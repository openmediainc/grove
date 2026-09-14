/**
 * Step 3 of the theme resolution order (lib/themes, queue #59): the default
 * the owner of the space being viewed has set.
 *
 * A space is "being viewed" when
 *   (a) the viewer opened a link that targets it — the space page's Visit
 *       (`?room=` plus `?at=` on its plot), a `?at=` or `?follow=` that lands
 *       on the plot, or a `?seq=` whose first shot starts there. The link
 *       holds while the camera travels there and stays; once the camera has
 *       arrived and then left, it is spent; or
 *   (b) the camera is centred on the plot (the nearest plot within a small
 *       radius) at plot-level zoom.
 *
 * It is only ever a SOFT default: the map applies it only while the viewer has
 * no `?theme=` pin and no stored choice of their own, and switches back to the
 * viewer's normal default when the camera leaves. Private plots: the public
 * minimap carries no default for them, so the theme comes only from the
 * member-gated list (`memberDefaults`); an outsider sees a held plot in their
 * own default.
 *
 * Pure: the map calls `viewedOwnerDefault` on a slow tick with the camera and
 * the plots it already has.
 */

import { isThemeId } from "./meta";
import type { ThemeId } from "./types";

export type ViewPlotRect = { x0: number; y0: number; x1: number; y1: number };

export type ViewPlot = {
  plotIndex: number;
  rect: ViewPlotRect;
  preset: string;
  /** From the public minimap; always null for a private plot. */
  defaultTheme: string | null;
};

export type ViewCamera = { tx: number; ty: number; zoom: number };

/** A link that targets a plot, and whether the camera has reached it yet. */
export type ViewLink = { plotIndex: number; since: number; reached: boolean };

/** At or above this zoom the camera is "on" a plot (bookmarks glide to 1.15, districts to 0.75). */
export const PLOT_THEME_ZOOM = 0.9;
/** Once on a plot, zooming out a little does not drop it. */
export const PLOT_THEME_STAY_ZOOM = 0.8;
/** How far outside a plot (tiles) the camera centre may be to pick it up. */
export const PLOT_THEME_RADIUS = 1;
/** How far outside the current plot the camera centre may drift before it is dropped. */
export const PLOT_THEME_STAY_RADIUS = 1.5;
/** A link whose camera never arrives (a glide given up, the viewer took over) stops applying. */
export const LINK_REACH_MS = 12_000;

/** Distance in tiles from a point to a plot's footprint (tile centres are integers); 0 inside. */
export function distanceToPlot(tx: number, ty: number, rect: ViewPlotRect): number {
  const dx = Math.max(rect.x0 - 0.5 - tx, 0, tx - (rect.x1 + 0.5));
  const dy = Math.max(rect.y0 - 0.5 - ty, 0, ty - (rect.y1 + 0.5));
  return Math.hypot(dx, dy);
}

/** The plot nearest a tile within `radius`, or null. Ties go to the lower index, so the answer is stable. */
export function nearestPlot<P extends ViewPlot>(tx: number, ty: number, plots: readonly P[], radius: number): P | null {
  let best: P | null = null;
  let bestD = Infinity;
  for (const p of plots) {
    const d = distanceToPlot(tx, ty, p.rect);
    if (d > radius) continue;
    if (d < bestD || (d === bestD && best !== null && p.plotIndex < best.plotIndex)) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/**
 * The plot the camera is centred on, at plot-level zoom, or null. `current` is
 * the plot picked last time: it is kept with a little slack (zoom and radius)
 * so the theme does not flicker when the camera hovers on an edge.
 */
export function cameraCentredPlot<P extends ViewPlot>(camera: ViewCamera, plots: readonly P[], current: number | null = null): P | null {
  if (current !== null && camera.zoom >= PLOT_THEME_STAY_ZOOM) {
    const cur = plots.find((p) => p.plotIndex === current);
    if (cur && distanceToPlot(camera.tx, camera.ty, cur.rect) <= PLOT_THEME_STAY_RADIUS) return cur;
  }
  if (camera.zoom < PLOT_THEME_ZOOM) return null;
  return nearestPlot(camera.tx, camera.ty, plots, PLOT_THEME_RADIUS);
}

/**
 * A plot's owner default as this viewer may see it. A private plot's comes
 * only from the member list (by plot index); anything from the public payload
 * for a private plot is ignored, so a stale or hand-made payload cannot leak it.
 */
export function plotOwnerDefault(plot: ViewPlot, memberDefaults: ReadonlyMap<number, string>): ThemeId | null {
  const raw = plot.preset === "private" ? memberDefaults.get(plot.plotIndex) ?? null : plot.defaultTheme;
  return isThemeId(raw) ? raw : null;
}

/** Start a link at the plot under a tile (a `?at=`, a followed body, a sequence's first shot), if there is one. */
export function linkAtTile(tx: number, ty: number, plots: readonly ViewPlot[], now: number): ViewLink | null {
  const p = nearestPlot(tx, ty, plots, 0);
  return p ? { plotIndex: p.plotIndex, since: now, reached: false } : null;
}

export type ViewedOwnerDefault = {
  /** The plot being viewed, or null. Feed back in as `current`. */
  plotIndex: number | null;
  /** The link state to keep (null once spent). */
  link: ViewLink | null;
  /** The owner default to use as step 3, or null for none. */
  theme: ThemeId | null;
};

export function viewedOwnerDefault(input: {
  camera: ViewCamera;
  plots: readonly ViewPlot[];
  memberDefaults: ReadonlyMap<number, string>;
  link: ViewLink | null;
  current: number | null;
  now: number;
}): ViewedOwnerDefault {
  const { camera, plots, memberDefaults, now } = input;
  let link = input.link;
  if (link) {
    const target = plots.find((p) => p.plotIndex === link!.plotIndex);
    if (!target) link = null;
    else {
      const d = distanceToPlot(camera.tx, camera.ty, target.rect);
      if (!link.reached && d <= PLOT_THEME_RADIUS) link = { ...link, reached: true };
      const holds = link.reached ? d <= PLOT_THEME_STAY_RADIUS : now - link.since <= LINK_REACH_MS;
      if (holds) return { plotIndex: target.plotIndex, link, theme: plotOwnerDefault(target, memberDefaults) };
      link = null;
    }
  }
  const p = cameraCentredPlot(camera, plots, input.current);
  return { plotIndex: p?.plotIndex ?? null, link: null, theme: p ? plotOwnerDefault(p, memberDefaults) : null };
}

/** Below this zoom the camera is not heading for any one plot, so nothing is fetched ahead (#79). */
export const PRELOAD_THEME_ZOOM = 0.6;
/** How far outside a plot (tiles) the camera centre may be for its default to be fetched ahead (#79). */
export const PRELOAD_THEME_RADIUS = 4;

/**
 * The owner default worth fetching BEFORE it applies (#79): the target of a
 * live link (the camera is gliding there), else the plot the camera is closing
 * in on — nearer than `PRELOAD_THEME_RADIUS` at a zoom that is heading for
 * plots. Only aoe ships with the map, so without this a space's default would
 * arrive a beat after the camera does. Same privacy as the default itself: a
 * private plot's comes only from the member list.
 */
export function approachingOwnerDefault(input: {
  camera: ViewCamera;
  plots: readonly ViewPlot[];
  memberDefaults: ReadonlyMap<number, string>;
  link: ViewLink | null;
}): ThemeId | null {
  const { camera, plots, memberDefaults, link } = input;
  if (link) {
    const target = plots.find((p) => p.plotIndex === link.plotIndex);
    const t = target ? plotOwnerDefault(target, memberDefaults) : null;
    if (t) return t;
  }
  if (camera.zoom < PRELOAD_THEME_ZOOM) return null;
  const near = nearestPlot(camera.tx, camera.ty, plots, PRELOAD_THEME_RADIUS);
  return near ? plotOwnerDefault(near, memberDefaults) : null;
}

/** The tile at the middle of a plot, for a link that should land on it (the space page's Visit). */
export function plotCentreTile(rect: ViewPlotRect): { tx: number; ty: number } {
  return { tx: Math.round((rect.x0 + rect.x1) / 2), ty: Math.round((rect.y0 + rect.y1) / 2) };
}
