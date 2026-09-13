import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { toCamel } from "@grove/protocol";
import { requireHuman } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * Estate names (queue #37, migration 038). Estates are computed in the minimap;
 * these only name the shared sign.
 *
 *   GET /api/v1/estates/names   the caller's own estate name and the orgs they own
 *   PUT /api/v1/estates/names   { estate_name, org_id? } — own estate, or an org the caller owns (else 404)
 */
export async function registerEstates(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/estates/names", async (req, reply) => {
    const human = await requireHuman(req, grove);
    return sendOk(reply, { names: await grove.estates.names(human) });
  });

  app.put("/api/v1/estates/names", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
    const orgId = typeof b.orgId === "string" && b.orgId ? b.orgId : null;
    const names = await grove.estates.setName(human, { orgId, name: b.estateName ?? null });
    return sendOk(reply, { names });
  });
}
