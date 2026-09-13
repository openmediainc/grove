import type { Agent, AgentVerb, Human, Presence, PresenceActivity, PresenceMode, Room } from "@grove/protocol";
import { isActiveVerb, VERB_LABEL, WORLD_ID } from "@grove/protocol";
import { badges } from "@grove/policy";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { mapPresence, mapRoom } from "../mappers.js";
import { withTx, type PoolClient } from "../db.js";
import type { FlagService } from "./flags.js";
import type { QuotaService } from "./quota.js";
import type { IdentityService } from "./identity.js";
import type { FollowHooks } from "./follows.js";
import {
  assertBatchSize,
  normalisePulseEventId,
  PULSE_DEDUPE_TTL_SECONDS,
  pulseSeenKey,
  resolvePulseAt,
  type PulseInput,
  type PulseItemResult,
} from "./pulse-batch.js";

/**
 * How long a body may claim an active verb without pulsing before we call it
 * stalled rather than working.
 *
 * The existing rhythm: HTTP pollers heartbeat every 120s, the map prefers a
 * pulse under 90s old, presence drops to `offline` at 5 min and is evicted at
 * 10 min. 180s is the only value that sits clear of all of them — 2x the map's
 * freshness window and 1.5x the poller rhythm, so a single dropped heartbeat or
 * a slow tool call never flags a healthy agent; yet it is well under the 5 min
 * offline mark, so a crashed runtime is visible about two minutes BEFORE
 * presence itself quietly gives up on it. That gap is the whole point: today a
 * dead runtime looks busy right up until it silently disappears.
 */
export const STALL_AFTER_SECONDS = 180;

/** Hard cap on a pulse `url`. Rejected, never truncated — half a URL is a lie. */
export const PULSE_URL_MAX = 512;
/** Hard cap on a pulse `error_text`. Truncated, like `detail`. */
export const PULSE_ERROR_MAX = 500;

/** Extra context a pulse may carry. Both optional; omitting both is the old behaviour. */
export interface PulseContext {
  /** External thing being worked: a PR, ticket or run. http/https only. */
  url?: string | null;
  /** What went wrong. Only stored for `error` / `blocked`. */
  errorText?: string | null;
}

/**
 * A pulse url renders as a clickable link on the public map, so the scheme is
 * an injection surface: `javascript:`, `data:` and friends are refused outright
 * rather than stored and filtered later by whoever happens to render it.
 */
export function normalisePulseUrl(raw: unknown): string | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (value.length > PULSE_URL_MAX) {
    throw new GroveError("INVALID", `url must be ${PULSE_URL_MAX} characters or fewer.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GroveError("INVALID", "url must be an absolute http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GroveError("INVALID", "url must use http: or https:.");
  }
  return parsed.toString();
}

/** Error text is free-form prose, so it is capped and trimmed, never parsed. */
export function normalisePulseError(raw: unknown): string | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  return value.slice(0, PULSE_ERROR_MAX);
}

/** A pulse after validation: exactly what gets written. Single pulses and batch items share it. */
interface NormalisedPulse {
  verb: AgentVerb;
  note: string | null;
  url: string | null;
  errorText: string | null;
}

/**
 * Every rule a pulse is checked against before it may spend quota or touch a
 * row. One function, so a batch item can never be judged by different rules
 * than the single pulse it stands in for.
 */
function normalisePulse(verb: string, detail: string | null | undefined, context?: PulseContext): NormalisedPulse {
  if (!(verb in VERB_LABEL)) {
    throw new GroveError("INVALID", `verb must be one of ${Object.keys(VERB_LABEL).join("|")}.`);
  }
  return {
    verb: verb as AgentVerb,
    note: detail ? String(detail).slice(0, 80) : null,
    url: normalisePulseUrl(context?.url),
    errorText: normalisePulseError(context?.errorText),
  };
}

/** What a batch did, item by item, plus where the body ended up. */
export interface PulseBatchResult {
  /** The body after the batch: the latest applied item wins. Null if it has no presence row. */
  presence: Presence | null;
  results: PulseItemResult[];
  applied: number;
  duplicates: number;
  refused: number;
}

/** Seconds since the last pulse, or null if this body has never pulsed. */
export function pulseAgeSeconds(pulsedAt?: string | null, now: number = Date.now()): number | null {
  if (!pulsedAt) return null;
  const at = Date.parse(pulsedAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((now - at) / 1000));
}

/**
 * Stalled = claiming to be doing something, but has not said so recently.
 * A body that never pulsed is not stalled (it claims nothing), and `idle` /
 * `offline` are not stalls — they are the agent correctly saying it is at rest.
 */
export function isStalledPulse(
  verb?: AgentVerb | string | null,
  pulsedAt?: string | null,
  now: number = Date.now(),
): boolean {
  if (!verb || !(verb in VERB_LABEL)) return false;
  if (!isActiveVerb(verb as AgentVerb)) return false;
  const age = pulseAgeSeconds(pulsedAt, now);
  return age !== null && age > STALL_AFTER_SECONDS;
}

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
  /**
   * The agent's owner human, taken straight off the row this query already
   * joins. Null for a human (it stands for itself) and for an unclaimed agent.
   * Published so a caller that needs the owner — the map's org tint, for one —
   * does not go back to `agents` for a column it was already handed.
   */
  ownerHumanId?: string | null;
  /**
   * The agent's stance (autonomy_mode). Public for the same reason badges are:
   * it is how a watcher reads what a body is likely to do next. Null for humans.
   */
  stance?: Agent["autonomyMode"] | null;
}

export class PresenceService {
  /** Late-bound by GroveApp: followers hear a fault (migration 028). */
  follows?: FollowHooks;

  constructor(
    private store: GroveStore,
    private flags: FlagService,
    private quota: QuotaService,
    private identity: IdentityService,
  ) {}

  /**
   * Resolve a room from UNTRUSTED input (a slug or id a caller supplied).
   * Scoped to the requested world, plus the canonical world — owner lounges
   * always live in the commons even while the caller's world cookie points at
   * a campus, so excluding canonical here would break every lounge.
   *
   * The id fallback used to be unscoped, which let anyone reach a private
   * campus's room by raw id and made the membership gate cosmetic.
   */
  async getRoom(slug: string, worldId: string = WORLD_ID): Promise<Room | null> {
    const { rows: bySlug } = await this.store.pg.query(
      "SELECT * FROM rooms WHERE slug = $1 AND world_id = $2",
      [slug, worldId],
    );
    if (bySlug[0]) return mapRoom(bySlug[0] as Record<string, unknown>);
    const { rows: byId } = await this.store.pg.query(
      "SELECT * FROM rooms WHERE id = $1 AND world_id IN ($2, $3)",
      [slug, worldId, WORLD_ID],
    );
    return byId[0] ? mapRoom(byId[0] as Record<string, unknown>) : null;
  }

  /**
   * Resolve a room by an id we already trust — one that came out of the
   * presence table or a hard-coded constant, never off the wire. Deliberately
   * unscoped: an actor already standing in a campus room must be able to
   * resolve it regardless of which world the request names.
   */
  async getRoomById(id: string): Promise<Room | null> {
    const { rows } = await this.store.pg.query("SELECT * FROM rooms WHERE id = $1", [id]);
    return rows[0] ? mapRoom(rows[0] as Record<string, unknown>) : null;
  }

  async listPublicRooms(worldId: string = WORLD_ID): Promise<Array<Room & { occupancy: number }>> {
    const { rows } = await this.store.pg.query(
      `SELECT r.*, count(p.actor_id)::int AS occupancy
       FROM rooms r
       LEFT JOIN presence p ON p.room_id = r.id
       WHERE r.kind <> 'owner_lounge' AND r.world_id = $1
       GROUP BY r.id
       ORDER BY CASE r.slug
         WHEN 'plaza' THEN 0 WHEN 'library' THEN 1 WHEN 'workshop' THEN 2
         WHEN 'stage' THEN 3 WHEN 'garden' THEN 4 WHEN 'board' THEN 5 ELSE 9 END`,
      [worldId],
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
    const existing = await this.getRoomById(id);
    if (existing) return existing;
    await this.store.pg.query(
      `INSERT INTO rooms (id, slug, name, kind, capacity, allows_room_say, allows_whisper, spectator_visible, owner_human_id, world_id)
       VALUES ($1,$2,$3,'owner_lounge',8,TRUE,TRUE,FALSE,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [id, id, `${human.handle}'s lounge`, human.id, WORLD_ID],
    );
    const room = await this.getRoomById(id);
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
      worldId?: string;
    },
  ): Promise<{ room: Room; presence: Presence; overflowed: boolean }> {
    const worldId = opts.worldId ?? WORLD_ID;
    await this.flags.assertNotFrozen("freeze.enter", "Entering the world is frozen.");
    await this.identity.assertActive(actor.id);
    if (opts.consumeEnter && actor.kind === "human") await this.quota.consumeEnter(actor.id);
    else await this.quota.consumeMove(actor.id);

    let targetSlug = slug === "lounge" && actor.kind === "human" ? `lounge_${actor.id}` : slug;
    if (slug === "lounge" && actor.kind === "agent" && actor.ownerHumanId) {
      targetSlug = `lounge_${actor.ownerHumanId}`;
    }
    if (targetSlug.startsWith("lounge_") && actor.kind === "human") {
      // Somebody else's lounge is private: it answers exactly like a room that
      // does not exist (queue #50). Before this a human could walk in by slug
      // and sit on the owner↔agent room's stream.
      if (targetSlug !== `lounge_${actor.id}`) {
        throw new GroveError("NOT_FOUND", "Room not found.", { httpStatus: 404 });
      }
      const human = await this.identity.getHuman(actor.id);
      if (human) await this.ensureLounge(human);
    }
    if (targetSlug.startsWith("lounge_") && actor.kind === "agent") {
      if (!actor.ownerHumanId || targetSlug !== `lounge_${actor.ownerHumanId}`) {
        throw new GroveError("ROOM_FORBIDDEN", "Agents may only enter their owner's lounge.");
      }
    }

    let room = await this.getRoom(targetSlug, worldId);
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
      if (err instanceof GroveError && err.code === "ROOM_FULL" && opts.overflowPlaza && room.slug === "plaza") {
        const garden = await this.getRoom("garden", worldId);
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
        throw new GroveError("ROOM_FULL", `${room.name} is full.`, { suggestedRoom: room.slug === "plaza" ? "garden" : "board" });
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
      // The ledger used to record arrivals and never departures, so history
      // could not tell a body that stayed from one that walked out. Replay needs
      // the leaving; the chronicle gates it exactly like the joining.
      await this.identity.audit("actor_left_room", actorId, { room: prev.roomId, reason: "left" });
      await this.store.redis.publish(
        `pubsub:room:${prev.roomId}`,
        JSON.stringify({ type: "actor_leave", actor_id: actorId, room_id: prev.roomId }),
      );
      if (prev.roomId === "plaza") {
        await this.store.redis.publish(
          "sse:plaza",
          JSON.stringify({ type: "actor_leave", actor_id: actorId, room_id: prev.roomId }),
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

  async setState(
    actorId: string,
    patch: { activity?: PresenceActivity; statusText?: string | null },
  ): Promise<Presence> {
    const presence = await this.touch(actorId, patch.activity ? { activity: patch.activity } : undefined);
    if (patch.statusText !== undefined) {
      await this.store.pg.query(`UPDATE agents SET status_text = $2 WHERE id = $1`, [
        actorId,
        patch.statusText,
      ]);
    }
    return presence;
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

  /**
   * An agent reports its current loop state. This is the campus-visible
   * equivalent of a heartbeat: it keeps the body alive AND says what it is doing,
   * so any runtime can be legible on the map without a bespoke bridge.
   */
  async pulse(
    actorId: string,
    verb: AgentVerb,
    detail?: string | null,
    context?: PulseContext,
  ): Promise<Presence> {
    // Validate BEFORE spending quota: a malformed url should not cost the agent
    // its one pulse for this second.
    const n = normalisePulse(verb, detail, context);
    await this.quota.consumePulse(actorId);
    const row = await this.writePulse(this.store.pg, actorId, n, null);
    if (!row) throw new GroveError("NOT_FOUND", "Join a room first (POST /world/join).", { httpStatus: 404 });
    await this.store.pg.query("UPDATE agents SET last_seen_at = now() WHERE id = $1", [actorId]);
    const presence = mapPresence(row);
    await this.publishPulse(actorId, presence, n);
    // Followers hear a fault (028). The hook folds a fault loop and never throws.
    if (n.verb === "error") await this.follows?.agentFaulted(actorId, presence.roomId, presence.errorText ?? null);
    return presence;
  }

  /**
   * A pulse raised by a tool-call span (ToolCallService), not by the agent
   * calling /world/pulse. Same columns, same broadcast, same 017 trigger — but
   * NOT the 1/s pulse gap: a PreToolUse and a PostToolUse routinely land in the
   * same second, and refusing the second would leave a finished call looking
   * like it is still running. The span routes carry their own quota.
   *
   * The url is left exactly as it was (sticky), and a tool phase is healthy by
   * definition, so any fault caption is cleared like any other healthy pulse.
   */
  async pulseFromSpan(actorId: string, verb: AgentVerb, detail: string | null): Promise<Presence> {
    const n: NormalisedPulse = { verb, note: detail ? String(detail).slice(0, 80) : null, url: null, errorText: null };
    const row = await this.writePulse(this.store.pg, actorId, n, null);
    if (!row) throw new GroveError("NOT_FOUND", "Join a room first (POST /world/join).", { httpStatus: 404 });
    await this.store.pg.query("UPDATE agents SET last_seen_at = now() WHERE id = $1", [actorId]);
    const presence = mapPresence(row);
    await this.publishPulse(actorId, presence, n);
    return presence;
  }

  /**
   * Several pulses in one request (AGT-10), each at the moment it really
   * happened. The rules and their numbers are documented in pulse-batch.ts and
   * docs/PULSE.md; in short:
   *
   *   - one batch spends ONE pulse of the 1/s cap, and carries ≤ PULSE_BATCH_MAX items;
   *   - items apply in array order, on a strictly increasing clock;
   *   - a bad item is refused on its own line, never the whole batch;
   *   - an `id` already seen is `duplicate`, and a batch of only duplicates is free;
   *   - every applied item is its own presence UPDATE, so the phase-history
   *     trigger (migration 017) sees each one at its own time — the ledger
   *     keeps what a fast agent did, while the body shows only the last item.
   */
  async pulseBatch(actorId: string, inputs: PulseInput[], receivedAt: number = Date.now()): Promise<PulseBatchResult> {
    assertBatchSize(inputs.length);
    const results: PulseItemResult[] = new Array(inputs.length);
    const toWrite: Array<{ index: number; id: string | null; n: NormalisedPulse; at: number; clamped: boolean }> = [];
    const idsInBatch = new Set<string>();
    let prevAt = Number.NEGATIVE_INFINITY;

    inputs.forEach((input, index) => {
      const sentId = input.id == null ? null : String(input.id);
      const refuse = (code: PulseItemResult["code"], reason: string) => {
        results[index] = { index, id: sentId, status: "refused", verb: input.verb || null, pulsedAt: null, clamped: false, code, reason };
      };
      let id: string | null;
      let n: NormalisedPulse;
      try {
        id = normalisePulseEventId(input.id);
        n = normalisePulse(input.verb, input.detail, { url: input.url, errorText: input.errorText });
      } catch (err) {
        if (err instanceof GroveError) return refuse("INVALID", err.message);
        throw err;
      }
      const when = resolvePulseAt(input.at, receivedAt);
      if (!when.ok) return refuse(when.code, when.reason);
      if (id && idsInBatch.has(id)) {
        results[index] = { index, id, status: "duplicate", verb: n.verb, pulsedAt: null, clamped: false };
        return;
      }
      if (id) idsInBatch.add(id);
      // Array order is the truth. A clock that runs backwards is moved forward
      // by the smallest step that keeps the timeline strictly increasing; the
      // trigger ignores an UPDATE that does not move pulsed_at, so equal
      // timestamps would silently lose an item.
      let at = when.at;
      let clamped = when.clamped;
      if (at <= prevAt) {
        at = prevAt + 1;
        clamped = true;
      }
      prevAt = at;
      toWrite.push({ index, id, n, at, clamped });
    });

    // A retry of something that already landed must not spend quota — or a
    // client whose response was lost would be refused by its own cooldown.
    const redis = this.store.redis;
    const withIds = toWrite.filter((w) => w.id);
    if (withIds.length) {
      const seen = await redis.mget(...withIds.map((w) => pulseSeenKey(actorId, w.id!)));
      withIds.forEach((w, i) => {
        if (seen[i] == null) return;
        results[w.index] = duplicateResult(w, seen[i]);
      });
    }
    let pending = toWrite.filter((w) => !results[w.index]);

    if (pending.length) {
      await this.quota.consumePulse(actorId);
      // Claim ids atomically: two racing retries cannot both write the same item.
      const claimed: string[] = [];
      for (const w of pending) {
        if (!w.id) continue;
        const key = pulseSeenKey(actorId, w.id);
        const ok = await redis.set(key, "pending", "EX", PULSE_DEDUPE_TTL_SECONDS, "NX");
        if (ok) claimed.push(key);
        else results[w.index] = duplicateResult(w, await redis.get(key));
      }
      pending = pending.filter((w) => !results[w.index]);
      let rows: Record<string, unknown>[] = [];
      try {
        if (pending.length) {
          rows = await withTx(this.store.pg, async (c) => {
            const out: Record<string, unknown>[] = [];
            for (const w of pending) {
              const row = await this.writePulse(c, actorId, w.n, new Date(w.at).toISOString());
              if (!row) throw new GroveError("NOT_FOUND", "Join a room first (POST /world/join).", { httpStatus: 404 });
              out.push(row);
            }
            await c.query("UPDATE agents SET last_seen_at = now() WHERE id = $1", [actorId]);
            return out;
          });
        }
      } catch (err) {
        // Nothing was written, so nothing may be remembered as written.
        if (claimed.length) await redis.del(...claimed);
        throw err;
      }
      let last: { presence: Presence; n: NormalisedPulse } | null = null;
      const firstAt = rows.length ? mapPresence(rows[0]!).pulsedAt ?? null : null;
      for (let i = 0; i < pending.length; i += 1) {
        const w = pending[i]!;
        const presence = mapPresence(rows[i]!);
        const pulsedAt = presence.pulsedAt ?? new Date(w.at).toISOString();
        if (w.id) await redis.set(pulseSeenKey(actorId, w.id), pulsedAt, "EX", PULSE_DEDUPE_TTL_SECONDS);
        results[w.index] = {
          index: w.index,
          id: w.id,
          status: "applied",
          verb: w.n.verb,
          pulsedAt,
          clamped: w.clamped || Date.parse(pulsedAt) !== w.at,
        };
        last = { presence, n: w.n };
      }
      if (last) {
        // ONE realtime event per batch, carrying the final state: a watcher's
        // body jumps to where the agent is now instead of strobing through a
        // second of history. The history itself is in the chronicle.
        const faulted = pending.some((w) => w.n.verb === "error");
        if (faulted) {
          await this.follows?.agentFaulted(actorId, last.presence.roomId, last.presence.errorText ?? null);
        }
        await this.publishPulse(actorId, last.presence, last.n, {
          count: rows.length,
          firstPulsedAt: firstAt,
          lastPulsedAt: last.presence.pulsedAt ?? null,
        });
        return summarise(last.presence, results);
      }
    }
    return summarise(await this.getPresence(actorId), results);
  }

  /**
   * The one UPDATE a pulse makes. `at` null means now(). pulsed_at never moves
   * backwards: a pulse stamped at or before the stored one lands 1 ms after it,
   * so the phase-history trigger always sees time go forward.
   */
  private async writePulse(
    q: Pick<PoolClient, "query">,
    actorId: string,
    n: NormalisedPulse,
    at: string | null,
  ): Promise<Record<string, unknown> | null> {
    // Only a pulse that says "offline" may downgrade the connection; a live
    // socket must not be demoted just because the agent also HTTP-pulsed.
    const connection = n.verb === "offline" ? "offline" : null;
    // A fault caption belongs to the fault: carried on error/blocked, wiped by
    // the next healthy pulse so the map never shows a stale reason.
    const fault = n.verb === "error" || n.verb === "blocked";
    const storedError = fault ? n.errorText : null;
    // The url is sticky — an agent names its PR once and keeps pulsing phases
    // against it — but a body going offline is no longer working on anything.
    const clearUrl = n.verb === "offline";
    const { rows } = await q.query(
      `UPDATE presence SET
         verb = $2, detail = $3,
         pulsed_at = GREATEST(COALESCE($9::timestamptz, now()), pulsed_at + interval '1 millisecond'),
         last_seen_at = now(),
         activity = $4,
         connection = COALESCE($5, connection),
         url = CASE WHEN $7::boolean THEN NULL ELSE COALESCE($6, url) END,
         error_text = $8
       WHERE actor_id = $1 RETURNING *`,
      [actorId, n.verb, n.note, ACTIVITY_FOR_VERB[n.verb], connection, n.url, clearUrl, storedError, at],
    );
    return (rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  private async publishPulse(
    actorId: string,
    presence: Presence,
    n: NormalisedPulse,
    batch?: { count: number; firstPulsedAt: string | null; lastPulsedAt: string | null },
  ): Promise<void> {
    const payload = JSON.stringify({
      type: "pulse",
      actor_id: actorId,
      room_id: presence.roomId,
      verb: n.verb,
      detail: n.note,
      url: presence.url ?? null,
      error_text: presence.errorText ?? null,
      presence,
      ...(batch
        ? { batch: { count: batch.count, first_pulsed_at: batch.firstPulsedAt, last_pulsed_at: batch.lastPulsedAt } }
        : {}),
    });
    await this.store.redis.publish(`pubsub:room:${presence.roomId}`, payload);
    if (presence.roomId === "plaza") await this.store.redis.publish("sse:plaza", payload);
  }

  async evictStale(): Promise<number> {
    await this.store.pg.query(
      `UPDATE presence SET connection = 'offline'
       WHERE connection = 'live' AND last_seen_at < now() - interval '5 minutes'`,
    );
    const { rows } = await this.store.pg.query<{ actor_id: string; room_id: string }>(
      `DELETE FROM presence
       WHERE last_seen_at < now() - interval '10 minutes'
       RETURNING actor_id, room_id`,
    );
    if (rows.length) {
      // One statement for the whole sweep: see leave() for why departures are kept.
      await this.store.pg.query(
        `INSERT INTO world_events (type, actor_id, payload)
         SELECT 'actor_left_room', t.actor_id, jsonb_build_object('room', t.room_id, 'reason', 'evicted')
         FROM unnest($1::text[], $2::text[]) AS t(actor_id, room_id)`,
        [rows.map((r) => r.actor_id), rows.map((r) => r.room_id)],
      );
    }
    for (const row of rows) {
      await this.store.redis.publish(
        `pubsub:room:${row.room_id}`,
        JSON.stringify({ type: "actor_leave", actor_id: row.actor_id, room_id: row.room_id }),
      );
      if (row.room_id === "plaza") {
        await this.store.redis.publish(
          "sse:plaza",
          JSON.stringify({ type: "actor_leave", actor_id: row.actor_id, room_id: "plaza" }),
        );
      }
    }
    return rows.length;
  }

  async nearby(roomId: string, viewerId?: string): Promise<NearbyRow[]> {
    const byRoom = await this.nearbyByRooms([roomId], viewerId);
    return byRoom.get(roomId) ?? [];
  }

  /**
   * Everyone standing in a SET of rooms, in one statement.
   *
   * The minimap used to ask room by room. That cost a round trip per room and,
   * worse, a fresh hash of the whole `agents` and `humans` tables per room — so
   * the price of one poll was rooms x population, on an endpoint the landing
   * page hits every 8 seconds. Same columns, same per-room seat ordering and
   * the same block filter as nearby(); only the statement count changes.
   *
   * Every requested room id is present in the result, empty rooms included, so
   * a caller never has to distinguish "no bodies" from "no such room".
   */
  async nearbyByRooms(roomIds: string[], viewerId?: string): Promise<Map<string, NearbyRow[]>> {
    const out = new Map<string, NearbyRow[]>();
    for (const id of roomIds) out.set(id, []);
    if (out.size === 0) return out;
    const { rows } = await this.store.pg.query(
      `SELECT p.*,
              CASE WHEN p.actor_kind = 'human' THEN h.display_name ELSE a.display_name END AS display_name,
              CASE WHEN p.actor_kind = 'human' THEN h.handle ELSE a.slug END AS slug,
              CASE WHEN p.actor_kind = 'human' THEN h.avatar_id ELSE a.avatar_id END AS avatar_id,
              CASE WHEN p.actor_kind = 'human' THEN h.lurk ELSE false END AS lurk,
              a.policy, a.claim_state, a.owner_human_id, a.autonomy_mode, oh.handle AS owner_handle
       FROM presence p
       LEFT JOIN humans h ON h.id = p.actor_id
       LEFT JOIN agents a ON a.id = p.actor_id
       LEFT JOIN humans oh ON oh.id = a.owner_human_id
       WHERE p.room_id = ANY($1::text[])
       ORDER BY p.room_id, p.seat_index`,
      [[...out.keys()]],
    );
    const blocked = await this.blockedActors(viewerId);
    for (const r of rows) {
      const actorId = r.actor_id as string;
      if (blocked.has(actorId)) continue;
      out.get(String(r.room_id))?.push(toNearbyRow(r as Record<string, unknown>));
    }
    return out;
  }

  /** Both directions of a block, so a viewer neither sees nor is seen. */
  private async blockedActors(viewerId?: string): Promise<Set<string>> {
    const blocked = new Set<string>();
    if (!viewerId) return blocked;
    const b = await this.store.pg.query(
      `SELECT blocked_id AS id FROM blocks WHERE blocker_id = $1
       UNION SELECT blocker_id FROM blocks WHERE blocked_id = $1`,
      [viewerId],
    );
    for (const r of b.rows) blocked.add(r.id as string);
    return blocked;
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
    if (room.id === "plaza" && (room.worldId ?? WORLD_ID) === WORLD_ID) {
      await this.store.redis.publish("sse:plaza", payload);
    }
  }
}

/** Back-compat: keep the coarse `activity` column meaningful for room UIs. */
const ACTIVITY_FOR_VERB: Record<AgentVerb, PresenceActivity> = {
  say: "chatting",
  tool: "working",
  read: "reading",
  wait: "listening",
  error: "error",
  blocked: "error",
  think: "idle",
  idle: "idle",
  offline: "idle",
};

/** One presence row, with its human/agent joins, as the rest of Grove reads it. */
function toNearbyRow(r: Record<string, unknown>): NearbyRow {
  const kind = r.actor_kind as "human" | "agent";
  const policy = kind === "agent" ? (toPolicy(r.policy) ?? undefined) : undefined;
  return {
    actorId: String(r.actor_id),
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
    presence: mapPresence(r),
    ownerHandle: r.owner_handle ? String(r.owner_handle) : undefined,
    policy,
    lurk: Boolean(r.lurk),
    claimState: (r.claim_state as Agent["claimState"]) ?? undefined,
    ownerHumanId: r.owner_human_id ? String(r.owner_human_id) : null,
    stance: kind === "agent" && r.autonomy_mode ? (String(r.autonomy_mode) as Agent["autonomyMode"]) : null,
  };
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

function duplicateResult(
  w: { index: number; id: string | null; n: NormalisedPulse },
  remembered: string | null,
): PulseItemResult {
  // "pending" means a racing request holds the claim and has not landed yet.
  const pulsedAt = remembered && remembered !== "pending" ? remembered : null;
  return { index: w.index, id: w.id, status: "duplicate", verb: w.n.verb, pulsedAt, clamped: false };
}

function summarise(presence: Presence | null, results: PulseItemResult[]): PulseBatchResult {
  return {
    presence,
    results,
    applied: results.filter((r) => r.status === "applied").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    refused: results.filter((r) => r.status === "refused").length,
  };
}
