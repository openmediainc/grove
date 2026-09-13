/**
 * Speech layout: where the lines people just said go on a crowded canvas.
 *
 * Before this, every body painted its own bubble at a fixed offset above its
 * head and nothing looked at anyone else's. Two bodies a tile apart said two
 * things on top of each other, and a third was simply gone. At minimum zoom a
 * bubble was a smear eight pixels wide.
 *
 * This module is the whole decision — which lines get a bubble, how much of
 * each line, where each bubble sits, which ones collapse to a pip, and how many
 * were squeezed out near a bubble that did fit — and none of the drawing. It is
 * pure and SCREEN-space: the caller converts anchors and obstacles out of
 * whatever camera it has, supplies a text measurer, and paints the result
 * however its theme paints a bubble. Nothing here knows what a canvas is.
 *
 * Four rules, in order:
 *
 *   1. Salience. A bubble never covers an obstacle. The caller passes hazard
 *      marks, heartbeat rings and nameplates as obstacles, so a fault outranks
 *      speech at every tier: speech moves out of its way, never the reverse.
 *   2. Relevance. When there is not room for everybody, the expanded line (the
 *      one being hovered, tapped or focused) goes first, then the newest.
 *   3. Stability. A bubble keeps the slot it had last frame while that slot is
 *      still free, and only moves back toward its home slot when home is free
 *      by a clear margin. Bodies bob; bubbles must not jitter with them.
 *   4. Nothing vanishes silently. A line that cannot be placed becomes a pip on
 *      its speaker (hover or tap to read it) and is counted into the "+N" of the
 *      nearest bubble that did fit.
 */

export type SpeechTier = "far" | "mid" | "near";

/**
 * Zoom thresholds between tiers. `mid` matches the nameplate level-of-detail
 * gate on the world map (LOD_LABELS): below it a body has no name either, and a
 * sentence floating over a nameless dot is noise.
 */
export const SPEECH_TIER_ZOOM = { mid: 0.7, near: 1.25 } as const;

/** How far past a threshold the zoom must go before the tier flips back. */
const TIER_HYSTERESIS = 0.04;

/**
 * The tier for a zoom, with hysteresis: pinching back and forth across a
 * threshold must not strobe every bubble between a pip and a sentence.
 */
export function speechTier(zoom: number, prev?: SpeechTier): SpeechTier {
  const h = TIER_HYSTERESIS;
  const { mid, near } = SPEECH_TIER_ZOOM;
  if (prev === "near") return zoom >= near - h ? "near" : zoom >= mid - h ? "mid" : "far";
  if (prev === "mid") return zoom >= near + h ? "near" : zoom >= mid - h ? "mid" : "far";
  if (prev === "far") return zoom >= near + h ? "near" : zoom >= mid + h ? "mid" : "far";
  return zoom >= near ? "near" : zoom >= mid ? "mid" : "far";
}

export type Rect = { x0: number; y0: number; x1: number; y1: number };

export type Speaker = {
  id: string;
  /** SCREEN point the bubble points at: the top of the speaker's head. */
  ax: number;
  ay: number;
  text: string;
  /** When it was said, ms. Newer wins when space runs out. */
  at: number;
  /** A whisper: drawn distinctly by the caller. Placement is the same. */
  whisper?: boolean;
  /** Hovered, tapped or focused: laid out first, and at full size at any tier. */
  expanded?: boolean;
};

/** Text roles the caller's measurer must understand. */
export type SpeechFont = "mid" | "near";

export type SpeechMetrics = {
  /** Font size in CSS px, per role, for the caller's canvas font string. */
  fontPx: Record<SpeechFont, number>;
  lineH: Record<SpeechFont, number>;
  maxW: Record<SpeechFont, number>;
  maxLines: Record<SpeechFont, number>;
  padX: number;
  padY: number;
  /** Gap between the bubble's bottom edge and the anchor, room for a tail. */
  tail: number;
  /** Space kept between two bubbles. */
  gap: number;
  /** Bubbles on screen at once, per tier. */
  budget: Record<"mid" | "near", number>;
  /** An unplaced line is counted into a bubble whose anchor is this close. */
  overflowRadius: number;
};

export const DEFAULT_SPEECH_METRICS: SpeechMetrics = {
  fontPx: { mid: 10, near: 11 },
  lineH: { mid: 13, near: 14 },
  maxW: { mid: 150, near: 190 },
  maxLines: { mid: 1, near: 3 },
  padX: 6,
  padY: 3,
  tail: 7,
  gap: 3,
  budget: { mid: 10, near: 14 },
  overflowRadius: 110,
};

export type LayoutInput = {
  tier: SpeechTier;
  speakers: readonly Speaker[];
  viewport: { w: number; h: number };
  /** Hazards, heartbeat marks, nameplates: things speech must not cover. */
  obstacles?: readonly Rect[];
  /** Width in CSS px of `text` in the given role's font. */
  measure: (text: string, font: SpeechFont) => number;
  /** Slot each speaker held last frame, from the previous result's `slots`. */
  previous?: ReadonlyMap<string, number>;
  metrics?: SpeechMetrics;
};

export type PlacedBubble = Rect & {
  id: string;
  font: SpeechFont;
  lines: string[];
  whisper: boolean;
  /** Candidate slot index; 0 is directly above the head. */
  slot: number;
  /** The anchor this bubble belongs to. */
  ax: number;
  ay: number;
  /** Too far from the head for a tail to reach: draw a leader line. */
  leader: boolean;
  /** Lines squeezed out nearby and folded into this one's "+N". */
  overflow: number;
};

export type Pip = { id: string; x: number; y: number; whisper: boolean };

export type SpeechLayout = {
  bubbles: PlacedBubble[];
  /** Speakers without a bubble this frame. Always drawn: nothing is dropped. */
  pips: Pip[];
  /** Feed back in as `previous` next frame. */
  slots: Map<string, number>;
};

/**
 * Candidate offsets, as fractions of the bubble's own width (dx) and of its
 * height plus gap (dy, negative is up). Near slots first; the tail can still
 * reach the head from 0–2. Stacking up comes before swinging to the sides,
 * because a column of bubbles over a crowd still reads top-down as a
 * conversation and a sideways one crosses other bodies' heads.
 */
const SLOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-0.45, 0],
  [0.45, 0],
  [0, -1],
  [-0.55, -1],
  [0.55, -1],
  [0, -2],
  [-0.7, -2],
  [0.7, -2],
  [-1.1, 0.9],
  [1.1, 0.9],
  [0, -3],
];

/** Slots whose box still sits over the head, so a tail rather than a leader. */
const TAIL_SLOTS = 3;
/** Padding for a fresh placement. */
const PAD = 2;
/** Moving back toward home needs the home slot free by this clear margin. */
const RETURN_PAD = 8;
/** Staying put tolerates this much overlap, so a bob cannot evict a bubble. */
const STAY_SHRINK = 3;

const PIP_DX = -13;
const PIP_DY = 4;

export function pipFor(s: Pick<Speaker, "id" | "ax" | "ay" | "whisper">): Pip {
  return { id: s.id, x: s.ax + PIP_DX, y: s.ay + PIP_DY, whisper: Boolean(s.whisper) };
}

/** Newest first; expanded before everything; id breaks ties so order is stable. */
export function byRelevance(p: Speaker, q: Speaker): number {
  if (Boolean(p.expanded) !== Boolean(q.expanded)) return p.expanded ? -1 : 1;
  if (p.at !== q.at) return q.at - p.at;
  return p.id < q.id ? -1 : p.id > q.id ? 1 : 0;
}

const ELLIPSIS = "…";

/**
 * Break `text` into at most `maxLines` lines no wider than `maxW`, ellipsising
 * the last. Words longer than a line are cut by character. Whitespace runs
 * collapse, so a line with a newline in it cannot grow the bubble.
 */
export function fitLines(
  text: string,
  maxW: number,
  maxLines: number,
  measure: (s: string) => number,
): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length || maxLines < 1) return [];
  const lines: string[] = [];
  let cur = "";
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    const next = cur ? `${cur} ${word}` : word;
    if (measure(next) <= maxW) {
      cur = next;
      i++;
      continue;
    }
    if (!cur) {
      // One word wider than the line: cut it by character.
      let cut = word.length - 1;
      while (cut > 1 && measure(word.slice(0, cut)) > maxW) cut--;
      lines.push(word.slice(0, cut));
      words[i] = word.slice(cut);
    } else {
      lines.push(cur);
      cur = "";
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) {
    lines.push(cur);
    cur = "";
    i = words.length;
  }
  const truncated = i < words.length || cur !== "";
  if (truncated && lines.length) {
    let last = lines[lines.length - 1]!;
    while (last.length > 0 && measure(last + ELLIPSIS) > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = last.trimEnd() + ELLIPSIS;
  }
  return lines;
}

function overlaps(a: Rect, b: Rect, pad: number): boolean {
  return a.x0 - pad < b.x1 && a.x1 + pad > b.x0 && a.y0 - pad < b.y1 && a.y1 + pad > b.y0;
}

function inside(r: Rect, w: number, h: number): boolean {
  return r.x0 >= 0 && r.y0 >= 0 && r.x1 <= w && r.y1 <= h;
}

/**
 * The box for slot `k`, pulled inside the viewport when it can be. A bubble
 * over a body at the screen edge slides along the edge rather than vanishing
 * off it; `moved` says how far that slide took it from where the slot wanted.
 */
function boxAt(
  k: number,
  s: Speaker,
  bw: number,
  bh: number,
  vw: number,
  vh: number,
  m: SpeechMetrics,
): { r: Rect; moved: number } {
  const [fx, fy] = SLOTS[k]!;
  const cx = s.ax + fx * bw;
  const y1 = s.ay - m.tail + fy * (bh + m.gap);
  let x0 = cx - bw / 2;
  let y0 = y1 - bh;
  const wantX = x0;
  const wantY = y0;
  if (bw <= vw) x0 = Math.min(Math.max(x0, 0), vw - bw);
  if (bh <= vh) y0 = Math.min(Math.max(y0, 0), vh - bh);
  return { r: { x0, y0, x1: x0 + bw, y1: y0 + bh }, moved: Math.abs(x0 - wantX) + Math.abs(y0 - wantY) };
}

export function layoutSpeech(input: LayoutInput): SpeechLayout {
  const m = input.metrics ?? DEFAULT_SPEECH_METRICS;
  const { w: vw, h: vh } = input.viewport;
  const obstacles = input.obstacles ?? [];
  const previous = input.previous;
  const bubbles: PlacedBubble[] = [];
  const pips: Pip[] = [];
  const slots = new Map<string, number>();
  const unplaced: Speaker[] = [];

  const order = [...input.speakers].filter((s) => s.text.trim()).sort(byRelevance);
  const budget = input.tier === "far" ? 0 : m.budget[input.tier];

  for (const s of order) {
    // Far: pips only, except the one line somebody asked to read.
    const wantsBubble = s.expanded || (input.tier !== "far" && bubbles.length < budget);
    if (!wantsBubble) {
      unplaced.push(s);
      continue;
    }
    // Off-screen anchors get nothing: there is no body there to hover, and a
    // bubble clamped onto the screen edge would belong to nobody you can see.
    if (s.ax < 0 || s.ax > vw || s.ay < 0 || s.ay > vh + 40) continue;

    const font: SpeechFont = s.expanded || input.tier === "near" ? "near" : "mid";
    const lines = fitLines(s.text, m.maxW[font], m.maxLines[font], (t) => input.measure(t, font));
    if (!lines.length) continue;
    const textW = Math.max(...lines.map((l) => input.measure(l, font)));
    const bw = Math.ceil(textW + m.padX * 2);
    const bh = lines.length * m.lineH[font] + m.padY * 2;

    const free = (r: Rect, pad: number) =>
      inside(r, vw, vh) &&
      !bubbles.some((b) => overlaps(r, b, pad + m.gap / 2)) &&
      !obstacles.some((o) => overlaps(r, o, pad));

    const prev = previous?.get(s.id);
    let chosen = -1;
    let chosenBox: { r: Rect; moved: number } | null = null;
    if (prev !== undefined && prev >= 0 && prev < SLOTS.length) {
      // Home first, but only by a clear margin; then the slot it already had.
      for (let k = 0; k < prev; k++) {
        const b = boxAt(k, s, bw, bh, vw, vh, m);
        if (free(b.r, RETURN_PAD)) {
          chosen = k;
          chosenBox = b;
          break;
        }
      }
      if (chosen < 0) {
        const b = boxAt(prev, s, bw, bh, vw, vh, m);
        if (free(b.r, -STAY_SHRINK)) {
          chosen = prev;
          chosenBox = b;
        }
      }
    }
    if (chosen < 0) {
      for (let k = 0; k < SLOTS.length; k++) {
        const b = boxAt(k, s, bw, bh, vw, vh, m);
        if (free(b.r, PAD)) {
          chosen = k;
          chosenBox = b;
          break;
        }
      }
    }
    if (chosen < 0 || !chosenBox) {
      unplaced.push(s);
      continue;
    }
    const r = chosenBox.r;
    const tailReaches = chosen < TAIL_SLOTS && s.ax >= r.x0 + 4 && s.ax <= r.x1 - 4 && chosenBox.moved < 12;
    slots.set(s.id, chosen);
    bubbles.push({
      ...r,
      id: s.id,
      font,
      lines,
      whisper: Boolean(s.whisper),
      slot: chosen,
      ax: s.ax,
      ay: s.ay,
      leader: !tailReaches,
      overflow: 0,
    });
  }

  for (const s of unplaced) {
    pips.push(pipFor(s));
    let best: PlacedBubble | null = null;
    let bestD = m.overflowRadius;
    for (const b of bubbles) {
      const d = Math.hypot(b.ax - s.ax, b.ay - s.ay);
      if (d <= bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best) best.overflow += 1;
  }

  return { bubbles, pips, slots };
}

/**
 * Where a leader line from a bubble to its speaker's head should leave the
 * bubble: the nearest point on the box's edge.
 */
export function leaderStart(b: PlacedBubble): { x: number; y: number } {
  const x = Math.min(Math.max(b.ax, b.x0), b.x1);
  const y = Math.min(Math.max(b.ay, b.y0), b.y1);
  return { x, y };
}
