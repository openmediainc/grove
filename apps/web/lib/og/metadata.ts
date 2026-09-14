import type { Metadata } from "next";
import type { ShareCard } from "@/lib/og/share";
import { OG_SIZE } from "@/lib/og/card";

/**
 * og:/twitter: metadata for a share card. Title, description and image all
 * come from the same public-only ShareCard; a generic card gets the site's
 * words, so a private space and a missing one produce identical tags.
 */
export function shareMetadata(card: ShareCard, imagePath: string): Metadata {
  const images = [{ url: imagePath, width: OG_SIZE.width, height: OG_SIZE.height, alt: card.generic ? "Glasshouse" : card.title }];
  return {
    title: card.title,
    description: card.description,
    openGraph: { title: card.title, description: card.description, siteName: "Glasshouse", type: "website", images },
    twitter: { card: "summary_large_image", title: card.title, description: card.description, images: [imagePath] },
  };
}
