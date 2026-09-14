import { describe, expect, it } from "vitest";
import { FOLLOW_STATE_BATCH_MAX } from "@grove/protocol";
import { chunk, createFollowStateLoader, followStatePath, type HeartState } from "../lib/follow-state";
import type { FollowTarget } from "../lib/follow";

const space = (ref: string): FollowTarget => ({ subject: "space", ref });
const agent = (slug: string): FollowTarget => ({ subject: "agent", slug });

/** A loader whose frame flushes by hand and whose server is a table. */
function harness(server: Record<string, HeartState>, opts: { fail?: boolean } = {}) {
  const calls: string[][] = [];
  let flush: (() => void) | null = null;
  const loader = createFollowStateLoader({
    fetchStates: async (keys) => {
      calls.push(keys);
      if (opts.fail) throw Object.assign(new Error("slow down"), { status: 429 });
      return Object.fromEntries(keys.filter((k) => k in server).map((k) => [k, server[k]!]));
    },
    schedule: (f) => {
      flush = f;
    },
  });
  const frame = async () => {
    const f = flush;
    flush = null;
    f?.();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { loader, calls, frame };
}

describe("batch follow state loader", () => {
  it("asks once for every heart mounted in the same frame, deduped", async () => {
    const { loader, calls, frame } = harness({
      "space:harbour": { following: true, followers: 3 },
      "agent:ada/scout": { following: false, followers: 1 },
    });
    const a = loader.load(space("harbour"));
    const b = loader.load(agent("ada/scout"));
    const c = loader.load(space("harbour"));
    expect(calls).toEqual([]);
    await frame();
    expect(calls).toEqual([["space:harbour", "agent:ada/scout"]]);
    expect(await a).toEqual({ following: true, followers: 3 });
    expect(await b).toEqual({ following: false, followers: 1 });
    expect(await c).toEqual({ following: true, followers: 3 });

    // Cached for the page session: a later mount asks nobody.
    expect(await loader.load(space("harbour"))).toEqual({ following: true, followers: 3 });
    expect(loader.peek(agent("ada/scout"))).toEqual({ following: false, followers: 1 });
    await frame();
    expect(calls).toHaveLength(1);
  });

  it("treats an omitted subject as invisible, and caches that too", async () => {
    const { loader, calls, frame } = harness({});
    const hidden = loader.load(space("private-plot"));
    await frame();
    expect(await hidden).toBeNull();
    expect(loader.peek(space("private-plot"))).toBeNull();
    expect(await loader.load(space("private-plot"))).toBeNull();
    expect(calls).toHaveLength(1);
    expect(await loader.load(space("a,b"))).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("splits a big page into requests of at most 50", async () => {
    const { loader, calls, frame } = harness({});
    const all = Array.from({ length: FOLLOW_STATE_BATCH_MAX * 2 + 3 }, (_, i) => loader.load(space(`s${i}`)));
    await frame();
    await Promise.all(all);
    expect(calls.map((c) => c.length)).toEqual([50, 50, 3]);
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it("is invalidated by a follow: the new answer reaches every heart for that subject", async () => {
    const { loader, calls, frame } = harness({ "agent:scout": { following: false, followers: 0 } });
    const first = loader.load(agent("scout"));
    await frame();
    expect(await first).toEqual({ following: false, followers: 0 });

    const heard: Array<HeartState | null> = [];
    const off = loader.subscribe(agent("scout"), (v) => heard.push(v));
    const other: Array<HeartState | null> = [];
    loader.subscribe(space("harbour"), (v) => other.push(v));
    loader.set(agent("scout"), { following: true, followers: 1 });
    expect(heard).toEqual([{ following: true, followers: 1 }]);
    expect(other).toEqual([]);
    expect(await loader.load(agent("scout"))).toEqual({ following: true, followers: 1 });
    off();
    loader.set(agent("scout"), null);
    expect(heard).toHaveLength(1);

    loader.invalidate(agent("scout"));
    const again = loader.load(agent("scout"));
    await frame();
    expect(await again).toEqual({ following: false, followers: 0 });
    expect(calls).toHaveLength(2);
  });

  it("lets a follow that lands mid-flight win over the older batch answer", async () => {
    const { loader, frame } = harness({ "space:harbour": { following: false, followers: 2 } });
    const pending = loader.load(space("harbour"));
    loader.set(space("harbour"), { following: true, followers: 3 });
    await frame();
    expect(await pending).toEqual({ following: true, followers: 3 });
    expect(loader.peek(space("harbour"))).toEqual({ following: true, followers: 3 });
  });

  it("does not cache a failed request, so the next mount asks again", async () => {
    const { loader, calls, frame } = harness({}, { fail: true });
    const p = loader.load(space("harbour")).then(
      () => "answered",
      (e: Error) => e.message,
    );
    await frame();
    expect(await p).toBe("slow down");
    expect(loader.peek(space("harbour"))).toBeUndefined();
    void loader.load(space("harbour")).catch(() => {});
    await frame();
    expect(calls).toHaveLength(2);
  });

  it("builds the batch path with the subjects in one encoded parameter", () => {
    expect(followStatePath(["space:harbour", "agent:ada/scout one"])).toBe(
      "/api/v1/follows/state?subjects=space%3Aharbour%2Cagent%3Aada%2Fscout%20one",
    );
  });
});
