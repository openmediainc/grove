import { describe, expect, it } from "vitest";
import { ReplayTimeline, seatInRegion, type MapRegion, type ReplayEvent } from "@grove/protocol";
import { ReplayController, toolCallsAt } from "@/lib/replay/controller";
import { ReplayMotion, REPLAY_TICK_MS } from "@/lib/replay/motion";

/**
 * Replay moves bodies through the live MotionDirector on an injected,
 * fixed-tick clock. The property that matters: the same window renders the
 * same frames however the playhead got there — any frame rate, any speed.
 */
const T0 = Date.parse("2026-09-13T09:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
let n = 5000;
const ev = (type: string, actor: string, s: number, extra: Partial<ReplayEvent> = {}): ReplayEvent => ({
  id: String(++n),
  type,
  kind: "movement",
  createdAt: iso(s),
  actor: { id: actor, kind: "agent", displayName: actor, slug: actor },
  roomId: null,
  roomName: null,
  summary: type,
  body: null,
  bodyWithheld: false,
  detail: {},
  ...extra,
});

function windowFixture() {
  const timeline = ReplayTimeline.build({
    since: iso(0),
    until: iso(900),
    keyframe: [
      { actorId: "smith", kind: "agent", displayName: "Smith", slug: "smith", roomId: "plaza", roomName: "Plaza", since: iso(-30), eventId: "1" },
      { actorId: "ivy", kind: "agent", displayName: "Ivy", slug: "ivy", roomId: "garden", roomName: "Garden", since: iso(-30), eventId: "2" },
    ],
    entries: [
      ev("agent_phase", "smith", 400, { detail: { verb: "tool", detail: "pnpm test", started_at: iso(60), ended_at: iso(300), seconds: 240 } }),
      ev("agent_phase", "ivy", 700, { detail: { verb: "read", started_at: iso(420), ended_at: iso(640), seconds: 220 } }),
      ev("actor_joined_room", "smith", 500, { roomId: "library", roomName: "Library" }),
      ev("actor_left_room", "ivy", 800, { roomId: "garden" }),
    ],
  });
  const spans = [
    { actor_id: "smith", call_id: "c1", name: "Bash", args: "pnpm test", started_at: iso(62), updated_at: iso(250), finished_at: iso(250), outcome: "ok", result: "green" },
    { actor_id: "smith", call_id: "c2", name: "Edit", args: null, started_at: iso(255), updated_at: iso(256), finished_at: null, outcome: null },
  ];
  const controller = new ReplayController(() => {});
  controller.loadWindow({ since: T0, until: T0 + 900_000, timeline, spans });
  return controller;
}

const homesFor = (bodies: Array<{ id: string; room_slug: string }>) =>
  new Map(bodies.map((b) => [b.id, seatInRegion(b.id, b.room_slug as Exclude<MapRegion, "wild">)]));

function run(controller: ReplayController, stepsMs: number[], samples: number[]) {
  const motion = new ReplayMotion(controller, homesFor);
  const out: unknown[] = [];
  let t = T0;
  let i = 0;
  for (const sample of samples) {
    while (t < T0 + sample * 1000) {
      t = Math.min(T0 + sample * 1000, t + stepsMs[i++ % stepsMs.length]!);
      motion.advanceTo(t);
    }
    const bodies = controller.bodiesAt(t);
    const homes = homesFor(bodies);
    out.push(
      bodies.map((b) => {
        const f = motion.frame(b.id, homes.get(b.id)!, t);
        return [b.id, Math.round(f.x * 1000), Math.round(f.y * 1000), f.state, f.span?.callId ?? null, f.mark?.outcome ?? null];
      }),
    );
  }
  return out;
}

describe("replay motion", () => {
  const samples = [30, 61, 64, 120, 250.5, 252, 300, 305, 430, 505, 650, 810];

  it("renders the same window identically at any frame rate or playback speed", () => {
    const a = run(windowFixture(), [16, 17, 33], samples); // 1x at ~60fps
    const b = run(windowFixture(), [960, 1010], samples); // 60x
    const c = run(windowFixture(), [REPLAY_TICK_MS], samples);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // ...and replaying it a second time is the same again.
    expect(run(windowFixture(), [16, 17, 33], samples)).toEqual(a);
  });

  it("a seek lands where playing up to it would have", () => {
    const played = run(windowFixture(), [250], samples);
    const seeked = samples.map((s) => run(windowFixture(), [s * 1000], [s])[0]);
    expect(seeked).toEqual(played);
  });

  it("scrubbing back and forth on one map lands on the same frames as playing straight through", () => {
    const controller = windowFixture();
    const played = run(windowFixture(), [100], samples);
    const motion = new ReplayMotion(controller, homesFor);
    motion.advanceTo(T0 + 900_000);
    const order = [11, 0, 7, 3, 9, 1, 5, 10, 2, 8, 4, 6];
    for (const i of order) {
      const t = T0 + samples[i]! * 1000;
      const bodies = controller.bodiesAt(t);
      const homes = homesFor(bodies);
      const got = bodies.map((b) => {
        const f = motion.frame(b.id, homes.get(b.id)!, t);
        return [b.id, Math.round(f.x * 1000), Math.round(f.y * 1000), f.state, f.span?.callId ?? null, f.mark?.outcome ?? null];
      });
      expect(got).toEqual(played[i]);
    }
  });

  it("sends a body to the workshop while a historical tool call is open, and plays its outcome", () => {
    const controller = windowFixture();
    const frames = run(controller, [100], samples) as Array<Array<[string, number, number, string, string | null, string | null]>>;
    const smithAt = (i: number) => frames[i]!.find((f) => f[0] === "smith")!;
    expect(smithAt(0)[3]).toBe("resting"); // 30s: before the span
    expect(["dispatched", "working"]).toContain(smithAt(3)[3]); // 120s: Bash open
    expect(smithAt(3)[4]).toBe("c1");
    expect(smithAt(5)[5]).toBe("ok"); // 252s: finish mark playing
    // The open Edit call has gone quiet past the stall threshold by 440s.
    expect(toolCallsAt([{ ...controller.bodiesAt(T0 + 256_000).find((b) => b.id === "smith")!.tool_calls[0]!, actorId: "smith" }], T0 + 440_000)[0]?.stalled).toBe(true);
    // Ivy left the map at 800s.
    expect(frames[11]!.map((f) => f[0])).toEqual(["smith"]);
  });
});
