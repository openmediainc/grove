import type { Config } from "tailwindcss";
import { brandTheme } from "@grove/ui/tokens";

// Brand tokens (DECISIONS #7, docs/design/DESIGN.md): semantic chrome colours
// (ground, surface, surface-raised, tint, frost, ink, muted, line, signal,
// signal-ink, pane, human, agent, focus, danger, success) from --gh-* CSS
// variables, plus spacing/radii/elevation helpers. The legacy `dusk-*` and
// `lantern-*` names are kept verbatim (map themes set --g-*, pages fall back
// to the aoe palette) until rollout rows #73–#75 migrate every usage.
const brand = brandTheme();

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/brand-ui.ts", "./lib/identity.ts"],
  theme: {
    extend: {
      ...brand,
      fontFamily: {
        display: ["var(--g-font-display, Fraunces)", "Georgia", "serif"],
        sans: ["Source Sans 3", "ui-sans-serif", "system-ui", "sans-serif"],
        ...brand.fontFamily,
      },
    },
  },
  plugins: [],
} satisfies Config;
