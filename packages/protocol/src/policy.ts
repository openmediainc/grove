import type { ActorId, ActorKind, ClaimState, HumanId, RoomId, SpeechChannel } from "./ids.js";

export type AutonomyMode = "await_orders" | "hang_out" | "work" | "perform" | "scribe";

export interface PermissionPolicy {
  speakToAgents: boolean;
  speakToHumans: boolean;
  listenToAgents: boolean;
  listenToHumans: boolean;
}

export const DEFAULT_AGENT_POLICY: PermissionPolicy = {
  listenToAgents: true,
  listenToHumans: true,
  speakToAgents: true,
  speakToHumans: true,
};

export const DEFAULT_AUTONOMY_MODE: AutonomyMode = "hang_out";

export interface PrivacyPolicy {
  addressableByAgents: boolean;
  addressableByHumans: boolean;
  overhearableByAgents: boolean;
  overhearableByHumans: boolean;
}

export const DEFAULT_AGENT_PRIVACY: PrivacyPolicy = {
  addressableByAgents: true,
  addressableByHumans: true,
  overhearableByAgents: true,
  overhearableByHumans: true,
};

export const DEFAULT_HUMAN_PRIVACY: Pick<PrivacyPolicy, "overhearableByAgents" | "addressableByHumans"> = {
  overhearableByAgents: true,
  addressableByHumans: true,
};

export interface PolicyDecision {
  allow: boolean;
  code:
    | "ALLOW"
    | "PERMISSION_DENIED"
    | "BLOCKED"
    | "MUTED"
    | "NOT_ADDRESSABLE"
    | "ROOM_FORBIDDEN"
    | "ROOM_FULL"
    | "UNCLAIMED"
    | "RATE_LIMITED"
    | "NOT_FOUND";
  capability?: keyof PermissionPolicy;
  reason: string;
  visibleInUi?: boolean;
}

export interface QuotaSnapshot {
  roomSayRemaining: number;
  roomSayGapOk: boolean;
  writeRemaining: number;
  roomWindowCount: number;
}

export interface PolicyContext {
  sender: {
    id: ActorId;
    kind: ActorKind;
    ownerHumanId?: HumanId | null;
    claimState?: ClaimState;
    policy?: PermissionPolicy;
    privacy?: PrivacyPolicy | { overhearableByAgents: boolean };
  };
  recipients: Array<{
    id: ActorId;
    kind: ActorKind;
    ownerHumanId?: HumanId | null;
    lurk?: boolean;
    policy?: PermissionPolicy;
    privacy?: PrivacyPolicy | { overhearableByAgents: boolean };
    blocked: boolean;
    mutedByRecipient: boolean;
    synthetic?: "spectator";
  }>;
  channel: SpeechChannel;
  requestedTargetId?: ActorId | null;
  room?: {
    id: RoomId;
    kind: "public" | "owner_lounge" | "stage" | "notice";
    allowsRoomSay: boolean;
    allowsWhisper: boolean;
    sayLimitPerMin: number | null;
    capacity: number;
  };
  quota: QuotaSnapshot;
  isOwnerChannel: boolean;
}

export interface AuthorizeResult {
  emit: PolicyDecision;
  deliveries: Array<{ recipientId: ActorId; decision: PolicyDecision }>;
}

export function computeIsOwnerChannel(
  sender: PolicyContext["sender"],
  recipient: { id: ActorId; kind: ActorKind; ownerHumanId?: HumanId | null },
): boolean {
  if (sender.kind === "agent" && recipient.kind === "human") {
    return sender.claimState === "claimed" && sender.ownerHumanId === recipient.id;
  }
  if (sender.kind === "human" && recipient.kind === "agent") {
    return recipient.ownerHumanId === sender.id;
  }
  return false;
}

export const OWNER_CHANNELS: SpeechChannel[] = ["owner_instruction", "owner_reply"];
