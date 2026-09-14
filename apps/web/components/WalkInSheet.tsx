"use client";

import { useEffect, useState } from "react";
import { api, type RoomPayload } from "@/lib/api";
import { describeArrival, perceptionFromMe } from "@/lib/walk-in";
import { ErrorNotice } from "@/components/ErrorNotice";

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
      role="dialog"
      aria-modal="false"
      aria-labelledby="walk-in-title"
      data-speech-avoid
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 rounded-t-2xl border-t border-lantern-400/30 bg-dusk-950/[0.97] p-4 pb-6 text-sm shadow-2xl sm:inset-x-auto sm:bottom-24 sm:left-1/2 sm:w-[380px] sm:-translate-x-1/2 sm:rounded-2xl sm:border sm:pb-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="walk-in-title" className="font-display text-2xl text-lantern-300">
            Walk in
          </h2>
          <p className="mt-1 text-white/60">You already have a body. Choose how you are perceived.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Not now"
          className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl text-white/50 hover:text-white sm:h-8 sm:w-8 sm:text-base"
        >
          ×
        </button>
      </div>
      <label className="mt-3 flex cursor-pointer items-start justify-between gap-4 py-1">
        <span>
          <strong>Lurk</strong>
          <span className="block text-xs text-white/50">Not addressable. You still overhear public speech.</span>
        </span>
        <input
          type="checkbox"
          className="mt-1 h-6 w-6 shrink-0 accent-lantern-400"
          checked={lurk}
          onChange={(e) => setLurk(e.target.checked)}
        />
      </label>
      <label className="flex cursor-pointer items-start justify-between gap-4 py-1">
        <span>
          <strong>Agents may hear me</strong>
          <span className="block text-xs text-white/50">If off, even your own agent will not take in what you say.</span>
        </span>
        <input
          type="checkbox"
          className="mt-1 h-6 w-6 shrink-0 accent-lantern-400"
          checked={overhear}
          onChange={(e) => setOverhear(e.target.checked)}
        />
      </label>
      <button
        type="button"
        onClick={() => void go()}
        disabled={busy}
        className="mt-3 w-full rounded-full bg-lantern-400 py-3 font-semibold text-dusk-950 disabled:opacity-60 sm:py-2"
      >
        {busy ? "Stepping through…" : `Walk into the ${placeName}`}
      </button>
      <ErrorNotice error={err} className="mt-2" />
    </div>
  );
}
