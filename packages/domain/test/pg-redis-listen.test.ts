import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgRedis, listenConnections } from "../src/pg-redis.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { assertTestDatabase, hasTestDatabase } from "./support/fixtures.js";

// The SSE close handler calls unsubscribe() then quit(). PgRedis had no
// unsubscribe, so the call threw, quit never ran, and every closed stream
// leaked a LISTEN connection until Supabase's session pool ran out.
describe("PgRedis subscriber lifecycle without a database", () => {
  it("unsubscribe and quit resolve even when nothing was subscribed", async () => {
    const bus = new PgRedis({} as never, "postgres://nobody@127.0.0.1:1/none");
    await expect(bus.unsubscribe("sse:plaza")).resolves.toBe(0);
    await expect(bus.quit()).resolves.toBe("OK");
    expect(listenConnections("postgres://nobody@127.0.0.1:1/none")).toBe(0);
  });
});

describe.skipIf(!hasTestDatabase())("PgRedis shares one LISTEN connection (REDIS_URL=pg)", () => {
  let config: ReturnType<typeof loadConfig>;
  let pool: ReturnType<typeof createPool>;
  const channel = `sse:listentest:${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the pg-redis listen suite");
    await migrate(config.databaseUrl);
    pool = createPool(config.databaseUrl);
  });

  afterAll(async () => {
    await pool.end();
  });

  const next = (bus: PgRedis) =>
    new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no message")), 5000);
      bus.once("message", (_ch: string, msg: string) => {
        clearTimeout(t);
        resolve(msg);
      });
    });

  it("many subscribers, one connection; the last quit closes it", async () => {
    const root = new PgRedis(pool, config.databaseUrl);
    const subs = [root.duplicate(), root.duplicate(), root.duplicate()];
    for (const s of subs) await s.subscribe(channel);
    expect(listenConnections(config.databaseUrl)).toBe(1);

    const heard = subs.map(next);
    await root.publish(channel, "hello");
    expect(await Promise.all(heard)).toEqual(["hello", "hello", "hello"]);

    // One viewer leaves; the others still hear the channel.
    await subs[0]!.unsubscribe(channel);
    await subs[0]!.quit();
    const still = [next(subs[1]!), next(subs[2]!)];
    await root.publish(channel, "again");
    expect(await Promise.all(still)).toEqual(["again", "again"]);
    expect(listenConnections(config.databaseUrl)).toBe(1);

    await subs[1]!.quit();
    await subs[2]!.quit();
    expect(listenConnections(config.databaseUrl)).toBe(0);
  });
});
