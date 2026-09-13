/**
 * Districts (queue #38): the rings of the plot spiral, named.
 *
 * Plots spiral outward around the fixed 3x3-block civic core (map-layout.ts),
 * one Chebyshev ring of blocks at a time. A district is one of those rings. It
 * is a NAME for where land sits, never a permission and never a ranking: an
 * inner ring is not better ground, only older.
 *
 * Pure, so the search API, the map and the tests agree on one rule:
 *
 *  - The core is blocks within ring 1 of the core centre. It is not a district.
 *  - The first ring of plots (ring 2) is district 1, ring 3 is district 2, …
 *  - Names come from a list (a theme's lexicon on the map; a neutral "Ring N"
 *    on plain pages). Beyond the end of the list the names cycle with a Roman
 *    numeral: with six names, district 7 is the first name + " II".
 */
import { PLOT_COLS, PLOT_ROWS, blockRing, plotForIndex, ringsNeeded, type PlotRect } from "./map-layout.js";

/** The block ring of the first plots outside the core. */
export const FIRST_DISTRICT_RING = 2;

export interface District {
  /** Chebyshev block ring around the core centre (>= 2). */
  ring: number;
  /** 1-based district number: ring 2 is district 1. */
  ordinal: number;
}

function blockOfTile(tx: number, ty: number): { bx: number; by: number } {
  return { bx: Math.floor(tx / PLOT_COLS), by: Math.floor(ty / PLOT_ROWS) };
}

/** The block ring a plot sits in (always >= 2). */
export function ringForPlotIndex(index: number): number {
  const r = plotForIndex(index);
  const { bx, by } = blockOfTile(r.x0, r.y0);
  return blockRing(bx, by);
}

/** The block ring a tile sits in. The core is ring 0 or 1. */
export function ringForTile(tx: number, ty: number): number {
  const { bx, by } = blockOfTile(Math.floor(tx), Math.floor(ty));
  return blockRing(bx, by);
}

/** The district of a ring, or null for the civic core. */
export function districtForRing(ring: number): District | null {
  if (!Number.isFinite(ring) || ring < FIRST_DISTRICT_RING) return null;
  const r = Math.floor(ring);
  return { ring: r, ordinal: r - FIRST_DISTRICT_RING + 1 };
}

/** Every plot has a district. */
export function districtForPlot(index: number): District {
  return districtForRing(ringForPlotIndex(index))!;
}

/** A tile's district, or null on the civic core. */
export function districtForTile(tx: number, ty: number): District | null {
  return districtForRing(ringForTile(tx, ty));
}

const ROMAN: ReadonlyArray<readonly [number, string]> = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

/** 1 → "I", 14 → "XIV". Anything below 1 is "". Capped at 3999, which no campus reaches. */
export function toRoman(n: number): string {
  let left = Math.min(3999, Math.floor(n));
  if (!(left >= 1)) return "";
  let out = "";
  for (const [v, s] of ROMAN) {
    while (left >= v) {
      out += s;
      left -= v;
    }
  }
  return out;
}

/**
 * A district's name from a list of names. The list cycles; the second time
 * round a name gets " II", the third " III". An empty list falls back to the
 * neutral name.
 */
export function districtName(names: readonly string[], district: District): string {
  const usable = names.map((n) => n.trim()).filter(Boolean);
  if (!usable.length) return neutralDistrictName(district);
  const i = district.ordinal - 1;
  const base = usable[i % usable.length]!;
  const cycle = Math.floor(i / usable.length);
  return cycle > 0 ? `${base} ${toRoman(cycle + 1)}` : base;
}

/** The plain-page name, for surfaces that do not wear a theme (DECISIONS 3). */
export function neutralDistrictName(district: District): string {
  return `Ring ${district.ordinal}`;
}

/** Tile bounds of the whole square a ring encloses (its outer edge). */
export function ringOuterRect(ring: number): PlotRect {
  const r = Math.max(0, Math.floor(ring));
  // Core centre block is (1,1); see map-layout.ts.
  return {
    x0: (1 - r) * PLOT_COLS,
    y0: (1 - r) * PLOT_ROWS,
    x1: (2 + r) * PLOT_COLS - 1,
    y1: (2 + r) * PLOT_ROWS - 1,
  };
}

/** The outermost ring that exists for a world of `plots` claimed spaces (always one open ring). */
export function outermostRing(plots: number): number {
  return Math.max(FIRST_DISTRICT_RING, ringsNeeded(plots) + 1);
}

/** Every district of a world of `plots` claimed spaces, inside out, including the open ring. */
export function worldDistricts(plots: number): District[] {
  const out: District[] = [];
  for (let r = FIRST_DISTRICT_RING; r <= outermostRing(plots); r++) out.push(districtForRing(r)!);
  return out;
}

/**
 * The districts that hold at least one of these plots, inside out, each with
 * the lowest plot index it holds (where "Go to" lands). Callers pass only the
 * plots they may name: the map passes public plots, never held ones.
 */
export function districtsHolding(plotIndices: Iterable<number>): Array<District & { firstPlot: number }> {
  const byRing = new Map<number, number>();
  for (const idx of plotIndices) {
    if (!Number.isInteger(idx) || idx < 0) continue;
    const ring = ringForPlotIndex(idx);
    const seen = byRing.get(ring);
    if (seen === undefined || idx < seen) byRing.set(ring, idx);
  }
  return [...byRing.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ring, firstPlot]) => ({ ...districtForRing(ring)!, firstPlot }));
}

