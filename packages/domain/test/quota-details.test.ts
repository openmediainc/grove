import { describe, expect, it } from "vitest";
import { MemoryRateLimiter, QuotaService, type RateLimitDetails } from "../src/services/quota.js";
import { GroveError } from "../src/errors.js";

/**
 * A RATE_LIMITED error has to say WHICH limiter refused, or the transport can
 * only answer with a floor.
 *
 * apps/api/src/http.ts derives every limiter's shape by running quota.ts, so it
 * knows the windows — but on a refusal it had no way to tell which of a route's
 * buckets had just spoken, and fell back to the shortest window of all of them.
 * These tests pin the three things it now needs: the bucket's name, the exact
 * wait, and the remaining count.
 *
 * They also pin the thing that must NOT change: the probe in http.ts learns a
 * limit by charging until it is refused and reading back which key refused
 * last. `refuse()` reads a TTL and never increments, so that derivation still
 * sees exactly what it saw before — the last test in this file is that promise,
 * written as a test rather than a comment.
 */

function details(err: unknown): RateLimitDetails {
  expect(err).toBeInstanceOf(GroveError);
  const d = (err as GroveError).details;
  expect(d, "a RATE_LIMITED error must carry details").toBeDefined();
  return d as unknown as RateLimitDetails;
}

async function refusal(fn: () => Promise<unknown>): Promise<RateLimitDetails> {
  try {
    await fn();
  } catch (e) {
    expect((e as GroveError).code).toBe("RATE_LIMITED");
    return details(e);
  }
  throw new Error("expected a RATE_LIMITED refusal");
}

describe("RATE_LIMITED details", () => {
  it("names the write limiter, its remaining count and its exact wait", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    for (let i = 0; i < 30; i += 1) await q.consumeWrite("agt_1", false);
    const d = await refusal(() => q.consumeWrite("agt_1", false));
    expect(d.limiter).toBe("write");
    expect(d.remaining).toBe(0);
    // The minute window, not a conservative constant: at most 60 s, and still
    // running, so strictly positive.
    expect(d.resetMs).toBeGreaterThan(0);
    expect(d.resetMs).toBeLessThanOrEqual(60_000);
  });

  it("distinguishes a first-24h bucket from the established one", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    for (let i = 0; i < 15; i += 1) await q.consumeWrite("agt_new", true);
    expect((await refusal(() => q.consumeWrite("agt_new", true))).limiter).toBe("write_new");

    const w = new QuotaService(new MemoryRateLimiter());
    for (let i = 0; i < 10; i += 1) await w.consumeWhisper("agt_new", true);
    expect((await refusal(() => w.consumeWhisper("agt_new", true))).limiter).toBe("whisper_new");
  });

  it("names the read limiter", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    for (let i = 0; i < 60; i += 1) await q.consumeRead("agt_2");
    const d = await refusal(() => q.consumeRead("agt_2"));
    expect(d.limiter).toBe("read");
    expect(d.resetMs).toBeLessThanOrEqual(60_000);
  });

  it("tells a refused pulse to wait a second, not a minute", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    await q.consumePulse("agt_3");
    const d = await refusal(() => q.consumePulse("agt_3"));
    expect(d.limiter).toBe("pulse");
    expect(d.remaining).toBe(0);
    // The whole point of the change: a cooldown is a second, and the blanket
    // fallback used to tell this caller to sleep for sixty.
    expect(d.resetMs).toBeLessThanOrEqual(1000);
    expect(d.resetMs).toBeGreaterThan(0);
  });

  it("separates a move cooldown from a spent move window", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    await q.consumeMove("agt_4");
    const cooldown = await refusal(() => q.consumeMove("agt_4"));
    expect(cooldown.limiter).toBe("move");
    expect(cooldown.resetMs).toBeLessThanOrEqual(3000);
  });

  it("tells a refused register how long its window really is", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    for (let i = 0; i < 3; i += 1) await q.consumeRegister("ip-hourly");
    const d = await refusal(() => q.consumeRegister("ip-hourly"));
    expect(d.limiter).toBe("register");
    expect(d.remaining).toBe(0);
    // An hour, not the 60 s the blanket fallback used to promise.
    expect(d.resetMs).toBeGreaterThan(60_000);
    expect(d.resetMs).toBeLessThanOrEqual(3_600_000);
  });

  it("carries the day window when the day window is the one that refused", async () => {
    // Register has TWO windows on one bucket: 3/hour and 10/day. A single
    // `limiter` name is not enough to tell them apart, so `resetMs` has to —
    // and it does, because it is the refusing KEY's ttl, not the bucket's.
    //
    // This limiter forgets the hour bucket every three calls, the way an hour
    // passing would, so the day window is the one left to speak.
    const counts = new Map<string, number>();
    const hourly = {
      async incr(key: string) {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, key.endsWith(":register:hour") && n >= 3 ? 0 : n);
        return n;
      },
      async get() {
        return 0;
      },
      async setPx() {},
      async ttlMs(key: string) {
        return key.endsWith(":register:day") ? 80_000_000 : 3_000_000;
      },
      async exists() {
        return false;
      },
    };
    const q = new QuotaService(hourly as never);
    for (let i = 0; i < 10; i += 1) await q.consumeRegister("ip-daily");
    const d = await refusal(() => q.consumeRegister("ip-daily"));
    expect(d.limiter).toBe("register");
    // A day, not an hour: the two windows on one bucket are now told apart.
    expect(d.resetMs).toBeGreaterThan(3_600_000);
    expect(d.resetMs).toBeLessThanOrEqual(86_400_000);
  });

  it("names the join-request bucket the skill docs name", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    for (let i = 0; i < 3; i += 1) await q.consumeJoinRequest("hum_1", false);
    expect((await refusal(() => q.consumeJoinRequest("hum_1", false))).limiter).toBe("join_request");
  });

  it("names enter, magic_link and report", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    for (let i = 0; i < 10; i += 1) await q.consumeEnter("hum_2");
    expect((await refusal(() => q.consumeEnter("hum_2"))).limiter).toBe("enter");

    for (let i = 0; i < 5; i += 1) await q.consumeMagicLink("A@Example.invalid");
    expect((await refusal(() => q.consumeMagicLink("a@example.invalid"))).limiter).toBe("magic_link");

    for (let i = 0; i < 10; i += 1) await q.consumeReport("hum_2", false);
    expect((await refusal(() => q.consumeReport("hum_2", false))).limiter).toBe("report");
  });

  it("still lets the http.ts probe learn a limit by charging until refused", async () => {
    // A miniature of ProbeLimiter: it records, never enforces, and remembers
    // the last key INCREMENTED. If refuse() ever incremented — or if it stopped
    // reading a real key — the derivation in apps/api/src/http.ts would start
    // publishing the wrong numbers, silently.
    const seen: string[] = [];
    let lastIncr: string | null = null;
    const probe = {
      counts: new Map<string, number>(),
      async incr(key: string) {
        lastIncr = key;
        const n = (this.counts.get(key) ?? 0) + 1;
        this.counts.set(key, n);
        return n;
      },
      async get(key: string) {
        return this.counts.get(key) ?? 0;
      },
      async setPx() {},
      async ttlMs(key: string) {
        seen.push(key);
        return -2; // a probe keeps no TTLs; the limiter must fall back, not crash
      },
      async exists() {
        return false;
      },
    };
    const q = new QuotaService(probe as never);
    let refused = 0;
    for (let i = 0; i < 100; i += 1) {
      try {
        await q.consumeWrite("probe", false);
      } catch {
        refused = probe.counts.get("ratelimit:probe:write:min") ?? 0;
        break;
      }
    }
    expect(refused - 1).toBe(30); // the derived limit, unchanged
    expect(lastIncr).toBe("ratelimit:probe:write:min"); // refuse() did not incr
    expect(seen).toEqual(["ratelimit:probe:write:min"]); // it read the refusing key
  });

  it("falls back to the full window when the limiter cannot say", async () => {
    const blind = {
      n: 0,
      async incr() {
        this.n += 1;
        return this.n;
      },
      async get() {
        return 0;
      },
      async setPx() {},
      async ttlMs() {
        return -2;
      },
      async exists() {
        return false;
      },
    };
    const q = new QuotaService(blind as never);
    for (let i = 0; i < 60; i += 1) await q.consumeRead("agt_5");
    expect((await refusal(() => q.consumeRead("agt_5"))).resetMs).toBe(60_000);
  });
});
