/**
 * Supporter plumbing through the real routes (queue #47).
 *
 *  - Off (the default, and every deploy without all four env vars): all three
 *    routes answer 404, signed in or not, and public flags are false.
 *  - On: checkout builds a subscription-mode Checkout Session for the signed-in
 *    person; the webhook believes only a valid signature over the raw body,
 *    refuses stale timestamps, and applies a re-delivery once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, SupporterService, createPool, loadConfig, migrate, signStripePayload } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("supporter routes suite");

const SECRET = "whsec_routes_" + "y".repeat(20);

function cookiesOf(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
}

describe.skipIf(!hasDb)("supporter routes", () => {
  let off: Awaited<ReturnType<typeof buildApp>>;
  let on: Awaited<ReturnType<typeof buildApp>>;
  let groveOff: GroveApp;
  let groveOn: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const stripeCalls: Array<{ url: string; init?: RequestInit }> = [];

  const fakeStripe = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    stripeCalls.push({ url, init });
    if (url.includes("/prices/")) {
      return new Response(JSON.stringify({ id: "price_routes", unit_amount: 450, currency: "gbp", recurring: { interval: "month", interval_count: 1 } }), {
        status: 200,
      });
    }
    if (url.endsWith("/checkout/sessions")) {
      return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the supporter routes suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    groveOff = new GroveApp(pg, redis, config);
    // Force OFF regardless of the machine's env.
    groveOff.supporters = new SupporterService(groveOff.store, null);
    groveOff.world.supporters = groveOff.supporters;
    off = await buildApp(groveOff);

    groveOn = new GroveApp(pg, redis, config);
    groveOn.supporters = new SupporterService(
      groveOn.store,
      { secretKey: "sk_test_fake", webhookSecret: SECRET, priceId: "price_routes" },
      fakeStripe,
    );
    groveOn.world.supporters = groveOn.supporters;
    on = await buildApp(groveOn);
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      await off?.close();
      await on?.close();
      await redis.quit();
      await pg.end();
    }
  });

  async function signIn(app: typeof on) {
    const local = `sup${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const magic = await app.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `${local}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await app.inject({ method: "POST", url: "/api/v1/humans/session/consume", payload: { token } });
    const session = cookiesOf(consumed).find((c) => c.startsWith("grove_session=")) ?? "";
    const human = (consumed.json() as { human: { id: string; handle: string } }).human;
    fixtures.trackHuman(human.id, session);
    return { cookie: session.split(";")[0]!, id: human.id, handle: human.handle };
  }

  function webhook(app: typeof on, body: string, header?: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/stripe/webhook",
      headers: { "content-type": "application/json", ...(header ? { "stripe-signature": header } : {}) },
      payload: body,
    });
  }

  it("answers 404 on every supporter route while off, signed in or not", async () => {
    const me = await signIn(off);
    const body = JSON.stringify({ type: "checkout.session.completed" });
    const header = signStripePayload(body, SECRET, Math.floor(Date.now() / 1000));
    const calls = [
      off.inject({ method: "GET", url: "/api/v1/supporter" }),
      off.inject({ method: "GET", url: "/api/v1/supporter", headers: { cookie: me.cookie } }),
      off.inject({ method: "POST", url: "/api/v1/supporter/checkout" }),
      off.inject({ method: "POST", url: "/api/v1/supporter/checkout", headers: { cookie: me.cookie } }),
      webhook(off, body, header),
      webhook(off, body),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(404);

    const profile = await off.inject({ method: "GET", url: `/api/v1/u/${me.handle}` });
    expect((profile.json() as { human: { supporter: boolean } }).human.supporter).toBe(false);
    const map = await off.inject({ method: "GET", url: "/api/v1/world/minimap" });
    for (const s of (map.json() as { spaces: Array<{ supporter: boolean }> }).spaces) expect(s.supporter).toBe(false);
  });

  it("when on: status needs sign-in, shows the price from Stripe, and checkout builds a subscription session", async () => {
    expect((await on.inject({ method: "GET", url: "/api/v1/supporter" })).statusCode).toBe(401);
    expect((await on.inject({ method: "POST", url: "/api/v1/supporter/checkout" })).statusCode).toBe(401);

    const me = await signIn(on);
    const status = await on.inject({ method: "GET", url: "/api/v1/supporter", headers: { cookie: me.cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      supporter: { status: null, active: false, perks: { sign_trim: false, extra_decor: false } },
      price: { display: "£4.50 / month" },
    });

    stripeCalls.length = 0;
    const checkout = await on.inject({ method: "POST", url: "/api/v1/supporter/checkout", headers: { cookie: me.cookie } });
    expect(checkout.statusCode).toBe(200);
    expect((checkout.json() as { checkout: { url: string } }).checkout.url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    const call = stripeCalls.find((c) => c.url.endsWith("/checkout/sessions"))!;
    expect(call.init?.method).toBe("POST");
    const form = new URLSearchParams(String(call.init?.body));
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("client_reference_id")).toBe(me.id);
    expect(form.get("line_items[0][price]")).toBe("price_routes");
    expect(form.get("success_url")).toMatch(/\/me\?supporter=thanks#support$/);
    expect(form.get("cancel_url")).toMatch(/\/me#support$/);
  });

  it("webhook: valid signature applies once, invalid and replayed signatures are refused", async () => {
    const me = await signIn(on);
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: "evt_routes_1",
      type: "checkout.session.completed",
      created: now,
      data: { object: { mode: "subscription", client_reference_id: me.id, customer: "cus_r", subscription: `sub_r_${me.id}`, payment_status: "paid" } },
    });

    const bad = await webhook(on, body, signStripePayload(body, "whsec_wrong", now));
    expect(bad.statusCode).toBe(400);
    const missing = await webhook(on, body);
    expect(missing.statusCode).toBe(400);
    const tampered = await webhook(on, body.replace("paid", "unpaid"), signStripePayload(body, SECRET, now));
    expect(tampered.statusCode).toBe(400);
    const replay = await webhook(on, body, signStripePayload(body, SECRET, now - 600));
    expect(replay.statusCode).toBe(400);
    expect((replay.json() as { error: { message: string } }).error.message).toContain("stale");
    expect((bad.json() as { error: { message: string } }).error.message).toContain("mismatch");
    expect(await groveOn.supporters.isActive(me.id)).toBe(false);

    const good = await webhook(on, body, signStripePayload(body, SECRET, now));
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({ received: true, outcome: "applied" });
    const again = await webhook(on, body, signStripePayload(body, SECRET, now));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ received: true, outcome: "stale" });

    expect(await groveOn.supporters.isActive(me.id)).toBe(true);
    const profile = await on.inject({ method: "GET", url: `/api/v1/u/${me.handle}` });
    expect((profile.json() as { human: { supporter: boolean } }).human.supporter).toBe(true);
    // The same person is still not flagged by an app that is switched off.
    const offProfile = await off.inject({ method: "GET", url: `/api/v1/u/${me.handle}` });
    expect((offProfile.json() as { human: { supporter: boolean } }).human.supporter).toBe(false);

    const status = await on.inject({ method: "GET", url: "/api/v1/supporter", headers: { cookie: me.cookie } });
    expect(status.json()).toMatchObject({ supporter: { status: "active", active: true, perks: { sign_trim: true, extra_decor: true } } });
    const conflict = await on.inject({ method: "POST", url: "/api/v1/supporter/checkout", headers: { cookie: me.cookie } });
    expect(conflict.statusCode).toBe(409);
  });

  it("webhook parsing leaves other routes on the JSON parser", async () => {
    const res = await on.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `parser${Date.now()}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    expect(res.statusCode).toBe(200);
  });
});
