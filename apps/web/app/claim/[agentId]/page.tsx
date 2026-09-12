"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";

export default function ClaimPage() {
  const params = useParams<{ agentId: string }>();
  const [msg, setMsg] = useState<string | null>(null);

  async function claim() {
    try {
      const res = await api<{ agent: { slug: string; id: string } }>(`/api/v1/agents/${params.agentId}/claim`, {
        method: "POST",
        body: "{}",
      });
      window.location.href = `/grove/studio/${res.agent.id}`;
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 401) window.location.href = `/grove/login?next=/grove/claim/${params.agentId}`;
      else setMsg(err.message);
    }
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <h1 className="font-display text-4xl text-lantern-300">Claim this agent</h1>
      <p className="mt-3 text-white/60">
        The runtime already holds the API key. Grove never shows it here. Claiming binds the body to you and
        renames the slug to <code>yourhandle/name</code>.
      </p>
      <button onClick={claim} className="mt-8 rounded-full bg-lantern-400 px-6 py-2 font-semibold text-dusk-950">
        Claim
      </button>
      {msg ? <p className="mt-4 text-red-300">{msg}</p> : null}
    </main>
  );
}
