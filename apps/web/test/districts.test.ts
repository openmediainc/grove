import { describe, expect, it } from "vitest";
import { plotForIndex, ringCapacity } from "@grove/protocol";
import {
  districtLabelsVisible,
  districtStops,
  districtStopsKey,
  inDistrict,
  ringLabelAnchors,
  ringNumberLabel,
  searchDistrict,
} from "../lib/districts";
import { THEMES } from "../lib/themes/all";

const plot = (plotIndex: number, preset = "public_write") => ({ plotIndex, preset, rect: plotForIndex(plotIndex) });

describe("district words", () => {
  it("every theme names 6–8 districts and a heading", () => {
    for (const theme of Object.values(THEMES)) {
      const d = theme.lexicon.district;
      expect(d.heading.trim()).not.toBe("");
      expect(d.names.length).toBeGreaterThanOrEqual(6);
      expect(d.names.length).toBeLessThanOrEqual(8);
      expect(new Set(d.names).size).toBe(d.names.length);
    }
  });
  it("says where a plot is in the theme's words", () => {
    const names = THEMES.aoe.lexicon.district.names;
    expect(inDistrict(names, 0)).toBe(`in ${names[0]}`);
    expect(inDistrict(names, ringCapacity(2))).toBe(`in ${names[1]}`);
  });
  it("search stays neutral", () => {
    expect(searchDistrict(2)).toBe("in Ring 1");
    expect(searchDistrict(5)).toBe("in Ring 4");
    expect(searchDistrict(1)).toBe("");
    expect(searchDistrict(null)).toBe("");
    expect(ringNumberLabel({ ring: 3, ordinal: 2 })).toBe("ring 2");
  });
  it("labels only zoomed out", () => {
    expect(districtLabelsVisible(0.3)).toBe(true);
    expect(districtLabelsVisible(1)).toBe(false);
  });
});

describe("districtStops", () => {
  const names = ["A", "B", "C"];
  it("lists districts holding public plots, landing on the lowest plot", () => {
    const stops = districtStops(names, [plot(20), plot(3), plot(2)]);
    expect(stops.map((s) => [s.ordinal, s.name])).toEqual([
      [1, "A"],
      [2, "B"],
    ]);
    const r = plotForIndex(2);
    expect(stops[0]).toMatchObject({ tx: (r.x0 + r.x1) / 2, ty: (r.y0 + r.y1) / 2 });
  });
  it("a held plot never adds a district or moves a landing", () => {
    expect(districtStops(names, [plot(20, "private")])).toEqual([]);
    const stops = districtStops(names, [plot(1, "private"), plot(5)]);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.tx).toBe((plotForIndex(5).x0 + plotForIndex(5).x1) / 2);
  });
  it("keys change only with the list", () => {
    expect(districtStopsKey(districtStops(names, [plot(2), plot(3)]))).toBe(districtStopsKey(districtStops(names, [plot(3), plot(2)])));
  });
});

describe("ringLabelAnchors", () => {
  it("hangs labels on the ring's own band, north and south", () => {
    const [n, s] = ringLabelAnchors(2);
    expect(n!.apex).toBe("n");
    expect(s!.apex).toBe("s");
    expect(n!.tx).toBeLessThan(0);
    expect(s!.ty).toBeGreaterThan(17);
  });
});
