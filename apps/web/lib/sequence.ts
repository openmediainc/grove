/**
 * Cinematic sequences (queue #39): the map's half, pure.
 *
 * The schema, validation and the link encoding live in @grove/protocol
 * (sequences.ts), shared with the API that stores long sequences. This file is
 * what the map needs to PLAY one and to RECORD one:
 *
 *  - `buildTimeline` / `cameraAt`: where the camera is `elapsed` ms into a
 *    sequence. Time comes in as an argument, so the same inputs always frame
 *    the same shot, and the map owns the clock (wall time live, gated on the
 *    replay clock when a replay is on).
 *  - the shot shapes (push, path, orbit, hold) as easing over tile framings.
 *    An orbit is a slow circular pan round a point with the zoom breathing; the
 *    isometric projection itself never rotates.
 *  - reduced motion: every glide becomes a cut, and every shot holds half as
 *    long again.
 *  - a follow target is looked up by the caller in the PUBLIC minimap; when it
 *    is not there (private now, gone) the camera holds where it last was.
 *  - `clampCamera`: a framing pulled onto the world, the same rule as #38.
 *  - recording: shots appended from the viewer's own camera moves.
 *  - the link: inline `?seq=` when short enough, else the stored id.
 */
import {
  SEQUENCE_MAX_SHOTS,
  SEQUENCE_MAX_TOTAL_MS,
  SEQUENCE_QUERY,
  SEQUENCE_URL_MAX,
  encodeSequence,
  sequenceDuration,
  validateSequence,
  type CameraKey,
  type Sequence,
  type SequenceShot,
  type SequenceShotKind,
} from "@grove/protocol";
import { clampTile, type TileRect } from "./camera";

/** An orbit sweeps a full circle in this long: slow enough to read the world going by. */
export const ORBIT_PERIOD_MS = 40_000;
/** An orbit started on (or almost on) its centre circles at this many tiles. */
export const ORBIT_MIN_RADIUS = 3;
/** How much an orbit's zoom breathes either side of its line. */
export const ORBIT_BREATH = 0.05;
/** How far a path shot pulls out at its middle (fraction of zoom). */
export const PATH_PULL = 0.15;
/** How far a path shot bows sideways, as a fraction of its length. */
export const PATH_BOW = 0.18;
/** Under reduced motion every shot holds this much longer. */
export const REDUCED_HOLD_SCALE = 1.5;

export const SHOT_KINDS: readonly SequenceShotKind[] = ["path", "push", "orbit", "hold"];
export const SHOT_LABEL: Record<SequenceShotKind, string> = { push: "Push", path: "Path", orbit: "Orbit", hold: "Hold" };

const clamp01 = (p: number) => (p < 0 ? 0 : p > 1 ? 1 : p);

export function easeInOutCubic(p: number): number {
  const x = clamp01(p);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export function easeInOutSine(p: number): number {
  return (1 - Math.cos(Math.PI * clamp01(p))) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Zoom moves geometrically, so 0.5 → 2 feels as even as 1 → 4. */
export function lerpZoom(a: number, b: number, t: number): number {
  return Math.exp(lerp(Math.log(a), Math.log(b), t));
}

export interface TimelineShot {
  shot: SequenceShot;
  start: number;
  end: number;
}

export interface Timeline {
  shots: TimelineShot[];
  total: number;
  reduced: boolean;
}

export function buildTimeline(seq: Sequence, opts: { reduced: boolean }): Timeline {
  const scale = opts.reduced ? REDUCED_HOLD_SCALE : 1;
  let at = 0;
  const shots = seq.shots.map((shot) => {
    const start = at;
    at += shot.durationMs * scale;
    return { shot, start, end: at };
  });
  return { shots, total: at, reduced: opts.reduced };
}

/** The shot `elapsed` ms in, and how far through it (0..1). Past the end: the last shot at 1. */
export function shotAt(tl: Timeline, elapsed: number): { index: number; p: number; done: boolean } {
  const last = tl.shots.length - 1;
  if (last < 0) return { index: -1, p: 1, done: true };
  if (elapsed >= tl.total) return { index: last, p: 1, done: true };
  const t = Math.max(0, elapsed);
  for (let i = 0; i <= last; i++) {
    const s = tl.shots[i]!;
    if (t < s.end) return { index: i, p: (t - s.start) / Math.max(1, s.end - s.start), done: false };
  }
  return { index: last, p: 1, done: true };
}

/** The framing a shot shows at progress `p`, with no follow target. */
export function shotFraming(shot: SequenceShot, p: number, reduced: boolean): CameraKey {
  const { from, to } = shot;
  if (shot.kind === "hold") return { ...from };
  if (reduced) return p < 0.5 ? { ...from } : { ...to };
  switch (shot.kind) {
    case "push": {
      const e = easeInOutCubic(p);
      return { tx: lerp(from.tx, to.tx, e), ty: lerp(from.ty, to.ty, e), zoom: lerpZoom(from.zoom, to.zoom, e) };
    }
    case "path": {
      const e = easeInOutSine(p);
      const dx = to.tx - from.tx;
      const dy = to.ty - from.ty;
      // A quadratic bow: the control point sits off the straight line, to one side.
      const cx = (from.tx + to.tx) / 2 - dy * PATH_BOW;
      const cy = (from.ty + to.ty) / 2 + dx * PATH_BOW;
      const u = 1 - e;
      const pull = 1 - PATH_PULL * Math.sin(Math.PI * clamp01(p));
      return {
        tx: u * u * from.tx + 2 * u * e * cx + e * e * to.tx,
        ty: u * u * from.ty + 2 * u * e * cy + e * e * to.ty,
        zoom: lerpZoom(from.zoom, to.zoom, e) * pull,
      };
    }
    case "orbit": {
      const r0 = Math.hypot(from.tx - to.tx, from.ty - to.ty);
      const radius = r0 < 0.5 ? ORBIT_MIN_RADIUS : r0;
      const a0 = r0 < 0.5 ? -Math.PI / 2 : Math.atan2(from.ty - to.ty, from.tx - to.tx);
      const sweep = (2 * Math.PI * shot.durationMs) / ORBIT_PERIOD_MS;
      const a = a0 + sweep * clamp01(p);
      const breath = 1 + ORBIT_BREATH * Math.sin(2 * Math.PI * clamp01(p));
      return {
        tx: to.tx + radius * Math.cos(a),
        ty: to.ty + radius * Math.sin(a),
        zoom: lerpZoom(from.zoom, to.zoom, easeInOutSine(p)) * breath,
      };
    }
  }
  return { ...from };
}

/** Where a follow target stands now, in tiles, or null when the public map does not carry it. */
export type ResolveFollow = (slug: string) => { tx: number; ty: number } | null;

export interface CameraFrame {
  camera: CameraKey;
  index: number;
  done: boolean;
  /** True when this shot asked to follow a body the public map does not carry. */
  lostFollow: boolean;
}

/**
 * The camera `elapsed` ms into the timeline.
 *
 * A shot with a follow target keeps that body in the middle, at the shot's own
 * zoom. When the body is not on the public map, the camera holds at `last` —
 * the camera the map showed on its previous frame — or, with none, where the
 * shot began: it never guesses where a private body went.
 */
export function cameraAt(tl: Timeline, elapsed: number, resolve: ResolveFollow, last: CameraKey | null = null): CameraFrame {
  const { index, p, done } = shotAt(tl, elapsed);
  if (index < 0) return { camera: last ?? { tx: 0, ty: 0, zoom: 1 }, index, done: true, lostFollow: false };
  const shot = tl.shots[index]!.shot;
  const framing = shotFraming(shot, p, tl.reduced);
  if (!shot.follow) return { camera: framing, index, done, lostFollow: false };
  const at = resolve(shot.follow);
  if (!at) return { camera: last ? { ...last } : { ...shot.from }, index, done, lostFollow: true };
  return { camera: { tx: at.tx, ty: at.ty, zoom: framing.zoom }, index, done, lostFollow: false };
}

/** A framing pulled onto the world and into the zoom range (#38's rule). */
export function clampCamera(cam: CameraKey, bounds: TileRect, zoom: { min: number; max: number }): CameraKey {
  const at = clampTile(cam, bounds);
  return { tx: at.tx, ty: at.ty, zoom: Math.min(zoom.max, Math.max(zoom.min, cam.zoom)) };
}

/* ---- recording ------------------------------------------------------- */

export interface Draft {
  title: string;
  /** The framing the recording started from: the first shot's start. */
  start: CameraKey | null;
  shots: SequenceShot[];
}

export function emptyDraft(start: CameraKey | null): Draft {
  return { title: "", start, shots: [] };
}

export function draftDuration(d: Draft): number {
  return sequenceDuration(d);
}

/** Whether one more shot of `durationMs` still fits the caps. */
export function canAddShot(d: Draft, durationMs: number): boolean {
  return d.shots.length < SEQUENCE_MAX_SHOTS && draftDuration(d) + durationMs <= SEQUENCE_MAX_TOTAL_MS;
}

/**
 * Append a shot that ends on the camera the viewer has now. It starts where the
 * last shot ended (or where recording began). A hold stays on the current
 * camera; an orbit circles the current camera from where the last shot ended.
 * `follow` must already be a slug off the public map, or null.
 */
export function addShot(d: Draft, current: CameraKey, kind: SequenceShotKind, durationMs: number, follow: string | null): Draft {
  if (!canAddShot(d, durationMs)) return d;
  const prev = d.shots.length ? d.shots[d.shots.length - 1]!.to : (d.start ?? current);
  const cur = { tx: current.tx, ty: current.ty, zoom: current.zoom };
  const shot: SequenceShot =
    kind === "hold"
      ? { kind, from: cur, to: { ...cur }, follow, durationMs }
      : { kind, from: { ...prev }, to: cur, follow, durationMs };
  return { ...d, start: d.start ?? cur, shots: [...d.shots, shot] };
}

export function removeLastShot(d: Draft): Draft {
  return { ...d, shots: d.shots.slice(0, -1) };
}

/** The draft as a validated sequence, or the reason it is not one yet. */
export function draftSequence(d: Draft): ReturnType<typeof validateSequence> {
  return validateSequence({ v: 1, title: d.title, shots: d.shots });
}

/* ---- the link -------------------------------------------------------- */

const MODE_PARAMS = ["kiosk", "tv", "follow", "at", SEQUENCE_QUERY];

function baseUrl(current: string): URL {
  const url = new URL(current);
  for (const k of MODE_PARAMS) url.searchParams.delete(k);
  url.hash = "";
  return url;
}

/**
 * The share link for a sequence: inline when the encoding is short enough,
 * otherwise `null` — the caller stores it and uses `storedSequenceLink`. Keeps
 * what belongs to the address (a theme pin, `?history=1`), drops other modes.
 */
export function inlineSequenceLink(current: string, seq: Sequence): string | null {
  const enc = encodeSequence(seq);
  if (enc.length > SEQUENCE_URL_MAX) return null;
  const url = baseUrl(current);
  url.searchParams.set(SEQUENCE_QUERY, enc);
  return url.toString();
}

export function storedSequenceLink(current: string, id: string): string {
  const url = baseUrl(current);
  url.searchParams.set(SEQUENCE_QUERY, id);
  return url.toString();
}

/** "0:42". */
export function formatRunTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
