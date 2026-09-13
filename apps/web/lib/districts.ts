/**
 * Districts on the map (queue #38): the web half.
 *
 * The rule (which ring a plot is in, how names cycle) is `@grove/protocol`
 * districts.ts. This file decides what the map and the search palette SAY:
 *
 *  - On the map (ring labels, the plot peek card, Go to ▾) a district wears the
 *    active theme's words: `lexicon.district.names`.
 *  - The search palette is a plain page surface, which DECISIONS 3 keeps
 *    neutral, so a space result says "in Ring 2". The map's ring labels carry
 *    the same "ring 2" under the themed name, so the two can be matched up.
 *  - Go to ▾ lists only districts that hold a PUBLIC plot. A held (private)
 *    plot never adds a district: the list must not say "somebody is out here".
 */
import {
  PLOT_COLS,
  PLOT_ROWS,
  districtForPlot,
  districtForRing,
  districtName,
  districtsHolding,
  neutralDistrictName,
  ringOuterRect,
  type District,
} from "@grove/protocol";

export type { District };

/** Ring labels are drawn below this zoom only: zoomed in, the plots speak for themselves. */
export const DISTRICT_LABEL_MAX_ZOOM = 0.6;

export function districtLabelsVisible(zoom: number): boolean {
  return zoom < DISTRICT_LABEL_MAX_ZOOM;
}

/** The themed name of a plot's district. */
export function plotDistrictName(names: readonly string[], plotIndex: number): string {
  return districtName(names, districtForPlot(plotIndex));
}

/** "in Hearth Ring", for the peek card. */
export function inDistrict(names: readonly string[], plotIndex: number): string {
  return `in ${plotDistrictName(names, plotIndex)}`;
}

/** The small neutral line under a ring label: "ring 2". */
export function ringNumberLabel(district: District): string {
  return neutralDistrictName(district).toLowerCase();
}

/** A search row's district, neutral: "in Ring 2", or "" when the API did not say. */
export function searchDistrict(ring: number | null | undefined): string {
  if (ring === null || ring === undefined) return "";
  const d = districtForRing(ring);
  return d ? `in ${neutralDistrictName(d)}` : "";
}

export type DistrictStop = { ordinal: number; name: string; tx: number; ty: number };

/**
 * Go to ▾ entries: districts holding at least one public plot, inside out, each
 * landing on the centre of its lowest-numbered public plot.
 */
export function districtStops(
  names: readonly string[],
  plots: ReadonlyArray<{ plotIndex: number; preset: string; rect: { x0: number; y0: number; x1: number; y1: number } }>,
): DistrictStop[] {
  const open = plots.filter((p) => p.preset !== "private");
  const byIndex = new Map(open.map((p) => [p.plotIndex, p]));
  return districtsHolding(open.map((p) => p.plotIndex)).map((d) => {
    const r = byIndex.get(d.firstPlot)!.rect;
    return { ordinal: d.ordinal, name: districtName(names, d), tx: (r.x0 + r.x1) / 2, ty: (r.y0 + r.y1) / 2 };
  });
}

/** A stable key for a list of stops, so React state only changes when the list does. */
export function districtStopsKey(stops: readonly DistrictStop[]): string {
  return stops.map((s) => `${s.ordinal}:${s.tx},${s.ty}`).join("|");
}

/**
 * Where a ring's labels hang, in tiles: just inside its north and south apexes
 * (the top and bottom corners of the diamond on screen), on the ring's own band,
 * so each ring's name sits at its outer edge and rings stack like contour labels.
 */
export function ringLabelAnchors(ring: number): Array<{ tx: number; ty: number; apex: "n" | "s" }> {
  const r = ringOuterRect(ring);
  const inX = PLOT_COLS / 4;
  const inY = PLOT_ROWS / 4;
  return [
    { tx: r.x0 + inX, ty: r.y0 + inY, apex: "n" },
    { tx: r.x1 - inX, ty: r.y1 - inY, apex: "s" },
  ];
}
