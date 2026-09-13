import { describe, expect, it } from "vitest";
import { plotForIndex, ringCapacity } from "../src/map-layout.js";
import { plotBlock, plotsAdjacent } from "../src/estates.js";
import {
  RELOCATE_COOLDOWN_DAYS,
  TRANSFER_EXPIRY_DAYS,
  confirmsSlug,
  nextRelocationAt,
  plotDistance,
  relocationIndexLimit,
  relocationOptions,
  relocationRefusal,
  transferExpiresAt,
} from "../src/space-moves.js";

describe("space moves (queue #35)", () => {
  it("confirms only the exact slug, forgiving whitespace and case", () => {
    expect(confirmsSlug("north-yard", "north-yard")).toBe(true);
    expect(confirmsSlug("  North-Yard ", "north-yard")).toBe(true);
    expect(confirmsSlug("north", "north-yard")).toBe(false);
    expect(confirmsSlug("north-yard!", "north-yard")).toBe(false);
    expect(confirmsSlug("", "north-yard")).toBe(false);
    expect(confirmsSlug(undefined, "north-yard")).toBe(false);
    expect(confirmsSlug(42, "42")).toBe(false);
  });

  it("measures plot adjacency in blocks", () => {
    const b = plotBlock(0);
    expect(plotForIndex(0).x0).toBe(b.bx * 8);
    expect(plotDistance(0, 0)).toBe(0);
    expect(plotDistance(0, 1)).toBe(1);
    // Ring 2 has 16 plots; index 0 is the top-left corner, 8 the bottom-right corner.
    expect(plotDistance(0, 8)).toBe(4);
  });

  it("never offers a plot outside the drawn world", () => {
    expect(relocationIndexLimit(1)).toBe(ringCapacity(2) + ringCapacity(3));
    expect(relocationIndexLimit(16)).toBe(ringCapacity(2) + ringCapacity(3));
    expect(relocationIndexLimit(17)).toBe(ringCapacity(2) + ringCapacity(3) + ringCapacity(4));
  });

  it("offers free plots next to the holder's other plots first, then the lowest free", () => {
    const taken = [0, 1, 2, 3, 20];
    const opts = relocationOptions({ taken, current: 3, claimed: taken.length, anchors: [20], limit: 30 });
    const indices = opts.map((o) => o.plotIndex);
    expect(indices).not.toContain(3);
    for (const t of taken) expect(indices).not.toContain(t);
    const near = opts.filter((o) => o.near);
    expect(near.length).toBeGreaterThan(0);
    // Near ones lead the list and really touch the anchor.
    expect(opts.slice(0, near.length).every((o) => o.near)).toBe(true);
    for (const o of near) {
      expect(o.nextTo).toBe(20);
      expect(plotsAdjacent(o.plotIndex, 20)).toBe(true);
    }
    const rest = opts.filter((o) => !o.near).map((o) => o.plotIndex);
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
    expect(rest[0]).toBe([4, 5, 6, 7, 8, 9, 10].find((i) => !plotsAdjacent(i, 20)));
    expect(relocationOptions({ taken, current: 3, claimed: 5 }).length).toBe(12);
  });

  it("refuses the commons, the same plot, a bad index, the far rings and a second move within a week", () => {
    const now = Date.parse("2026-09-13T12:00:00Z");
    expect(relocationRefusal({ target: 4, current: null, claimed: 3, relocatedAt: null })).toMatch(/commons/);
    expect(relocationRefusal({ target: 2, current: 2, claimed: 3, relocatedAt: null })).toMatch(/already/);
    expect(relocationRefusal({ target: "4", current: 2, claimed: 3, relocatedAt: null })).toMatch(/Pick/);
    expect(relocationRefusal({ target: -1, current: 2, claimed: 3, relocatedAt: null })).toMatch(/Pick/);
    expect(relocationRefusal({ target: 999, current: 2, claimed: 3, relocatedAt: null })).toMatch(/outside/);
    expect(relocationRefusal({ target: 4, current: 2, claimed: 3, relocatedAt: null, now })).toBeNull();
    const yesterday = new Date(now - 86_400_000).toISOString();
    expect(relocationRefusal({ target: 4, current: 2, claimed: 3, relocatedAt: yesterday, now })).toMatch(/once a week/);
    const longAgo = new Date(now - (RELOCATE_COOLDOWN_DAYS + 1) * 86_400_000).toISOString();
    expect(relocationRefusal({ target: 4, current: 2, claimed: 3, relocatedAt: longAgo, now })).toBeNull();
    expect(nextRelocationAt(null)).toBeNull();
  });

  it("gives an offer seven days", () => {
    const at = Date.parse("2026-09-01T00:00:00Z");
    expect(transferExpiresAt(at).toISOString()).toBe(new Date(at + TRANSFER_EXPIRY_DAYS * 86_400_000).toISOString());
  });
});
