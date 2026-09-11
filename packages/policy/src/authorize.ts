import type {
  AuthorizeResult,
  PermissionPolicy,
  PolicyContext,
  PolicyDecision,
  SpeechChannel,
} from "@grove/protocol";

const OWNER_CHANNELS: SpeechChannel[] = ["owner_instruction", "owner_reply"];

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
    if (ctx.sender.kind === "agent" && ctx.sender.policy) {
      const cap: keyof PermissionPolicy = target.kind === "agent" ? "speakToAgents" : "speakToHumans";
      if (!ctx.sender.policy[cap]) {
        return { allow: false, code: "PERMISSION_DENIED", capability: cap, reason: `Owner has not granted ${cap}.` };
      }
    }
    return { allow: true, code: "ALLOW", reason: "Sender may whisper." };
  }

  if (ctx.sender.kind === "agent" && ctx.sender.policy) {
    if (ctx.channel === "room_say" || ctx.channel === "notice") {
      if (!ctx.sender.policy.speakToAgents && !ctx.sender.policy.speakToHumans) {
        return {
          allow: false,
          code: "PERMISSION_DENIED",
          capability: "speakToHumans",
          reason: "Listen-only agents cannot room_say.",
        };
      }
    }
  }

  return { allow: true, code: "ALLOW", reason: "Sender may emit this speech act." };
}

function deliveryDecision(
  ctx: PolicyContext,
  r: PolicyContext["recipients"][number],
): PolicyDecision {
  // Owner short-circuit ONLY on owner channels. room_say to your owner is mixed-audience.
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
  if (ctx.channel === "room_say" && ctx.sender.privacy) {
    const priv = ctx.sender.privacy as import("@grove/protocol").PrivacyPolicy;
    if (r.kind === "agent" && priv.overhearableByAgents === false) {
      return {
        allow: false,
        code: "PERMISSION_DENIED",
        capability: "listenToHumans",
        reason: "Speaker is not overhearable by agents.",
      };
    }
    if (r.kind === "human" && "overhearableByHumans" in priv && priv.overhearableByHumans === false) {
      return {
        allow: false,
        code: "PERMISSION_DENIED",
        capability: "speakToHumans",
        reason: "Speaker is not overhearable by humans.",
      };
    }
  }

  if (r.kind === "agent" && r.policy) {
    const cap: keyof PermissionPolicy = ctx.sender.kind === "agent" ? "listenToAgents" : "listenToHumans";
    if (!r.policy[cap]) {
      return { allow: false, code: "PERMISSION_DENIED", capability: cap, reason: `Recipient does not have ${cap}.` };
    }
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
    return { allow: false, code: "PERMISSION_DENIED", capability: "speakToHumans", reason: "Not delivered to humans." };
  }
  if (
    ctx.channel === "room_say" &&
    ctx.sender.kind === "agent" &&
    ctx.sender.policy &&
    r.kind === "agent" &&
    !ctx.sender.policy.speakToAgents
  ) {
    return { allow: false, code: "PERMISSION_DENIED", capability: "speakToAgents", reason: "Not delivered to agents." };
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
