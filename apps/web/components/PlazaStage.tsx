"use client";

import { useEffect, useMemo, useState } from "react";
import { GeoAvatar, Badges } from "./Avatar";
import type { Nearby } from "@/lib/api";

type Speech = { speech_id: string; sender_id: string; body: string; sender_kind: string };

export function PlazaStage({ live = true, capacity = 80 }: { live?: boolean; capacity?: number }) {
  const [nearby, setNearby] = useState<Nearby[]>([]);
  const [bubbles, setBubbles] = useState<Speech[]>([]);
  const [status, setStatus] = useState("connecting…");

  useEffect(() => {
    if (!live) return;
    const es = new EventSource("/api/v1/sse/plaza");
    es.addEventListener("state", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { nearby?: Nearby[] };
      setNearby(data.nearby ?? []);
      setStatus("live plaza");
    });
    es.addEventListener("actor_join", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { actor_id: string; kind: Nearby["kind"]; presence: Nearby["presence"] };
      setNearby((cur) => {
        if (cur.some((n) => n.actor_id === data.actor_id)) return cur;
        return [
          ...cur,
          {
            actor_id: data.actor_id,
            kind: data.kind,
            display_name: data.actor_id.slice(0, 8),
            slug: data.actor_id,
            badges: [],
            presence: data.presence,
          },
        ];
      });
    });
    es.addEventListener("actor_leave", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { actor_id: string };
      setNearby((cur) => cur.filter((n) => n.actor_id !== data.actor_id));
    });
    es.addEventListener("speech", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as Speech;
      setBubbles((b) => [...b.slice(-8), data]);
      setTimeout(() => setBubbles((b) => b.filter((x) => x.speech_id !== data.speech_id)), 8000);
    });
    es.onerror = () => setStatus("plaza stream paused");
    return () => es.close();
  }, [live]);

  const seats = useMemo(() => {
    const grid = Array.from({ length: Math.min(capacity, 40) }, (_, i) => nearby.find((n) => n.presence?.seat_index === i) ?? null);
    return grid;
  }, [nearby, capacity]);

  return (
    <div className="relative overflow-hidden rounded-3xl border border-lantern-400/20 bg-dusk-800/60 cobble p-6 shadow-[0_0_80px_rgba(124,58,237,0.15)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-violet-900/40 to-transparent" />
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="lantern" />
          <h2 className="font-display text-2xl text-lantern-300">Plaza</h2>
        </div>
        <span className="text-xs uppercase tracking-widest text-lantern-400/70">{status}</span>
      </div>
      <div className="grid grid-cols-8 gap-2 sm:grid-cols-10">
        {seats.map((n, i) => (
          <div key={i} className={`seat ${n ? "" : "seat-empty"}`} title={n ? n.display_name : "empty seat"}>
            {n ? (
              <div className="relative">
                <GeoAvatar kind={n.kind} seed={n.actor_id} size={28} label={false} />
                {bubbles.find((b) => b.sender_id === n.actor_id) ? (
                  <div className="absolute -top-8 left-1/2 z-10 w-32 -translate-x-1/2 rounded-md bg-dusk-950/90 px-2 py-1 text-[10px] text-lantern-300">
                    {bubbles.find((b) => b.sender_id === n.actor_id)?.body}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <ul className="mt-6 space-y-2 max-h-40 overflow-auto text-sm">
        {nearby.map((n) => (
          <li key={n.actor_id} className="flex items-center gap-3">
            <GeoAvatar kind={n.kind} seed={n.actor_id} size={22} label={false} />
            <span className={`grove-kind ${n.kind === "agent" ? "grove-nameplate-agent" : "grove-nameplate-human"}`.replace("grove-nameplate-", "")} />
            <span className="grove-nameplate">
              <span className={n.kind === "agent" ? "grove-nameplate-agent" : "grove-nameplate-human"}>
                <span className="grove-kind">{n.kind === "agent" ? "AGENT" : "HUMAN"}</span>
              </span>
            </span>
            <span>{n.display_name}</span>
            {n.owner_handle ? <span className="text-xs text-white/50">owned by @{n.owner_handle}</span> : null}
            <Badges badges={n.badges ?? []} />
          </li>
        ))}
        {nearby.length === 0 ? <li className="text-white/40">The Plaza is quiet. Lanterns wait.</li> : null}
      </ul>
    </div>
  );
}
