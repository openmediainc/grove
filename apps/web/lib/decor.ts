/**
 * Plot decor on the map (#45): the pure half.
 *
 *  - `plotDecor`: what a plot from the minimap may draw. The server already
 *    sends none for a private plot; this drops it again so a stale or hand-made
 *    payload still cannot dress held land, and re-checks the shape.
 *  - `decorHoles`: decor sits in the world art pass UNDER the bodies (#52). A
 *    1x1 prop in front of a body could still cover its feet, so the renderer
 *    cuts the decor away round every body box it overlaps. This returns those
 *    cut-outs, relative to nothing but screen px, or null when nothing overlaps
 *    (the common case: no clip at all).
 */
import {
  DECOR_MAX_ITEMS,
  PLOT_BUILDING,
  PLOT_COLS,
  PLOT_DECOR_SLOTS,
  PLOT_ROWS,
  readStoredDecor,
  type DecorItem,
  type DecorPreset,
} from "@grove/protocol";
import { holeRuns, overlaps, type Rect } from "@/lib/layering";

export function plotDecor(preset: string | null | undefined, raw: unknown): DecorItem[] {
  if (preset === "private") return [];
  return readStoredDecor(raw);
}

/** A decor sprite's extent round its anchor (north vertex of the slot), layout px. Matches bakeAnchored(1, 1, 70). */
export const DECOR_EXTENT = { left: 36, right: 36, up: 70, down: 40 } as const;

export function decorScreenRect(lx: number, ly: number, zoom: number, px: number, py: number): Rect {
  const sx = lx * zoom + px;
  const sy = ly * zoom + py;
  return {
    x0: sx - DECOR_EXTENT.left * zoom,
    x1: sx + DECOR_EXTENT.right * zoom,
    y0: sy - DECOR_EXTENT.up * zoom,
    y1: sy + DECOR_EXTENT.down * zoom,
  };
}

/** Non-overlapping screen rects to cut out of a decor box, or null when no body overlaps it. */
export function decorHoles(box: Rect, bodies: readonly Rect[], cell: number): Rect[] | null {
  const hits = bodies.filter((b) => overlaps(box, b));
  if (!hits.length) return null;
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const local = hits.map((b) => ({ x0: b.x0 - box.x0, x1: b.x1 - box.x0, y0: b.y0 - box.y0, y1: b.y1 - box.y0 }));
  return holeRuns(local, cell, { w, h }).map((r) => ({ x0: r.x0 + box.x0, x1: r.x1 + box.x0, y0: r.y0 + box.y0, y1: r.y1 + box.y0 }));
}

/**
 * Paint one decor item, cut away round any body it overlaps. `paint` draws in
 * the current (layout) transform; the clip is built in screen space.
 */
export function paintDecorClear(
  ctx: CanvasRenderingContext2D,
  paint: () => void,
  lx: number,
  ly: number,
  bodies: readonly Rect[],
  view: { zoom: number; px: number; py: number; dpr: number },
): void {
  const box = decorScreenRect(lx, ly, view.zoom, view.px, view.py);
  const holes = decorHoles(box, bodies, Math.max(4, 6 * view.zoom));
  if (!holes) {
    paint();
    return;
  }
  ctx.save();
  const layout = ctx.getTransform();
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const path = new Path2D();
  path.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
  for (const r of holes) path.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  ctx.clip(path, "evenodd");
  ctx.setTransform(layout);
  paint();
  ctx.restore();
}

/* ---- Manage → Decor: the editor's pure half ------------------------- */

/** One cell of the 8x6 plot preview, north row first. */
export type DecorCell =
  | { kind: "building" }
  | { kind: "door" }
  | { kind: "slot"; slot: number }
  | { kind: "ground" };

/** The plot as the Manage preview lays it out: building, door, the decor slots, open ground. */
export function decorGrid(): DecorCell[][] {
  const rows: DecorCell[][] = [];
  for (let dy = 0; dy < PLOT_ROWS; dy++) {
    const row: DecorCell[] = [];
    for (let dx = 0; dx < PLOT_COLS; dx++) {
      const b = PLOT_BUILDING;
      const slot = PLOT_DECOR_SLOTS.findIndex((s) => s.dx === dx && s.dy === dy);
      if (dx >= b.dx && dx < b.dx + b.w && dy >= b.dy && dy < b.dy + b.h) row.push({ kind: "building" });
      else if (dx === b.dx + 1 && dy === b.dy + b.h) row.push({ kind: "door" });
      else if (slot >= 0) row.push({ kind: "slot", slot });
      else row.push({ kind: "ground" });
    }
    rows.push(row);
  }
  return rows;
}

export type PlaceResult = { ok: true; items: DecorItem[] } | { ok: false; message: string };

/**
 * Put `preset` on `slot` (replacing what was there), or clear the slot with
 * null. The server re-checks everything; this only keeps the draft honest.
 */
export function placeDecor(items: readonly DecorItem[], slot: number, preset: DecorPreset | null, max = DECOR_MAX_ITEMS): PlaceResult {
  const rest = items.filter((i) => i.slot !== slot);
  if (preset === null) return { ok: true, items: rest };
  if (rest.length >= max) return { ok: false, message: `Up to ${max} items. Clear a spot first.` };
  return { ok: true, items: [...rest, { preset, slot }].sort((a, b) => a.slot - b.slot) };
}

export function sameDecor(a: readonly DecorItem[], b: readonly DecorItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.slot === b[i]!.slot && x.preset === b[i]!.preset);
}
