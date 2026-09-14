/**
 * The map's side of docs/design/MOTION.md.
 *
 * packages/protocol/src/motion.ts decides; this adapts it to what the map
 * actually has (actors from the minimap, home seats, the dressing's blocked
 * tiles) and remembers per-body state between frames. WorldMap asks it one
 * question per body per frame — "where is this body, and what is it doing
 * about its errand?" — and draws the answer.
 *
 * Nothing here invents a signal. Every errand comes from errandFor() over
 * server fields; every outcome mark comes from a span the server says finished.
 */
import {
  assignWorkSlots,
  doorTile,
  errandFor,
  facingScreenDir,
  facingStepTile,
  findPath,
  positionOf,
  restingAt,
  stepMotion,
  type AgentVerb,
  type BodyMotion,
  type Errand,
  type MotionState,
  type SiteRequest,
  type Tile,
  type ToolCallOutcome,
  type ToolCallView,
  type WorldGrid,
} from "@grove/protocol";
import { pathMaskAt, tileBlocked } from "@/components/worldDressing";

/** The campus as bodies walk it. */
export const CAMPUS_GRID: WorldGrid = {
  blocked: (tx, ty) => tileBlocked(tx, ty),
  isPath: (tx, ty) => pathMaskAt(tx, ty) >= 0,
};

/** What the director needs to know about a body, straight off the actor. */
export interface MotionActor {
  id: string;
  verb: AgentVerb;
  stalled?: boolean;
  connection?: string | null;
  /** Paperclip bodies have no spans and no home to leave: they are placed, not dispatched. */
  source: "grove" | "paperclip";
  pulsedAt?: string | null;
  toolCalls?: ToolCallView[];
  /**
   * A body this one just addressed in public (#60, protocol facing.ts): a
   * server-derived hint, never a whisper. Ignored once `addressingUntil` passes.
   */
  addressing?: string | null;
  /** When the hint lapses (ms). */
  addressingUntil?: number | null;
}

/** How long a finish mark plays on the body. The result itself stays on the hover card. */
export const OUTCOME_MARK_MS = 2600;
/** A finish older than this when first seen (page load, a slow poll) is not replayed as news. */
const OUTCOME_FRESH_MS = 9000;

export interface OutcomeMark {
  outcome: ToolCallOutcome;
  at: number;
}

export interface BodyFrame {
  x: number;
  y: number;
  state: MotionState;
  /** The open span the body is working on, if any: drives the work bar. */
  span: ToolCallView | null;
  /** A finish that is still playing, if any. */
  mark: OutcomeMark | null;
  /**
   * Which way the body turns to face someone it just addressed in public:
   * -1 screen-left, 1 screen-right, 0 no turn. Reduced motion keeps the turn.
   */
  face: -1 | 0 | 1;
}

type Signals = {
  errand: Errand;
  since: number | null;
  open: ToolCallView[];
  destination: Tile | null;
  /** Approach only: when the hint lapses, and the addressee's id. */
  until: number | null;
  target: string | null;
};

export class MotionDirector {
  private motion = new Map<string, BodyMotion>();
  private signals = new Map<string, Signals>();
  private marks = new Map<string, OutcomeMark>();
  /** actorId|callId of every finish already seen, so a poll never replays one. */
  private seen = new Set<string>();
  private firstSync = true;
  /**
   * When each body's CURRENT errand began, kept across polls. A pulse moves
   * pulsed_at every time it repeats; using that raw would reshuffle the slot
   * order at a busy site on every pulse and walk workers between tiles.
   */
  private began = new Map<string, { key: string; since: number | null }>();

  constructor(private grid: WorldGrid = CAMPUS_GRID) {}

  /**
   * New signals from a poll or an SSE event. `homes` is the seat each body
   * would rest at. Work slots are re-assigned here, once, not per frame.
   */
  sync(actors: readonly MotionActor[], homes: ReadonlyMap<string, Tile>, now: number): void {
    const requests: SiteRequest[] = [];
    const next = new Map<string, Signals>();
    const restingSeats = new Set<string>();
    for (const a of actors) {
      const open = (a.toolCalls ?? []).filter((s) => s.finishedAt === null && !s.stalled);
      const addressing =
        a.source !== "paperclip" && a.addressing && a.addressing !== a.id && (a.addressingUntil ?? -Infinity) > now
          ? a.addressing
          : null;
      const errand: Errand =
        a.source === "paperclip"
          ? { kind: "rest" }
          : errandFor({ verb: a.verb, stalled: a.stalled, connection: a.connection, openToolCalls: open.length, addressing });
      let since: number | null = null;
      if (open.length) since = Math.min(...open.map((s) => Date.parse(s.startedAt)).filter(Number.isFinite));
      else if (a.pulsedAt) since = Date.parse(a.pulsedAt);
      if (since !== null && !Number.isFinite(since)) since = null;
      const key = errand.kind === "work" ? `work:${errand.site}` : errand.kind;
      const prev = this.began.get(a.id);
      if (prev && prev.key === key) since = prev.since ?? since;
      else this.began.set(a.id, { key, since });
      next.set(a.id, {
        errand,
        since,
        open,
        destination: null,
        until: errand.kind === "approach" ? (a.addressingUntil ?? null) : null,
        target: errand.kind === "approach" ? errand.targetId : null,
      });
      if (errand.kind === "work") requests.push({ id: a.id, site: errand.site, since: since ?? now });
      else {
        const home = homes.get(a.id);
        if (home) restingSeats.add(`${home.x},${home.y}`);
      }
      // Finishes: a mark plays once, and only for news.
      for (const s of a.toolCalls ?? []) {
        if (!s.finishedAt || !s.outcome) continue;
        const key = `${a.id}|${s.callId}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        const age = now - Date.parse(s.finishedAt);
        if (!this.firstSync && Number.isFinite(age) && age < OUTCOME_FRESH_MS) {
          this.marks.set(a.id, { outcome: s.outcome, at: now });
        }
      }
    }
    // A board slot for blocked bodies goes through the same allocator, so two
    // blocked agents do not stand on one tile either.
    for (const a of actors) {
      const sig = next.get(a.id)!;
      if (sig.errand.kind === "blocked") requests.push({ id: a.id, site: "board", since: sig.since ?? now });
    }
    const slots = assignWorkSlots(requests, this.grid, restingSeats);
    for (const [id, sig] of next) sig.destination = slots.get(id) ?? null;
    // #60: a speaker steps at most FACING_STEP_TILES toward whom it addressed,
    // onto a tile no seat, work slot or other speaker's step holds. Speakers are
    // placed in id order so the layout is a function of the inputs alone.
    const occupied = new Set<string>();
    for (const [id, sig] of next) {
      const t = sig.destination ?? homes.get(id);
      if (t) occupied.add(`${t.x},${t.y}`);
    }
    for (const id of [...next.keys()].sort()) {
      const sig = next.get(id)!;
      if (sig.errand.kind !== "approach") continue;
      const home = homes.get(id);
      const targetSig = next.get(sig.errand.targetId);
      const target = targetSig?.destination ?? homes.get(sig.errand.targetId);
      if (!home || !target || !targetSig) {
        // Addressee not on the map: nothing to walk toward.
        sig.errand = { kind: "rest" };
        sig.until = null;
        sig.target = null;
        continue;
      }
      const mine = `${home.x},${home.y}`;
      const others = new Set(occupied);
      others.delete(mine);
      const step = facingStepTile(home, target, this.grid, others);
      if (step.x !== home.x || step.y !== home.y) occupied.add(`${step.x},${step.y}`);
      sig.destination = step;
    }
    this.signals = next;
    this.firstSync = false;
    // Forget bodies that left, and finishes old enough that no poll will carry them again.
    for (const id of [...this.motion.keys()]) if (!next.has(id)) this.motion.delete(id);
    for (const id of [...this.began.keys()]) if (!next.has(id)) this.began.delete(id);
    for (const id of [...this.marks.keys()]) if (!next.has(id)) this.marks.delete(id);
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
  }

  /** One body, this frame. Cheap: the path search only runs when a trip starts. */
  frame(id: string, home: Tile, now: number, reducedMotion: boolean): BodyFrame {
    const known = this.signals.get(id) ?? { errand: { kind: "rest" } as Errand, since: null, open: [], destination: null, until: null, target: null };
    // A hint lapses on the clock it was given, not on the next poll: then the
    // body walks back home through the ordinary commit.
    const lapsed = known.errand.kind === "approach" && (known.until === null || now >= known.until);
    const sig = lapsed ? { ...known, errand: { kind: "rest" } as Errand, destination: null, target: null } : known;
    let m = this.motion.get(id);
    if (!m) {
      // First sighting stands where the signals say, rather than walking in from
      // the home seat: a body already mid-tool-call on page load is AT the site.
      const start =
        sig.errand.kind === "rest" || sig.errand.kind === "sleep" || sig.errand.kind === "approach" ? home : (sig.destination ?? home);
      m = { ...restingAt(start, now), errand: sig.errand, state: sig.errand.kind === "work" ? "working" : "resting" };
    }
    const grid = this.grid;
    m = stepMotion(m, sig.errand, {
      now,
      home,
      reducedMotion,
      errandSince: sig.since,
      destinationFor: (e) => {
        if (e.kind === "work") return sig.destination ?? doorTile(e.site);
        if (e.kind === "blocked") return sig.destination ?? doorTile("board");
        // Reduced motion: orient only, never a walk (MOTION.md §7).
        if (e.kind === "approach") return reducedMotion ? home : (sig.destination ?? home);
        return home;
      },
      path: (from, to) => findPath(from, to, grid),
    });
    this.motion.set(id, m);
    const at = positionOf(m, now);
    let mark = this.marks.get(id) ?? null;
    if (mark && now - mark.at > OUTCOME_MARK_MS) {
      this.marks.delete(id);
      mark = null;
    }
    const span = m.state === "working" || m.state === "dispatched" ? (sig.open[0] ?? null) : null;
    let face: -1 | 0 | 1 = 0;
    if (sig.target && m.errand.kind === "approach") {
      const other = this.motion.get(sig.target);
      const there = other ? positionOf(other, now) : this.signals.get(sig.target)?.destination;
      if (there) face = facingScreenDir(at, there);
    }
    return { x: at.x, y: at.y, state: m.state, span, mark, face };
  }
}

/** A span off the wire, snake_case or camelCase, into the protocol's view. */
export function spanFromWire(raw: Record<string, unknown>): ToolCallView | null {
  const pick = (snake: string, camel: string) => (raw[snake] !== undefined ? raw[snake] : raw[camel]);
  const callId = pick("call_id", "callId");
  const name = raw.name;
  const startedAt = pick("started_at", "startedAt");
  if (typeof callId !== "string" || typeof name !== "string" || typeof startedAt !== "string") return null;
  const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const str = (v: unknown) => (v == null ? null : String(v));
  const outcome = str(raw.outcome);
  return {
    callId,
    name,
    args: str(raw.args),
    startedAt,
    updatedAt: String(pick("updated_at", "updatedAt") ?? startedAt),
    finishedAt: str(pick("finished_at", "finishedAt")),
    outcome:
      outcome === "ok" || outcome === "error" || outcome === "cancelled" || outcome === "stalled" ? outcome : null,
    progress: num(raw.progress),
    progressDone: num(pick("progress_done", "progressDone")),
    progressTotal: num(pick("progress_total", "progressTotal")),
    result: str(raw.result),
    durationMs: num(pick("duration_ms", "durationMs")),
    stalled: Boolean(raw.stalled),
  };
}

/** Merge one live span event into a body's list: replace by call id, newest first, open first. */
export function mergeSpan(list: readonly ToolCallView[] | undefined, span: ToolCallView): ToolCallView[] {
  const out = (list ?? []).filter((s) => s.callId !== span.callId);
  out.push(span);
  return out
    .sort(
      (p, q) =>
        Number(q.finishedAt === null) - Number(p.finishedAt === null) || Date.parse(q.startedAt) - Date.parse(p.startedAt),
    )
    .slice(0, 6);
}
