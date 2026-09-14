import {
  BOARD_GAME_NAMES,
  TABLE_CLOCKS,
  WORLD_ID,
  applyBoardMove,
  initialBoardState,
  isBoardGame,
  isBoardState,
  isTableClock,
  legalBoardMoves,
  type Agent,
  type BoardEndReason,
  type BoardGame,
  type BoardState,
  type Human,
  type PolicyContext,
  type Seat,
  type TableClock,
  type TableMoveView,
  type TablePlayerView,
  type TableStatus,
  type TableView,
} from "@grove/protocol";
import { authorize } from "@grove/policy";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import { roomActivityVisibleSql } from "../visibility.js";
import type { CampusService } from "./campus.js";
import type { PresenceService } from "./presence.js";
import { isFirst24h, type QuotaService } from "./quota.js";
import type { SpeechService } from "./speech.js";

/** Who is at, or looking at, a table. A signed-out visitor is `null`. */
export type TableActor = { kind: "human"; human: Human } | { kind: "agent"; agent: Agent };

/** Unfinished tables one actor may be seated at, at once. */
export const TABLE_SEATED_MAX = 5;
/** Unfinished tables one room holds, at once. */
export const TABLE_ROOM_OPEN_MAX = 12;
/** A table nobody joined is cleared after this long. */
export const TABLE_WAITING_TTL_HOURS = 7 * 24;
/** A finished game stays listed in its room this long. */
export const TABLE_ENDED_SHOWN_HOURS = 24;
/** Moves returned with a table. A chess game longer than this is truncated from the front. */
export const TABLE_MOVES_MAX = 600;

const NEXT_EVENT_ID = `nextval(pg_get_serial_sequence('world_events', 'id'))`;
/** Drawn in `delivered_to` frames: the actors in a room who may watch its tables. */
const TABLE_FRAME = "table_update";

type Row = Record<string, unknown>;

function iso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function actorIdOf(a: TableActor): string {
  return a.kind === "human" ? a.human.id : a.agent.id;
}

/** The human a viewer reads as: themself, or an agent's owner. */
function viewerHumanId(a: TableActor | null): string | null {
  if (!a) return null;
  return a.kind === "human" ? a.human.id : a.agent.ownerHumanId ?? null;
}

function clockOf(seconds: number): TableClock {
  return seconds <= TABLE_CLOCKS.live ? "live" : "async";
}

/** A table's event payload, built in SQL from a board_tables row aliased `t`. `roomId` feeds the place gate. */
function payloadSql(t: string, extra = ""): string {
  return `jsonb_build_object('tableId', ${t}.id, 'roomId', ${t}.room_id, 'game', ${t}.game${extra ? `, ${extra}` : ""})`;
}

/** SQL: this table is visible to the viewer (`$v` human id) or the actor (`$a`) is seated at it. */
function tableVisibleSql(t: string, r: string, w: string, viewer: string, actor: string): string {
  return `(${roomActivityVisibleSql(r, w, viewer)} OR (${actor}::text IS NOT NULL AND (${t}.seat0_id = ${actor}::text OR ${t}.seat1_id = ${actor}::text)))`;
}

export interface TableDetail extends TableView {
  moves: TableMoveView[];
  /** Your seat, when the reader is a player. */
  yourSeat: Seat | null;
  /** Legal moves, only for the player whose turn it is. Columns "1".."7", or UCI. */
  legalMoves: string[];
}

/**
 * Turn-based boards (queue #42). See @grove/protocol boards.ts for the games.
 *
 * WHO MAY WATCH. Exactly who may see activity in the table's room: the
 * chronicle's place gate (visibility.ts). A private space or private room
 * answers 404 to everyone outside it, byte-identical to a table that never
 * existed. The two players always see their own table. An agent watching a
 * table it is not playing at needs an ear (listen to agents or to humans).
 *
 * WHO MAY PLAY. Sitting down and every move afterwards ask the permission
 * kernel whether the actor may speak in that room (`authorize()` on
 * `room_say`, with the room's space and room ceilings and the actor's
 * membership): a watch-only space seats nobody from outside, a listen-only or
 * unclaimed agent cannot sit, a room without public speech has no tables, and
 * a block between two players keeps them from sitting together. The kernel is
 * asked for the ceiling only — moves are charged to their own limiter
 * (`table_move`), never to room_say, so playing never silences a line.
 *
 * THE REFEREE. Legality comes from the pure rules in @grove/protocol and
 * nothing else; a move is one UPDATE guarded by move_count, so two moves racing
 * for the same turn cannot both land. Each move, and a game's end, writes its
 * chronicle row in the same statement.
 *
 * THE CLOCK. Every move sets a deadline (5 minutes live, 24 hours async); a
 * player who lets it pass loses. Like trials there is no scheduler: `advance()`
 * runs on reads and on the tick, and each timeout is claimed exactly once.
 */
export class TableService {
  constructor(
    private store: GroveStore,
    private quota: QuotaService,
    private presence: PresenceService,
    private campus: CampusService,
    private speech: SpeechService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Tables a viewer may see: in one room (unfinished, plus games that ended in
   * the last day), or everywhere (unfinished only) when no room is named.
   */
  async list(viewer: TableActor | null, input: { room?: unknown } = {}): Promise<TableView[]> {
    await this.advance();
    let roomId: string | null = null;
    if (input.room != null && input.room !== "") {
      const room = await this.resolveVisibleRoom(viewer, input.room);
      roomId = room.id;
    }
    const actorId = viewer ? actorIdOf(viewer) : null;
    const { rows } = await this.store.pg.query(
      `SELECT t.id FROM board_tables t
         JOIN rooms r ON r.id = t.room_id
         LEFT JOIN worlds w ON w.id = r.world_id
        WHERE ${tableVisibleSql("t", "r", "w", "$1", "$2")}
          AND ($3::text IS NULL OR t.room_id = $3::text)
          AND (t.status <> 'ended' OR ($3::text IS NOT NULL AND t.ended_at > now() - make_interval(hours => $4)
                                        AND t.end_reason IS DISTINCT FROM 'abandoned'))
        ORDER BY (t.status = 'ended'), t.updated_at DESC
        LIMIT 40`,
      [viewerHumanId(viewer), actorId, roomId, TABLE_ENDED_SHOWN_HOURS],
    );
    if (viewer && !(await this.mayWatchAsAgent(viewer))) {
      // An agent with no ear sees only the tables it plays at.
      const own: TableView[] = [];
      for (const r of rows) {
        const v = await this.view(String(r.id));
        if (v && v.players.some((p) => p.actorId === actorId)) own.push(v);
      }
      return own;
    }
    const out: TableView[] = [];
    for (const r of rows) {
      const v = await this.view(String(r.id));
      if (v) out.push(v);
    }
    return out;
  }

  /** One table with its moves, or a 404 for anyone who may not watch it. */
  async get(viewer: TableActor | null, tableId: string): Promise<TableDetail> {
    await this.advance();
    const t = await this.visibleRow(viewer, tableId);
    if (!t) throw notFound();
    const view = (await this.view(String(t.id)))!;
    const actorId = viewer ? actorIdOf(viewer) : null;
    const yourSeat: Seat | null = actorId === t.seat0_id ? 0 : actorId === t.seat1_id ? 1 : null;
    const { rows } = await this.store.pg.query(
      `SELECT seq, seat, actor_id, move, notation, at FROM (
         SELECT * FROM board_moves WHERE table_id = $1 ORDER BY seq DESC LIMIT $2
       ) m ORDER BY seq`,
      [t.id, TABLE_MOVES_MAX],
    );
    const moves: TableMoveView[] = (rows as Row[]).map((m) => ({
      seq: Number(m.seq),
      seat: Number(m.seat) === 1 ? 1 : 0,
      actorId: String(m.actor_id),
      move: String(m.move),
      notation: String(m.notation),
      at: iso(m.at)!,
    }));
    const legalMoves = view.status === "active" && yourSeat !== null && view.turn === yourSeat ? legalBoardMoves(view.state) : [];
    return { ...view, moves, yourSeat, legalMoves };
  }

  /**
   * Bodies at unfinished tables the viewer may see, for the map's "playing"
   * glyph and Grove TV, plus games that ended in the last few minutes.
   */
  async playing(viewer: TableActor | null): Promise<{
    tables: Array<{
      id: string;
      game: BoardGame;
      roomId: string;
      status: TableStatus;
      seats: [string | null, string | null];
      turn: Seat | null;
      lastMove: { notation: string; actorId: string; at: string } | null;
      result: { winner: Seat | null; reason: string; at: string } | null;
    }>;
  }> {
    await this.advance();
    const { rows } = await this.store.pg.query(
      `SELECT t.id, t.game, t.room_id, t.status, t.seat0_id, t.seat1_id, t.turn_seat, t.winner_seat, t.end_reason, t.ended_at,
              lm.notation AS last_notation, lm.actor_id AS last_actor, lm.at AS last_at
         FROM board_tables t
         JOIN rooms r ON r.id = t.room_id
         LEFT JOIN worlds w ON w.id = r.world_id
         LEFT JOIN LATERAL (SELECT notation, actor_id, at FROM board_moves m WHERE m.table_id = t.id ORDER BY seq DESC LIMIT 1) lm ON TRUE
        WHERE ${roomActivityVisibleSql("r", "w", "$1")}
          AND (t.status = 'active' OR (t.status = 'ended' AND t.ended_at > now() - interval '5 minutes'
                                       AND t.end_reason IS DISTINCT FROM 'abandoned'))
        ORDER BY t.updated_at DESC
        LIMIT 100`,
      [viewerHumanId(viewer)],
    );
    return {
      tables: (rows as Row[]).map((r) => ({
        id: String(r.id),
        game: String(r.game) as BoardGame,
        roomId: String(r.room_id),
        status: String(r.status) as TableStatus,
        seats: [r.seat0_id == null ? null : String(r.seat0_id), r.seat1_id == null ? null : String(r.seat1_id)],
        turn: r.status === "active" ? (Number(r.turn_seat) === 1 ? 1 : 0) : null,
        lastMove: r.last_notation == null ? null : { notation: String(r.last_notation), actorId: String(r.last_actor), at: iso(r.last_at)! },
        result:
          r.status === "ended"
            ? { winner: r.winner_seat == null ? null : Number(r.winner_seat) === 1 ? 1 : 0, reason: String(r.end_reason), at: iso(r.ended_at)! }
            : null,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Players
  // ---------------------------------------------------------------------------

  /** Open a table in a room and take the first seat (you move first). */
  async create(actor: TableActor, input: { room?: unknown; game?: unknown; clock?: unknown }): Promise<TableDetail> {
    if (!isBoardGame(input.game)) throw new GroveError("INVALID", "game must be four or chess.");
    const clock: TableClock = input.clock == null || input.clock === "" ? "async" : isTableClock(input.clock) ? input.clock : invalidClock();
    await this.advance();
    const room = await this.resolveVisibleRoom(actor, input.room);
    if (room.kind === "owner_lounge") {
      throw new GroveError("ROOM_FORBIDDEN", "Tables are set in rooms people can watch, not in an owner's lounge.");
    }
    await this.assertMayPlay(actor, room.id, null);
    const actorId = actorIdOf(actor);
    await this.assertSeatRoom(actorId);
    const { rows: busy } = await this.store.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM board_tables WHERE room_id = $1 AND status <> 'ended'`,
      [room.id],
    );
    if ((busy[0]?.n ?? 0) >= TABLE_ROOM_OPEN_MAX) {
      throw new GroveError("CONFLICT", `This room already has ${TABLE_ROOM_OPEN_MAX} tables going. Join one, or wait for a game to end.`);
    }
    await this.quota.consumeWrite(actorId, this.tight(actor));
    const id = newId("table");
    const state = initialBoardState(input.game);
    await this.store.pg.query(
      `WITH ins AS (
         INSERT INTO board_tables (id, room_id, game, move_seconds, seat0_id, state, created_by, created_event_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $5, ${NEXT_EVENT_ID})
         RETURNING *
       )
       INSERT INTO world_events (id, type, actor_id, payload)
       SELECT i.created_event_id, 'table.created', i.created_by, ${payloadSql("i", "'clock', $7::text")} FROM ins i`,
      [id, room.id, input.game, TABLE_CLOCKS[clock], actorId, JSON.stringify(state), clock],
    );
    await this.publish(id, room.id);
    return this.get(actor, id);
  }

  /** Take the empty seat. The game starts, and the first player's clock starts with it. */
  async join(actor: TableActor, tableId: string): Promise<TableDetail> {
    await this.advance();
    const t = await this.visibleRow(actor, tableId);
    if (!t) throw notFound();
    const actorId = actorIdOf(actor);
    if (t.seat0_id === actorId || t.seat1_id === actorId) return this.get(actor, tableId);
    if (t.status !== "waiting") throw new GroveError("CONFLICT", "Both seats are taken.");
    await this.assertMayPlay(actor, String(t.room_id), String(t.seat0_id));
    await this.assertSeatRoom(actorId);
    await this.quota.consumeWrite(actorId, this.tight(actor));
    const { rowCount } = await this.store.pg.query(
      `UPDATE board_tables
          SET seat1_id = $2, status = 'active', turn_seat = 0, updated_at = now(),
              turn_deadline = now() + make_interval(secs => move_seconds)
        WHERE id = $1 AND status = 'waiting' AND seat1_id IS NULL AND seat0_id IS NOT NULL AND seat0_id <> $2`,
      [tableId, actorId],
    );
    if (!rowCount) throw new GroveError("CONFLICT", "Somebody took that seat first.");
    await this.publish(tableId, String(t.room_id));
    return this.get(actor, tableId);
  }

  /** Get up from a table nobody has joined yet. The table is cleared, quietly. */
  async leave(actor: TableActor, tableId: string): Promise<TableDetail> {
    await this.advance();
    const t = await this.visibleRow(actor, tableId);
    if (!t) throw notFound();
    const actorId = actorIdOf(actor);
    if (t.seat0_id !== actorId && t.seat1_id !== actorId) throw new GroveError("CONFLICT", "You are not seated at this table.");
    if (t.status === "active") throw new GroveError("CONFLICT", "The game has started: resign instead.");
    if (t.status === "waiting") {
      await this.store.pg.query(
        `UPDATE board_tables SET status = 'ended', end_reason = 'abandoned', ended_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'waiting'`,
        [tableId],
      );
      await this.publish(tableId, String(t.room_id));
    }
    return this.get(actor, tableId);
  }

  /**
   * Play a move. Also accepts the words "resign" and "draw" (offer, or accept
   * the standing offer), so one tool covers a whole game.
   */
  async move(actor: TableActor, tableId: string, input: unknown): Promise<TableDetail> {
    const word = typeof input === "string" ? input.trim().toLowerCase() : "";
    if (word === "resign") return this.resign(actor, tableId);
    if (word === "draw") return this.offerDraw(actor, tableId);
    const { t, seat } = await this.seated(actor, tableId);
    const state = t.state as BoardState;
    if (!isBoardState(state)) throw new GroveError("CONFLICT", "This board cannot be read.");
    const result = applyBoardMove(state, seat, input);
    if (!result.ok) {
      throw new GroveError(result.reason === "It is not your turn." ? "CONFLICT" : "INVALID", result.reason);
    }
    await this.quota.consumeTableMove(actorIdOf(actor));
    const over = result.outcome.over;
    const winner = over ? result.outcome.winner : null;
    const reason = over ? result.outcome.reason : null;
    const [movedId, endedId] = await this.eventIds(2);
    const { rows } = await this.store.pg.query(
      `WITH up AS (
         UPDATE board_tables
            SET state = $2::jsonb, move_count = move_count + 1, turn_seat = 1 - turn_seat, updated_at = now(),
                draw_offer = CASE WHEN draw_offer = $4::smallint THEN draw_offer END,
                status = CASE WHEN $6::bool THEN 'ended' ELSE 'active' END,
                turn_deadline = CASE WHEN $6::bool THEN NULL ELSE now() + make_interval(secs => move_seconds) END,
                winner_seat = $7::smallint, end_reason = $8::text,
                ended_at = CASE WHEN $6::bool THEN now() END,
                ended_event_id = CASE WHEN $6::bool THEN $10::bigint END
          WHERE id = $1 AND status = 'active' AND move_count = $3::int AND turn_seat = $4::smallint
          RETURNING *
       ),
       mv AS (
         INSERT INTO board_moves (table_id, seq, seat, actor_id, move, notation, event_id)
         SELECT up.id, up.move_count, $4::smallint, $5::text, $9::text, $11::text, $12::bigint FROM up
         RETURNING *
       ),
       moved AS (
         INSERT INTO world_events (id, type, actor_id, payload)
         SELECT mv.event_id, 'table.moved', mv.actor_id,
                ${payloadSql("up", "'seq', mv.seq, 'move', mv.notation")}
           FROM mv JOIN up ON up.id = mv.table_id
         RETURNING 1
       ),
       ended AS (
         ${endedEventSql("up")}
         RETURNING 1
       )
       SELECT up.id FROM up`,
      [
        tableId,
        JSON.stringify(result.state),
        Number(t.move_count),
        seat,
        actorIdOf(actor),
        over,
        winner,
        reason,
        result.move,
        endedId,
        result.notation,
        movedId,
      ],
    );
    if (!rows[0]) throw new GroveError("CONFLICT", "The board changed before your move landed. Read the table again.");
    await this.publish(tableId, String(t.room_id));
    return this.get(actor, tableId);
  }

  /** Resign: the other player wins. */
  async resign(actor: TableActor, tableId: string): Promise<TableDetail> {
    const { t, seat } = await this.seated(actor, tableId, { skipKernel: true });
    await this.quota.consumeTableMove(actorIdOf(actor));
    await this.end(tableId, Number(t.move_count), seat === 0 ? 1 : 0, "resigned");
    await this.publish(tableId, String(t.room_id));
    return this.get(actor, tableId);
  }

  /** Offer a draw, or accept the one your opponent offered. A move by the other player declines it. */
  async offerDraw(actor: TableActor, tableId: string): Promise<TableDetail> {
    const { t, seat } = await this.seated(actor, tableId);
    await this.quota.consumeTableMove(actorIdOf(actor));
    const standing = t.draw_offer == null ? null : Number(t.draw_offer);
    if (standing !== null && standing !== seat) {
      await this.end(tableId, Number(t.move_count), null, "agreed_draw");
    } else if (standing === null) {
      await this.store.pg.query(
        `UPDATE board_tables SET draw_offer = $2, updated_at = now() WHERE id = $1 AND status = 'active' AND draw_offer IS NULL`,
        [tableId, seat],
      );
    }
    await this.publish(tableId, String(t.room_id));
    return this.get(actor, tableId);
  }

  // ---------------------------------------------------------------------------
  // The clock
  // ---------------------------------------------------------------------------

  /**
   * A player whose deadline passed loses on time; a table nobody joined for a
   * week is cleared without a word. Each claimed once, by one statement that
   * also writes the `table.ended` row.
   */
  async advance(): Promise<void> {
    const { rows } = await this.store.pg.query(
      `WITH due AS (
         SELECT id FROM board_tables WHERE status = 'active' AND turn_deadline <= now()
          ORDER BY turn_deadline LIMIT 50 FOR UPDATE SKIP LOCKED
       ),
       up AS (
         UPDATE board_tables t
            SET status = 'ended', end_reason = 'timeout', winner_seat = 1 - t.turn_seat,
                ended_at = now(), updated_at = now(), turn_deadline = NULL, draw_offer = NULL,
                ended_event_id = ${NEXT_EVENT_ID}
           FROM due WHERE t.id = due.id AND t.status = 'active'
          RETURNING t.*
       ),
       ended AS (
         ${endedEventSql("up")}
         RETURNING 1
       )
       SELECT id, room_id FROM up`,
    );
    await this.store.pg.query(
      `UPDATE board_tables SET status = 'ended', end_reason = 'abandoned', ended_at = now(), updated_at = now()
        WHERE status = 'waiting' AND created_at <= now() - make_interval(hours => $1)`,
      [TABLE_WAITING_TTL_HOURS],
    );
    for (const r of rows) await this.publish(String(r.id), String(r.room_id));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async end(tableId: string, moveCount: number, winner: Seat | null, reason: BoardEndReason): Promise<void> {
    const [endedId] = await this.eventIds(1);
    const { rows } = await this.store.pg.query(
      `WITH up AS (
         UPDATE board_tables
            SET status = 'ended', winner_seat = $3::smallint, end_reason = $4::text, ended_at = now(), updated_at = now(),
                turn_deadline = NULL, draw_offer = NULL, ended_event_id = $5::bigint
          WHERE id = $1 AND status = 'active' AND move_count = $2
          RETURNING *
       ),
       ended AS (
         ${endedEventSql("up")}
         RETURNING 1
       )
       SELECT id FROM up`,
      [tableId, moveCount, winner, reason, endedId],
    );
    if (!rows[0]) throw new GroveError("CONFLICT", "The board changed first. Read the table again.");
  }

  /** The table and the caller's seat, for an act by a player in an active game. Kernel-checked per act. */
  private async seated(actor: TableActor, tableId: string, opts: { skipKernel?: boolean } = {}): Promise<{ t: Row; seat: Seat }> {
    await this.advance();
    const t = await this.visibleRow(actor, tableId);
    if (!t) throw notFound();
    const actorId = actorIdOf(actor);
    const seat: Seat | null = t.seat0_id === actorId ? 0 : t.seat1_id === actorId ? 1 : null;
    if (seat === null) throw new GroveError("CONFLICT", "You are watching this table, not playing at it.");
    if (t.status === "waiting") throw new GroveError("CONFLICT", "Waiting for a second player.");
    if (t.status === "ended") throw new GroveError("CONFLICT", "This game is over.");
    // Giving up is never refused: a player the room has since closed to must
    // still be able to end their own game rather than wait out the clock.
    if (!opts.skipKernel) {
      const opponent = seat === 0 ? t.seat1_id : t.seat0_id;
      await this.assertMayPlay(actor, String(t.room_id), opponent == null ? null : String(opponent));
    }
    return { t, seat };
  }

  /**
   * Ask the kernel whether this actor may speak in the room — the ceiling a
   * seat requires. Quota is supplied open: moves have their own limiter, and a
   * seat must not depend on how recently someone said a line.
   */
  private async assertMayPlay(actor: TableActor, roomId: string, opponentId: string | null): Promise<void> {
    const room = await this.presence.getRoomById(roomId);
    if (!room) throw notFound();
    const senderId = actorIdOf(actor);
    const sender: PolicyContext["sender"] =
      actor.kind === "human"
        ? { id: actor.human.id, kind: "human", privacy: actor.human.privacy }
        : {
            id: actor.agent.id,
            kind: "agent",
            ownerHumanId: actor.agent.ownerHumanId,
            claimState: actor.agent.claimState,
            policy: actor.agent.policy,
            privacy: actor.agent.privacy,
          };
    const recipients: PolicyContext["recipients"] = [];
    if (opponentId && opponentId !== senderId) {
      const rec = await this.speech.loadRecipientPublic(opponentId, senderId);
      if (rec) recipients.push(rec);
    }
    const layers = await this.campus.ceilingLayersForRoom(room.id);
    const members = await this.campus.memberIdsOf(await this.campus.worldIdForRoom(room.id));
    const isMember = (ownerHumanId: string | null | undefined, id: string, kind: "human" | "agent") => {
      if (members === null) return true;
      const humanId = kind === "human" ? id : ownerHumanId;
      return Boolean(humanId && members.has(humanId));
    };
    sender.isSpaceMember = isMember(sender.ownerHumanId, sender.id, sender.kind);
    for (const r of recipients) r.isSpaceMember = isMember(r.ownerHumanId, r.id, r.kind);
    const result = authorize({
      sender,
      recipients,
      channel: "room_say",
      room: {
        id: room.id,
        kind: room.kind,
        allowsRoomSay: room.allowsRoomSay,
        allowsWhisper: room.allowsWhisper,
        sayLimitPerMin: room.sayLimitPerMin,
        capacity: room.capacity,
        ...(layers ?? {}),
      },
      quota: { roomSayRemaining: 1, roomSayGapOk: true, writeRemaining: 1, roomWindowCount: 0 },
      isOwnerChannel: false,
    });
    if (!result.emit.allow) {
      const e = result.emit;
      const reason = e.code === "UNCLAIMED" ? "Only a claimed agent can sit at a table." : e.reason;
      throw new GroveError(e.code, reason, { capability: e.capability, source: e.source, subject: e.subject, party: e.party, membership: e.membership });
    }
    if (result.deliveries.some((d) => d.decision.code === "BLOCKED")) throw new GroveError("BLOCKED", "Blocked.");
  }

  private async assertSeatRoom(actorId: string): Promise<void> {
    const { rows } = await this.store.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM board_tables WHERE status <> 'ended' AND (seat0_id = $1 OR seat1_id = $1)`,
      [actorId],
    );
    if ((rows[0]?.n ?? 0) >= TABLE_SEATED_MAX) {
      throw new GroveError("CONFLICT", `You are already seated at ${TABLE_SEATED_MAX} unfinished games. Finish one first.`);
    }
  }

  /** An agent watching needs an ear. Humans always have one. */
  private async mayWatchAsAgent(viewer: TableActor): Promise<boolean> {
    if (viewer.kind !== "agent") return true;
    return Boolean(viewer.agent.policy?.listenToAgents || viewer.agent.policy?.listenToHumans);
  }

  /** A room this viewer may watch, from a room id or a commons slug. 404 otherwise, whatever the reason. */
  private async resolveVisibleRoom(viewer: TableActor | null, raw: unknown): Promise<{ id: string; kind: string }> {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key || key.length > 200) throw new GroveError("NOT_FOUND", "Room not found.", { httpStatus: 404 });
    const { rows } = await this.store.pg.query(
      `SELECT r.id, r.kind FROM rooms r LEFT JOIN worlds w ON w.id = r.world_id
        WHERE (r.id = $1 OR (r.slug = $1 AND r.world_id = $3))
          AND (w.archived_at IS NULL)
          AND ${roomActivityVisibleSql("r", "w", "$2")}
        ORDER BY (r.id = $1) DESC LIMIT 1`,
      [key, viewerHumanId(viewer), WORLD_ID],
    );
    if (!rows[0]) throw new GroveError("NOT_FOUND", "Room not found.", { httpStatus: 404 });
    return { id: String(rows[0].id), kind: String(rows[0].kind) };
  }

  private async visibleRow(viewer: TableActor | null, tableId: string): Promise<Row | null> {
    if (typeof tableId !== "string" || !/^tbl_[0-9A-Za-z]{1,40}$/.test(tableId)) return null;
    const actorId = viewer ? actorIdOf(viewer) : null;
    const { rows } = await this.store.pg.query(
      `SELECT t.* FROM board_tables t
         JOIN rooms r ON r.id = t.room_id
         LEFT JOIN worlds w ON w.id = r.world_id
        WHERE t.id = $3 AND ${tableVisibleSql("t", "r", "w", "$1", "$2")}`,
      [viewerHumanId(viewer), actorId, tableId],
    );
    const t = (rows[0] as Row) ?? null;
    if (!t || !viewer) return t;
    const seated = t.seat0_id === actorId || t.seat1_id === actorId;
    if (!seated && !(await this.mayWatchAsAgent(viewer))) return null;
    return t;
  }

  /** The public view. Columns are picked one by one. */
  async view(tableId: string): Promise<TableView | null> {
    const { rows } = await this.store.pg.query(
      `SELECT t.*, r.name AS room_name,
              COALESCE(h0.display_name, a0.display_name) AS seat0_name, COALESCE(h0.handle::text, a0.slug::text) AS seat0_slug,
              COALESCE(h1.display_name, a1.display_name) AS seat1_name, COALESCE(h1.handle::text, a1.slug::text) AS seat1_slug
         FROM board_tables t
         JOIN rooms r ON r.id = t.room_id
         LEFT JOIN humans h0 ON h0.id = t.seat0_id
         LEFT JOIN agents a0 ON a0.id = t.seat0_id
         LEFT JOIN humans h1 ON h1.id = t.seat1_id
         LEFT JOIN agents a1 ON a1.id = t.seat1_id
        WHERE t.id = $1`,
      [tableId],
    );
    const t = rows[0] as Row | undefined;
    if (!t) return null;
    const state = isBoardState(t.state) ? (t.state as BoardState) : initialBoardState(String(t.game) as BoardGame);
    const players: TablePlayerView[] = [];
    for (const seat of [0, 1] as const) {
      const id = t[`seat${seat}_id`];
      if (id == null) continue;
      players.push({
        seat,
        actorId: String(id),
        kind: String(id).startsWith("agt_") ? "agent" : "human",
        displayName: t[`seat${seat}_name`] == null ? "someone since departed" : String(t[`seat${seat}_name`]),
        slug: t[`seat${seat}_slug`] == null ? null : String(t[`seat${seat}_slug`]),
      });
    }
    const status = String(t.status) as TableStatus;
    const moveSeconds = Number(t.move_seconds);
    return {
      id: String(t.id),
      roomId: String(t.room_id),
      roomName: t.room_name == null ? null : String(t.room_name),
      game: String(t.game) as BoardGame,
      clock: clockOf(moveSeconds),
      moveSeconds,
      status,
      players,
      turn: status === "active" ? (Number(t.turn_seat) === 1 ? 1 : 0) : null,
      state,
      fen: state.game === "chess" ? state.fen : null,
      moveCount: Number(t.move_count),
      turnDeadline: status === "active" ? iso(t.turn_deadline) : null,
      drawOffer: status === "active" && t.draw_offer != null ? (Number(t.draw_offer) === 1 ? 1 : 0) : null,
      result:
        status === "ended" && t.end_reason != null
          ? { winner: t.winner_seat == null ? null : Number(t.winner_seat) === 1 ? 1 : 0, reason: String(t.end_reason) as BoardEndReason }
          : null,
      createdBy: String(t.created_by),
      createdAt: iso(t.created_at)!,
      endedAt: iso(t.ended_at),
      endedEventId: t.ended_event_id == null ? null : String(t.ended_event_id),
    };
  }

  private async eventIds(n: number): Promise<string[]> {
    const { rows } = await this.store.pg.query(
      `SELECT ${NEXT_EVENT_ID}::text AS id FROM generate_series(1, $1) ORDER BY 1`,
      [n],
    );
    return rows.map((r) => String(r.id)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  }

  private tight(actor: TableActor): boolean {
    return actor.kind === "agent" && isFirst24h(actor.agent.claimedAt);
  }

  /**
   * Tell the room: a table changed. Only to the bodies in the room who may watch
   * it (the place gate, per body: a human as themself, an agent as its owner),
   * via `delivered_to`, so the room socket's own filter drops everyone else.
   * The frame names the table and its move count, nothing more; clients read
   * the table through the gated route. Best effort: the poll catches up.
   */
  private async publish(tableId: string, roomId: string): Promise<void> {
    try {
      const { rows } = await this.store.pg.query(
        `SELECT p.actor_id FROM presence p
           JOIN rooms r ON r.id = p.room_id
           LEFT JOIN worlds w ON w.id = r.world_id
           LEFT JOIN agents a ON a.id = p.actor_id
          WHERE p.room_id = $1
            AND ${roomActivityVisibleSql("r", "w", "(CASE WHEN p.actor_id LIKE 'hum_%' THEN p.actor_id ELSE a.owner_human_id END)")}`,
        [roomId],
      );
      const { rows: t } = await this.store.pg.query(`SELECT status, move_count FROM board_tables WHERE id = $1`, [tableId]);
      await this.store.redis.publish(
        `pubsub:room:${roomId}`,
        JSON.stringify(tableFrame(tableId, roomId, String(t[0]?.status ?? "ended"), Number(t[0]?.move_count ?? 0), rows.map((r) => String(r.actor_id)))),
      );
    } catch {
      /* best effort */
    }
  }
}

/** The room-channel frame for a table change. Exported for the frame-filter tests. */
export function tableFrame(tableId: string, roomId: string, status: string, moveCount: number, audience: string[]) {
  return { type: TABLE_FRAME, table_id: tableId, room_id: roomId, status, move_count: moveCount, delivered_to: audience };
}

/**
 * The `table.ended` ledger row for every row of CTE `up` that carries an
 * ended_event_id. The winner is the actor (a draw names seat 0) and the other
 * player is `targetId`, which the chronicle resolves to a name.
 */
function endedEventSql(up: string): string {
  return `INSERT INTO world_events (id, type, actor_id, payload)
         SELECT ${up}.ended_event_id, 'table.ended',
                CASE WHEN ${up}.winner_seat = 1 THEN ${up}.seat1_id ELSE ${up}.seat0_id END,
                ${payloadSql(
                  up,
                  `'result', CASE WHEN ${up}.winner_seat IS NULL THEN 'draw' ELSE 'win' END, 'reason', ${up}.end_reason, 'moves', ${up}.move_count, 'targetId', CASE WHEN ${up}.winner_seat = 1 THEN ${up}.seat0_id ELSE ${up}.seat1_id END`,
                )}
           FROM ${up} WHERE ${up}.ended_event_id IS NOT NULL`;
}

function invalidClock(): never {
  throw new GroveError("INVALID", "clock must be live (5 minutes a move) or async (24 hours a move).");
}

function notFound(): GroveError {
  return new GroveError("NOT_FOUND", "No such table.", { httpStatus: 404 });
}

export { BOARD_GAME_NAMES };
