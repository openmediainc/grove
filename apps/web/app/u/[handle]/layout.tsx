import type { Metadata } from "next";
import { shareMetadata } from "@/lib/og/metadata";
import { personShareFor, safeDecode, shareImagePath } from "@/lib/og/public-data";

// Share metadata only (#76). The page itself is a client component.
export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const handle = safeDecode((await params).handle);
  return shareMetadata(await personShareFor(handle), shareImagePath("person", handle));
}

export default function PersonLayout({ children }: { children: React.ReactNode }) {
  return children;
}
