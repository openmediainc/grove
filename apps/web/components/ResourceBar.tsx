"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { getTheme, readThemeChoice } from "@/lib/themes";
import { startPoll } from "@/lib/poll";
import { costLine, money, NOT_REPORTED, resourceTerms, tokens, totalTokens, type UsageDay, type UsageResponse } from "@/lib/cost";

/**
 * The resource counter: what today cost, for the viewer's own agents or their
 * org, in the map's chrome — the Age of Empires gold count.
 *
 * Renders nothing for a spectator or for someone with no agents: there is no
 * resource to count, and a "$0.00" for nobody would be a fake signal. A day
 * with tokens and no prices says "cost not reported".
 */

const POLL_MS = 30_000;
const SCOPE_KEY = "grove-cost-scope";

function readScope(): string {
  try {
    return window.localStorage.getItem(SCOPE_KEY) ?? "mine";
  } catch {
    return "mine";
  }
}

export function ResourceBar({ signedIn }: { signedIn: boolean | null }) {
  const [day, setDay] = useState<UsageDay | null>(null);
  const [scope, setScope] = useState("mine");
  const [terms, setTerms] = useState(() => resourceTerms(null));

  useEffect(() => setScope(readScope()), []);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    const pull = async () => {
      setTerms(resourceTerms(getTheme(readThemeChoice())));
      try {
        const r = await api<UsageResponse>(`/api/v1/usage?scope=${encodeURIComponent(scope)}`);
        if (!cancelled) setDay(r.usage);
      } catch (e) {
        // A stored org scope the viewer has since left: fall back to their own.
        if ((e as { status?: number }).status === 404 && scope !== "mine" && !cancelled) setScope("mine");
      }
    };
    const stopPoll = startPoll(() => void pull(), POLL_MS);
    return () => {
      cancelled = true;
      stopPoll();
    };
  }, [signedIn, scope]);

  if (!signedIn || !day) return null;
  if (day.owned_agents === 0 && day.orgs.length === 0) return null;

  const t = day.totals;
  const alerts = day.budget_alerts;
  const over = alerts.some((a) => a.budget.state === "over");
  const choose = (next: string) => {
    setScope(next);
    try {
      window.localStorage.setItem(SCOPE_KEY, next);
    } catch {
      /* the choice lasts as long as the tab */
    }
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line pb-2 normal-case tracking-normal">
      <span className="inline-flex items-center gap-1.5 text-sm text-ink" title={`Today's ${terms.name} (UTC day, ${day.scope.label})`}>
        <svg aria-hidden width="14" height="14" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="6" fill={t.cost_micros === null ? "#64748b" : terms.coin} stroke={terms.rim} strokeWidth="1.5" />
          <text x="7" y="10" textAnchor="middle" fontSize="8" fontWeight="700" fill={terms.rim}>
            {t.cost_micros === null ? "?" : "$"}
          </text>
        </svg>
        <span className="font-brand-mono tabular-nums">
          {t.cost_micros !== null ? money(t.cost_micros) : t.reports ? `cost ${NOT_REPORTED}` : "no usage reported today"}
        </span>
      </span>
      <span className="tabular-nums text-xs text-muted" title="Input, output and cache tokens reported today">
        {tokens(totalTokens(t))} tokens
      </span>
      {t.uncosted_reports > 0 && t.cost_micros !== null ? (
        <span className="text-[10px] text-muted" title="Reports that carried tokens but no price">
          + {t.uncosted_reports} unpriced
        </span>
      ) : null}
      {alerts.length ? (
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] ${over ? "border border-danger-ink/60 text-danger-ink" : "border border-line-strong bg-tint text-ink"}`}
          title={alerts.map((a) => `${a.display_name}: ${money(a.budget.month_to_date_micros)} of ${money(a.budget.monthly_micros)}`).join("\n")}
        >
          {alerts.length === 1 ? `${alerts[0]!.display_name} ${alerts[0]!.budget.state} budget` : `${alerts.length} near budget`}
        </span>
      ) : null}
      {day.orgs.length ? (
        <select
          aria-label="Whose spend"
          value={scope}
          onChange={(e) => choose(e.target.value)}
          className="rounded bg-surface-raised px-1 py-0.5 text-[10px] text-muted ring-1 ring-line-strong"
        >
          <option value="mine">mine</option>
          {day.orgs.map((o) => (
            <option key={o.id} value={`org:${o.id}`}>
              {o.name}
            </option>
          ))}
        </select>
      ) : null}
      <Link href="/me#cost" className="text-[10px] text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink" title={costLine(t)}>
        what did today cost
      </Link>
    </div>
  );
}
