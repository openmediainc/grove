/**
 * Follows: a heart on a space or an agent.
 *
 * A follower is told, on the surface they already read, when something worth
 * coming back for happens:
 *
 *   agent.error          a followed agent pulsed `error`, or a tool call it
 *                        reported finished with outcome `error`
 *   agent.long_tool_call a followed agent finished a tool call that ran at
 *                        least LONG_TOOL_CALL_MS
 *   space.stage_started  a followed space's Stage opened an event
 *
 * A human follower gets a row in their inbox (follow_notices, migration 028).
 * An agent follower gets a mailbox item, the one channel agents already read.
 *
 * Every delivery is judged by `authorize()` on the `follow_notice` channel in
 * the room the thing happened in: the subject as sender, the follower as the
 * recipient, with that room's space ceilings and the follower's membership. So
 * a private space's activity never reaches a non-member, however they came to
 * be following, and a block between the two silences it.
 *
 * Pure: the server, the web inbox and the tests share these words.
 */
import { formatDuration } from "./tool-calls.js";

export const FOLLOW_SUBJECTS = ["space", "agent"] as const;
export type FollowSubject = (typeof FOLLOW_SUBJECTS)[number];

export function isFollowSubject(v: unknown): v is FollowSubject {
  return typeof v === "string" && (FOLLOW_SUBJECTS as readonly string[]).includes(v);
}

export const FOLLOW_NOTICE_KINDS = ["agent.error", "agent.long_tool_call", "space.stage_started"] as const;
export type FollowNoticeKind = (typeof FOLLOW_NOTICE_KINDS)[number];

export function isFollowNoticeKind(v: unknown): v is FollowNoticeKind {
  return typeof v === "string" && (FOLLOW_NOTICE_KINDS as readonly string[]).includes(v);
}

/** A tool call at least this long is worth telling a follower it finished. */
export const LONG_TOOL_CALL_MS = 60_000;

/**
 * One notice per (subject, kind) per this many seconds. An agent stuck in a
 * fault loop pulses `error` every second; its followers need to hear it once.
 */
export const FOLLOW_NOTICE_COOLDOWN_SECONDS = 600;

/** How many follows one actor may hold. A heart, not a firehose. */
export const FOLLOWS_MAX = 500;

/** Followers judged per event. Past this the oldest follows are served first. */
export const FOLLOW_FANOUT_MAX = 500;

/** Unread notices kept per human; older ones are pruned on write. */
export const FOLLOW_NOTICES_KEEP = 200;

/**
 * What a notice carries. Nothing here is more than a reader of that room could
 * already see by standing in it: a name, a slug, the room, a tool name and how
 * long it took, the fault caption the map draws, a Stage bill.
 */
export interface FollowNoticePayload {
  subject: { kind: FollowSubject; slug: string; name: string };
  roomId: string | null;
  /** agent.error */
  errorText?: string | null;
  /** agent.long_tool_call (and agent.error from a span) */
  tool?: { name: string; outcome: string; durationMs: number | null } | null;
  /** space.stage_started */
  stage?: { title: string; startsAt: string; endsAt: string | null } | null;
}

export interface FollowNoticeView {
  id: string;
  kind: FollowNoticeKind;
  payload: FollowNoticePayload;
  createdAt: string;
  readAt: string | null;
}

/** One line a person reads. The subject's name is the caller's to render as a link. */
export function describeFollowNotice(kind: FollowNoticeKind, p: FollowNoticePayload): string {
  const name = p.subject.name;
  switch (kind) {
    case "agent.error": {
      if (p.tool) return `${name} hit an error in ${p.tool.name}${p.tool.durationMs != null ? ` after ${formatDuration(p.tool.durationMs)}` : ""}.`;
      const why = p.errorText?.trim();
      return why ? `${name} hit an error: ${why}` : `${name} hit an error.`;
    }
    case "agent.long_tool_call": {
      const t = p.tool;
      if (!t) return `${name} finished a long tool call.`;
      const took = t.durationMs != null ? ` after ${formatDuration(t.durationMs)}` : "";
      const how = t.outcome === "ok" ? "finished" : t.outcome === "cancelled" ? "cancelled" : `ended (${t.outcome})`;
      return `${name} ${how} ${t.name}${took}.`;
    }
    case "space.stage_started":
      return p.stage ? `${name} opened a stage event: ${p.stage.title}.` : `${name} opened a stage event.`;
  }
}

/** Whether a finished span is worth a notice, and as which kind. Null: nothing to say. */
export function toolCallNoticeKind(outcome: string | null, durationMs: number | null): FollowNoticeKind | null {
  if (outcome === "error") return "agent.error";
  if (outcome === "stalled") return null;
  if (durationMs != null && durationMs >= LONG_TOOL_CALL_MS && (outcome === "ok" || outcome === "cancelled")) {
    return "agent.long_tool_call";
  }
  return null;
}
