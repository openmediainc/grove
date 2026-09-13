/**
 * Plot signboards: what a claimed plot's sign says, and where the box goes.
 *
 * Pure. The renderer (WorldMap) collects one input per visible plot, lays it
 * out here in SCREEN space so the text is the same readable size at every
 * zoom, and hands the box to the active theme's `signboard()` slot, which only
 * decides how the board looks (THEMES.md). Placement and wording are not the
 * theme's to change.
 *
 * Privacy rule: a private plot's sign NEVER carries a name, owner, org or
 * headcount — not even when the viewer is its owner and the server sent the
 * name. The world map is watched on kiosks and TV; a private plot reads
 * "Held plot" (the theme's `heldPlot`) and its closed access label, nothing else.
 */

import type { Signboard, SignLine, ThemeLexicon } from "@/lib/themes/types";

/** Below this zoom a signboard is dropped: the text would be wider than its building. */
export const LOD_SIGNBOARD = 0.55;
/** At and above this zoom the board also lists the plot's bound orgs. */
export const LOD_SIGN_ORGS = 0.7;

export type SignPlot = {
  preset: string;
  name: string | null;
  occupancy: number;
  orgs: ReadonlyArray<{ name: string; colour: string }>;
};

export type SignContent = {
  held: boolean;
  title: string;
  detail: string;
  orgLine: string | null;
  tint: string | null;
};

export function signboardVisible(zoom: number): boolean {
  return zoom >= LOD_SIGNBOARD;
}

/** What the sign says. Private plots are held: no name, no orgs, no headcount. */
export function signContent(
  plot: SignPlot,
  lexicon: Pick<ThemeLexicon, "heldPlot" | "claimedPlot" | "access">,
): SignContent {
  const access = (lexicon.access as Record<string, { label: string } | undefined>)[plot.preset]?.label ?? plot.preset;
  if (plot.preset === "private") {
    return { held: true, title: lexicon.heldPlot, detail: access, orgLine: null, tint: null };
  }
  const name = plot.name?.trim();
  return {
    held: false,
    title: name ? name : lexicon.claimedPlot,
    detail: `${access}${plot.occupancy ? ` · ${plot.occupancy} here` : ""}`,
    orgLine: plot.orgs.length ? plot.orgs.map((o) => o.name).join(" · ") : null,
    tint: plot.orgs[0]?.colour ?? null,
  };
}

/** Measures `text` in CSS px at `fontPx`. The renderer passes ctx.measureText. */
export type Measure = (text: string, fontPx: number) => number;

/** Clip with an ellipsis so the text fits `maxW`. */
export function fitSignText(text: string, maxW: number, fontPx: number, measure: Measure): string {
  if (!text) return "";
  if (measure(text, fontPx) <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${text.slice(0, mid)}…`, fontPx) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : "";
}

const TITLE_PX = 11;
const DETAIL_PX = 9;
const PAD_X = 6;
const PAD_Y = 4;
const GAP = 2;
/** Never narrower than this, so a short name still reads as a board. */
const MIN_W = 44;
/** Never wider than this, however far in you zoom. */
const MAX_W = 150;
/** A 3x3 building is this many layout px wide; the board keeps inside ~80% of it. */
const BUILDING_W = 3 * 64;

/**
 * Lay out a board centred on (ax, ay), the SCREEN point on the building's
 * front where it hangs. Returns null below the zoom threshold.
 */
export function layoutSignboard(
  content: SignContent,
  anchor: { x: number; y: number },
  zoom: number,
  measure: Measure,
): Signboard | null {
  if (!signboardVisible(zoom)) return null;
  const maxW = Math.max(MIN_W, Math.min(MAX_W, BUILDING_W * zoom * 0.8));
  const inner = maxW - PAD_X * 2;
  const raw: Array<{ text: string; fontPx: number; role: SignLine["role"] }> = [
    { text: fitSignText(content.title, inner, TITLE_PX, measure), fontPx: TITLE_PX, role: "title" },
    { text: fitSignText(content.detail, inner, DETAIL_PX, measure), fontPx: DETAIL_PX, role: "detail" },
  ];
  if (content.orgLine && zoom >= LOD_SIGN_ORGS) {
    raw.push({ text: fitSignText(content.orgLine, inner, DETAIL_PX, measure), fontPx: DETAIL_PX, role: "org" });
  }
  const lines = raw.filter((l) => l.text);
  const textW = Math.max(0, ...lines.map((l) => measure(l.text, l.fontPx)));
  const w = Math.round(Math.min(maxW, Math.max(MIN_W, textW + PAD_X * 2)));
  const h = Math.round(PAD_Y * 2 + lines.reduce((s, l) => s + l.fontPx + GAP, 0) - (lines.length ? GAP : 0));
  const x0 = Math.round(anchor.x - w / 2);
  const y0 = Math.round(anchor.y - h / 2);
  let cursor = y0 + PAD_Y;
  const placed: SignLine[] = lines.map((l) => {
    const y = cursor + l.fontPx / 2;
    cursor += l.fontPx + GAP;
    return { text: l.text, fontPx: l.fontPx, y, role: l.role };
  });
  return {
    x0,
    y0,
    x1: x0 + w,
    y1: y0 + h,
    ax: Math.round(anchor.x),
    ay: Math.round(anchor.y),
    lines: placed,
    held: content.held,
    tint: content.tint,
  };
}
