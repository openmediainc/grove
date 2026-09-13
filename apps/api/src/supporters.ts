import type { FastifyInstance } from "fastify";
import { GroveError, verifyStripeSignature, type GroveApp } from "@grove/domain";
import { requireHuman } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * Supporter plumbing on the wire (queue #47, migration 036).
 *
 *   GET  /api/v1/supporter            my supporter status, perks and the price display (signed in)
 *   POST /api/v1/supporter/checkout   start a Stripe Checkout Session → { url } (signed in)
 *   POST /api/v1/stripe/webhook       Stripe events, signature-verified over the raw body
 *
 * All three answer 404 unless STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 * STRIPE_SUPPORTER_PRICE_ID and GROVE_SUPPORTER_ENABLED=1 are all set, so a
 * deploy without them looks exactly like one without the feature. The 404 is
 * decided before authentication, so it never depends on who asks.
 *
 * Supporter status is cosmetic. Nothing here, or anywhere, gates access on it.
 */
export async function registerSupporters(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/supporter", async (req, reply) => {
    grove.supporters.requireEnabled();
    const human = await requireHuman(req, grove);
    reply.header("cache-control", "no-store");
    const [supporter, price] = await Promise.all([grove.supporters.view(human.id), grove.supporters.priceDisplay()]);
    return sendOk(reply, { supporter, price: { display: price } });
  });

  app.post("/api/v1/supporter/checkout", async (req, reply) => {
    grove.supporters.requireEnabled();
    const human = await requireHuman(req, grove);
    await grove.quota.consumeWrite(human.id, false);
    const session = await grove.supporters.createCheckout(human.id, grove.store.config.publicUrl);
    reply.header("cache-control", "no-store");
    return sendOk(reply, { checkout: session });
  });

  // The webhook needs the exact bytes Stripe signed, so this scope parses
  // every body as a Buffer instead of JSON. Encapsulated: other routes keep
  // the normal JSON parser.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

    scope.post("/api/v1/stripe/webhook", async (req, reply) => {
      const settings = grove.supporters.requireEnabled();
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const header = req.headers["stripe-signature"];
      const verdict = verifyStripeSignature(raw, Array.isArray(header) ? header.join(",") : header, settings.webhookSecret);
      if (!verdict.ok) {
        throw new GroveError("VALIDATION_ERROR", `Invalid signature (${verdict.reason}).`, { httpStatus: 400 });
      }
      let event: unknown;
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new GroveError("VALIDATION_ERROR", "Body is not JSON.", { httpStatus: 400 });
      }
      const outcome = await grove.supporters.handleEvent(event as Parameters<typeof grove.supporters.handleEvent>[0]);
      return sendOk(reply, { received: true, outcome });
    });
  });
}
