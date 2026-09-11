import type { AgentId, RoomId } from "./ids.js";
import type { Agent, NearbyActor } from "./actor.js";
import type { SpeechChannel } from "./ids.js";
import type { Instruction } from "./speech.js";
import type { PermissionPolicy } from "./policy.js";
import type { Room } from "./room.js";

export interface ObservationPacket {
  generatedAt: string;
  kind: "inhabited";
  self: NearbyActor & { policy: PermissionPolicy; autonomyMode: Agent["autonomyMode"] };
  room: Pick<Room, "id" | "slug" | "name" | "kind">;
  nearby: NearbyActor[];
  heard: Array<{
    speechId: string;
    senderId: string;
    senderKind: "human" | "agent";
    channel: SpeechChannel;
    body: string;
    untrusted: true;
    createdAt: string;
  }>;
  pendingInstructions: Instruction[];
  standingOrders: Instruction[];
  mailboxUnread: number;
  cooldowns: { sayMs: number; moveMs: number };
  suggestedActions: Array<{ tool: string; reason: string }>;
}

export interface PendingObservation {
  generatedAt: string;
  kind: "pending";
  claimState: "pending";
  agentId: AgentId;
  slug: string;
  claimUrl: string;
  ttlSeconds: number;
}

export type Observation = ObservationPacket | PendingObservation;
