import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_AGENT_PRIVACY,
  OPEN_SPACE_POLICY,
  SPACE_POLICY_PRESETS,
  intersectSpacePolicy,
  spacePolicyForPreset,
  type PermissionPolicy,
  type PolicyContext,
  type QuotaSnapshot,
  type SpacePolicyPreset,
} from "@grove/protocol";
import { authorize } from "../src/authorize.js";

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

const PRESETS: SpacePolicyPreset[] = ["private", "public_view", "public_write"];

/** All 16 points of the four-boolean lattice. */
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

function sender(opts: {
  kind: "agent" | "human";
  policy?: PermissionPolicy;
  isSpaceMember?: boolean;
}): PolicyContext["sender"] {
  if (opts.kind === "agent") {
    return {
      id: "agt_sender",
      kind: "agent",
      ownerHumanId: "hum_owner",
      claimState: "claimed",
      policy: opts.policy ?? DEFAULT_AGENT_POLICY,
      privacy: DEFAULT_AGENT_PRIVACY,
      isSpaceMember: opts.isSpaceMember,
    };
  }
  return {
    id: "hum_sender",
    kind: "human",
    privacy: { overhearableByAgents: true },
    isSpaceMember: opts.isSpaceMember,
  };
}

function recipient(opts: {
  kind: "agent" | "human";
  policy?: PermissionPolicy;
  isSpaceMember?: boolean;
}): PolicyContext["recipients"][number] {
  if (opts.kind === "agent") {
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

function ctxFor(opts: {
  preset?: SpacePolicyPreset;
  senderKind: "agent" | "human";
  recipientKind: "agent" | "human";
  senderPolicy?: PermissionPolicy;
  recipientPolicy?: PermissionPolicy;
  senderIsMember?: boolean;
  recipientIsMember?: boolean;
  channel?: PolicyContext["channel"];
}): PolicyContext {
  const r = recipient({
    kind: opts.recipientKind,
    policy: opts.recipientPolicy,
    isSpaceMember: opts.recipientIsMember,
  });
  return {
    sender: sender({
      kind: opts.senderKind,
      policy: opts.senderPolicy,
      isSpaceMember: opts.senderIsMember,
    }),
    recipients: [r],
    channel: opts.channel ?? "room_say",
    requestedTargetId: opts.channel === "whisper" ? r.id : null,
    room: opts.preset ? { ...plaza, policy: spacePolicyForPreset(opts.preset) } : { ...plaza },
    quota,
    isOwnerChannel: false,
  };
}

/** The same context with the space's own policy removed — i.e. today's kernel. */
function withoutSpace(ctx: PolicyContext): PolicyContext {
  if (!ctx.room) return ctx;
  const room = { ...ctx.room };
  delete room.policy;
  return { ...ctx, room };
}

const KIND_PAIRS: Array<{ senderKind: "agent" | "human"; recipientKind: "agent" | "human" }> = [
  { senderKind: "agent", recipientKind: "agent" },
  { senderKind: "agent", recipientKind: "human" },
  { senderKind: "human", recipientKind: "agent" },
  { senderKind: "human", recipientKind: "human" },
];

// ---------------------------------------------------------------------------
// 1. The preset table itself
// ---------------------------------------------------------------------------

describe("space presets — shape", () => {
  it("private grants nothing to non-members", () => {
    expect(SPACE_POLICY_PRESETS.private).toEqual({
      speakToAgents: false,
      speakToHumans: false,
      listenToAgents: false,
      listenToHumans: false,
    });
  });

  it("public_view grants listening only", () => {
    expect(SPACE_POLICY_PRESETS.public_view).toEqual({
      speakToAgents: false,
      speakToHumans: false,
      listenToAgents: true,
      listenToHumans: true,
    });
  });

  it("public_write grants everything and is the open ceiling", () => {
    expect(SPACE_POLICY_PRESETS.public_write).toEqual({
      speakToAgents: true,
      speakToHumans: true,
      listenToAgents: true,
      listenToHumans: true,
    });
    expect(OPEN_SPACE_POLICY).toEqual(SPACE_POLICY_PRESETS.public_write);
  });

  it("intersectSpacePolicy is a pure AND over all 16 x 3 combinations", () => {
    for (const actor of allPolicies()) {
      for (const preset of PRESETS) {
        const space = SPACE_POLICY_PRESETS[preset];
        const eff = intersectSpacePolicy(actor, space);
        for (const cap of Object.keys(eff) as Array<keyof PermissionPolicy>) {
          expect(eff[cap]).toBe(actor[cap] && space[cap]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. All three presets against all four kind pairs
// ---------------------------------------------------------------------------

describe("space presets — room_say, non-member actors, all four kind pairs", () => {
  for (const { senderKind, recipientKind } of KIND_PAIRS) {
    const label = `${senderKind}->${recipientKind}`;

    it(`private: ${label} emit is PERMISSION_DENIED/speakToHumans`, () => {
      const res = authorize(ctxFor({ preset: "private", senderKind, recipientKind }));
      expect(res.emit.allow).toBe(false);
      expect(res.emit.code).toBe("PERMISSION_DENIED");
      expect(res.emit.capability).toBe("speakToHumans");
      expect(res.deliveries).toEqual([]);
    });

    it(`public_view: ${label} emit is denied (only members may speak)`, () => {
      const res = authorize(ctxFor({ preset: "public_view", senderKind, recipientKind }));
      expect(res.emit.allow).toBe(false);
      expect(res.emit.code).toBe("PERMISSION_DENIED");
      expect(res.emit.capability).toBe("speakToHumans");
    });

    it(`public_write: ${label} emits and delivers`, () => {
      const res = authorize(ctxFor({ preset: "public_write", senderKind, recipientKind }));
      expect(res.emit.allow).toBe(true);
      expect(res.emit.code).toBe("ALLOW");
      expect(res.deliveries[0]?.decision.allow).toBe(true);
    });
  }
});

describe("space presets — members", () => {
  for (const { senderKind, recipientKind } of KIND_PAIRS) {
    const label = `${senderKind}->${recipientKind}`;

    it(`private: member ${label} member is fully allowed`, () => {
      const res = authorize(
        ctxFor({
          preset: "private",
          senderKind,
          recipientKind,
          senderIsMember: true,
          recipientIsMember: true,
        }),
      );
      expect(res.emit.allow).toBe(true);
      expect(res.deliveries[0]?.decision.allow).toBe(true);
    });

    it(`private: member ${label} NON-member is emitted but not delivered`, () => {
      const res = authorize(
        ctxFor({
          preset: "private",
          senderKind,
          recipientKind,
          senderIsMember: true,
          recipientIsMember: false,
        }),
      );
      expect(res.emit.allow).toBe(true);
      const d = res.deliveries[0]?.decision;
      expect(d?.allow).toBe(false);
      expect(d?.code).toBe("PERMISSION_DENIED");
      expect(d?.capability).toBe(senderKind === "agent" ? "listenToAgents" : "listenToHumans");
    });

    it(`public_view: member ${label} NON-member IS delivered (anyone may observe)`, () => {
      const res = authorize(
        ctxFor({
          preset: "public_view",
          senderKind,
          recipientKind,
          senderIsMember: true,
          recipientIsMember: false,
        }),
      );
      expect(res.emit.allow).toBe(true);
      expect(res.deliveries[0]?.decision.allow).toBe(true);
    });
  }
});

describe("space presets — whisper", () => {
  for (const { senderKind, recipientKind } of KIND_PAIRS) {
    const label = `${senderKind}->${recipientKind}`;

    it(`private: ${label} whisper emit names the right capability`, () => {
      const res = authorize(
        ctxFor({ preset: "private", senderKind, recipientKind, channel: "whisper" }),
      );
      expect(res.emit.allow).toBe(false);
      expect(res.emit.code).toBe("PERMISSION_DENIED");
      expect(res.emit.capability).toBe(recipientKind === "agent" ? "speakToAgents" : "speakToHumans");
    });

    it(`public_write: ${label} whisper is allowed`, () => {
      const res = authorize(
        ctxFor({ preset: "public_write", senderKind, recipientKind, channel: "whisper" }),
      );
      expect(res.emit.allow).toBe(true);
      expect(res.deliveries[0]?.decision.allow).toBe(true);
    });
  }
});

describe("space presets — spectators are never members", () => {
  it("private space is not leaked to the spectator SSE feed", () => {
    const spectator: PolicyContext["recipients"][number] = {
      id: "hum_sse",
      kind: "human",
      lurk: true,
      blocked: false,
      mutedByRecipient: false,
      synthetic: "spectator",
    };
    const res = authorize({
      sender: sender({ kind: "agent", isSpaceMember: true }),
      recipients: [spectator],
      channel: "room_say",
      room: { ...plaza, policy: spacePolicyForPreset("private") },
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.allow).toBe(true);
    expect(res.deliveries[0]?.decision.allow).toBe(false);
    expect(res.deliveries[0]?.decision.capability).toBe("listenToAgents");
  });

  it("public_view space IS visible to the spectator SSE feed", () => {
    const spectator: PolicyContext["recipients"][number] = {
      id: "hum_sse",
      kind: "human",
      lurk: true,
      blocked: false,
      mutedByRecipient: false,
      synthetic: "spectator",
    };
    const res = authorize({
      sender: sender({ kind: "agent", isSpaceMember: true }),
      recipients: [spectator],
      channel: "room_say",
      room: { ...plaza, policy: spacePolicyForPreset("public_view") },
      quota,
      isOwnerChannel: false,
    });
    expect(res.deliveries[0]?.decision.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. THE SAFETY PROPERTY — a space can never grant what the actor lacks
// ---------------------------------------------------------------------------

describe("intersection property — a space can only narrow, never widen", () => {
  const channels: Array<PolicyContext["channel"]> = ["room_say", "whisper", "notice"];

  it("every (policy x preset x membership x kind-pair x channel) allowed WITH a space was allowed WITHOUT it", () => {
    let compared = 0;
    for (const { senderKind, recipientKind } of KIND_PAIRS) {
      for (const senderPolicy of allPolicies()) {
        for (const recipientPolicy of allPolicies()) {
          for (const preset of PRESETS) {
            for (const senderIsMember of [false, true]) {
              for (const recipientIsMember of [false, true]) {
                for (const channel of channels) {
                  const ctx = ctxFor({
                    preset,
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
                  compared += 1;

                  // Emit: the space may deny, never grant.
                  if (withSpace.emit.allow) {
                    expect(
                      bare.emit.allow,
                      `space "${preset}" granted EMIT that the actor lacks (${senderKind}->${recipientKind}, ${channel})`,
                    ).toBe(true);
                  }

                  // Delivery: same, per recipient.
                  for (const d of withSpace.deliveries) {
                    if (!d.decision.allow) continue;
                    const bareDecision = bare.deliveries.find(
                      (x) => x.recipientId === d.recipientId,
                    )?.decision;
                    expect(
                      bareDecision?.allow,
                      `space "${preset}" granted DELIVERY to ${d.recipientId} that the actor lacks (${senderKind}->${recipientKind}, ${channel})`,
                    ).toBe(true);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBe(KIND_PAIRS.length * 16 * 16 * PRESETS.length * 2 * 2 * channels.length);
  });

  it("no outcome is allowed that the ACTOR'S OWN booleans forbid (baseline independent of the kernel)", () => {
    // Deliberately does not re-run authorize as its own baseline: this asserts
    // straight against the declared booleans, so a bug inside the intersection
    // helper cannot make the check vacuous.
    const channels: Array<PolicyContext["channel"]> = ["room_say", "whisper", "notice"];
    let checked = 0;
    for (const { senderKind, recipientKind } of KIND_PAIRS) {
      for (const senderPolicy of allPolicies()) {
        for (const recipientPolicy of allPolicies()) {
          for (const preset of PRESETS) {
            for (const senderIsMember of [false, true]) {
              for (const recipientIsMember of [false, true]) {
                for (const channel of channels) {
                  const ctx = ctxFor({
                    preset,
                    senderKind,
                    recipientKind,
                    senderPolicy,
                    recipientPolicy,
                    senderIsMember,
                    recipientIsMember,
                    channel,
                  });
                  const res = authorize(ctx);
                  const where = `${preset} ${senderKind}->${recipientKind} ${channel} sp=${JSON.stringify(senderPolicy)} rp=${JSON.stringify(recipientPolicy)}`;

                  if (res.emit.allow && senderKind === "agent") {
                    if (channel === "whisper") {
                      const cap = recipientKind === "agent" ? "speakToAgents" : "speakToHumans";
                      expect(senderPolicy[cap], `emit widened ${cap}: ${where}`).toBe(true);
                    } else {
                      expect(
                        senderPolicy.speakToAgents || senderPolicy.speakToHumans,
                        `emit widened a mouth onto a listen-only agent: ${where}`,
                      ).toBe(true);
                    }
                  }

                  for (const d of res.deliveries) {
                    if (!d.decision.allow) continue;
                    if (recipientKind === "agent") {
                      const cap = senderKind === "agent" ? "listenToAgents" : "listenToHumans";
                      expect(recipientPolicy[cap], `delivery widened ${cap}: ${where}`).toBe(true);
                    }
                    if (senderKind === "agent" && channel === "room_say") {
                      const cap = recipientKind === "human" ? "speakToHumans" : "speakToAgents";
                      expect(senderPolicy[cap], `delivery widened ${cap}: ${where}`).toBe(true);
                    }
                  }
                  checked += 1;
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(KIND_PAIRS.length * 16 * 16 * PRESETS.length * 2 * 2 * channels.length);
  });

  it("a narrowing space never turns a denial into an allow, for any single capability", () => {
    // Same shape, stated per-capability on the emit path only, so a failure
    // points at one boolean rather than a whole context.
    for (const senderPolicy of allPolicies()) {
      for (const preset of PRESETS) {
        const eff = intersectSpacePolicy(senderPolicy, SPACE_POLICY_PRESETS[preset]);
        for (const cap of Object.keys(eff) as Array<keyof PermissionPolicy>) {
          if (!senderPolicy[cap]) expect(eff[cap]).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Owner channel bypasses space policy entirely
// ---------------------------------------------------------------------------

describe("owner channel bypasses space policy", () => {
  const ownerAsRecipient: PolicyContext["recipients"][number] = {
    id: "hum_owner",
    kind: "human",
    lurk: false,
    privacy: { overhearableByAgents: true },
    blocked: false,
    mutedByRecipient: false,
    isSpaceMember: false,
  };

  it("owner_reply from a listen-only agent passes through a private space", () => {
    const res = authorize({
      sender: {
        id: "agt_scribe",
        kind: "agent",
        ownerHumanId: "hum_owner",
        claimState: "claimed",
        policy: {
          speakToAgents: false,
          speakToHumans: false,
          listenToAgents: true,
          listenToHumans: true,
        },
        privacy: DEFAULT_AGENT_PRIVACY,
        isSpaceMember: false,
      },
      recipients: [ownerAsRecipient],
      channel: "owner_reply",
      room: { ...plaza, policy: spacePolicyForPreset("private") },
      quota,
      isOwnerChannel: true,
    });
    expect(res.emit.allow).toBe(true);
    expect(res.emit.code).toBe("ALLOW");
    expect(res.deliveries[0]?.decision.allow).toBe(true);
  });

  it("owner_instruction from a human reaches their agent inside a private space", () => {
    const res = authorize({
      sender: { id: "hum_owner", kind: "human", isSpaceMember: false },
      recipients: [
        {
          id: "agt_host",
          kind: "agent",
          ownerHumanId: "hum_owner",
          policy: DEFAULT_AGENT_POLICY,
          blocked: false,
          mutedByRecipient: false,
          isSpaceMember: false,
        },
      ],
      channel: "owner_instruction",
      room: { ...plaza, policy: spacePolicyForPreset("private") },
      quota,
      isOwnerChannel: true,
    });
    expect(res.emit.allow).toBe(true);
    expect(res.deliveries[0]?.decision.allow).toBe(true);
  });

  it("the owner channel stays open in a private space for every preset", () => {
    for (const preset of PRESETS) {
      const res = authorize({
        sender: {
          id: "agt_scribe",
          kind: "agent",
          ownerHumanId: "hum_owner",
          claimState: "claimed",
          policy: DEFAULT_AGENT_POLICY,
          isSpaceMember: false,
        },
        recipients: [ownerAsRecipient],
        channel: "owner_reply",
        room: { ...plaza, policy: spacePolicyForPreset(preset) },
        quota,
        isOwnerChannel: true,
      });
      expect(res.emit.allow, preset).toBe(true);
      expect(res.deliveries[0]?.decision.allow, preset).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Precedence is untouched
// ---------------------------------------------------------------------------

describe("precedence — space policy never preempts the existing codes", () => {
  it("UNCLAIMED still beats a private space", () => {
    const ctx = ctxFor({ preset: "private", senderKind: "agent", recipientKind: "human" });
    ctx.sender.claimState = "pending";
    expect(authorize(ctx).emit.code).toBe("UNCLAIMED");
  });

  it("ROOM_FORBIDDEN still beats a private space", () => {
    const ctx = ctxFor({ preset: "private", senderKind: "human", recipientKind: "human" });
    ctx.room = { ...plaza, allowsRoomSay: false, policy: spacePolicyForPreset("private") };
    expect(authorize(ctx).emit.code).toBe("ROOM_FORBIDDEN");
  });

  it("RATE_LIMITED still beats a private space", () => {
    const ctx = ctxFor({ preset: "private", senderKind: "human", recipientKind: "human" });
    ctx.quota = { ...quota, writeRemaining: 0 };
    expect(authorize(ctx).emit.code).toBe("RATE_LIMITED");
  });

  it("BLOCKED still beats a public_view space on delivery", () => {
    const ctx = ctxFor({
      preset: "public_view",
      senderKind: "human",
      recipientKind: "human",
      senderIsMember: true,
    });
    ctx.recipients[0]!.blocked = true;
    expect(authorize(ctx).deliveries[0]?.decision.code).toBe("BLOCKED");
  });

  it("MUTED still beats a private space on delivery", () => {
    const ctx = ctxFor({
      preset: "private",
      senderKind: "human",
      recipientKind: "human",
      senderIsMember: true,
      recipientIsMember: false,
    });
    ctx.recipients[0]!.mutedByRecipient = true;
    const d = authorize(ctx).deliveries[0]?.decision;
    expect(d?.code).toBe("MUTED");
    expect(d?.visibleInUi).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. No regression: public_write === no space policy at all
// ---------------------------------------------------------------------------

describe("no regression — an all-four-on agent in public_write behaves exactly as today", () => {
  it("is byte-identical to the same context with no space policy, across the matrix", () => {
    const channels: Array<PolicyContext["channel"]> = ["room_say", "whisper", "notice"];
    let compared = 0;
    for (const { senderKind, recipientKind } of KIND_PAIRS) {
      for (const recipientPolicy of allPolicies()) {
        for (const channel of channels) {
          for (const senderIsMember of [false, true]) {
            const ctx = ctxFor({
              preset: "public_write",
              senderKind,
              recipientKind,
              senderPolicy: DEFAULT_AGENT_POLICY,
              recipientPolicy,
              senderIsMember,
              channel,
            });
            expect(authorize(ctx)).toEqual(authorize(withoutSpace(ctx)));
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(KIND_PAIRS.length * 16 * 3 * 2);
  });

  it("public_write leaves the awkward cases alone too (mute, block, rate limit, garden cap)", () => {
    const variants: Array<(c: PolicyContext) => void> = [
      (c) => {
        c.recipients[0]!.mutedByRecipient = true;
      },
      (c) => {
        c.recipients[0]!.blocked = true;
      },
      (c) => {
        c.quota = { ...quota, writeRemaining: 0 };
      },
      (c) => {
        c.room = { ...plaza, sayLimitPerMin: 3, policy: spacePolicyForPreset("public_write") };
        c.quota = { ...quota, roomWindowCount: 3 };
      },
      (c) => {
        c.sender.policy = { ...DEFAULT_AGENT_POLICY, speakToHumans: false };
      },
      (c) => {
        c.sender.policy = { ...DEFAULT_AGENT_POLICY, speakToAgents: false };
      },
      (c) => {
        c.sender.privacy = { ...DEFAULT_AGENT_PRIVACY, overhearableByAgents: false };
      },
    ];
    for (const mutate of variants) {
      for (const { senderKind, recipientKind } of KIND_PAIRS) {
        const ctx = ctxFor({ preset: "public_write", senderKind, recipientKind });
        mutate(ctx);
        expect(authorize(ctx)).toEqual(authorize(withoutSpace(ctx)));
      }
    }
  });

  it("an agent that already lacks speakToHumans gains nothing from public_write", () => {
    const res = authorize(
      ctxFor({
        preset: "public_write",
        senderKind: "agent",
        recipientKind: "human",
        senderPolicy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false },
      }),
    );
    expect(res.emit.allow).toBe(true);
    expect(res.deliveries[0]?.decision.allow).toBe(false);
    expect(res.deliveries[0]?.decision.capability).toBe("speakToHumans");
  });

  it("a listen-only agent gains nothing from public_write, even as a member", () => {
    const res = authorize(
      ctxFor({
        preset: "public_write",
        senderKind: "agent",
        recipientKind: "human",
        senderIsMember: true,
        senderPolicy: {
          speakToAgents: false,
          speakToHumans: false,
          listenToAgents: true,
          listenToHumans: true,
        },
      }),
    );
    expect(res.emit.allow).toBe(false);
    expect(res.emit.code).toBe("PERMISSION_DENIED");
    expect(res.emit.capability).toBe("speakToHumans");
  });

  it("a deaf agent recipient gains nothing from public_write membership", () => {
    const res = authorize(
      ctxFor({
        preset: "public_write",
        senderKind: "human",
        recipientKind: "agent",
        recipientIsMember: true,
        recipientPolicy: { ...DEFAULT_AGENT_POLICY, listenToHumans: false },
      }),
    );
    expect(res.deliveries[0]?.decision.allow).toBe(false);
    expect(res.deliveries[0]?.decision.capability).toBe("listenToHumans");
  });

  it("rooms with no policy at all are untouched", () => {
    const res = authorize(ctxFor({ senderKind: "agent", recipientKind: "human" }));
    expect(res.emit.allow).toBe(true);
    expect(res.deliveries[0]?.decision.allow).toBe(true);
  });
});
