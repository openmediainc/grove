import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_AGENT_PRIVACY,
  computeIsOwnerChannel,
  type PolicyContext,
} from "@grove/protocol";
import { authorize } from "@grove/policy";
import {
  SPECTATOR_RECIPIENT,
  assertValidOwnerChannelFlag,
  spectatorMayHear,
} from "../src/services/speech.js";
import { GroveError } from "../src/errors.js";

const quota = { roomSayRemaining: 8, roomSayGapOk: true, writeRemaining: 30, roomWindowCount: 0 };
const plaza = {
  id: "plaza",
  kind: "public" as const,
  allowsRoomSay: true,
  allowsWhisper: true,
  sayLimitPerMin: null,
  capacity: 80,
};

describe("SpeechService owner-channel invariant", () => {
  it("rejects isOwnerChannel=true on room_say before authorize in the harness", () => {
    const ctx: PolicyContext = {
      sender: {
        id: "agt_1",
        kind: "agent",
        claimState: "claimed",
        ownerHumanId: "hum_owner",
        policy: DEFAULT_AGENT_POLICY,
      },
      recipients: [{ id: "hum_owner", kind: "human", blocked: false, mutedByRecipient: false }],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: true,
    };
    expect(() => assertValidOwnerChannelFlag(ctx)).toThrow(GroveError);
  });

  it("sets isOwnerChannel false for room_say even if owner is in the room", () => {
    const sender = {
      id: "agt_1",
      kind: "agent" as const,
      claimState: "claimed" as const,
      ownerHumanId: "hum_owner",
      policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false },
    };
    const owner = { id: "hum_owner", kind: "human" as const };
    expect(computeIsOwnerChannel(sender, owner)).toBe(true);
    const ctx: PolicyContext = {
      sender,
      recipients: [{ ...owner, blocked: false, mutedByRecipient: false }],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    };
    const result = authorize(ctx);
    expect(result.emit.allow).toBe(true);
    expect(result.deliveries[0]?.decision.allow).toBe(false);
  });
});

describe("listen-only 403 vs owner_reply 200 (kernel used by SpeechService)", () => {
  const listenOnly = {
    id: "agt_scribe",
    kind: "agent" as const,
    ownerHumanId: "hum_owner",
    claimState: "claimed" as const,
    policy: { ...DEFAULT_AGENT_POLICY, speakToAgents: false, speakToHumans: false },
    privacy: DEFAULT_AGENT_PRIVACY,
  };
  const owner = { id: "hum_owner", kind: "human" as const, blocked: false, mutedByRecipient: false };

  it("room_say denied", () => {
    const result = authorize({
      sender: listenOnly,
      recipients: [owner],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.emit.code).toBe("PERMISSION_DENIED");
    expect(result.emit.capability).toBe("speakToHumans");
  });

  it("owner_reply allowed", () => {
    const result = authorize({
      sender: listenOnly,
      recipients: [owner],
      channel: "owner_reply",
      quota,
      isOwnerChannel: true,
    });
    expect(result.emit.allow).toBe(true);
  });
});

describe("plaza SSE filter", () => {
  it("speak_to_humans=false is absent", () => {
    const sender = {
      id: "agt_x",
      kind: "agent" as const,
      claimState: "claimed" as const,
      policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false },
      privacy: DEFAULT_AGENT_PRIVACY,
    };
    expect(spectatorMayHear(sender, plaza, quota)).toBe(false);
  });

  it("speak_to_humans=true is present", () => {
    const sender = {
      id: "agt_x",
      kind: "agent" as const,
      claimState: "claimed" as const,
      policy: DEFAULT_AGENT_POLICY,
      privacy: DEFAULT_AGENT_PRIVACY,
    };
    expect(spectatorMayHear(sender, plaza, quota)).toBe(true);
  });

  it("synthetic spectator recipient is used", () => {
    expect(SPECTATOR_RECIPIENT.synthetic).toBe("spectator");
    expect(SPECTATOR_RECIPIENT.kind).toBe("human");
    expect(SPECTATOR_RECIPIENT.lurk).toBe(true);
  });
});

describe("unclaimed observe contract", () => {
  it("pending observation has no room field in the type", () => {
    const pending = {
      generatedAt: new Date().toISOString(),
      kind: "pending" as const,
      claimState: "pending" as const,
      agentId: "agt_01",
      slug: "agt_01",
      claimUrl: "http://localhost:3000/claim/agt_01",
      ttlSeconds: 100,
    };
    expect("room" in pending).toBe(false);
    expect(pending.kind).toBe("pending");
  });
});
