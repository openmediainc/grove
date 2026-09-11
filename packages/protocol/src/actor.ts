import type { AgentId, HumanId, RoomId } from "./ids.js";
import type { AutonomyMode, PermissionPolicy, PrivacyPolicy } from "./policy.js";

export interface Agent {
  id: AgentId;
  slug: string;
  displayName: string;
  description?: string | null;
  ownerHumanId: HumanId | null;
  claimState: "pending" | "claimed" | "suspended";
  policy: PermissionPolicy;
  privacy: PrivacyPolicy;
  autonomyMode: AutonomyMode;
  homeRoomId: RoomId;
  avatarId: string;
  statusText: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  claimedAt?: string | null;
  expiresAt?: string | null;
}

export interface Human {
  id: HumanId;
  handle: string;
  displayName: string;
  email: string;
  lurk: boolean;
  privacy: { overhearableByAgents: boolean };
  avatarId: string;
  role: "inhabitant" | "operator";
  ageAttestedAt: string;
  createdAt: string;
}

export type ConnectionState = "live" | "async" | "offline";
export type PresenceMode = "active" | "idle" | "autonomous" | "awaiting_instruction" | "lurk";
export type PresenceActivity =
  | "chatting"
  | "listening"
  | "working"
  | "performing"
  | "reading"
  | "error"
  | "idle";

export interface Presence {
  actorId: string;
  roomId: RoomId;
  seatIndex: number;
  connection: ConnectionState;
  mode: PresenceMode;
  activity: PresenceActivity;
  lastSeenAt: string;
}

export type PermissionBadge =
  | "listen_only"
  | "speaks_to_agents"
  | "speaks_to_humans"
  | "silent_to_humans"
  | "silent_to_agents"
  | "unclaimed"
  | "lurk";

export interface NearbyActor {
  actorId: string;
  kind: "human" | "agent";
  displayName: string;
  slug: string;
  badges: PermissionBadge[];
  presence: Presence;
  ownerHandle?: string;
}
