"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { BUDGET_TONE, budgetLine, costLine, money, tokens, totalTokens, type UsageResponse } from "@/lib/cost";
import { ErrorNotice } from "@/components/ErrorNotice";
import { INPUT_CLASS, LINK_CLASS, NUM_CLASS, SECTION_TITLE_CLASS, buttonClass } from "@/lib/brand-ui";

/**
 * Settings: this agent's spend today and its optional monthly budget.
 *
 * The budget is set on the agent's Settings tab because that is where an owner
 * already sets what an agent may do; the day's full breakdown lives on /me#cost
 * with the rest of the owner's agents.
 */
export function AgentBudget({ agentId }: { agentId: string }) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function refresh() {
    const r = await api<UsageResponse>(`/api/v1/usage?scope=agent:${encodeURIComponent(agentId)}`);
    setData(r);
    const monthly = r.usage.by_agent[0]?.budget?.monthly_micros ?? null;
    setDraft(monthly === null ? "" : String(monthly / 1_000_000));
  }

  useEffect(() => {
    void refresh().catch((e) => setErr(e));
  }, [agentId]);

  async function save(monthlyUsd: number | null) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/v1/agents/${agentId}/budget`, { method: "PUT", body: JSON.stringify({ monthly_usd: monthlyUsd }) });
      await refresh();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const u = data?.usage;
  const row = u?.by_agent[0];
  // The agent may have spent nothing today and still carry a budget: the
  // server returns it in budget_alerts only when near/over, so an agent with no
  // report today shows its budget from the draft rather than inventing a state.
  const budget = row?.budget ?? null;
  const line = budgetLine(budget);

  return (
    <section className="mt-8">
      <h2 className={SECTION_TITLE_CLASS}>Budget</h2>
      <p className="mt-1 text-sm text-muted">
        What this agent reported today, and an optional monthly cap in USD (UTC month). Glasshouse warns at 80% and over; it
        does not stop the agent.
      </p>
      <ErrorNotice error={err} className="mt-2" />
      {u ? (
        <div className="mt-3 rounded-gh-lg border border-line bg-surface-raised p-3 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-4">
            <span className={`text-ink ${NUM_CLASS}`}>{row ? costLine(row) : "nothing reported today"}</span>
            {row ? <span className={`text-muted ${NUM_CLASS}`}>{tokens(totalTokens(row))} tokens</span> : null}
            <Link href="/me#cost" className={`ml-auto text-xs ${LINK_CLASS}`}>
              the whole day →
            </Link>
          </div>
          {line && budget ? <p className={`mt-1 text-xs ${BUDGET_TONE[budget.state]}`}>{line}</p> : null}
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(draft);
              if (!draft.trim()) return void save(null);
              if (!Number.isFinite(n) || n <= 0) return setErr("A budget is a positive dollar amount, or empty for none.");
              void save(n);
            }}
          >
            <label className="text-xs text-muted" htmlFor="budget-usd">
              Monthly budget $
            </label>
            <input
              id="budget-usd"
              inputMode="decimal"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="none"
              className={`${INPUT_CLASS} !w-28 ${NUM_CLASS}`}
            />
            <button type="submit" disabled={busy} className={buttonClass("secondary", "md")}>
              Save
            </button>
            {row?.budget?.monthly_micros ? (
              <button type="button" disabled={busy} onClick={() => void save(null)} className={buttonClass("ghost", "md", "text-muted")}>
                Clear ({money(row.budget.monthly_micros)})
              </button>
            ) : null}
          </form>
        </div>
      ) : null}
    </section>
  );
}
