/**
 * Board image intake (queue #36): the format comes from the bytes, metadata
 * leaves, the size and dimension caps hold, and a container that does not walk
 * cleanly is refused rather than passed through.
 */
import { describe, expect, it } from "vitest";
import { BOARD_IMAGE_MAX_BYTES } from "@grove/protocol";
import { inspectBoardImage, sniffImageMime } from "../src/board-image.js";

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
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(w: number, h: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    ...extra,
    pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function seg(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
function jpeg(w: number, h: number): Buffer {
  const sof = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(h, 1);
  sof.writeUInt16BE(w, 3);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    seg(0xe1, Buffer.from("Exif\0\0GPSLatitude=51.5", "latin1")),
    seg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:creator>Jane</x:creator>", "latin1")),
    seg(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01profile", "latin1")),
    seg(0xed, Buffer.from("Photoshop 3.0\0IPTC byline", "latin1")),
    seg(0xfe, Buffer.from("secret comment", "latin1")),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, sof),
    seg(0xc4, Buffer.alloc(20, 2)),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    // Entropy data with byte stuffing and a restart marker.
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
    Buffer.from([0xff, 0xd9]),
    Buffer.from("PK\x03\x04 a zip glued on", "latin1"),
  ]);
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function webp(w: number, h: number): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04 | 0x10; // EXIF, XMP, alpha
  vp8x.writeUIntLE(w - 1, 4, 3);
  vp8x.writeUIntLE(h - 1, 7, 3);
  const vp8l = Buffer.alloc(9);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE(((h - 1) << 14) | (w - 1), 1);
  const body = Buffer.concat([
    riffChunk("VP8X", vp8x),
    riffChunk("VP8L", vp8l),
    riffChunk("EXIF", Buffer.from("Exif GPS", "latin1")),
    riffChunk("XMP ", Buffer.from("<xmp>who</xmp>", "latin1")),
  ]);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

function gif(w: number, h: number): Buffer {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "latin1");
  header.writeUInt16LE(w, 6);
  header.writeUInt16LE(h, 8);
  header[10] = 0x80; // global colour table, 2 entries
  const gct = Buffer.from([0, 0, 0, 255, 255, 255]);
  const netscape = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from("NETSCAPE2.0", "latin1"), Buffer.from([3, 1, 0, 0, 0])]);
  const xmp = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from("XMP DataXMP", "latin1"), Buffer.from([4]), Buffer.from("who!", "latin1"), Buffer.from([0])]);
  const comment = Buffer.concat([Buffer.from([0x21, 0xfe, 6]), Buffer.from("secret", "latin1"), Buffer.from([0])]);
  const image = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0]);
  return Buffer.concat([header, gct, netscape, xmp, comment, image, Buffer.from([0x3b]), Buffer.from("trailing")]);
}

describe("sniffImageMime", () => {
  it("names the four formats by their magic bytes and nothing else", () => {
    expect(sniffImageMime(png(1, 1))).toBe("image/png");
    expect(sniffImageMime(jpeg(1, 1))).toBe("image/jpeg");
    expect(sniffImageMime(webp(1, 1))).toBe("image/webp");
    expect(sniffImageMime(gif(1, 1))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageMime(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffImageMime(Buffer.from("RIFF\0\0\0\0WAVE"))).toBeNull();
  });
});

describe("inspectBoardImage", () => {
  it("PNG: keeps pixels and colour chunks, drops text/eXIf/tIME and bytes after IEND", () => {
    const input = Buffer.concat([
      png(640, 480, [
        pngChunk("tEXt", Buffer.from("Author\0Jane Doe", "latin1")),
        pngChunk("eXIf", Buffer.from("MM\0*GPS", "latin1")),
        pngChunk("tIME", Buffer.alloc(7)),
        pngChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f])),
      ]),
      Buffer.from("PK trailing zip"),
    ]);
    const r = inspectBoardImage(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.mime, r.width, r.height]).toEqual(["image/png", 640, 480]);
    expect(r.stripped.sort()).toEqual(["eXIf", "tEXt", "tIME"]);
    const text = r.bytes.toString("latin1");
    expect(text).not.toContain("Jane");
    expect(text).not.toContain("GPS");
    expect(text).not.toContain("PK trailing");
    expect(text).toContain("gAMA");
    expect(r.bytes.subarray(-8, -4).toString("latin1")).toBe("IEND");
  });

  it("JPEG: drops EXIF, XMP, IPTC and comments, keeps JFIF, ICC and the scan, stops at EOI", () => {
    const r = inspectBoardImage(jpeg(1200, 800));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.mime, r.width, r.height]).toEqual(["image/jpeg", 1200, 800]);
    const text = r.bytes.toString("latin1");
    for (const gone of ["Exif", "GPSLatitude", "Jane", "IPTC", "secret comment", "PK"]) expect(text).not.toContain(gone);
    expect(text).toContain("JFIF");
    expect(text).toContain("ICC_PROFILE");
    expect(r.bytes.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]))).toBe(true);
    expect([...r.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(r.stripped).toEqual(["APP1", "APP1", "APP13", "COM"]);
  });

  it("WebP: drops EXIF and XMP chunks, clears their VP8X flags and rewrites the RIFF size", () => {
    const r = inspectBoardImage(webp(300, 200));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.mime, r.width, r.height]).toEqual(["image/webp", 300, 200]);
    const text = r.bytes.toString("latin1");
    expect(text).not.toContain("EXIF");
    expect(text).not.toContain("<xmp>");
    expect(r.bytes[20]! & 0x0c).toBe(0);
    expect(r.bytes[20]! & 0x10).toBe(0x10);
    expect(r.bytes.readUInt32LE(4)).toBe(r.bytes.length - 8);
  });

  it("GIF: drops comments and XMP application blocks, keeps the loop block and the frame", () => {
    const r = inspectBoardImage(gif(64, 32));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.mime, r.width, r.height]).toEqual(["image/gif", 64, 32]);
    const text = r.bytes.toString("latin1");
    expect(text).toContain("NETSCAPE2.0");
    expect(text).not.toContain("XMP DataXMP");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("trailing");
    expect(r.bytes[r.bytes.length - 1]).toBe(0x3b);
  });

  it("refuses what is not one of the four formats, whatever it claims to be", () => {
    for (const bytes of [Buffer.from("<svg onload='alert(1)'/>"), Buffer.from("GIF"), Buffer.from("%PDF-1.7")]) {
      expect(inspectBoardImage(bytes)).toMatchObject({ ok: false, reason: "format" });
    }
    expect(inspectBoardImage(Buffer.alloc(0))).toMatchObject({ ok: false, reason: "empty" });
  });

  it("refuses more than 2 MB before reading it, and oversized dimensions", () => {
    const big = Buffer.concat([png(10, 10), Buffer.alloc(BOARD_IMAGE_MAX_BYTES)]);
    expect(inspectBoardImage(big)).toMatchObject({ ok: false, reason: "too_large" });
    expect(inspectBoardImage(png(9000, 10))).toMatchObject({ ok: false, reason: "dimensions" });
    expect(inspectBoardImage(png(7000, 7000))).toMatchObject({ ok: false, reason: "dimensions" });
    expect(inspectBoardImage(png(6000, 6000)).ok).toBe(true);
  });

  it("refuses truncated or malformed containers instead of passing them through", () => {
    const whole = png(10, 10);
    expect(inspectBoardImage(whole.subarray(0, whole.length - 10))).toMatchObject({ ok: false, reason: "corrupt" });
    const j = jpeg(10, 10);
    const eoi = j.indexOf(Buffer.from([0xff, 0xd9]));
    expect(inspectBoardImage(j.subarray(0, eoi))).toMatchObject({ ok: false, reason: "corrupt" });
    expect(inspectBoardImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toMatchObject({ ok: false, reason: "corrupt" });
    const w = webp(10, 10);
    w.writeUInt32LE(99999, 4);
    expect(inspectBoardImage(w)).toMatchObject({ ok: false, reason: "corrupt" });
    expect(inspectBoardImage(jpeg(0, 10))).toMatchObject({ ok: false, reason: "corrupt" });
  });
});
