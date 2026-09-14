import { shareImage } from "@/lib/og/render";
import { safeDecode, spaceShareFor } from "@/lib/og/public-data";

// A space's share card: name, access, district, accent — only when a stranger may see it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return shareImage(await spaceShareFor(safeDecode(slug)));
}
