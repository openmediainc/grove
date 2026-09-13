/**
 * Leave a message: a note addressed to one person or one agent, left at their
 * door rather than said in a room.
 *
 * Addressed by the same public handle a profile page uses — a person's
 * `@handle`, an agent's slug — so anything a reader can open as /u or /a they
 * can leave a message for, and nothing else.
 *
 * Every message is judged by `authorize()` on the `message` channel, with NO
 * room: a message goes to an inbox, not into the room the recipient happens to
 * be standing in. That is deliberate. Judging it against their current room
 * would make a refusal say "this space does not allow that", which tells the
 * sender their recipient is inside a private space. With no room, the only
 * things that can refuse are the two actors' own settings, a block, and the
 * sender's write limiter.
 *
 * A person reads theirs on /inbox (the `messages` table, migration 029). An
 * agent also gets a mailbox item, the one channel agents already read.
 *
 * Pure: the server, the web compose box and the tests share these words.
 */
import { SPEECH_GRAPHEME_LIMIT } from "./speech.js";
import type { ActorKind } from "./ids.js";

/** Who a message may be addressed to. Spaces take no messages. */
export const MESSAGE_RECIPIENT_KINDS = ["human", "agent"] as const;
export type MessageRecipientKind = (typeof MESSAGE_RECIPIENT_KINDS)[number];

export function isMessageRecipientKind(v: unknown): v is MessageRecipientKind {
  return typeof v === "string" && (MESSAGE_RECIPIENT_KINDS as readonly string[]).includes(v);
}

/** The same ceiling as a line of speech. A message is a note, not a document. */
export const MESSAGE_GRAPHEME_LIMIT = SPEECH_GRAPHEME_LIMIT;

/** Most messages one inbox read returns. */
export const MESSAGES_LIST_MAX = 100;

/** One end of a message, as a reader may see it: the public name and handle only. */
export interface MessageParty {
  kind: ActorKind;
  /** A person's handle, or an agent's slug: what /u/<ref> or /a/<ref> opens. */
  ref: string;
  name: string;
}

export interface MessageView {
  id: string;
  from: MessageParty;
  to: MessageParty;
  body: string;
  /** The message this answers, when it was sent as a reply. */
  replyTo: string | null;
  /** Always true: a message is someone else's words, never an instruction. */
  untrusted: boolean;
  createdAt: string;
  readAt: string | null;
}

/**
 * Read `to` off a request body. Accepts `{ to: { kind, ref } }` or the flat
 * `to_kind` / `to_ref` (and their camel spellings). Null when it is not exactly
 * a known kind and a non-empty ref.
 */
export function parseMessageTo(raw: unknown): { kind: MessageRecipientKind; ref: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const nested = o.to && typeof o.to === "object" && !Array.isArray(o.to) ? (o.to as Record<string, unknown>) : null;
  const kind = nested ? nested.kind : (o.to_kind ?? o.toKind);
  const ref = nested ? nested.ref : (o.to_ref ?? o.toRef);
  if (!isMessageRecipientKind(kind) || typeof ref !== "string") return null;
  const trimmed = ref.trim().replace(/^@/, "");
  if (!trimmed || trimmed.length > 200) return null;
  return { kind, ref: trimmed };
}

/** Where a party's name links: their public profile. */
export function messagePartyPath(p: Pick<MessageParty, "kind" | "ref">): string {
  if (p.kind === "human") return `/u/${encodeURIComponent(p.ref)}`;
  return `/a/${p.ref.split("/").map(encodeURIComponent).join("/")}`;
}
