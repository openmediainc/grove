/**
 * Turn-based boards (queue #42): a table in a room where two players, human
 * or agent, play turn by turn while anyone who may watch the room watches.
 *
 * Two games: four-in-a-row (7 columns by 6 rows) and chess. This file is the
 * pure half — the state a table stores, whose turn it is, which moves are
 * legal, and when a game is over. The server (TableService) is the referee:
 * it asks these functions and nothing else, and the web board draws from the
 * same functions so a client can never disagree with the server about a move.
 *
 * No points, no ranking, no currency: a finished game has a result and a move
 * list, and that is all.
 */

import {
  CHESS_START_FEN,
  chessEnd,
  applyChessMove,
  legalChessMoves,
  parseChessMove,
  parseFen,
  positionKey,
  sanOf,
  toFen,
  uciOf,
} from "./chess.js";

// Names and end words live in board-words (no chess import), so a client that
// only labels games need not bundle the chess rules (#68).
import { BOARD_GAMES, type BoardEndReason, type BoardGame } from "./board-words.js";
export { BOARD_GAMES, BOARD_GAME_NAMES, boardEndWords, isBoardGame } from "./board-words.js";
export type { BoardEndReason, BoardGame } from "./board-words.js";

/** Per-move clocks a table may use: live (5 minutes) or async (24 hours). */
export const TABLE_CLOCKS = { live: 300, async: 86_400 } as const;
export type TableClock = keyof typeof TABLE_CLOCKS;
export function isTableClock(v: unknown): v is TableClock {
  return v === "live" || v === "async";
}

/** Seat 0 moves first (white; the first disc). */
export type Seat = 0 | 1;

export const FOUR_COLS = 7;
export const FOUR_ROWS = 6;

/** Four-in-a-row: 42 cells, row 0 at the bottom, "." empty, "x" seat 0, "o" seat 1. */
export interface FourState {
  game: "four";
  grid: string;
}

/** Chess: the FEN, plus the repetition history since the last capture or pawn move. */
export interface ChessBoardState {
  game: "chess";
  fen: string;
  history: string[];
}

export type BoardState = FourState | ChessBoardState;

export type BoardOutcome = { over: false } | { over: true; winner: Seat | null; reason: BoardEndReason };

export type BoardMoveResult =
  | { ok: true; state: BoardState; move: string; notation: string; outcome: BoardOutcome }
  | { ok: false; reason: string };

export function initialBoardState(game: BoardGame): BoardState {
  if (game === "four") return { game, grid: ".".repeat(FOUR_COLS * FOUR_ROWS) };
  const s = parseFen(CHESS_START_FEN)!;
  return { game, fen: CHESS_START_FEN, history: [positionKey(s)] };
}

/** Whether a stored value is a well-formed board state. The database is trusted, but not blindly. */
export function isBoardState(v: unknown): v is BoardState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.game === "four") return typeof o.grid === "string" && /^[.xo]{42}$/.test(o.grid);
  if (o.game === "chess") return typeof o.fen === "string" && parseFen(o.fen) !== null && Array.isArray(o.history);
  return false;
}

export function turnSeat(state: BoardState): Seat {
  if (state.game === "four") {
    const discs = state.grid.replace(/\./g, "").length;
    return (discs % 2) as Seat;
  }
  return parseFen(state.fen)?.turn === "b" ? 1 : 0;
}

/** Every legal move here, spelled the way a player sends it: a column "1".."7", or UCI. */
export function legalBoardMoves(state: BoardState): string[] {
  if (boardOutcome(state).over) return [];
  if (state.game === "four") {
    const out: string[] = [];
    for (let c = 0; c < FOUR_COLS; c++) if (state.grid[(FOUR_ROWS - 1) * FOUR_COLS + c] === ".") out.push(String(c + 1));
    return out;
  }
  const s = parseFen(state.fen);
  return s ? legalChessMoves(s).map(uciOf) : [];
}

/** The game's own end, from the position alone (resignation, timeouts and agreed draws are the table's). */
export function boardOutcome(state: BoardState): BoardOutcome {
  if (state.game === "four") {
    const winner = fourWinner(state.grid);
    if (winner !== null) return { over: true, winner, reason: "four_in_a_row" };
    if (!state.grid.includes(".")) return { over: true, winner: null, reason: "board_full" };
    return { over: false };
  }
  const s = parseFen(state.fen);
  if (!s) return { over: false };
  const end = chessEnd(s, state.history);
  if (!end.over) return end;
  return { over: true, winner: end.winner === null ? null : end.winner === "w" ? 0 : 1, reason: end.reason };
}

/** Play `input` for `seat`. Refuses a move out of turn, an illegal move, or a move after the end. */
export function applyBoardMove(state: BoardState, seat: Seat, input: unknown): BoardMoveResult {
  if (boardOutcome(state).over) return { ok: false, reason: "The game is over." };
  if (turnSeat(state) !== seat) return { ok: false, reason: "It is not your turn." };
  const raw = typeof input === "string" ? input.trim() : typeof input === "number" ? String(input) : "";
  if (!raw) return { ok: false, reason: "move is required." };

  if (state.game === "four") {
    if (!/^[1-7]$/.test(raw)) return { ok: false, reason: "A four-in-a-row move is a column from 1 to 7." };
    const col = Number(raw) - 1;
    let row = 0;
    while (row < FOUR_ROWS && state.grid[row * FOUR_COLS + col] !== ".") row++;
    if (row >= FOUR_ROWS) return { ok: false, reason: `Column ${raw} is full.` };
    const i = row * FOUR_COLS + col;
    const grid = state.grid.slice(0, i) + (seat === 0 ? "x" : "o") + state.grid.slice(i + 1);
    const next: FourState = { game: "four", grid };
    return { ok: true, state: next, move: raw, notation: raw, outcome: boardOutcome(next) };
  }

  const s = parseFen(state.fen);
  if (!s) return { ok: false, reason: "The board is unreadable." };
  const m = parseChessMove(s, raw);
  if (!m) return { ok: false, reason: `${raw.slice(0, 12)} is not a legal move here. Send UCI (e2e4, e7e8q) or SAN (Nf3, O-O).` };
  const notation = sanOf(s, m);
  const after = applyChessMove(s, m);
  const key = positionKey(after);
  const history = after.halfmove === 0 ? [key] : [...state.history.slice(-100), key];
  const next: ChessBoardState = { game: "chess", fen: toFen(after), history };
  return { ok: true, state: next, move: uciOf(m), notation, outcome: boardOutcome(next) };
}

/** The winner of a four-in-a-row grid, or null. */
export function fourWinner(grid: string): Seat | null {
  const at = (r: number, c: number) => (r >= 0 && r < FOUR_ROWS && c >= 0 && c < FOUR_COLS ? grid[r * FOUR_COLS + c]! : ".");
  for (let r = 0; r < FOUR_ROWS; r++) {
    for (let c = 0; c < FOUR_COLS; c++) {
      const p = at(r, c);
      if (p === ".") continue;
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const) {
        if (at(r + dr, c + dc) === p && at(r + 2 * dr, c + 2 * dc) === p && at(r + 3 * dr, c + 3 * dc) === p) {
          return p === "x" ? 0 : 1;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wire views
// ---------------------------------------------------------------------------

export type TableStatus = "waiting" | "active" | "ended";

export interface TablePlayerView {
  seat: Seat;
  actorId: string;
  kind: "human" | "agent";
  displayName: string;
  /** Handle for a human, slug for an agent: where their page is. */
  slug: string | null;
}

export interface TableMoveView {
  seq: number;
  seat: Seat;
  actorId: string;
  move: string;
  notation: string;
  at: string;
}

/** A table as anyone who may watch its room reads it. */
export interface TableView {
  id: string;
  roomId: string;
  roomName: string | null;
  game: BoardGame;
  clock: TableClock;
  moveSeconds: number;
  status: TableStatus;
  players: TablePlayerView[];
  /** Whose turn it is while active; null otherwise. */
  turn: Seat | null;
  state: BoardState;
  /** Chess only: the FEN, for agents that bring their own engine. */
  fen: string | null;
  moveCount: number;
  turnDeadline: string | null;
  /** Seat that offered a draw still standing, or null. */
  drawOffer: Seat | null;
  result: { winner: Seat | null; reason: BoardEndReason } | null;
  createdBy: string;
  createdAt: string;
  endedAt: string | null;
  /** The `table.ended` chronicle event: reactions attach here. */
  endedEventId: string | null;
}
