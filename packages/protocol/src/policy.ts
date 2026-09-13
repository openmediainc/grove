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

/**
 * Field-wise OR of two ceilings. Used for exactly one thing: a member's ceiling
 * is never below the non-member ceiling of the same room (see `resolveCeiling`).
 * It never touches an ACTOR policy, so it cannot widen what anyone granted.
 */
export function unionSpacePolicy(a: SpacePolicy, b: SpacePolicy): SpacePolicy {
  return {
    speakToAgents: a.speakToAgents || b.speakToAgents,
    speakToHumans: a.speakToHumans || b.speakToHumans,
    listenToAgents: a.listenToAgents || b.listenToAgents,
    listenToHumans: a.listenToHumans || b.listenToHumans,
  };
}

/**
 * SPC-07 / SPC-10 — the four ceiling layers one room can carry, already resolved
 * to `SpacePolicy` objects by the caller. Every layer is optional and absence
 * means "inherit" (for a room layer) or "narrows nothing" (for a space layer),
 * so a context that carries none of them is exactly today's kernel.
 */
export interface CeilingLayers {
  /** The space's NON-member ceiling (from `worlds.policy_preset` / `space_policy`). */
  policy?: SpacePolicy;
  /** SPC-10: the space's MEMBER ceiling (`worlds.member_policy`). Absent = full. */
  memberPolicy?: SpacePolicy;
  /** SPC-07: this room's NON-member override (`rooms.room_preset`). Absent = inherit. */
  roomPolicy?: SpacePolicy;
  /** SPC-10 at room grain: this room's MEMBER override (`rooms.member_policy`). Absent = inherit. */
  roomMemberPolicy?: SpacePolicy;
}

/** Which layer set a ceiling. `null` = no layer narrows this actor here. */
export type CeilingScope = "room" | "space";
/** Which of the two ceilings applied to the actor. */
export type CeilingMembership = "member" | "non_member";

export interface ResolvedCeiling {
  ceiling: SpacePolicy;
  scope: CeilingScope | null;
  membership: CeilingMembership;
}

/**
 * THE precedence rule for room vs space vs member vs non-member. One function,
 * exported, so the kernel and every UI preview read the same answer.
 *
 *     nonMember(room) = room.roomPolicy ?? space.policy ?? OPEN
 *     member(room)    = (room.roomMemberPolicy ?? space.memberPolicy ?? OPEN) OR nonMember(room)
 *     effective       = actor AND (isMember ? member(room) : nonMember(room))
 *
 * 1. A room override REPLACES the space's value for that audience; it does not
 *    intersect with it. So a room may be more open than its space (a public
 *    lobby on a private plot) or more closed (a members-only study in a public
 *    space). Replacement is what an owner means by "this room is different".
 * 2. The two audiences resolve independently — a room that overrides only the
 *    non-member ceiling still inherits the space's member ceiling.
 * 3. A member is never below a non-member in the same room: joining a space can
 *    only ADD. Without the OR, a public lobby in a space whose members are
 *    listen-only would let strangers speak where members could not.
 * 4. Nothing here touches the actor's own matrix: `effective` is still an AND,
 *    so no layer can grant a capability the actor lacks.
 */
export function resolveCeiling(layers: CeilingLayers | undefined, isMember: boolean): ResolvedCeiling {
  const nonMember: { ceiling: SpacePolicy; scope: CeilingScope | null } = layers?.roomPolicy
    ? { ceiling: layers.roomPolicy, scope: "room" }
    : layers?.policy
      ? { ceiling: layers.policy, scope: "space" }
      : { ceiling: OPEN_SPACE_POLICY, scope: null };
  if (!isMember) return { ...nonMember, membership: "non_member" };
  const own: { ceiling: SpacePolicy; scope: CeilingScope } | null = layers?.roomMemberPolicy
    ? { ceiling: layers.roomMemberPolicy, scope: "room" }
    : layers?.memberPolicy
      ? { ceiling: layers.memberPolicy, scope: "space" }
      : null;
  if (!own) return { ceiling: OPEN_SPACE_POLICY, scope: null, membership: "member" };
  return {
    ceiling: unionSpacePolicy(own.ceiling, nonMember.ceiling),
    scope: own.scope,
    membership: "member",
  };
}

/**
 * Does this room's own override grant a NON-member anything? (An explicit
 * lobby.) `private` or no override grants nothing by itself; whether an
 * inheriting room admits visitors is `roomAdmitsVisitors`, which also reads the
 * space.
 */
export function roomAdmitsNonMembers(roomPreset: SpacePolicyPreset | null | undefined): boolean {
  if (!roomPreset) return false;
  const p = SPACE_POLICY_PRESETS[roomPreset];
  return Boolean(p && (p.listenToAgents || p.listenToHumans || p.speakToAgents || p.speakToHumans));
}

/** Whether a non-member ceiling grants any capability at all. */
export function ceilingAdmits(ceiling: SpacePolicy | null | undefined): boolean {
  return Boolean(
    ceiling && (ceiling.listenToAgents || ceiling.listenToHumans || ceiling.speakToAgents || ceiling.speakToHumans),
  );
}

/**
 * THE door rule for a non-member of a space. The same precedence as
 * `resolveCeiling`'s non-member side: a room override REPLACES the space.
 *
 * - An explicit room override decides for that room: `private` keeps a room of a
 *   public space closed; any other preset opens it as a lobby, even on a private
 *   plot.
 * - With no override the room inherits the space: `public_view` / `public_write`
 *   admit a non-member (who is then held to that ceiling — listen-only, or
 *   speak), `private` admits nobody.
 *
 * Admission is never membership: a visitor sits at the non-member ceiling.
 */
export function roomAdmitsVisitors(
  roomPreset: SpacePolicyPreset | null | undefined,
  spaceCeiling: SpacePolicy | null | undefined,
): boolean {
  return roomPreset ? roomAdmitsNonMembers(roomPreset) : ceilingAdmits(spaceCeiling);
}

/**
 * Parse an owner-supplied ceiling (wire or camel spelling) or `null` to clear
 * it. Returns `undefined` for anything that is not exactly four booleans, so a
 * route can refuse it rather than store half a ceiling.
 */
export function parseCeiling(raw: unknown): SpacePolicy | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const pick = (camel: string, snake: string) => (typeof o[camel] === "boolean" ? o[camel] : o[snake]);
  const sa = pick("speakToAgents", "speak_to_agents");
  const sh = pick("speakToHumans", "speak_to_humans");
  const la = pick("listenToAgents", "listen_to_agents");
  const lh = pick("listenToHumans", "listen_to_humans");
  if (![sa, sh, la, lh].every((v) => typeof v === "boolean")) return undefined;
  return {
    speakToAgents: sa as boolean,
    speakToHumans: sh as boolean,
    listenToAgents: la as boolean,
    listenToHumans: lh as boolean,
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
   * Set on `PERMISSION_DENIED` and on `NOT_ADDRESSABLE`; absent on every other
   * code, including `ALLOW`. Derived, never guessed: a capability the actor
   * still holds can only have been removed by the space, and every branch that
   * produces `NOT_ADDRESSABLE` reads a setting of the recipient's own.
   *
   * `NOT_ADDRESSABLE` is the refusal that most needs this — it is the world
   * saying "they have closed their door to you" — and it is always
   * `source: "actor"`, `subject: "recipient"`. It carries no `capability`: the
   * settings behind it (`privacy.addressableByAgents`,
   * `privacy.addressableByHumans`, a human's `lurk`) are not keys of
   * `PermissionPolicy`, and borrowing an actor-shaped capability name for them
   * would recreate the incoherence this field exists to remove.
   */
  source?: "actor" | "space" | "room";
  /**
   * SPC-07 / SPC-10: WHICH ceiling refused, when a ceiling did. Set exactly
   * when `source` is `"space"` or `"room"`: `"non_member"` means the refusal is
   * the one strangers get (join, or ask the owner to open this room);
   * `"member"` means even members are held to it here (only the owner can lift
   * it). Absent on `source: "actor"` and on every other code.
   *
   * `source: "room"` means a room override set the ceiling; `"space"` means the
   * room inherited it from its space. See `resolveCeiling`.
   */
  membership?: CeilingMembership;
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
   * actually read. Set exactly when `source` is `"actor"` — on
   * `PERMISSION_DENIED` and on `NOT_ADDRESSABLE`, which is always the
   * recipient's; absent when `source` is `"space"` (no actor is at fault) and
   * absent on every other code, including `ALLOW`.
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
  channel: PolicyChannel;
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
    /** SPC-10: the space's member ceiling. Absent ⇒ members sit at the full ceiling. */
    memberPolicy?: SpacePolicy;
    /** SPC-07: this room's non-member override. Absent ⇒ inherit `policy`. */
    roomPolicy?: SpacePolicy;
    /** SPC-10: this room's member override. Absent ⇒ inherit `memberPolicy`. */
    roomMemberPolicy?: SpacePolicy;
  };
  quota: QuotaSnapshot;
  isOwnerChannel: boolean;
}

/**
 * Every act the kernel judges. The speech channels, plus `reaction`: an emoji
 * put on a line or event. A reaction is never a row in `speech` and never a
 * `SpeechChannel` — `say()` cannot be asked to store one — but it is decided by
 * the same `authorize()` so it cannot grow a second, drifting rule.
 * Recipients on a reaction are the target's author (at most one).
 *
 * `follow_notice`: telling followers that a followed agent or space did
 * something (see follows.ts). Sender = the subject whose activity it is,
 * recipients = the followers, room = where it happened. It is not speech: the
 * act already happened, so emit only refuses an owner lounge, and each delivery
 * asks whether that follower could hear the sender in that room (blocks, mutes,
 * the recipient's own ear, the space and room ceilings with their membership).
 *
 * `message`: a note left for one person or agent (messages.ts). Sender = the
 * author, recipients = exactly the one addressee, and NO room: it lands in an
 * inbox, not in the room the addressee is standing in, so no space or room
 * ceiling is consulted and a refusal can never disclose where they are. Judged
 * like a whisper (their door, a block, both actors' own settings) but charged
 * to the write limiter only.
 */
export type PolicyChannel = SpeechChannel | "reaction" | "follow_notice" | "message";

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
