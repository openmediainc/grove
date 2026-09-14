import { describe, expect, it } from "vitest";
import { nextFreePlotIndex, plotNeighbourhood, redactNeighbour } from "../src/claim-preview.js";
import { plotBlock } from "../src/estates.js";

describe("next free plot", () => {
  it("is the smallest index nobody holds, like the allocator", () => {
    expect(nextFreePlotIndex([])).toBe(0);
    expect(nextFreePlotIndex([0, 1, 2])).toBe(3);
    expect(nextFreePlotIndex([0, 2, 3])).toBe(1);
    expect(nextFreePlotIndex([1, 2])).toBe(0);
  });
  it("ignores junk and does not change its input", () => {
    const taken = [0, -1, 1.5, Number.NaN, 1];
    expect(nextFreePlotIndex(taken)).toBe(2);
    expect(taken).toEqual([0, -1, 1.5, Number.NaN, 1]);
  });
});

describe("neighbourhood", () => {
  it("lists only held plots whose block touches the target's, never the target", () => {
    const target = 3;
    const taken = Array.from({ length: 60 }, (_, i) => i);
    const near = plotNeighbourhood(target, taken);
    expect(near).not.toContain(target);
    const t = plotBlock(target);
    for (const i of near) {
      const b = plotBlock(i);
      expect(Math.max(Math.abs(b.bx - t.bx), Math.abs(b.by - t.by))).toBe(1);
    }
    // At most the eight blocks around it.
    expect(near.length).toBeLessThanOrEqual(8);
    expect(near.length).toBeGreaterThan(0);
    expect([...near].sort((a, b) => a - b)).toEqual(near);
  });
  it("is empty on bare ground", () => {
    expect(plotNeighbourhood(0, [])).toEqual([]);
  });
});

describe("redaction", () => {
  it("drops a private plot to held: no name, orgs or branding", () => {
    expect(
      redactNeighbour({
        plotIndex: 4,
        policyPreset: "private",
        name: "Secret",
        orgs: [{ name: "Org", colour: "#123456" }],
        branding: { accent: "#7dd3fc", signText: "hi", emblem: "leaf" },
      }),
    ).toEqual({ plotIndex: 4, policyPreset: "private", name: null, orgs: [], branding: null });
  });
  it("keeps a public plot's public face", () => {
    const n = redactNeighbour({
      plotIndex: 5,
      policyPreset: "public_view",
      name: "Porch",
      orgs: [{ name: "Org", colour: "#123456" }],
      branding: { accent: "#7dd3fc", signText: null, emblem: null },
    });
    expect(n.name).toBe("Porch");
    expect(n.orgs).toEqual([{ name: "Org", colour: "#123456" }]);
    expect(n.branding?.accent).toBe("#7dd3fc");
  });
});
