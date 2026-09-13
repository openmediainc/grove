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
    dmarc: DnsCheck & { policy: string | null };
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

const STATUS_TONE: Record<Health["status"], string> = {
  ok: "border-emerald-400/40 bg-emerald-500/10 text-emerald-100",
  degraded: "border-amber-400/50 bg-amber-500/10 text-amber-100",
  down: "border-red-400/60 bg-red-500/15 text-red-100",
  unconfigured: "border-white/15 bg-white/5 text-white/80",
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
    <div className="rounded-lg border border-white/10 bg-dusk-800/60 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wider text-white/40">{label}</p>
      <p className="mt-0.5 text-lg text-white/90">{value}</p>
      {hint ? <p className="text-[11px] text-white/35">{hint}</p> : null}
    </div>
  );
}

function DnsLine({ label, check }: { label: string; check: { present: boolean | null; name?: string; record?: string | null; note?: string } }) {
  const tone = check.present === true ? "text-emerald-300" : check.present === false ? "text-red-300" : "text-white/40";
  return (
    <li className="flex flex-wrap gap-x-2 text-sm">
      <span className={`w-14 font-semibold ${tone}`}>{label}</span>
      <span className={tone}>{check.present === true ? "found" : check.present === false ? "missing" : "unchecked"}</span>
      <span className="break-all text-white/40">{check.name ?? check.note}</span>
      {check.record ? <code className="break-all text-xs text-white/35">{check.record}</code> : null}
    </li>
  );
}

export function EmailHealthPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  const [recent, setRecent] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (refreshDns = false) => {
    try {
      const res = await api<{ health: Health; recent: Row[] }>(`/api/v1/mod/email${refreshDns ? "?refresh_dns=1" : ""}`);
      setHealth(res.health);
      setRecent(res.recent);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (err) return <p className="mt-4 text-red-300">{err}</p>;
  if (!health) return <p className="mt-4 text-white/40">Loading…</p>;
  const day = health.windows.day;
  const week = health.windows.week;

  return (
    <section className="mt-4 space-y-6">
      <div className={`rounded-xl border p-4 ${STATUS_TONE[health.status]}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-semibold">Magic-link email: {health.status}</p>
          <button onClick={() => void load(true)} className="rounded-full bg-white/10 px-3 py-1 text-xs">
            Refresh (re-check DNS)
          </button>
        </div>
        <p className="mt-1 text-sm opacity-80">
          Transport <code>{health.transport}</code> · From <code className="break-all">{health.from}</code>
        </p>
        <p className="mt-1 text-xs opacity-60">{TRUTH[health.delivery_truth]}</p>
        {health.reasons.length ? (
          <ul className="mt-3 space-y-1 text-sm">
            {health.reasons.map((r) => (
              <li key={r.code}>
                <span className="font-semibold">{r.severity === "critical" ? "✕" : r.severity === "warning" ? "!" : "·"}</span>{" "}
                {r.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm">No problems in the last hour or day.</p>
        )}
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-widest text-lantern-400">Last 24 hours</h3>
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
        <p className="mt-2 text-xs text-white/40">
          Last accepted send {when(day.last_accepted_at ?? week.last_accepted_at)} · last sign-in via link{" "}
          {when(day.last_redeemed_at ?? week.last_redeemed_at)}
        </p>
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-widest text-lantern-400">Sender DNS</h3>
        {health.dns ? (
          <>
            <p className="mt-1 text-xs text-white/40">
              {health.dns.domain} · checked {when(health.dns.checked_at)}
              {health.dns.error ? ` · ${health.dns.error}` : ""}
            </p>
            <ul className="mt-2 space-y-1">
              <DnsLine label="SPF" check={health.dns.spf} />
              <DnsLine label="DKIM" check={health.dns.dkim} />
              <DnsLine label="DMARC" check={{ ...health.dns.dmarc, record: health.dns.dmarc.record }} />
            </ul>
          </>
        ) : (
          <p className="mt-1 text-sm text-white/40">No real sending domain configured, so there is nothing to check.</p>
        )}
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-widest text-lantern-400">Recent sends</h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-white/40">
              <tr>
                <th className="py-1 pr-3 font-normal">When</th>
                <th className="py-1 pr-3 font-normal">To</th>
                <th className="py-1 pr-3 font-normal">Send</th>
                <th className="py-1 pr-3 font-normal">Delivery</th>
                <th className="py-1 font-normal">Redeemed</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} className="border-t border-white/5 align-top">
                  <td className="py-1 pr-3 text-white/50">{when(r.created_at)}</td>
                  <td className="py-1 pr-3">{r.recipient_hint}</td>
                  <td className={`py-1 pr-3 ${r.send_status === "rejected" || r.send_status === "error" ? "text-red-300" : "text-white/70"}`}>
                    {r.send_status}
                    {r.send_ms != null ? <span className="text-white/30"> {r.send_ms}ms</span> : null}
                    {r.send_error ? <p className="text-xs text-red-200/70">{r.send_error}</p> : null}
                  </td>
                  <td className={`py-1 pr-3 ${r.delivery_status === "bounced" || r.delivery_status === "complained" || r.delivery_status === "failed" ? "text-red-300" : "text-white/70"}`}>
                    {r.delivery_status}
                  </td>
                  <td className="py-1 text-white/70">{r.redeemed_at ? `after ${secs(r.redeem_seconds)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {recent.length === 0 ? <p className="mt-2 text-white/40">No magic links requested since tracking began.</p> : null}
      </div>
    </section>
  );
}
