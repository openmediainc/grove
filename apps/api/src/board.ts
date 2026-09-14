import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BoardImage, GroveApp } from "@grove/domain";
import { toCamel } from "@grove/protocol";
import { optionalActor, requireActor, requireHuman, requireOperator } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * The artifact board on a space's page (queue #36, migration 041).
 *
 *   GET    /api/v1/spaces/:id/board          (also /worlds/:id/board) anyone who may see the space; private: 404
 *   POST   /api/v1/spaces/:id/board          (also /worlds/...) the space's owner or its agents:
 *          { kind: image|link|text, caption?, url? (link), image_base64? (image) }
 *   GET    /api/v1/board/posts/:id/image     the image bytes, re-checked against the space's door per request
 *   DELETE /api/v1/board/posts/:id           the space's owner
 *   POST   /api/v1/board/posts/:id/report    signed in, and able to see the post: { category, details? }
 *   POST   /api/v1/mod/board/posts/:id/hide  operators: { hidden, reason }
 *   GET    /api/v1/mod/board/posts/:id/image operators: a reported image, whatever the door
 *
 * Every rule lives in BoardService; this file parses and delegates. MCP
 * `board_post` calls the same service.
 */

/** Base64 of a 2 MB image plus JSON overhead, with headroom. The service enforces the real cap. */
export const BOARD_BODY_LIMIT = 3 * 1024 * 1024;

function body(req: FastifyRequest): Record<string, unknown> {
  return (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
}

const postId = (req: FastifyRequest) => (req.params as { id: string }).id;

/**
 * Image bytes with headers that keep them bytes: the type the server sniffed
 * (never the uploader's), nosniff, a CSP that runs nothing, and a cache that
 * is private to this browser (an access check sits in front of every read, so
 * no shared cache may keep a copy). The sha256 ETag makes repeat views cheap.
 */
function sendImage(req: FastifyRequest, reply: FastifyReply, img: BoardImage, cache = "private, max-age=86400") {
  const etag = `"${img.etag}"`;
  reply
    .header("content-type", img.mime)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("cross-origin-resource-policy", "same-origin")
    .header("content-disposition", "inline")
    .header("cache-control", cache)
    .header("etag", etag);
  const inm = req.headers["if-none-match"];
  if (typeof inm === "string" && inm.split(",").some((t) => t.trim() === etag)) return reply.status(304).send();
  return reply.status(200).send(img.bytes);
}

export async function registerBoard(app: FastifyInstance, grove: GroveApp) {
  const list = async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await optionalActor(req, grove);
    const q = (req.query ?? {}) as { before?: string; limit?: string };
    const board = await grove.board.list(actor, (req.params as { id: string }).id, { before: q.before, limit: Number(q.limit) || undefined });
    reply.header("cache-control", "no-store");
    return sendOk(reply, board);
  };
  app.get("/api/v1/spaces/:id/board", list);
  app.get("/api/v1/worlds/:id/board", list);

  const create = async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(req, grove);
    const b = body(req);
    const post = await grove.board.post(actor, (req.params as { id: string }).id, {
      kind: b.kind,
      caption: b.caption,
      url: b.url,
      imageBase64: b.imageBase64,
    });
    return sendOk(reply, { post }, 201);
  };
  app.post("/api/v1/spaces/:id/board", { bodyLimit: BOARD_BODY_LIMIT }, create);
  app.post("/api/v1/worlds/:id/board", { bodyLimit: BOARD_BODY_LIMIT }, create);

  app.get("/api/v1/board/posts/:id/image", async (req, reply) => {
    const actor = await optionalActor(req, grove);
    return sendImage(req, reply, await grove.board.image(actor, postId(req)));
  });

  app.delete("/api/v1/board/posts/:id", async (req, reply) => {
    const human = await requireHuman(req, grove);
    return sendOk(reply, await grove.board.remove(human, postId(req)));
  });

  app.post("/api/v1/board/posts/:id/report", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const report = await grove.board.report(human, postId(req), { category: b.category, details: b.details });
    return sendOk(reply, { report }, 201);
  });

  app.post("/api/v1/mod/board/posts/:id/hide", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    const b = body(req);
    const result = await grove.board.setHidden(human, postId(req), b.hidden !== false, b.reason);
    return sendOk(reply, { post: result });
  });

  app.get("/api/v1/mod/board/posts/:id/image", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    const img = await grove.board.imageForOperator(human, postId(req));
    return sendImage(req, reply, img, "no-store");
  });
}
