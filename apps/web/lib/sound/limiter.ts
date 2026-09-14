/**
 * Density limiter: the world can be very busy, the soundscape may not be.
 *
 * At most `perSecond` voices in any sliding second. A burst (many events of
 * the same kind in one sample) collapses to ONE voice carrying a count, so ten
 * agents starting a call at once is one slightly fuller pluck, not ten. Voices
 * admitted together are spread by a small gap so they never stack into a
 * chord of noise. What does not fit is dropped, never queued: a soundscape
 * that plays the last minute's backlog is lying about now.
 *
 * Priority when it has to choose: a hazard, then an arrival, a line, a
 * finish, a start. Hazards are further held to one per `hazardGapMs` so a bad
 * minute is a low tone now and then, never an alarm.
 */
import type { SoundEvent, SoundEventKind } from "./listener";

export interface LimiterOptions {
  perSecond: number;
  /** Minimum gap between two admitted voices. */
  spacingMs: number;
  hazardGapMs: number;
}

export const DEFAULT_LIMITER: LimiterOptions = { perSecond: 4, spacingMs: 140, hazardGapMs: 8_000 };

export type Scheduled = SoundEvent & { count: number; /** ms from now */ delayMs: number };

const PRIORITY: Record<SoundEventKind, number> = { hazard: 0, arrival: 1, speech: 2, finish: 3, start: 4 };

function groupKey(e: SoundEvent): string {
  switch (e.kind) {
    case "start":
      return `start|${e.verb}`;
    case "finish":
      return `finish|${e.verb}|${e.ok}`;
    default:
      return e.kind;
  }
}

/** Collapse a batch: one event per group, in priority order, with how many it stands for. */
export function collapse(events: readonly SoundEvent[]): Array<SoundEvent & { count: number }> {
  const groups = new Map<string, SoundEvent & { count: number }>();
  for (const e of events) {
    const k = groupKey(e);
    const g = groups.get(k);
    if (g) g.count++;
    else groups.set(k, { ...e, count: 1 });
  }
  return [...groups.values()].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
}

export class VoiceLimiter {
  private times: number[] = [];
  private lastHazard = -Infinity;

  constructor(private readonly opts: LimiterOptions = DEFAULT_LIMITER) {}

  reset(): void {
    this.times = [];
    this.lastHazard = -Infinity;
  }

  admit(events: readonly SoundEvent[], now: number): Scheduled[] {
    const out: Scheduled[] = [];
    this.times = this.times.filter((t) => t > now - 1000);
    for (const e of collapse(events)) {
      if (e.kind === "hazard" && now - this.lastHazard < this.opts.hazardGapMs) continue;
      const last = this.times.length ? this.times[this.times.length - 1]! : -Infinity;
      const at = Math.max(now, last + this.opts.spacingMs);
      // Voices already scheduled inside the second that `at` closes.
      const inWindow = this.times.filter((t) => t > at - 1000).length;
      if (inWindow >= this.opts.perSecond) continue;
      this.times.push(at);
      if (e.kind === "hazard") this.lastHazard = now;
      out.push({ ...e, delayMs: at - now });
    }
    return out;
  }
}
