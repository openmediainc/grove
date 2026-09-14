import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { requireHuman } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * Plot decor (queue #45, migration 044).
 *
 *   GET /api/v1/worlds/:id/decor   the space's owner: placed items + preset catalogue (locked ones say what earns them)
 *   PUT /api/v1/worlds/:id/decor   the space's owner; { items: [{ preset, slot }] } (≤ 6, unlocked, on real slots)
 *
 * Anyone else gets 404. The public sees decor only on the minimap, where a
 * private plot carries none. Rules live in @grove/protocol decor.ts.
 */
export async function registerDecor(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/worlds/:id/decor", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const decor = await grove.decor.get(human, (req.params as { id: string }).id);
    return sendOk(reply, { decor });
  });

  app.put("/api/v1/worlds/:id/decor", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const body = (req.body ?? {}) as { items?: unknown };
    const decor = await grove.decor.set(human, (req.params as { id: string }).id, body.items ?? null);
    return sendOk(reply, { decor });
  });
}
