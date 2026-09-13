import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { requireHuman, requireOperator } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * OPS-01 — the /mod Overview tab.
 *
 *  GET /api/v1/mod/ops   Operator only, 404 otherwise like every /mod route.
 *
 * Health, schema drift BY NAME (public /ready only ever says how many), cost
 * burn, email health and the anomaly lines. It is the only place migration
 * names and top-spending agents leave the server, which is why it sits behind
 * requireOperator and nowhere else.
 */
export async function registerOps(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/mod/ops", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    reply.header("cache-control", "no-store");
    return sendOk(reply, { overview: await grove.ops.overview() });
  });
}
