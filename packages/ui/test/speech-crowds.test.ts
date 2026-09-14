import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEECH_METRICS,
  FOLDED,
  clusterUnder,
  connectorOf,
  layoutSpeech,
  segmentLength,
  segmentsCross,
  type LayoutInput,
  type Rect,
  type Speaker,
  type SpeechLayout,
  type SpeechTier,
} from "../src/speech-layout";

/**
 * Speech in dense crowds (#64): synthetic Plaza crowds of 10, 30 and 60
 * speakers. Positions come from a seeded generator so every run lays out the
 * same crowd.
 */

const measure = (t: string) => t.length * 6;
const VIEW = { w: 1280, h: 800 };
const TILE = 64;
const MAX_LEADER = DEFAULT_SPEECH_METRICS.maxLeaderTiles * TILE;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PHRASES = ["hello", "shipping the fix now", "who has the plaza key?", "on it", "tests are green", "lunch?", "reading the brief"];

/** A crowd packed round the middle of the screen, the way the Plaza fills up. */
function crowd(n: number, seed = n): Speaker[] {
  const r = rng(seed);
  const radius = 30 + Math.sqrt(n) * 18;
  const out: Speaker[] = [];
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * radius;
    out.push({
      id: `s${String(i).padStart(2, "0")}`,
      ax: VIEW.w / 2 + Math.cos(a) * d * 1.6,
      ay: VIEW.h / 2 + Math.sin(a) * d * 0.8,
      at: 1000 + i * 10,
      text: `${PHRASES[i % PHRASES.length]} ${i}`,
    });
  }
  return out;
}

function frame(tier: SpeechTier, speakers: Speaker[], prev?: SpeechLayout, extra: Partial<LayoutInput> = {}): SpeechLayout {
  return layoutSpeech({
    tier,
    speakers,
    viewport: VIEW,
    measure,
    tilePx: TILE,
    previous: prev?.slots,
    previousCrowds: prev?.crowds,
    ...extra,
  });
}

function overlap(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function assertReadable(out: SpeechLayout, maxLeader = MAX_LEADER) {
  const segs = out.bubbles.map((b) => connectorOf(b, b.ax, b.ay));
  for (const s of segs) expect(segmentLength(s)).toBeLessThanOrEqual(maxLeader + 1e-6);
  for (let i = 0; i < out.bubbles.length; i++) {
    for (let j = i + 1; j < out.bubbles.length; j++) {
      expect(overlap(out.bubbles[i]!, out.bubbles[j]!), `${out.bubbles[i]!.id} over ${out.bubbles[j]!.id}`).toBe(false);
      expect(segmentsCross(segs[i]!, segs[j]!), `${out.bubbles[i]!.id} crosses ${out.bubbles[j]!.id}`).toBe(false);
    }
  }
}

/** Every speaker is exactly one of: its own bubble, a cluster member, or a loose pip. */
function assertAccounted(out: SpeechLayout, speakers: Speaker[]) {
  const own = new Set(out.bubbles.filter((b) => !b.cluster).map((b) => b.id));
  const folded = out.bubbles.flatMap((b) => b.cluster?.members ?? []);
  expect(new Set(folded).size).toBe(folded.length);
  for (const s of speakers) {
    const inCluster = folded.includes(s.id);
    const hasPip = out.pips.some((p) => p.id === s.id);
    expect(own.has(s.id) && inCluster, s.id).toBe(false);
    expect(own.has(s.id) || inCluster || hasPip, s.id).toBe(true);
  }
}

describe("speech in crowds", () => {
  for (const n of [10, 30, 60]) {
    describe(`${n} speakers`, () => {
      const people = crowd(n);

      for (const tier of ["far", "mid", "near"] as const) {
        it(`${tier}: short leaders, no crossings, no overlaps, nobody lost`, () => {
          const out = frame(tier, people);
          assertReadable(out);
          assertAccounted(out, people);
        });
      }

      it("far: the crowd is one count, not a spray of pips", () => {
        const out = frame("far", people);
        const counts = out.bubbles.filter((b) => b.cluster?.count);
        expect(counts.length).toBeGreaterThanOrEqual(1);
        const total = counts.reduce((k, b) => k + Number(b.lines[0]), 0);
        expect(total + out.pips.length).toBe(n);
        expect(out.bubbles.every((b) => b.cluster?.count)).toBe(true);
      });

      it("mid: a crowd collapses into cluster bubbles, newest line first", () => {
        const out = frame("mid", people);
        const clusters = out.bubbles.filter((b) => b.cluster);
        expect(clusters.length).toBeGreaterThanOrEqual(1);
        // Clusters, not individual sentences, over a crowd at mid zoom.
        const lone = out.bubbles.filter((b) => !b.cluster);
        for (const b of lone) {
          const c = out.crowds.get(b.id)!;
          expect([...out.crowds.values()].filter((k) => k === c).length).toBeLessThan(DEFAULT_SPEECH_METRICS.clusterAt);
        }
        const biggest = clusters.reduce((p, q) => (q.cluster!.members.length > p.cluster!.members.length ? q : p));
        const members = biggest.cluster!.members.map((id) => people.find((s) => s.id === id)!);
        const newest = members.reduce((p, q) => (q.at > p.at ? q : p));
        expect(biggest.cluster!.members[0]).toBe(newest.id);
        expect(biggest.lines[0]!.startsWith(newest.text.slice(0, 4))).toBe(true);
        expect(biggest.lines.at(-1)).toBe(`+${members.length - 1} more`);
      });

      it("near: individual bubbles up to the budget, the rest in a cluster", () => {
        const out = frame("near", people);
        const lone = out.bubbles.filter((b) => !b.cluster);
        expect(lone.length).toBeGreaterThan(0);
        expect(lone.length).toBeLessThanOrEqual(DEFAULT_SPEECH_METRICS.budget.near);
        if (n > DEFAULT_SPEECH_METRICS.budget.near) expect(out.bubbles.some((b) => b.cluster && !b.cluster.count)).toBe(true);
      });

      it("holds still frame to frame while the crowd bobs and shuffles a pixel or two", () => {
        for (const tier of ["mid", "near"] as const) {
          let prev = frame(tier, people);
          // Settle: the first frame had no memory.
          prev = frame(tier, people, prev);
          const slots = new Map(prev.slots);
          const ids = prev.bubbles.map((b) => b.id).sort();
          const wobble = rng(7);
          for (let t = 0; t < 40; t++) {
            const moved = people.map((s) => ({ ...s, ax: s.ax + (wobble() - 0.5) * 3, ay: s.ay + Math.sin(t / 3 + s.ax) * 2 }));
            prev = frame(tier, moved, prev);
            assertReadable(prev);
            expect(prev.bubbles.map((b) => b.id).sort()).toEqual(ids);
            expect(prev.slots).toEqual(slots);
          }
        }
      });

      it("is deterministic: the same crowd in any input order lays out the same", () => {
        const shuffled = [...people].reverse();
        for (const tier of ["far", "mid", "near"] as const) {
          const a = frame(tier, people);
          const b = frame(tier, shuffled);
          expect(b.bubbles).toEqual(a.bubbles);
          expect(b.pips.map((p) => p.id).sort()).toEqual(a.pips.map((p) => p.id).sort());
        }
      });
    });
  }

  it("does not flicker: across many crowds, a slot almost never flips and flips straight back", () => {
    let flickers = 0;
    let frames = 0;
    for (const n of [10, 30, 60]) {
      for (let seed = 1; seed <= 8; seed++) {
        for (const tier of ["mid", "near"] as const) {
          const people = crowd(n, seed * 101);
          let prev = frame(tier, people);
          for (let k = 0; k < 5; k++) prev = frame(tier, people, prev);
          const wobble = rng(seed + 99);
          const keys: string[] = [];
          for (let t = 0; t < 40; t++) {
            const moved = people.map((s) => ({ ...s, ax: s.ax + (wobble() - 0.5) * 3, ay: s.ay + Math.sin(t / 3 + s.ax) * 2 }));
            prev = frame(tier, moved, prev);
            assertReadable(prev);
            keys.push(JSON.stringify([...prev.slots].sort()));
            frames++;
          }
          for (let t = 2; t < keys.length; t++) if (keys[t] === keys[t - 2] && keys[t] !== keys[t - 1]) flickers++;
        }
      }
    }
    expect(flickers / frames).toBeLessThan(0.005);
  });

  it("holds a folded line in its cluster, and lets it out once the cluster is gone", () => {
    const people = crowd(30);
    const out = frame("near", people);
    const cluster = out.bubbles.find((b) => b.cluster)!;
    const folded = cluster.cluster!.members.at(-1)!;
    expect(out.slots.get(folded)).toBe(FOLDED);
    // Everyone else went quiet: the cluster has nobody left to hold.
    const alone = people.filter((s) => s.id === folded);
    const next = frame("near", alone, out);
    expect(next.bubbles.map((b) => b.id)).toEqual([folded]);
  });

  it("caps leaders by the zoom: a smaller tile means shorter leaders", () => {
    const people = crowd(30);
    const tile = 40;
    const out = frame("near", people, undefined, { tilePx: tile });
    assertReadable(out, DEFAULT_SPEECH_METRICS.maxLeaderTiles * tile);
  });

  it("paints the newest line last", () => {
    const out = frame("near", crowd(30));
    for (let i = 1; i < out.bubbles.length; i++) expect(out.bubbles[i]!.at).toBeGreaterThanOrEqual(out.bubbles[i - 1]!.at);
  });

  it("finds the cluster under a tap", () => {
    const out = frame("mid", crowd(30));
    const c = out.bubbles.find((b) => b.cluster)!;
    expect(clusterUnder(out, (c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2)?.id).toBe(c.id);
    expect(clusterUnder(out, 2, 2)).toBeNull();
    expect(clusterUnder(null, 0, 0)).toBeNull();
  });

  it("keeps the hovered speaker's own bubble inside a collapsed crowd", () => {
    const people = crowd(30);
    const pick = people[4]!;
    const out = frame("mid", people.map((s) => (s.id === pick.id ? { ...s, expanded: true } : s)));
    expect(out.bubbles.some((b) => b.id === pick.id && !b.cluster)).toBe(true);
    expect(out.bubbles.some((b) => b.cluster?.members.includes(pick.id))).toBe(false);
  });

  it("keeps two separate crowds apart", () => {
    const left = crowd(10, 1).map((s) => ({ ...s, id: `l${s.id}`, ax: s.ax - 400 }));
    const right = crowd(10, 2).map((s) => ({ ...s, id: `r${s.id}`, ax: s.ax + 400 }));
    const out = frame("mid", [...left, ...right]);
    const clusters = out.bubbles.filter((b) => b.cluster);
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    for (const c of clusters) {
      const sides = new Set(c.cluster!.members.map((id) => id[0]));
      expect(sides.size).toBe(1);
    }
  });

  it("stays inside a per-frame budget for a packed Plaza (micro-benchmark)", () => {
    const people = crowd(60);
    let prev: SpeechLayout | undefined;
    for (let i = 0; i < 20; i++) prev = frame("near", people, prev); // warm up
    const frames = 300;
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      const moved = people.map((s) => ({ ...s, ay: s.ay + Math.sin(i / 4 + s.ax) * 2 }));
      prev = frame(i % 2 ? "near" : "mid", moved, prev);
    }
    const per = (performance.now() - t0) / frames;
    // eslint-disable-next-line no-console
    console.log(`speech layout, 60 speakers: ${per.toFixed(3)} ms/frame`);
    // A 60 fps frame is 16.7 ms; speech gets a small slice of it, with CI headroom.
    expect(per).toBeLessThan(4);
  });
});
