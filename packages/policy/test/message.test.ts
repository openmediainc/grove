import { describe, expect, it } from "vitest";
import {
  spacePolicyForPreset,
  type PermissionPolicy,
  type PolicyContext,
  type QuotaSnapshot,
} from "@grove/protocol";
import { authorize } from "../src/authorize.js";

/**
 * The `message` channel: a note left for one person or agent. No room, so no
 * space or room ceiling can refuse it (and so no refusal can say where the
 * recipient is standing); their door, a block, both actors' own settings and
 * the write limiter can.
 */

const open: QuotaSnapshot = { roomSayRemaining: 0, roomSayGapOk: false, writeRemaining: 5, roomWindowCount: 99 };
const ALL: PermissionPolicy = { speakToAgents: true, speakToHumans: true, listenToAgents: true, listenToHumans: true };
const human = { id: "hum_s" as never, kind: "human" as const };
const agentSender = { id: "agt_s" as never, kind: "agent" as const, claimState: "claimed" as const, policy: ALL, ownerHumanId: "hum_o" as never };
const person = (over: Partial<PolicyContext["recipients"][number]> = {}): PolicyContext["recipients"][number] => ({
  id: "hum_r" as never,
  kind: "human",
  blocked: false,
  mutedByRecipient: false,
  ...over,
});
const agentRecipient = (over: Partial<PolicyContext["recipients"][number]> = {}): PolicyContext["recipients"][number] => ({
  id: "agt_r" as never,
  kind: "agent",
  ownerHumanId: "hum_x" as never,
  policy: ALL,
  blocked: false,
  mutedByRecipient: false,
  ...over,
});

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    sender: human,
    recipients: [person()],
    channel: "message",
    quota: open,
    isOwnerChannel: false,
    ...over,
  };
}

describe("authorize on the message channel", () => {
  it("lets a person leave a message for a person or an agent, with no room and a spent say gap", () => {
    for (const r of [person(), agentRecipient()]) {
      const res = authorize(ctx({ recipients: [r] }));
      expect(res.emit.allow).toBe(true);
      expect(res.deliveries[0]?.decision.allow).toBe(true);
    }
  });

  it("ignores any room it is handed, so a private space can neither refuse it nor be named", () => {
    const res = authorize(
      ctx({
        recipients: [person({ isSpaceMember: true })],
        room: {
          id: "wld_p:hall",
          kind: "public",
          allowsRoomSay: false,
          allowsWhisper: false,
          sayLimitPerMin: 1,
          capacity: 1,
          policy: spacePolicyForPreset("private"),
        },
      }),
    );
    expect(res.emit.allow).toBe(true);
    expect(res.deliveries[0]?.decision.allow).toBe(true);
    expect(JSON.stringify(res)).not.toMatch(/space|room/i);
  });

  it("is charged to the write limiter only", () => {
    const res = authorize(ctx({ quota: { ...open, writeRemaining: 0 } }));
    expect(res.emit).toMatchObject({ allow: false, code: "RATE_LIMITED" });
    expect(res.deliveries).toEqual([]);
  });

  it("needs exactly one recipient", () => {
    expect(authorize(ctx({ recipients: [] })).emit.code).toBe("NOT_FOUND");
    expect(authorize(ctx({ recipients: [person(), person({ id: "hum_2" as never })] })).emit.code).toBe("NOT_FOUND");
  });

  it("respects the recipient's door and attributes it to them", () => {
    const lurking = authorize(ctx({ recipients: [person({ lurk: true })] }));
    expect(lurking.emit).toMatchObject({ allow: false, code: "NOT_ADDRESSABLE", source: "actor", subject: "recipient" });
    const closed = authorize(
      ctx({
        sender: agentSender,
        recipients: [agentRecipient({ privacy: { addressableByAgents: false, addressableByHumans: true, overhearableByAgents: true, overhearableByHumans: true } })],
      }),
    );
    expect(closed.emit.code).toBe("NOT_ADDRESSABLE");
  });

  it("refuses across a block, unattributed", () => {
    const res = authorize(ctx({ recipients: [person({ blocked: true })] }));
    expect(res.emit).toEqual({ allow: false, code: "BLOCKED", reason: "Blocked." });
  });

  it("refuses an agent whose owner has not granted the mouth, as the sender's own setting", () => {
    const res = authorize(ctx({ sender: { ...agentSender, policy: { ...ALL, speakToHumans: false } } }));
    expect(res.emit).toMatchObject({ allow: false, code: "PERMISSION_DENIED", capability: "speakToHumans", source: "actor", subject: "sender" });
  });

  it("refuses an agent recipient that does not listen to that kind, as theirs", () => {
    const res = authorize(ctx({ recipients: [agentRecipient({ policy: { ...ALL, listenToHumans: false } })] }));
    expect(res.emit.allow).toBe(true);
    expect(res.deliveries[0]?.decision).toMatchObject({
      allow: false,
      code: "PERMISSION_DENIED",
      capability: "listenToHumans",
      source: "actor",
      subject: "recipient",
    });
  });

  it("marks a mute invisible, so the service can keep it from the reader without telling the sender", () => {
    const res = authorize(ctx({ recipients: [person({ mutedByRecipient: true })] }));
    expect(res.deliveries[0]?.decision).toMatchObject({ allow: false, code: "MUTED", visibleInUi: false });
  });

  it("refuses an unclaimed agent", () => {
    const res = authorize(ctx({ sender: { ...agentSender, claimState: "pending" } }));
    expect(res.emit.code).toBe("UNCLAIMED");
  });
});
