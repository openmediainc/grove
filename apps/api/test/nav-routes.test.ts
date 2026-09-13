/**
 * What the nav leans on (UX-1): Sign out really ends the session, /humans/me
 * carries the role the Mod link keys off, and the chronicle's shareable
 * `?actor=` filter resolves a handle or slug without leaking who exists or who
 * moderated.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("nav routes suite");

describe.skipIf(!hasDb)("nav routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the nav routes suite");
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
    return { cookie: cookie.split(";")[0] ?? "", id: human.id, handle: human.handle };
  }

  type Page = { entries: Array<{ type: string; actor: { id: string } | null }> };

  it("signs out: the session key is gone, the cookies are cleared, /humans/me is 401", async () => {
    const ada = await signIn("navout");
    const me = await app.inject({ method: "GET", url: "/api/v1/humans/me", headers: { cookie: ada.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ human: { id: ada.id, role: expect.any(String) } });

    const out = await app.inject({ method: "POST", url: "/api/v1/humans/logout", headers: { cookie: ada.cookie }, payload: {} });
    expect(out.statusCode).toBe(200);
    const set = String(out.headers["set-cookie"] ?? "");
    expect(set).toMatch(/grove_signed_in=;/);

    const after = await app.inject({ method: "GET", url: "/api/v1/humans/me", headers: { cookie: ada.cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("filters the chronicle by @handle, slug or id; nobody filters to nothing", async () => {
    const ada = await signIn("navchra");
    const bo = await signIn("navchrb");

    const get = async (q: string, cookie?: string) => {
      const r = await app.inject({ method: "GET", url: `/api/v1/chronicle?limit=50&${q}`, headers: cookie ? { cookie } : {} });
      expect(r.statusCode).toBe(200);
      return r.json() as Page;
    };

    const byHandle = await get(`actor=${encodeURIComponent(`@${ada.handle}`)}`);
    expect(byHandle.entries.length).toBeGreaterThan(0);
    expect(byHandle.entries.every((e) => e.actor?.id === ada.id)).toBe(true);

    const byId = await get(`actor=${ada.id}`);
    expect(byId.entries.map((e) => e.actor?.id)).toEqual(byHandle.entries.map((e) => e.actor?.id));

    expect((await get(`actor=${encodeURIComponent(`@nobody${Date.now()}`)}`)).entries).toEqual([]);
    expect((await get(`actor=no-such-agent-${Date.now()}`)).entries).toEqual([]);

    // A warning ada (as moderator) gave bo: bo is owed the row, never the name
    // of who gave it — so filtering by ada must not surface it for bo.
    await pg.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ('mod.warn', $1, $2)`, [
      ada.id,
      JSON.stringify({ targetId: bo.id, reason: "nav test" }),
    ]);
    const boSees = await get("", bo.cookie);
    expect(boSees.entries.some((e) => e.type === "mod.warn")).toBe(true);
    const boFiltered = await get(`actor=${encodeURIComponent(`@${ada.handle}`)}`, bo.cookie);
    expect(boFiltered.entries.some((e) => e.type === "mod.warn")).toBe(false);
  });
});
