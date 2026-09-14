"use client";

import { gp } from "@/lib/base";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { agentHref } from "@/lib/agent-page";
import {
  BUDGET_TONE,
  budgetLine,
  centsMoney,
  costLine,
  money,
  NOT_REPORTED,
  tokens,
  totalTokens,
  type Totals,
  type UsageResponse,
} from "@/lib/cost";
import { ErrorNotice } from "@/components/ErrorNotice";
import {
  EMPTY_CLASS,
  LINK_CLASS,
  NUM_CLASS,
  SELECT_CLASS,
  TABLE_CLASS,
  TABLE_WRAP_CLASS,
  TD_CLASS,
  TH_CLASS,
  buttonClass,
} from "@/lib/brand-ui";

/**
 * "What did today cost" — per agent, per model, per hour.
 *
 * Lives on /me (#cost), beside the owner's agents: spend is the other half of
 * "how did today go". An agent's own budget is set on its Settings tab; a space
 * page is one plot, and an agent's spend is not tied to a plot.
 *
 * Every number here came from GET /api/v1/usage, which decided in SQL what this
 * viewer may see. The page adds no rule of its own.
 */

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

function Cell({ t }: { t: Totals }) {
  return (
    <>
      <td className={`${TD_CLASS} ${NUM_CLASS} text-right`}>
        {t.cost_micros === null ? <span className="text-muted">{NOT_REPORTED}</span> : money(t.cost_micros)}
        {t.cost_micros !== null && t.uncosted_reports ? (
          <span className="block text-gh-xs text-muted">+ {t.uncosted_reports} unpriced</span>
        ) : null}
      </td>
      <td className={`${TD_CLASS} ${NUM_CLASS} text-right text-muted`}>{tokens(totalTokens(t))}</td>
    </>
  );
}

export function CostToday() {
  const [scope, setScope] = useState("mine");
  const [day, setDay] = useState(utcToday);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    void api<UsageResponse>(`/api/v1/usage?scope=${encodeURIComponent(scope)}&day=${day}`)
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setErr(e));
    return () => {
      cancelled = true;
    };
  }, [scope, day]);

  const u = data?.usage;
  const today = utcToday();
  // Bars are sized by cost when anything that day was priced, otherwise by
  // tokens — and an hour with reports but no price is drawn hatched, never as
  // an empty (free-looking) bar.
  const priced = Boolean(u && u.totals.cost_micros !== null);
  const peak = u ? Math.max(1, ...u.by_hour.map((h) => (priced ? h.cost_micros ?? 0 : totalTokens(h)))) : 1;

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-brand text-gh-base font-bold text-ink">What did {day === today ? "today" : day} cost</h3>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button type="button" onClick={() => setDay(shiftDay(day, -1))} className={buttonClass("secondary", "sm", "min-h-11 sm:min-h-8")}>
            ← earlier
          </button>
          <button
            type="button"
            disabled={day >= today}
            onClick={() => setDay(shiftDay(day, 1))}
            className={buttonClass("secondary", "sm", "min-h-11 sm:min-h-8")}
          >
            later →
          </button>
          {u && u.orgs.length ? (
            <select
              aria-label="Whose spend"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className={`${SELECT_CLASS} w-auto text-gh-sm`}
            >
              <option value="mine">my agents</option>
              {u.orgs.map((o) => (
                <option key={o.id} value={`org:${o.id}`}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">
        UTC day. Reported by the agents themselves; a cost they did not report is shown as {NOT_REPORTED}, never as $0.
      </p>

      <ErrorNotice error={err} className="mt-4" />
      {!u ? (
        err ? null : <p className="mt-4 text-sm text-muted">Adding it up…</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className={`font-brand-mono text-gh-2xl tabular-nums text-ink`}>
              {u.totals.reports === 0 ? "nothing reported" : u.totals.cost_micros === null ? `cost ${NOT_REPORTED}` : money(u.totals.cost_micros)}
            </span>
            <span className={`text-sm text-muted ${NUM_CLASS}`}>{tokens(totalTokens(u.totals))} tokens</span>
            <span className={`text-xs text-muted ${NUM_CLASS}`}>
              {u.totals.reports} report{u.totals.reports === 1 ? "" : "s"}
              {u.totals.uncosted_reports ? ` · ${u.totals.uncosted_reports} without a price` : ""}
            </span>
          </div>

          {u.totals.reports === 0 ? (
            <p className={`mt-3 ${EMPTY_CLASS}`}>
              No agent in view reported usage on this day. Agents report with <code>POST /world/usage</code> or the MCP{" "}
              <code>report_usage</code> tool — see <a className={LINK_CLASS} href={gp("/PULSE.md")}>PULSE.md</a>.
            </p>
          ) : (
            <>
              <div className="mt-5" role="img" aria-label={`Spend by UTC hour: ${u.by_hour.filter((h) => h.reports).map((h) => `${h.hour}:00 ${costLine(h)}`).join("; ")}`}>
                <div className="flex h-20 items-end gap-[2px]">
                  {u.by_hour.map((h) => {
                    const v = priced ? h.cost_micros ?? 0 : totalTokens(h);
                    const unpriced = h.reports > 0 && h.cost_micros === null;
                    const height = h.reports ? Math.max(6, Math.round((v / peak) * 100)) : 0;
                    return (
                      <div
                        key={h.hour}
                        title={`${String(h.hour).padStart(2, "0")}:00 UTC — ${costLine(h)}, ${tokens(totalTokens(h))} tokens`}
                        className={`flex-1 rounded-t-sm ${unpriced ? "bg-line-strong" : "bg-pane"}`}
                        style={{
                          height: `${unpriced && priced ? 6 : height}%`,
                          backgroundImage: unpriced
                            ? "repeating-linear-gradient(45deg, rgb(var(--gh-surface-raised-rgb) / .5) 0 2px, transparent 2px 5px)"
                            : undefined,
                        }}
                      />
                    );
                  })}
                </div>
                <div className={`mt-1 flex justify-between text-gh-xs text-muted ${NUM_CLASS}`}>
                  <span>00</span>
                  <span>06</span>
                  <span>12</span>
                  <span>18</span>
                  <span>23</span>
                </div>
                <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-gh-xs text-muted" aria-hidden>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-2 w-3 rounded-sm bg-pane" /> {priced ? "cost" : "tokens"} per UTC hour
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-2 w-3 rounded-sm bg-line-strong" /> reported without a price
                  </span>
                </p>
              </div>

              <div className="mt-6 grid gap-6 md:grid-cols-2">
                <div className={TABLE_WRAP_CLASS}>
                  <table className={TABLE_CLASS}>
                    <thead>
                      <tr>
                        <th className={TH_CLASS}>Agent</th>
                        <th className={`${TH_CLASS} text-right`}>Cost</th>
                        <th className={`${TH_CLASS} text-right`}>Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {u.by_agent.map((a) => {
                        const line = budgetLine(a.budget);
                        return (
                          <tr key={a.agent_id}>
                            <td className={TD_CLASS}>
                              <Link href={agentHref(a.agent_id, "settings")} className={LINK_CLASS}>
                                {a.display_name}
                              </Link>
                              {line && a.budget ? <span className={`block text-gh-xs ${BUDGET_TONE[a.budget.state]}`}>{line}</span> : null}
                            </td>
                            <Cell t={a} />
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className={TABLE_WRAP_CLASS}>
                  <table className={TABLE_CLASS}>
                    <thead>
                      <tr>
                        <th className={TH_CLASS}>Model</th>
                        <th className={`${TH_CLASS} text-right`}>Cost</th>
                        <th className={`${TH_CLASS} text-right`}>Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {u.by_model.map((m) => (
                        <tr key={m.model ?? ""}>
                          <td className={`${TD_CLASS} break-all font-brand-mono text-gh-xs`}>
                            {m.model ?? <span className="text-muted">model not given</span>}
                          </td>
                          <Cell t={m} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {u.budget_alerts.length ? (
            <ul className="mt-5 space-y-1 text-sm">
              {u.budget_alerts.map((a) => (
                <li key={a.agent_id} className={BUDGET_TONE[a.budget.state]}>
                  {a.display_name}: {budgetLine(a.budget)}
                </li>
              ))}
            </ul>
          ) : null}

          {data?.paperclip ? (
            <div className="mt-8 rounded-gh-lg border border-line bg-surface p-4 text-sm">
              <h3 className="gh-label text-muted">Paperclip this month · operator view</h3>
              {!data.paperclip.ok ? (
                <p className="mt-2 text-muted">Paperclip did not answer, so its budgets are unknown right now.</p>
              ) : (
                <>
                  {data.paperclip.company ? (
                    <p className="mt-2 text-muted">
                      Company: {centsMoney(data.paperclip.company.spent_monthly_cents)} of{" "}
                      {data.paperclip.company.budget_monthly_cents === null ? "no budget" : centsMoney(data.paperclip.company.budget_monthly_cents)}
                    </p>
                  ) : null}
                  <ul className="mt-2 space-y-1">
                    {data.paperclip.agents.map((a) => (
                      <li key={a.id} className="flex flex-wrap justify-between gap-2">
                        <span className="text-ink">{a.name}</span>
                        <span className={`${NUM_CLASS} text-muted`}>
                          {centsMoney(a.spent_monthly_cents)} · {a.budget_monthly_cents === null ? "no budget" : `budget ${centsMoney(a.budget_monthly_cents)}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
