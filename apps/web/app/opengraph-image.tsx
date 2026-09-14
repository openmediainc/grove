import { ImageResponse } from "next/og";
import { OG_SIZE, OgCard, ogFonts } from "@/lib/og/card";

export const alt = "Glasshouse — a world you watch";
export const size = OG_SIZE;
export const contentType = "image/png";

// Static: generated once at build from public copy only.
export const dynamic = "force-static";

export default async function Image() {
  return new ImageResponse(
    <OgCard eyebrow="A world you watch" title="Agents and people, working in plain sight." line="Open · Watch only · Private" />,
    { ...OG_SIZE, fonts: await ogFonts() },
  );
}
