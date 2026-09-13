/**
 * Reactions: an emoji on a line or an event, judged like speech.
 *
 * The properties that matter:
 *  - you react only to what you can SEE (a line's body reached you; an event is
 *    in your chronicle), and anything else is the same 404 as "never existed";
 *  - the permission kernel refuses a reaction where it would refuse a line
 *    (no mouth, a block), but a mute is never announced to the reactor;
 *  - readers get counts and their own, never who.
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

const REGISTER_IP = REGISTER_IPS.reactions;
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("reactions go through the kernel like speech", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the reactions suite");
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

  async function enter(actor: { id: string; kind: "human" | "agent"; ownerHumanId?: string | null }, room: string) {
    await grove.presence.enter(actor, room, { connection: "live", mode: "active", activity: "idle" });
  }

  /** A human speaks in a room; returns the speech id. */
  async function humanSays(human: Awaited<ReturnType<typeof newHuman>>, body: string) {
    await clearActorLimiters(redis, human.id);
    const ack = await grove.speech.say(
      { kind: "human", human },
      { channel: "room_say", body, idempotencyKey: `k-${tag()}` },
    );
    return ack.id;
  }

  async function refusal(p: Promise<unknown>): Promise<GroveError> {
    try {
      await p;
    } catch (e) {
      if (e instanceof GroveError) return e;
      throw e;
    }
    throw new Error("expected a refusal");
  }

  it("counts a reaction on a line that reached you, shows it as yours, and toggles off", async () => {
    const speaker = await newHuman("rx-speaker");
    const listener = await newHuman("rx-listener");
    const other = await newHuman("rx-other");
    await enter({ id: speaker.id, kind: "human" }, "library");
    await enter({ id: listener.id, kind: "human" }, "library");
    await enter({ id: other.id, kind: "human" }, "library");
    const speechId = await humanSays(speaker, `the lamps ${tag()}`);

    const a = await grove.reactions.react({ kind: "human", human: listener }, { targetKind: "speech", targetId: speechId, emoji: "heart" });
    expect(a.summary).toEqual({ counts: { heart: 1 }, mine: ["heart"] });
    // Idempotent: the same reaction twice is still one.
    await grove.reactions.react({ kind: "human", human: listener }, { targetKind: "speech", targetId: speechId, emoji: "heart" });
    const b = await grove.reactions.react({ kind: "human", human: other }, { targetKind: "speech", targetId: speechId, emoji: "heart" });
    expect(b.summary).toEqual({ counts: { heart: 2 }, mine: ["heart"] });

    // The speaker reads the count and nobody's name.
    const sums = await grove.reactions.summaries(speaker.id, [{ kind: "speech", id: speechId }]);
    expect(sums.get(`speech:${speechId}`)).toEqual({ counts: { heart: 2 }, mine: [] });

    const off = await grove.reactions.react(
      { kind: "human", human: listener },
      { targetKind: "speech", targetId: speechId, emoji: "heart", on: false },
    );
    expect(off.summary).toEqual({ counts: { heart: 1 }, mine: [] });
  });

  it("answers 404 for a line that never reached you, a whisper, and a line that does not exist", async () => {
    const speaker = await newHuman("rx-quiet");
    const bystander = await newHuman("rx-bystander");
    const confidant = await newHuman("rx-confidant");
    await enter({ id: speaker.id, kind: "human" }, "workshop");
    await enter({ id: confidant.id, kind: "human" }, "workshop");
    const speechId = await humanSays(speaker, `not for you ${tag()}`);

    const notHeard = await refusal(
      grove.reactions.react({ kind: "human", human: bystander }, { targetKind: "speech", targetId: speechId, emoji: "up" }),
    );
    const missing = await refusal(
      grove.reactions.react({ kind: "human", human: bystander }, { targetKind: "speech", targetId: `speech_${tag()}`, emoji: "up" }),
    );
    expect(notHeard.code).toBe("NOT_FOUND");
    expect(notHeard.httpStatus).toBe(404);
    expect({ code: missing.code, status: missing.httpStatus, message: missing.message }).toEqual({
      code: notHeard.code,
      status: notHeard.httpStatus,
      message: notHeard.message,
    });

    await clearActorLimiters(redis, speaker.id);
    const whisper = await grove.speech.say(
      { kind: "human", human: speaker },
      { channel: "whisper", targetId: confidant.id, body: `psst ${tag()}`, idempotencyKey: `k-${tag()}` },
    );
    const w = await refusal(
      grove.reactions.react({ kind: "human", human: confidant }, { targetKind: "speech", targetId: whisper.id, emoji: "up" }),
    );
    expect(w.httpStatus).toBe(404);
  });

  it("refuses an agent with no mouth, as the kernel refuses its line", async () => {
    const owner = await newHuman("rx-mute-owner");
    const speaker = await newHuman("rx-agent-speaker");
    const agent = await newAgent(owner, `rxmouthless${tag()}`);
    await enter({ id: speaker.id, kind: "human" }, "garden");
    await enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "garden");
    const speechId = await humanSays(speaker, `hello garden ${tag()}`);
    await grove.identity.patchPolicy(agent.id, owner, { speakToHumans: false, speakToAgents: false });
    const fresh = (await grove.identity.getAgent(agent.id))!;

    const e = await refusal(
      grove.reactions.react({ kind: "agent", agent: fresh }, { targetKind: "speech", targetId: speechId, emoji: "sprout" }),
    );
    expect(e.code).toBe("PERMISSION_DENIED");
  });

  it("refuses across a block without saying who set it, and lets a mute through silently", async () => {
    const speaker = await newHuman("rx-blocker");
    const reactor = await newHuman("rx-blocked");
    await enter({ id: speaker.id, kind: "human" }, "library");
    await enter({ id: reactor.id, kind: "human" }, "library");
    const speechId = await humanSays(speaker, `before the block ${tag()}`);

    await grove.moderation.mute(speaker, reactor.id);
    const muted = await grove.reactions.react({ kind: "human", human: reactor }, { targetKind: "speech", targetId: speechId, emoji: "wow" });
    expect(muted.summary.counts.wow).toBe(1);

    await grove.moderation.block(speaker, reactor.id);
    const e = await refusal(
      grove.reactions.react({ kind: "human", human: reactor }, { targetKind: "speech", targetId: speechId, emoji: "up" }),
    );
    expect(e.code).toBe("BLOCKED");
    expect(e.source).toBeUndefined();
    expect(e.subject).toBeUndefined();
  });

  it("takes reactions on civic chronicle events, and refuses moderation rows as unseen", async () => {
    const newcomer = await newHuman("rx-newcomer");
    const reactor = await newHuman("rx-welcomer");
    const { rows } = await pg.query(
      `SELECT id FROM world_events WHERE type = 'actor_registered' AND actor_id = $1 ORDER BY id DESC LIMIT 1`,
      [newcomer.id],
    );
    const eventId = String((rows[0] as { id: string }).id);
    const ok = await grove.reactions.react({ kind: "human", human: reactor }, { targetKind: "event", targetId: eventId, emoji: "party" });
    expect(ok.summary).toEqual({ counts: { party: 1 }, mine: ["party"] });

    const page = await grove.chronicle.entryById({ humanId: reactor.id, isOperator: false }, eventId);
    expect(page?.reactionTarget).toEqual({ kind: "event", id: eventId });

    await grove.moderation.report(reactor, { targetId: newcomer.id, category: "spam" });
    const { rows: rep } = await pg.query(
      `SELECT id FROM world_events WHERE type = 'report' AND actor_id = $1 ORDER BY id DESC LIMIT 1`,
      [reactor.id],
    );
    const reportId = String((rep[0] as { id: string }).id);
    // The reporter can SEE their report, but a report takes no reactions.
    const e = await refusal(
      grove.reactions.react({ kind: "human", human: reactor }, { targetKind: "event", targetId: reportId, emoji: "up" }),
    );
    expect(e.httpStatus).toBe(404);
  });

  it("refuses an emoji outside the set and a target kind it does not know", async () => {
    const reactor = await newHuman("rx-bad");
    const e1 = await refusal(
      grove.reactions.react({ kind: "human", human: reactor }, { targetKind: "speech", targetId: "x", emoji: "skull" }),
    );
    expect(e1.code).toBe("INVALID");
    const e2 = await refusal(
      grove.reactions.react({ kind: "human", human: reactor }, { targetKind: "notice", targetId: "x", emoji: "up" }),
    );
    expect(e2.code).toBe("INVALID");
  });
  it("pushes live counts to the line's audience only, never who, and drops a reader who blocked since", async () => {
    const speaker = await newHuman("rx-live-speaker");
    const listener = await newHuman("rx-live-listener");
    const later = await newHuman("rx-live-blocker");
    const outside = await newHuman("rx-live-outside");
    await enter({ id: speaker.id, kind: "human" }, "library");
    await enter({ id: listener.id, kind: "human" }, "library");
    await enter({ id: later.id, kind: "human" }, "library");
    const speechId = await humanSays(speaker, `live counts ${tag()}`);
    const { rows } = await pg.query(`SELECT room_id FROM speech WHERE id = $1`, [speechId]);
    const roomId = String((rows[0] as { room_id: string }).room_id);

    // `later` heard the line, then blocked the speaker: today's transcript hides
    // the line from them, so the push must too.
    await grove.moderation.block(later, speaker.id);
    const live = await grove.speech.liveAudience(speechId);
    expect(live?.roomId).toBe(roomId);
    expect(new Set(live?.audience)).toEqual(new Set([speaker.id, listener.id]));

    const sub = redis.duplicate();
    const frames: Array<Record<string, unknown>> = [];
    await sub.subscribe(`pubsub:room:${roomId}`);
    sub.on("message", (_ch, m) => {
      const f = JSON.parse(m) as Record<string, unknown>;
      if (f.type === "reaction_counts" && f.target_id === speechId) frames.push(f);
    });
    try {
      await grove.reactions.react({ kind: "human", human: listener }, { targetKind: "speech", targetId: speechId, emoji: "heart" });
      // Re-sending changes nothing and publishes nothing.
      await grove.reactions.react({ kind: "human", human: listener }, { targetKind: "speech", targetId: speechId, emoji: "heart" });
      await grove.reactions.react(
        { kind: "human", human: listener },
        { targetKind: "speech", targetId: speechId, emoji: "heart", on: false },
      );
      // An outsider's refused reaction publishes nothing either.
      await refusal(
        grove.reactions.react({ kind: "human", human: outside }, { targetKind: "speech", targetId: speechId, emoji: "up" }),
      );
      for (let i = 0; i < 40 && frames.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
      expect(frames.map((f) => f.counts)).toEqual([{ heart: 1 }, {}]);
      for (const f of frames) {
        expect(f).not.toHaveProperty("sender_id");
        expect(f).not.toHaveProperty("mine");
        expect(new Set(f.delivered_to as string[])).toEqual(new Set([speaker.id, listener.id]));
      }
    } finally {
      await sub.quit();
    }
    // A whisper is not a room line: no live audience.
    await clearActorLimiters(redis, speaker.id);
    const w = await grove.speech.say(
      { kind: "human", human: speaker },
      { channel: "whisper", targetId: listener.id, body: `psst ${tag()}`, idempotencyKey: `k-${tag()}` },
    );
    expect(await grove.speech.liveAudience(w.id)).toBeNull();
  });
});
