/**
 * Reading branding out of a website (queue #34): theme-color, og:site_name and
 * <title>, favicon links, the minimal PNG / ICO decoders, the dominant colour,
 * and the end-to-end suggestion against a loopback server.
 */
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAccent, readSignText } from "@grove/protocol";
import {
  decodeIco,
  decodePng,
  dominantColour,
  extractPageFacts,
  parseCssColour,
  suggestBrandingFromSite,
} from "../src/site-branding.js";
import { isBlockedAddress } from "../src/site-fetch.js";

// ------------------------------------------------------------------ fixtures

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** An RGBA PNG where pixel(x, y) is given; each row uses a different filter to exercise the unfilterer. */
function pngFixture(w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(w * 4);
  for (let y = 0; y < h; y++) {
    const line = Buffer.alloc(w * 4);
    for (let x = 0; x < w; x++) line.set(pixel(x, y), x * 4);
    const filter = y % 5;
    const out = Buffer.alloc(w * 4);
    for (let i = 0; i < line.length; i++) {
      const a = i >= 4 ? line[i - 4]! : 0;
      const b = prev[i]!;
      const c = i >= 4 ? prev[i - 4]! : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = (line[i]! - p) & 255;
    }
    rows.push(Buffer.from([filter]), out);
    prev = line;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** A logo: a navy mark in the middle of a white tile with transparent corners. */
const logoPixel = (x: number, y: number): [number, number, number, number] => {
  if ((x < 2 || x > 13) && (y < 2 || y > 13)) return [0, 0, 0, 0];
  if (x >= 4 && x < 12 && y >= 4 && y < 12) return [30, 58, 138, 255];
  return [255, 255, 255, 255];
};

function icoWrapping(images: Buffer[], sizes: number[]): Buffer {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    header[e] = sizes[i]! % 256;
    header[e + 1] = sizes[i]! % 256;
    header.writeUInt32LE(img.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([header, ...images]);
}
/** A 32-bit BMP icon image, solid colour. */
function bmp32(size: number, rgba: [number, number, number, number]): Buffer {
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size * 2, 8);
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) px.set([rgba[2], rgba[1], rgba[0], rgba[3]], i * 4);
  const mask = Buffer.alloc(Math.floor((size + 31) / 32) * 4 * size);
  return Buffer.concat([hdr, px, mask]);
}

// ------------------------------------------------------------------ HTML

describe("extractPageFacts", () => {
  const page = `<!doctype html><html><head>
    <!-- <meta name="theme-color" content="#ff0000"> -->
    <title>Pricing | Harbour &amp; Lights</title>
    <meta property="og:site_name" content="Harbour &amp; Lights Studio">
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">
    <meta name="theme-color" content="#1E3A8A">
    <script>document.write('<meta name="theme-color" content="#00ff00">')</script>
    <link rel="mask-icon" href="/mask.svg">
    <link rel="icon" type="image/svg+xml" href="/icon.svg">
    <link rel="shortcut icon" href="/favicon-legacy.ico">
    <link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">
    <link rel=apple-touch-icon href='//cdn.example.com/apple.png'>
  </head><body></body></html>`;

  it("reads theme-color (not the dark variant, not script or comment text), site name, and ranks icons", () => {
    const f = extractPageFacts(page, "https://harbour.example/pricing");
    expect(f.themeColor).toBe("#1e3a8a");
    expect(f.siteName).toBe("Harbour & Lights Studio");
    expect(f.title).toBe("Pricing | Harbour & Lights");
    expect(f.icons).toEqual([
      "https://cdn.example.com/apple.png",
      "https://harbour.example/icon-32.png",
      "https://harbour.example/favicon-legacy.ico",
      "https://harbour.example/favicon.ico",
    ]);
  });

  it("falls back to /favicon.ico and to no name or colour", () => {
    const f = extractPageFacts("<html><body>hi</body></html>", "http://plain.example/a/b");
    expect(f).toEqual({ siteName: null, title: null, description: null, themeColor: null, icons: ["http://plain.example/favicon.ico"] });
  });

  it("parses the CSS colour forms theme-color uses", () => {
    expect(parseCssColour("#abc")).toBe("#aabbcc");
    expect(parseCssColour("#AABBCCDD")).toBe("#aabbcc");
    expect(parseCssColour("rgb(30, 58, 138)")).toBe("#1e3a8a");
    expect(parseCssColour("rgba(30 58 138 / 50%)")).toBe("#1e3a8a");
    expect(parseCssColour("navy")).toBeNull();
    expect(parseCssColour("url(javascript:alert(1))")).toBeNull();
  });
});

// ------------------------------------------------------------------ images

describe("favicon decoding", () => {
  it("decodes a filtered RGBA PNG exactly", () => {
    const png = pngFixture(16, 16, logoPixel);
    const img = decodePng(png)!;
    expect([img.width, img.height]).toEqual([16, 16]);
    for (const [x, y] of [[0, 0], [5, 5], [3, 8], [15, 15]] as const) {
      expect([...img.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)]).toEqual(logoPixel(x, y));
    }
  });

  it("finds the logo's colour, not its white tile", () => {
    expect(dominantColour(decodePng(pngFixture(16, 16, logoPixel))!)).toBe("#1e3a8a");
  });

  it("uses the biggest colour when an icon has no clear colour", () => {
    const grey = decodePng(pngFixture(8, 8, (x) => (x < 6 ? [40, 40, 40, 255] : [250, 250, 250, 255])))!;
    expect(dominantColour(grey)).toBe("#282828");
    expect(dominantColour(decodePng(pngFixture(4, 4, () => [0, 0, 0, 0]))!)).toBeNull();
  });

  it("decodes PNG-in-ICO and 32-bit BMP ICO, choosing the largest image", () => {
    const small = bmp32(16, [255, 0, 0, 255]);
    const big = pngFixture(32, 32, () => [94, 234, 212, 255]);
    const ico = icoWrapping([small, big], [16, 32]);
    expect(dominantColour(decodeIco(ico)!)).toBe("#5eead4");
    const bmpOnly = icoWrapping([bmp32(16, [125, 211, 252, 255])], [16]);
    expect(dominantColour(decodeIco(bmpOnly)!)).toBe("#7dd3fc");
  });

  it("returns null for junk, SVG, truncated or oversized images", () => {
    expect(decodePng(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(decodePng(pngFixture(16, 16, logoPixel).subarray(0, 60))).toBeNull();
    expect(decodePng(pngFixture(600, 1, () => [1, 2, 3, 255]))).toBeNull();
    expect(decodeIco(Buffer.alloc(30))).toBeNull();
  });
});

// ------------------------------------------------------------------ end to end

describe("suggestBrandingFromSite", () => {
  let server: http.Server;
  let port = 0;
  const routes = new Map<string, (res: http.ServerResponse) => void>();
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const h = routes.get(req.url ?? "");
      if (h) h(res);
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const opts = {
    ports: "any" as const,
    resolve: async () => [{ address: "127.0.0.1", family: 4 as const }],
    isBlocked: (ip: string) => (ip === "127.0.0.1" ? false : isBlockedAddress(ip)),
  };
  const sendHtml = (body: string) => (res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  };

  it("uses theme-color that passes as it is, and the site name as sign text", async () => {
    routes.set("/", sendHtml(`<meta property="og:site_name" content="Lime Works"><meta name="theme-color" content="#bef264">`));
    const s = await suggestBrandingFromSite(`http://brand.test:${port}/`, opts);
    expect(s.name).toBe("Lime Works");
    expect(s.accent).toEqual({ accent: "#bef264", original: "#bef264", substituted: false, note: null });
    expect(s.source.accentFrom).toBe("theme_color");
  });

  it("swaps a dark theme-color for the nearest palette colour and says so; trims a long title", async () => {
    routes.set(
      "/dark",
      sendHtml(`<title>The Extraordinarily Long Harbour Company Name Ltd - Home</title><meta name="theme-color" content="#1e3a8a">`),
    );
    const s = await suggestBrandingFromSite(`http://brand.test:${port}/dark`, opts);
    expect(s.accent?.substituted).toBe(true);
    expect(s.accent?.accent).toBe("#a5b4fc");
    expect(s.accent?.note).toMatch(/#1e3a8a is too dark.*Periwinkle/);
    expect(s.name).toBe("The Extraordinarily Long");
    expect(readSignText(s.name).ok).toBe(true);
    expect(readAccent(s.accent!.accent).ok).toBe(true);
    expect(s.notes.join(" ")).toMatch(/shortened/);
  });

  it("falls back to the favicon PNG colour when there is no theme-color", async () => {
    routes.set("/fav", sendHtml(`<title>Teal Co</title><link rel="icon" type="image/png" href="/logo.png">`));
    routes.set("/logo.png", (res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(pngFixture(16, 16, (x, y) => (x > 3 && y > 3 ? [94, 234, 212, 255] : [255, 255, 255, 255])));
    });
    const s = await suggestBrandingFromSite(`http://brand.test:${port}/fav`, opts);
    expect(s.source.accentFrom).toBe("favicon");
    expect(s.source.faviconColour).toBe("#5eead4");
    expect(s.accent?.accent).toBe("#5eead4");
    expect(s.name).toBe("Teal Co");
  });

  it("skips an SVG or unreadable favicon gracefully and still suggests a name", async () => {
    routes.set("/svg", sendHtml(`<title>Vector</title><link rel="icon" href="/i.png">`));
    routes.set("/i.png", (res) => {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end("<svg/>");
    });
    const s = await suggestBrandingFromSite(`http://brand.test:${port}/svg`, opts);
    expect(s.accent).toBeNull();
    expect(s.name).toBe("Vector");
    expect(s.notes.join(" ")).toMatch(/no colour is suggested/);
  });

  it("does not fetch a favicon that points at a private address", async () => {
    routes.set("/sneaky", sendHtml(`<title>Sneaky</title><link rel="apple-touch-icon" href="http://169.254.169.254/latest/meta-data/iam">`));
    const s = await suggestBrandingFromSite(`http://brand.test:${port}/sneaky`, opts);
    expect(s.source.favicon).toBeNull();
    expect(s.name).toBe("Sneaky");
  });
});

describe("suggestBrandingFromSite with a neutral theme-color", () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<meta name="application-name" content="Sunny"><meta name="theme-color" content="#ffffff">`);
      } else if (req.url === "/favicon.ico") {
        res.writeHead(200, { "content-type": "image/x-icon" });
        res.end(icoWrapping([bmp32(16, [253, 224, 71, 255])], [16]));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("prefers the favicon's colour over white browser chrome", async () => {
    const s = await suggestBrandingFromSite(`http://brand.test:${port}/`, {
      ports: "any",
      resolve: async () => [{ address: "127.0.0.1", family: 4 as const }],
      isBlocked: (ip: string) => (ip === "127.0.0.1" ? false : isBlockedAddress(ip)),
    });
    expect(s.name).toBe("Sunny");
    expect(s.source.themeColor).toBe("#ffffff");
    expect(s.source.accentFrom).toBe("favicon");
    expect(s.accent?.accent).toBe("#fde047");
  });
});

describe("normaliseSiteUrl", async () => {
  const { normaliseSiteUrl } = await import("../src/services/branding.js");
  it("adds https to a bare host and refuses what is not an address", () => {
    expect(normaliseSiteUrl("example.com")).toBe("https://example.com/");
    expect(normaliseSiteUrl("example.com:8080/x")).toBe("https://example.com:8080/x");
    expect(normaliseSiteUrl(" http://Example.com/path ")).toBe("http://example.com/path");
    expect(normaliseSiteUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseSiteUrl("two words")).toBeNull();
    expect(normaliseSiteUrl(42)).toBeNull();
    expect(normaliseSiteUrl("")).toBeNull();
  });
});
