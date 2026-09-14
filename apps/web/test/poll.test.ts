import { describe, expect, it } from "vitest";
import { jittered, startPoll, type PollEnv } from "../lib/poll";

/** A hand-cranked clock and page. */
function fakeEnv() {
  let now = 0;
  let visible = true;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const subs = new Set<() => void>();
  const env: PollEnv = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
    visible: () => visible,
    onVisibility: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    random: () => 0.5, // no jitter
  };
  return {
    env,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
    setVisible(v: boolean) {
      visible = v;
      subs.forEach((f) => f());
    },
    get pending() {
      return timers.size;
    },
    get listeners() {
      return subs.size;
    },
  };
}

describe("startPoll (#68)", () => {
  it("runs now, then every interval while visible", () => {
    const f = fakeEnv();
    let n = 0;
    startPoll(() => n++, 1000, { env: f.env });
    expect(n).toBe(1);
    f.advance(3000);
    expect(n).toBe(4);
  });

  it("does not poll while hidden, and catches up once on return", () => {
    const f = fakeEnv();
    let n = 0;
    startPoll(() => n++, 1000, { env: f.env });
    f.setVisible(false);
    f.advance(10_000);
    expect(n).toBe(1);
    f.setVisible(true);
    expect(n).toBe(2);
    f.advance(999);
    expect(n).toBe(2);
    f.advance(1);
    expect(n).toBe(3);
  });

  it("a quick hide/show inside one interval does not add a request", () => {
    const f = fakeEnv();
    let n = 0;
    startPoll(() => n++, 8000, { env: f.env });
    f.advance(2000);
    f.setVisible(false);
    f.advance(1000);
    f.setVisible(true);
    expect(n).toBe(1);
  });

  it("runNow: false waits a full interval first", () => {
    const f = fakeEnv();
    let n = 0;
    startPoll(() => n++, 1000, { env: f.env, runNow: false });
    expect(n).toBe(0);
    f.advance(1000);
    expect(n).toBe(1);
  });

  it("stop clears the timer and the listener", () => {
    const f = fakeEnv();
    let n = 0;
    const stop = startPoll(() => n++, 1000, { env: f.env });
    stop();
    f.advance(5000);
    f.setVisible(true);
    expect(n).toBe(1);
    expect(f.pending).toBe(0);
    expect(f.listeners).toBe(0);
  });

  it("jitter stays within the band", () => {
    expect(jittered(8000, 0.1, () => 0)).toBe(7200);
    expect(jittered(8000, 0.1, () => 1)).toBe(8800);
    expect(jittered(8000, 0.1, () => 0.5)).toBe(8000);
    expect(jittered(1, 0.9, () => 0)).toBe(1);
  });
});
