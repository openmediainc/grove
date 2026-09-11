import type { FastifyInstance, FastifyReply } from "fastify";
import type { GroveApp } from "@grove/domain";
import { GroveError } from "@grove/domain";
import { WORLD_ID, toCamel } from "@grove/protocol";
import { currentWorldId, requireActor, requireHuman, requireOperator } from "./auth.js";
import { WORLD_COOKIE, sendOk } from "./http.js";

function body(req: { body: unknown }): Record<string, unknown> {
  return (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
}

function setWorldCookie(reply: FastifyReply, grove: GroveApp, worldId: string) {
  reply.setCookie(WORLD_COOKIE, worldId, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    secure: grove.store.config.nodeEnv === "production",
    maxAge: 30 * 24 * 3600,
  });
}

export async function registerPlatform(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/worlds", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const worlds = await grove.campus.listForHuman(human.id);
    return sendOk(reply, { worlds });
  });

  app.post("/api/v1/worlds", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const world = await grove.campus.createWorld(human, {
      name: String(b.name ?? ""),
      slug: String(b.slug ?? ""),
    });
    return sendOk(reply, { world }, 201);
  });

  app.post("/api/v1/worlds/:id/enter", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const id = (req.params as { id: string }).id;
    const world = await grove.campus.requireWorld(id);
    await grove.campus.addMember(world.id, human.id);
    setWorldCookie(reply, grove, world.id);
    const result = await grove.presence.enter(
      { id: human.id, kind: "human" },
      "plaza",
      {
        connection: "live",
        mode: human.lurk ? "lurk" : "active",
        activity: "idle",
        overflowPlaza: true,
        worldId: world.id,
      },
    );
    return sendOk(reply, { world, room: result.room, presence: result.presence, overflowed: result.overflowed });
  });

  app.get("/api/v1/stage/events", async (req, reply) => {
    await requireActor(req, grove);
    const worldId = currentWorldId(req);
    const events = await grove.campus.listEvents(worldId);
    return sendOk(reply, { events });
  });

  app.post("/api/v1/stage/events", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const event = await grove.campus.createEvent(human, {
      worldId: b.worldId ? String(b.worldId) : currentWorldId(req),
      roomId: b.roomId ? String(b.roomId) : undefined,
      title: String(b.title ?? ""),
      startsAt: String(b.startsAt ?? b.starts_at ?? ""),
      endsAt: b.endsAt ? String(b.endsAt) : null,
    });
    return sendOk(reply, { event });
  });

  app.post("/api/v1/roles", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const role = await grove.campus.assignRole(human, {
      worldId: b.worldId ? String(b.worldId) : currentWorldId(req),
      key: String(b.key ?? ""),
      label: String(b.label ?? b.key ?? ""),
      prompt: String(b.prompt ?? ""),
      cadenceMinutes: b.cadenceMinutes != null ? Number(b.cadenceMinutes) : undefined,
      holderAgentId: String(b.holderAgentId ?? ""),
    });
    return sendOk(reply, { role });
  });

  app.post("/api/v1/webhooks", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const webhook = await grove.webhooks.create(human.id, String(b.url ?? ""));
    return sendOk(reply, { webhook });
  });

  app.get("/api/v1/webhooks", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const webhooks = await grove.webhooks.list(human.id);
    return sendOk(reply, { webhooks });
  });

  app.patch("/api/v1/webhooks/:id", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const webhook = await grove.webhooks.patch(human.id, (req.params as { id: string }).id, {
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
      url: b.url ? String(b.url) : undefined,
    });
    return sendOk(reply, { webhook });
  });

  app.patch("/api/v1/agents/:id/hosted-brain", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const brain = await grove.brains.upsert((req.params as { id: string }).id, human.id, {
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
      tokenBudgetMonth: b.tokenBudgetMonth != null ? Number(b.tokenBudgetMonth) : undefined,
      model: b.model ? String(b.model) : undefined,
    });
    return sendOk(reply, { hostedBrain: brain });
  });

  app.get("/api/v1/agents/:id/hosted-brain", async (req, reply) => {
    const human = await requireHuman(req, grove);
    await grove.identity.requireOwned((req.params as { id: string }).id, human);
    const brain = await grove.brains.get((req.params as { id: string }).id);
    return sendOk(reply, { hostedBrain: brain });
  });

  void requireOperator;
  void WORLD_ID;
}
