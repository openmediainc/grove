import { WORLD_ID } from "@grove/protocol";
import { GroveError } from "../errors.js";
import type { GroveStore } from "../store.js";
import { roomActivityVisibleSql } from "../visibility.js";
import type { ChronicleEntry, ChronicleService, ChronicleViewer } from "./chronicle.js";
import { REPLAY_KEYFRAME_LOOKBACK_MS, type ReplayKeyframeBody, type ReplayPage } from "./replay.js";
import { toToolCallView } from "./tool-calls.js";

/**
 * Replay checkpoints (queue #63): where every PUBLIC body stood at the start of
 * each 5-minute bucket, so a deep seek reads one row plus a few minutes of the
 * ledger instead of every page of the day.
 *
 * ---------------------------------------------------------------------------
 * A CHECKPOINT NEVER BYPASSES VISIBILITY
 * ---------------------------------------------------------------------------
 * A row is what a SIGNED-OUT spectator reconstructs: it is computed by reading
 * the chronicle as the anonymous viewer, so the shared place gate
 * (visibility.ts) has already removed private spaces, private rooms and owner
 * lounges before anything is folded. It stores ids only — actor, room, when,
 * which ledger row — and the seek re-resolves names, rooms and the place gate
 * for the actual viewer at read time, so a room that closed after the row was
 * written drops out, and a renamed body reads with today's name like the
 * chronicle does.
 *
 * A viewer who may see more (a member, a lounge owner) gets it layered on top:
 * each body's latest movement in a place only they can see, applied only when
 * it is newer than the body's last public movement, then the ordinary gated
 * event stream from the checkpoint to the target.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * Movements fold in exactly the order ReplayTimeline applies them (time, then
 * departures before arrivals, then ledger id), so "checkpoint + the events after
 * it" is the same state as "play the window through to that instant". A
 * checkpoint is a function of the ledger before `at`; computing it twice writes
 * nothing the second time (ON CONFLICT DO NOTHING), and only buckets that ended
 * REPLAY_CHECKPOINT_GRACE_MS ago are computed, so a late-committing row is not
 * missed.
 */

export const REPLAY_CHECKPOINT_BUCKET_MS = 5 * 60_000;
/** A bucket is computed only once it ended this long ago. */
export const REPLAY_CHECKPOINT_GRACE_MS = 2 * 60_000;
/** Backfill never reaches further back than this. */
export const REPLAY_CHECKPOINT_BACKFILL_MS = 24 * 3600_000;
/** Rows older than the replay window (plus the lookback slack a seek may use) are pruned. */
export const REPLAY_CHECKPOINT_RETENTION_MS = 26 * 3600_000;
/** A seek uses a checkpoint at most this far before its target; else it falls back to the keyframe. */
export const REPLAY_SEEK_MAX_GAP_MS = 30 * 60_000;
/** How far past `at` one seek may also carry events (so small nudges need no second request). */
export const REPLAY_SEEK_MAX_AHEAD_MS = 10 * 60_000;
/** Buckets per tick, so a backfill of the whole day is spread over a couple of dozen ticks. */
const BUCKETS_PER_ADVANCE = 24;
const ADVANCE_EVERY_MS = 60_000;
const PRUNE_EVERY_MS = 10 * 60_000;
const PAGE = 2000;
const SEEK_PAGES = 20;

const MOVEMENT_TYPES = ["actor_joined_room", "actor_left_room"];
const ANON: ChronicleViewer = { humanId: null, isOperator: false };

/** [actor_id, room_id, entered_at_ms, event_id] */
export type CheckpointBody = [string, string | null, number, string];
/** [actor_id, event_id, left_at_ms] */
export type CheckpointGone = [string, string, number];

export interface CheckpointState {
  bodies: Map<string, { roomId: string | null; enteredAt: number; eventId: string }>;
  gone: Map<string, { eventId: string; at: number }>;
}

export interface ReplaySeekQuery {
  at: string;
  /** Optional: also carry events up to here (at most REPLAY_SEEK_MAX_AHEAD_MS past `at`). */
  until?: string | null;
  worldId: string;
}

export interface ReplaySeekPage {
  at: string;
  /** The span the entries cover: [since, until]. `since` is the checkpoint (or `at` on the fallback). */
  window: { since: string; until: string };
  worldId: string;
  /** The checkpoint used, or null when none was near enough and the keyframe was read instead. */
  checkpoint: { at: string } | null;
  keyframe: NonNullable<ReplayPage["keyframe"]>;
  /** Oldest first, gated exactly as a replay page. */
  entries: ChronicleEntry[];
  trailing: ChronicleEntry[];
  toolCalls: ReplayPage["toolCalls"];
  /** True when the gap held more events than one seek carries. */
  truncated: boolean;
}

const OP_RANK: Record<string, number> = { actor_left_room: 1, actor_joined_room: 2 };

function big(id: string): bigint {
  return /^\d+$/.test(id) ? BigInt(id) : 0n;
}

/** ReplayTimeline's step order for movements: time, departures first, then ledger id. */
export function sortMovements(entries: readonly ChronicleEntry[]): ChronicleEntry[] {
  return entries
    .filter((e) => e.actor && OP_RANK[e.type] !== undefined)
    .map((e) => ({ e, at: Date.parse(e.createdAt), id: big(e.id) }))
    .sort((p, q) => p.at - q.at || OP_RANK[p.e.type]! - OP_RANK[q.e.type]! || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))
    .map((x) => x.e);
}

/** Fold movements into a state, in timeline order. Mutates and returns `state`. */
export function foldMovements(state: CheckpointState, entries: readonly ChronicleEntry[]): CheckpointState {
  for (const e of sortMovements(entries)) {
    const actorId = e.actor!.id;
    const at = Date.parse(e.createdAt);
    if (e.type === "actor_joined_room") {
      state.bodies.set(actorId, { roomId: e.roomId, enteredAt: at, eventId: e.id });
      state.gone.delete(actorId);
    } else {
      state.bodies.delete(actorId);
      state.gone.set(actorId, { eventId: e.id, at });
    }
  }
  return state;
}

export function encodeState(state: CheckpointState): { bodies: CheckpointBody[]; gone: CheckpointGone[] } {
  const bodies = [...state.bodies.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, b]) => [id, b.roomId, b.enteredAt, b.eventId] as CheckpointBody);
  const gone = [...state.gone.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, g]) => [id, g.eventId, g.at] as CheckpointGone);
  return { bodies, gone };
}

export function decodeState(bodies: unknown, gone: unknown): CheckpointState {
  const state: CheckpointState = { bodies: new Map(), gone: new Map() };
  for (const b of Array.isArray(bodies) ? bodies : []) {
    if (!Array.isArray(b) || typeof b[0] !== "string") continue;
    state.bodies.set(b[0], { roomId: typeof b[1] === "string" ? b[1] : null, enteredAt: Number(b[2]), eventId: String(b[3]) });
  }
  for (const g of Array.isArray(gone) ? gone : []) {
    if (!Array.isArray(g) || typeof g[0] !== "string") continue;
    state.gone.set(g[0], { eventId: String(g[1]), at: Number(g[2]) });
  }
  return state;
}

function isoOf(value: string | null | undefined, field: string): number {
  const t = Date.parse(String(value ?? ""));
  if (!value || Number.isNaN(t)) throw new GroveError("INVALID", `${field} must be an ISO timestamp.`);
  return t;
}

function audible(entries: ChronicleEntry[]): ChronicleEntry[] {
  return entries.filter((e) => e.type !== "speech" || e.body !== null);
}

/**
 * Checkpoint bodies as this viewer may see them now: today's names, rooms that
 * still exist in this world, the shared place gate for THIS viewer, and rule 5
 * (a pending agent is nobody's business but its owner's).
 */
const RESOLVE_SQL = `
SELECT b.actor_id, b.room_id, b.entered_at, b.event_id, r.name AS room_name,
       CASE WHEN hu.id IS NOT NULL THEN 'human' WHEN ag.id IS NOT NULL THEN 'agent' ELSE 'unknown' END AS actor_kind,
       COALESCE(hu.display_name, ag.display_name) AS actor_name,
       COALESCE(hu.handle::text, ag.slug::text) AS actor_slug
FROM jsonb_array_elements($1::jsonb) el
CROSS JOIN LATERAL (SELECT el->>0 AS actor_id, el->>1 AS room_id, (el->>2)::bigint AS entered_at, el->>3 AS event_id) b
JOIN rooms r ON r.id = b.room_id
LEFT JOIN worlds rw ON rw.id = r.world_id
LEFT JOIN humans hu ON hu.id = b.actor_id
LEFT JOIN agents ag ON ag.id = b.actor_id
WHERE COALESCE(r.world_id, $3::text) = $2::text
  AND ${roomActivityVisibleSql("r", "rw", "$4")}
  AND (ag.id IS NULL OR ag.claim_state IS DISTINCT FROM 'pending' OR $5::bool OR ag.owner_human_id = $4::text)`;

export class ReplayCheckpointService {
  private lastAdvance = 0;
  private lastPrune = 0;

  constructor(
    private store: GroveStore,
    private chronicle: ChronicleService,
  ) {}

  /**
   * The checkpoint for `world` at `atMs`, computed if missing. Chains from the
   * latest earlier checkpoint within the lookback; otherwise bootstraps from the
   * anonymous keyframe (each body's last public movement in the lookback).
   */
  async computeAt(worldId: string, atMs: number): Promise<{ created: boolean; bodies: number; events: number }> {
    const at = new Date(atMs).toISOString();
    const { rows: existing } = await this.store.pg.query(
      `SELECT jsonb_array_length(bodies) AS n, events FROM replay_checkpoints WHERE world_id = $1 AND at = $2::timestamptz`,
      [worldId, at],
    );
    if (existing[0]) return { created: false, bodies: Number(existing[0].n), events: Number(existing[0].events) };

    const { rows: prevRows } = await this.store.pg.query(
      `SELECT at, bodies, gone FROM replay_checkpoints
        WHERE world_id = $1 AND at < $2::timestamptz AND at >= $3::timestamptz
        ORDER BY at DESC LIMIT 1`,
      [worldId, at, new Date(atMs - REPLAY_KEYFRAME_LOOKBACK_MS).toISOString()],
    );
    let state: CheckpointState;
    let events = 0;
    if (prevRows[0]) {
      state = decodeState(prevRows[0].bodies, prevRows[0].gone);
      const since = new Date(prevRows[0].at as string).toISOString();
      const entries: ChronicleEntry[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await this.chronicle.read(
          ANON,
          { since, until: at, worldId, types: MOVEMENT_TYPES, cursor, limit: PAGE, order: "asc" },
          { maxLimit: PAGE, withTotals: false },
        );
        entries.push(...page.entries);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      events = entries.length;
      foldMovements(state, entries);
    } else {
      const moves = await this.chronicle.lastMovements(ANON, {
        since: new Date(atMs - REPLAY_KEYFRAME_LOOKBACK_MS).toISOString(),
        until: at,
        worldId,
        limit: 5000,
      });
      events = moves.length;
      state = foldMovements({ bodies: new Map(), gone: new Map() }, moves);
    }
    // A departure older than the lookback can no longer decide an overlay.
    for (const [id, g] of state.gone) if (g.at < atMs - REPLAY_KEYFRAME_LOOKBACK_MS) state.gone.delete(id);
    const encoded = encodeState(state);
    const { rowCount } = await this.store.pg.query(
      `INSERT INTO replay_checkpoints (world_id, at, bodies, gone, events)
       VALUES ($1, $2::timestamptz, $3::jsonb, $4::jsonb, $5)
       ON CONFLICT (world_id, at) DO NOTHING`,
      [worldId, at, JSON.stringify(encoded.bodies), JSON.stringify(encoded.gone), events],
    );
    return { created: (rowCount ?? 0) > 0, bodies: encoded.bodies.length, events };
  }

  /**
   * Compute the next completed buckets for `world`, oldest first, at most
   * `maxBuckets`. Resumable: it always continues after the latest checkpoint,
   * and never reaches further back than REPLAY_CHECKPOINT_BACKFILL_MS.
   */
  async advance(
    worldId: string = WORLD_ID,
    now: number = Date.now(),
    maxBuckets: number = BUCKETS_PER_ADVANCE,
  ): Promise<number> {
    const B = REPLAY_CHECKPOINT_BUCKET_MS;
    const lastDue = Math.floor((now - REPLAY_CHECKPOINT_GRACE_MS) / B) * B;
    const floor = Math.ceil((now - REPLAY_CHECKPOINT_BACKFILL_MS) / B) * B;
    const { rows } = await this.store.pg.query(`SELECT max(at) AS at FROM replay_checkpoints WHERE world_id = $1`, [worldId]);
    const latest = rows[0]?.at ? new Date(rows[0].at as string).getTime() : null;
    let next = latest === null || latest < floor ? floor : Math.floor(latest / B) * B + B;
    let done = 0;
    while (next <= lastDue && done < maxBuckets) {
      const r = await this.computeAt(worldId, next);
      if (r.created) done++;
      next += B;
    }
    return done;
  }

  /** Delete checkpoints older than the replay window. */
  async prune(now: number = Date.now()): Promise<number> {
    const { rowCount } = await this.store.pg.query(`DELETE FROM replay_checkpoints WHERE at < $1::timestamptz`, [
      new Date(now - REPLAY_CHECKPOINT_RETENTION_MS).toISOString(),
    ]);
    return rowCount ?? 0;
  }

  /** For the tick: advance the commons at most once a minute, prune every ten. */
  async maybeAdvance(now: number = Date.now()): Promise<void> {
    if (now - this.lastAdvance < ADVANCE_EVERY_MS) return;
    this.lastAdvance = now;
    await this.advance(WORLD_ID, now);
    if (now - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = now;
      await this.prune(now);
    }
  }

  /**
   * GET /api/v1/replay/seek: the nearest checkpoint at or before `at`, resolved
   * for this viewer, plus every event this viewer may see from it to `until`
   * (default `at`). Falls back to the replay keyframe at `at` when no checkpoint
   * is near enough.
   */
  async seek(viewer: ChronicleViewer, query: ReplaySeekQuery): Promise<ReplaySeekPage> {
    const atMs = isoOf(query.at, "at");
    const untilMs = query.until ? isoOf(query.until, "until") : atMs;
    if (untilMs < atMs) throw new GroveError("INVALID", "until must not be before at.");
    if (untilMs - atMs > REPLAY_SEEK_MAX_AHEAD_MS) throw new GroveError("INVALID", "until may be at most 10 minutes after at.");
    if (atMs > Date.now() + 60_000) throw new GroveError("INVALID", "at must not be in the future.");
    const worldId = query.worldId;
    // Events at exactly `until` belong to the frame at `until` (a timeline
    // applies every step at or before t), and the chronicle's upper bound is
    // exclusive.
    const endIso = new Date(untilMs + 1).toISOString();

    const { rows: cpRows } = await this.store.pg.query(
      `SELECT at, bodies, gone FROM replay_checkpoints
        WHERE world_id = $1 AND at <= $2::timestamptz AND at >= $3::timestamptz
        ORDER BY at DESC LIMIT 1`,
      [worldId, new Date(atMs).toISOString(), new Date(atMs - REPLAY_SEEK_MAX_GAP_MS).toISOString()],
    );
    const cp = cpRows[0] as { at: string; bodies: unknown; gone: unknown } | undefined;
    const sinceMs = cp ? new Date(cp.at).getTime() : atMs;
    const since = new Date(sinceMs).toISOString();
    const lookbackSince = new Date(sinceMs - REPLAY_KEYFRAME_LOOKBACK_MS).toISOString();

    const keyframeBodies = cp
      ? await this.checkpointBodies(viewer, worldId, since, lookbackSince, cp)
      : (await this.chronicle.lastMovements(viewer, { since: lookbackSince, until: since, worldId }))
          .filter((m) => m.type === "actor_joined_room" && m.actor)
          .map((m) => keyframeBodyOf(m, Date.parse(m.createdAt)));
    keyframeBodies.sort((a, b) => (big(a.eventId) < big(b.eventId) ? -1 : big(a.eventId) > big(b.eventId) ? 1 : a.actorId < b.actorId ? -1 : 1));

    const entries: ChronicleEntry[] = [];
    let cursor: string | null = null;
    let truncated = false;
    for (let i = 0; i < SEEK_PAGES; i++) {
      const page = await this.chronicle.read(
        viewer,
        { since, until: endIso, worldId, cursor, limit: 1000, order: "asc" },
        { maxLimit: 1000, withTotals: false },
      );
      entries.push(...audible(page.entries));
      cursor = page.nextCursor;
      if (!cursor) break;
      if (i === SEEK_PAGES - 1) truncated = true;
    }

    const [trailingPage, spanRows] = await Promise.all([
      this.chronicle.read(
        viewer,
        {
          since: endIso,
          until: new Date(untilMs + 1 + REPLAY_KEYFRAME_LOOKBACK_MS).toISOString(),
          worldId,
          types: ["agent_phase"],
          limit: 1000,
          order: "asc",
        },
        { maxLimit: 1000, withTotals: false },
      ),
      this.chronicle.toolCallHistory(viewer, { since, until: endIso, worldId }),
    ]);
    const trailing = trailingPage.entries.filter((e) => {
      const started = Date.parse(String(e.detail.started_at ?? ""));
      return Number.isFinite(started) && started <= untilMs;
    });
    const toolCalls = spanRows.map((r) => ({
      ...toToolCallView(r as Parameters<typeof toToolCallView>[0], untilMs),
      actorId: String(r.actor_id),
    }));

    return {
      at: new Date(atMs).toISOString(),
      window: { since, until: new Date(untilMs).toISOString() },
      worldId,
      checkpoint: cp ? { at: since } : null,
      keyframe: { at: since, lookbackSince, bodies: keyframeBodies },
      entries,
      trailing,
      toolCalls,
      truncated,
    };
  }

  /** The public checkpoint resolved for this viewer, with their private-place movements layered on. */
  private async checkpointBodies(
    viewer: ChronicleViewer,
    worldId: string,
    since: string,
    lookbackSince: string,
    cp: { bodies: unknown; gone: unknown },
  ): Promise<ReplayKeyframeBody[]> {
    const state = decodeState(cp.bodies, cp.gone);
    const { rows } = await this.store.pg.query(RESOLVE_SQL, [
      JSON.stringify(encodeState(state).bodies),
      worldId,
      WORLD_ID,
      viewer.humanId,
      viewer.isOperator,
    ]);
    const out = new Map<string, ReplayKeyframeBody>();
    for (const r of rows as Array<Record<string, unknown>>) {
      const kind = String(r.actor_kind);
      out.set(String(r.actor_id), {
        actorId: String(r.actor_id),
        kind: kind === "human" || kind === "agent" ? kind : "unknown",
        displayName: r.actor_name ? String(r.actor_name) : "someone since departed",
        slug: r.actor_slug ? String(r.actor_slug) : null,
        roomId: String(r.room_id),
        roomName: r.room_name ? String(r.room_name) : null,
        since: new Date(Number(r.entered_at)).toISOString(),
        eventId: String(r.event_id),
      });
    }

    const overlay = await this.chronicle.lastPrivateMovements(viewer, { since: lookbackSince, until: since, worldId });
    for (const m of sortMovements(overlay)) {
      const actorId = m.actor!.id;
      const lastPublic = state.bodies.get(actorId)?.eventId ?? state.gone.get(actorId)?.eventId ?? null;
      // A public movement after this one already decided where the body is.
      if (lastPublic !== null && big(m.id) < big(lastPublic)) continue;
      if (m.type === "actor_joined_room") out.set(actorId, keyframeBodyOf(m, Date.parse(m.createdAt)));
      else out.delete(actorId);
    }
    return [...out.values()];
  }
}

function keyframeBodyOf(m: ChronicleEntry, at: number): ReplayKeyframeBody {
  return {
    actorId: m.actor!.id,
    kind: m.actor!.kind,
    displayName: m.actor!.displayName,
    slug: m.actor!.slug,
    roomId: m.roomId,
    roomName: m.roomName,
    since: new Date(at).toISOString(),
    eventId: m.id,
  };
}
