/**
 * Cards through the real routes: snake_case off the wire, a private space's card
 * answers 404 to everyone outside it, and only the owner writes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("cards routes suite");

describe.skipIf(!hasDb)("card routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the cards routes suite");
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

  it("keeps a private space's card behind its door and lets the owner write it", async () => {
    const owner = await signIn("cardown");
    const stranger = await signIn("cardnosy");
    const slug = `cards-${Math.random().toString(36).slice(2, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Card Harbour", slug, policy_preset: "private" },
    });
    expect(created.statusCode).toBe(201);
    const worldId = (created.json() as { world: { id: string } }).world.id;
    fixtures.trackWorld(worldId);

    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/worlds/${worldId}/card`,
      headers: { cookie: owner.cookie },
      payload: { working_on: "a lighthouse", links: [{ label: "Plans", url: "https://example.com/plans" }] },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { card: { card: { working_on: string } } }).card.card.working_on).toBe("a lighthouse");

    const mine = await app.inject({ method: "GET", url: `/api/v1/cards/spaces/${slug}`, headers: { cookie: owner.cookie } });
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as { card: { editable: string[] } }).card.editable).toContain("workingOn");

    const anon = await app.inject({ method: "GET", url: `/api/v1/cards/spaces/${slug}` });
    const nosy = await app.inject({ method: "GET", url: `/api/v1/cards/spaces/${worldId}`, headers: { cookie: stranger.cookie } });
    const nothing = await app.inject({ method: "GET", url: `/api/v1/cards/spaces/no-such-${slug}` });
    expect([anon.statusCode, nosy.statusCode, nothing.statusCode]).toEqual([404, 404, 404]);
    expect(anon.body).not.toContain("lighthouse");
    expect(nosy.json()).toEqual(nothing.json());

    const hijack = await app.inject({
      method: "PUT",
      url: `/api/v1/worlds/${worldId}/card`,
      headers: { cookie: stranger.cookie },
      payload: { working_on: "mine now" },
    });
    expect(hijack.statusCode).toBe(404);

    const self = await app.inject({
      method: "PUT",
      url: "/api/v1/humans/me/card",
      headers: { cookie: stranger.cookie },
      payload: { looking_for: "a harbour" },
    });
    expect(self.statusCode).toBe(200);
    const read = await app.inject({ method: "GET", url: `/api/v1/cards/humans/${stranger.handle}` });
    expect((read.json() as { card: { card: { looking_for: string }; editable: string[] } }).card).toMatchObject({
      card: { looking_for: "a harbour" },
      editable: [],
    });
    const unsigned = await app.inject({ method: "PUT", url: "/api/v1/humans/me/card", payload: { looking_for: "x" } });
    expect(unsigned.statusCode).toBe(401);
  });
});
