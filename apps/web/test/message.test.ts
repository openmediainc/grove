import { describe, expect, it } from "vitest";
import {
  composeTitle,
  draftProblem,
  draftRemaining,
  messageRequestBody,
  messageTargetFromCard,
  messageTargetKey,
  partyHref,
  replyTarget,
  type WireMessage,
} from "../lib/message";
import { THEMES } from "../lib/themes/all";

function msg(over: Partial<WireMessage> = {}): WireMessage {
  return {
    id: "msg_1",
    from: { kind: "human", ref: "ada", name: "Ada" },
    to: { kind: "agent", ref: "org/scout", name: "Scout" },
    body: "hello",
    reply_to: null,
    untrusted: true,
    created_at: "2026-09-13T12:00:00Z",
    read_at: null,
    ...over,
  };
}

describe("leave a message", () => {
  it("offers a compose box for people and agents, never for a space", () => {
    expect(messageTargetFromCard({ subject: "agent", slug: "org/scout" }, "Scout")).toEqual({ kind: "agent", ref: "org/scout", name: "Scout" });
    expect(messageTargetFromCard({ subject: "human", slug: "ada" })).toEqual({ kind: "human", ref: "ada", name: undefined });
    expect(messageTargetFromCard({ subject: "space", ref: "cove" })).toBeNull();
    expect(messageTargetFromCard(null)).toBeNull();
    expect(messageTargetKey({ kind: "agent", ref: "org/scout" })).toBe("agent:org/scout");
  });

  it("refuses an empty or over-long draft before it is sent", () => {
    expect(draftProblem("   ")).toBe("empty");
    expect(draftProblem("hi")).toBeNull();
    expect(draftProblem("x".repeat(1001))).toBe("too_long");
    // Graphemes, not UTF-16 units: a family emoji is one.
    expect(draftProblem("👨‍👩‍👧".repeat(1000))).toBeNull();
    expect(draftRemaining("  abc  ")).toBe(997);
  });

  it("posts the recipient by handle, trimmed, with a reply only when there is one", () => {
    expect(messageRequestBody({ kind: "human", ref: "ada" }, "  hi  ")).toEqual({ to: { kind: "human", ref: "ada" }, body: "hi" });
    expect(messageRequestBody({ kind: "agent", ref: "org/scout" }, "ok", "msg_9")).toEqual({
      to: { kind: "agent", ref: "org/scout" },
      body: "ok",
      reply_to: "msg_9",
    });
  });

  it("answers whoever sent it, and links only parties that still exist", () => {
    expect(replyTarget(msg())).toEqual({ kind: "human", ref: "ada", name: "Ada" });
    expect(replyTarget(msg({ from: { kind: "human", ref: "", name: "Someone who has left" } }))).toBeNull();
    expect(partyHref(msg().from)).toBe("/u/ada");
    expect(partyHref(msg().to)).toBe("/a/org/scout");
    expect(partyHref({ kind: "agent", ref: "org/x?y#z", name: "x" })).toBe("/a/org/x%3Fy%23z");
    expect(partyHref({ kind: "human", ref: "", name: "gone" })).toBeNull();
  });

  it("has the button's words in every theme", () => {
    for (const id of ["aoe", "space", "city", "scifi"] as const) {
      expect(THEMES[id].lexicon.card.message.length).toBeGreaterThan(0);
    }
    expect(composeTitle("Leave a message", { kind: "human", ref: "ada", name: "Ada" })).toBe("Leave a message for Ada");
    expect(composeTitle("Leave a message", { kind: "human", ref: "ada" })).toBe("Leave a message");
  });
});
