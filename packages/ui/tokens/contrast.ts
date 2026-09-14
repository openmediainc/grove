import { COLORS, MODES, type ColorRole, type Mode } from "./values.js";

/** WCAG 2.x contrast. Accepts `#rrggbb` or `rgb(r g b / a)`. */
export type Rgba = { r: number; g: number; b: number; a: number };

export function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)\s*)?\)$/i.exec(value.trim());
  if (rgb) return { r: +rgb[1]!, g: +rgb[2]!, b: +rgb[3]!, a: rgb[4] === undefined ? 1 : +rgb[4] };
  throw new Error(`unparseable colour: ${value}`);
}

/** Composite a (possibly translucent) colour over an opaque backdrop. */
export function over(top: Rgba, backdrop: Rgba): Rgba {
  const a = top.a;
  return {
    r: Math.round(top.r * a + backdrop.r * (1 - a)),
    g: Math.round(top.g * a + backdrop.g * (1 - a)),
    b: Math.round(top.b * a + backdrop.b * (1 - a)),
    a: 1,
  };
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrast(a: string | Rgba, b: string | Rgba): number {
  const x = luminance(typeof a === "string" ? parseColor(a) : a);
  const y = luminance(typeof b === "string" ? parseColor(b) : b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export type PairKind = "text" | "ui";
export const PAIR_MINIMUM: Readonly<Record<PairKind, number>> = { text: 4.5, ui: 3 };

export type ContrastPair = { fg: ColorRole; bg: ColorRole; kind: PairKind; use: string };

const TEXT_BGS: ColorRole[] = ["ground", "surface", "surface-raised", "tint", "frost"];
const UI_BGS: ColorRole[] = ["ground", "surface", "surface-raised"];

/**
 * Every foreground/background pair the chrome is allowed to use. If a pair
 * isn't listed, don't use it (DESIGN.md "Contrast"). `frost` is checked as
 * composited over pure black AND pure white, because the map under it can be
 * either.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...(["ink", "muted", "signal-text", "human", "agent", "danger-ink", "success"] as ColorRole[]).flatMap((fg) =>
    TEXT_BGS.map((bg) => ({ fg, bg, kind: "text" as const, use: `${fg} text on ${bg}` })),
  ),
  { fg: "signal-ink", bg: "signal", kind: "text", use: "primary button label" },
  { fg: "surface-raised", bg: "ink", kind: "text", use: "tooltip / inverted chip" },
  ...(["signal", "sky", "focus", "line-strong", "human", "agent", "ink"] as ColorRole[]).flatMap((fg) =>
    UI_BGS.map((bg) => ({ fg, bg, kind: "ui" as const, use: `${fg} mark/border on ${bg}` })),
  ),
];

/**
 * The fixed fault colour is only a UI mark on dark chrome. On daylight it
 * never stands alone: notices use `danger-ink` for the border and text, and
 * hazard triangles carry their own dark keyline (THEMES.md).
 */
export const DANGER_UI_PAIRS: readonly ContrastPair[] = UI_BGS.map((bg) => ({
  fg: "danger" as const,
  bg,
  kind: "ui" as const,
  use: `fault mark on ${bg} (night/tv only)`,
}));

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

export type ContrastResult = ContrastPair & { mode: Mode; ratio: number; pass: boolean; minimum: number };

/** Worst-case ratio for a pair in a mode (translucent backgrounds over black and white). */
export function pairRatio(mode: Mode, fg: ColorRole, bg: ColorRole): number {
  const f = parseColor(COLORS[mode][fg]);
  const b = parseColor(COLORS[mode][bg]);
  const backdrops = b.a < 1 ? [over(b, BLACK), over(b, WHITE)] : [b];
  return Math.min(...backdrops.map((bd) => contrast(f.a < 1 ? over(f, bd) : f, bd)));
}

export function contrastReport(): ContrastResult[] {
  const out: ContrastResult[] = [];
  for (const mode of MODES) {
    const pairs = mode === "light" ? CONTRAST_PAIRS : [...CONTRAST_PAIRS, ...DANGER_UI_PAIRS];
    for (const p of pairs) {
      const ratio = pairRatio(mode, p.fg, p.bg);
      const minimum = PAIR_MINIMUM[p.kind];
      out.push({ ...p, mode, ratio: Math.round(ratio * 100) / 100, minimum, pass: ratio >= minimum });
    }
  }
  return out;
}

/** The contrast table DESIGN.md embeds between its CONTRAST markers (a test keeps them equal). */
export function contrastTableMarkdown(): string {
  const rows = contrastReport();
  const key = (r: ContrastResult) => `${r.fg}|${r.bg}|${r.kind}`;
  const seen = new Map<string, { use: string; kind: PairKind; minimum: number; ratios: Partial<Record<Mode, number>> }>();
  for (const r of rows) {
    const k = key(r);
    const entry = seen.get(k) ?? { use: r.use, kind: r.kind, minimum: r.minimum, ratios: {} };
    entry.ratios[r.mode] = r.ratio;
    seen.set(k, entry);
  }
  const lines = ["| Pair | Kind | Min | Light | Night | TV |", "|---|---|---|---|---|---|"];
  for (const e of seen.values()) {
    const cell = (m: Mode) => (e.ratios[m] === undefined ? "n/a" : e.ratios[m]!.toFixed(2));
    lines.push(`| ${e.use} | ${e.kind} | ${e.minimum} | ${cell("light")} | ${cell("night")} | ${cell("tv")} |`);
  }
  return lines.join("\n");
}
