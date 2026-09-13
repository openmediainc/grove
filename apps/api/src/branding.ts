import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GroveApp } from "@grove/domain";
import { toCamel } from "@grove/protocol";
import { optionalHuman, requireHuman } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * Space branding (migration 035): accent colour, sign text, emblem.
 *
 *   GET /api/v1/worlds/:id/branding   anyone who may see the space (private: members, else 404)
 *   PUT /api/v1/worlds/:id/branding   the space's owner; { accent, sign_text, emblem }
 *   POST /api/v1/spaces/:id/branding/suggest   (also /worlds/:id/...) the owner; { url }
 *        -> { name, accent, source, notes }. Reads the website, saves nothing:
 *        the owner reviews it in the Manage preview and saves with the PUT.
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

  const suggest = async (req: FastifyRequest, reply: FastifyReply) => {
    const human = await requireHuman(req, grove);
    const body = (req.body ?? {}) as { url?: unknown };
    const s = await grove.branding.suggestFromWebsite(human, (req.params as { id: string }).id, body.url);
    return sendOk(reply, {
      name: s.name,
      accent: s.accent
        ? { accent: s.accent.accent, original: s.accent.original, substituted: s.accent.substituted, note: s.accent.note }
        : null,
      source: {
        url: s.source.url,
        site_name: s.source.siteName,
        title: s.source.title,
        theme_color: s.source.themeColor,
        favicon: s.source.favicon,
        favicon_colour: s.source.faviconColour,
        accent_from: s.source.accentFrom,
      },
      notes: s.notes,
    });
  };
  app.post("/api/v1/spaces/:id/branding/suggest", suggest);
  app.post("/api/v1/worlds/:id/branding/suggest", suggest);
}
