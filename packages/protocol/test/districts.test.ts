import { describe, expect, it } from "vitest";
import {
  districtForPlot,
  districtForRing,
  districtForTile,
  districtName,
  districtsHolding,
  neutralDistrictName,
  outermostRing,
  ringForPlotIndex,
  ringForTile,
  ringOuterRect,
  toRoman,
  worldDistricts,
} from "../src/districts.js";
import { MAP_COLS, MAP_ROWS, plotForIndex, ringCapacity, worldBounds } from "../src/map-layout.js";

const NAMES = ["Hearth Ring", "Mill Ring", "Orchard Ring"];

describe("rings", () => {
  it("the first ring of plots is ring 2, district 1", () => {
    expect(ringForPlotIndex(0)).toBe(2);
    expect(districtForPlot(0)).toEqual({ ring: 2, ordinal: 1 });
  });
  it("walks outward exactly at ring capacity", () => {
    const last2 = ringCapacity(2) - 1;
    expect(ringForPlotIndex(last2)).toBe(2);
    expect(ringForPlotIndex(last2 + 1)).toBe(3);
    const last3 = last2 + ringCapacity(3);
    expect(ringForPlotIndex(last3)).toBe(3);
    expect(ringForPlotIndex(last3 + 1)).toBe(4);
  });
  it("every tile of a plot is in that plot's ring", () => {
    for (const idx of [0, 7, 15, 16, 40, 41, 90]) {
      const r = plotForIndex(idx);
      const ring = ringForPlotIndex(idx);
      for (const [tx, ty] of [
        [r.x0, r.y0],
        [r.x1, r.y1],
        [r.x0, r.y1],
      ] as const)
        expect(ringForTile(tx, ty)).toBe(ring);
    }
  });
  it("the civic core is not a district", () => {
    expect(districtForTile(0, 0)).toBeNull();
    expect(districtForTile(MAP_COLS - 1, MAP_ROWS - 1)).toBeNull();
    expect(districtForTile(-1, 0)).toEqual({ ring: 2, ordinal: 1 });
    expect(districtForRing(1)).toBeNull();
    expect(districtForRing(Number.NaN)).toBeNull();
  });
  it("ring 1's outer square is the original civic grid", () => {
    const r = ringOuterRect(1);
    expect(r.x1 - r.x0 + 1).toBe(MAP_COLS);
    expect(r.y1 - r.y0 + 1).toBe(MAP_ROWS);
    expect(r).toEqual({ x0: 0, y0: 0, x1: MAP_COLS - 1, y1: MAP_ROWS - 1 });
  });
  it("the outermost ring's square is the world", () => {
    for (const plots of [0, 1, 16, 17, 56, 57]) expect(ringOuterRect(outermostRing(plots))).toEqual(worldBounds(plots));
  });
  it("lists the world's districts including the open ring", () => {
    expect(worldDistricts(0).map((d) => d.ordinal)).toEqual([1]);
    expect(worldDistricts(1).map((d) => d.ordinal)).toEqual([1, 2]);
    expect(worldDistricts(17).map((d) => d.ring)).toEqual([2, 3, 4]);
  });
});

describe("names", () => {
  it("names districts from the list, cycling with a numeral", () => {
    expect(districtName(NAMES, { ring: 2, ordinal: 1 })).toBe("Hearth Ring");
    expect(districtName(NAMES, { ring: 4, ordinal: 3 })).toBe("Orchard Ring");
    expect(districtName(NAMES, { ring: 5, ordinal: 4 })).toBe("Hearth Ring II");
    expect(districtName(NAMES, { ring: 8, ordinal: 7 })).toBe("Hearth Ring III");
  });
  it("falls back to the neutral name for an empty list", () => {
    expect(districtName([], { ring: 3, ordinal: 2 })).toBe("Ring 2");
    expect(districtName(["  "], { ring: 3, ordinal: 2 })).toBe("Ring 2");
    expect(neutralDistrictName({ ring: 2, ordinal: 1 })).toBe("Ring 1");
  });
  it("writes Roman numerals", () => {
    expect([1, 2, 4, 9, 14, 40, 1999].map(toRoman)).toEqual(["I", "II", "IV", "IX", "XIV", "XL", "MCMXCIX"]);
    expect(toRoman(0)).toBe("");
  });
});

describe("districtsHolding", () => {
  it("groups plots by district, inside out, with the lowest plot", () => {
    expect(districtsHolding([20, 3, 17, 2])).toEqual([
      { ring: 2, ordinal: 1, firstPlot: 2 },
      { ring: 3, ordinal: 2, firstPlot: 17 },
    ]);
  });
  it("ignores junk indices", () => {
    expect(districtsHolding([-1, 1.5, Number.NaN])).toEqual([]);
  });
});
