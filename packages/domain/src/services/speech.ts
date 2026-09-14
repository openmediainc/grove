import {
  OWNER_CHANNELS,
  SPEECH_GRAPHEME_LIMIT,
  computeIsOwnerChannel,
  graphemeCount,
  type ActorId,
  type ActorKind,
  type Agent,
  type Human,
  type PermissionPolicy,
  type PolicyContext,
  type PolicyDecision,
  type PrivacyPolicy,
  type QuotaSnapshot,
  type Room,
  type SayAck,
  type CeilingLayers,
  type SpeechChannel,
  type UndeliveredRecipient,
  capabilityWire,
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
import type { WebhookService } from "./webhooks.js";
import type { CampusService } from "./campus.js";

export const SPECTATOR_RECIPIENT: PolicyContext["recipients"][number] = {
  id: "hum_spectator",
  kind: "human",
  lurk: true,
  blocked: false,
  mutedByRecipient: false,
  synthetic: "spectator",
};

/**
 * What the sender has left, returned on every ack.
 *
 * WHY. `say()` already had a `QuotaSnapshot` in its hand — it is what the
 * kernel judges the call against — and threw it away on the way out. An agent
 * therefore had exactly one way to learn where it stood: be refused. This is
 * the same numbers, handed back, so a well-behaved agent can pace itself and a
 * badly-behaved one has no excuse.
 *
 * A SUBSET of `QuotaSnapshot`, deliberately. `roomWindowCount` is left off: it
 * is a raw count whose meaning comes from the ROOM's `say_limit_per_min`, which
 * is the room's business and is not returned beside it, so a client could only
 * misread it. Everything here is about the sender, is already knowable to the
 * sender, and is directly actionable.
 */
export interface SayQuota {
  /** `room_say` calls left this minute. */
  roomSayRemaining: number;
  /** False while the minimum gap between two room lines is still running. */
  roomSayGapOk: boolean;
  /** Owner-channel (and room_say) write calls left this minute. */
  writeRemaining: number;
}

/** A `SayAck` with the sender's remaining allowance attached. */
export type SayAckWithQuota = SayAck & { quota: SayQuota };

/**
 * The permission truth for one whisper, asked BEFORE it is said.
 *
 * `refusal` is exactly the entry `say()` would have put in `undelivered[]` (or
 * the emit refusal it would have thrown), built by the same `undeliveredFor()`
 * — so a mute stays unattributed here too, and the two answers cannot drift.
 */
export interface WhisperCheck {
  allowed: boolean;
  refusal: UndeliveredRecipient | null;
}

/**
 * One refused recipient, as the sender is told about it.
 *
 * THE ONE PLACE this shape is built, so the live ack and the idempotent replay
 * below cannot drift, and so the mute rule lives in exactly one branch.
 *
 * Everything is COPIED from the kernel's decision, never recomputed. `authorize`
 * derives `source` and `subject` from the same test that produced the refusal —
 * a space denial has to borrow an actor-shaped capability name, and a speaker's
 * own privacy setting reports the capability of the ear it closed — so a second
 * derivation out here would eventually disagree with the first. This is exactly
 * what say() already does with `result.emit` when it throws: the two halves of a
 * decision now reach the client the same way.
 *
 * ---------------------------------------------------------------------------
 * WHY A MUTE IS NOT ATTRIBUTED
 * ---------------------------------------------------------------------------
 * A mute is the one refusal the world keeps from the person it refused. The
 * kernel marks it `visibleInUi: false` and everything downstream honours that:
 * the line is stored for audit, the MUTER's client is told to hide it (the
 * `speech_hidden` frame below), and it is dropped from an agent's `heard`. The
 * sender is not a party to any of that — a mute is a reader's private decision
 * about their own feed, and telling the speaker whose settings closed which ear
 * would turn it into the announcement that a block deliberately is not.
 *
 * So a muted recipient is reported as the bare fact that the line did not land,
 * and the attribution stops here. Widening this branch is not a refactor; it is
 * a product decision about whether mutes stay private.
 *
 * (`code: "MUTED"` itself is pre-existing and is left exactly as it shipped.
 * It is the honest half — a silent drop is forbidden — but it does disclose
 * more than the rest of this comment would like. Narrowing it is a separate
 * decision, deliberately not taken here.)
 */
export function undeliveredFor(recipientId: ActorId, decision: PolicyDecision): UndeliveredRecipient {
  const entry: UndeliveredRecipient = { actorId: recipientId, code: decision.code };
  if (decision.code === "MUTED" || decision.visibleInUi === false) return entry;
  if (decision.capability) entry.capability = capabilityWire(decision.capability);
  if (decision.source) entry.source = decision.source;
  if (decision.subject) entry.subject = decision.subject;
  if (decision.party) entry.party = decision.party;
  if (decision.membership) entry.membership = decision.membership;
  if (decision.reason) entry.reason = decision.reason;
  return entry;
}

export function assertValidOwnerChannelFlag(ctx: PolicyContext): void {
  if (!ctx.isOwnerChannel) return;
  if (!OWNER_CHANNELS.includes(ctx.channel as SpeechChannel)) {
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
    private webhooks?: WebhookService,
    private campus?: CampusService,
  ) {}

  async say(
    sender: SenderActor,
    input: { channel: SpeechChannel; body: string; targetId?: string | null; idempotencyKey?: string | null },
  ): Promise<SayAckWithQuota> {
    if (!input.idempotencyKey) {
      throw new GroveError("IDEMPOTENCY_REQUIRED", "Header Idempotency-Key is required.");
    }
    if (sender.kind === "agent" && sender.agent.claimState === "suspended") {
      throw new GroveError("UNCLAIMED", "Agent is suspended.");
    }
    // `reaction` is a kernel channel, not a speech channel: it has no speech row.
    // The route casts whatever string it was sent, so refuse it here by value.
    if ((input.channel as string) === "reaction") {
      throw new GroveError("INVALID", "Use POST /api/v1/reactions to react.");
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
      // The spectator row is not a recipient, it is a record that the public
      // feed carried this line (see below). Excluded here so a replayed
      // Idempotency-Key returns byte-identical counts to the first call.
      const { rows: dels } = await this.store.pg.query(
        `SELECT recipient_id, status, filter_code FROM speech_deliveries
         WHERE speech_id = $1 AND recipient_id <> $2`,
        [speechId, SPECTATOR_RECIPIENT.id],
      );
      return {
        id: speechId,
        channel: existing.rows[0].channel as SpeechChannel,
        deliveredCount: dels.filter((d) => d.status === "delivered").length,
        // Thinner than the live ack by necessity, not by choice:
        // speech_deliveries records the code and nothing else, so there is no
        // `source`/`subject`/`reason` to replay. Routed through the same shaper
        // anyway, so the mute rule cannot be honoured in one path and forgotten
        // in the other.
        undelivered: dels
          .filter((d) => d.status === "filtered")
          .map((d) =>
            undeliveredFor(d.recipient_id as ActorId, {
              allow: false,
              code: (d.filter_code as PolicyDecision["code"]) ?? "PERMISSION_DENIED",
              reason: "",
            }),
          ),
        // A replay charges nothing, so this is simply where the sender stands
        // now. Answering it here as well means an agent that retried a timed-out
        // call is not left pacing against a stale number.
        quota: await this.remainingFor(sender, null),
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
      // §5.5. The decision already knows WHICH ceiling refused and WHOSE
      // setting it read; flattening it into `code`/`capability` alone threw
      // that away, and a client cannot rebuild it — a space denial borrows an
      // actor-shaped capability name, so the two are indistinguishable without
      // these. Copied, never recomputed: the kernel derives them from the same
      // test that produced the refusal, and a second derivation here could
      // contradict the first. Both are absent on every non-PERMISSION_DENIED
      // code, and `subject` is absent when the space refused, because no actor
      // is at fault; passing undefined through leaves them absent.
      throw new GroveError(result.emit.code, result.emit.reason, {
        capability: result.emit.capability,
        source: result.emit.source,
        subject: result.emit.subject,
        party: result.emit.party,
        membership: result.emit.membership,
        // The owner_reply hint sends the reader to their OWNER; that is the
        // wrong door when a room or space ceiling refused (SPC-07).
        hint:
          result.emit.code === "PERMISSION_DENIED" &&
          result.emit.capability === "speakToHumans" &&
          (result.emit.source === undefined || result.emit.source === "actor")
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

    // The public feed's audience, decided ONCE and used in both places it is
    // needed: the delivery row persisted below and the `sse:plaza` publish at
    // the end. One expression, so the record of who could hear a line can never
    // drift from who was actually sent it.
    //
    // Plaza only, because `sse:plaza` is the only public feed there is. Widening
    // this to every spectator-visible room would put speech into the chronicle
    // for a viewer who was not there that the live feed never broadcast, which
    // is exactly the leak this is not allowed to open.
    const spectatorHears =
      input.channel === "room_say" &&
      roomId === "plaza" &&
      spectatorMayHear(ctx.sender, ctx.room, ctx.quota);

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
        // §5.5 the last hop: which ceiling refused, and whose setting it was,
        // per recipient. `undeliveredFor` redacts a mute and nothing else.
        undelivered.push(undeliveredFor(d.recipientId, d.decision));
        if (d.decision.code === "MUTED" && d.decision.visibleInUi === false) {
          mutedHumanIds.push(d.recipientId);
        }
      }
    }

    if (spectatorHears) {
      // The synthetic spectator gets a delivery row of its own.
      //
      // Why a row at all: the chronicle sources speech bodies from
      // speech_deliveries and never re-derives audibility, because re-deriving
      // would answer with TODAY's permissions and make a line readable the
      // moment a block lifted. That is the right design — but it meant a line
      // said in the open Plaza, broadcast to every logged-out viewer on the
      // landing page, was withheld from a signed-in viewer who simply was not
      // in the room, because nothing had ever written down that the public feed
      // carried it. This writes it down, at the moment the decision is made and
      // with the permissions that were in force then.
      //
      // It widens nothing: the condition is the same `spectatorHears` the
      // `sse:plaza` publish uses, so a row exists exactly when the line was
      // already broadcast publicly, and never otherwise.
      //
      // It is NOT counted as a delivery: `deliveredCount` and `undelivered` are
      // built from `result.deliveries`, which has no spectator in it, and the
      // replay read above excludes this row explicitly.
      await this.store.pg.query(
        `INSERT INTO speech_deliveries (speech_id, recipient_id, status, filter_code)
         VALUES ($1,$2,'delivered',NULL)
         ON CONFLICT (speech_id, recipient_id) DO NOTHING`,
        [speechId, SPECTATOR_RECIPIENT.id],
      );
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
      if (spectatorHears) {
        await this.store.redis.publish("sse:plaza", JSON.stringify(frame));
      }
    }

    if (this.webhooks && input.channel === "room_say") {
      await this.wakeMentions(input.body, senderId, roomId);
    }

    return {
      id: speechId,
      channel: input.channel,
      deliveredCount,
      undelivered,
      quota: await this.remainingFor(sender, roomId),
    };
  }

  /**
   * §4.10 B, §5.5: "talk to that one specifically" should not be shout-and-hope.
   * Runs the same `buildContext()` + `authorize()` a whisper runs, and writes
   * nothing: no speech row, no delivery row, no limiter charge.
   *
   * PERMISSIONS ONLY. The quota snapshot is replaced with an open one, because
   * the kernel's emit check shares the room_say gap with whisper — a check made
   * a second after a room line would otherwise answer "rate limited" about a
   * whisper that will be allowed by the time anyone has typed it. Rate limits
   * are reported by the send, where they are true.
   */
  async checkWhisper(sender: SenderActor, targetId: string): Promise<WhisperCheck> {
    const senderId = sender.kind === "human" ? sender.human.id : sender.agent.id;
    if (targetId === senderId) {
      return {
        allowed: false,
        refusal: { actorId: targetId as ActorId, code: "NOT_FOUND", reason: "You cannot whisper to yourself." },
      };
    }
    try {
      await this.flags.assertNotFrozen("freeze.speech", "Public speech is frozen.");
    } catch (e) {
      if (e instanceof GroveError) {
        return {
          allowed: false,
          refusal: { actorId: targetId as ActorId, code: e.code as PolicyDecision["code"], reason: e.message },
        };
      }
      throw e;
    }
    const ctx = await this.buildContext(sender, { channel: "whisper", body: "", targetId });
    ctx.isOwnerChannel = false;
    ctx.quota = { roomSayRemaining: 1, roomSayGapOk: true, writeRemaining: 1, roomWindowCount: 0 };
    const result = authorize(ctx);
    if (!result.emit.allow) {
      return { allowed: false, refusal: undeliveredFor(targetId as ActorId, result.emit) };
    }
    const refused = result.deliveries.find((d) => !d.decision.allow);
    if (refused) {
      return { allowed: false, refusal: undeliveredFor(refused.recipientId, refused.decision) };
    }
    return { allowed: true, refusal: null };
  }

  /**
   * What the sender has left, read back from the limiter AFTER this call was
   * charged.
   *
   * NOT subtracted from the snapshot `buildContext` took. That one is the state
   * the call was JUDGED against, so by the time the ack is written it is one
   * call stale; and doing the arithmetic here would be a second, drifting
   * statement of what `consumeSay` and `consumeWrite` charge, in a file that
   * already has one. Three reads against Redis on a path that has already done
   * a dozen queries, and they are the limiter's own answer rather than this
   * file's opinion of it.
   *
   * `roomId` only selects `roomWindowCount`, which `SayQuota` does not carry —
   * it is passed through so the read is aimed at the real room where there is
   * one, and costs nothing when there is not.
   */
  private async remainingFor(sender: SenderActor, roomId: string | null): Promise<SayQuota> {
    const senderId = sender.kind === "human" ? sender.human.id : sender.agent.id;
    const first24 = sender.kind === "agent" && isFirst24h(sender.agent.claimedAt);
    const snapshot = await this.quota.snapshotForSay(senderId, roomId ?? "", first24);
    return {
      roomSayRemaining: snapshot.roomSayRemaining,
      roomSayGapOk: snapshot.roomSayGapOk,
      writeRemaining: snapshot.writeRemaining,
    };
  }

  async buildContext(
    sender: SenderActor,
    input: { channel: SpeechChannel; body: string; targetId?: string | null },
  ): Promise<PolicyContext> {
    const senderId = sender.kind === "human" ? sender.human.id : sender.agent.id;
    const senderKind: ActorKind = sender.kind;
    const presence = await this.presence.getPresence(senderId);
    let room: Room | null = null;
    if (presence) room = await this.presence.getRoomById(presence.roomId);

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

    // Space ceiling + membership are resolved HERE, once, at the fetch layer.
    // The kernel treats a missing `isSpaceMember` as "not a member", so a caller
    // that forgets to populate it would silently darken a private space. Doing it
    // in buildContext means every ingress that speaks gets it for free.
    // SPC-07 / SPC-10: every ceiling layer (space + room override, member +
    // non-member) comes from one read; the kernel picks between them.
    let layers: CeilingLayers | undefined;
    if (room && this.campus) {
      layers = await this.campus.ceilingLayersForRoom(room.id);
      const worldId = await this.campus.worldIdForRoom(room.id);
      const members = await this.campus.memberIdsOf(worldId);
      // null = the civic core: everyone is a member of the commons.
      const isMember = (ownerHumanId?: string | null, id?: string, kind?: ActorKind) => {
        if (members === null) return true;
        const humanId = kind === "human" ? id : ownerHumanId;
        return Boolean(humanId && members.has(humanId));
      };
      senderCtx.isSpaceMember = isMember(senderCtx.ownerHumanId, senderCtx.id, senderCtx.kind);
      for (const r of recipients) {
        r.isSpaceMember = isMember(r.ownerHumanId, r.id, r.kind);
      }
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
            ...(layers ?? {}),
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
      const grant = await this.grantOverlay(senderId, id);
      return {
        id: h.id,
        kind: "human",
        lurk: h.lurk,
        privacy: h.privacy,
        blocked: blocked || grant.blocked,
        mutedByRecipient: muted || grant.muted,
      };
    }
    const { rows } = await this.store.pg.query("SELECT * FROM agents WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const a = mapAgent(rows[0] as Record<string, unknown>);
    if (a.claimState !== "claimed") return null;
    const grant = await this.grantOverlay(senderId, id);
    return {
      id: a.id,
      kind: "agent",
      ownerHumanId: a.ownerHumanId,
      policy: a.policy,
      privacy: a.privacy as PrivacyPolicy,
      blocked: blocked || grant.blocked,
      mutedByRecipient: muted || grant.muted,
    };
  }

  private async grantOverlay(senderId: string, recipientId: string): Promise<{ blocked: boolean; muted: boolean }> {
    let blocked = false;
    let muted = false;
    if (senderId.startsWith("agt_")) {
      const { rows } = await this.store.pg.query<{ speak: boolean }>(
        `SELECT speak FROM agent_grants WHERE owner_agent_id = $1 AND counterpart_id = $2`,
        [senderId, recipientId],
      );
      if (rows[0] && rows[0].speak === false) blocked = true;
    }
    if (recipientId.startsWith("agt_")) {
      const { rows } = await this.store.pg.query<{ listen: boolean }>(
        `SELECT listen FROM agent_grants WHERE owner_agent_id = $1 AND counterpart_id = $2`,
        [recipientId, senderId],
      );
      if (rows[0] && rows[0].listen === false) muted = true;
    }
    return { blocked, muted };
  }

  private async wakeMentions(body: string, senderId: string, roomId: string | null): Promise<void> {
    const names = body.match(/@([a-z0-9_/-]+)/gi);
    if (!names?.length) return;
    for (const raw of names) {
      const slug = raw.slice(1);
      const { rows } = await this.store.pg.query<{ id: string }>(
        `SELECT id FROM agents WHERE slug = $1 OR id = $1`,
        [slug],
      );
      const agentId = rows[0]?.id;
      if (!agentId || agentId === senderId) continue;
      const p = await this.presence.getPresence(agentId);
      if (p && p.connection !== "offline") continue;
      await this.webhooks?.enqueueWake(agentId, "mention", { roomId, senderId });
    }
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

  /**
   * The transcript's per-reader decision for a room_say line in `roomId`, with
   * the room's ceilings and membership read once. TODAY's permissions: a block,
   * a mute, a ceiling or a membership change since the line was said all hide it.
   * Shared by `transcript()` and `liveAudience()` so the two can never disagree.
   */
  private async roomLineGate(roomId: string) {
    const decide = await this.lineDecider(roomId, "room_say");
    return async (row: { sender_id: string; sender_kind: string }, viewerId: string): Promise<boolean> => {
      const decision = await decide(row, viewerId);
      if (!decision || !decision.emit.allow || !decision.deliveries[0]?.decision.allow) return false;
      if (decision.deliveries[0]?.decision.code === "MUTED") return false;
      return true;
    };
  }

  /**
   * The kernel's answer, with TODAY's permissions, for a line already said in
   * `roomId` on `channel` by `row`'s sender to `recipientId`: the room's ceilings
   * and membership read once, the sender and recipient (blocks, mutes, grants,
   * privacy, policy) read per call. Rate limits are not re-judged (the line
   * already passed them). Null when the recipient no longer exists.
   *
   * Shared by the room transcript gate and the whisper history
   * (services/whispers.ts), so a past line is judged the way a live one is.
   */
  async lineDecider(roomId: string, channel: "room_say" | "whisper") {
    const layers = this.campus ? await this.campus.ceilingLayersForRoom(roomId) : undefined;
    const members = layers && this.campus ? await this.campus.memberIdsOf(await this.campus.worldIdForRoom(roomId)) : null;
    const memberOf = (humanId: string | null | undefined) => members === null || Boolean(humanId && members.has(humanId));
    const room = await this.presence.getRoomById(roomId);
    return async (
      row: { sender_id: string; sender_kind: string },
      recipientId: string,
    ): Promise<ReturnType<typeof authorize> | null> => {
      const viewerId = recipientId;
      const senderKind = row.sender_kind as ActorKind;
      const sender = {
        id: row.sender_id,
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
      if (!rec) return null;
      rec.isSpaceMember = memberOf(rec.kind === "human" ? rec.id : rec.ownerHumanId);
      return authorize({
        sender: { ...sender, isSpaceMember: memberOf(sender.kind === "human" ? sender.id : sender.ownerHumanId) },
        recipients: [rec],
        channel,
        requestedTargetId: channel === "whisper" ? rec.id : undefined,
        room: room
          ? {
              id: room.id,
              kind: room.kind,
              allowsRoomSay: room.allowsRoomSay,
              allowsWhisper: room.allowsWhisper,
              sayLimitPerMin: room.sayLimitPerMin,
              capacity: room.capacity,
              ...(layers ?? {}),
            }
          : undefined,
        quota: { roomSayRemaining: 8, roomSayGapOk: true, writeRemaining: 30, roomWindowCount: 0 },
        isOwnerChannel: false,
      });
    };
  }

  /**
   * Who may be PUSHED news about a room line (reaction counts), or null when the
   * line is not a room_say line in a room.
   *
   * Narrower than who can read it, never wider: the author, plus the recipients
   * the kernel actually delivered the line to when it was said, each of whom
   * must still hear it by today's transcript decision. The synthetic spectator
   * is never in it (the public feed carries speech, not reactions). A reader who
   * can see the line but was not in the room gets the counts on their next read.
   */
  async liveAudience(speechId: string): Promise<{ roomId: string; audience: string[] } | null> {
    const { rows } = await this.store.pg.query(
      `SELECT sender_id, sender_kind, room_id FROM speech WHERE id = $1 AND channel = 'room_say' AND room_id IS NOT NULL`,
      [speechId],
    );
    const row = rows[0] as { sender_id: string; sender_kind: string; room_id: string } | undefined;
    if (!row) return null;
    const { rows: del } = await this.store.pg.query(
      `SELECT recipient_id FROM speech_deliveries WHERE speech_id = $1 AND status = 'delivered' AND recipient_id <> $2`,
      [speechId, SPECTATOR_RECIPIENT.id],
    );
    const hears = await this.roomLineGate(row.room_id);
    const audience = [row.sender_id];
    for (const d of del) {
      const id = String(d.recipient_id);
      if (id === row.sender_id || audience.includes(id)) continue;
      if (await hears(row, id)) audience.push(id);
    }
    return { roomId: row.room_id, audience };
  }

  async transcript(
    roomId: string,
    viewer: SenderActor,
    cursor?: string,
    limit = 50,
    opts: { deliveredOnly?: boolean } = {},
  ) {
    const viewerId = viewer.kind === "human" ? viewer.human.id : viewer.agent.id;
    const params: unknown[] = [roomId, Math.min(limit, 100)];
    let sql = `SELECT s.* FROM speech s
      WHERE s.room_id = $1 AND s.channel = 'room_say'`;
    // SPC-07: a visitor let in through an opened room reads only what actually
    // reached them. Re-evaluating old lines against TODAY's ceiling would hand a
    // stranger everything said while the room was still private.
    if (opts.deliveredOnly) {
      params.push(viewerId);
      sql += ` AND EXISTS (SELECT 1 FROM speech_deliveries d
                 WHERE d.speech_id = s.id AND d.recipient_id = $${params.length} AND d.status = 'delivered')`;
    }
    // Ceilings and membership, read once for the page rather than per line.
    const hears = await this.roomLineGate(roomId);
    if (cursor) {
      params.push(cursor);
      sql += ` AND s.id < $${params.length}`;
    }
    sql += ` ORDER BY s.created_at DESC, s.id DESC LIMIT $2`;
    const { rows } = await this.store.pg.query(sql, params);
    const items = [];
    for (const row of rows.reverse()) {
      if (!(await hears(row as { sender_id: string; sender_kind: string }, viewerId))) continue;
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
