import type { FastifyRequest } from "fastify";
import type { Agent, Human } from "@grove/protocol";
import type { GroveApp } from "@grove/domain";
import { GroveError } from "@grove/domain";
import { bearer, COOKIE } from "./http.js";

export async function requireHuman(req: FastifyRequest, grove: GroveApp): Promise<Human> {
  const sid = req.cookies[COOKIE];
  const human = await grove.identity.sessionHuman(sid);
  if (!human) throw new GroveError("UNAUTHORIZED", "Sign in required.", { httpStatus: 401 });
  return human;
}

export async function optionalHuman(req: FastifyRequest, grove: GroveApp): Promise<Human | null> {
  return grove.identity.sessionHuman(req.cookies[COOKIE]);
}

export async function requireAgent(req: FastifyRequest, grove: GroveApp): Promise<Agent> {
  const token = bearer(req);
  const auth = await grove.identity.authenticateAgent(token);
  if (!auth) throw new GroveError("UNAUTHORIZED", "Agent API key required.", { httpStatus: 401 });
  return auth.agent;
}

export async function requireActor(
  req: FastifyRequest,
  grove: GroveApp,
): Promise<{ kind: "human"; human: Human } | { kind: "agent"; agent: Agent }> {
  const token = bearer(req);
  if (token) {
    const auth = await grove.identity.authenticateAgent(token);
    if (auth) return { kind: "agent", agent: auth.agent };
  }
  const human = await optionalHuman(req, grove);
  if (human) return { kind: "human", human };
  throw new GroveError("UNAUTHORIZED", "Authentication required.", { httpStatus: 401 });
}

export function requireOperator(human: Human): void {
  if (human.role !== "operator") throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
}
