import type { GroveStore } from "../store.js";
import { schemaStatus, type SchemaStatus } from "../migrate.js";
import type { EmailDeliveryService, EmailHealthReport } from "./email-deliveries.js";

/**
 * OPS-01 — the operator overview on /mod.
 *
 * One read, five questions an operator asks before anything else:
 *   is it up (postgres, redis), is the schema what the code expects (by NAME —
 *   this is operator-only, unlike public /ready), what is it costing, can people
 *   sign in, and is anything behaving unlike itself.
 *
 * The last one is the anomaly lines. Each metric is bucketed in SQL into eight
 * trailing 24-hour windows (0 = the last 24h, 1 = the 24h before, ...), one
 * grouped range scan per metric, all in ONE statement against created_at-style
 * indexes: world_events, tool_calls, usage_events and email_deliveries had
 * them already, and 031 adds `(created_at DESC)` on speech, messages,
 * reactions, follows and reports. A test EXPLAINs every metric with seq scans
 * disabled, so a new metric without an index fails. The comparison and the
 * wording are pure functions below, so they are tested without a database and
 * cannot drift from what the page says.
 *
 * Trailing 24h windows rather than "today since UTC midnight": at 00:30 UTC a
 * calendar day is thirty minutes old and every metric would read as a
 * collapse. A trailing window is always a full day, so "vs yesterday" means
 * what it says at any hour.
 *
 * Nothing here names a private space. It returns agent handles (for top spend)
 * and migration file names, and the route that serves it is operator-only.
 */

// ---------------------------------------------------------------------------
// Metrics.
// ---------------------------------------------------------------------------

export type MetricKind = "fault" | "traffic";

export interface MetricDef {
  key: string;
  /** Plural noun phrase, lower case: "tool-call errors". Starts the sentence. */
  label: string;
  /** fault = only a rise is news. traffic = a spike or a collapse is news. */
  kind: MetricKind;
  /** Below this many (in the window that would be flagged) nothing is said: noise floor. */
  minCount: number;
  /** A rise is flagged at this multiple of the baseline. */
  upRatio: number;
  /** How many prior windows exist to take a median over (retention caps some tables). */
  historyDays: number;
  unit: "count" | "usd_micros";
}

const DAY = 86_400;

/**
 * The metric catalogue and the SQL that buckets each one. Every query returns
 * (d int, n bigint) where d is the trailing-day index 0..7.
 */
export const OPS_METRICS: Array<MetricDef & { sql: string }> = [
  {
    key: "tool_call_errors",
    label: "tool-call errors",
    kind: "fault",
    minCount: 5,
    upRatio: 2,
    // Finished spans are pruned after 7 days (020), so the 7th prior window is empty.
    historyDays: 6,
    unit: "count",
    sql: bucket("tool_calls", "finished_at", "finished_at IS NOT NULL AND outcome = 'error'"),
  },
  {
    key: "tool_call_stalls",
    label: "stalled tool calls",
    kind: "fault",
    minCount: 5,
    upRatio: 2,
    historyDays: 6,
    unit: "count",
    sql: bucket("tool_calls", "finished_at", "finished_at IS NOT NULL AND outcome = 'stalled'"),
  },
  {
    key: "tool_calls",
    label: "tool calls",
    kind: "traffic",
    minCount: 20,
    upRatio: 3,
    historyDays: 6,
    unit: "count",
    sql: bucket("tool_calls", "finished_at", "finished_at IS NOT NULL"),
  },
  {
    key: "agent_faults",
    label: "agent faults (error or blocked pulses)",
    kind: "fault",
    minCount: 5,
    upRatio: 2,
    historyDays: 7,
    unit: "count",
    sql: bucket("world_events", "created_at", "type = 'agent_phase' AND payload->>'verb' IN ('error', 'blocked')"),
  },
  {
    key: "agent_phases",
    label: "agent pulse phase changes",
    kind: "traffic",
    minCount: 20,
    upRatio: 3,
    historyDays: 7,
    unit: "count",
    sql: bucket("world_events", "created_at", "type = 'agent_phase'"),
  },
  {
    key: "speech",
    label: "lines spoken",
    kind: "traffic",
    minCount: 20,
    upRatio: 3,
    historyDays: 7,
    unit: "count",
    sql: bucket("speech", "created_at", "TRUE"),
  },
  {
    key: "messages",
    label: "messages left",
    kind: "traffic",
    minCount: 10,
    upRatio: 3,
    historyDays: 7,
    unit: "count",
    sql: bucket("messages", "created_at", "TRUE"),
  },
  {
    key: "reactions",
    label: "reactions",
    kind: "traffic",
    minCount: 10,
    upRatio: 3,
    historyDays: 7,
    unit: "count",
    sql: bucket("reactions", "created_at", "TRUE"),
  },
  {
    key: "follows",
    label: "follows",
    kind: "traffic",
    minCount: 10,
    upRatio: 3,
    historyDays: 7,
    unit: "count",
    sql: bucket("follows", "created_at", "TRUE"),
  },
  {
    key: "reports",
    label: "reports filed",
    kind: "fault",
    minCount: 3,
    upRatio: 2,
    historyDays: 7,
    unit: "count",
    sql: bucket("reports", "created_at", "TRUE"),
  },
  {
    key: "email_failures",
    label: "sign-in emails refused or errored",
    kind: "fault",
    minCount: 3,
    upRatio: 2,
    historyDays: 7,
    unit: "count",
    sql: bucket("email_deliveries", "created_at", "send_status IN ('rejected', 'error')"),
  },
  {
    key: "spend",
    label: "reported spend",
    kind: "fault",
    // One dollar: below that a doubling is not worth an operator's attention.
    minCount: 1_000_000,
    upRatio: 2,
    historyDays: 7,
    unit: "usd_micros",
    sql: bucket("usage_events", "created_at", "cost_micros IS NOT NULL", "COALESCE(sum(cost_micros), 0)"),
  },
];

function bucket(table: string, column: string, where: string, agg = "count(*)"): string {
  // now() is fixed for the whole statement, so every metric shares one clock.
  return `SELECT floor(extract(epoch FROM (now() - ${column})) / ${DAY})::int AS d, ${agg} AS n
            FROM ${table}
           WHERE ${column} > now() - interval '8 days' AND ${column} <= now() AND ${where}
           GROUP BY 1`;
}

/** The single statement: every metric's buckets, tagged with the metric key. */
export function opsMetricsSql(): string {
  return OPS_METRICS.map(
    (m, i) => `SELECT '${m.key}'::text AS metric, b${i}.d, b${i}.n::bigint AS n FROM (${m.sql}) b${i}`,
  ).join("\nUNION ALL\n");
}

export interface MetricWindows {
  /** Trailing-day buckets, index 0 = the last 24h. Always length 8, zero-filled. */
  days: number[];
  current: number;
  previous: number;
  /** Median of the prior `historyDays` windows (1..historyDays). */
  median: number;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function windowsFrom(days: number[], historyDays: number): MetricWindows {
  const filled = Array.from({ length: 8 }, (_, i) => days[i] ?? 0);
  return {
    days: filled,
    current: filled[0]!,
    previous: filled[1]!,
    median: median(filled.slice(1, 1 + historyDays)),
  };
}

// ---------------------------------------------------------------------------
// Anomaly rules and wording. Pure.
// ---------------------------------------------------------------------------

export interface AnomalyLine {
  metric: string;
  severity: "critical" | "warning";
  direction: "up" | "down";
  /** The sentence the page shows, verbatim. */
  text: string;
  current: number;
  previous: number;
  median: number;
}

function amount(def: Pick<MetricDef, "unit">, n: number): string {
  if (def.unit === "usd_micros") return `$${(n / 1_000_000).toFixed(2)}`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** 2.96 → "3", 2.5 → "2.5", 14.2 → "14". */
export function formatRatio(r: number): string {
  if (r >= 10) return String(Math.round(r));
  const one = Math.round(r * 10) / 10;
  return Number.isInteger(one) ? String(one) : one.toFixed(1);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Is this metric behaving unlike itself? Returns the plain sentence, or null.
 *
 *  Up (every metric): the last 24h is at least `upRatio` times BOTH yesterday
 *  and the median (the larger of the two is the baseline, so one quiet day
 *  cannot manufacture a spike), and it clears the noise floor.
 *
 *  Down (traffic only): the last 24h is at most half of BOTH yesterday and the
 *  median, and the smaller of those cleared the noise floor. A fault metric
 *  falling is good news and is not a line.
 */
export function detectAnomaly(def: MetricDef, w: MetricWindows): AnomalyLine | null {
  const { current, previous, median: med } = w;
  const tail = `${def.historyDays}-day median ${amount(def, med)}`;

  const upBase = Math.max(previous, med);
  if (current >= def.minCount && current >= def.upRatio * Math.max(upBase, Number.EPSILON)) {
    const ratio = previous > 0 ? current / previous : Infinity;
    // Critical = a fault metric at 5x its baseline (or 5x the noise floor from nothing).
    const severity: AnomalyLine["severity"] =
      def.kind === "fault" && (upBase > 0 ? current / upBase >= 5 : current >= 5 * def.minCount) ? "critical" : "warning";
    const text =
      previous > 0
        ? `${capitalise(def.label)} up ${formatRatio(ratio)}× vs yesterday (${amount(def, current)} in the last 24h, ${amount(def, previous)} the day before; ${tail}).`
        : `${capitalise(def.label)}: ${amount(def, current)} in the last 24h, none the day before (${tail}).`;
    return { metric: def.key, severity, direction: "up", text, current, previous, median: med };
  }

  if (def.kind === "traffic") {
    const downBase = Math.min(previous, med);
    if (downBase >= def.minCount && current <= downBase / 2) {
      const text =
        current === 0
          ? `${capitalise(def.label)} stopped: none in the last 24h (${amount(def, previous)} the day before; ${tail}).`
          : `${capitalise(def.label)} down ${Math.round((1 - current / previous) * 100)}% vs yesterday (${amount(def, current)} in the last 24h, ${amount(def, previous)} the day before; ${tail}).`;
      return {
        metric: def.key,
        severity: current === 0 ? "critical" : "warning",
        direction: "down",
        text,
        current,
        previous,
        median: med,
      };
    }
  }
  return null;
}

/** Rows from opsMetricsSql() → per-metric windows. */
export function metricsFromRows(rows: Array<{ metric: string; d: number; n: number | string }>): Record<string, MetricWindows> {
  const days = new Map<string, number[]>();
  for (const r of rows) {
    const d = Number(r.d);
    if (d < 0 || d > 7) continue;
    const arr = days.get(r.metric) ?? Array(8).fill(0);
    arr[d] = (arr[d] ?? 0) + Number(r.n);
    days.set(r.metric, arr);
  }
  const out: Record<string, MetricWindows> = {};
  for (const m of OPS_METRICS) out[m.key] = windowsFrom(days.get(m.key) ?? [], m.historyDays);
  return out;
}

export function anomaliesFor(windows: Record<string, MetricWindows>): AnomalyLine[] {
  const lines: AnomalyLine[] = [];
  for (const m of OPS_METRICS) {
    const w = windows[m.key];
    if (!w) continue;
    const line = detectAnomaly(m, w);
    if (line) lines.push(line);
  }
  return lines.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

type Section<T> = T | { error: string };

export interface CostBurn {
  /** null when no report in the window carried a price: unknown is not $0.00. */
  todayMicros: number | null;
  yesterdayMicros: number | null;
  monthMicros: number | null;
  todayReports: number;
  todayUncostedReports: number;
  /** UTC calendar days, matching usage_daily. */
  day: string;
  topAgents: Array<{ agentId: string; slug: string; displayName: string; costMicros: number | null; reports: number }>;
}

export interface OpsOverview {
  generatedAt: string;
  anomalies: AnomalyLine[];
  metrics: Section<Array<MetricDef & MetricWindows>>;
  health: {
    postgres: { ok: boolean; ms: number | null; error?: string };
    redis: { ok: boolean; ms: number | null; error?: string };
    publicDeploy: boolean;
  };
  schema: Section<SchemaStatus>;
  cost: Section<CostBurn>;
  email: Section<Pick<EmailHealthReport, "status" | "reasons" | "transport" | "deliveryTruth"> & {
    day: { attempts: number; accepted: number; rejected: number; errored: number; redeemed: number };
  }>;
}

async function timed(run: () => Promise<unknown>): Promise<{ ok: boolean; ms: number | null; error?: string }> {
  const t = Date.now();
  try {
    await run();
    return { ok: true, ms: Date.now() - t };
  } catch (err) {
    return { ok: false, ms: null, error: (err as Error).message.slice(0, 200) };
  }
}

async function section<T>(run: () => Promise<T>): Promise<Section<T>> {
  try {
    return await run();
  } catch (err) {
    return { error: (err as Error).message.slice(0, 200) };
  }
}

const micros = (costed: unknown, sum: unknown) => (Number(costed) > 0 ? Number(sum) : null);

export class OpsService {
  constructor(
    private store: GroveStore,
    private emailDeliveries: EmailDeliveryService,
  ) {}

  async metrics(): Promise<Record<string, MetricWindows>> {
    const { rows } = await this.store.pg.query<{ metric: string; d: number; n: string }>(opsMetricsSql());
    return metricsFromRows(rows);
  }

  async cost(): Promise<CostBurn> {
    const pg = this.store.pg;
    const [days, top] = await Promise.all([
      pg.query(
        `WITH t AS (SELECT (now() AT TIME ZONE 'UTC')::date AS today)
         SELECT to_char(t.today, 'YYYY-MM-DD') AS today,
                COALESCE(sum(u.cost_micros)       FILTER (WHERE u.day = t.today), 0)     AS today_sum,
                COALESCE(sum(u.costed_reports)    FILTER (WHERE u.day = t.today), 0)     AS today_costed,
                COALESCE(sum(u.uncosted_reports)  FILTER (WHERE u.day = t.today), 0)     AS today_uncosted,
                COALESCE(sum(u.cost_micros)       FILTER (WHERE u.day = t.today - 1), 0) AS y_sum,
                COALESCE(sum(u.costed_reports)    FILTER (WHERE u.day = t.today - 1), 0) AS y_costed,
                COALESCE(sum(u.cost_micros), 0)                                          AS m_sum,
                COALESCE(sum(u.costed_reports), 0)                                       AS m_costed
           FROM t LEFT JOIN usage_daily u
             ON u.day >= LEAST(date_trunc('month', t.today)::date, t.today - 1) AND u.day <= t.today
          GROUP BY t.today`,
      ),
      pg.query(
        `SELECT u.agent_id, a.slug, a.display_name,
                sum(u.cost_micros) AS cost, sum(u.costed_reports) AS costed,
                sum(u.costed_reports + u.uncosted_reports) AS reports
           FROM usage_daily u JOIN agents a ON a.id = u.agent_id
          WHERE u.day = (now() AT TIME ZONE 'UTC')::date
          GROUP BY u.agent_id, a.slug, a.display_name
          ORDER BY sum(u.cost_micros) DESC, reports DESC
          LIMIT 5`,
      ),
    ]);
    const r = days.rows[0] ?? {};
    // Month-to-date must not include yesterday when yesterday was last month.
    const today = String(r.today ?? new Date().toISOString().slice(0, 10));
    let monthMicros = micros(r.m_costed, r.m_sum);
    if (today.endsWith("-01")) monthMicros = micros(r.today_costed, r.today_sum);
    return {
      day: today,
      todayMicros: micros(r.today_costed, r.today_sum),
      yesterdayMicros: micros(r.y_costed, r.y_sum),
      monthMicros,
      todayReports: Number(r.today_costed ?? 0) + Number(r.today_uncosted ?? 0),
      todayUncostedReports: Number(r.today_uncosted ?? 0),
      topAgents: top.rows.map((a) => ({
        agentId: String(a.agent_id),
        slug: String(a.slug),
        displayName: String(a.display_name),
        costMicros: micros(a.costed, a.cost),
        reports: Number(a.reports),
      })),
    };
  }

  async overview(): Promise<OpsOverview> {
    const [postgres, redis, schema, windows, cost, email] = await Promise.all([
      timed(() => this.store.pg.query("SELECT 1")),
      timed(() => this.store.redis.ping()),
      section(() => schemaStatus(this.store.pg)),
      section(() => this.metrics()),
      section(() => this.cost()),
      section(async () => {
        const h = await this.emailDeliveries.health();
        const d = h.windows.day;
        return {
          status: h.status,
          reasons: h.reasons,
          transport: h.transport,
          deliveryTruth: h.deliveryTruth,
          day: { attempts: d.attempts, accepted: d.accepted, rejected: d.rejected, errored: d.errored, redeemed: d.redeemed },
        };
      }),
    ]);

    const ok = !("error" in windows);
    return {
      generatedAt: new Date().toISOString(),
      anomalies: ok ? anomaliesFor(windows as Record<string, MetricWindows>) : [],
      metrics: ok
        ? OPS_METRICS.map(({ sql: _sql, ...def }) => ({ ...def, ...(windows as Record<string, MetricWindows>)[def.key]! }))
        : (windows as { error: string }),
      health: { postgres, redis, publicDeploy: this.store.config.publicDeploy },
      schema,
      cost,
      email,
    };
  }
}
