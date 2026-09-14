/**
 * Plot decor through the real routes (#45): signed-in only, owner-only (anyone
 * else 404), locked presets and bad slots get a reason, and the public minimap
 * carries the placed decor for a public plot and none for a private one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("decor routes suite");

describe.skipIf(!hasDb)("decor routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the decor routes suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    app = await buildApp(grove);
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      await app?.close();
      await redis.quit();
      await pg.end();
    }
  });

  async function signIn(tag: string) {
    const local = `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const magic = await app.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `${local}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await app.inject({ method: "POST", url: "/api/v1/humans/session/consume", payload: { token } });
    const raw = consumed.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    const human = (consumed.json() as { human: { id: string; handle: string } }).human;
    fixtures.trackHuman(human.id, cookie);
    return { cookie, id: human.id, handle: human.handle };
  }

  it("owner places decor; strangers 404; locked presets refused; private plots publish none", async () => {
    const owner = await signIn("decown");
    const stranger = await signIn("decnosy");
    const slug = `decor-${Math.random().toString(36).slice(2, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Decor Yard", slug, policy_preset: "public_write" },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; plot_index: number | null } }).world;
    fixtures.trackWorld(world.id);
    if (world.plot_index === null) {
      await pg.query(`UPDATE worlds SET plot_index = $2 WHERE id = $1`, [world.id, 110_000 + Math.floor(Math.random() * 20_000)]);
    }
    const url = `/api/v1/worlds/${world.id}/decor`;

    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: { cookie: stranger.cookie } })).statusCode).toBe(404);
    const strangerPut = await app.inject({ method: "PUT", url, headers: { cookie: stranger.cookie }, payload: { items: [] } });
    expect(strangerPut.statusCode).toBe(404);

    const got = await app.inject({ method: "GET", url, headers: { cookie: owner.cookie } });
    expect(got.statusCode).toBe(200);
    const cat = (got.json() as { decor: { catalogue: Array<{ preset: string; unlocked: boolean; hint: string | null }>; max_items: number } }).decor;
    expect(cat.max_items).toBe(6);
    expect(cat.catalogue.find((e) => e.preset === "telescope")).toMatchObject({ unlocked: false, hint: "earned by finishing a trial" });

    const locked = await app.inject({ method: "PUT", url, headers: { cookie: owner.cookie }, payload: { items: [{ preset: "telescope", slot: 1 }] } });
    expect(locked.statusCode).toBe(400);
    expect(locked.body).toMatch(/not unlocked/);
    const badSlot = await app.inject({ method: "PUT", url, headers: { cookie: owner.cookie }, payload: { items: [{ preset: "bench", slot: 99 }] } });
    expect(badSlot.statusCode).toBe(400);

    const put = await app.inject({
      method: "PUT",
      url,
      headers: { cookie: owner.cookie },
      payload: { items: [{ preset: "lamps", slot: 2 }, { preset: "planter", slot: 7 }] },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { decor: { items: unknown } }).decor.items).toEqual([
      { preset: "lamps", slot: 2 },
      { preset: "planter", slot: 7 },
    ]);

    const plot = async () =>
      ((await app.inject({ method: "GET", url: "/api/v1/world/minimap" })).json() as { spaces: Array<{ id: string; decor: unknown }> }).spaces.find(
        (s) => s.id === world.id,
      );
    expect((await plot())?.decor).toEqual([
      { preset: "lamps", slot: 2 },
      { preset: "planter", slot: 7 },
    ]);
    await pg.query(`UPDATE worlds SET policy_preset = 'private' WHERE id = $1`, [world.id]);
    const held = await plot();
    expect(held?.decor).toEqual([]);
    expect(JSON.stringify(held)).not.toMatch(/lamps|planter/);
  });
});
