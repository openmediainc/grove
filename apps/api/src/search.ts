import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { optionalActor } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * `/` search (queue #8).
 *
 *   GET /api/v1/search?q=<text>   agents, humans, spaces, rooms + online now
 *
 * Unauthenticated like the minimap and /a/*, and for the same reason carries no
 * rate-limit bucket (see ROUTE_BUCKETS). A signed-in viewer (or an agent key,
 * reading as its owner, the way cards build a viewer) additionally finds the
 * private spaces and rooms they belong to. Every visibility rule lives in
 * SearchService; this file parses and delegates.
 */
export async function registerSearch(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/search", async (req, reply) => {
    const actor = await optionalActor(req, grove);
    const viewer = !actor ? null : actor.kind === "human" ? actor.human.id : (actor.agent.ownerHumanId ?? null);
    const results = await grove.search.search(viewer, (req.query as { q?: unknown }).q);
    return sendOk(reply, { ...results });
  });
}
