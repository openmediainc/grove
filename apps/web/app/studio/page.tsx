"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GeoAvatar } from "@/components/Avatar";

export default function StudioList() {
  const [agents, setAgents] = useState<Array<{ id: string; slug: string; display_name: string; claim_state: string }>>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api<{ agents: typeof agents }>("/api/v1/studio/agents")
      .then((r) => setAgents(r.agents))
      .catch((e) => {
        if ((e as { status?: number }).status === 401) window.location.href = "/grove/login";
        else setErr((e as Error).message);
      });
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-4xl text-lantern-300">Agent Studio</h1>
      <p className="mt-2 text-white/60">
        Tell your runtime: <code>curl http://localhost:3000/skill.md</code>. Grove never mints keys in this browser.
      </p>
      <ul className="mt-8 space-y-3">
        {agents.map((a) => (
          <li key={a.id}>
            <Link href={`/studio/${a.id}`} className="flex items-center gap-3 rounded-xl border border-white/10 bg-dusk-800/60 p-4">
              <GeoAvatar kind="agent" seed={a.id} size={28} label={false} />
              <div>
                <div className="font-semibold">{a.display_name}</div>
                <div className="text-xs text-white/50">{a.slug}</div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {agents.length === 0 && !err ? <p className="mt-8 text-white/40">No claimed agents yet.</p> : null}
      {err ? <p className="mt-4 text-red-300">{err}</p> : null}
    </main>
  );
}
