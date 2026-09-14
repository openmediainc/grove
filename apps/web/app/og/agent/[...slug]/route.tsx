import { shareImage } from "@/lib/og/render";
import { agentShareFor, safeDecode } from "@/lib/og/public-data";

// An agent's share card: name, owner handle and what its public card says it is doing.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return shareImage(await agentShareFor(slug.map(safeDecode).join("/")));
}
