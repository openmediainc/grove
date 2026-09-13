import { describe, expect, it } from "vitest";
import type { ToolCallView } from "@grove/protocol";
import {
  TV_COOLDOWN_MS,
  TV_MAX_HOLD_MS,
  TV_MIN_HOLD_MS,
  TvDirector,
  type TvActor,
  type TvStage,
} from "../lib/tv/director";

const words = { regionTitle: (r: string) => r[0]!.toUpperCase() + r.slice(1) };
const T0 = Date.parse("2026-09-13T12:00:00Z");

function body(id: string, over: Partial<TvActor> = {}): TvActor {
  return { id, name: id, kind: "agent", region: "plaza", verb: "idle", hazard: null, ...over };
}

function span(callId: string, startedAt: number, open = true): ToolCallView {
  return {
    callId,
    name: "Bash",
    args: "pnpm test",
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(startedAt).toISOString(),
    finishedAt: open ? null : new Date(startedAt + 500).toISOString(),
    outcome: open ? null : "ok",
    progress: null,
    progressDone: null,
    progressTotal: null,
    result: null,
    durationMs: open ? null : 500,
    stalled: false,
  };
}

function run(d: TvDirector, actors: TvActor[], now: number, stage: TvStage | null = null) {
  d.observe(actors, now);
  return d.step({ now, actors, stage, words });
}

describe("Grove TV director", () => {
  it("pulls wide on an empty world and says so", () => {
    const shot = run(new TvDirector(), [], T0);
    expect(shot.kind).toBe("wide");
    expect(shot.caption).toMatch(/nobody is here/);
  });

  it("goes to a hazard first, with the fault in the caption", () => {
    const d = new TvDirector();
    const shot = run(d, [body("ivy", { verb: "tool" }), body("lantern", { verb: "error", hazard: "fault", errorText: "ENOENT: no such file" })], T0);
    expect(shot).toMatchObject({ kind: "hazard", actorId: "lantern" });
    expect(shot.caption).toBe("lantern hit a fault: ENOENT: no such file");
  });

  it("lets a hazard cut in before the minimum hold, but nothing else", () => {
    const d = new TvDirector();
    const calm = [body("ivy", { verb: "read", region: "library" })];
    expect(run(d, calm, T0).actorId).toBe("ivy");
    // A new arrival two seconds later does not cut in.
    const arrived = [...calm, body("spark", { region: "garden" })];
    expect(run(d, arrived, T0 + 2_000).actorId).toBe("ivy");
    // A stall does.
    const stalled = [...arrived, body("moss", { verb: "tool", hazard: "stall" })];
    const shot = run(d, stalled, T0 + 3_000);
    expect(shot).toMatchObject({ kind: "hazard", actorId: "moss" });
    expect(shot.caption).toMatch(/gone quiet/);
  });

  it("counts a burst of tool calls across polls and captions the latest", () => {
    const d = new TvDirector();
    const a = (calls: ToolCallView[]) => [body("ivy", { verb: "tool", toolCalls: calls }), body("fern")];
    run(d, a([span("c1", T0 - 20_000, false)]), T0);
    run(d, a([span("c2", T0 - 5_000, false)]), T0 + 1_000);
    const shot = run(d, a([span("c3", T0 + 1_500)]), T0 + TV_MIN_HOLD_MS + 2_000);
    expect(shot).toMatchObject({ kind: "burst", actorId: "ivy" });
    expect(shot.caption).toBe("ivy is on a run of 3 tool calls: Bash · pnpm test · running");
  });

  it("announces a body that was not in the last poll, but not the ones there at switch-on", () => {
    const d = new TvDirector();
    expect(run(d, [body("fern", { kind: "human" })], T0).kind).not.toBe("arrival");
    const shot = run(d, [body("fern", { kind: "human" }), body("spark", { kind: "human", region: "garden" })], T0 + TV_MIN_HOLD_MS);
    expect(shot).toMatchObject({ kind: "arrival", actorId: "spark" });
    expect(shot.caption).toBe("spark (a person) just arrived in Garden");
  });

  it("frames a conversation when two voices speak in one room", () => {
    const d = new TvDirector();
    const actors = [body("ivy"), body("fern", { kind: "human" })];
    run(d, actors, T0);
    d.heard("ivy", "shall we ship it?", T0 + 1_000);
    d.heard("fern", "after the tests pass", T0 + 4_000);
    const shot = run(d, actors, T0 + TV_MIN_HOLD_MS + 5_000);
    expect(shot).toMatchObject({ kind: "conversation", actorId: "fern", region: "plaza" });
    expect(shot.caption).toBe("ivy and fern are talking in Plaza: fern: “after the tests pass”");
  });

  it("puts a Stage event that just started on air", () => {
    const d = new TvDirector();
    const stage = { title: "Demo hour", startsAt: new Date(T0 - 30_000).toISOString(), region: "stage" };
    const shot = run(d, [body("ivy")], T0, stage);
    expect(shot).toMatchObject({ kind: "stage", actorId: null, region: "stage" });
    expect(shot.caption).toBe("Starting now in Stage: Demo hour");
  });

  it("holds a shot, then rests its subject so one body cannot own the channel", () => {
    const d = new TvDirector();
    const actors = [body("ivy", { verb: "tool", detail: "migrating" }), body("fern", { verb: "read", detail: "docs" })];
    const first = run(d, actors, T0);
    // Same scores: the tie breaks by key, so fern's shot comes first. Nothing better turns up.
    expect(run(d, actors, T0 + TV_MIN_HOLD_MS + 1).key).toBe(first.key);
    const second = run(d, actors, T0 + TV_MAX_HOLD_MS);
    expect(second.key).not.toBe(first.key);
    // After the second shot's own max hold, the first is still resting: the wide shot fills in.
    const third = run(d, actors, T0 + 2 * TV_MAX_HOLD_MS);
    expect(third.kind).toBe("wide");
    // Once rested, it comes back.
    const later = run(d, actors, T0 + TV_MAX_HOLD_MS + TV_COOLDOWN_MS + TV_MAX_HOLD_MS);
    expect(later.kind).not.toBe("wide");
  });

  it("cuts away at once when the followed body leaves the map", () => {
    const d = new TvDirector();
    expect(run(d, [body("ivy", { verb: "tool" })], T0).actorId).toBe("ivy");
    expect(run(d, [], T0 + 1_000).kind).toBe("wide");
  });

  it("keeps the caption honest while holding", () => {
    const d = new TvDirector();
    const open = [body("ivy", { toolCalls: [span("c1", T0 - 1_000)] })];
    expect(run(d, open, T0).caption).toBe("ivy is running Bash · pnpm test · running");
    const done = [body("ivy", { verb: "read", detail: "README.md" })];
    expect(run(d, done, T0 + 2_000).caption).toBe("ivy is reading in Plaza · README.md");
  });
});
