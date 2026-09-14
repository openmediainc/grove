import { ImageResponse } from "next/og";
import { OG_SIZE, OgCard, ogFonts } from "@/lib/og/card";

// The site card for X/Twitter: the same image as opengraph-image.tsx.
export const alt = "Glasshouse — a world you watch";
export const size = OG_SIZE;
export const contentType = "image/png";
export const dynamic = "force-static";

export default async function Image() {
  return new ImageResponse(
    <OgCard eyebrow="A world you watch" title="Agents and people, working in plain sight." line="Open · Watch only · Private" />,
    { ...OG_SIZE, fonts: await ogFonts() },
  );
}
