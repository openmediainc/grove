/**
 * One polling rule for the client (#68, docs/PERFORMANCE.md).
 *
 *  - A hidden tab does not poll. Nobody is looking, and a wall of background
 *    tabs should not cost the server a query each every few seconds.
 *  - Coming back runs the poll at once if a tick was missed, so the view is
 *    never a stale screen for a whole interval.
 *  - Each wait is jittered (±10% by default) so many viewers opened by the
 *    same link do not all land on the same second.
 *
 * The timer and page hooks are injectable so the rule is pinned by
 * test/poll.test.ts without a DOM.
 */

export interface PollEnv {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  visible: () => boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibility: (fn: () => void) => () => void;
  random: () => number;
}

export interface PollOptions {
  /** Run once immediately (default true). */
  runNow?: boolean;
  /** Fraction of the interval to jitter by, either way (default 0.1). */
  jitter?: number;
  env?: PollEnv;
}

function browserEnv(): PollEnv {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    onVisibility: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
    random: Math.random,
  };
}

/** The wait before the next tick: `ms` ± `jitter`, never under 1 ms. */
export function jittered(ms: number, jitter: number, random: () => number): number {
  return Math.max(1, Math.round(ms * (1 + jitter * (random() * 2 - 1))));
}

/** Call `fn` every `ms` while the page is visible. Returns stop. */
export function startPoll(fn: () => void, ms: number, opts: PollOptions = {}): () => void {
  const env = opts.env ?? browserEnv();
  const jitter = opts.jitter ?? 0.1;
  let timer: unknown = null;
  let stopped = false;
  let last = -Infinity;
  /** A tick came due while hidden; run it on return. */
  let owed = false;

  const run = () => {
    last = env.now();
    owed = false;
    fn();
  };
  const schedule = () => {
    if (stopped) return;
    timer = env.setTimeout(tick, jittered(ms, jitter, env.random));
  };
  const tick = () => {
    timer = null;
    if (stopped) return;
    if (env.visible()) run();
    else owed = true;
    schedule();
  };
  const unsubscribe = env.onVisibility(() => {
    if (stopped || !env.visible()) return;
    if (owed || env.now() - last >= ms) {
      if (timer !== null) env.clearTimeout(timer);
      run();
      schedule();
    }
  });

  if (opts.runNow ?? true) {
    if (env.visible()) run();
    else owed = true;
  } else {
    last = env.now();
  }
  schedule();

  return () => {
    stopped = true;
    if (timer !== null) env.clearTimeout(timer);
    unsubscribe();
  };
}
