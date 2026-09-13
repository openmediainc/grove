/**
 * OPS-01 on the wire: the /mod Overview is operator-only and answers 404 to
 * everyone else, and an operator gets schema drift by name plus the anomaly
 * lines in snake_case.
 */
import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("ops routes suite");

describe.skipIf(!hasDb)("operator overview route", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let grove: GroveApp | undefined;
  const fixtures = createFixtures(() => grove?.store);

  async function boot() {
    if (app) return app;
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the ops routes suite");
    await migrate(config.databaseUrl);
    grove = new GroveApp(createPool(config.databaseUrl), new Redis(config.redisUrl), config);
    app = await buildApp(grove);
    return app;
  }

  afterAll(async () => {
    await fixtures.cleanup();
    if (app) await app.close();
    await grove?.store.pg.end();
    grove?.store.redis.disconnect();
  });

  async function signIn(tag: string) {
    const server = await boot();
    const local = `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const magic = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `${local}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await server.inject({ method: "POST", url: "/api/v1/humans/session/consume", payload: { token } });
    const raw = consumed.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    const human = (consumed.json() as { human: { id: string } }).human;
    fixtures.trackHuman(human.id, cookie);
    return { cookie, id: human.id };
  }

  it("is invisible to anonymous callers and to inhabitants", async () => {
    const server = await boot();
    const anon = await server.inject({ method: "GET", url: "/api/v1/mod/ops" });
    expect([401, 404]).toContain(anon.statusCode);

    const inhabitant = await signIn("opsin");
    const res = await server.inject({ method: "GET", url: "/api/v1/mod/ops", headers: { cookie: inhabitant.cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("schema");
  });

  it("gives an operator health, schema names, cost, email and anomaly lines", async () => {
    const server = await boot();
    const op = await signIn("opsop");
    await grove!.store.pg.query("UPDATE humans SET role = 'operator' WHERE id = $1", [op.id]);
    const res = await server.inject({ method: "GET", url: "/api/v1/mod/ops", headers: { cookie: op.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const o = (res.json() as { overview: Record<string, any> }).overview;
    expect(o.health.postgres.ok).toBe(true);
    expect(Array.isArray(o.schema.pending)).toBe(true);
    expect(Array.isArray(o.schema.unknown)).toBe(true);
    expect(typeof o.schema.on_disk).toBe("number");
    expect(Array.isArray(o.anomalies)).toBe(true);
    const metric = (o.metrics as Array<Record<string, unknown>>).find((m) => m.key === "tool_call_errors");
    expect(metric).toMatchObject({ label: "tool-call errors", kind: "fault" });
    expect(metric).toHaveProperty("history_days");
    expect(metric).not.toHaveProperty("sql");
    expect(o.cost).toHaveProperty("top_agents");
    expect(o.email).toHaveProperty("status");
  });
});
