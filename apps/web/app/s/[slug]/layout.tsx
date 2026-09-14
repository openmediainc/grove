import type { Metadata } from "next";
import { shareMetadata } from "@/lib/og/metadata";
import { safeDecode, shareImagePath, spaceShareFor } from "@/lib/og/public-data";

// Share metadata only (#76). The page itself is a client component.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const slug = safeDecode((await params).slug);
  return shareMetadata(await spaceShareFor(slug), shareImagePath("space", slug));
}

export default function SpaceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
