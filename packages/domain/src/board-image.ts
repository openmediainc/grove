/**
 * Images posted to a space's board (queue #36): what the bytes ARE, how big the
 * picture is, and the same picture without the metadata people forget they
 * carry (GPS in EXIF, author names in XMP, text chunks, comments).
 *
 * The client's content type is never read. The format comes from magic bytes;
 * anything that is not PNG, JPEG, WebP or GIF is refused. Nothing is decoded to
 * pixels (no image dependency, no decompression bomb): each format's container
 * is walked, the metadata segments dropped and everything else copied as it
 * was, and bytes after the format's own end marker are dropped too (a JPEG with
 * a zip glued to its tail is just a JPEG afterwards). A container that does not
 * walk cleanly is refused rather than passed through.
 *
 * Kept on purpose: colour profiles (PNG iCCP, JPEG ICC APP2, Adobe APP14, WebP
 * ICCP) and animation (APNG chunks, GIF NETSCAPE loop, animated WebP), because
 * dropping them changes how the picture looks.
 */
import {
  BOARD_IMAGE_MAX_BYTES,
  BOARD_IMAGE_MAX_PIXELS,
  BOARD_IMAGE_MAX_SIDE,
  formatBoardBytes,
  type BoardImageMime,
} from "@grove/protocol";

export type BoardImageRefusal = "empty" | "too_large" | "format" | "corrupt" | "dimensions";

export type BoardImageResult =
  | { ok: true; mime: BoardImageMime; width: number; height: number; bytes: Buffer; stripped: string[] }
  | { ok: false; reason: BoardImageRefusal; message: string };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The format named by the first bytes, or null. */
export function sniffImageMime(buf: Buffer): BoardImageMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return "image/gif";
  return null;
}

class Corrupt extends Error {}
const need = (buf: Buffer, end: number) => {
  if (end > buf.length) throw new Corrupt("truncated");
};

// ------------------------------------------------------------------ PNG

/** Ancillary chunks that change how the image looks or animates. Everything else ancillary is dropped. */
const PNG_KEEP_ANCILLARY = new Set(["tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs", "bKGD", "acTL", "fcTL", "fdAT", "cICP"]);

function cleanPng(buf: Buffer) {
  const out: Buffer[] = [PNG_SIG];
  const stripped: string[] = [];
  let off = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  for (;;) {
    need(buf, off + 8);
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Corrupt("chunk type");
    const end = off + 12 + len;
    need(buf, end);
    if (!sawIhdr) {
      if (type !== "IHDR" || len !== 13) throw new Corrupt("IHDR first");
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
      sawIhdr = true;
    }
    const critical = type[0]! >= "A" && type[0]! <= "Z";
    if (critical || PNG_KEEP_ANCILLARY.has(type)) out.push(buf.subarray(off, end));
    else stripped.push(type);
    off = end;
    if (type === "IEND") break;
  }
  return { width, height, bytes: Buffer.concat(out), stripped };
}

// ------------------------------------------------------------------ JPEG

function cleanJpeg(buf: Buffer) {
  const out: Buffer[] = [buf.subarray(0, 2)];
  const stripped: string[] = [];
  let off = 2;
  let width = 0;
  let height = 0;
  for (;;) {
    need(buf, off + 2);
    if (buf[off] !== 0xff) throw new Corrupt("marker");
    // Fill bytes: any number of 0xFF before a marker.
    let m = off + 1;
    while (m < buf.length && buf[m] === 0xff) m++;
    need(buf, m + 1);
    const marker = buf[m]!;
    if (marker === 0xd9) {
      out.push(buf.subarray(off, m + 1));
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(off, m + 1));
      off = m + 1;
      continue;
    }
    need(buf, m + 3);
    const len = buf.readUInt16BE(m + 1);
    if (len < 2) throw new Corrupt("segment length");
    const segEnd = m + 1 + len;
    need(buf, segEnd);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 7) throw new Corrupt("SOF");
      height = buf.readUInt16BE(m + 4);
      width = buf.readUInt16BE(m + 6);
    }
    let keep = true;
    if (marker === 0xfe) keep = false; // COM
    else if (marker >= 0xe0 && marker <= 0xef) {
      const id = buf.toString("latin1", m + 3, Math.min(segEnd, m + 3 + 14));
      if (marker === 0xe0) keep = id.startsWith("JFIF") || id.startsWith("JFXX");
      else if (marker === 0xe2) keep = id.startsWith("ICC_PROFILE");
      else if (marker === 0xee) keep = id.startsWith("Adobe");
      else keep = false; // APP1 EXIF/XMP, APP13 IPTC/Photoshop, and the rest
    }
    if (keep) out.push(buf.subarray(off, segEnd));
    else stripped.push(marker === 0xfe ? "COM" : `APP${marker - 0xe0}`);
    off = segEnd;
    if (marker === 0xda) {
      // Entropy-coded data runs until a marker that is neither stuffing (FF00)
      // nor a restart (FFD0-FFD7).
      let p = off;
      for (;;) {
        need(buf, p + 2);
        if (buf[p] === 0xff) {
          const next = buf[p + 1]!;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        p++;
      }
      out.push(buf.subarray(off, p));
      off = p;
    }
  }
  return { width, height, bytes: Buffer.concat(out), stripped };
}

// ------------------------------------------------------------------ WebP

function cleanWebp(buf: Buffer) {
  need(buf, 12);
  const riffEnd = 8 + buf.readUInt32LE(4);
  if (riffEnd > buf.length || riffEnd < 12) throw new Corrupt("RIFF size");
  const chunks: Buffer[] = [];
  const stripped: string[] = [];
  let off = 12;
  let width = 0;
  let height = 0;
  let vp8x: Buffer | null = null;
  while (off < riffEnd) {
    need(buf, off + 8);
    const fourcc = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const dataEnd = off + 8 + size;
    const padded = dataEnd + (size & 1);
    if (dataEnd > riffEnd) throw new Corrupt("chunk size");
    const data = buf.subarray(off + 8, dataEnd);
    if (fourcc === "EXIF" || fourcc === "XMP ") {
      stripped.push(fourcc.trim());
    } else {
      const copy = Buffer.from(buf.subarray(off, Math.min(padded, riffEnd)));
      if (fourcc === "VP8X") {
        if (size < 10) throw new Corrupt("VP8X");
        vp8x = copy;
        width = data.readUIntLE(4, 3) + 1;
        height = data.readUIntLE(7, 3) + 1;
      } else if (fourcc === "VP8 " && !vp8x && width === 0) {
        if (size < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw new Corrupt("VP8");
        width = data.readUInt16LE(6) & 0x3fff;
        height = data.readUInt16LE(8) & 0x3fff;
      } else if (fourcc === "VP8L" && !vp8x && width === 0) {
        if (size < 5 || data[0] !== 0x2f) throw new Corrupt("VP8L");
        const bits = data.readUInt32LE(1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >> 14) & 0x3fff) + 1;
      }
      chunks.push(copy);
    }
    off = padded;
  }
  if (vp8x) vp8x[8] = vp8x[8]! & ~(0x08 | 0x04); // clear the EXIF and XMP flags
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "latin1");
  return { width, height, bytes: Buffer.concat([header, body]), stripped };
}

// ------------------------------------------------------------------ GIF

function cleanGif(buf: Buffer) {
  need(buf, 13);
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const flags = buf[10]!;
  let off = 13;
  if (flags & 0x80) off += 3 * (1 << ((flags & 7) + 1));
  need(buf, off);
  const out: Buffer[] = [buf.subarray(0, off)];
  const stripped: string[] = [];
  /** Offset just past a run of data sub-blocks starting at p. */
  const subBlocksEnd = (p: number) => {
    for (;;) {
      need(buf, p + 1);
      const n = buf[p]!;
      p += 1 + n;
      if (n === 0) return p;
    }
  };
  for (;;) {
    need(buf, off + 1);
    const b = buf[off]!;
    if (b === 0x3b) {
      out.push(buf.subarray(off, off + 1));
      break;
    }
    if (b === 0x21) {
      need(buf, off + 2);
      const label = buf[off + 1]!;
      const end = subBlocksEnd(off + 2);
      let keep = true;
      if (label === 0xfe) keep = false; // comment
      else if (label === 0xff) {
        need(buf, off + 14);
        const app = buf.toString("latin1", off + 3, off + 14);
        keep = app === "NETSCAPE2.0" || app === "ANIMEXTS1.0";
      }
      if (keep) out.push(buf.subarray(off, end));
      else stripped.push(label === 0xfe ? "comment" : "application");
      off = end;
    } else if (b === 0x2c) {
      need(buf, off + 10);
      const lflags = buf[off + 9]!;
      let p = off + 10;
      if (lflags & 0x80) p += 3 * (1 << ((lflags & 7) + 1));
      p += 1; // LZW minimum code size
      const end = subBlocksEnd(p);
      out.push(buf.subarray(off, end));
      off = end;
    } else {
      throw new Corrupt("block");
    }
  }
  return { width, height, bytes: Buffer.concat(out), stripped };
}

// ------------------------------------------------------------------ entry

/**
 * Sniff, measure and strip one uploaded image. Pure: bytes in, verdict out.
 * The size cap applies to what was sent, before stripping, so nobody can hide a
 * large payload in metadata that would be thrown away anyway.
 */
export function inspectBoardImage(input: Buffer): BoardImageResult {
  if (!input.length) return { ok: false, reason: "empty", message: "The image is empty." };
  if (input.length > BOARD_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      message: `Images are at most ${formatBoardBytes(BOARD_IMAGE_MAX_BYTES)}; that one is ${formatBoardBytes(input.length)}.`,
    };
  }
  const mime = sniffImageMime(input);
  if (!mime) return { ok: false, reason: "format", message: "Only PNG, JPEG, WebP and GIF images can be posted." };
  let cleaned: { width: number; height: number; bytes: Buffer; stripped: string[] };
  try {
    cleaned =
      mime === "image/png" ? cleanPng(input) : mime === "image/jpeg" ? cleanJpeg(input) : mime === "image/webp" ? cleanWebp(input) : cleanGif(input);
  } catch (e) {
    if (e instanceof Corrupt || e instanceof RangeError) {
      return { ok: false, reason: "corrupt", message: "That image could not be read. Try saving it again." };
    }
    throw e;
  }
  const { width, height } = cleaned;
  if (!width || !height) return { ok: false, reason: "corrupt", message: "That image could not be read. Try saving it again." };
  if (width > BOARD_IMAGE_MAX_SIDE || height > BOARD_IMAGE_MAX_SIDE || width * height > BOARD_IMAGE_MAX_PIXELS) {
    return {
      ok: false,
      reason: "dimensions",
      message: `That image is ${width} x ${height}. Images are at most ${BOARD_IMAGE_MAX_SIDE} pixels on a side and ${BOARD_IMAGE_MAX_PIXELS / 1_000_000} megapixels.`,
    };
  }
  return { ok: true, mime, width, height, bytes: cleaned.bytes, stripped: cleaned.stripped };
}
