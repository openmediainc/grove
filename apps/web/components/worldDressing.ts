/**
 * The dressing of the civic core: paths, scatter, props, civic landmarks and
 * the sheep. Everything here is computed ONCE, at module load, from the tile
 * grid alone.
 *
 * That is the whole design constraint. The map repaints at 60fps and re-polls
 * the world every 8s; if placement were derived per frame (or per poll) from
 * anything that moves — Math.random, array order, body count — the world would
 * shimmer between frames and reorder every poll. So:
 *
 *   - the path network is a fixed set of avenues, listed below;
 *   - each path tile's 16-way bitmask is derived from that set;
 *   - scatter is keyed on hash32("s:tx,ty") — the same tile always gets the
 *     same pebbles;
 *   - props are either hand-placed (the civic furniture) or derived from the
 *     path network (lanterns down one side of each avenue, signposts at the
 *     outer crossroads).
 *
 * The core is 24 x 18 = 432 tiles and never grows, so the per-tile lookups are
 * flat typed arrays indexed by ty * MAP_COLS + tx: the draw loop pays one array
 * read per tile and allocates nothing.
 */

import { MAP_COLS, MAP_ROWS, REGION_RECTS, hash32, regionAt, type MapRegion } from "@/lib/map-layout";
import {
  CIVIC,
  CIVIC_ROOMS,
  PATH_E,
  PATH_N,
  PATH_S,
  PATH_W,
  SCATTER_KEYS,
  type CivicRoom,
  type PropKey,
  type ScatterKey,
} from "@/lib/art";

const CORE_TILES = MAP_COLS * MAP_ROWS;

function idx(tx: number, ty: number): number {
  return ty * MAP_COLS + tx;
}

function inCore(tx: number, ty: number): boolean {
  return tx >= 0 && tx < MAP_COLS && ty >= 0 && ty < MAP_ROWS;
}

/* ------------------------------------------------------------------ *
 * Civic landmarks.
 *
 * Each region is 8 x 6 and each civic building is 4 x 4, anchored at
 * (x0 + 2, y0 + 1) — centred east/west, one tile in from the north edge.
 * That leaves a free lane on all four sides, which is exactly where the
 * avenues below run.
 * ------------------------------------------------------------------ */

export type CivicPlacement = { room: CivicRoom; tx: number; ty: number };

export const CIVIC_PLACEMENTS: readonly CivicPlacement[] = CIVIC_ROOMS.map((room) => {
  const r = REGION_RECTS[room];
  return { room, tx: r.x0 + 2, ty: r.y0 + 1 };
});

/** True when the tile is under a civic building's footprint. */
const CIVIC_FOOTPRINT = new Uint8Array(CORE_TILES);
for (const c of CIVIC_PLACEMENTS) {
  const a = CIVIC[c.room];
  for (let ty = c.ty; ty < c.ty + a.fh; ty++) {
    for (let tx = c.tx; tx < c.tx + a.fw; tx++) {
      if (inCore(tx, ty)) CIVIC_FOOTPRINT[idx(tx, ty)] = 1;
    }
  }
}

export function isCivicFootprint(tx: number, ty: number): boolean {
  return inCore(tx, ty) && CIVIC_FOOTPRINT[idx(tx, ty)] === 1;
}

/* ------------------------------------------------------------------ *
 * The path network.
 *
 * Six avenues, chosen so that every civic building is approached on a
 * paved lane and no path tile lands under a building. The two north-south
 * avenues (tx 9 and 14) flank the Library / Plaza / Garden column; the two
 * east-west avenues (ty 6 and 11) flank the Stage / Plaza / Workshop row;
 * tx 6 and tx 17 run down the outer flanks to the Garden and the Board.
 *
 * The Plaza building therefore sits inside a closed paved court — four
 * avenues boxing it — which is what makes the middle of the map read as a
 * plaza rather than as grass with a fountain on it.
 * ------------------------------------------------------------------ */

type Run = { tx0: number; ty0: number; tx1: number; ty1: number };

const AVENUES: readonly Run[] = [
  { tx0: 9, ty0: 0, tx1: 9, ty1: 17 },
  { tx0: 14, ty0: 0, tx1: 14, ty1: 17 },
  { tx0: 6, ty0: 6, tx1: 6, ty1: 17 },
  { tx0: 17, ty0: 6, tx1: 17, ty1: 17 },
  { tx0: 0, ty0: 6, tx1: 23, ty1: 6 },
  { tx0: 0, ty0: 11, tx1: 23, ty1: 11 },
];

const IS_PATH = new Uint8Array(CORE_TILES);
for (const run of AVENUES) {
  for (let ty = run.ty0; ty <= run.ty1; ty++) {
    for (let tx = run.tx0; tx <= run.tx1; tx++) {
      if (!inCore(tx, ty)) continue;
      // A path must never be laid under a building; the avenues are chosen so
      // this never fires, and it stays here so a future avenue cannot quietly
      // pave over the Library.
      if (CIVIC_FOOTPRINT[idx(tx, ty)] === 1) continue;
      IS_PATH[idx(tx, ty)] = 1;
    }
  }
}

function pathAt(tx: number, ty: number): boolean {
  return inCore(tx, ty) && IS_PATH[idx(tx, ty)] === 1;
}

/**
 * Per-tile connection mask, -1 where there is no path. n = ty-1, e = tx+1,
 * s = ty+1, w = tx-1, matching the manifest's file names exactly.
 */
const PATH_MASK = new Int8Array(CORE_TILES).fill(-1);
for (let ty = 0; ty < MAP_ROWS; ty++) {
  for (let tx = 0; tx < MAP_COLS; tx++) {
    if (!pathAt(tx, ty)) continue;
    let m = 0;
    if (pathAt(tx, ty - 1)) m |= PATH_N;
    if (pathAt(tx + 1, ty)) m |= PATH_E;
    if (pathAt(tx, ty + 1)) m |= PATH_S;
    if (pathAt(tx - 1, ty)) m |= PATH_W;
    PATH_MASK[idx(tx, ty)] = m;
  }
}

/** -1 when this tile carries no path; otherwise the 0..15 piece index. */
export function pathMaskAt(tx: number, ty: number): number {
  return inCore(tx, ty) ? PATH_MASK[idx(tx, ty)]! : -1;
}

/* ------------------------------------------------------------------ *
 * Scatter: transparent ground overlays.
 *
 * Deterministic from the tile, region-appropriate, and never on paving the
 * path set already textures. Density is deliberately low — the art README's
 * house rule is that ground noise is what does the most damage when zoomed
 * out, so this is a seasoning, not a texture.
 * ------------------------------------------------------------------ */

const SCATTER_DENSITY = 13; // percent of eligible tiles

const SCATTER_BY_REGION: Record<MapRegion, readonly ScatterKey[]> = {
  plaza: ["crack", "pebbles", "crack"],
  library: ["crack", "crack", "pebbles"],
  workshop: ["pebbles", "crack", "pebbles"],
  stage: ["crack", "pebbles", "puddle"],
  garden: ["tuft", "flowers", "leaves"],
  board: ["pebbles", "crack", "puddle"],
  wild: ["tuft", "tuft", "flowers"],
};

const SCATTER_AT = new Int8Array(CORE_TILES).fill(-1);
for (let ty = 0; ty < MAP_ROWS; ty++) {
  for (let tx = 0; tx < MAP_COLS; tx++) {
    if (pathAt(tx, ty) || CIVIC_FOOTPRINT[idx(tx, ty)] === 1) continue;
    const h = hash32(`s:${tx},${ty}`);
    if (h % 100 >= SCATTER_DENSITY) continue;
    const pool = SCATTER_BY_REGION[regionAt(tx, ty)];
    const key = pool[Math.floor(h / 100) % pool.length]!;
    SCATTER_AT[idx(tx, ty)] = SCATTER_KEYS.indexOf(key);
  }
}

/** -1 when this tile carries nothing; otherwise an index into SCATTER_KEYS. */
export function scatterAt(tx: number, ty: number): number {
  return inCore(tx, ty) ? SCATTER_AT[idx(tx, ty)]! : -1;
}

/* ------------------------------------------------------------------ *
 * Props.
 *
 * Two sources, both fixed:
 *
 *  1. Civic furniture, hand-placed on named tiles. "Deterministic" is not
 *     the same as "looks placed" — a hash can only sprinkle. Benches flank
 *     the Plaza, planters bracket the Library and Garden doors, crates and
 *     rubble pile up on the Workshop and Board yards. Every tile below is a
 *     free lane beside a building, never under one and never on an avenue.
 *  2. Street furniture derived from the avenues: a lantern every four tiles
 *     down ONE side of each avenue (the east side of a north-south run, the
 *     south side of an east-west one, so a road is lit from one side rather
 *     than double-hedged), and a signpost at the two outer crossroads.
 * ------------------------------------------------------------------ */

export type PropPlacement = { key: PropKey; tx: number; ty: number };

const FURNITURE: readonly PropPlacement[] = [
  // Plaza: a fire and a water basin to stand around, benches on both flanks.
  { key: "brazier", tx: 8, ty: 8 },
  { key: "wellstone", tx: 15, ty: 8 },
  { key: "bench", tx: 8, ty: 10 },
  { key: "bench", tx: 15, ty: 10 },
  // Library: planters bracketing the south steps, benches to read on.
  { key: "planter", tx: 10, ty: 5 },
  { key: "planter", tx: 13, ty: 5 },
  { key: "bench", tx: 8, ty: 3 },
  { key: "bench", tx: 15, ty: 3 },
  // Workshop: a working yard.
  { key: "crates", tx: 22, ty: 8 },
  { key: "crates", tx: 22, ty: 9 },
  { key: "crates", tx: 16, ty: 9 },
  { key: "rubble", tx: 23, ty: 10 },
  { key: "bench", tx: 16, ty: 7 },
  // Stage: seating on the west flank, a brazier at the east approach.
  { key: "bench", tx: 1, ty: 8 },
  { key: "bench", tx: 1, ty: 10 },
  { key: "brazier", tx: 7, ty: 9 },
  // Garden: planting at all four corners, a basin and a bench.
  { key: "planter", tx: 10, ty: 12 },
  { key: "planter", tx: 13, ty: 12 },
  { key: "planter", tx: 10, ty: 17 },
  { key: "planter", tx: 13, ty: 17 },
  { key: "wellstone", tx: 8, ty: 15 },
  { key: "bench", tx: 15, ty: 15 },
  // Board: the yard where things are dropped off and read.
  { key: "crates", tx: 22, ty: 14 },
  { key: "rubble", tx: 23, ty: 16 },
  { key: "bench", tx: 18, ty: 17 },
  { key: "bench", tx: 21, ty: 17 },
];

/** The two outer crossroads, where a signpost says the world continues. */
const SIGNPOSTS: readonly PropPlacement[] = [
  { key: "signpost", tx: 7, ty: 12 },
  { key: "signpost", tx: 18, ty: 12 },
];

function buildProps(): PropPlacement[] {
  const out: PropPlacement[] = [];
  const taken = new Uint8Array(CORE_TILES);
  const put = (p: PropPlacement) => {
    if (!inCore(p.tx, p.ty)) return;
    const i = idx(p.tx, p.ty);
    if (taken[i] === 1 || IS_PATH[i] === 1 || CIVIC_FOOTPRINT[i] === 1) return;
    taken[i] = 1;
    out.push(p);
  };
  for (const p of FURNITURE) put(p);
  for (const p of SIGNPOSTS) put(p);
  for (let ty = 0; ty < MAP_ROWS; ty++) {
    for (let tx = 0; tx < MAP_COLS; tx++) {
      // East side of a north-south avenue, or south side of an east-west one.
      if (pathAt(tx - 1, ty) && ty % 4 === 1) put({ key: "lantern", tx, ty });
      else if (pathAt(tx, ty - 1) && tx % 4 === 2) put({ key: "lantern", tx, ty });
    }
  }
  // Back-to-front: a prop with a larger (tx + ty) is nearer the camera. The
  // renderer re-sorts the whole structure layer each frame anyway, but sorting
  // the source list keeps the culled subset already in order.
  out.sort((a, b) => a.tx + a.ty - (b.tx + b.ty));
  return out;
}

export const PROPS: readonly PropPlacement[] = buildProps();

/** Tiles a body must not be seated on: it would stand inside the furniture. */
const OCCUPIED = new Uint8Array(CORE_TILES);
for (const p of PROPS) OCCUPIED[idx(p.tx, p.ty)] = 1;
for (let i = 0; i < CORE_TILES; i++) if (CIVIC_FOOTPRINT[i] === 1) OCCUPIED[i] = 1;

/**
 * A body may walk the avenues, but must not be seated inside a building or on
 * top of a bench. Seat assignment probes past these.
 */
export function tileBlocked(tx: number, ty: number): boolean {
  return inCore(tx, ty) && OCCUPIED[idx(tx, ty)] === 1;
}

/* ------------------------------------------------------------------ *
 * Lamps.
 *
 * Which of the fixed dressing actually burns, for the day/night pass. The
 * campus art was drawn at dusk with the lanterns already lit and the civic
 * windows already warm, so nothing here paints a light that was not already in
 * the picture — it only says WHERE the light in the picture is, so the renderer
 * can let it bloom as the hour gets darker and let it die back at noon.
 *
 * Same discipline as everything else in this file: decided once, at module
 * load, from the prop and civic lists that were themselves decided once. Two
 * flat Int16Arrays of [tx, ty, lift, radius], so the draw loop reads four
 * numbers per lamp and allocates nothing.
 *
 * The two lists are separate because they answer the level-of-detail question
 * differently. Street lamps live and die with the props they belong to and drop
 * out below LOD_DRESSING — a lantern's glow with no lantern under it is a
 * smudge. Civic windows follow the civic buildings, which are never gated: at
 * minimum zoom the six landmarks ARE the campus, and six warm windows are what
 * says the campus is lit at three in the morning.
 * ------------------------------------------------------------------ */

/** [tx, ty, lift, radius] per lamp. */
export const LAMP_STRIDE = 4;

/** Lift is in px above iso(tx,ty) — roughly where the flame sits in the sprite. */
const LAMP_LIFT: Partial<Record<PropKey, { lift: number; radius: number }>> = {
  lantern: { lift: 48, radius: 42 },
  brazier: { lift: 34, radius: 50 },
};

function packLamps(entries: ReadonlyArray<{ tx: number; ty: number; lift: number; radius: number }>): Int16Array {
  const out = new Int16Array(entries.length * LAMP_STRIDE);
  entries.forEach((e, i) => {
    out[i * LAMP_STRIDE] = e.tx;
    out[i * LAMP_STRIDE + 1] = e.ty;
    out[i * LAMP_STRIDE + 2] = e.lift;
    out[i * LAMP_STRIDE + 3] = e.radius;
  });
  return out;
}

export const STREET_LAMPS: Int16Array = packLamps(
  PROPS.flatMap((p) => {
    const g = LAMP_LIFT[p.key];
    return g ? [{ tx: p.tx, ty: p.ty, lift: g.lift, radius: g.radius }] : [];
  }),
);

/**
 * One warm window per civic landmark, centred on the 4x4 footprint and lifted
 * to the middle of the elevation rather than the roof, so the glow reads as
 * light coming OUT of the building instead of sitting on top of it.
 */
export const CIVIC_LAMPS: Int16Array = packLamps(
  CIVIC_PLACEMENTS.map((c) => ({
    tx: c.tx + 1,
    ty: c.ty + 1,
    lift: Math.round(CIVIC[c.room].ay * 0.46),
    radius: 68,
  })),
);

/* ------------------------------------------------------------------ *
 * Sheep.
 *
 * Ambient life in the Garden: an idle local model with nothing to do. Four
 * of them, each ambling back and forth along a two-tile stretch on its own
 * period, so the Garden is never completely still and never busy either.
 *
 * They are drawn through the unchanged 40x40 character path, and they are
 * dropped below LOD_LABELS — the art pass was blunt that a sheep zoomed out
 * is a white blob, and four white blobs in a corner is worse than an empty
 * corner.
 * ------------------------------------------------------------------ */

export type SheepPlan = { x0: number; y0: number; x1: number; y1: number; periodMs: number; phase: number };

export const SHEEP: readonly SheepPlan[] = [
  { x0: 8, y0: 13, x1: 8, y1: 14, periodMs: 26_000, phase: 0 },
  { x0: 8, y0: 17, x1: 9, y1: 17, periodMs: 31_000, phase: 0.31 },
  { x0: 15, y0: 13, x1: 15, y1: 12, periodMs: 23_000, phase: 0.62 },
  { x0: 15, y0: 17, x1: 14, y1: 17, periodMs: 35_000, phase: 0.85 },
];

/** Fraction of a sheep's cycle spent standing still at each end. */
const SHEEP_DWELL = 0.36;

export type SheepFrame = {
  x: number;
  y: number;
  pose: "sheep-graze" | "sheep-idle" | "sheep-walk-a" | "sheep-walk-b";
  flip: boolean;
};

/**
 * Where a sheep is at time `t`. Pure: the same t always gives the same frame,
 * so nothing here depends on render order or on how long the tab has been open.
 */
export function sheepAt(plan: SheepPlan, t: number): SheepFrame {
  const u = ((t / plan.periodMs + plan.phase) % 1 + 1) % 1;
  // Out, dwell, back, dwell.
  const leg = 0.5 - SHEEP_DWELL / 2;
  let p: number;
  let moving: boolean;
  let forward = true;
  if (u < leg) {
    p = u / leg;
    moving = true;
  } else if (u < 0.5) {
    p = 1;
    moving = false;
  } else if (u < 0.5 + leg) {
    p = 1 - (u - 0.5) / leg;
    moving = true;
    forward = false;
  } else {
    p = 0;
    moving = false;
  }
  const x = plan.x0 + (plan.x1 - plan.x0) * p;
  const y = plan.y0 + (plan.y1 - plan.y0) * p;
  if (!moving) {
    // Head down most of the time; head up on the far end, so the pair reads as
    // one animal doing two things rather than two identical decals.
    return { x, y, pose: u < 0.5 ? "sheep-idle" : "sheep-graze", flip: false };
  }
  const step = Math.floor(t / 260) % 2 === 0;
  // Sprites face the viewer's right. Screen-x increases with tx and decreases
  // with ty, so that combination is what decides the flip.
  const dx = (plan.x1 - plan.x0) - (plan.y1 - plan.y0);
  const heading = forward ? dx : -dx;
  return { x, y, pose: step ? "sheep-walk-a" : "sheep-walk-b", flip: heading < 0 };
}
