/**
 * ONB-07 on the wire: the probe's loopback gate, the operator gate on the mod
 * view, and the honest `delivery` field on the sign-in response.
 */
import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("email health suite");

describe.skipIf(!hasDb)("email health routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let grove: GroveApp | undefined;
  const fixtures = createFixtures(() => grove?.store);
  const domain = `ehr-${Math.random().toString(36).slice(2, 8)}.example`;

  async function boot() {
    if (app) return app;
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the email health suite");
    await migrate(config.databaseUrl);
    grove = new GroveApp(createPool(config.databaseUrl), new Redis(config.redisUrl), config);
    app = await buildApp(grove);
    return app;
  }

  afterAll(async () => {
    await grove?.store.pg.query("DELETE FROM email_deliveries WHERE recipient_domain = $1", [domain]);
    await fixtures.cleanup();
    if (app) await app.close();
    await grove?.store.pg.end();
    grove?.store.redis.disconnect();
  });

  it("the probe answers a direct loopback call and 404s anything proxied", async () => {
    const server = await boot();
    const direct = await server.inject({ method: "GET", url: "/internal/email-health" });
    expect([200, 503]).toContain(direct.statusCode);
    const body = direct.json() as { status: string; ok: boolean; transport: string; day: { attempts: number } };
    expect(body.transport).toBe(grove!.emailDeliveries.transport);
    expect(body.ok).toBe(body.status !== "down");
    expect(typeof body.day.attempts).toBe("number");
    expect(direct.statusCode).toBe(body.status === "down" ? 503 : 200);

    const proxied = await server.inject({
      method: "GET",
      url: "/internal/email-health",
      headers: { "x-forwarded-for": "100.64.0.9" },
    });
    expect(proxied.statusCode).toBe(404);
  });

  it("the mod view is not visible to a non-operator", async () => {
    const server = await boot();
    const anon = await server.inject({ method: "GET", url: "/api/v1/mod/email" });
    expect([401, 404]).toContain(anon.statusCode);
  });

  it("the sign-in response says what happened to the link, and records it", async () => {
    const server = await boot();
    const email = `probe${Date.now().toString(36)}@${domain}`;
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email, invite_code: "grove-alpha", age_attested: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { delivery: string; sent: boolean; dev_login_url?: string; link_ttl_seconds: number };
    expect(["email", "screen", "failed", "none"]).toContain(body.delivery);
    expect(body.link_ttl_seconds).toBe(900);
    if (body.delivery === "screen") expect(body.dev_login_url).toBeTruthy();

    const { rows } = await grove!.store.pg.query(
      "SELECT transport, send_status FROM email_deliveries WHERE recipient_domain = $1",
      [domain],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transport).toBe(grove!.emailDeliveries.transport);

    if (body.dev_login_url) {
      const token = new URL(body.dev_login_url).searchParams.get("token");
      const consumed = await server.inject({ method: "POST", url: "/api/v1/humans/session/consume", payload: { token } });
      expect(consumed.statusCode).toBe(200);
      fixtures.trackHuman((consumed.json() as { human: { id: string } }).human.id, String(consumed.headers["set-cookie"]));
      const after = await grove!.store.pg.query(
        "SELECT redeemed_at FROM email_deliveries WHERE recipient_domain = $1",
        [domain],
      );
      expect(after.rows[0]?.redeemed_at).not.toBeNull();
    }
  });
});
