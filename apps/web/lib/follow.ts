/**
 * The heart on a space or an agent, and the notices it earns.
 *
 * Pure, so what the heart asks for, what it says and where a notice links can
 * be tested without a browser. Who may follow what, and who hears what, is the
 * server's: a private space answers 404 to a non-member, and every notice was
 * judged by the permission kernel before it was written.
 */
import {
  describeFollowNotice,
  isFollowNoticeKind,
  type FollowNoticeKind,
  type FollowSubject,
} from "@grove/protocol";
import type { CardTarget } from "./card";
import { chronicleActorHref } from "./chronicle-link";
import type { ThemeLexicon } from "./themes/types";

export type FollowTarget = { subject: "space"; ref: string } | { subject: "agent"; slug: string };

/** The follow state as the API sends it (snake_case off the wire). */
export type WireFollow = {
  subject: FollowSubject;
  id: string;
  slug: string;
  name: string;
  following: boolean;
  followers: number;
};

/** One notice as the API sends it. */
export type WireFollowNotice = {
  id: string;
  kind: string;
  payload: {
    subject: { kind: FollowSubject; slug: string; name: string };
    room_id: string | null;
    error_text?: string | null;
    tool?: { name: string; outcome: string; duration_ms: number | null } | null;
    stage?: { title: string; starts_at: string; ends_at: string | null } | null;
  };
  created_at: string;
  read_at: string | null;
};

function enc(s: string): string {
  return s.split("/").map(encodeURIComponent).join("/");
}

export function followApiPath(t: FollowTarget): string {
  return t.subject === "space"
    ? `/api/v1/follows/spaces/${encodeURIComponent(t.ref)}`
    : `/api/v1/follows/agents/${enc(t.slug)}`;
}

/** Only spaces and agents take a heart. A person's card has none. */
export function followTargetFromCard(t: CardTarget | null): FollowTarget | null {
  if (!t) return null;
  if (t.subject === "space") return { subject: "space", ref: t.ref };
  if (t.subject === "agent") return { subject: "agent", slug: t.slug };
  return null;
}

export function followTargetKey(t: FollowTarget | null): string {
  if (!t) return "";
  return t.subject === "space" ? `space:${t.ref}` : `agent:${t.slug}`;
}

/** The button's words: the theme's verb, a count when there is one. */
export function heartLabel(state: Pick<WireFollow, "following" | "followers"> | null, lex: ThemeLexicon["card"]): string {
  const word = state?.following ? lex.following : lex.follow;
  return state && state.followers > 0 ? `${word} · ${state.followers}` : word;
}

/**
 * Where a notice takes you. An agent's notice is about something it did, so it
 * opens that agent's activity (the chronicle filtered to it) rather than its
 * profile; a space's opens the space page, where its Stage lives.
 */
export function noticeHref(n: WireFollowNotice): string {
  const s = n.payload.subject;
  return s.kind === "space" ? `/spaces/${encodeURIComponent(s.slug)}` : chronicleActorHref(s.slug);
}

/** The notice as one sentence, in the same words the server's tests use. */
export function noticeText(n: WireFollowNotice): string | null {
  if (!isFollowNoticeKind(n.kind)) return null;
  const p = n.payload;
  return describeFollowNotice(n.kind as FollowNoticeKind, {
    subject: p.subject,
    roomId: p.room_id,
    errorText: p.error_text ?? null,
    tool: p.tool ? { name: p.tool.name, outcome: p.tool.outcome, durationMs: p.tool.duration_ms } : null,
    stage: p.stage ? { title: p.stage.title, startsAt: p.stage.starts_at, endsAt: p.stage.ends_at } : null,
  });
}
