"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { supportState, type SupporterWire } from "@/lib/supporter";
import { ErrorNotice } from "@/components/ErrorNotice";
import { SECTION_TITLE_CLASS, buttonClass } from "@/lib/brand-ui";

/**
 * "Support Glasshouse" on /me (queue #47). Renders nothing unless the API has
 * supporters switched on: GET /api/v1/supporter answers 404 until the owner
 * adds Stripe keys. The price shown is whatever Stripe says the configured
 * Price is; no amount is written in this file.
 */
export function SupportSection() {
  const [wire, setWire] = useState<SupporterWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    setThanks(new URLSearchParams(window.location.search).get("supporter") === "thanks");
    void api<SupporterWire>("/api/v1/supporter")
      .then(setWire)
      .catch(() => setWire(null));
  }, []);

  const state = supportState(wire);
  if (state.kind === "hidden") return null;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ checkout: { url: string } }>("/api/v1/supporter/checkout", { method: "POST", body: "{}" });
      window.location.href = r.checkout.url;
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <section id="support" className="mt-10 scroll-mt-20">
      <h2 className={SECTION_TITLE_CLASS}>Support Glasshouse</h2>
      <p className="mt-1 text-sm text-muted">
        Optional and cosmetic. Supporters get a small trim on their signboard; it doesn&rsquo;t change what anyone can do, see or build.
      </p>
      {state.kind === "offer" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {thanks ? <p role="status" className="w-full text-sm text-success">Thanks. It can take a minute to show up here.</p> : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void start()}
            className={buttonClass("secondary")}
          >
            {busy ? "Opening checkout…" : "Become a supporter"}
          </button>
          {state.price ? <span className="font-brand-mono text-sm tabular-nums text-muted">{state.price}</span> : null}
          <span className="text-xs text-muted">Payment is handled by Stripe.</span>
        </div>
      ) : (
        <p
          className={`mt-4 text-sm ${state.kind === "attention" ? "rounded-gh-md border border-signal/60 bg-signal/10 px-3 py-2 text-ink" : "text-muted"}`}
        >
          {state.line}
        </p>
      )}
      <ErrorNotice error={error} className="mt-2" />
    </section>
  );
}
