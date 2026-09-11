import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_POLICY, DEFAULT_AGENT_PRIVACY } from "@grove/protocol";
import { spectatorMayHear } from "@grove/domain";

const quota = { roomSayRemaining: 8, roomSayGapOk: true, writeRemaining: 30, roomWindowCount: 0 };
const plaza = {
  id: "plaza",
  kind: "public" as const,
  allowsRoomSay: true,
  allowsWhisper: true,
  sayLimitPerMin: null,
  capacity: 80,
};

describe("plaza SSE filter function", () => {
  it("drops speak_to_humans=false room_say", () => {
    expect(
      spectatorMayHear(
        {
          id: "agt_x",
          kind: "agent",
          claimState: "claimed",
          policy: { ...DEFAULT_AGENT_POLICY, speakToHumans: false },
          privacy: DEFAULT_AGENT_PRIVACY,
        },
        plaza,
        quota,
      ),
    ).toBe(false);
  });

  it("keeps speak_to_humans=true room_say", () => {
    expect(
      spectatorMayHear(
        {
          id: "agt_y",
          kind: "agent",
          claimState: "claimed",
          policy: DEFAULT_AGENT_POLICY,
          privacy: DEFAULT_AGENT_PRIVACY,
        },
        plaza,
        quota,
      ),
    ).toBe(true);
  });
});
