import { describe, expect, it } from "vitest";
import { FACING_HINT_MS, FACING_STEP_TILES, ReplayTimeline, seatInRegion, type MapRegion, type ReplayEvent, type WorldGrid } from "@grove/protocol";
import { MotionDirector, type MotionActor } from "@/lib/motion/director";
import { ReplayController } from "@/lib/replay/controller";
import { ReplayMotion, REPLAY_TICK_MS } from "@/lib/replay/motion";

/** #60: a speaker steps toward whom it addressed in public, briefly and boundedly. */
const OPEN: WorldGrid = { blocked: () => false, isPath: () => true };
const T = 1_800_000_000_000;

const actor = (id: string, extra: Partial<MotionActor> = {}): MotionActor => ({
  id,
  verb: "say",
  connection: "async",
  source: "grove",
  pulsedAt: new Date(T - 60_000).toISOString(),
  ...extra,
});

function play(director: MotionDirector, homes: Map<string, { x: number; y: number }>, from: number, to: number, reduced = false) {
  const out: Array<{ t: number; x: number; y: number; state: string; face: number }> = [];
  for (let t = from; t <= to; t += 100) {
    for (const id of homes.keys()) {
      const f = director.frame(id, homes.get(id)!, t, reduced);
      if (id === "fern") out.push({ t, x: f.x, y: f.y, state: f.state, face: f.face });
    }
  }
  return out;
}

describe("walk toward the person you're talking to", () => {
  const homes = new Map([
    ["fern", { x: 10, y: 10 }],
    ["moss", { x: 18, y: 10 }],
  ]);

  it("steps at most FACING_STEP_TILES toward the addressee, faces them, then walks home when the hint lapses", () => {
    const d = new MotionDirector(OPEN);
    d.sync([actor("fern"), actor("moss")], homes, T);
    play(d, homes, T, T + 1000);
    const until = T + FACING_HINT_MS;
    d.sync([actor("fern", { addressing: "moss", addressingUntil: until }), actor("moss")], homes, T + 1000);
    const during = play(d, homes, T + 1000, until - 100);
    const far = Math.max(...during.map((f) => Math.max(Math.abs(f.x - 10), Math.abs(f.y - 10))));
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThanOrEqual(FACING_STEP_TILES + 1e-9);
    expect(during.some((f) => f.state === "approaching")).toBe(true);
    expect(during[during.length - 1]!.face).toBe(1); // moss is east (screen-right)
    // No new poll: the hint lapses on its own clock and the body goes home.
    const after = play(d, homes, until, until + 8000);
    const last = after[after.length - 1]!;
    expect([last.x, last.y, last.state, last.face]).toEqual([10, 10, "resting", 0]);
  });

  it("never walks onto a seat someone holds", () => {
    const crowd = new Map([...homes, ["ivy", { x: 12, y: 10 }], ["oak", { x: 11, y: 10 }]]);
    const d = new MotionDirector(OPEN);
    d.sync(
      [actor("fern", { addressing: "moss", addressingUntil: T + FACING_HINT_MS }), actor("moss"), actor("ivy"), actor("oak")],
      crowd,
      T,
    );
    const frames = play(d, crowd, T, T + 8000);
    const end = frames[frames.length - 1]!;
    expect(["11,10", "12,10", "18,10"]).not.toContain(`${end.x},${end.y}`);
  });

  it("reduced motion: turns to face, never walks", () => {
    const d = new MotionDirector(OPEN);
    d.sync([actor("fern", { addressing: "moss", addressingUntil: T + FACING_HINT_MS }), actor("moss")], homes, T);
    const frames = play(d, homes, T, T + 5000, true);
    expect(frames.every((f) => f.x === 10 && f.y === 10)).toBe(true);
    expect(frames[frames.length - 1]!.face).toBe(1);
  });

  it("an expired or self-addressed hint, or an addressee not on the map, does nothing", () => {
    for (const extra of [
      { addressing: "moss", addressingUntil: T - 1 },
      { addressing: "fern", addressingUntil: T + 10_000 },
      { addressing: "ghost", addressingUntil: T + 10_000 },
    ]) {
      const d = new MotionDirector(OPEN);
      d.sync([actor("fern", extra), actor("moss")], homes, T);
      const frames = play(d, homes, T, T + 5000);
      expect(frames.every((f) => f.x === 10 && f.y === 10 && f.face === 0)).toBe(true);
    }
  });
});

describe("replay rebuilds the same facing from public chronicle lines", () => {
  const T0 = Date.parse("2026-09-13T09:00:00.000Z");
  const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
  let n = 9000;
  const speech = (actor: string, s: number, body: string, pub: boolean): ReplayEvent => ({
    id: String(++n),
    type: "speech",
    kind: "speech",
    createdAt: iso(s),
    actor: { id: actor, kind: "agent", displayName: actor, slug: actor },
    roomId: "plaza",
    roomName: "Plaza",
    summary: "spoke",
    body,
    bodyWithheld: false,
    detail: pub ? { channel: "room_say", public: true } : { channel: "room_say" },
  });

  function fixture(pub = true) {
    const entries = [speech("fern", 60, "@moss is it green?", pub), speech("moss", 120, "@fern yes", pub)];
    const timeline = ReplayTimeline.build({
      since: iso(0),
      until: iso(600),
      keyframe: [
        { actorId: "fern", kind: "agent", displayName: "Fern", slug: "fern", roomId: "plaza", roomName: "Plaza", since: iso(-30), eventId: "1" },
        { actorId: "moss", kind: "agent", displayName: "Moss", slug: "moss", roomId: "plaza", roomName: "Plaza", since: iso(-30), eventId: "2" },
      ],
      entries,
    });
    const c = new ReplayController(() => {});
    c.loadWindow({ since: T0, until: T0 + 600_000, timeline, entries });
    return c;
  }
  const homesFor = (bodies: Array<{ id: string; room_slug: string }>) =>
    new Map(bodies.map((b) => [b.id, seatInRegion(b.id, b.room_slug as Exclude<MapRegion, "wild">)]));

  function run(c: ReplayController, stepMs: number, samples: number[]) {
    const motion = new ReplayMotion(c, homesFor);
    let t = T0;
    return samples.map((s) => {
      while (t < T0 + s * 1000) {
        t = Math.min(T0 + s * 1000, t + stepMs);
        motion.advanceTo(t);
      }
      const bodies = c.bodiesAt(t);
      const homes = homesFor(bodies);
      return bodies.map((b) => {
        const f = motion.frame(b.id, homes.get(b.id)!, t);
        return [b.id, b.addressing ?? null, Math.round(f.x * 1000), Math.round(f.y * 1000), f.state, f.face];
      });
    });
  }

  const samples = [30, 61, 63, 66, 74, 76, 90, 121, 125, 140, 300];

  it("hints from public lines only, and expire on the historical clock", () => {
    const c = fixture();
    expect(c.bodiesAt(T0 + 62_000).find((b) => b.id === "fern")!.addressing).toBe("moss");
    expect(c.snapshot(null).facing).toEqual([]); // playhead at window start
    expect(c.bodiesAt(T0 + 60_000 + FACING_HINT_MS).find((b) => b.id === "fern")!.addressing).toBeNull();
    const closed = fixture(false);
    expect(closed.bodiesAt(T0 + 62_000).every((b) => !b.addressing)).toBe(true);
  });

  it("is deterministic: any step size and a seek land on the same frames", () => {
    const a = run(fixture(), 16, samples);
    expect(run(fixture(), 1000, samples)).toEqual(a);
    expect(run(fixture(), REPLAY_TICK_MS, samples)).toEqual(a);
    const seeked = samples.map((s) => run(fixture(), s * 1000, [s])[0]);
    expect(seeked).toEqual(a);
    // Something actually happened: fern turned (and moss did, answering).
    expect(a.flat().some((row) => row[5] !== 0)).toBe(true);
  });
});
