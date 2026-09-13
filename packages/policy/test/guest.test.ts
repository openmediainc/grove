import { describe, expect, it } from "vitest";
import { spacePolicyForPreset, type PolicyChannel, type PolicyContext, type QuotaSnapshot } from "@grove/protocol";
import { authorize } from "../src/authorize.js";

/**
 * A guest pass (queue #32): a signed-out visitor who may react and nothing
 * else, always at the non-member ceiling.
 */

const open: QuotaSnapshot = { roomSayRemaining: 8, roomSayGapOk: true, writeRemaining: 30, roomWindowCount: 0 };
const plaza = {
  id: "plaza",
  kind: "public" as const,
  allowsRoomSay: true,
  allowsWhisper: true,
  sayLimitPerMin: null as number | null,
  capacity: 80,
};

function guestCtx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    sender: { id: "gst_abc" as never, kind: "human", guest: true },
    recipients: [{ id: "hum_a" as never, kind: "human", blocked: false, mutedByRecipient: false }],
    channel: "reaction",
    room: { ...plaza },
    quota: open,
    isOwnerChannel: false,
    requestedTargetId: "hum_a" as never,
    ...over,
  };
}

describe("authorize for a guest", () => {
  it("allows a reaction in an open room", () => {
    const r = authorize(guestCtx());
    expect(r.emit.allow).toBe(true);
    expect(r.deliveries[0]?.decision.allow).toBe(true);
  });

  it("refuses every other channel with UNAUTHORIZED, before any other rule", () => {
    const channels: PolicyChannel[] = ["room_say", "whisper", "notice", "message", "owner_instruction", "owner_reply"];
    for (const channel of channels) {
      const r = authorize(guestCtx({ channel, isOwnerChannel: true }));
      expect({ channel, code: r.emit.code }).toEqual({ channel, code: "UNAUTHORIZED" });
      expect(r.deliveries).toEqual([]);
    }
  });

  it("is held to the non-member ceiling even when a caller claims membership", () => {
    // Members may speak, strangers only watch: a guest is always a stranger.
    const room = {
      ...plaza,
      policy: spacePolicyForPreset("public_view"),
      memberPolicy: spacePolicyForPreset("public_write"),
    };
    const member = authorize({ ...guestCtx({ room }), sender: { id: "hum_m" as never, kind: "human", isSpaceMember: true } });
    expect(member.emit.allow).toBe(true);
    const guest = authorize(guestCtx({ room, sender: { id: "gst_abc" as never, kind: "human", guest: true, isSpaceMember: true } }));
    expect(guest.emit.allow).toBe(false);
    expect(guest.emit.code).toBe("PERMISSION_DENIED");
  });

  it("is still stopped by the write limiter and a room that takes no lines", () => {
    expect(authorize(guestCtx({ quota: { ...open, writeRemaining: 0 } })).emit.code).toBe("RATE_LIMITED");
    expect(authorize(guestCtx({ room: { ...plaza, allowsRoomSay: false } })).emit.code).toBe("ROOM_FORBIDDEN");
  });
});
