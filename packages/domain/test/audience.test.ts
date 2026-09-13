/**
 * The "N watching" count: distinct tab tokens seen in the last two buckets,
 * capped, bounded in storage, and never anything but a number.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUDIENCE_BUCKET_SECONDS,
  AUDIENCE_CAP,
  AudienceService,
  audienceKey,
  isWatchToken,
  type AudienceSetStore,
} from "../src/services/audience.js";
import { PgRedis } from "../src/pg-redis.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { assertTestDatabase, hasTestDatabase } from "./support/fixtures.js";

class FakeSets implements AudienceSetStore {
  sets = new Map<string, Set<string>>();
  writes = 0;
  async sadd(key: string, member: string) {
    this.writes++;
    const s = this.sets.get(key) ?? new Set<string>();
    this.sets.set(key, s);
    if (s.has(member)) return 0;
    s.add(member);
    return 1;
  }
  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }
  async expire() {
    return 1;
  }
  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) if (this.sets.delete(k)) n++;
    return n;
  }
}

const B = AUDIENCE_BUCKET_SECONDS * 1000;
const T0 = 1_000 * B; // start of a bucket

describe("audience heartbeats", () => {
  it("accepts only opaque token shapes", () => {
    expect(isWatchToken("abcdEFGH1234")).toBe(true);
    expect(isWatchToken("short")).toBe(false);
    expect(isWatchToken("has spaces in it here")).toBe(false);
    expect(isWatchToken("a@b.example.com-xxxx")).toBe(false);
    expect(isWatchToken(undefined)).toBe(false);
  });

  it("counts distinct tabs, not polls", async () => {
    const a = new AudienceService(new FakeSets());
    await a.heartbeat("w", "tab-aaaaaaaaaaaa", T0);
    await a.heartbeat("w", "tab-aaaaaaaaaaaa", T0 + 8_000);
    expect(await a.heartbeat("w", "tab-bbbbbbbbbbbb", T0 + 16_000)).toBe(2);
  });

  it("keeps a viewer across a bucket boundary and drops a closed tab after two buckets", async () => {
    const a = new AudienceService(new FakeSets());
    await a.heartbeat("w", "tab-closedclosed", T0 + B - 1_000);
    // Next bucket: the closed tab is still in the previous one.
    expect(await a.heartbeat("w", "tab-stayingstay", T0 + B + 1_000)).toBe(2);
    // Two buckets on, it is gone.
    expect(await a.heartbeat("w", "tab-stayingstay", T0 + 2 * B + 1_000)).toBe(1);
  });

  it("a read without a token counts but does not add", async () => {
    const a = new AudienceService(new FakeSets());
    await a.heartbeat("w", "tab-aaaaaaaaaaaa", T0);
    expect(await a.heartbeat("w", undefined, T0 + 1_000)).toBe(1);
    expect(await a.heartbeat("w", "nope", T0 + 1_000)).toBe(1);
  });

  it("deletes the bucket two back so storage stays bounded", async () => {
    const store = new FakeSets();
    const a = new AudienceService(store);
    await a.heartbeat("w", "tab-aaaaaaaaaaaa", T0);
    await a.heartbeat("w", "tab-aaaaaaaaaaaa", T0 + B);
    await a.heartbeat("w", "tab-aaaaaaaaaaaa", T0 + 2 * B);
    expect([...store.sets.keys()].sort()).toEqual(
      [audienceKey("w", 1001), audienceKey("w", 1002)].sort(),
    );
  });

  it("worlds are counted separately", async () => {
    const a = new AudienceService(new FakeSets());
    await a.heartbeat("w1", "tab-aaaaaaaaaaaa", T0);
    expect(await a.heartbeat("w2", "tab-bbbbbbbbbbbb", T0)).toBe(1);
  });

  it("stops accepting tokens at the cap", async () => {
    const store = new FakeSets();
    const a = new AudienceService(store);
    let n = 0;
    for (let i = 0; i < AUDIENCE_CAP + 20; i++) {
      n = (await a.heartbeat("w", `tok-${String(i).padStart(10, "0")}`, T0)) ?? -1;
    }
    expect(n).toBe(AUDIENCE_CAP);
    expect(store.sets.get(audienceKey("w", 1000))!.size).toBe(AUDIENCE_CAP);
  });

  it("never throws when the store fails", async () => {
    const broken: AudienceSetStore = {
      sadd: () => Promise.reject(new Error("down")),
      smembers: () => Promise.reject(new Error("down")),
      expire: () => Promise.reject(new Error("down")),
      del: () => Promise.reject(new Error("down")),
    };
    expect(await new AudienceService(broken).heartbeat("w", "tab-aaaaaaaaaaaa")).toBeNull();
  });
});

describe.skipIf(!hasTestDatabase())("audience heartbeats on the Postgres kv (REDIS_URL=pg)", () => {
  let config: ReturnType<typeof loadConfig>;
  let pool: ReturnType<typeof createPool>;
  const world = `audtest${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the audience suite");
    await migrate(config.databaseUrl);
    pool = createPool(config.databaseUrl);
  });

  afterAll(async () => {
    try {
      await pool.query("DELETE FROM grove_set WHERE key LIKE $1", [`audience:${world}:%`]);
    } finally {
      await pool.end();
    }
  });

  it("counts, expires and prunes through PgRedis", async () => {
    const bus = new PgRedis(pool, config.databaseUrl);
    const a = new AudienceService(bus);
    const now = Date.now();
    await a.heartbeat(world, "tab-aaaaaaaaaaaa", now);
    expect(await a.heartbeat(world, "tab-bbbbbbbbbbbb", now)).toBe(2);
    expect(await a.heartbeat(world, "tab-aaaaaaaaaaaa", now + 2 * B)).toBe(1);
    const { rows } = await pool.query<{ key: string; expires_at: Date | null }>(
      "SELECT key, expires_at FROM grove_set WHERE key LIKE $1",
      [`audience:${world}:%`],
    );
    expect(new Set(rows.map((r) => r.key)).size).toBe(1);
    expect(rows.every((r) => r.expires_at !== null)).toBe(true);
  });
});
