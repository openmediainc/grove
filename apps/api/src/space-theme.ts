import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { requireHuman } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * Owner default theme per space (queue #59, migration 045).
 *
 *   PUT /api/v1/worlds/:id/default-theme      the space's owner; { theme: "aoe"|"space"|"city"|"scifi"|null }
 *   GET /api/v1/world/member-default-themes   signed in; defaults of the PRIVATE plots the viewer belongs to
 *
 * Anyone but the owner gets 404 on the write. A public plot's default travels
 * in the public minimap; a private plot's never does, so members fetch theirs
 * here, keyed by plot index, and outsiders get an empty list.
 */
export async function registerSpaceTheme(app: FastifyInstance, grove: GroveApp) {
  app.put("/api/v1/worlds/:id/default-theme", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const body = (req.body ?? {}) as { theme?: unknown };
    const defaultTheme = await grove.spaceTheme.set(human, (req.params as { id: string }).id, body.theme ?? null);
    return sendOk(reply, { defaultTheme });
  });

  app.get("/api/v1/world/member-default-themes", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const plots = await grove.spaceTheme.memberPrivate(human.id);
    return sendOk(reply, { plots });
  });
}
