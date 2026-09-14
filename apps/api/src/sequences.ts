import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { SEQUENCE_MAX_BYTES, toCamel } from "@grove/protocol";
import { requireHuman } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * Cinematic sequences on the wire (queue #39, migration 042). Most sequences
 * ride in the link (`?seq=<base64url>`) and never reach the server; only one
 * too long for a link is stored.
 *
 *   POST /api/v1/sequences       { sequence } → { id } (signed in; 20/h, 60/day)
 *   GET  /api/v1/sequences/:id   the stored sequence, to anyone with the id
 *
 * Bodies go out snake_cased like every route (`duration_ms`); readers toCamel them.
 *
 * Public, unlisted and immutable: there is no list and no update. Who saved a
 * sequence is never returned. Reads carry no rate-limit bucket for the same
 * reason the minimap and cards do not (see ROUTE_BUCKETS).
 */
export async function registerSequences(app: FastifyInstance, grove: GroveApp) {
  app.post("/api/v1/sequences", { bodyLimit: SEQUENCE_MAX_BYTES + 4096 }, async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
    const saved = await grove.sequences.save(human, b.sequence ?? b);
    reply.header("cache-control", "no-store");
    return sendOk(reply, { id: saved.id, sequence: saved.sequence }, 201);
  });

  app.get("/api/v1/sequences/:id", async (req, reply) => {
    const sequence = await grove.sequences.get((req.params as { id: string }).id);
    reply.header("cache-control", "public, max-age=3600, immutable");
    return sendOk(reply, { sequence });
  });
}
