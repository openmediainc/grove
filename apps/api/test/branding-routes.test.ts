/**
 * Branding through the real routes: snake_case off the wire, owner-only writes,
 * plain refusal messages, and a private space's branding answers 404 outside it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("branding routes suite");

describe.skipIf(!hasDb)("branding routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the branding routes suite");
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

  it("owner sets branding; outsiders of a private space get 404; bad colours get a reason", async () => {
    const owner = await signIn("brandown");
    const stranger = await signIn("brandnosy");
    const slug = `brand-${Math.random().toString(36).slice(2, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Brand Harbour", slug, policy_preset: "private" },
    });
    expect(created.statusCode).toBe(201);
    const worldId = (created.json() as { world: { id: string } }).world.id;
    fixtures.trackWorld(worldId);

    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/worlds/${worldId}/branding`,
      headers: { cookie: owner.cookie },
      payload: { accent: "violet", sign_text: "Harbour lights", emblem: "anchor" },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { branding: unknown }).branding).toEqual({ accent: "#c4b5fd", sign_text: "Harbour lights", emblem: "anchor" });

    const detail = await app.inject({ method: "GET", url: `/api/v1/worlds/${slug}`, headers: { cookie: owner.cookie } });
    expect((detail.json() as { branding: { emblem: string } }).branding.emblem).toBe("anchor");

    const dark = await app.inject({
      method: "PUT",
      url: `/api/v1/worlds/${worldId}/branding`,
      headers: { cookie: owner.cookie },
      payload: { accent: "#222222" },
    });
    expect(dark.statusCode).toBe(400);
    expect(dark.body).toMatch(/too dark to read/);

    const anon = await app.inject({ method: "GET", url: `/api/v1/worlds/${slug}/branding` });
    const nosy = await app.inject({ method: "GET", url: `/api/v1/worlds/${worldId}/branding`, headers: { cookie: stranger.cookie } });
    expect([anon.statusCode, nosy.statusCode]).toEqual([404, 404]);
    expect(anon.body).not.toContain("anchor");

    const hijack = await app.inject({
      method: "PUT",
      url: `/api/v1/worlds/${worldId}/branding`,
      headers: { cookie: stranger.cookie },
      payload: { emblem: "star" },
    });
    expect(hijack.statusCode).toBe(404);
    const unsigned = await app.inject({ method: "PUT", url: `/api/v1/worlds/${worldId}/branding`, payload: { emblem: "star" } });
    expect(unsigned.statusCode).toBe(401);
  });
});
