/**
 * Owner default theme per space through the real routes (#59): owner-only write
 * (anyone else 404), bad ids refused, the detail and the public minimap carry
 * it for a public plot, a private plot's default never reaches the minimap,
 * and only members of a private space learn it from the member list.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("space theme routes suite");

describe.skipIf(!hasDb)("space default theme routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the space theme routes suite");
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

  it("owner sets a default; strangers 404; private plots publish none; members learn theirs", async () => {
    const owner = await signIn("thmown");
    const stranger = await signIn("thmnosy");
    const member = await signIn("thmmem");
    const slug = `theme-${Math.random().toString(36).slice(2, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Theme Yard", slug, policy_preset: "public_write" },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; plot_index: number | null } }).world;
    fixtures.trackWorld(world.id);
    if (world.plot_index === null) {
      await pg.query(`UPDATE worlds SET plot_index = $2 WHERE id = $1`, [world.id, 130_000 + Math.floor(Math.random() * 20_000)]);
    }
    const plotIndex = Number((await pg.query(`SELECT plot_index FROM worlds WHERE id = $1`, [world.id])).rows[0].plot_index);
    const url = `/api/v1/worlds/${world.id}/default-theme`;

    expect((await app.inject({ method: "PUT", url, payload: { theme: "city" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url, headers: { cookie: stranger.cookie }, payload: { theme: "city" } })).statusCode).toBe(404);
    const bad = await app.inject({ method: "PUT", url, headers: { cookie: owner.cookie }, payload: { theme: "neon" } });
    expect(bad.statusCode).toBe(400);

    const put = await app.inject({ method: "PUT", url, headers: { cookie: owner.cookie }, payload: { theme: "space" } });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { default_theme: unknown }).default_theme).toBe("space");

    const detail = await app.inject({ method: "GET", url: `/api/v1/worlds/${world.id}` });
    expect((detail.json() as { default_theme: unknown }).default_theme).toBe("space");

    const plot = async () =>
      ((await app.inject({ method: "GET", url: "/api/v1/world/minimap" })).json() as { spaces: Array<{ id: string; default_theme?: unknown }> }).spaces.find(
        (s) => s.id === world.id,
      );
    expect((await plot())?.default_theme).toBe("space");

    // Public plots are already public: the member list is for private ones only.
    const ownList = async (cookie: string) =>
      ((await app.inject({ method: "GET", url: "/api/v1/world/member-default-themes", headers: { cookie } })).json() as {
        plots: Array<{ plot_index: number; default_theme: string }>;
      }).plots.filter((p) => p.plot_index === plotIndex);
    expect(await ownList(owner.cookie)).toEqual([]);

    await pg.query(`UPDATE worlds SET policy_preset = 'private' WHERE id = $1`, [world.id]);
    await pg.query(`INSERT INTO world_members (world_id, human_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [world.id, member.id]);
    const held = await plot();
    expect(held?.default_theme ?? null).toBeNull();
    expect(JSON.stringify(held)).not.toMatch(/"space"/);
    expect((await app.inject({ method: "GET", url: `/api/v1/worlds/${world.id}`, headers: { cookie: stranger.cookie } })).statusCode).toBe(404);

    expect((await app.inject({ method: "GET", url: "/api/v1/world/member-default-themes" })).statusCode).toBe(401);
    expect(await ownList(stranger.cookie)).toEqual([]);
    expect(await ownList(owner.cookie)).toEqual([{ plot_index: plotIndex, default_theme: "space" }]);
    expect(await ownList(member.cookie)).toEqual([{ plot_index: plotIndex, default_theme: "space" }]);

    const cleared = await app.inject({ method: "PUT", url, headers: { cookie: owner.cookie }, payload: { theme: null } });
    expect((cleared.json() as { default_theme: unknown }).default_theme).toBeNull();
    expect(await ownList(member.cookie)).toEqual([]);
  });
});
