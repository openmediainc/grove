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
 * §5.5 — `source` says WHICH CEILING refused; `subject` says WHICH ACTOR.
 *
 * `capability` cannot stand in for it: a denial is named after the capability it
 * closed, which for speaker privacy is the RECIPIENT's ear (`listenToHumans`)
 * even though the setting that refused is the SENDER's own privacy. So a UI that
 * reads `source: "actor"` as "your setting" is wrong roughly half the time.
 *
 * The rule these tests pin: `subject` names the party whose stored setting the
 * branch actually read — never the party the capability is shaped like.
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

/** Isolates one capability, so an actor denial and a space denial can be compared at it. */
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

function agentRecipient(
  opts: { policy?: PermissionPolicy; isSpaceMember?: boolean } = {},
): PolicyContext["recipients"][number] {
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
// 1. The case `capability` gets backwards: speaker privacy
// ---------------------------------------------------------------------------

describe("subject: sender — the speaker's own setting refused", () => {
  it("a human not overhearable by agents is denied at the RECIPIENT's capability but is the SENDER's doing", () => {
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
    // The capability names the ear that closed...
    expect(d?.capability).toBe("listenToHumans");
    expect(d?.source).toBe("actor");
    // ...but the setting that refused belongs to the speaker.
    expect(d?.subject).toBe("sender");
  });

  it("an agent not overhearable by humans attributes to the sender", () => {
    const res = authorize({
      sender: agentSender({ privacy: { ...DEFAULT_AGENT_PRIVACY, overhearableByHumans: false } }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    });
    expect(res.deliveries[0]?.decision.subject).toBe("sender");
  });

  it("speaker privacy inside a private space is still the speaker, not the space", () => {
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
    const d = res.deliveries[0]?.decision;
    expect(d?.source).toBe("actor");
    expect(d?.subject).toBe("sender");
  });

  it("the sender's own matrix: listen-only emit, mixed-audience delivery, and whisper", () => {
    const emit = authorize({
      sender: agentSender({ policy: LISTEN_ONLY }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    }).emit;
    expect(emit.subject).toBe("sender");

    const mixed = authorize({
      sender: agentSender({ policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false } }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    }).deliveries[0]?.decision;
    expect(mixed?.capability).toBe("speakToHumans");
    expect(mixed?.subject).toBe("sender");

    const whisper = authorize({
      sender: agentSender({ policy: { ...DEFAULT_AGENT_POLICY, speakToAgents: false } }),
      recipients: [agentRecipient()],
      channel: "whisper",
      requestedTargetId: "agt_recipient",
      room: room(),
      quota,
      isOwnerChannel: false,
    }).emit;
    expect(whisper.subject).toBe("sender");
  });
});

// ---------------------------------------------------------------------------
// 2. The recipient's own ear
// ---------------------------------------------------------------------------

describe("subject: recipient — the listener's own setting refused", () => {
  it("an agent recipient who has closed listenToAgents attributes to the recipient", () => {
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
    expect(d?.subject).toBe("recipient");
  });

  it("the same closed ear inside a private space is still the recipient's own doing", () => {
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
    expect(res.deliveries[0]?.decision.subject).toBe("recipient");
  });
});

// ---------------------------------------------------------------------------
// 3. THE DISCRIMINATION — same code, same source, same capability, different actor
// ---------------------------------------------------------------------------

describe("subject actually discriminates", () => {
  it("two denials identical on every pre-existing field name different actors", () => {
    // Speaker privacy: the SENDER's privacy shuts an agent's ear.
    const bySender = authorize({
      sender: humanSender({ privacy: { overhearableByAgents: false } }),
      recipients: [agentRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    }).deliveries[0]?.decision;

    // Recipient policy: the RECIPIENT's own matrix shuts the same ear, at the
    // same capability, for the same sender kind (human → listenToHumans).
    const byRecipient = authorize({
      sender: humanSender(),
      recipients: [agentRecipient({ policy: { ...DEFAULT_AGENT_POLICY, listenToHumans: false } })],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    }).deliveries[0]?.decision;

    // Indistinguishable on every field the API had before `subject`.
    expect(bySender?.code).toBe("PERMISSION_DENIED");
    expect(byRecipient?.code).toBe("PERMISSION_DENIED");
    expect(bySender?.capability).toBe("listenToHumans");
    expect(byRecipient?.capability).toBe("listenToHumans");
    expect(bySender?.source).toBe("actor");
    expect(byRecipient?.source).toBe("actor");
    // Distinguishable now.
    expect(bySender?.subject).toBe("sender");
    expect(byRecipient?.subject).toBe("recipient");
    expect(bySender?.subject).not.toBe(byRecipient?.subject);
  });
});

// ---------------------------------------------------------------------------
// 4. Absent whenever no actor is at fault
// ---------------------------------------------------------------------------

describe("subject is absent when the SPACE is the cause", () => {
  it("a fully-capable agent refused by a private space (emit) names no actor", () => {
    const res = authorize({
      sender: agentSender({ isSpaceMember: false }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.source).toBe("space");
    expect(res.emit).not.toHaveProperty("subject");
    expect(res.emit.subject).toBeUndefined();
  });

  it("a non-member's ear shut by the space (delivery) names no actor", () => {
    const res = authorize({
      sender: agentSender({ isSpaceMember: true }),
      recipients: [humanRecipient({ isSpaceMember: false })],
      channel: "room_say",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    const d = res.deliveries[0]?.decision;
    expect(d?.source).toBe("space");
    expect(d).not.toHaveProperty("subject");
  });

  it("a sender's mouth shut by the space on a non-room_say channel names no actor", () => {
    const res = authorize({
      sender: agentSender({ isSpaceMember: false }),
      recipients: [humanRecipient({ isSpaceMember: false })],
      channel: "notice",
      room: room(HUMANS_MUTED_CEILING),
      quota,
      isOwnerChannel: false,
    });
    const d = res.deliveries[0]?.decision;
    expect(d?.source).toBe("space");
    expect(d).not.toHaveProperty("subject");
  });

  it("a human, who carries no matrix, is only ever refused by the space and so names no actor", () => {
    const res = authorize({
      sender: humanSender({ isSpaceMember: false }),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("public_view")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.source).toBe("space");
    expect(res.emit).not.toHaveProperty("subject");
  });
});

describe("subject is absent on ALLOW and on every non-permission code", () => {
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
        recipients: [agentRecipient()],
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
        sender: agentSender({ isSpaceMember: true }),
        recipients: [{ ...humanRecipient(), blocked: true }],
        channel: "room_say",
        room: room(),
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
        room: room(),
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
        room: room(),
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
        room: { ...plaza, allowsRoomSay: false },
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
        room: room(),
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
    it(`${c.code} (${c.where}) carries no subject`, () => {
      const res = authorize(c.ctx);
      const d: PolicyDecision | undefined = c.where === "emit" ? res.emit : res.deliveries[0]?.decision;
      expect(d?.code).toBe(c.code);
      expect(d).not.toHaveProperty("subject");
      expect(d?.subject).toBeUndefined();
    });
  }

  it("owner-channel ALLOW inside a private space carries no subject", () => {
    const res = authorize({
      sender: agentSender({ policy: LISTEN_ONLY, isSpaceMember: false }),
      recipients: [{ ...humanRecipient(), id: "hum_owner" }],
      channel: "owner_reply",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: true,
    });
    expect(res.emit).not.toHaveProperty("subject");
    expect(res.deliveries[0]?.decision).not.toHaveProperty("subject");
  });
});

// ---------------------------------------------------------------------------
// 5. Invariants over the whole matrix
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

const OVERHEARABLE = [true, false] as const;

function matrixCtx(opts: {
  space: SpacePolicyPreset | null;
  senderKind: "agent" | "human";
  recipientKind: "agent" | "human";
  senderPolicy: PermissionPolicy;
  recipientPolicy: PermissionPolicy;
  senderOverhearable: boolean;
  channel: PolicyContext["channel"];
}): PolicyContext {
  const r =
    opts.recipientKind === "agent"
      ? agentRecipient({ policy: opts.recipientPolicy })
      : humanRecipient();
  return {
    sender:
      opts.senderKind === "agent"
        ? agentSender({
            policy: opts.senderPolicy,
            privacy: {
              ...DEFAULT_AGENT_PRIVACY,
              overhearableByAgents: opts.senderOverhearable,
              overhearableByHumans: opts.senderOverhearable,
            },
          })
        : humanSender({ privacy: { overhearableByAgents: opts.senderOverhearable } }),
    recipients: [r],
    channel: opts.channel,
    requestedTargetId: opts.channel === "whisper" ? r.id : null,
    room: opts.space ? { ...plaza, policy: spacePolicyForPreset(opts.space) } : { ...plaza },
    quota,
    isOwnerChannel: false,
  };
}

describe("subject — invariants over the whole matrix", () => {
  const channels: Array<PolicyContext["channel"]> = ["room_say", "whisper", "notice"];

  it("subject is present EXACTLY when source is 'actor', and is always one of the two literals", () => {
    let withSubject = 0;
    let senders = 0;
    let recipients = 0;
    let withoutSubject = 0;
    for (const { senderKind, recipientKind } of KIND_PAIRS) {
      for (const senderPolicy of allPolicies()) {
        for (const recipientPolicy of allPolicies()) {
          for (const space of SPACE_OPTIONS) {
            for (const senderOverhearable of OVERHEARABLE) {
              for (const channel of channels) {
                const res = authorize(
                  matrixCtx({
                    space,
                    senderKind,
                    recipientKind,
                    senderPolicy,
                    recipientPolicy,
                    senderOverhearable,
                    channel,
                  }),
                );
                for (const d of [res.emit, ...res.deliveries.map((x) => x.decision)]) {
                  if (d.code === "PERMISSION_DENIED" && d.source === "actor") {
                    expect(["sender", "recipient"], `${d.reason} named ${String(d.subject)}`).toContain(
                      d.subject,
                    );
                    if (d.subject === "sender") senders += 1;
                    else recipients += 1;
                    withSubject += 1;
                  } else {
                    expect(d.subject, `${d.code}/${String(d.source)} leaked a subject`).toBeUndefined();
                    expect(Object.prototype.hasOwnProperty.call(d, "subject")).toBe(false);
                    withoutSubject += 1;
                  }
                }
              }
            }
          }
        }
      }
    }
    // Neither arm is vacuous, and BOTH literals are actually produced.
    expect(withSubject).toBeGreaterThan(0);
    expect(withoutSubject).toBeGreaterThan(0);
    expect(senders).toBeGreaterThan(0);
    expect(recipients).toBeGreaterThan(0);
  });

  it("a 'sender' denial survives swapping the recipient's matrix; a 'recipient' denial does not", () => {
    // The counterfactual that makes the label load-bearing rather than decorative:
    // blame the sender and the denial must not depend on the recipient's settings;
    // blame the recipient and opening their matrix must change the outcome.
    let senderChecked = 0;
    let recipientChecked = 0;
    for (const senderPolicy of allPolicies()) {
      for (const recipientPolicy of allPolicies()) {
        for (const senderOverhearable of OVERHEARABLE) {
          for (const channel of channels) {
            const base = matrixCtx({
              space: null,
              senderKind: "agent",
              recipientKind: "agent",
              senderPolicy,
              recipientPolicy,
              senderOverhearable,
              channel,
            });
            const opened: PolicyContext = {
              ...base,
              recipients: [agentRecipient({ policy: DEFAULT_AGENT_POLICY })],
            };
            for (const d of authorize(base).deliveries) {
              if (d.decision.code !== "PERMISSION_DENIED" || d.decision.source !== "actor") continue;
              const openedDecision = authorize(opened).deliveries.find(
                (x) => x.recipientId === d.recipientId,
              )?.decision;
              const where = `${channel} sp=${JSON.stringify(senderPolicy)} rp=${JSON.stringify(recipientPolicy)}`;
              if (d.decision.subject === "sender") {
                expect(
                  openedDecision,
                  `blamed the sender but opening the recipient's matrix changed it: ${where}`,
                ).toEqual(d.decision);
                senderChecked += 1;
              } else {
                expect(
                  openedDecision,
                  `blamed the recipient but the recipient's matrix was not load-bearing: ${where}`,
                ).not.toEqual(d.decision);
                recipientChecked += 1;
              }
            }
          }
        }
      }
    }
    expect(senderChecked).toBeGreaterThan(0);
    expect(recipientChecked).toBeGreaterThan(0);
  });
});
