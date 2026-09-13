/**
 * Cost burn through the real routes: an agent reports over REST and MCP with
 * snake_case off the wire, its owner reads the day and sets a budget, and
 * nobody else can do either.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import {
  assertTestDatabase,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
  warnIfNotTestDatabase,
} from "@grove/domain/test-support";
import { buildApp } from "../src/app.js";
import { callTool, TOOLS } from "../src/mcp.js";

const REGISTER_IP = REGISTER_IPS.usageRoutes;
const hasDb = hasTestDatabase();
warnIfNotTestDatabase("usage routes suite");

describe.skipIf(!hasDb)("cost burn routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the usage routes suite");
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
    const human = (consumed.json() as { human: { id: string } }).human;
    fixtures.trackHuman(human.id, cookie);
    return { cookie, id: human.id };
  }

  async function claimedAgent(cookie: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: { "x-forwarded-for": REGISTER_IP },
      payload: { name: "accountant", description: "fixture" },
    });
    const body = reg.json() as { agent_id: string; api_key: string };
    fixtures.trackAgent(body.agent_id);
    return { ...body, claim: () => app.inject({ method: "POST", url: `/api/v1/agents/${body.agent_id}/claim`, headers: { cookie } }) };
  }

  it("an unclaimed agent cannot report; a claimed one can, in snake_case", async () => {
    const owner = await signIn("usg");
    const agent = await claimedAgent(owner.cookie);
    const auth = { authorization: `Bearer ${agent.api_key}` };

    const early = await app.inject({ method: "POST", url: "/api/v1/world/usage", headers: auth, payload: { cost_usd: 1 } });
    expect((early.json() as { error: { code: string } }).error.code).toBe("UNCLAIMED");

    expect((await agent.claim()).statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/world/usage",
      headers: auth,
      payload: { model: "claude-sonnet", input_tokens: 1200, cache_read_input_tokens: 800, cost_usd: 0.0321, id: "t1" },
    });
    expect(res.statusCode).toBe(201);
    const recorded = (res.json() as { recorded: Array<Record<string, unknown>> }).recorded[0]!;
    expect(recorded).toMatchObject({ cost_micros: 32_100, input_tokens: 1200, cache_read_tokens: 800, duplicate: false });
    // Published limits reach the client like every other bucket.
    expect(String(res.headers["ratelimit-policy"] ?? "")).toMatch(/usage/);

    const bad = await app.inject({ method: "POST", url: "/api/v1/world/usage", headers: auth, payload: { model: "x" } });
    expect(bad.statusCode).toBe(400);

    // MCP says the same thing through the same ledger.
    expect(TOOLS.some((t) => t.name === "report_usage")).toBe(true);
    const tool = await callTool(grove, agent.agent_id, "report_usage", { output_tokens: 10 });
    const out = JSON.parse(tool.content[0]!.text) as { recorded: Array<{ cost_micros: number | null }> };
    expect(out.recorded[0]!.cost_micros).toBeNull();

    const day = await app.inject({ method: "GET", url: "/api/v1/usage", headers: { cookie: owner.cookie } });
    expect(day.statusCode).toBe(200);
    const usage = (day.json() as { usage: Record<string, any>; paperclip: unknown }).usage;
    expect(usage.totals).toMatchObject({ cost_micros: 32_100, costed_reports: 1, uncosted_reports: 1 });
    expect(usage.by_hour).toHaveLength(24);
    // Paperclip's spend has no Grove owner: an inhabitant is not shown it.
    expect((day.json() as { paperclip: unknown }).paperclip).toBeNull();

    const budget = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${agent.agent_id}/budget`,
      headers: { cookie: owner.cookie },
      payload: { monthly_usd: 0.04 },
    });
    expect(budget.statusCode).toBe(200);
    expect((budget.json() as { budget: { monthly_micros: number } }).budget.monthly_micros).toBe(40_000);
    const after = (await app.inject({ method: "GET", url: "/api/v1/usage", headers: { cookie: owner.cookie } })).json() as {
      usage: { budget_alerts: Array<{ agent_id: string; budget: { state: string } }> };
    };
    expect(after.usage.budget_alerts).toEqual([expect.objectContaining({ agent_id: agent.agent_id })]);
    expect(after.usage.budget_alerts[0]!.budget.state).toBe("near");

    const stranger = await signIn("nosy");
    const theirs = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${agent.agent_id}/budget`,
      headers: { cookie: stranger.cookie },
      payload: { monthly_usd: 100 },
    });
    expect(theirs.statusCode).toBe(404);
    const peek = await app.inject({
      method: "GET",
      url: `/api/v1/usage?scope=agent:${agent.agent_id}`,
      headers: { cookie: stranger.cookie },
    });
    expect(peek.statusCode).toBe(404);
    const signedOut = await app.inject({ method: "GET", url: "/api/v1/usage" });
    expect(signedOut.statusCode).toBe(401);
  });
});
