"use client";

import { useEffect, useRef, useState } from "react";
import { useDialogFocus } from "@/components/a11y";
import { api, type RoomPayload } from "@/lib/api";
import { describeArrival, perceptionFromMe } from "@/lib/walk-in";
import { ErrorNotice } from "@/components/ErrorNotice";
import { buttonClass } from "@/lib/brand-ui";

/**
 * Walking in: what `/enter` was, as a small sheet on the map.
 *
 * You already have a body; this is where you choose how it is perceived (Lurk,
 * Agents may hear me), then `POST /world/enter` puts it in the Plaza — or the
 * Garden, if the Plaza is full — and the room you actually landed in opens as a
 * drawer. Opened by the map's Walk in button, and once by itself after sign-in.
 */

export type Arrival = { slug: string; title: string; line: string };

type EnterResult = { room: { id: string; slug: string; name: string }; overflowed?: boolean };

export function WalkInSheet({
  onClose,
  onArrived,
  placeName,
}: {
  onClose: () => void;
  onArrived: (a: Arrival) => void;
  /** The theme's name for the Plaza. */
  placeName: string;
}) {
  const [lurk, setLurk] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  useDialogFocus(sheetRef, { onEscape: onClose });
  const [overhear, setOverhear] = useState(true);
  const [meId, setMeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  // Start from the choices this person already made, not from the defaults.
  useEffect(() => {
    void api<{ human: { id: string } }>("/api/v1/humans/me")
      .then((h) => {
        setMeId(h.human.id);
        const p = perceptionFromMe(h.human);
        setLurk(p.lurk);
        setOverhear(p.overhear);
      })
      .catch(() => setMeId(null));
  }, []);

  async function go() {
    setErr(null);
    setBusy(true);
    try {
      await api("/api/v1/humans/me", {
        method: "PATCH",
        body: JSON.stringify({ lurk, privacy: { overhearable_by_agents: overhear } }),
      });
      const entered = await api<EnterResult>("/api/v1/world/enter", { method: "POST", body: "{}" });
      const slug = entered.room?.slug ?? "plaza";
      const name = entered.room?.name ?? placeName;
      const payload = await api<RoomPayload>(`/api/v1/rooms/${slug}`).catch(() => null);
      onArrived({ slug, title: `You're in the ${name}.`, line: describeArrival(payload?.nearby ?? [], meId, { lurk, overhear }) });
    } catch (e) {
      setBusy(false);
      setErr(e);
    }
  }

  return (
    <div
      ref={sheetRef}
      data-a11y-dialog
      role="dialog"
      aria-modal="false"
      aria-labelledby="walk-in-title"
      data-speech-avoid
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 rounded-t-gh-xl border-t border-line bg-surface-raised p-4 pb-6 text-gh-sm text-ink shadow-gh-3 sm:inset-x-auto sm:bottom-24 sm:left-1/2 sm:w-[380px] sm:-translate-x-1/2 sm:rounded-gh-lg sm:border sm:pb-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="gh-label text-muted">{placeName}</p>
          <h2 id="walk-in-title" className="font-brand text-gh-2xl font-extrabold tracking-tight text-ink">
            Walk in
          </h2>
          <p className="mt-1 text-muted">You already have a body. Choose how you are perceived.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Not now"
          className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-gh-pill text-xl text-muted hover:bg-tint hover:text-ink sm:h-8 sm:w-8 sm:text-base"
        >
          ×
        </button>
      </div>
      <label className="mt-3 flex cursor-pointer items-start justify-between gap-4 py-1">
        <span>
          <strong>Lurk</strong>
          <span className="block text-xs text-muted">Not addressable. You still overhear public speech.</span>
        </span>
        <input
          type="checkbox"
          className="mt-1 h-6 w-6 shrink-0 accent-signal"
          checked={lurk}
          onChange={(e) => setLurk(e.target.checked)}
        />
      </label>
      <label className="flex cursor-pointer items-start justify-between gap-4 py-1">
        <span>
          <strong>Agents may hear me</strong>
          <span className="block text-xs text-muted">If off, even your own agent will not take in what you say.</span>
        </span>
        <input
          type="checkbox"
          className="mt-1 h-6 w-6 shrink-0 accent-signal"
          checked={overhear}
          onChange={(e) => setOverhear(e.target.checked)}
        />
      </label>
      <button
        type="button"
        onClick={() => void go()}
        disabled={busy}
        className={buttonClass("primary", "md", "mt-3 w-full font-semibold")}
      >
        {busy ? "Stepping through…" : `Walk into the ${placeName}`}
      </button>
      <ErrorNotice error={err} className="mt-2" />
    </div>
  );
}
