import { describe, expect, it } from "vitest";
import { isMessageRecipientKind, messagePartyPath, parseMessageTo } from "../src/index.js";

describe("messages vocabulary", () => {
  it("takes people and agents, never a space", () => {
    expect(isMessageRecipientKind("human")).toBe(true);
    expect(isMessageRecipientKind("agent")).toBe(true);
    expect(isMessageRecipientKind("space")).toBe(false);
  });

  it("reads `to` nested or flat, and refuses anything else", () => {
    expect(parseMessageTo({ to: { kind: "human", ref: " @ada " } })).toEqual({ kind: "human", ref: "ada" });
    expect(parseMessageTo({ to_kind: "agent", to_ref: "org/scout" })).toEqual({ kind: "agent", ref: "org/scout" });
    expect(parseMessageTo({ toKind: "agent", toRef: "scout" })).toEqual({ kind: "agent", ref: "scout" });
    expect(parseMessageTo({ to: "ada" })).toBeNull();
    expect(parseMessageTo({ to: { kind: "space", ref: "cove" } })).toBeNull();
    expect(parseMessageTo({ to: { kind: "human", ref: "   " } })).toBeNull();
    expect(parseMessageTo({ to: { kind: "human", ref: "x".repeat(201) } })).toBeNull();
    expect(parseMessageTo(null)).toBeNull();
  });

  it("links a party to its public profile", () => {
    expect(messagePartyPath({ kind: "human", ref: "ada" })).toBe("/u/ada");
    expect(messagePartyPath({ kind: "agent", ref: "org/scout bot" })).toBe("/a/org/scout%20bot");
  });
});
