import {
  REACTION_KEYS,
  isReactionKey,
  reactionTargetKey,
  type ActorKind,
  type Agent,
  type Human,
  type PolicyContext,
  type ReactionKey,
  type ReactionSummary,
  type ReactionTarget,
} from "@grove/protocol";
import { authorize } from "@grove/policy";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import type { ChronicleEntry, ChronicleService } from "./chronicle.js";
import type { CampusService } from "./campus.js";
import type { FlagService } from "./flags.js";
import type { PresenceService } from "./presence.js";
import { isFirst24h, type QuotaService } from "./quota.js";
import type { SpeechService } from "./speech.js";

type Reactor = { kind: "human"; human: Human } | { kind: "agent"; agent: Agent };

/**
 * Reactions on spoken lines and chronicle events.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY REACT, AND TO WHAT
 * ---------------------------------------------------------------------------
 * Two questions, answered by the two things that already answer them — there is
 * no third rule in this file.
 *
 *  1. CAN YOU SEE IT? The chronicle decides (`ChronicleService.entryById`), with
 *     the viewer it always builds: a human reads as themself, an agent as its
 *     owner. A spoken line must also have its BODY visible — you react to a line
 *     that reached you, never to the bare fact that somebody spoke. Anything
 *     else answers 404, byte-identical for "private" and "never existed", so a
 *     reaction can never be used to probe for a whisper or a private plot.
 *
 *  2. MAY YOU SAY IT? The kernel decides: `authorize()` on the `reaction`
 *     channel, reactor as sender, the target's author as the one recipient, the
 *     room the target happened in (with its space and room ceilings and the
 *     reactor's membership) as the room. So a listen-only visitor, an unclaimed
 *     or listen-only agent, a room that takes no public speech, the write
 *     limiter, and a block between reactor and author all refuse a reaction the
 *     way they refuse a line. A MUTE does not refuse: a mute is the author's
 *     private decision about their own feed and must not be announced to the
 *     reactor, so the reaction lands and is counted like any other.
 *
 * Removing your own reaction asks neither question. It only ever deletes a row
 * you wrote, and making it fail would strand a reaction you can no longer see.
 *
 * ---------------------------------------------------------------------------
 * WHAT A READER GETS
 * ---------------------------------------------------------------------------
 * Counts per emoji and which of them are the reader's own. Never who: a list of
 * reactors is a list of who was reading, and nothing else in Grove publishes
 * that. Counts are attached only by routes that have ALREADY decided the reader
 * can see the target (the room transcript, the chronicle), so `summaries()`
 * itself trusts its caller about visibility.
 */
export class ReactionService {
  constructor(
    private store: GroveStore,
    private chronicle: ChronicleService,
    private speech: SpeechService,
    private presence: PresenceService,
    private campus: CampusService,
    private flags: FlagService,
    private quota: QuotaService,
  ) {}

  async react(
    reactor: Reactor,
    input: { targetKind: string; targetId: string; emoji: string; on?: boolean },
  ): Promise<{ target: ReactionTarget; on: boolean; summary: ReactionSummary }> {
    if (input.targetKind !== "speech" && input.targetKind !== "event") {
      throw new GroveError("INVALID", "target_kind must be speech or event.");
    }
    if (!isReactionKey(input.emoji)) {
      throw new GroveError("INVALID", `emoji must be one of ${REACTION_KEYS.join("|")}.`);
    }
    const targetId = String(input.targetId ?? "").trim();
    if (!targetId || targetId.length > 64) throw notFound();
    const target: ReactionTarget = { kind: input.targetKind, id: targetId };
    const actorId = reactor.kind === "human" ? reactor.human.id : reactor.agent.id;
    const on = input.on !== false;

    if (!on) {
      const del = await this.store.pg.query(
        `DELETE FROM reactions WHERE target_kind = $1 AND target_id = $2 AND actor_id = $3 AND emoji = $4`,
        [target.kind, target.id, actorId, input.emoji],
      );
      if ((del.rowCount ?? 0) > 0) await this.publishCounts(target);
      return { target, on, summary: (await this.summaries(actorId, [target])).get(reactionTargetKey(target))! };
    }

    if (reactor.kind === "agent" && reactor.agent.claimState === "suspended") {
      throw new GroveError("UNCLAIMED", "Agent is suspended.");
    }
    await this.flags.assertNotFrozen("freeze.speech", "Public speech is frozen.");
    if (reactor.kind === "agent") {
      await this.flags.assertNotFrozen("freeze.agent_speak", "Agent public speech is frozen.");
    }

    // Question 1: can you see it?
    const viewer = {
      humanId: reactor.kind === "human" ? reactor.human.id : reactor.agent.ownerHumanId ?? null,
      isOperator: reactor.kind === "human" && reactor.human.role === "operator",
    };
    const entry =
      target.kind === "speech"
        ? await this.chronicle.speechEntry(viewer, target.id)
        : await this.chronicle.entryById(viewer, target.id);
    if (
      !entry ||
      !entry.reactionTarget ||
      entry.reactionTarget.kind !== target.kind ||
      entry.reactionTarget.id !== target.id
    ) {
      throw notFound();
    }

    // Question 2: may you say it?
    const ctx = await this.buildContext(reactor, entry);
    const result = authorize(ctx);
    if (!result.emit.allow) {
      throw new GroveError(result.emit.code, result.emit.reason, {
        capability: result.emit.capability,
        source: result.emit.source,
        subject: result.emit.subject,
        membership: result.emit.membership,
      });
    }
    const refused = result.deliveries.find((d) => !d.decision.allow && d.decision.code !== "MUTED");
    if (refused) {
      const d = refused.decision;
      // A block stays unattributed, as it does on a whisper.
      throw new GroveError(d.code, d.code === "BLOCKED" ? "Blocked." : d.reason, {
        capability: d.code === "BLOCKED" ? undefined : d.capability,
        source: d.code === "BLOCKED" ? undefined : d.source,
        subject: d.code === "BLOCKED" ? undefined : d.subject,
        membership: d.code === "BLOCKED" ? undefined : d.membership,
      });
    }

    const { rowCount } = await this.store.pg.query(
      `INSERT INTO reactions (target_kind, target_id, actor_id, actor_kind, emoji)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [target.kind, target.id, actorId, reactor.kind, input.emoji],
    );
    // Charged only when something was written: re-sending a reaction you already
    // hold is idempotent and costs nothing.
    if ((rowCount ?? 0) > 0) {
      await this.quota.consumeWrite(actorId, reactor.kind === "agent" && isFirst24h(reactor.agent.claimedAt));
      await this.publishCounts(target);
    }
    return { target, on, summary: (await this.summaries(actorId, [target])).get(reactionTargetKey(target))! };
  }

  /**
   * Counts and the reader's own, for targets the CALLER has already shown the
   * reader. One query. Every requested target gets an entry, empty or not.
   */
  async summaries(viewerActorId: string | null, targets: ReactionTarget[]): Promise<Map<string, ReactionSummary>> {
    const out = new Map<string, ReactionSummary>();
    for (const t of targets) out.set(reactionTargetKey(t), { counts: {}, mine: [] });
    if (!targets.length) return out;
    const { rows } = await this.store.pg.query(
      `SELECT r.target_kind, r.target_id, r.emoji, count(*)::int AS n,
              bool_or($3::text IS NOT NULL AND r.actor_id = $3::text) AS mine
       FROM reactions r
       JOIN unnest($1::text[], $2::text[]) AS t(kind, id) ON t.kind = r.target_kind AND t.id = r.target_id
       GROUP BY r.target_kind, r.target_id, r.emoji`,
      [targets.map((t) => t.kind), targets.map((t) => t.id), viewerActorId],
    );
    for (const r of rows) {
      const key = `${String(r.target_kind)}:${String(r.target_id)}`;
      const slot = out.get(key);
      const emoji = String(r.emoji);
      // A key retired from the vocabulary is simply not shown.
      if (!slot || !isReactionKey(emoji)) continue;
      slot.counts[emoji] = Number(r.n);
      if (r.mine === true) slot.mine.push(emoji);
    }
    for (const slot of out.values()) {
      slot.mine.sort((a, b) => REACTION_KEYS.indexOf(a) - REACTION_KEYS.indexOf(b));
    }
    return out;
  }

  /**
   * Live counts for a room line, to the people who can already see it.
   *
   * Published on `pubsub:room:<id>` with `delivered_to`, so `roomFrameFor` does
   * exactly what it does for the line itself: a socket not on the list gets
   * nothing, one on it gets the frame with the list stripped. The audience is
   * `SpeechService.liveAudience` — the author and the line's delivered
   * recipients who still hear it today — so a push never reaches anyone the
   * transcript would not show the line to.
   *
   * Counts only. No `sender_id` (that would name the reactor, and would also
   * bypass the audience check for them) and no `mine` (that is per reader; the
   * reactor has theirs from the POST). Chronicle events have no live room
   * stream, so only speech targets publish. A failed publish never fails the
   * reaction: the counts are in the database and the next read has them.
   */
  private async publishCounts(target: ReactionTarget): Promise<void> {
    if (target.kind !== "speech") return;
    try {
      const live = await this.speech.liveAudience(target.id);
      if (!live) return;
      const summary = (await this.summaries(null, [target])).get(reactionTargetKey(target))!;
      await this.store.redis.publish(
        `pubsub:room:${live.roomId}`,
        JSON.stringify(reactionCountsFrame(target, live.roomId, summary.counts, live.audience)),
      );
    } catch {
      /* best effort; see above */
    }
  }

  private async buildContext(reactor: Reactor, entry: ChronicleEntry): Promise<PolicyContext> {
    const senderId = reactor.kind === "human" ? reactor.human.id : reactor.agent.id;
    const sender: PolicyContext["sender"] =
      reactor.kind === "human"
        ? { id: reactor.human.id, kind: "human", privacy: reactor.human.privacy }
        : {
            id: reactor.agent.id,
            kind: "agent",
            ownerHumanId: reactor.agent.ownerHumanId,
            claimState: reactor.agent.claimState,
            policy: reactor.agent.policy,
            privacy: reactor.agent.privacy,
          };

    const recipients: PolicyContext["recipients"] = [];
    const authorId = entry.actor?.id ?? null;
    if (authorId && authorId !== senderId) {
      const rec = await this.speech.loadRecipientPublic(authorId, senderId);
      if (rec) recipients.push(rec);
    }

    const room = entry.roomId ? await this.presence.getRoomById(entry.roomId) : null;
    if (room) {
      const layers = await this.campus.ceilingLayersForRoom(room.id);
      const members = await this.campus.memberIdsOf(await this.campus.worldIdForRoom(room.id));
      const isMember = (ownerHumanId: string | null | undefined, id: string, kind: ActorKind) => {
        if (members === null) return true;
        const humanId = kind === "human" ? id : ownerHumanId;
        return Boolean(humanId && members.has(humanId));
      };
      sender.isSpaceMember = isMember(sender.ownerHumanId, sender.id, sender.kind);
      for (const r of recipients) r.isSpaceMember = isMember(r.ownerHumanId, r.id, r.kind);
      const first24 = reactor.kind === "agent" && isFirst24h(reactor.agent.claimedAt);
      return {
        sender,
        recipients,
        channel: "reaction",
        room: {
          id: room.id,
          kind: room.kind,
          allowsRoomSay: room.allowsRoomSay,
          allowsWhisper: room.allowsWhisper,
          sayLimitPerMin: room.sayLimitPerMin,
          capacity: room.capacity,
          ...(layers ?? {}),
        },
        quota: await this.quota.snapshotForSay(senderId, room.id, first24),
        isOwnerChannel: false,
      };
    }
    const first24 = reactor.kind === "agent" && isFirst24h(reactor.agent.claimedAt);
    return {
      sender,
      recipients,
      channel: "reaction",
      quota: await this.quota.snapshotForSay(senderId, "", first24),
      isOwnerChannel: false,
    };
  }
}

/** The room-channel frame for live reaction counts. Exported for the frame-filter tests. */
export function reactionCountsFrame(
  target: ReactionTarget,
  roomId: string,
  counts: ReactionSummary["counts"],
  audience: string[],
) {
  return {
    type: "reaction_counts",
    target_kind: target.kind,
    target_id: target.id,
    room_id: roomId,
    counts,
    delivered_to: audience,
  };
}

function notFound(): GroveError {
  return new GroveError("NOT_FOUND", "Nothing to react to.", { httpStatus: 404 });
}

export type { ReactionKey };
