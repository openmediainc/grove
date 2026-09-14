"use client";

/**
 * ONB-07 — the /mod "Email" tab.
 *
 * Login is magic links and nothing else, so this is the one screen that can
 * say "nobody can sign in" while /health is green. Three truths, shown apart
 * on purpose: what the provider said at send time (accepted is not delivered),
 * what it said later (only if it has an events API), and whether people
 * actually clicked. Recipients are masked server-side; the full address is
 * never stored.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { EMPTY_CLASS, NUM_CLASS, TABLE_CLASS, TD_CLASS, TH_CLASS, buttonClass } from "@/lib/brand-ui";
import { TableFrame } from "@/components/ui";

type Reason = { code: string; severity: "critical" | "warning" | "info"; message: string };

type Window = {
  hours: number;
  attempts: number;
  accepted: number;
  rejected: number;
  errored: number;
  not_sent: number;
  send_failure_rate: number | null;
  delivered: number;
  delayed: number;
  bounced: number;
  complained: number;
  delivery_failed: number;
  delivery_unknown: number;
  redeemed: number;
  expired_unredeemed: number;
  awaiting: number;
  recipients_in: number;
  recipients_stranded: number;
  recipient_redeem_rate: number | null;
  redeem_seconds_p50: number | null;
  redeem_seconds_p90: number | null;
  last_accepted_at: string | null;
  last_redeemed_at: string | null;
};

type DnsCheck = { name: string; present: boolean | null; record: string | null };

type Health = {
  status: "ok" | "degraded" | "down" | "unconfigured";
  reasons: Reason[];
  transport: string;
  from: string;
  delivery_truth: "provider_events_polled" | "redemption_only" | "none";
  windows: { hour: Window; day: Window; week: Window };
  dns: {
    domain: string;
    checked_at: string;
    spf: DnsCheck & { checked: string[] };
    dkim: (DnsCheck & { selector: string }) | { selector: null; present: null; note: string };
    dmarc: DnsCheck & {
      policy: string | null;
      applied_from?: "exact" | "organizational" | null;
      checked?: string[];
      alignment?: { dkim: "r" | "s"; spf: "r" | "s" } | null;
    };
    error: string | null;
  } | null;
  generated_at: string;
};

type Row = {
  id: string;
  transport: string;
  recipient_hint: string;
  send_status: string;
  send_error: string | null;
  send_ms: number | null;
  delivery_status: string;
  delivery_detail: string | null;
  created_at: string;
  redeemed_at: string | null;
  redeem_seconds: number | null;
};

/** Frame per status; the text stays ink and the status word carries the tone. */
const STATUS_TONE: Record<Health["status"], string> = {
  ok: "border-success/50 bg-surface-raised",
  degraded: "border-signal/60 bg-signal/10",
  down: "border-danger-ink/60 bg-danger-ink/5",
  unconfigured: "border-line-strong bg-surface-raised",
};

const STATUS_WORD: Record<Health["status"], string> = {
  ok: "text-success",
  degraded: "text-signal-text",
  down: "text-danger-ink",
  unconfigured: "text-muted",
};

const TRUTH: Record<Health["delivery_truth"], string> = {
  provider_events_polled: "Delivery, bounces and complaints come from the provider's events API (polled).",
  redemption_only: "SMTP has no events API: delivery is unknowable here, so the redeemed rate is the signal.",
  none: "Nothing is sent, so there is no delivery to measure.",
};

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

function secs(v: number | null): string {
  if (v == null) return "—";
  return v < 90 ? `${v}s` : `${Math.round(v / 60)}m`;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-gh-md border border-line bg-surface-raised px-3 py-2">
      <p className="gh-label text-muted">{label}</p>
      <p className={`mt-0.5 text-gh-lg text-ink ${NUM_CLASS}`}>{value}</p>
      {hint ? <p className="text-gh-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function DnsLine({ label, check }: { label: string; check: { present: boolean | null; name?: string; record?: string | null; note?: string } }) {
  const tone = check.present === true ? "text-success" : check.present === false ? "text-danger-ink" : "text-muted";
  return (
    <li className="flex flex-wrap gap-x-2 text-sm">
      <span className={`w-14 font-semibold ${tone}`}>{label}</span>
      <span className={tone}>{check.present === true ? "found" : check.present === false ? "missing" : "unchecked"}</span>
      <span className="break-all text-muted">{check.name ?? check.note}</span>
      {check.record ? <code className="break-all text-xs text-muted">{check.record}</code> : null}
    </li>
  );
}

/** Which DMARC record governs the sender, in words (RFC 7489 organisational fallback). */
export function dmarcApplied(d: {
  name: string;
  present: boolean | null;
  policy: string | null;
  applied_from?: "exact" | "organizational" | null;
  checked?: string[];
  alignment?: { dkim: "r" | "s"; spf: "r" | "s" } | null;
}): string {
  if (!d.present) return `DMARC: none found (asked ${(d.checked?.length ? d.checked : [d.name]).join(", ")}).`;
  const how = d.applied_from === "organizational" ? "the organisational domain's record applies" : "exact record for the sending domain";
  const align = d.alignment ? `, alignment dkim ${d.alignment.dkim === "s" ? "strict" : "relaxed"} / spf ${d.alignment.spf === "s" ? "strict" : "relaxed"}` : "";
  return `DMARC applied: ${d.name} — ${how}; policy p=${d.policy ?? "?"}${align}.`;
}

export function EmailHealthPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [recent, setRecent] = useState<Row[]>([]);
  const [err, setErr] = useState<unknown>(null);

  const load = useCallback(async (refreshDns = false) => {
    try {
      const res = await api<{ health: Health; recent: Row[] }>(`/api/v1/mod/email${refreshDns ? "?refresh_dns=1" : ""}`);
      setHealth(res.health);
      setRecent(res.recent);
      setErr(null);
    } catch (e) {
      setErr(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (err) return <ErrorNotice error={err} onRetry={() => void load()} className="mt-4" />;
  if (!health) return <p className="mt-4 text-muted">Loading…</p>;
  const day = health.windows.day;
  const week = health.windows.week;

  return (
    <section className="mt-4 space-y-6">
      <div className={`rounded-gh-lg border p-4 text-ink shadow-gh-1 ${STATUS_TONE[health.status]}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-semibold">
            Magic-link email: <span className={STATUS_WORD[health.status]}>{health.status}</span>
          </p>
          <button type="button" onClick={() => void load(true)} className={buttonClass("secondary", "sm")}>
            Refresh (re-check DNS)
          </button>
        </div>
        <p className="mt-1 text-sm text-muted">
          Transport <code className="font-brand-mono text-ink">{health.transport}</code> · From{" "}
          <code className="break-all font-brand-mono text-ink">{health.from}</code>
        </p>
        <p className="mt-1 text-xs text-muted">{TRUTH[health.delivery_truth]}</p>
        {health.reasons.length ? (
          <ul className="mt-3 space-y-1 text-sm">
            {health.reasons.map((r) => (
              <li key={r.code}>
                <span className={`font-semibold ${r.severity === "critical" ? "text-danger-ink" : r.severity === "warning" ? "text-signal-text" : "text-muted"}`}>
                  {r.severity === "critical" ? "✕" : r.severity === "warning" ? "!" : "·"}
                </span>{" "}
                {r.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm">No problems in the last hour or day.</p>
        )}
      </div>

      <div>
        <h3 className="gh-label text-muted">Last 24 hours</h3>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Links issued" value={day.attempts} hint={`${week.attempts} this week`} />
          <Stat label="Send failures" value={day.rejected + day.errored} hint={`rate ${pct(day.send_failure_rate)}`} />
          <Stat label="Bounced / complaints" value={`${day.bounced} / ${day.complained}`} hint={`${day.delivered} confirmed delivered`} />
          <Stat label="Accepted, fate unknown" value={day.delivery_unknown} hint="accepted ≠ delivered" />
          <Stat label="People who got in" value={day.recipients_in} hint={`rate ${pct(day.recipient_redeem_rate)}`} />
          <Stat label="People stranded" value={day.recipients_stranded} hint="asked, never used a link" />
          <Stat label="Links still live" value={day.awaiting} hint={`${day.expired_unredeemed} expired unused`} />
          <Stat label="Time to redeem" value={secs(day.redeem_seconds_p50)} hint={`p90 ${secs(day.redeem_seconds_p90)}`} />
        </div>
        <p className="mt-2 text-xs text-muted">
          Last accepted send {when(day.last_accepted_at ?? week.last_accepted_at)} · last sign-in via link{" "}
          {when(day.last_redeemed_at ?? week.last_redeemed_at)}
        </p>
      </div>

      <div>
        <h3 className="gh-label text-muted">Sender DNS</h3>
        {health.dns ? (
          <>
            <p className="mt-1 text-xs text-muted">
              {health.dns.domain} · checked {when(health.dns.checked_at)}
              {health.dns.error ? ` · ${health.dns.error}` : ""}
            </p>
            <ul className="mt-2 space-y-1">
              <DnsLine label="SPF" check={health.dns.spf} />
              <DnsLine label="DKIM" check={health.dns.dkim} />
              <DnsLine label="DMARC" check={{ ...health.dns.dmarc, record: health.dns.dmarc.record }} />
            </ul>
            <p className="mt-1 text-xs text-muted">{dmarcApplied(health.dns.dmarc)}</p>
          </>
        ) : (
          <p className="mt-1 text-sm text-muted">No real sending domain configured, so there is nothing to check.</p>
        )}
      </div>

      <div>
        <h3 className="gh-label text-muted">Recent sends</h3>
        <TableFrame label="Recent sends" className="mt-2">
          <table className={`${TABLE_CLASS} min-w-[640px]`}>
            <thead>
              <tr>
                <th className={TH_CLASS}>When</th>
                <th className={TH_CLASS}>To</th>
                <th className={TH_CLASS}>Send</th>
                <th className={TH_CLASS}>Delivery</th>
                <th className={`${TH_CLASS} text-right`}>Redeemed</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td className={`${TD_CLASS} ${NUM_CLASS} whitespace-nowrap text-gh-xs text-muted`}>{when(r.created_at)}</td>
                  <td className={`${TD_CLASS} font-brand-mono text-gh-xs`}>{r.recipient_hint}</td>
                  <td className={`${TD_CLASS} ${r.send_status === "rejected" || r.send_status === "error" ? "text-danger-ink" : "text-muted"}`}>
                    {r.send_status}
                    {r.send_ms != null ? <span className={`text-muted ${NUM_CLASS}`}> {r.send_ms}ms</span> : null}
                    {r.send_error ? <p className="text-xs text-danger-ink">{r.send_error}</p> : null}
                  </td>
                  <td className={`${TD_CLASS} ${r.delivery_status === "bounced" || r.delivery_status === "complained" || r.delivery_status === "failed" ? "text-danger-ink" : "text-muted"}`}>
                    {r.delivery_status}
                  </td>
                  <td className={`${TD_CLASS} ${NUM_CLASS} text-right text-muted`}>{r.redeemed_at ? `after ${secs(r.redeem_seconds)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
        {recent.length === 0 ? <p className={`mt-2 ${EMPTY_CLASS}`}>No magic links requested since tracking began.</p> : null}
      </div>
    </section>
  );
}
