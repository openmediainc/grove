import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { HANDLE_MAX, sanitizeHandle, sanitizeHandleWithSuffix } from "../src/crypto.js";

// DBT-01. Writes real humans, so it refuses any database not named *_test:
// importing the domain package loads .env as a side effect, so a bare
// "is DATABASE_URL set?" guard would happily point at the live world.
const SUFFIX = "_test";
function dbName(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || null;
  } catch {
    return null;
  }
}
const isTestDb = (url: string) => Boolean(dbName(url)?.endsWith(SUFFIX));
const hasDb = isTestDb(process.env.DATABASE_URL ?? "");

describe("sanitizeHandleWithSuffix keeps the suffix the clip used to eat", () => {
  it("leaves a short handle's suffix exactly where it was", () => {
    expect(sanitizeHandleWithSuffix("bob", "_2")).toBe("bob_2");
    expect(sanitizeHandleWithSuffix("bob", "_2")).toBe(sanitizeHandle("bob_2"));
  });

  it("keeps the suffix on a local part at or over the clip length", () => {
    const long = "averyveryverylongname"; // 21 chars
    expect(sanitizeHandle(long)).toBe(sanitizeHandle(`${long}_2`)); // the bug, in one line
    const two = sanitizeHandleWithSuffix(long, "_2");
    const three = sanitizeHandleWithSuffix(long, "_3");
    expect(two).not.toBe(sanitizeHandle(long));
    expect(two).not.toBe(three);
    expect(two.endsWith("_2")).toBe(true);
    expect(two.length).toBeLessThanOrEqual(HANDLE_MAX);
  });
});

describe.skipIf(!hasDb)("signup survives a long email local part", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const madeHumans: string[] = [];

  const tag = () => Math.random().toString(36).slice(2, 10);

  async function signUp(email: string) {
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({
      email,
      inviteCode: "grove-alpha",
      ageAttested: true,
    });
    const { human } = await grove.identity.consumeMagicLink(token);
    madeHumans.push(human.id);
    return human;
  }

  beforeAll(async () => {
    const config = loadConfig();
    if (!isTestDb(config.databaseUrl)) throw new Error("refusing: not a _test database");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    if (madeHumans.length) {
      await pg.query("UPDATE invite_codes SET redeemed_by = NULL WHERE redeemed_by = ANY($1)", [madeHumans]);
      await pg.query("DELETE FROM presence WHERE actor_id = ANY($1)", [madeHumans]);
      await pg.query("DELETE FROM world_members WHERE human_id = ANY($1)", [madeHumans]);
      await pg.query("DELETE FROM humans WHERE id = ANY($1)", [madeHumans]);
    }
    await redis.quit();
    await pg.end();
  });

  it("resolves a collision between two local parts that clip to the same 20 characters", async () => {
    // Both local parts are longer than HANDLE_MAX and share their first 20
    // characters, so the second signup collides. Before the fix all eight
    // retries re-derived the first human's handle and the INSERT raised 23505.
    const stem = `longlocalpart${tag()}collides`;
    expect(stem.length).toBeGreaterThan(HANDLE_MAX);
    const first = await signUp(`${stem}-one@example.com`);
    const second = await signUp(`${stem}-two@example.com`);

    expect(first.handle).toBe(sanitizeHandle(stem));
    expect(second.handle).not.toBe(first.handle);
    expect(second.handle.length).toBeLessThanOrEqual(HANDLE_MAX);
    expect(second.handle.endsWith("_2")).toBe(true);

    // A third one keeps walking rather than reusing _2.
    const third = await signUp(`${stem}-three@example.com`);
    expect(third.handle).not.toBe(first.handle);
    expect(third.handle).not.toBe(second.handle);
  });

  it("does not change the handle a short email already gets", async () => {
    const local = `bob${tag()}`;
    expect(local.length).toBeLessThan(HANDLE_MAX);
    const first = await signUp(`${local}@example.com`);
    expect(first.handle).toBe(local);

    // Same local part, different domain: the retry path still yields `local_2`.
    const second = await signUp(`${local}@other.example.com`);
    expect(second.handle).toBe(`${local}_2`);
  });
});
