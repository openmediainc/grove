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

export interface SayAck {
  id: SpeechId;
  channel: SpeechChannel;
  deliveredCount: number;
  undelivered: Array<{
    actorId: ActorId;
    code: PolicyDecision["code"];
    capability?: PolicyDecision["capability"];
  }>;
}

export const EMOTE_ENUM = ["nod", "wave", "notes", "work", "rest"] as const;
export type EmoteKind = (typeof EMOTE_ENUM)[number];

export const SPEECH_GRAPHEME_LIMIT = 1000;
export const STATUS_GRAPHEME_LIMIT = 140;
