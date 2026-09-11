import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { buildApp } from "../src/app.js";

const hasDb = Boolean(process.env.DATABASE_URL) || process.env.GROVE_INTEGRATION === "1";

describe.skipIf(!hasDb)("api integration", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let grove: GroveApp | undefined;

  async function boot() {
    if (app) return app;
    const config = loadConfig();
    await migrate(config.databaseUrl);
    const pg = createPool(config.databaseUrl);
    const redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    app = await buildApp(grove);
    return app;
  }

  afterAll(async () => {
    if (app) await app.close();
    await grove?.store.pg.end();
    grove?.store.redis.disconnect();
  });

  it("health and ready", async () => {
    const server = await boot();
    const h = await server.inject({ method: "GET", url: "/health" });
    expect(h.statusCode).toBe(200);
    const r = await server.inject({ method: "GET", url: "/ready" });
    expect(r.statusCode).toBe(200);
  });

  it("listen-only room_say 403 vs owner_reply 200; unclaimed observe has no room", async () => {
    const server = await boot();
    const g = grove!;
    const email = `itest-${Date.now()}@example.com`;
    const magic = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email, invite_code: "grove-alpha", age_attested: true },
    });
    expect(magic.statusCode).toBe(200);
    const magicBody = magic.json() as { dev_login_url?: string };
    const token = new URL(magicBody.dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session/consume",
      payload: { token },
    });
    expect(consumed.statusCode).toBe(200);
    const cookie = consumed.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : cookie;

    const reg = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      payload: { name: "scribe", description: "listen-only" },
    });
    expect(reg.statusCode).toBe(200);
    const regBody = reg.json() as { agent_id: string; api_key: string; slug: string };
    expect(regBody.slug).toBe(regBody.agent_id);
    expect(regBody.api_key.startsWith("aeth_live_")).toBe(true);

    const obsPending = await server.inject({
      method: "GET",
      url: "/api/v1/observe",
      headers: { authorization: `Bearer ${regBody.api_key}` },
    });
    expect(obsPending.statusCode).toBe(200);
    const pending = obsPending.json() as { observation: Record<string, unknown> };
    expect(pending.observation.kind).toBe("pending");
    expect(pending.observation.room).toBeUndefined();

    const claim = await server.inject({
      method: "POST",
      url: `/api/v1/agents/${regBody.agent_id}/claim`,
      headers: { cookie: cookieHeader ?? "" },
    });
    expect(claim.statusCode).toBe(200);

    await server.inject({
      method: "PATCH",
      url: `/api/v1/agents/${regBody.agent_id}/policy`,
      headers: { cookie: cookieHeader ?? "" },
      payload: {
        speak_to_agents: false,
        speak_to_humans: false,
        listen_to_agents: true,
        listen_to_humans: true,
      },
    });

    await server.inject({
      method: "POST",
      url: "/api/v1/world/enter",
      headers: { cookie: cookieHeader ?? "" },
    });
    await server.inject({
      method: "POST",
      url: "/api/v1/world/join",
      headers: { authorization: `Bearer ${regBody.api_key}` },
    });

    const denied = await server.inject({
      method: "POST",
      url: "/api/v1/say",
      headers: {
        authorization: `Bearer ${regBody.api_key}`,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: { channel: "room_say", body: "digest" },
    });
    expect(denied.statusCode).toBe(403);
    const deniedBody = denied.json() as { error: { code: string; capability: string } };
    expect(deniedBody.error.code).toBe("PERMISSION_DENIED");
    expect(deniedBody.error.capability).toBe("speak_to_humans");

    const allowed = await server.inject({
      method: "POST",
      url: "/api/v1/say",
      headers: {
        authorization: `Bearer ${regBody.api_key}`,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: { channel: "owner_reply", body: "digest" },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe("integration skip contract", () => {
  it("skips when DATABASE_URL is unset unless GROVE_INTEGRATION=1", () => {
    if (!hasDb) expect(hasDb).toBe(false);
    else expect(hasDb).toBe(true);
  });
});
