"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReplayMarker } from "@grove/protocol";
import {
  MAX_WINDOW_MS,
  REPLAY_SPEEDS,
  previousVisit,
  replayClock,
  replayWindowLabel,
  type ReplayController,
  type ReplayView,
} from "@/lib/replay/controller";

/**
 * Replay mode's controls: a scrubber over the chosen window, play/pause,
 * speed, and the loud "REPLAY · 09:14" state.
 *
 * WHERE IT LIVES, AND WHY. On the map, not on a page of its own: the question
 * is "what happened HERE while I was away", and the answer is the same bodies
 * in the same rooms, moving. The entry point is the map's History drawer
 * (Watch ▾ → History, or H); while replay is on, this bar takes the bottom of the
 * screen and a pill takes the top, so the state cannot be missed from either
 * end — and the map's frame turns amber so a screenshot says it too.
 *
 * The scrubber draws the server's density histogram as soon as the first page
 * lands (so a long load still shows where the busy minutes were), then the
 * markers once every page is in: faults red, arrivals green, work spans blue,
 * speech amber. Markers are thinned to one per pixel column per kind so a busy
 * day is still legible.
 */

const MARKER_COLOUR: Record<ReplayMarker["kind"], string> = {
  fault: "#f87171",
  arrival: "#6ee7b7",
  span: "#7dd3fc",
  speech: "#fbbf24",
};
const MARKER_ROW: Record<ReplayMarker["kind"], number> = { span: 0, arrival: 1, speech: 2, fault: 3 };

function useReplayView(controller: ReplayController): ReplayView {
  return useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.view,
    () => controller.view,
  );
}

/** Top-of-screen state. Impossible to mistake for live. */
export function ReplayBadge({ controller }: { controller: ReplayController }) {
  const view = useReplayView(controller);
  if (!view.active) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 rounded-gh-pill border-2 border-pane bg-ink px-4 py-1.5 font-brand-mono text-gh-sm uppercase tracking-[0.12em] text-ground shadow-gh-3"
      >
        <span aria-hidden className="h-2 w-2 rounded-[1px] bg-pane" />
        <span className="tabular-nums">{view.label}</span>
        <span className="hidden text-[10px] tracking-[0.08em] text-ground/80 sm:inline">UTC · not live</span>
      </div>
    </div>
  );
}

export function ReplayBar({ controller }: { controller: ReplayController }) {
  const view = useReplayView(controller);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef(false);
  const [hover, setHover] = useState<{ x: number; label: string } | null>(null);
  const [lastVisit, setLastVisit] = useState<number | null>(null);

  useEffect(() => {
    if (view.active) setLastVisit(previousVisit());
  }, [view.active]);

  const tAt = useCallback(
    (clientX: number) => {
      const c = canvasRef.current;
      if (!c) return view.since;
      const r = c.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
      return view.since + p * (view.until - view.since);
    },
    [view.since, view.until],
  );

  // Draw the scrubber. Everything in it is a function of the view, so the same
  // window draws the same strip.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !view.active) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const span = Math.max(1, view.until - view.since);
    const xOf = (t: number) => ((t - view.since) / span) * w;
    const barsH = h - 18;

    // Density.
    const max = view.density.reduce((m, b) => Math.max(m, b.n), 0);
    const bw = Math.max(1, (view.bucketMs / span) * w - 1);
    ctx.fillStyle = "rgba(244,209,154,0.35)";
    for (const b of view.density) {
      const bh = max ? Math.max(2, (b.n / max) * (barsH - 4)) : 0;
      ctx.fillRect(xOf(b.at), barsH - bh, bw, bh);
    }
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(0, barsH, w, 1);

    // Markers, thinned per pixel column per kind.
    const taken = new Set<string>();
    for (const m of view.markers) {
      const x = Math.round(xOf(m.at));
      const key = `${m.kind}:${x}`;
      const row = MARKER_ROW[m.kind];
      const y = barsH + 2 + row * 4;
      ctx.fillStyle = MARKER_COLOUR[m.kind];
      if (m.kind === "span" && m.endAt !== null) {
        ctx.globalAlpha = 0.45;
        ctx.fillRect(x, y, Math.max(1, xOf(m.endAt) - x), 3);
        ctx.globalAlpha = 1;
        continue;
      }
      if (taken.has(key)) continue;
      taken.add(key);
      ctx.fillRect(x, y, 2, 3);
    }

    // Playhead.
    const px = xOf(view.playhead);
    ctx.fillStyle = "#fbbf24";
    ctx.fillRect(Math.round(px) - 1, 0, 2, h);
  }, [view.active, view.density, view.markers, view.playhead, view.since, view.until, view.bucketMs]);

  const onPointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.type === "pointerdown") {
        dragRef.current = true;
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
        controller.seek(tAt(e.clientX));
        return;
      }
      if (e.type === "pointerup" || e.type === "pointercancel") {
        dragRef.current = false;
        return;
      }
      if (dragRef.current) controller.seek(tAt(e.clientX));
      // Hover: the nearest marker within a few pixels names itself.
      const c = canvasRef.current;
      if (!c) return;
      const r = c.getBoundingClientRect();
      const span = Math.max(1, view.until - view.since);
      let best: ReplayMarker | null = null;
      let bestD = 6;
      for (const m of view.markers) {
        const d = Math.abs(((m.at - view.since) / span) * r.width - (e.clientX - r.left));
        if (d < bestD) {
          bestD = d;
          best = m;
        }
      }
      setHover(best ? { x: e.clientX - r.left, label: `${replayClock(best.at)} · ${best.label}` } : null);
    },
    [controller, tAt, view.markers, view.since, view.until],
  );

  if (!view.active) return null;

  const hourAgo = () => {
    const now = Date.now();
    void controller.open(now - 3600_000, now);
  };
  const dayAgo = () => {
    const now = Date.now();
    void controller.open(now - MAX_WINDOW_MS, now);
  };
  const sinceVisit = () => {
    const now = Date.now();
    if (lastVisit) void controller.open(Math.max(lastVisit, now - MAX_WINDOW_MS), now);
  };
  const visitUsable = lastVisit !== null && Date.now() - lastVisit > 60_000;
  const windowMs = view.until - view.since;

  return (
    <div className="pointer-events-auto w-full rounded-gh-lg border border-pane/70 gh-frost p-3 font-brand text-gh-xs text-ink shadow-gh-2 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => (view.playing ? controller.pause() : controller.play())}
          disabled={view.loading}
          aria-label={view.playing ? "Pause replay" : "Play replay"}
          className="h-11 w-11 shrink-0 rounded-gh-pill border border-ink bg-ink text-base font-bold text-ground disabled:opacity-40 sm:h-9 sm:w-9"
        >
          {view.playing ? "❚❚" : "▶"}
        </button>
        <div className="flex overflow-hidden rounded-full border border-line-strong" role="group" aria-label="Playback speed">
          {REPLAY_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => controller.setSpeed(s)}
              aria-pressed={view.speed === s}
              className={`px-3 py-2 tabular-nums sm:py-1 ${view.speed === s ? "bg-ink text-ground" : "text-muted hover:bg-tint"}`}
            >
              {s}×
            </button>
          ))}
        </div>
        <span className="font-brand-mono tabular-nums text-ink">{replayClock(view.playhead)}</span>
        <span className="text-muted">
          {replayWindowLabel(view.since, view.until)} UTC
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={hourAgo}
            aria-pressed={Math.abs(windowMs - 3600_000) < 1000}
            className="rounded-gh-pill border border-line-strong bg-surface-raised px-3 py-2 hover:bg-tint sm:py-1"
          >
            Last hour
          </button>
          <button
            type="button"
            onClick={dayAgo}
            aria-pressed={Math.abs(windowMs - MAX_WINDOW_MS) < 1000}
            className="rounded-gh-pill border border-line-strong bg-surface-raised px-3 py-2 hover:bg-tint sm:py-1"
          >
            Last day
          </button>
          <button
            type="button"
            onClick={sinceVisit}
            disabled={!visitUsable}
            title={visitUsable ? `Since ${replayClock(lastVisit!)} UTC` : "No earlier visit remembered in this browser"}
            className="rounded-gh-pill border border-line-strong bg-surface-raised px-3 py-2 hover:bg-tint disabled:opacity-40 sm:py-1"
          >
            Since my last visit
          </button>
          <button
            type="button"
            onClick={() => controller.close()}
            className="rounded-gh-pill border border-signal bg-signal px-4 py-2 font-semibold text-signal-ink hover:brightness-[1.06] sm:py-1"
          >
            Back to live
          </button>
        </div>
      </div>
      <div className="relative mt-3">
        <canvas
          ref={canvasRef}
          className="block h-12 w-full cursor-pointer touch-none"
          aria-label="Replay timeline: drag to scrub"
          onPointerDown={onPointer}
          onPointerMove={onPointer}
          onPointerUp={onPointer}
          onPointerCancel={onPointer}
          onPointerLeave={() => setHover(null)}
        />
        {hover ? (
          <div
            className="pointer-events-none absolute bottom-full mb-1 max-w-[80%] -translate-x-1/2 truncate rounded-gh-sm bg-ink px-2 py-1 text-[11px] text-ground"
            style={{ left: Math.max(60, hover.x) }}
          >
            {hover.label}
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: MARKER_COLOUR.fault }} />faults</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: MARKER_COLOUR.arrival }} />arrivals</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: MARKER_COLOUR.span }} />work spans</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: MARKER_COLOUR.speech }} />speech</span>
        <span className="ml-auto">
          {view.error
            ? `Replay failed: ${view.error}`
            : view.loading
              ? `loading ${view.loaded.toLocaleString()} events…${view.provisional ? " · jumped ahead from a checkpoint" : ""}`
              : `${view.loaded.toLocaleString()} events you may see${view.truncated ? " (window truncated)" : ""}${
                  view.signedIn ? "" : " · signed out: movement only"
                }`}
        </span>
      </div>
    </div>
  );
}
