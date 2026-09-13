import { describe, expect, it } from "vitest";
import {
  badgeText,
  hasSignedInHint,
  inboxLabel,
  seenBody,
  seenPlan,
  shouldPoll,
  unreadTotal,
} from "../lib/unread";

describe("nav unread badge", () => {
  it("polls only with the signed-in hint and a visible tab", () => {
    expect(hasSignedInHint("")).toBe(false);
    expect(hasSignedInHint("grove_world=plaza")).toBe(false);
    expect(hasSignedInHint("grove_world=plaza; grove_signed_in=1")).toBe(true);
    expect(hasSignedInHint("grove_signed_in=")).toBe(false);
    expect(hasSignedInHint("not_grove_signed_in=1")).toBe(false);
    expect(shouldPoll("grove_signed_in=1", "visible")).toBe(true);
    expect(shouldPoll("grove_signed_in=1", "hidden")).toBe(false);
    expect(shouldPoll("", "visible")).toBe(false);
  });

  it("totals messages and notices, ignoring garbage", () => {
    expect(unreadTotal({ messages: 2, notices: 3 })).toBe(5);
    expect(unreadTotal(null)).toBe(0);
    expect(unreadTotal({ messages: -1, notices: Number.NaN })).toBe(0);
    expect(unreadTotal({ messages: 4 })).toBe(4);
  });

  it("says nothing at zero and caps at 9+", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(10)).toBe("9+");
    expect(inboxLabel(0)).toBe("Inbox");
    expect(inboxLabel(3)).toBe("Inbox, 3 unread");
  });

  it("marks seen what the inbox showed, or all when more are unread than listed", () => {
    const rows = [
      { id: "a", read_at: null },
      { id: "b", read_at: "2026-09-13T00:00:00Z" },
      { id: "c", read_at: null },
    ];
    expect(seenPlan(rows, 0)).toBeNull();
    expect(seenPlan(rows, 2)).toEqual({ ids: ["a", "c"] });
    expect(seenPlan(rows, 5)).toEqual({ all: true });
    expect(seenPlan([], 1)).toEqual({ all: true });
    expect(seenBody({ ids: ["a"] })).toEqual({ ids: ["a"] });
    expect(seenBody({ all: true })).toEqual({});
  });
});
