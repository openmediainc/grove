"use client";

import { useEffect, useRef } from "react";
import type { Nearby } from "@/lib/api";
import { tileRoomOf } from "@/lib/pixel";

const SPRITE = 64;
const CHAR_SRC = {
  "human-front": "/art/chars/human-front.png",
  "human-side": "/art/chars/human-side.png",
  "human-speak": "/art/chars/human-speak.png",
  "agent-front": "/art/chars/agent-front.png",
  "agent-side": "/art/chars/agent-side.png",
  "agent-work": "/art/chars/agent-work.png",
} as const;

type CharKey = keyof typeof CHAR_SRC;

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

export function PixelRoom({
  roomSlug,
  capacity,
  nearby,
  bubbles,
  className,
}: {
  roomSlug: string;
  capacity: number;
  nearby: Nearby[];
  bubbles?: Array<{ sender_id: string; body: string }>;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nearbyRef = useRef(nearby);
  const bubblesRef = useRef(bubbles);
  nearbyRef.current = nearby;
  bubblesRef.current = bubbles;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let cancelled = false;
    const tileSlug = tileRoomOf(roomSlug);

    const start = async () => {
      const tileSrc = `/art/tiles/${tileSlug}.png`;
      let tile: HTMLImageElement;
      try {
        tile = await loadImage(tileSrc);
      } catch {
        tile = await loadImage("/art/tiles/plaza.png");
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
      ctx.imageSmoothingEnabled = false;

      const cap = Math.max(1, capacity || 30);
      const cols = Math.ceil(Math.sqrt(cap));
      const rows = Math.ceil(cap / cols);
      const cssW = cols * SPRITE;
      const cssH = rows * SPRITE;
      const dpr = Math.min(2, window.devicePixelRatio || 1);

      const draw = (t: number) => {
        if (cancelled) return;
        const el = canvasRef.current;
        if (!el) return;
        if (el.width !== Math.floor(cssW * dpr) || el.height !== Math.floor(cssH * dpr)) {
          el.width = Math.floor(cssW * dpr);
          el.height = Math.floor(cssH * dpr);
          el.style.width = `${cssW}px`;
          el.style.height = `${cssH}px`;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.imageSmoothingEnabled = false;
        }
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            ctx.drawImage(tile, x * SPRITE, y * SPRITE, SPRITE, SPRITE);
          }
        }
        const actors = nearbyRef.current ?? [];
        const speech = bubblesRef.current ?? [];
        for (const n of actors) {
          const seat = n.presence?.seat_index ?? 0;
          const col = seat % cols;
          const row = Math.floor(seat / cols);
          const cx = col * SPRITE + SPRITE / 2;
          const cy = row * SPRITE + SPRITE / 2;
          const activity = n.presence?.activity ?? "idle";
          const key = spriteKey(n.kind, activity);
          const img = chars.get(key) ?? chars.get(n.kind === "human" ? "human-front" : "agent-front");
          const idleBob = activity === "idle" || activity === "chatting" || activity === "performing";
          const bob = idleBob ? Math.sin(t / 220 + seat * 0.85) * 3 : activity === "working" ? Math.sin(t / 160 + seat) * 1.5 : 0;
          const faceLeft = col >= cols / 2 && (activity === "listening" || activity === "reading");
          if (img) {
            ctx.save();
            ctx.translate(cx, cy + bob);
            // Side sprites face the viewer's right; flip for left.
            if (faceLeft) ctx.scale(-1, 1);
            ctx.drawImage(img, -SPRITE / 2, -SPRITE / 2, SPRITE, SPRITE);
            ctx.restore();
          } else {
            ctx.fillStyle = n.kind === "agent" ? "#7c3aed" : "#e8b86d";
            ctx.fillRect(cx - 10, cy - 10 + bob, 20, 20);
          }
          const line = speech.find((s) => s.sender_id === n.actor_id);
          if (line?.body) {
            const text = line.body.slice(0, 42);
            ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
            const w = Math.min(140, ctx.measureText(text).width + 10);
            const bx = cx - w / 2;
            const by = cy - SPRITE / 2 - 16 + bob;
            ctx.fillStyle = "rgba(7,8,20,0.88)";
            ctx.strokeStyle = "rgba(232,184,109,0.45)";
            ctx.beginPath();
            ctx.roundRect(bx, by, w, 16, 4);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#f4d19a";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(text, cx, by + 8, w - 8);
            ctx.textAlign = "left";
          }
        }
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

  return (
    <canvas
      ref={canvasRef}
      className={className ?? "mx-auto max-w-full rounded-xl border border-lantern-400/20 bg-dusk-950"}
      style={{ imageRendering: "pixelated" }}
      aria-label={`${roomSlug} pixel room`}
    />
  );
}
