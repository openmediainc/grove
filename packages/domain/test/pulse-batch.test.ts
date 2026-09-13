import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { toSnake } from "@grove/protocol";
import { GroveApp } from "../src/index.js";
import { GroveError } from "../src/errors.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  normalisePulseEventId,
  PULSE_BATCH_MAX,
  PULSE_DEDUPE_TTL_SECONDS,
  PULSE_FUTURE_TOLERANCE_MS,
  PULSE_MAX_AGE_SECONDS,
  pulseBatchFromWire,
  pulseInputFromWire,
  resolvePulseAt,
  type PulseInput,
} from "../src/services/pulse-batch.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

/** Own register bucket: the limiter is 3/IP/hour and vitest runs files in parallel. */
const REGISTER_IP = REGISTER_IPS.pulseBatch;

/**
 * Batch pulse (AGT-10).
 *
 * The 1/s cap made a fast agent choose between honesty and throughput. A batch
 * lets it report every phase it went through, at the moment it happened, in
 * one request. Each rule below is one decision from pulse-batch.ts / PULSE.md:
 * size, rate, clock, order, idempotency, partial failure, and what the map and
 * the ledger each get to keep.
 */

// ---------------------------------------------------------------------------
// Pure rules. No database.
// ---------------------------------------------------------------------------

describe("batch pulse: the clock", () => {
  const now = Date.parse("2026-09-13T12:00:00.000Z");

  it("reads no `at` as the moment the batch arrived", () => {
    expect(resolvePulseAt(undefined, now)).toEqual({ ok: true, at: now, clamped: false });
    expect(resolvePulseAt(null, now)).toEqual({ ok: true, at: now, clamped: false });
  });

  it("keeps a real past timestamp exactly, as ISO or epoch milliseconds", () => {
    expect(resolvePulseAt("2026-09-13T11:59:30.250Z", now)).toEqual({ ok: true, at: now - 29_750, clamped: false });
    expect(resolvePulseAt(now - 1000, now)).toEqual({ ok: true, at: now - 1000, clamped: false });
    expect(resolvePulseAt(String(now - 1000), now)).toEqual({ ok: true, at: now - 1000, clamped: false });
  });

  it("clamps a clock slightly ahead to the receive time, and says so", () => {
    expect(resolvePulseAt(now + PULSE_FUTURE_TOLERANCE_MS, now)).toEqual({ ok: true, at: now, clamped: true });
  });

  it("refuses a timestamp from the future beyond the tolerance", () => {
    const r = resolvePulseAt(now + PULSE_FUTURE_TOLERANCE_MS + 1, now);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe("TIMESTAMP_FUTURE");
  });

  it("accepts the last five minutes and refuses anything older, rather than rewriting it", () => {
    expect(resolvePulseAt(now - PULSE_MAX_AGE_SECONDS * 1000, now).ok).toBe(true);
    const r = resolvePulseAt(now - PULSE_MAX_AGE_SECONDS * 1000 - 1, now);
    expect(r.ok === false && r.code).toBe("TIMESTAMP_STALE");
  });

  it("refuses a timestamp it cannot read", () => {
    const r = resolvePulseAt("last tuesday", now);
    expect(r.ok === false && r.code).toBe("INVALID");
  });

  it("remembers ids for long enough that any retry it would still accept is caught", () => {
    // An item is accepted only while `at` is under PULSE_MAX_AGE_SECONDS old, so
    // the latest acceptable retry arrives at most that long after the first
    // landing. The id must outlive that window.
    expect(PULSE_DEDUPE_TTL_SECONDS).toBeGreaterThanOrEqual(PULSE_MAX_AGE_SECONDS * 2);
  });
});

describe("batch pulse: the wire", () => {
  it("is not a batch unless it says `pulses`", () => {
    expect(pulseBatchFromWire({ verb: "tool" })).toBeNull();
    expect(pulseBatchFromWire(null)).toBeNull();
  });

  it("refuses the whole request when the shape is wrong", () => {
    const code = (b: unknown) => {
      try {
        pulseBatchFromWire(b);
        return null;
      } catch (err) {
        return (err as GroveError).code;
      }
    };
    expect(code({ pulses: "tool" })).toBe("INVALID");
    expect(code({ pulses: [] })).toBe("INVALID");
    expect(code({ verb: "tool", pulses: [{ verb: "tool" }] })).toBe("INVALID");
    expect(code({ pulses: Array.from({ length: PULSE_BATCH_MAX + 1 }, () => ({ verb: "tool" })) })).toBe("INVALID");
    expect(code({ pulses: Array.from({ length: PULSE_BATCH_MAX }, () => ({ verb: "tool" })) })).toBeNull();
  });

  it("carries every field a single pulse carries, in either spelling", () => {
    const [snake, camel] = pulseBatchFromWire({
      pulses: [
        { verb: "error", detail: "d", url: "https://x.test/1", error_text: "boom", at: "2026-09-13T12:00:00Z", id: "e1" },
        { verb: "error", detail: "d", url: "https://x.test/1", errorText: "boom", at: "2026-09-13T12:00:00Z", id: "e1" },
      ],
    })!;
    expect(snake).toEqual(camel);
    // And a single pulse reads through the very same parser.
    expect(pulseInputFromWire({ verb: "error", detail: "d", url: "https://x.test/1", error_text: "boom" })).toMatchObject({
      verb: "error",
      detail: "d",
      url: "https://x.test/1",
      errorText: "boom",
    });
  });

  it("turns a non-object item into an item that will be refused, not a crash", () => {
    expect(pulseBatchFromWire({ pulses: ["tool", 7] })).toEqual([
      expect.objectContaining({ verb: "" }),
      expect.objectContaining({ verb: "" }),
    ]);
  });

  it("accepts a sane client event id and refuses anything else", () => {
    expect(normalisePulseEventId("01J9F2QK:step-3.a_b")).toBe("01J9F2QK:step-3.a_b");
    expect(normalisePulseEventId(null)).toBeNull();
    expect(() => normalisePulseEventId("has space")).toThrowError(/id must be/);
    expect(() => normalisePulseEventId("x".repeat(65))).toThrowError(/id must be/);
  });
});

// ---------------------------------------------------------------------------
// Against the database: the real write path, the real trigger, the real cap.
// ---------------------------------------------------------------------------

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("batch pulse: what lands", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function newInhabitant(name: string, opts: { join?: boolean } = {}) {
    const owner = await newHuman("batch-owner");
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner as never);
    await clearActorLimiters(redis, agent.id);
    if (opts.join !== false) {
      await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "plaza", {
        connection: "async",
        mode: "autonomous",
        activity: "idle",
        overflowPlaza: true,
      });
    }
    return agent;
  }

  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  async function phasesOf(actorId: string) {
    const { rows } = await pg.query(
      `SELECT payload FROM world_events WHERE type = 'agent_phase' AND actor_id = $1 ORDER BY id`,
      [actorId],
    );
    return rows.map((r) => r.payload as Record<string, unknown>);
  }

  async function presenceRow(actorId: string) {
    const { rows } = await pg.query("SELECT verb, detail, url, error_text, pulsed_at FROM presence WHERE actor_id = $1", [
      actorId,
    ]);
    return rows[0] as { verb: string; detail: string; url: string | null; error_text: string | null; pulsed_at: Date };
  }

  const rateLimited = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err) => (err instanceof GroveError ? err.code : String(err)),
    );

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the pulse batch suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    await fixtures.cleanup();
    await redis.quit();
    await pg.end();
  });

  it("applies an ordered burst: the body shows the last item, at the time it really happened", async () => {
    const agent = await newInhabitant(`burst${tag()}`);
    const t0 = Date.now() - 900;
    const result = await grove.presence.pulseBatch(agent.id, [
      { verb: "think", detail: "planning", at: t0 },
      { verb: "read", detail: "reading migrations", at: t0 + 200 },
      { verb: "tool", detail: "pnpm test:safe", at: t0 + 400, url: "https://github.com/grove/grove/pull/42" },
    ]);
    expect(result.applied).toBe(3);
    expect(result.refused).toBe(0);
    expect(result.results.map((r) => [r.index, r.status, r.verb])).toEqual([
      [0, "applied", "think"],
      [1, "applied", "read"],
      [2, "applied", "tool"],
    ]);
    expect(result.results.map((r) => Date.parse(r.pulsedAt!))).toEqual([t0, t0 + 200, t0 + 400]);
    expect(result.results.every((r) => !r.clamped)).toBe(true);

    const row = await presenceRow(agent.id);
    expect(row.verb).toBe("tool");
    expect(row.detail).toBe("pnpm test:safe");
    expect(row.url).toBe("https://github.com/grove/grove/pull/42");
    // Back-dated honestly: the body's pulse age is the last item's, not the request's.
    expect(row.pulsed_at.getTime()).toBe(t0 + 400);
    expect(result.presence?.verb).toBe("tool");
  });

  it("counts a batch as ONE request against the 1/s cap", async () => {
    const agent = await newInhabitant(`capped${tag()}`);
    await grove.presence.pulseBatch(agent.id, [{ verb: "think" }, { verb: "tool" }]);
    // The batch spent this second's pulse: a single pulse and a second batch are both refused...
    expect(await rateLimited(grove.presence.pulse(agent.id, "idle"))).toBe("RATE_LIMITED");
    expect(await rateLimited(grove.presence.pulseBatch(agent.id, [{ verb: "read" }]))).toBe("RATE_LIMITED");
    // ...and a refused batch writes nothing at all.
    expect((await presenceRow(agent.id)).verb).toBe("tool");
    await clearActorLimiters(redis, agent.id);
    expect(await rateLimited(grove.presence.pulse(agent.id, "idle"))).toBeNull();
  });

  it("refuses an oversized batch whole, before it spends the cap", async () => {
    const agent = await newInhabitant(`huge${tag()}`);
    const huge: PulseInput[] = Array.from({ length: PULSE_BATCH_MAX + 1 }, () => ({ verb: "tool" }));
    expect(await rateLimited(grove.presence.pulseBatch(agent.id, huge))).toBe("INVALID");
    expect((await presenceRow(agent.id)).verb).toBeNull();
    expect(await rateLimited(grove.presence.pulse(agent.id, "think"))).toBeNull();
  });

  it("reports a bad item on its own line and applies the rest", async () => {
    const agent = await newInhabitant(`partial${tag()}`);
    const t0 = Date.now() - 10_000;
    const result = await grove.presence.pulseBatch(agent.id, [
      { verb: "think", at: t0, id: "a" },
      { verb: "vibing", at: t0 + 1, id: "b" },
      { verb: "tool", url: "javascript:alert(1)", at: t0 + 2, id: "c" },
      { verb: "read", at: Date.now() + 60_000, id: "d" },
      { verb: "read", at: Date.now() - (PULSE_MAX_AGE_SECONDS + 60) * 1000, id: "e" },
      { verb: "tool", id: "bad id!" },
      { verb: "idle", at: t0 + 5, id: "f" },
    ]);
    expect(result.results.map((r) => [r.id, r.status, r.code ?? null])).toEqual([
      ["a", "applied", null],
      ["b", "refused", "INVALID"],
      ["c", "refused", "INVALID"],
      ["d", "refused", "TIMESTAMP_FUTURE"],
      ["e", "refused", "TIMESTAMP_STALE"],
      ["bad id!", "refused", "INVALID"],
      ["f", "applied", null],
    ]);
    expect(result.results[1]!.reason).toMatch(/verb must be one of/);
    expect(result.results[2]!.reason).toMatch(/http/);
    expect(result).toMatchObject({ applied: 2, refused: 5, duplicates: 0 });
    expect((await presenceRow(agent.id)).verb).toBe("idle");
    // A refused id is not remembered: fixed and resent, it lands.
    await clearActorLimiters(redis, agent.id);
    const again = await grove.presence.pulseBatch(agent.id, [{ verb: "tool", id: "b" }]);
    expect(again.results[0]!.status).toBe("applied");
  });

  it("goes out snake_case on the wire, per item, like undelivered[]", () => {
    const wire = toSnake({
      results: [{ index: 1, id: "b", status: "refused", verb: "vibing", pulsedAt: null, clamped: false, code: "INVALID", reason: "x" }],
    }) as { results: Record<string, unknown>[] };
    expect(Object.keys(wire.results[0]!).sort()).toEqual(
      ["clamped", "code", "id", "index", "pulsed_at", "reason", "status", "verb"],
    );
  });

  it("keeps the array's order when the client clock runs backwards, and says it clamped", async () => {
    const agent = await newInhabitant(`skew${tag()}`);
    const t0 = Date.now() - 30_000;
    const result = await grove.presence.pulseBatch(agent.id, [
      { verb: "think", at: t0 },
      { verb: "read", at: t0 - 5_000 }, // earlier than its predecessor
      { verb: "tool", at: t0 }, // equal to an earlier item
      { verb: "wait", at: Date.now() + 1_000 }, // a clock a second fast
    ]);
    const times = result.results.map((r) => Date.parse(r.pulsedAt!));
    expect(times[0]).toBe(t0);
    for (let i = 1; i < times.length; i += 1) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    expect(result.results.map((r) => r.clamped)).toEqual([false, true, true, true]);
    expect(times[3]!).toBeLessThanOrEqual(Date.now());
    expect((await presenceRow(agent.id)).verb).toBe("wait");
  });

  it("never moves the body's clock backwards past a pulse it already has", async () => {
    const agent = await newInhabitant(`behind${tag()}`);
    await grove.presence.pulse(agent.id, "think", "just now");
    const stored = (await presenceRow(agent.id)).pulsed_at.getTime();
    await clearActorLimiters(redis, agent.id);
    const result = await grove.presence.pulseBatch(agent.id, [{ verb: "tool", at: Date.now() - 60_000 }]);
    expect(result.results[0]!.status).toBe("applied");
    expect(result.results[0]!.clamped).toBe(true);
    expect(Date.parse(result.results[0]!.pulsedAt!)).toBeGreaterThan(stored);
  });

  it("does not double-log a retry, and a retry of only duplicates costs no quota", async () => {
    const agent = await newInhabitant(`retry${tag()}`);
    const t0 = Date.now() - 200_000;
    const batch: PulseInput[] = [
      { verb: "error", detail: "worker crashed", errorText: "boom", at: t0, id: "evt-1" },
      { verb: "think", detail: "recovering", at: t0 + 20_000, id: "evt-2" },
    ];
    const first = await grove.presence.pulseBatch(agent.id, batch);
    expect(first.applied).toBe(2);
    const phasesAfterFirst = await phasesOf(agent.id);
    expect(phasesAfterFirst.filter((p) => p.verb === "error")).toHaveLength(1);

    // The response was "lost"; the client resends immediately — inside the
    // cooldown. It must not be refused by its own cap, and nothing is re-written.
    const retry = await grove.presence.pulseBatch(agent.id, batch);
    expect(retry.results.map((r) => r.status)).toEqual(["duplicate", "duplicate"]);
    expect(retry.duplicates).toBe(2);
    // The duplicate points at where the original landed.
    expect(retry.results.map((r) => r.pulsedAt)).toEqual(first.results.map((r) => r.pulsedAt));
    expect(await phasesOf(agent.id)).toEqual(phasesAfterFirst);

    // A retry that mixes old and new writes only the new item.
    await clearActorLimiters(redis, agent.id);
    const mixed = await grove.presence.pulseBatch(agent.id, [...batch, { verb: "idle", id: "evt-3" }]);
    expect(mixed.results.map((r) => r.status)).toEqual(["duplicate", "duplicate", "applied"]);
  });

  it("treats a repeated id inside one batch as a duplicate", async () => {
    const agent = await newInhabitant(`twice${tag()}`);
    const result = await grove.presence.pulseBatch(agent.id, [
      { verb: "tool", id: "same" },
      { verb: "read", id: "same" },
    ]);
    expect(result.results.map((r) => r.status)).toEqual(["applied", "duplicate"]);
    expect((await presenceRow(agent.id)).verb).toBe("tool");
  });

  it("spends nothing and writes nothing when every item is refused", async () => {
    const agent = await newInhabitant(`allbad${tag()}`);
    const result = await grove.presence.pulseBatch(agent.id, [{ verb: "nope" }, { verb: "tool", at: Date.now() + 60_000 }]);
    expect(result).toMatchObject({ applied: 0, refused: 2 });
    expect((await presenceRow(agent.id)).verb).toBeNull();
    expect(await rateLimited(grove.presence.pulse(agent.id, "think"))).toBeNull();
  });

  it("rolls back a body with no room, and does not remember ids it never wrote", async () => {
    const agent = await newInhabitant(`roomless${tag()}`, { join: false });
    expect(await rateLimited(grove.presence.pulseBatch(agent.id, [{ verb: "tool", id: "x1" }]))).toBe("NOT_FOUND");
    expect(await redis.get(`pulse:seen:${agent.id}:x1`)).toBeNull();
  });

  it("keeps every phase of a burst in the ledger, at its own time", async () => {
    const agent = await newInhabitant(`ledger${tag()}`);
    const now = Date.now();
    // A tool stretch long enough to clear the 180s noise floor, then a brief
    // fault (never absorbed), then idle — all reported in one batch.
    await grove.presence.pulseBatch(agent.id, [
      { verb: "tool", detail: "pnpm test:safe", at: now - 290_000 },
      // Still at it: without this the stretch would be cut at the stall threshold.
      { verb: "tool", detail: "pnpm test:safe", at: now - 150_000 },
      { verb: "error", detail: "worker crashed", errorText: "TypeError: rows", at: now - 60_000 },
      { verb: "idle", detail: "gave up", at: now - 55_000 },
    ]);
    const phases = await phasesOf(agent.id);
    expect(phases.map((p) => p.verb)).toEqual(["tool", "error"]);
    expect(Date.parse(String(phases[0]!.started_at))).toBe(now - 290_000);
    expect(phases[0]!.seconds).toBe(230);
    expect(Date.parse(String(phases[1]!.started_at))).toBe(now - 60_000);
    expect(phases[1]!.seconds).toBe(5);
    expect(phases[1]!.error_text).toBe("TypeError: rows");
  });

  it("publishes ONE realtime event per batch, carrying the final state", async () => {
    const agent = await newInhabitant(`live${tag()}`);
    const sub = new Redis(loadConfig().redisUrl);
    const seen: Record<string, unknown>[] = [];
    try {
      await sub.subscribe("pubsub:room:plaza");
      sub.on("message", (_ch, msg) => {
        const d = JSON.parse(msg) as Record<string, unknown>;
        if (d.actor_id === agent.id && d.type === "pulse") seen.push(d);
      });
      await grove.presence.pulseBatch(agent.id, [
        { verb: "think", at: ago(3) },
        { verb: "read", at: ago(2) },
        { verb: "tool", detail: "pnpm test:safe", at: ago(1) },
      ]);
      for (let i = 0; i < 50 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await sub.quit();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.verb).toBe("tool");
    expect(seen[0]!.detail).toBe("pnpm test:safe");
    expect((seen[0]!.batch as { count: number }).count).toBe(3);
  });
});
