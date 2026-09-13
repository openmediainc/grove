import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  spacePolicyForPreset,
  type PolicyChannel,
  type PolicyContext,
  type QuotaSnapshot,
} from "@grove/protocol";
import { authorize } from "../src/authorize.js";

/**
 * Supporter status (queue #47) is cosmetic. No plot is paywalled and nothing a
 * supporter pays for changes who hears what. The kernel must give exactly the
 * same answer whether or not a sender or recipient is a supporter, and its
 * source must not mention supporters at all.
 */

const open: QuotaSnapshot = { roomSayRemaining: 8, roomSayGapOk: true, writeRemaining: 30, roomWindowCount: 0 };
const exhausted: QuotaSnapshot = { roomSayRemaining: 0, roomSayGapOk: false, writeRemaining: 0, roomWindowCount: 99 };
const baseRoom = {
  id: "plaza",
  kind: "public" as const,
  allowsRoomSay: true,
  allowsWhisper: true,
  sayLimitPerMin: null as number | null,
  capacity: 80,
};

const withSupporter = <T extends object>(o: T, on: boolean): T => ({ ...o, supporter: on, isSupporter: on, perks: { signTrim: on, extraDecor: on } });

describe("the permission kernel ignores supporter status", () => {
  const channels: PolicyChannel[] = ["room_say", "whisper", "notice", "message", "reaction", "follow_notice", "owner_instruction", "owner_reply"];
  const rooms = [
    baseRoom,
    { ...baseRoom, policy: spacePolicyForPreset("private") },
    { ...baseRoom, policy: spacePolicyForPreset("public_view"), memberPolicy: spacePolicyForPreset("public_write") },
    { ...baseRoom, allowsRoomSay: false, allowsWhisper: false },
  ];
  const senders: PolicyContext["sender"][] = [
    { id: "hum_s" as never, kind: "human" },
    { id: "hum_s" as never, kind: "human", isSpaceMember: true },
    { id: "gst_s" as never, kind: "human", guest: true },
    { id: "agt_s" as never, kind: "agent", claimState: "claimed", ownerHumanId: "hum_o" as never, policy: DEFAULT_AGENT_POLICY },
    { id: "agt_p" as never, kind: "agent", claimState: "pending", policy: DEFAULT_AGENT_POLICY },
  ];
  const recipients: PolicyContext["recipients"] = [
    { id: "hum_r" as never, kind: "human", blocked: false, mutedByRecipient: false },
    { id: "hum_b" as never, kind: "human", blocked: true, mutedByRecipient: false },
    { id: "agt_r" as never, kind: "agent", ownerHumanId: "hum_s" as never, policy: DEFAULT_AGENT_POLICY, blocked: false, mutedByRecipient: true },
  ];

  it("gives the same decision with or without supporter flags, across channels, rooms, senders and quotas", () => {
    let compared = 0;
    for (const channel of channels)
      for (const room of rooms)
        for (const sender of senders)
          for (const quota of [open, exhausted]) {
            const ctx: PolicyContext = {
              sender,
              recipients,
              channel,
              room,
              quota,
              isOwnerChannel: channel.startsWith("owner_"),
              requestedTargetId: channel === "whisper" || channel === "message" ? ("hum_r" as never) : null,
            };
            const plain = authorize(ctx);
            for (const on of [true, false]) {
              const flagged = authorize({
                ...ctx,
                sender: withSupporter(sender, on),
                recipients: recipients.map((r) => withSupporter(r, on)),
              });
              expect(flagged).toEqual(plain);
              compared += 1;
            }
          }
    expect(compared).toBeGreaterThan(300);
  });

  it("never reads supporter status in its source", () => {
    const src = path.resolve(__dirname, "../src");
    for (const file of fs.readdirSync(src)) {
      const text = fs.readFileSync(path.join(src, file), "utf8");
      expect({ file, mentions: /supporter|stripe|perk/i.test(text) }).toEqual({ file, mentions: false });
    }
  });
});
