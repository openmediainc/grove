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
 * into REPLAY_TICK_MS ticks; at every tick the director is synced if (and only
 * if) the signals changed, then every body is framed at that tick. The state at
 * any tick is therefore a function of the window alone. A seek backwards, or
 * forwards by more than the warm-up, rebuilds a fresh director from
 * REPLAY_WARMUP_MS before the target — longer than any motion timer
 * (commit 1.2s, dwell 4s, linger 2.5s, trip ≤3.5s), so a seek lands where
 * playing up to it would have, and the first sync there places bodies where
 * their signals put them, exactly as a page load does live.
 */
import type { Tile } from "@grove/protocol";
import { MotionDirector, spanFromWire, type BodyFrame, type MotionActor } from "@/lib/motion/director";
import { groveVerb, VERB_LABEL, type AgentVerb } from "@/lib/agent-verbs";
import type { ReplayWireBody } from "./controller";

export const REPLAY_TICK_MS = 100;
export const REPLAY_WARMUP_MS = 60_000;

export interface ReplayMotionSource {
  /** Changes exactly when the motion inputs change. */
  signalKey(t: number): string;
  /** Minimap-shaped bodies at historical time t. */
  bodiesAt(t: number): ReplayWireBody[];
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
  }

  static tickOf(t: number): number {
    return Math.floor(t / REPLAY_TICK_MS) * REPLAY_TICK_MS;
  }

  /** Bring the director to the tick containing `t`. */
  advanceTo(t: number): void {
    const target = ReplayMotion.tickOf(t);
    if (this.at === target) return;
    if (this.at === null || target < this.at || target - this.at > REPLAY_WARMUP_MS) {
      this.reset();
      this.at = target - REPLAY_WARMUP_MS - REPLAY_TICK_MS;
    }
    while (this.at! < target) {
      this.at! += REPLAY_TICK_MS;
      this.step(this.at!);
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
    }
    const reduced = this.reducedMotion();
    for (const id of this.ids) this.director.frame(id, this.homes.get(id) ?? { x: 0, y: 0 }, tick, reduced);
  }

  /** What the renderer draws for one body at `t`. Framed at the tick, so it is idempotent. */
  frame(id: string, home: Tile, t: number): BodyFrame {
    this.advanceTo(t);
    return this.director.frame(id, home, this.at!, this.reducedMotion());
  }

  /** The injected clock the renderer uses for anything motion-timed (outcome marks). */
  get now(): number {
    return this.at ?? 0;
  }
}
