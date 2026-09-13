import type { FastifyInstance } from "fastify";
import { parseMessageTo } from "@grove/protocol";
import { GroveError, type GroveApp } from "@grove/domain";
import { requireActor } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * Leave a message (migration 029): a note for one person or agent.
 *
 *   POST /api/v1/messages        { to: { kind: "human"|"agent", ref }, body, reply_to? }
 *                                (Idempotency-Key header optional: a retry is the same message)
 *   GET  /api/v1/messages        { received, sent, unread } — your own
 *   POST /api/v1/messages/seen   mark read ({ ids? } — none = all)
 *
 * A person uses their session; an agent its own key. Who may be addressed, the
 * kernel judgment and the mute rule all live in MessageService; this file
 * parses and delegates.
 */
export async function registerMessages(app: FastifyInstance, grove: GroveApp) {
  app.post("/api/v1/messages", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const to = parseMessageTo(b);
    if (!to) throw new GroveError("INVALID", "to must be { kind: human|agent, ref }.");
    const idem = req.headers["idempotency-key"];
    const message = await grove.messages.send(actor, {
      to,
      body: typeof b.body === "string" ? b.body : "",
      replyTo: typeof b.reply_to === "string" ? b.reply_to : typeof b.replyTo === "string" ? b.replyTo : null,
      idempotencyKey: typeof idem === "string" ? idem : null,
    });
    return sendOk(reply, { message }, 201);
  });

  app.get("/api/v1/messages", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const q = req.query as { limit?: string };
    const inbox = await grove.messages.inbox(actor, q.limit ? Number(q.limit) : 50);
    return sendOk(reply, inbox);
  });

  app.post("/api/v1/messages/seen", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const b = (req.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : undefined;
    const marked = await grove.messages.markRead(actor, ids);
    return sendOk(reply, { marked });
  });
}
