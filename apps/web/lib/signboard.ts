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
 * The same rule covers achievement marks: a held board never carries one.
 *
 * Marks (030) hang under the board as small medallions, one per mark the space
 * holds, in the protocol's fixed order. There is no count and no ranking to
 * draw: a space holds a mark or it does not.
 *
 * Branding (035): the owner's accent takes the board's stripe and the plot's
 * fence, with a bound org kept as a small secondary stripe; the sign text is a
 * line under the name; the emblem sits inside the board left of the text. A
 * private plot carries NONE of it — a colour or an emblem identifies a space as
 * well as its name does — whatever the payload says.
 */

import { normaliseMarks, readStoredBranding, type BrandEmblem, type SpaceBranding, type SpaceMark } from "@grove/protocol";
import type { SignEmblem, Signboard, SignLine, SignMark, ThemeLexicon } from "@/lib/themes/types";

/** Below this zoom a signboard is dropped: the text would be wider than its building. */
export const LOD_SIGNBOARD = 0.55;
/** At and above this zoom the board also lists the plot's bound orgs. */
export const LOD_SIGN_ORGS = 0.7;

export type SignPlot = {
  preset: string;
  name: string | null;
  occupancy: number;
  orgs: ReadonlyArray<{ name: string; colour: string }>;
  /** Mark keys the server published. Ignored for a private plot. */
  marks?: readonly string[];
  /** The owner's branding as the server published it. Ignored for a private plot. */
  branding?: SpaceBranding | null;
};

export type SignContent = {
  held: boolean;
  title: string;
  /** The owner's sign text, or null. */
  tagline: string | null;
  detail: string;
  orgLine: string | null;
  /** Primary stripe: owner accent, else first org colour. */
  tint: string | null;
  /** The org colour when the accent took the primary stripe. */
  secondaryTint: string | null;
  emblem: BrandEmblem | null;
  /** The owner's accent alone (colours the emblem), or null. */
  accent: string | null;
  marks: SpaceMark[];
};

/**
 * A plot's branding off the wire: re-validated, and dropped outright for a
 * private plot, so a stale or hand-made payload still cannot brand a held plot.
 */
export function plotBranding(preset: string | null | undefined, raw: unknown): SpaceBranding | null {
  if (preset === "private") return null;
  return readStoredBranding(raw);
}

/** The colour a plot's fence is drawn in: owner accent, else first org, else none. Never on a private plot. */
export function plotEdgeColour(plot: Pick<SignPlot, "preset" | "orgs" | "branding">): string | null {
  const accent = plot.preset === "private" ? null : (plot.branding?.accent ?? null);
  return accent ?? plot.orgs[0]?.colour ?? null;
}

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
    return {
      held: true,
      title: lexicon.heldPlot,
      tagline: null,
      detail: access,
      orgLine: null,
      tint: null,
      secondaryTint: null,
      emblem: null,
      accent: null,
      marks: [],
    };
  }
  const name = plot.name?.trim();
  const brand = plotBranding(plot.preset, plot.branding);
  const org = plot.orgs[0]?.colour ?? null;
  const accent = brand?.accent ?? null;
  return {
    held: false,
    title: name ? name : lexicon.claimedPlot,
    tagline: brand?.signText ?? null,
    detail: `${access}${plot.occupancy ? ` · ${plot.occupancy} here` : ""}`,
    orgLine: plot.orgs.length ? plot.orgs.map((o) => o.name).join(" · ") : null,
    tint: accent ?? org,
    secondaryTint: accent && org && org.toLowerCase() !== accent ? org : null,
    emblem: brand?.emblem ?? null,
    accent,
    marks: normaliseMarks(plot.marks),
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
/** The owner's sign text: between the name and the detail line. */
const TAGLINE_PX = 9;
/** Emblem glyph box and the gap to the text, SCREEN px. Fixed like the text. */
export const EMBLEM_PX = 12;
const EMBLEM_GAP = 4;
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
/** Mark medallion radius and the gap between two, SCREEN px. Fixed like the text. */
export const MARK_R = 6;
const MARK_GAP = 3;

/** Medallions in a row, centred under the board's bottom edge, overlapping it by a third. */
export function layoutSignMarks(marks: readonly SpaceMark[], cx: number, bottom: number): SignMark[] {
  const step = MARK_R * 2 + MARK_GAP;
  const first = cx - ((marks.length - 1) * step) / 2;
  const y = Math.round(bottom + MARK_R - 4);
  return marks.map((key, i) => ({ key, x: Math.round(first + i * step), y, r: MARK_R }));
}

/**
 * Board sizes. `plot` is a lone plot's board; `member` is a plot's own board
 * inside an estate — smaller, name and access only, because the estate's
 * shared sign carries the rest; `estate` is that shared sign (#37), a little
 * larger, sized by its words rather than by one building.
 */
type BoardSpec = { titlePx: number; detailPx: number; maxW: number; minW: number; perZoom: number; extras: boolean };
const SPECS = {
  plot: { titlePx: TITLE_PX, detailPx: DETAIL_PX, maxW: MAX_W, minW: MIN_W, perZoom: BUILDING_W * 0.8, extras: true },
  member: { titlePx: 10, detailPx: 8, maxW: 110, minW: 36, perZoom: BUILDING_W * 0.6, extras: false },
  estate: { titlePx: 13, detailPx: DETAIL_PX, maxW: 200, minW: 64, perZoom: 400, extras: false },
} as const satisfies Record<string, BoardSpec>;

/**
 * Lay out a board centred on (ax, ay), the SCREEN point on the building's
 * front where it hangs. Returns null below the zoom threshold. `compact` is a
 * plot's own board inside an estate (#37): smaller, no sign text or org line.
 */
export function layoutSignboard(
  content: SignContent,
  anchor: { x: number; y: number },
  zoom: number,
  measure: Measure,
  opts: { compact?: boolean } = {},
): Signboard | null {
  if (!signboardVisible(zoom)) return null;
  return layoutBoard(content, anchor, zoom, measure, opts.compact ? SPECS.member : SPECS.plot);
}

function layoutBoard(
  content: SignContent,
  anchor: { x: number; y: number },
  zoom: number,
  measure: Measure,
  spec: BoardSpec,
): Signboard {
  const maxW = Math.max(spec.minW, Math.min(spec.maxW, spec.perZoom * zoom));
  // A held board never carries branding, whatever the content was handed.
  const emblemKey = content.held ? null : content.emblem;
  const emblemRoom = emblemKey ? EMBLEM_PX + EMBLEM_GAP : 0;
  const inner = maxW - PAD_X * 2 - emblemRoom;
  const raw: Array<{ text: string; fontPx: number; role: SignLine["role"] }> = [
    { text: fitSignText(content.title, inner, spec.titlePx, measure), fontPx: spec.titlePx, role: "title" },
  ];
  if (spec.extras && !content.held && content.tagline) {
    raw.push({ text: fitSignText(content.tagline, inner, TAGLINE_PX, measure), fontPx: TAGLINE_PX, role: "tagline" });
  }
  raw.push({ text: fitSignText(content.detail, inner, spec.detailPx, measure), fontPx: spec.detailPx, role: "detail" });
  if (spec.extras && content.orgLine && zoom >= LOD_SIGN_ORGS) {
    raw.push({ text: fitSignText(content.orgLine, inner, DETAIL_PX, measure), fontPx: DETAIL_PX, role: "org" });
  }
  const lines = raw.filter((l) => l.text);
  const textW = Math.max(0, ...lines.map((l) => measure(l.text, l.fontPx)));
  const w = Math.round(Math.min(maxW, Math.max(spec.minW, textW + PAD_X * 2 + emblemRoom)));
  const textH = PAD_Y * 2 + lines.reduce((s, l) => s + l.fontPx + GAP, 0) - (lines.length ? GAP : 0);
  const h = Math.round(Math.max(textH, emblemKey ? EMBLEM_PX + PAD_Y * 2 : 0));
  const x0 = Math.round(anchor.x - w / 2);
  const y0 = Math.round(anchor.y - h / 2);
  const emblem: SignEmblem | null = emblemKey
    ? { key: emblemKey, cx: x0 + PAD_X + EMBLEM_PX / 2, cy: y0 + h / 2, size: EMBLEM_PX, colour: content.accent }
    : null;
  // Text centred in what is left of the board once the emblem has its column.
  const tx = x0 + emblemRoom + (w - emblemRoom) / 2;
  let cursor = y0 + Math.round((h - textH) / 2) + PAD_Y;
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
    tint: content.held ? null : content.tint,
    secondaryTint: content.held ? null : content.secondaryTint,
    emblem,
    tx: content.held ? x0 + w / 2 : tx,
    marks: content.held ? [] : layoutSignMarks(content.marks, x0 + w / 2, y0 + h),
  };
}

/* ------------------------------------------------------------------ *
 * Estates (#37): one shared sign for adjacent plots of one org or owner.
 * ------------------------------------------------------------------ */

/** Below this zoom the estate sign is dropped. Lower than a plot's: an estate is bigger. */
export const LOD_ESTATE_SIGN = 0.4;

export function estateSignVisible(zoom: number): boolean {
  return zoom >= LOD_ESTATE_SIGN;
}

export type EstateSignInput = { name: string | null; accent: string | null; plots: number };

/**
 * What the shared sign says: the estate's name (else the theme's word for an
 * estate) and how many plots it joins. No access level: access is per plot,
 * and each plot keeps its own board and building to say it. An estate is only
 * ever made of public plots (protocol estates.ts), so there is nothing held.
 */
export function estateSignContent(e: EstateSignInput, lexicon: Pick<ThemeLexicon, "estate">): SignContent {
  const name = e.name?.trim();
  return {
    held: false,
    title: name ? name : lexicon.estate.label,
    tagline: null,
    detail: `${lexicon.estate.label} · ${e.plots} ${lexicon.estate.plots}`,
    orgLine: null,
    tint: e.accent,
    secondaryTint: null,
    emblem: null,
    accent: e.accent,
    marks: [],
  };
}

export function layoutEstateSign(
  content: SignContent,
  anchor: { x: number; y: number },
  zoom: number,
  measure: Measure,
): Signboard | null {
  if (!estateSignVisible(zoom)) return null;
  return layoutBoard({ ...content, held: false, marks: [], emblem: null }, anchor, zoom, measure, SPECS.estate);
}
