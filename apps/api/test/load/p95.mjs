/**
 * Load harness: 50 humans + 50 claimed agents, each agent room_say once.
 *
 * Production SLO is 150ms p95 on staging hardware.
 * This harness fails if p95 > 1500ms (CI machines are slower).
 *
 * Skip: not part of `pnpm test`. Run with `pnpm --filter @grove/api load`.
 */
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { buildApp } from "../../src/app.ts";

const N = 50;
const GATE_MS = 1500;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main() {
  if (!process.env.DATABASE_URL && process.env.GROVE_INTEGRATION !== "1") {
    console.log("[load] skip: set DATABASE_URL (or GROVE_INTEGRATION=1)");
    process.exit(0);
  }
  const config = loadConfig();
  await migrate(config.databaseUrl);
  const pg = createPool(config.databaseUrl);
  const redis = new Redis(config.redisUrl);
  const grove = new GroveApp(pg, redis, config);
  const app = await buildApp(grove);
  const stamp = Date.now();

  const humans = [];
  for (let i = 0; i < N; i++) {
    const email = `load-${stamp}-${i}@example.com`;
    const magic = await app.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email, invite_code: "grove-alpha", age_attested: true },
    });
    const body = magic.json();
    const token = new URL(body.dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await app.inject({
      method: "POST",
      url: "/api/v1/humans/session/consume",
      payload: { token },
    });
    const cookie = consumed.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : cookie;
    await app.inject({
      method: "POST",
      url: "/api/v1/world/enter",
      headers: { cookie: cookieHeader ?? "" },
    });
    humans.push({ cookie: cookieHeader ?? "", email });
  }

  const agents = [];
  for (let i = 0; i < N; i++) {
    const ip = `198.51.100.${(i % 250) + 1}`;
    const unique = `${stamp}-${i}-${Math.random().toString(16).slice(2)}`;
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: { "x-forwarded-for": `${ip}:${i}:${unique}` },
      payload: { name: `loadbot${i}`, description: "load harness" },
    });
    const regBody = reg.json();
    if (reg.statusCode !== 200) {
      throw new Error(`register failed ${reg.statusCode}: ${JSON.stringify(regBody)}`);
    }
    await app.inject({
      method: "POST",
      url: `/api/v1/agents/${regBody.agent_id}/claim`,
      headers: { cookie: humans[i].cookie },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/world/join",
      headers: { authorization: `Bearer ${regBody.api_key}` },
    });
    agents.push({ id: regBody.agent_id, key: regBody.api_key });
  }

  const latencies = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/say",
      headers: {
        authorization: `Bearer ${agents[i].key}`,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: { channel: "room_say", body: `load hello ${i}` },
    });
    const ms = performance.now() - t0;
    latencies.push(ms);
    if (res.statusCode !== 200) {
      console.warn(`[load] say ${i} status ${res.statusCode}`, res.json());
    }
  }

  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  console.log(
    JSON.stringify(
      {
        n: N,
        p50_ms: Math.round(p50),
        p95_ms: Math.round(p95),
        max_ms: Math.round(latencies[latencies.length - 1] ?? 0),
        gate_ms: GATE_MS,
        slo_note: "Production SLO is 150ms p95 on staging hardware; harness gate is 1500ms.",
      },
      null,
      2,
    ),
  );

  await app.close();
  await pg.end();
  redis.disconnect();

  if (p95 > GATE_MS) {
    console.error(`[load] FAIL p95 ${Math.round(p95)}ms > ${GATE_MS}ms`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
