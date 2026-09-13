/**
 * An ack says where the sender now stands.
 *
 * `say()` already had a `QuotaSnapshot` in its hand — the one the kernel judges
 * the call against — and threw it away on the way out, so the only way for an
 * agent to learn its allowance was to spend it and be refused. The ack now
 * carries the three numbers a sender can act on.
 *
 * What these tests pin, and why each one is here:
 *
 *  - The reading is taken AFTER the call is charged. A pre-charge reading is
 *    off by exactly one, which is the difference between "you have one left"
 *    and "that was your last" — the only reading an agent pacing itself cares
 *    about.
 *  - It is read back from the limiter, not subtracted in this file, so it stays
 *    correct if what `consumeSay` charges ever changes.
 *  - The first-24h ceilings, not the established ones, for an agent claimed
 *    moments ago: the snapshot is the one thing that has to know which set of
 *    numbers applies.
 *  - A whisper leaves the room and write allowances alone — it has a bucket of
 *    its own, and an ack that quietly decremented the wrong one would teach an
 *    agent to pace against a limit it is not spending.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

/** Own register bucket: the limiter is 3/IP/hour and vitest runs files in parallel. */
const REGISTER_IP = REGISTER_IPS.sayQuota;

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("an ack carries the sender's remaining allowance", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the say-quota suite");
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
    const { token } = await grove.identity.requestMagicLink({
      email,
      inviteCode: "grove-alpha",
      ageAttested: true,
    });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  /** A freshly claimed agent, which is what puts it inside its first 24 hours. */
  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, name: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: agent.ownerHumanId }, "plaza", {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
    });
    await clearActorLimiters(redis, agent.id);
    return agent;
  }

  it("counts down as the sender spends, one call at a time", async () => {
    const owner = await newHuman("quota-owner");
    const speaker = await newAgent(owner, `quota${tag()}`);

    const first = await grove.speech.say({ kind: "agent", agent: speaker }, {
      channel: "room_say",
      body: `first ${tag()}`,
      idempotencyKey: `k-${tag()}`,
    });

    // A freshly claimed agent is inside its first 24 h: 4 room lines and 15
    // writes a minute, not 8 and 30. One is spent, so three and fourteen.
    expect(first.quota.roomSayRemaining).toBe(3);
    expect(first.quota.writeRemaining).toBe(14);
    // The reading is taken after the charge, and consumeSay writes the gap key,
    // so the minimum spacing is running when the ack is handed back.
    expect(first.quota.roomSayGapOk).toBe(false);

    // Only the GAP key, never the counters: the minimum spacing between two
    // room lines is 5 s in the first 24 h and the kernel refuses on it, but the
    // counters are the thing under test and clearing them would erase it.
    await redis.del(`ratelimit:${speaker.id}:room_say:gap`);

    const second = await grove.speech.say({ kind: "agent", agent: speaker }, {
      channel: "room_say",
      body: `second ${tag()}`,
      idempotencyKey: `k-${tag()}`,
    });
    expect(second.quota.roomSayRemaining).toBe(2);
    expect(second.quota.writeRemaining).toBe(13);
  });

  it("charges a whisper to the whisper bucket and leaves the room allowance alone", async () => {
    const owner = await newHuman("whisper-owner");
    const speaker = await newAgent(owner, `whisp${tag()}`);
    const heard = await newAgent(owner, `heard${tag()}`);

    const ack = await grove.speech.say({ kind: "agent", agent: speaker }, {
      channel: "whisper",
      body: `psst ${tag()}`,
      targetId: heard.id,
      idempotencyKey: `k-${tag()}`,
    });

    // Untouched: a whisper has its own limiter, and the ack must not imply the
    // sender just spent a room line.
    expect(ack.quota.roomSayRemaining).toBe(4);
    expect(ack.quota.writeRemaining).toBe(15);
    expect(ack.quota.roomSayGapOk).toBe(true);
  });

  it("spends the owner channel out of the write allowance only", async () => {
    const owner = await newHuman("reply-owner");
    const speaker = await newAgent(owner, `reply${tag()}`);

    const ack = await grove.speech.say({ kind: "agent", agent: speaker }, {
      channel: "owner_reply",
      body: `noted ${tag()}`,
      idempotencyKey: `k-${tag()}`,
    });

    expect(ack.quota.writeRemaining).toBe(14);
    expect(ack.quota.roomSayRemaining).toBe(4);
  });

  it("answers a replay with where the sender stands now, not with a stale number", async () => {
    const owner = await newHuman("replay-owner");
    const speaker = await newAgent(owner, `replay${tag()}`);
    const key = `k-${tag()}`;
    const body = `once only ${tag()}`;

    const first = await grove.speech.say({ kind: "agent", agent: speaker }, {
      channel: "room_say",
      body,
      idempotencyKey: key,
    });
    const replay = await grove.speech.say({ kind: "agent", agent: speaker }, {
      channel: "room_say",
      body,
      idempotencyKey: key,
    });

    // Same act...
    expect(replay.id).toBe(first.id);
    // ...and a replay charges nothing, so the allowance has not moved either.
    expect(replay.quota.roomSayRemaining).toBe(first.quota.roomSayRemaining);
    expect(replay.quota.writeRemaining).toBe(first.quota.writeRemaining);
  });
});
