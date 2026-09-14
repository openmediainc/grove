import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEECH_METRICS,
  byRelevance,
  fitLines,
  layoutSpeech,
  speechTier,
  type Rect,
  type Speaker,
} from "../src/speech-layout";

/** 6px a character: a monospace stand-in for canvas measureText. */
const measure = (t: string) => t.length * 6;
const VIEW = { w: 1200, h: 800 };

function speaker(id: string, ax: number, ay: number, at: number, text = `line from ${id}`): Speaker {
  return { id, ax, ay, at, text };
}

function overlap(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

describe("speechTier", () => {
  it("maps zoom to far / mid / near", () => {
    expect(speechTier(0.4)).toBe("far");
    expect(speechTier(0.7)).toBe("mid");
    expect(speechTier(1)).toBe("mid");
    expect(speechTier(1.25)).toBe("near");
    expect(speechTier(2.5)).toBe("near");
  });

  it("does not strobe across a threshold", () => {
    expect(speechTier(0.69, "mid")).toBe("mid");
    expect(speechTier(0.72, "far")).toBe("far");
    expect(speechTier(0.75, "far")).toBe("mid");
    expect(speechTier(1.23, "near")).toBe("near");
    expect(speechTier(1.27, "mid")).toBe("mid");
    expect(speechTier(1.3, "mid")).toBe("near");
    expect(speechTier(0.5, "near")).toBe("far");
  });
});

describe("fitLines", () => {
  it("leaves a short line alone", () => {
    expect(fitLines("hello there", 150, 1, measure)).toEqual(["hello there"]);
  });

  it("ellipsises a one-liner that does not fit", () => {
    const [line, ...rest] = fitLines("the quick brown fox jumps over the lazy dog again and again", 120, 1, measure);
    expect(rest).toEqual([]);
    expect(line!.endsWith("…")).toBe(true);
    expect(measure(line!)).toBeLessThanOrEqual(120);
  });

  it("wraps up to maxLines and ellipsises the last", () => {
    const lines = fitLines("one two three four five six seven eight nine ten eleven twelve", 60, 3, measure);
    expect(lines).toHaveLength(3);
    expect(lines[2]!.endsWith("…")).toBe(true);
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(60);
  });

  it("cuts a word longer than the line", () => {
    const lines = fitLines("supercalifragilisticexpialidocious", 60, 2, measure);
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(60);
    expect(lines.length).toBe(2);
  });

  it("collapses newlines so a line cannot grow the bubble", () => {
    expect(fitLines("a\n\n\nb", 150, 1, measure)).toEqual(["a b"]);
  });
});

describe("byRelevance", () => {
  it("puts expanded first, then newest, then id", () => {
    const list = [speaker("b", 0, 0, 5), speaker("a", 0, 0, 5), speaker("c", 0, 0, 9), { ...speaker("z", 0, 0, 1), expanded: true }];
    expect(list.sort(byRelevance).map((s) => s.id)).toEqual(["z", "c", "a", "b"]);
  });
});

describe("layoutSpeech", () => {
  it("puts a lone bubble directly over the head with a tail", () => {
    const out = layoutSpeech({ tier: "mid", speakers: [speaker("a", 600, 400, 1)], viewport: VIEW, measure });
    expect(out.bubbles).toHaveLength(1);
    const b = out.bubbles[0]!;
    expect(b.slot).toBe(0);
    expect(b.leader).toBe(false);
    expect(b.y1).toBeLessThanOrEqual(400);
    expect((b.x0 + b.x1) / 2).toBeCloseTo(600, 0);
    expect(out.pips).toEqual([]);
  });

  it("never overlaps two bubbles in a crowd", () => {
    const crowd: Speaker[] = [];
    for (let i = 0; i < 9; i++) crowd.push(speaker(`s${i}`, 560 + (i % 3) * 30, 400 + Math.floor(i / 3) * 16, i));
    const out = layoutSpeech({ tier: "mid", speakers: crowd, viewport: VIEW, measure });
    for (let i = 0; i < out.bubbles.length; i++)
      for (let j = i + 1; j < out.bubbles.length; j++) expect(overlap(out.bubbles[i]!, out.bubbles[j]!)).toBe(false);
    // Every speaker is accounted for: a bubble of its own or a pip, never neither.
    expect(out.bubbles.filter((b) => !b.cluster).length + out.pips.length).toBe(crowd.length);
  });

  it("never covers an obstacle (a hazard outranks speech)", () => {
    const hazard: Rect = { x0: 590, y0: 360, x1: 610, y1: 395 };
    const out = layoutSpeech({
      tier: "near",
      speakers: [speaker("a", 600, 400, 1)],
      viewport: VIEW,
      obstacles: [hazard],
      measure,
    });
    expect(out.bubbles).toHaveLength(1);
    expect(overlap(out.bubbles[0]!, hazard)).toBe(false);
  });

  it("gives the newest line the home slot when two speakers share a spot", () => {
    const out = layoutSpeech({
      tier: "mid",
      speakers: [speaker("old", 600, 400, 1), speaker("new", 600, 400, 2)],
      viewport: VIEW,
      measure,
    });
    const home = out.bubbles.find((b) => b.slot === 0);
    expect(home?.id).toBe("new");
    expect(out.bubbles.find((b) => b.id === "old")?.leader).toBe(true);
  });

  it("keeps the newest when the budget runs out, and folds the rest into the crowd's cluster", () => {
    const metrics = { ...DEFAULT_SPEECH_METRICS, budget: { mid: 2, near: 2 } };
    const crowd = [speaker("a", 600, 400, 1), speaker("b", 610, 402, 2), speaker("c", 620, 404, 3), speaker("d", 630, 406, 4)];
    const out = layoutSpeech({ tier: "near", speakers: crowd, viewport: VIEW, measure, metrics });
    expect(out.bubbles.filter((b) => !b.cluster).map((b) => b.id).sort()).toEqual(["c", "d"]);
    const cluster = out.bubbles.find((b) => b.cluster);
    expect(cluster?.cluster?.members).toEqual(["b", "a"]);
    expect(cluster?.lines.at(-1)).toBe("+1 more");
    expect(out.pips.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("counts a lone squeezed-out line as +N on the nearest bubble", () => {
    const metrics = { ...DEFAULT_SPEECH_METRICS, budget: { mid: 2, near: 2 } };
    const crowd = [speaker("a", 600, 400, 1), speaker("b", 610, 402, 2), speaker("c", 620, 404, 3)];
    const out = layoutSpeech({ tier: "near", speakers: crowd, viewport: VIEW, measure, metrics });
    expect(out.bubbles.map((b) => b.id).sort()).toEqual(["b", "c"]);
    expect(out.pips.map((p) => p.id)).toEqual(["a"]);
    expect(out.bubbles.reduce((n, b) => n + b.overflow, 0)).toBe(1);
  });

  it("does not count a far-away squeeze into an unrelated bubble", () => {
    const metrics = { ...DEFAULT_SPEECH_METRICS, budget: { mid: 1, near: 1 } };
    const out = layoutSpeech({
      tier: "mid",
      speakers: [speaker("here", 100, 400, 2), speaker("there", 1000, 400, 1)],
      viewport: VIEW,
      measure,
      metrics,
    });
    expect(out.bubbles[0]!.overflow).toBe(0);
    expect(out.pips.map((p) => p.id)).toEqual(["there"]);
  });

  it("draws only pips at far zoom, but expands the one being hovered", () => {
    const out = layoutSpeech({
      tier: "far",
      speakers: [speaker("a", 300, 400, 1), { ...speaker("b", 700, 400, 2), expanded: true }],
      viewport: VIEW,
      measure,
    });
    expect(out.bubbles.map((b) => b.id)).toEqual(["b"]);
    expect(out.bubbles[0]!.font).toBe("near");
    expect(out.pips.map((p) => p.id)).toEqual(["a"]);
  });

  it("truncates to one line at mid and wraps at near", () => {
    const long = "this is a fairly long thing to have said out loud in a crowded plaza, honestly";
    const mid = layoutSpeech({ tier: "mid", speakers: [speaker("a", 600, 400, 1, long)], viewport: VIEW, measure });
    const near = layoutSpeech({ tier: "near", speakers: [speaker("a", 600, 400, 1, long)], viewport: VIEW, measure });
    expect(mid.bubbles[0]!.lines).toHaveLength(1);
    expect(mid.bubbles[0]!.lines[0]!.endsWith("…")).toBe(true);
    expect(near.bubbles[0]!.lines.length).toBeGreaterThan(1);
  });

  it("slides a bubble inside the viewport instead of losing it off the top", () => {
    const out = layoutSpeech({ tier: "mid", speakers: [speaker("a", 5, 10, 1)], viewport: VIEW, measure });
    const b = out.bubbles[0]!;
    expect(b.x0).toBeGreaterThanOrEqual(0);
    expect(b.y0).toBeGreaterThanOrEqual(0);
  });

  it("is stable frame to frame while bodies bob", () => {
    const frame = (bob: number, previous?: Map<string, number>) =>
      layoutSpeech({
        tier: "mid",
        speakers: [speaker("a", 600, 400 + bob, 3), speaker("b", 615, 404 - bob, 2), speaker("c", 590, 396 + bob, 1)],
        viewport: VIEW,
        measure,
        previous,
      });
    let prev = frame(0);
    const first = new Map(prev.slots);
    for (let t = 0; t < 60; t++) {
      prev = frame(Math.sin(t / 3) * 2.5, prev.slots);
      expect(prev.slots).toEqual(first);
    }
  });

  it("keeps an existing bubble's slot when a newer line arrives elsewhere", () => {
    const one = layoutSpeech({
      tier: "mid",
      speakers: [speaker("a", 600, 400, 1), speaker("b", 605, 400, 2)],
      viewport: VIEW,
      measure,
    });
    const two = layoutSpeech({
      tier: "mid",
      speakers: [speaker("a", 600, 400, 1), speaker("b", 605, 400, 2), speaker("far", 100, 700, 3)],
      viewport: VIEW,
      measure,
      previous: one.slots,
    });
    expect(two.slots.get("a")).toBe(one.slots.get("a"));
    expect(two.slots.get("b")).toBe(one.slots.get("b"));
  });

  it("returns home once home is clearly free", () => {
    const blocker: Rect = { x0: 560, y0: 370, x1: 640, y1: 392 };
    const blocked = layoutSpeech({ tier: "mid", speakers: [speaker("a", 600, 400, 1)], viewport: VIEW, measure, obstacles: [blocker] });
    expect(blocked.slots.get("a")).not.toBe(0);
    const clear = layoutSpeech({ tier: "mid", speakers: [speaker("a", 600, 400, 1)], viewport: VIEW, measure, previous: blocked.slots });
    expect(clear.slots.get("a")).toBe(0);
  });

  it("skips empty lines entirely", () => {
    const out = layoutSpeech({ tier: "near", speakers: [speaker("a", 600, 400, 1, "   ")], viewport: VIEW, measure });
    expect(out.bubbles).toEqual([]);
    expect(out.pips).toEqual([]);
  });
});
