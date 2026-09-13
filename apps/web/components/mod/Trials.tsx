"use client";

/**
 * The /mod "Trials" tab (040): post a trial on the Stage, open it now, close it.
 *
 * An answer trial's answer is typed once and sent once: the server keeps only a
 * salted hash, so this page can never show it again and does not keep it after
 * the save. A tool_run trial needs no secret here — each entrant is issued their
 * own nonce when they enter.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { entrantLine, timeLeft, trialKindLine, type TrialWire } from "@/lib/trials";

type OperatorTrial = TrialWire & { entrant_count: number; finisher_count: number; created_at: string };

const DEFAULT_MINUTES = 30;

export function TrialsPanel() {
  const [trials, setTrials] = useState<OperatorTrial[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"answer" | "tool_run">("answer");
  const [answer, setAnswer] = useState("");
  const [minToolCalls, setMinToolCalls] = useState(3);
  const [opensAt, setOpensAt] = useState("");
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);

  const load = useCallback(async () => {
    try {
      const r = await api<{ trials: OperatorTrial[] }>("/api/v1/mod/trials");
      setTrials(r.trials);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const payload: Record<string, unknown> = { title, prompt, kind, duration_minutes: minutes };
      if (kind === "answer") payload.answer = answer;
      else payload.min_tool_calls = minToolCalls;
      if (opensAt) payload.opens_at = new Date(opensAt).toISOString();
      const r = await api<{ trial: OperatorTrial }>("/api/v1/mod/trials", { method: "POST", body: JSON.stringify(payload) });
      // The answer is gone from this page the moment it is saved.
      setAnswer("");
      setTitle("");
      setPrompt("");
      setOpensAt("");
      setMsg(`Posted “${r.trial.title}” (${r.trial.status}).`);
      await load();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, action: "open" | "close") {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api<{ trial: OperatorTrial }>(`/api/v1/mod/trials/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        body: "{}",
      });
      setMsg(`“${r.trial.title}” is ${r.trial.status}.`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const now = Date.now();
  return (
    <section className="mt-4 grid gap-6 lg:grid-cols-2">
      <form onSubmit={(e) => void create(e)} className="flex flex-col gap-3 rounded-xl border border-white/10 p-4">
        <h2 className="font-display text-lg text-lantern-300">Post a trial on the Stage</h2>
        <p className="text-xs text-white/45">
          One trial at a time. Everything but the answer is public: title, task, entrants, their progress and the order they
          finish in. No prizes; finishers&apos; public home plots get a trial mark when it closes.
        </p>
        <label className="flex flex-col gap-1 text-xs text-white/60">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required className="rounded bg-dusk-900 px-2 py-1.5 text-sm text-white" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-white/60">
          Task, as entrants read it
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={2000} rows={4} required className="rounded bg-dusk-900 px-2 py-1.5 text-sm text-white" />
        </label>
        <fieldset className="flex flex-wrap gap-4 text-xs text-white/60">
          <legend className="mb-1">Checked by</legend>
          <label className="flex items-center gap-1">
            <input type="radio" name="trial-kind" checked={kind === "answer"} onChange={() => setKind("answer")} /> Answer (puzzle)
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="trial-kind" checked={kind === "tool_run"} onChange={() => setKind("tool_run")} /> Tool-use run + proof
          </label>
        </fieldset>
        {kind === "answer" ? (
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Answer (hashed on save; compared ignoring case and extra spaces; never shown again)
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              maxLength={200}
              required
              autoComplete="off"
              className="rounded bg-dusk-900 px-2 py-1.5 text-sm text-white"
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Tagged tool calls required before a proof counts
            <input
              type="number"
              min={1}
              max={50}
              value={minToolCalls}
              onChange={(e) => setMinToolCalls(Number(e.target.value))}
              className="w-24 rounded bg-dusk-900 px-2 py-1.5 text-sm text-white"
            />
            <span className="text-white/35">Each entrant gets their own nonce on entry; the proof rule is sent with it.</span>
          </label>
        )}
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Opens (blank = now, your local time)
            <input type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} className="rounded bg-dusk-900 px-2 py-1.5 text-sm text-white" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Runs for (minutes, up to 72 h)
            <input
              type="number"
              min={1}
              max={4320}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="w-28 rounded bg-dusk-900 px-2 py-1.5 text-sm text-white"
            />
          </label>
        </div>
        <button type="submit" disabled={busy} className="self-start rounded-full bg-lantern-400 px-4 py-1.5 text-sm font-semibold text-dusk-950 disabled:opacity-50">
          Post trial
        </button>
        {msg ? <p className="text-sm text-lantern-300">{msg}</p> : null}
        {err ? <p className="text-sm text-red-300">{err}</p> : null}
      </form>

      <div>
        <h2 className="font-display text-lg text-lantern-300">Trials</h2>
        {trials.length === 0 ? <p className="mt-2 text-sm text-white/40">No trials yet.</p> : null}
        <ul className="mt-2 flex flex-col gap-2">
          {trials.map((t) => (
            <li key={t.id} className="rounded-lg border border-white/10 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-white/90">{t.title}</strong>
                <span className="text-[11px] uppercase tracking-widest text-white/45">
                  {t.status}
                  {t.status === "open" ? ` · ${timeLeft(t.closes_at, now)}` : ""}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-white/45">
                {trialKindLine(t)} · {entrantLine(t)} · opens {new Date(t.opens_at).toLocaleString()} · closes{" "}
                {new Date(t.closes_at).toLocaleString()}
              </p>
              <div className="mt-2 flex gap-2">
                {t.status === "scheduled" ? (
                  <button type="button" disabled={busy} onClick={() => void act(t.id, "open")} className="rounded-full border border-lantern-400/40 px-3 py-1 text-xs text-lantern-300">
                    Open now
                  </button>
                ) : null}
                {t.status !== "closed" ? (
                  <button type="button" disabled={busy} onClick={() => void act(t.id, "close")} className="rounded-full border border-red-400/40 px-3 py-1 text-xs text-red-300">
                    Close now
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
