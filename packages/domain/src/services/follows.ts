import {
  FOLLOWS_MAX,
  FOLLOW_FANOUT_MAX,
  FOLLOW_NOTICE_COOLDOWN_SECONDS,
  WORLD_ID,
  isFollowNoticeKind,
  type FollowSubjectRef,
  isFollowSubject,
  toolCallNoticeKind,
  type Agent,
  type FollowNoticeKind,
  type FollowNoticePayload,
  type FollowNoticeView,
  type FollowSubject,
  type Human,
  type PolicyContext,
  type ToolCallView,
} from "@grove/protocol";
import { authorize } from "@grove/policy";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import type { CampusService } from "./campus.js";
import type { IdentityService } from "./identity.js";
import type { MailboxService } from "./mailbox.js";
import type { PresenceService } from "./presence.js";
import type { SpeechService } from "./speech.js";
import { isFirst24h, type QuotaService } from "./quota.js";
import { GUEST_FOLLOWS_MAX, type Guest } from "./guests.js";

/**
 * Who follows. A guest (queue #32) follows through the signed-out door (public
 * spaces and claimed agents only) and is never told anything: it has no inbox.
 * Its follows move onto the person when that browser signs in.
 */
export type Follower = { kind: "human"; human: Human } | { kind: "agent"; agent: Agent } | { kind: "guest"; guest: Guest };

export interface FollowState {
  subject: FollowSubject;
  id: string;
  slug: string;
  name: string;
  following: boolean;
  /** How many follow it. Never who. */
  followers: number;
}

/**
 * What the event sources call. Kept narrow so PresenceService, ToolCallService
 * and CampusService (all built before this service) hold a late-bound hook
 * rather than a construction cycle.
 */
export interface FollowHooks {
  agentFaulted(agentId: string, roomId: string, errorText: string | null): Promise<void>;
  toolCallFinished(agentId: string, roomId: string, view: ToolCallView): Promise<void>;
  stageStarted(input: { worldId: string; roomId: string; createdBy: string; title: string; startsAt: string; endsAt: string | null }): Promise<void>;
}

type Subject = { kind: FollowSubject; id: string; slug: string; name: string };

const NOT_FOUND = () => new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });

/** The quota a follow notice is judged with. The kernel never reads it on this channel. */
const NO_QUOTA = { roomSayRemaining: 0, roomSayGapOk: false, writeRemaining: 0, roomWindowCount: 0 };

/**
 * Follows (migration 028). See @grove/protocol follows.ts for the vocabulary.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY FOLLOW WHAT
 * ---------------------------------------------------------------------------
 * A space is behind the same door as its card: a private space answers 404 to
 * a non-member, by id or slug, identical to "no such space". An archived space
 * is gone. An agent is as public as its /a profile (a pending agent is 404).
 * An agent follows as its owner for the door (the way the chronicle and cards
 * build a viewer).
 *
 * ---------------------------------------------------------------------------
 * WHO HEARS WHAT
 * ---------------------------------------------------------------------------
 * Written on the event, never polled. Each source calls one hook after its own
 * write; the hook finds the followers in one indexed read, and when there are
 * none (the common case) that is the whole cost. When there are some, every
 * follower is judged by authorize() on `follow_notice`, in the room it happened
 * in, with that room's ceilings and the follower's membership as of NOW — so
 * following a space and then losing membership stops the notices, and a private
 * room in a public space stays private. A private space is also refused
 * outright for non-members before the kernel is asked, belt and braces.
 *
 * Fault loops are folded: one notice per (subject, kind) per cooldown. A hook
 * never throws into the act that raised it — a pulse must not fail because a
 * follower's inbox could not be written.
 */
export class FollowService implements FollowHooks {
  constructor(
    private store: GroveStore,
    private identity: IdentityService,
    private campus: CampusService,
    private presence: PresenceService,
    private speech: SpeechService,
    private mailbox: MailboxService,
    private quota: QuotaService,
  ) {}

  // ----------------------------------------------------------------- follow

  async state(follower: Follower | null, subjectKind: string, ref: string): Promise<FollowState> {
    const subject = await this.resolve(viewerOf(follower), subjectKind, ref);
    return this.stateOf(follower ? actorIdOf(follower) : null, subject);
  }

  /**
   * Batch follow state (queue #55): many hearts in one read, keyed by
   * `FollowSubjectRef.key`. Every subject goes through the SAME door as
   * `state()`, and one that the door refuses is left out of the answer — a
   * private space you are not in and a subject that never existed are both
   * simply absent, never told apart. The counts are one grouped read over
   * whatever made it through. Signed out (`follower` null): `following` is
   * false everywhere, the counts are the public ones.
   */
  async states(
    follower: Follower | null,
    subjects: FollowSubjectRef[],
  ): Promise<Record<string, { following: boolean; followers: number }>> {
    const viewer = viewerOf(follower);
    const resolved = await Promise.all(
      subjects.map(async (s) => {
        try {
          return { key: s.key, subject: await this.resolve(viewer, s.kind, s.ref) };
        } catch (err) {
          if (err instanceof GroveError) return null;
          throw err;
        }
      }),
    );
    const found = resolved.filter((r): r is { key: string; subject: Subject } => r !== null);
    // Null prototype: the route's snake_case codec only rewrites plain objects,
    // and these keys are slugs to echo back byte for byte, not field names.
    const out = Object.create(null) as Record<string, { following: boolean; followers: number }>;
    if (!found.length) return out;
    const { rows } = await this.store.pg.query<{ subject_kind: string; subject_id: string; n: number; mine: boolean }>(
      `SELECT f.subject_kind, f.subject_id, count(*)::int AS n,
              bool_or($3::text IS NOT NULL AND f.follower_id = $3::text) AS mine
         FROM follows f
         JOIN unnest($1::text[], $2::text[]) AS t(kind, id) ON f.subject_kind = t.kind AND f.subject_id = t.id
        GROUP BY f.subject_kind, f.subject_id`,
      [found.map((r) => r.subject.kind), found.map((r) => r.subject.id), follower ? actorIdOf(follower) : null],
    );
    const counts = new Map(rows.map((r) => [`${r.subject_kind}:${r.subject_id}`, r]));
    for (const { key, subject } of found) {
      const row = counts.get(`${subject.kind}:${subject.id}`);
      out[key] = { following: row?.mine === true, followers: row?.n ?? 0 };
    }
    return out;
  }

  /** `onNew` runs after a follow row was actually written (not on a re-follow or an unfollow). */
  async setFollow(
    follower: Follower,
    subjectKind: string,
    ref: string,
    on: boolean,
    hooks: { onNew?: () => Promise<void> } = {},
  ): Promise<FollowState> {
    const followerId = actorIdOf(follower);
    if (!on) {
      // Unfollowing always deletes your own row, even behind a door you no
      // longer have — refusing would strand a follow you cannot see. But the
      // ANSWER still respects the door: past it you get the same 404 as a
      // subject that never existed, never its name.
      const loose = await this.resolveLoose(subjectKind, ref);
      if (loose) {
        await this.store.pg.query(
          `DELETE FROM follows WHERE follower_id = $1 AND subject_kind = $2 AND subject_id = $3`,
          [followerId, loose.kind, loose.id],
        );
      }
      const subject = await this.resolve(viewerOf(follower), subjectKind, ref);
      return this.stateOf(followerId, subject);
    }
    if (follower.kind === "agent" && follower.agent.claimState !== "claimed") {
      throw new GroveError("UNCLAIMED", "Only a claimed agent may follow.");
    }
    const subject = await this.resolve(viewerOf(follower), subjectKind, ref);
    if (subject.id === followerId) throw new GroveError("INVALID", "You cannot follow yourself.");
    const { rows } = await this.store.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM follows WHERE follower_id = $1`,
      [followerId],
    );
    const cap = follower.kind === "guest" ? GUEST_FOLLOWS_MAX : FOLLOWS_MAX;
    if ((rows[0]?.n ?? 0) >= cap) {
      throw new GroveError(
        "INVALID",
        follower.kind === "guest"
          ? `A guest can follow ${cap} things. Sign in to follow more.`
          : `You already follow ${cap} things. Unfollow some first.`,
      );
    }
    const { rowCount } = await this.store.pg.query(
      `INSERT INTO follows (follower_id, follower_kind, subject_kind, subject_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [followerId, follower.kind, subject.kind, subject.id],
    );
    // Charged only when something was written, like a reaction: re-following
    // is idempotent and free.
    if ((rowCount ?? 0) > 0) {
      await this.quota.consumeWrite(
        followerId,
        follower.kind === "guest" || (follower.kind === "agent" && isFirst24h(follower.agent.claimedAt)),
      );
      await hooks.onNew?.().catch(() => {});
    }
    return this.stateOf(followerId, subject);
  }

  /** What this actor follows, still-visible subjects only, newest first. */
  async listMine(follower: Follower): Promise<Array<Omit<FollowState, "followers">>> {
    const followerId = actorIdOf(follower);
    const { rows } = await this.store.pg.query<{ subject_kind: string; subject_id: string }>(
      `SELECT subject_kind, subject_id FROM follows WHERE follower_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [followerId, FOLLOWS_MAX],
    );
    const out: Array<Omit<FollowState, "followers">> = [];
    for (const r of rows) {
      try {
        const s = await this.resolve(viewerOf(follower), r.subject_kind, r.subject_id);
        out.push({ subject: s.kind, id: s.id, slug: s.slug, name: s.name, following: true });
      } catch {
        // Gone, or behind a door this follower no longer has: not listed.
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- notices

  async notices(humanId: string, limit = 50): Promise<{ items: FollowNoticeView[]; unread: number }> {
    const n = Math.max(1, Math.min(100, Math.floor(limit) || 50));
    const [list, count] = await Promise.all([
      this.store.pg.query(
        `SELECT id, kind, payload, created_at, read_at FROM follow_notices
          WHERE human_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [humanId, n],
      ),
      this.unreadCount(humanId),
    ]);
    const items: FollowNoticeView[] = [];
    for (const r of list.rows) {
      if (!isFollowNoticeKind(r.kind)) continue;
      items.push({
        id: String(r.id),
        kind: r.kind,
        payload: r.payload as FollowNoticePayload,
        createdAt: new Date(String(r.created_at)).toISOString(),
        readAt: r.read_at ? new Date(String(r.read_at)).toISOString() : null,
      });
    }
    return { items, unread: count };
  }

  /** Unread notices for the nav badge: one count on the partial unread index. */
  async unreadCount(humanId: string): Promise<number> {
    const { rows } = await this.store.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM follow_notices WHERE human_id = $1 AND read_at IS NULL`,
      [humanId],
    );
    return rows[0]?.n ?? 0;
  }

  async markSeen(humanId: string, ids?: string[]): Promise<number> {
    if (ids?.length) {
      const { rowCount } = await this.store.pg.query(
        `UPDATE follow_notices SET read_at = now() WHERE human_id = $1 AND id = ANY($2::text[]) AND read_at IS NULL`,
        [humanId, ids.slice(0, 200).map(String)],
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await this.store.pg.query(
      `UPDATE follow_notices SET read_at = now() WHERE human_id = $1 AND read_at IS NULL`,
      [humanId],
    );
    return rowCount ?? 0;
  }

  // ------------------------------------------------------------------ hooks

  async agentFaulted(agentId: string, roomId: string, errorText: string | null): Promise<void> {
    await this.safely(async () => {
      const agent = await this.agentSubject(agentId);
      if (!agent) return;
      await this.fanOut(agent.subject, agent.sender, roomId, "agent.error", {
        subject: publicSubject(agent.subject),
        roomId,
        errorText: errorText ? String(errorText).slice(0, 160) : null,
      });
    });
  }

  async toolCallFinished(agentId: string, roomId: string, view: ToolCallView): Promise<void> {
    const kind = toolCallNoticeKind(view.outcome, view.durationMs);
    if (!kind) return;
    await this.safely(async () => {
      const agent = await this.agentSubject(agentId);
      if (!agent) return;
      // The tool's name, outcome and duration: what the map drew over the body.
      // Never its args or result text, which can carry far more than a follower
      // standing in the room would have read at a glance.
      await this.fanOut(agent.subject, agent.sender, roomId, kind, {
        subject: publicSubject(agent.subject),
        roomId,
        tool: { name: view.name, outcome: view.outcome ?? "ok", durationMs: view.durationMs },
      });
    });
  }

  async stageStarted(input: {
    worldId: string;
    roomId: string;
    createdBy: string;
    title: string;
    startsAt: string;
    endsAt: string | null;
  }): Promise<void> {
    await this.safely(async () => {
      const world = await this.campus.getWorld(input.worldId);
      if (!world || world.archivedAt) return;
      const subject: Subject = { kind: "space", id: world.id, slug: world.slug, name: world.name };
      const sender: PolicyContext["sender"] = input.createdBy.startsWith("agt_")
        ? { id: input.createdBy as never, kind: "agent", claimState: "claimed" }
        : { id: input.createdBy as never, kind: "human" };
      // Exactly-once already (announceStage claims the row), so no cooldown.
      await this.fanOut(
        subject,
        sender,
        input.roomId,
        "space.stage_started",
        {
          subject: publicSubject(subject),
          roomId: input.roomId,
          stage: { title: input.title, startsAt: input.startsAt, endsAt: input.endsAt },
        },
        { cooldown: false },
      );
    });
  }

  // --------------------------------------------------------------- internals

  /**
   * Tell every follower of `subject` who may hear it. Returns how many were told.
   * Exposed for tests; sources go through the hooks above.
   */
  async fanOut(
    subject: Subject,
    sender: PolicyContext["sender"],
    roomId: string,
    kind: FollowNoticeKind,
    payload: FollowNoticePayload,
    opts: { cooldown?: boolean } = {},
  ): Promise<number> {
    const { rows: followers } = await this.store.pg.query<{ follower_id: string }>(
      // Guests have no inbox, and must never crowd real followers out of the fan-out cap.
      `SELECT follower_id FROM follows WHERE subject_kind = $1 AND subject_id = $2 AND follower_kind <> 'guest'
        ORDER BY created_at LIMIT $3`,
      [subject.kind, subject.id, FOLLOW_FANOUT_MAX],
    );
    if (!followers.length) return 0;

    if (opts.cooldown !== false) {
      const fresh = await this.store.redis.set(
        `follow:cool:${kind}:${subject.id}`,
        "1",
        "EX",
        FOLLOW_NOTICE_COOLDOWN_SECONDS,
        "NX",
      );
      if (!fresh) return 0;
    }

    // The room decides. No room, no report: fail closed.
    const room = await this.presence.getRoomById(roomId);
    if (!room) return 0;
    const { rows: wr } = await this.store.pg.query<{ id: string; policy_preset: string | null; archived_at: unknown }>(
      `SELECT w.id, w.policy_preset, w.archived_at FROM rooms r JOIN worlds w ON w.id = r.world_id WHERE r.id = $1`,
      [room.id],
    );
    const world = wr[0];
    if (!world || world.archived_at) return 0;
    const layers = await this.campus.ceilingLayersForRoom(room.id);
    const members = await this.campus.memberIdsOf(world.id);
    const isMember = (humanId: string | null | undefined) =>
      members === null ? true : Boolean(humanId && members.has(humanId));
    const privateSpace = world.id !== WORLD_ID && world.policy_preset === "private";

    const recipients: PolicyContext["recipients"] = [];
    for (const f of followers) {
      if (f.follower_id === sender.id) continue;
      const rec = await this.speech.loadRecipientPublic(f.follower_id, sender.id);
      if (!rec) continue;
      rec.isSpaceMember = isMember(rec.kind === "human" ? rec.id : rec.ownerHumanId);
      if (privateSpace && !rec.isSpaceMember) continue;
      recipients.push(rec);
    }
    if (!recipients.length) return 0;

    if (sender.kind === "agent" || sender.kind === "human") {
      const senderHuman = sender.kind === "human" ? sender.id : sender.ownerHumanId;
      sender.isSpaceMember = isMember(senderHuman);
    }
    const result = authorize({
      sender,
      recipients,
      channel: "follow_notice",
      room: {
        id: room.id,
        kind: room.kind,
        allowsRoomSay: room.allowsRoomSay,
        allowsWhisper: room.allowsWhisper,
        sayLimitPerMin: room.sayLimitPerMin,
        capacity: room.capacity,
        ...(layers ?? {}),
      },
      quota: NO_QUOTA,
      isOwnerChannel: false,
    });
    if (!result.emit.allow) return 0;

    const allowed = new Set(result.deliveries.filter((d) => d.decision.allow).map((d) => String(d.recipientId)));
    const humans = recipients.filter((r) => r.kind === "human" && allowed.has(r.id)).map((r) => String(r.id));
    const agents = recipients.filter((r) => r.kind === "agent" && allowed.has(r.id)).map((r) => String(r.id));

    if (humans.length) {
      const body = JSON.stringify(payload);
      await this.store.pg.query(
        `INSERT INTO follow_notices (id, human_id, kind, subject_kind, subject_id, payload)
         SELECT t.id, t.human_id, $3, $4, $5, $6::jsonb
           FROM unnest($1::text[], $2::text[]) AS t(id, human_id)`,
        [humans.map(() => newId("followNotice")), humans, kind, subject.kind, subject.id, body],
      );
      // Keep the table from growing without bound: read notices age out.
      await this.store.pg.query(
        `DELETE FROM follow_notices WHERE human_id = ANY($1::text[]) AND read_at IS NOT NULL
           AND created_at < now() - interval '30 days'`,
        [humans],
      );
    }
    for (const agentId of agents) {
      await this.mailbox.enqueue(agentId, `follow.${kind}`, payload as unknown as Record<string, unknown>);
    }
    return humans.length + agents.length;
  }

  private async safely(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.warn("[grove] follow notice failed:", (err as Error).message);
    }
  }

  private async agentSubject(agentId: string): Promise<{ subject: Subject; sender: PolicyContext["sender"] } | null> {
    if (!agentId.startsWith("agt_")) return null;
    // Cheap exit before loading anything: nobody follows most agents.
    const { rowCount } = await this.store.pg.query(
      `SELECT 1 FROM follows WHERE subject_kind = 'agent' AND subject_id = $1 AND follower_kind <> 'guest' LIMIT 1`,
      [agentId],
    );
    if (!rowCount) return null;
    const agent = await this.identity.getAgent(agentId);
    if (!agent || agent.claimState !== "claimed") return null;
    return {
      subject: { kind: "agent", id: agent.id, slug: agent.slug, name: agent.displayName },
      sender: {
        id: agent.id,
        kind: "agent",
        ownerHumanId: agent.ownerHumanId,
        claimState: agent.claimState,
        policy: agent.policy,
        privacy: agent.privacy,
      },
    };
  }

  private async stateOf(followerId: string | null, subject: Subject): Promise<FollowState> {
    const { rows } = await this.store.pg.query<{ n: number; mine: boolean }>(
      `SELECT count(*)::int AS n, bool_or($3::text IS NOT NULL AND follower_id = $3::text) AS mine
         FROM follows WHERE subject_kind = $1 AND subject_id = $2`,
      [subject.kind, subject.id, followerId],
    );
    return {
      subject: subject.kind,
      id: subject.id,
      slug: subject.slug,
      name: subject.name,
      following: rows[0]?.mine === true,
      followers: rows[0]?.n ?? 0,
    };
  }

  /** The door. `viewerHumanId` is the human, or an agent's owner; null signed out. */
  private async resolve(viewerHumanId: string | null, subjectKind: string, ref: string): Promise<Subject> {
    if (!isFollowSubject(subjectKind)) throw new GroveError("INVALID", "subject must be space or agent.");
    const key = String(ref ?? "").trim();
    if (!key || key.length > 200) throw NOT_FOUND();
    if (subjectKind === "space") {
      const world = await this.campus.getWorld(key);
      if (!world || world.archivedAt) throw NOT_FOUND();
      if (world.policyPreset === "private" && world.id !== WORLD_ID) {
        const member = viewerHumanId ? await this.campus.isMember(world.id, viewerHumanId) : false;
        if (!member) throw NOT_FOUND();
      }
      return { kind: "space", id: world.id, slug: world.slug, name: world.name };
    }
    const agent = (await this.identity.getAgentBySlug(key)) ?? (await this.identity.getAgent(key));
    if (!agent || agent.claimState === "pending") throw NOT_FOUND();
    return { kind: "agent", id: agent.id, slug: agent.slug, name: agent.displayName };
  }

  /** For unfollow only: find the row's subject without asking the door. */
  private async resolveLoose(subjectKind: string, ref: string): Promise<Subject | null> {
    if (!isFollowSubject(subjectKind)) throw new GroveError("INVALID", "subject must be space or agent.");
    const key = String(ref ?? "").trim();
    if (!key) return null;
    if (subjectKind === "space") {
      const world = await this.campus.getWorld(key);
      return world ? { kind: "space", id: world.id, slug: world.slug, name: world.name } : null;
    }
    const agent = (await this.identity.getAgentBySlug(key)) ?? (await this.identity.getAgent(key));
    return agent ? { kind: "agent", id: agent.id, slug: agent.slug, name: agent.displayName } : null;
  }
}

function actorIdOf(f: Follower): string {
  return f.kind === "human" ? f.human.id : f.kind === "agent" ? f.agent.id : f.guest.id;
}

/** The door's viewer: the human, an agent's owner, or nobody (signed out, or a guest). */
function viewerOf(f: Follower | null): string | null {
  if (!f || f.kind === "guest") return null;
  return f.kind === "human" ? f.human.id : (f.agent.ownerHumanId ?? null);
}

function publicSubject(s: Subject): FollowNoticePayload["subject"] {
  return { kind: s.kind, slug: s.slug, name: s.name };
}
