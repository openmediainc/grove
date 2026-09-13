/**
 * Resting at plot: an agent nobody is running, drawn dimmed at its home plot.
 *
 * The server already decided who may be shown (minimap `resting`: public plots
 * only, no private room doors, claimed agents with no presence). This file is
 * the map's half, kept pure so the rules are testable without a canvas:
 *
 *  - a resting body is never a live body. It is kept apart from the actor list,
 *    so the headcount, TV cuts, the idle bell and ?follow= never see it; and if
 *    a live body with the same id is on the map, the live one wins and the
 *    resting one is dropped (a poll racing a wake-up must not draw both);
 *  - it is only drawn on a plot this viewer's map actually carries, and never
 *    on a private one, even if a row ever claimed otherwise;
 *  - it carries a name and a tile, nothing a caption could turn into work.
 */
import { assignRestTiles, plotForIndex, type Tile } from "@grove/protocol";

/** One `resting` row as it arrives (snake or camel case). */
export type RestingWire = {
  id: string;
  slug?: string;
  display_name?: string;
  displayName?: string;
  plot_index?: number;
  plotIndex?: number;
};

export type RestingBody = { id: string; slug: string; name: string; plotIndex: number; tile: Tile };

/** A plot as the map knows it: index and access preset. */
export type RestingPlot = { plotIndex: number; preset: string };

export function restingBodies(
  rows: readonly RestingWire[] | undefined,
  plots: readonly RestingPlot[],
  liveIds: ReadonlySet<string>,
): RestingBody[] {
  if (!rows?.length) return [];
  const open = new Set(plots.filter((p) => p.preset !== "private").map((p) => p.plotIndex));
  const byPlot = new Map<number, Array<{ id: string; slug: string; name: string }>>();
  const seen = new Set<string>();
  for (const r of rows) {
    const idx = r.plot_index ?? r.plotIndex;
    if (!r.id || idx == null || !Number.isInteger(idx) || idx < 0) continue;
    if (!open.has(idx) || liveIds.has(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    const slug = r.slug ?? r.id;
    const list = byPlot.get(idx) ?? [];
    list.push({ id: r.id, slug, name: r.display_name ?? r.displayName ?? slug });
    byPlot.set(idx, list);
  }
  const out: RestingBody[] = [];
  for (const [plotIndex, list] of byPlot) {
    const tiles = assignRestTiles(
      list.map((b) => b.id),
      plotForIndex(plotIndex),
    );
    for (const b of list) {
      const tile = tiles.get(b.id);
      if (tile) out.push({ ...b, plotIndex, tile });
    }
  }
  return out;
}
