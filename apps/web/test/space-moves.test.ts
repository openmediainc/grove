import { describe, expect, it } from "vitest";
import { canOfferTransfer, canRelocate, previewCells, timeLeft, transferBody } from "@/lib/space-moves";

describe("transfer & relocate on Manage (#35)", () => {
  const member = { kind: "member" as const, humanId: "hum_1" };

  it("keeps Offer the space disabled until a recipient is picked and the slug is typed", () => {
    expect(canOfferTransfer({ pick: null, typed: "yard", slug: "yard" })).toBe(false);
    expect(canOfferTransfer({ pick: member, typed: "", slug: "yard" })).toBe(false);
    expect(canOfferTransfer({ pick: member, typed: "yar", slug: "yard" })).toBe(false);
    expect(canOfferTransfer({ pick: member, typed: " Yard ", slug: "yard" })).toBe(true);
    expect(canOfferTransfer({ pick: member, typed: "yard", slug: "yard", busy: true })).toBe(false);
    expect(canOfferTransfer({ pick: member, typed: "yard", slug: "yard", pending: true })).toBe(false);
  });

  it("keeps Move disabled without a new plot, the slug, or while the space is cooling down", () => {
    const now = Date.parse("2026-09-13T00:00:00Z");
    const base = { current: 2, typed: "yard", slug: "yard", nextAllowedAt: null, now };
    expect(canRelocate({ ...base, target: null })).toBe(false);
    expect(canRelocate({ ...base, target: 2 })).toBe(false);
    expect(canRelocate({ ...base, target: 5, typed: "yards" })).toBe(false);
    expect(canRelocate({ ...base, target: 5 })).toBe(true);
    expect(canRelocate({ ...base, target: 5, nextAllowedAt: "2026-09-14T00:00:00Z" })).toBe(false);
    expect(canRelocate({ ...base, target: 5, nextAllowedAt: "2026-09-12T00:00:00Z" })).toBe(true);
  });

  it("sends the confirmation with the offer", () => {
    expect(transferBody(member, "yard", true)).toEqual({ to_human_id: "hum_1", confirm: "yard", leave: true });
    expect(transferBody({ kind: "org", orgId: "org_1" }, "yard", false)).toEqual({ to_org_id: "org_1", confirm: "yard", leave: false });
  });

  it("says how long an offer has left", () => {
    const now = Date.parse("2026-09-13T00:00:00Z");
    expect(timeLeft("2026-09-12T00:00:00Z", now)).toBe("ran out");
    expect(timeLeft("2026-09-13T00:30:00Z", now)).toBe("under an hour");
    expect(timeLeft("2026-09-13T05:00:00Z", now)).toBe("5 hours");
    expect(timeLeft("2026-09-18T01:00:00Z", now)).toBe("5 days");
  });

  it("draws the core, where the space is and where it would go, with no names", () => {
    const v = previewCells({ current: 0, taken: [1], anchors: [], options: [2, 3], target: 3 });
    const roles = v.cells.map((c) => c.role);
    expect(roles.filter((r) => r === "core")).toHaveLength(9);
    expect(roles).toContain("current");
    expect(roles).toContain("target");
    expect(roles).toContain("taken");
    expect(v.cols).toBe(4);
    for (const c of v.cells) expect(Object.keys(c).sort()).toEqual(["bx", "by", "role"]);
  });
});
