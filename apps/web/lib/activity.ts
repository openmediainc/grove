/**
 * Activity: the world_events ledger read back through GET /api/v1/chronicle.
 *
 * Pure, so the grouping, the windows and the URL filters can be tested without
 * a browser. `components/Activity.tsx` is the one component that renders it
 * (the agent page, /chronicle, and next the space page and the History drawer).
 *
 * NOTHING HERE DECIDES WHO MAY SEE WHAT. The chronicle decided in SQL whether
 * each row reaches this viewer and withheld any body they may not read; this
 * file groups, labels and builds query strings.
 */
import { ACTOR_PARAM } from "./chronicle-link";
import type { ReactionSummaryWire, ReactionTargetWire } from "./reactions";

export { ACTOR_PARAM };

export type ActivityActor = { id: string; kind: string; display_name: string; slug: string | null };

export type ActivityEntry = {
  id: string;
  type: string;
  kind: string;
  moderation: boolean;
  created_at: string;
  actor: ActivityActor | null;
  world_id?: string;
  room_id: string | null;
  room_name: string | null;
  summary: string;
  body: string | null;
  body_withheld: boolean;
  detail: Record<string, unknown>;
  /** Null when the row takes no reactions (or its line is not yours to read). */
  reaction_target?: ReactionTargetWire | null;
  reactions?: ReactionSummaryWire | null;
};

export type ActivityTotals = { events: number; by_kind: Record<string, number>; by_type: Record<string, number> };

export type ActivityPage = {
  entries: ActivityEntry[];
  next_cursor: string | null;
  window: { since: string | null; until: string | null };
  totals: ActivityTotals;
  viewer: { signed_in: boolean; operator: boolean };
  vocabulary?: { types: string[]; kinds: string[] };
};

export const EMPTY_TOTALS: ActivityTotals = { events: 0, by_kind: {}, by_type: {} };

/** `hours: null` with key "today" is local midnight; with key "all", no lower bound. */
export const ACTIVITY_WINDOWS = [
  { key: "today", label: "Today", hours: null },
  { key: "1h", label: "Last hour", hours: 1 },
  { key: "12h", label: "Overnight", hours: 12 },
  { key: "24h", label: "24 hours", hours: 24 },
  { key: "7d", label: "7 days", hours: 24 * 7 },
  { key: "all", label: "Everything", hours: null },
] as const;

export type WindowKey = (typeof ACTIVITY_WINDOWS)[number]["key"];

export function isWindowKey(v: unknown): v is WindowKey {
  return ACTIVITY_WINDOWS.some((w) => w.key === v);
}

export function windowLabel(key: WindowKey): string {
  return ACTIVITY_WINDOWS.find((w) => w.key === key)?.label ?? "24 hours";
}

/** The ISO lower bound for a window, or null for "Everything". */
export function activitySince(key: WindowKey, now: Date = new Date()): string | null {
  if (key === "all") return null;
  if (key === "today") {
    const d = new Date(now.getTime());
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const w = ACTIVITY_WINDOWS.find((x) => x.key === key);
  return new Date(now.getTime() - (w?.hours ?? 24) * 3600_000).toISOString();
}

/**
 * Reading order: comings and goings first, consequences last. Must stay a
 * superset of the server's CHRONICLE_KINDS, or a kind gets no chip.
 */
export const KIND_ORDER = [
  "arrival",
  "claim",
  "movement",
  "work",
  "speech",
  "notice",
  "permission",
  "instruction",
  "credential",
  "moderation",
  "trial",
  "other",
];

export type KindCopy = { label: string; plural: (n: number) => string; tint: string };

const KIND_COPY: Record<string, KindCopy> = {
  arrival: { label: "arrivals", plural: (n) => `${n} arrived`, tint: "border-lantern-400/40 text-lantern-300" },
  claim: { label: "claims", plural: (n) => `${n} agents found an owner`, tint: "border-lantern-400/30 text-lantern-300/90" },
  movement: { label: "movement", plural: (n) => `${n} moves between rooms`, tint: "border-white/15 text-white/50" },
  // Phase history: only the agent's owner and operators ever receive these rows.
  work: { label: "work", plural: (n) => `${n} stretches of agent work`, tint: "border-violet-400/20 text-violet-200/80" },
  speech: { label: "talk", plural: (n) => `${n} lines spoken`, tint: "border-sky-400/30 text-sky-200" },
  notice: { label: "notices", plural: (n) => `${n} notices posted`, tint: "border-sky-400/30 text-sky-200" },
  permission: { label: "permissions", plural: (n) => `${n} permission changes`, tint: "border-violet-400/30 text-violet-200" },
  instruction: { label: "instructions", plural: (n) => `${n} instructions sent`, tint: "border-violet-400/30 text-violet-200" },
  credential: { label: "keys", plural: (n) => `${n} key changes`, tint: "border-amber-400/30 text-amber-200" },
  moderation: { label: "moderation", plural: (n) => `${n} moderation events`, tint: "border-red-400/40 text-red-300" },
  // Trials on the Stage (040): public commons events, and ones people cheer on.
  trial: { label: "trials", plural: (n) => `${n} trial moments on the Stage`, tint: "border-teal-400/40 text-teal-200" },
  other: { label: "other", plural: (n) => `${n} other events`, tint: "border-white/15 text-white/50" },
};

export function kindCopy(kind: string): KindCopy {
  return KIND_COPY[kind] ?? { label: kind, plural: (n) => `${n} ${kind} events`, tint: "border-white/15 text-white/50" };
}

/** Kinds that arrive in floods and say little one at a time; three or more in a row fold. */
export const COLLAPSIBLE = new Set(["movement", "arrival", "claim", "work"]);
export const RUN_MIN = 3;

export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const yesterday = new Date(now.getTime() - 86400_000);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The allow-listed payload, as chips. Never a JSON dump. */
export function detailChips(entry: Pick<ActivityEntry, "detail">): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(entry.detail ?? {})) {
    if (v === null || v === undefined) continue;
    if (k === "policy" && typeof v === "object") {
      const granted = Object.entries(v as Record<string, unknown>)
        .filter(([, on]) => on === true)
        .map(([cap]) => cap.replace(/_/g, " "));
      out.push(granted.length ? `may ${granted.join(", ")}` : "may do nothing");
      continue;
    }
    if (typeof v === "object") continue;
    if (k === "seat" || k === "channel" || k === "kind") continue; // already in the sentence
    out.push(`${k.replace(/_/g, " ")}: ${String(v)}`);
  }
  return out;
}

export type ActivityBlock =
  | { block: "day"; key: string; label: string }
  | { block: "run"; key: string; kind: string; entries: ActivityEntry[] }
  | { block: "one"; key: string; entry: ActivityEntry };

/** Day headings, and runs of RUN_MIN+ same-kind collapsible rows folded into one line. */
export function groupActivity(entries: ActivityEntry[], now: Date = new Date()): ActivityBlock[] {
  const out: ActivityBlock[] = [];
  let day = "";
  let run: ActivityEntry[] = [];
  const flush = () => {
    const head = run[0];
    if (!head) return;
    if (run.length >= RUN_MIN) out.push({ block: "run", key: `run-${head.id}`, kind: head.kind, entries: run });
    else for (const e of run) out.push({ block: "one", key: e.id, entry: e });
    run = [];
  };
  for (const e of entries) {
    const d = new Date(e.created_at).toDateString();
    if (d !== day) {
      flush();
      day = d;
      out.push({ block: "day", key: `day-${d}`, label: dayLabel(e.created_at, now) });
    }
    if (COLLAPSIBLE.has(e.kind)) {
      const head = run[0];
      if (head && head.kind !== e.kind) flush();
      run.push(e);
    } else {
      flush();
      out.push({ block: "one", key: e.id, entry: e });
    }
  }
  flush();
  return out;
}

/** What the filter bar holds. `actor` is the shareable `@handle` / slug / id ref. */
export type ActivityFilters = { win: WindowKey; kinds: string[]; actor: string | null };

export const WIN_PARAM = "win";
export const KINDS_PARAM = "kinds";

/** Filters off a query string. Unknown windows and blank values fall back to the defaults. */
export function readActivityFilters(search: string, defaults: { win: WindowKey }): ActivityFilters {
  const qs = new URLSearchParams(search);
  const win = qs.get(WIN_PARAM);
  const kinds = (qs.get(KINDS_PARAM) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => KIND_ORDER.includes(s));
  const actor = qs.get(ACTOR_PARAM)?.trim() || null;
  return { win: isWindowKey(win) ? win : defaults.win, kinds: [...new Set(kinds)], actor };
}

/**
 * The query string with the filters written in, every other param kept. A
 * default window is left out so a plain link stays plain. `withActor: false`
 * leaves `actor` alone (a page whose actor is fixed never writes one).
 */
export function writeActivityFilters(
  search: string,
  f: ActivityFilters,
  defaults: { win: WindowKey },
  opts: { withActor?: boolean } = {},
): string {
  const qs = new URLSearchParams(search);
  if (f.win === defaults.win) qs.delete(WIN_PARAM);
  else qs.set(WIN_PARAM, f.win);
  if (f.kinds.length) qs.set(KINDS_PARAM, f.kinds.join(","));
  else qs.delete(KINDS_PARAM);
  if (opts.withActor !== false) {
    if (f.actor) qs.set(ACTOR_PARAM, f.actor);
    else qs.delete(ACTOR_PARAM);
  }
  const out = qs.toString();
  return out ? `?${out}` : "";
}

/** The chronicle request for one page. `actorId` (fixed) wins over the shareable `actor` ref. */
export function activityQuery(q: {
  since: string | null;
  kinds?: string[];
  actorId?: string | null;
  actor?: string | null;
  worldId?: string | null;
  cursor?: string | null;
  limit?: number;
}): string {
  const qs = new URLSearchParams();
  if (q.since) qs.set("since", q.since);
  if (q.kinds?.length) qs.set("kinds", q.kinds.join(","));
  if (q.actorId) qs.set("actor_id", q.actorId);
  else if (q.actor) qs.set("actor", q.actor);
  if (q.worldId) qs.set("world_id", q.worldId);
  if (q.cursor) qs.set("cursor", q.cursor);
  qs.set("limit", String(q.limit ?? 80));
  return `/api/v1/chronicle?${qs.toString()}`;
}
