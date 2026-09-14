/**
 * Board tables (#42) as the MAP reads them: the "playing" glyph and Grove TV's
 * game moments. Split from lib/boards (#68) so the map's first load does not
 * carry the chess rules the room drawer's board needs. Pure; pinned by
 * test/boards.test.ts through lib/boards' re-exports.
 */
import { BOARD_GAME_NAMES, boardEndWords, type BoardGame } from "@grove/protocol";

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
