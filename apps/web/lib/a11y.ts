/**
 * Accessibility helpers (#67). Pure: no DOM, so they are tested in node.
 *
 * - `nextRovingIndex`: where the arrow keys move in a menu or a tab strip.
 * - `contrastRatio` and friends: WCAG 2.x relative luminance, used by the
 *   chrome contrast test over every theme's tokens (docs/ACCESSIBILITY.md).
 */

export type Orientation = "horizontal" | "vertical";

/**
 * The index a key moves to in a list of `count` items, or null when the key is
 * not a navigation key for this orientation (let it through). Wraps at both
 * ends, Home and End jump. `current` of -1 (nothing focused yet) steps in from
 * the nearest end.
 */
export function nextRovingIndex(current: number, key: string, count: number, orientation: Orientation = "vertical"): number | null {
  if (count <= 0) return null;
  const prev = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === next) return current < 0 ? 0 : (current + 1) % count;
  if (key === prev) return current < 0 ? count - 1 : (current - 1 + count) % count;
  return null;
}

/**
 * First item whose label starts with a typed character (menu typeahead), searching
 * after `current` and wrapping. -1 when nothing matches.
 */
export function typeaheadIndex(labels: readonly string[], current: number, char: string): number {
  const c = char.trim().toLowerCase();
  if (c.length !== 1 || labels.length === 0) return -1;
  for (let step = 1; step <= labels.length; step++) {
    const i = (current + step + labels.length) % labels.length;
    if ((labels[i] ?? "").trim().toLowerCase().startsWith(c)) return i;
  }
  return -1;
}

export type Rgb = readonly [number, number, number];

/** "r g b" (the theme chrome token form) or "#rrggbb" to a triple. */
export function parseColour(input: string): Rgb {
  const s = input.trim();
  if (s.startsWith("#")) {
    const hex = s.length === 4 ? s.slice(1).split("").map((h) => h + h).join("") : s.slice(1);
    const n = Number.parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const parts = s.split(/[\s,]+/).map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) throw new Error(`not a colour: ${input}`);
  return [parts[0]!, parts[1]!, parts[2]!];
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` at `alpha` composited over an opaque `bg` (what `text-white/50` becomes on screen). */
export function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const mix = (i: 0 | 1 | 2) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha));
  return [mix(0), mix(1), mix(2)];
}

/** WCAG 2.2 AA: body text 4.5:1; focus indicators and UI boundaries 3:1. */
export const TEXT_MIN = 4.5;
export const NON_TEXT_MIN = 3;

/**
 * The faintest white text the chrome may use (`text-white/50`). Below it,
 * small hint text fails 4.5:1 on the darkest chrome in at least one theme;
 * a web test scans app/ and components/ for anything fainter.
 */
export const MUTED_TEXT_MIN_ALPHA = 0.5;

export type ChromeTokens = {
  dusk950: string;
  dusk900: string;
  dusk800: string;
  dusk700: string;
  lantern300: string;
  lantern400: string;
  lantern500: string;
};

export type ContrastCheck = { pair: string; ratio: number; min: number; ok: boolean };

const WHITE: Rgb = [255, 255, 255];

/**
 * Every chrome pair the UI relies on, per theme:
 * - lantern text (300/400/500) on the dusk surfaces, ≥ 4.5;
 * - dark text on a lantern-400 button (Sign in, Walk in), ≥ 4.5;
 * - the focus ring (lantern-400) against every dusk surface, ≥ 3;
 * - the muted-text floor (white at MUTED_TEXT_MIN_ALPHA) on 950 and on 800, ≥ 4.5.
 */
export function chromeContrast(chrome: ChromeTokens): ContrastCheck[] {
  const c = Object.fromEntries(Object.entries(chrome).map(([k, v]) => [k, parseColour(v)])) as Record<keyof ChromeTokens, Rgb>;
  const out: ContrastCheck[] = [];
  const check = (pair: string, a: Rgb, b: Rgb, min: number) => {
    const ratio = contrastRatio(a, b);
    out.push({ pair, ratio, min, ok: ratio >= min });
  };
  const surfaces = ["dusk950", "dusk900", "dusk800"] as const;
  for (const text of ["lantern300", "lantern400", "lantern500"] as const) {
    for (const s of surfaces) check(`${text} text on ${s}`, c[text], c[s], TEXT_MIN);
  }
  check("dusk950 text on lantern400", c.dusk950, c.lantern400, TEXT_MIN);
  for (const s of [...surfaces, "dusk700"] as const) check(`focus ring lantern400 on ${s}`, c.lantern400, c[s], NON_TEXT_MIN);
  for (const s of ["dusk950", "dusk800"] as const) {
    check(`muted white/${MUTED_TEXT_MIN_ALPHA * 100} on ${s}`, over(WHITE, MUTED_TEXT_MIN_ALPHA, c[s]), c[s], TEXT_MIN);
  }
  return out;
}
