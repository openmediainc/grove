"use client";

/**
 * The idle bell.
 *
 * Age of Empires' most-copied affordance is one button that says how many
 * villagers are doing nothing and, when pressed, takes you to the next one.
 * Grove already computes three things nobody could see in aggregate — bodies
 * that are idle or asleep, bodies the server has marked stalled, and bodies
 * carrying a prompt-injection flag from the chronicle — and every one of them
 * was only discoverable by finding the body on the map first, which is exactly
 * backwards.
 *
 * One control, three counts, click to cycle. Hazards are counted first and
 * cycled first: a stalled body is a thing to fix, an idle one is only a thing
 * to notice. Pressing it moves the camera, using the follow-cam the map
 * already has — there is deliberately no second camera in here.
 */

export type AttentionCounts = {
  /** Bodies that are idle or asleep. Not a problem; just nobody's doing anything. */
  idle: number;
  /** Server-computed: claims to be working, has stopped reporting past stall_after_seconds. */
  stalled: number;
  /** Faulted, blocked, or flagged for prompt injection in the chronicle. */
  hazard: number;
  /**
   * Asleep and drifting toward eviction: presence went offline at five minutes
   * of silence, and the world deletes the body at ten. Ranked between a stall
   * and mere idleness — a stall is a thing to fix, this is a thing with a
   * deadline, and an idle body is only a thing to notice.
   */
  fading: number;
};

/** The bell's words, from the active theme's lexicon. The ORDER and the colours are not themeable. */
export type BellWords = { faulted: string; stalled: string; fading: string; idle: string; allBusy: string };

const DEFAULT_WORDS: BellWords = {
  faulted: "faulted",
  stalled: "stalled",
  fading: "fading",
  idle: "idle",
  allBusy: "all hands busy",
};

export function AttentionBell({
  counts,
  position,
  onCycle,
  words = DEFAULT_WORDS,
}: {
  counts: AttentionCounts;
  /** "3 of 7 · lantern" while cycling, null when nothing is being followed from here. */
  position: string | null;
  onCycle: () => void;
  words?: BellWords;
}) {
  const total = counts.hazard + counts.stalled + counts.fading + counts.idle;
  const alarming = counts.hazard + counts.stalled;

  if (total === 0) {
    return (
      <div
        className="pointer-events-none flex items-center gap-2 rounded-full border border-white/10 bg-dusk-950/70 py-1.5 pl-3 pr-4 text-[11px] text-white/35"
        title="Nothing is idle, stalled or faulted."
      >
        <span aria-hidden>◇</span>
        <span>{words.allBusy}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onCycle}
      title="Go to the next body that wants attention (.)"
      aria-label={`${total} bodies want attention. Go to the next one.`}
      className={`pointer-events-auto flex max-w-full items-center gap-2 rounded-full border py-2 pl-3 pr-4 text-xs transition-colors sm:py-1.5 ${
        alarming > 0
          ? "border-red-400/50 bg-red-950/50 text-red-200 hover:bg-red-900/50"
          : "border-lantern-400/30 bg-dusk-950/85 text-lantern-300/90 hover:bg-dusk-900/85"
      }`}
    >
      <span aria-hidden className={alarming > 0 ? "animate-pulse" : ""}>
        {alarming > 0 ? "▲" : "◆"}
      </span>
      <span className="flex items-center gap-2 tabular-nums">
        {counts.hazard > 0 ? (
          <span className="text-red-300" title="Faulted, blocked, or flagged for prompt injection">
            {counts.hazard} {words.faulted}
          </span>
        ) : null}
        {counts.stalled > 0 ? (
          <span className="text-orange-300" title="Says it is working, but has stopped reporting">
            {counts.stalled} {words.stalled}
          </span>
        ) : null}
        {counts.fading > 0 ? (
          <span className="text-amber-300" title="Asleep and drifting: the world empties the seat at ten minutes of silence">
            {counts.fading} {words.fading}
          </span>
        ) : null}
        {counts.idle > 0 ? (
          <span className={alarming > 0 ? "text-white/55" : ""} title="Idle or asleep">
            {counts.idle} {words.idle}
          </span>
        ) : null}
      </span>
      {position ? <span className="truncate border-l border-white/15 pl-2 text-white/60">{position}</span> : null}
    </button>
  );
}
