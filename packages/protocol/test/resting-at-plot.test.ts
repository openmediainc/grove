import { describe, expect, it } from "vitest";
import { plotForIndex } from "../src/map-layout.js";
import {
  AWAY_ALPHA,
  MOTION_TIMING,
  PLOT_BUILDING,
  assignRestTiles,
  plotRestTiles,
  positionOf,
  restingAway,
  stepMotion,
  type Errand,
  type MotionContext,
} from "../src/motion.js";

const rect = plotForIndex(3);

function ctx(now: number): MotionContext {
  return {
    now,
    home: { x: rect.x0, y: rect.y0 },
    destinationFor: () => ({ x: 12, y: 8 }),
    path: (a, b) => [a, b],
  };
}

describe("resting at plot", () => {
  it("lies only on the plot, never on the building", () => {
    const tiles = plotRestTiles(rect);
    expect(tiles).toHaveLength(8 * 6 - PLOT_BUILDING.w * PLOT_BUILDING.h);
    for (const t of tiles) {
      expect(t.x >= rect.x0 && t.x <= rect.x1 && t.y >= rect.y0 && t.y <= rect.y1).toBe(true);
      const onBuilding =
        t.x >= rect.x0 + PLOT_BUILDING.dx &&
        t.x < rect.x0 + PLOT_BUILDING.dx + PLOT_BUILDING.w &&
        t.y >= rect.y0 + PLOT_BUILDING.dy &&
        t.y < rect.y0 + PLOT_BUILDING.dy + PLOT_BUILDING.h;
      expect(onBuilding).toBe(false);
    }
    // Door first: south face, centre.
    expect(tiles[0]).toEqual({ x: rect.x0 + PLOT_BUILDING.dx + 1, y: rect.y0 + PLOT_BUILDING.dy + PLOT_BUILDING.h });
  });

  it("gives every agent its own tile, the same one whatever order they arrive in", () => {
    const ids = ["agent_c", "agent_a", "agent_b", "agent_d"];
    const a = assignRestTiles(ids, rect);
    const b = assignRestTiles([...ids].reverse(), rect);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(new Set([...a.values()].map((t) => `${t.x},${t.y}`)).size).toBe(ids.length);
  });

  it("places no more agents than the plot has tiles", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `agent_${i}`);
    expect(assignRestTiles(ids, rect).size).toBe(plotRestTiles(rect).length);
  });

  it("is the resting state, and no errand moves it", () => {
    const tile = { x: rect.x0 + 1, y: rect.y1 };
    const m = restingAway(tile, 1000);
    expect(m.state).toBe("resting");
    expect(m.away).toBe(true);
    const errands: Errand[] = [
      { kind: "work", site: "workshop" },
      { kind: "fault" },
      { kind: "stall" },
      { kind: "blocked" },
      { kind: "sleep" },
      { kind: "approach", targetId: "someone" },
    ];
    for (const e of errands) {
      let s = m;
      for (let now = 1000; now < 1000 + MOTION_TIMING.commitMs * 10; now += 500) s = stepMotion(s, e, ctx(now));
      expect(s.state).toBe("resting");
      expect(positionOf(s, 99_999)).toEqual(tile);
    }
  });

  it("is dimmer than any live body, even one about to be evicted", () => {
    // presenceHealth.sleepingAlpha floors at 0.26.
    expect(AWAY_ALPHA).toBeLessThan(0.26);
    expect(AWAY_ALPHA).toBeGreaterThan(0);
  });
});
