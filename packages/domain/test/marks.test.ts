/**
 * Achievement marks on plots (migration 030). The properties that matter:
 *  - a pruned span is folded into its space's durable tally in the same
 *    statement, so lifetime counts survive the seven-day prune exactly;
 *  - `thousand_calls` needs 1,000 lifetime calls on the space's ground, and
 *    `week_streak` seven consecutive UTC days, whether those days are in the
 *    tally or still live;
 *  - a mark is earned once and kept when the live spans behind it vanish;
 *  - the minimap publishes mark KEYS only, and none at all for a private plot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  assertTestDatabase,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.marks;
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("achievement marks on plots", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the marks suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      await redis.quit();
      await pg.end();
    }
  });

  async function newSpace(preset: "private" | "public_view" | "public_write") {
    const email = `marks-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    const t = tag();
    const space = await grove.campus.createWorld(human, { name: `Mark Yard ${t}`, slug: `markyard-${t}`, preset });
    fixtures.trackWorld(space.id);
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name: `marker${t}`, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, human);
    return { space, agent };
  }

  /** `n` finished spans in the space's plaza, started `daysAgo` UTC days back (noon). */
  async function spans(agentId: string, worldId: string, n: number, daysAgo: number) {
    await pg.query(
      `INSERT INTO tool_calls (id, actor_id, call_id, room_id, name, started_at, updated_at, finished_at, outcome)
       SELECT 'tc_mk_' || md5(random()::text || g), $1, 'mk_' || md5(random()::text || g), $2, 'Bash', ts, ts, ts, 'ok'
         FROM generate_series(1, $3::int) g,
              LATERAL (SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                              - make_interval(days => $4::int) + interval '12 hours' AS ts) x`,
      [agentId, `${worldId}:plaza`, n, daysAgo],
    );
  }

  const marksOf = async (worldId: string) =>
    (await pg.query(`SELECT mark FROM space_marks WHERE world_id = $1 ORDER BY mark`, [worldId])).rows.map((r) => r.mark);
  const mapMarks = async (worldId: string) => (await grove.world.minimap()).spaces.find((s) => s.id === worldId)?.marks;

  it("counts pruned spans into the durable tally exactly once, and awards a thousand calls across tally + live", async () => {
    const { space, agent } = await newSpace("public_write");
    await spans(agent.id, space.id, 600, 9);
    await spans(agent.id, space.id, 399, 1);

    const pruned = await grove.toolCalls.marks.pruneIntoTally(7);
    expect(pruned).toBeGreaterThanOrEqual(600);
    const { rows } = await pg.query(`SELECT sum(calls)::int AS n FROM tool_call_daily WHERE world_id = $1`, [space.id]);
    expect(rows[0].n).toBe(600);
    // Pruning again forgets nothing twice.
    await grove.toolCalls.marks.pruneIntoTally(7);
    expect((await pg.query(`SELECT sum(calls)::int AS n FROM tool_call_daily WHERE world_id = $1`, [space.id])).rows[0].n).toBe(600);

    await grove.toolCalls.marks.evaluate();
    expect(await marksOf(space.id)).toEqual([]);
    expect(await mapMarks(space.id)).toEqual([]);

    await spans(agent.id, space.id, 1, 0);
    await grove.toolCalls.marks.evaluate();
    expect(await marksOf(space.id)).toEqual(["thousand_calls"]);
    expect(await mapMarks(space.id)).toEqual(["thousand_calls"]);

    // Earned once: the live spans vanishing (an agent deleted) takes nothing back.
    await pg.query(`DELETE FROM tool_calls WHERE actor_id = $1`, [agent.id]);
    await pg.query(`DELETE FROM tool_call_daily WHERE world_id = $1`, [space.id]);
    await grove.toolCalls.marks.evaluate();
    expect(await marksOf(space.id)).toEqual(["thousand_calls"]);
  });

  it("awards a week streak for seven consecutive UTC days, not for seven days with a gap", async () => {
    const streak = await newSpace("public_view");
    const gappy = await newSpace("public_view");
    // Days 12..9 end up in the tally, 8..6 stay live: one run of seven.
    for (let d = 12; d >= 6; d--) await spans(streak.agent.id, streak.space.id, 1, d);
    // Seven days, but day 9 is missing.
    for (const d of [13, 12, 11, 10, 8, 7, 6]) await spans(gappy.agent.id, gappy.space.id, 1, d);
    await pg.query(`UPDATE tool_calls SET finished_at = now() WHERE actor_id = ANY($1) AND started_at > now() - interval '9 days'`, [
      [streak.agent.id, gappy.agent.id],
    ]);
    await grove.toolCalls.marks.pruneIntoTally(7);
    await grove.toolCalls.marks.evaluate();
    expect(await marksOf(streak.space.id)).toEqual(["week_streak"]);
    expect(await marksOf(gappy.space.id)).toEqual([]);
    const map = await grove.world.minimap();
    expect(map.spaces.find((s) => s.id === streak.space.id)?.marks).toEqual(["week_streak"]);
  });

  it("never publishes a private plot's marks, and publishes keys, never counts", async () => {
    const { space, agent } = await newSpace("private");
    await spans(agent.id, space.id, 1000, 0);
    await grove.toolCalls.marks.evaluate();
    expect(await marksOf(space.id)).toEqual(["thousand_calls"]);
    const row = (await grove.world.minimap()).spaces.find((s) => s.id === space.id)!;
    expect(row.marks).toEqual([]);
    expect(row.name).toBeNull();
    expect(JSON.stringify(row)).not.toContain("1000");
  });

  it("sweep folds the prune into the tally", async () => {
    const { space, agent } = await newSpace("public_write");
    await spans(agent.id, space.id, 3, 10);
    await grove.toolCalls.sweep();
    const { rows } = await pg.query(`SELECT sum(calls)::int AS n FROM tool_call_daily WHERE world_id = $1`, [space.id]);
    expect(rows[0].n).toBe(3);
  });
});
