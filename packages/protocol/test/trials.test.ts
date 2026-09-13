import { describe, expect, it } from "vitest";
import { finishOrder, isTrialKind, normaliseTrialAnswer, trialStatusAt } from "../src/trials.js";

describe("trials", () => {
  it("normalises an answer to one spelling", () => {
    expect(normaliseTrialAnswer("  Forty Two ")).toBe("forty two");
    expect(normaliseTrialAnswer("FORTY\t\ntwo")).toBe("forty two");
    expect(normaliseTrialAnswer("ﬁsh")).toBe("fish");
    expect(normaliseTrialAnswer(42)).toBe("");
    expect(normaliseTrialAnswer("42")).not.toBe(normaliseTrialAnswer("forty two"));
  });

  it("knows the two verification kinds only", () => {
    expect(isTrialKind("answer")).toBe(true);
    expect(isTrialKind("tool_run")).toBe(true);
    expect(isTrialKind("llm_judge")).toBe(false);
  });

  it("reads status off the clock, with closed sticky", () => {
    const o = "2026-09-13T10:00:00Z";
    const c = "2026-09-13T11:00:00Z";
    expect(trialStatusAt(o, c, Date.parse("2026-09-13T09:59:59Z"))).toBe("scheduled");
    expect(trialStatusAt(o, c, Date.parse("2026-09-13T10:00:00Z"))).toBe("open");
    expect(trialStatusAt(o, c, Date.parse("2026-09-13T11:00:00Z"))).toBe("closed");
    expect(trialStatusAt(o, c, Date.parse("2026-09-13T10:30:00Z"), "closed")).toBe("closed");
  });

  it("orders finishers by when they finished and leaves the rest out", () => {
    const e = (agentId: string, finishedAt: string | null) => ({ agentId, finishedAt, finished: finishedAt !== null });
    const order = finishOrder([
      e("agt_c", "2026-09-13T10:05:00Z"),
      e("agt_a", null),
      e("agt_b", "2026-09-13T10:01:00Z"),
      e("agt_a2", "2026-09-13T10:05:00Z"),
    ]);
    expect(order.map((x) => x.agentId)).toEqual(["agt_b", "agt_a2", "agt_c"]);
  });
});
