import { describe, expect, it } from "vitest";
import {
  guestChipLabel,
  guestFollowHref,
  guestFollowLine,
  guestSignInHref,
  hasGuestHint,
} from "@/lib/guest";

describe("guest pass (signed-out reactions and follows)", () => {
  it("asks about a guest only when the hint cookie says one exists", () => {
    expect(hasGuestHint("")).toBe(false);
    expect(hasGuestHint("grove_guest_hint=")).toBe(false);
    expect(hasGuestHint("grove_signed_in=1")).toBe(false);
    // The httpOnly cookie is never script-visible; only the hint counts.
    expect(hasGuestHint("grove_guest=abc")).toBe(false);
    expect(hasGuestHint("a=b; grove_guest_hint=1")).toBe(true);
  });

  it("says what signing in adds, with a count", () => {
    expect(guestFollowLine(0)).toMatch(/Sign in to get notified/);
    expect(guestFollowLine(1)).toBe("You follow 1 thing — sign in to get notified.");
    expect(guestFollowLine(3)).toBe("You follow 3 things — sign in to get notified.");
    expect(guestChipLabel(0)).toBe("Guest");
    expect(guestChipLabel(2)).toBe("Following 2");
  });

  it("links a followed space and agent to their pages", () => {
    expect(guestFollowHref({ subject: "space", slug: "harbour light" })).toMatch(/^\/s\/harbour%20light/);
    expect(guestFollowHref({ subject: "agent", slug: "scout" })).toMatch(/^\/a\/scout/);
  });

  it("sends a guest to sign in with a reason and a way back", () => {
    const href = guestSignInHref("/chronicle?win=24h");
    const q = new URLSearchParams(href.split("?")[1]);
    expect(href.startsWith("/login?")).toBe(true);
    expect(q.get("next")).toBe("/chronicle?win=24h");
    expect(q.get("why")).toBe("guest");
  });
});
