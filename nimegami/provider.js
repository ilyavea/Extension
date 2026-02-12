/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
  constructor() {
    this.base = "https://nimegami.id";
  }

  /* ====================== SETTINGS ====================== */

  getSettings() {
    return {
      episodeServers: ["NIMEGAMI"],
      supportsDub: false,
    };
  }

  /* ========================= SEARCH ========================= */

  async search(opts) {
    const q = encodeURIComponent(opts.query);
    const res = await fetch(`${this.base}/?s=${q}&post_type=post`);
    const html = await res.text();

    const results = [];
    const regex =
      /<article[\s\S]*?<a href="(https:\/\/nimegami\.id\/[^"]+)"[\s\S]*?<div class="title-post2">([\s\S]*?)<\/div>/g;

    let m;
    while ((m = regex.exec(html)) !== null) {

      results.push({
        id: m[1],
        title: m[2].trim(),
        url: m[1],
        subOrDub: "sub",
      });
    }

    return results;
  }

  /* ======================= EPISODES ======================== */

  async findEpisodes(id) {
    const animeUrl = id;

    const res = await fetch(animeUrl);
    const html = await res.text();

    const episodes = [];
    const regex =
      /<li[^>]*class="[^"]*select-eps[^"]*"[^>]*data="([^"]+)"[^>]*id="play_eps_(\d+)"/g;

    let m;
    while ((m = regex.exec(html)) !== null) {
      const encoded = m[1];
      const number = parseInt(m[2], 10);

      episodes.push({
        id: encoded,
        number,
        title: `Episode ${number}`,
        url: animeUrl,
      });
    }

    if (!episodes.length) {
      throw new Error("No episodes found");
    }

    episodes.sort((a, b) => a.number - b.number);
    return episodes;
  }

  /* ===================== VIDEO RESOLVER ===================== */

  normalizeBase64(str) {
    let s = str
      .replace(/&quot;/g, '"')
      .replace(/&#x3D;/g, '=')
      .replace(/&#61;/g, '=')
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    const pad = s.length % 4;
    if (pad) {
      s += '='.repeat(4 - pad);
    }

    return s;
  }

  isProbablyBase64(str) {
    return (
      typeof str === "string" &&
      str.length % 4 === 0 &&
      /^[A-Za-z0-9+/=]+$/.test(str)
    );
  }

  decodeBase64(str) {
    return Buffer.from(str, "base64").toString("utf-8");
  }

  async detectVideoType(url) {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
    });

    const headers = res.headers || {};
    const contentType =
      headers["content-type"] ||
      headers["Content-Type"] ||
      "";

    // DEBUG: lihat header & final URL
    console.log("[NIMEGAMI] detect headers:", headers);
    console.log("[NIMEGAMI] final url:", res.url);

    if (contentType.includes("application/vnd.apple.mpegurl")) {
      return { type: "m3u8", finalUrl: res.url };
    }

    if (contentType.includes("video/mp4")) {
      return { type: "mp4", finalUrl: res.url };
    }

    const text = await res.text();

    if (text.startsWith("#EXTM3U")) {
      return { type: "m3u8", finalUrl: res.url };
    }

    return { type: "unknown", finalUrl: res.url };
  }

  async resolveBerkasdrive(url) {
    const res = await fetch(url, {
      headers: {
        Referer: this.base,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
    });

    const html = await res.text();

    // CARI m3u8
    const m3u8 =
      html.match(/https?:\/\/[^"' ]+\.m3u8[^"' ]*/)?.[0];

    if (m3u8) {
      return {
        type: "m3u8",
        finalUrl: m3u8,
      };
    }

    return null;
  }

  async findEpisodeServer(episode, _server) {
    const rawEncoded = episode.id;

    if (!this.isProbablyBase64(rawEncoded)) {
      throw new Error("Episode ID is not valid base64");
    }

    let decoded;
    try {
      decoded = this.decodeBase64(rawEncoded);
      decoded = decoded.replace(/\\\//g, "/");
    } catch {
      throw new Error("Invalid episode base64");
    }

    let qualities;
    try {
      qualities = JSON.parse(decoded);
    } catch {
      throw new Error("Invalid episode JSON");
    }

    const videoSources = [];

    for (const q of qualities) {
      const quality = q.format;

      for (const rawUrl of q.url) {
        const cleanUrl = rawUrl.replace(/\\\//g, "/");
        const u = new URL(cleanUrl);
        const encoded = u.searchParams.get("id");
        if (!encoded) continue;

        let finalUrl;
        try {
          finalUrl = Buffer.from(encoded, "base64").toString("binary");
        } catch {
          continue;
        }

        videoSources.push({
          url: finalUrl,
          quality,
          type: "m3u8",
          subtitles: [],
        });
      }
    }

    console.log("[NIMEGAMI] videoSources:", videoSources);
    
    if (!videoSources.length) {
      throw new Error("No playable video found");
    }

    return {
      server: "NIMEGAMI",
      headers: {
        Referer: this.base,
        "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
      videoSources,
    };
  }

  /* ====================== EXTRACTORS ======================== */

  async extractVideos(url, quality) {
    if (
      url.includes("berkasdrive") ||
      url.includes("dlgan.space")
    ) {
      return [
        {
          url,
          quality,
          type: "mp4",
          subtitles: [],
        },
      ];
    }

    if (url.includes("bunga") || url.includes("uservideo")) {
      const res = await fetch(url);
      const html = await res.text();

      const m = html.match(/file\s*:\s*['"]([^'"]+)['"]/);
      if (!m) return [];

      return [
        {
          url: m[1],
          quality,
          type: "mp4",
          subtitles: [],
        },
      ];
    }

    return [];
  }

  /* ====================== JS UNPACKER ======================= */

  unpack(packedCode) {
    try {
      const m = packedCode.match(
        /\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/
      );
      if (!m) return "";

      let payload = m[1];
      const radix = parseInt(m[2]);
      const count = parseInt(m[3]);
      const keywords = m[4].split("|");

      const encode = (c) =>
        (c < radix ? "" : encode((c / radix) | 0)) +
        ((c = c % radix) > 35
          ? String.fromCharCode(c + 29)
          : c.toString(36));

      for (let i = count; i--;) {
        if (keywords[i]) {
          payload = payload.replace(
            new RegExp("\\b" + encode(i) + "\\b", "g"),
            keywords[i]
          );
        }
      }
      return payload;
    } catch {
      return "";
    }
  }
}
