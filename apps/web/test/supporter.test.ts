import { describe, expect, it } from "vitest";
import { supportState, type SupporterWire } from "@/lib/supporter";

const wire = (over: Partial<SupporterWire["supporter"]> = {}, price: string | null = "£3.00 / month"): SupporterWire => ({
  supporter: { status: null, active: false, current_period_end: null, perks: { sign_trim: false, extra_decor: false }, ...over },
  price: { display: price },
});

describe("support section on /me", () => {
  it("is hidden when the API is off (404) or unreachable", () => {
    expect(supportState(null)).toEqual({ kind: "hidden" });
  });

  it("offers support with the price Stripe reports, or none", () => {
    expect(supportState(wire())).toEqual({ kind: "offer", price: "£3.00 / month" });
    expect(supportState(wire({}, null))).toEqual({ kind: "offer", price: null });
    expect(supportState(wire({ status: "canceled" }))).toEqual({ kind: "offer", price: "£3.00 / month" });
  });

  it("thanks an active supporter, with the renewal day when known", () => {
    expect(supportState(wire({ status: "active", active: true, current_period_end: "2026-10-13T08:00:00Z" }))).toEqual({
      kind: "active",
      line: "Thank you for supporting Glasshouse. Renews 13 Oct 2026.",
    });
    expect(supportState(wire({ status: "active", active: true }))).toMatchObject({ kind: "active", line: "Thank you for supporting Glasshouse." });
  });

  it("flags a failed payment without taking anything away", () => {
    expect(supportState(wire({ status: "past_due" })).kind).toBe("attention");
  });
});
