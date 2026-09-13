import crypto from "node:crypto";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";

/**
 * Supporters (queue #47, migration 036): an optional, cosmetic supporter tier
 * paid through Stripe Checkout.
 *
 * ---------------------------------------------------------------------------
 * OFF UNTIL THE OWNER TURNS IT ON
 * ---------------------------------------------------------------------------
 * Every piece needs all four of STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 * STRIPE_SUPPORTER_PRICE_ID and GROVE_SUPPORTER_ENABLED=1. With any missing,
 * `supporterSettings()` is null: the routes answer 404, /me hides the section,
 * and every public `supporter` flag is false without touching the table.
 *
 * ---------------------------------------------------------------------------
 * COSMETIC ONLY
 * ---------------------------------------------------------------------------
 * Being a supporter buys a signboard trim and unlocks extra decor presets
 * (#45). It never gates access, speech, plots or visibility. The permission
 * kernel (packages/policy) does not read it, and a test there says so. No plot
 * is ever paywalled; nothing in the world ranks by it.
 *
 * ---------------------------------------------------------------------------
 * STRIPE WITHOUT A DEPENDENCY
 * ---------------------------------------------------------------------------
 * Three REST calls with fetch (create a Checkout Session, read the Price for
 * its display, nothing else) and a hand-written webhook signature check
 * (HMAC-SHA256 over `${t}.${rawBody}`, timing-safe, 5-minute tolerance).
 * Status is only ever written from a verified webhook, never from the browser
 * returning to the success URL.
 */

export interface SupporterSettings {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
}

/** The four env vars, or null when any is missing. The only switch. */
export function supporterSettings(env: NodeJS.ProcessEnv = process.env): SupporterSettings | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const priceId = env.STRIPE_SUPPORTER_PRICE_ID?.trim();
  if (env.GROVE_SUPPORTER_ENABLED !== "1" || !secretKey || !webhookSecret || !priceId) return null;
  return { secretKey, webhookSecret, priceId };
}

export const SUPPORTER_STATUSES = ["active", "canceled", "past_due"] as const;
export type SupporterStatus = (typeof SUPPORTER_STATUSES)[number];

/** Webhook timestamps older (or newer) than this are refused as replays. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** Cosmetic unlocks. Consumed by the signboard (after #33) and decor (#45). */
export interface SupporterPerks {
  signTrim: boolean;
  extraDecor: boolean;
}

export function supporterPerks(active: boolean): SupporterPerks {
  return { signTrim: active, extraDecor: active };
}

export interface SupporterView {
  status: SupporterStatus | null;
  active: boolean;
  currentPeriodEnd: string | null;
  perks: SupporterPerks;
}

export type SignatureResult = { ok: true; timestamp: number } | { ok: false; reason: "malformed" | "mismatch" | "stale" };

/**
 * Verify a `Stripe-Signature` header against the RAW request body.
 *
 * Header shape: `t=<unix>,v1=<hex>[,v1=<hex>…][,v0=…]`. Any v1 that matches
 * passes (Stripe sends two during a secret roll). The timestamp is part of
 * the signed payload, so it cannot be moved without breaking the signature,
 * and a timestamp outside the tolerance is refused: a captured delivery
 * cannot be replayed later.
 */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  header: string | undefined | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = STRIPE_SIGNATURE_TOLERANCE_SECONDS,
): SignatureResult {
  if (!header || !secret) return { ok: false, reason: "malformed" };
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  if (timestamp === null || !v1.length) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), body]))
    .digest();
  const matched = v1.some((sig) => {
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  if (!matched) return { ok: false, reason: "mismatch" };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: "stale" };
  return { ok: true, timestamp };
}

/** Sign a payload the way Stripe does. For tests and local rehearsal. */
export function signStripePayload(rawBody: string, secret: string, timestamp: number): string {
  const sig = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

/** Stripe subscription status → ours. Anything unrecognised is not active. */
export function mapSubscriptionStatus(stripeStatus: unknown): SupporterStatus {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
    case "paused":
      return "past_due";
    default:
      return "canceled";
  }
}

/** Format a Stripe Price for display, e.g. "£3.00 / month". Null when it cannot. */
export function formatPrice(price: unknown): string | null {
  const p = price as { unit_amount?: unknown; currency?: unknown; recurring?: { interval?: unknown; interval_count?: unknown } | null };
  if (typeof p?.unit_amount !== "number" || typeof p.currency !== "string") return null;
  let amount: string;
  try {
    const currency = p.currency.toUpperCase();
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    amount = new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(p.unit_amount / 10 ** digits);
  } catch {
    return null;
  }
  const interval = typeof p.recurring?.interval === "string" ? p.recurring.interval : null;
  if (!interval) return amount;
  const count = typeof p.recurring?.interval_count === "number" ? p.recurring.interval_count : 1;
  return count > 1 ? `${amount} / ${count} ${interval}s` : `${amount} / ${interval}`;
}

type Fetch = typeof fetch;

interface StripeEvent {
  id?: unknown;
  type?: unknown;
  created?: unknown;
  data?: { object?: Record<string, unknown> };
}

export type WebhookOutcome = "applied" | "ignored" | "stale";

const PRICE_CACHE_MS = 10 * 60_000;
const STRIPE_API = "https://api.stripe.com/v1";
const HUMAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function str(v: unknown): string | null {
  if (typeof v === "string" && v) return v;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id;
  return null;
}

/** current_period_end moved onto subscription items in newer Stripe API versions; read either. */
function periodEnd(sub: Record<string, unknown>): string | null {
  let secs: unknown = sub.current_period_end;
  if (typeof secs !== "number") {
    const items = (sub.items as { data?: Array<{ current_period_end?: unknown }> } | undefined)?.data;
    secs = items?.find((i) => typeof i.current_period_end === "number")?.current_period_end;
  }
  return typeof secs === "number" ? new Date(secs * 1000).toISOString() : null;
}

export class SupporterService {
  private priceCache: { at: number; display: string | null } | null = null;

  constructor(
    private store: GroveStore,
    private settings: SupporterSettings | null = supporterSettings(),
    private fetcher: Fetch = (...args) => fetch(...args),
  ) {}

  get enabled(): boolean {
    return this.settings !== null;
  }

  /** 404 when off, so a disabled deploy looks exactly like one without the feature. */
  requireEnabled(): SupporterSettings {
    if (!this.settings) throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    return this.settings;
  }

  async view(humanId: string): Promise<SupporterView> {
    const { rows } = await this.store.pg.query(
      `SELECT status, current_period_end FROM supporters WHERE human_id = $1`,
      [humanId],
    );
    const r = rows[0] as { status: SupporterStatus; current_period_end: Date | null } | undefined;
    const active = r?.status === "active";
    return {
      status: r?.status ?? null,
      active,
      currentPeriodEnd: r?.current_period_end ? new Date(r.current_period_end).toISOString() : null,
      perks: supporterPerks(active),
    };
  }

  /** Whether one person shows as a supporter publicly. Always false when off. */
  async isActive(humanId: string | null | undefined): Promise<boolean> {
    if (!this.enabled || !humanId) return false;
    return (await this.activeAmong([humanId])).has(humanId);
  }

  /** Which of these people show as supporters. Empty when off, without a query. */
  async activeAmong(humanIds: Array<string | null | undefined>): Promise<Set<string>> {
    const ids = [...new Set(humanIds.filter((x): x is string => typeof x === "string" && x.length > 0))];
    if (!this.enabled || !ids.length) return new Set();
    const { rows } = await this.store.pg.query(
      `SELECT human_id FROM supporters WHERE status = 'active' AND human_id = ANY($1::text[])`,
      [ids],
    );
    return new Set(rows.map((r) => String((r as { human_id: string }).human_id)));
  }

  /** The configured Price as display text, read from Stripe (cached). Null if Stripe is unreachable. */
  async priceDisplay(): Promise<string | null> {
    const s = this.requireEnabled();
    if (this.priceCache && Date.now() - this.priceCache.at < PRICE_CACHE_MS) return this.priceCache.display;
    let display: string | null = null;
    try {
      const res = await this.fetcher(`${STRIPE_API}/prices/${encodeURIComponent(s.priceId)}`, {
        headers: { authorization: `Bearer ${s.secretKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) display = formatPrice(await res.json());
    } catch {
      display = null;
    }
    this.priceCache = { at: Date.now(), display };
    return display;
  }

  /** Start a Checkout Session for this person. Returns the hosted Checkout URL. */
  async createCheckout(humanId: string, publicUrl: string): Promise<{ url: string }> {
    const s = this.requireEnabled();
    const existing = await this.store.pg.query(
      `SELECT status, stripe_customer_id FROM supporters WHERE human_id = $1`,
      [humanId],
    );
    const row = existing.rows[0] as { status: SupporterStatus; stripe_customer_id: string | null } | undefined;
    if (row?.status === "active") {
      throw new GroveError("CONFLICT", "You are already a supporter.", { httpStatus: 409 });
    }
    const base = publicUrl.replace(/\/+$/, "");
    const form = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": s.priceId,
      "line_items[0][quantity]": "1",
      client_reference_id: humanId,
      success_url: `${base}/me?supporter=thanks#support`,
      cancel_url: `${base}/me#support`,
      "metadata[human_id]": humanId,
      "subscription_data[metadata][human_id]": humanId,
    });
    if (row?.stripe_customer_id) form.set("customer", row.stripe_customer_id);
    let res: Response;
    try {
      res = await this.fetcher(`${STRIPE_API}/checkout/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${s.secretKey}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GroveError("UPSTREAM_UNAVAILABLE", "Checkout is unavailable right now.", { httpStatus: 502 });
    }
    const json = (await res.json().catch(() => null)) as { url?: unknown } | null;
    if (!res.ok || typeof json?.url !== "string") {
      throw new GroveError("UPSTREAM_UNAVAILABLE", "Checkout is unavailable right now.", { httpStatus: 502 });
    }
    return { url: json.url };
  }

  /**
   * Apply one verified webhook event. Idempotent: a re-delivered event, or an
   * older one arriving after a newer one, changes nothing (last_event_at).
   */
  async handleEvent(event: StripeEvent): Promise<WebhookOutcome> {
    this.requireEnabled();
    const type = typeof event.type === "string" ? event.type : "";
    const created = typeof event.created === "number" ? Math.floor(event.created) : 0;
    const obj = event.data?.object ?? {};

    if (type === "checkout.session.completed") {
      if (obj.mode !== "subscription") return "ignored";
      const humanId = str(obj.client_reference_id) ?? str((obj.metadata as Record<string, unknown> | undefined)?.human_id);
      if (!humanId || !HUMAN_ID_RE.test(humanId)) return "ignored";
      const status: SupporterStatus = obj.payment_status === "unpaid" ? "past_due" : "active";
      return this.upsert(humanId, {
        status,
        customerId: str(obj.customer),
        subscriptionId: str(obj.subscription),
        periodEnd: undefined,
        created,
      });
    }

    if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
      const subscriptionId = str(obj.id);
      if (!subscriptionId) return "ignored";
      const status = type === "customer.subscription.deleted" ? "canceled" : mapSubscriptionStatus(obj.status);
      let humanId = str((obj.metadata as Record<string, unknown> | undefined)?.human_id);
      if (!humanId) {
        const { rows } = await this.store.pg.query(`SELECT human_id FROM supporters WHERE stripe_subscription_id = $1`, [
          subscriptionId,
        ]);
        humanId = rows[0] ? String((rows[0] as { human_id: string }).human_id) : null;
      }
      if (!humanId || !HUMAN_ID_RE.test(humanId)) return "ignored";
      return this.upsert(humanId, {
        status,
        customerId: str(obj.customer),
        subscriptionId,
        periodEnd: periodEnd(obj),
        created,
      });
    }

    return "ignored";
  }

  private async upsert(
    humanId: string,
    v: {
      status: SupporterStatus;
      customerId: string | null;
      subscriptionId: string | null;
      /** undefined = leave as is. */
      periodEnd: string | null | undefined;
      created: number;
    },
  ): Promise<WebhookOutcome> {
    // An event for a person who no longer exists (or never did) is dropped.
    const human = await this.store.pg.query(`SELECT 1 FROM humans WHERE id = $1`, [humanId]);
    if (!human.rowCount) return "ignored";
    const keepPeriod = v.periodEnd === undefined;
    const { rowCount } = await this.store.pg.query(
      `INSERT INTO supporters (human_id, status, current_period_end, stripe_customer_id, stripe_subscription_id, last_event_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (human_id) DO UPDATE SET
         status = EXCLUDED.status,
         current_period_end = CASE WHEN $7::boolean THEN supporters.current_period_end ELSE EXCLUDED.current_period_end END,
         stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, supporters.stripe_customer_id),
         stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, supporters.stripe_subscription_id),
         last_event_at = EXCLUDED.last_event_at,
         updated_at = now()
       -- Newer event: apply. Same second: apply only if it changes something,
       -- so a re-delivery is a no-op. Older: never.
       WHERE supporters.last_event_at < EXCLUDED.last_event_at
          OR (supporters.last_event_at = EXCLUDED.last_event_at
              AND (supporters.status IS DISTINCT FROM EXCLUDED.status
                   OR (NOT $7::boolean AND supporters.current_period_end IS DISTINCT FROM EXCLUDED.current_period_end)
                   OR (EXCLUDED.stripe_subscription_id IS NOT NULL
                       AND supporters.stripe_subscription_id IS DISTINCT FROM EXCLUDED.stripe_subscription_id)))`,
      [humanId, v.status, keepPeriod ? null : v.periodEnd, v.customerId, v.subscriptionId, v.created, keepPeriod],
    );
    return rowCount ? "applied" : "stale";
  }
}
