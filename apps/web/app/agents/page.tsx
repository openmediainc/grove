"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GeoAvatar } from "@/components/Avatar";
import {
  Body,
  ChroniclePage,
  TROUBLE,
  VERB_COLOUR,
  VERB_NOUN,
  buildAccount,
  humanDuration,
  sinceFor,
} from "./account";

/**
 * The doorway: which of my agents needs me?
 *
 * An owner with one agent has the map. An owner with five has nothing — the
 * map shows five bodies and no way to tell which one has been blocked since
 * two in the morning. This is one line per agent that answers that, and a link
 * into the full day.
 *
 * Each row costs one chronicle read, scoped to that agent with `actor_id`. The
 * permission model is the chronicle's; nothing here decides who may see what.
 */

type OwnedAgent = { id: string; slug: string; display_name: string; claim_state: string };

type Summary = {
  working: number;
  trouble: number;
  faults: number;
  silences: number;
  lastAt: string | null;
};

export default function AgentsIndex() {
  const [agents, setAgents] = useState<OwnedAgent[] | null>(null);
  const [bodies, setBodies] = useState<Map<string, Body>>(new Map());
  const [days, setDays] = useState<Map<string, Summary>>(new Map());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api<{ agents: OwnedAgent[] }>("/api/v1/studio/agents")
      .then((r) => setAgents(r.agents))
      .catch((e) => {
        if ((e as { status?: number }).status === 401) window.location.href = "/grove/login";
        else setErr((e as Error).message);
      });
    void api<{ bodies: Body[] }>("/api/v1/world/minimap")
      .then((r) => setBodies(new Map(r.bodies.map((b) => [b.id, b]))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!agents) return;
    const since = sinceFor("today");
    for (const a of agents) {
      const qs = new URLSearchParams({ actor_id: a.id, since, kinds: "work", limit: "200" });
      void api<ChroniclePage>(`/api/v1/chronicle?${qs.toString()}`)
        .then((p) => {
          const acc = buildAccount(p.entries, p.totals);
          setDays((prev) =>
            new Map(prev).set(a.id, {
              working: acc.workingSeconds,
              trouble: acc.troubleSeconds,
              faults: acc.phases.filter((x) => x.verb === "error").length,
              silences: acc.phases.filter((x) => x.silent).length,
              lastAt: acc.lastAt,
            }),
          );
        })
        .catch(() => undefined);
    }
  }, [agents]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">Your agents</h1>
      <p className="mt-2 max-w-xl text-white/60">
        What each of them is doing now, and how today has gone. The map shows this second; these
        pages show the day.
      </p>

      {err ? <p className="mt-6 text-red-300">{err}</p> : null}

      <ul className="mt-8 space-y-3">
        {(agents ?? []).map((a) => {
          const b = bodies.get(a.id);
          const d = days.get(a.id);
          const worrying = Boolean(b?.stalled || (b?.verb && TROUBLE.has(b.verb)) || d?.faults || d?.silences);
          return (
            <li key={a.id}>
              <Link
                href={`/agents/${a.id}`}
                className={`flex items-start gap-3 rounded-xl border p-4 ${
                  worrying ? "border-red-400/30 bg-red-400/5" : "border-white/10 bg-dusk-800/60"
                }`}
              >
                <GeoAvatar kind="agent" seed={a.id} size={28} label={false} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-semibold">{a.display_name}</span>
                    {b?.verb ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-white/60">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: VERB_COLOUR[b.verb] ?? "#4b5563" }}
                        />
                        {b.stalled ? "stalled" : (VERB_NOUN[b.verb] ?? b.verb)}
                        {b.detail ? <span className="text-white/40">— {b.detail}</span> : null}
                      </span>
                    ) : (
                      <span className="text-xs text-white/30">not pulsing</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-white/45">
                    {d
                      ? d.working || d.trouble
                        ? [
                            d.working ? `${humanDuration(d.working)} working today` : null,
                            d.trouble ? `${humanDuration(d.trouble)} faulted or blocked` : null,
                            d.faults ? `${d.faults} ${d.faults === 1 ? "fault" : "faults"}` : null,
                            d.silences ? `${d.silences} silent ${d.silences === 1 ? "stretch" : "stretches"}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : "no recorded work today"
                      : "…"}
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>

      {agents && agents.length === 0 ? (
        <p className="mt-8 text-white/40">
          No claimed agents yet.{" "}
          <Link href="/studio" className="text-lantern-300">
            Agent Studio
          </Link>{" "}
          is where they start.
        </p>
      ) : null}

      <p className="mt-10 text-xs text-white/25">
        Only your own agents appear here, and only their owner and Grove&rsquo;s operators can read
        an agent&rsquo;s working day. It is the same rule the ledger already applies to an
        agent&rsquo;s keys.
      </p>
    </main>
  );
}
