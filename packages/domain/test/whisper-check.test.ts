/**
 * The room compose asks "can I whisper to this one?" before it lets you send.
 *
 * The property that matters is AGREEMENT: the check must say exactly what the
 * whisper itself would have said. A check that answered from badges, or that
 * re-derived the refusal its own way, would promise delivery to an ear the
 * kernel then closes — shout-and-hope again, with a green light on it.
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

const REGISTER_IP = REGISTER_IPS.whisperCheck;
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("whisper check agrees with the whisper", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the whisper check suite");
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

  async function speechRows(senderId: string) {
    const { rows } = await pg.query(`SELECT id FROM speech WHERE sender_id = $1`, [senderId]);
    return rows.length;
  }

  it("allows a whisper to an agent that listens to people, and writes nothing", async () => {
    const owner = await newHuman("wc-owner");
    const visitor = await newHuman("wc-visitor");
    const agent = await newAgent(owner, `wcear${tag()}`);
    await grove.presence.enter({ id: visitor.id, kind: "human" }, "library", {
      connection: "live",
      mode: "active",
      activity: "idle",
    });

    const before = await speechRows(visitor.id);
    const check = await grove.speech.checkWhisper({ kind: "human", human: visitor }, agent.id);
    expect(check).toEqual({ allowed: true, refusal: null });
    expect(await speechRows(visitor.id)).toBe(before);
    expect(await redis.keys(`ratelimit:${visitor.id}:whisper:*`)).toEqual([]);
  });

  it("refuses up front with the same entry the whisper puts in undelivered[]", async () => {
    const owner = await newHuman("wc-deaf-owner");
    const visitor = await newHuman("wc-deaf-visitor");
    const agent = await newAgent(owner, `wcdeaf${tag()}`);
    await grove.identity.patchPolicy(agent.id, owner, { listenToHumans: false });

    const check = await grove.speech.checkWhisper({ kind: "human", human: visitor }, agent.id);
    expect(check.allowed).toBe(false);
    expect(check.refusal).toMatchObject({
      actorId: agent.id,
      code: "PERMISSION_DENIED",
      capability: "listen_to_humans",
      source: "actor",
      subject: "recipient",
    });

    await clearActorLimiters(redis, visitor.id);
    const ack = await grove.speech.say({ kind: "human", human: visitor }, {
      channel: "whisper",
      targetId: agent.id,
      body: `are you there ${tag()}`,
      idempotencyKey: `k-${tag()}`,
    });
    expect(ack.deliveredCount).toBe(0);
    expect(ack.undelivered).toEqual([check.refusal]);
  });

  it("names the recipient's door when they are lurking", async () => {
    const lurker = await newHuman("wc-lurker");
    const visitor = await newHuman("wc-lurk-visitor");
    await grove.identity.patchHuman(lurker.id, { lurk: true });
    const check = await grove.speech.checkWhisper({ kind: "human", human: visitor }, lurker.id);
    expect(check.allowed).toBe(false);
    expect(check.refusal).toMatchObject({ code: "NOT_ADDRESSABLE", source: "actor", subject: "recipient" });
  });

  it("answers about permissions, not about a limiter that will have cleared", async () => {
    const owner = await newHuman("wc-gap-owner");
    const visitor = await newHuman("wc-gap-visitor");
    const agent = await newAgent(owner, `wcgap${tag()}`);
    // The room_say gap the kernel's emit check shares with whisper.
    await redis.set(`ratelimit:${visitor.id}:room_say:gap`, "1", "PX", 60_000);
    const check = await grove.speech.checkWhisper({ kind: "human", human: visitor }, agent.id);
    expect(check.allowed).toBe(true);
    await clearActorLimiters(redis, visitor.id);
  });

  it("will not offer a whisper to yourself", async () => {
    const visitor = await newHuman("wc-self");
    const check = await grove.speech.checkWhisper({ kind: "human", human: visitor }, visitor.id);
    expect(check.allowed).toBe(false);
  });
});
