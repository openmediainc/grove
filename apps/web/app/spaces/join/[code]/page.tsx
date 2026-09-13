"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * The landing page for an invite link. Redemption is a POST, so it happens here
 * rather than on a GET: a link pasted into a chat that unfurls previews must not
 * spend a single-use invite before the person has even clicked it.
 */
export default function RedeemInvite() {
  const { code } = useParams<{ code: string }>();
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [world, setWorld] = useState<{ id: string; slug: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
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
      setErr((e as Error).message);
      setState("error");
    }
  }

  return (
    <main className="mx-auto max-w-lg px-4 py-10 sm:px-6 sm:py-16">
      <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">An invitation</h1>

      {signedIn === false ? (
        <>
          <p className="mt-3 text-white/60">
            Sign in first, then come back to this link — the invite admits a person, so Grove has to know
            which one.
          </p>
          <Link
            href="/login"
            className="mt-6 inline-block rounded-full bg-lantern-400 px-5 py-3 text-sm font-semibold text-dusk-950 sm:py-2"
          >
            Sign in
          </Link>
        </>
      ) : null}

      {signedIn && state !== "done" ? (
        <>
          <p className="mt-3 text-white/60">
            Someone has held a plot open for you. Accepting makes you a member of their space.
          </p>
          <button
            onClick={() => void redeem()}
            disabled={state === "working"}
            className="mt-6 rounded-full bg-lantern-400 px-5 py-3 font-semibold text-dusk-950 disabled:opacity-40 sm:py-2"
          >
            {state === "working" ? "Accepting…" : "Accept the invitation"}
          </button>
        </>
      ) : null}

      {state === "done" && world ? (
        <>
          <p className="mt-3 text-white/60">
            You are a member of <strong className="text-white">{world.name}</strong>.
          </p>
          <Link
            href={`/spaces/${world.slug}`}
            className="mt-6 inline-block rounded-full bg-lantern-400 px-5 py-3 font-semibold text-dusk-950 sm:py-2"
          >
            Go to the space
          </Link>
        </>
      ) : null}

      {err ? (
        <p className="mt-6 text-red-300">
          {err} An invite stops working once it is revoked, spent, or past its expiry.
        </p>
      ) : null}

      <Link href="/spaces" className="mt-10 block py-2 text-sm text-white/40">
        ← All spaces
      </Link>
    </main>
  );
}
