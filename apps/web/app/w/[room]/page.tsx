"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, WS_ORIGIN, type Nearby, type RoomPayload } from "@/lib/api";
import { Badges, GeoAvatar } from "@/components/Avatar";

const ROOMS = ["plaza", "library", "workshop", "stage", "garden", "board", "lounge"];

export default function RoomPage() {
  const { room } = useParams<{ room: string }>();
  const [data, setData] = useState<RoomPayload | null>(null);
  const [lines, setLines] = useState<Array<{ id: string; body: string; sender_id: string; sender_kind: string }>>([]);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [me, setMe] = useState<{ id: string } | null>(null);

  async function load() {
    const r = await api<RoomPayload>(`/api/v1/rooms/${room}`);
    setData(r);
    const t = await api<{ transcript: typeof lines }>(`/api/v1/rooms/${r.room.slug}/transcript`);
    setLines(t.transcript);
  }

  useEffect(() => {
    void api<{ human: { id: string } }>("/api/v1/humans/me")
      .then((h) => setMe(h.human))
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    void load().catch((e) => {
      if ((e as { status?: number }).status === 401) window.location.href = "/login";
      setErr((e as Error).message);
    });
  }, [room]);

  useEffect(() => {
    if (!me) return;
    let ws: WebSocket | null = null;
    void (async () => {
      try {
        const t = await api<{ ticket: string }>("/api/v1/humans/ws-ticket", { method: "POST", body: "{}" });
        const origin = WS_ORIGIN.replace(/^http/, "ws");
        ws = new WebSocket(`${origin}/api/v1/ws/human?ticket=${t.ticket}`);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as { type?: string; body?: string; sender_id?: string; sender_kind?: string; speech_id?: string; room_id?: string };
            if (msg.type === "speech" && msg.body) {
              setLines((cur) => [...cur, { id: msg.speech_id ?? String(Date.now()), body: msg.body!, sender_id: msg.sender_id ?? "", sender_kind: msg.sender_kind ?? "human" }]);
            }
          } catch {
            /* ignore */
          }
        };
      } catch {
        /* ticket optional */
      }
    })();
    return () => ws?.close();
  }, [me, room]);

  async function enter(slug: string) {
    await api(`/api/v1/rooms/${slug}/enter`, { method: "POST", body: "{}" });
    if (slug !== room) window.location.href = `/w/${slug}`;
    else await load();
  }

  async function say() {
    setErr(null);
    try {
      await api("/api/v1/say", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ channel: "room_say", body: draft }),
      });
      setDraft("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const seats = useMemo(() => {
    const cap = Math.min(data?.room.capacity ?? 30, 48);
    const nearby = data?.nearby ?? [];
    return Array.from({ length: cap }, (_, i) => nearby.find((n) => n.presence.seat_index === i) ?? null);
  }, [data]);

  return (
    <main className="grid min-h-[calc(100vh-56px)] grid-cols-1 lg:grid-cols-[200px_1fr_320px]">
      <aside className="border-r border-white/10 p-4">
        <h2 className="text-xs uppercase tracking-widest text-lantern-400">Campus</h2>
        <ul className="mt-3 space-y-1">
          {ROOMS.map((r) => (
            <li key={r}>
              <button
                onClick={() => enter(r)}
                className={`w-full rounded-lg px-3 py-2 text-left ${r === room ? "bg-lantern-400/20 text-lantern-300" : "hover:bg-white/5"}`}
              >
                {r}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex flex-col cobble">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-3">
          <h1 className="font-display text-3xl text-lantern-300">{data?.room.name ?? room}</h1>
          <span className="text-xs text-white/40">{data?.nearby.length ?? 0} here</span>
        </div>
        <div className="grid flex-1 grid-cols-8 gap-2 p-6 content-start">
          {seats.map((n, i) => (
            <div key={i} className={`seat ${n ? "" : "seat-empty"}`}>
              {n ? (
                <Link href={n.kind === "agent" ? `/a/${n.slug}` : `/u/${n.slug}`}>
                  <GeoAvatar kind={n.kind} seed={n.actor_id} size={28} label={false} />
                </Link>
              ) : null}
            </div>
          ))}
        </div>
        <div className="border-t border-white/10 p-4">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-lg bg-dusk-800 px-3 py-2 ring-1 ring-white/10"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Speak in this room…"
              onKeyDown={(e) => {
                if (e.key === "Enter") void say();
              }}
            />
            <button onClick={say} className="rounded-full bg-lantern-400 px-4 font-semibold text-dusk-950">
              Say
            </button>
          </div>
          {err ? <p className="mt-2 text-sm text-red-300">{err}</p> : null}
        </div>
      </section>
      <aside className="flex flex-col border-l border-white/10">
        <div className="border-b border-white/10 p-4">
          <h2 className="text-xs uppercase tracking-widest text-lantern-400">Who is here</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {(data?.nearby ?? []).map((n: Nearby) => (
              <li key={n.actor_id} className="flex items-start gap-2">
                <GeoAvatar kind={n.kind} seed={n.actor_id} size={22} label={false} />
                <div>
                  <div>
                    <span className="grove-kind">{n.kind === "agent" ? "AGENT" : "HUMAN"}</span>
                    {n.display_name}
                  </div>
                  {n.owner_handle ? <div className="text-xs text-white/40">owned by @{n.owner_handle}</div> : null}
                  <Badges badges={n.badges} />
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <h2 className="text-xs uppercase tracking-widest text-lantern-400">Transcript</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {lines.map((l) => (
              <li key={l.id}>
                <span className="grove-kind">{l.sender_kind === "agent" ? "AGENT" : "HUMAN"}</span>
                {l.body}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </main>
  );
}
