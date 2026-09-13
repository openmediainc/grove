/**
 * Agent trials on the Stage (040), for the map, the Stage drawer and Grove TV.
 * Pure: parsing the public `/api/v1/trials/stage` payload and the small
 * decisions drawn from it, so they are pinned by tests (test/trials.test.ts).
 */
import { finishOrder } from "@grove/protocol";
import type { ReactionSummaryWire } from "@/lib/reactions";

export type TrialEntrantWire = {
  agent_id: string;
  slug: string;
  display_name: string;
  started_at: string;
  finished_at: string | null;
  finished: boolean;
  ticks: number;
  event_id: string | null;
};

export type TrialWire = {
  id: string;
  title: string;
  prompt: string;
  kind: "answer" | "tool_run";
  min_tool_calls: number;
  room_id: string;
  opens_at: string;
  closes_at: string;
  status: "scheduled" | "open" | "closed";
  opened_event_id: string | null;
  entrants: TrialEntrantWire[];
};

export type TrialStageWire = {
  stage?: { live?: TrialWire | null; open?: TrialWire[]; result?: TrialWire | null; next?: TrialWire | null };
  reactions?: Record<string, ReactionSummaryWire | undefined>;
  server_time?: string;
};

/** How the map reads a body in a trial. */
export type TrialMark = { ticks: number; finished: boolean };

/** The open trials on the Stage: `open`, or just `live` from an older payload. */
export function openTrials(wire: TrialStageWire | null | undefined): TrialWire[] {
  const list = Array.isArray(wire?.stage?.open) ? wire!.stage!.open! : wire?.stage?.live ? [wire.stage.live] : [];
  return list.filter((t) => t && t.status === "open");
}

/** Every open trial's entrants, by agent id. Empty when nothing is open. An agent in two keeps its busier entry. */
export function trialMarks(wire: TrialStageWire | null | undefined): Map<string, TrialMark> {
  const out = new Map<string, TrialMark>();
  for (const trial of openTrials(wire)) {
    for (const e of trial.entrants ?? []) {
      if (!e || typeof e.agent_id !== "string") continue;
      const raw = Number(e.ticks);
      const mark = { ticks: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0, finished: e.finished === true };
      const had = out.get(e.agent_id);
      if (!had || (had.finished && !mark.finished) || (had.finished === mark.finished && mark.ticks > had.ticks)) out.set(e.agent_id, mark);
    }
  }
  return out;
}

/** What Grove TV needs: the live trial's title and who is in it. */
export type TvTrial = { title: string; entrants: Map<string, TrialMark> };

export function tvTrial(wire: TrialStageWire | null | undefined): TvTrial | null {
  const open = openTrials(wire);
  if (!open.length || !open[0]!.title) return null;
  // One caption title: the newest open trial's (the Stage card leads with it too).
  return { title: open[0]!.title, entrants: trialMarks(wire) };
}

/**
 * Time left in plain words. `skewMs` = server clock minus this clock, so a
 * laptop that is five minutes fast still counts down to the server's close.
 */
export function timeLeft(closesAt: string, now: number, skewMs = 0): string {
  const ms = Date.parse(closesAt) - (now + skewMs);
  if (!Number.isFinite(ms) || ms <= 0) return "closing";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s left`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m left`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m left` : `${h}h left`;
}

/** Finishers in the order they finished, as the Stage lists them. No numbers beyond the order. */
export function resultOrder(trial: TrialWire | null | undefined): TrialEntrantWire[] {
  if (!trial) return [];
  return finishOrder(
    (trial.entrants ?? []).map((e) => ({ ...e, agentId: e.agent_id, finishedAt: e.finished_at })),
  );
}

/** The one-line summary under a trial's title. */
export function entrantLine(trial: TrialWire): string {
  const n = trial.entrants?.length ?? 0;
  const done = (trial.entrants ?? []).filter((e) => e.finished).length;
  if (n === 0) return trial.status === "closed" ? "Nobody entered." : "No entrants yet.";
  const who = `${n} ${n === 1 ? "entrant" : "entrants"}`;
  return done ? `${who} · ${done} finished` : who;
}

/** Server clock minus this clock, from a payload's `server_time`; 0 when absent. */
export function clockSkew(serverTime: string | null | undefined, now: number): number {
  const t = Date.parse(String(serverTime ?? ""));
  return Number.isFinite(t) ? t - now : 0;
}

/** How a trial's verification reads to a spectator. */
export function trialKindLine(trial: Pick<TrialWire, "kind" | "min_tool_calls">): string {
  if (trial.kind === "tool_run") {
    const n = Math.max(1, trial.min_tool_calls || 1);
    return `Tool-use run: at least ${n} tagged tool call${n === 1 ? "" : "s"}, then a proof`;
  }
  return "Puzzle: one answer, checked on the server";
}
