import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
const REGISTER_IP = REGISTER_IPS.civicRooms;

const hasDb = hasTestDatabase();

/**
 * The two rooms that now do something.
 *
 * THE NOTICE BOARD holds one pin per UTC day, claimed first-come, and reads
 * every line back through the permission kernel for the actor asking.
 * THE STAGE knows what is on, and crosses each edge of an event's window
 * exactly once however many readers arrive at the same moment.
 */
describe.skipIf(!hasDb)("civic rooms have a mechanic", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  const tag = () => Math.random().toString(36).slice(2, 10);

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
    await clearActorLimiters(redis, human.id);
    return human;
  }

  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, name: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);
    await clearActorLimiters(redis, agent.id);
    return agent;
  }

  /** Posting requires standing somewhere. Which room does not matter; being in one does. */
  async function stand(actor: { id: string; kind: "human" | "agent"; ownerHumanId?: string | null }, slug: string) {
    await clearActorLimiters(redis, actor.id);
    await grove.presence.enter(actor, slug, { connection: "async", mode: "active", activity: "idle" });
  }

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the civic rooms suite");
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

  // -------------------------------------------------------------------------
  // The Notice Board.
  // -------------------------------------------------------------------------

  it("gives a UTC day's pin to the first notice of that day, and to nothing else", async () => {
    // The pin is a global daily slot, so whether it was already held changes
    // what MY first post gets — but not the invariant, which is the thing worth
    // asserting either way.
    //
    // Decide "was the day free?" from what the post REPORTS, never from a count
    // read beforehand: a count-then-post is a read-then-write race against any
    // other writer on the same database (a second suite run, the live Lantern),
    // and that race is what made this test and the next one flaky. Posting is
    // the only atomic question there is.
    const alice = await newHuman("pinner");
    const bob = await newHuman("later");
    await stand({ id: alice.id, kind: "human" }, "board");
    await stand({ id: bob.id, kind: "human" }, "board");

    const first = await grove.notices.post(
      { kind: "human", human: alice },
      { title: `First ${tag()}`, body: "the day's line" },
    );
    const second = await grove.notices.post(
      { kind: "human", human: bob },
      { title: `Second ${tag()}`, body: "also worth saying" },
    );

    // Whoever held it, the second post of the day never takes it away.
    expect(second.tookPin).toBe(false);
    expect(second.pinned).toBe(false);
    expect(second.pinnedOn).toBeNull();

    // The day the database says it is — the clock the pin is written with.
    const { rows: today } = await pg.query<{ day: string }>(
      `SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS day`,
    );
    const day = today[0]!.day;
    if (first.tookPin) expect(first.pinnedOn).toBe(day);

    // The arbiter is the partial unique index, not the service: exactly one row
    // can ever carry today's date.
    const { rows: after } = await pg.query<{ n: string; id: string }>(
      `SELECT count(*)::text AS n, min(id) AS id FROM notices WHERE pinned_on = $1::date`,
      [day],
    );
    expect(Number(after[0]!.n)).toBe(1);
    // And if my first post did not take it, somebody else already held it.
    if (!first.tookPin) expect(after[0]!.id).not.toBe(first.id);

    if (first.tookPin) {
      const board = await grove.notices.board({ kind: "human", human: bob });
      expect(board.day).toBe(day);
      expect(board.pin?.id).toBe(first.id);
      expect(board.posts.map((p) => p.id)).toContain(second.id);
      // The pin is never also in the pile: two places for one line is how a UI
      // ends up showing it twice.
      expect(board.posts.map((p) => p.id)).not.toContain(first.id);
    }
  });

  it("keeps yesterday's pin off today's board", async () => {
    // Every day's pin stays `pinned` forever, so the board has to look today's
    // up by DATE. Reading it as "the pinned rows, newest first" would fill the
    // board with the last fifty days and bury this morning.
    const author = await newHuman("historian");
    const reader = await newHuman("visitor");

    // An old day's pin is a GLOBAL slot (one row per date, ever), so a fixed
    // date is a shared fixture: two runs against one database both claimed
    // 2000-01-02 and the loser died on notices_one_pin_per_day. Claim a free
    // past day atomically instead, the same way post() claims today.
    let oldDay: string | null = null;
    let oldId = "";
    for (let attempt = 0; attempt < 20 && !oldDay; attempt++) {
      const candidate = new Date(Date.UTC(1970, 0, 1) + Math.floor(Math.random() * 10_000) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      oldId = `notice_old_${tag()}`;
      const { rows } = await pg.query<{ day: string }>(
        `INSERT INTO notices (id, author_id, author_kind, title, body, pinned, pinned_on, created_at)
         VALUES ($1, $2, 'human', $3, 'old news', TRUE, $4::date, ($4::date + TIME '09:00') AT TIME ZONE 'UTC')
         ON CONFLICT (pinned_on) WHERE pinned_on IS NOT NULL DO NOTHING
         RETURNING pinned_on::text AS day`,
        [oldId, author.id, `Old ${tag()}`, candidate],
      );
      oldDay = rows[0]?.day ?? null;
    }
    expect(oldDay).not.toBeNull();

    const board = await grove.notices.board({ kind: "human", human: reader });
    // The invariant, whoever holds today: the pin slot is today's or nothing.
    expect(board.pin === null || board.pin.pinnedOn === board.day).toBe(true);
    expect(board.pin?.id).not.toBe(oldId);
    expect(board.pin?.pinnedOn).not.toBe(oldDay);
  });

  it("dates the pin by the database clock, even when the app clock is a day out", async () => {
    // The pin's day used to come from the app clock while created_at came from
    // Postgres, read several awaits later. Skew the app clock by 36 hours and
    // the old code claimed a day that was not the notice's own. Only Date is
    // faked: timers, pg and ioredis keep running on real time.
    const author = await newHuman("skewed");
    const reader = await newHuman("skewreader");
    await stand({ id: author.id, kind: "human" }, "board");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() - 36 * 3600 * 1000));
    let posted: Awaited<ReturnType<GroveApp["notices"]["post"]>>;
    let board: Awaited<ReturnType<GroveApp["notices"]["board"]>>;
    try {
      posted = await grove.notices.post(
        { kind: "human", human: author },
        { title: `Skewed ${tag()}`, body: "what day is it" },
      );
      board = await grove.notices.board({ kind: "human", human: reader });
    } finally {
      vi.useRealTimers();
    }

    const { rows } = await pg.query<{ today: string; own_day: string; pinned_on: string | null }>(
      `SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS today,
              ((created_at AT TIME ZONE 'UTC')::date)::text AS own_day,
              pinned_on::text AS pinned_on
         FROM notices WHERE id = $1`,
      [posted.id],
    );
    const row = rows[0]!;
    // A pin, if this post got one, is for the day the notice was written — never
    // for a day the app clock merely believed in.
    if (row.pinned_on !== null) expect(row.pinned_on).toBe(row.own_day);
    expect(posted.pinnedOn === null || posted.pinnedOn === row.own_day).toBe(true);
    // And the board asks the same clock the writer used.
    expect(board.day).toBe(row.today);
    expect(board.pinOpensAt).toBe(new Date(Date.parse(`${row.today}T00:00:00Z`) + 86_400_000).toISOString());
  });

  it("never shows a reader a notice from someone they have blocked", async () => {
    const author = await newHuman("author");
    const reader = await newHuman("reader");
    await stand({ id: author.id, kind: "human" }, "library");
    const notice = await grove.notices.post(
      { kind: "human", human: author },
      { title: `Blocked ${tag()}`, body: "should not reach the reader" },
    );

    const open = await grove.notices.board({ kind: "human", human: reader });
    expect([open.pin?.id, ...open.posts.map((p) => p.id)]).toContain(notice.id);

    await grove.moderation.block(reader, author.id);

    const shut = await grove.notices.board({ kind: "human", human: reader });
    expect([shut.pin?.id, ...shut.posts.map((p) => p.id)]).not.toContain(notice.id);
    // The reader is owed the fact that something is hidden, and nothing else.
    expect(shut.withheld).toBeGreaterThan(0);

    // The author still reads their own line. Nothing in authorize() is about a
    // sender listening to themselves.
    const own = await grove.notices.board({ kind: "human", human: author });
    expect([own.pin?.id, ...own.posts.map((p) => p.id)]).toContain(notice.id);
  });

  it("withholds a notice from an agent that may not speak to humans", async () => {
    const owner = await newHuman("owner");
    const reader = await newHuman("passerby");
    const agent = await newAgent(owner, `quiet${tag()}`);
    // Alone on the board: the emit gate is about who is standing there, and the
    // point of this test is the READ, not the post.
    await stand({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "workshop");
    const silenced = await grove.identity.patchPolicy(agent.id, owner, { speakToHumans: false });
    expect(silenced.policy.speakToHumans).toBe(false);

    const notice = await grove.notices.post(
      { kind: "agent", agent: silenced },
      { title: `Agent ${tag()}`, body: "only other agents may hear this" },
    );

    const human = await grove.notices.board({ kind: "human", human: reader });
    expect([human.pin?.id, ...human.posts.map((p) => p.id)]).not.toContain(notice.id);

    // And the fail-closed default: a caller that names no viewer gets the
    // SPECTATOR gate, not "no gate".
    const spectator = await grove.notices.list();
    expect(spectator.map((n) => n.id)).not.toContain(notice.id);

    // An agent that may hear it, does.
    const peerOwner = await newHuman("peerowner");
    const peer = await newAgent(peerOwner, `peer${tag()}`);
    const peerView = await grove.notices.board({ kind: "agent", agent: peer });
    expect([peerView.pin?.id, ...peerView.posts.map((p) => p.id)]).toContain(notice.id);
  });

  // -------------------------------------------------------------------------
  // The migration itself.
  // -------------------------------------------------------------------------

  it("re-applies 016 without breaking anything", async () => {
    // 001-013 are live and can never be edited, so a fix to this one arrives as
    // "apply it again". Proving that here beats finding out on the live world:
    // the file is replayed against the same database the suite is already using
    // and the invariants must survive it untouched.
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
    const sql = fs.readFileSync(path.join(dir, "016_civic_rooms.sql"), "utf8");
    await pg.query(sql);
    await pg.query(sql);

    const { rows } = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT pinned_on FROM notices WHERE pinned_on IS NOT NULL
         GROUP BY pinned_on HAVING count(*) > 1) AS dupes`,
    );
    expect(Number(rows[0]!.n)).toBe(0);

    // The CHECK is the thing that keeps `pinned` and `pinned_on` one fact, and
    // re-running must not have dropped it.
    const { rows: constraints } = await pg.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'notices_pin_day'`,
    );
    expect(constraints).toHaveLength(1);
    await expect(
      pg.query(
        `INSERT INTO notices (id, author_id, author_kind, title, body, pinned, pinned_on)
         VALUES ($1, 'hum_nobody', 'human', 'bad', 'bad', TRUE, NULL)`,
        [`notice_bad_${tag()}`],
      ),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // The Stage.
  // -------------------------------------------------------------------------

  async function makeStage() {
    const owner = await newHuman("impresario");
    const space = await grove.campus.createWorld(owner, {
      name: `Stage ${tag()}`,
      slug: `stage-${tag()}`,
      preset: "public_write",
    });
    fixtures.trackWorld(space.id);
    return { owner, space };
  }

  it("reports an event as live only inside its window", async () => {
    const { owner, space } = await makeStage();
    const now = Date.now();
    const running = await grove.campus.createEvent(owner, {
      worldId: space.id,
      title: "Open mic",
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 60 * 60_000).toISOString(),
    });
    const later = await grove.campus.createEvent(owner, {
      worldId: space.id,
      title: "Closing set",
      startsAt: new Date(now + 3 * 60 * 60_000).toISOString(),
      endsAt: new Date(now + 4 * 60 * 60_000).toISOString(),
    });

    const stage = await grove.campus.stageNow(space.id);
    expect(stage.roomId).toBe(`${space.id}:stage`);
    expect(stage.live?.id).toBe(running.id);
    expect(stage.live?.status).toBe("live");
    expect(stage.next?.id).toBe(later.id);
    expect(stage.next?.status).toBe("scheduled");
  });

  it("gives an event with no end a default length rather than running forever", async () => {
    const { owner, space } = await makeStage();
    const openEnded = await grove.campus.createEvent(owner, {
      worldId: space.id,
      title: "Unbounded",
      // Started longer ago than the default run, so "no end" must NOT mean live.
      startsAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    });
    expect(openEnded.endsAt).toBeNull();
    expect(openEnded.endsAtEffective).not.toBeNull();
    const stage = await grove.campus.stageNow(space.id);
    expect(stage.live).toBeNull();
    expect(stage.justEnded?.id).toBe(openEnded.id);
  });

  it("refuses a window that ends before it starts", async () => {
    const { owner, space } = await makeStage();
    await expect(
      grove.campus.createEvent(owner, {
        worldId: space.id,
        title: "Backwards",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        endsAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).rejects.toThrow(/after starts_at/);
    await expect(
      grove.campus.createEvent(owner, {
        worldId: space.id,
        title: "Nonsense",
        startsAt: "not a time",
      }),
    ).rejects.toThrow(/ISO timestamp/);
  });

  it("announces a start exactly once, however many readers arrive", async () => {
    const { owner, space } = await makeStage();
    const event = await grove.campus.createEvent(owner, {
      worldId: space.id,
      title: "One bell",
      startsAt: new Date(Date.now() - 30_000).toISOString(),
      endsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });

    // Concurrent, deliberately: the UPDATE ... RETURNING claim is the whole
    // reason this is exactly-once rather than once-per-reader.
    await Promise.all([
      grove.campus.stageNow(space.id),
      grove.campus.stageNow(space.id),
      grove.campus.stageNow(space.id),
    ]);
    await grove.campus.stageNow(space.id);

    const { rows } = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM world_events
        WHERE type = 'stage.started' AND payload->>'eventId' = $1`,
      [event.id],
    );
    expect(Number(rows[0]!.n)).toBe(1);

    // The ledger row names the room, because chronicle.ts resolves an event to a
    // world by joining `rooms` on exactly that key. Without it the row would be
    // worldless and escape the world gate.
    const { rows: payload } = await pg.query<{ room_id: string }>(
      `SELECT payload->>'roomId' AS room_id FROM world_events
        WHERE type = 'stage.started' AND payload->>'eventId' = $1`,
      [event.id],
    );
    expect(payload[0]!.room_id).toBe(`${space.id}:stage`);
  });

  it("announces an end once, and only after it announced the start", async () => {
    const { owner, space } = await makeStage();
    const event = await grove.campus.createEvent(owner, {
      worldId: space.id,
      title: "Short set",
      startsAt: new Date(Date.now() - 120_000).toISOString(),
      endsAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await grove.campus.stageNow(space.id);
    await grove.campus.stageNow(space.id);

    const { rows } = await pg.query<{ type: string; n: string }>(
      `SELECT type, count(*)::text AS n FROM world_events
        WHERE payload->>'eventId' = $1 GROUP BY type ORDER BY type`,
      [event.id],
    );
    expect(rows.map((r) => [r.type, Number(r.n)])).toEqual([
      ["stage.ended", 1],
      ["stage.started", 1],
    ]);
  });
});
