import crypto from "node:crypto";
import { Resolver } from "node:dns/promises";
import type { GroveStore } from "../store.js";
import { isProduction } from "../config.js";
import { newUlid } from "../ids.js";
import { MailSendError, type Mailer, type MailSendResult, type MailTransport } from "../mailer.js";

/**
 * ONB-07 — is anybody actually getting their magic link?
 *
 * Login is emailed links and nothing else. A provider that rejects every send,
 * a sender domain that lost its DKIM record, or a link that lands in spam are
 * each a total outage for new and returning humans, and each one leaves /health
 * and /ready green, because the API is up and the database answers.
 *
 * This service keeps one row per send attempt (migration 025) and derives three
 * separate, honest signals from it:
 *
 *   1. SEND — what the provider said synchronously. `accepted` only means the
 *      API took the message.
 *   2. DELIVERY — what the provider said later. Resend has an events API
 *      (GET /emails/:id → last_event) and we POLL it, outbound. We do not take
 *      webhooks: Grove is tailnet-only and a provider on the public internet
 *      cannot reach it, and opening a Funnel for it is against the house rules.
 *      SMTP has no events API at all: its delivery_status stays `unknown`.
 *   3. REDEMPTION — whether the human clicked. Provider independent, and the
 *      only signal that catches "delivered to the spam folder". Measured per
 *      RECIPIENT, not per link, because a person who asks twice and clicks the
 *      second link got in, and must not count as a failure.
 *
 * Nothing in here may break login. Every write is best-effort and logged.
 */

const DAY_MS = 24 * 3600 * 1000;
/** Stop asking the provider about a message after this long; it is not going to change. */
const POLL_HORIZON_MS = 2 * DAY_MS;
const FINAL_DELIVERY = new Set(["delivered", "bounced", "complained", "failed"]);

export type SendStatus = "pending" | "accepted" | "rejected" | "error" | "not_sent";
export type DeliveryStatus = "unknown" | "sent" | "delivered" | "delayed" | "bounced" | "complained" | "failed";

/** `p***@teqdr.com`. Enough for an operator to recognise their own test, useless as a mailing list. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

/** The address inside a From header: `Grove <noreply@x.com>` → `noreply@x.com`. */
export function fromAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1]! : from).trim();
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// DNS: SPF / DKIM / DMARC for the sending domain. Read-only TXT lookups — the
// same queries `dig TXT` makes — cached, because the answer changes on the
// scale of days and the mod page is reloaded on the scale of seconds.
// ---------------------------------------------------------------------------

export type TxtResolver = (name: string) => Promise<string[][]>;

export interface DnsRecordCheck {
  name: string;
  present: boolean;
  record: string | null;
}

export interface EmailDnsReport {
  domain: string;
  checkedAt: string;
  spf: DnsRecordCheck & { checked: string[] };
  dkim: (DnsRecordCheck & { selector: string }) | { selector: null; present: null; note: string };
  dmarc: DnsRecordCheck & { policy: string | null };
  error: string | null;
}

async function txt(resolve: TxtResolver, name: string): Promise<string[]> {
  try {
    return (await resolve(name)).map((chunks) => chunks.join(""));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") return [];
    throw err;
  }
}

export async function checkSenderDns(
  domain: string,
  opts: { transport: MailTransport; dkimSelector?: string | null; resolve?: TxtResolver },
): Promise<EmailDnsReport> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  const resolve: TxtResolver = opts.resolve ?? ((name) => resolver.resolveTxt(name));
  const report: EmailDnsReport = {
    domain,
    checkedAt: new Date().toISOString(),
    spf: { name: domain, present: false, record: null, checked: [] },
    dkim: { selector: null, present: null, note: "no DKIM selector known for this transport; set GROVE_MAIL_DKIM_SELECTOR" },
    dmarc: { name: `_dmarc.${domain}`, present: false, record: null, policy: null },
    error: null,
  };
  try {
    // Resend signs the envelope (Return-Path) with `send.<domain>`, so SPF lives
    // there rather than on the apex. Check both and say which answered.
    const spfNames = opts.transport === "resend" ? [`send.${domain}`, domain] : [domain];
    for (const name of spfNames) {
      report.spf.checked.push(name);
      const spf = (await txt(resolve, name)).find((r) => r.toLowerCase().startsWith("v=spf1"));
      if (spf) {
        report.spf = { ...report.spf, name, present: true, record: spf };
        break;
      }
    }
    const selector = opts.dkimSelector ?? (opts.transport === "resend" ? "resend" : null);
    if (selector) {
      const name = `${selector}._domainkey.${domain}`;
      const dkim = (await txt(resolve, name)).find((r) => /(^|;)\s*p=/.test(r));
      report.dkim = { name, selector, present: Boolean(dkim), record: dkim ? `${dkim.slice(0, 40)}…` : null };
    }
    const dmarc = (await txt(resolve, report.dmarc.name)).find((r) => r.toUpperCase().startsWith("V=DMARC1"));
    if (dmarc) {
      report.dmarc.present = true;
      report.dmarc.record = dmarc;
      report.dmarc.policy = /(?:^|;)\s*p=([a-z]+)/i.exec(dmarc)?.[1]?.toLowerCase() ?? null;
    }
  } catch (err) {
    report.error = `DNS lookup failed: ${(err as Error).message}`.slice(0, 200);
  }
  return report;
}

// ---------------------------------------------------------------------------
// The verdict. Pure, so every threshold is unit-tested rather than trusted.
// ---------------------------------------------------------------------------

export interface WindowStats {
  hours: number;
  attempts: number;
  /** Attempts handed to a real transport (resend/smtp). Failure rates are over these. */
  realAttempts: number;
  accepted: number;
  rejected: number;
  errored: number;
  notSent: number;
  pending: number;
  /** (rejected + errored) / attempts that went to a real transport. */
  sendFailureRate: number | null;
  delivered: number;
  delayed: number;
  bounced: number;
  complained: number;
  deliveryFailed: number;
  /** Accepted, and the provider has not (or cannot) say more. */
  deliveryUnknown: number;
  issued: number;
  redeemed: number;
  expiredUnredeemed: number;
  awaiting: number;
  /** Distinct recipients with at least one redeemed link. */
  recipientsIn: number;
  /** Distinct recipients whose every link expired unused. */
  recipientsStranded: number;
  /** recipientsIn / (recipientsIn + recipientsStranded). Ignores links still live. */
  recipientRedeemRate: number | null;
  redeemSecondsP50: number | null;
  redeemSecondsP90: number | null;
  lastAttemptAt: string | null;
  lastAcceptedAt: string | null;
  lastRedeemedAt: string | null;
}

export type EmailHealthStatus = "ok" | "degraded" | "down" | "unconfigured";

export interface EmailHealthReason {
  code: string;
  severity: "critical" | "warning" | "info";
  message: string;
}

export interface EmailHealthInput {
  transport: MailTransport;
  production: boolean;
  hour: WindowStats;
  day: WindowStats;
  /** send_status of the most recent real-transport attempts, newest first. */
  recentSendStatuses: SendStatus[];
  dns: EmailDnsReport | null;
}

export function assessEmailHealth(input: EmailHealthInput): { status: EmailHealthStatus; reasons: EmailHealthReason[] } {
  const reasons: EmailHealthReason[] = [];
  const { transport, hour, day } = input;

  if (transport === "noop") {
    reasons.push({
      code: "NO_TRANSPORT",
      severity: input.production ? "critical" : "info",
      message: "No mail transport is configured: magic links are stored and never sent to anyone.",
    });
    return { status: input.production ? "down" : "unconfigured", reasons };
  }
  if (transport === "stdout") {
    reasons.push({
      code: "STDOUT_ONLY",
      severity: "info",
      message:
        "No email leaves this server (no RESEND_API_KEY / GROVE_SMTP_URL). Links are shown on the sign-in screen and printed to the API log.",
    });
    return { status: "unconfigured", reasons };
  }

  const failed = (s: SendStatus) => s === "rejected" || s === "error";
  const lastThree = input.recentSendStatuses.slice(0, 3);
  if (lastThree.length === 3 && lastThree.every(failed)) {
    reasons.push({
      code: "SEND_FAILING",
      severity: "critical",
      message: "The last 3 magic-link sends all failed at the provider. Nobody can sign in.",
    });
  }
  if (hour.realAttempts >= 3 && (hour.sendFailureRate ?? 0) >= 0.5) {
    reasons.push({
      code: "SEND_FAILURE_RATE_HIGH",
      severity: "critical",
      message: `${Math.round((hour.sendFailureRate ?? 0) * 100)}% of sends failed in the last hour (${hour.rejected + hour.errored}/${hour.realAttempts}).`,
    });
  } else if (day.realAttempts >= 5 && (day.sendFailureRate ?? 0) > 0.1) {
    reasons.push({
      code: "SEND_FAILURES",
      severity: "warning",
      message: `${Math.round((day.sendFailureRate ?? 0) * 100)}% of sends failed in the last 24h (${day.rejected + day.errored}/${day.realAttempts}).`,
    });
  }
  if (day.complained > 0) {
    reasons.push({
      code: "COMPLAINTS",
      severity: "warning",
      message: `${day.complained} recipient(s) marked a magic link as spam in the last 24h.`,
    });
  }
  if (day.accepted > 0 && day.bounced > 0 && day.bounced / day.accepted >= 0.05) {
    reasons.push({
      code: "BOUNCES",
      severity: "warning",
      message: `${day.bounced} of ${day.accepted} accepted messages bounced in the last 24h.`,
    });
  }
  if (day.recipientsStranded >= 3 && (day.recipientRedeemRate ?? 1) < 0.5) {
    reasons.push({
      code: "LINKS_NOT_REDEEMED",
      severity: "warning",
      message: `${day.recipientsStranded} people asked for a link in the last 24h and never used one (${day.recipientsIn} got in). Check the spam folder and sender DNS.`,
    });
  }
  const dns = input.dns;
  if (dns && !dns.error) {
    if (!dns.spf.present) {
      reasons.push({ code: "DNS_SPF_MISSING", severity: "warning", message: `No SPF record at ${dns.spf.checked.join(" or ")}.` });
    }
    if (dns.dkim.present === false) {
      reasons.push({ code: "DNS_DKIM_MISSING", severity: "warning", message: `No DKIM key at ${dns.dkim.name}.` });
    }
    if (!dns.dmarc.present) {
      reasons.push({ code: "DNS_DMARC_MISSING", severity: "warning", message: `No DMARC record at ${dns.dmarc.name}.` });
    }
  } else if (dns?.error) {
    reasons.push({ code: "DNS_UNCHECKED", severity: "info", message: dns.error });
  }

  const status: EmailHealthStatus = reasons.some((r) => r.severity === "critical")
    ? "down"
    : reasons.some((r) => r.severity === "warning")
      ? "degraded"
      : "ok";
  return { status, reasons };
}

// ---------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------

export interface DeliveryRow {
  id: string;
  transport: MailTransport;
  recipientHint: string;
  recipientDomain: string;
  sendStatus: SendStatus;
  sendError: string | null;
  sendMs: number | null;
  providerMessageId: string | null;
  deliveryStatus: DeliveryStatus;
  deliveryDetail: string | null;
  deliveryEventAt: string | null;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemSeconds: number | null;
}

export interface EmailHealthReport {
  status: EmailHealthStatus;
  reasons: EmailHealthReason[];
  transport: MailTransport;
  from: string;
  deliveryTruth: "provider_events_polled" | "redemption_only" | "none";
  windows: { hour: WindowStats; day: WindowStats; week: WindowStats };
  dns: EmailDnsReport | null;
  generatedAt: string;
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const num = (v: unknown) => (v == null ? null : Number(v));

export class EmailDeliveryService {
  private dnsCache: { at: number; report: EmailDnsReport } | null = null;

  constructor(
    private store: GroveStore,
    private mailer: Mailer,
    private deps: { resolveTxt?: TxtResolver } = {},
  ) {}

  get transport(): MailTransport {
    return this.mailer.kind;
  }

  get from(): string {
    return this.mailer.from;
  }

  private recipientHash(email: string): string {
    const key = this.store.config.mailHashKey || this.store.config.databaseUrl;
    return crypto.createHmac("sha256", key).update(email.toLowerCase()).digest("hex");
  }

  /**
   * Send one magic link and write down exactly what happened. Never throws: the
   * caller learns the outcome from the return value.
   */
  async sendMagicLink(input: { email: string; token: string; url: string; ttlSeconds: number }): Promise<{
    sendStatus: SendStatus;
    result: MailSendResult | null;
  }> {
    const id = `mail_${newUlid()}`;
    let recorded = false;
    try {
      await this.store.pg.query(
        `INSERT INTO email_deliveries
           (id, transport, recipient_hash, recipient_hint, recipient_domain, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
        [
          id,
          this.mailer.kind,
          this.recipientHash(input.email),
          maskEmail(input.email),
          emailDomain(input.email),
          sha256(input.token),
          input.ttlSeconds,
        ],
      );
      recorded = true;
    } catch (err) {
      console.warn("[grove] email_deliveries insert failed:", (err as Error).message);
    }

    const started = Date.now();
    let sendStatus: SendStatus;
    let result: MailSendResult | null = null;
    let error: string | null = null;
    try {
      result = await this.mailer.sendMagicLink(input.email, input.url);
      sendStatus = result.sent ? "accepted" : "not_sent";
    } catch (err) {
      sendStatus = err instanceof MailSendError ? err.outcome : "error";
      error = (err as Error).message.slice(0, 300);
      console.warn(`[grove] mailer ${sendStatus}:`, error);
    }
    const ms = Date.now() - started;

    if (recorded) {
      const pollable = sendStatus === "accepted" && result?.providerMessageId && this.mailer.lookupDelivery;
      try {
        await this.store.pg.query(
          `UPDATE email_deliveries
              SET send_status = $2, send_error = $3, send_ms = $4, provider_message_id = $5,
                  sent_at = now(),
                  next_poll_at = CASE WHEN $6 THEN now() + interval '60 seconds' ELSE NULL END
            WHERE id = $1`,
          [id, sendStatus, error, ms, result?.providerMessageId ?? null, Boolean(pollable)],
        );
      } catch (err) {
        console.warn("[grove] email_deliveries update failed:", (err as Error).message);
      }
    }
    return { sendStatus, result };
  }

  /** The link was clicked. Idempotent; a token with no row (pre-023 link) is a no-op. */
  async markRedeemed(token: string): Promise<void> {
    try {
      await this.store.pg.query(
        "UPDATE email_deliveries SET redeemed_at = now() WHERE token_hash = $1 AND redeemed_at IS NULL",
        [sha256(token)],
      );
    } catch (err) {
      console.warn("[grove] email_deliveries redeem failed:", (err as Error).message);
    }
  }

  /**
   * Ask the provider about accepted messages whose fate is still open. Backs off
   * 1m, 2m, 4m … capped at an hour, and gives up after two days. At most `limit`
   * lookups per call so a backlog cannot trip the provider's rate limit.
   */
  async pollDue(limit = 5): Promise<number> {
    const lookup = this.mailer.lookupDelivery?.bind(this.mailer);
    if (!lookup) return 0;
    const { rows } = await this.store.pg.query(
      `SELECT id, provider_message_id, polls, created_at FROM email_deliveries
        WHERE next_poll_at IS NOT NULL AND next_poll_at <= now()
        ORDER BY next_poll_at LIMIT $1`,
      [limit],
    );
    let updated = 0;
    for (const row of rows as Array<{ id: string; provider_message_id: string; polls: number; created_at: string }>) {
      const polls = Number(row.polls) + 1;
      const tooOld = Date.now() - new Date(row.created_at).getTime() > POLL_HORIZON_MS;
      const backoffSec = Math.min(60 * 2 ** polls, 3600);
      try {
        const { state, raw } = await lookup(row.provider_message_id);
        const final = state !== null && FINAL_DELIVERY.has(state);
        await this.store.pg.query(
          `UPDATE email_deliveries
              SET polls = $2,
                  delivery_status = COALESCE($3, delivery_status),
                  delivery_detail = $4,
                  delivery_event_at = CASE WHEN $3::text IS NOT NULL AND $3::text IS DISTINCT FROM delivery_status THEN now() ELSE delivery_event_at END,
                  next_poll_at = CASE WHEN $5 THEN NULL ELSE now() + make_interval(secs => $6) END
            WHERE id = $1`,
          [row.id, polls, state, raw.slice(0, 60), final || tooOld, backoffSec],
        );
        updated++;
      } catch (err) {
        await this.store.pg.query(
          `UPDATE email_deliveries
              SET polls = $2, delivery_detail = $3,
                  next_poll_at = CASE WHEN $4 THEN NULL ELSE now() + make_interval(secs => $5) END
            WHERE id = $1`,
          [row.id, polls, `lookup failed: ${(err as Error).message}`.slice(0, 120), tooOld, backoffSec],
        );
      }
    }
    return updated;
  }

  async windowStats(hours: number): Promise<WindowStats> {
    const { rows } = await this.store.pg.query(
      `WITH w AS (
         SELECT * FROM email_deliveries WHERE created_at > now() - make_interval(hours => $1)
       ),
       per_recipient AS (
         SELECT recipient_hash,
                bool_or(redeemed_at IS NOT NULL) AS got_in,
                bool_or(redeemed_at IS NULL AND expires_at >= now()) AS live
           FROM w GROUP BY recipient_hash
       )
       SELECT
         count(*)                                                        AS attempts,
         count(*) FILTER (WHERE send_status = 'accepted')                AS accepted,
         count(*) FILTER (WHERE send_status = 'rejected')                AS rejected,
         count(*) FILTER (WHERE send_status = 'error')                   AS errored,
         count(*) FILTER (WHERE send_status = 'not_sent')                AS not_sent,
         count(*) FILTER (WHERE send_status = 'pending')                 AS pending,
         count(*) FILTER (WHERE transport IN ('resend', 'smtp'))         AS real_attempts,
         count(*) FILTER (WHERE delivery_status = 'delivered')           AS delivered,
         count(*) FILTER (WHERE delivery_status = 'delayed')             AS delayed,
         count(*) FILTER (WHERE delivery_status = 'bounced')             AS bounced,
         count(*) FILTER (WHERE delivery_status = 'complained')          AS complained,
         count(*) FILTER (WHERE delivery_status = 'failed')              AS delivery_failed,
         count(*) FILTER (WHERE send_status = 'accepted' AND delivery_status IN ('unknown', 'sent')) AS delivery_unknown,
         count(*) FILTER (WHERE redeemed_at IS NOT NULL)                 AS redeemed,
         count(*) FILTER (WHERE redeemed_at IS NULL AND expires_at < now())  AS expired_unredeemed,
         count(*) FILTER (WHERE redeemed_at IS NULL AND expires_at >= now()) AS awaiting,
         (SELECT count(*) FROM per_recipient WHERE got_in)               AS recipients_in,
         (SELECT count(*) FROM per_recipient WHERE NOT got_in AND NOT live) AS recipients_stranded,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM redeemed_at - created_at))
           FILTER (WHERE redeemed_at IS NOT NULL)                        AS p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM redeemed_at - created_at))
           FILTER (WHERE redeemed_at IS NOT NULL)                        AS p90,
         max(created_at)                                                 AS last_attempt_at,
         max(sent_at) FILTER (WHERE send_status = 'accepted')            AS last_accepted_at,
         max(redeemed_at)                                                AS last_redeemed_at
       FROM w`,
      [hours],
    );
    const r = rows[0] as Record<string, unknown>;
    const n = (k: string) => Number(r[k] ?? 0);
    const realAttempts = n("real_attempts");
    const failures = n("rejected") + n("errored");
    const inCount = n("recipients_in");
    const stranded = n("recipients_stranded");
    const p50 = num(r.p50);
    const p90 = num(r.p90);
    return {
      hours,
      attempts: n("attempts"),
      realAttempts,
      accepted: n("accepted"),
      rejected: n("rejected"),
      errored: n("errored"),
      notSent: n("not_sent"),
      pending: n("pending"),
      sendFailureRate: realAttempts > 0 ? failures / realAttempts : null,
      delivered: n("delivered"),
      delayed: n("delayed"),
      bounced: n("bounced"),
      complained: n("complained"),
      deliveryFailed: n("delivery_failed"),
      deliveryUnknown: n("delivery_unknown"),
      issued: n("attempts"),
      redeemed: n("redeemed"),
      expiredUnredeemed: n("expired_unredeemed"),
      awaiting: n("awaiting"),
      recipientsIn: inCount,
      recipientsStranded: stranded,
      recipientRedeemRate: inCount + stranded > 0 ? inCount / (inCount + stranded) : null,
      redeemSecondsP50: p50 == null ? null : Math.round(p50),
      redeemSecondsP90: p90 == null ? null : Math.round(p90),
      lastAttemptAt: iso(r.last_attempt_at),
      lastAcceptedAt: iso(r.last_accepted_at),
      lastRedeemedAt: iso(r.last_redeemed_at),
    };
  }

  async recent(limit = 50): Promise<DeliveryRow[]> {
    const { rows } = await this.store.pg.query(
      `SELECT id, transport, recipient_hint, recipient_domain, send_status, send_error, send_ms,
              provider_message_id, delivery_status, delivery_detail, delivery_event_at,
              created_at, expires_at, redeemed_at,
              extract(epoch FROM redeemed_at - created_at) AS redeem_seconds
         FROM email_deliveries ORDER BY created_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      transport: r.transport as MailTransport,
      recipientHint: r.recipient_hint as string,
      recipientDomain: r.recipient_domain as string,
      sendStatus: r.send_status as SendStatus,
      sendError: (r.send_error as string | null) ?? null,
      sendMs: num(r.send_ms),
      providerMessageId: (r.provider_message_id as string | null) ?? null,
      deliveryStatus: r.delivery_status as DeliveryStatus,
      deliveryDetail: (r.delivery_detail as string | null) ?? null,
      deliveryEventAt: iso(r.delivery_event_at),
      createdAt: iso(r.created_at)!,
      expiresAt: iso(r.expires_at)!,
      redeemedAt: iso(r.redeemed_at),
      redeemSeconds: r.redeem_seconds == null ? null : Math.round(Number(r.redeem_seconds)),
    }));
  }

  /** DNS for the From domain, cached ten minutes. Null when there is no real sender to check. */
  async senderDns(force = false): Promise<EmailDnsReport | null> {
    if (this.mailer.kind !== "resend" && this.mailer.kind !== "smtp") return null;
    const domain = emailDomain(fromAddress(this.mailer.from));
    if (!domain || domain === "localhost") return null;
    if (!force && this.dnsCache && Date.now() - this.dnsCache.at < 10 * 60_000) return this.dnsCache.report;
    const report = await checkSenderDns(domain, {
      transport: this.mailer.kind,
      dkimSelector: this.store.config.mailDkimSelector ?? null,
      resolve: this.deps.resolveTxt,
    });
    this.dnsCache = { at: Date.now(), report };
    return report;
  }

  async health(opts: { forceDns?: boolean } = {}): Promise<EmailHealthReport> {
    const [hour, day, week, recentReal, dns] = await Promise.all([
      this.windowStats(1),
      this.windowStats(24),
      this.windowStats(24 * 7),
      this.store.pg.query(
        `SELECT send_status FROM email_deliveries
          WHERE transport IN ('resend', 'smtp') AND send_status <> 'pending'
          ORDER BY created_at DESC LIMIT 5`,
      ),
      this.senderDns(opts.forceDns),
    ]);
    const verdict = assessEmailHealth({
      transport: this.mailer.kind,
      production: isProduction(this.store.config),
      hour,
      day,
      recentSendStatuses: (recentReal.rows as Array<{ send_status: SendStatus }>).map((r) => r.send_status),
      dns,
    });
    return {
      ...verdict,
      transport: this.mailer.kind,
      from: this.mailer.from,
      deliveryTruth: this.mailer.lookupDelivery
        ? "provider_events_polled"
        : this.mailer.kind === "smtp"
          ? "redemption_only"
          : "none",
      windows: { hour, day, week },
      dns,
      generatedAt: new Date().toISOString(),
    };
  }
}
