/**
 * How alive a body's connection is, and how close it is to losing its seat.
 *
 * Grove already has three thresholds, and until now only the first was visible:
 *
 *   stall   — server-computed at `stall_after_seconds` (180): claims to be
 *             working, has not reported. Drawn since the hazard pass, as an
 *             orange triangle.
 *   offline — presence drops to `offline` after 5 minutes with no heartbeat.
 *   evicted — the presence row is DELETED after 10 minutes with no heartbeat,
 *             and the body stops being on the map at all.
 *
 * So an owner watching the campus saw a body go from fine, to dimmer, to
 * absent, with nothing in between they could have acted on. This file is the
 * arithmetic behind making that drift legible while there is still time.
 *
 * WHAT IT MAY HONESTLY USE. The public minimap carries `connection`
 * ("live" | "async" | "offline"), `pulse_age_seconds` (server-measured seconds
 * since the body last said what it was doing, null if it never has) and
 * `stall_after_seconds`. It does NOT carry `last_seen_at`, so the exact age of
 * the last heartbeat is not knowable from here. Rather than invent one, every
 * estimate below is a LOWER BOUND on the silence and the wording says "at
 * least":
 *
 *   - connected: the last heartbeat cannot be five minutes old or presence
 *     would not still be connected, so the drift is capped just short of the
 *     halfway mark however old the pulse is.
 *   - offline: the silence is at least five minutes, because that is what put
 *     it offline. On top of that we take the larger of the server's pulse age
 *     and how long THIS TAB has watched it sit offline — the same honesty the
 *     scaffolding clock already accepts, for the same reason: a measured
 *     interval from a watcher who arrived late beats a fabricated absolute.
 *
 * Everything here is pure, and nothing consults Math.random, array order or
 * poll order: the same inputs give the same answer in every frame and every tab.
 * `bodyHealth` allocates one small object of numbers and builds no strings, so
 * it is safe to call once per body per frame; `healthNote` does the formatting
 * and is called only when something is actually being read.
 */

/** Presence drops to `offline` here. Mirrors presence.evictStale(). */
export const OFFLINE_AFTER_MS = 5 * 60_000;
/** The presence row is deleted here, and the body is gone. */
export const EVICT_AFTER_MS = 10 * 60_000;

/**
 * How long a body that has left stays on the map as a departure.
 *
 * Deliberately shorter than one poll (8s): this is the animation of a thing
 * leaving, not a tombstone. A body that blinks out between two polls reads as a
 * rendering bug; a body that fades where it stood reads as a body leaving.
 */
export const DEPART_MS = 2200;

export type HealthStage =
  /** Reporting inside the stall threshold. Nothing to draw. */
  | "beating"
  /** Connected, but has never pulsed: its silence cannot be measured at all. */
  | "unreported"
  /** Connected, but silent for longer than the stall threshold. */
  | "quiet"
  /** Presence has gone offline. Counting down to an empty seat. */
  | "fading"
  /** Not Grove's to measure: a mirrored Paperclip body next door. */
  | "elsewhere";

export type Health = {
  stage: HealthStage;
  /**
   * 0..1: how far this body has drifted from "just heard from" toward
   * "evicted". 0.5 is the offline mark, 1 is the empty seat.
   */
  drift: number;
  /** Lower bound on how long the body has been silent, in ms. 0 when unknown. */
  silenceMs: number;
};

/** A Paperclip body is mirrored from next door; Grove's eviction clock never runs on it. */
export const ELSEWHERE: Health = { stage: "elsewhere", drift: 0, silenceMs: 0 };

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** "40s", "4m", "1h 12m" — short enough for a caption, exact enough to act on. */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function bodyHealth(input: {
  connection: string | null | undefined;
  pulseAgeSeconds: number | null;
  stallAfterSeconds: number;
  /** Wall-clock ms when THIS tab first saw the body offline; null while connected. */
  offlineSince: number | null;
  now: number;
}): Health {
  const conn = (input.connection ?? "").toLowerCase();
  const pulseMs = input.pulseAgeSeconds == null ? null : Math.max(0, input.pulseAgeSeconds * 1000);
  if (conn === "offline") {
    const watched = input.offlineSince == null ? 0 : Math.max(0, input.now - input.offlineSince);
    // Three lower bounds on the silence; the largest is the one we can defend.
    const silenceMs = Math.max(OFFLINE_AFTER_MS, pulseMs ?? 0, OFFLINE_AFTER_MS + watched);
    return { stage: "fading", drift: clamp01(silenceMs / EVICT_AFTER_MS), silenceMs };
  }
  if (pulseMs == null) return { stage: "unreported", drift: 0, silenceMs: 0 };
  // Still connected, so the heartbeat is under five minutes old however old the
  // pulse is; the drift can never cross the offline mark from this branch.
  const drift = Math.min(0.49, pulseMs / EVICT_AFTER_MS);
  const stage: HealthStage = input.pulseAgeSeconds! > input.stallAfterSeconds ? "quiet" : "beating";
  return { stage, drift, silenceMs: pulseMs };
}

/** One sentence for the hover card and the peek. Built only when read. */
export function healthNote(h: Health): string {
  if (h.stage === "elsewhere") {
    return "Runs on Paperclip next door, so Grove holds no heartbeat for it and never evicts it.";
  }
  if (h.stage === "fading") {
    return `Asleep — silent for at least ${fmtAge(h.silenceMs)}. The world empties a seat at ten minutes.`;
  }
  if (h.stage === "quiet") {
    return `Quiet for ${fmtAge(h.silenceMs)} — still connected, but not reporting. Asleep at five minutes.`;
  }
  if (h.stage === "unreported") {
    return "Connected, but it has never reported what it is doing, so the map reads the room and not the body.";
  }
  return `Reporting — last heard ${fmtAge(h.silenceMs)} ago.`;
}

/** Drawn only once a body has drifted; a healthy body carries no mark at all. */
export function healthVisible(h: Health): boolean {
  return h.stage === "quiet" || h.stage === "fading";
}

/**
 * Amber while it is merely quiet, through the stall orange to the fault red as
 * the seat runs out. A fixed eight-step ramp rather than a colour composed per
 * body per frame: the draw loop must not build strings.
 */
const HEALTH_RAMP: readonly string[] = [
  "#fbbf24",
  "#fbbf24",
  "#fbbf24",
  "#fbbf24",
  "#fb923c",
  "#f97316",
  "#f87171",
  "#ef4444",
];

export function healthColour(drift: number): string {
  const i = Math.min(HEALTH_RAMP.length - 1, Math.max(0, Math.floor(drift * HEALTH_RAMP.length)));
  return HEALTH_RAMP[i]!;
}

/**
 * How opaque a sleeping body should be.
 *
 * The ladder the map already had was awake 1.0 / idle 0.72 / asleep 0.4, and
 * then nothing — asleep was the last rung before the body was simply gone. This
 * continues it: a sleeping body keeps dimming as its seat runs out, so "about
 * to go" is a state you can see from across the campus rather than one you
 * infer from the absence afterwards.
 *
 * The floor is 0.26 and not lower. A first pass took it to 0.18, and at that
 * value a body one minute from eviction was so close to invisible that the
 * departure afterwards had nothing left to remove — which is the bug this was
 * meant to fix, arrived at from the other side. The ring carries the precision;
 * the alpha only has to say "less than it was".
 */
export function sleepingAlpha(drift: number): number {
  return 0.4 - 0.14 * clamp01((drift - 0.5) / 0.5);
}
