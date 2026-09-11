import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "../src/index.js";

const hasDb = Boolean(process.env.DATABASE_URL) || process.env.GROVE_INTEGRATION === "1";

describe.skipIf(!hasDb)("heartbeat eviction", () => {
  let grove: GroveApp | undefined;

  async function boot() {
    if (grove) return grove;
    const config = loadConfig();
    await migrate(config.databaseUrl);
    grove = new GroveApp(createPool(config.databaseUrl), new Redis(config.redisUrl), config);
    return grove;
  }

  afterAll(async () => {
    await grove?.store.pg.end();
    grove?.store.redis.disconnect();
  });

  it("removes an actor after 10 minute HTTP ttl", async () => {
    const g = await boot();
    const actorId = `hum_evict_${Date.now()}`;
    const seat = 79;
    await g.store.pg.query(`DELETE FROM presence WHERE room_id = 'plaza' AND seat_index = $1`, [seat]);
    await g.store.pg.query(
      `INSERT INTO presence (actor_id, actor_kind, room_id, seat_index, connection, mode, activity, last_seen_at)
       VALUES ($1,'human','plaza',$2,'async','active','idle', now() - interval '11 minutes')
       ON CONFLICT (actor_id) DO UPDATE SET last_seen_at = now() - interval '11 minutes', connection = 'async', seat_index = $2`,
      [actorId, seat],
    );
    const before = await g.presence.getPresence(actorId);
    expect(before).not.toBeNull();
    const n = await g.presence.evictStale();
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await g.presence.getPresence(actorId);
    expect(after).toBeNull();
  });
});
