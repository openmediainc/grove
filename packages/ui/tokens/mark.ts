import { COLORS, PALETTE } from "./values.js";
import { WORDMARK_HEIGHT, WORDMARK_PATH, WORDMARK_WIDTH } from "./wordmark-path.js";

/**
 * The Glasshouse mark: four panes in a rounded square frame, the top-right
 * pane lit in the signal colour (lit = activity). One geometry, two weights:
 * `regular` for 32px and up, `small` (heavier mullions, bigger lit pane) for
 * favicons and the nav at 16–24px.
 */
export type MarkVariant = "light" | "night";
export type MarkWeight = "regular" | "small";

const FRAME_INK: Record<MarkVariant, string> = { light: PALETTE.mullionInk, night: PALETTE.mist };

export function markGeometry(weight: MarkWeight = "regular") {
  const stroke = weight === "small" ? 4 : 2.6;
  // Lit pane fills the top-right cell inside the stroke with an even gap.
  const inset = weight === "small" ? 2 : 2.5;
  const cellStart = 23 + stroke / 2 + inset;
  const cellEnd = 42 - stroke / 2 - inset;
  const top = 4 + stroke / 2 + inset;
  const bottom = 23 - stroke / 2 - inset;
  return {
    stroke,
    lit: { x: round(cellStart), y: round(top), w: round(cellEnd - cellStart), h: round(bottom - top) },
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Inner SVG for the mark in a 46×46 box. */
export function markBody(variant: MarkVariant, weight: MarkWeight = "regular", ink?: string): string {
  const { stroke, lit } = markGeometry(weight);
  const c = ink ?? FRAME_INK[variant];
  return (
    `<rect x="4" y="4" width="38" height="38" rx="3" fill="none" stroke="${c}" stroke-width="${stroke}"/>` +
    `<path d="M23 4v38M4 23h38" stroke="${c}" stroke-width="${stroke}"/>` +
    `<rect x="${lit.x}" y="${lit.y}" width="${lit.w}" height="${lit.h}" fill="${PALETTE.signal}"/>`
  );
}

export function markSvg(variant: MarkVariant = "light", weight: MarkWeight = "regular"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 46 46" width="46" height="46" role="img" aria-label="Glasshouse">${markBody(variant, weight)}</svg>\n`;
}

export function wordmarkSvg(variant: MarkVariant = "light"): string {
  const w = WORDMARK_WIDTH;
  const h = WORDMARK_HEIGHT;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="glasshouse"><path fill="${FRAME_INK[variant]}" d="${WORDMARK_PATH}"/></svg>\n`;
}

/** Mark + wordmark, wordmark optically centred on the mark. */
export function lockupSvg(variant: MarkVariant = "light"): string {
  const gap = 12;
  const scale = 0.82;
  const ww = round(WORDMARK_WIDTH * scale);
  const wh = WORDMARK_HEIGHT * scale;
  const width = round(46 + gap + ww);
  const y = round((46 - wh) / 2 + 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 46" width="${width}" height="46" role="img" aria-label="glasshouse">${markBody(variant)}<g transform="translate(${46 + gap} ${y}) scale(${scale})"><path fill="${FRAME_INK[variant]}" d="${WORDMARK_PATH}"/></g></svg>\n`;
}

/**
 * favicon.svg: follows the browser's colour scheme on its own, and sits on a
 * pane of ground so it reads on any tab strip.
 */
export function faviconSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 46 46" width="46" height="46">` +
    `<style>.g{fill:${COLORS.light.ground}}.f{stroke:${PALETTE.mullionInk}}@media (prefers-color-scheme:dark){.g{fill:${COLORS.night.ground}}.f{stroke:${PALETTE.mist}}}</style>` +
    `<rect class="g" width="46" height="46" rx="9"/>` +
    markBody("light", "small")
      .replaceAll(`stroke="${PALETTE.mullionInk}"`, `class="f"`) +
    `</svg>\n`
  );
}

/** Square app icon on a solid ground, used for PNG sizes and apple-touch-icon. `pad` is the fraction of the edge left clear. */
export function appIconSvg(size: number, variant: MarkVariant = "light", pad = 0.18): string {
  const ground = variant === "light" ? COLORS.light.ground : COLORS.night.ground;
  const inner = size * (1 - pad * 2);
  const s = inner / 46;
  const o = (size - inner) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${ground}"/><g transform="translate(${round(o)} ${round(o)}) scale(${round(s * 1000) / 1000})">${markBody(variant, size <= 48 ? "small" : "regular")}</g></svg>\n`;
}

/** Every brand file the web app serves, path → contents. A test pins the committed files to this. */
export function brandFiles(): Record<string, string> {
  return {
    "brand/mark-light.svg": markSvg("light"),
    "brand/mark-night.svg": markSvg("night"),
    "brand/mark-small-light.svg": markSvg("light", "small"),
    "brand/mark-small-night.svg": markSvg("night", "small"),
    "brand/wordmark-light.svg": wordmarkSvg("light"),
    "brand/wordmark-night.svg": wordmarkSvg("night"),
    "brand/lockup-light.svg": lockupSvg("light"),
    "brand/lockup-night.svg": lockupSvg("night"),
    "favicon.svg": faviconSvg(),
  };
}
