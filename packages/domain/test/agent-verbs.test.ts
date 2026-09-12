import { describe, expect, it } from "vitest";
import { groveVerb, isActiveVerb, paperclipVerb, regionForVerb } from "@grove/protocol";

describe("agent verbs", () => {
  it("maps grove presence to the agent loop", () => {
    expect(groveVerb("chatting", "async")).toBe("say");
    expect(groveVerb("working", "async")).toBe("tool");
    expect(groveVerb("reading", "async")).toBe("read");
    expect(groveVerb("listening", "live")).toBe("wait");
    expect(groveVerb("idle", "live")).toBe("think");
    expect(groveVerb("idle", "async")).toBe("idle");
    expect(groveVerb("idle", "offline")).toBe("offline");
    expect(groveVerb("error", "async")).toBe("error");
  });

  it("maps paperclip status + issue + heartbeat", () => {
    const now = Date.parse("2026-09-12T18:00:00.000Z");
    expect(paperclipVerb({ status: "error", now })).toBe("error");
    expect(paperclipVerb({ status: "idle", issueStatus: "blocked", now })).toBe("blocked");
    expect(paperclipVerb({ status: "idle", executionState: "running", now })).toBe("tool");
    expect(
      paperclipVerb({ status: "idle", lastHeartbeatAt: "2026-09-12T17:50:00.000Z", now }),
    ).toBe("think");
    expect(
      paperclipVerb({ status: "idle", lastHeartbeatAt: "2026-09-12T10:00:00.000Z", now }),
    ).toBe("idle");
    expect(paperclipVerb({ status: "idle", now })).toBe("offline");
  });

  it("sends blocked/fault to the board and tools to the workshop", () => {
    expect(regionForVerb("blocked", "ceo")).toBe("board");
    expect(regionForVerb("error", "engineer")).toBe("board");
    expect(regionForVerb("tool", "engineer")).toBe("workshop");
    expect(regionForVerb("say", "engineer")).toBe("plaza");
    expect(isActiveVerb("tool")).toBe(true);
    expect(isActiveVerb("offline")).toBe(false);
  });
});
