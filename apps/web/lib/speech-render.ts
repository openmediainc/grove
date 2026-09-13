/**
 * Speech on a canvas: the glue between @grove/ui's layout engine and a
 * theme's speech()/speechPip() slots, shared by the world map and PixelRoom.
 *
 * `paintSpeech()` is one frame: measure (cached), lay out, paint through the
 * theme. It keeps the slot memory and tier between frames so bubbles do not
 * jitter and the tier does not strobe at a threshold. Who said what lives in
 * `SpeechBook` (@grove/ui).
 */

import {
  DEFAULT_SPEECH_METRICS,
  layoutSpeech,
  speechTier,
  type Rect,
  type Speaker,
  type SpeechFont,
  type SpeechLayout,
  type SpeechMetrics,
  type SpeechTier,
} from "@grove/ui";
import type { Theme } from "@/lib/themes";

export { SpeechBook, SPEECH_KEEP_CHARS } from "@grove/ui";

const FAMILY = "ui-sans-serif, system-ui, sans-serif";

/** Per-canvas state carried between frames. */
export type SpeechPainter = {
  tier: SpeechTier | undefined;
  slots: Map<string, number>;
  widths: Map<string, number>;
  last: SpeechLayout | null;
};

export function speechPainter(): SpeechPainter {
  return { tier: undefined, slots: new Map(), widths: new Map(), last: null };
}

/**
 * Lay out and paint one frame of speech. The caller must already have set a
 * SCREEN-space transform (CSS px). Obstacles are SCREEN rects.
 *
 * `zoom` picks the tier; pass `tier` to force one (PixelRoom is always near).
 */
export function paintSpeech(
  ctx: CanvasRenderingContext2D,
  painter: SpeechPainter,
  theme: Theme,
  input: {
    speakers: readonly Speaker[];
    viewport: { w: number; h: number };
    obstacles?: readonly Rect[];
    zoom?: number;
    tier?: SpeechTier;
    t: number;
    metrics?: SpeechMetrics;
  },
): SpeechLayout {
  const m = input.metrics ?? DEFAULT_SPEECH_METRICS;
  const tier = input.tier ?? speechTier(input.zoom ?? 1, painter.tier);
  painter.tier = tier;
  // measureText is the expensive half of a bubble and the same few lines are
  // measured every frame; cache by font and text, bounded.
  if (painter.widths.size > 4000) painter.widths.clear();
  const family = theme.art.speechFont ?? FAMILY;
  const measure = (text: string, font: SpeechFont) => {
    const key = family + "|" + font + "|" + text;
    let w = painter.widths.get(key);
    if (w === undefined) {
      ctx.font = `${m.fontPx[font]}px ${family}`;
      w = ctx.measureText(text).width;
      painter.widths.set(key, w);
    }
    return w;
  };
  const out = layoutSpeech({
    tier,
    speakers: input.speakers,
    viewport: input.viewport,
    obstacles: input.obstacles,
    measure,
    previous: painter.slots,
    metrics: m,
  });
  painter.slots = out.slots;
  painter.last = out;
  const art = theme.art;
  for (const p of out.pips) art.speechPip(ctx, p.x, p.y, p.whisper, input.t);
  for (const b of out.bubbles) {
    art.speech(
      ctx,
      {
        x0: b.x0,
        y0: b.y0,
        x1: b.x1,
        y1: b.y1,
        ax: b.ax,
        ay: b.ay,
        lines: b.lines,
        fontPx: m.fontPx[b.font],
        lineH: m.lineH[b.font],
        padX: m.padX,
        padY: m.padY,
        whisper: b.whisper,
        leader: b.leader,
        overflow: b.overflow,
      },
      input.t,
    );
  }
  return out;
}

/** A screen-space square around a point, for fixed-size marks as obstacles. */
export function markRect(sx: number, sy: number, half: number): Rect {
  return { x0: sx - half, y0: sy - half, x1: sx + half, y1: sy + half };
}
