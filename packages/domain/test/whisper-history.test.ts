/**
 * Whispers persisted (migration 032): a reload does not empty the whisper log.
 *
 * The properties that matter: only the two parties ever read a whisper back;
 * the kernel re-judges it at read time (a block since hides it from both, a mute
 * since from the reader who muted, an undelivered one never reaches the target);
 * and whispers past retention are pruned with their delivery rows, unless
 * someone in them has an open report.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, WHISPER_RETENTION_DAYS } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  createFixtures,
  hasTestDatabase,
} from "./support/fixtures.js";

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("whisper history", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the whisper history suite");
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

  // The library seats 40 and is shared with every file running alongside (and
  // the api suite, in the same database). Holding 13 seats for the whole file
  // made a parallel run ROOM_FULL now and then: each test gives its seats back.
  const seated = new Set<string>();
  afterEach(async () => {
    for (const id of seated) await grove.presence.leave(id);
    seated.clear();
  });

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  type H = Awaited<ReturnType<typeof newHuman>>;
  const as = (h: H) => ({ kind: "human" as const, human: h });

  async function inRoom(h: H, room = "library") {
    seated.add(h.id);
    await grove.presence.enter({ id: h.id, kind: "human" }, room, { connection: "live", mode: "active", activity: "idle" });
  }

  async function whisper(from: H, to: string, body: string) {
    await clearActorLimiters(redis, from.id);
    return grove.speech.say(as(from), { channel: "whisper", targetId: to, body, idempotencyKey: `k-${tag()}` });
  }

  const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

  it("comes back for sender and recipient only, in that room only", async () => {
    const ada = await newHuman("wh-ada");
    const bo = await newHuman("wh-bo");
    const cy = await newHuman("wh-cy");
    await inRoom(ada);
    await inRoom(bo);
    await inRoom(cy);
    const one = await whisper(ada, bo.id, `psst ${tag()}`);
    const two = await whisper(bo, ada.id, `back ${tag()}`);
    expect(one.deliveredCount).toBe(1);

    const adaView = await grove.whispers.history(as(ada), "library");
    expect(ids(adaView)).toEqual([one.id, two.id]);
    expect(adaView[0]).toMatchObject({ direction: "out", otherId: bo.id, otherKind: "human", undelivered: null });
    expect(adaView[1]).toMatchObject({ direction: "in", otherId: bo.id });

    const boView = await grove.whispers.history(as(bo), "library");
    expect(ids(boView)).toEqual([one.id, two.id]);
    expect(boView[0]!.direction).toBe("in");

    expect(await grove.whispers.history(as(cy), "library")).toEqual([]);
    expect(await grove.whispers.history(as(ada), "workshop")).toEqual([]);
  });

  it("a block since hides the exchange from both sides", async () => {
    const ada = await newHuman("wh-blk-ada");
    const bo = await newHuman("wh-blk-bo");
    await inRoom(ada);
    await inRoom(bo);
    const one = await whisper(ada, bo.id, `before ${tag()}`);
    expect(ids(await grove.whispers.history(as(bo), "library"))).toEqual([one.id]);

    await grove.moderation.block(bo, ada.id);
    expect(await grove.whispers.history(as(bo), "library")).toEqual([]);
    expect(await grove.whispers.history(as(ada), "library")).toEqual([]);

    // Nothing was deleted: lifting the block shows it again.
    await pg.query(`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [bo.id, ada.id]);
    expect(ids(await grove.whispers.history(as(bo), "library"))).toEqual([one.id]);
  });

  it("a mute since hides it from the muter, not from the sender", async () => {
    const ada = await newHuman("wh-mute-ada");
    const bo = await newHuman("wh-mute-bo");
    await inRoom(ada);
    await inRoom(bo);
    const one = await whisper(ada, bo.id, `hello ${tag()}`);
    await grove.moderation.mute(bo, ada.id);
    expect(await grove.whispers.history(as(bo), "library")).toEqual([]);
    expect(ids(await grove.whispers.history(as(ada), "library"))).toEqual([one.id]);
  });

  it("an undelivered whisper stays the sender's, with its code, and never reaches the target", async () => {
    const ada = await newHuman("wh-und-ada");
    const bo = await newHuman("wh-und-bo");
    await inRoom(ada);
    await grove.moderation.mute(bo, ada.id);
    const ack = await whisper(ada, bo.id, `anyone ${tag()}`);
    expect(ack.deliveredCount).toBe(0);
    const adaView = await grove.whispers.history(as(ada), "library");
    expect(ids(adaView)).toEqual([ack.id]);
    // The same code-only entry the say ack's replay gives, so a mute stays unattributed.
    expect(adaView[0]!.undelivered).toEqual({ actorId: bo.id, code: "MUTED" });
    // Lifting the mute does not deliver what was never delivered.
    await pg.query(`DELETE FROM mutes WHERE muter_id = $1 AND muted_id = $2`, [bo.id, ada.id]);
    expect(await grove.whispers.history(as(bo), "library")).toEqual([]);
  });

  it("prunes whispers past retention with their deliveries, keeping recent ones, room lines and open reports", async () => {
    const ada = await newHuman("wh-prune-ada");
    const bo = await newHuman("wh-prune-bo");
    const cy = await newHuman("wh-prune-cy");
    await inRoom(ada);
    await inRoom(bo);
    await inRoom(cy);
    const old = await whisper(ada, bo.id, `old ${tag()}`);
    const fresh = await whisper(ada, bo.id, `fresh ${tag()}`);
    const reported = await whisper(cy, bo.id, `reported ${tag()}`);
    await clearActorLimiters(redis, ada.id);
    const said = await grove.speech.say(as(ada), { channel: "room_say", body: `room ${tag()}`, idempotencyKey: `k-${tag()}` });
    const aged = `now() - make_interval(days => ${WHISPER_RETENTION_DAYS + 1})`;
    await pg.query(`UPDATE speech SET created_at = ${aged} WHERE id = ANY($1::text[])`, [[old.id, reported.id, said.id]]);
    await pg.query(
      `INSERT INTO reports (id, reporter_id, target_id, category, status) VALUES ($1, $2, $3, 'other', 'open')`,
      [`rep_wh_${tag()}`, bo.id, cy.id],
    );

    // Past retention is not served even before the prune runs.
    expect(ids(await grove.whispers.history(as(ada), "library"))).toEqual([fresh.id]);

    expect(await grove.whispers.prune()).toBeGreaterThanOrEqual(1);
    const left = async (id: string) => (await pg.query(`SELECT 1 FROM speech WHERE id = $1`, [id])).rowCount;
    expect(await left(old.id)).toBe(0);
    expect((await pg.query(`SELECT 1 FROM speech_deliveries WHERE speech_id = $1`, [old.id])).rowCount).toBe(0);
    expect(await left(fresh.id)).toBe(1);
    expect(await left(reported.id)).toBe(1);
    expect(await left(said.id)).toBe(1);

    // Throttled per process: a second call inside the window does nothing.
    const t = Date.now();
    await grove.whispers.maybePrune(t);
    expect(await grove.whispers.maybePrune(t + 1000)).toBe(0);

    await pg.query(`DELETE FROM reports WHERE target_id = $1`, [cy.id]);
  });
});
