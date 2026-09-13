import { describe, expect, it } from "vitest";
import { REGION_RECTS } from "../src/map-layout.js";
import {
  CIVIC_FOOTPRINT,
  MOTION_TIMING,
  approachTile,
  assignWorkSlots,
  doorTile,
  errandFor,
  findPath,
  meetingTiles,
  pointAlong,
  positionOf,
  restingAt,
  routeLength,
  simplifyRoute,
  stepMotion,
  tripMs,
  workSlots,
  type BodyMotion,
  type Errand,
  type MotionContext,
  type SiteRegion,
  type Tile,
  type WorldGrid,
} from "../src/motion.js";

/** The campus as the web dressing lays it out: six 4x4 buildings, the avenues. */
function campusGrid(extraBlocked: Tile[] = []): WorldGrid {
  const blocked = new Set<string>(extraBlocked.map((t) => `${t.x},${t.y}`));
  for (const r of Object.values(REGION_RECTS)) {
    for (let y = r.y0 + CIVIC_FOOTPRINT.dy; y < r.y0 + CIVIC_FOOTPRINT.dy + CIVIC_FOOTPRINT.h; y++) {
      for (let x = r.x0 + CIVIC_FOOTPRINT.dx; x < r.x0 + CIVIC_FOOTPRINT.dx + CIVIC_FOOTPRINT.w; x++) {
        blocked.add(`${x},${y}`);
      }
    }
  }
  const avenues = (x: number, y: number) => x === 9 || x === 14 || y === 6 || y === 11;
  return {
    blocked: (x, y) => blocked.has(`${x},${y}`),
    isPath: (x, y) => avenues(x, y) && !blocked.has(`${x},${y}`),
  };
}

const grid = campusGrid();

describe("errands: what the signals say a body is for", () => {
  it("sends tool work to the workshop and reading to the library", () => {
    expect(errandFor({ verb: "tool" })).toEqual({ kind: "work", site: "workshop" });
    expect(errandFor({ verb: "read" })).toEqual({ kind: "work", site: "library" });
  });

  it("does thinking, waiting, idling and room speech at home", () => {
    for (const verb of ["think", "wait", "idle", "say"] as const) {
      expect(errandFor({ verb })).toEqual({ kind: "rest" });
    }
  });

  it("lets an open tool call outrank a think pulse sent between parallel calls", () => {
    expect(errandFor({ verb: "think", openToolCalls: 2 })).toEqual({ kind: "work", site: "workshop" });
  });

  it("puts stall ahead of the claimed verb, and sleep ahead of everything", () => {
    expect(errandFor({ verb: "tool", stalled: true, openToolCalls: 1 })).toEqual({ kind: "stall" });
    expect(errandFor({ verb: "tool", stalled: true, connection: "offline" })).toEqual({ kind: "sleep" });
    expect(errandFor({ verb: "offline" })).toEqual({ kind: "sleep" });
  });

  it("separates a fault (stay put) from blocked (go to the Board)", () => {
    expect(errandFor({ verb: "error" })).toEqual({ kind: "fault" });
    expect(errandFor({ verb: "blocked" })).toEqual({ kind: "blocked" });
  });

  it("approaches only when the server names an addressee", () => {
    expect(errandFor({ verb: "say", addressing: "agt_b" })).toEqual({ kind: "approach", targetId: "agt_b" });
    expect(errandFor({ verb: "say", addressing: null })).toEqual({ kind: "rest" });
  });
});

describe("work sites", () => {
  it("never offers a slot inside a building", () => {
    for (const region of Object.keys(REGION_RECTS) as SiteRegion[]) {
      const slots = workSlots(region, grid);
      expect(slots.length).toBeGreaterThan(8);
      for (const s of slots) expect(grid.blocked(s.x, s.y)).toBe(false);
    }
  });

  it("orders slots from the door outward", () => {
    const door = doorTile("workshop");
    const slots = workSlots("workshop", grid);
    expect(slots[0]).toEqual(door);
    const d = (t: Tile) => Math.abs(t.x - door.x) + Math.abs(t.y - door.y);
    for (let i = 1; i < slots.length; i++) expect(d(slots[i]!)).toBeGreaterThanOrEqual(d(slots[i - 1]!));
  });

  it("drops slots the furniture owns", () => {
    const door = doorTile("library");
    const withBench = campusGrid([door]);
    expect(workSlots("library", withBench)).not.toContainEqual(door);
  });

  it("gives every worker its own tile, deterministically", () => {
    const reqs = Array.from({ length: 10 }, (_, i) => ({ id: `agt_${i}`, site: "workshop" as const, since: i }));
    const a = assignWorkSlots(reqs, grid);
    const b = assignWorkSlots([...reqs].reverse(), grid);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    const keys = new Set([...a.values()].map((t) => `${t.x},${t.y}`));
    expect(keys.size).toBe(10);
  });

  it("keeps an earlier worker on its slot when a newcomer hashes to the same one", () => {
    const first = assignWorkSlots([{ id: "agt_first", site: "library", since: 1 }], grid).get("agt_first")!;
    // Find a newcomer id whose preferred slot collides with the first.
    const slots = workSlots("library", grid);
    let clash = "";
    for (let i = 0; i < 500 && !clash; i++) {
      const id = `agt_n${i}`;
      const only = assignWorkSlots([{ id, site: "library", since: 0 }], grid).get(id)!;
      if (only.x === first.x && only.y === first.y) clash = id;
    }
    expect(clash).not.toBe("");
    const both = assignWorkSlots(
      [
        { id: "agt_first", site: "library", since: 1 },
        { id: clash, site: "library", since: 2 },
      ],
      grid,
    );
    expect(both.get("agt_first")).toEqual(first);
    expect(both.get(clash)).not.toEqual(first);
    expect(slots.length).toBeGreaterThan(1);
  });

  it("spills a full apron outward instead of stacking bodies", () => {
    const n = workSlots("board", grid).length + 5;
    const reqs = Array.from({ length: n }, (_, i) => ({ id: `agt_${i}`, site: "board" as const, since: i }));
    const out = assignWorkSlots(reqs, grid);
    const keys = new Set([...out.values()].map((t) => `${t.x},${t.y}`));
    expect(keys.size).toBe(n);
    for (const t of out.values()) expect(grid.blocked(t.x, t.y)).toBe(false);
  });

  it("approaches the neighbour of a target nearest the approacher, never its tile", () => {
    const t = approachTile({ x: 0, y: 11 }, { x: 4, y: 11 }, grid);
    expect(t).toEqual({ x: 3, y: 11 });
  });

  it("meets two mutual addressees side by side in the middle", () => {
    const [a, b] = meetingTiles({ x: 1, y: 11 }, { x: 21, y: 11 }, grid);
    expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);
    expect(a.x).toBeLessThan(b.x);
    expect(grid.blocked(a.x, a.y) || grid.blocked(b.x, b.y)).toBe(false);
  });
});

describe("pathing", () => {
  it("walks around a building rather than through it", () => {
    // Plaza building occupies x 10..13, y 7..10. Straight across it would cross.
    const route = findPath({ x: 9, y: 8 }, { x: 14, y: 8 }, grid);
    expect(route[0]).toEqual({ x: 9, y: 8 });
    expect(route[route.length - 1]).toEqual({ x: 14, y: 8 });
    for (const t of route) expect(grid.blocked(t.x, t.y)).toBe(false);
    for (let i = 1; i < route.length; i++) {
      expect(Math.abs(route[i]!.x - route[i - 1]!.x) + Math.abs(route[i]!.y - route[i - 1]!.y)).toBe(1);
    }
  });

  it("prefers the avenues when they are not much longer", () => {
    const route = findPath({ x: 9, y: 2 }, { x: 9, y: 16 }, grid);
    expect(route.every((t) => t.x === 9)).toBe(true);
  });

  it("reaches every work site from the plaza home without touching a footprint", () => {
    const home = { x: 11, y: 11 };
    for (const region of Object.keys(REGION_RECTS) as SiteRegion[]) {
      const to = workSlots(region, grid)[0]!;
      const route = findPath(home, to, grid);
      expect(route.length).toBeGreaterThan(0);
      expect(route[route.length - 1]).toEqual(to);
      for (const t of route) expect(grid.blocked(t.x, t.y)).toBe(false);
    }
  });

  it("walks outside the core too (claimed plots are open ground)", () => {
    const route = findPath({ x: -5, y: -3 }, { x: -1, y: 2 }, grid);
    expect(route[route.length - 1]).toEqual({ x: -1, y: 2 });
    expect(routeLength(route)).toBe(9);
  });

  it("simplifies straight runs to corners and interpolates by distance", () => {
    const route = simplifyRoute([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]);
    expect(route).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ]);
    expect(pointAlong(route, 0.5)).toEqual({ x: 2, y: 0 });
    expect(pointAlong(route, 0.75)).toEqual({ x: 2, y: 1 });
  });

  it("clamps trip time so long walks still arrive promptly", () => {
    expect(tripMs([{ x: 0, y: 0 }])).toBe(0);
    expect(tripMs([{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(MOTION_TIMING.minTripMs);
    expect(tripMs([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toBe(MOTION_TIMING.maxTripMs);
  });
});

describe("the controller", () => {
  const HOME = { x: 11, y: 11 };
  const WORKSHOP = doorTile("workshop");
  const BOARD = doorTile("board");

  function ctx(now: number, extra: Partial<MotionContext> = {}): MotionContext {
    return {
      now,
      home: HOME,
      destinationFor: (e: Errand) =>
        e.kind === "work" ? doorTile(e.site) : e.kind === "blocked" ? BOARD : HOME,
      path: (a, b) => findPath(a, b, grid),
      ...extra,
    };
  }

  const WORK: Errand = { kind: "work", site: "workshop" };
  const REST: Errand = { kind: "rest" };

  function run(m: BodyMotion, errand: Errand, from: number, to: number, stepMs = 100, extra = {}): BodyMotion {
    let cur = m;
    for (let t = from; t <= to; t += stepMs) cur = stepMotion(cur, errand, ctx(t, extra));
    return cur;
  }

  it("does not move for work that is over before it commits", () => {
    let m = restingAt(HOME, 0);
    m = run(m, WORK, 0, 600);
    m = run(m, REST, 700, 10_000);
    expect(m.state).toBe("resting");
    expect(positionOf(m, 10_000)).toEqual(HOME);
  });

  it("dispatches, arrives and works once the errand has held", () => {
    let m = restingAt(HOME, 0);
    m = run(m, WORK, 0, MOTION_TIMING.commitMs + 100);
    expect(m.state).toBe("dispatched");
    m = run(m, WORK, MOTION_TIMING.commitMs + 200, 8000);
    expect(m.state).toBe("working");
    expect(positionOf(m, 8000)).toEqual(WORKSHOP);
  });

  it("commits at once when the server says the work started long ago", () => {
    let m = restingAt(HOME, 10_000);
    m = stepMotion(m, WORK, ctx(10_000, { errandSince: 2_000 }));
    expect(m.state).toBe("dispatched");
  });

  it("never passes through a building on the way", () => {
    let m = restingAt({ x: 9, y: 8 }, 0);
    m = stepMotion(m, WORK, ctx(0, { errandSince: -5000 }));
    for (let t = 0; t <= m.routeMs; t += 50) {
      const p = positionOf(m, t);
      expect(grid.blocked(Math.round(p.x), Math.round(p.y)), `at ${p.x},${p.y}`).toBe(false);
    }
  });

  it("coalesces tool→think→tool bursts into one visit", () => {
    let m = restingAt(HOME, 0);
    m = run(m, WORK, 0, 8000);
    expect(m.state).toBe("working");
    // A two-second think between tool calls: the body lingers, it does not leave.
    m = run(m, REST, 8100, 10_000);
    expect(m.state).toBe("working");
    m = run(m, WORK, 10_100, 12_000);
    expect(m.state).toBe("working");
    expect(positionOf(m, 12_000)).toEqual(WORKSHOP);
  });

  it("returns home after the linger once the work is really over", () => {
    let m = restingAt(HOME, 0);
    m = run(m, WORK, 0, 8000);
    m = run(m, REST, 8100, 8100 + MOTION_TIMING.lingerMs + MOTION_TIMING.commitMs + 200);
    expect(m.state).toBe("returning");
    m = run(m, REST, 12_000, 20_000);
    expect(m.state).toBe("resting");
    expect(positionOf(m, 20_000)).toEqual(HOME);
  });

  it("holds a minimum dwell even when the work was brief", () => {
    let m = restingAt(WORKSHOP, 0);
    m = { ...m, state: "working", errand: WORK };
    m = run(m, REST, 100, MOTION_TIMING.minDwellMs - 200);
    expect(m.state).toBe("working");
  });

  it("freezes a stalled body exactly where it was, mid-walk included", () => {
    let m = restingAt(HOME, 0);
    m = stepMotion(m, WORK, ctx(0, { errandSince: -5000 }));
    const mid = m.routeMs / 2;
    const where = positionOf(m, mid);
    m = stepMotion(m, { kind: "stall" }, ctx(mid));
    expect(m.state).toBe("stalled");
    expect(positionOf(m, mid + 60_000)).toEqual(where);
  });

  it("walks a blocked body to the Board without waiting for commit or dwell", () => {
    let m = restingAt(HOME, 0);
    m = run(m, WORK, 0, 8000);
    m = stepMotion(m, { kind: "blocked" }, ctx(8100));
    expect(m.state).toBe("blocked");
    expect(m.route[m.route.length - 1]).toEqual(BOARD);
  });

  it("retargets mid-walk from where the body is, without a jump", () => {
    let m = restingAt(HOME, 0);
    m = stepMotion(m, WORK, ctx(0, { errandSince: -5000 }));
    const t = Math.floor(m.routeMs / 3);
    const before = positionOf(m, t);
    const read: Errand = { kind: "work", site: "library" };
    m = stepMotion(m, read, ctx(t, { errandSince: t - 5000 }));
    expect(positionOf(m, t)).toEqual(before);
    expect(m.route[m.route.length - 1]).toEqual(doorTile("library"));
  });

  it("teleports under reduced motion, but keeps the same decisions", () => {
    let m = restingAt(HOME, 0);
    m = stepMotion(m, WORK, ctx(0, { errandSince: -5000, reducedMotion: true }));
    expect(m.routeMs).toBe(0);
    expect(m.state).toBe("working");
    expect(positionOf(m, 0)).toEqual(WORKSHOP);
  });
});
