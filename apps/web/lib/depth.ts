/**
 * Depth view (queue #46): the map's adapted 3D, as pure functions.
 *
 * Glasshouse stays Canvas 2D isometric (DECISIONS: 3D is adapted, not adopted).
 * Depth view is a viewer preference layered over the ordinary camera
 * (lib/camera `CameraView`), never stored in a shot, a link or a sequence:
 *
 *  - **Tilt.** The ground plane is squashed or stretched vertically about the
 *    point at the centre of the viewport, as if the camera's elevation moved
 *    between flatter and steeper than the flat 2:1 projection (30°, because
 *    TH/TW = 0.5 = sin 30°). The centre point never moves, so a recorded
 *    camera key, a `?at=` link and a cinematic shot frame the same tile in
 *    either mode. Upright things (buildings, bodies, props, signs) are placed
 *    on the tilted ground but keep their own height: the tilt moves their
 *    ANCHOR, never squashes their art.
 *  - **Parallax.** While the camera pans, the ground trails the upright layer
 *    by a few pixels and settles back when it stops. At rest the two layers
 *    agree exactly, so hit-testing reads the upright layer and is exact. Off
 *    under reduced motion (tilt only).
 *  - **Height cues.** A soft shadow under things by their height, a slight
 *    shrink of far upright art, and a faint haze toward the far (top) edge.
 *
 * Every screen <-> layout mapping here has an exact inverse, and the camera's
 * bounds (#38) are re-derived for the tilted view so fit and clamp still hold.
 */

import { clampPan, fitZoom, zoomRange, type Box, type CameraView } from "./camera";

/** The flat projection's elevation: TH/TW = 0.5 = sin 30°. */
export const FLAT_ANGLE = 30;
/** How far Depth view may tilt, in degrees of camera elevation. */
export const DEPTH_ANGLE_MIN = 26;
export const DEPTH_ANGLE_MAX = 40;
/** The angle Depth view uses: a lower, longer look across the world. */
export const DEPTH_ANGLE = 26;
/** localStorage: "1" when the viewer turned Depth view on. Off by default. */
export const DEPTH_KEY = "grove-depth-view";

/** How much the ground trails a pan, as a share of the pan. */
export const PARALLAX_SHARE = 0.08;
/** The furthest the ground ever trails, in CSS px. */
export const PARALLAX_MAX = 10;
/** How quickly a trail settles, ms (e-folding time). */
export const PARALLAX_SETTLE_MS = 140;
/** A per-frame jump bigger than this is a cut, not a pan: no trail. */
export const PARALLAX_CUT_PX = 240;
/** Far upright art is drawn up to this much smaller at the top edge. */
export const PERSPECTIVE_SHRINK = 0.06;
/** How quickly the tilt eases in and out when toggled, ms (e-folding time). */
export const TILT_EASE_MS = 120;

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Vertical scale of the ground for a camera elevation, relative to the flat map (1 at 30°). */
export function tiltFor(angleDeg: number): number {
  const a = clamp(angleDeg, DEPTH_ANGLE_MIN, DEPTH_ANGLE_MAX);
  return Math.sin((a * Math.PI) / 180) / Math.sin((FLAT_ANGLE * Math.PI) / 180);
}

/** The stored preference: only an explicit "1" turns it on. */
export function depthPreference(stored: string | null): boolean {
  return stored === "1";
}

/** The layout point under the centre of a `w` x `h` viewport (the tilt's fixed point). */
export function focusOf(view: CameraView, w: number, h: number): { fx: number; fy: number } {
  const z = view.zoom || 1;
  return { fx: (w / 2 - view.px) / z, fy: (h / 2 - view.py) / z };
}

/** A layout y moved onto the tilted ground about the focus row `fy`. Identity when k = 1. */
export function tiltY(y: number, fy: number, k: number): number {
  return k === 1 ? y : fy + (y - fy) * k;
}

/** Exact inverse of tiltY. */
export function untiltY(y: number, fy: number, k: number): number {
  return k === 1 ? y : fy + (y - fy) / k;
}

/** Layout -> CSS screen px, for the upright layer (what hit-testing reads). */
export function toScreen(view: CameraView, w: number, h: number, k: number, x: number, y: number): { x: number; y: number } {
  const { fy } = focusOf(view, w, h);
  return { x: x * view.zoom + view.px, y: tiltY(y, fy, k) * view.zoom + view.py };
}

/** CSS screen px -> layout. The exact inverse of toScreen. */
export function fromScreen(view: CameraView, w: number, h: number, k: number, sx: number, sy: number): { x: number; y: number } {
  const z = view.zoom || 1;
  const { fy } = focusOf(view, w, h);
  return { x: (sx - view.px) / z, y: untiltY((sy - view.py) / z, fy, k) };
}

/**
 * The canvas transform (a, b, c, d, e, f in CSS px; multiply by dpr) that draws
 * RAW layout coordinates onto the tilted ground, trailed by `lag`. With k = 1
 * and no lag it is exactly the flat `layout * zoom + pan`.
 */
export function groundTransform(
  view: CameraView,
  w: number,
  h: number,
  k: number,
  lag: { x: number; y: number } = { x: 0, y: 0 },
): [number, number, number, number, number, number] {
  const z = view.zoom;
  const { fy } = focusOf(view, w, h);
  return [z, 0, 0, z * k, view.px + lag.x, view.py + fy * z * (1 - k) + lag.y];
}

/** A layout box with its height scaled by the tilt, for sizing questions (fit, zoom range). */
function tiltedSize(box: Box, k: number): Box {
  return { minX: box.minX, maxX: box.maxX, minY: box.minY * k, maxY: box.maxY * k };
}

/** fitZoom for the tilted world: it is `k` times as tall on screen. */
export function fitZoomTilted(box: Box, w: number, h: number, k: number, pad?: number): number {
  return fitZoom(tiltedSize(box, k), w, h, pad);
}

/** zoomRange for the tilted world: zoomed right out, the whole tilted world still fits. */
export function zoomRangeTilted(box: Box, w: number, h: number, k: number, opts: { nominalMin: number; max: number }) {
  return zoomRange(tiltedSize(box, k), w, h, opts);
}

/**
 * clampPan for the tilted view. Horizontally nothing changes. Vertically the
 * tilted world is an ordinary world drawn at zoom `z * k` with pan
 * `cy - (cy - py) * k`; clamp that, then map the pan back.
 */
export function clampPanTilted(view: CameraView, box: Box, w: number, h: number, margin: number, k: number): CameraView {
  if (k === 1) return clampPan(view, box, w, h, margin);
  const cy = h / 2;
  const x = clampPan(view, box, w, h, margin);
  const pyk = cy - (cy - view.py) * k;
  const y = clampPan({ zoom: view.zoom * k, px: view.px, py: pyk }, box, w, h, margin);
  return { zoom: view.zoom, px: x.px, py: cy - (cy - y.py) / k };
}

/** The layout rectangle the tilted viewport shows (the minimap's rectangle, #38). */
export function viewportBoxTilted(view: CameraView, w: number, h: number, k: number): Box {
  const a = fromScreen(view, w, h, k, 0, 0);
  const b = fromScreen(view, w, h, k, w, h);
  return { minX: a.x, maxX: b.x, minY: a.y, maxY: b.y };
}

/**
 * The flat-camera aim that puts layout row `y` at screen row `wantY` once
 * tilted. Follow-cam and glides compute `py = aim - y * zoom`; passing
 * `aimScreenY(wantY, h, k)` as the aim makes that exact under tilt.
 */
export function aimScreenY(wantY: number, h: number, k: number): number {
  const cy = h / 2;
  return k === 1 ? wantY : cy - (cy - wantY) / k;
}

/**
 * One frame of the ground's trail. `moved` is how far the focus moved this
 * frame, in CSS px at the current zoom (layout delta x zoom). The ground trails
 * a share of it, capped, and settles back on its own. A cut (a jump far bigger
 * than any drag) and reduced motion leave no trail.
 */
export function stepParallax(
  lag: { x: number; y: number },
  moved: { x: number; y: number },
  dtMs: number,
  reduced: boolean,
): { x: number; y: number } {
  if (reduced) return { x: 0, y: 0 };
  if (Math.hypot(moved.x, moved.y) > PARALLAX_CUT_PX) return { x: 0, y: 0 };
  const decay = Math.exp(-Math.max(0, dtMs) / PARALLAX_SETTLE_MS);
  const nx = clamp((lag.x + moved.x * PARALLAX_SHARE) * decay, -PARALLAX_MAX, PARALLAX_MAX);
  const ny = clamp((lag.y + moved.y * PARALLAX_SHARE) * decay, -PARALLAX_MAX, PARALLAX_MAX);
  return { x: Math.abs(nx) < 0.01 ? 0 : nx, y: Math.abs(ny) < 0.01 ? 0 : ny };
}

/** Ease the drawn tilt toward its target. Reduced motion snaps. */
export function easeTilt(current: number, target: number, dtMs: number, reduced: boolean): number {
  if (reduced) return target;
  const next = current + (target - current) * (1 - Math.exp(-Math.max(0, dtMs) / TILT_EASE_MS));
  return Math.abs(next - target) < 0.002 ? target : next;
}

/**
 * How big far upright art is drawn: 1 on the lower half of the screen,
 * shrinking toward the top edge. Never above 1, so an upright thing never
 * outgrows the box its layering (#52) and decor cut-aways were computed for.
 */
export function perspectiveScale(screenY: number, h: number, depth: number): number {
  if (depth <= 0 || h <= 0) return 1;
  const far = clamp((h / 2 - screenY) / (h / 2), 0, 1);
  return 1 - PERSPECTIVE_SHRINK * depth * far;
}

/** How tall a layer stands: sets its shadow. */
export type LayerHeight = "prop" | "body" | "building";
const HEIGHT: Record<LayerHeight, number> = { prop: 0.45, body: 0.6, building: 1 };

/**
 * A soft ground shadow for something standing on a footprint, in layout px
 * relative to the footprint's ground centre: half-axes, an offset away from
 * the light (up-left), and an alpha. Taller layers throw bigger, darker shadows;
 * the ellipse lies on the ground, so its height follows the tilt.
 */
export function shadowSpec(
  footprint: { fw: number; fh: number },
  layer: LayerHeight,
  k: number,
  tile: { w: number; h: number },
): { rx: number; ry: number; dx: number; dy: number; alpha: number } {
  const hgt = HEIGHT[layer];
  const across = ((footprint.fw + footprint.fh) / 2) * (tile.w / 2);
  const rx = across * (layer === "body" ? 0.42 : 0.5 + 0.1 * hgt);
  const ry = rx * (tile.h / tile.w) * k;
  return { rx, ry, dx: rx * 0.14 * hgt, dy: ry * 0.18 * hgt, alpha: 0.28 + 0.22 * hgt };
}
