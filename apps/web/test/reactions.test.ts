import { describe, expect, it } from "vitest";
import { applyReaction, reactionChips, reactionRefusalText } from "../lib/reactions";

describe("reaction chips", () => {
  it("orders by the vocabulary, drops zeros, and marks the reader's own", () => {
    const chips = reactionChips({ counts: { party: 2, up: 1, heart: 0 }, mine: ["party"] });
    expect(chips.map((c) => [c.key, c.count, c.mine])).toEqual([
      ["up", 1, false],
      ["party", 2, true],
    ]);
  });

  it("reads a missing summary as empty", () => {
    expect(reactionChips(undefined)).toEqual([]);
  });
});

describe("applyReaction", () => {
  it("adds one and marks it mine", () => {
    expect(applyReaction({ counts: { up: 2 }, mine: [] }, "up", true)).toEqual({ counts: { up: 3 }, mine: ["up"] });
  });

  it("is idempotent for a reaction already held", () => {
    const s = { counts: { up: 1 }, mine: ["up" as const] };
    expect(applyReaction(s, "up", true)).toBe(s);
  });

  it("removes one, drops the key at zero, and never goes negative", () => {
    expect(applyReaction({ counts: { heart: 1 }, mine: ["heart"] }, "heart", false)).toEqual({ counts: {}, mine: [] });
    expect(applyReaction({ counts: {}, mine: [] }, "heart", false)).toEqual({ counts: {}, mine: [] });
  });

  it("keeps the reader's own in vocabulary order", () => {
    expect(applyReaction({ counts: { sprout: 1 }, mine: ["sprout"] }, "up", true).mine).toEqual(["up", "sprout"]);
  });
});

describe("reactionRefusalText", () => {
  it("never explains a 404", () => {
    expect(reactionRefusalText("NOT_FOUND")).toBe("You can react only to what reached you.");
  });
});
