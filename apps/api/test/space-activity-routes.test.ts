/**
 * One space's activity (`GET /api/v1/chronicle?world_id=`, the space page's
 * Activity tab): a private space answers 404 to everyone outside it, exactly
 * like a space that does not exist, and its members read it; a public space's
 * activity is readable signed out. Rows never leak across spaces.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("space activity routes suite");

describe.skipIf(!hasDb)("space activity route", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the space activity routes suite");
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

  it("keeps a private space's activity behind its door and filters to one space", async () => {
    const owner = await signIn("actown");
    const stranger = await signIn("actnosy");
    const t = Math.random().toString(36).slice(2, 8);
    const ids: Record<string, string> = {};
    for (const [slug, preset] of [
      [`act-hid-${t}`, "private"],
      [`act-open-${t}`, "public_view"],
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/worlds",
        headers: { cookie: owner.cookie },
        payload: { name: `Activity ${slug}`, slug, policy_preset: preset },
      });
      expect(created.statusCode).toBe(201);
      ids[preset] = (created.json() as { world: { id: string } }).world.id;
      fixtures.trackWorld(ids[preset]!);
    }
    const hidden = ids.private!;
    const open = ids.public_view!;
    await grove.presence.enter({ id: owner.id, kind: "human" }, `${open}:plaza`, {
      connection: "async",
      mode: "active",
      activity: "idle",
      worldId: open,
    });

    const get = (world: string, cookie?: string) =>
      app.inject({ method: "GET", url: `/api/v1/chronicle?world_id=${encodeURIComponent(world)}`, headers: cookie ? { cookie } : {} });

    const anon = await get(hidden);
    const nosy = await get(`act-hid-${t}`, stranger.cookie);
    const nothing = await get(`act-none-${t}`, stranger.cookie);
    expect([anon.statusCode, nosy.statusCode, nothing.statusCode]).toEqual([404, 404, 404]);
    expect(nosy.json()).toEqual(nothing.json());
    expect(nosy.body).not.toContain(`act-hid-${t}`);

    const mine = await get(hidden, owner.cookie);
    expect(mine.statusCode).toBe(200);

    type Page = { entries: Array<{ world_id: string; type: string; actor: { id: string } | null }> };
    const pub = await get(`act-open-${t}`);
    expect(pub.statusCode).toBe(200);
    const rows = (pub.json() as Page).entries;
    expect(rows.some((r) => r.type === "actor_joined_room" && r.actor?.id === owner.id)).toBe(true);
    expect(rows.every((r) => r.world_id === open)).toBe(true);
  });
});
