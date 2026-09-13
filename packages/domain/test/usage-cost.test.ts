import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import type { Human } from "@grove/protocol";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  budgetVerdict,
  normaliseUsageBody,
  normaliseUsageReport,
  USAGE_MAX_REPORTS,
} from "../src/services/usage.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.usageCost;
const hasDb = hasTestDatabase();

// ---------------------------------------------------------------------------
// Pure rules. No database.
// ---------------------------------------------------------------------------

describe("usage report validation", () => {
  const NOW = Date.parse("2026-09-13T12:00:00Z");

  it("converts cost_usd to integer micro-dollars", () => {
    const r = normaliseUsageReport({ model: "claude-haiku", inputTokens: 1200, costUsd: 0.000137 }, NOW);
    expect(r.costMicros).toBe(137);
    expect(r.inputTokens).toBe(1200);
    expect(r.outputTokens).toBeNull();
  });

  it("keeps an omitted cost as null — unknown is not zero", () => {
    const r = normaliseUsageReport({ outputTokens: 50 }, NOW);
    expect(r.costMicros).toBeNull();
  });

  it("keeps a reported zero as a real zero (a free local model)", () => {
    expect(normaliseUsageReport({ costMicros: 0 }, NOW).costMicros).toBe(0);
  });

  it("accepts Anthropic's usage field names as aliases", () => {
    const r = normaliseUsageReport({ cacheReadInputTokens: 900, cacheCreationInputTokens: 40, inputTokens: 3 }, NOW);
    expect(r.cacheReadTokens).toBe(900);
    expect(r.cacheWriteTokens).toBe(40);
  });

  it("refuses an empty report, negatives, fractions, and a disagreeing pair", () => {
    for (const bad of [
      {},
      { model: "x" },
      { inputTokens: -1 },
      { outputTokens: 1.5 },
      { costUsd: -0.01 },
      { costMicros: 100, costUsd: 0.5 },
      { costUsd: "lots" },
    ]) {
      expect(() => normaliseUsageReport(bad, NOW)).toThrowError();
    }
  });

  it("refuses a currency it cannot add up", () => {
    expect(() => normaliseUsageReport({ costUsd: 1, currency: "EUR" }, NOW)).toThrowError(/USD/);
    expect(normaliseUsageReport({ costUsd: 1, currency: "usd" }, NOW).costMicros).toBe(1_000_000);
  });

  it("needs a session to accumulate against", () => {
    expect(() => normaliseUsageReport({ cumulative: true, costUsd: 1 }, NOW)).toThrowError(/session_id/);
  });

  it("bounds occurred_at to the last week and a little skew", () => {
    expect(() => normaliseUsageReport({ costUsd: 1, occurredAt: "2026-09-01T00:00:00Z" }, NOW)).toThrowError(/7 days/);
    expect(() => normaliseUsageReport({ costUsd: 1, occurredAt: "2026-09-13T13:00:00Z" }, NOW)).toThrowError(/future/);
    expect(normaliseUsageReport({ costUsd: 1, occurredAt: "2026-09-12T23:00:00Z" }, NOW).occurredAt.toISOString()).toBe(
      "2026-09-12T23:00:00.000Z",
    );
  });

  it("batches, and caps the batch", () => {
    expect(normaliseUsageBody({ reports: [{ costUsd: 1 }, { inputTokens: 2 }] }, NOW)).toHaveLength(2);
    expect(() =>
      normaliseUsageBody({ reports: Array.from({ length: USAGE_MAX_REPORTS + 1 }, () => ({ costUsd: 1 })) }, NOW),
    ).toThrowError(/At most/);
  });
});

describe("budget verdict", () => {
  const base = { monthUncostedReports: 0, monthElapsed: 0.5 };
  it("reads none without a budget and unknown with no priced spend", () => {
    expect(budgetVerdict({ ...base, monthlyMicros: null, monthToDateMicros: 5 }).state).toBe("none");
    expect(budgetVerdict({ ...base, monthlyMicros: 1_000_000, monthToDateMicros: null }).state).toBe("unknown");
  });
  it("ok, near at 80%, over at 100%", () => {
    expect(budgetVerdict({ ...base, monthlyMicros: 1_000_000, monthToDateMicros: 799_999 }).state).toBe("ok");
    expect(budgetVerdict({ ...base, monthlyMicros: 1_000_000, monthToDateMicros: 800_000 }).state).toBe("near");
    expect(budgetVerdict({ ...base, monthlyMicros: 1_000_000, monthToDateMicros: 1_000_000 }).state).toBe("over");
  });
  it("projects straight-line only for the current month", () => {
    expect(budgetVerdict({ ...base, monthlyMicros: 1, monthToDateMicros: 300 }).projectedMicros).toBe(600);
    expect(
      budgetVerdict({ monthUncostedReports: 0, monthElapsed: null, monthlyMicros: 1, monthToDateMicros: 300 })
        .projectedMicros,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The ledger, the rollups and the gate.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)("cost burn ledger (migration 024)", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  async function newHuman(prefix: string): Promise<Human> {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function newAgent(owner: Human, name: string, room = "plaza", worldId?: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner as never);
    await clearActorLimiters(redis, agent.id);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, room, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      overflowPlaza: room === "plaza",
      ...(worldId ? { worldId } : {}),
    });
    return agent;
  }

  const report = (agent: Parameters<GroveApp["usage"]["record"]>[0], body: Record<string, unknown>) =>
    grove.usage.record(agent, normaliseUsageBody(body));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the cost burn suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    await fixtures.cleanup();
    await pg?.end();
    await redis?.quit();
  });

  it("adds a day up, and a day with no price reads not reported rather than $0", async () => {
    const owner = await newHuman("burn");
    const agent = await newAgent(owner, `burner${tag()}`);

    // Nothing priced yet: tokens only.
    await report(agent, { model: "m-small", inputTokens: 1000, outputTokens: 200 });
    let day = await grove.usage.day(owner);
    expect(day.totals.reports).toBe(1);
    expect(day.totals.costMicros).toBeNull();
    expect(day.totals.uncostedReports).toBe(1);
    expect(day.ownedAgents).toBe(1);

    await report(agent, { reports: [
      { model: "m-small", inputTokens: 500, costUsd: 0.0125 },
      { model: "m-large", outputTokens: 40, costMicros: 90_000 },
    ] });
    day = await grove.usage.day(owner);
    expect(day.totals.costMicros).toBe(102_500);
    expect(day.totals.costedReports).toBe(2);
    expect(day.totals.uncostedReports).toBe(1);
    expect(day.totals.inputTokens).toBe(1500);

    const small = day.byModel.find((m) => m.model === "m-small")!;
    expect(small.costMicros).toBe(12_500);
    expect(small.uncostedReports).toBe(1);
    expect(day.byAgent).toHaveLength(1);
    expect(day.byAgent[0]!.agentId).toBe(agent.id);

    // The hours tile the day exactly.
    expect(day.byHour).toHaveLength(24);
    const hourly = day.byHour.reduce((n, h) => n + (h.costMicros ?? 0), 0);
    expect(hourly).toBe(102_500);
    expect(day.byHour.reduce((n, h) => n + h.inputTokens, 0)).toBe(1500);
  });

  it("counts a retried report once", async () => {
    const owner = await newHuman("retry");
    const agent = await newAgent(owner, `retrier${tag()}`);
    const first = await report(agent, { id: "turn-1", costUsd: 0.5 });
    const again = await report(agent, { id: "turn-1", costUsd: 0.5 });
    expect(first[0]!.duplicate).toBe(false);
    expect(again[0]!.duplicate).toBe(true);
    expect((await grove.usage.day(owner)).totals.costMicros).toBe(500_000);
  });

  it("turns a running session total into increments, and never re-counts a stale one", async () => {
    const owner = await newHuman("cumul");
    const agent = await newAgent(owner, `statusline${tag()}`);
    const s = { cumulative: true, sessionId: `sess-${tag()}` };
    await report(agent, { ...s, costUsd: 0.1, inputTokens: 100 });
    await report(agent, { ...s, costUsd: 0.25, inputTokens: 150 });
    // Arrives late, lower than what we already have: adds nothing.
    const stale = await report(agent, { ...s, costUsd: 0.2, inputTokens: 120 });
    expect(stale[0]!.unchanged).toBe(true);
    // Tokens moved but no cost in this report: the increment is unpriced, not free.
    const unpriced = await report(agent, { ...s, inputTokens: 180 });
    expect(unpriced[0]!.costMicros).toBeNull();
    const day = await grove.usage.day(owner);
    expect(day.totals.costMicros).toBe(250_000);
    expect(day.totals.inputTokens).toBe(180);
    expect(day.totals.uncostedReports).toBe(1);
  });

  it("shows a private space's spend to its members and nobody else", async () => {
    const owner = await newHuman("plotowner");
    const space = await grove.campus.createWorld(owner, { name: "Vault", slug: `vault-${tag()}`, preset: "private" });
    fixtures.trackWorld(space.id);
    const insider = await newAgent(owner, `insider${tag()}`, `${space.id}:plaza`, space.id);
    await report(insider, { costUsd: 2 });

    const member = await newHuman("member");
    await grove.campus.addMember(space.id, member.id);
    const stranger = await newHuman("stranger");

    // A member of the space reads the space's spend.
    const asMember = await grove.usage.day(member, { scope: `space:${space.id}` });
    expect(asMember.totals.costMicros).toBe(2_000_000);

    // A stranger cannot open the space scope, nor the agent, and gets nothing
    // by guessing — the same NOT_FOUND an absent space gives.
    await expect(grove.usage.day(stranger, { scope: `space:${space.id}` })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(grove.usage.day(stranger, { scope: `agent:${insider.id}` })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(grove.usage.day(member, { scope: `agent:${insider.id}` })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The commons' spend is everyone's spend at once: operators only.
    await expect(grove.usage.day(owner, { scope: "space:aetheria-prime" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // An org is not a way into a private plot. The stranger shares an org with
    // the owner: commons spend is shared, the private plot's is not.
    const org = await grove.campus.createOrg(owner, { name: "Guild", slug: `guild-${tag()}` });
    fixtures.trackOrg(org.id);
    await grove.campus.addOrgMember(owner, org.id, stranger.id);
    const commons = await newAgent(owner, `commoner${tag()}`);
    await report(commons, { costUsd: 0.3 });

    const orgView = await grove.usage.day(stranger, { scope: `org:${org.slug}` });
    expect(orgView.totals.costMicros).toBe(300_000);
    expect(orgView.byAgent.map((a) => a.agentId)).toEqual([commons.id]);
    // And a fellow org member never sees another owner's budget.
    expect(orgView.byAgent[0]!.budget).toBeNull();

    const ownerOrgView = await grove.usage.day(owner, { scope: `org:${org.id}` });
    expect(ownerOrgView.totals.costMicros).toBe(2_300_000);

    const operator = { ...(await newHuman("op")), role: "operator" as const };
    const opView = await grove.usage.day(operator, { scope: `space:${space.id}` });
    expect(opView.totals.costMicros).toBe(2_000_000);
  });

  it("burns against an optional monthly budget and warns near and over", async () => {
    const owner = await newHuman("budget");
    const agent = await newAgent(owner, `spender${tag()}`);
    const stranger = await newHuman("meddler");
    await expect(grove.usage.setBudget(stranger, agent.id, 1_000_000)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(grove.usage.setBudget(owner, agent.id, 0)).rejects.toMatchObject({ code: "INVALID" });

    expect(await grove.usage.setBudget(owner, agent.id, 1_000_000)).toBe(1_000_000);
    let day = await grove.usage.day(owner);
    // A budget with nothing priced this month is unknown, not fine.
    expect(day.byAgent).toHaveLength(0);
    await report(agent, { inputTokens: 10 });
    day = await grove.usage.day(owner);
    expect(day.byAgent[0]!.budget!.state).toBe("unknown");

    await report(agent, { costUsd: 0.85 });
    day = await grove.usage.day(owner);
    expect(day.byAgent[0]!.budget!.state).toBe("near");
    expect(day.budgetAlerts.map((a) => a.agentId)).toEqual([agent.id]);

    await report(agent, { costUsd: 0.2 });
    day = await grove.usage.day(owner);
    expect(day.byAgent[0]!.budget).toMatchObject({ state: "over", monthToDateMicros: 1_050_000, monthlyMicros: 1_000_000 });

    expect(await grove.usage.setBudget(owner, agent.id, null)).toBeNull();
    day = await grove.usage.day(owner);
    expect(day.byAgent[0]!.budget!.state).toBe("none");
    expect(day.budgetAlerts).toHaveLength(0);
  });

  it("puts a deposit on the minimap body with no amount on it", async () => {
    const owner = await newHuman("carrier");
    const agent = await newAgent(owner, `carrier${tag()}`);
    await report(agent, { costUsd: 0.42 });
    const map = await grove.world.minimap();
    const body = map.bodies.find((b) => b.id === agent.id)!;
    expect(body.deposit).toMatchObject({ costed: true });
    // Not a bare /42/: the body carries a random ULID id and avatar, and
    // "42" turns up in one about one run in seven. Look for the amount the
    // ways it could actually leak: dollars, micros, or a cost key.
    expect(JSON.stringify(body)).not.toMatch(/\b0?\.42\b|420000|cost_?micros|costUsd/i);

    const quiet = await newAgent(owner, `quiet${tag()}`);
    await report(quiet, { outputTokens: 5 });
    const again = await grove.world.minimap();
    expect(again.bodies.find((b) => b.id === quiet.id)!.deposit).toMatchObject({ costed: false });
  });

  it("refuses a malformed day and an unknown scope", async () => {
    const owner = await newHuman("scope");
    await expect(grove.usage.day(owner, { day: "yesterday" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(grove.usage.day(owner, { day: "2999-01-01" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(grove.usage.day(owner, { scope: "everyone" })).rejects.toMatchObject({ code: "INVALID" });
  });
});
