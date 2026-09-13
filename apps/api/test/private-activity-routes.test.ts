/**
 * Queue #50 through the real routes: what happens inside a private space never
 * reaches a signed-out visitor, a guest pass or a signed-in stranger — not via
 * the unfiltered chronicle, a space's activity, replay, the AWN agent list or
 * someone else's lounge — and a member reads it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, guestIdForToken, guestIpBucket, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, clearRegisterLimiter, createFixtures, hasTestDatabase, REGISTER_IPS, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("private activity routes suite");

describe.skipIf(!hasDb)("private activity routes", { timeout: 60_000 }, () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const guestIds: string[] = [];
  const tag = () => Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the private activity routes suite");
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

  async function signIn(tagName: string) {
    const local = `${tagName}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const magic = await app.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `${local}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await app.inject({ method: "POST", url: "/api/v1/humans/session/consume", payload: { token } });
    const raw = consumed.headers["set-cookie"];
    const all = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    const cookie = (all.find((c) => c.startsWith("grove_session=")) ?? "").split(";")[0]!;
    const human = (consumed.json() as { human: { id: string; handle: string } }).human;
    fixtures.trackHuman(human.id, cookie);
    return { cookie, id: human.id };
  }

  /** A guest pass, issued the only way one is: by following something public. */
  async function guestCookie(publicSlug: string): Promise<string> {
    const b = guestIpBucket("127.0.0.1");
    for (const key of await redis.keys(`ratelimit:guestip:${b}:*`)) await redis.del(key);
    const res = await app.inject({ method: "PUT", url: `/api/v1/follows/spaces/${publicSlug}` });
    expect(res.statusCode).toBe(200);
    const raw = res.headers["set-cookie"];
    const set = (Array.isArray(raw) ? raw : [raw]).map(String).find((c) => c.startsWith("grove_guest="))!;
    const token = set.split(";")[0]!.slice("grove_guest=".length);
    guestIds.push(guestIdForToken(decodeURIComponent(token)));
    return `grove_guest=${token}`;
  }

  it("gives outsiders nothing from a private space on any route, and members everything", async () => {
    const owner = await signIn("paown");
    const stranger = await signIn("panosy");
    const t = tag();
    const worlds: Record<string, { id: string; slug: string }> = {};
    for (const [slug, preset] of [
      [`pa-shut-${t}`, "private"],
      [`pa-open-${t}`, "public_view"],
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/worlds",
        headers: { cookie: owner.cookie },
        payload: { name: `Activity ${slug}`, slug, policy_preset: preset },
      });
      expect(created.statusCode).toBe(201);
      const id = (created.json() as { world: { id: string } }).world.id;
      fixtures.trackWorld(id);
      worlds[preset] = { id, slug };
    }
    const shut = worlds.private!;

    // An agent at work inside the private space, and a notice-typed row naming its room.
    await clearRegisterLimiter(redis, REGISTER_IPS.privateActivityRoutes);
    const reg = await grove.identity.registerAgent({ name: `paagent${t}`, description: "fixture" }, REGISTER_IPS.privateActivityRoutes);
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, { id: owner.id } as never);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, `${shut.id}:plaza`, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      worldId: shut.id,
    });
    const secret = `inside words ${t}`;
    await grove.identity.audit("notice", owner.id, { title: secret, roomId: `${shut.id}:plaza` });
    const { rows } = await pg.query(
      `SELECT id FROM world_events WHERE actor_id = ANY($1::text[]) AND type IN ('notice','actor_joined_room') ORDER BY id DESC LIMIT 2`,
      [[owner.id, agent.id]],
    );
    const privateIds = rows.map((r) => String((r as { id: string }).id));
    expect(privateIds).toHaveLength(2);

    const guest = await guestCookie(worlds.public_view!.slug);
    const outsiders: Array<[string, Record<string, string>]> = [
      ["signed out", {}],
      ["guest", { cookie: guest }],
      ["stranger", { cookie: stranger.cookie }],
    ];
    const since = encodeURIComponent(new Date(Date.now() - 5 * 60_000).toISOString());
    const until = encodeURIComponent(new Date(Date.now() + 5_000).toISOString());
    type Page = { entries: Array<{ id: string }> };

    for (const [who, headers] of outsiders) {
      const all = await app.inject({ method: "GET", url: `/api/v1/chronicle?limit=200&since=${since}`, headers });
      expect(all.statusCode, who).toBe(200);
      const ids = (all.json() as Page).entries.map((e) => e.id);
      for (const id of privateIds) expect(ids, who).not.toContain(id);
      expect(all.body, who).not.toContain(secret);
      expect(all.body, who).not.toContain(shut.id);

      const scoped = await app.inject({ method: "GET", url: `/api/v1/chronicle?world_id=${shut.slug}`, headers });
      expect(scoped.statusCode, who).toBe(404);

      const replay = await app.inject({
        method: "GET",
        url: `/api/v1/replay?since=${since}&until=${until}`,
        headers: { ...headers, "x-grove-world": shut.id },
      });
      expect([403, 404], who).toContain(replay.statusCode);
      expect(replay.body, who).not.toContain(secret);
    }

    // The AWN agent list is unauthenticated: no room, no activity inside the door.
    const listed = await app.inject({ method: "GET", url: "/world/agents" });
    const row = (listed.json() as { agents: Array<{ id: string; room_id: string | null; activity: string | null }> }).agents.find(
      (a) => a.id === agent.id,
    );
    if (row) {
      expect(row.room_id).toBeNull();
      expect(row.activity).toBeNull();
    }
    expect(listed.body).not.toContain(shut.id);

    // Someone else's lounge answers like a room that does not exist.
    const lounge = await app.inject({ method: "POST", url: `/api/v1/rooms/lounge_${owner.id}/enter`, headers: { cookie: stranger.cookie } });
    expect(lounge.statusCode).toBe(404);

    // The member reads all of it.
    const mine = await app.inject({ method: "GET", url: `/api/v1/chronicle?limit=200&since=${since}`, headers: { cookie: owner.cookie } });
    const mineIds = (mine.json() as Page).entries.map((e) => e.id);
    for (const id of privateIds) expect(mineIds).toContain(id);
    const scopedMine = await app.inject({ method: "GET", url: `/api/v1/chronicle?world_id=${shut.slug}`, headers: { cookie: owner.cookie } });
    expect(scopedMine.statusCode).toBe(200);
    expect(scopedMine.body).toContain(secret);
  });
});
