import { describe, expect, it } from "vitest";
import { SEQUENCE_URL_MAX, parseSequenceRef, validateSequence, type Sequence } from "@grove/protocol";
import { worldBounds } from "@grove/protocol";
import {
  ORBIT_MIN_RADIUS,
  REDUCED_HOLD_SCALE,
  addShot,
  buildTimeline,
  cameraAt,
  canAddShot,
  clampCamera,
  draftSequence,
  easeInOutCubic,
  easeInOutSine,
  emptyDraft,
  formatRunTime,
  inlineSequenceLink,
  lerpZoom,
  removeLastShot,
  shotAt,
  shotFraming,
  storedSequenceLink,
} from "../lib/sequence";

const key = (tx: number, ty: number, zoom = 1) => ({ tx, ty, zoom });

function seq(raw: unknown): Sequence {
  const r = validateSequence(raw);
  if (!r.ok) throw new Error(r.message);
  return r.sequence;
}

const SAMPLE = seq({
  title: "Tour",
  shots: [
    { kind: "push", from: key(0, 0, 0.5), to: key(10, 0, 2), durationMs: 4000 },
    { kind: "orbit", from: key(10, 4, 1), to: key(10, 0, 1), durationMs: 10_000 },
    { kind: "path", from: key(10, 0, 1), to: key(30, 20, 1), durationMs: 6000 },
    { kind: "hold", from: key(30, 20, 1), durationMs: 2000, follow: "lantern" },
  ],
});

const none = () => null;

describe("easing", () => {
  it("starts at 0, ends at 1, is symmetric and clamps", () => {
    for (const f of [easeInOutCubic, easeInOutSine]) {
      expect(f(0)).toBe(0);
      expect(f(1)).toBeCloseTo(1, 10);
      expect(f(0.5)).toBeCloseTo(0.5, 10);
      expect(f(0.25) + f(0.75)).toBeCloseTo(1, 10);
      expect(f(-3)).toBe(0);
      expect(f(9)).toBeCloseTo(1, 10);
    }
  });
  it("moves zoom geometrically", () => {
    expect(lerpZoom(0.5, 2, 0.5)).toBeCloseTo(1, 10);
  });
});

describe("timeline", () => {
  it("lays shots end to end", () => {
    const tl = buildTimeline(SAMPLE, { reduced: false });
    expect(tl.total).toBe(22_000);
    expect(shotAt(tl, 0)).toEqual({ index: 0, p: 0, done: false });
    expect(shotAt(tl, 2000)).toEqual({ index: 0, p: 0.5, done: false });
    expect(shotAt(tl, 4000).index).toBe(1);
    expect(shotAt(tl, 21_999).index).toBe(3);
    expect(shotAt(tl, 22_000)).toEqual({ index: 3, p: 1, done: true });
    expect(shotAt(tl, -50)).toEqual({ index: 0, p: 0, done: false });
  });

  it("holds longer under reduced motion", () => {
    expect(buildTimeline(SAMPLE, { reduced: true }).total).toBe(22_000 * REDUCED_HOLD_SCALE);
  });
});

describe("shot shapes", () => {
  it("push eases from start to end", () => {
    const shot = SAMPLE.shots[0]!;
    expect(shotFraming(shot, 0, false)).toEqual(key(0, 0, 0.5));
    const end = shotFraming(shot, 1, false);
    expect(end.tx).toBeCloseTo(10);
    expect(end.zoom).toBeCloseTo(2);
    const mid = shotFraming(shot, 0.5, false);
    expect(mid.tx).toBeCloseTo(5);
    expect(mid.zoom).toBeCloseTo(1);
  });

  it("orbit starts on its start point and keeps its radius round the centre", () => {
    const shot = SAMPLE.shots[1]!;
    const start = shotFraming(shot, 0, false);
    expect(start.tx).toBeCloseTo(10);
    expect(start.ty).toBeCloseTo(4);
    for (const p of [0.1, 0.33, 0.8, 1]) {
      const f = shotFraming(shot, p, false);
      expect(Math.hypot(f.tx - 10, f.ty - 0)).toBeCloseTo(4, 6);
      // Zoom breathes, gently.
      expect(Math.abs(f.zoom - 1)).toBeLessThanOrEqual(0.051);
    }
    expect(shotFraming(shot, 0.25, false).tx).not.toBeCloseTo(10, 1);
  });

  it("orbit on its own centre circles at the minimum radius", () => {
    const f = shotFraming({ kind: "orbit", from: key(5, 5), to: key(5, 5), follow: null, durationMs: 5000 }, 0.5, false);
    expect(Math.hypot(f.tx - 5, f.ty - 5)).toBeCloseTo(ORBIT_MIN_RADIUS, 6);
  });

  it("path lands on both ends, bows off the straight line and pulls out mid-way", () => {
    const shot = SAMPLE.shots[2]!;
    expect(shotFraming(shot, 0, false)).toEqual(key(10, 0, 1));
    const end = shotFraming(shot, 1, false);
    expect(end.tx).toBeCloseTo(30);
    expect(end.ty).toBeCloseTo(20);
    const mid = shotFraming(shot, 0.5, false);
    // Straight-line midpoint is (20, 10); the bow moves it off that line.
    expect(Math.abs(mid.tx - 20) + Math.abs(mid.ty - 10)).toBeGreaterThan(1);
    expect(mid.zoom).toBeLessThan(1);
  });

  it("reduced motion cuts instead of gliding", () => {
    for (const shot of SAMPLE.shots.slice(0, 3)) {
      expect(shotFraming(shot, 0.2, true)).toEqual(shot.from);
      expect(shotFraming(shot, 0.7, true)).toEqual(shot.to);
    }
    expect(shotFraming(SAMPLE.shots[3]!, 0.7, true)).toEqual(SAMPLE.shots[3]!.from);
  });
});

describe("cameraAt and follow targets", () => {
  const tl = buildTimeline(SAMPLE, { reduced: false });

  it("follows a public body at the shot's zoom", () => {
    const frame = cameraAt(tl, 21_000, (slug) => (slug === "lantern" ? { tx: 31.5, ty: 18 } : null));
    expect(frame.index).toBe(3);
    expect(frame.lostFollow).toBe(false);
    expect(frame.camera).toEqual({ tx: 31.5, ty: 18, zoom: 1 });
  });

  it("holds at the last camera when the target is private or gone", () => {
    const last = key(29, 19, 1.1);
    const frame = cameraAt(tl, 21_000, none, last);
    expect(frame.lostFollow).toBe(true);
    expect(frame.camera).toEqual(last);
    // With no previous frame, where the shot began.
    expect(cameraAt(tl, 21_000, none).camera).toEqual(SAMPLE.shots[3]!.from);
  });

  it("never asks about targets a shot does not name", () => {
    let asked = 0;
    cameraAt(tl, 1000, () => {
      asked++;
      return null;
    });
    expect(asked).toBe(0);
  });
});

describe("clamp integration", () => {
  it("pulls a framing past the world's edge back onto it, zoom into range", () => {
    const bounds = worldBounds(0);
    const wild = seq({ shots: [{ kind: "push", from: key(-4000, -4000, 0.03), to: key(4000, 4000, 3.9), durationMs: 1000 }] });
    const tl = buildTimeline(wild, { reduced: false });
    for (const t of [0, 500, 1000]) {
      const c = clampCamera(cameraAt(tl, t, none).camera, bounds, { min: 0.2, max: 2.5 });
      expect(c.tx).toBeGreaterThanOrEqual(bounds.x0);
      expect(c.tx).toBeLessThanOrEqual(bounds.x1);
      expect(c.ty).toBeGreaterThanOrEqual(bounds.y0);
      expect(c.ty).toBeLessThanOrEqual(bounds.y1);
      expect(c.zoom).toBeGreaterThanOrEqual(0.2);
      expect(c.zoom).toBeLessThanOrEqual(2.5);
    }
  });
});

describe("recording", () => {
  it("chains shots from the viewer's camera moves", () => {
    let d = emptyDraft(key(1, 1, 1));
    d = addShot(d, key(5, 5, 1.5), "push", 3000, null);
    d = addShot(d, key(8, 2, 1.5), "path", 4000, "lantern");
    d = addShot(d, key(8, 2, 1.5), "hold", 2000, null);
    expect(d.shots.map((s) => s.kind)).toEqual(["push", "path", "hold"]);
    expect(d.shots[0]!.from).toEqual(key(1, 1, 1));
    expect(d.shots[1]!.from).toEqual(key(5, 5, 1.5));
    expect(d.shots[1]!.follow).toBe("lantern");
    expect(d.shots[2]!.to).toEqual(d.shots[2]!.from);
    expect(draftSequence({ ...d, title: "Walk" }).ok).toBe(true);
    expect(removeLastShot(d).shots).toHaveLength(2);
  });

  it("refuses a shot past 12 or past 60 s", () => {
    let d = emptyDraft(key(0, 0));
    for (let i = 0; i < 12; i++) d = addShot(d, key(i, 0), "path", 1000, null);
    expect(canAddShot(d, 1000)).toBe(false);
    expect(addShot(d, key(99, 0), "path", 1000, null)).toBe(d);
    let long = emptyDraft(key(0, 0));
    long = addShot(long, key(1, 0), "path", 58_000, null);
    expect(canAddShot(long, 2000)).toBe(true);
    expect(canAddShot(long, 2100)).toBe(false);
  });
});

describe("links", () => {
  it("round-trips a sequence through an inline link, dropping other modes", () => {
    const url = inlineSequenceLink("https://glasshouse.test/?tv=1&follow=x&theme=city#frag", SAMPLE)!;
    const parsed = new URL(url);
    expect(parsed.searchParams.get("tv")).toBeNull();
    expect(parsed.searchParams.get("follow")).toBeNull();
    expect(parsed.searchParams.get("theme")).toBe("city");
    expect(parsed.hash).toBe("");
    expect(parseSequenceRef(parsed.searchParams.get("seq"))).toEqual({ kind: "inline", sequence: SAMPLE });
  });

  it("asks for storage when the encoding is too long for a link", () => {
    const big = seq({
      title: "界".repeat(60),
      shots: Array.from({ length: 12 }, (_, i) => ({
        kind: "path",
        from: key(i + 0.1, -i - 0.1, 1.23),
        to: key(i + 100.1, -i - 100.1, 0.57),
        follow: `a-very-long-public-agent-slug-${i}-${"x".repeat(30)}`,
        durationMs: 4000,
      })),
    });
    expect(inlineSequenceLink("https://glasshouse.test/", big)).toBeNull();
    const stored = storedSequenceLink("https://glasshouse.test/?seq=old", "seq_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3");
    expect(new URL(stored).searchParams.get("seq")).toBe("seq_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3");
    expect(SEQUENCE_URL_MAX).toBeGreaterThan(1000);
  });

  it("formats run time", () => {
    expect(formatRunTime(42_400)).toBe("0:42");
    expect(formatRunTime(60_000)).toBe("1:00");
  });
});
