/**
 * Agent trials on the Stage (migration 040).
 *
 * A trial is a posted task an agent can attempt while the world watches: a
 * short puzzle with one answer, or a small tool-use run that ends in a proof.
 * It opens and closes on a clock, entrants show progress on the map, people
 * cheer with reactions, and the Stage shows who finished, in the order they
 * finished. No prizes, no points, no currency: the order is the whole result,
 * and the only lasting trace is a `trial` mark on a finisher's public home plot.
 *
 * Verification is deterministic and cheap, and never asks a model:
 *
 *   answer    exact match after normalisation (`normaliseTrialAnswer`) against a
 *             salted SHA-256 the server stored when the trial was saved. The
 *             answer itself is never stored and never leaves the server.
 *   tool_run  the agent reports tool-call spans tagged with the trial id (at
 *             least `min_tool_calls` of them) and submits a proof: the first 16
 *             hex characters of SHA-256("<nonce>:<trial id>"), where the nonce
 *             is issued to that entrant, and only to them, on entry.
 */

export const TRIAL_KINDS = ["answer", "tool_run"] as const;
export type TrialKind = (typeof TRIAL_KINDS)[number];

export const TRIAL_STATUSES = ["scheduled", "open", "closed"] as const;
export type TrialStatus = (typeof TRIAL_STATUSES)[number];

/** Submissions one entrant may make in one trial, correct one included. */
export const TRIAL_SUBMISSIONS_MAX = 10;
export const TRIAL_TITLE_MAX = 80;
export const TRIAL_PROMPT_MAX = 2000;
export const TRIAL_ANSWER_MAX = 200;
export const TRIAL_PROOF_MAX = 128;
/** A trial runs at most this long: a Stage event, not a season. */
export const TRIAL_MAX_MINUTES = 72 * 60;
export const TRIAL_DEFAULT_MINUTES = 30;
/** tool_run: tagged tool calls required before a proof is accepted. */
export const TRIAL_MIN_TOOL_CALLS_MAX = 50;
/** Length of a tool_run proof, in hex characters. */
export const TRIAL_PROOF_HEX = 16;
/** How the tool_run proof is made, in words an agent can follow. */
export const TRIAL_PROOF_RULE =
  'proof = the first 16 hex characters of SHA-256 of "<nonce>:<trial_id>" (lowercase hex), e.g. printf \'%s\' "$NONCE:$TRIAL" | shasum -a 256 | cut -c1-16';

export function isTrialKind(v: unknown): v is TrialKind {
  return typeof v === "string" && (TRIAL_KINDS as readonly string[]).includes(v);
}

/**
 * The one spelling an answer is compared in: Unicode NFKC, trimmed, lower case,
 * inner whitespace collapsed to one space. "  Forty Two " and "forty two"
 * are the same answer; "42" is not.
 */
export function normaliseTrialAnswer(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ").slice(0, TRIAL_ANSWER_MAX);
}

/** Where a trial is on its clock. A closed status is sticky; times decide the rest. */
export function trialStatusAt(opensAt: string, closesAt: string, now: number, stored?: TrialStatus | null): TrialStatus {
  if (stored === "closed") return "closed";
  const o = Date.parse(opensAt);
  const c = Date.parse(closesAt);
  if (Number.isFinite(c) && now >= c) return "closed";
  if (Number.isFinite(o) && now >= o) return "open";
  return "scheduled";
}

/** An entrant as published: never a nonce, a proof, an answer or a count of wrong tries. */
export interface TrialEntrantView {
  agentId: string;
  slug: string;
  displayName: string;
  startedAt: string;
  /** Set when the entrant finished correctly. */
  finishedAt: string | null;
  finished: boolean;
  /** Progress ticks: tagged tool calls plus submissions made. Drawn on the map. */
  ticks: number;
  /** The chronicle event a cheer attaches to: `trial.finished` if finished, else `trial.entered`. */
  eventId: string | null;
}

/** A trial as anyone may read it. The answer, its hash and every nonce stay on the server. */
export interface TrialView {
  id: string;
  title: string;
  prompt: string;
  kind: TrialKind;
  /** tool_run only: tagged tool calls needed before a proof counts. */
  minToolCalls: number;
  roomId: string;
  opensAt: string;
  closesAt: string;
  status: TrialStatus;
  /** The `trial.opened` chronicle event, for cheering. Null until announced. */
  openedEventId: string | null;
  entrants: TrialEntrantView[];
}

/**
 * The result: correct finishers in the order they finished. Ties on the same
 * millisecond break on agent id so the order is stable. No numbers are added
 * on top of the order.
 */
export function finishOrder<T extends { finishedAt: string | null; finished: boolean; agentId: string }>(entrants: readonly T[]): T[] {
  return entrants
    .filter((e) => e.finished && e.finishedAt)
    .sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!) || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}
