import type { FastifyReply, FastifyRequest } from "fastify";
import { GroveError } from "@grove/domain";
import { capabilityWire, HTTP_STATUS_FOR_CODE, toSnake } from "@grove/protocol";

export function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof GroveError) {
    const body: Record<string, unknown> = {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
      },
    };
    const error = body.error as Record<string, unknown>;
    if (err.capability) error.capability = capabilityWire(err.capability);
    if (err.hint) error.hint = err.hint;
    if (err.suggestedRoom) error.suggested_room = err.suggestedRoom;
    if (err.code === "PERMISSION_DENIED" && err.capability) {
      error.docs = `https://grove.example/docs/permissions#${capabilityWire(err.capability)}`;
    }
    const status = err.httpStatus || HTTP_STATUS_FOR_CODE[err.code] || 400;
    reply.header("X-Aetheria-Error", err.code);
    if (status === 429) reply.header("Retry-After", "60");
    return reply.status(status).send(body);
  }
  const message = err instanceof Error ? err.message : "internal error";
  console.error(err);
  return reply.status(500).send({ ok: false, error: { code: "INTERNAL", message } });
}

export function sendOk(reply: FastifyReply, data: Record<string, unknown>, status = 200) {
  return reply.status(status).send(toSnake({ ok: true, ...data }));
}

export function clientIp(req: FastifyRequest): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string") return xf.split(",")[0]!.trim();
  return req.ip;
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1];
}

export const COOKIE = "grove_session";
