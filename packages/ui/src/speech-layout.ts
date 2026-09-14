/**
 * Speech layout: where the lines people just said go on a crowded canvas.
 *
 * Before this, every body painted its own bubble at a fixed offset above its
 * head and nothing looked at anyone else's. Two bodies a tile apart said two
 * things on top of each other, and a third was simply gone. At minimum zoom a
 * bubble was a smear eight pixels wide.
 *
 * This module is the whole decision — which lines get a bubble, how much of
 * each line, where each bubble sits, which ones collapse to a pip or into a
 * crowd's cluster bubble, and how many were squeezed out near a bubble that did
 * fit — and none of the drawing. It is pure and SCREEN-space: the caller
 * converts anchors and obstacles out of whatever camera it has, supplies a text
 * measurer, and paints the result however its theme paints a bubble. Nothing
 * here knows what a canvas is, or what time it is: the same inputs give the
 * same layout, so a replay (#63) draws what the live map drew.
 *
 * Six rules, in order:
 *
 *   1. Salience. A bubble never covers an obstacle. The caller passes hazard
 *      marks, heartbeat rings and nameplates as obstacles, so a fault outranks
 *      speech at every tier: speech moves out of its way, never the reverse.
 *   2. Relevance. When there is not room for everybody, the expanded line (the
 *      one being hovered, tapped or focused) goes first, then the newest.
 *   3. Short, straight leaders (#64). A leader line is never longer than
 *      `maxLeaderTiles` tile widths at the current zoom, never crosses another
 *      bubble's leader or tail, and never runs under another bubble. A line
 *      that cannot be placed inside those rules is not pushed further out.
 *   4. Crowds collapse. Anchors within `crowdLinkTiles` of each other are one
 *      crowd. Lines a crowd could not place become ONE cluster bubble over it:
 *      the newest of them, then "+N more". Far out a crowd is a count; at mid
 *      zoom a crowd of `clusterAt` or more is a cluster; close up everyone gets
 *      a bubble and only the overflow clusters.
 *   5. Stability. A bubble keeps the slot it had last frame while that slot is
 *      still free, and only moves back toward its home slot when home is free
 *      by a clear margin; a crowd holds together a little past its link
 *      distance. Bodies bob; bubbles must not jitter with them.
 *   6. Nothing vanishes silently. A line without a bubble of its own is a pip
 *      on its speaker (hover or tap to read it) and is counted into a cluster
 *      or into the "+N" of the nearest bubble that did fit.
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
  /** Individual bubbles on screen at once, per tier. Cluster bubbles are extra. */
  budget: Record<"mid" | "near", number>;
  /** An unplaced line outside any cluster is counted into a bubble whose anchor is this close. */
  overflowRadius: number;
  /** Longest leader line, in tile widths at the current zoom. */
  maxLeaderTiles: number;
  /** Two anchors this close, in tile widths, are in the same crowd. */
  crowdLinkTiles: number;
  /** At mid zoom a crowd this big is a cluster; at far zoom, a count. */
  clusterAt: number;
  /** Candidate boxes tested per frame before the rest fall to clusters and pips. */
  checkBudget: number;
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
  maxLeaderTiles: 2.5,
  crowdLinkTiles: 0.9,
  clusterAt: 3,
  checkBudget: 6000,
};

/** A tile's SCREEN width when the caller does not say: the world map's TW at 1x. */
export const DEFAULT_TILE_PX = 64;

export type LayoutInput = {
  tier: SpeechTier;
  speakers: readonly Speaker[];
  viewport: { w: number; h: number };
  /** Hazards, heartbeat marks, nameplates: things speech must not cover. */
  obstacles?: readonly Rect[];
  /** Width in CSS px of `text` in the given role's font. */
  measure: (text: string, font: SpeechFont) => number;
  /** Slot each speaker (or cluster) held last frame, from the previous result's `slots`. */
  previous?: ReadonlyMap<string, number>;
  /** Crowd each speaker was in last frame, from the previous result's `crowds`. */
  previousCrowds?: ReadonlyMap<string, string>;
  /** SCREEN px of one tile's width at the current zoom. Scales leaders and crowds. */
  tilePx?: number;
  metrics?: SpeechMetrics;
};

/** What a cluster bubble stands for. */
export type SpeechCluster = {
  /** The crowd's stable key. */
  crowd: string;
  /** Speakers folded into it, newest first. The first one's line is the one shown. */
  members: string[];
  /** A far-zoom count rather than a line. */
  count: boolean;
};

export type PlacedBubble = Rect & {
  /** A speaker id, or `crowd:<key>` for a cluster. */
  id: string;
  font: SpeechFont;
  lines: string[];
  whisper: boolean;
  /** Candidate slot index; 0 is directly above the head. */
  slot: number;
  /** The anchor this bubble belongs to (a cluster: the top of its crowd). */
  ax: number;
  ay: number;
  /** Too far from the head for a tail to reach: draw a leader line. */
  leader: boolean;
  /** Lines squeezed out nearby and folded into this one's "+N". */
  overflow: number;
  /** When its line was said; bubbles come out oldest first so the newest paints on top. */
  at: number;
  /** Set on a cluster bubble. */
  cluster?: SpeechCluster;
};

export type Pip = { id: string; x: number; y: number; whisper: boolean };

export type SpeechLayout = {
  /** Oldest first: paint in this order and the newest line is on top. */
  bubbles: PlacedBubble[];
  /** Speakers without a bubble or a count this frame. Always drawn: nothing is dropped. */
  pips: Pip[];
  /** Feed back in as `previous` next frame. `FOLDED` (-1) marks a line held in a cluster. */
  slots: Map<string, number>;
  /** Feed back in as `previousCrowds` next frame. Speaker id → crowd key. */
  crowds: Map<string, string>;
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

/**
 * The same slots, left-leaning or right-leaning first. A speaker on the left
 * of its crowd reaches up and left, one on the right up and right: sorted by
 * angle round the crowd's centre, their leaders fan out instead of crossing.
 */
const SLOT_ORDER: Record<-1 | 0 | 1, readonly number[]> = {
  0: SLOTS.map((_, i) => i),
  [-1]: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  1: [0, 2, 1, 3, 5, 4, 6, 8, 7, 10, 9, 11],
};

/** How far from home each slot is; left/right twins share a rank. */
const SLOT_RANK: readonly number[] = [0, 1, 1, 2, 3, 3, 4, 5, 5, 6, 6, 7];

/** Slots whose box still sits over the head, so a tail rather than a leader. */
const TAIL_SLOTS = 3;
/** Padding for a fresh placement. */
const PAD = 2;
/** Moving back toward home needs the home slot free by this clear margin. */
const RETURN_PAD = 8;
/** Staying put tolerates this much overlap, so a bob cannot evict a bubble. */
const STAY_SHRINK = 3;
/** Two speakers in the same crowd last frame stay together this much further out. */
const CROWD_HOLD = 1.25;
/** A leader may run this far through another bubble's corner before it counts as under it. */
const UNDER_TOLERANCE = 3;
/** The `slots` entry of a speaker folded into its crowd's cluster. */
export const FOLDED = -1;
/** A fresh leader stays this far inside the cap; the slack is what a bob may use. */
const LEADER_MARGIN = 8;
/** Individual bubbles a cluster may evict, oldest first, to find itself room. */
const CLUSTER_EVICTIONS = 3;

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

/** A straight segment, SCREEN px. */
export type Segment = { x1: number; y1: number; x2: number; y2: number };

/**
 * The line a bubble's tail or leader draws, from where it leaves the box to
 * the head. The same geometry kit.drawSpeechBubble strokes, so what the layout
 * checked for crossings is what gets painted.
 */
export function connectorOf(r: Rect, ax: number, ay: number): Segment {
  const x1 = Math.min(Math.max(ax, r.x0 + 4), r.x1 - 4);
  const y1 = ay < r.y0 ? r.y0 : r.y1;
  return { x1, y1, x2: ax, y2: ay };
}

/**
 * Where a leader line from a bubble to its speaker's head should leave the
 * bubble.
 */
export function leaderStart(b: PlacedBubble): { x: number; y: number } {
  const s = connectorOf(b, b.ax, b.ay);
  return { x: s.x1, y: s.y1 };
}

export function segmentLength(s: Segment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return Math.abs(v) < 1e-9 ? 0 : v;
}

/** Two connectors meeting this close to a head are converging on it, not crossing. */
export const HEAD_TOLERANCE = 6;

/**
 * Whether two connectors cross. Touching at an end does not count, and nor
 * does meeting within `headTol` of either head (`x2, y2`): two people standing
 * on nearly the same spot share a head, and their lines converging there is not
 * a crossing anyone reads as one.
 */
export function segmentsCross(a: Segment, b: Segment, headTol = HEAD_TOLERANCE): boolean {
  const o1 = orient(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const o2 = orient(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const o3 = orient(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const o4 = orient(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  if (!(o1 * o2 < 0 && o3 * o4 < 0)) return false;
  if (headTol <= 0) return true;
  const t = o3 / (o3 - o4);
  const ix = a.x1 + (a.x2 - a.x1) * t;
  const iy = a.y1 + (a.y2 - a.y1) * t;
  return Math.hypot(ix - a.x2, iy - a.y2) > headTol && Math.hypot(ix - b.x2, iy - b.y2) > headTol;
}

/** Length of `s` that lies inside `r` (Liang–Barsky clip). */
function lengthInside(s: Segment, r: Rect): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (
    clip(-dx, s.x1 - r.x0) &&
    clip(dx, r.x1 - s.x1) &&
    clip(-dy, s.y1 - r.y0) &&
    clip(dy, r.y1 - s.y1)
  ) {
    return Math.max(0, t1 - t0) * Math.hypot(dx, dy);
  }
  return 0;
}

/**
 * The box for slot `k`, pulled inside the viewport when it can be. A bubble
 * over a body at the screen edge slides along the edge rather than vanishing
 * off it; `moved` says how far that slide took it from where the slot wanted.
 */
function boxAt(
  k: number,
  ax: number,
  ay: number,
  bw: number,
  bh: number,
  vw: number,
  vh: number,
  m: SpeechMetrics,
): { r: Rect; moved: number } {
  const [fx, fy] = SLOTS[k]!;
  const cx = ax + fx * bw;
  const y1 = ay - m.tail + fy * (bh + m.gap);
  let x0 = cx - bw / 2;
  let y0 = y1 - bh;
  const wantX = x0;
  const wantY = y0;
  if (bw <= vw) x0 = Math.min(Math.max(x0, 0), vw - bw);
  if (bh <= vh) y0 = Math.min(Math.max(y0, 0), vh - bh);
  return { r: { x0, y0, x1: x0 + bw, y1: y0 + bh }, moved: Math.abs(x0 - wantX) + Math.abs(y0 - wantY) };
}

type Crowd = {
  key: string;
  /** Members in relevance order. */
  members: Speaker[];
  cx: number;
};

/**
 * Group anchors into crowds: single-linkage over a spatial grid, so it stays
 * near-linear in a packed Plaza. Deterministic: the pairs are visited in the
 * relevance order, and a crowd's key is its smallest member id.
 */
function groupCrowds(
  speakers: readonly Speaker[],
  link: number,
  previous: ReadonlyMap<string, string> | undefined,
): { crowdOf: Map<string, Crowd>; crowds: Crowd[] } {
  const n = speakers.length;
  const parent = speakers.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const reach = link * CROWD_HOLD;
  const cell = Math.max(1, reach);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const s = speakers[i]!;
    const gx = Math.floor(s.ax / cell);
    const gy = Math.floor(s.ay / cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = grid.get(`${gx + ox},${gy + oy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          const o = speakers[j]!;
          const d = Math.hypot(o.ax - s.ax, o.ay - s.ay);
          const was = previous?.get(s.id);
          const limit = was !== undefined && was === previous?.get(o.id) ? reach : link;
          if (d <= limit) {
            const a = find(i);
            const b = find(j);
            if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
          }
        }
      }
    }
    const key = `${gx},${gy}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }
  const byRoot = new Map<number, Speaker[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = byRoot.get(r);
    if (list) list.push(speakers[i]!);
    else byRoot.set(r, [speakers[i]!]);
  }
  const crowdOf = new Map<string, Crowd>();
  const crowds: Crowd[] = [];
  for (const members of byRoot.values()) {
    let key = members[0]!.id;
    let sx = 0;
    for (const s of members) {
      if (s.id < key) key = s.id;
      sx += s.ax;
    }
    const crowd: Crowd = { key, members, cx: sx / members.length };
    crowds.push(crowd);
    for (const s of members) crowdOf.set(s.id, crowd);
  }
  return { crowdOf, crowds };
}

/** Paint order: oldest first, id breaking ties. Whether `b` is painted after (at, id). */
function paintsAfter(b: { at: number; id: string }, at: number, id: string): boolean {
  return b.at !== at ? b.at > at : b.id > id;
}

function byPaint(p: { at: number; id: string }, q: { at: number; id: string }): number {
  return p.at !== q.at ? p.at - q.at : p.id < q.id ? -1 : p.id > q.id ? 1 : 0;
}

type Placed = PlacedBubble & { seg: Segment; crowd: string | null; expanded: boolean };

export function layoutSpeech(input: LayoutInput): SpeechLayout {
  const m = input.metrics ?? DEFAULT_SPEECH_METRICS;
  const { w: vw, h: vh } = input.viewport;
  const obstacles = input.obstacles ?? [];
  const previous = input.previous;
  const tile = input.tilePx && input.tilePx > 0 ? input.tilePx : DEFAULT_TILE_PX;
  // Never so short that a bubble directly over the head is out of reach.
  const maxLeader = Math.max(m.maxLeaderTiles * tile, m.tail + 16);
  const link = Math.max(m.crowdLinkTiles * tile, 12);
  const tier = input.tier;

  const placed: Placed[] = [];
  const pips: Pip[] = [];
  const slots = new Map<string, number>();
  let checks = 0;

  const order = [...input.speakers].filter((s) => s.text.trim()).sort(byRelevance);
  // Off-screen anchors get no bubble and no crowd: there is no body there to
  // hover, and a bubble clamped onto the screen edge would belong to nobody
  // you can see. They keep a pip, which simply lands off the canvas.
  const onScreen = (s: Speaker) => s.ax >= 0 && s.ax <= vw && s.ay >= 0 && s.ay <= vh + 40;
  const visible = order.filter(onScreen);
  for (const s of order) if (!onScreen(s)) pips.push(pipFor(s));

  const { crowdOf, crowds: crowdList } = groupCrowds(visible, link, input.previousCrowds);
  const crowds = new Map<string, string>();
  for (const [id, c] of crowdOf) crowds.set(id, c.key);

  /**
   * Try to put a box of `bw`x`bh` for anchor (ax, ay) in a slot, under every
   * rule at once. `side` leans the slot order away from the crowd's centre.
   *
   *   stay    — only the slot it held last frame, tolerating a bob's overlap;
   *   improve — only slots nearer home than that, and only by a clear margin;
   *   fresh   — any slot;
   *   all     — stay-or-improve, then fresh (a cluster does it in one go).
   *
   * `self` is left out of the collision test: it is the bubble being moved.
   */
  const tryPlace = (
    id: string,
    ax: number,
    ay: number,
    bw: number,
    bh: number,
    side: -1 | 0 | 1,
    cap: number,
    at: number,
    mode: "stay" | "improve" | "fresh" | "all",
    self?: Placed,
  ): { k: number; r: Rect; moved: number; seg: Segment } | null => {
    const free = (r: Rect, pad: number): Segment | null => {
      checks++;
      // Bubbles paint oldest first. A leader may run under a bubble painted
      // after it (a newer line covers it cleanly, the way a stacked column
      // reads), never over one painted before it. Staying put forgives a
      // bob's worth of corner.
      const underTol = pad < 0 ? UNDER_TOLERANCE + STAY_SHRINK * 5 : UNDER_TOLERANCE;
      if (!inside(r, vw, vh)) return null;
      const seg = connectorOf(r, ax, ay);
      // A new placement must be clearly inside the cap and clear of crossings;
      // staying put may use the whole cap, so a bob at the limit cannot flip it.
      if (segmentLength(seg) > (pad < 0 ? maxLeader : maxLeader - LEADER_MARGIN)) return null;
      for (const o of obstacles) if (overlaps(r, o, pad)) return null;
      for (const b of placed) {
        if (b === self) continue;
        // Staying put may eat the gap between two bubbles, never overlap them.
        if (overlaps(r, b, Math.max(pad + m.gap / 2, 0))) return null;
        if (segmentsCross(seg, b.seg, pad < 0 ? HEAD_TOLERANCE : HEAD_TOLERANCE / 2)) return null;
        if (paintsAfter(b, at, id) ? lengthInside(b.seg, r) > underTol : lengthInside(seg, b) > underTol) return null;
      }
      return seg;
    };
    const at_ = (k: number, pad: number) => {
      const b = boxAt(k, ax, ay, bw, bh, vw, vh, m);
      const seg = free(b.r, pad);
      return seg ? { k, ...b, seg } : null;
    };
    const cand = SLOT_ORDER[side];
    const prev = previous?.get(id);
    const prevPos = prev === undefined ? -1 : cand.indexOf(prev);
    if ((mode === "improve" || mode === "all") && prevPos >= 0) {
      // Only strictly nearer home: a left/right twin is not an improvement,
      // so a speaker drifting across its crowd's centre does not swap sides.
      for (const k of cand) {
        if (SLOT_RANK[k]! >= SLOT_RANK[prev!]!) continue;
        if (checks > cap) return null;
        const got = at_(k, RETURN_PAD);
        if (got) return got;
      }
    }
    if ((mode === "stay" || mode === "all") && prevPos >= 0) {
      const got = at_(prev!, -STAY_SHRINK);
      if (got) return got;
    }
    if (mode === "fresh" || mode === "all") {
      // Had no bubble last frame while it was already on screen: coming out of
      // a cluster or a pip needs the same clear margin as going home, or a bob
      // that opens a sliver of room would pop it in and out every other frame.
      const pad = prev === undefined && previous !== undefined && input.previousCrowds?.has(id) ? RETURN_PAD : PAD;
      for (const k of cand) {
        if (checks > cap) return null;
        const got = at_(k, pad);
        if (got) return got;
      }
    }
    return null;
  };

  const sideOf = (s: Speaker, c: Crowd | undefined): -1 | 0 | 1 => {
    if (!c || c.members.length < 2) return 0;
    const dx = s.ax - c.cx;
    return dx < -2 ? -1 : dx > 2 ? 1 : 0;
  };

  const measureBox = (lines: string[], font: SpeechFont) => {
    const textW = Math.max(...lines.map((l) => input.measure(l, font)));
    return { bw: Math.ceil(textW + m.padX * 2), bh: lines.length * m.lineH[font] + m.padY * 2 };
  };

  // Individual bubbles. What does not get one waits for its crowd's cluster.
  type Want = { s: Speaker; crowd: Crowd; font: SpeechFont; lines: string[]; bw: number; bh: number; side: -1 | 0 | 1 };
  const wants: Want[] = [];
  const pending = new Map<string, Speaker[]>();
  const wait = (s: Speaker) => {
    const key = crowdOf.get(s.id)!.key;
    const list = pending.get(key);
    if (list) list.push(s);
    else pending.set(key, [s]);
  };
  for (const s of visible) {
    const crowd = crowdOf.get(s.id)!;
    const collapsed = tier === "mid" && crowd.members.length >= m.clusterAt;
    if (!(s.expanded || (tier !== "far" && !collapsed))) continue;
    const font: SpeechFont = s.expanded || tier === "near" ? "near" : "mid";
    const lines = fitLines(s.text, m.maxW[font], m.maxLines[font], (t) => input.measure(t, font));
    if (!lines.length) continue;
    wants.push({ s, crowd, font, lines, ...measureBox(lines, font), side: sideOf(s, crowd) });
  }
  const budget = tier === "far" ? 0 : m.budget[tier];
  let individuals = 0;
  const hasRoom = (w: Want) => w.s.expanded || individuals < budget;
  const put = (w: Want, got: { k: number; r: Rect; moved: number; seg: Segment }) => {
    const { s } = w;
    if (!s.expanded) individuals++;
    const tailReaches = got.k < TAIL_SLOTS && s.ax >= got.r.x0 + 4 && s.ax <= got.r.x1 - 4 && got.moved < 12;
    slots.set(s.id, got.k);
    const bubble: Placed = {
      ...got.r,
      id: s.id,
      font: w.font,
      lines: w.lines,
      whisper: Boolean(s.whisper),
      slot: got.k,
      ax: s.ax,
      ay: s.ay,
      leader: !tailReaches,
      overflow: 0,
      at: s.at,
      seg: got.seg,
      crowd: w.crowd.key,
      expanded: Boolean(s.expanded),
    };
    placed.push(bubble);
    return bubble;
  };
  // 1. Keep: everyone who had a slot holds it while it is still (nearly) free,
  //    before anyone new is placed — a new line does not shove the old ones.
  const done = new Set<string>();
  const kept: Array<{ w: Want; b: Placed }> = [];
  // 0. The line somebody asked to read goes first, wherever it fits best.
  for (const w of wants) {
    if (!w.s.expanded) continue;
    const got = tryPlace(w.s.id, w.s.ax, w.s.ay, w.bw, w.bh, w.side, m.checkBudget, w.s.at, "all");
    if (got) {
      put(w, got);
      done.add(w.s.id);
    }
  }
  for (const w of wants) {
    if (done.has(w.s.id)) continue;
    if ((previous?.get(w.s.id) ?? FOLDED) < 0 || !hasRoom(w) || checks > m.checkBudget) continue;
    const got = tryPlace(w.s.id, w.s.ax, w.s.ay, w.bw, w.bh, w.side, m.checkBudget, w.s.at, "stay");
    if (got) {
      kept.push({ w, b: put(w, got) });
      done.add(w.s.id);
    }
  }
  // 2. Improve: a kept bubble moves nearer home only when home is clearly free.
  for (const { w, b } of kept) {
    if (b.slot === 0 || checks > m.checkBudget) continue;
    const got = tryPlace(w.s.id, w.s.ax, w.s.ay, w.bw, w.bh, w.side, m.checkBudget, w.s.at, "improve", b);
    if (!got) continue;
    Object.assign(b, got.r, {
      slot: got.k,
      seg: got.seg,
      leader: !(got.k < TAIL_SLOTS && w.s.ax >= got.r.x0 + 4 && w.s.ax <= got.r.x1 - 4 && got.moved < 12),
    });
    slots.set(w.s.id, got.k);
  }
  // 3. Fresh: the rest, most relevant first, while the budget lasts.
  for (const w of wants) {
    if (done.has(w.s.id)) continue;
    if (!hasRoom(w) || checks > m.checkBudget) continue;
    // Folded into its crowd's cluster last frame, and the cluster is still
    // there: it stays folded. Popping back out would squeeze the cluster, which
    // would evict it again next frame — a two-frame flicker (#64). It comes
    // back out when the crowd disperses or the cluster is gone.
    if (!w.s.expanded && w.crowd.members.length > 1 && previous?.get(w.s.id) === FOLDED && previous.has(`crowd:${w.crowd.key}`)) continue;
    const got = tryPlace(w.s.id, w.s.ax, w.s.ay, w.bw, w.bh, w.side, m.checkBudget, w.s.at, "fresh");
    if (got) {
      put(w, got);
      done.add(w.s.id);
    }
  }
  for (const s of visible) if (!done.has(s.id) && s.text.trim()) wait(s);

  // Clusters, for the crowds with the newest waiting lines first.
  const clusterCap = m.checkBudget + Math.ceil(m.checkBudget / 4);
  const waiting = crowdList
    .filter((c) => pending.has(c.key))
    .sort((p, q) => byRelevance(pending.get(p.key)![0]!, pending.get(q.key)![0]!));
  const loose: Speaker[] = [];
  for (const crowd of waiting) {
    const list = pending.get(crowd.key)!;
    const collapsed = crowd.members.length >= m.clusterAt;
    // A lone line that did not fit is a pip, not a cluster of one — except in a
    // crowd mid zoom collapsed, where the cluster is the only bubble it gets.
    const wantsCluster = tier === "far" ? collapsed : list.length >= 2 || (tier === "mid" && collapsed);
    if (!wantsCluster) {
      loose.push(...list);
      continue;
    }
    const id = `crowd:${crowd.key}`;
    const font: SpeechFont = tier === "near" ? "near" : "mid";
    let done = false;
    const evicted: Placed[] = [];
    for (let tries = 0; tries <= CLUSTER_EVICTIONS && !done; tries++) {
      list.sort(byRelevance);
      const count = tier === "far";
      const newest = list[0]!;
      let lines: string[];
      if (count) {
        lines = [String(list.length)];
      } else {
        const more = list.length - 1;
        lines = fitLines(newest.text, m.maxW[font], more > 0 ? Math.max(1, m.maxLines[font] - 1) : m.maxLines[font], (t) =>
          input.measure(t, font),
        );
        if (more > 0) lines.push(`+${more} more`);
      }
      // The cluster points at the top of the crowd it stands for, over its middle.
      let ax = 0;
      let ay = Infinity;
      for (const s of list) {
        ax += s.ax;
        if (s.ay < ay) ay = s.ay;
      }
      ax /= list.length;
      const { bw, bh } = measureBox(lines, font);
      const got = lines.length ? tryPlace(id, ax, ay, bw, bh, 0, clusterCap, newest.at, "all") : null;
      if (got) {
        slots.set(id, got.k);
        placed.push({
          ...got.r,
          id,
          font,
          lines,
          whisper: !count && Boolean(newest.whisper),
          slot: got.k,
          ax,
          ay,
          leader: !(got.k < TAIL_SLOTS && ax >= got.r.x0 + 4 && ax <= got.r.x1 - 4 && got.moved < 12),
          overflow: 0,
          at: newest.at,
          seg: got.seg,
          crowd: crowd.key,
          expanded: false,
          cluster: { crowd: crowd.key, members: list.map((s) => s.id), count },
        });
        // Far out, the count is the crowd's whole mark; closer in, each member keeps its pip.
        if (!count) for (const s of list) pips.push(pipFor(s));
        done = true;
        break;
      }
      // No room: give the crowd's oldest individual bubble back to the cluster.
      let victim = -1;
      for (let i = placed.length - 1; i >= 0; i--) {
        const b = placed[i]!;
        if (b.crowd === crowd.key && !b.cluster && !b.expanded) {
          victim = i;
          break;
        }
      }
      if (victim < 0) break;
      const gone = placed.splice(victim, 1)[0]!;
      evicted.push(gone);
      const speaker = crowd.members.find((s) => s.id === gone.id);
      if (speaker) list.push(speaker);
    }
    if (done) {
      for (const f of list) slots.set(f.id, FOLDED);
    } else {
      // The cluster did not fit even so: the evicted bubbles go back where they were.
      const back = new Set(evicted.map((b) => b.id));
      placed.push(...evicted);
      loose.push(...list.filter((s) => !back.has(s.id)));
    }
  }

  // What is left is a pip, counted into the nearest bubble's "+N".
  for (const s of loose) {
    pips.push(pipFor(s));
    let best: Placed | null = null;
    let bestD = m.overflowRadius;
    for (const b of placed) {
      if (b.cluster) continue;
      const d = Math.hypot(b.ax - s.ax, b.ay - s.ay);
      if (d <= bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best) best.overflow += 1;
  }

  const bubbles: PlacedBubble[] = placed
    .map(({ seg: _seg, crowd: _crowd, expanded: _expanded, ...b }) => b)
    .sort(byPaint);
  return { bubbles, pips, slots, crowds };
}

/**
 * The cluster bubble under a SCREEN point, if any: a tap on it opens the
 * room's transcript on the lines it folded away.
 */
export function clusterUnder(layout: SpeechLayout | null, x: number, y: number, slop = 4): PlacedBubble | null {
  if (!layout) return null;
  for (let i = layout.bubbles.length - 1; i >= 0; i--) {
    const b = layout.bubbles[i]!;
    if (!b.cluster) continue;
    if (x >= b.x0 - slop && x <= b.x1 + slop && y >= b.y0 - slop && y <= b.y1 + slop) return b;
  }
  return null;
}
