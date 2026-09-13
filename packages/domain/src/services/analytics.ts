import crypto from "node:crypto";
import type { GroveStore } from "../store.js";

/**
 * First-party analytics (migration 033): counts, never people.
 *
 * WHAT IS COUNTED. Page views (one beacon per page from the web app), sign-ins
 * (a magic link consumed), walk-ins (a person entering the world or a room),
 * follows, messages and reactions — each recorded by the API route that already
 * performed the action, for PEOPLE only (agents have their own metrics on the
 * Overview). Everything is a per-UTC-day counter in `analytics_daily`.
 *
 * WHAT IS NEVER STORED. No IP, no user agent, no handle, no session, no id, no
 * path, no referrer. A request carrying `DNT: 1` or `Sec-GPC: 1` is not counted
 * at all, not even as a page view. Nothing leaves the server; the only reader
 * is the operator-only /mod Overview.
 *
 * UNIQUE VISITORS. HMAC-SHA256(today's salt, ip + user agent), truncated to 24
 * bits, is inserted into `analytics_buckets` so a second page view today is not
 * a second visitor. 24 bits is deliberate: each bucket is shared by hundreds of
 * possible addresses, so a bucket cannot be walked back to one. The salt is
 * random, lives one UTC day, and is DELETED by the prune once the day is over,
 * together with the day's buckets. After that nobody — operator included — can
 * tell whether yesterday's visitor came back today. That is why there is no
 * "returning visitor" number for anonymous traffic: it would need a join the
 * design exists to make impossible.
 *
 * RETENTION. Measured on signed-in people instead, as cohorts: the week they
 * first signed in (the week their `humans` row was created) against each week
 * they did something. A person's first counted action in a week marks
 * HMAC(this week's salt, human id) in `analytics_buckets` and adds one to
 * `analytics_cohorts(cohort_week, active_week)`. The weekly salt and its marks
 * are deleted when the week ends. What survives is a grid of numbers.
 *
 * PRUNING. Counters and cohort cells older than ANALYTICS_RETENTION_DAYS go in
 * the tick (maybePrune), with every salt and bucket whose period is over.
 *
 * Every write swallows its own errors: analytics is never allowed to fail the
 * action it is counting.
 */

export const ANALYTICS_RETENTION_DAYS = 90;
export const ANALYTICS_PRUNE_EVERY_MS = 10 * 60_000;
/** Hex characters of the HMAC kept per bucket: 6 = 24 bits. */
export const ANALYTICS_BUCKET_HEX = 6;
/** Cohort rows shown (and weeks per row). */
export const ANALYTICS_COHORT_WEEKS = 8;

export const ANALYTICS_EVENTS = ["visit", "unique_visitor", "sign_in", "walk_in", "follow", "message", "reaction"] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];
/** The events a route may record directly (unique_visitor is derived from visit). */
export type ActionEvent = Exclude<AnalyticsEvent, "visit" | "unique_visitor">;

export const ANALYTICS_LABELS: Record<AnalyticsEvent, string> = {
  visit: "Page views",
  unique_visitor: "Unique visitors",
  sign_in: "Sign-ins",
  walk_in: "Walk-ins",
  follow: "Follows",
  message: "Messages",
  reaction: "Reactions",
};

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

/** "2026-09-13" for the UTC day containing `ms`. */
export function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The Monday (UTC) starting the ISO week that contains `ms`, as "YYYY-MM-DD". */
export function utcWeekOf(ms: number): string {
  const d = new Date(Math.floor(ms / DAY_MS) * DAY_MS);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return utcDayOf(d.getTime() - dow * DAY_MS);
}

/** Whole weeks from `fromWeek` to `toWeek` (both Mondays). */
export function weeksBetween(fromWeek: string, toWeek: string): number {
  return Math.round((Date.parse(`${toWeek}T00:00:00Z`) - Date.parse(`${fromWeek}T00:00:00Z`)) / (7 * DAY_MS));
}

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

/** Do Not Track or Global Privacy Control: count nothing for this request. */
export function trackingRefused(headers: HeaderBag): boolean {
  return header(headers, "dnt") === "1" || header(headers, "sec-gpc") === "1";
}

const BOT_UA = /bot|crawl|spider|slurp|scrape|preview|headless|lighthouse|monitor|uptime|curl|wget|python|httpclient|go-http|java\/|okhttp|axios|node-fetch|undici|facebookexternalhit|embedly|whatsapp|telegram|discord|slack/i;

/** A deliberately simple check; the user agent is looked at, never kept. */
export function looksLikeBot(userAgent: string | null | undefined): boolean {
  if (!userAgent || userAgent.length < 10) return true;
  return BOT_UA.test(userAgent);
}

/** Truncated HMAC: the only thing written for a visitor or an active person. */
export function bucketOf(salt: Buffer, ...parts: string[]): string {
  return crypto.createHmac("sha256", salt).update(parts.join("\n")).digest("hex").slice(0, ANALYTICS_BUCKET_HEX);
}

export function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface AnalyticsSeries {
  key: AnalyticsEvent;
  label: string;
  /** Today so far (UTC). */
  today: number;
  yesterday: number;
  /** Median of the seven full days before today. */
  median7: number;
  /** Index 0 = today, 1 = yesterday … 7. Zero-filled. */
  days: number[];
}

export interface AnalyticsCohort {
  /** Monday of the week these people first signed in. */
  cohortWeek: string;
  /** People whose first sign-in was that week (from `humans`, counted). */
  size: number;
  /** active[n] = how many of them did something in week n (0 = their first week). Only weeks that have begun. */
  active: number[];
}

export interface AnalyticsSummary {
  day: string;
  week: string;
  series: AnalyticsSeries[];
  cohorts: AnalyticsCohort[];
  retentionDays: number;
}

/** Rows of (day, event, n) → one series per event, relative to `today`. */
export function seriesFromRows(rows: Array<{ day: string; event: string; n: number | string }>, today: string): AnalyticsSeries[] {
  const t = Date.parse(`${today}T00:00:00Z`);
  const byEvent = new Map<string, number[]>();
  for (const r of rows) {
    const idx = Math.round((t - Date.parse(`${r.day}T00:00:00Z`)) / DAY_MS);
    if (idx < 0 || idx > 7) continue;
    const arr = byEvent.get(r.event) ?? Array<number>(8).fill(0);
    arr[idx] = (arr[idx] ?? 0) + Number(r.n);
    byEvent.set(r.event, arr);
  }
  return ANALYTICS_EVENTS.map((key) => {
    const days = byEvent.get(key) ?? Array<number>(8).fill(0);
    return { key, label: ANALYTICS_LABELS[key], today: days[0]!, yesterday: days[1]!, median7: medianOf(days.slice(1, 8)), days };
  });
}

/** Cohort sizes + (cohort_week, active_week, n) cells → the last `weeks` cohorts, newest first. */
export function cohortsFromRows(
  sizes: Array<{ week: string; n: number | string }>,
  cells: Array<{ cohort_week: string; active_week: string; n: number | string }>,
  thisWeek: string,
  weeks: number = ANALYTICS_COHORT_WEEKS,
): AnalyticsCohort[] {
  const out: AnalyticsCohort[] = [];
  for (let i = 0; i < weeks; i++) {
    const cohortWeek = utcDayOf(Date.parse(`${thisWeek}T00:00:00Z`) - i * 7 * DAY_MS);
    const size = Number(sizes.find((s) => s.week === cohortWeek)?.n ?? 0);
    const span = Math.min(weeks, weeksBetween(cohortWeek, thisWeek) + 1);
    const active = Array<number>(span).fill(0);
    for (const c of cells) {
      if (c.cohort_week !== cohortWeek) continue;
      const n = weeksBetween(cohortWeek, c.active_week);
      if (n >= 0 && n < span) active[n] = (active[n] ?? 0) + Number(c.n);
    }
    out.push({ cohortWeek, size, active });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------

export class AnalyticsService {
  private salts = new Map<string, Buffer>();
  private lastPruned = 0;

  constructor(private store: GroveStore) {}

  /** The salt for a period, created on first use. Two processes racing agree on the winner's. */
  private async salt(scope: "visitor" | "active", period: string): Promise<Buffer> {
    const key = `${scope}:${period}`;
    const cached = this.salts.get(key);
    if (cached) return cached;
    await this.store.pg.query(
      `INSERT INTO analytics_salts (scope, period, salt) VALUES ($1, $2::date, $3) ON CONFLICT DO NOTHING`,
      [scope, period, crypto.randomBytes(32)],
    );
    const { rows } = await this.store.pg.query<{ salt: Buffer }>(
      `SELECT salt FROM analytics_salts WHERE scope = $1 AND period = $2::date`,
      [scope, period],
    );
    const salt = rows[0]!.salt;
    // Only the current period's salt is ever useful; forget the rest.
    for (const k of this.salts.keys()) if (k.startsWith(`${scope}:`)) this.salts.delete(k);
    this.salts.set(key, salt);
    return salt;
  }

  private async bump(event: AnalyticsEvent, day: string): Promise<void> {
    await this.store.pg.query(
      `INSERT INTO analytics_daily (day, event, n) VALUES ($1::date, $2, 1)
       ON CONFLICT (day, event) DO UPDATE SET n = analytics_daily.n + 1`,
      [day, event],
    );
  }

  /** True when this bucket was not yet marked in this period. */
  private async mark(scope: "visitor" | "active", period: string, bucket: string): Promise<boolean> {
    const { rowCount } = await this.store.pg.query(
      `INSERT INTO analytics_buckets (scope, period, bucket) VALUES ($1, $2::date, $3) ON CONFLICT DO NOTHING`,
      [scope, period, bucket],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * A person did something countable. `humanId` is used only to mark this
   * week's activity for the retention grid; it is not written anywhere.
   */
  async record(event: ActionEvent, opts: { humanId?: string | null; now?: number } = {}): Promise<void> {
    const now = opts.now ?? Date.now();
    try {
      await this.bump(event, utcDayOf(now));
      if (opts.humanId) await this.markActive(opts.humanId, now);
    } catch {
      /* never fail the action being counted */
    }
  }

  /** One page view from the beacon. Bots and refused requests are filtered by the caller. */
  async visit(opts: { ip: string; userAgent: string; humanId?: string | null; now?: number }): Promise<void> {
    const now = opts.now ?? Date.now();
    const day = utcDayOf(now);
    try {
      await this.bump("visit", day);
      const bucket = bucketOf(await this.salt("visitor", day), opts.ip, opts.userAgent);
      if (await this.mark("visitor", day, bucket)) await this.bump("unique_visitor", day);
      if (opts.humanId) await this.markActive(opts.humanId, now);
    } catch {
      /* decoration, never an error */
    }
  }

  /** First action of this person this week → one more in their cohort's cell. */
  async markActive(humanId: string, now: number = Date.now()): Promise<boolean> {
    const week = utcWeekOf(now);
    const { rows } = await this.store.pg.query<{ created_at: Date }>(`SELECT created_at FROM humans WHERE id = $1`, [humanId]);
    if (!rows[0]) return false;
    const cohortWeek = utcWeekOf(new Date(rows[0].created_at).getTime());
    if (weeksBetween(cohortWeek, week) < 0) return false;
    const bucket = bucketOf(await this.salt("active", week), humanId);
    if (!(await this.mark("active", week, bucket))) return false;
    await this.store.pg.query(
      `INSERT INTO analytics_cohorts (cohort_week, active_week, n) VALUES ($1::date, $2::date, 1)
       ON CONFLICT (cohort_week, active_week) DO UPDATE SET n = analytics_cohorts.n + 1`,
      [cohortWeek, week],
    );
    return true;
  }

  /** Drop counters past retention, and every salt and bucket whose period is over. */
  async prune(now: number = Date.now()): Promise<{ daily: number; cohorts: number; salts: number; buckets: number }> {
    const today = utcDayOf(now);
    const week = utcWeekOf(now);
    const cutoff = utcDayOf(now - ANALYTICS_RETENTION_DAYS * DAY_MS);
    const pg = this.store.pg;
    const daily = await pg.query(`DELETE FROM analytics_daily WHERE day < $1::date`, [cutoff]);
    const cohorts = await pg.query(`DELETE FROM analytics_cohorts WHERE active_week < $1::date`, [cutoff]);
    const past = `(scope = 'visitor' AND period < $1::date) OR (scope = 'active' AND period < $2::date) OR scope NOT IN ('visitor', 'active')`;
    const buckets = await pg.query(`DELETE FROM analytics_buckets WHERE ${past}`, [today, week]);
    const salts = await pg.query(`DELETE FROM analytics_salts WHERE ${past}`, [today, week]);
    return {
      daily: daily.rowCount ?? 0,
      cohorts: cohorts.rowCount ?? 0,
      salts: salts.rowCount ?? 0,
      buckets: buckets.rowCount ?? 0,
    };
  }

  /** At most every ANALYTICS_PRUNE_EVERY_MS per process. For the tick. */
  async maybePrune(now: number = Date.now()): Promise<void> {
    if (now - this.lastPruned < ANALYTICS_PRUNE_EVERY_MS) return;
    this.lastPruned = now;
    await this.prune(now);
  }

  /** The /mod Overview card: today vs yesterday vs 7-day median, and the cohort grid. */
  async summary(now: number = Date.now()): Promise<AnalyticsSummary> {
    const today = utcDayOf(now);
    const week = utcWeekOf(now);
    const firstCohort = utcDayOf(Date.parse(`${week}T00:00:00Z`) - (ANALYTICS_COHORT_WEEKS - 1) * 7 * DAY_MS);
    const pg = this.store.pg;
    const [daily, sizes, cells] = await Promise.all([
      pg.query<{ day: string; event: string; n: string }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, event, n FROM analytics_daily
          WHERE day > $1::date - 8 AND day <= $1::date`,
        [today],
      ),
      pg.query<{ week: string; n: string }>(
        `SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week, count(*) AS n
           FROM humans WHERE created_at >= $1::date GROUP BY 1`,
        [firstCohort],
      ),
      pg.query<{ cohort_week: string; active_week: string; n: string }>(
        `SELECT to_char(cohort_week, 'YYYY-MM-DD') AS cohort_week, to_char(active_week, 'YYYY-MM-DD') AS active_week, n
           FROM analytics_cohorts WHERE cohort_week >= $1::date`,
        [firstCohort],
      ),
    ]);
    return {
      day: today,
      week,
      series: seriesFromRows(daily.rows, today),
      cohorts: cohortsFromRows(sizes.rows, cells.rows, week),
      retentionDays: ANALYTICS_RETENTION_DAYS,
    };
  }
}
