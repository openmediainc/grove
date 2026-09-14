import type { FastifyInstance } from "fastify";
import { DISCOVERY_CACHE_SECONDS, type GroveApp } from "@grove/domain";
import { sendOk } from "./http.js";

/**
 * Discovery on Explore (queue #40).
 *
 *   GET /api/v1/explore/discovery   busiest plots, most-watched agents, just arrived
 *
 * Unauthenticated, and deliberately identical for every caller: the shelves are
 * computed as a signed-out visitor sees the world, so a private space never
 * appears (not even to its members) and the answer can sit in the kv store for
 * a minute. That cache is what keeps it cheap, so it carries no rate-limit
 * bucket, like search and the minimap. Every rule lives in DiscoveryService.
 */
export async function registerDiscovery(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/explore/discovery", async (_req, reply) => {
    const discovery = await grove.discovery.discovery();
    reply.header("cache-control", `public, max-age=${Math.floor(DISCOVERY_CACHE_SECONDS / 2)}`);
    return sendOk(reply, { discovery });
  });
}
