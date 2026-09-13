import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { toToolCallView } from "../src/services/tool-calls.js";
import { STALL_AFTER_SECONDS } from "../src/services/presence.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.toolCalls;
const hasDb = hasTestDatabase();

// ---------------------------------------------------------------------------
// Pure: the stall verdict on a row.
// ---------------------------------------------------------------------------

describe("tool-call view", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    call_id: "toolu_1",
    name: "Bash",
    args: "pnpm test",
    started_at: "2026-09-13T10:00:00.000Z",
    updated_at: "2026-09-13T10:00:00.000Z",
    finished_at: null,
    outcome: null,
    progress: null,
    progress_done: null,
    progress_total: null,
    result: null,
    ...over,
  });

  it("is not stalled inside the threshold, and is past it", () => {
    const t0 = Date.parse("2026-09-13T10:00:00.000Z");
    expect(toToolCallView(row(), t0 + STALL_AFTER_SECONDS * 1000).stalled).toBe(false);
    expect(toToolCallView(row(), t0 + STALL_AFTER_SECONDS * 1000 + 1).stalled).toBe(true);
  });

  it("never calls a finished span stalled, and gives it a duration", () => {
    const v = toToolCallView(
      row({ finished_at: "2026-09-13T10:00:12.500Z", outcome: "ok" }),
      Date.parse("2026-09-13T12:00:00.000Z"),
    );
    expect(v.stalled).toBe(false);
    expect(v.durationMs).toBe(12_500);
  });

  it("leaves progress null (indeterminate) when none was reported", () => {
    expect(toToolCallView(row()).progress).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Against a database.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)("tool calls as spans (migration 020)", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function newInhabitant(name: string) {
    const owner = await newHuman("span-owner");
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner as never);
    await clearActorLimiters(redis, agent.id);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "plaza", {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      overflowPlaza: true,
    });
    return agent;
  }

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the tool-calls suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    await fixtures.cleanup();
    await redis.quit();
    await pg.end();
  });

  it("starts a span, pulses the body `tool`, and finishes back to `think` in the same second", async () => {
    const agent = await newInhabitant(`spanner${tag()}`);
    const started = await grove.toolCalls.start(agent.id, { callId: "toolu_a", name: "Bash", args: "pnpm test:safe" });
    expect(started.outcome).toBeNull();
    expect(started.progress).toBeNull();
    let presence = await grove.presence.getPresence(agent.id);
    expect(presence?.verb).toBe("tool");
    expect(presence?.detail).toBe("Bash · pnpm test:safe");

    // No 1/s gap: a fast tool's finish lands straight after its start.
    const done = await grove.toolCalls.finish(agent.id, "toolu_a", { outcome: "ok", result: "42 passed" });
    expect(done.outcome).toBe("ok");
    expect(done.result).toBe("42 passed");
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    presence = await grove.presence.getPresence(agent.id);
    expect(presence?.verb).toBe("think");
  });

  it("is idempotent on call_id and does not reset the clock on a retried start", async () => {
    const agent = await newInhabitant(`retry${tag()}`);
    const a = await grove.toolCalls.start(agent.id, { callId: "toolu_r", name: "Edit", args: "x.ts" });
    const b = await grove.toolCalls.start(agent.id, { callId: "toolu_r", name: "Edit", args: "x.ts" });
    expect(b.startedAt).toBe(a.startedAt);
    const { rows } = await pg.query("SELECT count(*)::int AS n FROM tool_calls WHERE actor_id = $1", [agent.id]);
    expect(rows[0].n).toBe(1);
  });

  it("stores real progress only when reported, and a bare progress report is a keep-alive", async () => {
    const agent = await newInhabitant(`prog${tag()}`);
    await grove.toolCalls.start(agent.id, { callId: "build", name: "Bash", args: "build" });
    await pg.query("UPDATE tool_calls SET updated_at = now() - interval '200 seconds' WHERE actor_id = $1", [agent.id]);
    const before = await grove.toolCalls.forActors([agent.id]);
    expect(before.get(agent.id)?.[0]?.stalled).toBe(true);

    const alive = await grove.toolCalls.progress(agent.id, "build", {});
    expect(alive.stalled).toBe(false);
    expect(alive.progress).toBeNull();

    const p = await grove.toolCalls.progress(agent.id, "build", { done: 3, total: 12 });
    expect(p.progress).toBeCloseTo(0.25);
    expect(p.progressDone).toBe(3);
    expect(p.progressTotal).toBe(12);
    // A later bare keep-alive keeps the last real numbers rather than erasing them.
    const again = await grove.toolCalls.progress(agent.id, "build", {});
    expect(again.progressDone).toBe(3);
  });

  it("refuses an agent-claimed `stalled` and an unknown call", async () => {
    const agent = await newInhabitant(`liar${tag()}`);
    await grove.toolCalls.start(agent.id, { callId: "c1", name: "Read" });
    await expect(grove.toolCalls.finish(agent.id, "c1", { outcome: "stalled" })).rejects.toThrow(/outcome/);
    await expect(grove.toolCalls.finish(agent.id, "nope", { outcome: "ok" })).rejects.toThrow(/No tool call/);
    await expect(grove.toolCalls.start(agent.id, { name: "" })).rejects.toThrow(/name/);
  });

  it("strips secrets from the caption before it is stored", async () => {
    const agent = await newInhabitant(`secret${tag()}`);
    const v = await grove.toolCalls.start(agent.id, {
      name: "Bash",
      args: "curl -H 'Authorization: Bearer supersecretvalue123' https://x",
    });
    expect(v.args).not.toContain("supersecretvalue123");
    const { rows } = await pg.query("SELECT args FROM tool_calls WHERE actor_id = $1", [agent.id]);
    expect(String(rows[0].args)).not.toContain("supersecretvalue123");
  });

  it("does not hand a body back to `think` while another call is still open", async () => {
    const agent = await newInhabitant(`para${tag()}`);
    await grove.toolCalls.start(agent.id, { callId: "p1", name: "Read", args: "a.ts" });
    await grove.toolCalls.start(agent.id, { callId: "p2", name: "Grep", args: "TODO" });
    await grove.toolCalls.finish(agent.id, "p2", { outcome: "ok" });
    let presence = await grove.presence.getPresence(agent.id);
    expect(presence?.verb).toBe("tool");
    await grove.toolCalls.finish(agent.id, "p1", { outcome: "error", result: "ENOENT" });
    presence = await grove.presence.getPresence(agent.id);
    expect(presence?.verb).toBe("think");
  });

  it("leaves a verb the agent set in the meantime alone", async () => {
    const agent = await newInhabitant(`blk${tag()}`);
    await grove.toolCalls.start(agent.id, { callId: "b1", name: "Bash" });
    await clearActorLimiters(redis, agent.id);
    await grove.presence.pulse(agent.id, "blocked", "need a human", { errorText: "permission prompt" });
    await grove.toolCalls.finish(agent.id, "b1", { outcome: "cancelled" });
    const presence = await grove.presence.getPresence(agent.id);
    expect(presence?.verb).toBe("blocked");
  });

  it("sweeps a silent span to `stalled`, ending it at the last moment anything was known, and a late finish still wins", async () => {
    const agent = await newInhabitant(`sweep${tag()}`);
    await grove.toolCalls.start(agent.id, { callId: "s1", name: "Bash", args: "long build" });
    await pg.query(
      "UPDATE tool_calls SET started_at = now() - interval '20 minutes', updated_at = now() - interval '15 minutes' WHERE actor_id = $1",
      [agent.id],
    );
    await grove.toolCalls.sweep();
    const { rows } = await pg.query(
      "SELECT outcome, extract(epoch FROM finished_at - updated_at)::int AS tail FROM tool_calls WHERE actor_id = $1",
      [agent.id],
    );
    expect(rows[0].outcome).toBe("stalled");
    expect(rows[0].tail).toBe(STALL_AFTER_SECONDS);

    const late = await grove.toolCalls.finish(agent.id, "s1", { outcome: "ok" });
    expect(late.outcome).toBe("ok");
  });

  it("publishes open spans and recent outcomes on the minimap, with the stance", async () => {
    const agent = await newInhabitant(`mini${tag()}`);
    await grove.toolCalls.start(agent.id, { callId: "m1", name: "Bash", args: "open one" });
    await grove.toolCalls.start(agent.id, { callId: "m2", name: "Edit", args: "done one" });
    await grove.toolCalls.finish(agent.id, "m2", { outcome: "ok" });
    const map = await grove.world.minimap();
    const body = map.bodies.find((b) => b.id === agent.id);
    expect(body).toBeTruthy();
    expect(body!.stance).toBe("hang_out");
    const byId = new Map(body!.toolCalls.map((t) => [t.callId, t]));
    expect(byId.get("m1")?.outcome).toBeNull();
    expect(byId.get("m2")?.outcome).toBe("ok");
    // Open first.
    expect(body!.toolCalls[0]!.callId).toBe("m1");
  });
});
