import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { assertTestDatabase, createFixtures, hasTestDatabase } from "./support/fixtures.js";

// ---------------------------------------------------------------------------
// This suite was the last hole in the *_test guard, and the worst one to leave
// open. It does not merely write rows: `evictStale()` sweeps EVERY actor in the
// database whose heartbeat has lapsed, so a run pointed at the live world would
// empty the Plaza of everyone who happened to be asleep.
//
// The old gate was `Boolean(process.env.DATABASE_URL)`, which never once
// refused: importing @grove/domain loads dotenv as a side effect, so
// DATABASE_URL is ALWAYS populated from the deployed configuration before the
// first line of a test is evaluated. `pnpm --filter @grove/domain test` on a
// developer's machine therefore ran this against production.
//
// Now it checks the database NAME, twice, exactly as every sibling suite does:
// once on process.env at module load (to decide whether to skip) and once on the
// url loadConfig() actually hands back (which can supply its own default).
// ---------------------------------------------------------------------------
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("heartbeat eviction", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  // Shared apparatus: foreign-key ordered sweep, protected-id guards,
  // derive-don't-trust owner sweeps, loud on failure. See ./support/fixtures.ts.
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the eviction suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    // cleanup() throws if anything failed to delete, so a leak fails the suite
    // loudly. Close the connections either way.
    try {
      await fixtures.cleanup();
    } finally {
      await redis.quit();
      await pg.end();
    }
  });

  it("removes an actor after 10 minute HTTP ttl", async () => {
    const actorId = `hum_evict_${Date.now()}`;
    const seat = 79;
    // Tracked as a human so the shared sweep takes the presence row even if the
    // assertion below never reaches evictStale().
    fixtures.trackHuman(actorId);
    await pg.query(`DELETE FROM presence WHERE room_id = 'plaza' AND seat_index = $1`, [seat]);
    await pg.query(
      `INSERT INTO presence (actor_id, actor_kind, room_id, seat_index, connection, mode, activity, last_seen_at)
       VALUES ($1,'human','plaza',$2,'async','active','idle', now() - interval '11 minutes')
       ON CONFLICT (actor_id) DO UPDATE SET last_seen_at = now() - interval '11 minutes', connection = 'async', seat_index = $2`,
      [actorId, seat],
    );
    const before = await grove.presence.getPresence(actorId);
    expect(before).not.toBeNull();
    const n = await grove.presence.evictStale();
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await grove.presence.getPresence(actorId);
    expect(after).toBeNull();
  });
});
