/**
 * Guest passes (queue #32): a signed-out browser that may react and follow.
 *
 * The properties that matter:
 *  - a guest sees exactly what a signed-out visitor sees: it can react to a
 *    civic chronicle event, and gets the same 404 as "never existed" for a
 *    spoken line (only people read those) or a private space;
 *  - a guest's reaction is counted like anyone's, and a guest follower is
 *    never told anything (and never crowds a real follower out);
 *  - signing in moves the guest's reactions and follows onto the person, a
 *    duplicate staying one row, and the guest is gone;
 *  - a guest untouched for 30 days is pruned with everything it did.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { GroveError } from "../src/errors.js";
import { GUEST_TTL_DAYS, guestIdForToken, guestIpBucket, isGuestToken } from "../src/services/guests.js";
import { assertTestDatabase, clearActorLimiters, createFixtures, hasTestDatabase } from "./support/fixtures.js";

const hasDb = hasTestDatabase();

describe("guest pass helpers", () => {
  it("keys a guest by a hash of its token, never the token", () => {
    const token = "a".repeat(43);
    const id = guestIdForToken(token);
    expect(id).toMatch(/^gst_[0-9a-f]{32}$/);
    expect(id).not.toContain(token);
    expect(guestIdForToken(token)).toBe(id);
  });

  it("accepts only token-shaped cookies", () => {
    expect(isGuestToken("A".repeat(43))).toBe(true);
    expect(isGuestToken("short")).toBe(false);
    expect(isGuestToken("x".repeat(43) + ";")).toBe(false);
    expect(isGuestToken(undefined)).toBe(false);
  });

  it("never puts a client address in a limiter key", () => {
    const b = guestIpBucket("203.0.113.9");
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(b).not.toContain("203");
    expect(guestIpBucket("203.0.113.9")).toBe(b);
    expect(guestIpBucket("203.0.113.10")).not.toBe(b);
  });
});

describe.skipIf(!hasDb)("guest passes react and follow like a signed-out visitor", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const guestIds: string[] = [];
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the guests suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    try {
      for (const id of guestIds) await grove.guests.forget(id);
      await fixtures.cleanup();
    } finally {
      await redis.quit();
      await pg.end();
    }
  });

  async function newGuest() {
    const { guest, token } = await grove.guests.issue();
    guestIds.push(guest.id);
    await clearActorLimiters(redis, guest.id);
    return { guest, token };
  }

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function arrivalOf(humanId: string): Promise<string> {
    const { rows } = await pg.query(
      `SELECT id FROM world_events WHERE type = 'actor_registered' AND actor_id = $1 ORDER BY id DESC LIMIT 1`,
      [humanId],
    );
    return String((rows[0] as { id: string }).id);
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

  it("finds a guest by its token and not otherwise", async () => {
    const { guest, token } = await newGuest();
    expect((await grove.guests.fromToken(token))?.id).toBe(guest.id);
    expect(await grove.guests.fromToken("B".repeat(43))).toBeNull();
    const { rows } = await pg.query(`SELECT * FROM guests WHERE id = $1`, [guest.id]);
    expect(Object.keys(rows[0] as object).sort()).toEqual(["created_at", "id", "last_seen_at"]);
  });

  it("reacts to a civic event a signed-out visitor can see, counted with everyone's", async () => {
    const newcomer = await newHuman("gst-newcomer");
    const person = await newHuman("gst-person");
    const eventId = await arrivalOf(newcomer.id);
    const { guest } = await newGuest();

    const a = await grove.reactions.react({ kind: "guest", guest }, { targetKind: "event", targetId: eventId, emoji: "party" });
    expect(a.summary).toEqual({ counts: { party: 1 }, mine: ["party"] });
    const b = await grove.reactions.react({ kind: "human", human: person }, { targetKind: "event", targetId: eventId, emoji: "party" });
    expect(b.summary).toEqual({ counts: { party: 2 }, mine: ["party"] });

    const off = await grove.reactions.react(
      { kind: "guest", guest },
      { targetKind: "event", targetId: eventId, emoji: "party", on: false },
    );
    expect(off.summary).toEqual({ counts: { party: 1 }, mine: [] });
  });

  it("answers 404 for a spoken line, which only signed-in readers see", async () => {
    const speaker = await newHuman("gst-speaker");
    await grove.presence.enter({ id: speaker.id, kind: "human" }, "library", { connection: "live", mode: "active", activity: "idle" });
    await clearActorLimiters(redis, speaker.id);
    const ack = await grove.speech.say({ kind: "human", human: speaker }, { channel: "room_say", body: `hello ${tag()}`, idempotencyKey: `k-${tag()}` });
    const { guest } = await newGuest();
    const e = await refusal(grove.reactions.react({ kind: "guest", guest }, { targetKind: "speech", targetId: ack.id, emoji: "up" }));
    expect(e.code).toBe("NOT_FOUND");
    expect(e.httpStatus).toBe(404);
  });

  it("follows a public space, never a private one, and is never told anything", async () => {
    const owner = await newHuman("gst-owner");
    const fan = await newHuman("gst-fan");
    const open = await grove.campus.createWorld(owner, { name: `Open ${tag()}`, slug: `open-${tag()}`, preset: "public_view" });
    const closed = await grove.campus.createWorld(owner, { name: `Shut ${tag()}`, slug: `shut-${tag()}`, preset: "private" });
    fixtures.trackWorld(open.id);
    fixtures.trackWorld(closed.id);
    const { guest } = await newGuest();

    const e = await refusal(grove.follows.setFollow({ kind: "guest", guest }, "space", closed.slug, true));
    expect(e.code).toBe("NOT_FOUND");

    const state = await grove.follows.setFollow({ kind: "guest", guest }, "space", open.slug, true);
    expect(state).toMatchObject({ following: true, followers: 1 });
    await grove.follows.setFollow({ kind: "human", human: fan }, "space", open.slug, true);
    expect((await grove.follows.listMine({ kind: "guest", guest })).map((f) => f.id)).toEqual([open.id]);

    // A Stage opening tells the person and not the guest.
    await grove.campus.createEvent(owner, { worldId: open.id, title: "Doors", startsAt: new Date(Date.now() - 60_000).toISOString() });
    await grove.campus.stageNow(open.id);
    const notices = await pg.query(`SELECT human_id FROM follow_notices WHERE subject_id = $1`, [open.id]);
    expect(notices.rows.map((r) => (r as { human_id: string }).human_id)).toEqual([fan.id]);
  });

  it("merges into the person on sign-in, a duplicate staying one row", async () => {
    const owner = await newHuman("gst-mown");
    const newcomer = await newHuman("gst-mnew");
    const person = await newHuman("gst-merge");
    const space = await grove.campus.createWorld(owner, { name: `Merge ${tag()}`, slug: `merge-${tag()}`, preset: "public_view" });
    const other = await grove.campus.createWorld(owner, { name: `Other ${tag()}`, slug: `other-${tag()}`, preset: "public_write" });
    fixtures.trackWorld(space.id);
    fixtures.trackWorld(other.id);
    const eventId = await arrivalOf(newcomer.id);
    const { guest } = await newGuest();

    // The person already holds one of each; the guest holds those and one more.
    await grove.reactions.react({ kind: "human", human: person }, { targetKind: "event", targetId: eventId, emoji: "heart" });
    await grove.follows.setFollow({ kind: "human", human: person }, "space", space.slug, true);
    await grove.reactions.react({ kind: "guest", guest }, { targetKind: "event", targetId: eventId, emoji: "heart" });
    await grove.reactions.react({ kind: "guest", guest }, { targetKind: "event", targetId: eventId, emoji: "wow" });
    await grove.follows.setFollow({ kind: "guest", guest }, "space", space.slug, true);
    await grove.follows.setFollow({ kind: "guest", guest }, "space", other.slug, true);

    const merged = await grove.guests.merge(guest.id, person);
    expect(merged).toEqual({ reactions: 1, follows: 1 });

    const sums = await grove.reactions.summaries(person.id, [{ kind: "event", id: eventId }]);
    expect(sums.get(`event:${eventId}`)).toEqual({ counts: { heart: 1, wow: 1 }, mine: ["heart", "wow"] });
    const follows = await grove.follows.listMine({ kind: "human", human: person });
    expect(follows.map((f) => f.id).sort()).toEqual([space.id, other.id].sort());
    expect((await grove.follows.state(null, "space", space.slug)).followers).toBe(1);

    const left = await pg.query(
      `SELECT (SELECT count(*) FROM guests WHERE id = $1)::int AS g,
              (SELECT count(*) FROM reactions WHERE actor_id = $1)::int AS r,
              (SELECT count(*) FROM follows WHERE follower_id = $1)::int AS f`,
      [guest.id],
    );
    expect(left.rows[0]).toEqual({ g: 0, r: 0, f: 0 });
    // Merging again is a no-op.
    expect(await grove.guests.merge(guest.id, person)).toEqual({ reactions: 0, follows: 0 });
  });

  it("prunes a guest idle past the TTL with everything it did, and keeps a recent one", async () => {
    const newcomer = await newHuman("gst-prune");
    const eventId = await arrivalOf(newcomer.id);
    const stale = await newGuest();
    const recent = await newGuest();
    await grove.reactions.react({ kind: "guest", guest: stale.guest }, { targetKind: "event", targetId: eventId, emoji: "up" });
    await grove.reactions.react({ kind: "guest", guest: recent.guest }, { targetKind: "event", targetId: eventId, emoji: "up" });
    await pg.query(`UPDATE guests SET last_seen_at = now() - make_interval(days => $2) WHERE id = $1`, [
      stale.guest.id,
      GUEST_TTL_DAYS + 1,
    ]);

    // Pruning runs in batches from the oldest; loop until our stale guest is gone.
    for (let i = 0; i < 20; i += 1) {
      await grove.guests.prune();
      const { rowCount } = await pg.query(`SELECT 1 FROM guests WHERE id = $1`, [stale.guest.id]);
      if (!rowCount) break;
    }
    expect(await grove.guests.fromToken(stale.token)).toBeNull();
    expect((await grove.guests.fromToken(recent.token))?.id).toBe(recent.guest.id);
    const sums = await grove.reactions.summaries(null, [{ kind: "event", id: eventId }]);
    expect(sums.get(`event:${eventId}`)).toEqual({ counts: { up: 1 }, mine: [] });
  });
});
