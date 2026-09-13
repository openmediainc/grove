import type { ActorId, ActorKind, RoomId, SpeechChannel, SpeechId } from "./ids.js";
import type { PolicyDecision } from "./policy.js";

export interface SpeechAct {
  id: SpeechId;
  channel: SpeechChannel;
  senderId: ActorId;
  senderKind: ActorKind;
  roomId: RoomId | null;
  targetId: ActorId | null;
  body: string;
  createdAt: string;
  untrusted: boolean;
  idempotencyKey: string | null;
}

export interface Instruction {
  id: string;
  agentId: string;
  ownerHumanId: string;
  kind: "one_shot" | "standing" | "stop";
  body: string;
  createdAt: string;
  expiresAt: string | null;
  ackedAt: string | null;
}

export interface SayRequest {
  channel: SpeechChannel;
  body: string;
  targetId?: ActorId | null;
  roomId?: RoomId | null;
  idempotencyKey: string;
}

/**
 * One recipient the line did not reach, and why.
 *
 * §5.5 reached the EMIT refusal first: `source` and `subject` ride on the 403
 * that says the sender may not speak at all. But a line can be emitted and then
 * filtered for SOME recipients, and until now that half carried `code` and
 * `capability` only — so "their owner has not granted this", "this space does
 * not allow it" and "your own privacy setting stopped it" all arrived as the
 * same `PERMISSION_DENIED`, per recipient, with no way to tell them apart.
 *
 * The kernel already derives all four fields per recipient, in the same test
 * that produced the refusal (see `PolicyDecision`). These are copied from it
 * verbatim, never recomputed: a second derivation here could contradict the
 * first. `reason` is the kernel's own sentence, the same one that becomes the
 * `message` of the 403 when it is the EMIT half that refuses — so the two
 * halves of one decision finally read alike.
 *
 * THE ONE DELIBERATE ASYMMETRY: a mute is never attributed. A muted recipient
 * appears with `code: "MUTED"` and nothing else — no capability, no source, no
 * subject, no reason. See `undeliveredFor()` in
 * packages/domain/src/services/speech.ts for why that is a rule and not an
 * oversight.
 */
export interface UndeliveredRecipient {
  actorId: ActorId;
  code: PolicyDecision["code"];
  /**
   * The WIRE spelling (`listen_to_humans`), matching `error.capability`.
   * It used to ship camelCase here while the error shipped snake, so the one
   * renderer for a refusal — `describeRefusal` in @grove/ui — could not read an
   * undelivered entry at all. One name, one spelling, everywhere.
   */
  capability?: string;
  /** Which ceiling refused: the actor's own settings, or the space's. */
  source?: PolicyDecision["source"];
  /** Whose setting it was, when an actor's was: the sender's, or the recipient's. */
  subject?: PolicyDecision["subject"];
  /** SPC-07/10: which ceiling, when a room or space refused: members' or non-members'. */
  membership?: PolicyDecision["membership"];
  /** The kernel's sentence. Names a setting, never a person. */
  reason?: string;
}

export interface SayAck {
  id: SpeechId;
  channel: SpeechChannel;
  deliveredCount: number;
  undelivered: UndeliveredRecipient[];
}

export const EMOTE_ENUM = ["nod", "wave", "notes", "work", "rest"] as const;
export type EmoteKind = (typeof EMOTE_ENUM)[number];

export const SPEECH_GRAPHEME_LIMIT = 1000;
export const STATUS_GRAPHEME_LIMIT = 140;
