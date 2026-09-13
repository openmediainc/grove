import type { FastifyInstance, FastifyRequest } from "fastify";
import { looksLikeBot, trackingRefused, type ActionEvent, type GroveApp } from "@grove/domain";
import { optionalHuman } from "./auth.js";
import { clientIp, COOKIE } from "./http.js";

/**
 * First-party analytics on the wire (migration 033). Stance: docs/PRIVACY.md.
 *
 *  POST /api/v1/analytics/visit   The web app's page-view beacon (sendBeacon, no
 *                                 body). Always 204, counted or not, so the
 *                                 response says nothing about the filter.
 *
 * Actions are counted by the routes that perform them, through countAction():
 * sign-in consume, walk-ins (world / room / space enter), follow, message and
 * reaction — people only, never agents, and never a request carrying DNT or
 * GPC. What reaches AnalyticsService is an event name and, for the weekly
 * retention mark, the person's id; neither the IP nor the user agent of an
 * action is passed on.
 */

/** Count one action by a person, unless their browser asked not to be counted. Never throws. */
export async function countAction(req: FastifyRequest, grove: GroveApp, event: ActionEvent, humanId: string | null): Promise<void> {
  if (!humanId || trackingRefused(req.headers)) return;
  await grove.analytics.record(event, { humanId }).catch(() => {});
}

export async function registerAnalytics(app: FastifyInstance, grove: GroveApp) {
  app.post("/api/v1/analytics/visit", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
    if (!trackingRefused(req.headers) && !looksLikeBot(ua)) {
      // A session lookup only when a session cookie came along.
      const human = req.cookies[COOKIE] ? await optionalHuman(req, grove).catch(() => null) : null;
      await grove.analytics.visit({ ip: clientIp(req), userAgent: ua, humanId: human?.id ?? null });
    }
    return reply.status(204).send();
  });
}
