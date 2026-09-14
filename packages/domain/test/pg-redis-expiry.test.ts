import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgRedis } from "../src/pg-redis.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { RedisRateLimiter } from "../src/services/quota.js";
import { assertTestDatabase, hasTestDatabase } from "./support/fixtures.js";

// Prod runs REDIS_URL=pg and nothing purges grove_kv, so expired rows stay in
// the table. Found in the browser (#57): a signed-in human's read limiter kept
// counting past its 60s window, refused every read for good, and the refusal
// itself answered 500 because pttl mixed integer and text CASE arms.
describe.skipIf(!hasTestDatabase())("PgRedis treats expired rows as absent (REDIS_URL=pg)", () => {
  let config: ReturnType<typeof loadConfig>;
  let pool: ReturnType<typeof createPool>;
  let bus: PgRedis;
  const tag = Math.random().toString(36).slice(2, 10);
  const k = (name: string) => `expirytest:${tag}:${name}`;
  const lapse = (table: "grove_kv" | "grove_set", key: string) =>
    pool.query(`UPDATE ${table} SET expires_at = now() - interval '1 second' WHERE key = $1`, [key]);

  beforeAll(async () => {
    config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the pg-redis expiry suite");
    await migrate(config.databaseUrl);
    pool = createPool(config.databaseUrl);
    bus = new PgRedis(pool, config.databaseUrl);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM grove_kv WHERE key LIKE $1", [`expirytest:${tag}:%`]);
    await pool.query("DELETE FROM grove_set WHERE key LIKE $1", [`expirytest:${tag}:%`]);
    await pool.end();
  });

  it("pttl answers numbers for no TTL, a live TTL, an expired row and no row", async () => {
    await bus.set(k("plain"), "v");
    expect(await bus.pttl(k("plain"))).toBe(-1);
    await bus.set(k("live"), "v", "PX", 30_000);
    const ms = await bus.pttl(k("live"));
    expect(ms).toBeGreaterThan(20_000);
    expect(ms).toBeLessThanOrEqual(30_000);
    await lapse("grove_kv", k("live"));
    expect(await bus.pttl(k("live"))).toBe(-2);
    expect(await bus.pttl(k("missing"))).toBe(-2);
  });

  it("a rate-limit window starts again after it lapses", async () => {
    const limiter = new RedisRateLimiter(bus as never);
    expect(await limiter.incr(k("rate"), 60)).toBe(1);
    expect(await limiter.incr(k("rate"), 60)).toBe(2);
    await lapse("grove_kv", k("rate"));
    expect(await limiter.incr(k("rate"), 60)).toBe(1);
    expect(await limiter.ttlMs(k("rate"))).toBeGreaterThan(50_000);
    expect(await limiter.incr(k("rate"), 60)).toBe(2);
  });

  it("SET NX takes an expired key and still refuses a live one", async () => {
    expect(await bus.set(k("lock"), "a", "EX", 60, "NX")).toBe("OK");
    expect(await bus.set(k("lock"), "b", "EX", 60, "NX")).toBeNull();
    expect(await bus.get(k("lock"))).toBe("a");
    await lapse("grove_kv", k("lock"));
    expect(await bus.set(k("lock"), "c", "EX", 60, "NX")).toBe("OK");
    expect(await bus.get(k("lock"))).toBe("c");
    expect(await bus.pttl(k("lock"))).toBeGreaterThan(50_000);
  });

  it("SADD after a set's TTL lapsed makes the member visible again", async () => {
    expect(await bus.sadd(k("set"), "m1")).toBe(1);
    await bus.expire(k("set"), 60);
    await lapse("grove_set", k("set"));
    expect(await bus.smembers(k("set"))).toEqual([]);
    expect(await bus.sadd(k("set"), "m1")).toBe(1);
    expect(await bus.smembers(k("set"))).toEqual(["m1"]);
  });
});
