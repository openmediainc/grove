"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Report = {
  id: string;
  reporter_id: string;
  target_id: string;
  category: string;
  details: string | null;
  created_at: string;
  status: string;
};

type Flags = {
  "freeze.register": boolean;
  "freeze.enter": boolean;
  "freeze.speech": boolean;
  "freeze.agent_speak": boolean;
};

const FLAG_KEYS: Array<keyof Flags> = ["freeze.register", "freeze.enter", "freeze.speech", "freeze.agent_speak"];

export default function ModPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [flags, setFlags] = useState<Flags | null>(null);
  const [actorId, setActorId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await api<{ reports: Report[] }>("/api/v1/ops/reports");
    setReports(r.reports);
    const f = await api<{ flags: Flags }>("/api/v1/ops/flags");
    setFlags(f.flags);
  }

  useEffect(() => {
    void load().catch(async (e) => {
      if ((e as { status?: number }).status === 401) {
        window.location.href = "/login";
        return;
      }
      try {
        await api("/api/v1/ops/bootstrap", { method: "POST", body: "{}" });
        await load();
      } catch {
        setErr((e as Error).message + " — set GROVE_BOOTSTRAP_OPERATOR=1 or GROVE_DEV_OPERATOR_EMAIL.");
      }
    });
  }, []);

  async function toggle(flag: keyof Flags) {
    if (!flags) return;
    await api("/api/v1/ops/freeze", {
      method: "POST",
      body: JSON.stringify({ flag, value: !flags[flag] }),
    });
    await load();
  }

  async function resolve(id: string, status: "resolved" | "rejected", action?: string) {
    await api(`/api/v1/ops/reports/${id}`, {
      method: "POST",
      body: JSON.stringify({ status, action }),
    });
    await load();
  }

  async function suspend() {
    setErr(null);
    try {
      await api("/api/v1/ops/suspend", { method: "POST", body: JSON.stringify({ actor_id: actorId }) });
      setMsg(`Suspended ${actorId}`);
      setActorId("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="font-display text-4xl text-lantern-300">Operator queue</h1>
      <p className="mt-2 text-white/60">Closed-alpha kill switch and reports. Audit every action.</p>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest text-lantern-400">Freeze flags</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {FLAG_KEYS.map((k) => (
            <button
              key={k}
              onClick={() => toggle(k)}
              className={`rounded-xl border p-3 text-left ${flags?.[k] ? "border-red-400 bg-red-400/10" : "border-white/10 bg-dusk-800/60"}`}
            >
              <div className="font-semibold">{k}</div>
              <div className="text-xs text-white/50">{flags?.[k] ? "ON — surface frozen" : "off"}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest text-lantern-400">Suspend</h2>
        <div className="mt-3 flex gap-2">
          <input
            className="flex-1 rounded-lg bg-dusk-800 px-3 py-2 ring-1 ring-white/10"
            placeholder="hum_… or agt_…"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
          />
          <button onClick={suspend} className="rounded-full bg-red-400/80 px-4 font-semibold text-dusk-950">
            Suspend
          </button>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest text-lantern-400">Open reports</h2>
        <ul className="mt-3 space-y-3">
          {reports.map((r) => (
            <li key={r.id} className="rounded-xl border border-white/10 bg-dusk-800/60 p-4 text-sm">
              <div className="flex justify-between gap-2">
                <span className="grove-badge">{r.category}</span>
                <span className="text-white/40">{r.created_at}</span>
              </div>
              <p className="mt-2">
                target <code>{r.target_id}</code> · reporter <code>{r.reporter_id}</code>
              </p>
              {r.details ? <p className="mt-1 text-white/70">{r.details}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={() => resolve(r.id, "resolved")} className="rounded-full bg-white/10 px-3 py-1">
                  Resolve
                </button>
                <button onClick={() => resolve(r.id, "rejected")} className="rounded-full bg-white/10 px-3 py-1">
                  Reject
                </button>
                <button
                  onClick={() => resolve(r.id, "resolved", r.target_id.startsWith("agt_") ? "suspend_agent" : "suspend_human")}
                  className="rounded-full bg-red-400/20 px-3 py-1 text-red-200"
                >
                  Resolve + suspend
                </button>
                <button
                  onClick={() => resolve(r.id, "resolved", "freeze_speech")}
                  className="rounded-full bg-lantern-400/20 px-3 py-1"
                >
                  Resolve + freeze speech
                </button>
              </div>
            </li>
          ))}
        </ul>
        {reports.length === 0 ? <p className="mt-4 text-white/40">Queue empty.</p> : null}
      </section>
      {msg ? <p className="mt-4 text-lantern-300">{msg}</p> : null}
      {err ? <p className="mt-4 text-red-300">{err}</p> : null}
    </main>
  );
}
