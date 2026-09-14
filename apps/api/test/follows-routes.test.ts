/**
 * Follows through the real routes: a private space's heart answers 404 to
 * everyone outside it (identical to no such space), follow/unfollow round-trip
 * with a count and never a list, and notices are a signed-in human's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("follows routes suite");

describe.skipIf(!hasDb)("follow routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the follows routes suite");
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

  it("follows and unfollows a space, and keeps a private one behind its door", async () => {
    const owner = await signIn("folown");
    const fan = await signIn("folfan");
    const slug = `follow-${Math.random().toString(36).slice(2, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Follow Harbour", slug, policy_preset: "private" },
    });
    expect(created.statusCode).toBe(201);
    const worldId = (created.json() as { world: { id: string } }).world.id;
    fixtures.trackWorld(worldId);

    const nosy = await app.inject({ method: "PUT", url: `/api/v1/follows/spaces/${slug}`, headers: { cookie: fan.cookie } });
    const peek = await app.inject({ method: "GET", url: `/api/v1/follows/spaces/${worldId}` });
    const nothing = await app.inject({ method: "GET", url: `/api/v1/follows/spaces/no-such-${slug}` });
    const unfollowPeek = await app.inject({
      method: "DELETE",
      url: `/api/v1/follows/spaces/${slug}`,
      headers: { cookie: fan.cookie, "content-type": "application/json" },
      payload: "{}",
    });
    expect([nosy.statusCode, peek.statusCode, nothing.statusCode, unfollowPeek.statusCode]).toEqual([404, 404, 404, 404]);
    expect(peek.json()).toEqual(nothing.json());
    expect(nosy.body + unfollowPeek.body).not.toContain("Follow Harbour");

    const open = await app.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${worldId}`,
      headers: { cookie: owner.cookie },
      payload: { policy_preset: "public_view" },
    });
    expect(open.statusCode).toBe(200);

    const put = await app.inject({ method: "PUT", url: `/api/v1/follows/spaces/${slug}`, headers: { cookie: fan.cookie } });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { follow: unknown }).follow).toMatchObject({ following: true, followers: 1, subject: "space" });
    const anon = await app.inject({ method: "GET", url: `/api/v1/follows/spaces/${slug}` });
    expect((anon.json() as { follow: unknown }).follow).toMatchObject({ following: false, followers: 1 });
    expect(anon.body).not.toContain(fan.handle);

    const mine = await app.inject({ method: "GET", url: "/api/v1/follows", headers: { cookie: fan.cookie } });
    expect((mine.json() as { follows: Array<{ slug: string }> }).follows.map((f) => f.slug)).toEqual([slug]);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/follows/spaces/${slug}`,
      headers: { cookie: fan.cookie, "content-type": "application/json" },
      payload: "{}",
    });
    expect((del.json() as { follow: unknown }).follow).toMatchObject({ following: false, followers: 0 });

    // Signed out, a follow is taken on a guest pass (guests-routes.test.ts); an unfollow with none is a 401.
    const unsigned = await app.inject({ method: "DELETE", url: `/api/v1/follows/spaces/${slug}`, headers: { "content-type": "application/json" }, payload: "{}" });
    expect(unsigned.statusCode).toBe(401);
  });

  it("answers many hearts at once, omitting private and unknown subjects alike, for people, guests and nobody", async () => {
    const owner = await signIn("folbatown");
    const fan = await signIn("folbatfan");
    const t = Math.random().toString(36).slice(2, 8);
    const make = async (slug: string, preset: string) => {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/worlds",
        headers: { cookie: owner.cookie },
        payload: { name: `Batch ${slug}`, slug, policy_preset: preset },
      });
      expect(created.statusCode).toBe(201);
      const id = (created.json() as { world: { id: string } }).world.id;
      fixtures.trackWorld(id);
      return id;
    };
    const open = `batch-open-${t}`;
    const shut = `batch-shut-${t}`;
    await make(open, "public_view");
    const shutId = await make(shut, "private");
    expect((await app.inject({ method: "PUT", url: `/api/v1/follows/spaces/${open}`, headers: { cookie: fan.cookie } })).statusCode).toBe(200);

    const q = (subjects: string) => `/api/v1/follows/state?subjects=${encodeURIComponent(subjects)}`;
    const asks = `space:${open},space:${shut},space:${shutId},space:no-such-${t},agent:nobody-${t},human:${fan.handle},junk`;

    // A signed-in outsider: the open space only. The private one is as absent as the missing one.
    const outsider = await app.inject({ method: "GET", url: q(asks), headers: { cookie: fan.cookie } });
    expect(outsider.statusCode).toBe(200);
    expect(outsider.json()).toEqual({ ok: true, states: { [`space:${open}`]: { following: true, followers: 1 } } });
    expect(outsider.body).not.toContain(shut);
    const privateAlone = await app.inject({ method: "GET", url: q(`space:${shutId}`), headers: { cookie: fan.cookie } });
    const missingAlone = await app.inject({ method: "GET", url: q(`space:no-such-${t}`), headers: { cookie: fan.cookie } });
    expect([privateAlone.statusCode, missingAlone.statusCode]).toEqual([200, 200]);
    expect(privateAlone.body).toBe(missingAlone.body);

    // A member sees the private space, by slug and by id, under the key it asked with.
    const member = await app.inject({ method: "GET", url: q(asks), headers: { cookie: owner.cookie } });
    expect((member.json() as { states: unknown }).states).toEqual({
      [`space:${open}`]: { following: false, followers: 1 },
      [`space:${shut}`]: { following: false, followers: 0 },
      [`space:${shutId}`]: { following: false, followers: 0 },
    });

    // Signed out: no error, nothing followed, public counts.
    const nobody = await app.inject({ method: "GET", url: q(asks) });
    expect(nobody.statusCode).toBe(200);
    expect((nobody.json() as { states: unknown }).states).toEqual({ [`space:${open}`]: { following: false, followers: 1 } });
    expect((await app.inject({ method: "GET", url: "/api/v1/follows/state" })).json()).toEqual({ ok: true, states: {} });

    // A guest pass (#32) sees its own follow, and still nothing private.
    const { guest, token } = await grove.guests.issue();
    try {
      await grove.follows.setFollow({ kind: "guest", guest }, "space", open, true);
      const asGuest = await app.inject({ method: "GET", url: q(asks), headers: { cookie: `grove_guest=${token}` } });
      expect((asGuest.json() as { states: unknown }).states).toEqual({ [`space:${open}`]: { following: true, followers: 2 } });
    } finally {
      await grove.guests.forget(guest.id);
    }

    // Limits: 50 subjects is fine, 51 is refused; the per-follower window refuses a loop.
    const fifty = Array.from({ length: 50 }, (_, i) => `space:n${i}-${t}`).join(",");
    expect((await app.inject({ method: "GET", url: q(fifty), headers: { cookie: fan.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: q(`${fifty},space:${open}`), headers: { cookie: fan.cookie } })).statusCode).toBe(400);
    const windowKey = `ratelimit:${fan.id}:follow_state:min`;
    await redis.set(windowKey, "120", "EX", 60);
    try {
      const limited = await app.inject({ method: "GET", url: q(`space:${open}`), headers: { cookie: fan.cookie } });
      expect(limited.statusCode).toBe(429);
    } finally {
      await redis.del(windowKey);
    }
  });

  it("serves a human their own notices and marks them read", async () => {
    const me = await signIn("folnote");
    const empty = await app.inject({ method: "GET", url: "/api/v1/follows/notices", headers: { cookie: me.cookie } });
    expect(empty.json()).toMatchObject({ items: [], unread: 0 });
    await pg.query(
      `INSERT INTO follow_notices (id, human_id, kind, subject_kind, subject_id, payload)
       VALUES ($1, $2, 'agent.error', 'agent', 'agt_x', $3)`,
      [`fnt_${Date.now()}`, me.id, JSON.stringify({ subject: { kind: "agent", slug: "x", name: "X" }, room_id: "plaza" })],
    );
    const one = await app.inject({ method: "GET", url: "/api/v1/follows/notices", headers: { cookie: me.cookie } });
    expect((one.json() as { unread: number }).unread).toBe(1);
    const seen = await app.inject({
      method: "POST",
      url: "/api/v1/follows/notices/seen",
      headers: { cookie: me.cookie },
      payload: {},
    });
    expect((seen.json() as { marked: number }).marked).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/v1/follows/notices" })).statusCode).toBe(401);
  });
});
