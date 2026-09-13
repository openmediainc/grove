import { describe, expect, it } from "vitest";
import {
  spacePolicyForPreset,
  type PermissionPolicy,
  type PolicyContext,
  type QuotaSnapshot,
} from "@grove/protocol";
import { authorize } from "../src/authorize.js";

/**
 * The `follow_notice` channel: telling followers what a followed agent or space
 * did. Sender = the subject, recipients = followers, room = where it happened.
 */

const spent: QuotaSnapshot = { roomSayRemaining: 0, roomSayGapOk: false, writeRemaining: 0, roomWindowCount: 99 };
const ALL: PermissionPolicy = { speakToAgents: true, speakToHumans: true, listenToAgents: true, listenToHumans: true };
const room = {
  id: "wld_x:workshop",
  kind: "public" as const,
  allowsRoomSay: true,
  allowsWhisper: true,
  sayLimitPerMin: null as number | null,
  capacity: 20,
};
const agent = { id: "agt_s" as never, kind: "agent" as const, claimState: "claimed" as const, policy: ALL, ownerHumanId: "hum_o" as never };
const follower = (over: Partial<PolicyContext["recipients"][number]> = {}): PolicyContext["recipients"][number] => ({
  id: "hum_f" as never,
  kind: "human",
  blocked: false,
  mutedByRecipient: false,
  ...over,
});

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    sender: agent,
    recipients: [follower()],
    channel: "follow_notice",
    room: { ...room },
    quota: spent,
    isOwnerChannel: false,
    ...over,
  };
}

describe("authorize on the follow_notice channel", () => {
  it("tells a follower in an open room, with no quota and no mouth needed", () => {
    const r = authorize(ctx({ sender: { ...agent, policy: { ...ALL, speakToAgents: false, speakToHumans: false } } }));
    expect(r.emit.allow).toBe(true);
    expect(r.deliveries[0]?.decision.allow).toBe(true);
  });

  it("never reports out of an owner lounge, or for an unclaimed agent", () => {
    expect(authorize(ctx({ room: { ...room, kind: "owner_lounge" } })).emit.allow).toBe(false);
    expect(authorize(ctx({ sender: { ...agent, claimState: "pending" } })).emit.code).toBe("UNCLAIMED");
  });

  it("does not tell a non-member what happened in a private space, but tells a member", () => {
    const priv = { ...room, policy: spacePolicyForPreset("private") };
    const r = authorize(ctx({ room: priv, recipients: [follower(), follower({ id: "hum_m" as never, isSpaceMember: true })] }));
    expect(r.deliveries[0]?.decision).toMatchObject({ allow: false, code: "PERMISSION_DENIED", source: "space" });
    expect(r.deliveries[1]?.decision.allow).toBe(true);
  });

  it("tells a non-member of a public_view space: they could watch it happen", () => {
    const r = authorize(ctx({ room: { ...room, policy: spacePolicyForPreset("public_view") } }));
    expect(r.deliveries[0]?.decision.allow).toBe(true);
  });

  it("honours a private room inside a public space", () => {
    const r = authorize(
      ctx({ room: { ...room, policy: spacePolicyForPreset("public_write"), roomPolicy: spacePolicyForPreset("private") } }),
    );
    expect(r.deliveries[0]?.decision).toMatchObject({ allow: false, source: "room" });
  });

  it("silences a block and a mute, and an agent follower that cannot listen to agents", () => {
    const r = authorize(
      ctx({
        recipients: [
          follower({ blocked: true }),
          follower({ id: "hum_q" as never, mutedByRecipient: true }),
          { id: "agt_f" as never, kind: "agent", policy: { ...ALL, listenToAgents: false }, blocked: false, mutedByRecipient: false },
        ],
      }),
    );
    expect(r.deliveries.map((d) => d.decision.code)).toEqual(["BLOCKED", "MUTED", "PERMISSION_DENIED"]);
  });
});
