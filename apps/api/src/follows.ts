import type { FastifyInstance, FastifyRequest } from "fastify";
import { GroveError, type GroveApp } from "@grove/domain";
import { optionalActor, requireHuman } from "./auth.js";
import { asGuest, currentGuest } from "./guests.js";
import { sendOk } from "./http.js";
import { countAction } from "./analytics.js";

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
 * A human follows with their session; an agent with its own key; a signed-out
 * browser with a guest pass (guests.ts), public subjects only, no notices. Every door and
 * every delivery rule lives in FollowService; this file parses and delegates.
 */

type Req = FastifyRequest;

function agentRef(req: Req): string {
  return decodeURIComponent((req.params as { "*": string })["*"] ?? "");
}

export async function registerFollows(app: FastifyInstance, grove: GroveApp) {
  const read = (kind: "space" | "agent", ref: (req: Req) => string) => async (req: Req, reply: import("fastify").FastifyReply) => {
    const actor = await optionalActor(req, grove);
    const guest = actor ? null : await currentGuest(req, grove);
    const follow = await grove.follows.state(actor ?? (guest ? { kind: "guest", guest } : null), kind, ref(req));
    return sendOk(reply, { follow });
  };
  const write = (kind: "space" | "agent", ref: (req: Req) => string, on: boolean) =>
    async (req: Req, reply: import("fastify").FastifyReply) => {
      const actor = await optionalActor(req, grove);
      if (!actor) {
        // Signed out: as this browser's guest pass, issued only by a follow (not an unfollow).
        const follow = await asGuest(req, reply, grove, { issue: on }, (guest) =>
          grove.follows.setFollow({ kind: "guest", guest }, kind, ref(req), on),
        );
        return sendOk(reply, { follow, asGuest: true });
      }
      const follow = await grove.follows.setFollow(actor, kind, ref(req), on, {
        onNew: () => countAction(req, grove, "follow", actor.kind === "human" ? actor.human.id : null),
      });
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
    const actor = await optionalActor(req, grove);
    const guest = actor ? null : await currentGuest(req, grove);
    if (!actor && !guest) throw new GroveError("UNAUTHORIZED", "Authentication required.", { httpStatus: 401 });
    const follows = await grove.follows.listMine(actor ?? { kind: "guest", guest: guest! });
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
