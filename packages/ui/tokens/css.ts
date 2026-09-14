import { parseColor } from "./contrast.js";
import {
  COLOR_ROLES,
  COLORS,
  ELEVATION,
  FONT_STACKS,
  LABEL,
  MODES,
  MOTION,
  RADII,
  SPACING,
  TYPE_SCALE,
  TYPE_SCALE_FACTOR,
  type Mode,
} from "./values.js";

function modeVars(mode: Mode, indent: string): string {
  const lines: string[] = [];
  for (const role of COLOR_ROLES) {
    const value = COLORS[mode][role];
    lines.push(`--gh-${role}: ${value};`);
    const c = parseColor(value);
    // Channel triplets so Tailwind can apply its own alpha (`bg-ink/40`).
    if (c.a === 1) lines.push(`--gh-${role}-rgb: ${c.r} ${c.g} ${c.b};`);
  }
  for (const [k, v] of Object.entries(ELEVATION[mode])) lines.push(`--gh-elevation-${k}: ${v};`);
  lines.push(`--gh-type-scale: ${TYPE_SCALE_FACTOR[mode]};`);
  lines.push(`--gh-mode: ${mode};`);
  return lines.map((l) => indent + l).join("\n");
}

/** The generated stylesheet. `tokens.css` must equal this (a test checks). */
export function tokensCss(): string {
  const shared: string[] = [];
  for (const [k, v] of Object.entries(TYPE_SCALE)) shared.push(`--gh-text-${k}: calc(${v}rem * var(--gh-type-scale, 1));`);
  for (const [k, v] of Object.entries(SPACING)) shared.push(`--gh-space-${k}: ${v};`);
  for (const [k, v] of Object.entries(RADII)) shared.push(`--gh-radius-${k}: ${v};`);
  shared.push(`--gh-font-sans: ${FONT_STACKS.sans};`);
  shared.push(`--gh-font-mono: ${FONT_STACKS.mono};`);
  shared.push(`--gh-label-size: calc(${LABEL.size} * var(--gh-type-scale, 1));`);
  shared.push(`--gh-label-tracking: ${LABEL.tracking};`);
  shared.push(`--gh-ring: 0 0 0 2px var(--gh-ground), 0 0 0 4px var(--gh-focus);`);
  shared.push(`--gh-duration-fast: ${MOTION.fast}ms;`);
  shared.push(`--gh-duration-base: ${MOTION.base}ms;`);
  shared.push(`--gh-duration-slow: ${MOTION.slow}ms;`);
  shared.push(`--gh-ease: ${MOTION.ease};`);

  const out: string[] = [
    "/* GENERATED from packages/ui/tokens/values.ts by css.ts. Do not edit by hand:",
    "   change values.ts, then run `UPDATE_BRAND=1 pnpm --filter @grove/ui test`. */",
    "",
    ":root {",
    shared.map((l) => "  " + l).join("\n"),
    modeVars("light", "  "),
    "}",
    "",
    "/* No stored choice: follow the system. */",
    "@media (prefers-color-scheme: dark) {",
    "  :root:not([data-mode]) {",
    modeVars("night", "    "),
    "  }",
    "}",
    "",
    "/* A manual choice on <html>, or a scoped preview on any element. */",
  ];
  for (const mode of MODES) {
    out.push(`[data-mode="${mode}"] {`, modeVars(mode, "  "), "}", "");
  }
  out.push(
    "/* Chrome primitives. Scoped to .gh-chrome so nothing outside it changes. */",
    ".gh-chrome {",
    "  color-scheme: light;",
    "  background: var(--gh-ground);",
    "  color: var(--gh-ink);",
    "  font-family: var(--gh-font-sans);",
    "  font-size: var(--gh-text-base);",
    "  line-height: 1.5;",
    "}",
    '[data-mode="night"] .gh-chrome, [data-mode="tv"] .gh-chrome, .gh-chrome[data-mode="night"], .gh-chrome[data-mode="tv"] {',
    "  color-scheme: dark;",
    "}",
    "@media (prefers-color-scheme: dark) {",
    "  :root:not([data-mode]) .gh-chrome:not([data-mode]) { color-scheme: dark; }",
    "}",
    ".gh-label {",
    "  font-family: var(--gh-font-mono);",
    "  font-size: var(--gh-label-size);",
    "  letter-spacing: var(--gh-label-tracking);",
    "  text-transform: uppercase;",
    "  font-weight: 400;",
    "}",
    ".gh-frost {",
    "  background: var(--gh-frost);",
    "}",
    "@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {",
    "  .gh-frost {",
    "    background: var(--gh-frost-blur);",
    "    -webkit-backdrop-filter: blur(12px) saturate(1.2);",
    "    backdrop-filter: blur(12px) saturate(1.2);",
    "  }",
    "}",
    ".gh-chrome :focus-visible {",
    "  outline: 2px solid var(--gh-focus);",
    "  outline-offset: 2px;",
    "}",
    "@media (prefers-reduced-motion: reduce) {",
    "  :root { --gh-duration-fast: 0ms; --gh-duration-base: 0ms; --gh-duration-slow: 0ms; }",
    "}",
    "",
  );
  return out.join("\n");
}
