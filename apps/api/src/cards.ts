import type { FastifyInstance } from "fastify";
import { isFirst24h, type GroveApp } from "@grove/domain";
import { toCamel } from "@grove/protocol";
import { optionalActor, optionalHuman, requireAgent, requireHuman } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * Cards (migration 027): working on / looking for / latest / links.
 *
 *   GET /api/v1/cards/spaces/:ref    a space, by id or slug (private: members only, else 404)
 *   GET /api/v1/cards/agents/*       an agent, by slug or id
 *   GET /api/v1/cards/humans/:handle a person
 *   PUT /api/v1/worlds/:id/card      the space's owner
 *   PUT /api/v1/agents/:id/card      the agent's owner (looking_for, links)
 *   PUT /api/v1/humans/me/card       the person themself
 *   PUT /api/v1/agents/me/card       the agent itself, with its own key (looking_for, links; #65)
 *
 * Reads are unauthenticated like /a/* and /u/:handle, and deliberately carry no
 * rate-limit bucket for the same reason (see ROUTE_BUCKETS). Every visibility
 * rule lives in CardService; this file parses and delegates.
 */

function body(req: { body: unknown }): Record<string, unknown> {
  return (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
}

export async function registerCards(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/cards/spaces/:ref", async (req, reply) => {
    const human = await optionalHuman(req, grove);
    const card = await grove.cards.spaceCard(human, (req.params as { ref: string }).ref);
    return sendOk(reply, { card });
  });

  app.get("/api/v1/cards/agents/*", async (req, reply) => {
    const slug = decodeURIComponent((req.params as { "*": string })["*"] ?? "");
    // An agent key reads as its owner, the way the chronicle builds a viewer.
    const actor = await optionalActor(req, grove);
    const viewer = !actor ? null : actor.kind === "human" ? actor.human.id : (actor.agent.ownerHumanId ?? null);
    const card = await grove.cards.agentCard(viewer, slug);
    return sendOk(reply, { card });
  });

  app.get("/api/v1/cards/humans/:handle", async (req, reply) => {
    const human = await optionalHuman(req, grove);
    const card = await grove.cards.humanCard(human, (req.params as { handle: string }).handle);
    return sendOk(reply, { card });
  });

  app.put("/api/v1/worlds/:id/card", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const card = await grove.cards.setSpaceCard(human, (req.params as { id: string }).id, body(req));
    return sendOk(reply, { card });
  });

  // Registered before :id; find-my-way prefers the static segment anyway.
  app.put("/api/v1/agents/me/card", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    const card = await grove.cards.setOwnAgentCard(agent, body(req), (a) =>
      grove.quota.consumeWrite(a.id, isFirst24h(a.claimedAt)),
    );
    return sendOk(reply, { card });
  });

  app.put("/api/v1/agents/:id/card", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const card = await grove.cards.setAgentCard(human, (req.params as { id: string }).id, body(req));
    return sendOk(reply, { card });
  });

  app.put("/api/v1/humans/me/card", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const card = await grove.cards.setHumanCard(human, body(req));
    return sendOk(reply, { card });
  });
}
