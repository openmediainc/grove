/**
 * The span routes, through the real app (migration 020). A domain test already
 * proves the rules; this proves the doors are open, wired to the rules, and
 * speak the wire's snake_case — including a start and finish in the same second,
 * which the 1/s pulse cap would refuse.
 */
import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, testClient, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
// This file's own address, so its register window is nobody else's.
const client = testClient("toolCallRoutes");
warnIfNotTestDatabase("tool-call routes suite");

describe.skipIf(!hasDb)("tool-call routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let grove: GroveApp | undefined;
  const fixtures = createFixtures(() => grove?.store);

  async function boot() {
    if (app) return app;
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the tool-call routes suite");
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

  async function inhabitant(server: Awaited<ReturnType<typeof buildApp>>) {
    const local = `tcr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const magic = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `${local}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await server.inject({ method: "POST", url: "/api/v1/humans/session/consume", payload: { token } });
    const raw = consumed.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    fixtures.trackHuman((consumed.json() as { human: { id: string } }).human.id, cookie);
    await client.reset(grove!.store.redis);
    const reg = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: client.headers,
      payload: { name: `spans${local.slice(-4)}`, description: "tool-call routes" },
    });
    expect(reg.statusCode).toBe(200);
    const { agent_id, api_key } = reg.json() as { agent_id: string; api_key: string };
    fixtures.trackAgent(agent_id);
    const claim = await server.inject({ method: "POST", url: `/api/v1/agents/${agent_id}/claim`, headers: { cookie } });
    expect(claim.statusCode).toBe(200);
    const auth = { authorization: `Bearer ${api_key}` };
    return { agentId: agent_id, auth };
  }

  it("refuses before a body has joined, then runs a whole span", async () => {
    const server = await boot();
    const { agentId, auth } = await inhabitant(server);

    const early = await server.inject({ method: "POST", url: "/api/v1/world/tool-calls", headers: auth, payload: { name: "Bash" } });
    expect(early.statusCode).toBe(404);

    const join = await server.inject({ method: "POST", url: "/api/v1/world/join", headers: auth });
    expect(join.statusCode).toBe(200);

    const start = await server.inject({
      method: "POST",
      url: "/api/v1/world/tool-calls",
      headers: auth,
      payload: { call_id: "toolu_route1", name: "Bash", args: "pnpm test:safe" },
    });
    expect(start.statusCode).toBe(200);
    const started = (start.json() as { tool_call: Record<string, unknown> }).tool_call;
    expect(started.call_id).toBe("toolu_route1");
    expect(started.progress).toBeNull();

    const prog = await server.inject({
      method: "POST",
      url: "/api/v1/world/tool-calls/toolu_route1/progress",
      headers: auth,
      payload: { done: 2, total: 8 },
    });
    expect(prog.statusCode).toBe(200);
    expect((prog.json() as { tool_call: { progress: number } }).tool_call.progress).toBeCloseTo(0.25);

    const fin = await server.inject({
      method: "POST",
      url: "/api/v1/world/tool-calls/toolu_route1/finish",
      headers: auth,
      payload: { outcome: "error", result: "3 failed" },
    });
    expect(fin.statusCode).toBe(200);
    const finished = (fin.json() as { tool_call: Record<string, unknown> }).tool_call;
    expect(finished.outcome).toBe("error");
    expect(finished.result).toBe("3 failed");
    expect(typeof finished.duration_ms).toBe("number");

    const bad = await server.inject({
      method: "POST",
      url: "/api/v1/world/tool-calls/toolu_route1/finish",
      headers: auth,
      payload: { outcome: "stalled" },
    });
    expect(bad.statusCode).toBe(400);

    // The public minimap carries it, snake_cased, under the body.
    const map = await server.inject({ method: "GET", url: "/api/v1/world/minimap" });
    const body = (map.json() as { bodies: Array<{ id: string; tool_calls: Array<{ call_id: string; outcome: string }>; stance: string }> }).bodies.find(
      (b) => b.id === agentId,
    );
    expect(body?.tool_calls.find((t) => t.call_id === "toolu_route1")?.outcome).toBe("error");
    expect(body?.stance).toBe("hang_out");
  });
});
