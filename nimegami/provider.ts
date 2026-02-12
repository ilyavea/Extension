/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
  base: string;
  headers: Record<string, string>;
  cookie: string;

  constructor() {
    this.base = "https://nimegami.id";
    this.headers = {
      Referer: this.base,
      "User-Agent": "Mozilla/5.0",
    };
    this.cookie = "";
  }

  /* ====================== SETTINGS ====================== */

  getSettings() {
    return {
      episodeServers: ["NIMEGAMI"],
      supportsDub: false,
    };
  }

  base64Decode(input: string): string {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    let str = input.replace(/=+$/, "");
    let output = "";

    if (str.length % 4 === 1) {
        throw new Error("Invalid base64 string");
    }

    for (
        let bc = 0, bs = 0, buffer, idx = 0;
        (buffer = str.charAt(idx++));
        ~buffer &&
        ((bs = bc % 4 ? bs * 64 + buffer : buffer),
        bc++ % 4)
        ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
        : 0
    ) {
        buffer = chars.indexOf(buffer);
    }

    return decodeURIComponent(
        output
        .split("")
        .map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  /* ========================= SEARCH ========================= */

  async search(opts: { query: string }) {
    const q = encodeURIComponent(opts.query);
    const res = await fetch(`${this.base}/?s=${q}&post_type=post`, {
      headers: this.headers,
    });
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

  async findEpisodes(id: string) {
    const res = await fetch(id);
    const html = await res.text();

    const episodes = [];

    // ambil SEMUA data base64 episode
    const regex = /data="([^"]+)"/g;

    let match;
    let index = 1;

    while ((match = regex.exec(html)) !== null) {
        const encoded = match[1];

        // validasi base64 JSON
        try {
        const decoded = this.base64Decode(encoded)
            .replace(/\\\//g, "/");
        JSON.parse(decoded);
        } catch {
        continue; // skip data sampah
        }

        episodes.push({
        id: encoded, // ⬅️ TIDAK perlu slug lagi
        number: index++,
        title: `Episode ${index - 1}`,
        url: id,
        });
    }

    if (!episodes.length) {
        throw new Error("No episodes found (data attribute not detected)");
    }

    return episodes;
    }

  /* ===================== VIDEO RESOLVER ===================== */

  async fetchWithCookies(url: string) {
    const res = await fetch(url, {
      headers: {
        ...this.headers,
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      redirect: "follow",
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      this.cookie = setCookie;
    }

    return res;
  }

  extractApi(html: string, key: string): string | null {
    const r = new RegExp(`${key}\\s*=\\s*["']([^"']+)["']`);
    const m = html.match(r);
    return m ? m[1].replace(/\\\//g, "/") : null;
  }

  async getStreamUrlFromPage(streamingPageUrl: string): Promise<string | null> {
    // 1️⃣ Load streaming.php HTML → init session
    const pageRes = await this.fetchWithCookies(streamingPageUrl);
    const html = await pageRes.text();

    // 2️⃣ Extract API endpoints
    const streamApi = this.extractApi(html, "FILE_URL_API");
    const fallbackApi = this.extractApi(html, "FILE_FALLBACK_API");

    if (!streamApi) return null;

    // 3️⃣ Try stream-worker (JSON)
    try {
      const apiRes = await this.fetchWithCookies(
        this.base + streamApi
      );
      const data = await apiRes.json();
      if (data?.ok && data?.url) {
        return data.url;
      }
    } catch {
      // ignore
    }

    // 4️⃣ Fallback: download-worker
    if (fallbackApi) {
      try {
        const fbRes = await this.fetchWithCookies(
          this.base + fallbackApi
        );
        const data = await fbRes.json();
        if (data?.ok && data?.url) {
          return data.url;
        }
      } catch {
        // ignore
      }
    }

    return null;
  }

  async findEpisodeServer(episode: any, _server: any) {
    const [encoded] = episode.id.split("|");

    // 1. decode payload episode
    const decoded = this.base64Decode(encoded).replace(/\\\//g, "/");

    let qualities: any[];
    try {
        qualities = JSON.parse(decoded);
    } catch {
        throw new Error("Invalid episode payload");
      }

    const videoSources: any[] = [];

    for (const q of qualities) {
        for (const raw of q.url) {
        let url = raw
            .replace(/\\u0026/g, "&")
            .replace(/&amp;/g, "&")
            .replace(/\\\//g, "/");

        // cuma berkasdrive / streaming.php yang valid
        if (!url.includes("streaming")) continue;

        // 2. fetch halaman streaming.php
        const res = await fetch(url, {
            headers: {
            Referer: this.base,
            "User-Agent": "Mozilla/5.0",
            },
        });

        const html = await res.text();

        // 3. ambil DIRECT MP4
        const match =
            html.match(/<source[^>]+src=["']([^"']+)["']/i) ||
            html.match(/file\s*:\s*["']([^"']+)["']/i);

        if (!match) continue;

        const finalUrl = match[1];

        // 4. push FINAL VIDEO (INI YANG ENGINE BUTUHKAN)
        videoSources.push({
            url: finalUrl,
            quality: q.format,
            type: "mp4",
            subtitles: [],
            headers: {
            Referer: url,
            "User-Agent": "Mozilla/5.0",
            },
        });
        }
    }

    if (!videoSources.length) {
        throw new Error("No playable video found");
    }

      return {
        server: "NIMEGAMI",
        headers: this.headers,
        videoSources,
    };
    }
}
