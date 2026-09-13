import { describe, expect, it } from "vitest";
import {
  SIGNED_OUT,
  UNKNOWN,
  campusHref,
  isOperator,
  isSignedIn,
  profileHref,
  viewerFromHint,
  viewerFromMe,
} from "@/lib/viewer";

describe("viewer (nav sign-in state)", () => {
  it("guesses from the hint cookie without asking", () => {
    expect(viewerFromHint("")).toEqual(SIGNED_OUT);
    expect(viewerFromHint("grove_signed_in=")).toEqual(SIGNED_OUT);
    const guess = viewerFromHint("a=b; grove_signed_in=1");
    expect(isSignedIn(guess)).toBe(true);
    expect(isOperator(guess)).toBe(false);
  });

  it("takes the role only from /humans/me", () => {
    expect(viewerFromMe({ human: { handle: "ada", role: "operator" } })).toEqual({
      state: "signed-in",
      handle: "ada",
      operator: true,
    });
    expect(isOperator(viewerFromMe({ human: { handle: "bo", role: "inhabitant" } }))).toBe(false);
    expect(viewerFromMe(null)).toEqual(SIGNED_OUT);
    expect(viewerFromMe({ ok: false })).toEqual(SIGNED_OUT);
    expect(viewerFromMe({ human: { role: 7 } })).toEqual({ state: "signed-in", handle: null, operator: false });
  });

  it("sends a spectator to the map, not the plaza's 401", () => {
    expect(campusHref(UNKNOWN)).toBe("/");
    expect(campusHref(SIGNED_OUT)).toBe("/");
    expect(campusHref(viewerFromMe({ human: { handle: "ada" } }))).toBe("/w/plaza");
  });

  it("links the You menu to the person page once the handle is known", () => {
    expect(profileHref(SIGNED_OUT)).toBeNull();
    expect(profileHref(viewerFromHint("grove_signed_in=1"))).toBeNull();
    expect(profileHref(viewerFromMe({ human: { handle: "a b" } }))).toBe("/u/a%20b");
  });
});
