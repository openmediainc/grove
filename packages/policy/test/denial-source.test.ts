import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_AGENT_PRIVACY,
  spacePolicyForPreset,
  type PermissionPolicy,
  type PolicyContext,
  type PolicyDecision,
  type QuotaSnapshot,
  type SpacePolicy,
  type SpacePolicyPreset,
} from "@grove/protocol";
import { authorize } from "../src/authorize.js";

/**
 * §5.5 — permission state must be socially readable.
 *
 * `capability` cannot say WHO refused: a space denial has to borrow an
 * actor-shaped capability name, so "your owner has not granted this" and "this
 * space does not allow it" arrive at the UI looking identical. `source` is the
 * machine-readable half of that sentence. These tests pin it down.
 */

const quota: QuotaSnapshot = {
  roomSayRemaining: 8,
  roomSayGapOk: true,
  writeRemaining: 30,
  roomWindowCount: 0,
};

const plaza = {
  id: "plaza",
  kind: "public" as const,
  allowsRoomSay: true,
  allowsWhisper: true,
  sayLimitPerMin: null as number | null,
  capacity: 80,
};

const LISTEN_ONLY: PermissionPolicy = {
  speakToAgents: false,
  speakToHumans: false,
  listenToAgents: true,
  listenToHumans: true,
};

/**
 * A ceiling no preset offers: the space keeps agent-to-agent speech open but
 * closes the human ear. Presets are data (§5.3), so a route may resolve any
 * SpacePolicy; this one isolates ONE capability so a space denial and an actor
 * denial can be compared at the same `capability`.
 */
const HUMANS_MUTED_CEILING: SpacePolicy = {
  speakToAgents: true,
  speakToHumans: false,
  listenToAgents: true,
  listenToHumans: true,
};

function agentSender(opts: { policy?: PermissionPolicy; isSpaceMember?: boolean; privacy?: unknown } = {}) {
  return {
    id: "agt_sender",
    kind: "agent" as const,
    ownerHumanId: "hum_owner",
    claimState: "claimed" as const,
    policy: opts.policy ?? DEFAULT_AGENT_POLICY,
    privacy: (opts.privacy ?? DEFAULT_AGENT_PRIVACY) as PolicyContext["sender"]["privacy"],
    isSpaceMember: opts.isSpaceMember,
  };
}

function humanSender(opts: { isSpaceMember?: boolean; privacy?: unknown } = {}) {
  return {
    id: "hum_sender",
    kind: "human" as const,
    privacy: (opts.privacy ?? { overhearableByAgents: true }) as PolicyContext["sender"]["privacy"],
    isSpaceMember: opts.isSpaceMember,
  };
}

function humanRecipient(opts: { isSpaceMember?: boolean } = {}): PolicyContext["recipients"][number] {
  return {
    id: "hum_recipient",
    kind: "human",
    lurk: false,
    privacy: { overhearableByAgents: true },
    blocked: false,
    mutedByRecipient: false,
    isSpaceMember: opts.isSpaceMember,
  };
}

function agentRecipient(opts: { policy?: PermissionPolicy; isSpaceMember?: boolean } = {}): PolicyContext["recipients"][number] {
  return {
    id: "agt_recipient",
    kind: "agent",
    ownerHumanId: "hum_other",
    policy: opts.policy ?? DEFAULT_AGENT_POLICY,
    privacy: DEFAULT_AGENT_PRIVACY,
    blocked: false,
    mutedByRecipient: false,
    isSpaceMember: opts.isSpaceMember,
  };
}

function room(policy?: SpacePolicy) {
  return policy ? { ...plaza, policy } : { ...plaza };
}

// ---------------------------------------------------------------------------
// 1. Denials from the actor's own four booleans
// ---------------------------------------------------------------------------

describe("source: actor — the actor's own capability matrix refused", () => {
  it("listen-only agent room_say emit", () => {
    const res = authorize({
      sender: agentSender({ policy: LISTEN_ONLY }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.code).toBe("PERMISSION_DENIED");
    expect(res.emit.capability).toBe("speakToHumans");
    expect(res.emit.source).toBe("actor");
  });

  it("whisper the owner never granted", () => {
    const res = authorize({
      sender: agentSender({ policy: { ...DEFAULT_AGENT_POLICY, speakToAgents: false } }),
      recipients: [agentRecipient()],
      channel: "whisper",
      requestedTargetId: "agt_recipient",
      room: room(),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.code).toBe("PERMISSION_DENIED");
    expect(res.emit.capability).toBe("speakToAgents");
    expect(res.emit.source).toBe("actor");
  });

  it("recipient's own ear is shut", () => {
    const res = authorize({
      sender: agentSender(),
      recipients: [agentRecipient({ policy: { ...DEFAULT_AGENT_POLICY, listenToAgents: false } })],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    });
    const d = res.deliveries[0]?.decision;
    expect(d?.capability).toBe("listenToAgents");
    expect(d?.source).toBe("actor");
  });

  it("mixed-audience: agent without speakToHumans is not delivered to a human", () => {
    const res = authorize({
      sender: agentSender({ policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false } }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    });
    const d = res.deliveries[0]?.decision;
    expect(d?.capability).toBe("speakToHumans");
    expect(d?.source).toBe("actor");
  });

  it("mixed-audience: agent without speakToAgents is not delivered to an agent", () => {
    const res = authorize({
      sender: agentSender({ policy: { ...DEFAULT_AGENT_POLICY, speakToAgents: false } }),
      recipients: [agentRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    });
    const d = res.deliveries[0]?.decision;
    expect(d?.capability).toBe("speakToAgents");
    expect(d?.source).toBe("actor");
  });

  it("a mouthless sender in a private space is still the ACTOR's denial, not the space's", () => {
    // The space would have denied too, but the actor arrived with no mouth at
    // all: telling this owner "the space refused you" would be a lie.
    const res = authorize({
      sender: agentSender({ policy: LISTEN_ONLY }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.code).toBe("PERMISSION_DENIED");
    expect(res.emit.source).toBe("actor");
  });

  it("a human sender carrying a mouthless matrix is the actor's own denial", () => {
    // Humans normally carry no matrix (§5.1), so this reaches the aggregate
    // "no audience left" branch rather than the agent-only listen-only branch.
    const res = authorize({
      sender: { ...humanSender(), policy: LISTEN_ONLY },
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("public_write")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.code).toBe("PERMISSION_DENIED");
    expect(res.emit.capability).toBe("speakToHumans");
    expect(res.emit.source).toBe("actor");
  });
});

// ---------------------------------------------------------------------------
// 2. Denials from the space ceiling
// ---------------------------------------------------------------------------

describe("source: space — the space's ceiling refused", () => {
  it("fully-capable agent in a private space (emit)", () => {
    const res = authorize({
      sender: agentSender({ isSpaceMember: false }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.code).toBe("PERMISSION_DENIED");
    expect(res.emit.capability).toBe("speakToHumans");
    expect(res.emit.source).toBe("space");
  });

  it("a human, who has no matrix of their own, can only ever be denied by the space", () => {
    const res = authorize({
      sender: humanSender({ isSpaceMember: false }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("public_view")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.code).toBe("PERMISSION_DENIED");
    expect(res.emit.source).toBe("space");
  });

  it("whisper blocked by a private space", () => {
    const res = authorize({
      sender: agentSender({ isSpaceMember: false }),
      recipients: [humanRecipient()],
      channel: "whisper",
      requestedTargetId: "hum_recipient",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.code).toBe("PERMISSION_DENIED");
    expect(res.emit.capability).toBe("speakToHumans");
    expect(res.emit.source).toBe("space");
  });

  it("a non-member's ear is shut by the space, not by the listener", () => {
    const res = authorize({
      sender: agentSender({ isSpaceMember: true }),
      recipients: [humanRecipient({ isSpaceMember: false })],
      channel: "room_say",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    const d = res.deliveries[0]?.decision;
    expect(d?.code).toBe("PERMISSION_DENIED");
    expect(d?.capability).toBe("listenToAgents");
    expect(d?.source).toBe("space");
  });

  it("the same listener denied by their OWN matrix reads as actor, in the same space", () => {
    const res = authorize({
      sender: agentSender({ isSpaceMember: true }),
      recipients: [
        agentRecipient({ policy: { ...DEFAULT_AGENT_POLICY, listenToAgents: false }, isSpaceMember: true }),
      ],
      channel: "room_say",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    const d = res.deliveries[0]?.decision;
    expect(d?.capability).toBe("listenToAgents");
    expect(d?.source).toBe("actor");
  });
});

// ---------------------------------------------------------------------------
// 3. Privacy denials are the actor's own setting
// ---------------------------------------------------------------------------

describe("source: actor — speaker privacy", () => {
  it("a human who is not overhearable by agents", () => {
    const res = authorize({
      sender: humanSender({ privacy: { overhearableByAgents: false } }),
      recipients: [agentRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    });
    const d = res.deliveries[0]?.decision;
    expect(d?.code).toBe("PERMISSION_DENIED");
    expect(d?.capability).toBe("listenToHumans");
    expect(d?.source).toBe("actor");
  });

  it("an agent who is not overhearable by humans", () => {
    const res = authorize({
      sender: agentSender({ privacy: { ...DEFAULT_AGENT_PRIVACY, overhearableByHumans: false } }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    });
    const d = res.deliveries[0]?.decision;
    expect(d?.code).toBe("PERMISSION_DENIED");
    expect(d?.capability).toBe("speakToHumans");
    expect(d?.source).toBe("actor");
  });

  it("speaker privacy inside a private space is still the speaker's own setting", () => {
    const res = authorize({
      sender: agentSender({
        isSpaceMember: true,
        privacy: { ...DEFAULT_AGENT_PRIVACY, overhearableByHumans: false },
      }),
      recipients: [humanRecipient({ isSpaceMember: true })],
      channel: "room_say",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.deliveries[0]?.decision.source).toBe("actor");
  });
});

// ---------------------------------------------------------------------------
// 4. THE DISCRIMINATION — same pair, same capability, different source
// ---------------------------------------------------------------------------

describe("actor vs space actually discriminates", () => {
  it("the same sender/recipient pair, denied at the same capability, reports different sources (delivery)", () => {
    const byActor = authorize({
      sender: agentSender({ policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false } }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    }).deliveries[0];

    const bySpace = authorize({
      sender: agentSender({ policy: DEFAULT_AGENT_POLICY }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(HUMANS_MUTED_CEILING),
      quota,
      isOwnerChannel: false,
    }).deliveries[0];

    // Same people.
    expect(byActor?.recipientId).toBe(bySpace?.recipientId);
    expect(byActor?.recipientId).toBe("hum_recipient");
    // Indistinguishable on every field the API had BEFORE `source`.
    expect(byActor?.decision.allow).toBe(false);
    expect(bySpace?.decision.allow).toBe(false);
    expect(byActor?.decision.code).toBe("PERMISSION_DENIED");
    expect(bySpace?.decision.code).toBe("PERMISSION_DENIED");
    expect(byActor?.decision.capability).toBe("speakToHumans");
    expect(bySpace?.decision.capability).toBe("speakToHumans");
    // Distinguishable now.
    expect(byActor?.decision.source).toBe("actor");
    expect(bySpace?.decision.source).toBe("space");
    expect(byActor?.decision.source).not.toBe(bySpace?.decision.source);
  });

  it("the same sender/recipient pair, denied at the same capability, reports different sources (emit)", () => {
    const byActor = authorize({
      sender: agentSender({ policy: LISTEN_ONLY }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    }).emit;

    const bySpace = authorize({
      sender: agentSender({ policy: DEFAULT_AGENT_POLICY }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    }).emit;

    expect(byActor.code).toBe(bySpace.code);
    expect(byActor.capability).toBe(bySpace.capability);
    expect(byActor.capability).toBe("speakToHumans");
    expect(byActor.source).toBe("actor");
    expect(bySpace.source).toBe("space");
  });

  it("`reason` agrees with `source`: an actor denial no longer blames a space that is not there", () => {
    // Was: this site returned "This space does not grant speakToHumans." on a
    // non-room_say channel with NO space policy at all, so the prose blamed a
    // space that did not exist while `source` said "actor". Both halves of the
    // sentence are now derived from the same test, so they cannot disagree.
    const res = authorize({
      sender: agentSender({ policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false } }),
      recipients: [humanRecipient()],
      channel: "notice",
      room: room(),
      quota,
      isOwnerChannel: false,
    });
    const d = res.deliveries[0]?.decision;
    expect(d?.source).toBe("actor");
    expect(d?.reason).toBe("Sender does not have speakToHumans.");
    expect(d?.reason).not.toContain("space");

    // ...and when a space really is the cause, the same site still says so.
    const bySpace = authorize({
      sender: agentSender({ policy: DEFAULT_AGENT_POLICY, isSpaceMember: false }),
      recipients: [humanRecipient({ isSpaceMember: false })],
      channel: "notice",
      room: room(HUMANS_MUTED_CEILING),
      quota,
      isOwnerChannel: false,
    });
    const sd = bySpace.deliveries[0]?.decision;
    expect(sd?.source).toBe("space");
    expect(sd?.reason).toBe("This space does not grant speakToHumans.");
  });
});

// ---------------------------------------------------------------------------
// 5. `source` is absent everywhere else
// ---------------------------------------------------------------------------

describe("source is absent on ALLOW and on every non-permission code", () => {
  const cases: Array<{ code: string; where: "emit" | "delivery"; ctx: PolicyContext }> = [
    {
      code: "ALLOW",
      where: "emit",
      ctx: {
        sender: agentSender(),
        recipients: [humanRecipient()],
        channel: "room_say",
        room: room(),
        quota,
        isOwnerChannel: false,
      },
    },
    {
      code: "ALLOW",
      where: "delivery",
      ctx: {
        sender: agentSender(),
        recipients: [humanRecipient()],
        channel: "room_say",
        room: room(spacePolicyForPreset("public_write")),
        quota,
        isOwnerChannel: false,
      },
    },
    {
      code: "BLOCKED",
      where: "delivery",
      ctx: {
        // Member sender, so the emit survives the private ceiling and a
        // delivery decision is actually produced.
        sender: agentSender({ isSpaceMember: true }),
        recipients: [{ ...humanRecipient(), blocked: true }],
        channel: "room_say",
        room: room(spacePolicyForPreset("private")),
        quota,
        isOwnerChannel: false,
      },
    },
    {
      code: "MUTED",
      where: "delivery",
      ctx: {
        sender: agentSender({ isSpaceMember: true }),
        recipients: [{ ...humanRecipient(), mutedByRecipient: true }],
        channel: "room_say",
        room: room(spacePolicyForPreset("private")),
        quota,
        isOwnerChannel: false,
      },
    },
    {
      code: "RATE_LIMITED",
      where: "emit",
      ctx: {
        sender: agentSender(),
        recipients: [humanRecipient()],
        channel: "room_say",
        room: room(spacePolicyForPreset("private")),
        quota: { ...quota, writeRemaining: 0 },
        isOwnerChannel: false,
      },
    },
    {
      code: "ROOM_FORBIDDEN",
      where: "emit",
      ctx: {
        sender: agentSender(),
        recipients: [humanRecipient()],
        channel: "room_say",
        room: { ...plaza, allowsRoomSay: false, policy: spacePolicyForPreset("private") },
        quota,
        isOwnerChannel: false,
      },
    },
    {
      code: "UNCLAIMED",
      where: "emit",
      ctx: {
        sender: { ...agentSender(), claimState: "pending" as const },
        recipients: [humanRecipient()],
        channel: "room_say",
        room: room(spacePolicyForPreset("private")),
        quota,
        isOwnerChannel: false,
      },
    },
    {
      code: "NOT_FOUND",
      where: "emit",
      ctx: {
        sender: agentSender(),
        recipients: [humanRecipient(), { ...humanRecipient(), id: "hum_other" }],
        channel: "owner_reply",
        room: room(),
        quota,
        isOwnerChannel: true,
      },
    },
    {
      code: "NOT_ADDRESSABLE",
      where: "emit",
      ctx: {
        sender: agentSender(),
        recipients: [{ ...humanRecipient(), lurk: true }],
        channel: "whisper",
        requestedTargetId: "hum_recipient",
        room: room(),
        quota,
        isOwnerChannel: false,
      },
    },
  ];

  for (const c of cases) {
    it(`${c.code} (${c.where}) carries no source`, () => {
      const res = authorize(c.ctx);
      const d: PolicyDecision | undefined =
        c.where === "emit" ? res.emit : res.deliveries[0]?.decision;
      expect(d?.code).toBe(c.code);
      expect(d).not.toHaveProperty("source");
      expect(d?.source).toBeUndefined();
    });
  }

  it("owner-channel ALLOW inside a private space carries no source", () => {
    const res = authorize({
      sender: agentSender({ policy: LISTEN_ONLY, isSpaceMember: false }),
      recipients: [{ ...humanRecipient(), id: "hum_owner" }],
      channel: "owner_reply",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: true,
    });
    expect(res.emit).not.toHaveProperty("source");
    expect(res.deliveries[0]?.decision).not.toHaveProperty("source");
  });
});

// ---------------------------------------------------------------------------
// 6. The property: source is load-bearing, not decorative
// ---------------------------------------------------------------------------

function allPolicies(): PermissionPolicy[] {
  const out: PermissionPolicy[] = [];
  for (const speakToAgents of [false, true]) {
    for (const speakToHumans of [false, true]) {
      for (const listenToAgents of [false, true]) {
        for (const listenToHumans of [false, true]) {
          out.push({ speakToAgents, speakToHumans, listenToAgents, listenToHumans });
        }
      }
    }
  }
  return out;
}

const KIND_PAIRS: Array<{ senderKind: "agent" | "human"; recipientKind: "agent" | "human" }> = [
  { senderKind: "agent", recipientKind: "agent" },
  { senderKind: "agent", recipientKind: "human" },
  { senderKind: "human", recipientKind: "agent" },
  { senderKind: "human", recipientKind: "human" },
];

const SPACE_OPTIONS: Array<SpacePolicyPreset | null> = [null, "private", "public_view", "public_write"];

function matrixCtx(opts: {
  space: SpacePolicyPreset | null;
  senderKind: "agent" | "human";
  recipientKind: "agent" | "human";
  senderPolicy: PermissionPolicy;
  recipientPolicy: PermissionPolicy;
  senderIsMember: boolean;
  recipientIsMember: boolean;
  channel: PolicyContext["channel"];
}): PolicyContext {
  const r =
    opts.recipientKind === "agent"
      ? agentRecipient({ policy: opts.recipientPolicy, isSpaceMember: opts.recipientIsMember })
      : humanRecipient({ isSpaceMember: opts.recipientIsMember });
  return {
    sender:
      opts.senderKind === "agent"
        ? agentSender({ policy: opts.senderPolicy, isSpaceMember: opts.senderIsMember })
        : humanSender({ isSpaceMember: opts.senderIsMember }),
    recipients: [r],
    channel: opts.channel,
    requestedTargetId: opts.channel === "whisper" ? r.id : null,
    room: opts.space ? { ...plaza, policy: spacePolicyForPreset(opts.space) } : { ...plaza },
    quota,
    isOwnerChannel: false,
  };
}

function withoutSpace(ctx: PolicyContext): PolicyContext {
  if (!ctx.room) return ctx;
  const r = { ...ctx.room };
  delete r.policy;
  return { ...ctx, room: r };
}

describe("source — invariants over the whole matrix", () => {
  const channels: Array<PolicyContext["channel"]> = ["room_say", "whisper", "notice"];

  it("source is present EXACTLY on PERMISSION_DENIED, and is always one of the two literals", () => {
    let denials = 0;
    let others = 0;
    for (const { senderKind, recipientKind } of KIND_PAIRS) {
      for (const senderPolicy of allPolicies()) {
        for (const recipientPolicy of allPolicies()) {
          for (const space of SPACE_OPTIONS) {
            for (const senderIsMember of [false, true]) {
              for (const recipientIsMember of [false, true]) {
                for (const channel of channels) {
                  const res = authorize(
                    matrixCtx({
                      space,
                      senderKind,
                      recipientKind,
                      senderPolicy,
                      recipientPolicy,
                      senderIsMember,
                      recipientIsMember,
                      channel,
                    }),
                  );
                  for (const d of [res.emit, ...res.deliveries.map((x) => x.decision)]) {
                    expect(d.code).not.toBe("ROOM_FULL");
                    if (d.code === "PERMISSION_DENIED") {
                      expect(["actor", "space"]).toContain(d.source);
                      denials += 1;
                    } else {
                      expect(d.source, `${d.code} leaked a source`).toBeUndefined();
                      expect(Object.prototype.hasOwnProperty.call(d, "source")).toBe(false);
                      others += 1;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    // Both arms are actually exercised — neither branch is vacuous.
    expect(denials).toBeGreaterThan(0);
    expect(others).toBeGreaterThan(0);
  });

  it("a 'space' denial always disappears when the space policy is removed, and an 'actor' denial never does", () => {
    // This is what makes the field meaningful rather than decorative: the label
    // has to match what a counterfactual world without the space ceiling does.
    let spaceChecked = 0;
    let actorChecked = 0;
    for (const { senderKind, recipientKind } of KIND_PAIRS) {
      for (const senderPolicy of allPolicies()) {
        for (const recipientPolicy of allPolicies()) {
          for (const space of SPACE_OPTIONS) {
            for (const senderIsMember of [false, true]) {
              for (const recipientIsMember of [false, true]) {
                for (const channel of channels) {
                  const ctx = matrixCtx({
                    space,
                    senderKind,
                    recipientKind,
                    senderPolicy,
                    recipientPolicy,
                    senderIsMember,
                    recipientIsMember,
                    channel,
                  });
                  const withSpace = authorize(ctx);
                  const bare = authorize(withoutSpace(ctx));
                  const where = `${space ?? "none"} ${senderKind}->${recipientKind} ${channel} sp=${JSON.stringify(senderPolicy)}`;

                  if (withSpace.emit.code === "PERMISSION_DENIED") {
                    if (withSpace.emit.source === "space") {
                      expect(bare.emit, `emit blamed the space but the space was not load-bearing: ${where}`).not.toEqual(withSpace.emit);
                      spaceChecked += 1;
                    } else {
                      expect(bare.emit, `emit blamed the actor but the denial needed the space: ${where}`).toEqual(withSpace.emit);
                      actorChecked += 1;
                    }
                  }

                  for (const d of withSpace.deliveries) {
                    if (d.decision.code !== "PERMISSION_DENIED") continue;
                    const bareDecision = bare.deliveries.find((x) => x.recipientId === d.recipientId)?.decision;
                    if (d.decision.source === "space") {
                      expect(bareDecision, `delivery blamed the space but the space was not load-bearing: ${where}`).not.toEqual(d.decision);
                      spaceChecked += 1;
                    } else {
                      expect(bareDecision, `delivery blamed the actor but the denial needed the space: ${where}`).toEqual(d.decision);
                      actorChecked += 1;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(spaceChecked).toBeGreaterThan(0);
    expect(actorChecked).toBeGreaterThan(0);
  });
});
