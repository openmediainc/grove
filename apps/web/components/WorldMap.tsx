"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { CHAR_SRC, type CharKey, tileSrc } from "@/lib/art";
import { gp } from "@/lib/base";
import {
  groveVerb,
  isActiveVerb,
  paperclipVerb,
  regionForVerb,
  VERB_LABEL,
  VERB_RING,
  type AgentVerb,
} from "@/lib/agent-verbs";
import {
  MAP_COLS,
  MAP_ROWS,
  exploreRadius,
  regionAt,
  seatInRegion,
  tileExplored,
  type MapRegion,
} from "@/lib/map-layout";

const TW = 64;
const TH = 32;
const FOG_KEY = "grove-fog-radius";

type GroveBody = {
  id: string;
  kind: "human" | "agent";
  display_name?: string;
  displayName?: string;
  slug: string;
  room_slug?: string;
  roomSlug?: string;
  activity: string;
  connection: string;
  source: "grove";
};

type PaperclipBody = {
  id: string;
  name: string;
  status: string;
  role: string;
  title: string | null;
  adapter_type?: string;
  adapterType?: string;
  last_heartbeat_at?: string | null;
  lastHeartbeatAt?: string | null;
};

type PaperclipIssue = {
  identifier: string;
  status: string;
  assignee_agent_id?: string | null;
  assigneeAgentId?: string | null;
  execution_state?: string | null;
  executionState?: string | null;
  title: string;
};

type Minimap = {
  bodies?: GroveBody[];
  claimed_agents?: number;
  claimedAgents?: number;
  paperclip?: { ok: boolean; agents: PaperclipBody[]; issues?: PaperclipIssue[] };
};

type Actor = {
  id: string;
  name: string;
  kind: "human" | "agent" | "paperclip";
  region: MapRegion;
  activity: string;
  verb: AgentVerb;
  source: "grove" | "paperclip";
  bubble?: string;
  detail?: string;
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(src));
    img.src = src;
  });
}

function spriteKey(kind: Actor["kind"], verb: AgentVerb): CharKey {
  if (kind === "human") {
    if (verb === "say") return "human-speak";
    if (verb === "read" || verb === "wait" || verb === "think") return "human-side";
    return "human-front";
  }
  if (verb === "tool" || verb === "error") return "agent-work";
  if (verb === "read" || verb === "wait" || verb === "think") return "agent-side";
  return "agent-front";
}

function iso(tx: number, ty: number): { x: number; y: number } {
  return { x: (tx - ty) * (TW / 2), y: (tx + ty) * (TH / 2) };
}

function readMaxFog(): number {
  try {
    const n = Number(window.localStorage.getItem(FOG_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeMaxFog(n: number): void {
  try {
    window.localStorage.setItem(FOG_KEY, String(n));
  } catch {
    /* ignore */
  }
}

function drawGlyph(ctx: CanvasRenderingContext2D, verb: AgentVerb, x: number, y: number, t: number) {
  ctx.save();
  ctx.translate(x + 16, y - 18);
  ctx.fillStyle = VERB_RING[verb];
  ctx.strokeStyle = VERB_RING[verb];
  ctx.lineWidth = 1.5;
  if (verb === "tool") {
    for (let i = 0; i < 4; i++) {
      const a = t / 140 + (i * Math.PI) / 2;
      ctx.fillRect(Math.cos(a) * 7 - 1.5, Math.sin(a) * 7 - 1.5, 3, 3);
    }
  } else if (verb === "think") {
    ctx.beginPath();
    ctx.arc(0, 0, 5 + Math.sin(t / 200) * 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillRect(-1, -8, 2, 2);
    ctx.fillRect(4, -6, 2, 2);
  } else if (verb === "wait") {
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("?", 0, 4);
  } else if (verb === "error") {
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("!", 0, 4);
  } else if (verb === "blocked") {
    ctx.fillRect(-4, -4, 8, 8);
  } else if (verb === "read") {
    ctx.strokeRect(-6, -4, 12, 8);
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(0, 4);
    ctx.stroke();
  } else if (verb === "say") {
    ctx.beginPath();
    ctx.ellipse(0, 0, 7, 5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function WorldMap() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const actorsRef = useRef<Actor[]>([]);
  const radiusRef = useRef(4);
  const hoverRef = useRef<Actor | null>(null);
  const [hud, setHud] = useState({ grove: 0, paperclip: 0, claimed: 0, paperclipOk: false, radius: 4, awake: 0, asleep: 0 });
  const [status, setStatus] = useState("charting the dusk…");

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const data = await api<Minimap>("/api/v1/world/minimap");
        if (cancelled) return;
        const grove = (data.bodies ?? []).map((b) => {
          const room = (b.room_slug ?? b.roomSlug ?? "plaza") as MapRegion;
          const region =
            room === "plaza" || room === "library" || room === "workshop" || room === "stage" || room === "garden" || room === "board"
              ? room
              : "plaza";
          const verb = groveVerb(b.activity, b.connection);
          return {
            id: b.id,
            name: b.display_name ?? b.displayName ?? b.slug,
            kind: b.kind,
            region,
            activity: b.activity || "idle",
            verb,
            source: "grove" as const,
            detail: VERB_LABEL[verb],
          };
        });
        const issues = data.paperclip?.issues ?? [];
        const pcAgents = data.paperclip?.agents ?? [];
        const paperclip = pcAgents.map((a) => {
          const mine = issues.find((i) => (i.assignee_agent_id ?? i.assigneeAgentId) === a.id);
          const hb = a.last_heartbeat_at ?? a.lastHeartbeatAt;
          const verb = paperclipVerb({
            status: a.status,
            lastHeartbeatAt: hb,
            issueStatus: mine?.status,
            executionState: mine?.execution_state ?? mine?.executionState,
          });
          const region = regionForVerb(verb, a.role) as MapRegion;
          return {
            id: `pc:${a.id}`,
            name: a.name,
            kind: "paperclip" as const,
            region,
            activity: verb,
            verb,
            source: "paperclip" as const,
            detail: mine ? `${VERB_LABEL[verb]} · ${mine.identifier}` : VERB_LABEL[verb],
          };
        });
        const actors = [...grove, ...paperclip];
        actorsRef.current = actors;
        const claimed = data.claimed_agents ?? data.claimedAgents ?? 0;
        const awake = actors.filter((a) => isActiveVerb(a.verb)).length;
        const asleep = actors.length - awake;
        const next = Math.max(readMaxFog(), exploreRadius(claimed, awake));
        writeMaxFog(next);
        radiusRef.current = next;
        setHud({
          grove: grove.length,
          paperclip: paperclip.length,
          claimed,
          paperclipOk: Boolean(data.paperclip?.ok),
          radius: next,
          awake,
          asleep,
        });
        setStatus(data.paperclip?.ok ? "live campus + paperclip" : "live campus · paperclip quiet");
      } catch {
        if (!cancelled) setStatus("map stream paused");
      }
    };
    void pull();
    const t = window.setInterval(() => void pull(), 8000);
    const es = new EventSource(gp("/api/v1/sse/plaza"));
    es.addEventListener("speech", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { sender_id?: string; body?: string };
      if (!data.sender_id || !data.body) return;
      actorsRef.current = actorsRef.current.map((a) =>
        a.id === data.sender_id ? { ...a, bubble: data.body!.slice(0, 48), verb: "say" } : a,
      );
      window.setTimeout(() => {
        actorsRef.current = actorsRef.current.map((a) => (a.id === data.sender_id ? { ...a, bubble: undefined } : a));
      }, 8000);
    });
    return () => {
      cancelled = true;
      window.clearInterval(t);
      es.close();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let cancelled = false;

    const start = async () => {
      const tiles = new Map<string, HTMLImageElement>();
      for (const slug of ["plaza", "library", "workshop", "stage", "garden", "board"]) {
        try {
          tiles.set(slug, await loadImage(tileSrc(slug)));
        } catch {
          /* missing tile */
        }
      }
      if (!tiles.get("plaza")) return;
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

      const origin = () => {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const last = iso(MAP_COLS - 1, MAP_ROWS - 1);
        const first = iso(0, MAP_ROWS - 1);
        const mapW = iso(MAP_COLS - 1, 0).x - first.x + TW;
        const mapH = last.y + TH;
        return { ox: (w - mapW) / 2 - first.x, oy: Math.max(24, (h - mapH) / 2), w, h };
      };

      const tileFromEvent = (ev: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        const { ox, oy } = origin();
        const mx = ev.clientX - rect.left - ox;
        const my = ev.clientY - rect.top - oy;
        const tx = Math.round((mx / (TW / 2) + my / (TH / 2)) / 2);
        const ty = Math.round((my / (TH / 2) - mx / (TW / 2)) / 2);
        return { tx, ty };
      };

      canvas.onclick = (ev) => {
        const { tx, ty } = tileFromEvent(ev);
        const region = regionAt(tx, ty);
        if (region !== "wild" && tileExplored(tx, ty, radiusRef.current)) {
          router.push(`/w/${region}`);
        }
      };
      canvas.onmousemove = (ev) => {
        const { tx, ty } = tileFromEvent(ev);
        const actors = actorsRef.current;
        hoverRef.current =
          actors.find((a) => {
            const seat = seatInRegion(a.id, a.region);
            return seat.x === tx && seat.y === ty;
          }) ?? null;
        canvas.style.cursor = regionAt(tx, ty) !== "wild" ? "pointer" : "default";
      };

      const draw = (t: number) => {
        if (cancelled) return;
        const el = canvasRef.current;
        if (!el) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const cssW = el.clientWidth;
        const cssH = el.clientHeight;
        if (el.width !== Math.floor(cssW * dpr) || el.height !== Math.floor(cssH * dpr)) {
          el.width = Math.floor(cssW * dpr);
          el.height = Math.floor(cssH * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, cssW, cssH);
        const { ox, oy } = origin();
        const radius = radiusRef.current;
        const fallback = tiles.get("plaza")!;

        for (let ty = 0; ty < MAP_ROWS; ty++) {
          for (let tx = 0; tx < MAP_COLS; tx++) {
            const region = regionAt(tx, ty);
            const tile = tiles.get(region === "wild" ? "garden" : region) ?? fallback;
            const p = iso(tx, ty);
            const x = ox + p.x;
            const y = oy + p.y;
            const explored = tileExplored(tx, ty, radius);
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + TW / 2, y + TH / 2);
            ctx.lineTo(x, y + TH);
            ctx.lineTo(x - TW / 2, y + TH / 2);
            ctx.closePath();
            ctx.clip();
            ctx.globalAlpha = explored ? 1 : 0.18;
            ctx.drawImage(tile, x - TW / 2, y, TW, TH);
            if (!explored) {
              ctx.fillStyle = "rgba(4,6,16,0.72)";
              ctx.fill();
            }
            ctx.restore();
            if (explored && (tx + ty) % 7 === 0) {
              ctx.beginPath();
              ctx.moveTo(x, y);
              ctx.lineTo(x + TW / 2, y + TH / 2);
              ctx.lineTo(x, y + TH);
              ctx.lineTo(x - TW / 2, y + TH / 2);
              ctx.closePath();
              ctx.strokeStyle = "rgba(232,184,109,0.12)";
              ctx.stroke();
            }
          }
        }

        const actors = actorsRef.current;
        for (const a of actors) {
          const seat = seatInRegion(a.id, a.region);
          if (!tileExplored(seat.x, seat.y, radius)) continue;
          const p = iso(seat.x, seat.y);
          const active = isActiveVerb(a.verb);
          const walk = active ? Math.sin(t / 160 + seat.x) * 5 : 0;
          const bob = Math.sin(t / (active ? 160 : 400) + seat.y) * (active ? 2.5 : a.verb === "offline" ? 0 : 1.2);
          const x = ox + p.x + walk;
          const y = oy + p.y - 18 + bob;
          ctx.save();
          ctx.globalAlpha = a.verb === "offline" ? 0.4 : a.verb === "idle" ? 0.72 : 1;
          ctx.beginPath();
          ctx.ellipse(x, y + 18, active ? 14 : 10, 5, 0, 0, Math.PI * 2);
          ctx.strokeStyle = VERB_RING[a.verb];
          ctx.lineWidth = active ? 2 : 1;
          ctx.stroke();
          const key = spriteKey(a.kind === "paperclip" ? "agent" : a.kind, a.verb);
          const img = chars.get(key) ?? chars.get("agent-front");
          if (img) ctx.drawImage(img, x - 20, y - 20, 40, 40);
          else {
            ctx.fillStyle = a.kind === "human" ? "#e8b86d" : "#7c3aed";
            ctx.fillRect(x - 6, y - 6, 12, 12);
          }
          drawGlyph(ctx, a.verb, x, y, t);
          ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = a.source === "paperclip" ? "#c4b5fd" : "#f4d19a";
          ctx.fillText(a.name.slice(0, 18), x, y + 28);
          ctx.fillStyle = VERB_RING[a.verb];
          ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
          ctx.fillText(a.detail ?? VERB_LABEL[a.verb], x, y + 40);
          ctx.restore();
          if (a.bubble) {
            const text = a.bubble;
            ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
            ctx.textAlign = "center";
            const w = Math.min(160, ctx.measureText(text).width + 12);
            ctx.fillStyle = "rgba(7,8,20,0.9)";
            ctx.beginPath();
            ctx.roundRect(x - w / 2, y - 36, w, 16, 4);
            ctx.fill();
            ctx.fillStyle = "#f4d19a";
            ctx.fillText(text, x, y - 24, w - 8);
          }
        }

        const hover = hoverRef.current;
        if (hover) {
          ctx.fillStyle = "rgba(7,8,20,0.92)";
          ctx.fillRect(12, cssH - 40, 360, 28);
          ctx.fillStyle = "#f4d19a";
          ctx.textAlign = "left";
          ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
          ctx.fillText(`${hover.name} · ${hover.detail ?? hover.verb} · ${hover.region}`, 20, cssH - 22);
        }
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    };

    void start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      canvas.onclick = null;
      canvas.onmousemove = null;
    };
  }, [router]);

  return (
    <section className="relative min-h-[calc(100vh-56px)] overflow-hidden bg-dusk-950">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ imageRendering: "pixelated" }} aria-label="Grove world map" />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-lantern-400/80">Aetheria · Grove</p>
          <h1 className="font-display mt-1 text-4xl text-lantern-300 md:text-5xl">The campus grows as they do.</h1>
          <p className="mt-2 max-w-xl text-sm text-white/70">
            Idle bodies sit. Awake ones think, tool, wait, or speak — Grove Plaza plus Paperclip on this Mini.
          </p>
        </div>
        <div className="pointer-events-auto rounded-2xl border border-lantern-400/20 bg-dusk-950/80 px-4 py-3 text-xs uppercase tracking-widest text-lantern-300/80">
          <div>{status}</div>
          <div className="mt-1 text-white/60">
            {hud.awake} awake · {hud.asleep} asleep · fog {hud.radius}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] normal-case tracking-normal text-white/50">
            <span>tool</span>
            <span>think</span>
            <span>speak</span>
            <span>wait</span>
            <span>blocked</span>
            <span>fault</span>
            <span>asleep</span>
          </div>
        </div>
      </div>
      <div className="pointer-events-auto absolute bottom-6 left-6 flex gap-3">
        <a href={gp("/login")} className="rounded-full bg-lantern-400 px-5 py-2 font-semibold text-dusk-950">
          Enter as yourself
        </a>
        <a href={gp("/docs")} className="rounded-full border border-white/15 px-5 py-2 text-white/80">
          curl /skill.md
        </a>
      </div>
    </section>
  );
}
