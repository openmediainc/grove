/**
 * The map camera's bounds (queue #38): the pure half.
 *
 * The map draws in "layout space" (iso tile position + a centring offset) and
 * shows it at `screen = layout * zoom + pan`. These functions decide how far
 * that view may go, so every camera — a drag, a pinch, a bookmark glide, the
 * follow-cam, the kiosk tour, Grove TV and a `?at=` link — ends inside one
 * rule, and the rule can be tested without a canvas:
 *
 *  - Zoomed all the way out, the WHOLE world fits the viewport, on a 390px
 *    phone as on a desktop (`zoomRange`). The floor is far below any campus
 *    that exists so the fit always wins.
 *  - The world may be dragged until its edge is `margin` px inside the
 *    viewport, never further: you can reach every plot and never lose the world
 *    (`clampPan`). A world smaller than the viewport is simply centred.
 *  - A tile target (a link, a glide) outside the world is pulled onto its edge
 *    (`clampTile`).
 */

export type Box = { minX: number; maxX: number; minY: number; maxY: number };
export type CameraView = { zoom: number; px: number; py: number };
export type TileRect = { x0: number; y0: number; x1: number; y1: number };

/** No campus needs to be drawn smaller than this; only here so a degenerate viewport cannot ask for 0. */
export const ZOOM_FLOOR = 0.02;
/** Breathing room round the world at fit zoom, in CSS px per side. */
export const FIT_PAD = 16;

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** The zoom at which `box` fits a `w` x `h` viewport with `pad` px to spare on every side. */
export function fitZoom(box: Box, w: number, h: number, pad = FIT_PAD): number {
  const bw = Math.max(1, box.maxX - box.minX);
  const bh = Math.max(1, box.maxY - box.minY);
  const aw = Math.max(1, w - 2 * pad);
  const ah = Math.max(1, h - 2 * pad);
  return Math.max(ZOOM_FLOOR, Math.min(aw / bw, ah / bh));
}

/**
 * How far in and out the camera goes. Out: never less far than `nominalMin`
 * (the zoom a small campus is comfortable at), but always far enough that the
 * whole world fits. In: `max`, and never below the minimum.
 */
export function zoomRange(box: Box, w: number, h: number, opts: { nominalMin: number; max: number }): { min: number; max: number } {
  const min = clamp(Math.min(opts.nominalMin, fitZoom(box, w, h)), ZOOM_FLOOR, opts.max);
  return { min, max: Math.max(min, opts.max) };
}

/** One axis of clampPan. */
function clampAxis(pan: number, lo: number, hi: number, zoom: number, view: number, margin: number): number {
  const size = (hi - lo) * zoom;
  if (size <= view) return (view - size) / 2 - lo * zoom;
  // The world's edge may come `margin` px inside the viewport, no further (capped at half the view).
  const m = Math.min(margin, view / 2);
  return clamp(pan, view - m - hi * zoom, m - lo * zoom);
}

/** The view with its pan pulled back inside the world. Zoom is left alone. */
export function clampPan(view: CameraView, box: Box, w: number, h: number, margin: number): CameraView {
  return {
    zoom: view.zoom,
    px: clampAxis(view.px, box.minX, box.maxX, view.zoom, w, margin),
    py: clampAxis(view.py, box.minY, box.maxY, view.zoom, h, margin),
  };
}

/** The view that shows the whole box, centred. */
export function fitView(box: Box, w: number, h: number, pad = FIT_PAD): CameraView {
  const zoom = fitZoom(box, w, h, pad);
  return {
    zoom,
    px: w / 2 - ((box.minX + box.maxX) / 2) * zoom,
    py: h / 2 - ((box.minY + box.maxY) / 2) * zoom,
  };
}

/** A tile pulled onto the world when it lies outside. */
export function clampTile(at: { tx: number; ty: number }, bounds: TileRect): { tx: number; ty: number } {
  return { tx: clamp(at.tx, bounds.x0, bounds.x1), ty: clamp(at.ty, bounds.y0, bounds.y1) };
}

/** The centre tile of the world. */
export function worldCentre(bounds: TileRect): { tx: number; ty: number } {
  return { tx: (bounds.x0 + bounds.x1) / 2, ty: (bounds.y0 + bounds.y1) / 2 };
}

/** The layout-space rectangle the viewport shows (for the minimap). */
export function viewportBox(view: CameraView, w: number, h: number): Box {
  const z = view.zoom || 1;
  return { minX: -view.px / z, maxX: (w - view.px) / z, minY: -view.py / z, maxY: (h - view.py) / z };
}

/**
 * The minimap's fit: a uniform scale and offset that put `box` inside a
 * `w` x `h` inset with `pad` px round it, centred. `toInset` maps a layout
 * point to the inset; `fromInset` is its exact inverse (a click on the inset).
 */
export function insetTransform(box: Box, w: number, h: number, pad = 4) {
  const bw = Math.max(1, box.maxX - box.minX);
  const bh = Math.max(1, box.maxY - box.minY);
  const s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  const ox = (w - bw * s) / 2 - box.minX * s;
  const oy = (h - bh * s) / 2 - box.minY * s;
  return {
    scale: s,
    toInset: (x: number, y: number) => ({ x: x * s + ox, y: y * s + oy }),
    fromInset: (x: number, y: number) => ({ x: (x - ox) / s, y: (y - oy) / s }),
  };
}

/** The pan that centres layout point (x, y) in the viewport at `zoom`. */
export function centreOn(x: number, y: number, zoom: number, w: number, h: number): CameraView {
  return { zoom, px: w / 2 - x * zoom, py: h / 2 - y * zoom };
}

/** Minimap collapsed state: stored choice wins; with none, phones start collapsed. */
export function insetCollapsedDefault(stored: string | null, narrow: boolean): boolean {
  if (stored === "1") return true;
  if (stored === "0") return false;
  return narrow;
}
