import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GroveApp, WindowStats } from "@grove/domain";
import { GroveError } from "@grove/domain";
import { toSnake } from "@grove/protocol";
import { requireHuman, requireOperator } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * ONB-07 — magic-link deliverability, on the wire.
 *
 * Two doors onto the same report (EmailDeliveryService.health):
 *
 *  GET /api/v1/mod/email        Operator only (404 otherwise, like every /mod
 *                               route). The /mod "Email" tab: verdict, funnel,
 *                               DNS, and the last sends with masked recipients.
 *
 *  GET /internal/email-health   The machine probe for alerting (OPS-03). No
 *                               cookie, so it is LOOPBACK ONLY: it answers a
 *                               direct connection to 127.0.0.1:3511 carrying no
 *                               proxy headers, and 404s anything else. It is
 *                               also outside /api, so the web app's rewrites
 *                               never forward it onto the tailnet.
 *                               HTTP 503 when status is `down`, 200 otherwise —
 *                               `curl -fsS` fails exactly when nobody can sign
 *                               in. The body carries no recipient data at all.
 *                               Contract: docs/EMAIL-DELIVERABILITY.md.
 */

function isDirectLoopback(req: FastifyRequest): boolean {
  const addr = req.socket.remoteAddress ?? "";
  const loopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  const proxied = Boolean(req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"] || req.headers["x-real-ip"]);
  return loopback && !proxied;
}

export async function registerEmailHealth(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/mod/email", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    const q = req.query as { refresh_dns?: string; limit?: string };
    const [health, recent] = await Promise.all([
      grove.emailDeliveries.health({ forceDns: q.refresh_dns === "1" }),
      grove.emailDeliveries.recent(q.limit ? Number(q.limit) : 50),
    ]);
    return sendOk(reply, { health, recent });
  });

  app.get("/internal/email-health", async (req, reply) => {
    if (!isDirectLoopback(req)) throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    const h = await grove.emailDeliveries.health();
    const body = {
      ok: h.status !== "down",
      status: h.status,
      reasons: h.reasons,
      transport: h.transport,
      deliveryTruth: h.deliveryTruth,
      hour: pick(h.windows.hour),
      day: pick(h.windows.day),
      dns: h.dns
        ? {
            domain: h.dns.domain,
            spf: h.dns.spf.present,
            dkim: h.dns.dkim.present,
            dmarc: h.dns.dmarc.present,
            dmarcPolicy: h.dns.dmarc.policy,
            dmarcRecord: h.dns.dmarc.present ? h.dns.dmarc.name : null,
            dmarcAppliedFrom: h.dns.dmarc.appliedFrom,
            error: h.dns.error,
          }
        : null,
      generatedAt: h.generatedAt,
    };
    return reply.status(h.status === "down" ? 503 : 200).send(toSnake(body));
  });
}

function pick(w: WindowStats) {
  return {
    attempts: w.attempts,
    realAttempts: w.realAttempts,
    accepted: w.accepted,
    rejected: w.rejected,
    errored: w.errored,
    sendFailureRate: w.sendFailureRate,
    delivered: w.delivered,
    bounced: w.bounced,
    complained: w.complained,
    redeemed: w.redeemed,
    expiredUnredeemed: w.expiredUnredeemed,
    recipientsIn: w.recipientsIn,
    recipientsStranded: w.recipientsStranded,
    recipientRedeemRate: w.recipientRedeemRate,
    redeemSecondsP50: w.redeemSecondsP50,
    lastAcceptedAt: w.lastAcceptedAt,
    lastRedeemedAt: w.lastRedeemedAt,
  };
}
