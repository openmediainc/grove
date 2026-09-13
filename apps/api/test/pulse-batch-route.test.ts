/**
 * Batch pulse on the real route (AGT-10), through `app.inject()`.
 *
 * The domain suite proves the rules. This proves the door: that `{ pulses }`
 * on POST /world/pulse reaches them, that the per-item lines leave in
 * snake_case, and that the cap a batch spends is the same `pulse` bucket — with
 * the same 429, Retry-After and RateLimit headers — as a single pulse.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate, PULSE_BATCH_MAX } from "@grove/domain";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
  warnIfNotTestDatabase,
} from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const REGISTER_IP = REGISTER_IPS.pulseBatchRoute;
const hasDb = hasTestDatabase();
warnIfNotTestDatabase("pulse batch route suite");
const tag = () => Math.random().toString(36).slice(2, 10);

describe.skipIf(!hasDb)("POST /world/pulse with a batch", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the pulse batch route suite");
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

  /** A claimed agent with a body in the plaza, and its bearer key. */
  async function inhabitant() {
    const email = `batch-route-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);

    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: { "x-forwarded-for": REGISTER_IP },
      payload: { name: `batch${tag()}`, description: "fixture" },
    });
    const body = reg.json() as { agent_id: string; api_key: string };
    fixtures.trackAgent(body.agent_id);
    await grove.identity.claimAgent(body.agent_id, human as never);
    const auth = { authorization: `Bearer ${body.api_key}` };
    const joined = await app.inject({ method: "POST", url: "/api/v1/world/join", headers: auth });
    expect(joined.statusCode).toBe(200);
    await clearActorLimiters(redis, body.agent_id);
    return { id: body.agent_id, auth };
  }

  const pulse = (auth: Record<string, string>, payload: unknown) =>
    app.inject({ method: "POST", url: "/api/v1/world/pulse", headers: auth, payload: payload as never });

  it("applies a batch and reports every item in snake_case", async () => {
    const a = await inhabitant();
    const t0 = Date.now() - 2_000;
    const res = await pulse(a.auth, {
      pulses: [
        { verb: "think", detail: "planning", at: new Date(t0).toISOString(), id: "r1" },
        { verb: "vibing", id: "r2" },
        { verb: "tool", detail: "pnpm test:safe", at: t0 + 500, id: "r3", error_text: "ignored on tool" },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, applied: 2, duplicates: 0, refused: 1 });
    expect((body.presence as Record<string, unknown>).verb).toBe("tool");
    expect((body.presence as Record<string, unknown>).pulsed_at).toBe(new Date(t0 + 500).toISOString());
    const results = body.results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.status)).toEqual(["applied", "refused", "applied"]);
    expect(results[0]).toEqual({
      index: 0,
      id: "r1",
      status: "applied",
      verb: "think",
      pulsed_at: new Date(t0).toISOString(),
      clamped: false,
    });
    expect(results[1]).toMatchObject({ index: 1, id: "r2", status: "refused", code: "INVALID" });
    expect(String(results[1]!.reason)).toMatch(/verb must be one of/);
    // The pulse bucket is advertised on a batch exactly as on a single pulse.
    expect(String(res.headers["ratelimit-policy"])).toContain('"pulse"');
  });

  it("spends the same pulse bucket: a second call inside the second is a 429, a pure retry is not", async () => {
    const a = await inhabitant();
    const batch = { pulses: [{ verb: "read", id: "q1" }, { verb: "tool", id: "q2" }] };
    expect((await pulse(a.auth, batch)).statusCode).toBe(200);

    const refused = await pulse(a.auth, { pulses: [{ verb: "idle", id: "q3" }] });
    expect(refused.statusCode).toBe(429);
    expect((refused.json() as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    expect(refused.headers["retry-after"]).toBe("1");

    const single = await pulse(a.auth, { verb: "idle" });
    expect(single.statusCode).toBe(429);

    // Same ids again, still inside the cooldown: nothing new to write, so no refusal.
    const retry = await pulse(a.auth, batch);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ applied: 0, duplicates: 2 });
  });

  it("refuses a malformed batch whole with a 400, and leaves the single pulse unchanged", async () => {
    const a = await inhabitant();
    const huge = await pulse(a.auth, { pulses: Array.from({ length: PULSE_BATCH_MAX + 1 }, () => ({ verb: "tool" })) });
    expect(huge.statusCode).toBe(400);
    expect((huge.json() as { error: { code: string } }).error.code).toBe("INVALID");
    const mixed = await pulse(a.auth, { verb: "tool", pulses: [{ verb: "tool" }] });
    expect(mixed.statusCode).toBe(400);

    const single = await pulse(a.auth, { verb: "tool", detail: "pnpm test:safe" });
    expect(single.statusCode).toBe(200);
    const body = single.json() as { presence: Record<string, unknown>; results?: unknown };
    expect(body.presence.verb).toBe("tool");
    expect(body.results).toBeUndefined();
  });
});
