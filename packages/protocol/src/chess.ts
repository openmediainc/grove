/**
 * Chess rules, pure and dependency-free (queue #42, turn-based board).
 *
 * A small, complete legal-move generator: every piece, castling (rights, empty
 * and unattacked squares), en passant, promotion, check, checkmate, stalemate,
 * the fifty-move rule, threefold repetition and dead positions. It is verified
 * by perft against the published counts (test/chess.test.ts), which is the
 * standard way to prove a move generator exact.
 *
 * Squares are 0..63 with a1 = 0, h1 = 7, a8 = 56. Pieces are FEN letters:
 * upper case white, lower case black, "" empty.
 *
 * Why not a dependency: the rules are small, the repo keeps its protocol
 * package dependency-free, and a server that referees games between strangers
 * should own exactly the rules it enforces.
 */

export type ChessColor = "w" | "b";
export type PromotionPiece = "q" | "r" | "b" | "n";

export interface ChessState {
  /** 64 squares, a1 = 0. */
  board: string[];
  turn: ChessColor;
  /** Castling rights, a subset of "KQkq" in that order, or "". */
  castling: string;
  /** En passant target square, or -1. */
  ep: number;
  halfmove: number;
  fullmove: number;
}

export interface ChessMove {
  from: number;
  to: number;
  piece: string;
  captured: string;
  promotion: PromotionPiece | null;
  /** "k" king side, "q" queen side, or null. */
  castle: "k" | "q" | null;
  enPassant: boolean;
}

export const CHESS_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const FILES = "abcdefgh";

export function squareName(sq: number): string {
  return `${FILES[sq & 7]}${(sq >> 3) + 1}`;
}

export function parseSquare(name: string): number {
  if (!/^[a-h][1-8]$/.test(name)) return -1;
  return FILES.indexOf(name[0]!) + (Number(name[1]) - 1) * 8;
}

const colorOf = (p: string): ChessColor | null => (p === "" ? null : p === p.toUpperCase() ? "w" : "b");
const other = (c: ChessColor): ChessColor => (c === "w" ? "b" : "w");
const onBoard = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;

// ---------------------------------------------------------------------------
// FEN
// ---------------------------------------------------------------------------

export function parseFen(fen: string): ChessState | null {
  const parts = String(fen ?? "").trim().split(/\s+/);
  if (parts.length < 4) return null;
  const [placement, turn, castling, ep, half = "0", full = "1"] = parts;
  const rows = placement!.split("/");
  if (rows.length !== 8) return null;
  const board: string[] = new Array(64).fill("");
  for (let i = 0; i < 8; i++) {
    const rank = 7 - i;
    let file = 0;
    for (const ch of rows[i]!) {
      if (/[1-8]/.test(ch)) file += Number(ch);
      else if (/[pnbrqkPNBRQK]/.test(ch)) {
        if (file > 7) return null;
        board[rank * 8 + file] = ch;
        file += 1;
      } else return null;
    }
    if (file !== 8) return null;
  }
  if (turn !== "w" && turn !== "b") return null;
  if (!/^(-|K?Q?k?q?)$/.test(castling!) || castling === "") return null;
  const epSq = ep === "-" ? -1 : parseSquare(ep!);
  if (ep !== "-" && epSq < 0) return null;
  const halfmove = Number(half);
  const fullmove = Number(full);
  if (!Number.isInteger(halfmove) || halfmove < 0 || !Number.isInteger(fullmove) || fullmove < 1) return null;
  if (board.filter((p) => p === "K").length !== 1 || board.filter((p) => p === "k").length !== 1) return null;
  return { board, turn, castling: castling === "-" ? "" : castling!, ep: epSq, halfmove, fullmove };
}

function placementOf(board: readonly string[]): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const p = board[rank * 8 + file]!;
      if (!p) empty++;
      else {
        if (empty) row += String(empty);
        empty = 0;
        row += p;
      }
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  return rows.join("/");
}

export function toFen(s: ChessState): string {
  return `${placementOf(s.board)} ${s.turn} ${s.castling || "-"} ${s.ep < 0 ? "-" : squareName(s.ep)} ${s.halfmove} ${s.fullmove}`;
}

/**
 * The position for repetition: placement, side to move, castling rights, and
 * the en passant square only when a capture onto it is actually possible.
 */
export function positionKey(s: ChessState): string {
  let ep = "-";
  if (s.ep >= 0 && pseudoMoves(s).some((m) => m.enPassant && isLegalAfter(s, m))) ep = squareName(s.ep);
  return `${placementOf(s.board)} ${s.turn} ${s.castling || "-"} ${ep}`;
}

// ---------------------------------------------------------------------------
// Attacks
// ---------------------------------------------------------------------------

const KNIGHT: ReadonlyArray<[number, number]> = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING: ReadonlyArray<[number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const ROOK_DIRS: ReadonlyArray<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS: ReadonlyArray<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Is `sq` attacked by any piece of colour `by`? */
export function isAttacked(board: readonly string[], sq: number, by: ChessColor): boolean {
  const f = sq & 7;
  const r = sq >> 3;
  const up = by === "w" ? -1 : 1; // an attacking pawn stands one rank behind the square, from its side
  for (const df of [-1, 1]) {
    const pf = f + df;
    const pr = r + up;
    if (onBoard(pf, pr) && board[pr * 8 + pf] === (by === "w" ? "P" : "p")) return true;
  }
  const knight = by === "w" ? "N" : "n";
  for (const [df, dr] of KNIGHT) {
    if (onBoard(f + df, r + dr) && board[(r + dr) * 8 + f + df] === knight) return true;
  }
  const king = by === "w" ? "K" : "k";
  for (const [df, dr] of KING) {
    if (onBoard(f + df, r + dr) && board[(r + dr) * 8 + f + df] === king) return true;
  }
  const rookish = by === "w" ? ["R", "Q"] : ["r", "q"];
  const bishopish = by === "w" ? ["B", "Q"] : ["b", "q"];
  for (const [dirs, hitters] of [
    [ROOK_DIRS, rookish],
    [BISHOP_DIRS, bishopish],
  ] as const) {
    for (const [df, dr] of dirs) {
      let cf = f + df;
      let cr = r + dr;
      while (onBoard(cf, cr)) {
        const p = board[cr * 8 + cf]!;
        if (p) {
          if (hitters.includes(p)) return true;
          break;
        }
        cf += df;
        cr += dr;
      }
    }
  }
  return false;
}

export function inCheck(s: ChessState, color: ChessColor = s.turn): boolean {
  const king = s.board.indexOf(color === "w" ? "K" : "k");
  return king >= 0 && isAttacked(s.board, king, other(color));
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

function move(s: ChessState, from: number, to: number, extra: Partial<ChessMove> = {}): ChessMove {
  return {
    from,
    to,
    piece: s.board[from]!,
    captured: s.board[to]!,
    promotion: null,
    castle: null,
    enPassant: false,
    ...extra,
  };
}

function pseudoMoves(s: ChessState): ChessMove[] {
  const out: ChessMove[] = [];
  const us = s.turn;
  const them = other(us);
  for (let sq = 0; sq < 64; sq++) {
    const p = s.board[sq]!;
    if (!p || colorOf(p) !== us) continue;
    const f = sq & 7;
    const r = sq >> 3;
    const kind = p.toLowerCase();
    if (kind === "p") {
      const dir = us === "w" ? 1 : -1;
      const startRank = us === "w" ? 1 : 6;
      const lastRank = us === "w" ? 7 : 0;
      const pushPawn = (to: number, extra: Partial<ChessMove> = {}) => {
        if (to >> 3 === lastRank) {
          for (const promotion of ["q", "r", "b", "n"] as const) out.push(move(s, sq, to, { ...extra, promotion }));
        } else out.push(move(s, sq, to, extra));
      };
      const one = sq + 8 * dir;
      if (onBoard(f, r + dir) && !s.board[one]) {
        pushPawn(one);
        const two = sq + 16 * dir;
        if (r === startRank && !s.board[two]) out.push(move(s, sq, two));
      }
      for (const df of [-1, 1]) {
        if (!onBoard(f + df, r + dir)) continue;
        const to = (r + dir) * 8 + f + df;
        const target = s.board[to]!;
        if (target && colorOf(target) === them) pushPawn(to);
        else if (!target && to === s.ep) out.push(move(s, sq, to, { enPassant: true, captured: us === "w" ? "p" : "P" }));
      }
      continue;
    }
    if (kind === "n" || kind === "k") {
      for (const [df, dr] of kind === "n" ? KNIGHT : KING) {
        if (!onBoard(f + df, r + dr)) continue;
        const to = (r + dr) * 8 + f + df;
        if (colorOf(s.board[to]!) !== us) out.push(move(s, sq, to));
      }
      if (kind === "k") castles(s, sq, out);
      continue;
    }
    const dirs = kind === "r" ? ROOK_DIRS : kind === "b" ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS];
    for (const [df, dr] of dirs) {
      let cf = f + df;
      let cr = r + dr;
      while (onBoard(cf, cr)) {
        const to = cr * 8 + cf;
        const target = s.board[to]!;
        if (target && colorOf(target) === us) break;
        out.push(move(s, sq, to));
        if (target) break;
        cf += df;
        cr += dr;
      }
    }
  }
  return out;
}

function castles(s: ChessState, sq: number, out: ChessMove[]): void {
  const us = s.turn;
  const home = us === "w" ? 4 : 60;
  if (sq !== home) return;
  const them = other(us);
  const rook = us === "w" ? "R" : "r";
  const kRight = us === "w" ? "K" : "k";
  const qRight = us === "w" ? "Q" : "q";
  if (isAttacked(s.board, home, them)) return;
  if (s.castling.includes(kRight) && s.board[home + 3] === rook && !s.board[home + 1] && !s.board[home + 2]) {
    if (!isAttacked(s.board, home + 1, them) && !isAttacked(s.board, home + 2, them)) {
      out.push(move(s, home, home + 2, { castle: "k" }));
    }
  }
  if (
    s.castling.includes(qRight) &&
    s.board[home - 4] === rook &&
    !s.board[home - 1] &&
    !s.board[home - 2] &&
    !s.board[home - 3]
  ) {
    if (!isAttacked(s.board, home - 1, them) && !isAttacked(s.board, home - 2, them)) {
      out.push(move(s, home, home - 2, { castle: "q" }));
    }
  }
}

const CORNER_RIGHTS: Record<number, string> = { 0: "Q", 7: "K", 56: "q", 63: "k" };

/** The position after `m`. Does not check legality. */
export function applyChessMove(s: ChessState, m: ChessMove): ChessState {
  const board = s.board.slice();
  const us = s.turn;
  board[m.to] = m.promotion ? (us === "w" ? m.promotion.toUpperCase() : m.promotion) : m.piece;
  board[m.from] = "";
  if (m.enPassant) board[m.to + (us === "w" ? -8 : 8)] = "";
  if (m.castle === "k") {
    board[m.from + 1] = board[m.from + 3]!;
    board[m.from + 3] = "";
  } else if (m.castle === "q") {
    board[m.from - 1] = board[m.from - 4]!;
    board[m.from - 4] = "";
  }
  let castling = s.castling;
  if (m.piece === "K") castling = castling.replace("K", "").replace("Q", "");
  if (m.piece === "k") castling = castling.replace("k", "").replace("q", "");
  for (const sq of [m.from, m.to]) {
    const right = CORNER_RIGHTS[sq];
    if (right) castling = castling.replace(right, "");
  }
  const pawn = m.piece.toLowerCase() === "p";
  const ep = pawn && Math.abs(m.to - m.from) === 16 ? (m.from + m.to) / 2 : -1;
  return {
    board,
    turn: other(us),
    castling,
    ep,
    halfmove: pawn || m.captured ? 0 : s.halfmove + 1,
    fullmove: us === "b" ? s.fullmove + 1 : s.fullmove,
  };
}

function isLegalAfter(s: ChessState, m: ChessMove): boolean {
  return !inCheck(applyChessMove(s, m), s.turn);
}

export function legalChessMoves(s: ChessState): ChessMove[] {
  return pseudoMoves(s).filter((m) => isLegalAfter(s, m));
}

export function uciOf(m: ChessMove): string {
  return `${squareName(m.from)}${squareName(m.to)}${m.promotion ?? ""}`;
}

/** Standard algebraic notation, with + and #. `legal` is legalChessMoves(s), passed in when known. */
export function sanOf(s: ChessState, m: ChessMove, legal: ChessMove[] = legalChessMoves(s)): string {
  let san: string;
  if (m.castle) san = m.castle === "k" ? "O-O" : "O-O-O";
  else {
    const kind = m.piece.toUpperCase();
    const capture = m.captured !== "" || m.enPassant;
    if (kind === "P") {
      san = `${capture ? `${FILES[m.from & 7]}x` : ""}${squareName(m.to)}${m.promotion ? `=${m.promotion.toUpperCase()}` : ""}`;
    } else {
      const rivals = legal.filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
      let dis = "";
      if (rivals.length) {
        const sameFile = rivals.some((o) => (o.from & 7) === (m.from & 7));
        const sameRank = rivals.some((o) => o.from >> 3 === m.from >> 3);
        if (!sameFile) dis = FILES[m.from & 7]!;
        else if (!sameRank) dis = String((m.from >> 3) + 1);
        else dis = squareName(m.from);
      }
      san = `${kind}${dis}${capture ? "x" : ""}${squareName(m.to)}`;
    }
  }
  const after = applyChessMove(s, m);
  if (inCheck(after)) san += legalChessMoves(after).length ? "+" : "#";
  return san;
}

/**
 * Read a move as a player sends it: UCI ("e2e4", "e7e8q") or SAN ("e4",
 * "Nf3", "O-O", "exd8=Q+"). A pawn reaching the last rank with no piece named
 * promotes to a queen. Null when it is not a legal move here.
 */
export function parseChessMove(s: ChessState, input: string): ChessMove | null {
  const raw = String(input ?? "").trim();
  if (!raw || raw.length > 12) return null;
  const legal = legalChessMoves(s);
  const uci = /^([a-h][1-8])-?([a-h][1-8])=?([qrbnQRBN])?$/.exec(raw);
  if (uci) {
    const from = parseSquare(uci[1]!);
    const to = parseSquare(uci[2]!);
    const promo = (uci[3]?.toLowerCase() ?? null) as PromotionPiece | null;
    const matches = legal.filter((m) => m.from === from && m.to === to);
    if (!matches.length) return null;
    if (matches.some((m) => m.promotion)) return matches.find((m) => m.promotion === (promo ?? "q")) ?? null;
    return promo ? null : matches[0]!;
  }
  const clean = (x: string) => x.replace(/[+#!?]/g, "").replace(/0/g, "O").replace(/=/g, "");
  const wanted = clean(raw);
  for (const m of legal) {
    const san = clean(sanOf(s, m, legal));
    if (san === wanted) return m;
    // "e8" for "e8=Q": a promotion with no piece named is a queen.
    if (m.promotion === "q" && san.slice(0, -1) === wanted) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export type ChessEnd =
  | { over: false }
  | { over: true; winner: ChessColor | null; reason: "checkmate" | "stalemate" | "fifty_moves" | "repetition" | "insufficient_material" };

/** Neither side can ever mate: bare kings, or one minor piece, or bishops all on one colour. */
export function insufficientMaterial(board: readonly string[]): boolean {
  const pieces: Array<{ p: string; sq: number }> = [];
  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq]!;
    if (p && p.toLowerCase() !== "k") pieces.push({ p: p.toLowerCase(), sq });
  }
  if (!pieces.length) return true;
  if (pieces.length === 1 && (pieces[0]!.p === "n" || pieces[0]!.p === "b")) return true;
  if (pieces.every((x) => x.p === "b")) {
    const shade = (sq: number) => ((sq & 7) + (sq >> 3)) % 2;
    return pieces.every((x) => shade(x.sq) === shade(pieces[0]!.sq));
  }
  return false;
}

/**
 * Is the game over in this position? `history` is the list of positionKey()s
 * seen since the last capture or pawn move, including this one. The
 * fifty-move rule and threefold repetition end the game automatically: there
 * is no referee to claim a draw to.
 */
export function chessEnd(s: ChessState, history: readonly string[] = []): ChessEnd {
  const legal = legalChessMoves(s);
  if (!legal.length) {
    return inCheck(s) ? { over: true, winner: other(s.turn), reason: "checkmate" } : { over: true, winner: null, reason: "stalemate" };
  }
  if (insufficientMaterial(s.board)) return { over: true, winner: null, reason: "insufficient_material" };
  if (s.halfmove >= 100) return { over: true, winner: null, reason: "fifty_moves" };
  if (history.length >= 3) {
    const key = history[history.length - 1]!;
    if (history.filter((h) => h === key).length >= 3) return { over: true, winner: null, reason: "repetition" };
  }
  return { over: false };
}

/** Leaf nodes at `depth`: the move generator's proof of correctness. */
export function perft(s: ChessState, depth: number): number {
  if (depth <= 0) return 1;
  const moves = legalChessMoves(s);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(applyChessMove(s, m), depth - 1);
  return n;
}
