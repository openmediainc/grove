import type { RefusalInput } from "@grove/ui";
import type { Nearby } from "./api";

/**
 * Whisper, as the room compose speaks it. Pure helpers only — the page owns the
 * state, and nothing here decides whether a whisper is ALLOWED: that is the
 * kernel's answer, asked for through `GET /api/v1/whisper/check`.
 */

/** `GET /api/v1/whisper/check`, and one `undelivered[]` entry of a say ack. Wire spelling. */
export type UndeliveredWire = {
  actor_id: string;
  code: string;
  capability?: string;
  source?: string;
  subject?: string;
  /** #62: which side a refusal is about, also on a ceiling refusal. */
  party?: string;
  membership?: string;
  reason?: string;
};

export type WhisperCheckWire = { allowed: boolean; refusal: UndeliveredWire | null };

export type SayAckWire = {
  id: string;
  channel: string;
  delivered_count: number;
  undelivered: UndeliveredWire[];
};

/** One private line in the reader's own log. Never part of the room transcript. */
export type WhisperLine = {
  id: string;
  body: string;
  direction: "out" | "in";
  /** The other party. */
  other_id: string;
  other_kind: "human" | "agent";
  created_at: string;
  /** Only on "out": why it did not land, when it did not. */
  undelivered?: RefusalInput | null;
};

/**
 * The event a body's motion can hang off (a whisperer walks toward who they are
 * whispering to). Dispatched on `window`; nothing in this page listens to it.
 *
 *  - `target`  — the speaker picked someone to whisper to
 *  - `sent`    — a whisper was accepted by the server (it may still be undelivered)
 *  - `cleared` — back to speaking to the room
 */
export const WHISPER_EVENT = "grove:whisper";

export type WhisperEventDetail = {
  phase: "target" | "sent" | "cleared";
  speakerId: string | null;
  targetId: string | null;
  roomSlug: string;
};

export function emitWhisperEvent(detail: WhisperEventDetail): void {
  try {
    window.dispatchEvent(new CustomEvent<WhisperEventDetail>(WHISPER_EVENT, { detail }));
  } catch {
    /* no window (SSR) — nothing to animate */
  }
}

/** Every name a person might type for a body: its slug, the last part of an owned slug, its name. */
function namesOf(n: Nearby): string[] {
  const out = new Set<string>();
  const slug = (n.slug ?? "").toLowerCase();
  if (slug) {
    out.add(slug);
    const tail = slug.split("/").pop();
    if (tail) out.add(tail);
  }
  const name = (n.display_name ?? "").toLowerCase().trim();
  if (name && !/\s/.test(name)) out.add(name);
  return [...out];
}

/** The body in this room answering to `name`, other than the reader. Exact match only. */
export function findByName(name: string, nearby: Nearby[], meId?: string | null): Nearby | null {
  const want = name.toLowerCase().replace(/^@/, "");
  if (!want) return null;
  return nearby.find((n) => n.actor_id !== meId && namesOf(n).includes(want)) ?? null;
}

/**
 * `/w lantern hello` or `/whisper lantern hello`, recognised once the name is
 * finished (a space after it). Returns who, and whatever was typed after.
 */
export function parseWhisperCommand(
  draft: string,
  nearby: Nearby[],
  meId?: string | null,
): { target: Nearby; rest: string } | null {
  const m = /^\/(?:w|whisper)\s+@?(\S+)\s([\s\S]*)$/i.exec(draft);
  if (!m) return null;
  const target = findByName(m[1]!, nearby, meId);
  return target ? { target, rest: m[2] ?? "" } : null;
}

/**
 * A draft that OPENS with `@name`. Not converted automatically: in the room an
 * @mention is public speech that also wakes that agent, which is a different
 * act. The compose offers the whisper instead of assuming it.
 */
export function leadingMention(
  draft: string,
  nearby: Nearby[],
  meId?: string | null,
): { target: Nearby; rest: string } | null {
  const m = /^@(\S+)(?:\s([\s\S]*))?$/.exec(draft);
  if (!m) return null;
  const target = findByName(m[1]!, nearby, meId);
  return target ? { target, rest: m[2] ?? "" } : null;
}

/** An `undelivered[]` entry (or a check refusal) as `describeRefusal` reads it. */
export function refusalFromWire(entry: UndeliveredWire, recipientKind?: "human" | "agent"): RefusalInput {
  return {
    code: entry.code,
    capability: entry.capability,
    source: entry.source === "actor" || entry.source === "space" || entry.source === "room" ? entry.source : undefined,
    subject: entry.subject === "sender" || entry.subject === "recipient" ? entry.subject : undefined,
    party: entry.party === "sender" || entry.party === "recipient" ? entry.party : undefined,
    membership: entry.membership === "member" || entry.membership === "non_member" ? entry.membership : undefined,
    message: entry.reason,
    senderKind: "human",
    channel: "whisper",
    recipientKind,
  };
}

export function nameFor(n: Pick<Nearby, "display_name" | "slug"> | null | undefined): string {
  return n?.display_name || n?.slug || "them";
}
