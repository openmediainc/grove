import { describe, expect, it } from "vitest";
import { BODY_EXTENT, bodyScreenRect, clearCentre, holeRuns, hoverCardSpot, overlaps, type Rect } from "../lib/layering";

const VIEW = { w: 800, h: 600 };

function covered(runs: Rect[], x: number, y: number): number {
  return runs.filter((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1).length;
}

describe("bodyScreenRect", () => {
  it("scales the body's extent with zoom round its screen anchor", () => {
    const r = bodyScreenRect(100, 50, 2, 10, -20);
    expect(r).toEqual({
      x0: 210 - BODY_EXTENT.left * 2,
      x1: 210 + BODY_EXTENT.right * 2,
      y0: 80 - BODY_EXTENT.up * 2,
      y1: 80 + BODY_EXTENT.down * 2,
    });
  });
});

describe("holeRuns", () => {
  it("covers every point of overlapping bodies exactly once (even-odd safe)", () => {
    const bodies = [
      { x0: 100, y0: 100, x1: 160, y1: 180 },
      { x0: 130, y0: 140, x1: 200, y1: 220 },
      { x0: 400, y0: 300, x1: 420, y1: 310 },
    ];
    const runs = holeRuns(bodies, 8, VIEW);
    for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) expect(overlaps(runs[i]!, runs[j]!)).toBe(false);
    for (const b of bodies) {
      for (let x = b.x0; x < b.x1; x += 3) for (let y = b.y0; y < b.y1; y += 3) expect(covered(runs, x, y)).toBe(1);
    }
    // Far from any body, nothing is cut.
    expect(covered(runs, 700, 50)).toBe(0);
  });

  it("clips to the viewport and handles no bodies", () => {
    expect(holeRuns([], 8, VIEW)).toEqual([]);
    const runs = holeRuns([{ x0: -50, y0: -50, x1: 10, y1: 10 }], 8, VIEW);
    for (const r of runs) {
      expect(r.x0).toBeGreaterThanOrEqual(0);
      expect(r.y0).toBeGreaterThanOrEqual(0);
    }
    expect(covered(runs, 5, 5)).toBe(1);
  });
});

describe("hoverCardSpot", () => {
  const card = { w: 460, h: 60 };
  it("stays bottom-left when the body is elsewhere", () => {
    expect(hoverCardSpot({ x0: 600, y0: 100, x1: 640, y1: 150 }, card, VIEW)).toEqual({ x: 12, y: 528 });
    expect(hoverCardSpot(null, card, VIEW)).toEqual({ x: 12, y: 528 });
  });
  it("moves off a body it would cover", () => {
    const body = { x0: 40, y0: 540, x1: 80, y1: 590 };
    const spot = hoverCardSpot(body, card, VIEW);
    expect(overlaps({ x0: spot.x, y0: spot.y, x1: spot.x + card.w, y1: spot.y + card.h }, body)).toBe(false);
  });
});

describe("clearCentre", () => {
  it("is the middle with nothing open", () => {
    expect(clearCentre(VIEW, [])).toEqual({ x: 400, y: 300 });
  });
  it("frames left of a right-docked drawer", () => {
    expect(clearCentre({ w: 1400, h: 900 }, [{ x0: 980, y0: 0, x1: 1400, y1: 900 }])).toEqual({ x: 490, y: 450 });
  });
  it("frames above a phone bottom sheet", () => {
    expect(clearCentre({ w: 390, h: 800 }, [{ x0: 0, y0: 112, x1: 390, y1: 800 }])).toEqual({ x: 195, y: 56 });
  });
  it("ignores a cover that leaves almost nothing clear", () => {
    expect(clearCentre({ w: 390, h: 800 }, [{ x0: 0, y0: 40, x1: 390, y1: 800 }])).toEqual({ x: 195, y: 400 });
  });
});
