"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { EMPTY_TOTALS, activityQuery } from "@/lib/activity";
import {
  TROUBLE,
  VERB_COLOUR,
  VERB_NOUN,
  accountSentences,
  buildAccount,
  clock,
  humanDuration,
  liveSentence,
  type Body,
  type ChronicleEntry,
  type ChroniclePage,
} from "@/lib/agent-account";

/**
 * The owner's day, above the agent's Activity list: is it alive and stuck, what
 * did it do in two sentences, where the time went, and what needs you.
 *
 * Its rows come from the same GET /api/v1/chronicle as the list below; the
 * `agent_phase` rows it totals are gated in SQL to the owner and operators, so
 * nothing here needs hiding from anyone else — they would receive none.
 * It reads the window in bigger pages than the list so the totals are whole.
 */
const MAX_PAGES = 6;

export function AgentDay({
  agentId,
  name,
  since,
  windowLabel,
}: {
  agentId: string;
  name: string;
  since: string | null;
  windowLabel: string;
}) {
  const [body, setBody] = useState<Body | null>(null);
  const [entries, setEntries] = useState<ChronicleEntry[]>([]);
  const [meta, setMeta] = useState<ChroniclePage | null>(null);
  const [truncated, setTruncated] = useState(false);

  // The live body: the minimap already computes `stalled` and pulse age.
  useEffect(() => {
    const load = () =>
      void api<{ bodies: Body[] }>("/api/v1/world/minimap")
        .then((r) => setBody(r.bodies.find((b) => b.id === agentId) ?? null))
        .catch(() => setBody(null));
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [agentId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const all: ChronicleEntry[] = [];
      let cursor: string | null = null;
      let page: ChroniclePage | null = null;
      let hitCap = true;
      try {
        for (let i = 0; i < MAX_PAGES; i++) {
          page = await api<ChroniclePage>(activityQuery({ since, actorId: agentId, cursor, limit: 200 }));
          all.push(...page.entries);
          cursor = page.next_cursor;
          if (!cursor) {
            hitCap = false;
            break;
          }
        }
      } catch {
        /* the list below shows the error; the summary just stays quiet */
      }
      if (!alive) return;
      setEntries(all);
      setMeta(page);
      setTruncated(hitCap && Boolean(page));
    })();
    return () => {
      alive = false;
    };
  }, [agentId, since]);

  const account = useMemo(() => buildAccount(entries, meta?.totals ?? EMPTY_TOTALS), [entries, meta]);

  return (
    <div className="mt-6 space-y-6">
      <section className="rounded-2xl border border-white/10 bg-dusk-800/60 p-4 sm:p-5">
        <h3 className="text-[11px] uppercase tracking-[0.18em] text-white/35">Right now</h3>
        <p
          className={`mt-2 break-words text-base sm:text-lg ${
            body?.stalled || (body?.verb && TROUBLE.has(body.verb)) ? "text-red-200" : "text-white/85"
          }`}
        >
          {liveSentence(name, body, account)}
        </p>
        {body?.url ? (
          <a
            href={body.url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 block break-all text-sm text-lantern-300 underline decoration-lantern-400/30 underline-offset-4"
          >
            {body.url}
          </a>
        ) : null}
      </section>

      <section>
        <h3 className="font-display text-2xl text-lantern-300/90">{windowLabel}</h3>
        <div className="mt-2 space-y-2">
          {meta
            ? accountSentences(account, windowLabel).map((line) => (
                <p key={line} className="text-white/75">
                  {line}
                </p>
              ))
            : <p className="text-sm text-white/40">Adding up the day…</p>}
        </div>
        {truncated ? (
          <p className="mt-2 text-xs text-white/35">
            This window is busier than one read can hold; the totals cover the whole window, the
            breakdown the most recent {entries.length} entries.
          </p>
        ) : null}
      </section>

      {account.byVerb.length ? (
        <section>
          <h3 className="text-[11px] uppercase tracking-[0.18em] text-white/35">Where the time went</h3>
          <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full border border-white/10">
            {account.byVerb.map((v) => (
              <span
                key={v.verb}
                title={`${VERB_NOUN[v.verb] ?? v.verb} — ${humanDuration(v.seconds)}`}
                style={{
                  width: `${(v.seconds / Math.max(1, account.accountedSeconds)) * 100}%`,
                  background: VERB_COLOUR[v.verb] ?? "#4b5563",
                }}
              />
            ))}
          </div>
          <ul className="mt-3 space-y-1.5">
            {account.byVerb.map((v) => (
              <li key={v.verb} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: VERB_COLOUR[v.verb] ?? "#4b5563" }} />
                <span className={`w-28 shrink-0 ${TROUBLE.has(v.verb) ? "text-red-300" : "text-white/70"}`}>
                  {VERB_NOUN[v.verb] ?? v.verb}
                </span>
                <span className="w-16 shrink-0 tabular-nums text-white/85">{humanDuration(v.seconds)}</span>
                <span className="text-white/35">
                  {Math.round((v.seconds / Math.max(1, account.accountedSeconds)) * 100)}% · {v.stretches}{" "}
                  {v.stretches === 1 ? "stretch" : "stretches"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3 className="text-[11px] uppercase tracking-[0.18em] text-white/35">Needs you</h3>
        {account.trouble.length || account.alarming.length ? (
          <ul className="mt-3 space-y-2">
            {account.trouble.map((p) => (
              <li key={`t-${p.id}`} className="rounded-xl border border-red-400/25 bg-red-400/5 p-3">
                <p className="text-sm text-red-200">
                  {p.verb === "error"
                    ? `Faulted for ${humanDuration(p.seconds)}`
                    : p.verb === "blocked"
                      ? `Blocked for ${humanDuration(p.seconds)}`
                      : `Claimed ${VERB_NOUN[p.verb] ?? p.verb} for ${humanDuration(p.seconds)}, then went silent`}
                  <span className="ml-2 font-mono text-[11px] text-white/35">
                    {clock(p.startedAt)}–{clock(p.endedAt)}
                  </span>
                </p>
                {p.detail ? <p className="mt-1 text-sm text-white/70">{p.detail}</p> : null}
                {p.errorText ? (
                  <p className="mt-1 break-words border-l-2 border-red-400/30 pl-3 font-mono text-xs text-red-200/80">{p.errorText}</p>
                ) : null}
              </li>
            ))}
            {account.alarming.map((e) => (
              <li key={`a-${e.id}`} className="rounded-xl border border-red-400/25 bg-red-400/5 p-3">
                <p className="text-sm text-red-200">
                  {e.summary}
                  <span className="ml-2 font-mono text-[11px] text-white/35">{clock(e.created_at)}</span>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-xl border border-white/10 bg-dusk-800/40 p-3 text-sm text-white/50">
            Nothing. No faults, no blocks, no silences, nothing a moderator touched and no key changed hands.
          </p>
        )}
      </section>

      {account.instructions.length ? (
        <section>
          <h3 className="text-[11px] uppercase tracking-[0.18em] text-white/35">What you told it</h3>
          <ul className="mt-3 space-y-1">
            {account.instructions.map((e) => (
              <li key={e.id} className="flex gap-3 text-sm text-white/70">
                <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-white/30">{clock(e.created_at)}</span>
                <span className="min-w-0 break-words">{e.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <h3 className="pt-2 text-[11px] uppercase tracking-[0.18em] text-white/35">Everything, newest first</h3>
    </div>
  );
}
