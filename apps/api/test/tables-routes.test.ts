/**
 * Board tables through the real app (#42): doors wired to the service, reads as
 * public as the room (a private space is a 404 signed out), moves charged to
 * table_move, and the MCP-shaped JSON a player needs (legal moves on its turn).
 */
import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, testClient, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
// This file's own address, so its register window is nobody else's.
const client = testClient("tablesRoutes");
warnIfNotTestDatabase("tables routes suite");

describe.skipIf(!hasDb)("table routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let grove: GroveApp | undefined;
  const fixtures = createFixtures(() => grove?.store);

  async function boot() {
    if (app) return app;
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the tables routes suite");
    await migrate(config.databaseUrl);
    const pg = createPool(config.databaseUrl);
    const redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    app = await buildApp(grove);
    return app;
  }

  afterAll(async () => {
    await fixtures.cleanup();
    if (app) await app.close();
    await grove?.store.pg.end();
    grove?.store.redis.disconnect();
  });

  type Server = Awaited<ReturnType<typeof buildApp>>;

  async function human(server: Server, prefix: string) {
    const local = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const magic = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `${local}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await server.inject({ method: "POST", url: "/api/v1/humans/session/consume", payload: { token } });
    const raw = consumed.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    const id = (consumed.json() as { human: { id: string } }).human.id;
    fixtures.trackHuman(id, cookie);
    return { id, cookie };
  }

  async function agent(server: Server, owner: { cookie: string }) {
    await client.reset(grove!.store.redis);
    const reg = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: client.headers,
      payload: { name: `tabler${Math.random().toString(36).slice(2, 7)}`, description: "table routes" },
    });
    expect(reg.statusCode).toBe(200);
    const { agent_id, api_key } = reg.json() as { agent_id: string; api_key: string };
    fixtures.trackAgent(agent_id);
    const claim = await server.inject({ method: "POST", url: `/api/v1/agents/${agent_id}/claim`, headers: { cookie: owner.cookie } });
    expect(claim.statusCode).toBe(200);
    return { agentId: agent_id, auth: { authorization: `Bearer ${api_key}` } };
  }

  it("opens, joins, moves and resigns over REST, public in a public room and 404 behind a private door", async () => {
    const server = await boot();
    const alice = await human(server, "tblalice");
    const owner = await human(server, "tblowner");
    const bot = await agent(server, owner);

    expect((await server.inject({ method: "POST", url: "/api/v1/tables", payload: { room: "library", game: "four" } })).statusCode).toBe(401);
    const bad = await server.inject({ method: "POST", url: "/api/v1/tables", headers: { cookie: alice.cookie }, payload: { room: "library", game: "go" } });
    expect(bad.statusCode).toBe(400);

    const opened = await server.inject({
      method: "POST",
      url: "/api/v1/tables",
      headers: { cookie: alice.cookie },
      payload: { room: "library", game: "chess", clock: "live" },
    });
    expect(opened.statusCode).toBe(201);
    const t = (opened.json() as { table: { id: string; status: string; your_seat: number } }).table;
    expect(t).toMatchObject({ status: "waiting", your_seat: 0 });

    const joined = await server.inject({ method: "POST", url: `/api/v1/tables/${t.id}/join`, headers: bot.auth });
    expect(joined.statusCode).toBe(200);
    expect((joined.json() as { table: { status: string } }).table.status).toBe("active");

    const moved = await server.inject({ method: "POST", url: `/api/v1/tables/${t.id}/move`, headers: { cookie: alice.cookie }, payload: { move: "e4" } });
    expect(moved.statusCode).toBe(200);
    expect(moved.headers["ratelimit-policy"] ?? "").toContain("table_move");
    const outOfTurn = await server.inject({ method: "POST", url: `/api/v1/tables/${t.id}/move`, headers: { cookie: alice.cookie }, payload: { move: "d4" } });
    expect(outOfTurn.statusCode).toBe(409);

    const botView = (await server.inject({ method: "GET", url: `/api/v1/tables/${t.id}`, headers: bot.auth })).json() as {
      table: { legal_moves: string[]; fen: string; moves: Array<{ notation: string }>; your_seat: number };
    };
    expect(botView.table.your_seat).toBe(1);
    expect(botView.table.legal_moves).toContain("e7e5");
    expect(botView.table.moves.map((m) => m.notation)).toEqual(["e4"]);

    const anonList = (await server.inject({ method: "GET", url: "/api/v1/tables?room=library" })).json() as { tables: Array<{ id: string }> };
    expect(anonList.tables.map((x) => x.id)).toContain(t.id);
    const playing = (await server.inject({ method: "GET", url: "/api/v1/tables/playing" })).json() as { tables: Array<{ id: string; seats: string[] }> };
    expect(playing.tables.find((x) => x.id === t.id)?.seats).toEqual([alice.id, bot.agentId]);

    const resigned = await server.inject({ method: "POST", url: `/api/v1/tables/${t.id}/resign`, headers: bot.auth, payload: {} });
    expect((resigned.json() as { table: { result: { winner: number; reason: string } } }).table.result).toEqual({ winner: 0, reason: "resigned" });
    const ended = (await server.inject({ method: "GET", url: `/api/v1/tables/${t.id}` })).json() as { table: { ended_event_id: string }; reactions: Record<string, unknown> };
    expect(ended.reactions[`event:${ended.table.ended_event_id}`]).toEqual({ counts: {}, mine: [] });

    // A private space: its table and its room answer 404 signed out and to a stranger.
    const ownerHuman = (await grove!.identity.getHuman(owner.id))!;
    const shut = await grove!.campus.createWorld(ownerHuman, { name: "Shut tables", slug: `shut-tables-${Date.now().toString(36)}`, preset: "private" });
    fixtures.trackWorld(shut.id);
    const hidden = await grove!.tables.create({ kind: "human", human: ownerHuman }, { room: `${shut.id}:library`, game: "four" });
    for (const headers of [{}, { cookie: alice.cookie }]) {
      expect((await server.inject({ method: "GET", url: `/api/v1/tables/${hidden.id}`, headers })).statusCode).toBe(404);
      expect((await server.inject({ method: "GET", url: `/api/v1/tables?room=${encodeURIComponent(`${shut.id}:library`)}`, headers })).statusCode).toBe(404);
      expect((await server.inject({ method: "POST", url: `/api/v1/tables/${hidden.id}/join`, headers, payload: {} })).statusCode).toBe(Object.keys(headers).length ? 404 : 401);
    }
    expect((await server.inject({ method: "GET", url: `/api/v1/tables/${hidden.id}`, headers: { cookie: owner.cookie } })).statusCode).toBe(200);
  });
});
