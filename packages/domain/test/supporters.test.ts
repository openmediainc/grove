/**
 * Supporter plumbing (queue #47).
 *
 * The properties that matter:
 *  - it is OFF unless all four env vars are set;
 *  - a webhook is believed only with a valid Stripe signature over the exact
 *    raw body, inside a 5-minute window (a captured delivery cannot be replayed
 *    later, and the timestamp cannot be moved without breaking the signature);
 *  - applying events is idempotent: a re-delivery changes nothing and an older
 *    event arriving late never rolls status back;
 *  - public flags are false, without a query, while it is off.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  SupporterService,
  formatPrice,
  mapSubscriptionStatus,
  signStripePayload,
  supporterSettings,
  verifyStripeSignature,
} from "../src/services/supporters.js";
import { assertTestDatabase, createFixtures, hasTestDatabase } from "./support/fixtures.js";

const hasDb = hasTestDatabase();
const SECRET = "whsec_test_" + "x".repeat(24);
const SETTINGS = { secretKey: "sk_test_fake", webhookSecret: SECRET, priceId: "price_fake" };

describe("supporter switch", () => {
  const full = {
    STRIPE_SECRET_KEY: "sk_test_a",
    STRIPE_WEBHOOK_SECRET: "whsec_a",
    STRIPE_SUPPORTER_PRICE_ID: "price_a",
    GROVE_SUPPORTER_ENABLED: "1",
  };

  it("is on only with all four env vars", () => {
    expect(supporterSettings(full)).toEqual({ secretKey: "sk_test_a", webhookSecret: "whsec_a", priceId: "price_a" });
    for (const key of Object.keys(full)) {
      expect(supporterSettings({ ...full, [key]: "" })).toBeNull();
      const without: Record<string, string> = { ...full };
      delete without[key];
      expect(supporterSettings(without)).toBeNull();
    }
    expect(supporterSettings({ ...full, GROVE_SUPPORTER_ENABLED: "true" })).toBeNull();
    expect(supporterSettings({})).toBeNull();
  });

  it("refuses every entry point with a 404 while off", async () => {
    const svc = new SupporterService({} as never, null, (() => {
      throw new Error("must not call Stripe");
    }) as never);
    expect(svc.enabled).toBe(false);
    const calls: Array<() => unknown> = [
      () => svc.requireEnabled(),
      () => svc.priceDisplay(),
      () => svc.createCheckout("hum_x", "http://x"),
      () => svc.handleEvent({ type: "checkout.session.completed" }),
    ];
    for (const call of calls) {
      await expect(Promise.resolve().then(call)).rejects.toMatchObject({ httpStatus: 404 });
    }
    // Public flags: false with no database touched ({} store would throw).
    expect(await svc.isActive("hum_x")).toBe(false);
    expect((await svc.activeAmong(["hum_x", "hum_y"])).size).toBe(0);
  });
});

describe("Stripe webhook signature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });
  const now = 1_800_000_000;

  it("accepts a valid signature", () => {
    const header = signStripePayload(body, SECRET, now);
    expect(verifyStripeSignature(Buffer.from(body), header, SECRET, now)).toEqual({ ok: true, timestamp: now });
    expect(verifyStripeSignature(body, header, SECRET, now + 299).ok).toBe(true);
  });

  it("accepts any matching v1 during a secret roll", () => {
    const good = signStripePayload(body, SECRET, now).split("v1=")[1];
    const header = `t=${now},v1=${"0".repeat(64)},v1=${good},v0=${"1".repeat(64)}`;
    expect(verifyStripeSignature(body, header, SECRET, now).ok).toBe(true);
  });

  it("refuses a wrong secret, a changed body or a moved timestamp", () => {
    const header = signStripePayload(body, SECRET, now);
    expect(verifyStripeSignature(body, header, "whsec_other", now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(body + " ", header, SECRET, now)).toEqual({ ok: false, reason: "mismatch" });
    const moved = header.replace(`t=${now}`, `t=${now + 10}`);
    expect(verifyStripeSignature(body, moved, SECRET, now + 10)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a replay outside the 5-minute window, either side", () => {
    const header = signStripePayload(body, SECRET, now);
    expect(verifyStripeSignature(body, header, SECRET, now + 301)).toEqual({ ok: false, reason: "stale" });
    expect(verifyStripeSignature(body, header, SECRET, now - 301)).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses malformed or missing headers", () => {
    for (const h of [undefined, "", "garbage", `t=${now}`, `v1=${"a".repeat(64)}`, `t=abc,v1=${"a".repeat(64)}`, `t=${now},v1=short`]) {
      expect(verifyStripeSignature(body, h, SECRET, now)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, now), "", now).ok).toBe(false);
  });
});

describe("supporter helpers", () => {
  it("maps Stripe subscription statuses to three of ours", () => {
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("trialing")).toBe("active");
    expect(mapSubscriptionStatus("past_due")).toBe("past_due");
    expect(mapSubscriptionStatus("unpaid")).toBe("past_due");
    expect(mapSubscriptionStatus("canceled")).toBe("canceled");
    expect(mapSubscriptionStatus("incomplete_expired")).toBe("canceled");
    expect(mapSubscriptionStatus(undefined)).toBe("canceled");
  });

  it("formats a price from Stripe's own fields, never a hard-coded amount", () => {
    expect(formatPrice({ unit_amount: 300, currency: "gbp", recurring: { interval: "month", interval_count: 1 } })).toBe("£3.00 / month");
    expect(formatPrice({ unit_amount: 500, currency: "jpy", recurring: { interval: "year", interval_count: 1 } })).toBe("JP¥500 / year");
    expect(formatPrice({ unit_amount: 1200, currency: "usd", recurring: { interval: "month", interval_count: 3 } })).toBe("US$12.00 / 3 months");
    expect(formatPrice({ unit_amount: null, currency: "gbp" })).toBeNull();
    expect(formatPrice({ unit_amount: 100, currency: "zzzz" })).toBeNull();
  });
});

describe.skipIf(!hasDb)("supporter events are applied idempotently", () => {
  let grove: GroveApp;
  let svc: SupporterService;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the supporters suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    svc = new SupporterService(grove.store, SETTINGS, (() => {
      throw new Error("no Stripe calls in this suite");
    }) as never);
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      await redis.quit();
      await pg.end();
    }
  });

  async function newHuman() {
    const email = `sup-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function row(humanId: string) {
    const { rows } = await pg.query(`SELECT * FROM supporters WHERE human_id = $1`, [humanId]);
    return rows[0] as Record<string, unknown> | undefined;
  }

  const completed = (humanId: string, created: number, sub = `sub_${tag()}`) => ({
    id: `evt_${tag()}`,
    type: "checkout.session.completed",
    created,
    data: { object: { mode: "subscription", client_reference_id: humanId, customer: "cus_1", subscription: sub, payment_status: "paid" } },
  });
  const subEvent = (type: string, sub: string, status: string, created: number, periodEnd: number, humanId?: string) => ({
    id: `evt_${tag()}`,
    type,
    created,
    data: {
      object: {
        id: sub,
        customer: "cus_1",
        status,
        metadata: humanId ? { human_id: humanId } : {},
        items: { data: [{ current_period_end: periodEnd }] },
      },
    },
  });

  it("checkout completed makes an active supporter; a re-delivery changes nothing", async () => {
    const h = await newHuman();
    const ev = completed(h.id, 1000, "sub_a" + tag());
    expect(await svc.handleEvent(ev)).toBe("applied");
    const first = await row(h.id);
    expect(first?.status).toBe("active");
    expect(await svc.handleEvent(ev)).toBe("stale");
    const second = await row(h.id);
    expect(second?.updated_at).toEqual(first?.updated_at);
    expect(await svc.isActive(h.id)).toBe(true);
    expect((await svc.view(h.id)).perks).toEqual({ signTrim: true, extraDecor: true });
  });

  it("updates and deletes follow the subscription, and an older event never rolls back", async () => {
    const h = await newHuman();
    const sub = `sub_${tag()}`;
    expect(await svc.handleEvent(completed(h.id, 1000, sub))).toBe("applied");
    // Found by subscription id even without metadata.
    expect(await svc.handleEvent(subEvent("customer.subscription.updated", sub, "past_due", 1100, 2_000_000_000))).toBe("applied");
    expect((await row(h.id))?.status).toBe("past_due");
    expect((await svc.view(h.id)).currentPeriodEnd).toBe(new Date(2_000_000_000_000).toISOString());
    expect(await svc.isActive(h.id)).toBe(false);

    expect(await svc.handleEvent(subEvent("customer.subscription.deleted", sub, "canceled", 1200, 2_000_000_000))).toBe("applied");
    expect((await row(h.id))?.status).toBe("canceled");
    // The earlier "active" update arriving late is ignored.
    const late = subEvent("customer.subscription.updated", sub, "active", 1150, 2_000_000_000, h.id);
    expect(await svc.handleEvent(late)).toBe("stale");
    expect(await svc.handleEvent(completed(h.id, 1000, sub))).toBe("stale");
    expect((await row(h.id))?.status).toBe("canceled");
    expect((await svc.view(h.id)).perks).toEqual({ signTrim: false, extraDecor: false });
  });

  it("ignores events it cannot attach to a real person, and other event types", async () => {
    expect(await svc.handleEvent(completed("hum_does_not_exist_" + tag(), 1000))).toBe("ignored");
    expect(await svc.handleEvent(subEvent("customer.subscription.updated", `sub_unknown_${tag()}`, "active", 1000, 1))).toBe("ignored");
    expect(await svc.handleEvent({ type: "invoice.paid", created: 1, data: { object: {} } })).toBe("ignored");
    const h = await newHuman();
    const payment = completed(h.id, 1000);
    (payment.data.object as { mode: string }).mode = "payment";
    expect(await svc.handleEvent(payment)).toBe("ignored");
    expect(await row(h.id)).toBeUndefined();
  });

  it("activeAmong returns only active supporters", async () => {
    const a = await newHuman();
    const b = await newHuman();
    await svc.handleEvent(completed(a.id, 1000));
    const set = await svc.activeAmong([a.id, b.id, null, undefined]);
    expect([...set]).toEqual([a.id]);
  });
});
