/**
 * Motion: why a body goes where it goes, how long it stays, and how it gets back.
 *
 * The design is written down in docs/design/MOTION.md. This module is the whole
 * of the logic that document describes, kept pure (no DOM, no clock of its own,
 * no randomness) so it can be unit-tested and so the map is a thin renderer of
 * decisions made here.
 *
 * An RTS villager has a task, a work site, a path, a work animation and a
 * return trip. A Grove body has the same five things, with one rule an RTS does
 * not need: every one of them must be backed by a signal the server actually
 * sent. A body stands at the Workshop because a tool call is genuinely in
 * flight, never because the renderer thought it would look busy.
 */
import type { AgentVerb } from "./agent-verbs.js";
import { hash32, isDecorSlotOffset, REGION_RECTS, type MapRegion, type PlotRect } from "./map-layout.js";

export type Tile = { x: number; y: number };

/** The civic buildings a body can be sent to. `wild` is not a destination. */
export type SiteRegion = Exclude<MapRegion, "wild">;

/* ------------------------------------------------------------------ *
 * 1. The state machine
 * ------------------------------------------------------------------ */

/**
 * Where a body is in its errand. Rendering keys off this, not off the verb:
 * the verb says what the agent claims, the state says what the body is doing
 * about it on the map this frame.
 */
export type MotionState =
  /** At home, nothing that needs a trip. Idle, thinking, waiting, speaking in its room. */
  | "resting"
  /** Walking to a work site because work that needs one is in flight. */
  | "dispatched"
  /** At the work site with the work still in flight. */
  | "working"
  /** Work ended; walking home (after the linger). */
  | "returning"
  /** Said it errored. Stays where the fault happened. */
  | "faulted"
  /** Said it needs a human. Walks to the Board and waits there. */
  | "blocked"
  /** Claims active work but has gone quiet past the stall threshold. Frozen where it was. */
  | "stalled"
  /** Offline. Walks home, then dims. */
  | "asleep"
  /** Walking toward another body it is addressing. */
  | "approaching";

/** What the signals say the body is FOR right now. Derived; never stored server-side. */
export type Errand =
  | { kind: "rest" }
  | { kind: "work"; site: SiteRegion }
  | { kind: "fault" }
  | { kind: "blocked" }
  | { kind: "stall" }
  | { kind: "sleep" }
  | { kind: "approach"; targetId: string };

export interface ErrandInput {
  verb: AgentVerb;
  /** Server verdict (minimap `stalled`), never recomputed here. */
  stalled?: boolean;
  /** Presence connection, verbatim. */
  connection?: string | null;
  /** Open, non-stalled tool-call spans this body has, per the server. */
  openToolCalls?: number;
  /** A body this one is publicly addressing, when the server says so. */
  addressing?: string | null;
}

/**
 * The verb-to-site table. Deliberately NOT regionForVerb(): that function
 * places a Paperclip body that has no room at all, while this one decides
 * whether a body with a home should LEAVE it.
 *
 * Only work that happens somewhere else earns a trip. Thinking and waiting are
 * done where you stand; speaking in a room is done in the room.
 */
export const WORK_SITE: Partial<Record<AgentVerb, SiteRegion>> = {
  tool: "workshop",
  read: "library",
};

export function errandFor(input: ErrandInput): Errand {
  const conn = (input.connection ?? "").toLowerCase();
  if (input.verb === "offline" || conn === "offline") return { kind: "sleep" };
  if (input.stalled) return { kind: "stall" };
  if (input.verb === "error") return { kind: "fault" };
  if (input.verb === "blocked") return { kind: "blocked" };
  // An open tool call outranks the verb: the span is the stronger signal, and
  // a `think` pulse sent between two parallel tool calls must not recall the body.
  if ((input.openToolCalls ?? 0) > 0) return { kind: "work", site: "workshop" };
  const site = WORK_SITE[input.verb];
  if (site) return { kind: "work", site };
  if (input.addressing) return { kind: "approach", targetId: input.addressing };
  return { kind: "rest" };
}

export function sameErrand(a: Errand, b: Errand): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "work" && b.kind === "work") return a.site === b.site;
  if (a.kind === "approach" && b.kind === "approach") return a.targetId === b.targetId;
  return true;
}

/* ------------------------------------------------------------------ *
 * 2. Timing: dwell and hysteresis
 * ------------------------------------------------------------------ */

export const MOTION_TIMING = {
  /**
   * A trip is only started once the errand has held this long. A 40ms Read
   * that starts and finishes between two frames never moves the body; its
   * outcome still renders where the body stands.
   */
  commitMs: 1200,
  /** Minimum time at a work site before leaving for anything but a fault or sleep. */
  minDwellMs: 4000,
  /** After the work ends, how long the body waits at the site for more of the same. */
  lingerMs: 2500,
  /** Walking speed on open ground. Avenues are cheaper to path, not faster to walk. */
  tilesPerSecond: 4,
  /** Trips are clamped so a long walk still arrives while the work is plausibly running. */
  minTripMs: 500,
  maxTripMs: 3500,
} as const;

export type MotionTiming = { -readonly [K in keyof typeof MOTION_TIMING]: number };

/* ------------------------------------------------------------------ *
 * 3. Work-site selection
 * ------------------------------------------------------------------ */

export interface WorldGrid {
  /** Tiles no body may stand on or walk through (building footprints, props). */
  blocked(tx: number, ty: number): boolean;
  /** Paved tiles. Pathing prefers them; they are not required. */
  isPath(tx: number, ty: number): boolean;
}

/** Civic building placement, mirrored from worldDressing: 4x4 at (x0+2, y0+1). */
export const CIVIC_FOOTPRINT = { dx: 2, dy: 1, w: 4, h: 4 } as const;

/** The tile in front of a building's door: centre of its south face, one row out. */
export function doorTile(region: SiteRegion): Tile {
  const r = REGION_RECTS[region];
  return { x: r.x0 + CIVIC_FOOTPRINT.dx + 1, y: r.y0 + CIVIC_FOOTPRINT.dy + CIVIC_FOOTPRINT.h };
}

/**
 * Where work at a building is done, best slot first: the apron of tiles around
 * the footprint, ordered by distance from the door (ties broken west-to-east,
 * north-to-south so the order is total). Blocked tiles are dropped.
 */
export function workSlots(region: SiteRegion, grid: WorldGrid): Tile[] {
  const r = REGION_RECTS[region];
  const fx0 = r.x0 + CIVIC_FOOTPRINT.dx;
  const fy0 = r.y0 + CIVIC_FOOTPRINT.dy;
  const fx1 = fx0 + CIVIC_FOOTPRINT.w - 1;
  const fy1 = fy0 + CIVIC_FOOTPRINT.h - 1;
  const door = doorTile(region);
  const out: Tile[] = [];
  for (let y = fy0 - 1; y <= fy1 + 1; y++) {
    for (let x = fx0 - 1; x <= fx1 + 1; x++) {
      const inside = x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1;
      if (inside) continue;
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      if (grid.blocked(x, y)) continue;
      out.push({ x, y });
    }
  }
  const d = (t: Tile) => Math.abs(t.x - door.x) + Math.abs(t.y - door.y);
  return out.sort((p, q) => d(p) - d(q) || p.y - q.y || p.x - q.x);
}

export interface SiteRequest {
  id: string;
  site: SiteRegion;
  /** When this body's current work began (ms). Earlier work keeps its slot. */
  since: number;
}

/**
 * One slot per working body, deterministic for a given set of requests.
 *
 * Each body prefers a slot by hash of its id, so two agents do not both head
 * for the door tile; collisions probe forward. Bodies are placed in order of
 * when their work started, so a body already at a slot is never bumped by a
 * newcomer. A full apron spills outward in rings — still rendered as working,
 * because a tool call does not queue behind another agent's and the map must
 * not draw a queue that does not exist.
 */
export function assignWorkSlots(
  requests: readonly SiteRequest[],
  grid: WorldGrid,
  taken: ReadonlySet<string> = new Set(),
): Map<string, Tile> {
  const out = new Map<string, Tile>();
  const used = new Set(taken);
  const bySite = new Map<SiteRegion, SiteRequest[]>();
  for (const r of requests) {
    const list = bySite.get(r.site) ?? [];
    list.push(r);
    bySite.set(r.site, list);
  }
  for (const [site, list] of bySite) {
    const slots = workSlots(site, grid);
    const ordered = [...list].sort((p, q) => p.since - q.since || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
    for (const req of ordered) {
      let seat: Tile | null = null;
      if (slots.length) {
        const start = hash32(req.id) % slots.length;
        for (let n = 0; n < slots.length; n++) {
          const s = slots[(start + n) % slots.length]!;
          const key = `${s.x},${s.y}`;
          if (!used.has(key)) {
            seat = s;
            break;
          }
        }
      }
      if (!seat) seat = spill(site, grid, used);
      used.add(`${seat.x},${seat.y}`);
      out.set(req.id, seat);
    }
  }
  return out;
}

function spill(site: SiteRegion, grid: WorldGrid, used: ReadonlySet<string>): Tile {
  const door = doorTile(site);
  for (let ring = 1; ring <= 8; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = door.x + dx;
        const y = door.y + dy;
        if (grid.blocked(x, y) || used.has(`${x},${y}`)) continue;
        return { x, y };
      }
    }
  }
  return door;
}

/**
 * Where to stand to address another body: the free neighbour of the target
 * nearest to the approacher. Never the target's own tile.
 */
export function approachTile(from: Tile, target: Tile, grid: WorldGrid, used: ReadonlySet<string> = new Set()): Tile {
  const around: Tile[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const t = { x: target.x + dx, y: target.y + dy };
      if (grid.blocked(t.x, t.y) || used.has(`${t.x},${t.y}`)) continue;
      around.push(t);
    }
  }
  if (!around.length) return from;
  const d = (t: Tile) => Math.hypot(t.x - from.x, t.y - from.y);
  return around.sort((p, q) => d(p) - d(q) || p.y - q.y || p.x - q.x)[0]!;
}

/**
 * Two bodies addressing EACH OTHER meet in the middle rather than chasing one
 * another round the map: each takes one of two adjacent free tiles at the
 * midpoint. Returns [tile for a, tile for b].
 */
export function meetingTiles(a: Tile, b: Tile, grid: WorldGrid): [Tile, Tile] {
  const mx = Math.round((a.x + b.x) / 2);
  const my = Math.round((a.y + b.y) / 2);
  for (let ring = 0; ring <= 4; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = mx + dx;
        const y = my + dy;
        if (grid.blocked(x, y)) continue;
        // a partner tile, facing along the axis the two bodies came from
        const horizontal = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y);
        const px = horizontal ? x + 1 : x;
        const py = horizontal ? y : y + 1;
        if (grid.blocked(px, py)) continue;
        const first = { x, y };
        const second = { x: px, y: py };
        // whoever is west (or north) takes the west (or north) tile
        const aFirst = horizontal ? a.x <= b.x : a.y <= b.y;
        return aFirst ? [first, second] : [second, first];
      }
    }
  }
  return [a, b];
}

/* ------------------------------------------------------------------ *
 * 4. Pathing
 * ------------------------------------------------------------------ */

export interface PathOptions {
  /** Cost of a step onto a paved tile. */
  pathCost?: number;
  /** Cost of a step onto open ground. Higher than paving, so avenues win. */
  groundCost?: number;
  /** Search budget; beyond it the straight line is returned (never a hang). */
  maxNodes?: number;
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * A* over the tile grid, 4-connected (diagonals would cut building corners in
 * iso). Returns the tiles from `from` to `to` inclusive. A blocked destination
 * or an exhausted budget returns the straight two-point route, so a caller can
 * always walk *something*; the tests pin that no normal campus trip hits it.
 */
export function findPath(from: Tile, to: Tile, grid: WorldGrid, opts: PathOptions = {}): Tile[] {
  const pathCost = opts.pathCost ?? 1;
  const groundCost = opts.groundCost ?? 1.6;
  const maxNodes = opts.maxNodes ?? 4000;
  const sx = Math.round(from.x);
  const sy = Math.round(from.y);
  const tx = Math.round(to.x);
  const ty = Math.round(to.y);
  if (sx === tx && sy === ty) return [{ x: tx, y: ty }];
  if (grid.blocked(tx, ty)) return [{ x: sx, y: sy }, { x: tx, y: ty }];
  const key = (x: number, y: number) => `${x},${y}`;
  const h = (x: number, y: number) => (Math.abs(x - tx) + Math.abs(y - ty)) * pathCost;
  const g = new Map<string, number>([[key(sx, sy), 0]]);
  const came = new Map<string, string>();
  // Small open set; a binary heap is not worth it at campus scale.
  const open: Array<{ x: number; y: number; f: number }> = [{ x: sx, y: sy, f: h(sx, sy) }];
  let expanded = 0;
  while (open.length && expanded < maxNodes) {
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      const o = open[i]!;
      const b = open[best]!;
      if (o.f < b.f || (o.f === b.f && (o.y < b.y || (o.y === b.y && o.x < b.x)))) best = i;
    }
    const cur = open.splice(best, 1)[0]!;
    const ck = key(cur.x, cur.y);
    if (cur.x === tx && cur.y === ty) {
      const out: Tile[] = [];
      let k: string | undefined = ck;
      while (k) {
        const [x, y] = k.split(",").map(Number) as [number, number];
        out.push({ x, y });
        k = came.get(k);
      }
      return out.reverse();
    }
    expanded++;
    const cg = g.get(ck)!;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      // The start tile may itself be blocked (a body caught on a prop); leaving it is allowed.
      if (grid.blocked(nx, ny)) continue;
      const nk = key(nx, ny);
      const ng = cg + (grid.isPath(nx, ny) ? pathCost : groundCost);
      if (ng >= (g.get(nk) ?? Infinity)) continue;
      g.set(nk, ng);
      came.set(nk, ck);
      const f = ng + h(nx, ny);
      const existing = open.find((o) => o.x === nx && o.y === ny);
      if (existing) existing.f = f;
      else open.push({ x: nx, y: ny, f });
    }
  }
  return [{ x: sx, y: sy }, { x: tx, y: ty }];
}

/** Collapse straight runs to their corners, so a route is a short polyline. */
export function simplifyRoute(route: readonly Tile[]): Tile[] {
  if (route.length <= 2) return [...route];
  const out: Tile[] = [route[0]!];
  for (let i = 1; i < route.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = route[i]!;
    const c = route[i + 1]!;
    const collinear = (b.x - a.x) * (c.y - b.y) === (b.y - a.y) * (c.x - b.x);
    if (!collinear) out.push(b);
  }
  out.push(route[route.length - 1]!);
  return out;
}

export function routeLength(route: readonly Tile[]): number {
  let n = 0;
  for (let i = 1; i < route.length; i++) {
    n += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.y - route[i - 1]!.y);
  }
  return n;
}

/** The point `p` (0..1) of the way along a polyline, by distance. */
export function pointAlong(route: readonly Tile[], p: number): Tile {
  if (!route.length) return { x: 0, y: 0 };
  if (route.length === 1 || p <= 0) return { ...route[0]! };
  if (p >= 1) return { ...route[route.length - 1]! };
  let left = routeLength(route) * p;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= seg && seg > 0) {
      const k = left / seg;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    left -= seg;
  }
  return { ...route[route.length - 1]! };
}

export function tripMs(route: readonly Tile[], timing: MotionTiming = MOTION_TIMING): number {
  const len = routeLength(route);
  if (len === 0) return 0;
  const ms = (len / timing.tilesPerSecond) * 1000;
  return Math.min(timing.maxTripMs, Math.max(timing.minTripMs, ms));
}

/* ------------------------------------------------------------------ *
 * 5. The controller
 * ------------------------------------------------------------------ */

export interface BodyMotion {
  state: MotionState;
  /**
   * Resting at its home plot with nobody running it (MOTION.md §3, "Resting at
   * plot"). Still `resting` — the same state, not a parallel one — but with no
   * signals behind it at all, so it takes no errand: it never walks, works,
   * faults or stalls. Waking up is the body reappearing as a live body.
   */
  away?: boolean;
  /** The errand the body is currently acting on. */
  errand: Errand;
  /** A different errand the signals now show, not yet committed. */
  pending: Errand | null;
  /** When `pending` first appeared (or when its work started, if known earlier). */
  pendingSince: number;
  /** The route being walked (tile polyline). Length 1 = standing. */
  route: Tile[];
  routeStart: number;
  routeMs: number;
  /** When the body arrived at its current destination; null while walking. */
  arrivedAt: number | null;
  /** When the work at the current site stopped being in flight; null while it is. */
  workEndedAt: number | null;
}

export interface MotionContext {
  now: number;
  /** The body's home seat. */
  home: Tile;
  /** Where this body would stand for a given errand (slot, board, approach tile). */
  destinationFor(errand: Errand): Tile;
  /** Path between two tiles. */
  path(from: Tile, to: Tile): Tile[];
  /** Reduced motion: every trip is instant. */
  reducedMotion?: boolean;
  timing?: MotionTiming;
  /** When the incoming errand's underlying work actually began, if the server said. */
  errandSince?: number | null;
}

export function restingAt(tile: Tile, now: number): BodyMotion {
  return {
    state: "resting",
    errand: { kind: "rest" },
    pending: null,
    pendingSince: now,
    route: [{ x: tile.x, y: tile.y }],
    routeStart: now,
    routeMs: 0,
    arrivedAt: now,
    workEndedAt: null,
  };
}

/* ------------------------------------------------------------------ *
 * 5a. Resting at plot
 * ------------------------------------------------------------------ */

/**
 * How bright a body resting at its plot is drawn. Below the dimmest sleeping
 * body (sleepingAlpha floors at 0.26) so it can never be mistaken for a live
 * one — even a live one about to leave.
 */
export const AWAY_ALPHA = 0.22;

/** A plot building's footprint within its 8x6 plot (mirrors the map's BUILDING anchor). */
export const PLOT_BUILDING = { dx: 2, dy: 1, w: 3, h: 3 } as const;

/**
 * The tiles a plot's resting agents lie on: every tile of the plot outside the
 * building, nearest the building's door first (south face, centre), ties broken
 * north-to-south then west-to-east so the order is total.
 */
export function plotRestTiles(rect: PlotRect): Tile[] {
  const bx0 = rect.x0 + PLOT_BUILDING.dx;
  const by0 = rect.y0 + PLOT_BUILDING.dy;
  const bx1 = bx0 + PLOT_BUILDING.w - 1;
  const by1 = by0 + PLOT_BUILDING.h - 1;
  const door = { x: bx0 + 1, y: by1 + 1 };
  const out: Tile[] = [];
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      if (x >= bx0 && x <= bx1 && y >= by0 && y <= by1) continue;
      // #45: decor slots stay clear of bodies whether or not decor is placed.
      if (isDecorSlotOffset(x - rect.x0, y - rect.y0)) continue;
      out.push({ x, y });
    }
  }
  const d = (t: Tile) => Math.abs(t.x - door.x) + Math.abs(t.y - door.y);
  return out.sort((p, q) => d(p) - d(q) || p.y - q.y || p.x - q.x);
}

/**
 * One tile per resting agent on a plot, deterministic for a given set of ids
 * (order-independent). Ids are placed in sorted order so adding one agent never
 * reshuffles the others more than a probe. Past the plot's tiles, the rest are
 * not placed: a plot shows who lives there, not a pile.
 */
export function assignRestTiles(ids: readonly string[], rect: PlotRect): Map<string, Tile> {
  const tiles = plotRestTiles(rect);
  const out = new Map<string, Tile>();
  const used = new Set<number>();
  for (const id of [...new Set(ids)].sort()) {
    if (used.size >= tiles.length) break;
    let i = hash32(id) % tiles.length;
    while (used.has(i)) i = (i + 1) % tiles.length;
    used.add(i);
    out.set(id, tiles[i]!);
  }
  return out;
}

/** A body resting at its plot: `resting`, standing, and inert. */
export function restingAway(tile: Tile, now: number): BodyMotion {
  return { ...restingAt(tile, now), away: true };
}

/** Where the body is this instant. Eased per trip, linear by distance along the route. */
export function positionOf(m: BodyMotion, now: number): Tile {
  if (m.routeMs <= 0 || m.route.length < 2) return { ...m.route[m.route.length - 1]! };
  const p = Math.min(1, Math.max(0, (now - m.routeStart) / m.routeMs));
  return pointAlong(m.route, easeInOut(p));
}

export function isWalking(m: BodyMotion, now: number): boolean {
  return m.routeMs > 0 && m.route.length >= 2 && now - m.routeStart < m.routeMs;
}

export function destinationOf(m: BodyMotion): Tile {
  return m.route[m.route.length - 1]!;
}

function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

/** Errands that pre-empt dwell and commit: the truth about a fault must not wait politely. */
function urgent(e: Errand): boolean {
  return e.kind === "fault" || e.kind === "stall" || e.kind === "sleep" || e.kind === "blocked";
}

function stateFor(errand: Errand, walking: boolean): MotionState {
  switch (errand.kind) {
    case "rest":
      return walking ? "returning" : "resting";
    case "work":
      return walking ? "dispatched" : "working";
    case "fault":
      return "faulted";
    case "blocked":
      return "blocked";
    case "stall":
      return "stalled";
    case "sleep":
      return "asleep";
    case "approach":
      return "approaching";
  }
}

function sameTile(a: Tile, b: Tile): boolean {
  return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}

/**
 * Advance one body. Call once per frame (or per poll) with the errand the
 * signals show NOW; the controller decides whether to act on it yet.
 *
 * The rules, in order:
 *  1. Stall and fault freeze the body where it is — no trip, because nothing
 *     is known about where the work went. Sleep and blocked walk (home, Board).
 *  2. A non-urgent change must hold for `commitMs` before a trip starts.
 *  3. Leaving a work site waits for min dwell and for the linger after the
 *     work ended, so tool→think→tool bursts coalesce into one visit.
 *  4. A committed change mid-walk retargets from where the body is now.
 */
export function stepMotion(prev: BodyMotion, incoming: Errand, ctx: MotionContext): BodyMotion {
  // Resting at plot: no signal reaches a body nobody runs, so nothing moves it.
  if (prev.away) return prev;
  const timing = ctx.timing ?? MOTION_TIMING;
  const now = ctx.now;
  const m: BodyMotion = { ...prev, route: prev.route };
  const walking = isWalking(m, now);
  if (!walking && m.arrivedAt === null) m.arrivedAt = m.routeStart + m.routeMs;

  // Same errand as the one being acted on: clear any pending change, refresh
  // the destination if it moved (a slot reassigned, a target that walked).
  if (sameErrand(incoming, m.errand)) {
    m.pending = null;
    if (m.errand.kind === "work") m.workEndedAt = null;
    const want = ctx.destinationFor(incoming);
    const frozen = incoming.kind === "stall" || incoming.kind === "fault";
    if (!frozen && !sameTile(destinationOf(m), want)) {
      return walkTo(m, incoming, want, ctx, timing);
    }
    m.state = stateFor(m.errand, isWalking(m, now));
    return m;
  }

  // Work at this site just stopped. Remember when, for the linger.
  if (m.errand.kind === "work" && m.workEndedAt === null) m.workEndedAt = now;

  if (!m.pending || !sameErrand(m.pending, incoming)) {
    m.pending = incoming;
    m.pendingSince = Math.min(now, ctx.errandSince ?? now);
  }

  if (urgent(incoming)) return commit(m, incoming, ctx, timing);

  // Rule 2: commit.
  if (now - m.pendingSince < timing.commitMs) {
    m.state = stateFor(m.errand, isWalking(m, now));
    return m;
  }

  // Rule 3: dwell + linger at a work site, only once actually arrived there.
  if (m.errand.kind === "work" && !isWalking(m, now)) {
    const arrived = m.arrivedAt ?? now;
    const ended = m.workEndedAt ?? now;
    const free = Math.max(arrived + timing.minDwellMs, ended + timing.lingerMs);
    if (now < free) {
      m.state = "working";
      return m;
    }
  }
  return commit(m, incoming, ctx, timing);
}

function commit(m: BodyMotion, errand: Errand, ctx: MotionContext, timing: MotionTiming): BodyMotion {
  m.pending = null;
  if (errand.kind === "stall" || errand.kind === "fault") {
    // Freeze exactly where the body is this instant.
    const here = positionOf(m, ctx.now);
    return {
      ...m,
      errand,
      state: stateFor(errand, false),
      route: [here],
      routeStart: ctx.now,
      routeMs: 0,
      arrivedAt: ctx.now,
      workEndedAt: m.errand.kind === "work" ? (m.workEndedAt ?? ctx.now) : null,
    };
  }
  return walkTo(m, errand, ctx.destinationFor(errand), ctx, timing);
}

function walkTo(m: BodyMotion, errand: Errand, dest: Tile, ctx: MotionContext, timing: MotionTiming): BodyMotion {
  const here = positionOf(m, ctx.now);
  const start = { x: Math.round(here.x), y: Math.round(here.y) };
  let route = simplifyRoute(ctx.path(start, dest));
  // Begin from the exact interpolated position so a retarget never jumps.
  if (route.length && (route[0]!.x !== here.x || route[0]!.y !== here.y)) {
    route = [here, ...route.slice(sameTile(route[0]!, here) ? 1 : 0)];
    if (route.length === 1) route.push({ ...dest });
  }
  const ms = ctx.reducedMotion ? 0 : tripMs(route, timing);
  const standing = ms === 0 || route.length < 2;
  return {
    ...m,
    errand,
    pending: null,
    state: stateFor(errand, !standing),
    route: standing ? [{ x: dest.x, y: dest.y }] : route,
    routeStart: ctx.now,
    routeMs: standing ? 0 : ms,
    arrivedAt: standing ? ctx.now : null,
    workEndedAt: errand.kind === "work" ? null : m.workEndedAt,
  };
}
