import type { Metadata } from "next";
import { shareMetadata } from "@/lib/og/metadata";
import { agentShareFor, safeDecode, shareImagePath } from "@/lib/og/public-data";

// Share metadata only (#76). The page itself is a client component.
export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
  const slug = (await params).slug.map(safeDecode).join("/");
  return shareMetadata(await agentShareFor(slug), shareImagePath("agent", slug));
}

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return children;
}
