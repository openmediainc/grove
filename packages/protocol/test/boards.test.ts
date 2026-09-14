import { describe, expect, it } from "vitest";
import {
  applyBoardMove,
  boardOutcome,
  fourWinner,
  initialBoardState,
  isBoardGame,
  isBoardState,
  legalBoardMoves,
  turnSeat,
  type BoardState,
} from "../src/boards.js";

function play(state: BoardState, moves: string[]): BoardState {
  let s = state;
  for (const m of moves) {
    const r = applyBoardMove(s, turnSeat(s), m);
    if (!r.ok) throw new Error(`${m}: ${r.reason}`);
    s = r.state;
  }
  return s;
}

describe("four-in-a-row", () => {
  it("drops discs to the bottom and alternates seats", () => {
    const s = initialBoardState("four");
    expect(turnSeat(s)).toBe(0);
    expect(legalBoardMoves(s)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    const r = applyBoardMove(s, 0, "4");
    expect(r.ok && r.state.game === "four" && r.state.grid[3]).toBe("x");
    const after = play(s, ["4", "4"]);
    expect(after.game === "four" && after.grid[3 + 7]).toBe("o");
    expect(turnSeat(after)).toBe(0);
  });

  it("refuses out of turn, bad columns and full columns", () => {
    const s = initialBoardState("four");
    expect(applyBoardMove(s, 1, "1")).toEqual({ ok: false, reason: "It is not your turn." });
    expect(applyBoardMove(s, 0, "8").ok).toBe(false);
    expect(applyBoardMove(s, 0, "0").ok).toBe(false);
    const full = play(s, ["1", "1", "1", "1", "1", "1"]);
    expect(applyBoardMove(full, 0, "1")).toEqual({ ok: false, reason: "Column 1 is full." });
    expect(legalBoardMoves(full)).not.toContain("1");
  });

  it("finds four in a row in every direction", () => {
    const horiz = play(initialBoardState("four"), ["1", "1", "2", "2", "3", "3", "4"]);
    expect(boardOutcome(horiz)).toEqual({ over: true, winner: 0, reason: "four_in_a_row" });
    expect(applyBoardMove(horiz, 1, "5")).toEqual({ ok: false, reason: "The game is over." });
    const vert = play(initialBoardState("four"), ["1", "2", "1", "2", "1", "2", "3", "2"]);
    expect(boardOutcome(vert)).toMatchObject({ winner: 1 });
    // Diagonal up-right for seat 0: (0,0) (1,1) (2,2) (3,3).
    const diag = play(initialBoardState("four"), ["1", "2", "2", "3", "3", "4", "3", "4", "4", "7", "4"]);
    expect(boardOutcome(diag)).toMatchObject({ over: true, winner: 0 });
    expect(fourWinner(".".repeat(42))).toBeNull();
  });

  it("calls a full board with no line a draw", () => {
    // A known drawn fill: columns in pairs, three discs each way, never four.
    const grid = [
      "xxoxxox", // row 0 (bottom)
      "ooxooxo",
      "xxoxxox",
      "ooxooxo",
      "xxoxxox",
      "ooxooxo",
    ].join("");
    expect(fourWinner(grid)).toBeNull();
    expect(boardOutcome({ game: "four", grid })).toEqual({ over: true, winner: null, reason: "board_full" });
    expect(legalBoardMoves({ game: "four", grid })).toEqual([]);
  });
});

describe("chess on a table", () => {
  it("plays SAN or UCI, records both spellings, and ends on mate", () => {
    let s = initialBoardState("chess");
    const first = applyBoardMove(s, 0, "e4");
    expect(first).toMatchObject({ ok: true, move: "e2e4", notation: "e4" });
    expect(applyBoardMove(s, 1, "e5").ok).toBe(false);
    s = play(s, ["f2f3", "e5", "g4"]);
    const mate = applyBoardMove(s, 1, "Qh4");
    expect(mate).toMatchObject({ ok: true, notation: "Qh4#", outcome: { over: true, winner: 1, reason: "checkmate" } });
    expect(mate.ok && legalBoardMoves(mate.state)).toEqual([]);
  });

  it("validates stored states", () => {
    expect(isBoardState(initialBoardState("chess"))).toBe(true);
    expect(isBoardState(initialBoardState("four"))).toBe(true);
    expect(isBoardState({ game: "four", grid: "x" })).toBe(false);
    expect(isBoardState({ game: "go" })).toBe(false);
    expect(isBoardGame("chess")).toBe(true);
    expect(isBoardGame("poker")).toBe(false);
  });
});
