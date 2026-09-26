/**
 * Link previews for messages, fetched by the sender only: the page title,
 * description, site name and picture from its OpenGraph / Twitter tags, and
 * the video id for YouTube. The picture comes back as bytes; the page uploads
 * it to the homeserver and puts the preview into the message itself, so
 * nobody else ever contacts the linked site.
 *
 * `fetchFn` is Electron's net.fetch in the app (proxy settings, the system
 * certificate store) and plain fetch in tests.
 */

const MAX_HTML = 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const TIMEOUT_MS = 8000;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "-", ndash: "-", hellip: "..." };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function clean(s, max) {
  const v = decodeEntities(String(s ?? "")).replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 3).trimEnd()}...` : v;
}

/** <meta> tags as a map: property or name (lower case) to content; the first one wins. */
function metaTags(html) {
  const out = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    }
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (key && attrs.content !== undefined && !(key in out)) out[key] = attrs.content;
  }
  return out;
}

function youtubeId(u) {
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id = "";
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v") ?? "";
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
  }
  return /^[\w-]{6,20}$/.test(id) ? id : "";
}

async function readLimited(res, limit) {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, limit);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= limit) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, limit));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.byteLength, out.byteLength - at));
    out.set(part, at);
    at += part.byteLength;
    if (at >= out.byteLength) break;
  }
  return out;
}

function decodeHtml(bytes, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "";
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";
  }
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function createPreviewer(fetchFn, userAgent) {
  const get = async (url, accept) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      return await fetchFn(url, {
        signal: ctl.signal,
        redirect: "follow",
        headers: { "User-Agent": userAgent, Accept: accept, "Accept-Language": "ru,en;q=0.8" },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const image = async (url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      const res = await get(u.href, "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8");
      const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!res.ok || !mime.startsWith("image/") || mime === "image/svg+xml") return null;
      const data = await readLimited(res, MAX_IMAGE + 1);
      if (data.byteLength > MAX_IMAGE || data.byteLength < 64) return null;
      return { data, mime };
    } catch {
      return null;
    }
  };

  const youtube = async (u, id) => {
    let title = "";
    let author = "";
    try {
      // the canonical address: oEmbed does not know every short form (youtu.be, shorts)
      const watch = `https://www.youtube.com/watch?v=${id}`;
      const res = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, "application/json");
      if (res.ok) {
        const j = await res.json();
        title = clean(j.title, 300);
        author = clean(j.author_name, 200);
      }
    } catch {
      // the picture and the player still work without the title
    }
    const pic = (await image(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`)) ?? (await image(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`));
    return { url: u.href, site: "YouTube", title, description: author, color: "#ff0000", youtube: id, image: pic };
  };

  return async function preview(raw) {
    let u;
    try {
      u = new URL(String(raw));
    } catch {
      return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const yt = youtubeId(u);
    if (yt) return youtube(u, yt);

    let res;
    try {
      res = await get(u.href, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5");
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    const finalUrl = res.url || u.href;
    const host = new URL(finalUrl).hostname.replace(/^www\./, "");

    // a link straight to a picture shows the picture
    if (/^image\//i.test(type) && !/svg/i.test(type)) {
      const data = await readLimited(res, MAX_IMAGE + 1).catch(() => null);
      if (!data || data.byteLength > MAX_IMAGE) return null;
      return { url: u.href, site: host, title: "", description: "", color: "", youtube: "", image: { data, mime: type.split(";")[0].trim() } };
    }
    if (!/html/i.test(type)) return null;

    let html;
    try {
      html = decodeHtml(await readLimited(res, MAX_HTML), type);
    } catch {
      return null;
    }
    const meta = metaTags(html);
    const title = clean(meta["og:title"] || meta["twitter:title"] || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "", 300);
    const description = clean(meta["og:description"] || meta["twitter:description"] || meta.description || "", 600);
    const site = clean(meta["og:site_name"] || host, 120);
    const color = /^#[0-9a-f]{6}$/i.test(meta["theme-color"] ?? "") ? meta["theme-color"] : "";
    const picUrl = meta["og:image:secure_url"] || meta["og:image"] || meta["og:image:url"] || meta["twitter:image"] || meta["twitter:image:src"] || "";
    if (!title && !description && !picUrl) return null;

    let pic = null;
    if (picUrl) {
      try {
        pic = await image(new URL(decodeEntities(picUrl), finalUrl).href);
      } catch {
        pic = null;
      }
    }
    return { url: u.href, site, title, description, color, youtube: "", image: pic };
  };
}

module.exports = { createPreviewer, youtubeId, metaTags };
