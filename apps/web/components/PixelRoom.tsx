"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_SPEECH_METRICS, SpeechBook, type Rect, type Speaker, type SpeechMetrics } from "@grove/ui";
import type { Nearby } from "@/lib/api";
import { CHAR_SRC, type CharKey, tileSrc } from "@/lib/art";
import { tileRoomOf } from "@/lib/pixel";
import { paintSpeech, speechPainter } from "@/lib/speech-render";
import { getTheme, readThemeChoice } from "@/lib/themes";

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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(src));
    img.src = src;
  });
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

export function PixelRoom({
  roomSlug,
  capacity,
  nearby,
  bubbles,
  className,
  onPickActor,
  highlightId,
}: {
  roomSlug: string;
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
    const tileSlug = tileRoomOf(roomSlug);
    const painter = speechPainter();
    const theme = getTheme(readThemeChoice());

    const start = async () => {
      let tile: HTMLImageElement;
      try {
        tile = await loadImage(tileSrc(tileSlug));
      } catch {
        tile = await loadImage(tileSrc("plaza"));
      }
      const chars = new Map<CharKey, HTMLImageElement>();
      await Promise.all(
        (Object.keys(CHAR_SRC) as CharKey[]).map(async (k) => {
          try {
            chars.set(k, await loadImage(CHAR_SRC[k]));
          } catch {
            /* keep missing */
          }
        }),
      );
      if (cancelled || !canvasRef.current) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);

      const draw = (t: number) => {
        if (cancelled) return;
        const el = canvasRef.current;
        if (!el) return;
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
        for (let y = 0; y < g.h; y += g.cell) {
          for (let x = 0; x < g.w; x += g.cell) ctx.drawImage(tile, x, y, g.cell, g.cell);
        }
        // The floor steps back so the bodies and what they say come forward:
        // at phone width, full-strength cobble was louder than anybody on it.
        ctx.fillStyle = "rgba(7,8,20,0.55)";
        ctx.fillRect(0, 0, g.w, g.h);

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
          const img = chars.get(key) ?? chars.get(n.kind === "human" ? "human-front" : "agent-front");
          const idleBob = activity === "idle" || activity === "chatting" || activity === "performing";
          const bob = idleBob ? Math.sin(t / 220 + seat * 0.85) * 3 : activity === "working" ? Math.sin(t / 160 + seat) * 1.5 : 0;
          const faceLeft = col >= g.cols / 2 && (activity === "listening" || activity === "reading");
          const size = SPRITE * scale;
          if (highlightRef.current === n.actor_id) {
            ctx.save();
            ctx.strokeStyle = "rgba(196,181,253,0.95)";
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.ellipse(cx, cy + size / 2 - 8 * scale, size / 2 - 10 * scale, 7 * scale, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
          if (img) {
            ctx.save();
            ctx.translate(cx, cy + bob);
            if (faceLeft) ctx.scale(-1, 1);
            ctx.drawImage(img, -size / 2, -size / 2, size, size);
            ctx.restore();
          } else {
            ctx.fillStyle = n.kind === "agent" ? "#7c3aed" : "#e8b86d";
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
          ctx.fillStyle = "rgba(7,8,20,0.7)";
          ctx.fillRect(cx - lw / 2 - 3, ny - 1, lw + 6, NAME_H);
          ctx.fillStyle = n.kind === "agent" ? "#c4b5fd" : "#f4d19a";
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

    void start();
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
        aria-label={`${roomSlug}: ${nearby.length} here${speaking ? `, ${speaking} speaking — the transcript has every line` : ""}`}
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
