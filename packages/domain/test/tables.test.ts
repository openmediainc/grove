/**
 * Turn-based boards (#42). The properties that matter:
 *  - the referee is the pure rules: turn order, legality, the end of a game;
 *  - only the two players move; a spectator, a stranger, a third party cannot;
 *  - sitting and moving are kernel-checked like speech in that room (unclaimed
 *    and listen-only agents, watch-only spaces, blocks);
 *  - a private space's tables are a 404 to outsiders, in the list, the table
 *    itself, the chronicle, and the room's live frames;
 *  - the move clock: a player who lets it run out loses, exactly once;
 *  - moves and a game's end are chronicle rows; a game's end can be cheered.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { tableFrame, type TableActor } from "../src/services/tables.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.tables;
const hasDb = hasTestDatabase();
const ANON = { humanId: null, isOperator: false };

describe("table frames", () => {
  it("carry the audience for the room socket's filter, and nothing about the board", () => {
    const f = tableFrame("tbl_1", "library", "active", 3, ["hum_a"]);
    expect(f).toEqual({ type: "table_update", table_id: "tbl_1", room_id: "library", status: "active", move_count: 3, delivered_to: ["hum_a"] });
  });
});

describe.skipIf(!hasDb)("turn-based board tables", { timeout: 60_000 }, () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the tables suite");
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
    await clearActorLimiters(redis, human.id);
    return human;
  }

  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, claim = true) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name: `player${tag()}`, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    if (!claim) return reg.agent;
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);
    await clearActorLimiters(redis, agent.id);
    return agent;
  }

  const H = (human: Awaited<ReturnType<typeof newHuman>>): TableActor => ({ kind: "human", human });
  const A = (agent: Awaited<ReturnType<typeof newAgent>>): TableActor => ({ kind: "agent", agent });

  async function space(owner: Awaited<ReturnType<typeof newHuman>>, preset: "private" | "public_view" | "public_write") {
    const w = await grove.campus.createWorld(owner, { name: `Tables ${tag()}`, slug: `tables-${tag()}`, preset });
    fixtures.trackWorld(w.id);
    return w;
  }

  it("referees four-in-a-row: turn order, players only, the end, and the chronicle", async () => {
    const alice = await newHuman("t-alice");
    const bobOwner = await newHuman("t-bobowner");
    const bob = await newAgent(bobOwner);
    const carol = await newHuman("t-carol");

    const opened = await grove.tables.create(H(alice), { room: "library", game: "four", clock: "live" });
    expect(opened).toMatchObject({ status: "waiting", game: "four", clock: "live", moveSeconds: 300, roomId: "library", yourSeat: 0 });
    expect(opened.players).toHaveLength(1);
    // Nobody can move before the second seat is taken.
    await expect(grove.tables.move(H(alice), opened.id, "4")).rejects.toMatchObject({ code: "CONFLICT" });

    const joined = await grove.tables.join(A(bob), opened.id);
    expect(joined).toMatchObject({ status: "active", turn: 0, yourSeat: 1, legalMoves: [] });
    expect(joined.turnDeadline).not.toBeNull();
    // A third body cannot take a seat, and a spectator cannot move.
    await expect(grove.tables.join(H(carol), opened.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(grove.tables.move(H(carol), opened.id, "1")).rejects.toMatchObject({ code: "CONFLICT" });
    // Out of turn.
    await expect(grove.tables.move(A(bob), opened.id, "1")).rejects.toMatchObject({ code: "CONFLICT", message: "It is not your turn." });
    // Illegal.
    await expect(grove.tables.move(H(alice), opened.id, "9")).rejects.toMatchObject({ code: "INVALID" });

    const aliceView = await grove.tables.get(H(alice), opened.id);
    expect(aliceView.legalMoves).toEqual(["1", "2", "3", "4", "5", "6", "7"]);

    for (const [who, col] of [
      [alice, "1"], [bob, "1"], [alice, "2"], [bob, "2"], [alice, "3"], [bob, "3"],
    ] as const) {
      await grove.tables.move("handle" in who ? H(who) : A(who), opened.id, col);
    }
    const won = await grove.tables.move(H(alice), opened.id, "4");
    expect(won).toMatchObject({ status: "ended", result: { winner: 0, reason: "four_in_a_row" }, moveCount: 7, turn: null });
    expect(won.moves.map((m) => m.notation)).toEqual(["1", "1", "2", "2", "3", "3", "4"]);
    expect(won.endedEventId).not.toBeNull();
    await expect(grove.tables.move(A(bob), opened.id, "5")).rejects.toMatchObject({ code: "CONFLICT" });

    // A signed-out visitor watches the whole game.
    const anon = await grove.tables.get(null, opened.id);
    expect(anon.moves).toHaveLength(7);
    expect(anon.yourSeat).toBeNull();
    expect((await grove.tables.list(null, { room: "library" })).map((t) => t.id)).toContain(opened.id);

    // Ledger: created, seven moves, ended — public in a public room, in order.
    const page = await grove.chronicle.read(ANON, { types: ["table.created", "table.moved", "table.ended"], limit: 200 });
    const mine = page.entries.filter((e) => e.detail.tableId === opened.id).reverse();
    expect(mine.map((e) => e.type)).toEqual(["table.created", ...Array(7).fill("table.moved"), "table.ended"]);
    const ended = mine[mine.length - 1]!;
    expect(ended.kind).toBe("game");
    expect(ended.actor?.id).toBe(alice.id);
    expect(ended.summary).toContain("won at four-in-a-row against");
    expect(ended.summary).toContain(bob.slug);
    expect(ended.reactionTarget).toEqual({ kind: "event", id: ended.id });
    expect(mine[1]!.reactionTarget).toBeNull();
    // People cheer a game's end like any other moment.
    const cheer = await grove.reactions.react(H(carol) as never, { targetKind: "event", targetId: ended.id, emoji: "heart" });
    expect(cheer.summary.counts).toEqual({ heart: 1 });
  });

  it("plays chess in SAN or UCI, offers and agrees draws, and resigns", async () => {
    const owner = await newHuman("t-chess-owner");
    const agent = await newAgent(owner);
    const human = await newHuman("t-chess-human");
    const w = await space(owner, "public_write");
    const room = `${w.id}:library`;

    const t = await grove.tables.create(A(agent), { room, game: "chess" });
    expect(t.clock).toBe("async");
    await grove.tables.join(H(human), t.id);
    const e4 = await grove.tables.move(A(agent), t.id, "e4");
    expect(e4.moves[0]).toMatchObject({ move: "e2e4", notation: "e4", seat: 0 });
    expect(e4.fen).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
    const e5 = await grove.tables.move(H(human), t.id, "e7e5");
    expect(e5.legalMoves).toEqual([]);
    expect((await grove.tables.get(A(agent), t.id)).legalMoves).toContain("g1f3");

    // A draw offer stands until the other player moves; accepting ends it.
    const offered = await grove.tables.move(A(agent), t.id, "draw");
    expect(offered.drawOffer).toBe(0);
    await grove.tables.move(A(agent), t.id, "Nf3");
    expect((await grove.tables.get(null, t.id)).drawOffer).toBe(0);
    await grove.tables.move(H(human), t.id, "Nc6");
    expect((await grove.tables.get(null, t.id)).drawOffer).toBeNull();
    await grove.tables.offerDraw(H(human), t.id);
    const drawn = await grove.tables.offerDraw(A(agent), t.id);
    expect(drawn).toMatchObject({ status: "ended", result: { winner: null, reason: "agreed_draw" } });

    const t2 = await grove.tables.create(H(human), { room, game: "chess", clock: "live" });
    await grove.tables.join(A(agent), t2.id);
    const resigned = await grove.tables.move(H(human), t2.id, "resign");
    expect(resigned).toMatchObject({ status: "ended", result: { winner: 1, reason: "resigned" } });
  });

  it("loses a player on time, once, and clears a table nobody joined", async () => {
    const a = await newHuman("t-clock-a");
    const b = await newHuman("t-clock-b");
    const w = await space(a, "public_write");
    const room = `${w.id}:garden`;
    const t = await grove.tables.create(H(a), { room, game: "four", clock: "live" });
    await grove.tables.join(H(b), t.id);
    await grove.tables.move(H(a), t.id, "4");
    // b's clock runs out.
    await pg.query(`UPDATE board_tables SET turn_deadline = now() - interval '1 second' WHERE id = $1`, [t.id]);
    await Promise.all([grove.tables.advance(), grove.tables.advance(), grove.tables.advance()]);
    const after = await grove.tables.get(H(b), t.id);
    expect(after).toMatchObject({ status: "ended", result: { winner: 0, reason: "timeout" } });
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM world_events WHERE type = 'table.ended' AND payload->>'tableId' = $1`, [t.id]);
    expect(rows[0].n).toBe(1);

    const lonely = await grove.tables.create(H(a), { room, game: "chess" });
    await pg.query(`UPDATE board_tables SET created_at = now() - interval '8 days' WHERE id = $1`, [lonely.id]);
    await grove.tables.advance();
    expect(await grove.tables.get(H(a), lonely.id)).toMatchObject({ status: "ended", result: { winner: null, reason: "abandoned" } });
    expect((await grove.tables.list(H(a), { room })).map((x) => x.id)).not.toContain(lonely.id);

    // Leaving a waiting table clears it; leaving a game in progress is resigning.
    const left = await grove.tables.create(H(b), { room, game: "four" });
    expect((await grove.tables.leave(H(b), left.id)).status).toBe("ended");
  });

  it("asks the kernel: claimed agents with a mouth, rooms that take speech, open ceilings, no blocks", async () => {
    const owner = await newHuman("t-kernel-owner");
    const unclaimed = await newAgent(owner, false);
    await expect(grove.tables.create(A(unclaimed), { room: "library", game: "four" })).rejects.toMatchObject({ code: "UNCLAIMED" });

    const quiet = await newAgent(owner);
    const listenOnly = await grove.identity.patchPolicy(quiet.id, owner, { speakToAgents: false, speakToHumans: false });
    await expect(grove.tables.create(A(listenOnly), { room: "library", game: "four" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });

    // A watch-only space: outsiders watch, members play.
    const outsider = await newHuman("t-kernel-outsider");
    const view = await space(owner, "public_view");
    const viewRoom = `${view.id}:plaza`;
    await expect(grove.tables.create(H(outsider), { room: viewRoom, game: "four" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const t = await grove.tables.create(H(owner), { room: viewRoom, game: "four" });
    expect((await grove.tables.list(H(outsider), { room: viewRoom })).map((x) => x.id)).toContain(t.id);
    await expect(grove.tables.join(H(outsider), t.id)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    // A block keeps two people from sitting together, whichever side set it.
    const rival = await newHuman("t-kernel-rival");
    const open = await space(owner, "public_write");
    const t2 = await grove.tables.create(H(owner), { room: `${open.id}:plaza`, game: "four" });
    await grove.moderation.block(owner, rival.id);
    await expect(grove.tables.join(H(rival), t2.id)).rejects.toMatchObject({ code: "BLOCKED" });
  });

  it("keeps a private space's tables behind its door: list, table, chronicle and live frames", async () => {
    const owner = await newHuman("t-private-owner");
    const outsider = await newHuman("t-private-outsider");
    const outsiderAgent = await newAgent(outsider);
    const shut = await space(owner, "private");
    const room = `${shut.id}:plaza`;

    await grove.presence.enter({ id: owner.id, kind: "human" }, room, { connection: "live", mode: "active", activity: "idle", worldId: shut.id });
    // Somebody standing in the room without being inside the space (a lobby
    // visitor's position): they must not hear the table either.
    await grove.presence.enter({ id: outsider.id, kind: "human" }, room, { connection: "live", mode: "active", activity: "idle", worldId: shut.id });
    await clearActorLimiters(redis, owner.id);
    await clearActorLimiters(redis, outsider.id);

    const sub = redis.duplicate();
    const frames: Array<Record<string, unknown>> = [];
    await sub.subscribe(`pubsub:room:${room}`);
    sub.on("message", (_ch, m) => {
      const f = JSON.parse(m) as Record<string, unknown>;
      if (f.type === "table_update") frames.push(f);
    });
    try {
      const t = await grove.tables.create(H(owner), { room, game: "chess" });
      for (let i = 0; i < 40 && !frames.length; i++) await new Promise((r) => setTimeout(r, 25));
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]!.delivered_to).toContain(owner.id);
      expect(frames[0]!.delivered_to).not.toContain(outsider.id);

      for (const viewer of [null, H(outsider), A(outsiderAgent)]) {
        await expect(grove.tables.get(viewer, t.id)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
        await expect(grove.tables.list(viewer, { room })).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
        expect((await grove.tables.list(viewer)).map((x) => x.id)).not.toContain(t.id);
        expect((await grove.tables.playing(viewer)).tables.map((x) => x.id)).not.toContain(t.id);
      }
      await expect(grove.tables.join(H(outsider), t.id)).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
      await expect(grove.tables.create(H(outsider), { room, game: "four" })).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
      // The same 404 as a table that never existed.
      await expect(grove.tables.get(H(outsider), "tbl_01NOPE")).rejects.toMatchObject({ code: "NOT_FOUND", message: "No such table." });

      expect((await grove.tables.get(H(owner), t.id)).status).toBe("waiting");
      const outsiderChronicle = await grove.chronicle.read({ humanId: outsider.id, isOperator: false }, { types: ["table.created"], limit: 200 });
      expect(outsiderChronicle.entries.some((e) => e.detail.tableId === t.id)).toBe(false);
      const ownerChronicle = await grove.chronicle.read({ humanId: owner.id, isOperator: false }, { types: ["table.created"], limit: 200 });
      expect(ownerChronicle.entries.some((e) => e.detail.tableId === t.id)).toBe(true);
    } finally {
      await sub.quit();
    }
  });

  it("lists who is playing for the map, and rate limits moves", async () => {
    const a = await newHuman("t-play-a");
    const b = await newHuman("t-play-b");
    const w = await space(a, "public_write");
    const t = await grove.tables.create(H(a), { room: `${w.id}:workshop`, game: "chess", clock: "live" });
    await grove.tables.join(H(b), t.id);
    await grove.tables.move(H(a), t.id, "d4");
    const playing = (await grove.tables.playing(null)).tables.find((x) => x.id === t.id);
    expect(playing).toMatchObject({ status: "active", seats: [a.id, b.id], turn: 1, lastMove: { notation: "d4", actorId: a.id } });

    await redis.set(`ratelimit:${b.id}:table_move:min`, "30", "EX", 60);
    await expect(grove.tables.move(H(b), t.id, "d5")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
