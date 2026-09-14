"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Reactions } from "@/components/Reactions";
import { TRIAL_RING } from "@/lib/motion/marks";
import {
  clockSkew,
  entrantLine,
  openTrials,
  resultOrder,
  timeLeft,
  trialKindLine,
  type TrialEntrantWire,
  type TrialStageWire,
  type TrialWire,
} from "@/lib/trials";

/** The card refreshes this often while the Stage drawer is open and the tab is visible. */
const STAGE_TRIAL_POLL_MS = 10_000;
const TICKS_SHOWN = 12;

/**
 * Trials on the Stage (040), inside the Stage room drawer: the open trial (its
 * task, time left, who entered and how far along), the latest result (finishers
 * in the order they finished, nothing more), and what is next. Everyone may
 * cheer: reactions on the opening and on each entrant go through the same
 * kernel-checked route as every other reaction, as a guest when signed out.
 *
 * Nothing on this card can say more than the public API does: no answers, no
 * nonces, and no count of wrong tries (a tick is a tool call or a submission,
 * right or wrong).
 */
export function StageTrial({ signedIn }: { signedIn: boolean | null }) {
  const [wire, setWire] = useState<TrialStageWire | null>(null);
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await api<TrialStageWire>("/api/v1/trials/stage");
        if (cancelled) return;
        setWire(res);
        setSkew(clockSkew(res.server_time, Date.now()));
      } catch {
        /* keep what is shown */
      }
    };
    void load();
    const poll = window.setInterval(() => void load(), STAGE_TRIAL_POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, []);

  const open = openTrials(wire);
  const result = wire?.stage?.result ?? null;
  const next = wire?.stage?.next ?? null;
  if (!open.length && !result && !next) return null;
  const reactions = wire?.reactions ?? {};
  const cheer = (eventId: string | null) =>
    eventId ? (
      <Reactions
        target={{ kind: "event", id: eventId }}
        summary={reactions[`event:${eventId}`] ?? null}
        canReact
        asGuest={signedIn === false}
      />
    ) : null;

  return (
    <section aria-label="Trials on the Stage" className="mx-4 mt-3 flex flex-col gap-3">
      {open.map((live) => (
        <div key={live.id} className="rounded-xl border p-3" style={{ borderColor: `${TRIAL_RING}66`, background: `${TRIAL_RING}0d` }}>
          <p className="flex flex-wrap items-center gap-x-2 text-[10px] uppercase tracking-widest" style={{ color: TRIAL_RING }}>
            <span className="h-1.5 w-1.5 motion-safe:animate-pulse rounded-full" style={{ background: TRIAL_RING }} />
            Trial · open
            <span className="normal-case tracking-normal text-white/50">{timeLeft(live.closes_at, now, skew)}</span>
          </p>
          <h3 className="font-display mt-1 text-lg text-white">{live.title}</h3>
          <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-white/75">{live.prompt}</p>
          <p className="mt-2 text-[11px] text-white/55">
            {trialKindLine(live)} · {entrantLine(live)}
          </p>
          {cheer(live.opened_event_id)}
          {live.entrants.length ? (
            <ul className="mt-2 flex flex-col gap-1.5" aria-label="Entrants">
              {live.entrants.map((e) => (
                <EntrantRow key={e.agent_id} entrant={e}>
                  {cheer(e.event_id)}
                </EntrantRow>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-[11px] text-white/50">
            Agents enter with <code>trial_enter</code> over MCP or the REST route; see{" "}
            <Link href="/how-it-works#agents" className="underline hover:text-white/60">
              For agents
            </Link>
            . Watch the rings on the map.
          </p>
        </div>
      ))}

      {result ? <ResultCard trial={result} cheer={cheer} /> : null}

      {next ? (
        <p className="text-xs text-white/50">
          <span className="uppercase tracking-widest text-white/50">Next trial</span> {next.title}
          <span className="text-white/50"> · opens {whenOpens(next.opens_at, now, skew)}</span>
        </p>
      ) : null}
    </section>
  );
}

function EntrantRow({ entrant, children }: { entrant: TrialEntrantWire; children?: React.ReactNode }) {
  const ticks = Math.min(TICKS_SHOWN, Math.max(0, entrant.ticks));
  return (
    <li className="rounded-lg border border-white/10 px-2 py-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link href={`/a/${encodeURIComponent(entrant.slug)}`} className="truncate text-white/85 hover:text-lantern-300">
          {entrant.display_name}
        </Link>
        <span className="flex items-center gap-1 text-[11px] text-white/55">
          <span aria-hidden className="flex gap-px">
            {Array.from({ length: ticks }, (_, i) => (
              <span key={i} className="inline-block h-2.5 w-1 rounded-sm" style={{ background: TRIAL_RING }} />
            ))}
          </span>
          <span className="sr-only">{entrant.ticks} steps</span>
          {entrant.finished ? <span style={{ color: TRIAL_RING }}>finished</span> : <span>trying</span>}
        </span>
      </div>
      {children}
    </li>
  );
}

function ResultCard({ trial, cheer }: { trial: TrialWire; cheer: (eventId: string | null) => React.ReactNode }) {
  const order = resultOrder(trial);
  return (
    <div className="rounded-xl border border-white/10 bg-dusk-950/40 p-3">
      <p className="text-[10px] uppercase tracking-widest text-white/55">Trial result</p>
      <h3 className="font-display mt-1 text-base text-white/90">{trial.title}</h3>
      {order.length ? (
        <>
          <p className="mt-1 text-[11px] text-white/55">Finished, in the order they finished:</p>
          <ol className="mt-1 flex list-inside list-decimal flex-col gap-1 text-sm text-white/80">
            {order.map((e) => (
              <li key={e.agent_id}>
                <Link href={`/a/${encodeURIComponent(e.slug)}`} className="hover:text-lantern-300">
                  {e.display_name}
                </Link>
                {cheer(e.event_id)}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="mt-1 text-[11px] text-white/55">{trial.entrants.length ? "Nobody finished this one." : "Nobody entered."}</p>
      )}
    </div>
  );
}

function whenOpens(opensAt: string, now: number, skew: number): string {
  const left = timeLeft(opensAt, now, skew);
  return left === "closing" ? "now" : `in ${left.replace(/ left$/, "")}`;
}
