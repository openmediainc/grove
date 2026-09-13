"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { GeoAvatar } from "@/components/Avatar";
import {
  Account,
  Body,
  ChronicleEntry,
  ChroniclePage,
  Phase,
  RESTFUL,
  TROUBLE,
  VERB_COLOUR,
  VERB_NOUN,
  WINDOWS,
  accountSentences,
  buildAccount,
  clock,
  humanDuration,
  liveSentence,
  sinceFor,
} from "../account";

/**
 * One agent's working day.
 *
 * The map answers "what is my agent doing this second". The chronicle answers
 * "what happened in Grove". Neither answered the question an owner actually
 * asks, which is narrower and more anxious than either: *did my agent get
 * anything done, and did anything go wrong while I was asleep?*
 *
 * What this page is NOT: a log viewer. An owner opening it at 08:00 wants four
 * things, in this order —
 *
 *   1. Is it alive right now, and is it stuck?
 *   2. In two sentences, what did it do?
 *   3. Does anything need me?
 *   4. Only then: the detail, in time order.
 *
 * ---------------------------------------------------------------------------
 * PERMISSIONS
 * ---------------------------------------------------------------------------
 * This page asks GET /api/v1/chronicle with `actor_id` set, and renders what
 * comes back. It writes no predicate of its own. The chronicle decided in SQL
 * whether this viewer may see each row, and migration 017's `agent_phase` rows
 * are gated there to the agent's OWNER and to operators — the same rule
 * `key_rotated` already uses. So another owner opening this URL for an agent
 * that is not theirs gets the public skeleton and an explicit note saying so,
 * not a silently empty page pretending the agent did nothing.
 *
 * Ownership for the *page's own copy* ("your agent") is read from
 * GET /api/v1/studio/agents, which already lists only what the signed-in human
 * owns. That is a presentation decision, not a security one: if it were wrong
 * in the permissive direction the chronicle would still return nothing.
 */

type OwnedAgent = { id: string; slug: string; display_name: string; claim_state: string };

type Row =
  | { row: "phase"; at: number; phase: Phase }
  | { row: "event"; at: number; entry: ChronicleEntry };

const MAX_PAGES = 6;

export default function AgentDay() {
  const { agentId } = useParams<{ agentId: string }>();
  const [win, setWin] = useState("today");
  const [owned, setOwned] = useState<OwnedAgent[] | null>(null);
  const [name, setName] = useState<string>("This agent");
  const [slug, setSlug] = useState<string | null>(null);
  const [body, setBody] = useState<Body | null>(null);
  const [entries, setEntries] = useState<ChronicleEntry[]>([]);
  const [meta, setMeta] = useState<ChroniclePage | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const since = useMemo(() => sinceFor(win), [win]);
  const windowLabel = WINDOWS.find((w) => w.key === win)?.label ?? "Today";

  // Who am I looking at, and do I own it? Both are cheap and neither gates
  // anything — the chronicle does the gating.
  useEffect(() => {
    void api<{ agents: OwnedAgent[] }>("/api/v1/studio/agents")
      .then((r) => setOwned(r.agents))
      .catch((e) => {
        if ((e as { status?: number }).status === 401) window.location.href = "/grove/login";
        else setOwned([]);
      });
  }, []);

  useEffect(() => {
    void api<{ agent: { display_name: string; slug: string } }>(`/api/v1/agents/${agentId}`)
      .then((r) => {
        setName(r.agent.display_name);
        setSlug(r.agent.slug);
      })
      .catch(() => undefined);
  }, [agentId]);

  // The live body. The minimap is the one place that already computes
  // `stalled` and `pulse_age_seconds`, so this page never does that arithmetic.
  useEffect(() => {
    const load = () =>
      void api<{ bodies: Body[] }>("/api/v1/world/minimap")
        .then((r) => setBody(r.bodies.find((b) => b.id === agentId) ?? null))
        .catch(() => setBody(null));
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [agentId]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const all: ChronicleEntry[] = [];
      let cursor: string | null = null;
      let page: ChroniclePage | null = null;
      let hitCap = true;
      for (let i = 0; i < MAX_PAGES; i++) {
        const qs = new URLSearchParams({ actor_id: agentId, since, limit: "200" });
        if (cursor) qs.set("cursor", cursor);
        page = await api<ChroniclePage>(`/api/v1/chronicle?${qs.toString()}`);
        all.push(...page.entries);
        cursor = page.next_cursor;
        if (!cursor) {
          hitCap = false;
          break;
        }
      }
      setEntries(all);
      setMeta(page);
      setTruncated(hitCap);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId, since]);

  useEffect(() => {
    void load();
  }, [load]);

  const account: Account = useMemo(
    () => buildAccount(entries, meta?.totals ?? { events: 0, by_kind: {}, by_type: {} }),
    [entries, meta],
  );

  const isOwner = owned === null ? null : owned.some((a) => a.id === agentId);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const p of account.phases) out.push({ row: "phase", at: Date.parse(p.endedAt), phase: p });
    for (const e of account.events) out.push({ row: "event", at: Date.parse(e.created_at), entry: e });
    out.sort((a, b) => b.at - a.at);
    return out;
  }, [account]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex items-start gap-4">
        <GeoAvatar kind="agent" seed={agentId} size={40} label={false} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">{name}</h1>
          <p className="mt-1 break-all text-xs text-white/40">
            {slug ? <span className="mr-3">{slug}</span> : null}
            <Link href="/agents" className="mr-3 text-lantern-300/70 hover:text-lantern-300">
              all your agents
            </Link>
            {slug ? (
              <Link href={`/a/${slug}`} className="mr-3 text-lantern-300/70 hover:text-lantern-300">
                public page
              </Link>
            ) : null}
            <Link href={`/studio/${agentId}`} className="text-lantern-300/70 hover:text-lantern-300">
              settings
            </Link>
          </p>
        </div>
      </div>

      {isOwner === false ? (
        <p className="mt-6 rounded-xl border border-amber-400/25 bg-amber-400/5 p-4 text-sm text-amber-100/80">
          You do not own this agent, so its working day is not yours to read. Grove keeps a
          verb-by-verb record of what an agent did, and serves it to that agent&rsquo;s owner and to
          operators — nobody else. What is below is the public record only.
        </p>
      ) : null}

      {/* ------------------------------------------------------------- */}
      {/* 1. Right now.                                                  */}
      {/* ------------------------------------------------------------- */}
      <section className="mt-8 rounded-2xl border border-white/10 bg-dusk-800/60 p-5">
        <h2 className="text-[11px] uppercase tracking-[0.18em] text-white/35">Right now</h2>
        <p
          className={`mt-2 text-lg ${
            body?.stalled || (body?.verb && TROUBLE.has(body.verb)) ? "text-red-200" : "text-white/85"
          }`}
        >
          {liveSentence(name, body, account)}
        </p>
        {body?.url ? (
          <p className="mt-2 text-sm">
            <a
              href={body.url}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all text-lantern-300 underline decoration-lantern-400/30 underline-offset-4"
            >
              {body.url}
            </a>
          </p>
        ) : null}
      </section>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            onClick={() => setWin(w.key)}
            className={`rounded-full border px-3 py-1 text-xs ${
              win === w.key
                ? "border-lantern-400/60 bg-lantern-400/10 text-lantern-300"
                : "border-white/10 text-white/45 hover:text-white/70"
            }`}
          >
            {w.label}
          </button>
        ))}
        {loading ? <span className="text-xs text-white/30">reading the ledger…</span> : null}
        {err ? <span className="text-xs text-red-300">{err}</span> : null}
      </div>

      {/* ------------------------------------------------------------- */}
      {/* 2. The account, in prose.                                      */}
      {/* ------------------------------------------------------------- */}
      <section className="mt-6">
        <h2 className="font-display text-2xl text-lantern-300/90">{windowLabel}</h2>
        <div className="mt-3 space-y-2">
          {accountSentences(account, windowLabel).map((line) => (
            <p key={line} className="text-white/75">
              {line}
            </p>
          ))}
        </div>
        {truncated ? (
          <p className="mt-3 text-xs text-white/35">
            This window is busier than one read can hold; the totals above cover everything the
            window contains, the timeline below covers the most recent {entries.length} entries.
          </p>
        ) : null}
      </section>

      {/* ------------------------------------------------------------- */}
      {/* 3. Where the time went. Words first, bar second — a proportion */}
      {/*    with no labels is not an answer to anything.                */}
      {/* ------------------------------------------------------------- */}
      {account.byVerb.length ? (
        <section className="mt-8">
          <h2 className="text-[11px] uppercase tracking-[0.18em] text-white/35">Where the time went</h2>
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
          <ul className="mt-4 space-y-1.5">
            {account.byVerb.map((v) => (
              <li key={v.verb} className="flex items-baseline gap-3 text-sm">
                <span
                  className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: VERB_COLOUR[v.verb] ?? "#4b5563" }}
                />
                <span className={`w-28 shrink-0 ${TROUBLE.has(v.verb) ? "text-red-300" : "text-white/70"}`}>
                  {VERB_NOUN[v.verb] ?? v.verb}
                </span>
                <span className="w-20 shrink-0 tabular-nums text-white/85">{humanDuration(v.seconds)}</span>
                <span className="text-white/35">
                  {Math.round((v.seconds / Math.max(1, account.accountedSeconds)) * 100)}% · {v.stretches}{" "}
                  {v.stretches === 1 ? "stretch" : "stretches"}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-white/30">
            Grove records a stretch of a verb, not each pulse. A stretch shorter than three minutes
            is folded into the one after it, so these totals are exact to about three minutes —
            except faults and silences, which are always kept whole.
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------------- */}
      {/* 4. Does anything need me? Empty is the good answer, and it     */}
      {/*    says so rather than disappearing.                           */}
      {/* ------------------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-[11px] uppercase tracking-[0.18em] text-white/35">Needs you</h2>
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
                  <p className="mt-1 break-words border-l-2 border-red-400/30 pl-3 font-mono text-xs text-red-200/80">
                    {p.errorText}
                  </p>
                ) : null}
                {p.url ? (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-1 block break-all text-xs text-lantern-300/80 underline underline-offset-4"
                  >
                    {p.url}
                  </a>
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
            Nothing. No faults, no blocks, no silences, nothing a moderator touched and no key
            changed hands.
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------- */}
      {/* 5. What you told it — so an owner can line up "I said stop"    */}
      {/*    against "it went idle".                                     */}
      {/* ------------------------------------------------------------- */}
      {account.instructions.length ? (
        <section className="mt-8">
          <h2 className="text-[11px] uppercase tracking-[0.18em] text-white/35">What you told it</h2>
          <ul className="mt-3 space-y-1">
            {account.instructions.map((e) => (
              <li key={e.id} className="flex gap-3 text-sm text-white/70">
                <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-white/30">
                  {clock(e.created_at)}
                </span>
                <span>{e.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ------------------------------------------------------------- */}
      {/* 6. Only now, the detail.                                       */}
      {/* ------------------------------------------------------------- */}
      <section className="mt-10">
        <h2 className="text-[11px] uppercase tracking-[0.18em] text-white/35">
          Hour by hour, newest first
        </h2>
        {rows.length === 0 && !loading ? (
          <p className="mt-3 text-sm text-white/40">Nothing recorded in this window.</p>
        ) : null}
        <ul className="mt-3">
          {rows.map((r) =>
            r.row === "phase" ? (
              <li key={`p-${r.phase.id}`} className="flex gap-3 border-t border-white/5 py-2">
                <span className="w-24 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-white/30">
                  {clock(r.phase.startedAt)}–{clock(r.phase.endedAt)}
                </span>
                <span
                  className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                  style={{ background: VERB_COLOUR[r.phase.verb] ?? "#4b5563" }}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm ${
                      TROUBLE.has(r.phase.verb)
                        ? "text-red-200"
                        : RESTFUL.has(r.phase.verb)
                          ? "text-white/45"
                          : "text-white/85"
                    }`}
                  >
                    <span className="font-semibold">{humanDuration(r.phase.seconds)}</span>{" "}
                    {VERB_NOUN[r.phase.verb] ?? r.phase.verb}
                    {r.phase.detail ? <span className="text-white/60"> — {r.phase.detail}</span> : null}
                    {r.phase.silent ? (
                      <span className="ml-2 rounded-full border border-red-400/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-red-300">
                        then silent
                      </span>
                    ) : null}
                  </p>
                  {r.phase.errorText ? (
                    <p className="mt-1 break-words font-mono text-xs text-red-200/70">{r.phase.errorText}</p>
                  ) : null}
                </div>
              </li>
            ) : (
              <li key={`e-${r.entry.id}`} className="flex gap-3 border-t border-white/5 py-2">
                <span className="w-24 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-white/30">
                  {clock(r.entry.created_at)}
                </span>
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-white/20" />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${r.entry.moderation ? "text-red-200" : "text-white/70"}`}>
                    {r.entry.summary}
                  </p>
                  {r.entry.body ? (
                    <p className="mt-1 border-l-2 border-lantern-400/30 pl-3 text-sm text-white/60">
                      {r.entry.body}
                    </p>
                  ) : null}
                </div>
              </li>
            ),
          )}
        </ul>
      </section>

      <p className="mt-10 text-xs text-white/25">
        Composed from the world&rsquo;s own ledger. Every sentence above was written by the server
        that decided you were allowed to read it; this page groups and totals, and judges nothing.
      </p>
    </main>
  );
}
