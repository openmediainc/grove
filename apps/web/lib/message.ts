/**
 * Leave a message: the compose box on a card or a profile, and the inbox rows.
 *
 * Pure, so who a card may be messaged at, what a send posts and what a draft is
 * refused for can be tested without a browser. Who may actually be reached is
 * the server's: every send is judged by the permission kernel, and a refusal
 * comes back as a flattened decision for RefusalNotice to say out loud.
 */
import { MESSAGE_GRAPHEME_LIMIT, graphemeCount, messagePartyPath, type MessageRecipientKind } from "@grove/protocol";
import type { CardTarget } from "./card";

export type MessageTarget = { kind: MessageRecipientKind; ref: string; name?: string };

/** A message party as the API sends it. */
export type WireParty = { kind: "human" | "agent"; ref: string; name: string };

/** One message as the API sends it (snake_case off the wire). */
export type WireMessage = {
  id: string;
  from: WireParty;
  to: WireParty;
  body: string;
  reply_to: string | null;
  untrusted: boolean;
  created_at: string;
  read_at: string | null;
};

export type WireMessages = { received: WireMessage[]; sent: WireMessage[]; unread: number };

/** People and agents take messages; a space's card does not. */
export function messageTargetFromCard(t: CardTarget | null, name?: string): MessageTarget | null {
  if (!t || t.subject === "space") return null;
  return { kind: t.subject, ref: t.slug, name };
}

/** Who to answer: whoever sent it. Null when they have gone (no handle left to address). */
export function replyTarget(m: WireMessage): MessageTarget | null {
  return m.from.ref ? { kind: m.from.kind, ref: m.from.ref, name: m.from.name } : null;
}

export type DraftProblem = "empty" | "too_long" | null;

export function draftProblem(body: string): DraftProblem {
  const t = body.trim();
  if (!t) return "empty";
  return graphemeCount(t) > MESSAGE_GRAPHEME_LIMIT ? "too_long" : null;
}

/** Characters left, for the counter under the box. */
export function draftRemaining(body: string): number {
  return MESSAGE_GRAPHEME_LIMIT - graphemeCount(body.trim());
}

/** What a send posts. */
export function messageRequestBody(target: MessageTarget, body: string, replyTo?: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { to: { kind: target.kind, ref: target.ref }, body: body.trim() };
  if (replyTo) out.reply_to = replyTo;
  return out;
}

/** Stable key for the target, so a compose box resets when the card changes. */
export function messageTargetKey(t: MessageTarget | null): string {
  return t ? `${t.kind}:${t.ref}` : "";
}

/** Where a party's name links. */
export function partyHref(p: WireParty): string | null {
  return p.ref ? messagePartyPath(p) : null;
}

/** "Leave a message for Ada" — the button's words with the name, when there is one. */
export function composeTitle(lexWord: string, target: MessageTarget | null): string {
  return target?.name ? `${lexWord} for ${target.name}` : lexWord;
}
