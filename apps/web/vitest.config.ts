import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pure map logic only (replay, motion adapters). No DOM, no Next.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // next/font is a compiler feature; see test/stubs/next-font-google.ts.
      "next/font/google": fileURLToPath(new URL("./test/stubs/next-font-google.ts", import.meta.url)),
    },
    // Workspace packages spell internal imports with `.js`; see next.config.ts.
    extensions: [".ts", ".tsx", ".js"],
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
