import {
  OWNER_CHANNELS,
  SPEECH_GRAPHEME_LIMIT,
  computeIsOwnerChannel,
  graphemeCount,
  type ActorKind,
  type Agent,
  type Human,
  type PermissionPolicy,
  type PolicyContext,
  type PrivacyPolicy,
  type QuotaSnapshot,
  type Room,
  type SayAck,
  type SpeechChannel,
} from "@grove/protocol";
import { authorize } from "@grove/policy";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import { mapAgent, mapHuman, mapRoom } from "../mappers.js";
import { flagPromptInjection } from "../crypto.js";
import type { FlagService } from "./flags.js";
import { isFirst24h, type QuotaService } from "./quota.js";
import type { PresenceService } from "./presence.js";
import type { MailboxService } from "./mailbox.js";

export const SPECTATOR_RECIPIENT: PolicyContext["recipients"][number] = {
  id: "hum_spectator",
  kind: "human",
  lurk: true,
  blocked: false,
  mutedByRecipient: false,
  synthetic: "spectator",
};

export function assertValidOwnerChannelFlag(ctx: PolicyContext): void {
  if (!ctx.isOwnerChannel) return;
  if (!OWNER_CHANNELS.includes(ctx.channel)) {
    throw new GroveError("INVALID", "isOwnerChannel is only valid on owner channels.");
  }
  if (ctx.recipients.length !== 1) {
    throw new GroveError("RECIPIENTS_INVALID", "Owner channel requires exactly one recipient.");
  }
  if (!computeIsOwnerChannel(ctx.sender, ctx.recipients[0]!)) {
    throw new GroveError("NOT_FOUND", "Owner channel identities do not match.");
  }
}

export function spectatorMayHear(sender: PolicyContext["sender"], room: PolicyContext["room"], quota: QuotaSnapshot): boolean {
  const result = authorize({
    sender,
    recipients: [SPECTATOR_RECIPIENT],
    channel: "room_say",
    room,
    quota,
    isOwnerChannel: false,
  });
  return Boolean(result.emit.allow && result.deliveries[0]?.decision.allow);
}

type SenderActor =
  | { kind: "human"; human: Human }
  | { kind: "agent"; agent: Agent };

export class SpeechService {
  constructor(
    private store: GroveStore,
    private flags: FlagService,
    private quota: QuotaService,
    private presence: PresenceService,
    private mailbox?: MailboxService,
  ) {}

  async say(
    sender: SenderActor,
    input: { channel: SpeechChannel; body: string; targetId?: string | null; idempotencyKey?: string | null },
  ): Promise<SayAck> {
    if (!input.idempotencyKey) {
      throw new GroveError("IDEMPOTENCY_REQUIRED", "Header Idempotency-Key is required.");
    }
    if (sender.kind === "agent" && sender.agent.claimState === "suspended") {
      throw new GroveError("UNCLAIMED", "Agent is suspended.");
    }
    const count = graphemeCount(input.body);
    if (count > SPEECH_GRAPHEME_LIMIT) {
      throw new GroveError("BODY_TOO_LONG", "Speech body must be ≤ 1000 graphemes.");
    }
    if (input.channel === "room_say" || input.channel === "whisper") {
      await this.flags.assertNotFrozen("freeze.speech", "Public speech is frozen.");
    }
    if (sender.kind === "agent" && input.channel === "room_say") {
      await this.flags.assertNotFrozen("freeze.agent_speak", "Agent public speech is frozen.");
    }

    const senderId = sender.kind === "human" ? sender.human.id : sender.agent.id;
    const existing = await this.store.pg.query(
      `SELECT id, channel FROM speech WHERE sender_id = $1 AND idempotency_key = $2`,
      [senderId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const speechId = existing.rows[0].id as string;
      const { rows: dels } = await this.store.pg.query(
        `SELECT recipient_id, status, filter_code FROM speech_deliveries WHERE speech_id = $1`,
        [speechId],
      );
      return {
        id: speechId,
        channel: existing.rows[0].channel as SpeechChannel,
        deliveredCount: dels.filter((d) => d.status === "delivered").length,
        undelivered: dels
          .filter((d) => d.status === "filtered")
          .map((d) => ({
            actorId: d.recipient_id as string,
            code: (d.filter_code as SayAck["undelivered"][number]["code"]) ?? "PERMISSION_DENIED",
          })),
      };
    }

    if (flagPromptInjection(input.body)) {
      await this.store.pg.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ('prompt_injection_flag', $1, $2)`, [
        senderId,
        JSON.stringify({ channel: input.channel }),
      ]);
    }

    const ctx = await this.buildContext(sender, input);
    if (OWNER_CHANNELS.includes(input.channel) && ctx.recipients.length !== 1) {
      throw new GroveError("RECIPIENTS_INVALID", "Owner channel requires exactly one recipient.");
    }
    // Production SpeechService never owner-bypasses room_say.
    if (!OWNER_CHANNELS.includes(input.channel)) {
      ctx.isOwnerChannel = false;
    }
    assertValidOwnerChannelFlag(ctx);

    const result = authorize(ctx);
    if (!result.emit.allow) {
      throw new GroveError(result.emit.code, result.emit.reason, {
        capability: result.emit.capability,
        hint:
          result.emit.code === "PERMISSION_DENIED" && result.emit.capability === "speakToHumans"
            ? "Use channel owner_reply to talk to your owner, or ask them to enable Talk to humans."
            : undefined,
      });
    }

    if (input.channel === "whisper") {
      await this.quota.consumeWhisper(senderId, sender.kind === "agent" && isFirst24h(sender.agent.claimedAt));
    }

    const speechId = newId("speech");
    const untrusted = !ctx.isOwnerChannel;
    const roomId = ctx.room?.id ?? null;
    const targetId =
      input.channel === "whisper" || OWNER_CHANNELS.includes(input.channel)
        ? (ctx.recipients[0]?.id ?? input.targetId ?? null)
        : null;

    await this.store.pg.query(
      `INSERT INTO speech (id, channel, sender_id, sender_kind, room_id, target_id, body, grapheme_count, idempotency_key, untrusted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        speechId,
        input.channel,
        senderId,
        sender.kind,
        roomId,
        targetId,
        input.body,
        count,
        input.idempotencyKey,
        untrusted,
      ],
    );

    const undelivered: SayAck["undelivered"] = [];
    let deliveredCount = 0;
    const allowedIds: string[] = [];
    const mutedHumanIds: string[] = [];

    for (const d of result.deliveries) {
      const allow = d.decision.allow;
      await this.store.pg.query(
        `INSERT INTO speech_deliveries (speech_id, recipient_id, status, filter_code) VALUES ($1,$2,$3,$4)`,
        [speechId, d.recipientId, allow ? "delivered" : "filtered", allow ? null : d.decision.code],
      );
      if (allow) {
        deliveredCount += 1;
        allowedIds.push(d.recipientId);
        if (
          this.mailbox &&
          (input.channel === "whisper" || input.channel === "owner_instruction") &&
          d.recipientId.startsWith("agt_")
        ) {
          await this.mailbox.enqueueIfOffline(d.recipientId, input.channel, {
            speechId,
            senderId,
            senderKind: sender.kind,
            body: input.body,
            channel: input.channel,
          });
        }
      } else {
        undelivered.push({
          actorId: d.recipientId,
          code: d.decision.code,
          capability: d.decision.capability,
        });
        if (d.decision.code === "MUTED" && d.decision.visibleInUi === false) {
          mutedHumanIds.push(d.recipientId);
        }
      }
    }

    if (input.channel === "room_say" && roomId) {
      const first24 = sender.kind === "agent" && isFirst24h(sender.agent.claimedAt);
      await this.quota.consumeSay(senderId, roomId, first24);
    } else if (OWNER_CHANNELS.includes(input.channel)) {
      const first24 = sender.kind === "agent" && isFirst24h(sender.agent.claimedAt);
      await this.quota.consumeWrite(senderId, first24);
    }

    await this.store.pg.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ('speech', $1, $2)`, [
      senderId,
      JSON.stringify({ speechId, channel: input.channel, roomId }),
    ]);

    const frame = {
      type: "speech",
      speech_id: speechId,
      channel: input.channel,
      sender_id: senderId,
      sender_kind: sender.kind,
      room_id: roomId,
      target_id: targetId,
      body: input.body,
      untrusted,
      created_at: new Date().toISOString(),
    };

    if (OWNER_CHANNELS.includes(input.channel)) {
      const recip = ctx.recipients[0]!.id;
      await this.store.redis.publish(`pubsub:actor:${recip}`, JSON.stringify(frame));
    } else {
      if (roomId) {
        await this.store.redis.publish(
          `pubsub:room:${roomId}`,
          JSON.stringify({ ...frame, delivered_to: allowedIds, muted_hidden: mutedHumanIds }),
        );
      }
      for (const id of allowedIds) {
        await this.store.redis.publish(`pubsub:actor:${id}`, JSON.stringify(frame));
      }
      for (const id of mutedHumanIds) {
        await this.store.redis.publish(
          `pubsub:actor:${id}`,
          JSON.stringify({ type: "speech_hidden", speech_id: speechId, room_id: roomId }),
        );
      }
      if (input.channel === "room_say" && roomId === "plaza" && spectatorMayHear(ctx.sender, ctx.room, ctx.quota)) {
        await this.store.redis.publish("sse:plaza", JSON.stringify(frame));
      }
    }

    return { id: speechId, channel: input.channel, deliveredCount, undelivered };
  }

  async buildContext(
    sender: SenderActor,
    input: { channel: SpeechChannel; body: string; targetId?: string | null },
  ): Promise<PolicyContext> {
    const senderId = sender.kind === "human" ? sender.human.id : sender.agent.id;
    const senderKind: ActorKind = sender.kind;
    const presence = await this.presence.getPresence(senderId);
    let room: Room | null = null;
    if (presence) room = await this.presence.getRoom(presence.roomId);

    const senderCtx: PolicyContext["sender"] =
      sender.kind === "human"
        ? {
            id: sender.human.id,
            kind: "human",
            privacy: sender.human.privacy,
          }
        : {
            id: sender.agent.id,
            kind: "agent",
            ownerHumanId: sender.agent.ownerHumanId,
            claimState: sender.agent.claimState,
            policy: sender.agent.policy,
            privacy: sender.agent.privacy,
          };

    let recipients: PolicyContext["recipients"] = [];

    if (input.channel === "owner_reply") {
      if (sender.kind !== "agent" || !sender.agent.ownerHumanId) {
        // authorize will NOT_FOUND; still need a recipient list of 0 or a dummy
        recipients = [];
      } else {
        const owner = await this.loadRecipient(sender.agent.ownerHumanId, senderId);
        recipients = owner ? [owner] : [];
      }
    } else if (input.channel === "owner_instruction") {
      if (sender.kind !== "human" || !input.targetId) {
        recipients = [];
      } else {
        const agent = await this.loadRecipient(input.targetId, senderId);
        recipients = agent ? [agent] : [];
      }
    } else if (input.channel === "whisper") {
      if (!input.targetId) throw new GroveError("RECIPIENTS_INVALID", "Whisper requires a target.");
      const target = await this.loadRecipient(input.targetId, senderId);
      recipients = target ? [target] : [];
    } else {
      if (!room) {
        throw new GroveError("NOT_FOUND", "Join a room before speaking.", { httpStatus: 404 });
      }
      const members = await this.presence.nearby(room.id, senderId);
      for (const m of members) {
        if (m.actorId === senderId) continue;
        const rec = await this.loadRecipient(m.actorId, senderId);
        if (rec) recipients.push(rec);
      }
    }

    const first24 = sender.kind === "agent" && isFirst24h(sender.agent.claimedAt);
    const quota = room
      ? await this.quota.snapshotForSay(senderId, room.id, first24)
      : { roomSayRemaining: 8, roomSayGapOk: true, writeRemaining: 30, roomWindowCount: 0 };

    let isOwnerChannel = false;
    if (OWNER_CHANNELS.includes(input.channel) && recipients.length === 1) {
      isOwnerChannel = computeIsOwnerChannel(senderCtx, recipients[0]!);
    }

    return {
      sender: senderCtx,
      recipients,
      channel: input.channel,
      requestedTargetId: input.targetId ?? null,
      room: room
        ? {
            id: room.id,
            kind: room.kind,
            allowsRoomSay: room.allowsRoomSay,
            allowsWhisper: room.allowsWhisper,
            sayLimitPerMin: room.sayLimitPerMin,
            capacity: room.capacity,
          }
        : undefined,
      quota,
      isOwnerChannel,
    };
  }

  async loadRecipientPublic(id: string, senderId: string): Promise<PolicyContext["recipients"][number] | null> {
    return this.loadRecipient(id, senderId);
  }

  private async loadRecipient(id: string, senderId: string): Promise<PolicyContext["recipients"][number] | null> {
    const blocked = await this.isBlocked(senderId, id);
    const muted = await this.isMuted(id, senderId);
    if (id.startsWith("hum_")) {
      const { rows } = await this.store.pg.query("SELECT * FROM humans WHERE id = $1", [id]);
      if (!rows[0]) return null;
      const h = mapHuman(rows[0] as Record<string, unknown>);
      return {
        id: h.id,
        kind: "human",
        lurk: h.lurk,
        privacy: h.privacy,
        blocked,
        mutedByRecipient: muted,
      };
    }
    const { rows } = await this.store.pg.query("SELECT * FROM agents WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const a = mapAgent(rows[0] as Record<string, unknown>);
    if (a.claimState !== "claimed") return null;
    return {
      id: a.id,
      kind: "agent",
      ownerHumanId: a.ownerHumanId,
      policy: a.policy,
      privacy: a.privacy as PrivacyPolicy,
      blocked,
      mutedByRecipient: muted,
    };
  }

  async isBlocked(a: string, b: string): Promise<boolean> {
    const { rowCount } = await this.store.pg.query(
      `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [a, b],
    );
    return (rowCount ?? 0) > 0;
  }

  async isMuted(muter: string, muted: string): Promise<boolean> {
    const { rowCount } = await this.store.pg.query(
      `SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = $2`,
      [muter, muted],
    );
    return (rowCount ?? 0) > 0;
  }

  async transcript(roomId: string, viewer: SenderActor, cursor?: string, limit = 50) {
    const viewerId = viewer.kind === "human" ? viewer.human.id : viewer.agent.id;
    const params: unknown[] = [roomId, Math.min(limit, 100)];
    let sql = `SELECT s.* FROM speech s
      WHERE s.room_id = $1 AND s.channel = 'room_say'`;
    if (cursor) {
      params.push(cursor);
      sql += ` AND s.id < $${params.length}`;
    }
    sql += ` ORDER BY s.created_at DESC, s.id DESC LIMIT $2`;
    const { rows } = await this.store.pg.query(sql, params);
    const items = [];
    for (const row of rows.reverse()) {
      const senderKind = row.sender_kind as ActorKind;
      const sender = {
        id: row.sender_id as string,
        kind: senderKind,
        policy: undefined as PermissionPolicy | undefined,
        privacy: undefined as PolicyContext["sender"]["privacy"],
        claimState: undefined as Agent["claimState"] | undefined,
        ownerHumanId: undefined as string | null | undefined,
      };
      if (senderKind === "agent") {
        const ag = await this.store.pg.query("SELECT * FROM agents WHERE id = $1", [sender.id]);
        if (ag.rows[0]) {
          const a = mapAgent(ag.rows[0] as Record<string, unknown>);
          sender.policy = a.policy;
          sender.privacy = a.privacy;
          sender.claimState = a.claimState;
          sender.ownerHumanId = a.ownerHumanId;
        }
      } else {
        const hu = await this.store.pg.query("SELECT * FROM humans WHERE id = $1", [sender.id]);
        if (hu.rows[0]) sender.privacy = mapHuman(hu.rows[0] as Record<string, unknown>).privacy;
      }
      const rec = await this.loadRecipient(viewerId, sender.id);
      if (!rec) continue;
      const room = await this.presence.getRoom(roomId);
      const decision = authorize({
        sender,
        recipients: [rec],
        channel: "room_say",
        room: room
          ? {
              id: room.id,
              kind: room.kind,
              allowsRoomSay: room.allowsRoomSay,
              allowsWhisper: room.allowsWhisper,
              sayLimitPerMin: room.sayLimitPerMin,
              capacity: room.capacity,
            }
          : undefined,
        quota: { roomSayRemaining: 8, roomSayGapOk: true, writeRemaining: 30, roomWindowCount: 0 },
        isOwnerChannel: false,
      });
      if (!decision.emit.allow || !decision.deliveries[0]?.decision.allow) continue;
      if (decision.deliveries[0]?.decision.code === "MUTED") continue;
      items.push({
        id: row.id,
        channel: row.channel,
        senderId: row.sender_id,
        senderKind: row.sender_kind,
        body: row.body,
        untrusted: row.untrusted,
        createdAt: new Date(row.created_at as string).toISOString(),
      });
    }
    const nextCursor = rows.length ? (rows[0] as { id: string }).id : null;
    return { items, nextCursor };
  }

  async ownerThread(agentId: string, ownerId: string, limit = 50) {
    const { rows } = await this.store.pg.query(
      `SELECT * FROM speech
       WHERE channel IN ('owner_reply','owner_instruction')
         AND (
           (sender_id = $1 AND target_id = $2)
           OR (sender_id = $2 AND target_id = $1)
         )
       ORDER BY created_at DESC
       LIMIT $3`,
      [agentId, ownerId, limit],
    );
    const { rows: ins } = await this.store.pg.query(
      `SELECT * FROM instructions WHERE agent_id = $1 AND owner_human_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [agentId, ownerId, limit],
    );
    return {
      speech: rows.reverse().map((r) => ({
        id: r.id,
        channel: r.channel,
        senderId: r.sender_id,
        senderKind: r.sender_kind,
        body: r.body,
        createdAt: new Date(r.created_at as string).toISOString(),
        untrusted: false,
      })),
      instructions: ins.reverse().map((r) => ({
        id: r.id,
        agentId: r.agent_id,
        ownerHumanId: r.owner_human_id,
        kind: r.kind,
        body: r.body,
        createdAt: new Date(r.created_at as string).toISOString(),
        expiresAt: r.expires_at ? new Date(r.expires_at as string).toISOString() : null,
        ackedAt: r.acked_at ? new Date(r.acked_at as string).toISOString() : null,
      })),
    };
  }
}

export function roomFromRow(row: Record<string, unknown>): Room {
  return mapRoom(row);
}
