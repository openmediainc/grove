import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Theme tokens. The map sets --g-* from the active theme (lib/themes);
        // everywhere else the fallback is the aoe palette these used to be.
        dusk: {
          950: "rgb(var(--g-dusk-950, 7 8 20) / <alpha-value>)",
          900: "rgb(var(--g-dusk-900, 11 18 32) / <alpha-value>)",
          800: "rgb(var(--g-dusk-800, 18 26 46) / <alpha-value>)",
          700: "rgb(var(--g-dusk-700, 26 39 68) / <alpha-value>)",
        },
        lantern: {
          300: "rgb(var(--g-lantern-300, 244 209 154) / <alpha-value>)",
          400: "rgb(var(--g-lantern-400, 232 184 109) / <alpha-value>)",
          500: "rgb(var(--g-lantern-500, 212 146 58) / <alpha-value>)",
        },
      },
      fontFamily: {
        display: ["var(--g-font-display, Fraunces)", "Georgia", "serif"],
        sans: ["Source Sans 3", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
