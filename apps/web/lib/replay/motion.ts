/**
 * Replay bodies move through the SAME MotionDirector as live ones.
 *
 * Live, the director is synced when a poll or an SSE event lands and asked
 * for a frame every animation frame, both on the wall clock. Replay cannot use
 * either cadence and stay deterministic: a poll every 250ms of wall time is a
 * different historical instant at 1x than at 60x, and the director's commit /
 * dwell / linger timers would fire at different moments on a fast machine and
 * a slow one.
 *
 * So replay injects the clock and fixes the cadence. Historical time is cut
 * into REPLAY_TICK_MS ticks, and the tick sequence is a function of the window
 * alone: from the window's start, and after every signal change for
 * REPLAY_SETTLE_MS (longer than any motion timer: commit 1.2s + dwell 4s +
 * linger 2.5s + trip ≤3.5s), the director is synced on a change and every body
 * is framed at every tick. Once settled, nothing in the model can move until
 * the next signal change, so the clock jumps straight to it.
 *
 * Motion has memory a warm-up cannot recover — "silence freezes": a stalled
 * body stays wherever it was working, hours later — so a seek does not start
 * over. The director is checkpointed every REPLAY_CHECKPOINT_MS of history as
 * the simulation passes, and a seek resumes from the nearest checkpoint at or
 * before the target, running the identical tick sequence from there. Seeking
 * to t and playing to t therefore produce the same frame, which the web test
 * suite asserts.
 */
import type { Tile } from "@grove/protocol";
import { MotionDirector, spanFromWire, type BodyFrame, type MotionActor } from "@/lib/motion/director";
import { groveVerb, VERB_LABEL, type AgentVerb } from "@/lib/agent-verbs";
import type { ReplayWireBody } from "./controller";

export const REPLAY_TICK_MS = 100;
export const REPLAY_SETTLE_MS = 15_000;
export const REPLAY_CHECKPOINT_MS = 30_000;

export interface ReplayMotionSource {
  /** Changes when the loaded window changes. */
  readonly epoch: number;
  /** Changes exactly when the motion inputs change. */
  signalKey(t: number): string;
  /** Minimap-shaped bodies at historical time t. */
  bodiesAt(t: number): ReplayWireBody[];
  /** The first instant after t at which signalKey changes, or null. */
  nextSignalChange(t: number): number | null;
  /** Where the loaded window starts. */
  readonly windowStart: number;
}

/** A deep copy of a director. Its state is plain data (Maps, Sets, objects); the grid is shared. */
function cloneDirector(d: MotionDirector): MotionDirector {
  const copy = Object.create(MotionDirector.prototype) as MotionDirector;
  for (const [k, v] of Object.entries(d)) {
    (copy as unknown as Record<string, unknown>)[k] = k === "grid" ? v : structuredClone(v);
  }
  return copy;
}

interface MotionCheckpoint {
  at: number;
  key: string;
  ids: string[];
  homes: ReadonlyMap<string, Tile>;
  settleUntil: number;
  director: MotionDirector;
}

/**
 * The same verb rule the map applies to a live minimap body: a current pulse
 * verb wins, otherwise infer from presence. In replay a body carries a verb
 * only while a historical span covers the instant, so "current" is exact.
 */
export function motionActorOf(b: ReplayWireBody): MotionActor {
  const pulsed = b.verb && b.verb in VERB_LABEL ? (b.verb as AgentVerb) : null;
  return {
    id: b.id,
    verb: pulsed ?? groveVerb(b.activity, b.connection),
    stalled: b.stalled,
    connection: b.connection,
    source: "grove",
    pulsedAt: b.pulsed_at,
    toolCalls: (b.tool_calls ?? []).map((s) => spanFromWire(s as unknown as Record<string, unknown>) ?? s),
  };
}

export class ReplayMotion {
  private director = new MotionDirector();
  private at: number | null = null;
  private key = "";
  private ids: string[] = [];
  private homes: ReadonlyMap<string, Tile> = new Map();
  private settleUntil = -Infinity;
  private epoch = -1;
  private checkpoints: MotionCheckpoint[] = [];

  constructor(
    private source: ReplayMotionSource,
    /** Home seats for a set of bodies: the map's own seating, passed in. */
    private homesFor: (bodies: ReplayWireBody[]) => ReadonlyMap<string, Tile>,
    private reducedMotion: () => boolean = () => false,
  ) {}

  /** Forget everything (a new window). */
  reset(): void {
    this.director = new MotionDirector();
    this.at = null;
    this.key = "";
    this.ids = [];
    this.homes = new Map();
    this.settleUntil = -Infinity;
    this.checkpoints = [];
  }

  static tickOf(t: number): number {
    return Math.floor(t / REPLAY_TICK_MS) * REPLAY_TICK_MS;
  }

  private startTick(): number {
    return ReplayMotion.tickOf(this.source.windowStart) - REPLAY_TICK_MS;
  }

  private restore(cp: MotionCheckpoint): void {
    this.at = cp.at;
    this.key = cp.key;
    this.ids = cp.ids;
    this.homes = cp.homes;
    this.settleUntil = cp.settleUntil;
    this.director = cloneDirector(cp.director);
  }

  private checkpoint(): void {
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (last && last.at >= this.at!) return;
    this.checkpoints.push({
      at: this.at!,
      key: this.key,
      ids: this.ids,
      homes: this.homes,
      settleUntil: this.settleUntil,
      director: cloneDirector(this.director),
    });
  }

  /** Bring the director to the tick containing `t`. */
  advanceTo(t: number): void {
    if (this.epoch !== this.source.epoch) {
      this.reset();
      this.epoch = this.source.epoch;
    }
    const target = Math.max(ReplayMotion.tickOf(t), this.startTick());
    if (this.at === target) return;
    if (this.at === null || target < this.at) {
      // Resume from the nearest checkpoint at or before the target, else the start.
      let cp: MotionCheckpoint | null = null;
      for (let i = this.checkpoints.length - 1; i >= 0; i--) {
        if (this.checkpoints[i]!.at <= target) {
          cp = this.checkpoints[i]!;
          break;
        }
      }
      if (cp) this.restore(cp);
      else {
        this.director = new MotionDirector();
        this.at = this.startTick();
        this.key = "";
        this.ids = [];
        this.homes = new Map();
        this.settleUntil = -Infinity;
      }
    } else {
      // Going forwards past saved history: continue from the furthest checkpoint
      // if it is ahead of where we stand (a seek into ground already simulated).
      const last = this.checkpoints[this.checkpoints.length - 1];
      if (last && last.at > this.at && last.at <= target) this.restore(last);
    }
    while (this.at! < target) {
      let next = this.at! + REPLAY_TICK_MS;
      if (next > this.settleUntil) {
        // Settled: nothing can move until the signals change. Jump to the tick
        // before the change, stopping at checkpoint boundaries on the way.
        const change = this.source.nextSignalChange(this.at!);
        const changeTick = change === null ? Infinity : Math.ceil(change / REPLAY_TICK_MS) * REPLAY_TICK_MS;
        const boundary = (Math.floor(this.at! / REPLAY_CHECKPOINT_MS) + 1) * REPLAY_CHECKPOINT_MS;
        const jump = Math.min(target, changeTick - REPLAY_TICK_MS, boundary);
        if (jump > this.at!) {
          this.at = jump;
          if (this.at % REPLAY_CHECKPOINT_MS === 0) this.checkpoint();
          continue;
        }
        next = this.at! + REPLAY_TICK_MS;
      }
      this.at = next;
      this.step(next);
      if (next % REPLAY_CHECKPOINT_MS === 0) this.checkpoint();
    }
  }

  private step(tick: number): void {
    const key = this.source.signalKey(tick);
    if (key !== this.key) {
      this.key = key;
      const bodies = this.source.bodiesAt(tick);
      this.homes = this.homesFor(bodies);
      this.ids = bodies.map((b) => b.id);
      this.director.sync(bodies.map(motionActorOf), this.homes, tick);
      this.settleUntil = tick + REPLAY_SETTLE_MS;
    }
    const reduced = this.reducedMotion();
    for (const id of this.ids) this.director.frame(id, this.homes.get(id) ?? { x: 0, y: 0 }, tick, reduced);
  }

  /**
   * What the renderer draws for one body at `t`. Read-only: the director is
   * advanced on the fixed tick sequence and then asked for a frame on a COPY,
   * so however often the renderer asks, the simulation is never nudged.
   */
  frame(id: string, home: Tile, t: number): BodyFrame {
    this.advanceTo(t);
    if (!this.peek || this.peekAt !== this.at || this.peekKey !== this.key) {
      this.peek = cloneDirector(this.director);
      this.peekAt = this.at;
      this.peekKey = this.key;
    }
    return this.peek.frame(id, home, this.at!, this.reducedMotion());
  }

  private peek: MotionDirector | null = null;
  private peekAt: number | null = null;
  private peekKey = "";

  /** The injected clock the renderer uses for anything motion-timed (outcome marks). */
  get now(): number {
    return this.at ?? 0;
  }
}
