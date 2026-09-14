/**
 * Cost burn on the web: the wire shape of GET /api/v1/usage and the only
 * functions allowed to turn it into words.
 *
 * The rule every function here keeps: a null cost is "not reported", never
 * "$0.00". A day where some reports were priced and some were not shows the
 * priced total and says how many were not — it never implies the unpriced ones
 * were free.
 */

import type { Theme } from "@/lib/themes";

export type Totals = {
  reports: number;
  costed_reports: number;
  uncosted_reports: number;
  /** Null when nothing in the bucket was priced. */
  cost_micros: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

export type BudgetState = "none" | "unknown" | "ok" | "near" | "over";

export type Budget = {
  monthly_micros: number | null;
  month_to_date_micros: number | null;
  month_uncosted_reports: number;
  projected_micros: number | null;
  state: BudgetState;
};

export type UsageDay = {
  scope: { kind: "mine" | "agent" | "org" | "space"; id: string | null; label: string };
  day: string;
  currency: "USD";
  totals: Totals;
  by_agent: Array<Totals & { agent_id: string; display_name: string; budget: Budget | null }>;
  by_model: Array<Totals & { model: string | null }>;
  by_hour: Array<Totals & { hour: number }>;
  budget_alerts: Array<{ agent_id: string; display_name: string; budget: Budget }>;
  owned_agents: number;
  orgs: Array<{ id: string; slug: string; name: string }>;
};

export type PaperclipBudgets = {
  ok: boolean;
  company: { budget_monthly_cents: number | null; spent_monthly_cents: number | null } | null;
  agents: Array<{ id: string; name: string; budget_monthly_cents: number | null; spent_monthly_cents: number | null }>;
} | null;

export type UsageResponse = { usage: UsageDay; paperclip: PaperclipBudgets };

export const NOT_REPORTED = "not reported";

/** Dollars from integer micro-dollars. Small amounts keep enough digits to be non-zero. */
export function money(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return NOT_REPORTED;
  const usd = micros / 1_000_000;
  if (micros === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

/** Paperclip keeps cents; convert exactly, and keep its unknown unknown. */
export function centsMoney(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? NOT_REPORTED : money(cents * 10_000);
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function totalTokens(t: Totals): number {
  return t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens;
}

/** "$1.23", "$1.23 · 2 unpriced", "not reported", or "nothing reported". */
export function costLine(t: Totals): string {
  if (t.reports === 0) return "nothing reported";
  if (t.cost_micros === null) return `cost ${NOT_REPORTED}`;
  return t.uncosted_reports > 0 ? `${money(t.cost_micros)} · ${t.uncosted_reports} unpriced` : money(t.cost_micros);
}

export const BUDGET_TONE: Record<BudgetState, string> = {
  none: "text-muted",
  unknown: "text-muted",
  ok: "text-success",
  near: "text-signal-text",
  over: "text-danger-ink",
};

export function budgetLine(b: Budget | null): string | null {
  if (!b || b.state === "none" || b.monthly_micros === null) return null;
  const of = `of ${money(b.monthly_micros)} this month`;
  if (b.state === "unknown") return `spend ${NOT_REPORTED} ${of}`;
  const pace = b.projected_micros !== null ? ` · on pace for ${money(b.projected_micros)}` : "";
  const word = b.state === "over" ? "over budget: " : b.state === "near" ? "near budget: " : "";
  return `${word}${money(b.month_to_date_micros)} ${of}${pace}`;
}

/**
 * What the resource is called and how its icon is drawn, per theme. Optional
 * on the theme contract so a theme can adopt it when it is ready; the default
 * is aoe's gold, which is also what an honest dollar reads as on this map.
 */
export type ResourceTerms = { name: string; coin: string; rim: string };

const DEFAULT_RESOURCE: ResourceTerms = { name: "gold", coin: "#fbbf24", rim: "#92400e" };

export function resourceTerms(theme: Theme | null | undefined): ResourceTerms {
  const r = theme?.lexicon.resource;
  return { ...DEFAULT_RESOURCE, ...(r ?? {}) };
}
