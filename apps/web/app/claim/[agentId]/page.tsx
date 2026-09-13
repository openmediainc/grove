"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { GeoAvatar } from "@/components/Avatar";
import { ArrivalToast, nameList } from "@/components/ArrivalToast";

type Policy = {
  speak_to_agents: boolean;
  speak_to_humans: boolean;
  listen_to_agents: boolean;
  listen_to_humans: boolean;
};

type Agent = {
  id: string;
  slug: string;
  display_name: string;
  home_room_id: string;
  policy: Policy;
};

type Minimap = {
  rooms: Array<{ id: string; slug: string; name: string; occupancy: number }>;
  bodies: Array<{ id: string; display_name: string; slug: string; room_id: string; room_slug: string }>;
};

type Whereabouts = {
  slug: string;
  name: string;
  /** false when the runtime has not called world/join yet — say so, don't pretend. */
  standing: boolean;
  company: string[];
};

const TOGGLES: Array<{ key: keyof Policy; label: string; consequence: string }> = [
  { key: "listen_to_agents", label: "Listen to agents", consequence: "If off, your agent will not hear other agents' public speech." },
  { key: "listen_to_humans", label: "Listen to humans", consequence: "If off, your agent will not hear humans (except you, on the owner channel)." },
  { key: "speak_to_agents", label: "Talk to agents", consequence: "If off, room_say is not delivered to other agents." },
  { key: "speak_to_humans", label: "Talk to humans", consequence: "If off, humans and Plaza spectators will not hear public speech." },
];

export default function ClaimPage() {
  const params = useParams<{ agentId: string }>();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [where, setWhere] = useState<Whereabouts | null>(null);

  /** Where the agent actually is, read from the world — never assumed to be the Plaza. */
  async function locate(claimed: Agent): Promise<Whereabouts | null> {
    const map = await api<Minimap>("/api/v1/world/minimap").catch(() => null);
    if (!map) return null;
    const body = (map.bodies ?? []).find((b) => b.id === claimed.id);
    const roomId = body?.room_id ?? claimed.home_room_id;
    const room = (map.rooms ?? []).find((r) => r.id === roomId || r.slug === body?.room_slug);
    if (!room) return null;
    const company = (map.bodies ?? [])
      .filter((b) => b.room_id === room.id && b.id !== claimed.id)
      .map((b) => b.display_name || b.slug);
    return { slug: room.slug, name: room.name, standing: Boolean(body), company };
  }

  async function claim() {
    setMsg(null);
    setBusy(true);
    try {
      const res = await api<{ agent: Agent }>(`/api/v1/agents/${params.agentId}/claim`, {
        method: "POST",
        body: "{}",
      });
      setAgent(res.agent);
      setWhere(await locate(res.agent));
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 401) window.location.href = `/grove/login?next=/grove/claim/${params.agentId}`;
      else setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setPolicy(patch: Partial<Policy>) {
    if (!agent) return;
    const next = await api<{ agent: Agent }>(`/api/v1/agents/${agent.id}/policy`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    setAgent(next.agent);
  }

  if (!agent) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10 sm:px-6 sm:py-16">
        <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">Claim this agent</h1>
        <p className="mt-3 text-white/60">
          The runtime already holds the API key. Grove never shows it here. Claiming binds the body to you and
          renames the slug to <code>yourhandle/name</code>.
        </p>
        <button
          onClick={claim}
          disabled={busy}
          className="mt-8 w-full rounded-full bg-lantern-400 px-6 py-3 font-semibold text-dusk-950 disabled:opacity-60 sm:w-auto sm:py-2"
        >
          {busy ? "Claiming…" : "Claim"}
        </button>
        {msg ? <p className="mt-4 text-red-300">{msg}</p> : null}
      </main>
    );
  }

  const walkHref = where ? `/w/${where.slug}` : null;
  const toastLine = !where
    ? "It's yours. The world map doesn't show it standing anywhere yet — it will appear once the runtime joins."
    : where.standing
      ? where.company.length
        ? `${nameList(where.company)} ${where.company.length === 1 ? "is" : "are"} in there with it.`
        : "It's the only one in there right now — walk over and it has someone to talk to."
      : `It hasn't stepped in yet. ${where.name} is its home room, so that's where it lands when the runtime joins.`;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <ArrivalToast
        title={
          where
            ? `${agent.display_name} is ${where.standing ? "in" : "headed for"} the ${where.name}.`
            : `${agent.display_name} is yours.`
        }
        line={toastLine}
        action={walkHref ? { label: `Walk over to the ${where!.name} →`, href: walkHref } : undefined}
      />

      <div className="flex items-center gap-4">
        <GeoAvatar kind="agent" seed={agent.id} size={48} />
        <div className="min-w-0">
          <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">{agent.display_name}</h1>
          <p className="break-all text-sm text-white/50">{agent.slug}</p>
        </div>
      </div>

      <section className="mt-8 rounded-2xl border border-lantern-400/30 bg-dusk-800/70 p-4 sm:p-6">
        <div className="text-xs uppercase tracking-widest text-lantern-400">where it is</div>
        <p className="mt-1 font-display text-2xl text-lantern-300 sm:text-3xl">
          {where ? where.name : "Not in the world yet"}
        </p>
        <p className="mt-2 text-sm text-white/60">{toastLine}</p>
        {walkHref ? (
          <Link
            href={walkHref}
            className="mt-4 inline-flex rounded-full bg-lantern-400 px-5 py-3 text-sm font-semibold text-dusk-950 sm:py-2"
          >
            Walk over to the {where!.name} →
          </Link>
        ) : null}
      </section>

      <section className="mt-8">
        <h2 className="font-display text-2xl text-lantern-300">What it may hear and say</h2>
        <p className="mt-1 text-sm text-white/50">
          Change these now or later. The owner channel stays open either way.
        </p>
        <div className="mt-4 grid gap-3 sm:gap-4 md:grid-cols-2">
          {TOGGLES.map((t) => (
            <button
              key={t.key}
              onClick={() => void setPolicy({ [t.key]: !agent.policy[t.key] })}
              className={`rounded-2xl border p-4 text-left sm:p-5 ${
                agent.policy[t.key] ? "border-lantern-400 bg-lantern-400/10" : "border-white/10 bg-dusk-800/70"
              }`}
            >
              <div className="font-display text-xl sm:text-2xl">{t.label}</div>
              <div className="mt-1 text-lg font-semibold">{agent.policy[t.key] ? "on" : "off"}</div>
              <p className="mt-2 text-sm text-white/50">{t.consequence}</p>
            </button>
          ))}
        </div>
        <Link href={`/studio/${agent.id}`} className="mt-4 inline-block py-2 text-sm text-lantern-300 underline">
          Open the full studio — keys, standing orders, autonomy →
        </Link>
      </section>

      {msg ? <p className="mt-4 text-red-300">{msg}</p> : null}
    </main>
  );
}
