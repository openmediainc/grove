"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { spaceHref } from "@/lib/space-page";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PAGE_TITLE_CLASS, buttonClass } from "@/lib/brand-ui";

/**
 * The landing page for an invite link. Redemption is a POST, so it happens here
 * rather than on a GET: a link pasted into a chat that unfurls previews must not
 * spend a single-use invite before the person has even clicked it.
 */
/** Sign in, then land back on this invite (login's `next` takes an unprefixed in-app path). */
function loginHref(code: string): string {
  return `/login?${new URLSearchParams({ next: `/spaces/join/${encodeURIComponent(code)}` }).toString()}`;
}

export default function RedeemInvite() {
  const { code } = useParams<{ code: string }>();
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [world, setWorld] = useState<{ id: string; slug: string; name: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    void api<{ human: { id: string } }>("/api/v1/humans/me")
      .then(() => setSignedIn(true))
      .catch(() => setSignedIn(false));
  }, []);

  async function redeem() {
    setErr(null);
    setState("working");
    try {
      const r = await api<{
        world: { id: string; slug: string; name: string };
        already_member: boolean;
      }>(`/api/v1/invites/${encodeURIComponent(code)}/redeem`, { method: "POST", body: "{}" });
      setWorld(r.world);
      setState("done");
    } catch (e) {
      setErr(e);
      setState("error");
    }
  }

  return (
    <main className="mx-auto max-w-lg px-4 py-10 sm:px-6 sm:py-16">
      <h1 className={PAGE_TITLE_CLASS}>An invitation</h1>

      {signedIn === false ? (
        <>
          <p className="mt-3 text-muted">
            Sign in first and we will bring you straight back here — the invite admits a person, so Glasshouse
            has to know which one.
          </p>
          <Link
            href={loginHref(code)}
            className={buttonClass("primary", "md", "mt-6")}
          >
            Sign in
          </Link>
        </>
      ) : null}

      {signedIn && state !== "done" ? (
        <>
          <p className="mt-3 text-muted">
            Someone has held a plot open for you. Accepting makes you a member of their space.
          </p>
          <button
            onClick={() => void redeem()}
            disabled={state === "working"}
            className={buttonClass("primary", "md", "mt-6")}
          >
            {state === "working" ? "Accepting…" : "Accept the invitation"}
          </button>
        </>
      ) : null}

      {state === "done" && world ? (
        <>
          <p className="mt-3 text-muted">
            You are a member of <strong className="text-ink">{world.name}</strong>.
          </p>
          <Link
            href={spaceHref(world.slug)}
            className={buttonClass("primary", "md", "mt-6")}
          >
            Go to the space
          </Link>
        </>
      ) : null}

      {err ? (
        <div className="mt-6">
          <ErrorNotice error={err} action="accept this invite" />
          <p className="mt-2 text-sm text-muted">An invite stops working once it is revoked, spent, or past its expiry.</p>
        </div>
      ) : null}

      <Link href="/explore" className="mt-10 inline-block py-2 text-sm text-muted underline-offset-2 hover:text-ink hover:underline">
        ← Explore
      </Link>
    </main>
  );
}
