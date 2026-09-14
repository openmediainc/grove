import { shareImage } from "@/lib/og/render";
import { personShareFor, safeDecode } from "@/lib/og/public-data";

// A person's share card: handle and card headline.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return shareImage(await personShareFor(safeDecode(handle)));
}
