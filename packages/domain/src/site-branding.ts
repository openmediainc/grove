/**
 * Branding suggestions read from a website (queue #34): a name, a theme colour
 * and the favicon's colour, and nothing else.
 *
 * HTML is scanned as text with scripts, styles and comments removed first; it
 * is never parsed into a DOM and nothing in it runs. Favicons are decoded by a
 * minimal PNG / ICO reader built on node:zlib (no image dependency); SVG and
 * anything else is skipped. Every byte arrives through SiteFetchSession, which
 * owns the network rules.
 */
import zlib from "node:zlib";
import { signTextFromName, suggestAccent, normaliseHex, type AccentSuggestion } from "@grove/protocol";
import { SiteFetchError, SiteFetchSession, type FetchWant, type SiteFetchOptions } from "./site-fetch.js";

export const HTML_MAX_BYTES = 512 * 1024;
export const FAVICON_MAX_BYTES = 100 * 1024;
/** Favicons tried at most, so one site cannot spend the whole deadline on images. */
const MAX_FAVICON_TRIES = 3;
/** Icons larger than this on either side are not decoded (memory bound). */
const MAX_ICON_SIDE = 512;

const HTML_WANT: FetchWant = {
  accept: (m) => m === "text/html" || m === "application/xhtml+xml",
  maxBytes: HTML_MAX_BYTES,
  overflow: "truncate",
  acceptHeader: "text/html,application/xhtml+xml;q=0.9",
};

const ICON_MIMES = new Set(["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/ico", "image/icon"]);
const ICON_WANT: FetchWant = {
  accept: (m) => ICON_MIMES.has(m),
  maxBytes: FAVICON_MAX_BYTES,
  overflow: "fail",
  acceptHeader: "image/png,image/x-icon;q=0.9,image/vnd.microsoft.icon;q=0.9",
};

// ------------------------------------------------------------------ HTML

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", middot: "·" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const k = m[1]!.toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export type PageFacts = {
  siteName: string | null;
  title: string | null;
  /** og:description, else meta description; whitespace collapsed. */
  description: string | null;
  themeColor: string | null;
  /** Icon URLs in the order they should be tried, ending with /favicon.ico. */
  icons: string[];
};

/** A CSS colour as found in theme-color: hex (3, 4, 6, 8 digits) or rgb()/rgba(). */
export function parseCssColour(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3 || h.length === 6) return normaliseHex(`#${h}`);
    if (h.length === 4) return normaliseHex(`#${h.slice(0, 3)}`);
    if (h.length === 8) return normaliseHex(`#${h.slice(0, 6)}`);
    return null;
  }
  const fn = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(s);
  if (fn) {
    const [r, g, b] = fn.slice(1).map((n) => Math.min(255, Number(n)));
    return `#${[r, g, b].map((n) => n!.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

/** The first segment of "Page | Site" style titles, when a separator is present. */
function titleName(title: string): string {
  const parts = title.split(/\s+[|·•—–-]\s+/).map((p) => p.trim()).filter(Boolean);
  return parts[0] ?? title;
}

export function extractPageFacts(html: string, pageUrl: string): PageFacts {
  const clean = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, " ")
    .replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/gi, " ")
    .replace(/<template\b[\s\S]*?(?:<\/template\s*>|$)/gi, " ");

  let base = pageUrl;
  const metas: Record<string, string>[] = [];
  const links: Record<string, string>[] = [];
  const tagRe = /<(meta|link|base)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(clean))) {
    const a = attrs(m[2]!);
    const tag = m[1]!.toLowerCase();
    if (tag === "meta") metas.push(a);
    else if (tag === "link") links.push(a);
    else if (tag === "base" && a.href && base === pageUrl) {
      try {
        base = new URL(a.href, pageUrl).toString();
      } catch {
        /* ignore */
      }
    }
  }
  const meta = (key: string) => {
    const hit = metas.find((a) => (a.property ?? a.name ?? "").toLowerCase() === key && a.content?.trim());
    return hit ? hit.content!.trim() : null;
  };

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(clean);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).replace(/\s+/g, " ").trim() || null : null;

  const themeMetas = metas.filter((a) => (a.name ?? "").toLowerCase() === "theme-color" && a.content);
  const themeRaw = (themeMetas.find((a) => !a.media) ?? themeMetas.find((a) => /light/.test(a.media ?? "")) ?? themeMetas[0])?.content;

  const ranked: Array<{ url: string; rank: number }> = [];
  links.forEach((a, i) => {
    const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
    if (!a.href) return;
    const type = (a.type ?? "").toLowerCase();
    if (type === "image/svg+xml" || /\.svgz?(\?|#|$)/i.test(a.href)) return;
    let rank: number;
    if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) rank = 0;
    else if (rel.includes("icon")) rank = type === "image/png" || /\.png(\?|#|$)/i.test(a.href) ? 1 : 2;
    else return;
    try {
      const u = new URL(a.href, base);
      if (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "data:") ranked.push({ url: u.toString(), rank: rank * 100 + i });
    } catch {
      /* ignore */
    }
  });
  ranked.sort((x, y) => x.rank - y.rank);
  const icons = [...new Set(ranked.map((r) => r.url))];
  try {
    const fallback = new URL("/favicon.ico", pageUrl).toString();
    if (!icons.includes(fallback)) icons.push(fallback);
  } catch {
    /* ignore */
  }

  const rawDescription = meta("og:description") ?? meta("description") ?? meta("twitter:description");
  return {
    siteName: meta("og:site_name") ?? meta("application-name") ?? meta("apple-mobile-web-app-title"),
    title,
    description: rawDescription ? rawDescription.replace(/\s+/g, " ").trim() || null : null,
    themeColor: themeRaw ? parseCssColour(themeRaw) : null,
    icons,
  };
}

// ------------------------------------------------------------------ images

export type Rgba = { width: number; height: number; data: Uint8Array };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal PNG decoder: non-interlaced, every colour type, bit depths 1-16. Null when unsupported. */
export function decodePng(buf: Buffer): Rgba | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let ctype = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const start = off + 8;
    if (start + len > buf.length) break;
    const data = buf.subarray(start, start + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      ctype = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off = start + len + 4;
  }
  if (!width || !height || width > MAX_ICON_SIDE || height > MAX_ICON_SIDE || interlace !== 0) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null;
  if (ctype === 3 && !palette) return null;
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const expected = height * (stride + 1);
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1024 });
  } catch {
    return null;
  }
  if (raw.length < expected) return null;

  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  const sample = (row: Uint8Array, index: number): number => {
    if (depth === 8) return row[index]!;
    if (depth === 16) return row[index * 2]!;
    const bit = index * depth;
    const v = (row[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    return ctype === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      line[i] = (line[i]! + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (ctype === 3) {
        const idx = sample(line, x);
        if (idx * 3 + 2 >= palette!.length) return null;
        out[o] = palette![idx * 3]!;
        out[o + 1] = palette![idx * 3 + 1]!;
        out[o + 2] = palette![idx * 3 + 2]!;
        out[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
      } else if (ctype === 0 || ctype === 4) {
        const g = sample(line, x * channels);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = ctype === 4 ? sample(line, x * channels + 1) : 255;
      } else {
        out[o] = sample(line, x * channels);
        out[o + 1] = sample(line, x * channels + 1);
        out[o + 2] = sample(line, x * channels + 2);
        out[o + 3] = ctype === 6 ? sample(line, x * channels + 3) : 255;
      }
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** Minimal ICO decoder: the largest image, PNG-in-ICO or an uncompressed 32/24/8/4/1-bit BMP. */
export function decodeIco(buf: Buffer): Rgba | null {
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  let best: { size: number; offset: number; area: number } | null = null;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (e + 16 > buf.length) break;
    const w = buf[e]! || 256;
    const h = buf[e + 1]! || 256;
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    if (offset + size > buf.length || size < 8) continue;
    if (!best || w * h > best.area) best = { size, offset, area: w * h };
  }
  if (!best) return null;
  const img = buf.subarray(best.offset, best.offset + best.size);
  if (img.subarray(0, 8).equals(PNG_SIG)) return decodePng(img);
  if (img.length < 40) return null;
  const headerSize = img.readUInt32LE(0);
  const width = img.readInt32LE(4);
  const height = Math.abs(img.readInt32LE(8)) / 2;
  const bits = img.readUInt16LE(14);
  const compression = img.readUInt32LE(16);
  if (!width || !height || width > MAX_ICON_SIDE || height > MAX_ICON_SIDE || compression !== 0) return null;
  if (![1, 4, 8, 24, 32].includes(bits)) return null;
  const colours = bits <= 8 ? img.readUInt32LE(32) || 1 << bits : 0;
  const palOff = headerSize;
  const pixOff = palOff + colours * 4;
  const rowBytes = Math.floor((width * bits + 31) / 32) * 4;
  const maskRow = Math.floor((width + 31) / 32) * 4;
  if (pixOff + rowBytes * height > img.length) return null;
  const maskOff = pixOff + rowBytes * height;
  const hasMask = maskOff + maskRow * height <= img.length;
  const out = new Uint8Array(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const srcRow = pixOff + (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (bits === 32 || bits === 24) {
        const p = srcRow + x * (bits >> 3);
        out[o] = img[p + 2]!;
        out[o + 1] = img[p + 1]!;
        out[o + 2] = img[p]!;
        out[o + 3] = bits === 32 ? img[p + 3]! : 255;
        if (bits === 32 && img[p + 3]!) anyAlpha = true;
      } else {
        const bit = x * bits;
        const idx = (img[srcRow + (bit >> 3)]! >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
        const q = palOff + idx * 4;
        if (q + 2 >= pixOff) return null;
        out[o] = img[q + 2]!;
        out[o + 1] = img[q + 1]!;
        out[o + 2] = img[q]!;
        out[o + 3] = 255;
      }
    }
  }
  if (bits !== 32 || !anyAlpha) {
    for (let y = 0; y < height; y++) {
      const mRow = maskOff + (height - 1 - y) * maskRow;
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const transparent = hasMask ? (img[mRow + (x >> 3)]! >> (7 - (x & 7))) & 1 : 0;
        out[o + 3] = transparent ? 0 : 255;
      }
    }
  }
  return { width, height, data: out };
}

/**
 * The colour a person would call the icon's colour. Opaque pixels are bucketed
 * (4 bits a channel); the biggest bucket of clearly coloured pixels wins when
 * such pixels are at least a tenth of the icon, since a logo on a white or
 * black tile is its colour, not the tile. Otherwise the biggest bucket of all.
 */
export function dominantColour(img: Rgba): string | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number; vivid: boolean }>();
  let opaque = 0;
  let vivid = 0;
  const d = img.data;
  for (let i = 0; i + 3 < d.length; i += 4) {
    if (d[i + 3]! < 128) continue;
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    opaque++;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const isVivid = max - min >= 48 && max >= 48;
    if (isVivid) vivid++;
    const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
    const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0, vivid: isVivid };
    cur.n++;
    cur.r += r;
    cur.g += g;
    cur.b += b;
    buckets.set(key, cur);
  }
  if (!opaque) return null;
  const preferVivid = vivid >= opaque * 0.1;
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const v of buckets.values()) {
    if (preferVivid && !v.vivid) continue;
    if (!best || v.n > best.n) best = v;
  }
  if (!best) return null;
  const hex = (n: number) => Math.round(n / best!.n).toString(16).padStart(2, "0");
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}

export function decodeIcon(buf: Buffer): Rgba | null {
  if (buf.subarray(0, 8).equals(PNG_SIG)) return decodePng(buf);
  if (buf.length >= 4 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) return decodeIco(buf);
  return null;
}

// ------------------------------------------------------------------ suggestion

export type SiteBrandingSuggestion = {
  /** Sign text from the site's name (at most 24 characters), or null. */
  name: string | null;
  accent: AccentSuggestion | null;
  source: {
    /** The page actually read, after redirects. */
    url: string;
    siteName: string | null;
    title: string | null;
    themeColor: string | null;
    favicon: string | null;
    faviconColour: string | null;
    /** Where the accent came from. */
    accentFrom: "theme_color" | "favicon" | null;
  };
  notes: string[];
};

/** White, black and greys: less than 15% chroma. */
function isNeutral(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return Math.max(...c) - Math.min(...c) < 0.15 * 255;
}

function dataUrlBytes(url: string): Buffer | null {
  const m = /^data:(image\/(?:png|x-icon|vnd\.microsoft\.icon));base64,([a-z0-9+/=\s]+)$/i.exec(url);
  if (!m) return null;
  if (m[2]!.length > (FAVICON_MAX_BYTES * 4) / 3 + 8) return null;
  return Buffer.from(m[2]!, "base64");
}

/**
 * The first favicon (in the page's own order, at most MAX_FAVICON_TRIES) that
 * decodes to a colour. Every fetch goes through the session, so its network
 * rules and deadline apply; a failed icon is skipped, never thrown.
 */
export async function readFaviconColour(
  session: SiteFetchSession,
  facts: Pick<PageFacts, "icons">,
): Promise<{ favicon: string | null; colour: string | null }> {
  for (const icon of facts.icons.slice(0, MAX_FAVICON_TRIES)) {
    if (session.remainingMs() <= 250) break;
    try {
      const bytes = icon.startsWith("data:") ? dataUrlBytes(icon) : (await session.get(icon, ICON_WANT)).body;
      const img = bytes ? decodeIcon(bytes) : null;
      const colour = img ? dominantColour(img) : null;
      if (colour) return { favicon: icon.startsWith("data:") ? "(inline icon)" : icon, colour };
    } catch (e) {
      if (!(e instanceof SiteFetchError)) throw e;
    }
  }
  return { favicon: null, colour: null };
}

/** Read a site and suggest branding. Throws SiteFetchError when the page itself cannot be read. */
export async function suggestBrandingFromSite(rawUrl: string, opts: SiteFetchOptions = {}): Promise<SiteBrandingSuggestion> {
  const session = new SiteFetchSession(opts);
  const page = await session.get(rawUrl, HTML_WANT);
  const facts = extractPageFacts(page.body.toString("utf8"), page.url);
  const notes: string[] = [];

  let favicon: string | null = null;
  let faviconColour: string | null = null;
  // The favicon is read when the page names no theme colour, or only a neutral
  // one (white, black, grey: usually the browser chrome, not the brand).
  if (!facts.themeColor || isNeutral(facts.themeColor)) {
    const icon = await readFaviconColour(session, facts);
    favicon = icon.favicon;
    faviconColour = icon.colour;
  }

  const useFavicon = Boolean(faviconColour && (!facts.themeColor || !isNeutral(faviconColour)));
  const colour = useFavicon ? faviconColour : facts.themeColor;
  const accent = colour ? suggestAccent(colour) : null;
  if (!colour) notes.push("The website names no theme colour and its icon could not be read, so no colour is suggested.");
  if (accent?.note) notes.push(accent.note);

  const rawName = facts.siteName ?? (facts.title ? titleName(facts.title) : null);
  const name = rawName ? signTextFromName(rawName) : null;
  if (!name) notes.push("The website gives no name, so the sign text is left as it is.");
  else if (rawName && name !== rawName.replace(/\s+/g, " ").trim()) notes.push("The name was shortened to fit the sign.");

  return {
    name,
    accent,
    source: {
      url: page.url,
      siteName: facts.siteName,
      title: facts.title,
      themeColor: facts.themeColor,
      favicon,
      faviconColour,
      accentFrom: useFavicon ? "favicon" : facts.themeColor ? "theme_color" : null,
    },
    notes,
  };
}

// ------------------------------------------------------------------ link cards

export type LinkPreview = {
  /** The page actually read, after redirects. */
  url: string;
  host: string;
  title: string | null;
  description: string | null;
  themeColour: string | null;
  faviconColour: string | null;
};

const PREVIEW_TITLE_MAX = 120;
const PREVIEW_DESCRIPTION_MAX = 240;

function cut(s: string | null, max: number): string | null {
  if (!s) return null;
  const chars = [...s];
  if (chars.length <= max) return s;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

/**
 * What a board link card shows (queue #36): title, description, theme colour and
 * favicon colour, read through the same SSRF-safe session as branding
 * suggestions. Text only; no image URL leaves this function, so the card never
 * loads anything from the linked site. Throws SiteFetchError when the page
 * itself cannot be read.
 */
export async function readLinkPreview(rawUrl: string, opts: SiteFetchOptions = {}): Promise<LinkPreview> {
  const session = new SiteFetchSession(opts);
  const page = await session.get(rawUrl, HTML_WANT);
  const facts = extractPageFacts(page.body.toString("utf8"), page.url);
  const icon = await readFaviconColour(session, facts);
  const title = facts.siteName && facts.title && !facts.title.includes(facts.siteName) ? `${facts.title} · ${facts.siteName}` : facts.title ?? facts.siteName;
  return {
    url: page.url,
    host: new URL(page.url).hostname,
    title: cut(title, PREVIEW_TITLE_MAX),
    description: cut(facts.description, PREVIEW_DESCRIPTION_MAX),
    themeColour: facts.themeColor,
    faviconColour: icon.colour,
  };
}
