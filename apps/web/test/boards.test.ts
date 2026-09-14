import { describe, expect, it } from "vitest";
import { initialBoardState } from "@grove/protocol";
import {
  chessMoveFor,
  chessSquares,
  clockLeft,
  fourRows,
  legalFromFen,
  moveListLines,
  playingMarks,
  tableLine,
  targetsFrom,
  tvGameMoments,
  type PlayingWire,
  type TableWire,
} from "../lib/boards";
import { TvDirector, type TvActor } from "../lib/tv/director";

const T0 = Date.parse("2026-09-13T12:00:00Z");

function table(over: Partial<TableWire> = {}): TableWire {
  return {
    id: "tbl_1",
    room_id: "library",
    room_name: "Library",
    game: "chess",
    clock: "live",
    move_seconds: 300,
    status: "active",
    players: [
      { seat: 0, actor_id: "hum_a", kind: "human", display_name: "Ada", slug: "ada" },
      { seat: 1, actor_id: "agt_b", kind: "agent", display_name: "Bolt", slug: "bolt" },
    ],
    turn: 1,
    state: initialBoardState("chess"),
    fen: null,
    move_count: 1,
    turn_deadline: new Date(T0 + 250_000).toISOString(),
    draw_offer: null,
    result: null,
    created_at: new Date(T0).toISOString(),
    ended_at: null,
    ended_event_id: null,
    ...over,
  };
}

describe("board tables in the drawer", () => {
  it("says whose move it is, how long they have, and how a game ended, without a score", () => {
    expect(tableLine(table(), T0)).toBe("Bolt to move · 4m 10s left");
    expect(tableLine(table({ draw_offer: 0 }), T0)).toContain("Ada offers a draw");
    expect(tableLine(table({ status: "waiting", turn: null, players: [table().players[0]!] }), T0)).toBe("Ada is waiting for someone to sit down");
    expect(tableLine(table({ status: "ended", result: { winner: 1, reason: "checkmate" } }), T0)).toBe("Bolt won (checkmate)");
    expect(tableLine(table({ status: "ended", result: { winner: null, reason: "stalemate" } }), T0)).toBe("Drawn (stalemate)");
    expect(clockLeft(new Date(T0 - 1).toISOString(), T0)).toBe("time is up");
    expect(clockLeft(new Date(T0 + 7_200_000).toISOString(), T0)).toBe("2h 0m left");
  });

  it("draws four-in-a-row top row first and chess from the viewer's side", () => {
    const rows = fourRows({ game: "four", grid: "x" + ".".repeat(41) });
    expect(rows).toHaveLength(6);
    expect(rows[5]![0]).toBe("x");
    const white = chessSquares(initialBoardState("chess"), false);
    expect(white[0]).toMatchObject({ name: "a8", piece: "r", dark: false });
    expect(white[63]).toMatchObject({ name: "h1", piece: "R", dark: false });
    expect(white[56]).toMatchObject({ name: "a1", dark: true });
    const black = chessSquares(initialBoardState("chess"), true);
    expect(black[0]).toMatchObject({ name: "h1", piece: "R" });
  });

  it("turns clicks into the server's own move spelling, promotions included", () => {
    const legal = legalFromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(targetsFrom(legal, "g1").sort()).toEqual(["f3", "h3"]);
    expect(chessMoveFor(legal, "e2", "e4")).toBe("e2e4");
    expect(chessMoveFor(legal, "e2", "e5")).toBeNull();
    const promo = legalFromFen("8/4P2k/8/8/8/8/8/4K3 w - - 0 1");
    expect(chessMoveFor(promo, "e7", "e8")).toBe("e7e8q");
    expect(chessMoveFor(promo, "e7", "e8", "n")).toBe("e7e8n");
    expect(legalFromFen("garbage")).toEqual([]);
  });

  it("numbers chess moves in pairs", () => {
    const m = (seq: number, notation: string) => ({ seq, seat: ((seq + 1) % 2) as 0 | 1, actor_id: "x", move: notation, notation, at: "" });
    expect(moveListLines("chess", [m(1, "e4"), m(2, "e5"), m(3, "Nf3")])).toEqual(["1. e4 e5", "2. Nf3"]);
    expect(moveListLines("four", [m(1, "4")])).toEqual(["1. ● column 4"]);
  });
});

describe("board tables on the map and on TV", () => {
  const wire: PlayingWire = {
    tables: [
      { id: "tbl_1", game: "chess", room_id: "library", status: "active", seats: ["hum_a", "agt_b"], turn: 1, last_move: { notation: "Qh5+", actor_id: "hum_a", at: new Date(T0 - 5_000).toISOString() }, result: null },
      { id: "tbl_2", game: "four", room_id: "garden", status: "ended", seats: ["hum_c", "agt_d"], turn: null, last_move: null, result: { winner: 1, reason: "four_in_a_row", at: new Date(T0 - 10_000).toISOString() } },
      { id: "tbl_3", game: "four", room_id: "garden", status: "ended", seats: ["hum_e", "agt_f"], turn: null, last_move: null, result: { winner: 0, reason: "timeout", at: new Date(T0 - 600_000).toISOString() } },
    ],
  };

  it("marks only bodies at active tables, and whose move it is", () => {
    const marks = playingMarks(wire);
    expect([...marks.keys()].sort()).toEqual(["agt_b", "hum_a"]);
    expect(marks.get("agt_b")).toEqual({ game: "chess", toMove: true });
    expect(marks.get("hum_a")).toEqual({ game: "chess", toMove: false });
    expect(playingMarks(null).size).toBe(0);
  });

  it("offers TV a check or a fresh game end, low priority, only for bodies on the map", () => {
    const moments = tvGameMoments(wire, T0);
    expect(moments.map((m) => m.kind)).toEqual(["check", "end"]);
    expect(moments[1]).toMatchObject({ actorId: "agt_d", otherId: "hum_c", words: "won (four in a row)", gameName: "four-in-a-row" });

    const actor = (id: string, name: string, verb = "idle"): TvActor => ({ id, name, kind: id.startsWith("agt") ? "agent" : "human", region: "garden", verb, hazard: null });
    const director = new TvDirector();
    const words = { regionTitle: (r: string) => r, atTable: "at a tavern table" };
    const cands = director.candidates([actor("agt_d", "Dot"), actor("hum_c", "Cy")], null, words, T0, null, moments);
    const game = cands.find((c) => c.kind === "game")!;
    expect(game.caption).toBe("Dot won (four in a row) at four-in-a-row against Cy, at a tavern table in garden");
    expect(game.actorId).toBe("agt_d");
    // Below talk and hazards; a body not on the map gets no shot.
    const faulted = director.candidates([{ ...actor("agt_d", "Dot"), hazard: "fault" }], null, words, T0, null, moments);
    expect(faulted[0]!.kind).toBe("hazard");
    expect(director.candidates([actor("hum_x", "X")], null, words, T0, null, moments).some((c) => c.kind === "game")).toBe(false);
  });
});
