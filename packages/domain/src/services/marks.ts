import { MARK_STREAK_DAYS, MARK_THOUSAND_CALLS, normaliseMarks, type SpaceMark } from "@grove/protocol";
import type { GroveStore } from "../store.js";

/**
 * How often a process re-evaluates marks from the sweep. Marks are a slow
 * truth (a thousand calls, a week): minutes of lag cost nothing, and the
 * evaluation aggregates every live span, so it must not ride every 15s tick.
 */
export const MARK_EVALUATE_EVERY_MS = 5 * 60_000;

/**
 * Achievement marks on plots (migration 030). See the migration for the shape.
 *
 * Work is counted where it happened: a tool-call span belongs to the space its
 * room was in. Lifetime calls = the durable daily tally (written by the prune)
 * plus the spans still in `tool_calls`; a span is in exactly one of the two.
 * Marks are INSERTed once and never removed.
 */
export class MarkService {
  private lastEvaluated = 0;

  constructor(private store: GroveStore) {}

  /**
   * Delete finished spans past retention, folding each into the durable daily
   * tally of the space it happened in, in ONE statement: a span can never be
   * forgotten without being counted, nor counted twice.
   */
  async pruneIntoTally(retentionDays: number): Promise<number> {
    const { rows } = await this.store.pg.query<{ pruned: number }>(
      `WITH gone AS (
         DELETE FROM tool_calls WHERE finished_at < now() - make_interval(days => $1)
         RETURNING room_id, started_at
       ),
       tally AS (
         INSERT INTO tool_call_daily (world_id, day, calls)
         SELECT r.world_id, (g.started_at AT TIME ZONE 'UTC')::date, count(*)
           FROM gone g
           JOIN rooms r ON r.id = g.room_id
           JOIN worlds w ON w.id = r.world_id
          GROUP BY 1, 2
         ON CONFLICT (world_id, day) DO UPDATE SET calls = tool_call_daily.calls + EXCLUDED.calls
         RETURNING 1
       )
       SELECT (SELECT count(*)::int FROM gone) AS pruned, (SELECT count(*) FROM tally) AS _t`,
      [retentionDays],
    );
    return rows[0]?.pruned ?? 0;
  }

  /** Evaluate at most every MARK_EVALUATE_EVERY_MS per process. For the sweep. */
  async maybeEvaluate(now: number = Date.now()): Promise<number> {
    if (now - this.lastEvaluated < MARK_EVALUATE_EVERY_MS) return 0;
    this.lastEvaluated = now;
    return this.evaluate();
  }

  /**
   * Award every mark a claimed space has newly earned. Returns how many were
   * awarded. Idempotent: an earned mark keeps its first earned_at.
   */
  async evaluate(): Promise<number> {
    const { rowCount } = await this.store.pg.query(
      `WITH live AS (
         SELECT r.world_id, (t.started_at AT TIME ZONE 'UTC')::date AS day, count(*) AS calls
           FROM tool_calls t JOIN rooms r ON r.id = t.room_id
          WHERE r.world_id IS NOT NULL
          GROUP BY 1, 2
       ),
       per_day AS (
         SELECT world_id, day, sum(calls) AS calls
           FROM (SELECT world_id, day, calls FROM tool_call_daily UNION ALL SELECT world_id, day, calls FROM live) u
          GROUP BY 1, 2
       ),
       islands AS (
         SELECT world_id, day - (row_number() OVER (PARTITION BY world_id ORDER BY day))::int AS grp
           FROM per_day WHERE calls > 0
       ),
       earned AS (
         SELECT world_id, 'thousand_calls' AS mark FROM per_day
          GROUP BY world_id HAVING sum(calls) >= $1
         UNION
         SELECT world_id, 'week_streak' FROM islands
          GROUP BY world_id, grp HAVING count(*) >= $2
       )
       INSERT INTO space_marks (world_id, mark)
       SELECT e.world_id, e.mark FROM earned e
         JOIN worlds w ON w.id = e.world_id AND w.plot_index IS NOT NULL
       ON CONFLICT (world_id, mark) DO NOTHING`,
      [MARK_THOUSAND_CALLS, MARK_STREAK_DAYS],
    );
    return rowCount ?? 0;
  }

  /** Marks held, per space id. The caller decides who may see them. */
  async forWorlds(worldIds: readonly string[]): Promise<Map<string, SpaceMark[]>> {
    const out = new Map<string, SpaceMark[]>();
    if (!worldIds.length) return out;
    const { rows } = await this.store.pg.query<{ world_id: string; marks: string[] }>(
      `SELECT world_id, array_agg(mark) AS marks FROM space_marks
        WHERE world_id = ANY($1::text[]) GROUP BY world_id`,
      [[...worldIds]],
    );
    for (const r of rows) out.set(String(r.world_id), normaliseMarks(r.marks));
    return out;
  }
}
