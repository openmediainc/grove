import {
  intersectSpacePolicy,
  type AuthorizeResult,
  type PermissionPolicy,
  type PolicyContext,
  type PolicyDecision,
  type SpacePolicy,
  type SpeechChannel,
} from "@grove/protocol";

const OWNER_CHANNELS: SpeechChannel[] = ["owner_instruction", "owner_reply"];

/**
 * An actor with no capability matrix of their own (every human — §5.1) is
 * treated as unrestricted, so the space alone narrows them. Also the ceiling a
 * member of a space sits at.
 */
const ALL_CAPABILITIES: PermissionPolicy = {
  speakToAgents: true,
  speakToHumans: true,
  listenToAgents: true,
  listenToHumans: true,
};

/**
 * The space's ceiling for one actor. Members sit at the full ceiling; the
 * space's own policy applies to everyone else. No room, or no room policy,
 * narrows nothing — so every pre-space context behaves exactly as before.
 */
function spaceCeilingFor(
  room: PolicyContext["room"],
  actor: { isSpaceMember?: boolean },
): SpacePolicy {
  if (!room?.policy) return ALL_CAPABILITIES;
  return actor.isSpaceMember === true ? ALL_CAPABILITIES : room.policy;
}

/** effective = actor_policy AND space_policy. Never widens: see intersectSpacePolicy. */
function effectiveCaps(
  actorPolicy: PermissionPolicy | undefined,
  room: PolicyContext["room"],
  actor: { isSpaceMember?: boolean },
): PermissionPolicy {
  return intersectSpacePolicy(actorPolicy ?? ALL_CAPABILITIES, spaceCeilingFor(room, actor));
}

/**
 * §5.5. `subject` names WHOSE stored setting this branch read — not who the
 * capability is shaped like. It is meaningless when the space refused (no actor
 * is at fault), so it is attached only on `source: "actor"` and is absent, not
 * undefined, otherwise.
 */
function denied(
  capability: keyof PermissionPolicy,
  reason: string,
  source: NonNullable<PolicyDecision["source"]>,
  subject: NonNullable<PolicyDecision["subject"]>,
): PolicyDecision {
  const decision: PolicyDecision = {
    allow: false,
    code: "PERMISSION_DENIED",
    capability,
    reason,
    source,
  };
  if (source === "actor") decision.subject = subject;
  return decision;
}

/**
 * §5.5. Which ceiling refused, for a denial produced by the INTERSECTION.
 *
 * Derived, not assumed. `effectiveCaps` is an AND, so if the actor still holds
 * the capability the only thing that can have removed it is the space; if the
 * actor never held it, the space is irrelevant and the denial is the actor's own.
 * An actor with no matrix (every human — §5.1) holds everything, so any denial
 * they see through this path is always the space's.
 */
function narrowedSource(
  actorPolicy: PermissionPolicy | undefined,
  capability: keyof PermissionPolicy,
): NonNullable<PolicyDecision["source"]> {
  return (actorPolicy ?? ALL_CAPABILITIES)[capability] ? "space" : "actor";
}

/**
 * A denial from `effective = actor AND space`, attributed to whichever half said no.
 *
 * The prose is derived from the SAME test as `source`, so the sentence can never
 * contradict the field. It used to be passed in by the caller, always blaming a
 * space — which on a channel with no space policy at all (e.g. a `notice`
 * reaching the per-recipient mouth check) named a space that was not there.
 */
function spaceDenied(
  actorPolicy: PermissionPolicy | undefined,
  capability: keyof PermissionPolicy,
  subject: NonNullable<PolicyDecision["subject"]>,
): PolicyDecision {
  const source = narrowedSource(actorPolicy, capability);
  const reason =
    source === "space"
      ? `This space does not grant ${capability}.`
      : subject === "sender"
        ? `Sender does not have ${capability}.`
        : `Recipient does not have ${capability}.`;
  return denied(capability, reason, source, subject);
}

export function authorize(ctx: PolicyContext): AuthorizeResult {
  const emit = emitDecision(ctx);
  if (!emit.allow) return { emit, deliveries: [] };

  const deliveries = ctx.recipients.map((r) => ({
    recipientId: r.id,
    decision: deliveryDecision(ctx, r),
  }));
  return { emit, deliveries };
}

function emitDecision(ctx: PolicyContext): PolicyDecision {
  // Owner channel is always open and bypasses space policy entirely.
  if (OWNER_CHANNELS.includes(ctx.channel)) {
    if (ctx.recipients.length !== 1) {
      return { allow: false, code: "NOT_FOUND", reason: "Owner channel requires exactly one recipient." };
    }
    if (!ctx.isOwnerChannel) {
      return { allow: false, code: "NOT_FOUND", reason: "Owner channel requires matching identities." };
    }
    return { allow: true, code: "ALLOW", reason: "Owner channel is always open." };
  }

  if (ctx.sender.kind === "agent" && ctx.sender.claimState !== "claimed") {
    return { allow: false, code: "UNCLAIMED", reason: "Unclaimed agents cannot send public speech." };
  }

  if (ctx.channel === "room_say" && ctx.room && !ctx.room.allowsRoomSay) {
    return { allow: false, code: "ROOM_FORBIDDEN", reason: "This room does not allow public speech." };
  }
  if (ctx.channel === "whisper" && ctx.room && !ctx.room.allowsWhisper) {
    return { allow: false, code: "ROOM_FORBIDDEN", reason: "This room does not allow whispers." };
  }

  // Independent named limiters: all must pass. Occupancy is NOT checked here.
  if (ctx.quota.writeRemaining <= 0 || !ctx.quota.roomSayGapOk || ctx.quota.roomSayRemaining <= 0) {
    return { allow: false, code: "RATE_LIMITED", reason: "Rate limiter exhausted." };
  }
  if (
    ctx.channel === "room_say" &&
    ctx.room?.sayLimitPerMin != null &&
    ctx.quota.roomWindowCount >= ctx.room.sayLimitPerMin
  ) {
    return { allow: false, code: "RATE_LIMITED", reason: "Room say_limit_per_min exhausted." };
  }

  if (ctx.channel === "whisper") {
    const target = ctx.recipients.find((r) => r.id === ctx.requestedTargetId) ?? ctx.recipients[0];
    if (!target) return { allow: false, code: "NOT_FOUND", reason: "Recipient not found." };
    const addr = assertAddressable(ctx.sender, target);
    if (!addr.allow) return addr;
    const cap: keyof PermissionPolicy = target.kind === "agent" ? "speakToAgents" : "speakToHumans";
    if (ctx.sender.kind === "agent" && ctx.sender.policy) {
      if (!ctx.sender.policy[cap]) {
        return denied(cap, `Owner has not granted ${cap}.`, "actor", "sender");
      }
    }
    // Space narrowing: applies to human senders too, who have no matrix of their own.
    if (!effectiveCaps(ctx.sender.policy, ctx.room, ctx.sender)[cap]) {
      return spaceDenied(ctx.sender.policy, cap, "sender");
    }
    return { allow: true, code: "ALLOW", reason: "Sender may whisper." };
  }

  if (ctx.sender.kind === "agent" && ctx.sender.policy) {
    if (ctx.channel === "room_say" || ctx.channel === "notice") {
      if (!ctx.sender.policy.speakToAgents && !ctx.sender.policy.speakToHumans) {
        return denied("speakToHumans", "Listen-only agents cannot room_say.", "actor", "sender");
      }
    }
  }

  // Space narrowing of the same "no mouth" rule, for every sender kind.
  // speakToHumans is the canonical failed capability when no audience is left (§5.8a).
  if (ctx.channel === "room_say" || ctx.channel === "notice") {
    const effective = effectiveCaps(ctx.sender.policy, ctx.room, ctx.sender);
    if (!effective.speakToAgents && !effective.speakToHumans) {
      // `capability` is the canonical speakToHumans (§5.8a) even when it was
      // speakToAgents that the space removed, so per-capability attribution
      // would misreport here. Attribute on the real question this branch asks:
      // did the actor arrive with a mouth at all?
      const own = ctx.sender.policy ?? ALL_CAPABILITIES;
      const hadAMouth = own.speakToAgents || own.speakToHumans;
      return denied(
        "speakToHumans",
        "This space does not grant speech here.",
        hadAMouth ? "space" : "actor",
        "sender",
      );
    }
  }

  return { allow: true, code: "ALLOW", reason: "Sender may emit this speech act." };
}

function deliveryDecision(
  ctx: PolicyContext,
  r: PolicyContext["recipients"][number],
): PolicyDecision {
  // Owner short-circuit ONLY on owner channels. room_say to your owner is mixed-audience.
  // Space policy never applies here: the owner channel is always open.
  if (OWNER_CHANNELS.includes(ctx.channel)) {
    if (!ctx.isOwnerChannel) {
      return { allow: false, code: "NOT_FOUND", reason: "Owner channel identities do not match." };
    }
    return { allow: true, code: "ALLOW", reason: "Owner channel." };
  }

  if (r.blocked) return { allow: false, code: "BLOCKED", reason: "Blocked." };
  if (r.mutedByRecipient) {
    return {
      allow: false,
      code: "MUTED",
      reason: r.kind === "human" ? "Muted; hidden in UI, kept in audit." : "Muted; dropped from agent heard.",
      visibleInUi: false,
    };
  }

  if (ctx.channel === "whisper") {
    const addr = assertAddressable(ctx.sender, r);
    if (!addr.allow) return addr;
  }

  // Speaker privacy, including human.overhearableByAgents. Applies to own agents too.
  // NOTE the asymmetry these two carry: `capability` is the capability the block
  // CLOSED (the recipient's ear, for overhearableByAgents), while the setting that
  // refused is the SPEAKER's own privacy. subject: "sender" is the only honest
  // attribution here, and is why `source: "actor"` alone cannot be rendered as
  // "your setting".
  if (ctx.channel === "room_say" && ctx.sender.privacy) {
    const priv = ctx.sender.privacy as import("@grove/protocol").PrivacyPolicy;
    if (r.kind === "agent" && priv.overhearableByAgents === false) {
      return denied("listenToHumans", "Speaker is not overhearable by agents.", "actor", "sender");
    }
    if (r.kind === "human" && "overhearableByHumans" in priv && priv.overhearableByHumans === false) {
      return denied("speakToHumans", "Speaker is not overhearable by humans.", "actor", "sender");
    }
  }

  const listenCap: keyof PermissionPolicy =
    ctx.sender.kind === "agent" ? "listenToAgents" : "listenToHumans";

  if (r.kind === "agent" && r.policy) {
    if (!r.policy[listenCap]) {
      return denied(listenCap, `Recipient does not have ${listenCap}.`, "actor", "recipient");
    }
  }

  // Space narrowing of the recipient's ear. Applies to humans and spectators too:
  // a spectator is never a member, so a private space is not leaked to the SSE feed.
  if (!effectiveCaps(r.policy, ctx.room, r)[listenCap]) {
    return spaceDenied(r.policy, listenCap, "recipient");
  }

  // Mixed-audience: agent room_say without speakToHumans is not delivered to humans or spectators
  // (including the agent's owner, who is a human client).
  if (
    ctx.channel === "room_say" &&
    ctx.sender.kind === "agent" &&
    ctx.sender.policy &&
    (r.kind === "human" || r.synthetic === "spectator") &&
    !ctx.sender.policy.speakToHumans
  ) {
    return denied("speakToHumans", "Not delivered to humans.", "actor", "sender");
  }
  if (
    ctx.channel === "room_say" &&
    ctx.sender.kind === "agent" &&
    ctx.sender.policy &&
    r.kind === "agent" &&
    !ctx.sender.policy.speakToAgents
  ) {
    return denied("speakToAgents", "Not delivered to agents.", "actor", "sender");
  }

  // Space narrowing of the sender's mouth, per recipient kind. Applies to human
  // senders too, and to every non-owner channel.
  const speakCap: keyof PermissionPolicy =
    r.kind === "human" || r.synthetic === "spectator" ? "speakToHumans" : "speakToAgents";
  if (!effectiveCaps(ctx.sender.policy, ctx.room, ctx.sender)[speakCap]) {
    return spaceDenied(ctx.sender.policy, speakCap, "sender");
  }

  return { allow: true, code: "ALLOW", reason: "Recipient may receive this speech act." };
}

/** Unexported. Used for whisper (P2) and directed notice. Both sender kinds. */
function assertAddressable(
  sender: PolicyContext["sender"],
  target: PolicyContext["recipients"][number],
): PolicyDecision {
  if (target.blocked) return { allow: false, code: "BLOCKED", reason: "Blocked." };
  if (target.kind === "human" && target.lurk) {
    return { allow: false, code: "NOT_ADDRESSABLE", reason: "Human is lurking." };
  }
  const priv = target.privacy as import("@grove/protocol").PrivacyPolicy | undefined;
  if (priv) {
    if (sender.kind === "agent" && priv.addressableByAgents === false) {
      return { allow: false, code: "NOT_ADDRESSABLE", reason: "Not addressable by agents." };
    }
    if (sender.kind === "human" && priv.addressableByHumans === false) {
      return { allow: false, code: "NOT_ADDRESSABLE", reason: "Not addressable by humans." };
    }
  }
  return { allow: true, code: "ALLOW", reason: "Addressable." };
}
