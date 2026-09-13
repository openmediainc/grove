/**
 * Guest passes through the real routes (queue #32): a cookie is issued only by
 * a reaction or a follow that succeeds, never by a page view, a read or a
 * refusal; a guest can do nothing else; signing in merges it into the person.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, guestIdForToken, guestIpBucket, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("guest routes suite");

function cookiesOf(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
}

function guestCookie(res: { headers: Record<string, unknown> }): string | null {
  const c = cookiesOf(res).find((v) => v.startsWith("grove_guest="));
  if (!c) return null;
  const value = c.split(";")[0]!.slice("grove_guest=".length);
  return value ? c : null;
}

describe.skipIf(!hasDb)("guest pass routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const guestIds: string[] = [];
  const tag = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the guest routes suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    app = await buildApp(grove);
  });

  afterAll(async () => {
    try {
      for (const id of guestIds) await grove.guests.forget(id);
      await fixtures.cleanup();
    } finally {
      await app?.close();
      await redis.quit();
      await pg.end();
    }
  });

  /** inject() arrives from 127.0.0.1; clear that network's issue and act windows between steps. */
  async function clearGuestLimits() {
    const b = guestIpBucket("127.0.0.1");
    for (const key of await redis.keys(`ratelimit:guestip:${b}:*`)) await redis.del(key);
  }

  function track(setCookie: string): string {
    const token = setCookie.split(";")[0]!.slice("grove_guest=".length);
    const id = guestIdForToken(decodeURIComponent(token));
    guestIds.push(id);
    return `grove_guest=${token}`;
  }

  async function signIn(tagName: string, extraCookie?: string) {
    const local = `${tagName}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const magic = await app.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `${local}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await app.inject({
      method: "POST",
      url: "/api/v1/humans/session/consume",
      payload: { token },
      ...(extraCookie ? { headers: { cookie: extraCookie } } : {}),
    });
    const session = cookiesOf(consumed).find((c) => c.startsWith("grove_session=")) ?? "";
    const human = (consumed.json() as { human: { id: string; handle: string } }).human;
    fixtures.trackHuman(human.id, session);
    return { cookie: session.split(";")[0]!, id: human.id, consumed };
  }

  async function arrivalOf(humanId: string): Promise<string> {
    const { rows } = await pg.query(
      `SELECT id FROM world_events WHERE type = 'actor_registered' AND actor_id = $1 ORDER BY id DESC LIMIT 1`,
      [humanId],
    );
    return String((rows[0] as { id: string }).id);
  }

  it("issues a guest only on a reaction that lands, and never on a read or a refusal", async () => {
    await clearGuestLimits();
    const newcomer = await signIn("gstrx");
    const eventId = await arrivalOf(newcomer.id);

    const views = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/chronicle" }),
      app.inject({ method: "GET", url: "/api/v1/world/minimap" }),
      app.inject({ method: "GET", url: "/api/v1/guest" }),
    ]);
    for (const v of views) expect(guestCookie(v)).toBeNull();
    expect(views[2]!.statusCode).toBe(401);

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/reactions",
      payload: { target_kind: "event", target_id: "999999999999", emoji: "up" },
    });
    expect(missing.statusCode).toBe(404);
    expect(guestCookie(missing)).toBeNull();

    const removeWithout = await app.inject({
      method: "POST",
      url: "/api/v1/reactions",
      payload: { target_kind: "event", target_id: eventId, emoji: "up", on: false },
    });
    expect(removeWithout.statusCode).toBe(401);

    const badKey = await app.inject({
      method: "POST",
      url: "/api/v1/reactions",
      headers: { authorization: "Bearer aeth_live_nope" },
      payload: { target_kind: "event", target_id: eventId, emoji: "up" },
    });
    expect(badKey.statusCode).toBe(401);
    expect(guestCookie(badKey)).toBeNull();

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/reactions",
      payload: { target_kind: "event", target_id: eventId, emoji: "party" },
    });
    expect(ok.statusCode).toBe(200);
    const set = guestCookie(ok);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(cookiesOf(ok).some((c) => c.startsWith("grove_guest_hint=1"))).toBe(true);
    expect(ok.json()).toMatchObject({ as_guest: true, reaction: { summary: { counts: { party: 1 }, mine: ["party"] } } });
    const cookie = track(set!);

    // The chronicle shows the guest its own reaction.
    const page = await app.inject({ method: "GET", url: `/api/v1/chronicle?types=actor_registered&limit=100`, headers: { cookie } });
    const entry = (page.json() as { entries: Array<{ id: string; reactions: { mine: string[] } | null }> }).entries.find(
      (e) => e.id === eventId,
    );
    expect(entry?.reactions?.mine).toEqual(["party"]);
  });

  it("lets a guest follow public things only, and nothing but react and follow", async () => {
    await clearGuestLimits();
    const owner = await signIn("gstown");
    const open = `gopen-${tag()}`;
    const shut = `gshut-${tag()}`;
    for (const [slug, preset] of [
      [open, "public_view"],
      [shut, "private"],
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/worlds",
        headers: { cookie: owner.cookie },
        payload: { name: `Guest ${slug}`, slug, policy_preset: preset },
      });
      expect(created.statusCode).toBe(201);
      fixtures.trackWorld((created.json() as { world: { id: string } }).world.id);
    }

    const privateTry = await app.inject({ method: "PUT", url: `/api/v1/follows/spaces/${shut}` });
    expect(privateTry.statusCode).toBe(404);
    expect(guestCookie(privateTry)).toBeNull();

    const follow = await app.inject({ method: "PUT", url: `/api/v1/follows/spaces/${open}` });
    expect(follow.statusCode).toBe(200);
    expect(follow.json()).toMatchObject({ as_guest: true, follow: { following: true, followers: 1 } });
    const cookie = track(guestCookie(follow)!);

    const state = await app.inject({ method: "GET", url: `/api/v1/follows/spaces/${open}`, headers: { cookie } });
    expect((state.json() as { follow: unknown }).follow).toMatchObject({ following: true });
    const mine = await app.inject({ method: "GET", url: "/api/v1/guest", headers: { cookie } });
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as { guest: { follows: Array<{ slug: string }> } }).guest.follows.map((f) => f.slug)).toEqual([open]);

    // Everything else answers as it does to anyone signed out.
    const refused = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/say", headers: { cookie }, payload: { channel: "room_say", body: "hi", idempotency_key: `g-${tag()}` } }),
      app.inject({ method: "POST", url: "/api/v1/messages", headers: { cookie }, payload: { to: owner.id, body: "hi" } }),
      app.inject({ method: "POST", url: "/api/v1/worlds", headers: { cookie }, payload: { name: "Nope", slug: `nope-${tag()}` } }),
      app.inject({ method: "GET", url: "/api/v1/follows/notices", headers: { cookie } }),
      app.inject({ method: "GET", url: "/api/v1/humans/me", headers: { cookie } }),
    ]);
    expect(refused.map((r) => r.statusCode)).toEqual([401, 401, 401, 401, 401]);

    // Forget this browser: the guest and its follow are gone.
    const forget = await app.inject({ method: "DELETE", url: "/api/v1/guest", headers: { cookie } });
    expect(forget.json()).toMatchObject({ forgotten: true });
    const after = await app.inject({ method: "GET", url: `/api/v1/follows/spaces/${open}` });
    expect((after.json() as { follow: unknown }).follow).toMatchObject({ followers: 0 });
    expect((await app.inject({ method: "GET", url: "/api/v1/guest", headers: { cookie } })).statusCode).toBe(401);
  });

  it("merges the guest into the person who signs in from that browser, and clears the cookie", async () => {
    await clearGuestLimits();
    const owner = await signIn("gstmown");
    const slug = `gmerge-${tag()}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: `Merge ${slug}`, slug, policy_preset: "public_view" },
    });
    fixtures.trackWorld((created.json() as { world: { id: string } }).world.id);
    const eventId = await arrivalOf(owner.id);

    const follow = await app.inject({ method: "PUT", url: `/api/v1/follows/spaces/${slug}` });
    const cookie = track(guestCookie(follow)!);
    const react = await app.inject({
      method: "POST",
      url: "/api/v1/reactions",
      headers: { cookie },
      payload: { target_kind: "event", target_id: eventId, emoji: "heart" },
    });
    expect(react.statusCode).toBe(200);
    // An existing guest is not issued a second time.
    expect(guestCookie(react)).toContain(cookie);

    const person = await signIn("gstmerge", cookie);
    const cleared = cookiesOf(person.consumed).find((c) => c.startsWith("grove_guest="));
    expect(cleared).toMatch(/^grove_guest=;/);

    const mine = await app.inject({ method: "GET", url: "/api/v1/follows", headers: { cookie: person.cookie } });
    expect((mine.json() as { follows: Array<{ slug: string }> }).follows.map((f) => f.slug)).toEqual([slug]);
    const page = await app.inject({ method: "GET", url: `/api/v1/chronicle?types=actor_registered&limit=100`, headers: { cookie: person.cookie } });
    const entry = (page.json() as { entries: Array<{ id: string; reactions: { counts: Record<string, number>; mine: string[] } | null }> }).entries.find(
      (e) => e.id === eventId,
    );
    expect(entry?.reactions).toEqual({ counts: { heart: 1 }, mine: ["heart"] });
    expect((await app.inject({ method: "GET", url: "/api/v1/guest", headers: { cookie } })).statusCode).toBe(401);
  });
});
