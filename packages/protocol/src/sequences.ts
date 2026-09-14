/**
 * Cinematic sequences (queue #39): a camera path over the map, shareable as a
 * link.
 *
 * A sequence is an ordered list of shots. Each shot moves the camera from one
 * framing to another over a duration:
 *
 *   push   a straight, eased move — usually a push in (zoom) on a subject
 *   path   a travelling shot: pulls out a touch, arcs across, settles in
 *   orbit  a slow circular pan round `to` (starting where `from` is), with the
 *          zoom breathing gently. The projection never rotates: the map is an
 *          isometric picture and a rotated one would be a different world.
 *   hold   the camera stays on `from`
 *
 * A framing is a TILE (fractional) and a zoom, never screen pixels, so one link
 * frames the same ground on a phone and on a wall display; the map pulls every
 * framing onto the world with the same clamp as a drag (#38).
 *
 * PRIVACY. A sequence holds camera positions and, per shot, at most the slug of
 * a body to follow. It never names a plot or a space. A follow slug is resolved
 * against the PUBLIC minimap when the sequence plays; a body that is not there
 * (private now, gone, never existed) is not followed and the camera holds where
 * it last was. The title is the author's own words, one line.
 *
 * Pure and shared: the web map, the Copy-link button and the API that stores a
 * long sequence validate with this one function, so they cannot disagree.
 */
import { graphemeCount } from "./graphemes.js";

export const SEQUENCE_KINDS = ["push", "orbit", "path", "hold"] as const;
export type SequenceShotKind = (typeof SEQUENCE_KINDS)[number];

export const SEQUENCE_MAX_SHOTS = 12;
export const SEQUENCE_MAX_TOTAL_MS = 60_000;
export const SEQUENCE_MIN_SHOT_MS = 500;
export const SEQUENCE_TITLE_MAX = 60;
/** A stored sequence's JSON may be at most this many bytes. */
export const SEQUENCE_MAX_BYTES = 32 * 1024;
/** An encoded sequence at most this long rides in the link itself; longer ones are stored. */
export const SEQUENCE_URL_MAX = 1500;
/** Far beyond any campus; only here so a pasted link cannot ask for Infinity. */
export const SEQUENCE_TILE_LIMIT = 4096;
export const SEQUENCE_ZOOM_MIN = 0.02;
export const SEQUENCE_ZOOM_MAX = 4;
export const SEQUENCE_QUERY = "seq";
/** Stored sequence ids: `seq_` + a ULID. */
export const SEQUENCE_ID_RE = /^seq_[0-9A-HJKMNP-TV-Z]{26}$/;

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\p{Co}]|(?!‍)\p{Cf}/u;

export interface CameraKey {
  tx: number;
  ty: number;
  zoom: number;
}

export interface SequenceShot {
  kind: SequenceShotKind;
  from: CameraKey;
  to: CameraKey;
  /** A public body's slug to keep in frame, or null. */
  follow: string | null;
  durationMs: number;
}

export interface Sequence {
  v: 1;
  title: string | null;
  shots: SequenceShot[];
}

export type SequenceResult = { ok: true; sequence: Sequence } | { ok: false; message: string };

function fail(message: string): SequenceResult {
  return { ok: false, message };
}

function round(n: number, places: number): number {
  const k = 10 ** places;
  return Math.round(n * k) / k;
}

function readKey(raw: unknown, where: string): CameraKey | string {
  if (!raw || typeof raw !== "object") return `${where} must be a camera position.`;
  const r = raw as Record<string, unknown>;
  const { tx, ty, zoom } = r;
  if (typeof tx !== "number" || typeof ty !== "number" || typeof zoom !== "number") return `${where} needs tx, ty and zoom numbers.`;
  if (!Number.isFinite(tx) || !Number.isFinite(ty) || Math.abs(tx) > SEQUENCE_TILE_LIMIT || Math.abs(ty) > SEQUENCE_TILE_LIMIT) {
    return `${where} is off the map.`;
  }
  if (!Number.isFinite(zoom) || zoom < SEQUENCE_ZOOM_MIN || zoom > SEQUENCE_ZOOM_MAX) return `${where} zoom is out of range.`;
  // Stored at the precision a camera can show: a tenth of a tile, a hundredth of zoom.
  return { tx: round(tx, 1), ty: round(ty, 1), zoom: round(zoom, 2) };
}

/** One line of plain text, at most SEQUENCE_TITLE_MAX characters; blank = no title. */
export function readSequenceTitle(raw: unknown): { ok: true; title: string | null } | { ok: false; message: string } {
  if (raw === null || raw === undefined) return { ok: true, title: null };
  if (typeof raw !== "string") return { ok: false, message: "Title must be text." };
  if (FORBIDDEN_TEXT.test(raw)) return { ok: false, message: "Title must be one line of plain text." };
  const title = raw.replace(/\s+/g, " ").trim().normalize("NFC");
  if (!title) return { ok: true, title: null };
  if (graphemeCount(title) > SEQUENCE_TITLE_MAX) return { ok: false, message: `Title can be at most ${SEQUENCE_TITLE_MAX} characters.` };
  return { ok: true, title };
}

/** Total running time of a (valid) sequence, in ms. */
export function sequenceDuration(seq: Pick<Sequence, "shots">): number {
  return seq.shots.reduce((n, s) => n + s.durationMs, 0);
}

/**
 * Validate and normalise anything claiming to be a sequence. Unknown fields are
 * dropped, numbers are rounded to what a camera can show, a hold's `to` is its
 * `from`. The result is the canonical form every reader stores and plays.
 */
export function validateSequence(raw: unknown): SequenceResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("A sequence must be an object.");
  const r = raw as Record<string, unknown>;
  if (r.v !== undefined && r.v !== 1) return fail("Unknown sequence version.");
  const title = readSequenceTitle(r.title);
  if (!title.ok) return fail(title.message);
  if (!Array.isArray(r.shots)) return fail("A sequence needs a list of shots.");
  if (r.shots.length === 0) return fail("A sequence needs at least one shot.");
  if (r.shots.length > SEQUENCE_MAX_SHOTS) return fail(`A sequence can have at most ${SEQUENCE_MAX_SHOTS} shots.`);
  const shots: SequenceShot[] = [];
  let total = 0;
  for (let i = 0; i < r.shots.length; i++) {
    const s = r.shots[i] as Record<string, unknown> | null;
    const where = `Shot ${i + 1}`;
    if (!s || typeof s !== "object") return fail(`${where} must be an object.`);
    const kind = s.kind;
    if (typeof kind !== "string" || !(SEQUENCE_KINDS as readonly string[]).includes(kind)) {
      return fail(`${where} kind must be one of ${SEQUENCE_KINDS.join(", ")}.`);
    }
    const from = readKey(s.from, `${where} start`);
    if (typeof from === "string") return fail(from);
    const to = kind === "hold" && s.to === undefined ? from : readKey(s.to, `${where} end`);
    if (typeof to === "string") return fail(to);
    let follow: string | null = null;
    if (s.follow !== undefined && s.follow !== null && s.follow !== "") {
      if (typeof s.follow !== "string" || !SLUG_RE.test(s.follow)) return fail(`${where} follows something that is not a body.`);
      follow = s.follow;
    }
    const d = s.durationMs;
    if (typeof d !== "number" || !Number.isFinite(d)) return fail(`${where} needs a duration.`);
    const durationMs = Math.round(d / 100) * 100;
    if (durationMs < SEQUENCE_MIN_SHOT_MS) return fail(`${where} must last at least ${SEQUENCE_MIN_SHOT_MS / 1000} s.`);
    total += durationMs;
    if (total > SEQUENCE_MAX_TOTAL_MS) return fail(`A sequence can run at most ${SEQUENCE_MAX_TOTAL_MS / 1000} s.`);
    shots.push({ kind: kind as SequenceShotKind, from, to: kind === "hold" ? { ...from } : to, follow, durationMs });
  }
  const sequence: Sequence = { v: 1, title: title.title, shots };
  if (utf8Bytes(JSON.stringify(sequence)).length > SEQUENCE_MAX_BYTES) return fail("That sequence is too large.");
  return { ok: true, sequence };
}

/* ---- the link ---------------------------------------------------------- *
 * Compact positional JSON, UTF-8, base64url:
 *   [1, title|0, [[kind, tx, ty, zoom, tx, ty, zoom, durationMs, follow?], ...]]
 * A hold writes its framing once. Kinds are one letter.
 * ------------------------------------------------------------------------ */

const KIND_LETTER: Record<SequenceShotKind, string> = { push: "u", orbit: "o", path: "p", hold: "h" };
const LETTER_KIND: Record<string, SequenceShotKind> = { u: "push", o: "orbit", p: "path", h: "hold" };

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  const enc = encodeURIComponent(s);
  for (let i = 0; i < enc.length; i++) {
    const c = enc[i]!;
    if (c === "%") {
      out.push(parseInt(enc.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c.charCodeAt(0));
  }
  return out;
}

function utf8Decode(bytes: number[]): string {
  let s = "";
  for (const b of bytes) s += `%${b.toString(16).padStart(2, "0")}`;
  return decodeURIComponent(s);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64Url(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (b !== undefined) out += B64[(n >> 6) & 63]!;
    if (c !== undefined) out += B64[n & 63]!;
  }
  return out;
}

function fromBase64Url(s: string): number[] | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return out;
}

/** The compact link form of a VALID sequence. */
export function encodeSequence(seq: Sequence): string {
  const shots = seq.shots.map((s) => {
    const row: Array<string | number> = [KIND_LETTER[s.kind], s.from.tx, s.from.ty, s.from.zoom];
    if (s.kind !== "hold") row.push(s.to.tx, s.to.ty, s.to.zoom);
    row.push(s.durationMs);
    if (s.follow) row.push(s.follow);
    return row;
  });
  return toBase64Url(utf8Bytes(JSON.stringify([1, seq.title ?? 0, shots])));
}

/** A link's `?seq=` value back into a validated sequence, or null for anything malformed. */
export function decodeSequence(encoded: string): Sequence | null {
  if (!encoded || encoded.length > SEQUENCE_MAX_BYTES * 2) return null;
  const bytes = fromBase64Url(encoded);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(bytes));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed[0] !== 1 || !Array.isArray(parsed[2])) return null;
  const shots: unknown[] = [];
  for (const row of parsed[2] as unknown[]) {
    if (!Array.isArray(row)) return null;
    const kind = LETTER_KIND[String(row[0])];
    if (!kind) return null;
    const hold = kind === "hold";
    const from = { tx: row[1], ty: row[2], zoom: row[3] };
    const to = hold ? from : { tx: row[4], ty: row[5], zoom: row[6] };
    const rest = hold ? 4 : 7;
    shots.push({ kind, from, to, durationMs: row[rest], follow: row[rest + 1] ?? null });
  }
  const r = validateSequence({ v: 1, title: parsed[1] === 0 ? null : parsed[1], shots });
  return r.ok ? r.sequence : null;
}

/** What a `?seq=` value names: a sequence carried inline, a stored id, or nothing usable. */
export type SequenceRef = { kind: "inline"; sequence: Sequence } | { kind: "id"; id: string } | null;

export function parseSequenceRef(raw: string | null): SequenceRef {
  if (!raw) return null;
  const s = raw.trim();
  if (SEQUENCE_ID_RE.test(s)) return { kind: "id", id: s };
  const sequence = decodeSequence(s);
  return sequence ? { kind: "inline", sequence } : null;
}
