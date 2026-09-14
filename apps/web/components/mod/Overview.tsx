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
      ? "border-red-400/60 bg-red-500/10"
      : tone === "warn"
        ? "border-amber-400/50 bg-amber-500/10"
        : tone === "ok"
          ? "border-emerald-400/30 bg-emerald-500/5"
          : "border-white/10 bg-dusk-800/60";
  return (
    <div className={`rounded-xl border p-4 ${ring}`}>
      <h3 className="text-xs uppercase tracking-widest text-lantern-400">{title}</h3>
      <div className="mt-2 text-sm text-white/80">{children}</div>
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
          className={i === series.length - 1 ? "w-1.5 bg-lantern-300" : "w-1.5 bg-white/25"}
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
  if (!data) return <p className="mt-4 text-white/55">Loading…</p>;

  const { health, schema, cost, email } = data;
  const up = health.postgres.ok && health.redis.ok;

  return (
    <section className="mt-4 space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-white/55">
          Last 24 hours against the 24 hours before and the week&apos;s median · updated{" "}
          {new Date(data.generated_at).toLocaleTimeString()}
        </p>
        <button onClick={() => void load()} className="rounded-full bg-white/10 px-3 py-1 text-xs">
          Refresh
        </button>
      </div>

      {/* --- anomaly lines ---------------------------------------------------- */}
      <div>
        <h3 className="text-xs uppercase tracking-widest text-lantern-400">Anomalies</h3>
        {data.anomalies.length ? (
          <ul className="mt-2 space-y-2">
            {data.anomalies.map((a) => (
              <li
                key={a.metric}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  a.severity === "critical" ? "border-red-400/60 bg-red-500/15 text-red-100" : "border-amber-400/50 bg-amber-500/10 text-amber-100"
                }`}
              >
                <span className="font-semibold">{a.direction === "up" ? "▲" : "▼"}</span> {a.text}
              </li>
            ))}
          </ul>
        ) : failed(data.metrics) ? (
          <p className="mt-2 text-sm text-red-300">Could not compute anomalies: {data.metrics.error}</p>
        ) : (
          <p className="mt-2 text-sm text-emerald-200/80">Nothing unusual: every metric is within its normal range.</p>
        )}
      </div>

      {/* --- health, schema, cost, email -------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card title="Health" tone={up ? "ok" : "bad"}>
          <p>
            Postgres {health.postgres.ok ? `up · ${health.postgres.ms}ms` : `DOWN — ${health.postgres.error ?? "no answer"}`}
          </p>
          <p>Redis {health.redis.ok ? `up · ${health.redis.ms}ms` : `DOWN — ${health.redis.error ?? "no answer"}`}</p>
          <p className="mt-1 text-xs text-white/55">{health.public_deploy ? "Public deploy" : "Local / test deploy"}</p>
        </Card>

        <Card title="Schema" tone={failed(schema) ? "bad" : schema.ok ? "ok" : "bad"}>
          {failed(schema) ? (
            <p className="text-red-200">Could not read schema_migrations: {schema.error}</p>
          ) : (
            <>
              <p>
                {schema.ok ? "In step with the code" : "Drift"} · {schema.applied} applied of {schema.on_disk} on disk
              </p>
              {schema.pending.length ? (
                <p className="mt-1 break-all text-red-200">
                  Not applied yet: {schema.pending.join(", ")} — run <code>pnpm migrate</code>.
                </p>
              ) : null}
              {schema.unknown.length ? (
                <p className="mt-1 break-all text-amber-200">
                  In the database but not in this build: {schema.unknown.join(", ")}
                </p>
              ) : null}
            </>
          )}
        </Card>

        <Card title="Cost burn (UTC day)">
          {failed(cost) ? (
            <p className="text-red-200">Could not read usage: {cost.error}</p>
          ) : (
            <>
              <p>
                Today {money(cost.today_micros)} · yesterday {money(cost.yesterday_micros)} · month {money(cost.month_micros)}
              </p>
              <p className="text-xs text-white/55">
                {cost.today_reports} report(s) today
                {cost.today_uncosted_reports ? `, ${cost.today_uncosted_reports} without a price` : ""}
              </p>
              {cost.top_agents.length ? (
                <ul className="mt-2 space-y-0.5 text-xs">
                  {cost.top_agents.map((a) => (
                    <li key={a.agent_id}>
                      {a.display_name} <span className="text-white/55">@{a.slug}</span> — {money(a.cost_micros)}
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
            <p className="text-red-200">Could not read the delivery ledger: {email.error}</p>
          ) : (
            <>
              <p>
                Magic links: {email.status} · <code>{email.transport}</code>
              </p>
              <p className="text-xs text-white/55">
                24h: {email.day.attempts} issued, {email.day.accepted} accepted, {email.day.rejected + email.day.errored} failed,{" "}
                {email.day.redeemed} used
              </p>
              {email.reasons.slice(0, 3).map((r) => (
                <p key={r.code} className="mt-1 text-xs">
                  {r.message}
                </p>
              ))}
              {email.dmarc ? <p className="mt-1 text-xs text-white/50">{dmarcApplied(email.dmarc)}</p> : null}
              <p className="mt-1 text-xs text-white/55">Details in the Email tab.</p>
            </>
          )}
        </Card>
      </div>

      {/* --- visitors & funnel (first-party, docs/PRIVACY.md) ------------------ */}
      {data.analytics ? <FunnelCard a={data.analytics} /> : null}

      {/* --- every metric ----------------------------------------------------- */}
      {!failed(data.metrics) ? (
        <div>
          <h3 className="text-xs uppercase tracking-widest text-lantern-400">Pulse and traffic</h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs text-white/55">
                <tr>
                  <th className="py-1 pr-3 font-normal">Metric</th>
                  <th className="py-1 pr-3 font-normal">Last 24h</th>
                  <th className="py-1 pr-3 font-normal">Day before</th>
                  <th className="py-1 pr-3 font-normal">Median</th>
                  <th className="py-1 font-normal">8 days</th>
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((m) => {
                  const flagged = data.anomalies.some((a) => a.metric === m.key);
                  return (
                    <tr key={m.key} className="border-t border-white/5">
                      <td className={`py-1 pr-3 ${flagged ? "text-amber-200" : "text-white/80"}`}>{m.label}</td>
                      <td className="py-1 pr-3">{amount(m, m.current)}</td>
                      <td className="py-1 pr-3 text-white/60">{amount(m, m.previous)}</td>
                      <td className="py-1 pr-3 text-white/60">{amount(m, m.median)}</td>
                      <td className="py-1">
                        <Spark m={m} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {err ? (
        <div>
          <p className="text-xs text-white/55">Last refresh failed; these numbers are from the one before.</p>
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
        <p className="text-red-200">Could not read analytics: {a.error}</p>
      </Card>
    );
  }
  const weeks = Math.max(1, ...a.cohorts.map((c) => c.active.length));
  return (
    <Card title="Visitors & funnel">
      <p className="text-xs text-white/55">
        UTC day {a.day} so far, against yesterday and the median of the 7 days before. People only, no IPs or identities
        stored, DNT/GPC honoured, kept {a.retention_days} days ·{" "}
        <a
          className="underline decoration-dotted"
          href="https://github.com/openmediainc/grove/blob/main/docs/PRIVACY.md"
          target="_blank"
          rel="noreferrer"
        >
          privacy stance
        </a>
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[360px] text-left text-sm">
          <thead className="text-xs text-white/55">
            <tr>
              <th className="py-1 pr-3 font-normal"> </th>
              <th className="py-1 pr-3 font-normal">Today</th>
              <th className="py-1 pr-3 font-normal">Yesterday</th>
              <th className="py-1 font-normal">7-day median</th>
            </tr>
          </thead>
          <tbody>
            {a.series.map((r) => (
              <tr key={r.key} className="border-t border-white/5">
                <td className="py-1 pr-3 text-white/80">{r.label}</td>
                <td className="py-1 pr-3">{r.today}</td>
                <td className="py-1 pr-3 text-white/60">{r.yesterday}</td>
                <td className="py-1 text-white/60">{countText(r.median7)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 className="mt-4 text-xs uppercase tracking-widest text-white/50">Weekly retention (signed-in people)</h4>
      <p className="text-xs text-white/55">
        Rows: the week people first signed in. Columns: share of them active in week N (0 = that week).
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead className="text-white/55">
            <tr>
              <th className="py-1 pr-2 font-normal">Cohort</th>
              <th className="py-1 pr-2 font-normal">People</th>
              {Array.from({ length: weeks }, (_, n) => (
                <th key={n} className="py-1 pr-2 font-normal">
                  W{n}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.cohorts.map((c) => (
              <tr key={c.cohort_week} className="border-t border-white/5">
                <td className="py-1 pr-2 text-white/70">{weekLabel(c.cohort_week)}</td>
                <td className="py-1 pr-2">{c.size}</td>
                {Array.from({ length: weeks }, (_, n) => (
                  <td key={n} className="py-1 pr-2 text-white/70" title={n < c.active.length ? `${c.active[n]} of ${c.size}` : ""}>
                    {n < c.active.length ? cohortPercent(c.active[n] ?? 0, c.size) : ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
