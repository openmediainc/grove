/**
 * Board tables (#42), for the room drawer, the map's "playing" glyph and Grove
 * TV. Pure: parsing the public table payloads and the small decisions drawn
 * from them, so they are pinned by tests (test/boards.test.ts). The rules
 * themselves come from @grove/protocol — the same functions the server
 * referees with — so the board a player clicks can never disagree with it.
 */
import {
  BOARD_GAME_NAMES,
  FOUR_COLS,
  FOUR_ROWS,
  boardEndWords,
  isBoardState,
  legalChessMoves,
  parseFen,
  squareName,
  uciOf,
  type BoardGame,
  type BoardState,
} from "@grove/protocol";

export type TablePlayerWire = { seat: 0 | 1; actor_id: string; kind: "human" | "agent"; display_name: string; slug: string | null };
export type TableMoveWire = { seq: number; seat: 0 | 1; actor_id: string; move: string; notation: string; at: string };

export type TableWire = {
  id: string;
  room_id: string;
  room_name: string | null;
  game: BoardGame;
  clock: "live" | "async";
  move_seconds: number;
  status: "waiting" | "active" | "ended";
  players: TablePlayerWire[];
  turn: 0 | 1 | null;
  state: unknown;
  fen: string | null;
  move_count: number;
  turn_deadline: string | null;
  draw_offer: 0 | 1 | null;
  result: { winner: 0 | 1 | null; reason: string } | null;
  created_at: string;
  ended_at: string | null;
  ended_event_id: string | null;
  moves?: TableMoveWire[];
  your_seat?: 0 | 1 | null;
  legal_moves?: string[];
};

export type PlayingWire = {
  tables?: Array<{
    id: string;
    game: BoardGame;
    room_id: string;
    status: "active" | "ended";
    seats: [string | null, string | null];
    turn: 0 | 1 | null;
    last_move: { notation: string; actor_id: string; at: string } | null;
    result: { winner: 0 | 1 | null; reason: string; at: string } | null;
  }>;
};

export function gameName(game: BoardGame | string): string {
  return (BOARD_GAME_NAMES as Record<string, string>)[game] ?? "board game";
}

export function boardOf(table: Pick<TableWire, "state" | "game">): BoardState | null {
  return isBoardState(table.state) ? table.state : null;
}

export function playerAt(table: Pick<TableWire, "players">, seat: 0 | 1): TablePlayerWire | null {
  return table.players.find((p) => p.seat === seat) ?? null;
}

/** Seat 0 is white / the first disc. Plain words, same in every theme. */
export function seatWord(game: BoardGame, seat: 0 | 1): string {
  if (game === "chess") return seat === 0 ? "white" : "black";
  return seat === 0 ? "first" : "second";
}

/** One line under a table: whose move, waiting, or how it ended. Never a score. */
export function tableLine(t: TableWire, now: number = Date.now()): string {
  const name = (seat: 0 | 1) => playerAt(t, seat)?.display_name ?? "someone";
  if (t.status === "waiting") return `${name(0)} is waiting for someone to sit down`;
  if (t.status === "active") {
    const turn = t.turn ?? 0;
    const left = t.turn_deadline ? clockLeft(t.turn_deadline, now) : null;
    const offer = t.draw_offer !== null ? ` · ${name(t.draw_offer)} offers a draw` : "";
    return `${name(turn)} to move${left ? ` · ${left}` : ""}${offer}`;
  }
  if (!t.result) return "Game over";
  const how = boardEndWords(t.result.reason);
  if (t.result.reason === "abandoned") return "Nobody sat down";
  if (t.result.winner === null) return `Drawn (${how})`;
  return `${name(t.result.winner)} won (${how})`;
}

/** "4m 10s left", "23h left". A passed deadline reads as "time is up". */
export function clockLeft(deadline: string, now: number): string {
  const ms = Date.parse(deadline) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "time is up";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s left`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`;
}

/** Four-in-a-row, top row first, for drawing: each cell "." | "x" | "o". */
export function fourRows(state: BoardState | null): string[][] {
  const grid = state?.game === "four" ? state.grid : ".".repeat(FOUR_COLS * FOUR_ROWS);
  const rows: string[][] = [];
  for (let r = FOUR_ROWS - 1; r >= 0; r--) rows.push(grid.slice(r * FOUR_COLS, (r + 1) * FOUR_COLS).split(""));
  return rows;
}

/** Original, text-only piece marks: a letter in a disc, so no font or artwork is borrowed. */
export const PIECE_LETTER: Record<string, string> = { k: "K", q: "Q", r: "R", b: "B", n: "N", p: "" };

export type ChessSquare = { name: string; piece: string; dark: boolean };

/** Chess squares in reading order for the viewer: black's view is flipped. */
export function chessSquares(state: BoardState | null, flip: boolean): ChessSquare[] {
  const s = state?.game === "chess" ? parseFen(state.fen) : null;
  const out: ChessSquare[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const rank = flip ? row : 7 - row;
      const file = flip ? 7 - col : col;
      const sq = rank * 8 + file;
      out.push({ name: squareName(sq), piece: s?.board[sq] ?? "", dark: (rank + file) % 2 === 0 });
    }
  }
  return out;
}

/** Where the piece on `from` may go, as the server's legal moves spell them (UCI). */
export function targetsFrom(legal: readonly string[], from: string): string[] {
  return [...new Set(legal.filter((m) => m.startsWith(from)).map((m) => m.slice(2, 4)))];
}

/**
 * The move to send for a click from `from` to `to`, or null. A pawn reaching
 * the last rank sends the promotion piece picked (queen unless changed).
 */
export function chessMoveFor(legal: readonly string[], from: string, to: string, promotion: "q" | "r" | "b" | "n" = "q"): string | null {
  const plain = `${from}${to}`;
  if (legal.includes(plain)) return plain;
  const promo = `${plain}${promotion}`;
  return legal.includes(promo) ? promo : null;
}

/** Legal moves from a FEN, when the payload did not carry them (a spectator never gets them). */
export function legalFromFen(fen: string | null): string[] {
  const s = fen ? parseFen(fen) : null;
  return s ? legalChessMoves(s).map(uciOf) : [];
}

/** Chess moves in numbered pairs for the move list: "1. e4 e5". Four-in-a-row: columns in order. */
export function moveListLines(game: BoardGame, moves: readonly TableMoveWire[]): string[] {
  if (game === "four") return moves.map((m) => `${m.seq}. ${m.seat === 0 ? "●" : "○"} column ${m.notation}`);
  const lines: string[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    const white = moves[i]!;
    const black = moves[i + 1];
    lines.push(`${Math.floor(i / 2) + 1}. ${white.notation}${black ? ` ${black.notation}` : ""}`);
  }
  return lines;
}

/** How the map reads a body at a table. */
export type PlayingMark = { game: BoardGame; toMove: boolean };

/** Bodies at active tables, by actor id. A body at two tables is "to move" if it is at either. */
export function playingMarks(wire: PlayingWire | null | undefined): Map<string, PlayingMark> {
  const out = new Map<string, PlayingMark>();
  for (const t of wire?.tables ?? []) {
    if (!t || t.status !== "active" || !Array.isArray(t.seats)) continue;
    t.seats.forEach((id, seat) => {
      if (typeof id !== "string") return;
      const toMove = t.turn === seat;
      const had = out.get(id);
      out.set(id, { game: had && !toMove ? had.game : t.game, toMove: Boolean(had?.toMove || toMove) });
    });
  }
  return out;
}

/** What Grove TV may cut to: a check, a mate, a game's end, in the last little while. */
export type TvGameMoment = {
  key: string;
  /** The body to follow: the one who just moved, or the winner (seat 0 on a draw). */
  actorId: string;
  otherId: string | null;
  game: BoardGame;
  /** "chess", "four-in-a-row": for the caption. */
  gameName: string;
  kind: "check" | "end";
  words: string;
  at: number;
};

export const TV_GAME_WINDOW_MS = 60_000;

export function tvGameMoments(wire: PlayingWire | null | undefined, now: number): TvGameMoment[] {
  const out: TvGameMoment[] = [];
  for (const t of wire?.tables ?? []) {
    if (!t || !Array.isArray(t.seats)) continue;
    if (t.status === "ended" && t.result) {
      const at = Date.parse(t.result.at);
      const winner = t.result.winner ?? 0;
      const actorId = t.seats[winner];
      if (!actorId || !Number.isFinite(at) || now - at > TV_GAME_WINDOW_MS) continue;
      const how = boardEndWords(t.result.reason);
      out.push({
        key: `game:${t.id}:end`,
        actorId,
        otherId: t.seats[winner === 0 ? 1 : 0] ?? null,
        game: t.game,
        gameName: gameName(t.game),
        kind: "end",
        words: t.result.winner === null ? `drew (${how})` : `won (${how})`,
        at,
      });
      continue;
    }
    const last = t.last_move;
    if (t.status !== "active" || !last || !/[+#]$/.test(last.notation)) continue;
    const at = Date.parse(last.at);
    if (!Number.isFinite(at) || now - at > TV_GAME_WINDOW_MS) continue;
    const seat = t.seats.indexOf(last.actor_id);
    out.push({
      key: `game:${t.id}:${last.notation}:${last.at}`,
      actorId: last.actor_id,
      otherId: seat < 0 ? null : t.seats[seat === 0 ? 1 : 0] ?? null,
      game: t.game,
      gameName: gameName(t.game),
      kind: "check",
      words: `gave check (${last.notation})`,
      at,
    });
  }
  return out;
}

/** Square name helper re-exported for the board component. */
export { squareName };
