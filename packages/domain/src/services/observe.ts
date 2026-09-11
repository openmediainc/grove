import type { Agent, Observation, ObservationPacket, PendingObservation } from "@grove/protocol";
import { authorize } from "@grove/policy";
import { badges } from "@grove/policy";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import type { PresenceService } from "./presence.js";
import type { SpeechService } from "./speech.js";
import type { IdentityService } from "./identity.js";
import type { MailboxService } from "./mailbox.js";
import type { CampusService } from "./campus.js";
import { WORLD_ID } from "@grove/protocol";

export class ObserveService {
  constructor(
    private store: GroveStore,
    private presence: PresenceService,
    private speech: SpeechService,
    private identity: IdentityService,
    private mailbox?: MailboxService,
    private campus?: CampusService,
  ) {}

  async observe(agent: Agent): Promise<Observation> {
    if (agent.claimState === "pending") {
      const ttl = agent.expiresAt ? Math.max(0, Math.floor((Date.parse(agent.expiresAt) - Date.now()) / 1000)) : 0;
      const pending: PendingObservation = {
        generatedAt: new Date().toISOString(),
        kind: "pending",
        claimState: "pending",
        agentId: agent.id,
        slug: agent.slug,
        claimUrl: `${this.store.config.publicUrl}/claim/${agent.id}`,
        ttlSeconds: ttl,
      };
      return pending;
    }
    if (agent.claimState === "suspended") {
      throw new GroveError("UNCLAIMED", "Agent is suspended.");
    }
    const p = await this.presence.getPresence(agent.id);
    if (!p) {
      throw new GroveError("NOT_FOUND", "Join the world first (POST /world/join).", { httpStatus: 404 });
    }
    const room = await this.presence.getRoom(p.roomId);
    if (!room) throw new GroveError("NOT_FOUND", "Room missing.");
    const nearby = await this.presence.nearby(room.id, agent.id);
    const { rows: heardRows } = await this.store.pg.query(
      `SELECT s.* FROM speech s
       JOIN speech_deliveries d ON d.speech_id = s.id
       WHERE d.recipient_id = $1 AND d.status = 'delivered' AND s.channel = 'room_say'
         AND s.created_at > now() - interval '10 minutes'
       ORDER BY s.created_at DESC
       LIMIT 20`,
      [agent.id],
    );
    const heard: ObservationPacket["heard"] = [];
    for (const row of heardRows.reverse()) {
      heard.push({
        speechId: row.id as string,
        senderId: row.sender_id as string,
        senderKind: row.sender_kind as "human" | "agent",
        channel: "room_say",
        body: row.body as string,
        untrusted: true,
        createdAt: new Date(row.created_at as string).toISOString(),
      });
    }
    const { rows: ins } = await this.store.pg.query(
      `SELECT * FROM instructions WHERE agent_id = $1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at`,
      [agent.id],
    );
    const pendingInstructions = ins
      .filter((r) => r.kind === "one_shot" && !r.acked_at)
      .map(mapIns);
    const standingOrders = ins.filter((r) => r.kind === "standing").map(mapIns);

    const selfNearby = nearby.find((n) => n.actorId === agent.id);
    const packet: ObservationPacket = {
      generatedAt: new Date().toISOString(),
      kind: "inhabited",
      self: {
        actorId: agent.id,
        kind: "agent",
        displayName: agent.displayName,
        slug: agent.slug,
        badges: badges({ kind: "agent", claimState: agent.claimState, policy: agent.policy }),
        presence: p,
        ownerHandle: selfNearby?.ownerHandle,
        policy: agent.policy,
        autonomyMode: agent.autonomyMode,
      },
      room: { id: room.id, slug: room.slug, name: room.name, kind: room.kind },
      nearby: nearby
        .filter((n) => n.actorId !== agent.id)
        .map((n) => ({
          actorId: n.actorId,
          kind: n.kind,
          displayName: n.displayName,
          slug: n.slug,
          badges: n.badges,
          presence: n.presence,
          ownerHandle: n.ownerHandle,
        })),
      heard,
      pendingInstructions,
      standingOrders,
      mailboxUnread: this.mailbox ? await this.mailbox.unreadCount(agent.id) : 0,
      cooldowns: { sayMs: 0, moveMs: 0 },
      suggestedActions: suggested(agent, nearby.length, pendingInstructions.length),
    };
    if (this.campus) {
      const briefings = await this.campus.dueBriefings(agent.id, room.worldId ?? WORLD_ID);
      if (briefings.length) packet.briefings = briefings;
    }
    return packet;
  }
}

function mapIns(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    ownerHumanId: String(r.owner_human_id),
    kind: r.kind as "one_shot" | "standing" | "stop",
    body: String(r.body),
    createdAt: new Date(String(r.created_at)).toISOString(),
    expiresAt: r.expires_at ? new Date(String(r.expires_at)).toISOString() : null,
    ackedAt: r.acked_at ? new Date(String(r.acked_at)).toISOString() : null,
  };
}

function suggested(agent: Agent, nearbyCount: number, pending: number) {
  const out: Array<{ tool: string; reason: string }> = [];
  if (pending) out.push({ tool: "look", reason: "You have pending owner instructions." });
  if (agent.autonomyMode === "hang_out" && nearbyCount > 1 && agent.policy.speakToHumans) {
    out.push({ tool: "say", reason: "Someone is here — greet them if it feels right." });
  }
  if (out.length === 0) out.push({ tool: "look", reason: "Take in the room." });
  return out.slice(0, 5);
}

// keep authorize import used for type-side documentation that observe is filtered via deliveries
void authorize;
