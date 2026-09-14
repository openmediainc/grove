import { describe, expect, it } from "vitest";
import {
  FACING_HINT_MS,
  FACING_STEP_TILES,
  deriveFacingHints,
  facingEdges,
  facingFromWire,
  facingScreenDir,
  facingStepTile,
  facingToWire,
  mentionsIn,
  type FacingBody,
  type PublicLine,
} from "../src/facing.js";

const T = 1_800_000_000_000;
const bodies: FacingBody[] = [
  { id: "agt_fern", slug: "fern", roomId: "plaza" },
  { id: "agt_moss", slug: "moss", roomId: "plaza" },
  { id: "hum_ada", slug: "ada", roomId: "plaza" },
  { id: "agt_ivy", slug: "ivy", roomId: "library" },
];
let n = 0;
const line = (senderId: string, body: string, at: number, extra: Partial<PublicLine> = {}): PublicLine => ({
  speechId: `sp_${++n}`,
  senderId,
  roomId: "plaza",
  body,
  at,
  public: true,
  ...extra,
});

describe("facing hints (#60)", () => {
  it("reads @mentions, case-insensitively, without emails", () => {
    expect(mentionsIn("hey @Moss, and @ada! mail me at a@b.com @moss")).toEqual(["moss", "ada"]);
    expect(mentionsIn("@ada_x/fern-2/ ok")).toEqual(["ada_x/fern-2"]);
  });

  it("a public line that mentions a body in the same room makes a hint", () => {
    const hints = deriveFacingHints([line("agt_fern", "@moss did the build pass?", T)], bodies, T + 1000);
    expect(hints).toEqual([{ from: "agt_fern", to: "agt_moss", speechId: expect.any(String), at: T, until: T + FACING_HINT_MS }]);
    expect(FACING_HINT_MS).toBeLessThanOrEqual(20_000);
  });

  it("never from a line the public feed did not carry (a whisper, a filtered line, a withheld body)", () => {
    expect(deriveFacingHints([line("agt_fern", "@moss psst", T, { public: false })], bodies, T + 1)).toEqual([]);
    expect(deriveFacingHints([line("agt_fern", "@moss", T, { body: null })], bodies, T + 1)).toEqual([]);
    expect(deriveFacingHints([line("agt_fern", "@moss", T, { roomId: null })], bodies, T + 1)).toEqual([]);
  });

  it("never across rooms, never at yourself, never at a handle nobody on the map answers to", () => {
    expect(deriveFacingHints([line("agt_fern", "@ivy over there?", T)], bodies, T + 1)).toEqual([]);
    expect(deriveFacingHints([line("agt_fern", "@fern note to self", T)], bodies, T + 1)).toEqual([]);
    expect(deriveFacingHints([line("agt_fern", "@nobody", T)], bodies, T + 1)).toEqual([]);
    // Speaker no longer in the room it spoke in.
    expect(deriveFacingHints([line("agt_ivy", "@moss", T)], bodies, T + 1)).toEqual([]);
  });

  it("expires after FACING_HINT_MS and ignores lines from the future", () => {
    const l = line("agt_fern", "@moss", T);
    expect(deriveFacingHints([l], bodies, T + FACING_HINT_MS - 1)).toHaveLength(1);
    expect(deriveFacingHints([l], bodies, T + FACING_HINT_MS)).toEqual([]);
    expect(deriveFacingHints([l], bodies, T - 1)).toEqual([]);
    expect(facingEdges([l, line("agt_moss", "x", T + 5, { public: false })])).toEqual([T, T + FACING_HINT_MS]);
  });

  it("the newest line wins; one addressing nobody ends the hint; input order does not matter", () => {
    const a = line("agt_fern", "@moss hi", T);
    const b = line("agt_fern", "@ada and you", T + 2000);
    const c = line("agt_fern", "anyway", T + 4000);
    expect(deriveFacingHints([b, a], bodies, T + 3000).map((h) => h.to)).toEqual(["hum_ada"]);
    expect(deriveFacingHints([c, a, b], bodies, T + 5000)).toEqual([]);
    const two = [line("agt_moss", "@fern yes", T + 10), a];
    expect(deriveFacingHints(two, bodies, T + 20)).toEqual(deriveFacingHints([...two].reverse(), bodies, T + 20));
  });

  it("round-trips the wire shape and drops malformed hints", () => {
    const [h] = deriveFacingHints([line("agt_fern", "@moss", T)], bodies, T + 1);
    const wire = facingToWire(h!);
    expect(Object.keys(wire).sort()).toEqual(["from", "to", "until"]);
    expect(facingFromWire(wire)).toEqual({ from: "agt_fern", to: "agt_moss", until: T + FACING_HINT_MS });
    expect(facingFromWire({ from: "a", to: "a", until: wire.until })).toBeNull();
    expect(facingFromWire({ from: "a", to: "b", until: "nope" })).toBeNull();
    expect(facingFromWire(null)).toBeNull();
  });
});

describe("facing step (#60): bounded, and respects what is standing there", () => {
  const open = { blocked: () => false };

  it("steps at most FACING_STEP_TILES, strictly nearer, never onto the addressee", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 10, y: 0 };
    const s = facingStepTile(from, to, open);
    expect(Math.max(Math.abs(s.x), Math.abs(s.y))).toBeLessThanOrEqual(FACING_STEP_TILES);
    expect(s).toEqual({ x: 2, y: 0 });
    // Right beside: nowhere nearer that is not the addressee's own tile → stay.
    expect(facingStepTile({ x: 4, y: 4 }, { x: 5, y: 4 }, open)).toEqual({ x: 4, y: 4 });
    // Two apart: one step, ending beside them.
    expect(facingStepTile({ x: 0, y: 0 }, { x: 2, y: 0 }, open)).toEqual({ x: 1, y: 0 });
  });

  it("avoids occupied seats and blocked tiles, and stays put when boxed in", () => {
    const occupied = new Set(["2,0", "1,0"]);
    const s = facingStepTile({ x: 0, y: 0 }, { x: 10, y: 0 }, open, occupied);
    expect(occupied.has(`${s.x},${s.y}`)).toBe(false);
    expect(s.x).toBeGreaterThan(0);
    const walls = { blocked: (x: number, y: number) => !(x === 0 && y === 0) };
    expect(facingStepTile({ x: 0, y: 0 }, { x: 10, y: 0 }, walls)).toEqual({ x: 0, y: 0 });
  });

  it("turns toward the addressee's side of the screen", () => {
    expect(facingScreenDir({ x: 5, y: 5 }, { x: 8, y: 5 })).toBe(1);
    expect(facingScreenDir({ x: 5, y: 5 }, { x: 5, y: 8 })).toBe(-1);
    expect(facingScreenDir({ x: 5, y: 5 }, { x: 6, y: 6 })).toBe(0);
  });
});
