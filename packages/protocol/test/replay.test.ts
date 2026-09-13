import { describe, expect, it } from "vitest";
import {
  REPLAY_CHECKPOINT_EVERY,
  ReplayTimeline,
  normaliseKeyframeBody,
  normaliseReplayEvent,
  type ReplayEvent,
  type ReplayState,
} from "../src/replay.js";

const T0 = Date.parse("2026-09-13T09:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

let nextId = 1000;
function ev(type: string, actorId: string, seconds: number, extra: Partial<ReplayEvent> = {}): ReplayEvent {
  nextId += 1;
  return {
    id: String(nextId),
    type,
    kind: "movement",
    createdAt: at(seconds),
    actor: { id: actorId, kind: "agent", displayName: actorId, slug: actorId },
    roomId: null,
    roomName: null,
    summary: `${actorId} ${type}`,
    body: null,
    bodyWithheld: false,
    detail: {},
    ...extra,
  };
}

const flat = (s: ReplayState) => ({
  bodies: [...s.bodies.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  phases: [...s.phases.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
});

describe("replay timeline", () => {
  it("starts from the keyframe, walks bodies between rooms, and takes them off on leave", () => {
    const tl = ReplayTimeline.build({
      since: at(0),
      until: at(3600),
      keyframe: [
        { actorId: "lantern", kind: "agent", displayName: "Lantern", slug: "lantern", roomId: "plaza", roomName: "Plaza", since: at(-60), eventId: "10" },
      ],
      entries: [
        ev("actor_joined_room", "lantern", 100, { roomId: "library", roomName: "Library" }),
        ev("actor_joined_room", "ivy", 200, { roomId: "garden", roomName: "Garden" }),
        ev("actor_left_room", "lantern", 300, { roomId: "library" }),
      ],
    });
    expect(tl.frameAt(T0 + 50_000, { lineMs: 8000 }).map((b) => [b.id, b.roomId])).toEqual([["lantern", "plaza"]]);
    expect(tl.frameAt(T0 + 250_000, { lineMs: 8000 }).map((b) => [b.id, b.roomId])).toEqual([
      ["ivy", "garden"],
      ["lantern", "library"],
    ]);
    expect(tl.frameAt(T0 + 301_000, { lineMs: 8000 }).map((b) => b.id)).toEqual(["ivy"]);
    // ivy arrived on the map; lantern only moved rooms.
    expect(tl.markers.filter((m) => m.kind === "arrival").map((m) => m.actorId)).toEqual(["ivy"]);
  });

  it("shows a line only while it is fresh, and places an unseen speaker in the room it spoke in", () => {
    const tl = ReplayTimeline.build({
      since: at(0),
      until: at(600),
      keyframe: [],
      entries: [
        ev("speech", "spark", 10, { roomId: "workshop", roomName: "Workshop", body: "sparks fly", kind: "speech" }),
        ev("speech", "spark", 40, { roomId: "workshop", roomName: "Workshop", body: null, bodyWithheld: true, kind: "speech" }),
      ],
    });
    const f1 = tl.frameAt(T0 + 12_000, { lineMs: 8000 });
    expect(f1[0]?.roomId).toBe("workshop");
    expect(f1[0]?.line?.body).toBe("sparks fly");
    expect(tl.frameAt(T0 + 30_000, { lineMs: 8000 })[0]?.line).toBeNull();
    // A withheld body stays withheld: the timeline never fills it in.
    const f3 = tl.frameAt(T0 + 41_000, { lineMs: 8000 })[0]!;
    expect(f3.line).toEqual({ at: T0 + 40_000, body: null, withheld: true });
  });

  it("covers an instant with the work span the owner may see, and marks faults", () => {
    const tl = ReplayTimeline.build({
      since: at(0),
      until: at(3600),
      keyframe: [{ actorId: "a1", kind: "agent", displayName: "A1", slug: "a1", roomId: "plaza", roomName: "Plaza", since: at(-5), eventId: "1" }],
      entries: [
        ev("agent_phase", "a1", 900, { kind: "work", detail: { verb: "tool", detail: "npm test", started_at: at(100), ended_at: at(700), seconds: 600 } }),
        ev("agent_phase", "a1", 1000, { kind: "work", detail: { verb: "error", error_text: "boom", started_at: at(700), ended_at: at(760), seconds: 60 } }),
      ],
    });
    expect(tl.frameAt(T0 + 50_000, { lineMs: 0 })[0]!.phase).toBeNull();
    expect(tl.frameAt(T0 + 200_000, { lineMs: 0 })[0]!.phase?.verb).toBe("tool");
    // At the exact boundary the next span has taken over.
    expect(tl.frameAt(T0 + 700_000, { lineMs: 0 })[0]!.phase?.verb).toBe("error");
    expect(tl.frameAt(T0 + 800_000, { lineMs: 0 })[0]!.phase).toBeNull();
    expect(tl.markers.map((m) => m.kind)).toEqual(["span", "fault"]);
    expect(tl.markers[0]!.endAt).toBe(T0 + 700_000);
  });

  it("answers a seek from a checkpoint exactly as a replay from zero would, in any order", () => {
    const rooms = ["plaza", "library", "workshop", "stage", "garden", "board"];
    const entries: ReplayEvent[] = [];
    // Deterministic pseudo-random walk, many checkpoints' worth.
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < REPLAY_CHECKPOINT_EVERY * 9 + 17; i++) {
      const who = `b${Math.floor(rnd() * 40)}`;
      const s = Math.floor(rnd() * 3600);
      const r = rnd();
      if (r < 0.6) entries.push(ev("actor_joined_room", who, s, { roomId: rooms[Math.floor(rnd() * 6)]! }));
      else if (r < 0.75) entries.push(ev("actor_left_room", who, s));
      else entries.push(ev("speech", who, s, { roomId: "plaza", body: `line ${i}` }));
    }
    // Same-second collisions are common above; ordering must still be total.
    const build = (list: ReplayEvent[]) => ReplayTimeline.build({ since: at(0), until: at(3600), keyframe: [], entries: list });
    const tl = build(entries);
    const shuffled = build([...entries].reverse());
    const probes = [3599, 12, 1800, 1801, 0, 2400, 900, 3600, 1799, 60];
    for (const p of probes) {
      const t = T0 + p * 1000;
      expect(flat(tl.stateAt(t))).toEqual(flat(tl.stateFromZero(t)));
      expect(tl.frameAt(t, { lineMs: 8000 })).toEqual(shuffled.frameAt(t, { lineMs: 8000 }));
    }
    // Sequential playback through the incremental cache agrees too.
    for (let s = 0; s <= 3600; s += 7) {
      const t = T0 + s * 1000;
      expect(flat(tl.stateAt(t))).toEqual(flat(tl.stateFromZero(t)));
    }
  });

  it("drops duplicate entries (a trailing span also on a page) and normalises either casing", () => {
    const raw = {
      id: "55",
      type: "actor_joined_room",
      kind: "movement",
      created_at: at(5),
      actor: { id: "hum_x", kind: "human", display_name: "Ex", slug: "ex" },
      room_id: "plaza",
      room_name: "Plaza",
      summary: "@ex walked into Plaza.",
      body: null,
      body_withheld: false,
      detail: { seat: 1 },
    };
    const e = normaliseReplayEvent(raw);
    expect(e).toMatchObject({ id: "55", createdAt: at(5), roomId: "plaza", actor: { displayName: "Ex" } });
    const k = normaliseKeyframeBody({ actor_id: "a", kind: "agent", display_name: "A", slug: null, room_id: "garden", room_name: "Garden", since: at(-1), event_id: "3" });
    expect(k).toMatchObject({ actorId: "a", roomId: "garden", eventId: "3" });
    const tl = ReplayTimeline.build({ since: at(0), until: at(60), keyframe: [], entries: [e, e] });
    expect(tl.stepCount).toBe(1);
    expect(tl.density(6)).toEqual([1, 0, 0, 0, 0, 0]);
  });
});
