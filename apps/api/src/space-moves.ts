import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { requireHuman } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * Transfer & relocate (queue #35). Every rule lives in SpaceMoveService; this
 * file parses and delegates. Signed out: 401. Not the space's holder (members,
 * strangers and operators alike): 404, the same as a space that does not exist.
 * The commons: 400, it can neither move nor change hands.
 *
 *   GET    /api/v1/worlds/:id/transfer          holder: { pending, last, candidates }
 *   POST   /api/v1/worlds/:id/transfer          holder: { to_handle | to_human_id | to_org_id, confirm, leave }
 *   DELETE /api/v1/worlds/:id/transfer          holder: cancel the pending offer
 *   GET    /api/v1/transfers/incoming           offers waiting for me
 *   POST   /api/v1/transfers/:id/accept         the recipient only (else 404)
 *   POST   /api/v1/transfers/:id/decline        the recipient only (else 404)
 *   GET    /api/v1/worlds/:id/relocate          holder: { current, next_allowed_at, options, taken, anchors }
 *   POST   /api/v1/worlds/:id/relocate          holder: { plot_index, confirm }
 */
export async function registerSpaceMoves(app: FastifyInstance, grove: GroveApp) {
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  const bodyOf = (req: { body: unknown }) => (req.body ?? {}) as Record<string, unknown>;

  app.get("/api/v1/worlds/:id/transfer", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const state = await grove.spaceMoves.transferState(human, idOf(req));
    const candidates = await grove.spaceMoves.candidates(human, idOf(req));
    reply.header("cache-control", "private, no-store");
    return sendOk(reply, { ...state, candidates });
  });

  app.post("/api/v1/worlds/:id/transfer", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = bodyOf(req);
    const transfer = await grove.spaceMoves.offerTransfer(human, idOf(req), {
      toHandle: b.to_handle ?? b.toHandle,
      toHumanId: b.to_human_id ?? b.toHumanId,
      toOrgId: b.to_org_id ?? b.toOrgId,
      confirm: b.confirm,
      leave: b.leave,
    });
    return sendOk(reply, { transfer }, 201);
  });

  app.delete("/api/v1/worlds/:id/transfer", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const transfer = await grove.spaceMoves.cancelTransfer(human, idOf(req));
    return sendOk(reply, { transfer });
  });

  app.get("/api/v1/transfers/incoming", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const offers = await grove.spaceMoves.incoming(human.id);
    reply.header("cache-control", "private, no-store");
    return sendOk(reply, { offers });
  });

  app.post("/api/v1/transfers/:id/accept", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const transfer = await grove.spaceMoves.answer(human, idOf(req), "accept");
    return sendOk(reply, { transfer });
  });

  app.post("/api/v1/transfers/:id/decline", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const transfer = await grove.spaceMoves.answer(human, idOf(req), "decline");
    return sendOk(reply, { transfer });
  });

  app.get("/api/v1/worlds/:id/relocate", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const plan = await grove.spaceMoves.relocationPlan(human, idOf(req));
    reply.header("cache-control", "private, no-store");
    return sendOk(reply, { ...plan });
  });

  app.post("/api/v1/worlds/:id/relocate", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = bodyOf(req);
    const world = await grove.spaceMoves.relocate(human, idOf(req), {
      plotIndex: b.plot_index ?? b.plotIndex,
      confirm: b.confirm,
    });
    return sendOk(reply, { world });
  });
}
