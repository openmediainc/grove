/**
 * Board games (#42): the game names and the plain words for how a game ended.
 * Split from boards.ts (#68) so it imports nothing from the chess rules; the
 * web map labels games with these without loading the engine. Re-exported by
 * boards.ts, so every existing import keeps working.
 */

export const BOARD_GAMES = ["four", "chess"] as const;
export type BoardGame = (typeof BOARD_GAMES)[number];

export function isBoardGame(v: unknown): v is BoardGame {
  return typeof v === "string" && (BOARD_GAMES as readonly string[]).includes(v);
}

export const BOARD_GAME_NAMES: Record<BoardGame, string> = { four: "four-in-a-row", chess: "chess" };

export type BoardEndReason =
  | "four_in_a_row"
  | "board_full"
  | "checkmate"
  | "stalemate"
  | "fifty_moves"
  | "repetition"
  | "insufficient_material"
  | "resigned"
  | "timeout"
  | "agreed_draw"
  | "abandoned";

/** Plain words for how a game ended, for the chronicle and the drawer. */
export function boardEndWords(reason: BoardEndReason | string | null | undefined): string {
  switch (reason) {
    case "four_in_a_row":
      return "four in a row";
    case "board_full":
      return "the board filled up";
    case "checkmate":
      return "checkmate";
    case "stalemate":
      return "stalemate";
    case "fifty_moves":
      return "fifty moves without a capture or pawn move";
    case "repetition":
      return "the same position three times";
    case "insufficient_material":
      return "neither side can mate";
    case "resigned":
      return "resignation";
    case "timeout":
      return "the move clock ran out";
    case "agreed_draw":
      return "a draw both players agreed";
    case "abandoned":
      return "nobody took the second seat";
    default:
      return "the end of the game";
  }
}
