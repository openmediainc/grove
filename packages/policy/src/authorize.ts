import {
  intersectSpacePolicy,
  resolveCeiling,
  type AuthorizeResult,
  type PermissionPolicy,
  type PolicyContext,
  type PolicyChannel,
  type PolicyDecision,
  type ResolvedCeiling,
  type SpeechChannel,
} from "@grove/protocol";

const OWNER_CHANNELS: readonly PolicyChannel[] = ["owner_instruction", "owner_reply"] satisfies SpeechChannel[];

/** Channels with a mouth: a listen-only sender cannot use any of them. */
const MOUTH_CHANNELS: readonly PolicyChannel[] = ["room_say", "notice", "reaction"];

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
 * The ceiling one actor faces in this room: room override ?? space, member vs
 * non-member, resolved by the ONE precedence rule in @grove/protocol
 * (`resolveCeiling`). No room, or no layers, narrows nothing — so every
 * pre-space context behaves exactly as before. Membership must be pre-fetched:
 * absent reads as not-a-member.
 */
function ceilingFor(room: PolicyContext["room"], actor: { isSpaceMember?: boolean }): ResolvedCeiling {
  return resolveCeiling(room, actor.isSpaceMember === true);
}

/** effective = actor_policy AND ceiling. Never widens: see intersectSpacePolicy. */
function effectiveCaps(
  actorPolicy: PermissionPolicy | undefined,
  room: PolicyContext["room"],
  actor: { isSpaceMember?: boolean },
): PermissionPolicy {
  return intersectSpacePolicy(actorPolicy ?? ALL_CAPABILITIES, ceilingFor(room, actor).ceiling);
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
  membership?: PolicyDecision["membership"],
): PolicyDecision {
  const decision: PolicyDecision = {
    allow: false,
    code: "PERMISSION_DENIED",
    capability,
    reason,
    source,
  };
  // #62: which side of the act, on every attributed denial (ceiling ones too).
  decision.party = subject;
  if (source === "actor") decision.subject = subject;
  else if (membership) decision.membership = membership;
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
  ceiling: ResolvedCeiling,
): NonNullable<PolicyDecision["source"]> {
  if (!(actorPolicy ?? ALL_CAPABILITIES)[capability]) return "actor";
  // SPC-07: a room override that set the ceiling is named as the room. A
  // null scope cannot remove anything (it is the open ceiling), so the only
  // way to arrive here with one is a caller bug; "space" is the old answer.
  return ceiling.scope === "room" ? "room" : "space";
}

/** The kernel's sentence for a ceiling denial. Space/non-member keeps its original wording. */
function ceilingReason(
  capability: keyof PermissionPolicy,
  source: "space" | "room",
  membership: ResolvedCeiling["membership"],
): string {
  if (source === "room") {
    return membership === "member"
      ? `This room does not grant members ${capability}.`
      : `This room does not grant non-members ${capability}.`;
  }
  return membership === "member"
    ? `This space does not grant members ${capability}.`
    : `This space does not grant ${capability}.`;
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
  room: PolicyContext["room"],
  actor: { isSpaceMember?: boolean },
): PolicyDecision {
  const ceiling = ceilingFor(room, actor);
  const source = narrowedSource(actorPolicy, capability, ceiling);
  if (source === "actor") {
    const reason =
      subject === "sender" ? `Sender does not have ${capability}.` : `Recipient does not have ${capability}.`;
    return denied(capability, reason, source, subject);
  }
  return denied(capability, ceilingReason(capability, source, ceiling.membership), source, subject, ceiling.membership);
}

/**
 * §5.8a, PRM-06. WHICH mouth to name on the aggregate "no audience left"
 * refusal — the one branch whose test is a disjunction, so no single capability
 * is on its own THE cause.
 *
 * `capability` used to be hard-coded to the canonical `speakToHumans` while
 * `source` was decided by a different question ("did the actor arrive with any
 * mouth at all?"). Each field was right by its own rule and the PAIR was a lie:
 * an agent granted `{speakToAgents: true, speakToHumans: false}` standing in a
 * `public_view` space read as `capability: "speakToHumans", source: "space"` —
 * a capability the actor never held, charged to the space that never took it.
 * Switching to per-capability attribution on that hard-coded name is no better:
 * it says `"actor"`, which sends the owner to a switch that would not have
 * helped, and it is the SPACE that closed the mouth they actually had.
 *
 * The fix is to stop hard-coding the name. Pick the mouth the actor genuinely
 * held and genuinely lost, and the existing per-capability rules (`source`,
 * `reason`) become true of it without any special case — the aggregate answer
 * and the per-capability answer are then the same answer, which is what
 * coherence means here. `speakToHumans` stays canonical wherever it is honest:
 * the actor held it and lost it, or the actor arrived with no mouth at all and
 * so genuinely lacks it.
 *
 *   own SH=true                 -> speakToHumans (canonical; held and removed)
 *   own SH=false, SA=true       -> speakToAgents (the only mouth there was)
 *   own SH=false, SA=false      -> speakToHumans (canonical; never held either)
 */
function mouthThatClosed(actorPolicy: PermissionPolicy | undefined): keyof PermissionPolicy {
  const own = actorPolicy ?? ALL_CAPABILITIES;
  return own.speakToHumans || !own.speakToAgents ? "speakToHumans" : "speakToAgents";
}

export function authorize(input: PolicyContext): AuthorizeResult {
  // A message has no room, whatever a caller passed: it lands in an inbox, and
  // judging it against the room the recipient stands in would let a refusal
  // say which (private) space they are inside.
  let ctx: PolicyContext = input.channel === "message" ? { ...input, room: undefined } : input;
  // A guest is never a member of anything: the most restrictive ceiling, always.
  if (ctx.sender.guest) ctx = { ...ctx, sender: { ...ctx.sender, isSpaceMember: false, policy: undefined } };
  const emit = emitDecision(ctx);
  if (!emit.allow) return { emit, deliveries: [] };

  const deliveries = ctx.recipients.map((r) => ({
    recipientId: r.id,
    decision: deliveryDecision(ctx, r),
  }));
  return { emit, deliveries };
}

/** The only acts a guest pass can perform through the kernel. Following is a door check, not an act. */
const GUEST_CHANNELS: readonly PolicyChannel[] = ["reaction"];

function emitDecision(ctx: PolicyContext): PolicyDecision {
  // A guest reacts and nothing else. Checked before every other rule, the owner
  // channel included: a guest owns no agent and has no mouth.
  if (ctx.sender.guest && !GUEST_CHANNELS.includes(ctx.channel)) {
    return { allow: false, code: "UNAUTHORIZED", reason: "Guests can react and follow. Sign in to do more." };
  }
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

  // A follow notice reports something that already happened: no mouth, no
  // quota. It only refuses where nothing is public to report — an owner's
  // lounge, or an agent nobody has claimed.
  if (ctx.channel === "follow_notice") {
    if (ctx.room?.kind === "owner_lounge") {
      return { allow: false, code: "NOT_FOUND", reason: "Nothing in an owner lounge is reported to followers." };
    }
    if (ctx.sender.kind === "agent" && ctx.sender.claimState !== "claimed") {
      return { allow: false, code: "UNCLAIMED", reason: "Unclaimed agents have no followers to tell." };
    }
    return { allow: true, code: "ALLOW", reason: "Followers may be told." };
  }

  // A message: one addressee, their door, the sender's own mouth, the write
  // limiter. No room and so no ceiling (see authorize()).
  if (ctx.channel === "message") {
    if (ctx.sender.kind === "agent" && ctx.sender.claimState !== "claimed") {
      return { allow: false, code: "UNCLAIMED", reason: "Unclaimed agents cannot leave messages." };
    }
    const target = ctx.recipients.length === 1 ? ctx.recipients[0] : undefined;
    if (!target) return { allow: false, code: "NOT_FOUND", reason: "A message has exactly one recipient." };
    if (ctx.quota.writeRemaining <= 0) {
      return { allow: false, code: "RATE_LIMITED", reason: "Rate limiter exhausted." };
    }
    const addr = assertAddressable(ctx.sender, target);
    if (!addr.allow) return addr;
    const cap: keyof PermissionPolicy = target.kind === "agent" ? "speakToAgents" : "speakToHumans";
    if (ctx.sender.kind === "agent" && ctx.sender.policy && !ctx.sender.policy[cap]) {
      return denied(cap, `Owner has not granted ${cap}.`, "actor", "sender");
    }
    return { allow: true, code: "ALLOW", reason: "Sender may leave a message." };
  }

  if (ctx.sender.kind === "agent" && ctx.sender.claimState !== "claimed") {
    return { allow: false, code: "UNCLAIMED", reason: "Unclaimed agents cannot send public speech." };
  }

  if (ctx.channel === "room_say" && ctx.room && !ctx.room.allowsRoomSay) {
    return { allow: false, code: "ROOM_FORBIDDEN", reason: "This room does not allow public speech." };
  }
  // A room that takes no public lines takes no reactions to them either.
  if (ctx.channel === "reaction" && ctx.room && !ctx.room.allowsRoomSay) {
    return { allow: false, code: "ROOM_FORBIDDEN", reason: "This room does not allow reactions." };
  }
  if (ctx.channel === "whisper" && ctx.room && !ctx.room.allowsWhisper) {
    return { allow: false, code: "ROOM_FORBIDDEN", reason: "This room does not allow whispers." };
  }

  // A reaction is charged to the write limiter only. Sharing the room_say gap
  // would mean a thumbs-up silenced your next line for three seconds.
  // Otherwise, independent named limiters: all must pass. Occupancy is NOT checked here.
  const limited =
    ctx.channel === "reaction"
      ? ctx.quota.writeRemaining <= 0
      : ctx.quota.writeRemaining <= 0 || !ctx.quota.roomSayGapOk || ctx.quota.roomSayRemaining <= 0;
  if (limited) {
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
      return spaceDenied(ctx.sender.policy, cap, "sender", ctx.room, ctx.sender);
    }
    return { allow: true, code: "ALLOW", reason: "Sender may whisper." };
  }

  if (ctx.sender.kind === "agent" && ctx.sender.policy) {
    if (MOUTH_CHANNELS.includes(ctx.channel)) {
      if (!ctx.sender.policy.speakToAgents && !ctx.sender.policy.speakToHumans) {
        return denied("speakToHumans", "Listen-only agents cannot room_say.", "actor", "sender");
      }
    }
  }

  // Space narrowing of the same "no mouth" rule, for every sender kind.
  if (MOUTH_CHANNELS.includes(ctx.channel)) {
    const effective = effectiveCaps(ctx.sender.policy, ctx.room, ctx.sender);
    if (!effective.speakToAgents && !effective.speakToHumans) {
      return spaceDenied(ctx.sender.policy, mouthThatClosed(ctx.sender.policy), "sender", ctx.room, ctx.sender);
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

  if (ctx.channel === "whisper" || ctx.channel === "message") {
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
    return spaceDenied(r.policy, listenCap, "recipient", ctx.room, r);
  }

  // A follow notice is a report of activity, not a line: the sender's mouth is
  // not in question, only whether this follower could have heard it there.
  if (ctx.channel === "follow_notice") {
    return { allow: true, code: "ALLOW", reason: "Follower could hear this in that room." };
  }

  // Mixed-audience: agent room_say without speakToHumans is not delivered to humans or spectators
  // (including the agent's owner, who is a human client).
  if (
    (ctx.channel === "room_say" || ctx.channel === "reaction") &&
    ctx.sender.kind === "agent" &&
    ctx.sender.policy &&
    (r.kind === "human" || r.synthetic === "spectator") &&
    !ctx.sender.policy.speakToHumans
  ) {
    return denied("speakToHumans", "Not delivered to humans.", "actor", "sender");
  }
  if (
    (ctx.channel === "room_say" || ctx.channel === "reaction") &&
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
    return spaceDenied(ctx.sender.policy, speakCap, "sender", ctx.room, ctx.sender);
  }

  return { allow: true, code: "ALLOW", reason: "Recipient may receive this speech act." };
}

/**
 * §5.5, PRM-07. "They have closed their door to you" is the denial that most
 * needs to name whose door it is, and it used to carry `code` and prose alone.
 *
 * Every branch that produces it reads a setting belonging to the RECIPIENT —
 * their `privacy.addressableByAgents`, their `privacy.addressableByHumans`, or
 * their own `lurk` — so the attribution is not a judgement call: `source` is
 * always `"actor"` (no space ceiling is consulted here; `assertAddressable` is
 * reached on channels a space has already let through) and `subject` is always
 * `"recipient"`. Without these a client had no way to tell this apart from its
 * own settings refusing, and the nameplate's "owned by @x" byline points at a
 * door that cannot open it.
 *
 * No `capability`: none of the three settings is a `PermissionPolicy` key, and
 * borrowing an actor-shaped name for a privacy flag is exactly the confusion
 * PRM-06 was. The code itself already says what closed.
 */
function notAddressable(reason: string): PolicyDecision {
  return {
    allow: false,
    code: "NOT_ADDRESSABLE",
    reason,
    source: "actor",
    subject: "recipient",
    party: "recipient",
  };
}

/** Unexported. Used for whisper (P2), message and directed notice. Both sender kinds. */
function assertAddressable(
  sender: PolicyContext["sender"],
  target: PolicyContext["recipients"][number],
): PolicyDecision {
  // BLOCKED stays unattributed: a block is mutual by design and the code does
  // not disclose which side set it. Only the NOT_ADDRESSABLE branches are the
  // recipient's own door.
  if (target.blocked) return { allow: false, code: "BLOCKED", reason: "Blocked." };
  if (target.kind === "human" && target.lurk) {
    return notAddressable("Human is lurking.");
  }
  const priv = target.privacy as import("@grove/protocol").PrivacyPolicy | undefined;
  if (priv) {
    if (sender.kind === "agent" && priv.addressableByAgents === false) {
      return notAddressable("Not addressable by agents.");
    }
    if (sender.kind === "human" && priv.addressableByHumans === false) {
      return notAddressable("Not addressable by humans.");
    }
  }
  return { allow: true, code: "ALLOW", reason: "Addressable." };
}

/** One capability, as it stands for one actor in one room or space (#62). */
export interface CapabilityVerdict {
  allowed: boolean;
  /** Who removed it, by the kernel's own attribution rule. Absent when allowed. */
  source?: "actor" | "space" | "room";
  /** Set with `source: "space" | "room"`: the members' ceiling or the visitors'. */
  membership?: ResolvedCeiling["membership"];
  /**
   * What the ceiling alone says, whatever the actor holds. Lets a UI say "your
   * setting — and the space would not allow it either" without re-deriving it.
   */
  ceilingAllows: boolean;
}

export type CapabilityVerdicts = Record<keyof PermissionPolicy, CapabilityVerdict>;

const CAPABILITY_KEYS: ReadonlyArray<keyof PermissionPolicy> = [
  "speakToAgents",
  "speakToHumans",
  "listenToAgents",
  "listenToHumans",
];

/**
 * #62 — effective = actor ∩ ceiling for all four capabilities, attributed the
 * way `authorize()` attributes a ceiling denial (`narrowedSource`, the same
 * function), so the owner's Settings page and an actual refusal can never
 * disagree about who closed a capability.
 *
 * `layers` is `PolicyContext["room"]`'s ceiling half; undefined narrows
 * nothing (the commons). Membership must be pre-fetched, as for `authorize`.
 */
export function explainCapabilities(
  actorPolicy: PermissionPolicy | undefined,
  layers: CeilingLayersInput,
  isMember: boolean,
): CapabilityVerdicts {
  const ceiling = resolveCeiling(layers, isMember);
  const own = actorPolicy ?? ALL_CAPABILITIES;
  const out = {} as CapabilityVerdicts;
  for (const cap of CAPABILITY_KEYS) {
    const ceilingAllows = ceiling.ceiling[cap];
    if (own[cap] && ceilingAllows) {
      out[cap] = { allowed: true, ceilingAllows };
      continue;
    }
    const source = narrowedSource(actorPolicy, cap, ceiling);
    out[cap] =
      source === "actor"
        ? { allowed: false, source, ceilingAllows }
        : { allowed: false, source, membership: ceiling.membership, ceilingAllows };
  }
  return out;
}

type CeilingLayersInput = Parameters<typeof resolveCeiling>[0];
