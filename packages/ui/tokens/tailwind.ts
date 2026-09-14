import { parseColor } from "./contrast.js";
import { COLOR_ROLES, COLORS, RADII, TYPE_SCALE, type ColorRole } from "./values.js";

/**
 * Tailwind mapping for the brand tokens. Semantic names only. `sky` is
 * exposed as `pane` because Tailwind's own `sky-*` palette is still in use.
 *
 * `bg-surface`, `text-ink`, `text-muted`, `border-line`, `bg-signal`,
 * `text-signal-ink`, `text-human`, `text-agent`, `ring-focus`, `bg-frost`…
 */
const TAILWIND_NAME: Partial<Record<ColorRole, string>> = { sky: "pane" };

export function brandColors(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of COLOR_ROLES) {
    const name = TAILWIND_NAME[role] ?? role;
    const translucent = parseColor(COLORS.light[role]).a < 1;
    out[name] = translucent ? `var(--gh-${role})` : `rgb(var(--gh-${role}-rgb) / <alpha-value>)`;
  }
  return out;
}

/**
 * The legacy chrome names. Rollout #73 moved the global chrome onto semantic
 * tokens; pages and the map chrome (#74–#75) still use `dusk-*`/`lantern-*`.
 * Inside the map a theme sets --g-* as before. Everywhere else the fallback is
 * now Nightwatch (night ground, surfaces, line; dusk-violet accents), and those
 * pages sit in a `[data-brand-legacy]` frame that pins the brand tokens to
 * night, so nothing written for a dark page lands on a light ground.
 */
const rgb = (hex: string) => {
  const c = parseColor(hex);
  return `${c.r} ${c.g} ${c.b}`;
};
export const LEGACY_NIGHT = {
  dusk950: rgb(COLORS.night.ground),
  dusk900: rgb(COLORS.night.surface),
  dusk800: rgb(COLORS.night["surface-raised"]),
  dusk700: rgb(COLORS.night.line),
  lantern300: rgb(COLORS.tv.focus),
  lantern400: rgb(COLORS.night.sky),
  lantern500: "154 134 230",
} as const;

export const LEGACY_CHROME_COLORS = {
  dusk: {
    950: `rgb(var(--g-dusk-950, ${LEGACY_NIGHT.dusk950}) / <alpha-value>)`,
    900: `rgb(var(--g-dusk-900, ${LEGACY_NIGHT.dusk900}) / <alpha-value>)`,
    800: `rgb(var(--g-dusk-800, ${LEGACY_NIGHT.dusk800}) / <alpha-value>)`,
    700: `rgb(var(--g-dusk-700, ${LEGACY_NIGHT.dusk700}) / <alpha-value>)`,
  },
  lantern: {
    300: `rgb(var(--g-lantern-300, ${LEGACY_NIGHT.lantern300}) / <alpha-value>)`,
    400: `rgb(var(--g-lantern-400, ${LEGACY_NIGHT.lantern400}) / <alpha-value>)`,
    500: `rgb(var(--g-lantern-500, ${LEGACY_NIGHT.lantern500}) / <alpha-value>)`,
  },
} as const;

/** Legacy name → the semantic token it migrates to (DESIGN.md "Migration"). */
export const LEGACY_TO_SEMANTIC: Readonly<Record<string, string>> = {
  "dusk-950": "ground",
  "dusk-900": "surface",
  "dusk-800": "surface-raised",
  "dusk-700": "line",
  "lantern-300": "ink (headings) or signal-text",
  "lantern-400": "signal",
  "lantern-500": "signal",
};

export function brandTheme() {
  const fontSize: Record<string, string> = {};
  for (const k of Object.keys(TYPE_SCALE)) fontSize[`gh-${k}`] = `var(--gh-text-${k})`;
  const borderRadius: Record<string, string> = {};
  for (const k of Object.keys(RADII)) borderRadius[`gh-${k}`] = `var(--gh-radius-${k})`;
  return {
    colors: { ...LEGACY_CHROME_COLORS, ...brandColors() },
    fontFamily: {
      brand: ["var(--gh-font-sans)"],
      "brand-mono": ["var(--gh-font-mono)"],
    },
    fontSize,
    borderRadius,
    boxShadow: {
      "gh-1": "var(--gh-elevation-1)",
      "gh-2": "var(--gh-elevation-2)",
      "gh-3": "var(--gh-elevation-3)",
      "gh-ring": "var(--gh-ring)",
    },
    transitionTimingFunction: { gh: "var(--gh-ease)" },
    transitionDuration: { "gh-fast": "var(--gh-duration-fast)", gh: "var(--gh-duration-base)", "gh-slow": "var(--gh-duration-slow)" },
  };
}
