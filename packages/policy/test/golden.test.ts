import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_AGENT_PRIVACY,
  type PolicyContext,
  type QuotaSnapshot,
} from "@grove/protocol";
import { authorize } from "../src/authorize.js";
import { badges } from "../src/badges.js";

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

const garden = {
  ...plaza,
  id: "garden",
  sayLimitPerMin: 3,
};

function listenOnlyPolicy() {
  return {
    speakToAgents: false,
    speakToHumans: false,
    listenToAgents: true,
    listenToHumans: true,
  };
}

const owner = {
  id: "hum_owner",
  kind: "human" as const,
  lurk: false,
  privacy: { overhearableByAgents: true },
  blocked: false,
  mutedByRecipient: false,
};

const listenOnlyAgent = {
  id: "agt_scribe",
  kind: "agent" as const,
  ownerHumanId: "hum_owner",
  claimState: "claimed" as const,
  policy: listenOnlyPolicy(),
  privacy: DEFAULT_AGENT_PRIVACY,
};

describe("golden 1 — listen-only owner_reply vs room_say", () => {
  it("owner_reply to owner is ALLOW", () => {
    const result = authorize({
      sender: listenOnlyAgent,
      recipients: [owner],
      channel: "owner_reply",
      quota,
      isOwnerChannel: true,
    });
    expect(result.emit.allow).toBe(true);
    expect(result.emit.code).toBe("ALLOW");
    expect(result.deliveries[0]?.decision.allow).toBe(true);
  });

  it("same body as room_say is PERMISSION_DENIED / speakToHumans", () => {
    const result = authorize({
      sender: listenOnlyAgent,
      recipients: [owner],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.emit.allow).toBe(false);
    expect(result.emit.code).toBe("PERMISSION_DENIED");
    expect(result.emit.capability).toBe("speakToHumans");
    expect(result.deliveries).toEqual([]);
  });
});

describe("golden 2 — isOwnerChannel on room_say does not owner-bypass delivery", () => {
  it("wrongly-set isOwnerChannel=true on room_say still filters humans when speakToHumans=false", () => {
    const sender = {
      id: "agt_stagehand",
      kind: "agent" as const,
      ownerHumanId: "hum_owner",
      claimState: "claimed" as const,
      policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false },
      privacy: DEFAULT_AGENT_PRIVACY,
    };
    const result = authorize({
      sender,
      recipients: [owner],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: true,
    });
    expect(result.emit.allow).toBe(true);
    expect(result.deliveries[0]?.decision.allow).toBe(false);
    expect(result.deliveries[0]?.decision.code).toBe("PERMISSION_DENIED");
    expect(result.deliveries[0]?.decision.capability).toBe("speakToHumans");
  });
});

describe("golden 3 — human overhearableByAgents=false hides from own agent", () => {
  it("own agent with listenToHumans=true does not receive the line", () => {
    const human = {
      id: "hum_maya",
      kind: "human" as const,
      privacy: { overhearableByAgents: false },
    };
    const ownAgent = {
      id: "agt_host",
      kind: "agent" as const,
      ownerHumanId: "hum_maya",
      policy: DEFAULT_AGENT_POLICY,
      blocked: false,
      mutedByRecipient: false,
    };
    const result = authorize({
      sender: human,
      recipients: [ownAgent],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.emit.allow).toBe(true);
    expect(result.deliveries[0]?.decision.allow).toBe(false);
    expect(result.deliveries[0]?.decision.code).toBe("PERMISSION_DENIED");
    expect(result.deliveries[0]?.decision.capability).toBe("listenToHumans");
  });
});

describe("golden 4 — spectator synthetic ≡ human for mixed-audience", () => {
  it("speakToHumans=false is denied to spectator the same as an embodied human", () => {
    const sender = {
      id: "agt_stagehand",
      kind: "agent" as const,
      claimState: "claimed" as const,
      policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false },
      privacy: DEFAULT_AGENT_PRIVACY,
    };
    const spectator = {
      id: "hum_spectator",
      kind: "human" as const,
      lurk: true,
      blocked: false,
      mutedByRecipient: false,
      synthetic: "spectator" as const,
    };
    const embodied = {
      id: "hum_jules",
      kind: "human" as const,
      lurk: false,
      blocked: false,
      mutedByRecipient: false,
    };
    const spec = authorize({
      sender,
      recipients: [spectator],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    const hum = authorize({
      sender,
      recipients: [embodied],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(spec.deliveries[0]?.decision).toMatchObject({
      allow: false,
      code: "PERMISSION_DENIED",
      capability: "speakToHumans",
    });
    expect(hum.deliveries[0]?.decision).toMatchObject({
      allow: false,
      code: "PERMISSION_DENIED",
      capability: "speakToHumans",
    });
  });
});

describe("golden 5 — mute split", () => {
  it("mute human → MUTED visibleInUi=false", () => {
    const result = authorize({
      sender: { id: "hum_a", kind: "human", privacy: { overhearableByAgents: true } },
      recipients: [
        {
          id: "hum_b",
          kind: "human",
          blocked: false,
          mutedByRecipient: true,
        },
      ],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.deliveries[0]?.decision.code).toBe("MUTED");
    expect(result.deliveries[0]?.decision.visibleInUi).toBe(false);
    expect(result.deliveries[0]?.decision.allow).toBe(false);
  });

  it("mute agent → MUTED dropped from heard", () => {
    const result = authorize({
      sender: { id: "hum_a", kind: "human", privacy: { overhearableByAgents: true } },
      recipients: [
        {
          id: "agt_b",
          kind: "agent",
          policy: DEFAULT_AGENT_POLICY,
          blocked: false,
          mutedByRecipient: true,
        },
      ],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.deliveries[0]?.decision.code).toBe("MUTED");
    expect(result.deliveries[0]?.decision.allow).toBe(false);
    expect(result.deliveries[0]?.decision.visibleInUi).toBe(false);
  });
});

describe("golden 6 — garden sayLimitPerMin=3", () => {
  it("4th say is RATE_LIMITED", () => {
    const result = authorize({
      sender: { id: "hum_a", kind: "human", privacy: { overhearableByAgents: true } },
      recipients: [owner],
      channel: "room_say",
      room: garden,
      quota: { ...quota, roomWindowCount: 3 },
      isOwnerChannel: false,
    });
    expect(result.emit.allow).toBe(false);
    expect(result.emit.code).toBe("RATE_LIMITED");
  });

  it("3rd say still emits", () => {
    const result = authorize({
      sender: { id: "hum_a", kind: "human" },
      recipients: [owner],
      channel: "room_say",
      room: garden,
      quota: { ...quota, roomWindowCount: 2 },
      isOwnerChannel: false,
    });
    expect(result.emit.allow).toBe(true);
  });
});

describe("golden 7 — unclaimed room_say", () => {
  it("UNCLAIMED", () => {
    const result = authorize({
      sender: {
        id: "agt_pending",
        kind: "agent",
        claimState: "pending",
        policy: DEFAULT_AGENT_POLICY,
      },
      recipients: [owner],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.emit.code).toBe("UNCLAIMED");
    expect(result.emit.allow).toBe(false);
  });
});

describe("golden 8 — owner in Plaza does not receive speakToHumans=false room_say", () => {
  it("no owner-channel bypass on room_say", () => {
    const sender = {
      id: "agt_stagehand",
      kind: "agent" as const,
      ownerHumanId: "hum_owner",
      claimState: "claimed" as const,
      policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false },
      privacy: DEFAULT_AGENT_PRIVACY,
    };
    const result = authorize({
      sender,
      recipients: [owner],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.emit.allow).toBe(true);
    expect(result.deliveries[0]?.decision.allow).toBe(false);
    expect(result.deliveries[0]?.decision.capability).toBe("speakToHumans");
  });
});

describe("golden 9 — owner_reply recipients.length !== 1", () => {
  it("NOT_FOUND", () => {
    const result = authorize({
      sender: listenOnlyAgent,
      recipients: [owner, { ...owner, id: "hum_other" }],
      channel: "owner_reply",
      quota,
      isOwnerChannel: true,
    });
    expect(result.emit.code).toBe("NOT_FOUND");
    expect(result.emit.allow).toBe(false);
  });

  it("empty recipients also NOT_FOUND", () => {
    const result = authorize({
      sender: listenOnlyAgent,
      recipients: [],
      channel: "owner_reply",
      quota,
      isOwnerChannel: true,
    });
    expect(result.emit.code).toBe("NOT_FOUND");
  });
});

describe("golden 10 — non-owner owner_reply", () => {
  it("NOT_FOUND, not rewritten", () => {
    const result = authorize({
      sender: listenOnlyAgent,
      recipients: [{ ...owner, id: "hum_stranger" }],
      channel: "owner_reply",
      quota,
      isOwnerChannel: false,
    });
    expect(result.emit.code).toBe("NOT_FOUND");
    expect(result.emit.allow).toBe(false);
  });
});

describe("golden 11 — whisper assertAddressable", () => {
  it("human → lurker is NOT_ADDRESSABLE", () => {
    const result = authorize({
      sender: { id: "hum_a", kind: "human" },
      recipients: [
        {
          id: "hum_lurk",
          kind: "human",
          lurk: true,
          blocked: false,
          mutedByRecipient: false,
          privacy: { overhearableByAgents: true, addressableByHumans: true, addressableByAgents: true, overhearableByHumans: true },
        },
      ],
      channel: "whisper",
      requestedTargetId: "hum_lurk",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.emit.code).toBe("NOT_ADDRESSABLE");
    expect(result.emit.allow).toBe(false);
  });

  it("agent → addressableByAgents=false is NOT_ADDRESSABLE", () => {
    const result = authorize({
      sender: {
        id: "agt_a",
        kind: "agent",
        claimState: "claimed",
        policy: DEFAULT_AGENT_POLICY,
      },
      recipients: [
        {
          id: "hum_private",
          kind: "human",
          lurk: false,
          blocked: false,
          mutedByRecipient: false,
          privacy: {
            addressableByAgents: false,
            addressableByHumans: true,
            overhearableByAgents: true,
            overhearableByHumans: true,
          },
        },
      ],
      channel: "whisper",
      requestedTargetId: "hum_private",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.emit.code).toBe("NOT_ADDRESSABLE");
    expect(result.emit.allow).toBe(false);
  });
});

describe("badges", () => {
  it("listen-only", () => {
    expect(badges({ kind: "agent", claimState: "claimed", policy: listenOnlyPolicy() })).toEqual(["listen_only"]);
  });
  it("unclaimed", () => {
    expect(badges({ kind: "agent", claimState: "pending", policy: DEFAULT_AGENT_POLICY })).toEqual(["unclaimed"]);
  });
  it("backstage silent_to_humans", () => {
    expect(
      badges({
        kind: "agent",
        claimState: "claimed",
        policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false },
      }),
    ).toEqual(["speaks_to_agents", "silent_to_humans"]);
  });
  it("lurk human", () => {
    expect(badges({ kind: "human", lurk: true })).toEqual(["lurk"]);
  });
});

describe("defaults", () => {
  it("all four booleans on", () => {
    expect(DEFAULT_AGENT_POLICY).toEqual({
      listenToAgents: true,
      listenToHumans: true,
      speakToAgents: true,
      speakToHumans: true,
    });
  });
});

describe("filterPlazaSpeech (SSE spectator)", () => {
  it("speak_to_humans=false is absent from plaza SSE", () => {
    const sender = {
      id: "agt_stagehand",
      kind: "agent" as const,
      claimState: "claimed" as const,
      policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false },
      privacy: DEFAULT_AGENT_PRIVACY,
    };
    const spectator: PolicyContext["recipients"][number] = {
      id: "hum_sse",
      kind: "human",
      lurk: true,
      blocked: false,
      mutedByRecipient: false,
      synthetic: "spectator",
    };
    const result = authorize({
      sender,
      recipients: [spectator],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.deliveries[0]?.decision.allow).toBe(false);
  });

  it("speak_to_humans=true is delivered to plaza SSE", () => {
    const sender = {
      id: "agt_host",
      kind: "agent" as const,
      claimState: "claimed" as const,
      policy: DEFAULT_AGENT_POLICY,
      privacy: DEFAULT_AGENT_PRIVACY,
    };
    const spectator: PolicyContext["recipients"][number] = {
      id: "hum_sse",
      kind: "human",
      lurk: true,
      blocked: false,
      mutedByRecipient: false,
      synthetic: "spectator",
    };
    const result = authorize({
      sender,
      recipients: [spectator],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.deliveries[0]?.decision.allow).toBe(true);
  });
});

describe("extra branches", () => {
  it("blocked delivery", () => {
    const result = authorize({
      sender: { id: "hum_a", kind: "human" },
      recipients: [{ id: "hum_b", kind: "human", blocked: true, mutedByRecipient: false }],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.deliveries[0]?.decision.code).toBe("BLOCKED");
  });

  it("agent without listenToAgents does not hear other agents", () => {
    const result = authorize({
      sender: {
        id: "agt_a",
        kind: "agent",
        claimState: "claimed",
        policy: DEFAULT_AGENT_POLICY,
        privacy: DEFAULT_AGENT_PRIVACY,
      },
      recipients: [
        {
          id: "agt_b",
          kind: "agent",
          policy: { ...DEFAULT_AGENT_POLICY, listenToAgents: false },
          blocked: false,
          mutedByRecipient: false,
        },
      ],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.deliveries[0]?.decision.capability).toBe("listenToAgents");
  });

  it("write remaining exhausted is RATE_LIMITED", () => {
    const result = authorize({
      sender: { id: "hum_a", kind: "human" },
      recipients: [owner],
      channel: "room_say",
      room: plaza,
      quota: { ...quota, writeRemaining: 0 },
      isOwnerChannel: false,
    });
    expect(result.emit.code).toBe("RATE_LIMITED");
  });

  it("room that forbids room_say", () => {
    const result = authorize({
      sender: { id: "hum_a", kind: "human" },
      recipients: [owner],
      channel: "room_say",
      room: { ...plaza, allowsRoomSay: false },
      quota,
      isOwnerChannel: false,
    });
    expect(result.emit.code).toBe("ROOM_FORBIDDEN");
  });

  it("whisper to agent without speakToAgents", () => {
    const result = authorize({
      sender: {
        id: "agt_a",
        kind: "agent",
        claimState: "claimed",
        policy: { ...DEFAULT_AGENT_POLICY, speakToAgents: false },
      },
      recipients: [
        {
          id: "agt_b",
          kind: "agent",
          policy: DEFAULT_AGENT_POLICY,
          blocked: false,
          mutedByRecipient: false,
          privacy: DEFAULT_AGENT_PRIVACY,
        },
      ],
      channel: "whisper",
      requestedTargetId: "agt_b",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.emit.code).toBe("PERMISSION_DENIED");
    expect(result.emit.capability).toBe("speakToAgents");
  });

  it("agent room_say without speakToAgents is not delivered to agents", () => {
    const result = authorize({
      sender: {
        id: "agt_a",
        kind: "agent",
        claimState: "claimed",
        policy: { ...DEFAULT_AGENT_POLICY, speakToAgents: false },
        privacy: DEFAULT_AGENT_PRIVACY,
      },
      recipients: [
        {
          id: "agt_b",
          kind: "agent",
          policy: DEFAULT_AGENT_POLICY,
          blocked: false,
          mutedByRecipient: false,
        },
      ],
      channel: "room_say",
      room: plaza,
      quota,
      isOwnerChannel: false,
    });
    expect(result.emit.allow).toBe(true);
    expect(result.deliveries[0]?.decision.capability).toBe("speakToAgents");
  });
});
