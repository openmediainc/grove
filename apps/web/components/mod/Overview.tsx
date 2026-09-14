"use client";

/**
 * OPS-01 — the /mod "Overview" tab.
 *
 * The first thing an operator reads: anything behaving unlike itself (the
 * anomaly lines, worded server-side so the page and the tests say the same
 * sentence), then whether it is up, whether the schema matches the code, what
 * it is costing, and whether people can sign in.
 *
 * Operator-only: the route 404s everyone else. Schema drift is shown by file
 * name here, which public /ready never does.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { money } from "@/lib/cost";
import { dmarcApplied } from "@/components/mod/EmailHealth";
import { cohortPercent, countText, weekLabel } from "@/lib/analytics";
import { ErrorNotice } from "@/components/ErrorNotice";
import { startPoll } from "@/lib/poll";
import { LINK_CLASS, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, buttonClass } from "@/lib/brand-ui";
import { TableFrame } from "@/components/ui";

type Anomaly = {
  metric: string;
  severity: "critical" | "warning";
  direction: "up" | "down";
  text: string;
};

type Metric = {
  key: string;
  label: string;
  kind: "fault" | "traffic";
  unit: "count" | "usd_micros";
  history_days: number;
  days: number[];
  current: number;
  previous: number;
  median: number;
};

type Failed = { error: string };
type Check = { ok: boolean; ms: number | null; error?: string };

type Overview = {
  generated_at: string;
  anomalies: Anomaly[];
  metrics: Metric[] | Failed;
  health: { postgres: Check; redis: Check; public_deploy: boolean };
  schema: { ok: boolean; on_disk: number; applied: number; pending: string[]; unknown: string[] } | Failed;
  cost:
    | {
        day: string;
        today_micros: number | null;
        yesterday_micros: number | null;
        month_micros: number | null;
        today_reports: number;
        today_uncosted_reports: number;
        top_agents: Array<{ agent_id: string; slug: string; display_name: string; cost_micros: number | null; reports: number }>;
      }
    | Failed;
  email:
    | {
        status: "ok" | "degraded" | "down" | "unconfigured";
        reasons: Array<{ code: string; severity: string; message: string }>;
        transport: string;
        day: { attempts: number; accepted: number; rejected: number; errored: number; redeemed: number };
        dmarc: { name: string; present: boolean; policy: string | null; applied_from: "exact" | "organizational" | null } | null;
      }
    | Failed;
  analytics?: Analytics | Failed;
};

type Analytics = {
  day: string;
  week: string;
  retention_days: number;
  series: Array<{ key: string; label: string; today: number; yesterday: number; median7: number; days: number[] }>;
  cohorts: Array<{ cohort_week: string; size: number; active: number[] }>;
};

const failed = (v: unknown): v is Failed => typeof v === "object" && v !== null && "error" in v;

function Card({ title, tone, children }: { title: string; tone?: "ok" | "warn" | "bad"; children: React.ReactNode }) {
  const ring =
    tone === "bad"
      ? "border-danger-ink/60 bg-danger-ink/5"
      : tone === "warn"
        ? "border-signal/60 bg-signal/10"
        : tone === "ok"
          ? "border-success/50 bg-surface-raised"
          : "border-line bg-surface-raised";
  const word = tone === "bad" ? "Fault" : tone === "warn" ? "Degraded" : tone === "ok" ? "OK" : null;
  const wordTone = tone === "bad" ? "text-danger-ink" : tone === "warn" ? "text-signal-text" : "text-success";
  return (
    <div className={`rounded-gh-lg border p-4 shadow-gh-1 ${ring}`}>
      <h3 className="flex items-baseline justify-between gap-2">
        <span className="gh-label text-muted">{title}</span>
        {word ? <span className={`gh-label ${wordTone}`}>{word}</span> : null}
      </h3>
      <div className="mt-2 text-sm text-ink">{children}</div>
    </div>
  );
}

function amount(m: Metric, n: number): string {
  if (m.unit === "usd_micros") return money(n);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Eight trailing days, oldest on the left, as bars. */
function Spark({ m }: { m: Metric }) {
  const series = [...m.days].reverse();
  const max = Math.max(1, ...series);
  return (
    <div className="flex h-5 items-end gap-px" aria-hidden>
      {series.map((n, i) => (
        <span
          key={i}
          className={i === series.length - 1 ? "w-1.5 bg-signal" : "w-1.5 bg-line"}
          style={{ height: `${Math.max(2, Math.round((n / max) * 20))}px` }}
        />
      ))}
    </div>
  );
}

export function OverviewPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ overview: Overview }>("/api/v1/mod/ops");
      setData(res.overview);
      setErr(null);
    } catch (e) {
      setErr(e);
    }
  }, []);

  useEffect(() => {
    return startPoll(() => void load(), 60_000);
  }, [load]);

  if (err && !data) return <ErrorNotice error={err} onRetry={() => void load()} className="mt-4" />;
  if (!data) return <p className="mt-4 text-muted">Loading…</p>;

  const { health, schema, cost, email } = data;
  const up = health.postgres.ok && health.redis.ok;

  return (
    <section className="mt-4 space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-muted">
          Last 24 hours against the 24 hours before and the week&apos;s median · updated{" "}
          {new Date(data.generated_at).toLocaleTimeString()}
        </p>
        <button type="button" onClick={() => void load()} className={buttonClass("secondary", "sm")}>
          Refresh
        </button>
      </div>

      {/* --- anomaly lines ---------------------------------------------------- */}
      <div>
        <h3 className="gh-label text-muted">Anomalies</h3>
        {data.anomalies.length ? (
          <ul className="mt-2 space-y-2">
            {data.anomalies.map((a) => (
              <li
                key={a.metric}
                className={`rounded-gh-md border px-3 py-2 text-sm ${
                  a.severity === "critical" ? "border-danger-ink/60 bg-danger-ink/5 text-danger-ink" : "border-signal/60 bg-signal/10 text-ink"
                }`}
              >
                <span className={`font-semibold ${a.severity === "critical" ? "" : "text-signal-text"}`}>
                  {a.direction === "up" ? "▲" : "▼"} <span className="gh-label">{a.severity}</span>
                </span>{" "}
                {a.text}
              </li>
            ))}
          </ul>
        ) : failed(data.metrics) ? (
          <p className="mt-2 text-sm text-danger-ink">Could not compute anomalies: {data.metrics.error}</p>
        ) : (
          <p className="mt-2 text-sm text-success">Nothing unusual: every metric is within its normal range.</p>
        )}
      </div>

      {/* --- health, schema, cost, email -------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card title="Health" tone={up ? "ok" : "bad"}>
          <p>
            Postgres {health.postgres.ok ? `up · ${health.postgres.ms}ms` : `DOWN — ${health.postgres.error ?? "no answer"}`}
          </p>
          <p>Redis {health.redis.ok ? `up · ${health.redis.ms}ms` : `DOWN — ${health.redis.error ?? "no answer"}`}</p>
          <p className="mt-1 text-xs text-muted">{health.public_deploy ? "Public deploy" : "Local / test deploy"}</p>
        </Card>

        <Card title="Schema" tone={failed(schema) ? "bad" : schema.ok ? "ok" : "bad"}>
          {failed(schema) ? (
            <p className="text-danger-ink">Could not read schema_migrations: {schema.error}</p>
          ) : (
            <>
              <p>
                {schema.ok ? "In step with the code" : "Drift"} · {schema.applied} applied of {schema.on_disk} on disk
              </p>
              {schema.pending.length ? (
                <p className="mt-1 break-all text-danger-ink">
                  Not applied yet: {schema.pending.join(", ")} — run <code>pnpm migrate</code>.
                </p>
              ) : null}
              {schema.unknown.length ? (
                <p className="mt-1 break-all text-ink">
                  <span className="text-signal-text">Unknown:</span> In the database but not in this build: {schema.unknown.join(", ")}
                </p>
              ) : null}
            </>
          )}
        </Card>

        <Card title="Cost burn (UTC day)">
          {failed(cost) ? (
            <p className="text-danger-ink">Could not read usage: {cost.error}</p>
          ) : (
            <>
              <p>
                Today <span className={NUM_CLASS}>{money(cost.today_micros)}</span> · yesterday{" "}
                <span className={NUM_CLASS}>{money(cost.yesterday_micros)}</span> · month <span className={NUM_CLASS}>{money(cost.month_micros)}</span>
              </p>
              <p className="text-xs text-muted">
                {cost.today_reports} report(s) today
                {cost.today_uncosted_reports ? `, ${cost.today_uncosted_reports} without a price` : ""}
              </p>
              {cost.top_agents.length ? (
                <ul className="mt-2 space-y-0.5 text-xs">
                  {cost.top_agents.map((a) => (
                    <li key={a.agent_id}>
                      {a.display_name} <span className="text-muted">@{a.slug}</span> — <span className={NUM_CLASS}>{money(a.cost_micros)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </Card>

        <Card
          title="Email"
          tone={failed(email) ? "bad" : email.status === "ok" ? "ok" : email.status === "down" ? "bad" : "warn"}
        >
          {failed(email) ? (
            <p className="text-danger-ink">Could not read the delivery ledger: {email.error}</p>
          ) : (
            <>
              <p>
                Magic links: {email.status} · <code>{email.transport}</code>
              </p>
              <p className="text-xs text-muted">
                24h: {email.day.attempts} issued, {email.day.accepted} accepted, {email.day.rejected + email.day.errored} failed,{" "}
                {email.day.redeemed} used
              </p>
              {email.reasons.slice(0, 3).map((r) => (
                <p key={r.code} className="mt-1 text-xs">
                  {r.message}
                </p>
              ))}
              {email.dmarc ? <p className="mt-1 text-xs text-muted">{dmarcApplied(email.dmarc)}</p> : null}
              <p className="mt-1 text-xs text-muted">Details in the Email tab.</p>
            </>
          )}
        </Card>
      </div>

      {/* --- visitors & funnel (first-party, docs/PRIVACY.md) ------------------ */}
      {data.analytics ? <FunnelCard a={data.analytics} /> : null}

      {/* --- every metric ----------------------------------------------------- */}
      {!failed(data.metrics) ? (
        <div>
          <h3 className="gh-label text-muted">Pulse and traffic</h3>
          <TableFrame label="Pulse and traffic" className="mt-2">
            <table className={`${TABLE_CLASS} min-w-[520px]`}>
              <thead>
                <tr>
                  <th className={TH_CLASS}>Metric</th>
                  <th className={`${TH_CLASS} text-right`}>Last 24h</th>
                  <th className={`${TH_CLASS} text-right`}>Day before</th>
                  <th className={`${TH_CLASS} text-right`}>Median</th>
                  <th className={TH_CLASS}>8 days</th>
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((m) => {
                  const flagged = data.anomalies.some((a) => a.metric === m.key);
                  return (
                    <tr key={m.key}>
                      <td className={`${TD_CLASS} text-ink`}>
                        {m.label}
                        {flagged ? <span className="gh-label ml-2 text-signal-text">anomaly</span> : null}
                      </td>
                      <td className={`${TD_CLASS} ${NUM_CLASS} text-right`}>{amount(m, m.current)}</td>
                      <td className={`${TD_CLASS} ${NUM_CLASS} text-right text-muted`}>{amount(m, m.previous)}</td>
                      <td className={`${TD_CLASS} ${NUM_CLASS} text-right text-muted`}>{amount(m, m.median)}</td>
                      <td className={TD_CLASS}>
                        <Spark m={m} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableFrame>
        </div>
      ) : null}

      {err ? (
        <div>
          <p className="text-xs text-muted">Last refresh failed; these numbers are from the one before.</p>
          <ErrorNotice error={err} live="polite" size="xs" onRetry={() => void load()} className="mt-1" />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Visitors & funnel: first-party counts only (docs/PRIVACY.md). Calendar UTC
 * days here, unlike the trailing windows above: the counters are per day by
 * design, so "today" is today so far.
 */
function FunnelCard({ a }: { a: Analytics | Failed }) {
  if (failed(a)) {
    return (
      <Card title="Visitors & funnel" tone="bad">
        <p className="text-danger-ink">Could not read analytics: {a.error}</p>
      </Card>
    );
  }
  const weeks = Math.max(1, ...a.cohorts.map((c) => c.active.length));
  return (
    <Card title="Visitors & funnel">
      <p className="text-xs text-muted">
        UTC day {a.day} so far, against yesterday and the median of the 7 days before. People only, no IPs or identities
        stored, DNT/GPC honoured, kept {a.retention_days} days ·{" "}
        <a
          className={LINK_CLASS}
          href="https://github.com/openmediainc/grove/blob/main/docs/PRIVACY.md"
          target="_blank"
          rel="noreferrer"
        >
          privacy stance
        </a>
      </p>
      <TableFrame label="Visitors" className="mt-2">
        <table className={`${TABLE_CLASS} min-w-[360px]`}>
          <thead>
            <tr>
              <th className={TH_CLASS}>
                <span className="sr-only">Series</span>
              </th>
              <th className={`${TH_CLASS} text-right`}>Today</th>
              <th className={`${TH_CLASS} text-right`}>Yesterday</th>
              <th className={`${TH_CLASS} text-right`}>7-day median</th>
            </tr>
          </thead>
          <tbody>
            {a.series.map((r) => (
              <tr key={r.key}>
                <td className={`${TD_CLASS} text-ink`}>{r.label}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS} text-right`}>{r.today}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS} text-right text-muted`}>{r.yesterday}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS} text-right text-muted`}>{countText(r.median7)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>

      <h4 className="gh-label mt-4 text-muted">Weekly retention (signed-in people)</h4>
      <p className="text-xs text-muted">
        Rows: the week people first signed in. Columns: share of them active in week N (0 = that week).
      </p>
      <TableFrame label="Weekly retention" className="mt-2">
        <table className={`${TABLE_CLASS} min-w-[420px] text-gh-xs`}>
          <thead>
            <tr>
              <th className={TH_CLASS}>Cohort</th>
              <th className={`${TH_CLASS} text-right`}>People</th>
              {Array.from({ length: weeks }, (_, n) => (
                <th key={n} className={`${TH_CLASS} text-right`}>
                  W{n}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.cohorts.map((c) => (
              <tr key={c.cohort_week}>
                <td className={`${TD_CLASS} text-muted`}>{weekLabel(c.cohort_week)}</td>
                <td className={`${TD_CLASS} ${NUM_CLASS} text-right`}>{c.size}</td>
                {Array.from({ length: weeks }, (_, n) => (
                  <td key={n} className={`${TD_CLASS} ${NUM_CLASS} text-right text-muted`} title={n < c.active.length ? `${c.active[n]} of ${c.size}` : ""}>
                    {n < c.active.length ? cohortPercent(c.active[n] ?? 0, c.size) : ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </Card>
  );
}
