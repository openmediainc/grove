import { afterAll, afterEach, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

/**
 * SPC-07 / SPC-10 over HTTP: the owner route, lobby admission for a non-member,
 * and the 404-not-403 existence rule. A visitor may reach exactly the room the
 * owner opened; every other room of the space — closed or nonexistent — answers
 * with the byte-identical refusal a non-member always got.
 */
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("room policy routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let grove: GroveApp | undefined;
  let redis: Redis | undefined;
  let pg: ReturnType<typeof createPool> | undefined;

  async function boot() {
    if (app) return app;
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run room policy route tests");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    app = await buildApp(grove);
    return app;
  }

  const fixtures = createFixtures(() => grove?.store);
  afterEach(async () => {
    await fixtures.cleanup();
  });
  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await pg?.end();
  });

  async function signIn(tag: string) {
    const server = await boot();
    const local = `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const magic = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `${local}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    expect(magic.statusCode).toBe(200);
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await server.inject({ method: "POST", url: "/api/v1/humans/session/consume", payload: { token } });
    expect(consumed.statusCode).toBe(200);
    const raw = consumed.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    const human = (consumed.json() as { human: { id: string; handle: string } }).human;
    fixtures.trackHuman(human.id, cookie);
    return { cookie, id: human.id, handle: human.handle };
  }

  async function spaceWith(owner: { cookie: string }, preset: "private" | "public_view" | "public_write") {
    const server = await boot();
    const slug = `grove-pub-${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: `Public ${slug}`, slug, policy_preset: preset },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string } }).world;
    fixtures.trackWorld(world.id);
    return world;
  }

  async function privateSpace(owner: { cookie: string }) {
    const server = await boot();
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: `Lobby Plot ${Date.now()}`, slug: `grove-lobby-${Date.now()}`, policy_preset: "private" },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; slug: string; name: string } }).world;
    fixtures.trackWorld(world.id);
    return world;
  }

  it("an owner opens one room; a visitor reaches it and nothing else, and closed == missing", async () => {
    const server = await boot();
    const owner = await signIn("rpo");
    const visitor = await signIn("rpv");
    const world = await privateSpace(owner);
    const as = (cookie: string) => ({ cookie, "x-grove-world": world.id });

    // Before: the lobby is as closed as every other room.
    expect((await server.inject({ method: "GET", url: "/api/v1/rooms/garden", headers: as(visitor.cookie) })).statusCode).toBe(403);

    const opened = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}/rooms/garden`,
      headers: { cookie: owner.cookie },
      payload: { room_preset: "public_view" },
    });
    expect(opened.statusCode).toBe(200);
    const body = opened.json() as { room: { room_preset: string; admits_non_members: boolean }; evicted: string[] };
    expect(body.room.room_preset).toBe("public_view");
    expect(body.room.admits_non_members).toBe(true);

    // The lobby answers the visitor.
    const lobby = await server.inject({ method: "GET", url: "/api/v1/rooms/garden", headers: as(visitor.cookie) });
    expect(lobby.statusCode).toBe(200);
    expect((lobby.json() as { room: { id: string } }).room.id).toBe(`${world.id}:garden`);
    expect((await server.inject({ method: "GET", url: "/api/v1/rooms/garden/transcript", headers: as(visitor.cookie) })).statusCode).toBe(200);

    // A closed room and a room that does not exist are indistinguishable.
    const closed = await server.inject({ method: "GET", url: "/api/v1/rooms/library", headers: as(visitor.cookie) });
    const missing = await server.inject({ method: "GET", url: "/api/v1/rooms/no-such-room", headers: as(visitor.cookie) });
    expect(closed.statusCode).toBe(403);
    expect(missing.statusCode).toBe(closed.statusCode);
    expect(missing.body).toBe(closed.body);
    // And the space as a whole stays shut: minimap, world, detail.
    expect((await server.inject({ method: "GET", url: "/api/v1/world/minimap", headers: as(visitor.cookie) })).statusCode).toBe(403);
    expect((await server.inject({ method: "GET", url: `/api/v1/worlds/${world.id}`, headers: { cookie: visitor.cookie } })).statusCode).toBe(404);

    // Walk in through the lobby door, and only that door.
    const walked = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/enter`,
      headers: { cookie: visitor.cookie },
      payload: { room: "garden" },
    });
    expect(walked.statusCode).toBe(200);
    expect((walked.json() as { room: { id: string } }).room.id).toBe(`${world.id}:garden`);
    expect(await grove!.campus.isMember(world.id, visitor.id)).toBe(false);
    const plaza = await server.inject({ method: "POST", url: `/api/v1/worlds/${world.id}/enter`, headers: { cookie: visitor.cookie }, payload: {} });
    expect(plaza.statusCode).toBe(403);
    const moved = await server.inject({ method: "POST", url: "/api/v1/rooms/library/enter", headers: as(visitor.cookie) });
    expect(moved.statusCode).toBe(403);

    // Speaking in a public_view lobby: refused, and the ROOM is named for non-members.
    const said = await server.inject({
      method: "POST",
      url: "/api/v1/say",
      headers: { ...as(visitor.cookie), "idempotency-key": `rp-${Date.now()}` },
      payload: { channel: "room_say", body: "hello lobby" },
    });
    expect(said.statusCode).toBe(403);
    expect((said.json() as { error: Record<string, unknown> }).error).toMatchObject({
      code: "PERMISSION_DENIED",
      source: "room",
      membership: "non_member",
    });

    // The public directory names the lobby and nothing else about the plot.
    const dir = await server.inject({ method: "GET", url: "/api/v1/worlds/directory" });
    const plot = (dir.json() as { spaces: Array<{ id: string; name: string | null; open_rooms: Array<{ slug: string }> }> }).spaces.find(
      (s) => s.id === world.id,
    )!;
    expect(plot.name).toBeNull();
    expect(plot.open_rooms.map((r) => r.slug)).toEqual(["garden"]);
    expect(JSON.stringify(plot)).not.toContain(world.name);
  });

  it("public presets let a non-member walk in as a visitor at the preset's level; private stays shut", async () => {
    const server = await boot();
    const owner = await signIn("pbo");
    const visitor = await signIn("pbv");
    // A second visitor for public_write: a brand-new human's first-day say
    // limits would otherwise count the refused public_view attempt against it.
    const talker = await signIn("pbt");
    const say = (who: { cookie: string }, worldId: string, body: string) =>
      server.inject({
        method: "POST",
        url: "/api/v1/say",
        headers: { cookie: who.cookie, "x-grove-world": worldId, "idempotency-key": `pb-${Date.now()}-${body}` },
        payload: { channel: "room_say", body },
      });

    // public_view: in without joining, can listen, cannot speak.
    const view = await spaceWith(owner, "public_view");
    const inView = await server.inject({ method: "POST", url: `/api/v1/worlds/${view.id}/enter`, headers: { cookie: visitor.cookie }, payload: {} });
    expect(inView.statusCode).toBe(200);
    expect((inView.json() as { room: { id: string } }).room.id).toBe(`${view.id}:plaza`);
    expect(await grove!.campus.isMember(view.id, visitor.id)).toBe(false);
    expect((await server.inject({ method: "GET", url: "/api/v1/rooms/plaza", headers: { cookie: visitor.cookie, "x-grove-world": view.id } })).statusCode).toBe(200);
    const muted = await say(visitor, view.id, "hi-view");
    expect(muted.statusCode).toBe(403);
    expect((muted.json() as { error: Record<string, unknown> }).error).toMatchObject({ code: "PERMISSION_DENIED", membership: "non_member" });

    // public_write: in, and may speak.
    const write = await spaceWith(owner, "public_write");
    expect((await server.inject({ method: "POST", url: `/api/v1/worlds/${write.id}/enter`, headers: { cookie: talker.cookie }, payload: {} })).statusCode).toBe(200);
    expect((await say(talker, write.id, "hi-write")).statusCode).toBe(200);
    expect(await grove!.campus.isMember(write.id, talker.id)).toBe(false);

    // A private room inside a public space stays closed.
    const closed = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${write.id}/rooms/library`,
      headers: { cookie: owner.cookie },
      payload: { room_preset: "private" },
    });
    expect(closed.statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: `/api/v1/worlds/${write.id}/enter`, headers: { cookie: visitor.cookie }, payload: { room: "library" } })).statusCode).toBe(403);
    expect((await server.inject({ method: "GET", url: "/api/v1/rooms/library", headers: { cookie: visitor.cookie, "x-grove-world": write.id } })).statusCode).toBe(403);

    // A private space admits nobody who is not a member.
    const priv = await spaceWith(owner, "private");
    expect((await server.inject({ method: "POST", url: `/api/v1/worlds/${priv.id}/enter`, headers: { cookie: visitor.cookie }, payload: {} })).statusCode).toBe(403);
  });

  it("owner-only: a stranger, a foreign room and bad input are refused without confirming anything", async () => {
    const server = await boot();
    const owner = await signIn("rpo2");
    const stranger = await signIn("rps2");
    const world = await privateSpace(owner);
    const other = await privateSpace(stranger);

    const byStranger = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}/rooms/plaza`,
      headers: { cookie: stranger.cookie },
      payload: { room_preset: "public_write" },
    });
    expect(byStranger.statusCode).toBe(404);
    const foreign = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}/rooms/${encodeURIComponent(`${other.id}:plaza`)}`,
      headers: { cookie: owner.cookie },
      payload: { room_preset: "public_write" },
    });
    expect(foreign.statusCode).toBe(404);
    const bad = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}/rooms/plaza`,
      headers: { cookie: owner.cookie },
      payload: { member_policy: { speak_to_agents: "yes" } },
    });
    expect(bad.statusCode).toBe(400);

    // SPC-10 on the space itself round-trips in wire spelling.
    const ceiling = { speak_to_agents: false, speak_to_humans: false, listen_to_agents: true, listen_to_humans: true };
    const patched = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: owner.cookie },
      payload: { member_policy: ceiling },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { world: { member_policy: unknown } }).world.member_policy).toEqual(ceiling);
    const cleared = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: owner.cookie },
      payload: { member_policy: null },
    });
    expect((cleared.json() as { world: { member_policy: unknown } }).world.member_policy).toBeNull();
  });
});
