/**
 * Search through the real route: snake_case off the wire, a private space is
 * absent for anyone outside it (signed out or a stranger) and present for its
 * owner, and the online list rides along with no query.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("search routes suite");

describe.skipIf(!hasDb)("search route", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the search routes suite");
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

  it("finds public things for anyone and a private space only for those inside", async () => {
    const owner = await signIn("srchown");
    const stranger = await signIn("srchnosy");
    const t = Math.random().toString(36).slice(2, 8);
    const hidden = `srch-hid-${t}`;
    const open = `srch-open-${t}`;
    for (const [slug, preset] of [
      [hidden, "private"],
      [open, "public_write"],
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/worlds",
        headers: { cookie: owner.cookie },
        payload: { name: `Search ${slug}`, slug, policy_preset: preset },
      });
      expect(created.statusCode).toBe(201);
      fixtures.trackWorld((created.json() as { world: { id: string } }).world.id);
    }

    type Res = { ok: boolean; query: string; spaces: Array<{ slug: string; is_member: boolean }>; online: unknown[]; agents: unknown[] };
    const anon = await app.inject({ method: "GET", url: `/api/v1/search?q=${encodeURIComponent(`srch-hid-${t}`)}` });
    const nosy = await app.inject({ method: "GET", url: `/api/v1/search?q=${encodeURIComponent(`srch-hid-${t}`)}`, headers: { cookie: stranger.cookie } });
    const mine = await app.inject({ method: "GET", url: `/api/v1/search?q=${encodeURIComponent(`srch-hid-${t}`)}`, headers: { cookie: owner.cookie } });
    expect([anon.statusCode, nosy.statusCode, mine.statusCode]).toEqual([200, 200, 200]);
    expect((anon.json() as Res).spaces).toEqual([]);
    expect((nosy.json() as Res).spaces).toEqual([]);
    expect(anon.body).not.toContain(hidden);
    expect(nosy.body).not.toContain(hidden);
    expect((mine.json() as Res).spaces).toEqual([expect.objectContaining({ slug: hidden, is_member: true })]);

    const pub = await app.inject({ method: "GET", url: `/api/v1/search?q=${encodeURIComponent(open)}` });
    expect((pub.json() as Res).spaces.map((s) => s.slug)).toEqual([open]);

    const empty = await app.inject({ method: "GET", url: "/api/v1/search" });
    expect(empty.statusCode).toBe(200);
    const e = empty.json() as Res;
    expect(e).toMatchObject({ ok: true, query: "", agents: [], spaces: [] });
    expect(Array.isArray(e.online)).toBe(true);
  });
});
