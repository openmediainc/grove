/**
 * Discovery on Explore (#40) through the real route: snake_case off the wire, a
 * short public cache header, and a private space absent for everyone, its own
 * owner included (the shelves are one public listing), while an open space with
 * activity is on Busiest plots and Just arrived.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { DISCOVERY_CACHE_KEY, GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("discovery routes suite");

describe.skipIf(!hasDb)("discovery route", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the discovery routes suite");
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
    return { cookie, id: human.id };
  }

  async function createSpace(owner: { cookie: string }, preset: string) {
    const slug = `dsr-${Math.random().toString(36).slice(2, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: `Discovery ${slug}`, slug, policy_preset: preset },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; slug: string } }).world;
    fixtures.trackWorld(world.id);
    return world;
  }

  it("serves one public listing to everyone, never naming a private space", async () => {
    const owner = await signIn("dsrown");
    const open = await createSpace(owner, "public_write");
    const shut = await createSpace(owner, "private");
    for (const w of [open, shut]) {
      await pg.query(
        `INSERT INTO speech (id, channel, sender_id, sender_kind, room_id, body, grapheme_count)
         VALUES ($1, 'room_say', $2, 'human', $3, 'hi', 2)`,
        [`sp_dsr_${Math.random().toString(36).slice(2, 10)}`, owner.id, `${w.id}:plaza`],
      );
    }
    await redis.del(DISCOVERY_CACHE_KEY);

    const anon = await app.inject({ method: "GET", url: "/api/v1/explore/discovery" });
    expect(anon.statusCode).toBe(200);
    expect(anon.headers["cache-control"]).toBe("public, max-age=30");
    const body = anon.json() as {
      discovery: {
        busiest_plots: Array<{ id: string; speakers: number; here_now: number }>;
        most_watched_agents: unknown[];
        just_arrived: Array<{ id: string; kind: string }>;
        generated_at: string;
        ttl_seconds: number;
      };
    };
    expect(body.discovery.ttl_seconds).toBe(60);
    expect(Array.isArray(body.discovery.most_watched_agents)).toBe(true);
    const text = anon.body;
    expect(text).not.toContain(shut.id);
    expect(text).not.toContain(shut.slug);

    const asOwner = await app.inject({ method: "GET", url: "/api/v1/explore/discovery", headers: { cookie: owner.cookie } });
    expect(asOwner.body).not.toContain(shut.id);
    // Same cached answer, whoever asks.
    expect((asOwner.json() as typeof body).discovery.generated_at).toBe(body.discovery.generated_at);

    // Busiest plots and Just arrived hold the open space (read past the page cap).
    expect((await grove.discovery.busiestPlots(100_000)).map((p) => p.id)).toContain(open.id);
    expect((await grove.discovery.justArrived(100_000)).map((p) => p.id)).toContain(open.id);
    await redis.del(DISCOVERY_CACHE_KEY);
  });
});
