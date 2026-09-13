/**
 * Space branding (migration 035): an accent colour, a short line of sign text
 * and a small emblem from a built-in set. The owner sets them on Manage; the
 * map draws them on the plot's signboard and fence in every theme.
 *
 * Pure, so the server, the Manage editor, its live preview and the tests agree
 * on one set of rules. WHO may see branding is decided elsewhere, and the rule
 * is the name's: a private plot's branding never leaves the database for the
 * public map, because a colour and an emblem can identify a space as surely as
 * its name can.
 *
 * Rules:
 *  - accent: a key from BRAND_PALETTE, or any #rgb / #rrggbb that reads on every
 *    theme's signboard (at least BRAND_MIN_CONTRAST:1 against each board) and is
 *    not mistakable for a hazard colour. Stored as lowercase #rrggbb.
 *  - signText: at most SIGN_TEXT_MAX characters (grapheme clusters, so an emoji
 *    or an accented letter counts once), one line, no control or invisible
 *    formatting characters.
 *  - emblem: a key from BRAND_EMBLEMS. The glyphs are drawn in code by the web
 *    kit; there are no uploads and no image files.
 */
import { graphemeCount } from "./graphemes.js";

export const SIGN_TEXT_MAX = 24;

/**
 * WCAG non-text contrast. The accent is a stripe, a fence and an emblem, never
 * body text, so 3:1 is the bar — against EVERY theme's board, since a viewer
 * picks the theme and the owner cannot know which.
 */
export const BRAND_MIN_CONTRAST = 3;

/**
 * Each theme's signboard colour, composited to opaque (the translucent boards
 * sit over dark ground). The web themes pin these in a test, so a restyled
 * board cannot quietly make an accepted accent unreadable.
 */
export const SIGN_BOARD_COLOURS = {
  aoe: "#5a3b1f",
  space: "#0f172a",
  city: "#14532d",
  scifi: "#040a0e",
} as const;
export type SignBoardTheme = keyof typeof SIGN_BOARD_COLOURS;

const THEME_WORD: Record<SignBoardTheme, string> = {
  aoe: "Age of Empires",
  space: "Space",
  city: "City",
  scifi: "Sci-fi",
};

/** The map's hazard colours (flag, fault, stall). An accent may not pass for one. */
export const HAZARD_HEXES = ["#f472b6", "#f87171", "#fb923c"] as const;
/** RGB distance under which an accent reads as a hazard colour. */
const HAZARD_DISTANCE = 64;

/** The curated palette: every entry passes the rules above (a test pins that). */
export const BRAND_PALETTE = [
  { key: "sky", label: "Sky", hex: "#7dd3fc" },
  { key: "teal", label: "Teal", hex: "#5eead4" },
  { key: "mint", label: "Mint", hex: "#6ee7b7" },
  { key: "lime", label: "Lime", hex: "#bef264" },
  { key: "sun", label: "Sun", hex: "#fde047" },
  { key: "cream", label: "Cream", hex: "#fef3c7" },
  { key: "periwinkle", label: "Periwinkle", hex: "#a5b4fc" },
  { key: "violet", label: "Violet", hex: "#c4b5fd" },
  { key: "silver", label: "Silver", hex: "#cbd5e1" },
  { key: "snow", label: "Snow", hex: "#f8fafc" },
] as const;
export type BrandPaletteKey = (typeof BRAND_PALETTE)[number]["key"];

/** The built-in emblem set, in picker order. Glyphs are drawn in the web kit. */
export const BRAND_EMBLEMS = [
  "leaf",
  "star",
  "moon",
  "sun",
  "wave",
  "peak",
  "key",
  "book",
  "gear",
  "feather",
  "heart",
  "anchor",
  "diamond",
  "compass",
  "flower",
  "tree",
] as const;
export type BrandEmblem = (typeof BRAND_EMBLEMS)[number];

export const BRAND_EMBLEM_LABEL: Record<BrandEmblem, string> = {
  leaf: "Leaf",
  star: "Star",
  moon: "Moon",
  sun: "Sun",
  wave: "Wave",
  peak: "Peak",
  key: "Key",
  book: "Book",
  gear: "Gear",
  feather: "Feather",
  heart: "Heart",
  anchor: "Anchor",
  diamond: "Diamond",
  compass: "Compass",
  flower: "Flower",
  tree: "Tree",
};

export interface SpaceBranding {
  /** Lowercase #rrggbb, or null. */
  accent: string | null;
  signText: string | null;
  emblem: BrandEmblem | null;
}

export const EMPTY_BRANDING: SpaceBranding = { accent: null, signText: null, emblem: null };

export function isBrandEmblem(v: unknown): v is BrandEmblem {
  return typeof v === "string" && (BRAND_EMBLEMS as readonly string[]).includes(v);
}

// ------------------------------------------------------------------ colour

/** `#rgb` or `#rrggbb` (any case) to lowercase `#rrggbb`; null if it is neither. */
export function normaliseHex(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Contrast of `hex` against each theme's board. */
export function boardContrasts(hex: string): Record<SignBoardTheme, number> {
  const out = {} as Record<SignBoardTheme, number>;
  for (const t of Object.keys(SIGN_BOARD_COLOURS) as SignBoardTheme[]) out[t] = contrastRatio(hex, SIGN_BOARD_COLOURS[t]);
  return out;
}

/**
 * Why an accent cannot be used, in plain words, or null when it can. The
 * lowest-contrast theme is named so the owner knows which way to move.
 */
export function accentProblem(hex: string): string | null {
  const [r, g, b] = rgb(hex);
  for (const h of HAZARD_HEXES) {
    const [hr, hg, hb] = rgb(h);
    if (Math.hypot(r - hr, g - hg, b - hb) < HAZARD_DISTANCE) {
      return "That colour is too close to the map's warning colours, which mark faults. Pick another.";
    }
  }
  const c = boardContrasts(hex);
  let worst: SignBoardTheme = "aoe";
  for (const t of Object.keys(c) as SignBoardTheme[]) if (c[t] < c[worst]) worst = t;
  if (c[worst] < BRAND_MIN_CONTRAST) {
    return `That colour is too dark to read on the ${THEME_WORD[worst]} sign (${c[worst].toFixed(1)}:1, it needs ${BRAND_MIN_CONTRAST}:1). Pick a lighter one.`;
  }
  return null;
}

/** A palette key or a hex, to a usable #rrggbb or a plain reason it is not. */
export function readAccent(raw: unknown): { ok: true; hex: string } | { ok: false; message: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, message: "Accent must be a palette colour or a #rrggbb hex." };
  const pal = BRAND_PALETTE.find((p) => p.key === raw.trim().toLowerCase());
  if (pal) return { ok: true, hex: pal.hex };
  const hex = normaliseHex(raw);
  if (!hex) return { ok: false, message: "Accent must be a palette colour or a #rrggbb hex." };
  const problem = accentProblem(hex);
  return problem ? { ok: false, message: problem } : { ok: true, hex };
}

// ------------------------------------------------------------------ text

/**
 * Control (Cc), invisible formatting (Cf: bidi overrides, zero-width marks),
 * line/paragraph separators and private-use code points. The one
 * exception is ZWJ (U+200D), which joins emoji into a single character.
 */
const FORBIDDEN_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\p{Co}]|(?!\u200d)\p{Cf}/u;

/** Sign text to a stored value (null clears) or a plain reason it is refused. */
export function readSignText(raw: unknown): { ok: true; text: string | null } | { ok: false; message: string } {
  if (raw === null) return { ok: true, text: null };
  if (typeof raw !== "string") return { ok: false, message: "Sign text must be text." };
  if (FORBIDDEN_TEXT.test(raw)) return { ok: false, message: "Sign text must be one line of plain text." };
  const text = raw.replace(/\s+/g, " ").trim().normalize("NFC");
  if (!text) return { ok: true, text: null };
  if (graphemeCount(text) > SIGN_TEXT_MAX) return { ok: false, message: `Sign text can be at most ${SIGN_TEXT_MAX} characters.` };
  return { ok: true, text };
}

// ------------------------------------------------------------------ wire

export type BrandingPatchResult = { ok: true; patch: Partial<SpaceBranding> } | { ok: false; message: string };

/**
 * A write off the wire. Absent keys are left alone; null (or "") clears one.
 * Anything invalid is refused with a reason rather than dropped, so the owner
 * learns why a colour did not stick.
 */
export function normaliseBrandingPatch(raw: unknown): BrandingPatchResult {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const patch: Partial<SpaceBranding> = {};
  if ("accent" in o && o.accent !== undefined) {
    if (o.accent === null || o.accent === "") patch.accent = null;
    else {
      const a = readAccent(o.accent);
      if (!a.ok) return a;
      patch.accent = a.hex;
    }
  }
  if ("signText" in o && o.signText !== undefined) {
    const t = readSignText(o.signText);
    if (!t.ok) return t;
    patch.signText = t.text;
  }
  if ("emblem" in o && o.emblem !== undefined) {
    if (o.emblem === null || o.emblem === "") patch.emblem = null;
    else if (!isBrandEmblem(o.emblem)) return { ok: false, message: "Pick an emblem from the set." };
    else patch.emblem = o.emblem;
  }
  return { ok: true, patch };
}

export function mergeBranding(current: SpaceBranding, patch: Partial<SpaceBranding>): SpaceBranding {
  return {
    accent: patch.accent !== undefined ? patch.accent : current.accent,
    signText: patch.signText !== undefined ? patch.signText : current.signText,
    emblem: patch.emblem !== undefined ? patch.emblem : current.emblem,
  };
}

/**
 * A stored (or received) value, re-checked field by field. Never throws: a
 * field that no longer passes (say, a board was restyled) is dropped, not
 * drawn. Accepts camelCase or snake_case keys. Null when nothing is set.
 */
export function readStoredBranding(raw: unknown): SpaceBranding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const accentRaw = o.accent;
  const accent = typeof accentRaw === "string" ? (readAccent(accentRaw) as { ok: boolean; hex?: string }) : null;
  const textRaw = o.signText ?? o.sign_text;
  const text = typeof textRaw === "string" ? readSignText(textRaw) : null;
  const out: SpaceBranding = {
    accent: accent?.ok ? accent.hex! : null,
    signText: text?.ok ? text.text : null,
    emblem: isBrandEmblem(o.emblem) ? o.emblem : null,
  };
  return out.accent || out.signText || out.emblem ? out : null;
}

// ------------------------------------------------------------------ from a website (#34)

/**
 * Sign text taken from a website's name: forbidden characters removed rather
 * than refused (the owner did not type them), whitespace collapsed, then cut
 * to SIGN_TEXT_MAX characters at a word boundary when one is close. Null when
 * nothing usable is left. The result always passes readSignText.
 */
export function signTextFromName(raw: string): string | null {
  const cleaned = raw
    .replace(new RegExp(FORBIDDEN_TEXT.source, "gu"), " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
  if (!cleaned) return null;
  const parts = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(cleaned)].map((s) => s.segment);
  if (parts.length <= SIGN_TEXT_MAX) return cleaned;
  const cut = parts.slice(0, SIGN_TEXT_MAX).join("");
  const space = cut.lastIndexOf(" ");
  const atWordEnd = parts[SIGN_TEXT_MAX] === " ";
  const text = (atWordEnd || space < 12 ? cut : cut.slice(0, space)).trim();
  return text || null;
}

/** Hue in degrees (0..360) and chroma (0..1) of a #rrggbb colour. */
function hueChroma(hex: string): { hue: number; chroma: number } {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { hue, chroma: d / 255 };
}

/** Below this chroma a colour reads as grey, and maps to the palette's grey. */
const GREY_CHROMA = 0.15;

/**
 * The palette colour nearest a brand colour that cannot be used as it is. A
 * failing colour is almost always failing on lightness (too dark for the dark
 * boards) or on hue (a red, too near the warning colours), so nearness is by
 * hue: a navy becomes Periwinkle, a forest green Mint. Greys go to Silver.
 */
export function nearestPaletteAccent(hex: string): (typeof BRAND_PALETTE)[number] {
  const src = hueChroma(hex);
  const silver = BRAND_PALETTE.find((p) => p.key === "silver")!;
  if (src.chroma < GREY_CHROMA) return silver;
  let best: (typeof BRAND_PALETTE)[number] = silver;
  let bestD = Infinity;
  for (const p of BRAND_PALETTE) {
    const hc = hueChroma(p.hex);
    if (hc.chroma < GREY_CHROMA) continue;
    const raw = Math.abs(hc.hue - src.hue);
    const d = Math.min(raw, 360 - raw);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

export type AccentSuggestion = {
  /** A #rrggbb that readAccent accepts. */
  accent: string;
  /** The website's own colour, as found. */
  original: string;
  /** True when the website's colour could not be used and a palette colour stands in. */
  substituted: boolean;
  /** Plain words for the owner when substituted, else null. */
  note: string | null;
};

/**
 * A website's colour to an accent the sign can use: the colour itself when it
 * passes #33's rules, otherwise the nearest palette colour, saying why.
 */
export function suggestAccent(raw: string): AccentSuggestion | null {
  const hex = normaliseHex(raw);
  if (!hex) return null;
  const problem = accentProblem(hex);
  if (!problem) return { accent: hex, original: hex, substituted: false, note: null };
  const pal = nearestPaletteAccent(hex);
  const why = problem.startsWith("That colour is too close")
    ? "is too close to the map's warning colours"
    : "is too dark to read on every theme's sign";
  return {
    accent: pal.hex,
    original: hex,
    substituted: true,
    note: `The website's colour ${hex} ${why}, so this suggests ${pal.label}, the nearest palette colour.`,
  };
}
