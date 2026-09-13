/** Age-of-Empires-lite campus grid. Original 64px tiles are squashed to 2:1 diamonds in the client. */
export const MAP_COLS = 24;
export const MAP_ROWS = 18;

export type MapRegion = "plaza" | "library" | "workshop" | "stage" | "garden" | "board" | "wild";

type Rect = { x0: number; y0: number; x1: number; y1: number };

export const REGION_RECTS: Record<Exclude<MapRegion, "wild">, Rect> = {
  plaza: { x0: 8, y0: 6, x1: 15, y1: 11 },
  library: { x0: 8, y0: 0, x1: 15, y1: 5 },
  garden: { x0: 8, y0: 12, x1: 15, y1: 17 },
  stage: { x0: 0, y0: 6, x1: 7, y1: 11 },
  workshop: { x0: 16, y0: 6, x1: 23, y1: 11 },
  board: { x0: 16, y0: 12, x1: 23, y1: 17 },
};

export const PLAZA_CENTER = { x: 11.5, y: 8.5 };

export function regionAt(tx: number, ty: number): MapRegion {
  for (const [name, r] of Object.entries(REGION_RECTS) as Array<[Exclude<MapRegion, "wild">, Rect]>) {
    if (tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1) return name;
  }
  return "wild";
}

/** Fog radius in tiles. Grows with claimed Grove agents + live bodies; Mini-scale only. */
export function exploreRadius(claimedAgents: number, liveBodies: number): number {
  const claimed = Math.max(0, claimedAgents);
  const live = Math.max(0, liveBodies);
  return Math.min(18, 4 + claimed + Math.min(8, live));
}

export function tileExplored(tx: number, ty: number, radius: number): boolean {
  const dx = tx - PLAZA_CENTER.x;
  const dy = ty - PLAZA_CENTER.y;
  return Math.hypot(dx, dy) <= radius;
}

export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function seatInRegion(id: string, region: MapRegion): { x: number; y: number } {
  const rect = region === "wild" ? REGION_RECTS.plaza : REGION_RECTS[region];
  const h = hash32(id);
  const w = rect.x1 - rect.x0 + 1;
  const ht = rect.y1 - rect.y0 + 1;
  return { x: rect.x0 + (h % w), y: rect.y0 + (Math.floor(h / w) % ht) };
}

export function paperclipHome(role: string | undefined, status: string | undefined): MapRegion {
  const r = (role ?? "").toLowerCase();
  const s = (status ?? "").toLowerCase();
  if (s === "error") return "board";
  if (r === "ceo") return "plaza";
  if (r === "engineer") return "workshop";
  if (r === "general") return "library";
  return "workshop";
}

/* ------------------------------------------------------------------ *
 * One world that grows.
 *
 * The six civic rooms are the CORE and never move: they occupy the
 * 3x3 block of plots at the centre, which is exactly the original
 * 24x18 grid. Claimed spaces are allocated plots that spiral outward
 * around that core, so the world gets physically larger as more people
 * and agents arrive — nobody is ever relocated to make room.
 *
 * Plot coordinates are absolute tile coordinates and may be negative;
 * the renderer projects them the same way as any other tile.
 * ------------------------------------------------------------------ */

export const PLOT_COLS = 8;
export const PLOT_ROWS = 6;
/** The core spans blocks (0,0)..(2,2); its centre block is (1,1). */
const CORE_CENTER_BLOCK = { bx: 1, by: 1 };
const CORE_RING = 1;

export interface PlotRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Chebyshev ring index of a block relative to the core centre. */
export function blockRing(bx: number, by: number): number {
  return Math.max(Math.abs(bx - CORE_CENTER_BLOCK.bx), Math.abs(by - CORE_CENTER_BLOCK.by));
}

/** Number of allocatable blocks in ring r (r > CORE_RING). */
export function ringCapacity(r: number): number {
  if (r <= CORE_RING) return 0;
  const side = 2 * r + 1;
  const inner = 2 * (r - 1) + 1;
  return side * side - inner * inner;
}

/** Blocks of ring r, in a stable clockwise order starting top-left. */
function ringBlocks(r: number): Array<{ bx: number; by: number }> {
  const { bx: cx, by: cy } = CORE_CENTER_BLOCK;
  const out: Array<{ bx: number; by: number }> = [];
  const lo = -r;
  const hi = r;
  for (let dx = lo; dx <= hi; dx++) out.push({ bx: cx + dx, by: cy + lo });
  for (let dy = lo + 1; dy <= hi; dy++) out.push({ bx: cx + hi, by: cy + dy });
  for (let dx = hi - 1; dx >= lo; dx--) out.push({ bx: cx + dx, by: cy + hi });
  for (let dy = hi - 1; dy >= lo + 1; dy--) out.push({ bx: cx + lo, by: cy + dy });
  return out;
}

/**
 * Deterministic plot for the Nth claimed space. Index 0 is the first plot
 * outside the core; a space keeps its plot for life, so allocation must
 * never depend on anything but the index.
 */
export function plotForIndex(index: number): PlotRect {
  if (index < 0 || !Number.isFinite(index)) throw new RangeError("plot index must be >= 0");
  let i = Math.floor(index);
  let r = CORE_RING + 1;
  while (i >= ringCapacity(r)) {
    i -= ringCapacity(r);
    r += 1;
  }
  const block = ringBlocks(r)[i];
  // ringCapacity(r) and ringBlocks(r).length are the same number by construction,
  // so the loop above always leaves i in range; this keeps that honest under
  // noUncheckedIndexedAccess rather than asserting it away.
  if (!block) throw new RangeError(`no plot at index ${index}`);
  const { bx, by } = block;
  return {
    x0: bx * PLOT_COLS,
    y0: by * PLOT_ROWS,
    x1: bx * PLOT_COLS + PLOT_COLS - 1,
    y1: by * PLOT_ROWS + PLOT_ROWS - 1,
  };
}

/** How many rings must exist to hold `plots` claimed spaces. */
export function ringsNeeded(plots: number): number {
  let r = CORE_RING;
  let left = Math.max(0, plots);
  while (left > 0) {
    r += 1;
    left -= ringCapacity(r);
  }
  return r;
}

/**
 * Tile bounds of the whole world for a given number of claimed spaces.
 * Always includes at least one full ring of open land beyond what is
 * claimed, so there is visibly somewhere to go.
 */
export function worldBounds(plots: number): PlotRect {
  const r = Math.max(CORE_RING + 1, ringsNeeded(plots) + 1);
  const { bx: cx, by: cy } = CORE_CENTER_BLOCK;
  return {
    x0: (cx - r) * PLOT_COLS,
    y0: (cy - r) * PLOT_ROWS,
    x1: (cx + r + 1) * PLOT_COLS - 1,
    y1: (cy + r + 1) * PLOT_ROWS - 1,
  };
}

/** True when the tile belongs to the fixed civic core rather than a plot. */
export function isCoreTile(tx: number, ty: number): boolean {
  return tx >= 0 && tx < MAP_COLS && ty >= 0 && ty < MAP_ROWS;
}
