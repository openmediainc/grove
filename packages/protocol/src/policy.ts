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

/**
 * §5.3 v2 grain: a space's own access level.
 *
 * Same four capabilities as `PermissionPolicy`, read as a CEILING rather than a
 * grant: it is the most an actor is permitted to do *in this space*. The kernel
 * composes it as a strict intersection —
 *
 *     effective = actor_policy AND space_policy
 *
 * so a space can only ever NARROW an actor. It can never widen one. Humans carry
 * no capability matrix (§5.1), so their actor half is implicitly all-true and the
 * space is the only thing that narrows them.
 *
 * The ceiling applies to NON-MEMBERS of the space. A member of the space always
 * sits at the full ceiling (all four true) and is narrowed only by their own
 * actor policy — that is what makes `private` and `public_view` mean anything.
 * Membership arrives per-actor on `PolicyContext` as `isSpaceMember`.
 *
 * The owner channel (`owner_instruction` / `owner_reply`) bypasses this entirely.
 */
export interface SpacePolicy {
  speakToAgents: boolean;
  speakToHumans: boolean;
  listenToAgents: boolean;
  listenToHumans: boolean;
}

/** The named access levels a space owner actually picks. */
export type SpacePolicyPreset = "private" | "public_view" | "public_write";

/**
 * Presets are DATA, not branching logic. `authorize` never looks at the preset
 * name; a route resolves the name to a `SpacePolicy` and puts that on the context.
 *
 * | preset       | non-member may speak | non-member may listen |
 * |--------------|----------------------|-----------------------|
 * | private      | no                   | no                    |
 * | public_view  | no                   | yes                   |
 * | public_write | yes                  | yes                   |
 */
export const SPACE_POLICY_PRESETS: Record<SpacePolicyPreset, SpacePolicy> = {
  // Only the space's own members may speak or be heard at all.
  private: {
    speakToAgents: false,
    speakToHumans: false,
    listenToAgents: false,
    listenToHumans: false,
  },
  // Anyone may observe/listen; only members may speak.
  public_view: {
    speakToAgents: false,
    speakToHumans: false,
    listenToAgents: true,
    listenToHumans: true,
  },
  // Anyone may speak and listen. Narrows nothing; identical to no space policy.
  public_write: {
    speakToAgents: true,
    speakToHumans: true,
    listenToAgents: true,
    listenToHumans: true,
  },
};

/** A space that narrows nothing. Also the ceiling a member of any space sits at. */
export const OPEN_SPACE_POLICY: SpacePolicy = SPACE_POLICY_PRESETS.public_write;

/** Back-compatible default: existing rooms behave exactly as they do today. */
export const DEFAULT_SPACE_POLICY_PRESET: SpacePolicyPreset = "public_write";

export function spacePolicyForPreset(preset: SpacePolicyPreset): SpacePolicy {
  return SPACE_POLICY_PRESETS[preset];
}

/**
 * The one composition rule. Pure, total, and monotone: every field of the result
 * is `false` whenever either input is `false`, so the result can never grant a
 * capability the actor lacks.
 */
export function intersectSpacePolicy(actor: PermissionPolicy, space: SpacePolicy): PermissionPolicy {
  return {
    speakToAgents: actor.speakToAgents && space.speakToAgents,
    speakToHumans: actor.speakToHumans && space.speakToHumans,
    listenToAgents: actor.listenToAgents && space.listenToAgents,
    listenToHumans: actor.listenToHumans && space.listenToHumans,
  };
}

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
  /**
   * §5.5: which ceiling actually refused. `capability` alone cannot say — a
   * space denial has to borrow an actor-shaped capability name, so without this
   * "your owner has not granted this" and "this space does not allow it" are
   * indistinguishable to a UI.
   *
   * Only ever set on `PERMISSION_DENIED`; absent on every other code, including
   * `ALLOW`. Derived, never guessed: a capability the actor still holds can only
   * have been removed by the space.
   */
  source?: "actor" | "space";
  /**
   * §5.5: WHICH actor. `source: "actor"` says a person's own setting refused,
   * but not whose — and `capability` cannot stand in for it, because a denial
   * borrows the capability name of the ear it closed even when the cause was the
   * mouth. Speaker privacy is the plain case: `overhearableByAgents` reports
   * `capability: "listenToHumans"` (the recipient's ear) while the setting that
   * actually refused belongs to the SENDER. A UI that renders "actor" as "your
   * setting" is wrong about half the time without this.
   *
   * Derived, never guessed: it names the party whose stored setting the branch
   * actually read. Set on `PERMISSION_DENIED` exactly when `source` is `"actor"`;
   * absent when `source` is `"space"` (no actor is at fault) and absent on every
   * other code, including `ALLOW`.
   */
  subject?: "sender" | "recipient";
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
    /** Member of ctx.room. Already-fetched, like quota. Absent ⇒ not a member. */
    isSpaceMember?: boolean;
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
    /** Member of ctx.room. Already-fetched, like quota. Absent ⇒ not a member. */
    isSpaceMember?: boolean;
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
    /**
     * The space's own access level, already resolved from its preset by the
     * caller. Absent ⇒ the space narrows nothing (today's behaviour).
     */
    policy?: SpacePolicy;
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
