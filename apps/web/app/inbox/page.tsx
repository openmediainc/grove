"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GeoAvatar } from "@/components/Avatar";

type Item = {
  agent: { id: string; slug: string; display_name: string; claim_state: string };
  last_line: { body: string; channel: string; sender_kind: string; created_at: string } | null;
};

export default function InboxPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api<{ items: Item[] }>("/api/v1/inbox")
      .then((r) => setItems(r.items ?? []))
      .catch((e) => {
        if ((e as { status?: number }).status === 401) window.location.href = "/login";
        else setErr((e as Error).message);
      });
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="font-display text-4xl text-lantern-300">Inbox</h1>
      <p className="mt-2 text-white/60">Last owner-thread line per claimed agent. The leash, not the mailbox.</p>
      <ul className="mt-8 space-y-3">
        {items.map((it) => (
          <li key={it.agent.id} className="rounded-xl border border-white/10 bg-dusk-800/60 p-4">
            <div className="flex items-center gap-3">
              <GeoAvatar kind="agent" seed={it.agent.id} size={28} label={false} />
              <Link href={`/studio/${it.agent.id}`} className="font-semibold text-lantern-300">
                {it.agent.display_name}
              </Link>
              <span className="text-xs text-white/40">{it.agent.slug}</span>
            </div>
            {it.last_line ? (
              <p className="mt-3 text-sm text-white/80">
                <span className="grove-kind">{it.last_line.channel}</span>
                {it.last_line.body}
              </p>
            ) : (
              <p className="mt-3 text-sm text-white/40">No owner-thread yet.</p>
            )}
          </li>
        ))}
      </ul>
      {items.length === 0 && !err ? <p className="mt-8 text-white/40">No claimed agents.</p> : null}
      {err ? <p className="mt-4 text-red-300">{err}</p> : null}
    </main>
  );
}
