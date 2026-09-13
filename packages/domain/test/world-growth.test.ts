import { describe, expect, it } from "vitest";
import {
  MAP_COLS,
  MAP_ROWS,
  PLOT_COLS,
  PLOT_ROWS,
  blockRing,
  isCoreTile,
  plotForIndex,
  regionAt,
  ringCapacity,
  ringsNeeded,
  worldBounds,
} from "@grove/protocol";

const overlaps = (a: ReturnType<typeof plotForIndex>, b: ReturnType<typeof plotForIndex>) =>
  a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

describe("one world that grows", () => {
  it("keeps the civic core exactly where it was", () => {
    expect(MAP_COLS).toBe(3 * PLOT_COLS);
    expect(MAP_ROWS).toBe(3 * PLOT_ROWS);
    expect(isCoreTile(11, 8)).toBe(true);
    expect(regionAt(11, 8)).toBe("plaza");
  });

  it("never allocates a plot that overlaps the core", () => {
    for (let i = 0; i < 200; i++) {
      const p = plotForIndex(i);
      const corners: Array<[number, number]> = [
        [p.x0, p.y0],
        [p.x1, p.y1],
      ];
      for (const [x, y] of corners) {
        expect(isCoreTile(x, y)).toBe(false);
      }
    }
  });

  it("never allocates the same land twice", () => {
    const plots = Array.from({ length: 120 }, (_, i) => plotForIndex(i));
    for (let i = 0; i < plots.length; i++) {
      for (let j = i + 1; j < plots.length; j++) {
        expect(overlaps(plots[i]!, plots[j]!)).toBe(false);
      }
    }
  });

  it("is stable: a space keeps its plot for life", () => {
    expect(plotForIndex(37)).toEqual(plotForIndex(37));
    expect(plotForIndex(0)).not.toEqual(plotForIndex(1));
  });

  it("fills the inner ring before reaching outward", () => {
    const first = ringCapacity(2);
    for (let i = 0; i < first; i++) {
      const p = plotForIndex(i);
      expect(blockRing(p.x0 / PLOT_COLS, p.y0 / PLOT_ROWS)).toBe(2);
    }
    const next = plotForIndex(first);
    expect(blockRing(next.x0 / PLOT_COLS, next.y0 / PLOT_ROWS)).toBe(3);
  });

  it("ring capacity grows and matches the ring it describes", () => {
    expect(ringCapacity(1)).toBe(0);
    expect(ringCapacity(2)).toBe(16);
    expect(ringCapacity(3)).toBe(24);
    expect(ringsNeeded(0)).toBe(1);
    expect(ringsNeeded(16)).toBe(2);
    expect(ringsNeeded(17)).toBe(3);
  });

  it("always shows open land beyond what is claimed", () => {
    const empty = worldBounds(0);
    const busy = worldBounds(100);
    expect(busy.x1 - busy.x0).toBeGreaterThan(empty.x1 - empty.x0);
    const far = plotForIndex(99);
    expect(far.x0).toBeGreaterThanOrEqual(busy.x0);
    expect(far.x1).toBeLessThanOrEqual(busy.x1);
    expect(far.y0).toBeGreaterThanOrEqual(busy.y0);
    expect(far.y1).toBeLessThanOrEqual(busy.y1);
  });
});
