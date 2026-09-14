import { describe, expect, it } from "vitest";
import {
  CHESS_START_FEN,
  applyChessMove,
  chessEnd,
  inCheck,
  insufficientMaterial,
  legalChessMoves,
  parseChessMove,
  parseFen,
  perft,
  positionKey,
  sanOf,
  toFen,
  uciOf,
} from "../src/chess.js";

const fen = (f: string) => {
  const s = parseFen(f);
  if (!s) throw new Error(`bad fen ${f}`);
  return s;
};

/** Published perft counts (chessprogramming.org "Perft Results"). */
const PERFT: Array<[string, string, number[]]> = [
  ["start", CHESS_START_FEN, [20, 400, 8902]],
  ["kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", [48, 2039, 97862]],
  ["position 3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812, 43238]],
  ["position 4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9467]],
  ["position 4 mirrored", "r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1", [6, 264, 9467]],
  ["position 5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486, 62379]],
  ["position 6", "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", [46, 2079]],
];

describe("chess move generator (perft)", () => {
  for (const [name, f, counts] of PERFT) {
    it(`${name} matches the published counts`, () => {
      const s = fen(f);
      counts.forEach((n, i) => expect(perft(s, i + 1)).toBe(n));
    });
  }
});

describe("chess rules", () => {
  it("round-trips FEN and refuses a broken one", () => {
    expect(toFen(fen(CHESS_START_FEN))).toBe(CHESS_START_FEN);
    expect(parseFen("8/8/8/8/8/8/8/8 w - - 0 1")).toBeNull(); // no kings
    expect(parseFen("rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBeNull();
    expect(parseFen("nonsense")).toBeNull();
  });

  it("reads UCI and SAN, and refuses illegal moves", () => {
    const s = fen(CHESS_START_FEN);
    expect(uciOf(parseChessMove(s, "e2e4")!)).toBe("e2e4");
    expect(uciOf(parseChessMove(s, "Nf3")!)).toBe("g1f3");
    expect(uciOf(parseChessMove(s, "e4")!)).toBe("e2e4");
    expect(parseChessMove(s, "e2e5")).toBeNull();
    expect(parseChessMove(s, "Ke2")).toBeNull();
    expect(parseChessMove(s, "")).toBeNull();
  });

  it("castles both ways only through safe, empty squares, and moves the rook", () => {
    const s = fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    const ks = parseChessMove(s, "O-O")!;
    expect(uciOf(ks)).toBe("e1g1");
    expect(toFen(applyChessMove(s, ks))).toBe("r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1");
    expect(uciOf(parseChessMove(s, "e1c1")!)).toBe("e1c1");
    // A rook on f8 attacks f1: no king-side castle; queen side still fine.
    const guarded = fen("r3kr2/8/8/8/8/8/8/R3K2R w KQq - 0 1");
    expect(parseChessMove(guarded, "O-O")).toBeNull();
    expect(parseChessMove(guarded, "O-O-O")).not.toBeNull();
    // In check: no castling at all.
    const checked = fen("r3k2r/8/8/8/8/8/4r3/R3K2R w KQkq - 0 1");
    expect(inCheck(checked)).toBe(true);
    expect(parseChessMove(checked, "O-O")).toBeNull();
    // Capturing a rook on its corner takes that right away.
    const take = applyChessMove(s, parseChessMove(s, "a1a8")!);
    expect(take.castling).toBe("Kk");
  });

  it("captures en passant only right after the double push", () => {
    let s = fen("4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1");
    s = applyChessMove(s, parseChessMove(s, "d5")!);
    expect(toFen(s)).toBe("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2");
    const ep = parseChessMove(s, "exd6")!;
    expect(ep.enPassant).toBe(true);
    expect(sanOf(s, ep)).toBe("exd6");
    expect(toFen(applyChessMove(s, ep))).toBe("4k3/8/3P4/8/8/8/8/4K3 b - - 0 2");
    // One quiet move later the chance is gone.
    const quiet = applyChessMove(s, parseChessMove(s, "Kd1")!);
    const later = applyChessMove(quiet, parseChessMove(quiet, "Kd8")!);
    expect(parseChessMove(later, "exd6")).toBeNull();
  });

  it("promotes (queen by default) and writes it in SAN", () => {
    const s = fen("8/4P2k/8/8/8/8/8/4K3 w - - 0 1");
    const q = parseChessMove(s, "e8")!;
    expect(q.promotion).toBe("q");
    expect(sanOf(s, q)).toBe("e8=Q");
    expect(parseChessMove(s, "e7e8n")!.promotion).toBe("n");
    expect(parseChessMove(s, "e8=R")!.promotion).toBe("r");
    expect(legalChessMoves(s).filter((m) => m.from === 52)).toHaveLength(4);
  });

  it("knows checkmate, stalemate and dead positions", () => {
    // Fool's mate.
    let s = fen(CHESS_START_FEN);
    for (const m of ["f3", "e5", "g4", "Qh4"]) s = applyChessMove(s, parseChessMove(s, m)!);
    expect(chessEnd(s)).toEqual({ over: true, winner: "b", reason: "checkmate" });
    const stale = fen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
    expect(chessEnd(stale)).toEqual({ over: true, winner: null, reason: "stalemate" });
    expect(insufficientMaterial(fen("8/8/8/4k3/8/8/2N5/4K3 w - - 0 1").board)).toBe(true);
    expect(insufficientMaterial(fen("8/8/8/4k3/8/8/2R5/4K3 w - - 0 1").board)).toBe(false);
    expect(chessEnd(fen("8/8/8/4k3/8/8/8/4K3 w - - 0 1"))).toMatchObject({ over: true, reason: "insufficient_material" });
  });

  it("adds + and # and disambiguates", () => {
    const s = fen("4k3/8/8/8/8/8/8/R3K2R w - - 0 1");
    expect(sanOf(s, parseChessMove(s, "a1a8")!)).toBe("Ra8+");
    const twins = fen("4k3/8/8/8/8/8/8/R4RK1 w - - 0 1");
    expect(sanOf(twins, parseChessMove(twins, "a1d1")!)).toBe("Rad1");
    expect(uciOf(parseChessMove(twins, "Rfd1")!)).toBe("f1d1");
    let mate = fen(CHESS_START_FEN);
    for (const m of ["f3", "e5", "g4"]) mate = applyChessMove(mate, parseChessMove(mate, m)!);
    expect(sanOf(mate, parseChessMove(mate, "d8h4")!)).toBe("Qh4#");
  });

  it("ends on fifty moves and on threefold repetition", () => {
    expect(chessEnd(fen("4k3/8/8/8/8/8/8/R3K3 w - - 100 80"))).toMatchObject({ over: true, reason: "fifty_moves" });
    let s = fen(CHESS_START_FEN);
    const history = [positionKey(s)];
    for (const m of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]) {
      s = applyChessMove(s, parseChessMove(s, m)!);
      history.push(positionKey(s));
    }
    expect(chessEnd(s, history)).toMatchObject({ over: true, winner: null, reason: "repetition" });
    expect(chessEnd(s, history.slice(0, 5))).toEqual({ over: false });
  });
});
