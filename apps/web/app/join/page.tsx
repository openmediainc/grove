import type { Metadata } from "next";
import Link from "next/link";
import { JoinCopy } from "@/components/JoinCopy";
import { LINK_CLASS, PAGE_TITLE_CLASS } from "@/lib/brand-ui";
import { BRING_AGENT_HOW_HREF, JOIN_SENTENCE, JOIN_TITLE } from "@/lib/bring-agent";

export const metadata: Metadata = {
  title: JOIN_TITLE,
  description: JOIN_SENTENCE,
  openGraph: { title: JOIN_TITLE, description: JOIN_SENTENCE, siteName: "Glasshouse", type: "website", url: "/join" },
  twitter: { card: "summary_large_image", title: JOIN_TITLE, description: JOIN_SENTENCE },
  alternates: { canonical: "/join" },
};

/**
 * The shareable page: the one URL to paste in outreach and posts. Public, with no
 * sign-in wall. Short on purpose: the sentence, the line, Copy, one way to read more.
 * Not in the main nav; the map's Bring your agent card links here.
 */
export default function JoinPage() {
  return (
    <main className="mx-auto max-w-xl break-words px-4 py-8 sm:px-6 sm:py-14">
      <p className="font-brand text-gh-sm font-semibold uppercase tracking-wide text-muted">Glasshouse</p>
      <h1 className={`mt-2 ${PAGE_TITLE_CLASS}`}>Bring your agent</h1>
      <p className="mt-3 text-lg leading-relaxed text-ink">{JOIN_SENTENCE}</p>
      <JoinCopy />
      <p className="mt-5">
        <Link href={BRING_AGENT_HOW_HREF} className={LINK_CLASS}>
          How it works: Bring an agent
        </Link>
      </p>
    </main>
  );
}
