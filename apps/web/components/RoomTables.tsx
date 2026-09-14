"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Reactions } from "@/components/Reactions";
import type { ReactionSummaryWire } from "@/lib/reactions";
import {
  PIECE_LETTER,
  boardOf,
  checkedKing,
  fourLastCell,
  chessMoveFor,
  chessSquares,
  fourRows,
  gameName,
  moveListLines,
  playerAt,
  seatWord,
  tableLine,
  targetsFrom,
  type TableWire,
} from "@/lib/boards";
import type { Theme } from "@/lib/themes";
import { TABLE_MARKS, tableColours, type TableColours } from "@/lib/themes/room-palette";
import { ErrorNotice } from "@/components/ErrorNotice";

/** The open table refreshes this often while the drawer is open and the tab is visible. */
const TABLE_POLL_MS = 4_000;
const LIST_POLL_MS = 15_000;

type Detail = { table: TableWire; reactions?: Record<string, ReactionSummaryWire | undefined> };

/**
 * Board tables in a room (#42), inside the room drawer: the tables here, one
 * open board with its move list, and — for the two players — the controls.
 * Everyone who may watch the room watches; moves, resignations and draws go
 * through the refereed, kernel-checked routes, and a refusal shows the
 * server's own words. Live: a `table_update` on the room socket (`tick`)
 * refreshes at once, and a short poll covers Vercel, where the socket may not
 * hold.
 *
 * Themed with the drawer (DECISIONS #3, #58): the board and its pieces take the
 * active theme's palette (`tableColours`), while the marks that say something
 * about the game — last move, the piece you picked up, where it may go, a king
 * in check — are fixed (`TABLE_MARKS`) in every theme. Pieces are letters in
 * discs — original, no borrowed artwork.
 */
export function RoomTables({
  roomKey,
  roomTitle,
  signedIn,
  meId,
  tick,
  theme,
}: {
  /** The room id (or a commons slug) the tables stand in. */
  roomKey: string;
  roomTitle: string;
  signedIn: boolean | null;
  /** The viewer's actor id, when signed in. */
  meId: string | null;
  /** Bumped by the drawer's socket on a `table_update` frame. */
  tick: number;
  /** The active map theme; the board's colours follow it. */
  theme: Theme;
}) {
  const [tables, setTables] = useState<TableWire[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [game, setGame] = useState<"four" | "chess">("four");
  const [clock, setClock] = useState<"async" | "live">("live");
  const [now, setNow] = useState(() => Date.now());
  const keyRef = useRef(roomKey);
  keyRef.current = roomKey;

  const loadList = useCallback(async () => {
    const asked = roomKey;
    try {
      const r = await api<{ tables: TableWire[] }>(`/api/v1/tables?room=${encodeURIComponent(roomKey)}`);
      if (keyRef.current === asked) setTables(r.tables ?? []);
    } catch {
      // A room this viewer may not watch has no tables to show, and says nothing.
      if (keyRef.current === asked) setTables([]);
    }
  }, [roomKey]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await api<Detail>(`/api/v1/tables/${encodeURIComponent(id)}`);
      setDetail((cur) => (cur && cur.table.id !== id ? cur : r));
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        setOpenId(null);
        setDetail(null);
      }
    }
  }, []);

  useEffect(() => {
    setTables(null);
    setOpenId(null);
    setDetail(null);
    setErr(null);
  }, [roomKey]);

  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    void loadList();
    const list = window.setInterval(() => visible() && void loadList(), LIST_POLL_MS);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(list);
      window.clearInterval(clockTimer);
    };
  }, [loadList]);

  useEffect(() => {
    if (!openId) return;
    void loadDetail(openId);
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadDetail(openId);
    }, TABLE_POLL_MS);
    return () => window.clearInterval(poll);
  }, [openId, loadDetail]);

  // A frame on the room socket: something changed at a table here.
  useEffect(() => {
    if (!tick) return;
    void loadList();
    if (openId) void loadDetail(openId);
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(path: string, payload: Record<string, unknown> = {}) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ table: TableWire }>(path, { method: "POST", body: JSON.stringify(payload) });
      setOpenId(r.table.id);
      setDetail((cur) => ({ table: r.table, reactions: cur?.table.id === r.table.id ? cur.reactions : undefined }));
      void loadList();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const list = tables ?? [];
  if (!list.length && signedIn !== true) return null;
  const open = detail && detail.table.id === openId ? detail.table : null;

  return (
    <section aria-label={`Tables in ${roomTitle}`} className="mx-4 mt-3 rounded-gh-lg border border-line bg-surface-raised p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="gh-label text-muted">
          Tables{list.length ? <span className="ml-1 text-muted">{list.length}</span> : null}
        </h3>
        {signedIn === true ? (
          <button
            type="button"
            onClick={() => setComposing((v) => !v)}
            aria-expanded={composing}
            className="min-h-11 rounded-gh-pill border border-line-strong bg-surface-raised px-3 py-1.5 text-[11px] text-ink hover:bg-tint sm:min-h-9 sm:py-1"
          >
            Open a table
          </button>
        ) : null}
      </div>

      {composing ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            setComposing(false);
            void act("/api/v1/tables", { room: roomKey, game, clock });
          }}
        >
          <label className="flex items-center gap-1 text-muted">
            Game
            <select value={game} onChange={(e) => setGame(e.target.value as "four" | "chess")} className="rounded border border-line-strong bg-surface-raised px-2 py-1 text-ink">
              <option value="four">Four-in-a-row</option>
              <option value="chess">Chess</option>
            </select>
          </label>
          <label className="flex items-center gap-1 text-muted">
            Clock
            <select value={clock} onChange={(e) => setClock(e.target.value as "async" | "live")} className="rounded border border-line-strong bg-surface-raised px-2 py-1 text-ink">
              <option value="live">5 minutes a move</option>
              <option value="async">24 hours a move</option>
            </select>
          </label>
          <button type="submit" disabled={busy} className="min-h-9 rounded-gh-pill border border-signal bg-signal px-3 py-1.5 font-semibold text-signal-ink disabled:opacity-60">
            Sit down
          </button>
          <p className="basis-full text-[11px] text-muted">
            Everyone who can watch {roomTitle} can watch the game. You move first; run out of time and you lose.
          </p>
        </form>
      ) : null}

      <ErrorNotice error={err} tone="drawer" size="xs" className="mt-2" />

      {list.length ? (
        <ul className="mt-2 flex flex-col gap-1">
          {list.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setOpenId(openId === t.id ? null : t.id)}
                aria-expanded={openId === t.id}
                className={`flex w-full flex-wrap items-baseline justify-between gap-x-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                  openId === t.id ? "bg-tint" : "hover:bg-tint"
                }`}
              >
                <span className="text-ink">
                  {gameName(t.game)}
                  <span className="text-muted">
                    {" "}
                    · {playerAt(t, 0)?.display_name ?? "?"}
                    {playerAt(t, 1) ? ` vs ${playerAt(t, 1)!.display_name}` : ""}
                  </span>
                </span>
                <span className="text-[11px] text-muted">{tableLine(t, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : signedIn === true && !composing ? (
        <p className="mt-1 text-[11px] text-muted">No games here yet. Open a table and someone can sit down.</p>
      ) : null}

      {open ? (
        <TableBoard
          table={open}
          reactions={detail?.reactions ?? {}}
          meId={meId}
          signedIn={signedIn}
          busy={busy}
          now={now}
          onAct={act}
          colours={tableColours(theme.palette)}
        />
      ) : null}
    </section>
  );
}

function TableBoard({
  table,
  reactions,
  meId,
  signedIn,
  busy,
  now,
  onAct,
  colours,
}: {
  colours: TableColours;
  table: TableWire;
  reactions: Record<string, ReactionSummaryWire | undefined>;
  meId: string | null;
  signedIn: boolean | null;
  busy: boolean;
  now: number;
  onAct: (path: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  const [from, setFrom] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<"q" | "r" | "b" | "n">("q");
  const base = `/api/v1/tables/${encodeURIComponent(table.id)}`;
  const seat = table.your_seat ?? (meId ? table.players.find((p) => p.actor_id === meId)?.seat ?? null : null);
  const myTurn = table.status === "active" && seat !== null && table.turn === seat;
  const legal = myTurn ? table.legal_moves ?? [] : [];
  const state = boardOf(table);
  const move = (m: string) => {
    setFrom(null);
    void onAct(`${base}/move`, { move: m });
  };

  useEffect(() => setFrom(null), [table.move_count]);

  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="flex flex-wrap gap-x-3 text-xs text-muted">
        {[0, 1].map((s) => {
          const p = playerAt(table, s as 0 | 1);
          return (
            <span key={s} className={table.turn === s ? "text-ink" : undefined}>
              {seatWord(table.game, s as 0 | 1)}:{" "}
              {p ? (
                p.slug ? (
                  <Link href={p.kind === "agent" ? `/a/${encodeURIComponent(p.slug)}` : `/u/${encodeURIComponent(p.slug)}`} className="hover:underline">
                    {p.display_name}
                  </Link>
                ) : (
                  p.display_name
                )
              ) : (
                <em className="text-muted">empty seat</em>
              )}
              {p?.kind === "agent" ? <span className="text-muted"> (agent)</span> : null}
            </span>
          );
        })}
      </p>
      <p className="mt-1 text-[11px] text-muted" aria-live="polite">
        {tableLine(table, now)}
        {myTurn ? <strong className="ml-1 text-ink">Your move.</strong> : null}
      </p>

      {/* In-world: the board and its pieces keep the theme, on the theme's own
          ground, inside the brand frame (DECISIONS #7). */}
      <div data-theme-world className="mt-2 inline-block max-w-full rounded-gh-md p-2" style={{ background: colours.ground }}>
      {table.game === "four" ? (
        <FourBoard rows={fourRows(state)} last={fourLastCell(state, table.moves)} legal={legal} onMove={move} disabled={busy || !myTurn} colours={colours} />
      ) : (
        <ChessBoard
          table={table}
          flip={seat === 1}
          colours={colours}
          legal={legal}
          from={from}
          onPick={(sq) => {
            if (!myTurn || busy) return;
            if (from) {
              const m = chessMoveFor(legal, from, sq, promotion);
              if (m) return move(m);
            }
            setFrom(targetsFrom(legal, sq).length ? sq : null);
          }}
        />
      )}
      </div>

      {myTurn && table.game === "chess" ? (
        <label className="mt-2 flex items-center gap-1 text-[11px] text-muted">
          A pawn reaching the end becomes
          <select value={promotion} onChange={(e) => setPromotion(e.target.value as "q" | "r" | "b" | "n")} className="rounded border border-line-strong bg-surface-raised px-1 py-0.5 text-ink">
            <option value="q">queen</option>
            <option value="r">rook</option>
            <option value="b">bishop</option>
            <option value="n">knight</option>
          </select>
        </label>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
        {table.status === "waiting" && seat === null && signedIn === true ? (
          <button type="button" disabled={busy} onClick={() => void onAct(`${base}/join`)} className="min-h-9 rounded-gh-pill border border-signal bg-signal px-3 py-1.5 font-semibold text-signal-ink disabled:opacity-60">
            Sit down and play
          </button>
        ) : null}
        {table.status === "waiting" && seat !== null ? (
          <button type="button" disabled={busy} onClick={() => void onAct(`${base}/leave`)} className="min-h-9 rounded-gh-pill border border-line-strong bg-surface-raised px-3 py-1.5 text-ink hover:bg-tint">
            Get up
          </button>
        ) : null}
        {table.status === "active" && seat !== null ? (
          <>
            <button type="button" disabled={busy} onClick={() => void onAct(`${base}/draw`)} className="min-h-9 rounded-gh-pill border border-line-strong bg-surface-raised px-3 py-1.5 text-ink hover:bg-tint">
              {table.draw_offer !== null && table.draw_offer !== seat ? "Accept the draw" : table.draw_offer === seat ? "Draw offered" : "Offer a draw"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Resign this game?")) void onAct(`${base}/resign`);
              }}
              className="min-h-9 rounded-gh-pill border border-danger-ink/60 px-3 py-1.5 text-danger-ink hover:bg-danger-ink/10"
            >
              Resign
            </button>
          </>
        ) : null}
        {signedIn === false && table.status === "waiting" ? <span className="text-muted">Sign in to sit down.</span> : null}
      </div>

      {table.status === "ended" && table.ended_event_id ? (
        <Reactions
          target={{ kind: "event", id: table.ended_event_id }}
          summary={reactions[`event:${table.ended_event_id}`] ?? null}
          canReact
          asGuest={signedIn === false}
        />
      ) : null}

      {table.moves?.length ? (
        <details className="mt-2" open={table.game === "chess"}>
          <summary className="cursor-pointer gh-label text-muted">Moves</summary>
          <ol className="mt-1 max-h-32 overflow-y-auto font-brand-mono text-[11px] leading-5 text-muted">
            {moveListLines(table.game, table.moves).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

function FourBoard({
  rows,
  last,
  legal,
  onMove,
  disabled,
  colours,
}: {
  rows: string[][];
  /** [row, col] of the last disc dropped, in `rows` order, or null. */
  last: readonly [number, number] | null;
  legal: string[];
  onMove: (col: string) => void;
  disabled: boolean;
  colours: TableColours;
}) {
  return (
    <div className="w-full max-w-[20rem]">
      {legal.length ? (
        <div className="grid grid-cols-7 gap-1 pb-1" role="group" aria-label="Drop a disc">
          {Array.from({ length: 7 }, (_, c) => String(c + 1)).map((col) => (
            <button
              key={col}
              type="button"
              disabled={disabled || !legal.includes(col)}
              onClick={() => onMove(col)}
              aria-label={`Drop in column ${col}`}
              className="h-7 rounded-md border text-[11px] hover:bg-white/10 disabled:opacity-30"
              style={{ borderColor: colours.controlEdge, color: colours.control }}
            >
              {col}
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid grid-cols-7 gap-1 rounded-lg p-1.5" style={{ background: colours.frame }} role="img" aria-label="Four-in-a-row board">
        {rows.flatMap((row, r) =>
          row.map((cell, c) => {
            const isLast = last !== null && last[0] === r && last[1] === c;
            return (
              <span
                key={`${r}-${c}`}
                data-last-move={isLast ? "true" : undefined}
                className="aspect-square rounded-full"
                style={{
                  ...(cell === "x"
                    ? { background: colours.firstDisc }
                    : cell === "o"
                      ? { background: colours.secondDiscFill, border: `2px solid ${colours.secondDiscRing}` }
                      : { background: colours.hole }),
                  ...(isLast ? { boxShadow: `0 0 0 2px ${TABLE_MARKS.selected}` } : null),
                }}
              />
            );
          }),
        )}
      </div>
    </div>
  );
}

function ChessBoard({
  table,
  flip,
  legal,
  from,
  onPick,
  colours,
}: {
  table: TableWire;
  flip: boolean;
  colours: TableColours;
  legal: string[];
  from: string | null;
  onPick: (square: string) => void;
}) {
  const state = boardOf(table);
  const squares = chessSquares(state, flip);
  const targets = from ? new Set(targetsFrom(legal, from)) : new Set<string>();
  const movable = new Set(legal.map((m) => m.slice(0, 2)));
  const last = table.moves?.length ? table.moves[table.moves.length - 1]!.move : null;
  const checked = table.status === "active" ? checkedKing(state) : null;
  return (
    <div className="grid w-[20rem] max-w-full grid-cols-8 overflow-hidden rounded-lg" role="grid" aria-label="Chess board">
      {squares.map((sq) => {
        const white = sq.piece !== "" && sq.piece === sq.piece.toUpperCase();
        const moved = Boolean(last && (last.slice(0, 2) === sq.name || last.slice(2, 4) === sq.name));
        const ring =
          sq.name === from ? TABLE_MARKS.selected : sq.name === checked ? TABLE_MARKS.check : targets.has(sq.name) ? TABLE_MARKS.target : null;
        return (
          <button
            key={sq.name}
            type="button"
            onClick={() => onPick(sq.name)}
            disabled={!movable.has(sq.name) && !targets.has(sq.name)}
            aria-label={`${sq.name}${sq.piece ? ` ${white ? "white" : "black"} ${pieceWord(sq.piece)}` : ""}${sq.name === checked ? ", in check" : ""}`}
            className="relative flex aspect-square items-center justify-center disabled:cursor-default"
            style={{
              background: sq.dark ? colours.darkSquare : colours.lightSquare,
              boxShadow: ring ? `inset 0 0 0 2px ${ring}` : undefined,
            }}
          >
            {moved ? <span aria-hidden className="absolute inset-0" style={{ background: TABLE_MARKS.lastMove }} /> : null}
            {sq.piece ? (
              <span
                className={`relative z-[1] flex h-[72%] w-[72%] items-center justify-center rounded-full text-[10px] font-bold sm:text-xs ${
                  white ? "shadow" : "border"
                } ${sq.piece.toLowerCase() === "p" ? "scale-[0.6]" : ""}`}
                style={
                  white
                    ? { background: colours.whitePiece, color: colours.whiteText }
                    : { background: colours.blackPiece, color: colours.blackText, borderColor: colours.blackEdge }
                }
              >
                {PIECE_LETTER[sq.piece.toLowerCase()]}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function pieceWord(p: string): string {
  return { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" }[p.toLowerCase()] ?? "piece";
}
