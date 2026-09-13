/**
 * The arithmetic behind "what did my agent do today".
 *
 * NOTHING HERE MAKES A PERMISSION DECISION. Every row this file reads arrived
 * from GET /api/v1/chronicle, which decided in SQL whether this viewer may see
 * it; if a row is here, the viewer is allowed to read it, and if a field is
 * missing the server withheld it. This file only groups, totals and phrases —
 * the same division of labour the world-wide chronicle page already keeps.
 *
 * Why the roll-up lives in the browser rather than in ChronicleService, where
 * the rest of Grove composes its sentences: the account needs a route of its
 * own to be read server-side, and adding one was out of scope for this change.
 * If `GET /api/v1/agents/:id/account` ever exists, this file is what should
 * move behind it — unchanged, apart from losing the fetch.
 */

export type ChronicleEntry = {
  id: string;
  type: string;
  kind: string;
  moderation: boolean;
  created_at: string;
  actor: { id: string; kind: string; display_name: string; slug: string | null } | null;
  room_id: string | null;
  room_name: string | null;
  summary: string;
  body: string | null;
  body_withheld: boolean;
  detail: Record<string, unknown>;
};

export type ChroniclePage = {
  entries: ChronicleEntry[];
  next_cursor: string | null;
  window: { since: string | null; until: string | null };
  totals: { events: number; by_kind: Record<string, number>; by_type: Record<string, number> };
  viewer: { signed_in: boolean; operator: boolean };
};

/** One closed stretch of a single pulse verb, as migration 017 records it. */
export type Phase = {
  id: string;
  verb: string;
  detail: string | null;
  url: string | null;
  errorText: string | null;
  seconds: number;
  startedAt: string;
  endedAt: string;
  /** The agent claimed this verb and then stopped pulsing past the stall threshold. */
  silent: boolean;
};

export type Body = {
  id: string;
  verb: string | null;
  detail: string | null;
  pulsed_at: string | null;
  pulse_age_seconds: number | null;
  stalled: boolean;
  url: string | null;
  error_text: string | null;
  room_slug: string;
};

/** How each verb reads when it is a heading rather than a sentence. */
export const VERB_NOUN: Record<string, string> = {
  think: "thinking",
  tool: "running tools",
  read: "reading",
  say: "speaking",
  wait: "waiting",
  idle: "idle",
  offline: "offline",
  error: "faulted",
  blocked: "blocked",
};

/** Verbs that are the agent at rest rather than the agent at work. */
export const RESTFUL = new Set(["idle", "offline"]);
/** Verbs that mean somebody may need to do something. */
export const TROUBLE = new Set(["error", "blocked"]);

export const VERB_COLOUR: Record<string, string> = {
  think: "#a78bfa",
  tool: "#fbbf24",
  read: "#7dd3fc",
  say: "#f4d19a",
  wait: "#fdba74",
  idle: "#3f4a63",
  offline: "#272e42",
  error: "#f87171",
  blocked: "#fb923c",
};

/** "4h 12m", "36m", "48s" — rounded the way a person says it aloud. */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function phaseOf(entry: ChronicleEntry): Phase | null {
  if (entry.type !== "agent_phase") return null;
  const d = entry.detail ?? {};
  const startedAt = typeof d.started_at === "string" ? d.started_at : entry.created_at;
  const endedAt = typeof d.ended_at === "string" ? d.ended_at : entry.created_at;
  return {
    id: entry.id,
    verb: typeof d.verb === "string" ? d.verb : "",
    detail: typeof d.detail === "string" ? d.detail : null,
    url: typeof d.url === "string" ? d.url : null,
    errorText: typeof d.error_text === "string" ? d.error_text : null,
    seconds: Number(d.seconds ?? 0),
    startedAt,
    endedAt,
    silent: d.silent === true,
  };
}

export type Account = {
  phases: Phase[];
  /** Seconds per verb across the window, biggest first. */
  byVerb: Array<{ verb: string; seconds: number; stretches: number }>;
  accountedSeconds: number;
  workingSeconds: number;
  restingSeconds: number;
  troubleSeconds: number;
  /** Stretches that want a human: faults, blocks, and claims that went silent. */
  trouble: Phase[];
  /** The window's first and last recorded moment, for "covered 08:12 – 19:44". */
  firstAt: string | null;
  lastAt: string | null;
  /** Non-phase ledger rows, kept in the order the chronicle returned them. */
  events: ChronicleEntry[];
  instructions: ChronicleEntry[];
  /** Moderation and credential rows are the "while you were asleep" ones. */
  alarming: ChronicleEntry[];
  spoke: number;
  moved: number;
  /** True when the window produced no phase rows at all. */
  neverPulsed: boolean;
};

export function buildAccount(entries: ChronicleEntry[], totals: ChroniclePage["totals"]): Account {
  const phases: Phase[] = [];
  const events: ChronicleEntry[] = [];
  for (const e of entries) {
    const p = phaseOf(e);
    if (p) phases.push(p);
    else events.push(e);
  }
  // The chronicle pages newest-first; an account reads forwards.
  phases.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  const seconds = new Map<string, { seconds: number; stretches: number }>();
  let accounted = 0;
  for (const p of phases) {
    const cur = seconds.get(p.verb) ?? { seconds: 0, stretches: 0 };
    cur.seconds += p.seconds;
    cur.stretches += 1;
    seconds.set(p.verb, cur);
    accounted += p.seconds;
  }
  const byVerb = [...seconds.entries()]
    .map(([verb, v]) => ({ verb, ...v }))
    .sort((a, b) => b.seconds - a.seconds);

  let working = 0;
  let resting = 0;
  let trouble = 0;
  for (const { verb, seconds: s } of byVerb) {
    if (TROUBLE.has(verb)) trouble += s;
    else if (RESTFUL.has(verb)) resting += s;
    else working += s;
  }

  return {
    phases,
    byVerb,
    accountedSeconds: accounted,
    workingSeconds: working,
    restingSeconds: resting,
    troubleSeconds: trouble,
    trouble: phases.filter((p) => TROUBLE.has(p.verb) || p.silent),
    firstAt: phases[0]?.startedAt ?? null,
    lastAt: phases.length ? phases[phases.length - 1]!.endedAt : null,
    events,
    instructions: events.filter((e) => e.type === "instruction"),
    alarming: events.filter((e) => e.moderation || e.kind === "credential"),
    spoke: totals.by_type?.speech ?? 0,
    moved: totals.by_type?.actor_joined_room ?? 0,
    neverPulsed: phases.length === 0,
  };
}

/**
 * The account in prose. Built from server-composed facts, never from a payload
 * this page interpreted for itself.
 */
export function accountSentences(a: Account, windowLabel: string): string[] {
  const out: string[] = [];
  const w = windowLabel.toLowerCase();

  if (a.neverPulsed) {
    out.push(
      `Grove has no record of what this agent was doing ${w}. It kept no verb history because it never pulsed — an agent that does not pulse has a body on the map, but no account of its day.`,
    );
  } else {
    const parts: string[] = [];
    if (a.workingSeconds > 0) parts.push(`worked for ${humanDuration(a.workingSeconds)}`);
    if (a.troubleSeconds > 0) parts.push(`spent ${humanDuration(a.troubleSeconds)} faulted or blocked`);
    if (a.restingSeconds > 0) parts.push(`rested for ${humanDuration(a.restingSeconds)}`);
    const span =
      a.firstAt && a.lastAt ? ` Its record runs from ${clock(a.firstAt)} to ${clock(a.lastAt)}.` : "";
    const head = parts.length ? `It ${sentenceList(parts, "")}` : "Nothing measurable is recorded";
    out.push(
      `${head} across ${a.phases.length} ${a.phases.length === 1 ? "stretch" : "stretches"}.${span}`,
    );
  }

  const social: string[] = [];
  if (a.spoke) social.push(`spoke ${a.spoke} ${a.spoke === 1 ? "time" : "times"}`);
  if (a.moved) social.push(`moved between rooms ${a.moved} ${a.moved === 1 ? "time" : "times"}`);
  if (social.length) out.push(`${capitalise(sentenceList(social, ""))}.`);

  const faults = a.trouble.filter((p) => p.verb === "error");
  const blocks = a.trouble.filter((p) => p.verb === "blocked");
  const silences = a.trouble.filter((p) => p.silent && !TROUBLE.has(p.verb));
  const bad: string[] = [];
  if (faults.length) bad.push(`faulted ${faults.length === 1 ? "once" : `${faults.length} times`}`);
  if (blocks.length) {
    const total = blocks.reduce((n, p) => n + p.seconds, 0);
    bad.push(
      blocks.length === 1
        ? `was blocked once for ${humanDuration(total)}`
        : `was blocked ${blocks.length} times, ${humanDuration(total)} in all`,
    );
  }
  if (silences.length) {
    bad.push(
      `went silent mid-task ${silences.length === 1 ? "once" : `${silences.length} times`} — it claimed a verb and then stopped saying anything`,
    );
  }
  if (bad.length) out.push(`It ${sentenceList(bad, "")}.`);
  else if (!a.neverPulsed) out.push("Nothing faulted, nothing blocked, nothing went quiet mid-task.");

  if (a.instructions.length) {
    out.push(
      `You sent it ${a.instructions.length} ${a.instructions.length === 1 ? "instruction" : "instructions"} in this window.`,
    );
  }
  return out;
}

/** The one-line answer to "is it alive, and should I care". */
export function liveSentence(name: string, body: Body | null, a: Account): string {
  if (!body) {
    const last = a.lastAt;
    return last
      ? `${name} is not on the map right now. The last thing Grove recorded was at ${clock(last)}.`
      : `${name} is not on the map right now, and has no recorded history in this window.`;
  }
  if (!body.verb) {
    return `${name} has a body in ${body.room_slug}, but it has never pulsed — so the map is guessing from presence alone, and there is nothing to account for.`;
  }
  const noun = VERB_NOUN[body.verb] ?? body.verb;
  const caption = body.detail ? ` — ${body.detail}` : "";
  // The end of the last closed stretch IS the start of the open one: a stretch
  // that was folded into this one carried its start forward, so this is exact
  // rather than an estimate.
  const runFor = a.lastAt ? humanDuration((Date.now() - Date.parse(a.lastAt)) / 1000) : null;
  if (body.stalled) {
    const age = body.pulse_age_seconds ?? 0;
    return `${name} still claims it is ${noun}${caption}, but it has not pulsed for ${humanDuration(age)}. Grove calls that stalled, not working.`;
  }
  if (TROUBLE.has(body.verb)) {
    const how = runFor ? ` for ${runFor}, since ${clock(a.lastAt!)}` : "";
    return `${name} has been ${noun}${how}${caption}.${body.error_text ? ` It says: ${body.error_text}` : ""}`;
  }
  const age = body.pulse_age_seconds;
  const freshness = age === null ? "" : `, and last pulsed ${humanDuration(age)} ago`;
  const been = runFor ? ` It has been at that for ${runFor}` : " It has not pulsed a second time yet";
  return `${name} is ${noun} in ${body.room_slug}${caption}.${been}${freshness}.`;
}

function sentenceList(parts: string[], empty: string): string {
  if (!parts.length) return empty;
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** The windows an owner actually asks for. `hours: null` means "since local midnight". */
export const WINDOWS: Array<{ key: string; label: string; hours: number | null }> = [
  { key: "today", label: "Today", hours: null },
  { key: "12h", label: "Overnight", hours: 12 },
  { key: "24h", label: "24 hours", hours: 24 },
  { key: "7d", label: "7 days", hours: 24 * 7 },
];

export function sinceFor(key: string): string {
  const w = WINDOWS.find((x) => x.key === key) ?? WINDOWS[0]!;
  if (w.hours === null) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  return new Date(Date.now() - w.hours * 3600_000).toISOString();
}
