import { describe, expect, it } from "vitest";
import {
  FOLLOW_STATE_BATCH_MAX,
  parseFollowSubjectKey,
  parseFollowSubjects,
  LONG_TOOL_CALL_MS,
  describeFollowNotice,
  isFollowNoticeKind,
  isFollowSubject,
  toolCallNoticeKind,
} from "../src/index.js";

const agent = { kind: "agent" as const, slug: "ada", name: "Ada" };

describe("follows vocabulary", () => {
  it("knows its subjects and kinds", () => {
    expect(isFollowSubject("space")).toBe(true);
    expect(isFollowSubject("human")).toBe(false);
    expect(isFollowNoticeKind("agent.error")).toBe(true);
    expect(isFollowNoticeKind("agent.said")).toBe(false);
  });

  it("decides which finished spans are worth a notice", () => {
    expect(toolCallNoticeKind("error", 10)).toBe("agent.error");
    expect(toolCallNoticeKind("ok", LONG_TOOL_CALL_MS - 1)).toBeNull();
    expect(toolCallNoticeKind("ok", LONG_TOOL_CALL_MS)).toBe("agent.long_tool_call");
    expect(toolCallNoticeKind("cancelled", LONG_TOOL_CALL_MS * 3)).toBe("agent.long_tool_call");
    // Stalled is the server's guess about silence, not something that finished.
    expect(toolCallNoticeKind("stalled", LONG_TOOL_CALL_MS * 3)).toBeNull();
    expect(toolCallNoticeKind(null, null)).toBeNull();
  });

  it("says each notice in one line", () => {
    expect(describeFollowNotice("agent.error", { subject: agent, roomId: "plaza", errorText: "tsc exited 2" })).toBe(
      "Ada hit an error: tsc exited 2",
    );
    expect(describeFollowNotice("agent.error", { subject: agent, roomId: "plaza" })).toBe("Ada hit an error.");
    expect(
      describeFollowNotice("agent.error", { subject: agent, roomId: "plaza", tool: { name: "Bash", outcome: "error", durationMs: 4200 } }),
    ).toBe("Ada hit an error in Bash after 4.2s.");
    expect(
      describeFollowNotice("agent.long_tool_call", {
        subject: agent,
        roomId: "plaza",
        tool: { name: "Bash", outcome: "ok", durationMs: 185_000 },
      }),
    ).toBe("Ada finished Bash after 3m 5s.");
    expect(
      describeFollowNotice("space.stage_started", {
        subject: { kind: "space", slug: "hall", name: "The Hall" },
        roomId: "wld_1:stage",
        stage: { title: "Opening night", startsAt: "2026-09-13T20:00:00Z", endsAt: null },
      }),
    ).toBe("The Hall opened a stage event: Opening night.");
  });
});

describe("batch follow state subjects", () => {
  it("reads space:<ref> and agent:<slug>, slashes included", () => {
    expect(parseFollowSubjectKey("space:harbour")).toEqual({ key: "space:harbour", kind: "space", ref: "harbour" });
    expect(parseFollowSubjectKey(" agent:ada/scout_ab12 ")).toEqual({ key: "agent:ada/scout_ab12", kind: "agent", ref: "ada/scout_ab12" });
    for (const bad of ["human:ada", "space:", ":x", "harbour", "", `space:${"x".repeat(201)}`]) {
      expect(parseFollowSubjectKey(bad)).toBeNull();
    }
  });

  it("splits commas and repeats, dedupes, drops junk silently and refuses only too many", () => {
    const r = parseFollowSubjects(["space:a,agent:b,space:a", "nope,agent:b", "space:c"]);
    expect(r.subjects.map((s) => s.key)).toEqual(["space:a", "agent:b", "space:c"]);
    expect(r.tooMany).toBe(false);
    expect(parseFollowSubjects(undefined).subjects).toEqual([]);
    const many = Array.from({ length: FOLLOW_STATE_BATCH_MAX + 1 }, (_, i) => `space:s${i}`).join(",");
    expect(parseFollowSubjects(many).tooMany).toBe(true);
    const exact = Array.from({ length: FOLLOW_STATE_BATCH_MAX }, (_, i) => `space:s${i}`).join(",");
    expect(parseFollowSubjects(`${exact},space:s0`).tooMany).toBe(false);
  });
});
