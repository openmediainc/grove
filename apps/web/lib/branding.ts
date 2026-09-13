/**
 * Space branding on Manage (035): the draft an owner edits, what goes on the
 * wire, and what the live preview draws. Pure; the rules are @grove/protocol's.
 */
import {
  BRAND_PALETTE,
  SIGN_TEXT_MAX,
  graphemeCount,
  isBrandEmblem,
  readAccent,
  readSignText,
  type BrandEmblem,
  type SpaceBranding,
} from "@grove/protocol";
import type { SignPlot } from "@/lib/signboard";

export type BrandingDraft = { accent: string; signText: string; emblem: BrandEmblem | null };

/** Wire branding (snake_case from the API) to an editable draft. */
export function brandingDraft(wire: { accent?: string | null; sign_text?: string | null; emblem?: string | null } | null | undefined): BrandingDraft {
  return {
    accent: wire?.accent ?? "",
    signText: wire?.sign_text ?? "",
    emblem: isBrandEmblem(wire?.emblem) ? wire!.emblem as BrandEmblem : null,
  };
}

export type DraftCheck = {
  /** The values the preview may draw: only what the server would accept. */
  valid: SpaceBranding;
  accentError: string | null;
  signTextError: string | null;
  /** Characters used, as the server counts them. */
  signTextCount: number;
};

export function checkDraft(d: BrandingDraft): DraftCheck {
  const a = d.accent.trim() ? readAccent(d.accent) : ({ ok: true, hex: null } as const);
  const t = readSignText(d.signText);
  return {
    valid: { accent: a.ok ? a.hex : null, signText: t.ok ? t.text : null, emblem: d.emblem },
    accentError: a.ok ? null : a.message,
    signTextError: t.ok ? null : t.message,
    signTextCount: graphemeCount(d.signText.replace(/\s+/g, " ").trim()),
  };
}

/** The PUT body. Empty fields clear. */
export function draftToBody(d: BrandingDraft): { accent: string | null; sign_text: string | null; emblem: string | null } {
  return { accent: d.accent.trim() || null, sign_text: d.signText.trim() || null, emblem: d.emblem };
}

/** Which palette swatch a hex is, if any. */
export function paletteKeyOf(hex: string): string | null {
  const h = hex.trim().toLowerCase();
  return BRAND_PALETTE.find((p) => p.hex === h || p.key === h)?.key ?? null;
}

/**
 * The plot the preview signs. A private space previews as it would look once
 * opened, because the map shows a held sign with none of the branding on it —
 * the editor says so in words next to the preview.
 */
export function previewPlot(
  space: { name: string; policy_preset: string },
  orgs: ReadonlyArray<{ name: string; colour: string }>,
  branding: SpaceBranding,
): SignPlot {
  return {
    preset: space.policy_preset === "private" ? "public_view" : space.policy_preset,
    name: space.name,
    occupancy: 0,
    orgs,
    branding,
  };
}

export { SIGN_TEXT_MAX };

// ------------------------------------------------------------------ from a website (#34)

/** POST /api/v1/spaces/:id/branding/suggest, as it comes off the wire. */
export type BrandingSuggestion = {
  name: string | null;
  accent: { accent: string; original: string; substituted: boolean; note: string | null } | null;
  source: {
    url: string;
    site_name: string | null;
    title: string | null;
    theme_color: string | null;
    favicon: string | null;
    favicon_colour: string | null;
    accent_from: "theme_color" | "favicon" | null;
  };
  notes: string[];
};

/**
 * The draft with a suggestion laid over it: what the preview shows before
 * Apply, and what Apply puts in the editor. Only the fields the website gave
 * change; the emblem is never guessed, so it stays as it is.
 */
export function applySuggestion(d: BrandingDraft, s: BrandingSuggestion | null): BrandingDraft {
  if (!s) return d;
  return {
    accent: s.accent?.accent ?? d.accent,
    signText: s.name ?? d.signText,
    emblem: d.emblem,
  };
}

/** One line saying where the colour came from, for the suggestion card. */
export function suggestionColourLine(s: BrandingSuggestion): string | null {
  if (!s.accent) return null;
  const from = s.source.accent_from === "favicon" ? "its icon" : "its theme colour";
  return s.accent.substituted
    ? `Colour: ${s.accent.accent} (the website's ${s.accent.original} from ${from} could not be used)`
    : `Colour: ${s.accent.accent}, from ${from}`;
}
