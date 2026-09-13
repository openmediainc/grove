import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { toCamel } from "@grove/protocol";
import { optionalHuman, requireHuman } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * Space branding (migration 035): accent colour, sign text, emblem.
 *
 *   GET /api/v1/worlds/:id/branding   anyone who may see the space (private: members, else 404)
 *   PUT /api/v1/worlds/:id/branding   the space's owner; { accent, sign_text, emblem }
 *
 * Every visibility and validation rule lives in BrandingService and
 * @grove/protocol branding.ts; this file parses and delegates.
 */
export async function registerBranding(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/worlds/:id/branding", async (req, reply) => {
    const human = await optionalHuman(req, grove);
    const branding = await grove.branding.spaceBranding(human, (req.params as { id: string }).id);
    return sendOk(reply, { branding });
  });

  app.put("/api/v1/worlds/:id/branding", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const body = (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
    const branding = await grove.branding.setSpaceBranding(human, (req.params as { id: string }).id, body);
    return sendOk(reply, { branding });
  });
}
