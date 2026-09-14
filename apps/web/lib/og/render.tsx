import { ImageResponse } from "next/og";
import { OG_SIZE, OgCard, ogFonts } from "@/lib/og/card";
import type { ShareCard } from "@/lib/og/share";

/**
 * Share images change when a card or a name changes, and a space can go
 * private at any moment, so they are cached briefly: a minute in browsers and
 * at the edge, then refetched. Crawlers keep their own copies regardless.
 * Generic and specific cards carry the same headers and status, so neither
 * says whether a space exists.
 */
export const SHARE_CACHE_CONTROL = "public, max-age=60, s-maxage=60";

export async function shareImage(card: ShareCard): Promise<Response> {
  const img = new ImageResponse(
    <OgCard eyebrow={card.eyebrow} title={card.heading} line={card.line} accent={card.accent} />,
    { ...OG_SIZE, fonts: await ogFonts() },
  );
  const headers = new Headers(img.headers);
  headers.set("content-type", "image/png");
  headers.set("cache-control", SHARE_CACHE_CONTROL);
  return new Response(img.body, { status: 200, headers });
}
