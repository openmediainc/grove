/**
 * Batch follow state for every heart on a page (queue #55).
 *
 * A shelf of 24 cards used to ask 24 times. Now each FollowButton asks this
 * loader, which collects every ask made within one frame (16 ms), drops the
 * ones it already knows or is already fetching, and sends what is left as one
 * `GET /api/v1/follows/state?subjects=…` per 50.
 *
 * The answer is cached for the page session. A subject the server left out (a
 * private space you are not in, a pending agent, nothing by that name) is
 * cached as `null`, which the button renders as nothing, exactly as a 404 did.
 * A follow or unfollow puts the server's answer straight into the cache and
 * tells every other heart on the page for the same subject, so two shelves
 * showing one agent never disagree.
 *
 * Pure apart from the injected fetch and scheduler, so batching, dedupe and
 * invalidation are tested without a browser.
 */
import { FOLLOW_STATE_BATCH_MAX } from "@grove/protocol";
import { followTargetKey, type FollowTarget } from "./follow";

export type HeartState = { following: boolean; followers: number };

/** One batch request: the keys asked, and the states the server returned (omitted = not visible). */
export type FetchStates = (keys: string[]) => Promise<Record<string, HeartState>>;

export const FOLLOW_STATE_PATH = "/api/v1/follows/state";
export const FOLLOW_BATCH_WINDOW_MS = 16;

export function followStatePath(keys: string[]): string {
  return `${FOLLOW_STATE_PATH}?subjects=${encodeURIComponent(keys.join(","))}`;
}

/** Split into requests of at most `size` keys. */
export function chunk<T>(items: T[], size = FOLLOW_STATE_BATCH_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Entry = { value: HeartState | null } | { pending: Promise<HeartState | null> };

export interface FollowStateLoader {
  /** The state for one subject: cached, in flight, or batched into the next frame. Null: not visible. */
  load(target: FollowTarget): Promise<HeartState | null>;
  /** What the cache holds right now (undefined: not known yet). */
  peek(target: FollowTarget): HeartState | null | undefined;
  /** Put a known answer in the cache (after a follow/unfollow) and tell every listener for that subject. */
  set(target: FollowTarget, value: HeartState | null): void;
  /** Forget one subject, or everything, so the next load asks again. */
  invalidate(target?: FollowTarget): void;
  /** Hear `set` for one subject. Returns the unsubscribe. */
  subscribe(target: FollowTarget, fn: (value: HeartState | null) => void): () => void;
}

export function createFollowStateLoader(opts: {
  fetchStates: FetchStates;
  schedule?: (flush: () => void) => void;
}): FollowStateLoader {
  const schedule = opts.schedule ?? ((flush) => void setTimeout(flush, FOLLOW_BATCH_WINDOW_MS));
  const cache = new Map<string, Entry>();
  const listeners = new Map<string, Set<(v: HeartState | null) => void>>();
  let queue = new Map<string, { resolve: (v: HeartState | null) => void; reject: (e: unknown) => void }[]>();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const batch = queue;
    queue = new Map();
    for (const keys of chunk([...batch.keys()])) {
      opts.fetchStates(keys).then(
        (states) => {
          for (const key of keys) {
            const got = Object.prototype.hasOwnProperty.call(states, key) ? states[key] : undefined;
            const fetched: HeartState | null = got ? { following: got.following === true, followers: Number(got.followers) || 0 } : null;
            const now = cache.get(key);
            // Still waiting on this fetch: cache it. A follow that landed in flight (`set`) is newer and
            // wins; an `invalidate` in flight means do not cache, but still answer the waiting hearts.
            let answer = fetched;
            if (now && "pending" in now) cache.set(key, { value: fetched });
            else if (now && "value" in now) answer = now.value;
            for (const w of batch.get(key) ?? []) w.resolve(answer);
          }
        },
        (err) => {
          for (const key of keys) {
            // Not cached: a later mount may ask again. A follow that landed in flight still answers.
            const now = cache.get(key);
            if (now && "pending" in now) cache.delete(key);
            for (const w of batch.get(key) ?? []) {
              if (now && "value" in now) w.resolve(now.value);
              else w.reject(err);
            }
          }
        },
      );
    }
  };

  return {
    load(target) {
      const key = followTargetKey(target);
      // A comma would split into another subject on the wire; no real slug has one.
      if (key.slice(key.indexOf(":") + 1).includes(",")) return Promise.resolve(null);
      const hit = cache.get(key);
      if (hit) return "value" in hit ? Promise.resolve(hit.value) : hit.pending;
      const pending = new Promise<HeartState | null>((resolve, reject) => {
        const waiting = queue.get(key) ?? [];
        waiting.push({ resolve, reject });
        queue.set(key, waiting);
      });
      cache.set(key, { pending });
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
      return pending;
    },
    peek(target) {
      const hit = cache.get(followTargetKey(target));
      return hit && "value" in hit ? hit.value : undefined;
    },
    set(target, value) {
      const key = followTargetKey(target);
      cache.set(key, { value });
      for (const fn of listeners.get(key) ?? []) fn(value);
    },
    invalidate(target) {
      if (target) cache.delete(followTargetKey(target));
      else cache.clear();
    },
    subscribe(target, fn) {
      const key = followTargetKey(target);
      const set = listeners.get(key) ?? new Set();
      set.add(fn);
      listeners.set(key, set);
      return () => {
        set.delete(fn);
        if (!set.size) listeners.delete(key);
      };
    },
  };
}
