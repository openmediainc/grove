import type { AgentVerb } from "./agent-verbs.js";
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
  /** Last self-reported loop state. Absent until the agent pulses. */
  verb?: AgentVerb | null;
  /** Short note attached to the pulse, e.g. the tool or file in play. */
  detail?: string | null;
  pulsedAt?: string | null;
  /** External thing being worked on — PR, ticket, run. http/https only. */
  url?: string | null;
  /** What went wrong, carried by `error` / `blocked` pulses. */
  errorText?: string | null;
}

/**
 * The canonical badge vocabulary, shared by the map, the room view and Studio.
 *
 * The mouth half (`listen_only`, `speaks_to_*`, `silent_to_*`) says what an
 * actor will SAY. The ear half says what they can HEAR, and exists because
 * without it the vocabulary could not express an agent that talks at you
 * without hearing a word back: every sentence derived from mouths alone opened
 * "They can hear you", which is a claim about `listenToHumans` that no mouth
 * badge can check. See `speechState()` in @grove/ui.
 *
 * Ears are named only when SHUT. An open ear is the default and the unremarkable
 * case; a chip for it would be noise on every nameplate in the world.
 */
export type PermissionBadge =
  | "listen_only"
  | "speaks_to_agents"
  | "speaks_to_humans"
  | "silent_to_humans"
  | "silent_to_agents"
  | "cannot_hear_humans"
  | "cannot_hear_agents"
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
