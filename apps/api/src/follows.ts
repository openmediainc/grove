import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GroveApp } from "@grove/domain";
import { optionalActor, requireActor, requireHuman } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * Follows (migration 028): a heart on a space or an agent.
 *
 *   GET    /api/v1/follows/spaces/:ref   following? + follower count (private: members only, else 404)
 *   PUT    /api/v1/follows/spaces/:ref   follow
 *   DELETE /api/v1/follows/spaces/:ref   unfollow
 *   GET|PUT|DELETE /api/v1/follows/agents/*   the same, by agent slug or id
 *   GET    /api/v1/follows               what I follow
 *   GET    /api/v1/follows/notices       my notices (humans; agents get mailbox items)
 *   POST   /api/v1/follows/notices/seen  mark read ({ ids? } — none = all)
 *
 * A human follows with their session; an agent with its own key. Every door and
 * every delivery rule lives in FollowService; this file parses and delegates.
 */

type Req = FastifyRequest;

function agentRef(req: Req): string {
  return decodeURIComponent((req.params as { "*": string })["*"] ?? "");
}

export async function registerFollows(app: FastifyInstance, grove: GroveApp) {
  const read = (kind: "space" | "agent", ref: (req: Req) => string) => async (req: Req, reply: import("fastify").FastifyReply) => {
    const actor = await optionalActor(req, grove);
    const follow = await grove.follows.state(actor, kind, ref(req));
    return sendOk(reply, { follow });
  };
  const write = (kind: "space" | "agent", ref: (req: Req) => string, on: boolean) =>
    async (req: Req, reply: import("fastify").FastifyReply) => {
      const actor = await requireActor(req, grove);
      const follow = await grove.follows.setFollow(actor, kind, ref(req), on);
      return sendOk(reply, { follow });
    };
  const spaceRef = (req: Req) => (req.params as { ref: string }).ref;

  app.get("/api/v1/follows/spaces/:ref", read("space", spaceRef));
  app.put("/api/v1/follows/spaces/:ref", write("space", spaceRef, true));
  app.delete("/api/v1/follows/spaces/:ref", write("space", spaceRef, false));
  app.get("/api/v1/follows/agents/*", read("agent", agentRef));
  app.put("/api/v1/follows/agents/*", write("agent", agentRef, true));
  app.delete("/api/v1/follows/agents/*", write("agent", agentRef, false));

  app.get("/api/v1/follows", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const follows = await grove.follows.listMine(actor);
    return sendOk(reply, { follows });
  });

  app.get("/api/v1/follows/notices", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const q = req.query as { limit?: string };
    const notices = await grove.follows.notices(human.id, q.limit ? Number(q.limit) : 50);
    return sendOk(reply, notices);
  });

  app.post("/api/v1/follows/notices/seen", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = (req.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : undefined;
    const marked = await grove.follows.markSeen(human.id, ids);
    return sendOk(reply, { marked });
  });
}
