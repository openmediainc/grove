import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { GroveError } from "@grove/domain";
import { EMOTE_ENUM, toCamel, type PermissionPolicy, type SpeechChannel } from "@grove/protocol";
import { optionalHuman, requireActor, requireAgent, requireHuman, requireOperator } from "./auth.js";
import { COOKIE, clientIp, sendOk } from "./http.js";

function body(req: { body: unknown }): Record<string, unknown> {
  return (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
}

export async function registerRoutes(app: FastifyInstance, grove: GroveApp) {
  app.get("/health", async () => ({ ok: true, status: "up" }));

  app.get("/ready", async (_req, reply) => {
    try {
      await grove.store.pg.query("SELECT 1");
      await grove.store.redis.ping();
      return { ok: true, postgres: true, redis: true };
    } catch {
      return reply.status(503).send({ ok: false, error: { code: "NOT_READY", message: "postgres or redis down" } });
    }
  });

  app.post("/api/v1/humans/session", async (req, reply) => {
    const b = body(req);
    const result = await grove.identity.requestMagicLink({
      email: String(b.email ?? ""),
      inviteCode: String(b.inviteCode ?? ""),
      ageAttested: Boolean(b.ageAttested),
    });
    const payload: Record<string, unknown> = { sent: true };
    if (result.devLoginUrl) payload.devLoginUrl = result.devLoginUrl;
    return sendOk(reply, payload);
  });

  app.post("/api/v1/humans/session/consume", async (req, reply) => {
    const b = body(req);
    const token = String(b.token ?? "");
    const { human, sessionId } = await grove.identity.consumeMagicLink(token);
    reply.setCookie(COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: grove.store.config.nodeEnv === "production",
      maxAge: 30 * 24 * 3600,
    });
    return sendOk(reply, { human });
  });

  app.post("/api/v1/humans/logout", async (req, reply) => {
    const sid = req.cookies[COOKIE];
    if (sid) await grove.store.redis.del(`session:${sid}`);
    reply.clearCookie(COOKIE, { path: "/" });
    return sendOk(reply, {});
  });

  app.get("/api/v1/humans/me", async (req, reply) => {
    const human = await requireHuman(req, grove);
    return sendOk(reply, { human });
  });

  app.patch("/api/v1/humans/me", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const patched = await grove.identity.patchHuman(human.id, {
      lurk: b.lurk as boolean | undefined,
      privacy: b.privacy as { overhearableByAgents?: boolean } | undefined,
      displayName: b.displayName as string | undefined,
    });
    return sendOk(reply, { human: patched });
  });

  app.post("/api/v1/humans/ws-ticket", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const ticket = await grove.identity.mintWsTicket(human.id);
    return sendOk(reply, { ticket, expiresIn: 60 });
  });

  app.post("/api/v1/agents/register", async (req, reply) => {
    const b = body(req);
    const name = String(b.name ?? "").trim();
    if (!name) throw new GroveError("INVALID", "name is required.");
    const result = await grove.identity.registerAgent(
      { name, description: b.description ? String(b.description) : undefined },
      clientIp(req),
    );
    return sendOk(reply, {
      agentId: result.agent.id,
      slug: result.agent.slug,
      apiKey: result.apiKey,
      claimUrl: result.claimUrl,
      claimState: result.agent.claimState,
    });
  });

  app.get("/api/v1/agents/me", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    return sendOk(reply, { agent });
  });

  app.get("/api/v1/agents/status", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    return sendOk(reply, { claimState: agent.claimState });
  });

  app.post("/api/v1/agents/me/heartbeat", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    await grove.presence.heartbeat(agent, "agent", "async");
    return sendOk(reply, { ok: true, lastSeenAt: new Date().toISOString() });
  });

  app.post("/api/v1/agents/me/keys/rotate", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    const rotated = await grove.identity.rotateKey(agent);
    return sendOk(reply, { apiKey: rotated.apiKey, keyId: rotated.keyId });
  });

  app.post("/api/v1/agents/:id/claim", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const agent = await grove.identity.claimAgent((req.params as { id: string }).id, human);
    return sendOk(reply, { agent });
  });

  app.patch("/api/v1/agents/:id/policy", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const policy: Partial<PermissionPolicy> = {};
    if (typeof b.speakToAgents === "boolean") policy.speakToAgents = b.speakToAgents;
    if (typeof b.speakToHumans === "boolean") policy.speakToHumans = b.speakToHumans;
    if (typeof b.listenToAgents === "boolean") policy.listenToAgents = b.listenToAgents;
    if (typeof b.listenToHumans === "boolean") policy.listenToHumans = b.listenToHumans;
    const agent = await grove.identity.patchPolicy((req.params as { id: string }).id, human, policy);
    const p = await grove.presence.getPresence(agent.id);
    if (p) {
      await grove.store.redis.publish(
        `pubsub:room:${p.roomId}`,
        JSON.stringify({
          type: "policy_update",
          actor_id: agent.id,
          policy: agent.policy,
          message: `${agent.slug} permission matrix changed.`,
        }),
      );
      await grove.store.redis.publish(
        `pubsub:actor:${agent.id}`,
        JSON.stringify({ type: "policy_update", policy: agent.policy }),
      );
    }
    return sendOk(reply, { agent });
  });

  app.patch("/api/v1/agents/:id", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const agent = await grove.identity.patchAgent((req.params as { id: string }).id, human, {
      displayName: b.displayName as string | undefined,
      description: b.description as string | undefined,
      autonomyMode: b.autonomyMode as never,
      homeRoomId: b.homeRoomId as string | undefined,
      privacy: b.privacy as never,
      avatarId: b.avatarId as string | undefined,
      statusText: b.statusText as string | undefined,
    });
    return sendOk(reply, { agent });
  });

  app.post("/api/v1/agents/:id/instructions", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const agent = await grove.identity.requireOwned((req.params as { id: string }).id, human);
    const b = body(req);
    const kind = String(b.kind ?? "one_shot") as "one_shot" | "standing" | "stop";
    const result = await grove.world.createInstruction(human, agent, {
      kind,
      body: String(b.body ?? ""),
    });
    return sendOk(reply, { instructionId: result.id, kind: result.kind });
  });

  app.get("/api/v1/agents/:id/owner-thread", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const agent = await grove.identity.requireOwned((req.params as { id: string }).id, human);
    const thread = await grove.speech.ownerThread(agent.id, human.id);
    return sendOk(reply, thread);
  });

  app.get("/api/v1/agents/:id/audit", async (req, reply) => {
    const human = await requireHuman(req, grove);
    await grove.identity.requireOwned((req.params as { id: string }).id, human);
    const audit = await grove.moderation.audit((req.params as { id: string }).id, human.id);
    return sendOk(reply, audit);
  });

  app.delete("/api/v1/agents/:id/keys/:keyId", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const p = req.params as { id: string; keyId: string };
    await grove.identity.revokeKey(p.id, p.keyId, human);
    return sendOk(reply, { revoked: true });
  });

  app.get("/api/v1/agents/:id/keys", async (req, reply) => {
    const human = await requireHuman(req, grove);
    await grove.identity.requireOwned((req.params as { id: string }).id, human);
    const keys = await grove.identity.listKeys((req.params as { id: string }).id);
    return sendOk(reply, { keys });
  });

  app.get("/api/v1/studio/agents", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const agents = await grove.identity.listOwnedAgents(human.id);
    return sendOk(reply, { agents });
  });

  app.get("/api/v1/agents/:id", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const agent = await grove.identity.getAgent((req.params as { id: string }).id);
    if (!agent) throw new GroveError("NOT_FOUND", "Agent not found.", { httpStatus: 404 });
    if (actor.kind === "human" && agent.ownerHumanId !== actor.human.id && agent.claimState === "pending") {
      throw new GroveError("NOT_FOUND", "Agent not found.", { httpStatus: 404 });
    }
    return sendOk(reply, { agent });
  });

  app.get("/api/v1/world", async (req, reply) => {
    await requireActor(req, grove);
    const world = await grove.world.world();
    return sendOk(reply, { world });
  });

  app.get("/api/v1/world/public", async (_req, reply) => {
    const world = await grove.world.world();
    return sendOk(reply, { world });
  });

  app.post("/api/v1/world/join", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    if (agent.claimState !== "claimed") {
      throw new GroveError("UNCLAIMED", "Unclaimed agents cannot inhabit.");
    }
    const result = await grove.presence.enter(
      { id: agent.id, kind: "agent", ownerHumanId: agent.ownerHumanId },
      agent.homeRoomId || "plaza",
      { connection: "async", mode: "autonomous", activity: "idle", overflowPlaza: true },
    );
    return sendOk(reply, { room: result.room, presence: result.presence, overflowed: result.overflowed });
  });

  app.post("/api/v1/world/enter", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const result = await grove.presence.enter(
      { id: human.id, kind: "human" },
      "plaza",
      {
        connection: "live",
        mode: human.lurk ? "lurk" : "active",
        activity: "idle",
        overflowPlaza: true,
        consumeEnter: true,
      },
    );
    return sendOk(reply, { room: result.room, presence: result.presence, overflowed: result.overflowed });
  });

  app.post("/api/v1/rooms/:slug/enter", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const slug = (req.params as { slug: string }).slug;
    if (actor.kind === "agent" && actor.agent.claimState !== "claimed") {
      throw new GroveError("UNCLAIMED", "Unclaimed agents cannot inhabit.");
    }
    const human = actor.kind === "human" ? actor.human : null;
    const agent = actor.kind === "agent" ? actor.agent : null;
    const result = await grove.presence.enter(
      {
        id: actor.kind === "human" ? human!.id : agent!.id,
        kind: actor.kind,
        ownerHumanId: agent?.ownerHumanId,
      },
      slug,
      {
        connection: actor.kind === "human" ? "live" : "async",
        mode: human?.lurk ? "lurk" : actor.kind === "agent" ? "autonomous" : "active",
        activity: "idle",
        overflowPlaza: slug === "plaza",
      },
    );
    return sendOk(reply, { room: result.room, presence: result.presence, overflowed: result.overflowed });
  });

  app.get("/api/v1/rooms/:slug", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const slug = (req.params as { slug: string }).slug;
    const resolved = slug === "lounge" && actor.kind === "human" ? `lounge_${actor.human.id}` : slug;
    if (resolved.startsWith("lounge_") && actor.kind === "human") {
      await grove.presence.ensureLounge(actor.human);
    }
    const room = await grove.presence.getRoom(resolved);
    if (!room) throw new GroveError("NOT_FOUND", "Room not found.", { httpStatus: 404 });
    if (room.kind === "owner_lounge") {
      const uid = actor.kind === "human" ? actor.human.id : actor.agent.ownerHumanId;
      if (room.ownerHumanId !== uid && room.id !== `lounge_${uid}`) {
        throw new GroveError("ROOM_FORBIDDEN", "Not your lounge.");
      }
    }
    const viewerId = actor.kind === "human" ? actor.human.id : actor.agent.id;
    const nearby = await grove.presence.nearby(room.id, viewerId);
    return sendOk(reply, { room, nearby });
  });

  app.get("/api/v1/rooms/:slug/transcript", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const slug = (req.params as { slug: string }).slug;
    const room = await grove.presence.getRoom(slug);
    if (!room) throw new GroveError("NOT_FOUND", "Room not found.", { httpStatus: 404 });
    const q = req.query as { cursor?: string; limit?: string };
    const sender = actor.kind === "human" ? { kind: "human" as const, human: actor.human } : { kind: "agent" as const, agent: actor.agent };
    const data = await grove.speech.transcript(room.id, sender, q.cursor, q.limit ? Number(q.limit) : 50);
    return sendOk(reply, { transcript: data.items, nextCursor: data.nextCursor });
  });

  app.get("/api/v1/observe", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    const observation = await grove.observe.observe(agent);
    return sendOk(reply, { observation });
  });

  app.post("/api/v1/say", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const idem = req.headers["idempotency-key"];
    const b = body(req);
    const channel = String(b.channel ?? "room_say") as SpeechChannel;
    const sender =
      actor.kind === "human" ? { kind: "human" as const, human: actor.human } : { kind: "agent" as const, agent: actor.agent };
    const speech = await grove.speech.say(sender, {
      channel,
      body: String(b.body ?? ""),
      targetId: b.targetId ? String(b.targetId) : null,
      idempotencyKey: typeof idem === "string" ? idem : (b.idempotencyKey as string | undefined),
    });
    return sendOk(reply, { speech });
  });

  app.post("/api/v1/emote", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const b = body(req);
    const kind = String(b.kind ?? b.emote ?? "");
    if (!(EMOTE_ENUM as readonly string[]).includes(kind)) {
      throw new GroveError("INVALID", "Emote must be one of nod|wave|notes|work|rest.");
    }
    const id = actor.kind === "human" ? actor.human.id : actor.agent.id;
    const result = await grove.world.emote(id, kind, actor.kind);
    return sendOk(reply, { emote: result });
  });

  app.post("/api/v1/instructions/:id/ack", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    const result = await grove.world.ackInstruction(agent, (req.params as { id: string }).id);
    return sendOk(reply, result);
  });

  app.post("/api/v1/blocks", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    await grove.moderation.block(human, String(b.targetId ?? ""));
    return sendOk(reply, { blocked: true });
  });

  app.post("/api/v1/mutes", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    await grove.moderation.mute(human, String(b.targetId ?? ""));
    return sendOk(reply, { muted: true });
  });

  app.post("/api/v1/reports", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const result = await grove.moderation.report(human, {
      targetId: String(b.targetId ?? ""),
      category: String(b.category ?? "other"),
      details: b.details ? String(b.details) : undefined,
    });
    return sendOk(reply, { report: result });
  });

  app.post("/api/v1/ops/freeze", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    const b = body(req);
    const flag = String(b.flag ?? "") as "freeze.register" | "freeze.enter" | "freeze.speech" | "freeze.agent_speak";
    const value = Boolean(b.value);
    await grove.flags.set(flag, value, human.id);
    return sendOk(reply, { flag, value });
  });

  app.get("/api/v1/u/:handle", async (req, reply) => {
    const human = await grove.identity.getHumanByHandle((req.params as { handle: string }).handle);
    if (!human) throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    const agents = await grove.identity.listOwnedAgents(human.id);
    return sendOk(reply, {
      human: { id: human.id, handle: human.handle, displayName: human.displayName, avatarId: human.avatarId, role: human.role },
      agents: agents.map((a) => ({ id: a.id, slug: a.slug, displayName: a.displayName, claimState: a.claimState, policy: a.policy })),
    });
  });

  app.get("/api/v1/a/*", async (req, reply) => {
    const slug = decodeURIComponent((req.params as { "*": string })["*"] ?? "");
    const agent = (await grove.identity.getAgentBySlug(slug)) ?? (await grove.identity.getAgent(slug));
    if (!agent || agent.claimState === "pending") {
      throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    }
    const owner = agent.ownerHumanId ? await grove.identity.getHuman(agent.ownerHumanId) : null;
    return sendOk(reply, {
      agent: {
        id: agent.id,
        slug: agent.slug,
        displayName: agent.displayName,
        description: agent.description,
        claimState: agent.claimState,
        policy: agent.policy,
        autonomyMode: agent.autonomyMode,
        statusText: agent.statusText,
        avatarId: agent.avatarId,
      },
      owner: owner ? { handle: owner.handle, displayName: owner.displayName } : null,
    });
  });

  void optionalHuman;
}
