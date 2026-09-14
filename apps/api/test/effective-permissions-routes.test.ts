/**
 * #62 through the real route: `GET /api/v1/agents/:id/effective-permissions`
 * is the owner's alone (everyone else gets the missing-agent 404), private
 * spaces appear only when the owner is a member, and each cell carries the
 * kernel's own attribution — the agent's setting, or which ceiling, members'
 * or visitors'.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import {
  REGISTER_IPS,
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  warnIfNotTestDatabase,
} from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("effective permissions routes suite");

type Verdict = { allowed: boolean; source?: string; membership?: string; ceiling_allows: boolean };
type Verdicts = Record<"speak_to_agents" | "speak_to_humans" | "listen_to_agents" | "listen_to_humans", Verdict>;
type Place = {
  id: string;
  slug: string | null;
  name: string | null;
  commons: boolean;
  is_member: boolean;
  here: boolean;
  member_policy: unknown;
  verdicts: Verdicts;
  rooms: Array<{ id: string; name: string; room_preset: string | null; here: boolean; verdicts: Verdicts }>;
};

describe.skipIf(!hasDb)("effective permissions route", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const t = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the effective permissions routes suite");
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

  async function space(owner: { cookie: string }, name: string, preset: string) {
    const slug = `ep-${name.toLowerCase().replace(/\W+/g, "-")}-${t}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: `${name} ${t}`, slug, policy_preset: preset },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; slug: string; name: string } }).world;
    fixtures.trackWorld(world.id);
    return world;
  }

  async function view(agentId: string, cookie?: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/effective-permissions`,
      headers: cookie ? { cookie } : {},
    });
  }

  const places = (res: { json: () => unknown }) =>
    (res.json() as { effective_permissions: { spaces: Place[] } }).effective_permissions.spaces;

  it("is the owner's alone, lists private spaces only through membership, and attributes every cell", async () => {
    const owner = await signIn("epown");
    const other = await signIn("epoth");

    await clearRegisterLimiter(redis, REGISTER_IPS.effectivePermissionsRoutes);
    const reg = await grove.identity.registerAgent({ name: `epagent${t}`, description: "fixture" }, REGISTER_IPS.effectivePermissionsRoutes);
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, { id: owner.id } as never);

    // The owner's private space: members are held to listen-only, and the Library is Watch only for visitors.
    const mine = await space(owner, "Study", "private");
    const listenOnly = { speak_to_agents: false, speak_to_humans: false, listen_to_agents: true, listen_to_humans: true };
    expect((await app.inject({ method: "PATCH", url: `/api/v1/worlds/${mine.id}`, headers: { cookie: owner.cookie }, payload: { member_policy: listenOnly } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/v1/worlds/${mine.id}/rooms/library`, headers: { cookie: owner.cookie }, payload: { room_preset: "public_view" } })).statusCode).toBe(200);

    // Someone else's spaces: a Watch-only one the agent walks into, and a private one it never sees.
    const theirView = await space(other, "Gallery", "public_view");
    const theirPrivate = await space(other, "Vault", "private");
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, `${theirView.id}:plaza`, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      worldId: theirView.id,
    });

    // Owner only: a stranger and a missing agent read the same; signed out is a 401.
    const stranger = await view(agent.id, other.cookie);
    const missing = await view(`agt_missing_${t}`, other.cookie);
    expect(stranger.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(stranger.body).toBe(missing.body);
    expect((await view(agent.id)).statusCode).toBe(401);

    const res = await view(agent.id, owner.cookie);
    expect(res.statusCode).toBe(200);
    const list = places(res);
    for (const leak of [theirPrivate.id, theirPrivate.slug, theirPrivate.name]) expect(res.body).not.toContain(leak);

    const commons = list.find((p) => p.commons)!;
    expect(commons.is_member).toBe(true);
    expect(Object.values(commons.verdicts).every((v) => v.allowed)).toBe(true);

    const study = list.find((p) => p.id === mine.id)!;
    expect(study).toMatchObject({ name: mine.name, is_member: true, here: false, member_policy: listenOnly });
    expect(study.verdicts.speak_to_humans).toEqual({ allowed: false, source: "space", membership: "member", ceiling_allows: false });
    expect(study.verdicts.listen_to_humans).toEqual({ allowed: true, ceiling_allows: true });
    // Only the room that differs is listed.
    expect(study.rooms.map((r) => r.id)).toEqual([`${mine.id}:library`]);

    const gallery = list.find((p) => p.id === theirView.id)!;
    expect(gallery).toMatchObject({ is_member: false, here: true });
    expect(gallery.verdicts.speak_to_agents).toMatchObject({ allowed: false, source: "space", membership: "non_member" });
    expect(gallery.rooms).toEqual([expect.objectContaining({ id: `${theirView.id}:plaza`, here: true })]);

    // The agent's own setting is named as the agent's, even where the ceiling also closes it.
    await grove.identity.patchPolicy(agent.id, { id: owner.id } as never, { listenToHumans: false });
    const after = places(await view(agent.id, owner.cookie));
    expect(after.find((p) => p.commons)!.verdicts.listen_to_humans).toEqual({ allowed: false, source: "actor", ceiling_allows: true });

    // A lobby on someone else's private plot: the room is named, the space is not.
    expect((await app.inject({ method: "PATCH", url: `/api/v1/worlds/${theirPrivate.id}/rooms/garden`, headers: { cookie: other.cookie }, payload: { room_preset: "public_write" } })).statusCode).toBe(200);
    await clearActorLimiters(redis, agent.id);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, `${theirPrivate.id}:garden`, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      worldId: theirPrivate.id,
    });
    const lobbyRes = await view(agent.id, owner.cookie);
    expect(lobbyRes.body).not.toContain(theirPrivate.slug);
    expect(lobbyRes.body).not.toContain(theirPrivate.name);
    const held = places(lobbyRes).find((p) => p.here)!;
    expect(held).toMatchObject({ name: null, slug: null, is_member: false });
    expect(held.rooms.map((r) => r.id)).toEqual([`${theirPrivate.id}:garden`]);
    expect(held.rooms[0]!.verdicts.speak_to_agents).toMatchObject({ allowed: true });
    expect(places(lobbyRes).some((p) => p.id === theirView.id)).toBe(false);
  });
});
