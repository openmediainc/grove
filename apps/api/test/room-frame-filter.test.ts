import { describe, expect, it } from "vitest";
import { roomFrameFor } from "../src/realtime.js";

/**
 * A whisper said in a room is published on the room channel with its audience.
 * Before this filter every socket subscribed to the room received the body.
 */
const whisper = JSON.stringify({
  type: "speech",
  speech_id: "sp_1",
  channel: "whisper",
  sender_id: "hum_sender",
  target_id: "agt_target",
  body: "just between us",
  delivered_to: ["agt_target"],
  muted_hidden: [],
});

describe("room frame filter", () => {
  it("drops a whisper for a bystander in the room", () => {
    expect(roomFrameFor("hum_bystander", whisper)).toBeNull();
  });

  it("keeps the whole frame for the sender", () => {
    expect(roomFrameFor("hum_sender", whisper)).toBe(whisper);
  });

  it("gives the recipient the line but not the audience lists", () => {
    const out = JSON.parse(roomFrameFor("agt_target", whisper)!);
    expect(out.body).toBe("just between us");
    expect(out).not.toHaveProperty("delivered_to");
    expect(out).not.toHaveProperty("muted_hidden");
  });

  it("drops a room line the kernel filtered for this reader", () => {
    const say = JSON.stringify({ type: "speech", channel: "room_say", sender_id: "agt_a", body: "hi", delivered_to: ["hum_b"] });
    expect(roomFrameFor("hum_c", say)).toBeNull();
    expect(JSON.parse(roomFrameFor("hum_b", say)!).body).toBe("hi");
  });

  it("passes frames that carry no audience untouched", () => {
    const moved = JSON.stringify({ type: "moved", room: { id: "plaza" } });
    expect(roomFrameFor("hum_x", moved)).toBe(moved);
    expect(roomFrameFor("hum_x", "not json")).toBe("not json");
  });
});

describe("live reaction counts on the room channel", () => {
  const frame = JSON.stringify({
    type: "reaction_counts",
    target_kind: "speech",
    target_id: "sp_9",
    room_id: "library",
    counts: { heart: 2 },
    delivered_to: ["hum_author", "hum_heard"],
  });

  it("reaches the line's audience as counts, without the audience list", () => {
    for (const viewer of ["hum_author", "hum_heard"]) {
      const out = JSON.parse(roomFrameFor(viewer, frame)!);
      expect(out.counts).toEqual({ heart: 2 });
      expect(out).not.toHaveProperty("delivered_to");
      expect(out).not.toHaveProperty("sender_id");
    }
  });

  it("gives a reader the line never reached nothing", () => {
    expect(roomFrameFor("hum_elsewhere", frame)).toBeNull();
  });
});
