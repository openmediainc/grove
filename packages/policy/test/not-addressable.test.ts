import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_AGENT_PRIVACY,
  spacePolicyForPreset,
  type PolicyContext,
  type PrivacyPolicy,
  type QuotaSnapshot,
} from "@grove/protocol";
import { authorize } from "../src/authorize.js";

/**
 * PRM-07 — `NOT_ADDRESSABLE` is the denial that most needs to say who refused,
 * and it said the least.
 *
 * It is the world telling you "they have closed their door to you", and it is
 * produced by exactly three settings, all of them the RECIPIENT's own:
 * `privacy.addressableByAgents`, `privacy.addressableByHumans`, and a human's
 * `lurk`. It shipped with `code` and prose alone, so a client could not tell it
 * apart from its own settings refusing — and the nameplate's "owned by @x"
 * byline sends the reader to a door that cannot open it.
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

const OPEN_PRIVACY: PrivacyPolicy = {
  addressableByAgents: true,
  addressableByHumans: true,
  overhearableByAgents: true,
  overhearableByHumans: true,
};

function agentSender() {
  return {
    id: "agt_sender",
    kind: "agent" as const,
    ownerHumanId: "hum_owner",
    claimState: "claimed" as const,
    policy: DEFAULT_AGENT_POLICY,
    privacy: DEFAULT_AGENT_PRIVACY as PolicyContext["sender"]["privacy"],
  };
}

function humanSender() {
  return {
    id: "hum_sender",
    kind: "human" as const,
    privacy: { overhearableByAgents: true } as PolicyContext["sender"]["privacy"],
  };
}

function target(over: Partial<PolicyContext["recipients"][number]> = {}) {
  return {
    id: "hum_target",
    kind: "human" as const,
    lurk: false,
    blocked: false,
    mutedByRecipient: false,
    privacy: OPEN_PRIVACY as PolicyContext["recipients"][number]["privacy"],
    ...over,
  };
}

function whisper(
  sender: PolicyContext["sender"],
  recipient: PolicyContext["recipients"][number],
): PolicyContext {
  return {
    sender,
    recipients: [recipient],
    channel: "whisper",
    requestedTargetId: recipient.id,
    room: { ...plaza },
    quota,
    isOwnerChannel: false,
  };
}

// ---------------------------------------------------------------------------
// 1. All three causes are attributed, and identically
// ---------------------------------------------------------------------------

describe("every NOT_ADDRESSABLE names the recipient's own settings", () => {
  it("a lurking human", () => {
    const res = authorize(whisper(agentSender(), target({ lurk: true })));
    expect(res.emit.code).toBe("NOT_ADDRESSABLE");
    expect(res.emit.source).toBe("actor");
    expect(res.emit.subject).toBe("recipient");
    expect(res.emit.reason).toBe("Human is lurking.");
  });

  it("addressableByAgents: false, whispered at by an agent", () => {
    const res = authorize(
      whisper(agentSender(), target({ privacy: { ...OPEN_PRIVACY, addressableByAgents: false } })),
    );
    expect(res.emit.code).toBe("NOT_ADDRESSABLE");
    expect(res.emit.source).toBe("actor");
    expect(res.emit.subject).toBe("recipient");
  });

  it("addressableByHumans: false, whispered at by a human", () => {
    const res = authorize(
      whisper(humanSender(), target({ privacy: { ...OPEN_PRIVACY, addressableByHumans: false } })),
    );
    expect(res.emit.code).toBe("NOT_ADDRESSABLE");
    expect(res.emit.source).toBe("actor");
    expect(res.emit.subject).toBe("recipient");
  });

  it("an agent recipient that is not addressable by agents", () => {
    const res = authorize(
      whisper(
        agentSender(),
        target({
          id: "agt_target",
          kind: "agent",
          policy: DEFAULT_AGENT_POLICY,
          privacy: { ...OPEN_PRIVACY, addressableByAgents: false },
        }),
      ),
    );
    expect(res.emit.code).toBe("NOT_ADDRESSABLE");
    expect(res.emit.source).toBe("actor");
    expect(res.emit.subject).toBe("recipient");
  });

  it("carries no capability: none of the three settings is a matrix key", () => {
    // Borrowing an actor-shaped capability name for a privacy flag is exactly
    // the confusion PRM-06 was; the code already says what closed.
    const res = authorize(whisper(agentSender(), target({ lurk: true })));
    expect(res.emit).not.toHaveProperty("capability");
  });
});

// ---------------------------------------------------------------------------
// 2. The attribution is load-bearing, not decorative
// ---------------------------------------------------------------------------

describe("the attribution matches what the recipient's setting actually does", () => {
  it("subject: 'recipient' — opening the recipient's own setting removes the denial", () => {
    const closed = target({ privacy: { ...OPEN_PRIVACY, addressableByAgents: false } });
    const denied = authorize(whisper(agentSender(), closed));
    expect(denied.emit.code).toBe("NOT_ADDRESSABLE");
    expect(denied.emit.subject).toBe("recipient");

    const opened = authorize(whisper(agentSender(), { ...closed, privacy: OPEN_PRIVACY }));
    expect(opened.emit.code).not.toBe("NOT_ADDRESSABLE");
    expect(opened.emit.allow).toBe(true);
  });

  it("source: 'actor' — removing the space's ceiling does NOT remove the denial", () => {
    // The counterfactual that separates the two labels: a space denial
    // disappears when the space does, an actor denial never does.
    const closed = target({ lurk: true });
    const inSpace = authorize({
      ...whisper(agentSender(), closed),
      room: { ...plaza, policy: spacePolicyForPreset("private") },
    });
    const bare = authorize(whisper(agentSender(), closed));
    expect(inSpace.emit.code).toBe("NOT_ADDRESSABLE");
    expect(inSpace.emit.source).toBe("actor");
    expect(bare.emit).toEqual(inSpace.emit);
  });

  it("changing the SENDER's own matrix does not change it either", () => {
    const closed = target({ lurk: true });
    const a = authorize(whisper(agentSender(), closed));
    const b = authorize(
      whisper(
        { ...agentSender(), policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false } },
        closed,
      ),
    );
    expect(b.emit).toEqual(a.emit);
  });
});

// ---------------------------------------------------------------------------
// 3. Nothing that was unattributed on purpose became attributed
// ---------------------------------------------------------------------------

describe("the neighbouring refusals are untouched", () => {
  it("BLOCKED is still unattributed — a block is mutual and does not say whose", () => {
    const res = authorize(whisper(agentSender(), target({ blocked: true })));
    expect(res.emit.code).toBe("BLOCKED");
    expect(res.emit).not.toHaveProperty("source");
    expect(res.emit).not.toHaveProperty("subject");
  });

  it("a NOT_ADDRESSABLE reached on the DELIVERY half is attributed the same way", () => {
    // The whisper emit half picks the requested target; a second recipient on
    // the same act reaches assertAddressable through deliveryDecision.
    const reachable = target({ id: "hum_open" });
    const res = authorize({
      sender: agentSender(),
      recipients: [reachable, target({ id: "hum_shut", lurk: true })],
      channel: "whisper",
      requestedTargetId: "hum_open",
      room: { ...plaza },
      quota,
      isOwnerChannel: false,
    });
    expect(res.emit.allow).toBe(true);
    const shut = res.deliveries.find((d) => d.recipientId === "hum_shut")?.decision;
    expect(shut?.code).toBe("NOT_ADDRESSABLE");
    expect(shut?.source).toBe("actor");
    expect(shut?.subject).toBe("recipient");
  });

  it("an addressable target on an open channel still carries neither field", () => {
    const res = authorize(whisper(agentSender(), target()));
    expect(res.emit.allow).toBe(true);
    expect(res.emit).not.toHaveProperty("source");
    expect(res.emit).not.toHaveProperty("subject");
  });
});
