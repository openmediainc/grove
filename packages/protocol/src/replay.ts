/**
 * Replay timeline: the ledger window from GET /api/v1/replay, turned into
 * "what the world looked like at time t".
 *
 * Pure. No clock, no randomness, no DOM. The same window always yields the
 * same steps in the same order, and `stateAt(t)` is a function of the window
 * and `t` alone — which is what makes "replaying the same window twice renders
 * the same" a property of this file rather than a hope about the renderer.
 *
 * SCRUBBING IS NOT REPLAY-FROM-ZERO. A busy hour is tens of thousands of steps.
 * Every CHECKPOINT_EVERY steps the build keeps a frozen copy of the state, so a
 * seek anywhere is "clone the nearest checkpoint, apply at most
 * CHECKPOINT_EVERY steps". Forward playback is cheaper still: the last answer is
 * cached and advanced incrementally.
 *
 * WHAT A BODY IS, HISTORICALLY. The ledger says where a body walked
 * (actor_joined_room), when it left (actor_left_room), what it said (speech)
 * and — for an owner or operator only — what it was doing (agent_phase spans).
 * It does not hold presence snapshots, so:
 *   - a body is on the map from the keyframe or its join until its leave;
 *   - a speaker the window never saw arrive is placed in the room it spoke in,
 *     because speaking there is evidence of being there;
 *   - a work span with no room is remembered per actor and shown whenever that
 *     body is on the map; it never conjures a body by itself.
 * Nothing here invents a position, a verb or a line the server did not send.
 */

/** Steps between frozen checkpoints. */
export const REPLAY_CHECKPOINT_EVERY = 256;

export type ReplayMarkerKind = "fault" | "arrival" | "span" | "speech";

export interface ReplayActorRef {
  id: string;
  kind: string;
  displayName: string;
  slug: string | null;
}

/** One ledger entry, normalised from the wire (snake_case or camelCase). */
export interface ReplayEvent {
  id: string;
  type: string;
  kind: string;
  createdAt: string;
  actor: ReplayActorRef | null;
  roomId: string | null;
  roomName: string | null;
  summary: string;
  body: string | null;
  bodyWithheld: boolean;
  detail: Record<string, unknown>;
}

export interface ReplayKeyframeBodyInput {
  actorId: string;
  kind: string;
  displayName: string;
  slug: string | null;
  roomId: string | null;
  roomName: string | null;
  since: string;
  eventId: string;
}

export interface ReplayWindowInput {
  since: string;
  until: string;
  keyframe: ReplayKeyframeBodyInput[];
  /** Every entry of every page plus `trailing`, in any order; duplicates are dropped. */
  entries: ReplayEvent[];
}

export interface ReplayBody {
  id: string;
  kind: string;
  name: string;
  slug: string | null;
  roomId: string | null;
  roomName: string | null;
  /** Timeline ms when it arrived where it stands. */
  enteredAt: number;
  lastLine: { at: number; body: string | null; withheld: boolean } | null;
}

export interface ReplayPhase {
  eventId: string;
  verb: string;
  detail: string | null;
  url: string | null;
  errorText: string | null;
  startedAt: number;
  endedAt: number;
  silent: boolean;
}

export interface ReplayState {
  bodies: Map<string, ReplayBody>;
  phases: Map<string, ReplayPhase>;
}

export interface ReplayMarker {
  at: number;
  endAt: number | null;
  kind: ReplayMarkerKind;
  eventId: string;
  actorId: string | null;
  label: string;
}

/** A body as the map should draw it at one instant. */
export interface ReplayFrameBody {
  id: string;
  kind: string;
  name: string;
  slug: string | null;
  roomId: string | null;
  roomName: string | null;
  enteredAt: number;
  /** The span covering this instant, if this viewer may see spans at all. */
  phase: ReplayPhase | null;
  /** A line said within `lineMs` before this instant. */
  line: { at: number; body: string | null; withheld: boolean } | null;
}

type Op = "join" | "leave" | "speak" | "phaseStart" | "phaseEnd";

interface Step {
  at: number;
  op: Op;
  ev: ReplayEvent;
  id: bigint;
}

/* ------------------------------------------------------------------ *
 * wire normalisation
 * ------------------------------------------------------------------ */

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function pickKey(raw: Record<string, unknown>, camel: string): unknown {
  if (raw[camel] !== undefined) return raw[camel];
  const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return raw[snake];
}

/** Accept a chronicle entry in either casing (sendOk snake-cases the wire). */
export function normaliseReplayEvent(raw: Record<string, unknown>): ReplayEvent {
  const a = pickKey(raw, "actor") as Record<string, unknown> | null | undefined;
  return {
    id: String(raw.id),
    type: String(raw.type),
    kind: String(raw.kind ?? "other"),
    createdAt: String(pickKey(raw, "createdAt")),
    actor: a
      ? {
          id: String(a.id),
          kind: String(a.kind ?? "unknown"),
          displayName: String(pickKey(a, "displayName") ?? a.slug ?? a.id),
          slug: str(a.slug),
        }
      : null,
    roomId: str(pickKey(raw, "roomId")),
    roomName: str(pickKey(raw, "roomName")),
    summary: String(raw.summary ?? ""),
    body: str(raw.body),
    bodyWithheld: Boolean(pickKey(raw, "bodyWithheld")),
    detail: ((raw.detail as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>,
  };
}

export function normaliseKeyframeBody(raw: Record<string, unknown>): ReplayKeyframeBodyInput {
  return {
    actorId: String(pickKey(raw, "actorId")),
    kind: String(raw.kind ?? "unknown"),
    displayName: String(pickKey(raw, "displayName") ?? raw.slug ?? pickKey(raw, "actorId")),
    slug: str(raw.slug),
    roomId: str(pickKey(raw, "roomId")),
    roomName: str(pickKey(raw, "roomName")),
    since: String(raw.since),
    eventId: String(pickKey(raw, "eventId")),
  };
}

/* ------------------------------------------------------------------ *
 * build
 * ------------------------------------------------------------------ */

const OP_RANK: Record<Op, number> = { phaseEnd: 0, leave: 1, join: 2, phaseStart: 3, speak: 4 };

function compareSteps(p: Step, q: Step): number {
  if (p.at !== q.at) return p.at - q.at;
  if (OP_RANK[p.op] !== OP_RANK[q.op]) return OP_RANK[p.op] - OP_RANK[q.op];
  return p.id < q.id ? -1 : p.id > q.id ? 1 : 0;
}

function parseMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function toBigInt(id: string): bigint {
  return /^\d+$/.test(id) ? BigInt(id) : 0n;
}

function cloneState(s: ReplayState): ReplayState {
  const bodies = new Map<string, ReplayBody>();
  for (const [k, b] of s.bodies) bodies.set(k, { ...b, lastLine: b.lastLine ? { ...b.lastLine } : null });
  const phases = new Map<string, ReplayPhase>();
  for (const [k, p] of s.phases) phases.set(k, p);
  return { bodies, phases };
}

const FAULT_VERBS = new Set(["error", "blocked", "offline"]);

export class ReplayTimeline {
  readonly since: number;
  readonly until: number;
  readonly markers: ReplayMarker[];
  private readonly steps: Step[];
  private readonly initial: ReplayState;
  private readonly checkpoints: Array<{ index: number; state: ReplayState }>;
  private cache: { index: number; state: ReplayState } | null = null;

  private constructor(since: number, until: number, initial: ReplayState, steps: Step[], markers: ReplayMarker[]) {
    this.since = since;
    this.until = until;
    this.initial = initial;
    this.steps = steps;
    this.markers = markers;
    this.checkpoints = [{ index: 0, state: cloneState(initial) }];
    const running = cloneState(initial);
    for (let i = 0; i < steps.length; i++) {
      applyStep(running, steps[i]!);
      if ((i + 1) % REPLAY_CHECKPOINT_EVERY === 0) this.checkpoints.push({ index: i + 1, state: cloneState(running) });
    }
  }

  static build(input: ReplayWindowInput): ReplayTimeline {
    const since = Date.parse(input.since);
    const until = Date.parse(input.until);

    const initial: ReplayState = { bodies: new Map(), phases: new Map() };
    const keyframe = [...input.keyframe].sort((p, q) => {
      const a = toBigInt(p.eventId);
      const b = toBigInt(q.eventId);
      return a < b ? -1 : a > b ? 1 : p.actorId < q.actorId ? -1 : 1;
    });
    for (const k of keyframe) {
      initial.bodies.set(k.actorId, {
        id: k.actorId,
        kind: k.kind,
        name: k.displayName,
        slug: k.slug,
        roomId: k.roomId,
        roomName: k.roomName,
        enteredAt: Math.min(Date.parse(k.since), since),
        lastLine: null,
      });
    }

    const seen = new Set<string>();
    const steps: Step[] = [];
    for (const ev of input.entries) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      const at = parseMs(ev.createdAt) ?? since;
      const id = toBigInt(ev.id);
      switch (ev.type) {
        case "actor_joined_room":
          if (ev.actor) steps.push({ at, op: "join", ev, id });
          break;
        case "actor_left_room":
          if (ev.actor) steps.push({ at, op: "leave", ev, id });
          break;
        case "speech":
          if (ev.actor) steps.push({ at, op: "speak", ev, id });
          break;
        case "agent_phase": {
          if (!ev.actor) break;
          const start = parseMs(ev.detail.started_at) ?? at;
          const end = parseMs(ev.detail.ended_at) ?? at;
          steps.push({ at: start, op: "phaseStart", ev, id });
          steps.push({ at: Math.max(start, end), op: "phaseEnd", ev, id });
          break;
        }
        default:
          break;
      }
    }
    steps.sort(compareSteps);

    // Markers are derived by walking the steps once, so "arrival" can mean
    // arriving on the map rather than every room-to-room move.
    const markers: ReplayMarker[] = [];
    const probe = cloneState(initial);
    for (const step of steps) {
      const ev = step.ev;
      const actorId = ev.actor?.id ?? null;
      if (step.op === "join" && actorId && !probe.bodies.has(actorId)) {
        markers.push({ at: step.at, endAt: null, kind: "arrival", eventId: ev.id, actorId, label: ev.summary });
      } else if (step.op === "speak") {
        markers.push({ at: step.at, endAt: null, kind: "speech", eventId: ev.id, actorId, label: ev.summary });
      } else if (step.op === "phaseStart") {
        const verb = String(ev.detail.verb ?? "");
        const fault = FAULT_VERBS.has(verb) || ev.detail.silent === true;
        const end = parseMs(ev.detail.ended_at);
        markers.push({
          at: step.at,
          endAt: end,
          kind: fault ? "fault" : "span",
          eventId: ev.id,
          actorId,
          label: ev.summary,
        });
      }
      applyStep(probe, step);
    }
    // Events with no body effect still mark the line (stage windows).
    for (const ev of input.entries) {
      if (ev.type !== "stage.started") continue;
      const start = parseMs(ev.detail.startsAt ?? ev.detail.starts_at) ?? parseMs(ev.createdAt);
      if (start === null) continue;
      markers.push({
        at: start,
        endAt: parseMs(ev.detail.endsAt ?? ev.detail.ends_at),
        kind: "span",
        eventId: ev.id,
        actorId: null,
        label: ev.summary,
      });
    }
    markers.sort((p, q) => p.at - q.at || (toBigInt(p.eventId) < toBigInt(q.eventId) ? -1 : 1));

    return new ReplayTimeline(since, until, initial, steps, markers);
  }

  get stepCount(): number {
    return this.steps.length;
  }

  /** When the next step after `t` happens, or null. */
  nextStepAfter(t: number): number | null {
    const i = this.indexAt(t);
    return i < this.steps.length ? this.steps[i]!.at : null;
  }

  /** Number of steps at or before `t`: changes exactly when the state at `t` can. */
  stepIndexAt(t: number): number {
    return this.indexAt(t);
  }

  /** Number of steps at or before `t`. */
  private indexAt(t: number): number {
    let lo = 0;
    let hi = this.steps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.steps[mid]!.at <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The world state after every step at or before `t`. The returned object is
   * shared with the cache: read it, never mutate it.
   */
  stateAt(t: number): ReplayState {
    const index = this.indexAt(t);
    const cached = this.cache;
    if (cached && cached.index === index) return cached.state;
    if (cached && cached.index < index && index - cached.index <= REPLAY_CHECKPOINT_EVERY) {
      for (let i = cached.index; i < index; i++) applyStep(cached.state, this.steps[i]!);
      cached.index = index;
      return cached.state;
    }
    let lo = 0;
    let hi = this.checkpoints.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.checkpoints[mid]!.index <= index) lo = mid;
      else hi = mid - 1;
    }
    const cp = this.checkpoints[lo]!;
    const state = cloneState(cp.state);
    for (let i = cp.index; i < index; i++) applyStep(state, this.steps[i]!);
    this.cache = { index, state };
    return state;
  }

  /** The same answer as stateAt, computed from the keyframe with no checkpoint. For tests. */
  stateFromZero(t: number): ReplayState {
    const state = cloneState(this.initial);
    const index = this.indexAt(t);
    for (let i = 0; i < index; i++) applyStep(state, this.steps[i]!);
    return state;
  }

  /** What to draw at `t`: bodies in a stable (id) order, each with its covering span and fresh line. */
  frameAt(t: number, opts: { lineMs: number }): ReplayFrameBody[] {
    const state = this.stateAt(t);
    const out: ReplayFrameBody[] = [];
    const ids = [...state.bodies.keys()].sort();
    for (const id of ids) {
      const b = state.bodies.get(id)!;
      const p = state.phases.get(id) ?? null;
      const phase = p && p.startedAt <= t && t < p.endedAt ? p : null;
      const line = b.lastLine && t - b.lastLine.at <= opts.lineMs ? b.lastLine : null;
      out.push({
        id: b.id,
        kind: b.kind,
        name: b.name,
        slug: b.slug,
        roomId: b.roomId,
        roomName: b.roomName,
        enteredAt: b.enteredAt,
        phase,
        line,
      });
    }
    return out;
  }

  /** Steps per bucket across the window, for a scrubber drawn from loaded data. */
  density(buckets: number): number[] {
    const n = Math.max(1, Math.trunc(buckets));
    const out = new Array<number>(n).fill(0);
    const span = Math.max(1, this.until - this.since);
    for (const s of this.steps) {
      if (s.op === "phaseEnd") continue;
      const i = Math.floor(((s.at - this.since) / span) * n);
      out[Math.max(0, Math.min(n - 1, i))]! += 1;
    }
    return out;
  }
}

function applyStep(state: ReplayState, step: Step): void {
  const ev = step.ev;
  const actor = ev.actor;
  if (!actor) return;
  switch (step.op) {
    case "join": {
      const prev = state.bodies.get(actor.id);
      state.bodies.set(actor.id, {
        id: actor.id,
        kind: actor.kind,
        name: actor.displayName,
        slug: actor.slug,
        roomId: ev.roomId,
        roomName: ev.roomName,
        enteredAt: step.at,
        lastLine: prev?.lastLine ?? null,
      });
      return;
    }
    case "leave":
      state.bodies.delete(actor.id);
      return;
    case "speak": {
      const prev = state.bodies.get(actor.id);
      const line = { at: step.at, body: ev.body, withheld: ev.bodyWithheld };
      if (prev) {
        prev.lastLine = line;
      } else if (ev.roomId) {
        state.bodies.set(actor.id, {
          id: actor.id,
          kind: actor.kind,
          name: actor.displayName,
          slug: actor.slug,
          roomId: ev.roomId,
          roomName: ev.roomName,
          enteredAt: step.at,
          lastLine: line,
        });
      }
      return;
    }
    case "phaseStart": {
      const d = ev.detail;
      const start = step.at;
      const end = parseMs(d.ended_at) ?? start;
      state.phases.set(actor.id, {
        eventId: ev.id,
        verb: String(d.verb ?? "idle"),
        detail: str(d.detail),
        url: str(d.url),
        errorText: str(d.error_text),
        startedAt: start,
        endedAt: Math.max(start, end),
        silent: d.silent === true,
      });
      return;
    }
    case "phaseEnd": {
      const cur = state.phases.get(actor.id);
      if (cur && cur.eventId === ev.id) state.phases.delete(actor.id);
      return;
    }
  }
}
