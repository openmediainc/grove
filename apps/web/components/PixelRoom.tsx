"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_SPEECH_METRICS, SpeechBook, type Rect, type Speaker, type SpeechMetrics } from "@grove/ui";
import type { Nearby } from "@/lib/api";
import type { CharKey } from "@/lib/art";
import { paintSpeech, speechPainter } from "@/lib/speech-render";
import type { Theme } from "@/lib/themes";
import { roomColours } from "@/lib/themes/room-palette";

const SPRITE = 64;
/** A cell never shrinks below this, so a phone gets fewer columns, not smaller bodies. */
const MIN_CELL = 54;
/** Clear floor above the first row: the top row's speech has to go somewhere. */
const HEADROOM = 58;
/** Under each body: its name. */
const NAME_H = 12;
/** Lines older than this are not over anyone's head any more; the transcript keeps them. */
const ROOM_SPEECH_MAX_AGE_MS = 10 * 60_000;
/** A tapped body's line stays open in full for this long. */
const EXPAND_MS = 8_000;

export type RoomBubble = { sender_id: string; body: string; created_at?: string; whisper?: boolean };

function spriteKey(kind: "human" | "agent", activity: string | undefined): CharKey {
  const act = activity ?? "idle";
  if (kind === "human") {
    if (act === "chatting" || act === "performing") return "human-speak";
    if (act === "listening" || act === "reading") return "human-side";
    return "human-front";
  }
  if (act === "working") return "agent-work";
  if (act === "listening" || act === "reading") return "agent-side";
  return "agent-front";
}

/**
 * The room's grid for the width it has.
 *
 * It used to be a fixed sqrt(capacity) square of 64px cells — 7x6 for a
 * 40-seat Plaza — drawn at 448px and squeezed by CSS into a phone's 358px, so
 * the bodies were squashed, the top row's speech was cut off above the canvas,
 * and three people in a big room stood in one corner of a wall of cobble.
 *
 * Now the bodies present are packed in seat order: as many columns as the
 * width allows (never more than the square would have), cells at least
 * MIN_CELL wide, and only as many rows as there are bodies. The floor is sized
 * to who is here, not to who could be.
 */
export function roomGrid(count: number, capacity: number, availW: number) {
  const square = Math.ceil(Math.sqrt(Math.max(1, capacity || 30)));
  const fit = Math.max(1, Math.floor(availW / MIN_CELL));
  const cols = Math.max(1, Math.min(square, fit));
  const cell = Math.min(SPRITE, Math.floor(availW / cols));
  const rows = Math.max(1, Math.ceil(count / cols));
  const rowH = cell + NAME_H + 26;
  return { cols, rows, cell, rowH, w: cols * cell, h: HEADROOM + rows * rowH };
}

/** Bodies in the order the grid packs them. */
function bySeat(nearby: readonly Nearby[]): Nearby[] {
  return [...nearby].sort((p, q) => (p.presence?.seat_index ?? 0) - (q.presence?.seat_index ?? 0));
}

function cellCentre(i: number, g: ReturnType<typeof roomGrid>) {
  const col = i % g.cols;
  const row = Math.floor(i / g.cols);
  return { cx: col * g.cell + g.cell / 2, cy: HEADROOM + row * g.rowH + g.cell / 2, col };
}

/** Which body a point on the canvas (CSS px, canvas-relative) is over. */
export function roomActorAt(
  nearby: readonly Nearby[],
  g: ReturnType<typeof roomGrid>,
  x: number,
  y: number,
): string | null {
  const col = Math.floor(x / g.cell);
  const row = Math.floor((y - HEADROOM) / g.rowH);
  if (col < 0 || col >= g.cols || row < 0) return null;
  return bySeat(nearby)[row * g.cols + col]?.actor_id ?? null;
}

/** Where the pixel room's furniture stands, for a grid holding `count` bodies. Pure. */
export function roomFurniture(count: number, g: Pick<ReturnType<typeof roomGrid>, "cols" | "rows">) {
  const lamps = g.cols >= 2 ? [0, g.cols - 1] : [0];
  const tables: number[] = [];
  // Empty cells of the last row: every other one gets a table, so a quiet room
  // still reads as a room and not as a wall of floor.
  for (let i = count; i < g.cols * g.rows; i++) if (i % 2 === 0) tables.push(i);
  return { lamps, tables };
}

export function PixelRoom({
  roomSlug,
  roomTitle,
  theme,
  capacity,
  nearby,
  bubbles,
  className,
  onPickActor,
  highlightId,
}: {
  roomSlug: string;
  /** The room's name in the active theme's words, painted on its wall. */
  roomTitle?: string;
  /** The active map theme (DECISIONS #3): floor, walls, furniture, bodies and speech follow it live. */
  theme: Theme;
  capacity: number;
  nearby: Nearby[];
  bubbles?: RoomBubble[];
  className?: string;
  /** Clicking a body. The roster offers the same thing by keyboard. */
  onPickActor?: (actorId: string) => void;
  /** A body to ring (who you are whispering to). */
  highlightId?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nearbyRef = useRef(nearby);
  nearbyRef.current = nearby;
  const highlightRef = useRef(highlightId);
  highlightRef.current = highlightId;
  const [availW, setAvailW] = useState(SPRITE * 6);
  const widthRef = useRef(availW);
  widthRef.current = availW;
  const expandRef = useRef<{ id: string; until: number } | null>(null);
  const hoverRef = useRef<string | null>(null);
  const titleRef = useRef(roomTitle ?? roomSlug);
  titleRef.current = roomTitle ?? roomSlug;
  // Like the map: keep drawing the previous theme until the new one's art is prepared.
  const drawnThemeRef = useRef<Theme>(theme);
  useEffect(() => {
    let live = true;
    void theme.art.prepare().then(() => {
      if (live) drawnThemeRef.current = theme;
    });
    return () => {
      live = false;
    };
  }, [theme]);

  // Newest line per speaker, rebuilt when the transcript changes. The old
  // lookup took each speaker's FIRST line in the transcript — their oldest.
  const bookRef = useRef(new SpeechBook());
  useEffect(() => {
    const book = new SpeechBook();
    const now = Date.now();
    for (const l of bubbles ?? []) {
      const at = l.created_at ? Date.parse(l.created_at) : NaN;
      book.hear(l.sender_id, l.body, Number.isFinite(at) ? at : now, Boolean(l.whisper));
    }
    bookRef.current = book;
  }, [bubbles]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setAvailW(Math.max(MIN_CELL * 3, Math.floor(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let cancelled = false;
    const painter = speechPainter();

    const start = () => {
      if (cancelled || !canvasRef.current) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);

      const draw = (t: number) => {
        if (cancelled) return;
        const el = canvasRef.current;
        if (!el) return;
        const theme = drawnThemeRef.current;
        const colours = roomColours(theme.palette);
        const actors = bySeat(nearbyRef.current ?? []);
        const g = roomGrid(actors.length, capacity, widthRef.current);
        if (el.width !== Math.floor(g.w * dpr) || el.height !== Math.floor(g.h * dpr)) {
          el.width = Math.floor(g.w * dpr);
          el.height = Math.floor(g.h * dpr);
          el.style.width = `${g.w}px`;
          el.style.height = `${g.h}px`;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, g.w, g.h);
        for (let x = 0; x < g.w; x += g.cell) theme.art.room(ctx, "wall", x, 0, g.cell, HEADROOM);
        for (let y = HEADROOM; y < g.h; y += g.cell) {
          for (let x = 0; x < g.w; x += g.cell) theme.art.room(ctx, "floor", x, y, g.cell, g.cell);
        }
        // The room steps back so the bodies and what they say come forward:
        // at phone width, full-strength floor was louder than anybody on it.
        ctx.fillStyle = colours.dim;
        ctx.fillRect(0, 0, g.w, g.h);

        const furniture = roomFurniture(actors.length, g);
        ctx.save();
        ctx.globalAlpha = 0.85;
        for (const col of furniture.lamps) theme.art.room(ctx, "lamp", col * g.cell, 0, g.cell, HEADROOM);
        for (const i of furniture.tables) {
          const { cx, cy } = cellCentre(i, g);
          theme.art.room(ctx, "table", cx - g.cell / 2, cy - g.cell / 2, g.cell, g.cell);
        }
        actors.forEach((_, i) => {
          const { cx, cy } = cellCentre(i, g);
          theme.art.room(ctx, "seat", cx - g.cell / 2, cy - g.cell / 2 + 4, g.cell, g.cell);
        });
        ctx.restore();

        // The room's name on its wall, in the theme's words and display face.
        const title = titleRef.current;
        if (title) {
          const room = Math.max(0, g.w - (g.cols >= 2 ? 2 * g.cell : 0) - 12);
          ctx.font = `11px ${theme.palette.displayFont}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          let label = title;
          while (label.length > 1 && ctx.measureText(label).width > room - 12) label = label.slice(0, -1);
          if (label !== title) label = `${label.slice(0, -1)}…`;
          if (room > 30) {
            const lw = ctx.measureText(label).width + 12;
            ctx.fillStyle = colours.placardBg;
            ctx.fillRect(g.w / 2 - lw / 2, 6, lw, 16);
            ctx.strokeStyle = colours.placardEdge;
            ctx.lineWidth = 1;
            ctx.strokeRect(g.w / 2 - lw / 2 + 0.5, 6.5, lw - 1, 15);
            ctx.fillStyle = colours.placardText;
            ctx.fillText(label, g.w / 2, 14);
          }
        }

        const scale = g.cell / SPRITE;
        const names: Rect[] = [];
        const speakers: Speaker[] = [];
        const book = bookRef.current;
        const nowMs = Date.now();
        const exp = expandRef.current;
        if (exp && exp.until < nowMs) expandRef.current = null;
        const expandId = hoverRef.current ?? expandRef.current?.id ?? null;

        actors.forEach((n, i) => {
          const { cx, cy, col } = cellCentre(i, g);
          const seat = n.presence?.seat_index ?? i;
          const activity = n.presence?.activity ?? "idle";
          const key = spriteKey(n.kind, activity);
          const idleBob = activity === "idle" || activity === "chatting" || activity === "performing";
          const bob = idleBob ? Math.sin(t / 220 + seat * 0.85) * 3 : activity === "working" ? Math.sin(t / 160 + seat) * 1.5 : 0;
          const faceLeft = col >= g.cols / 2 && (activity === "listening" || activity === "reading");
          const size = SPRITE * scale;
          if (highlightRef.current === n.actor_id) {
            ctx.save();
            ctx.strokeStyle = colours.whisperRing;
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.ellipse(cx, cy + size / 2 - 8 * scale, size / 2 - 10 * scale, 7 * scale, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
          // The theme's body sprite is a 40 x 40 box; the room draws it at cell size.
          ctx.save();
          ctx.translate(cx, cy + bob);
          const k = size / 40;
          ctx.scale(faceLeft ? -k : k, k);
          const drawn = theme.art.body(ctx, key, 0, 0);
          ctx.restore();
          if (!drawn) {
            ctx.fillStyle = theme.palette.placeholder[n.kind === "agent" ? "agent" : "human"];
            ctx.fillRect(cx - 10, cy - 10 + bob, 20, 20);
          }
          // Names under the bodies: on a phone the roster is a long scroll away.
          const name = n.display_name || n.slug;
          ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          let label = name;
          while (label.length > 1 && ctx.measureText(label).width > g.cell - 4) label = label.slice(0, -1);
          if (label !== name) label = `${label.slice(0, -1)}…`;
          const lw = ctx.measureText(label).width;
          const ny = cy + g.cell / 2 + 1;
          ctx.fillStyle = colours.nameBg;
          ctx.fillRect(cx - lw / 2 - 3, ny - 1, lw + 6, NAME_H);
          ctx.fillStyle = n.kind === "agent" ? colours.agentName : colours.humanName;
          ctx.fillText(label, cx, ny);
          names.push({ x0: cx - lw / 2 - 3, y0: ny - 1, x1: cx + lw / 2 + 3, y1: ny - 1 + NAME_H });

          const said = book.get(n.actor_id);
          if (said && nowMs - said.at <= ROOM_SPEECH_MAX_AGE_MS) {
            speakers.push({
              id: n.actor_id,
              ax: cx,
              ay: cy - size / 2 + 8 + bob,
              text: said.text,
              at: said.at,
              whisper: said.whisper,
              expanded: n.actor_id === expandId,
            });
          }
        });
        ctx.textBaseline = "alphabetic";

        // A room is always close up, so every line gets a bubble if there is
        // room for it; narrower on a phone, so two bubbles fit side by side.
        const narrow = g.w < 480;
        const metrics: SpeechMetrics = {
          ...DEFAULT_SPEECH_METRICS,
          maxW: { mid: 130, near: narrow ? 150 : 190 },
          maxLines: { mid: 1, near: narrow ? 2 : 3 },
          overflowRadius: g.cell * 1.6,
        };
        paintSpeech(ctx, painter, theme, {
          speakers,
          viewport: { w: g.w, h: g.h },
          obstacles: names,
          tier: "near",
          t,
          metrics,
        });
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    };

    start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [roomSlug, capacity]);

  const pointAt = (clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const g = roomGrid(nearbyRef.current.length, capacity, widthRef.current);
    return roomActorAt(nearbyRef.current, g, clientX - rect.left, clientY - rect.top);
  };

  const speaking = nearby.filter((n) => bookRef.current.get(n.actor_id)).length;

  return (
    <div ref={wrapRef} className="w-full">
      <canvas
        ref={canvasRef}
        className={className ?? "mx-auto block rounded-xl border border-lantern-400/20 bg-dusk-950"}
        style={{ imageRendering: "pixelated", cursor: onPickActor ? "pointer" : undefined }}
        role="img"
        aria-label={`${roomTitle ?? roomSlug}: ${nearby.length} here${speaking ? `, ${speaking} speaking — the transcript has every line` : ""}`}
        onPointerMove={(e) => {
          if (e.pointerType === "mouse") hoverRef.current = pointAt(e.clientX, e.clientY);
        }}
        onPointerLeave={() => {
          hoverRef.current = null;
        }}
        onPointerDown={(e) => {
          const id = pointAt(e.clientX, e.clientY);
          expandRef.current = id ? { id, until: Date.now() + EXPAND_MS } : null;
        }}
        onClick={(e) => {
          if (!onPickActor) return;
          const id = pointAt(e.clientX, e.clientY);
          if (id) onPickActor(id);
        }}
      />
    </div>
  );
}
