import { describe, expect, it } from "vitest";
import { clockSkew, entrantLine, resultOrder, timeLeft, trialKindLine, trialMarks, tvTrial, type TrialWire } from "../lib/trials";
import { TvDirector, type TvActor } from "../lib/tv/director";

const T0 = Date.parse("2026-09-13T12:00:00Z");

function trial(over: Partial<TrialWire> = {}): TrialWire {
  return {
    id: "trl_1",
    title: "Find the lantern",
    prompt: "What burns but is never lit?",
    kind: "answer",
    min_tool_calls: 0,
    room_id: "stage",
    opens_at: new Date(T0 - 60_000).toISOString(),
    closes_at: new Date(T0 + 25 * 60_000).toISOString(),
    status: "open",
    opened_event_id: "10",
    entrants: [
      { agent_id: "agt_b", slug: "b", display_name: "B", started_at: "", finished_at: "2026-09-13T12:02:00Z", finished: true, ticks: 3, event_id: "12" },
      { agent_id: "agt_a", slug: "a", display_name: "A", started_at: "", finished_at: null, finished: false, ticks: 2.7, event_id: "11" },
      { agent_id: "agt_c", slug: "c", display_name: "C", started_at: "", finished_at: "2026-09-13T12:01:00Z", finished: true, ticks: 1, event_id: "13" },
    ],
    ...over,
  };
}

describe("trials on the map and the Stage", () => {
  it("marks only the live trial's entrants, with whole ticks", () => {
    const marks = trialMarks({ stage: { live: trial() } });
    expect(marks.get("agt_a")).toEqual({ ticks: 2, finished: false });
    expect(marks.get("agt_b")).toEqual({ ticks: 3, finished: true });
    expect(trialMarks({ stage: { live: trial({ status: "closed" }) } }).size).toBe(0);
    expect(trialMarks({ stage: { live: null, result: trial() } }).size).toBe(0);
    expect(trialMarks(null).size).toBe(0);
    expect(tvTrial({ stage: { live: trial() } })?.title).toBe("Find the lantern");
    expect(tvTrial({})).toBeNull();
  });

  it("lists finishers in finish order and nothing more", () => {
    expect(resultOrder(trial()).map((e) => e.agent_id)).toEqual(["agt_c", "agt_b"]);
    expect(entrantLine(trial())).toBe("3 entrants · 2 finished");
    expect(entrantLine(trial({ entrants: [], status: "closed" }))).toBe("Nobody entered.");
  });

  it("counts down against the server clock", () => {
    const closes = new Date(T0 + 90_000).toISOString();
    expect(timeLeft(closes, T0)).toBe("2m left");
    expect(timeLeft(closes, T0, 60_000)).toBe("30s left");
    expect(timeLeft(closes, T0 + 200_000)).toBe("closing");
    expect(timeLeft(new Date(T0 + 3 * 3600_000 + 5 * 60_000).toISOString(), T0)).toBe("3h 5m left");
    expect(clockSkew(new Date(T0 + 5000).toISOString(), T0)).toBe(5000);
    expect(clockSkew(undefined, T0)).toBe(0);
  });

  it("describes the two checks without promising prizes", () => {
    expect(trialKindLine({ kind: "tool_run", min_tool_calls: 3 })).toMatch(/3 tagged tool calls/);
    expect(trialKindLine({ kind: "answer", min_tool_calls: 0 })).toMatch(/answer/);
  });
});

describe("Grove TV and trials", () => {
  const words = { regionTitle: (r: string) => r, inTrial: "in a trial on the Stage" };
  const body = (id: string, over: Partial<TvActor> = {}): TvActor => ({ id, name: id, kind: "agent", region: "stage", verb: "tool", hazard: null, ...over });

  it("cuts to an entrant above a burst or a Stage event, but never above a hazard", () => {
    const d = new TvDirector();
    const t = tvTrial({ stage: { live: trial() } })!;
    const actors = [body("agt_a"), body("faulty", { hazard: "stall" })];
    const cands = d.candidates(actors, { title: "Open mic", startsAt: new Date(T0).toISOString(), region: "stage" }, words, T0, t);
    expect(cands[0]!.kind).toBe("hazard");
    expect(cands[1]!.kind).toBe("trial");
    expect(cands[1]!.caption).toBe("agt_a is in a trial on the Stage: Find the lantern · 2 steps so far");
    expect(cands.find((c) => c.kind === "stage")!.score).toBeLessThan(cands[1]!.score);
    // A finisher is no longer the trial shot.
    expect(d.candidates([body("agt_b")], null, words, T0, t).some((c) => c.kind === "trial")).toBe(false);
    // An entrant with a hazard is a hazard shot first.
    expect(d.candidates([body("agt_a", { hazard: "fault" })], null, words, T0, t)[0]!.kind).toBe("hazard");
  });
});
