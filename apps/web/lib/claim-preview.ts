/**
 * Preview before claiming (queue #48): what Create space's preview draws and
 * says. Pure, so the redaction and the camera are testable without a canvas.
 *
 * Nothing here reserves anything. The preview shows the plot a space created
 * NOW would get (the API's read of the next free index) and the plots around
 * it as the public map shows them; the create request re-checks all of it.
 *
 * Privacy: a private space previews two ways. "As visitors see it" is the map's
 * truth — a held plot with no name, sign text, emblem or accent (signContent's
 * held board) — and is the default. "As you see it" shows the owner their name
 * and branding on the closed building, with the closed access word.
 */
import {
  PLOT_COLS,
  PLOT_ROWS,
  plotBlock,
  plotForIndex,
  plotNeighbourhood,
  readStoredBranding,
  redactNeighbour,
  ringForPlotIndex,
  type PlotRect,
  type SpaceBranding,
} from "@grove/protocol";
import { plotEdgeColour, signContent, type SignContent, type SignPlot } from "@/lib/signboard";
import type { ThemeLexicon } from "@/lib/themes/types";

/** GET /api/v1/spaces/claim-preview, off the wire. */
export type WireClaimPreview = {
  plot_index: number;
  ring: number;
  neighbours: Array<{
    plot_index: number;
    policy_preset: string;
    name: string | null;
    orgs: Array<{ name: string; colour: string }>;
    branding: unknown;
  }>;
};

export type ViewAs = "owner" | "visitors";

/** A private space opens on what everyone else sees. */
export function defaultViewAs(preset: string): ViewAs {
  return preset === "private" ? "visitors" : "owner";
}

export type DraftSpace = { name: string; preset: string; branding: SpaceBranding | null };

export type PreviewPlot = {
  plotIndex: number;
  rect: PlotRect;
  /** The building drawn: the access level, never softened. */
  access: "private" | "public_view" | "public_write";
  sign: SignContent;
  /** Fence colour, or null. */
  fence: string | null;
  mine: boolean;
};

function accessOf(preset: string): PreviewPlot["access"] {
  return preset === "private" || preset === "public_view" ? preset : "public_write";
}

type Lex = Pick<ThemeLexicon, "heldPlot" | "claimedPlot" | "access">;

/** The would-be space's own plot, as the chosen viewer sees it. */
export function draftPlot(plotIndex: number, draft: DraftSpace, viewAs: ViewAs, lexicon: Lex): PreviewPlot {
  const priv = draft.preset === "private";
  const base: SignPlot = { preset: draft.preset, name: draft.name.trim() || null, occupancy: 0, orgs: [], branding: draft.branding };
  let sign: SignContent;
  let fence: string | null;
  if (priv && viewAs === "visitors") {
    // Exactly the map's held board: signContent drops everything for private.
    sign = signContent({ ...base, branding: null, name: null }, lexicon);
    fence = null;
  } else if (priv) {
    // The owner's view: their name and branding, still on the closed building,
    // still saying closed.
    sign = { ...signContent({ ...base, preset: "public_view" }, lexicon), detail: lexicon.access.private.label };
    fence = draft.branding?.accent ?? null;
  } else {
    sign = signContent(base, lexicon);
    fence = plotEdgeColour(base);
  }
  return { plotIndex, rect: plotForIndex(plotIndex), access: accessOf(draft.preset), sign, fence, mine: true };
}

/** A neighbouring plot, re-redacted on this side too: a private one is held whatever the wire said. */
export function neighbourPlot(n: WireClaimPreview["neighbours"][number], lexicon: Lex): PreviewPlot {
  const safe = redactNeighbour({
    plotIndex: n.plot_index,
    policyPreset: n.policy_preset,
    name: n.name,
    orgs: n.orgs ?? [],
    branding: readStoredBranding(n.branding),
  });
  const plot: SignPlot = { preset: safe.policyPreset, name: safe.name, occupancy: 0, orgs: safe.orgs, branding: safe.branding };
  return {
    plotIndex: safe.plotIndex,
    rect: plotForIndex(safe.plotIndex),
    access: accessOf(safe.policyPreset),
    sign: signContent(plot, lexicon),
    fence: plotEdgeColour(plot),
    mine: false,
  };
}

/** Every plot the preview draws, back to front (by the south-most tile). */
export function previewScene(
  preview: Pick<WireClaimPreview, "plot_index" | "neighbours">,
  draft: DraftSpace,
  viewAs: ViewAs,
  lexicon: Lex,
): PreviewPlot[] {
  const plots = [
    ...preview.neighbours.filter((n) => n.plot_index !== preview.plot_index).map((n) => neighbourPlot(n, lexicon)),
    draftPlot(preview.plot_index, draft, viewAs, lexicon),
  ];
  return plots.sort((a, b) => a.rect.x1 + a.rect.y1 - (b.rect.x1 + b.rect.y1));
}

/** The tiles the preview draws: the target's block and the eight around it. */
export function previewWindow(plotIndex: number): PlotRect {
  const { bx, by } = plotBlock(plotIndex);
  return {
    x0: (bx - 1) * PLOT_COLS,
    y0: (by - 1) * PLOT_ROWS,
    x1: (bx + 2) * PLOT_COLS - 1,
    y1: (by + 2) * PLOT_ROWS - 1,
  };
}

const TW = 64;
const TH = 32;
export const PREVIEW_MIN_ZOOM = 0.3;
export const PREVIEW_MAX_ZOOM = 1;

export function isoPoint(tx: number, ty: number): { x: number; y: number } {
  return { x: (tx - ty) * (TW / 2), y: (tx + ty) * (TH / 2) };
}

/**
 * The camera: the target plot centred, zoomed so roughly a block of neighbours
 * shows on each side on a wide canvas, and never so far out the target's own
 * building is a speck on a phone. Layout space is iso(); screen = layout * zoom + pan.
 */
export function previewCamera(plotIndex: number, cssW: number, cssH: number): { zoom: number; px: number; py: number } {
  const r = plotForIndex(plotIndex);
  const c = isoPoint((r.x0 + r.x1 + 1) / 2, (r.y0 + r.y1 + 1) / 2);
  // Two blocks across in each direction: (2*COLS + 2*ROWS) tiles of iso width.
  const spanW = (2 * PLOT_COLS + 2 * PLOT_ROWS) * (TW / 2);
  const spanH = (2 * PLOT_COLS + 2 * PLOT_ROWS) * (TH / 2);
  const fit = Math.min(Math.max(1, cssW) / spanW, Math.max(1, cssH) / spanH);
  const zoom = Math.min(PREVIEW_MAX_ZOOM, Math.max(PREVIEW_MIN_ZOOM, fit));
  return { zoom, px: cssW / 2 - c.x * zoom, py: cssH / 2 - c.y * zoom };
}

/** Canvas height for a width: a landscape frame, bounded so a phone keeps the form in reach. */
export function previewHeight(cssW: number): number {
  return Math.round(Math.min(380, Math.max(220, cssW * 0.62)));
}

/** Neutral words under the preview (DECISIONS 3: pages stay neutral). */
export function plotCaption(plotIndex: number, ring = ringForPlotIndex(plotIndex)): string {
  return `Plot ${plotIndex} · Ring ${ring}`;
}

/** The access sentence the preview says under the canvas. */
export function viewLine(preset: string, viewAs: ViewAs): string {
  if (preset !== "private") return "Everyone sees this sign and building on the map.";
  return viewAs === "visitors"
    ? "Everyone else sees a held plot: no name, sign text, emblem or colour."
    : "Only you and the members you let in see this. The map shows everyone else a held plot.";
}

/** POST /api/v1/worlds with an expected plot, off the wire. */
export type WireCreated = {
  world: { id: string; slug: string; plot_index: number | null; policy_preset: string };
  expected_plot_index?: number;
  plot_changed?: boolean;
};

export type CreateOutcome =
  | { kind: "as_previewed"; slug: string }
  | { kind: "moved"; slug: string; from: number; to: number; message: string };

export function createOutcome(r: WireCreated): CreateOutcome {
  const to = r.world.plot_index;
  if (r.plot_changed && typeof r.expected_plot_index === "number" && typeof to === "number") {
    return {
      kind: "moved",
      slug: r.world.slug,
      from: r.expected_plot_index,
      to,
      message: `Someone claimed plot ${r.expected_plot_index} first, so your space is on plot ${to}. Everything else is as you previewed it.`,
    };
  }
  return { kind: "as_previewed", slug: r.world.slug };
}

/**
 * The preview for a plot the space actually got (after a move), built from the
 * public minimap's spaces: neighbours of the new plot, redacted again, and the
 * new space itself left out (it is drawn from the draft).
 */
export function previewForPlot(
  plotIndex: number,
  spaces: ReadonlyArray<{ plot_index?: number; policy_preset?: string; name?: string | null; orgs?: Array<{ name: string; colour: string }>; branding?: unknown }>,
): WireClaimPreview {
  const byIndex = new Map<number, (typeof spaces)[number]>();
  for (const s of spaces) if (typeof s.plot_index === "number") byIndex.set(s.plot_index, s);
  const near = plotNeighbourhood(plotIndex, byIndex.keys());
  return {
    plot_index: plotIndex,
    ring: ringForPlotIndex(plotIndex),
    neighbours: near.map((i) => {
      const s = byIndex.get(i)!;
      const n = redactNeighbour({
        plotIndex: i,
        policyPreset: String(s.policy_preset ?? "private"),
        name: s.name ?? null,
        orgs: s.orgs ?? [],
        branding: readStoredBranding(s.branding),
      });
      return { plot_index: n.plotIndex, policy_preset: n.policyPreset, name: n.name, orgs: n.orgs, branding: n.branding };
    }),
  };
}

/** The tile a "See it on the map" link centres on. */
export function plotCentre(plotIndex: number): { tx: number; ty: number } {
  const r = plotForIndex(plotIndex);
  return { tx: Math.round((r.x0 + r.x1) / 2), ty: Math.round((r.y0 + r.y1) / 2) };
}
