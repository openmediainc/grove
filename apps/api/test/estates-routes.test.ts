/**
 * Estate names through the real routes (#37): signed-in only, an org's name is
 * its owner's to set (anyone else 404), bad names get a reason, and the public
 * minimap carries an `estates` list.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("estates routes suite");

describe.skipIf(!hasDb)("estates routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the estates routes suite");
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

  it("names your own estate and your org's; refuses strangers and bad names", async () => {
    const owner = await signIn("estown");
    const stranger = await signIn("estnosy");

    expect((await app.inject({ method: "GET", url: "/api/v1/estates/names" })).statusCode).toBe(401);

    const org = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers: { cookie: owner.cookie },
      payload: { name: `Estate Org ${Math.random().toString(36).slice(2, 6)}` },
    });
    expect(org.statusCode).toBe(201);
    const orgId = (org.json() as { org: { id: string } }).org.id;

    const own = await app.inject({
      method: "PUT",
      url: "/api/v1/estates/names",
      headers: { cookie: owner.cookie },
      payload: { estate_name: "Home Field" },
    });
    expect(own.statusCode).toBe(200);
    expect((own.json() as { names: { mine: string } }).names.mine).toBe("Home Field");

    const orgPut = await app.inject({
      method: "PUT",
      url: "/api/v1/estates/names",
      headers: { cookie: owner.cookie },
      payload: { estate_name: "The Keep", org_id: orgId },
    });
    expect(orgPut.statusCode).toBe(200);
    const names = (orgPut.json() as { names: { orgs: Array<{ id: string; estate_name: string | null }> } }).names;
    expect(names.orgs.find((o) => o.id === orgId)?.estate_name).toBe("The Keep");

    const hijack = await app.inject({
      method: "PUT",
      url: "/api/v1/estates/names",
      headers: { cookie: stranger.cookie },
      payload: { estate_name: "Mine", org_id: orgId },
    });
    expect(hijack.statusCode).toBe(404);

    const long = await app.inject({
      method: "PUT",
      url: "/api/v1/estates/names",
      headers: { cookie: owner.cookie },
      payload: { estate_name: "x".repeat(25) },
    });
    expect(long.statusCode).toBe(400);
    expect(long.body).toMatch(/at most 24/);

    const map = await app.inject({ method: "GET", url: "/api/v1/world/minimap" });
    expect(Array.isArray((map.json() as { estates?: unknown }).estates)).toBe(true);
  });
});
