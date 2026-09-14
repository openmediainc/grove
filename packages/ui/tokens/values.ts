/**
 * Glasshouse brand tokens (DECISIONS #7): the ONE source for chrome colour,
 * type, spacing, radii, elevation and focus. `tokens.css` and the Tailwind
 * mapping are generated from this file; `DESIGN.md` documents it.
 *
 * Roles, not colour names. Day = Clear Pane, night = Nightwatch, tv = night
 * with a larger type scale and higher contrast.
 *
 * Boundary: these style chrome only (nav, drawer frames, menus, cards, pages,
 * emails, docs). Map themes style the world. Hazard, verb and outcome colours
 * are fixed and never come from here, except `danger`, which IS the fixed
 * fault colour (pinned to HAZARD_COLOUR.fault by a web test).
 */

export const MODES = ["light", "night", "tv"] as const;
export type Mode = (typeof MODES)[number];

export const COLOR_ROLES = [
  "ground",
  "surface",
  "surface-raised",
  "tint",
  "frost",
  "frost-blur",
  "ink",
  "muted",
  "line",
  "line-strong",
  "signal",
  "signal-ink",
  "signal-text",
  "sky",
  "human",
  "agent",
  "focus",
  "danger",
  "danger-ink",
  "success",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

/** The fixed fault colour. Not themeable: identical in every mode. */
export const FAULT = "#f87171";

/** Raw brand palette from the approved B + C direction. */
export const PALETTE = {
  daylight: "#F3F6F8",
  frost: "#DCE6EE",
  mullionInk: "#0E1B2B",
  signal: "#E2542B",
  skyPane: "#3E7CB1",
  nightGlass: "#0A0B14",
  indigoPane: "#1B1E3A",
  mist: "#E4E2F0",
  duskViolet: "#B7A6F2",
  humanAmber: "#F4B860",
  agentCyan: "#7FD1E8",
} as const;

/**
 * Colour values per mode. Translucent roles (`frost`, `frost-blur`) are
 * `rgb(r g b / a)`; everything else is a 6-digit hex so contrast can be
 * computed. `frost` is the no-blur fallback (denser); `frost-blur` is used
 * only under `@supports (backdrop-filter)`.
 */
export const COLORS: Readonly<Record<Mode, Readonly<Record<ColorRole, string>>>> = {
  light: {
    ground: PALETTE.daylight,
    surface: "#FBFCFD",
    "surface-raised": "#FFFFFF",
    tint: PALETTE.frost,
    frost: "rgb(246 249 251 / 0.94)",
    "frost-blur": "rgb(246 249 251 / 0.88)",
    ink: PALETTE.mullionInk,
    muted: "#4A5A6C",
    line: "#C9D4DD",
    "line-strong": "#6E7D8C",
    signal: PALETTE.signal,
    "signal-ink": PALETTE.mullionInk,
    "signal-text": "#A8380F",
    sky: PALETTE.skyPane,
    human: "#8A5200",
    agent: "#0A6680",
    focus: PALETTE.skyPane,
    danger: FAULT,
    "danger-ink": "#B42318",
    success: "#1A6B43",
  },
  night: {
    ground: PALETTE.nightGlass,
    surface: "#12142A",
    "surface-raised": PALETTE.indigoPane,
    tint: "#232748",
    frost: "rgb(16 18 31 / 0.94)",
    "frost-blur": "rgb(16 18 31 / 0.88)",
    ink: PALETTE.mist,
    muted: "#A9A6C0",
    line: "#2A2E52",
    "line-strong": "#7A7EA8",
    signal: PALETTE.signal,
    "signal-ink": PALETTE.nightGlass,
    "signal-text": "#F2794F",
    sky: PALETTE.duskViolet,
    human: PALETTE.humanAmber,
    agent: PALETTE.agentCyan,
    focus: PALETTE.duskViolet,
    danger: FAULT,
    "danger-ink": FAULT,
    success: "#6FD3A0",
  },
  tv: {
    ground: "#05060D",
    surface: "#0E1022",
    "surface-raised": "#171A33",
    tint: "#20244A",
    frost: "rgb(10 11 22 / 0.96)",
    "frost-blur": "rgb(10 11 22 / 0.86)",
    ink: "#F4F3FA",
    muted: "#C4C1DA",
    line: "#3A3F6A",
    "line-strong": "#8A8EB8",
    signal: PALETTE.signal,
    "signal-ink": "#05060D",
    "signal-text": "#F58A64",
    sky: "#C9BCFA",
    human: "#F7C77E",
    agent: "#96DCEE",
    focus: "#D6CCFF",
    danger: FAULT,
    "danger-ink": "#FA8C8C",
    success: "#86DDB0",
  },
};

/** Type scale in rem, multiplied by the mode's `--gh-type-scale`. */
export const TYPE_SCALE = {
  xs: 0.75,
  sm: 0.875,
  base: 1,
  lg: 1.125,
  xl: 1.375,
  "2xl": 1.75,
  "3xl": 2.25,
  "4xl": 3,
} as const;
export type TypeStep = keyof typeof TYPE_SCALE;

export const TYPE_SCALE_FACTOR: Readonly<Record<Mode, number>> = { light: 1, night: 1, tv: 1.25 };

export const FONT_WEIGHTS = { regular: 400, medium: 500, bold: 700, black: 800 } as const;

/** The mono uppercase label: Fragment Mono, tracked out, used sparingly. */
export const LABEL = { size: "0.6875rem", tracking: "0.08em", weight: 400 } as const;

/** 4px grid. */
export const SPACING = { 0: "0", 1: "0.25rem", 2: "0.5rem", 3: "0.75rem", 4: "1rem", 5: "1.25rem", 6: "1.5rem", 8: "2rem", 10: "2.5rem", 12: "3rem", 16: "4rem" } as const;

export const RADII = { sm: "4px", md: "8px", lg: "12px", xl: "16px", pill: "999px" } as const;

export const ELEVATION: Readonly<Record<Mode, Readonly<Record<"1" | "2" | "3", string>>>> = {
  light: {
    "1": "0 1px 2px rgb(14 27 43 / 0.08)",
    "2": "0 4px 12px rgb(14 27 43 / 0.10), 0 1px 2px rgb(14 27 43 / 0.06)",
    "3": "0 12px 32px rgb(14 27 43 / 0.16), 0 2px 6px rgb(14 27 43 / 0.08)",
  },
  night: {
    "1": "0 1px 2px rgb(0 0 0 / 0.4)",
    "2": "0 4px 14px rgb(0 0 0 / 0.45)",
    "3": "0 14px 36px rgb(0 0 0 / 0.55)",
  },
  tv: {
    "1": "0 1px 2px rgb(0 0 0 / 0.5)",
    "2": "0 4px 14px rgb(0 0 0 / 0.55)",
    "3": "0 14px 36px rgb(0 0 0 / 0.65)",
  },
};

/** Motion durations (ms) and easing; everything collapses under reduced motion. */
export const MOTION = { fast: 120, base: 180, slow: 280, ease: "cubic-bezier(0.2, 0, 0, 1)" } as const;

export const FONT_STACKS = {
  sans: 'var(--gh-font-schibsted, "Schibsted Grotesk"), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'var(--gh-font-fragment, "Fragment Mono"), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;
