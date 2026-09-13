/**
 * Follows: a heart on a space or an agent.
 *
 * The properties that matter:
 *  - a private space is behind its door: a non-member cannot follow it (404,
 *    identical to no such space), and unfollowing never answers with its name;
 *  - a followed agent's error, and a long tool call finishing, reach followers
 *    once (a fault loop is folded) — humans in their inbox, agents in the mailbox;
 *  - activity in a private space never reaches a follower who is not a member,
 *    including one who lost membership after following; a block silences it;
 *  - a followed space opening a Stage event tells its followers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { GroveError } from "../src/errors.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.follows;
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("follows and their notices", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the follows suite");
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

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, name: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    return grove.identity.claimAgent(reg.agent.id, owner);
  }

  async function notFound(p: Promise<unknown>) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GroveError);
    expect((err as GroveError).code).toBe("NOT_FOUND");
  }

  const kinds = async (humanId: string) => (await grove.follows.notices(humanId)).items.map((i) => i.kind);

  it("keeps a private space's heart behind its door", async () => {
    const owner = await newHuman("fol-owner");
    const member = await newHuman("fol-member");
    const stranger = await newHuman("fol-stranger");
    const space = await grove.campus.createWorld(owner, { name: `Cove ${tag()}`, slug: `cove-${tag()}`, preset: "private" });
    fixtures.trackWorld(space.id);
    await grove.campus.addMember(space.id, member.id);

    const followed = await grove.follows.setFollow({ kind: "human", human: member }, "space", space.slug, true);
    expect(followed).toMatchObject({ following: true, followers: 1, name: space.name });
    // Idempotent.
    expect((await grove.follows.setFollow({ kind: "human", human: member }, "space", space.id, true)).followers).toBe(1);

    await notFound(grove.follows.setFollow({ kind: "human", human: stranger }, "space", space.slug, true));
    await notFound(grove.follows.setFollow({ kind: "human", human: stranger }, "space", space.id, false));
    await notFound(grove.follows.state({ kind: "human", human: stranger }, "space", space.slug));
    await notFound(grove.follows.state(null, "space", space.id));
    await notFound(grove.follows.state(null, "space", `no-such-${tag()}`));
    await expect(grove.follows.state(null, "person", "x")).rejects.toMatchObject({ code: "INVALID" });

    expect((await grove.follows.listMine({ kind: "human", human: member })).map((f) => f.id)).toEqual([space.id]);
    const off = await grove.follows.setFollow({ kind: "human", human: member }, "space", space.slug, false);
    expect(off).toMatchObject({ following: false, followers: 0 });
  });

  it("tells followers when an agent errors or finishes a long call, once per fault loop", async () => {
    const owner = await newHuman("fol-agent-owner");
    const fan = await newHuman("fol-fan");
    const agent = await newAgent(owner, `watched${tag()}`);
    const listener = await newAgent(owner, `listener${tag()}`);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "workshop", {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
    });
    await grove.follows.setFollow({ kind: "human", human: fan }, "agent", agent.slug, true);
    await grove.follows.setFollow({ kind: "agent", agent: listener }, "agent", agent.id, true);
    await expect(grove.follows.setFollow({ kind: "agent", agent }, "agent", agent.id, true)).rejects.toMatchObject({ code: "INVALID" });

    await clearActorLimiters(redis, agent.id);
    await grove.presence.pulse(agent.id, "error", "build broke", { errorText: "tsc exited 2" });
    await clearActorLimiters(redis, agent.id);
    await grove.presence.pulse(agent.id, "error", "still broke");
    const after = await grove.follows.notices(fan.id);
    expect(after.items.map((i) => i.kind)).toEqual(["agent.error"]);
    expect(after.unread).toBe(1);
    expect(after.items[0]!.payload.subject).toEqual({ kind: "agent", slug: agent.slug, name: agent.displayName });
    const mail = await grove.mailbox.listUnread(listener.id);
    expect(mail.map((m) => m.kind)).toEqual(["follow.agent.error"]);

    // A short call says nothing; a long one does, without its args or result.
    await clearActorLimiters(redis, agent.id);
    await grove.toolCalls.start(agent.id, { callId: `s${tag()}`, name: "Read", args: "short" });
    const long = `l${tag()}`;
    await clearActorLimiters(redis, agent.id);
    await grove.toolCalls.start(agent.id, { callId: long, name: "Bash", args: "pnpm build --secret-ish" });
    await pg.query(`UPDATE tool_calls SET started_at = now() - interval '3 minutes' WHERE actor_id = $1 AND call_id = $2`, [agent.id, long]);
    await clearActorLimiters(redis, agent.id);
    await grove.toolCalls.finish(agent.id, long, { outcome: "ok", result: "private output" });
    const notices = await grove.follows.notices(fan.id);
    expect(notices.items.map((i) => i.kind)).toEqual(["agent.long_tool_call", "agent.error"]);
    expect(notices.items[0]!.payload.tool).toMatchObject({ name: "Bash", outcome: "ok" });
    expect(JSON.stringify(notices)).not.toContain("secret-ish");
    expect(JSON.stringify(notices)).not.toContain("private output");

    expect(await grove.follows.markSeen(fan.id)).toBe(2);
    expect((await grove.follows.notices(fan.id)).unread).toBe(0);
  });

  it("never tells a non-member what an agent did inside a private space, and honours a block", async () => {
    const owner = await newHuman("fol-priv-owner");
    const member = await newHuman("fol-priv-member");
    const outsider = await newHuman("fol-priv-outsider");
    const blocked = await newHuman("fol-priv-blocked");
    const agent = await newAgent(owner, `vaulted${tag()}`);
    const space = await grove.campus.createWorld(owner, { name: `Keep ${tag()}`, slug: `keep-${tag()}`, preset: "private" });
    fixtures.trackWorld(space.id);
    await grove.campus.addMember(space.id, member.id);

    // All three follow the agent while it is out in the commons.
    for (const h of [member, outsider, blocked]) {
      await grove.follows.setFollow({ kind: "human", human: h }, "agent", agent.slug, true);
    }
    await pg.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [blocked.id, agent.id]);

    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, `${space.id}:plaza`, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      worldId: space.id,
    });
    await clearActorLimiters(redis, agent.id);
    await grove.presence.pulse(agent.id, "error", "vault fault", { errorText: "vault-secret" });

    expect(await kinds(member.id)).toEqual(["agent.error"]);
    expect(await kinds(outsider.id)).toEqual([]);
    expect(await kinds(blocked.id)).toEqual([]);

    // Losing membership stops the notices: the door is asked on every event.
    await pg.query(`DELETE FROM world_members WHERE world_id = $1 AND human_id = $2`, [space.id, member.id]);
    await redis.del(`follow:cool:agent.error:${agent.id}`);
    await clearActorLimiters(redis, agent.id);
    await grove.presence.pulse(agent.id, "error", "again");
    expect(await kinds(member.id)).toEqual(["agent.error"]);
  });

  it("tells a space's followers when its Stage opens an event", async () => {
    const owner = await newHuman("fol-stage-owner");
    const fan = await newHuman("fol-stage-fan");
    const space = await grove.campus.createWorld(owner, { name: `Hall ${tag()}`, slug: `hall-${tag()}`, preset: "public_view" });
    fixtures.trackWorld(space.id);
    await grove.follows.setFollow({ kind: "human", human: fan }, "space", space.slug, true);

    await grove.campus.createEvent(owner, {
      worldId: space.id,
      title: "Opening night",
      startsAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await grove.campus.stageNow(space.id);
    await grove.campus.stageNow(space.id);
    const n = await grove.follows.notices(fan.id);
    expect(n.items.map((i) => i.kind)).toEqual(["space.stage_started"]);
    expect(n.items[0]!.payload.stage?.title).toBe("Opening night");

    // Made private with the fan outside: the next event says nothing to them.
    await grove.campus.updateWorld(owner, space.id, { policyPreset: "private" });
    await grove.campus.createEvent(owner, {
      worldId: space.id,
      title: "Closed session",
      startsAt: new Date(Date.now() - 30_000).toISOString(),
    });
    await grove.campus.stageNow(space.id);
    expect(await kinds(fan.id)).toEqual(["space.stage_started"]);
  });
});
