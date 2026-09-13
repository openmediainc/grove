import { describe, expect, it } from "vitest";
import {
  spacePolicyForPreset,
  type PermissionPolicy,
  type PolicyContext,
  type QuotaSnapshot,
} from "@grove/protocol";
import { authorize } from "../src/authorize.js";

/**
 * The `reaction` channel: an emoji on a line, judged like the line.
 * Sender = reactor, the one recipient = the target's author.
 */

const open: QuotaSnapshot = { roomSayRemaining: 8, roomSayGapOk: true, writeRemaining: 30, roomWindowCount: 0 };
const plaza = {
  id: "plaza",
  kind: "public" as const,
  allowsRoomSay: true,
  allowsWhisper: true,
  sayLimitPerMin: 1 as number | null,
  capacity: 80,
};
const ALL: PermissionPolicy = { speakToAgents: true, speakToHumans: true, listenToAgents: true, listenToHumans: true };

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    sender: { id: "hum_r" as never, kind: "human" },
    recipients: [{ id: "hum_a" as never, kind: "human", blocked: false, mutedByRecipient: false }],
    channel: "reaction",
    room: { ...plaza },
    quota: open,
    isOwnerChannel: false,
    ...over,
  };
}

describe("authorize on the reaction channel", () => {
  it("allows a human reacting in an open room", () => {
    const r = authorize(ctx());
    expect(r.emit.allow).toBe(true);
    expect(r.deliveries[0]?.decision.allow).toBe(true);
  });

  it("is not held by the room_say gap or the room's per-minute line cap, only the write limiter", () => {
    const busy = { roomSayRemaining: 0, roomSayGapOk: false, writeRemaining: 5, roomWindowCount: 99 };
    expect(authorize(ctx({ quota: busy })).emit.allow).toBe(true);
    expect(authorize(ctx({ quota: { ...busy, writeRemaining: 0 } })).emit.code).toBe("RATE_LIMITED");
  });

  it("is forbidden where the room takes no public speech", () => {
    expect(authorize(ctx({ room: { ...plaza, allowsRoomSay: false } })).emit.code).toBe("ROOM_FORBIDDEN");
  });

  it("refuses a listen-only agent and an unclaimed one", () => {
    const mouthless = authorize(
      ctx({
        sender: {
          id: "agt_x" as never,
          kind: "agent",
          claimState: "claimed",
          policy: { ...ALL, speakToAgents: false, speakToHumans: false },
        },
      }),
    );
    expect(mouthless.emit).toMatchObject({ allow: false, code: "PERMISSION_DENIED", source: "actor" });
    const unclaimed = authorize(ctx({ sender: { id: "agt_y" as never, kind: "agent", claimState: "pending", policy: ALL } }));
    expect(unclaimed.emit.code).toBe("UNCLAIMED");
  });

  it("refuses a non-member visitor in a listen-only space, attributed to the space", () => {
    const r = authorize(ctx({ room: { ...plaza, policy: spacePolicyForPreset("public_view") } }));
    expect(r.emit).toMatchObject({ allow: false, code: "PERMISSION_DENIED", source: "space" });
  });

  it("does not deliver an agent's reaction to a human author when it may not speak to humans", () => {
    const r = authorize(
      ctx({
        sender: { id: "agt_x" as never, kind: "agent", claimState: "claimed", policy: { ...ALL, speakToHumans: false } },
      }),
    );
    expect(r.emit.allow).toBe(true);
    expect(r.deliveries[0]?.decision).toMatchObject({ allow: false, code: "PERMISSION_DENIED" });
  });

  it("reports a block as BLOCKED and a mute as MUTED (the service lets a mute through)", () => {
    const blocked = authorize(ctx({ recipients: [{ id: "hum_a" as never, kind: "human", blocked: true, mutedByRecipient: false }] }));
    expect(blocked.deliveries[0]?.decision.code).toBe("BLOCKED");
    const muted = authorize(ctx({ recipients: [{ id: "hum_a" as never, kind: "human", blocked: false, mutedByRecipient: true }] }));
    expect(muted.deliveries[0]?.decision.code).toBe("MUTED");
  });

  it("leaves room_say's limiter exactly as it was", () => {
    const busy = { roomSayRemaining: 8, roomSayGapOk: false, writeRemaining: 30, roomWindowCount: 0 };
    expect(authorize(ctx({ channel: "room_say", quota: busy })).emit.code).toBe("RATE_LIMITED");
  });
});
