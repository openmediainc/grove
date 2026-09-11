import { EMOTE_ENUM, type Agent, type EmoteKind, type Human } from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import type { PresenceService } from "./presence.js";
import type { IdentityService } from "./identity.js";
import type { FlagService } from "./flags.js";
import type { MailboxService } from "./mailbox.js";
import { WORLD_ID, WORLD_PUBLIC_NAME } from "@grove/protocol";

export class WorldService {
  constructor(
    private store: GroveStore,
    private presence: PresenceService,
    private identity: IdentityService,
    private flags: FlagService,
    private mailbox?: MailboxService,
  ) {}

  async world() {
    const rooms = await this.presence.listPublicRooms();
    const flags = await this.flags.getAll();
    return {
      id: WORLD_ID,
      name: WORLD_PUBLIC_NAME,
      codeName: "Aetheria",
      rooms,
      flags,
    };
  }

  async emote(actorId: string, kind: string, actorKind: "human" | "agent") {
    await this.flags.assertNotFrozen("freeze.speech", "Emotes are frozen with public speech.");
    if (!(EMOTE_ENUM as readonly string[]).includes(kind)) {
      throw new GroveError("INVALID", "Emote must be one of nod|wave|notes|work|rest.");
    }
    const p = await this.presence.getPresence(actorId);
    if (!p) throw new GroveError("NOT_FOUND", "Join a room first.", { httpStatus: 404 });
    const activity =
      kind === "work" ? "working" : kind === "notes" ? "reading" : kind === "rest" ? "idle" : "chatting";
    await this.presence.touch(actorId, { activity });
    const frame = {
      type: "emote",
      actor_id: actorId,
      kind: actorKind,
      emote: kind as EmoteKind,
      room_id: p.roomId,
    };
    await this.store.redis.publish(`pubsub:room:${p.roomId}`, JSON.stringify(frame));
    if (p.roomId === "plaza") await this.store.redis.publish("sse:plaza", JSON.stringify(frame));
    return frame;
  }

  async createInstruction(
    owner: Human,
    agent: Agent,
    input: { kind: "one_shot" | "standing" | "stop"; body: string },
  ) {
    if (agent.ownerHumanId !== owner.id) throw new GroveError("NOT_FOUND", "Agent not found.", { httpStatus: 404 });
    const id = newId("instruction");
    const expires = input.kind === "one_shot" ? new Date(Date.now() + 24 * 3600 * 1000) : null;
    await this.store.pg.query(
      `INSERT INTO instructions (id, agent_id, owner_human_id, kind, body, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, agent.id, owner.id, input.kind, input.body, expires?.toISOString() ?? null],
    );
    if (input.kind === "stop") {
      await this.store.pg.query(
        `UPDATE instructions SET acked_at = now() WHERE agent_id = $1 AND kind = 'one_shot' AND acked_at IS NULL`,
        [agent.id],
      );
    }
    await this.identity.audit("instruction", owner.id, { instructionId: id, agentId: agent.id, kind: input.kind });
    await this.store.redis.publish(
      `pubsub:actor:${agent.id}`,
      JSON.stringify({ type: "instruction", id, kind: input.kind, body: input.body }),
    );
    await this.mailbox?.enqueueIfOffline(agent.id, "owner_instruction", {
      instructionId: id,
      kind: input.kind,
      body: input.body,
      ownerHumanId: owner.id,
    });
    return { id, kind: input.kind };
  }

  async ackInstruction(agent: Agent, instructionId: string) {
    const { rows } = await this.store.pg.query(
      `UPDATE instructions SET acked_at = now() WHERE id = $1 AND agent_id = $2 RETURNING *`,
      [instructionId, agent.id],
    );
    if (!rows[0]) throw new GroveError("NOT_FOUND", "Instruction not found.", { httpStatus: 404 });
    return { id: instructionId, acked: true };
  }

  async plazaSnapshot() {
    const room = await this.presence.getRoom("plaza");
    const nearby = await this.presence.nearby("plaza");
    return {
      room,
      nearby: nearby.map((n) => ({
        actorId: n.actorId,
        kind: n.kind,
        displayName: n.displayName,
        slug: n.slug,
        badges: n.badges,
        presence: n.presence,
        ownerHandle: n.ownerHandle,
        avatarId: n.avatarId,
      })),
    };
  }
}
