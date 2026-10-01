/**
 * First-party analytics on the wire (033): the beacon always answers 204 and
 * counts only a browser that did not opt out and is not a bot; actions are
 * counted by the routes that perform them, for people, never under DNT/GPC;
 * and the operator Overview carries the Visitors & funnel summary. Agent
 * registrations and claims are counted as bare numbers beside Sign-ins.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, testClient, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("analytics routes suite");

const client = testClient("analyticsRoutes");

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

describe.skipIf(!hasDb)("analytics routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let grove: GroveApp | undefined;
  const fixtures = createFixtures(() => grove?.store);

  async function boot() {
    if (app) return app;
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the analytics routes suite");
    await migrate(config.databaseUrl);
    grove = new GroveApp(createPool(config.databaseUrl), new Redis(config.redisUrl), config);
    app = await buildApp(grove);
    return app;
  }

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await fixtures.cleanup();
    if (app) await app.close();
    await grove?.store.pg.end();
    grove?.store.redis.disconnect();
  });

  async function signIn(tag: string, headers: Record<string, string> = {}) {
    const server = await boot();
    const local = `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const magic = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `${local}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await server.inject({ method: "POST", url: "/api/v1/humans/session/consume", payload: { token }, headers });
    const raw = consumed.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    const human = (consumed.json() as { human: { id: string } }).human;
    fixtures.trackHuman(human.id, cookie);
    return { cookie, id: human.id };
  }

  it("the beacon is always 204, and counts only an opted-in, non-bot browser", async () => {
    const server = await boot();
    const visit = vi.spyOn(grove!.analytics, "visit");
    const send = (headers: Record<string, string>) => server.inject({ method: "POST", url: "/api/v1/analytics/visit", headers });

    const refused: Array<Record<string, string>> = [
      { "user-agent": CHROME, dnt: "1" },
      { "user-agent": CHROME, "sec-gpc": "1" },
      { "user-agent": "curl/8.4.0" },
      { "user-agent": "x" },
    ];
    for (const headers of refused) {
      const res = await send(headers);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
    }
    expect(visit).not.toHaveBeenCalled();

    const ok = await send({ "user-agent": CHROME });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(visit).toHaveBeenCalledTimes(1);
    const arg = visit.mock.calls[0]![0];
    expect(arg.humanId).toBeNull();
  });

  it("a signed-in beacon passes the person only for the weekly retention mark", async () => {
    const server = await boot();
    const me = await signIn("anbeacon");
    const visit = vi.spyOn(grove!.analytics, "visit");
    await server.inject({ method: "POST", url: "/api/v1/analytics/visit", headers: { "user-agent": CHROME, cookie: me.cookie } });
    expect(visit.mock.calls[0]![0].humanId).toBe(me.id);
  });

  it("a sign-in is counted for the person, and not at all under DNT", async () => {
    await boot();
    const record = vi.spyOn(grove!.analytics, "record");
    const me = await signIn("ansign");
    expect(record).toHaveBeenCalledWith("sign_in", { humanId: me.id });

    record.mockClear();
    await signIn("ansigndnt", { dnt: "1" });
    await signIn("ansigngpc", { "sec-gpc": "1" });
    expect(record).not.toHaveBeenCalled();
  });

  it("walking into the world is a walk-in", async () => {
    const server = await boot();
    const me = await signIn("anwalk");
    const record = vi.spyOn(grove!.analytics, "record");
    const res = await server.inject({ method: "POST", url: "/api/v1/world/enter", headers: { cookie: me.cookie }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(record).toHaveBeenCalledWith("walk_in", { humanId: me.id });
  });

  async function register(headers: Record<string, string> = {}) {
    const server = await boot();
    await client.reset(grove!.store.redis);
    const reg = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: { ...client.headers, ...headers },
      payload: { name: `ancount${Math.random().toString(36).slice(2, 7)}`, description: "analytics routes" },
    });
    expect(reg.statusCode).toBe(200);
    const agentId = (reg.json() as { agent_id: string }).agent_id;
    fixtures.trackAgent(agentId);
    return agentId;
  }

  it("an agent registration is counted as a bare number, and not under DNT or GPC", async () => {
    await boot();
    const record = vi.spyOn(grove!.analytics, "record");
    await register();
    expect(record).toHaveBeenCalledTimes(1);
    // The event name and nothing else: no agent id, no person, no address.
    expect(record.mock.calls[0]).toEqual(["agent_registered"]);

    record.mockClear();
    await register({ dnt: "1" });
    await register({ "sec-gpc": "1" });
    expect(record).not.toHaveBeenCalled();
  });

  it("a claim by a person is counted once, as a bare number; a repeat claim or a refused one is not", async () => {
    const server = await boot();
    const owner = await signIn("anclaim");
    const other = await signIn("anclaim2");
    const agentId = await register();
    const record = vi.spyOn(grove!.analytics, "record");
    const claim = (cookie: string, headers: Record<string, string> = {}) =>
      server.inject({ method: "POST", url: `/api/v1/agents/${agentId}/claim`, headers: { cookie, ...headers } });

    expect((await claim(owner.cookie)).statusCode).toBe(200);
    expect(record.mock.calls).toEqual([["agent_claimed"]]);

    record.mockClear();
    expect((await claim(owner.cookie)).statusCode).toBe(200); // same owner again: already theirs
    expect((await claim(other.cookie)).statusCode).toBe(409); // somebody else: refused
    expect(record).not.toHaveBeenCalled();

    // Under DNT the claim still happens; it is simply not counted.
    const quiet = await register({ dnt: "1" });
    const res = await server.inject({ method: "POST", url: `/api/v1/agents/${quiet}/claim`, headers: { cookie: owner.cookie, dnt: "1" } });
    expect(res.statusCode).toBe(200);
    expect(record).not.toHaveBeenCalled();
  });

  it("the Overview's agent rows move with a real registration and claim", async () => {
    const server = await boot();
    const op = await signIn("anopagent");
    await grove!.store.pg.query("UPDATE humans SET role = 'operator' WHERE id = $1", [op.id]);
    const read = async () => {
      const res = await server.inject({ method: "GET", url: "/api/v1/mod/ops", headers: { cookie: op.cookie } });
      const series = (res.json() as { overview: { analytics: { series: Array<{ key: string; label: string; today: number }> } } }).overview.analytics
        .series;
      return {
        registered: series.find((s) => s.key === "agent_registered")!,
        claimed: series.find((s) => s.key === "agent_claimed")!,
      };
    };
    const before = await read();
    expect(before.registered.label).toBe("Agents registered");
    expect(before.claimed.label).toBe("Agents claimed by a person");

    const agentId = await register();
    const claimed = await server.inject({ method: "POST", url: `/api/v1/agents/${agentId}/claim`, headers: { cookie: op.cookie } });
    expect(claimed.statusCode).toBe(200);

    const after = await read();
    // At least: other suites may be registering on the same test database at the same time.
    expect(after.registered.today).toBeGreaterThanOrEqual(before.registered.today + 1);
    expect(after.claimed.today).toBeGreaterThanOrEqual(before.claimed.today + 1);
    // Counts only: nothing on the row names the agent.
    expect(JSON.stringify(after)).not.toContain(agentId);
  });

  it("the operator Overview carries Visitors & funnel", async () => {
    const server = await boot();
    const op = await signIn("anop");
    await grove!.store.pg.query("UPDATE humans SET role = 'operator' WHERE id = $1", [op.id]);
    const res = await server.inject({ method: "GET", url: "/api/v1/mod/ops", headers: { cookie: op.cookie } });
    expect(res.statusCode).toBe(200);
    const a = (res.json() as { overview: { analytics: Record<string, any> } }).overview.analytics;
    expect(a.retention_days).toBe(90);
    expect((a.series as Array<{ key: string }>).map((s) => s.key)).toEqual([
      "visit",
      "unique_visitor",
      "sign_in",
      "agent_registered",
      "agent_claimed",
      "walk_in",
      "follow",
      "message",
      "reaction",
    ]);
    expect(a.series[0]).toHaveProperty("median7");
    expect(Array.isArray(a.cohorts)).toBe(true);
    expect(a.cohorts[0]).toHaveProperty("cohort_week");
    const signIns = (a.series as Array<{ key: string; today: number }>).find((s) => s.key === "sign_in")!;
    expect(signIns.today).toBeGreaterThanOrEqual(1);
    const email = (res.json() as { overview: { email: Record<string, unknown> } }).overview.email;
    expect(email).toHaveProperty("dmarc");
  });
});
