import type { Agent, Human, Presence, PresenceActivity, PresenceMode, Room } from "@grove/protocol";
import { badges } from "@grove/policy";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { mapPresence, mapRoom } from "../mappers.js";
import { withTx } from "../db.js";
import type { FlagService } from "./flags.js";
import type { QuotaService } from "./quota.js";
import type { IdentityService } from "./identity.js";

export interface NearbyRow {
  actorId: string;
  kind: "human" | "agent";
  displayName: string;
  slug: string;
  badges: ReturnType<typeof badges>;
  presence: Presence;
  ownerHandle?: string;
  avatarId: string;
  policy?: Agent["policy"];
  lurk?: boolean;
  claimState?: Agent["claimState"];
}

export class PresenceService {
  constructor(
    private store: GroveStore,
    private flags: FlagService,
    private quota: QuotaService,
    private identity: IdentityService,
  ) {}

  async getRoom(slug: string): Promise<Room | null> {
    const { rows } = await this.store.pg.query("SELECT * FROM rooms WHERE slug = $1 OR id = $1", [slug]);
    return rows[0] ? mapRoom(rows[0] as Record<string, unknown>) : null;
  }

  async listPublicRooms(): Promise<Array<Room & { occupancy: number }>> {
    const { rows } = await this.store.pg.query(
      `SELECT r.*, count(p.actor_id)::int AS occupancy
       FROM rooms r
       LEFT JOIN presence p ON p.room_id = r.id
       WHERE r.kind <> 'owner_lounge'
       GROUP BY r.id
       ORDER BY CASE r.id
         WHEN 'plaza' THEN 0 WHEN 'library' THEN 1 WHEN 'workshop' THEN 2
         WHEN 'stage' THEN 3 WHEN 'garden' THEN 4 WHEN 'board' THEN 5 ELSE 9 END`,
    );
    return rows.map((r) => ({
      ...mapRoom(r as Record<string, unknown>),
      occupancy: Number((r as { occupancy: number }).occupancy),
    }));
  }

  async getPresence(actorId: string): Promise<Presence | null> {
    const { rows } = await this.store.pg.query("SELECT * FROM presence WHERE actor_id = $1", [actorId]);
    return rows[0] ? mapPresence(rows[0] as Record<string, unknown>) : null;
  }

  async ensureLounge(human: Human): Promise<Room> {
    const id = `lounge_${human.id}`;
    const existing = await this.getRoom(id);
    if (existing) return existing;
    await this.store.pg.query(
      `INSERT INTO rooms (id, slug, name, kind, capacity, allows_room_say, allows_whisper, spectator_visible, owner_human_id)
       VALUES ($1,$2,$3,'owner_lounge',8,TRUE,TRUE,FALSE,$4)
       ON CONFLICT (id) DO NOTHING`,
      [id, id, `${human.handle}'s lounge`, human.id],
    );
    const room = await this.getRoom(id);
    if (!room) throw new GroveError("NOT_FOUND", "Lounge could not be provisioned.");
    return room;
  }

  async enter(
    actor: { id: string; kind: "human" | "agent"; ownerHumanId?: string | null },
    slug: string,
    opts: {
      connection: Presence["connection"];
      mode: PresenceMode;
      activity: PresenceActivity;
      overflowPlaza?: boolean;
      consumeEnter?: boolean;
    },
  ): Promise<{ room: Room; presence: Presence; overflowed: boolean }> {
    await this.flags.assertNotFrozen("freeze.enter", "Entering the campus is frozen.");
    if (opts.consumeEnter && actor.kind === "human") await this.quota.consumeEnter(actor.id);
    else await this.quota.consumeMove(actor.id);

    let targetSlug = slug === "lounge" && actor.kind === "human" ? `lounge_${actor.id}` : slug;
    if (slug === "lounge" && actor.kind === "agent" && actor.ownerHumanId) {
      targetSlug = `lounge_${actor.ownerHumanId}`;
    }
    if (targetSlug.startsWith("lounge_") && actor.kind === "human") {
      const human = await this.identity.getHuman(actor.id);
      if (human) await this.ensureLounge(human);
    }
    if (targetSlug.startsWith("lounge_") && actor.kind === "agent") {
      if (!actor.ownerHumanId || targetSlug !== `lounge_${actor.ownerHumanId}`) {
        throw new GroveError("ROOM_FORBIDDEN", "Agents may only enter their owner's lounge.");
      }
    }

    let room = await this.getRoom(targetSlug);
    if (!room) throw new GroveError("NOT_FOUND", "Room not found.", { httpStatus: 404 });

    let overflowed = false;
    const occupying = await this.getPresence(actor.id);
    if (occupying?.roomId === room.id) {
      const updated = await this.touch(actor.id, opts);
      return { room, presence: updated, overflowed };
    }

    const tryEnter = async (r: Room) => this.assignSeat(actor, r, opts);

    try {
      const presence = await tryEnter(room);
      await this.publishJoin(actor, room, presence);
      return { room, presence, overflowed };
    } catch (err) {
      if (err instanceof GroveError && err.code === "ROOM_FULL" && opts.overflowPlaza && room.id === "plaza") {
        const garden = await this.getRoom("garden");
        if (garden) {
          try {
            const presence = await tryEnter(garden);
            overflowed = true;
            await this.publishJoin(actor, garden, presence);
            return { room: garden, presence, overflowed };
          } catch (err2) {
            if (err2 instanceof GroveError && err2.code === "ROOM_FULL") {
              throw new GroveError("ROOM_FULL", "Plaza and Garden are full.", { suggestedRoom: "board" });
            }
            throw err2;
          }
        }
      }
      if (err instanceof GroveError && err.code === "ROOM_FULL") {
        throw new GroveError("ROOM_FULL", `${room.name} is full.`, { suggestedRoom: room.id === "plaza" ? "garden" : "board" });
      }
      throw err;
    }
  }

  private async assignSeat(
    actor: { id: string; kind: "human" | "agent" },
    room: Room,
    opts: { connection: Presence["connection"]; mode: PresenceMode; activity: PresenceActivity },
  ): Promise<Presence> {
    try {
      return await withTx(this.store.pg, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [room.id]);
        await c.query("SELECT * FROM rooms WHERE id = $1 FOR UPDATE", [room.id]);
        await c.query("DELETE FROM presence WHERE actor_id = $1", [actor.id]);
        const { rows: taken } = await c.query<{ seat_index: number }>(
          "SELECT seat_index FROM presence WHERE room_id = $1 ORDER BY seat_index",
          [room.id],
        );
        const used = new Set(taken.map((t) => t.seat_index));
        let seat = -1;
        for (let i = 0; i < room.capacity; i++) {
          if (!used.has(i)) {
            seat = i;
            break;
          }
        }
        if (seat < 0) {
          throw new GroveError("ROOM_FULL", "Room is full.", { suggestedRoom: "garden" });
        }
        const { rows } = await c.query(
          `INSERT INTO presence (actor_id, actor_kind, room_id, seat_index, connection, mode, activity, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now())
           RETURNING *`,
          [actor.id, actor.kind, room.id, seat, opts.connection, opts.mode, opts.activity],
        );
        return mapPresence(rows[0] as Record<string, unknown>);
      });
    } catch (err) {
      if (err instanceof GroveError) throw err;
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        throw new GroveError("SEAT_TAKEN", "Seat race; retry.");
      }
      throw err;
    }
  }

  async leave(actorId: string): Promise<void> {
    const prev = await this.getPresence(actorId);
    await this.store.pg.query("DELETE FROM presence WHERE actor_id = $1", [actorId]);
    if (prev) {
      await this.store.redis.publish(
        `pubsub:room:${prev.roomId}`,
        JSON.stringify({ type: "actor_leave", actor_id: actorId, room_id: prev.roomId }),
      );
      if (prev.roomId === "plaza") {
        await this.store.redis.publish(
          "sse:plaza",
          JSON.stringify({ type: "actor_leave", actor_id: actorId, room_id: "plaza" }),
        );
      }
    }
  }

  async touch(
    actorId: string,
    patch?: Partial<{ connection: Presence["connection"]; mode: PresenceMode; activity: PresenceActivity }>,
  ): Promise<Presence> {
    const { rows } = await this.store.pg.query(
      `UPDATE presence SET
         last_seen_at = now(),
         connection = COALESCE($2, connection),
         mode = COALESCE($3, mode),
         activity = COALESCE($4, activity)
       WHERE actor_id = $1 RETURNING *`,
      [actorId, patch?.connection ?? null, patch?.mode ?? null, patch?.activity ?? null],
    );
    if (!rows[0]) throw new GroveError("NOT_FOUND", "Not in a room.", { httpStatus: 404 });
    await this.store.pg.query("UPDATE agents SET last_seen_at = now() WHERE id = $1", [actorId]);
    return mapPresence(rows[0] as Record<string, unknown>);
  }

  async heartbeat(actor: Agent | Human, kind: "human" | "agent", connection: Presence["connection"]): Promise<void> {
    if (kind === "agent") {
      const agent = actor as Agent;
      if (agent.claimState !== "claimed") {
        await this.identity.heartbeatUnclaimed(agent);
        return;
      }
    }
    const p = await this.getPresence(actor.id);
    if (p) await this.touch(actor.id, { connection });
    else if (kind === "agent") {
      await this.store.pg.query("UPDATE agents SET last_seen_at = now() WHERE id = $1", [actor.id]);
    }
  }

  async evictStale(): Promise<void> {
    await this.store.pg.query(
      `UPDATE presence SET connection = 'offline'
       WHERE connection = 'live' AND last_seen_at < now() - interval '5 minutes'`,
    );
    await this.store.pg.query(
      `UPDATE presence SET connection = 'offline'
       WHERE connection = 'async' AND last_seen_at < now() - interval '10 minutes'`,
    );
  }

  async nearby(roomId: string, viewerId?: string): Promise<NearbyRow[]> {
    const { rows } = await this.store.pg.query(
      `SELECT p.*,
              CASE WHEN p.actor_kind = 'human' THEN h.display_name ELSE a.display_name END AS display_name,
              CASE WHEN p.actor_kind = 'human' THEN h.handle ELSE a.slug END AS slug,
              CASE WHEN p.actor_kind = 'human' THEN h.avatar_id ELSE a.avatar_id END AS avatar_id,
              CASE WHEN p.actor_kind = 'human' THEN h.lurk ELSE false END AS lurk,
              a.policy, a.claim_state, a.owner_human_id, oh.handle AS owner_handle
       FROM presence p
       LEFT JOIN humans h ON h.id = p.actor_id
       LEFT JOIN agents a ON a.id = p.actor_id
       LEFT JOIN humans oh ON oh.id = a.owner_human_id
       WHERE p.room_id = $1
       ORDER BY p.seat_index`,
      [roomId],
    );
    const blocked = new Set<string>();
    if (viewerId) {
      const b = await this.store.pg.query(
        `SELECT blocked_id AS id FROM blocks WHERE blocker_id = $1
         UNION SELECT blocker_id FROM blocks WHERE blocked_id = $1`,
        [viewerId],
      );
      for (const r of b.rows) blocked.add(r.id as string);
    }
    const out: NearbyRow[] = [];
    for (const r of rows) {
      const actorId = r.actor_id as string;
      if (blocked.has(actorId)) continue;
      const kind = r.actor_kind as "human" | "agent";
      const policy = kind === "agent" ? (toPolicy(r.policy) ?? undefined) : undefined;
      out.push({
        actorId,
        kind,
        displayName: String(r.display_name),
        slug: String(r.slug),
        avatarId: String(r.avatar_id),
        badges: badges({
          kind,
          claimState: (r.claim_state as Agent["claimState"]) ?? undefined,
          lurk: Boolean(r.lurk),
          policy,
        }),
        presence: mapPresence(r as Record<string, unknown>),
        ownerHandle: r.owner_handle ? String(r.owner_handle) : undefined,
        policy,
        lurk: Boolean(r.lurk),
        claimState: (r.claim_state as Agent["claimState"]) ?? undefined,
      });
    }
    return out;
  }

  private async publishJoin(
    actor: { id: string; kind: "human" | "agent" },
    room: Room,
    presence: Presence,
  ): Promise<void> {
    await this.identity.audit("actor_joined_room", actor.id, { room: room.id, seat: presence.seatIndex });
    const payload = JSON.stringify({
      type: "actor_join",
      actor_id: actor.id,
      kind: actor.kind,
      room_id: room.id,
      presence,
    });
    await this.store.redis.publish(`pubsub:room:${room.id}`, payload);
    if (room.id === "plaza") await this.store.redis.publish("sse:plaza", payload);
  }
}

function toPolicy(raw: unknown): Agent["policy"] | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    speakToAgents: Boolean(o.speak_to_agents ?? o.speakToAgents),
    speakToHumans: Boolean(o.speak_to_humans ?? o.speakToHumans),
    listenToAgents: Boolean(o.listen_to_agents ?? o.listenToAgents),
    listenToHumans: Boolean(o.listen_to_humans ?? o.listenToHumans),
  };
}
