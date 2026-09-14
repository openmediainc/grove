import {
  WORLD_ID,
  plotForIndex,
  readStoredBranding,
  readStoredCard,
  type CardFields,
  type SpaceBranding,
} from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { roomActivityVisibleSql, spaceVisibleSql, visibleOccupancySql } from "../visibility.js";

/**
 * Discovery on Explore (queue #40): the adapted leaderboard.
 *
 * Three shelves, all ACTIVITY and never money, and never a rank number:
 *   - Busiest plots: non-private spaces by what happened in their public rooms
 *     over the last 24h (distinct speakers + tool-call spans + distinct visitors).
 *   - Most-watched agents: claimed agents by new follows plus reactions to their
 *     lines in public rooms over the last 7 days.
 *   - Just arrived: non-private spaces created and agents claimed in the last 7 days.
 *
 * ONE PUBLIC LISTING. Every shelf is computed as a signed-out visitor sees the
 * world (viewer NULL through queue #50's shared place predicate), for everyone:
 * a private space never appears, not even for its own members, and activity in
 * a private room or an owner's lounge never counts toward a public space's score.
 * That is also what makes it cacheable: nothing in the answer depends on who asks.
 *
 * CHEAP. The whole answer is kept in the kv store for DISCOVERY_CACHE_SECONDS,
 * so the three reads run at most once a minute per deploy, not per request.
 * Each read is a range scan on an existing time index (speech_created_at 031,
 * tool_calls_finished / tool_calls_open 020, world_events_type_time 001,
 * follows_created_at / reactions_created_at 031).
 *
 * The SQL returns candidates with their raw counts; the ORDER is the pure
 * `orderShelf` below (metric desc, ties by most recent activity, then id), so
 * ordering is tested without a database and cannot drift between shelves.
 */

export const DISCOVERY_CACHE_KEY = "discovery:v1";
export const DISCOVERY_CACHE_SECONDS = 60;
/** What a shelf shows before "More". The page owns that cut; the API sends up to DISCOVERY_SHELF_MAX. */
export const DISCOVERY_SHELF_VISIBLE = 8;
export const DISCOVERY_SHELF_MAX = 24;
/** Candidates read per shelf before ordering. */
const CANDIDATES = 100;

export interface DiscoverySpace {
  kind: "space";
  id: string;
  slug: string;
  name: string;
  policyPreset: string;
  ownerHandle: string | null;
  plotIndex: number | null;
  /** The plot's centre tile, for a `?at=` jump. Null without a plot. */
  at: { tx: number; ty: number } | null;
  branding: SpaceBranding | null;
  card: CardFields;
  /** Bodies standing in its public rooms now. */
  hereNow: number;
  createdAt: string;
}

export interface BusyPlot extends DiscoverySpace {
  speakers: number;
  spans: number;
  visitors: number;
  lastActiveAt: string | null;
}

export interface DiscoveryAgent {
  kind: "agent";
  id: string;
  slug: string;
  name: string;
  ownerHandle: string | null;
  card: CardFields;
  followers: number;
  claimedAt: string | null;
}

export interface WatchedAgent extends DiscoveryAgent {
  followsWeek: number;
  reactionsWeek: number;
  lastActiveAt: string | null;
}

export type ArrivalItem = (DiscoverySpace & { arrivedAt: string }) | (DiscoveryAgent & { arrivedAt: string });

export interface Discovery {
  busiestPlots: BusyPlot[];
  mostWatchedAgents: WatchedAgent[];
  justArrived: ArrivalItem[];
  generatedAt: string;
  /** Seconds the answer is kept. */
  ttlSeconds: number;
}

// ---------------------------------------------------------------------------
// Pure ordering.
// ---------------------------------------------------------------------------

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * A shelf's order: the metric, highest first; a tie goes to whatever happened
 * most recently; then the id, so two identical rows never swap between reads.
 * Rows with a zero metric are dropped (a shelf of nothing happening is empty).
 */
export function orderShelf<T extends { id: string }>(
  items: T[],
  metric: (t: T) => number,
  recency: (t: T) => string | null,
  cap = DISCOVERY_SHELF_MAX,
): T[] {
  return items
    .filter((t) => metric(t) > 0)
    .sort((a, b) => metric(b) - metric(a) || ms(recency(b)) - ms(recency(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, cap);
}

export const plotScore = (p: Pick<BusyPlot, "speakers" | "spans" | "visitors">) => p.speakers + p.spans + p.visitors;
export const watchScore = (a: Pick<WatchedAgent, "followsWeek" | "reactionsWeek">) => a.followsWeek + a.reactionsWeek;

/** Newest first, ties by id. */
export function orderArrivals(items: ArrivalItem[], cap = DISCOVERY_SHELF_MAX): ArrivalItem[] {
  return [...items]
    .sort((a, b) => ms(b.arrivedAt) - ms(a.arrivedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, cap);
}

export function plotCentre(plotIndex: number | null): { tx: number; ty: number } | null {
  if (plotIndex == null || !Number.isFinite(plotIndex) || plotIndex < 0) return null;
  const r = plotForIndex(plotIndex);
  return { tx: Math.round((r.x0 + r.x1) / 2), ty: Math.round((r.y0 + r.y1) / 2) };
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

function iso(v: unknown): string | null {
  return v == null ? null : new Date(String(v)).toISOString();
}

/** A non-private, live, claimed space as a signed-out visitor sees it. */
const PUBLIC_SPACE = (w: string) =>
  `(${w}.id <> '${WORLD_ID}' AND ${w}.archived_at IS NULL AND ${spaceVisibleSql(w, "NULL")})`;

const SPACE_COLUMNS = `
  w.id, w.slug::text AS slug, w.name, w.policy_preset, w.plot_index, w.branding, w.card, w.created_at,
  oh.handle::text AS owner_handle,
  ${visibleOccupancySql("w", "NULL")} AS here_now`;

const AGENT_COLUMNS = `
  a.id, a.slug::text AS slug, a.display_name, a.card, a.claimed_at,
  oh.handle::text AS owner_handle,
  (SELECT count(*)::int FROM follows fc WHERE fc.subject_kind = 'agent' AND fc.subject_id = a.id) AS followers`;

/** A claimed agent whose owner (if any) is not suspended: as public as /a/:slug. */
const PUBLIC_AGENT = `(a.claim_state = 'claimed' AND (oh.id IS NULL OR oh.suspended_at IS NULL))`;

function toSpace(r: Record<string, unknown>): DiscoverySpace {
  const plotIndex = r.plot_index == null ? null : Number(r.plot_index);
  return {
    kind: "space",
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    policyPreset: String(r.policy_preset),
    ownerHandle: r.owner_handle ? String(r.owner_handle) : null,
    plotIndex,
    at: plotCentre(plotIndex),
    branding: readStoredBranding(r.branding),
    card: readStoredCard(r.card),
    hereNow: Number(r.here_now ?? 0),
    createdAt: iso(r.created_at) ?? new Date(0).toISOString(),
  };
}

function toAgent(r: Record<string, unknown>): DiscoveryAgent {
  return {
    kind: "agent",
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.display_name),
    ownerHandle: r.owner_handle ? String(r.owner_handle) : null,
    card: readStoredCard(r.card),
    followers: Number(r.followers ?? 0),
    claimedAt: iso(r.claimed_at),
  };
}

export class DiscoveryService {
  constructor(private store: GroveStore) {}

  /** The shelves, from the kv cache when fresh. `fresh` skips the cache (tests, operators). */
  async discovery(opts: { fresh?: boolean } = {}): Promise<Discovery> {
    if (!opts.fresh) {
      try {
        const hit = await this.store.redis.get(DISCOVERY_CACHE_KEY);
        if (hit) return JSON.parse(hit) as Discovery;
      } catch {
        // A cache miss, not an outage: compute.
      }
    }
    const [busiestPlots, mostWatchedAgents, justArrived] = await Promise.all([
      this.busiestPlots(),
      this.mostWatchedAgents(),
      this.justArrived(),
    ]);
    const out: Discovery = {
      busiestPlots,
      mostWatchedAgents,
      justArrived,
      generatedAt: new Date().toISOString(),
      ttlSeconds: DISCOVERY_CACHE_SECONDS,
    };
    try {
      await this.store.redis.set(DISCOVERY_CACHE_KEY, JSON.stringify(out), "EX", DISCOVERY_CACHE_SECONDS);
    } catch {
      // Serve it uncached.
    }
    return out;
  }

  async busiestPlots(cap = DISCOVERY_SHELF_MAX): Promise<BusyPlot[]> {
    const place = roomActivityVisibleSql("r", "w", "NULL");
    const { rows } = await this.store.pg.query(
      `WITH speakers AS (
         SELECT r.world_id, count(DISTINCT s.sender_id)::int AS n, max(s.created_at) AS last
           FROM speech s
           JOIN rooms r ON r.id = s.room_id
           JOIN worlds w ON w.id = r.world_id
          WHERE s.created_at > now() - interval '24 hours'
            AND s.channel = 'room_say'
            AND ${PUBLIC_SPACE("w")} AND ${place}
          GROUP BY 1
       ), spans AS (
         SELECT r.world_id, count(*)::int AS n, max(COALESCE(t.finished_at, t.started_at)) AS last
           FROM tool_calls t
           JOIN rooms r ON r.id = t.room_id
           JOIN worlds w ON w.id = r.world_id
          WHERE (t.finished_at > now() - interval '24 hours'
                 OR (t.finished_at IS NULL AND t.started_at > now() - interval '24 hours'))
            AND ${PUBLIC_SPACE("w")} AND ${place}
          GROUP BY 1
       ), visitors AS (
         SELECT r.world_id, count(DISTINCT e.actor_id)::int AS n, max(e.created_at) AS last
           FROM world_events e
           JOIN rooms r ON r.id = e.payload->>'room'
           JOIN worlds w ON w.id = r.world_id
          WHERE e.type = 'actor_joined_room'
            AND e.created_at > now() - interval '24 hours'
            AND ${PUBLIC_SPACE("w")} AND ${place}
          GROUP BY 1
       ), scored AS (
         SELECT COALESCE(sp.world_id, tc.world_id, vi.world_id) AS world_id,
                COALESCE(sp.n, 0) AS speakers, COALESCE(tc.n, 0) AS spans, COALESCE(vi.n, 0) AS visitors,
                GREATEST(sp.last, tc.last, vi.last) AS last_active
           FROM speakers sp
           FULL JOIN spans tc ON tc.world_id = sp.world_id
           FULL JOIN visitors vi ON vi.world_id = COALESCE(sp.world_id, tc.world_id)
       )
       SELECT ${SPACE_COLUMNS}, sc.speakers, sc.spans, sc.visitors, sc.last_active
         FROM scored sc
         JOIN worlds w ON w.id = sc.world_id
         LEFT JOIN humans oh ON oh.id = w.owner_human_id
        WHERE ${PUBLIC_SPACE("w")}
        ORDER BY (sc.speakers + sc.spans + sc.visitors) DESC, sc.last_active DESC NULLS LAST
        LIMIT ${Math.max(cap, CANDIDATES)}`,
    );
    const plots: BusyPlot[] = rows.map((r) => ({
      ...toSpace(r),
      speakers: Number(r.speakers),
      spans: Number(r.spans),
      visitors: Number(r.visitors),
      lastActiveAt: iso(r.last_active),
    }));
    return orderShelf(plots, plotScore, (p) => p.lastActiveAt, cap);
  }

  async mostWatchedAgents(cap = DISCOVERY_SHELF_MAX): Promise<WatchedAgent[]> {
    const { rows } = await this.store.pg.query(
      `WITH f AS (
         SELECT subject_id AS id, count(*)::int AS n, max(created_at) AS last
           FROM follows
          WHERE subject_kind = 'agent' AND created_at > now() - interval '7 days'
          GROUP BY 1
       ), rx AS (
         SELECT s.sender_id AS id, count(*)::int AS n, max(x.created_at) AS last
           FROM reactions x
           JOIN speech s ON x.target_kind = 'speech' AND s.id = x.target_id
           JOIN rooms r ON r.id = s.room_id
           LEFT JOIN worlds w ON w.id = r.world_id
          WHERE x.created_at > now() - interval '7 days'
            AND s.sender_kind = 'agent'
            AND s.channel = 'room_say'
            AND (w.id IS NULL OR w.archived_at IS NULL)
            AND ${roomActivityVisibleSql("r", "w", "NULL")}
          GROUP BY 1
       ), scored AS (
         SELECT COALESCE(f.id, rx.id) AS id, COALESCE(f.n, 0) AS follows_week, COALESCE(rx.n, 0) AS reactions_week,
                GREATEST(f.last, rx.last) AS last_active
           FROM f FULL JOIN rx ON rx.id = f.id
       )
       SELECT ${AGENT_COLUMNS}, sc.follows_week, sc.reactions_week, sc.last_active
         FROM scored sc
         JOIN agents a ON a.id = sc.id
         LEFT JOIN humans oh ON oh.id = a.owner_human_id
        WHERE ${PUBLIC_AGENT}
        ORDER BY (sc.follows_week + sc.reactions_week) DESC, sc.last_active DESC NULLS LAST
        LIMIT ${Math.max(cap, CANDIDATES)}`,
    );
    const agents: WatchedAgent[] = rows.map((r) => ({
      ...toAgent(r),
      followsWeek: Number(r.follows_week),
      reactionsWeek: Number(r.reactions_week),
      lastActiveAt: iso(r.last_active),
    }));
    return orderShelf(agents, watchScore, (a) => a.lastActiveAt, cap);
  }

  async justArrived(cap = DISCOVERY_SHELF_MAX): Promise<ArrivalItem[]> {
    const [spaces, agents] = await Promise.all([
      this.store.pg.query(
        `SELECT ${SPACE_COLUMNS}
           FROM worlds w LEFT JOIN humans oh ON oh.id = w.owner_human_id
          WHERE w.created_at > now() - interval '7 days' AND ${PUBLIC_SPACE("w")}
          ORDER BY w.created_at DESC
          LIMIT ${cap}`,
      ),
      this.store.pg.query(
        `SELECT ${AGENT_COLUMNS}
           FROM agents a LEFT JOIN humans oh ON oh.id = a.owner_human_id
          WHERE a.claimed_at > now() - interval '7 days' AND ${PUBLIC_AGENT}
          ORDER BY a.claimed_at DESC
          LIMIT ${cap}`,
      ),
    ]);
    const items: ArrivalItem[] = [
      ...spaces.rows.map((r) => {
        const s = toSpace(r);
        return { ...s, arrivedAt: s.createdAt };
      }),
      ...agents.rows.map((r) => {
        const a = toAgent(r);
        return { ...a, arrivedAt: a.claimedAt ?? new Date(0).toISOString() };
      }),
    ];
    return orderArrivals(items, cap);
  }
}
