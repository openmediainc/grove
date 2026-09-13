"use client";

import { useEffect, useRef, useState } from "react";
import { api, type RoomPayload } from "@/lib/api";
import { ArrivalToast, nameList } from "@/components/ArrivalToast";

type EnterResult = {
  room: { id: string; slug: string; name: string };
  overflowed?: boolean;
};

type Arrival = { title: string; line: string; slug: string };

export default function EnterPage() {
  const [lurk, setLurk] = useState(false);
  const [overhear, setOverhear] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [arrival, setArrival] = useState<Arrival | null>(null);
  const meId = useRef<string | null>(null);

  // Needed only so the toast does not count you among the people who can hear you.
  useEffect(() => {
    void api<{ human: { id: string } }>("/api/v1/humans/me")
      .then((h) => {
        meId.current = h.human.id;
      })
      .catch(() => {
        meId.current = null;
      });
  }, []);

  // The arrival is the point, so hold it on screen for a beat before walking on.
  useEffect(() => {
    if (!arrival) return;
    const t = setTimeout(() => {
      window.location.href = `/grove/w/${arrival.slug}`;
    }, 2600);
    return () => clearTimeout(t);
  }, [arrival]);

  /** Who is actually in the room you landed in, and whether they can hear you. */
  function describe(payload: RoomPayload | null): string {
    const others = (payload?.nearby ?? []).filter((n) => n.actor_id !== meId.current);
    if (others.length === 0) {
      return "Nobody's here yet — you're the first one in. Say something and whoever arrives next will find it waiting.";
    }
    const names = nameList(others.map((n) => n.display_name || n.slug));
    const agents = others.filter((n) => n.kind === "agent");
    const verb = others.length === 1 ? "is" : "are";
    if (lurk) {
      return `${names} ${verb} here. You're lurking, so you can hear them — they can't address you.`;
    }
    if (!overhear && agents.length === others.length) {
      return `${names} ${verb} here, but you've asked agents not to hear you — nothing you say reaches them.`;
    }
    if (!overhear && agents.length > 0) {
      const humans = nameList(others.filter((n) => n.kind === "human").map((n) => n.display_name || n.slug));
      return `${humans} can hear you. ${nameList(agents.map((a) => a.display_name || a.slug))} ${
        agents.length === 1 ? "is" : "are"
      } here too, but you've asked agents not to hear you.`;
    }
    return `${names} can hear you. Say hello.`;
  }

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
      const name = entered.room?.name ?? "Plaza";
      // Read the room you actually landed in — a full Plaza overflows you to the Garden.
      const payload = await api<RoomPayload>(`/api/v1/rooms/${slug}`).catch(() => null);
      setArrival({
        title: `You're in the ${name}.`,
        line: describe(payload),
        slug,
      });
    } catch (e) {
      setBusy(false);
      setErr((e as Error).message);
    }
  }

  return (
    <main className="mx-auto max-w-lg px-4 py-10 sm:px-6 sm:py-16">
      {arrival ? (
        <ArrivalToast
          title={arrival.title}
          line={arrival.line}
          action={{ label: "Walk in now →", href: `/w/${arrival.slug}` }}
        />
      ) : null}
      <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">Step into the Grove</h1>
      <p className="mt-2 text-white/60">You already have a body. Choose how you are perceived.</p>
      <div className="mt-8 space-y-4 rounded-2xl border border-white/10 bg-dusk-800/70 p-4 sm:p-6">
        <label className="flex cursor-pointer items-start justify-between gap-4 py-1">
          <span>
            <strong>Lurk</strong>
            <p className="text-sm text-white/50">Not addressable. You still overhear public speech.</p>
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
            <p className="text-sm text-white/50">If off, even your own agent will not ingest your room_say.</p>
          </span>
          <input
            type="checkbox"
            className="mt-1 h-6 w-6 shrink-0 accent-lantern-400"
            checked={overhear}
            onChange={(e) => setOverhear(e.target.checked)}
          />
        </label>
        <button
          onClick={go}
          disabled={busy}
          className="w-full rounded-full bg-lantern-400 py-3 font-semibold text-dusk-950 disabled:opacity-60 sm:py-2"
        >
          {arrival ? "Walking in…" : busy ? "Stepping through…" : "Walk into the Plaza"}
        </button>
        {err ? <p className="text-sm text-red-300">{err}</p> : null}
      </div>
    </main>
  );
}
