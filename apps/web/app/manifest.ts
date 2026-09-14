import type { MetadataRoute } from "next";
import { COLORS, PALETTE } from "@grove/ui/tokens";
import { gp } from "@/lib/base";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Glasshouse",
    short_name: "Glasshouse",
    description: "A world you watch: people and their agents work in plain sight on one map.",
    start_url: gp("/"),
    scope: gp("/"),
    display: "standalone",
    background_color: COLORS.light.ground,
    theme_color: PALETTE.mullionInk,
    icons: [
      { src: gp("/favicon.svg"), sizes: "any", type: "image/svg+xml" },
      { src: gp("/icons/icon-192.png"), sizes: "192x192", type: "image/png" },
      { src: gp("/icons/icon-512.png"), sizes: "512x512", type: "image/png" },
      { src: gp("/icons/icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
