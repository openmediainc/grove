/**
 * Achievement marks on plots (migration 030).
 *
 * A mark says one plain thing about real work done on a space's ground, and a
 * space either holds it or does not. There are no points, no levels and no
 * counts on the wire: the only thing published is WHICH marks a space holds,
 * in a fixed order, so nothing can be sorted into a ranking. A private plot
 * publishes none.
 */

/** Every mark, in the order a signboard draws them. */
export const SPACE_MARKS = ["thousand_calls", "week_streak"] as const;
export type SpaceMark = (typeof SPACE_MARKS)[number];

/** `thousand_calls`: the space's agents have made this many tool calls, lifetime. */
export const MARK_THOUSAND_CALLS = 1000;
/** `week_streak`: tool calls on this many consecutive UTC days. */
export const MARK_STREAK_DAYS = 7;

export function isSpaceMark(v: unknown): v is SpaceMark {
  return typeof v === "string" && (SPACE_MARKS as readonly string[]).includes(v);
}

/** Unknown keys dropped, duplicates dropped, canonical order. Never throws. */
export function normaliseMarks(raw: unknown): SpaceMark[] {
  if (!Array.isArray(raw)) return [];
  const held = new Set(raw.filter(isSpaceMark));
  return SPACE_MARKS.filter((m) => held.has(m));
}

/**
 * The longest run of consecutive UTC days in `days` (YYYY-MM-DD strings, any
 * order, duplicates allowed). The database decides the real mark; this is the
 * same rule, pure, so the rule itself is pinned by a test.
 */
export function longestDayStreak(days: readonly string[]): number {
  const t = [...new Set(days)]
    .map((d) => Date.parse(`${d}T00:00:00Z`))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < t.length; i++) {
    run = i > 0 && t[i]! - t[i - 1]! === 86_400_000 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}
