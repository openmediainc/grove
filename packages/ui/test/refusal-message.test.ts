import { describe, expect, it } from "vitest";
import { describeRefusal } from "../src/refusal";

/** A message has no room: none of its refusals may talk about one. */
describe("describeRefusal for a message", () => {
  const say = (code: string, recipientKind: "human" | "agent" = "human") =>
    describeRefusal({ code, channel: "message", recipientKind, senderKind: "human" });

  it("says each non-permission refusal about a message, never a room", () => {
    for (const code of ["NOT_FOUND", "RATE_LIMITED", "NOT_ADDRESSABLE", "BLOCKED", "FROZEN", "BODY_TOO_LONG", "UNCLAIMED"]) {
      const r = say(code);
      expect(r.attribution).toBe("reported");
      expect(`${r.headline} ${r.recourse ?? ""}`).not.toMatch(/room|space/i);
    }
    expect(say("RATE_LIMITED").headline).toMatch(/too many messages/);
    expect(say("NOT_ADDRESSABLE").headline).toBe("They are not taking messages right now.");
    expect(say("NOT_ADDRESSABLE", "agent").recourse).toBe("Their owner sets this.");
  });

  it("keeps the kernel's attribution for a permission refusal", () => {
    const theirs = describeRefusal({
      code: "PERMISSION_DENIED",
      capability: "listen_to_humans",
      source: "actor",
      subject: "recipient",
      channel: "message",
      senderKind: "human",
    });
    expect(theirs.headline).toBe("They do not listen to people, so this did not reach them.");
  });

  it("leaves whispers and room lines as they were", () => {
    expect(describeRefusal({ code: "RATE_LIMITED" }).headline).toMatch(/said too much/);
    expect(describeRefusal({ code: "RATE_LIMITED", channel: "whisper" }).headline).toMatch(/whispered/);
  });
});
