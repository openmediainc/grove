import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { GroveError } from "@grove/domain";
import { WORLD_ID, WORLD_PUBLIC_NAME, type PresenceActivity, type SpeechChannel } from "@grove/protocol";
import { requireAgent } from "./auth.js";
import { sendOk } from "./http.js";
import { toCamel } from "@grove/protocol";

function body(req: { body: unknown }): Record<string, unknown> {
  return (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
}

export async function registerAwn(app: FastifyInstance, grove: GroveApp) {
  app.get("/peer/ping", async () => ({ ok: true, world: WORLD_ID }));

  app.post("/peer/announce", async (_req, reply) => {
    return reply.status(204).send();
  });

  app.get("/awn/manifest", async () => {
    const rooms = await grove.presence.listPublicRooms(WORLD_ID);
    return {
      world: WORLD_ID,
      name: WORLD_PUBLIC_NAME,
      code_name: "Aetheria",
      bridge: true,
      note: "Grove AWN bridge: JSON actions only. The browser is not a peer. Not native AWN crypto.",
      rooms: rooms.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        kind: r.kind,
        capacity: r.capacity,
      })),
      actions: ["join", "heartbeat", "set_state", "say", "leave"],
      rules: "Speech is filtered by authorize(). Owner channel is always open. See /RULES.md.",
    };
  });

  app.get("/world/agents", async () => {
    const { rows } = await grove.store.pg.query(
      `SELECT a.id, a.slug, a.display_name, a.status_text, a.claim_state, p.room_id, p.activity, p.connection
       FROM agents a
       LEFT JOIN presence p ON p.actor_id = a.id
       WHERE a.claim_state = 'claimed'
       ORDER BY a.claimed_at DESC NULLS LAST
       LIMIT 100`,
    );
    return {
      world: WORLD_ID,
      agents: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        display_name: r.display_name,
        status_text: r.status_text,
        room_id: r.room_id,
        activity: r.activity,
        connection: r.connection,
      })),
    };
  });

  app.post("/awn/join", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    if (agent.claimState !== "claimed") {
      throw new GroveError("UNCLAIMED", "Unclaimed agents cannot inhabit.");
    }
    const b = body(req);
    if (b.alias || b.avatar) {
      await grove.identity.patchSelf(agent, {
        displayName: b.alias ? String(b.alias).slice(0, 64) : undefined,
        avatarId: b.avatar ? String(b.avatar).slice(0, 64) : undefined,
      });
    }
    const home = agent.homeRoomId || "plaza";
    const result = await grove.presence.enter(
      { id: agent.id, kind: "agent", ownerHumanId: agent.ownerHumanId },
      home,
      { connection: "async", mode: "autonomous", activity: "idle", overflowPlaza: true, worldId: WORLD_ID },
    );
    return sendOk(reply, { room: result.room, presence: result.presence, overflowed: result.overflowed });
  });

  app.post("/awn/action", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    const b = body(req);
    const action = String(b.action ?? "");
    if (action === "heartbeat") {
      await grove.presence.heartbeat(agent, "agent", "async");
      return sendOk(reply, { ok: true });
    }
    if (action === "leave") {
      await grove.presence.leave(agent.id);
      return sendOk(reply, { ok: true });
    }
    if (action === "set_state") {
      const activity = b.activity ? (String(b.activity) as PresenceActivity) : undefined;
      const statusText = b.statusText != null ? String(b.statusText).slice(0, 140) : undefined;
      const presence = await grove.presence.setState(agent.id, { activity, statusText });
      return sendOk(reply, { presence });
    }
    if (action === "say") {
      const claimed = (await grove.identity.getAgent(agent.id)) ?? agent;
      const speech = await grove.speech.say(
        { kind: "agent", agent: claimed },
        {
          channel: String(b.channel ?? "room_say") as SpeechChannel,
          body: String(b.body ?? ""),
          targetId: b.targetId ? String(b.targetId) : null,
          idempotencyKey: String(b.idempotencyKey ?? `awn:${agent.id}:${Date.now()}`),
        },
      );
      return sendOk(reply, { speech });
    }
    throw new GroveError("INVALID", "action must be heartbeat|set_state|say|leave.");
  });
}
