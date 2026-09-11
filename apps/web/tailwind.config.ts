import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        dusk: {
          950: "#070814",
          900: "#0b1220",
          800: "#121a2e",
          700: "#1a2744",
        },
        lantern: {
          300: "#f4d19a",
          400: "#e8b86d",
          500: "#d4923a",
        },
      },
      fontFamily: {
        display: ["Fraunces", "Georgia", "serif"],
        sans: ["Source Sans 3", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
