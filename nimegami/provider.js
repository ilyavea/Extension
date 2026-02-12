/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
  constructor() {
    this.base = "https://nimegami.id";
    this.headers = {
      Referer: this.base,
      "User-Agent": "Mozilla/5.0",
    };
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
    const res = await fetch(id);
    const html = await res.text();

    const episodes = [];
    const regex =
      /<li[^>]*class="[^"]*select-eps[^"]*"[^>]*data="([^"]+)"[^>]*id="play_eps_(\d+)"/g;

    let m;
    while ((m = regex.exec(html)) !== null) {
      episodes.push({
        id: m[1], // BASE64 JSON
        number: parseInt(m[2], 10),
        title: `Episode ${m[2]}`,
        url: id,
      });
    }

    if (!episodes.length) {
      throw new Error("No episodes found");
    }

    return episodes.sort((a, b) => a.number - b.number);
  }

  /* ===================== VIDEO RESOLVER ===================== */

  async findEpisodeServer(episode, _server) {
    // === STEP 1: decode episode base64 ===
    let decoded;
    try {
      decoded = Buffer.from(episode.id, "base64").toString("utf-8");
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

    // === STEP 2: loop qualities ===
    for (const q of qualities) {
      const quality = q.format;

      for (const url of q.url) {
        const real = await this.resolveVideoUrl(url);
        if (!real) continue;

        videoSources.push({
          url: real,
          quality,
          type: real.includes(".m3u8") ? "m3u8" : "mp4",
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
      headers: this.headers,
      videoSources,
    };
  }

  /* ===================== HOST RESOLVERS ===================== */

  async resolveVideoUrl(url) {
    // video.nimegami.id → double base64
    if (url.includes("video.nimegami.id")) {
      const u = new URL(url);
      const encoded = u.searchParams.get("url");
      if (!encoded) return null;
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      return this.resolveVideoUrl(decoded);
    }

    // berkasdrive / drive.nimegami
    if (url.includes("berkasdrive") || url.includes("drive.nimegami")) {
      const res = await fetch(url, { headers: this.headers });
      const html = await res.text();

      const m =
        html.match(/<source[^>]+src=["']([^"']+)["']/i) ||
        html.match(/file\s*:\s*["']([^"']+)["']/i);

      return m ? m[1] : null;
    }

    // direct link (fallback)
    if (url.startsWith("http")) {
      return url;
    }

    return null;
  }
}
