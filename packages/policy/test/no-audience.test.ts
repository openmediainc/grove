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
 * PRM-06 — `capability` and `source` must describe the SAME event.
 *
 * The "no audience left" branch of `authorize()` hard-coded `capability` to the
 * canonical `speakToHumans` (§5.8a) while deciding `source` from a different
 * question entirely ("did the actor arrive with any mouth at all?"). Each field
 * was right by its own rule; the pair was a lie. An agent granted
 * `{speakToAgents: true, speakToHumans: false}` standing in a `public_view`
 * space was refused with `capability: "speakToHumans", source: "space"` — a
 * capability the actor never held, charged to the space that never took it.
 *
 * The fix is to name the mouth the actor genuinely held and genuinely lost, so
 * the per-capability rules for `source` and `reason` become true of it without
 * a special case. These tests pin the pair, not either field alone.
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

const ALL: PermissionPolicy = {
  speakToAgents: true,
  speakToHumans: true,
  listenToAgents: true,
  listenToHumans: true,
};

/** Grants a mouth toward agents and nothing toward people. The PRM-06 shape. */
const AGENT_MOUTH_ONLY: PermissionPolicy = {
  speakToAgents: true,
  speakToHumans: false,
  listenToAgents: true,
  listenToHumans: true,
};

/** Grants a mouth toward people and nothing toward agents. The mirror image. */
const HUMAN_MOUTH_ONLY: PermissionPolicy = {
  speakToAgents: false,
  speakToHumans: true,
  listenToAgents: true,
  listenToHumans: true,
};

const MOUTHLESS: PermissionPolicy = {
  speakToAgents: false,
  speakToHumans: false,
  listenToAgents: true,
  listenToHumans: true,
};

function room(policy?: SpacePolicy) {
  return policy ? { ...plaza, policy } : { ...plaza };
}

function agentSender(policy: PermissionPolicy, isSpaceMember = false) {
  return {
    id: "agt_sender",
    kind: "agent" as const,
    ownerHumanId: "hum_owner",
    claimState: "claimed" as const,
    policy,
    privacy: DEFAULT_AGENT_PRIVACY as PolicyContext["sender"]["privacy"],
    isSpaceMember,
  };
}

function agentRecipient(policy: PermissionPolicy = ALL, isSpaceMember = false) {
  return {
    id: "agt_recipient",
    kind: "agent" as const,
    policy,
    privacy: DEFAULT_AGENT_PRIVACY as PolicyContext["recipients"][number]["privacy"],
    blocked: false,
    mutedByRecipient: false,
    isSpaceMember,
  };
}

function humanRecipient(isSpaceMember = false) {
  return {
    id: "hum_recipient",
    kind: "human" as const,
    lurk: false,
    blocked: false,
    mutedByRecipient: false,
    isSpaceMember,
  };
}

// ---------------------------------------------------------------------------
// 1. The exact reported case
// ---------------------------------------------------------------------------

describe("PRM-06 — the reported incoherence", () => {
  it("an agent-only mouth removed by a public_view space names speakToAgents, not speakToHumans", () => {
    const res = authorize({
      sender: agentSender(AGENT_MOUTH_ONLY),
      recipients: [agentRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("public_view")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.code).toBe("PERMISSION_DENIED");
    // The pair: the space really did take speakToAgents, and the actor really
    // did hold it. Naming speakToHumans here blamed the space for a capability
    // the owner had never granted.
    expect(res.emit.capability).toBe("speakToAgents");
    expect(res.emit.source).toBe("space");
    expect(res.emit.reason).toBe("This space does not grant speakToAgents.");
    expect(res.emit).not.toHaveProperty("subject");
  });

  it("the same agent in a private space reads the same way", () => {
    const res = authorize({
      sender: agentSender(AGENT_MOUTH_ONLY),
      recipients: [agentRecipient()],
      channel: "notice",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.capability).toBe("speakToAgents");
    expect(res.emit.source).toBe("space");
  });

  it("the mirror image — a people-only mouth removed by the space — stays speakToHumans", () => {
    const res = authorize({
      sender: agentSender(HUMAN_MOUTH_ONLY),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("public_view")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.capability).toBe("speakToHumans");
    expect(res.emit.source).toBe("space");
  });

  it("an actor that arrived with no mouth at all keeps the canonical name and blames itself", () => {
    // §5.8a's canonical capability is still the honest one here: the actor
    // genuinely lacks speakToHumans, so the pair is coherent unchanged.
    const res = authorize({
      // A human carrying a matrix reaches the aggregate branch; an agent is
      // caught one branch earlier by the listen-only rule.
      sender: { id: "hum_sender", kind: "human" as const, policy: MOUTHLESS },
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.capability).toBe("speakToHumans");
    expect(res.emit.source).toBe("actor");
    expect(res.emit.subject).toBe("sender");
    // It used to say "This space does not grant speech here." while blaming the
    // actor — the prose contradicted the field it shipped beside.
    expect(res.emit.reason).toBe("Sender does not have speakToHumans.");
  });

  it("a fully-granted actor silenced by the space still reports the canonical capability", () => {
    const res = authorize({
      sender: agentSender(ALL),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.capability).toBe("speakToHumans");
    expect(res.emit.source).toBe("space");
  });
});

// ---------------------------------------------------------------------------
// 2. The property that the old code violated
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

const SPACE_OPTIONS: Array<SpacePolicyPreset | null> = [null, "private", "public_view", "public_write"];
const KIND_PAIRS: Array<{ senderKind: "agent" | "human"; recipientKind: "agent" | "human" }> = [
  { senderKind: "agent", recipientKind: "agent" },
  { senderKind: "agent", recipientKind: "human" },
  { senderKind: "human", recipientKind: "agent" },
  { senderKind: "human", recipientKind: "human" },
];

describe("capability and source describe the same event, over the whole matrix", () => {
  const channels: Array<PolicyContext["channel"]> = ["room_say", "whisper", "notice"];

  /**
   * WHOSE matrix a `capability` is a claim about.
   *
   * `subject` answers this, but only when `source` is `"actor"`: a space denial
   * deliberately carries no subject, because no actor is at fault. So the test
   * cannot read the owner off the decision, and guessing "the sender" is wrong —
   * the recipient's-ear intersection site reports `listenToAgents` about the
   * RECIPIENT while the sender may well lack it, which is correct and would look
   * like a violation.
   *
   * The structural rule, with the speaker-privacy branch held out of the matrix
   * (see below), is exact: every `listenTo*` denial is a claim about the
   * recipient's ear, and every `speakTo*` denial is a claim about the sender's
   * mouth. That is also what makes the subject-vs-structure cross-check below
   * worth asserting.
   */
  function ownerOf(capability: keyof PermissionPolicy): "sender" | "recipient" {
    return capability === "listenToAgents" || capability === "listenToHumans"
      ? "recipient"
      : "sender";
  }

  it("source: 'space' only ever names a capability the blamed party HELD; source: 'actor' only ever names one they LACKED", () => {
    // The one deliberate exception is kept out of the matrix rather than
    // special-cased: a speaker-privacy denial (overhearableBy*) reports the
    // capability of the EAR it closed while `subject` names the sender, so the
    // named party may well hold it. Every sender here is fully overhearable, so
    // that branch never fires and the rule below is exact.
    let space = 0;
    let actor = 0;
    for (const { senderKind, recipientKind } of KIND_PAIRS) {
      for (const senderPolicy of allPolicies()) {
        for (const recipientPolicy of allPolicies()) {
          for (const preset of SPACE_OPTIONS) {
            for (const senderIsMember of [false, true]) {
              for (const recipientIsMember of [false, true]) {
                for (const channel of channels) {
                  const r =
                    recipientKind === "agent"
                      ? agentRecipient(recipientPolicy, recipientIsMember)
                      : humanRecipient(recipientIsMember);
                  const sender =
                    senderKind === "agent"
                      ? agentSender(senderPolicy, senderIsMember)
                      : {
                          id: "hum_sender",
                          kind: "human" as const,
                          privacy: { overhearableByAgents: true, overhearableByHumans: true },
                          isSpaceMember: senderIsMember,
                        };
                  const ctx: PolicyContext = {
                    sender,
                    recipients: [r],
                    channel,
                    requestedTargetId: channel === "whisper" ? r.id : null,
                    room: preset ? room(spacePolicyForPreset(preset)) : room(),
                    quota,
                    isOwnerChannel: false,
                  };
                  const res = authorize(ctx);
                  const decisions: PolicyDecision[] = [
                    res.emit,
                    ...res.deliveries.map((d) => d.decision),
                  ];
                  for (const d of decisions) {
                    if (d.code !== "PERMISSION_DENIED" || !d.capability) continue;
                    // Whose stored matrix the decision is a claim about.
                    const owner = ownerOf(d.capability);
                    const blamed =
                      owner === "recipient"
                        ? (recipientKind === "agent" ? recipientPolicy : ALL)
                        : (senderKind === "agent" ? senderPolicy : ALL);
                    const held = blamed[d.capability];
                    const where =
                      `${preset ?? "none"} ${senderKind}->${recipientKind} ${channel} ` +
                      `cap=${d.capability} src=${d.source} owner=${owner} ` +
                      `sp=${JSON.stringify(senderPolicy)} rp=${JSON.stringify(recipientPolicy)} ` +
                      `sm=${senderIsMember} rm=${recipientIsMember}`;
                    // When the kernel DOES name the party, it must agree with
                    // the structural rule — otherwise `ownerOf` is reading the
                    // wrong matrix and the assertions below prove nothing.
                    if (d.subject) {
                      expect(d.subject, `subject disagrees with structure: ${where}`).toBe(owner);
                    }
                    if (d.source === "space") {
                      // Blaming the space for a capability the party never had
                      // is the PRM-06 bug, in one assertion.
                      expect(held, `space blamed for a capability never held: ${where}`).toBe(true);
                      space += 1;
                    } else {
                      expect(held, `actor blamed for a capability they hold: ${where}`).toBe(false);
                      actor += 1;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    // Neither arm is vacuous.
    expect(space).toBeGreaterThan(0);
    expect(actor).toBeGreaterThan(0);
  });

  it("the reason always agrees with the source it ships beside", () => {
    let spaceProse = 0;
    let actorProse = 0;
    for (const senderPolicy of allPolicies()) {
      for (const preset of SPACE_OPTIONS) {
        for (const channel of ["room_say", "notice"] as const) {
          const res = authorize({
            sender: agentSender(senderPolicy),
            recipients: [agentRecipient()],
            channel,
            room: preset ? room(spacePolicyForPreset(preset)) : room(),
            quota,
            isOwnerChannel: false,
          });
          const d = res.emit;
          if (d.code !== "PERMISSION_DENIED") continue;
          if (d.source === "space") {
            expect(d.reason).toContain("This space");
            expect(d.reason).not.toContain("Sender does not have");
            spaceProse += 1;
          } else {
            expect(d.reason, `blamed the actor in the space's words: ${d.reason}`).not.toContain(
              "This space",
            );
            actorProse += 1;
          }
        }
      }
    }
    expect(spaceProse).toBeGreaterThan(0);
    expect(actorProse).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Nothing about the canonical §5.8a behaviour moved
// ---------------------------------------------------------------------------

describe("the canonical no-mouth denial is unchanged where it was already honest", () => {
  it("a listen-only agent's room_say is still speakToHumans / actor / sender", () => {
    const res = authorize({
      sender: agentSender(MOUTHLESS),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.capability).toBe("speakToHumans");
    expect(res.emit.source).toBe("actor");
    expect(res.emit.subject).toBe("sender");
    expect(res.emit.reason).toBe("Listen-only agents cannot room_say.");
  });

  it("a member of a private space keeps their agent-only mouth and is allowed", () => {
    const res = authorize({
      sender: agentSender(AGENT_MOUTH_ONLY, true),
      recipients: [agentRecipient(ALL, true)],
      channel: "room_say",
      room: room(spacePolicyForPreset("private")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.allow).toBe(true);
    expect(res.emit).not.toHaveProperty("capability");
  });

  it("a public_write space narrows nothing, so DEFAULT_AGENT_POLICY still speaks", () => {
    const res = authorize({
      sender: agentSender(DEFAULT_AGENT_POLICY),
      recipients: [humanRecipient()],
      channel: "room_say",
      room: room(spacePolicyForPreset("public_write")),
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.allow).toBe(true);
  });
});
