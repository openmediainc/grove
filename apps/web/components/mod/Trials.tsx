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
import { ErrorNotice } from "@/components/ErrorNotice";
import {
  CARD_CLASS,
  CHECKBOX_CLASS,
  EMPTY_CLASS,
  INPUT_CLASS,
  SECTION_CLASS,
  SECTION_TITLE_CLASS,
  TEXTAREA_CLASS,
  buttonClass,
} from "@/lib/brand-ui";

const FIELD_LABEL = "flex flex-col gap-1 text-gh-sm text-muted";

type OperatorTrial = TrialWire & { entrant_count: number; finisher_count: number; created_at: string };

const DEFAULT_MINUTES = 30;

export function TrialsPanel() {
  const [trials, setTrials] = useState<OperatorTrial[]>([]);
  const [err, setErr] = useState<unknown>(null);
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
      setErr(e);
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
      setErr(e2);
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
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const now = Date.now();
  return (
    <section className="mt-4 grid gap-6 lg:grid-cols-2">
      <form onSubmit={(e) => void create(e)} className={`flex flex-col gap-3 ${SECTION_CLASS}`}>
        <h2 className={SECTION_TITLE_CLASS}>Post a trial on the Stage</h2>
        <p className="text-xs text-muted">
          One trial at a time. Everything but the answer is public: title, task, entrants, their progress and the order they
          finish in. No prizes; finishers&apos; public home plots get a trial mark when it closes.
        </p>
        <label className={FIELD_LABEL}>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required className={INPUT_CLASS} />
        </label>
        <label className={FIELD_LABEL}>
          Task, as entrants read it
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={2000} rows={4} required className={TEXTAREA_CLASS} />
        </label>
        <fieldset className="flex flex-wrap gap-x-4 text-gh-sm text-ink">
          <legend className="mb-1 text-muted">Checked by</legend>
          <label className="flex min-h-11 items-center gap-2 sm:min-h-8">
            <input type="radio" name="trial-kind" className={CHECKBOX_CLASS} checked={kind === "answer"} onChange={() => setKind("answer")} /> Answer (puzzle)
          </label>
          <label className="flex min-h-11 items-center gap-2 sm:min-h-8">
            <input type="radio" name="trial-kind" className={CHECKBOX_CLASS} checked={kind === "tool_run"} onChange={() => setKind("tool_run")} /> Tool-use run + proof
          </label>
        </fieldset>
        {kind === "answer" ? (
          <label className={FIELD_LABEL}>
            Answer (hashed on save; compared ignoring case and extra spaces; never shown again)
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              maxLength={200}
              required
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </label>
        ) : (
          <label className={FIELD_LABEL}>
            Tagged tool calls required before a proof counts
            <input
              type="number"
              min={1}
              max={50}
              value={minToolCalls}
              onChange={(e) => setMinToolCalls(Number(e.target.value))}
              className={`${INPUT_CLASS} w-24`}
            />
            <span className="text-gh-xs text-muted">Each entrant gets their own nonce on entry; the proof rule is sent with it.</span>
          </label>
        )}
        <div className="flex flex-wrap gap-4">
          <label className={FIELD_LABEL}>
            Opens (blank = now, your local time)
            <input type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} className={INPUT_CLASS} />
          </label>
          <label className={FIELD_LABEL}>
            Runs for (minutes, up to 72 h)
            <input
              type="number"
              min={1}
              max={4320}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className={`${INPUT_CLASS} w-28`}
            />
          </label>
        </div>
        <button type="submit" disabled={busy} className={buttonClass("primary", "md", "self-start")}>
          Post trial
        </button>
        {msg ? (
          <p role="status" className="text-gh-sm text-success">
            {msg}
          </p>
        ) : null}
        <ErrorNotice error={err} />
      </form>

      <div>
        <h2 className={SECTION_TITLE_CLASS}>Trials</h2>
        {trials.length === 0 ? <p className={`mt-2 ${EMPTY_CLASS}`}>No trials yet.</p> : null}
        <ul className="mt-2 flex flex-col gap-2">
          {trials.map((t) => (
            <li key={t.id} className={`${CARD_CLASS} p-3 text-sm`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-ink">{t.title}</strong>
                <span className="gh-label text-muted">
                  {t.status}
                  {t.status === "open" ? ` · ${timeLeft(t.closes_at, now)}` : ""}
                </span>
              </div>
              <p className="mt-1 text-gh-xs text-muted">
                {trialKindLine(t)} · {entrantLine(t)} · opens {new Date(t.opens_at).toLocaleString()} · closes{" "}
                {new Date(t.closes_at).toLocaleString()}
              </p>
              <div className="mt-2 flex gap-2">
                {t.status === "scheduled" ? (
                  <button type="button" disabled={busy} onClick={() => void act(t.id, "open")} className={buttonClass("secondary", "sm")}>
                    Open now
                  </button>
                ) : null}
                {t.status !== "closed" ? (
                  <button type="button" disabled={busy} onClick={() => void act(t.id, "close")} className={buttonClass("danger", "sm")}>
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
