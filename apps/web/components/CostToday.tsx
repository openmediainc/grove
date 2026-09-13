"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
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

/**
 * "What did today cost" — per agent, per model, per hour.
 *
 * Lives on /agents, the owner's "which of my agents needs me" page, rather than
 * on a new top-level page: that page is already the owner's day across all of
 * their agents, and spend is the other half of the same question. Studio is one
 * agent; a space page is one plot, and an agent's spend is not tied to a plot.
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
      <td className="py-1.5 pr-3 text-right tabular-nums">
        {t.cost_micros === null ? <span className="text-white/40">{NOT_REPORTED}</span> : money(t.cost_micros)}
        {t.cost_micros !== null && t.uncosted_reports ? (
          <span className="block text-[10px] text-white/35">+ {t.uncosted_reports} unpriced</span>
        ) : null}
      </td>
      <td className="py-1.5 text-right tabular-nums text-white/60">{tokens(totalTokens(t))}</td>
    </>
  );
}

export function CostToday() {
  const [scope, setScope] = useState("mine");
  const [day, setDay] = useState(utcToday);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    void api<UsageResponse>(`/api/v1/usage?scope=${encodeURIComponent(scope)}&day=${day}`)
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setErr((e as Error).message));
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
    <section id="cost" className="mt-10 scroll-mt-20">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-2xl text-lantern-300">What did {day === today ? "today" : day} cost</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button type="button" onClick={() => setDay(shiftDay(day, -1))} className="rounded-full border border-white/15 px-3 py-2 sm:py-1">
            ← earlier
          </button>
          <button
            type="button"
            disabled={day >= today}
            onClick={() => setDay(shiftDay(day, 1))}
            className="rounded-full border border-white/15 px-3 py-2 disabled:opacity-30 sm:py-1"
          >
            later →
          </button>
          {u && u.orgs.length ? (
            <select
              aria-label="Whose spend"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="rounded-lg bg-dusk-800 px-2 py-2 ring-1 ring-white/10 sm:py-1"
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
      <p className="mt-1 text-xs text-white/40">
        UTC day. Reported by the agents themselves; a cost they did not report is shown as {NOT_REPORTED}, never as $0.
      </p>

      {err ? <p className="mt-4 text-sm text-red-300">{err}</p> : null}
      {!u ? (
        err ? null : <p className="mt-4 text-sm text-white/40">Adding it up…</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className="font-display text-3xl text-white">
              {u.totals.reports === 0 ? "nothing reported" : u.totals.cost_micros === null ? `cost ${NOT_REPORTED}` : money(u.totals.cost_micros)}
            </span>
            <span className="text-sm text-white/55">{tokens(totalTokens(u.totals))} tokens</span>
            <span className="text-xs text-white/40">
              {u.totals.reports} report{u.totals.reports === 1 ? "" : "s"}
              {u.totals.uncosted_reports ? ` · ${u.totals.uncosted_reports} without a price` : ""}
            </span>
          </div>

          {u.totals.reports === 0 ? (
            <p className="mt-3 text-sm text-white/45">
              No agent in view reported usage on this day. Agents report with <code>POST /world/usage</code> or the MCP{" "}
              <code>report_usage</code> tool — see <a className="underline" href="/grove/PULSE.md">PULSE.md</a>.
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
                        className={`flex-1 rounded-t-sm ${unpriced ? "bg-slate-400/40" : "bg-amber-400/80"}`}
                        style={{
                          height: `${unpriced && priced ? 6 : height}%`,
                          backgroundImage: unpriced
                            ? "repeating-linear-gradient(45deg, rgba(255,255,255,.25) 0 2px, transparent 2px 5px)"
                            : undefined,
                        }}
                      />
                    );
                  })}
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-white/35">
                  <span>00</span>
                  <span>06</span>
                  <span>12</span>
                  <span>18</span>
                  <span>23</span>
                </div>
              </div>

              <div className="mt-6 grid gap-6 md:grid-cols-2">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-widest text-white/40">
                        <th className="pb-1 font-normal">Agent</th>
                        <th className="pb-1 pr-3 text-right font-normal">Cost</th>
                        <th className="pb-1 text-right font-normal">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {u.by_agent.map((a) => {
                        const line = budgetLine(a.budget);
                        return (
                          <tr key={a.agent_id} className="border-t border-white/5 align-top">
                            <td className="py-1.5 pr-3">
                              <Link href={`/studio/${a.agent_id}`} className="hover:underline">
                                {a.display_name}
                              </Link>
                              {line && a.budget ? <span className={`block text-[10px] ${BUDGET_TONE[a.budget.state]}`}>{line}</span> : null}
                            </td>
                            <Cell t={a} />
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-widest text-white/40">
                        <th className="pb-1 font-normal">Model</th>
                        <th className="pb-1 pr-3 text-right font-normal">Cost</th>
                        <th className="pb-1 text-right font-normal">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {u.by_model.map((m) => (
                        <tr key={m.model ?? ""} className="border-t border-white/5 align-top">
                          <td className="break-all py-1.5 pr-3">
                            {m.model ?? <span className="text-white/45">model not given</span>}
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
            <div className="mt-8 rounded-xl border border-violet-300/15 bg-violet-300/5 p-4 text-sm">
              <h3 className="text-xs uppercase tracking-widest text-violet-200/70">Paperclip this month · operator view</h3>
              {!data.paperclip.ok ? (
                <p className="mt-2 text-white/45">Paperclip did not answer, so its budgets are unknown right now.</p>
              ) : (
                <>
                  {data.paperclip.company ? (
                    <p className="mt-2 text-white/70">
                      Company: {centsMoney(data.paperclip.company.spent_monthly_cents)} of{" "}
                      {data.paperclip.company.budget_monthly_cents === null ? "no budget" : centsMoney(data.paperclip.company.budget_monthly_cents)}
                    </p>
                  ) : null}
                  <ul className="mt-2 space-y-1">
                    {data.paperclip.agents.map((a) => (
                      <li key={a.id} className="flex flex-wrap justify-between gap-2">
                        <span>{a.name}</span>
                        <span className="tabular-nums text-white/60">
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
