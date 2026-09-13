import { GroveError } from "../errors.js";
import type { ChronicleDensity, ChronicleEntry, ChronicleService, ChronicleViewer } from "./chronicle.js";

/**
 * Replay: the last hour (or day) of the world, in order, for the map to play.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A READER, NOT A SECOND GATE
 * ---------------------------------------------------------------------------
 * Every row this returns comes out of ChronicleService, which decides in SQL
 * who may see what (private spaces, whispers, speech bodies by delivery,
 * moderation grading, unknown types fail closed). Replay adds ORDER and SHAPE —
 * forward paging, a starting keyframe, a density histogram — and no rule of its
 * own. That is the whole design: a second copy of the visibility rules would be
 * a second place to get one wrong, and "a viewer must never see in replay what
 * they could not have seen live" is exactly the promise the chronicle already
 * keeps for history.
 *
 * Why the chronicle's gate and not a re-run of the live policy kernel over old
 * rows: the kernel answers with TODAY's permissions. A line said while you were
 * blocked would become audible in replay the moment the block lifted.
 * `speech_deliveries` is the world's own record, frozen at say-time, of who was
 * allowed to hear each line, and the chronicle reads bodies from it. Replay
 * therefore shows a body exactly when the moment itself delivered it.
 *
 * Where replay is deliberately NARROWER than live:
 *   - Pulse verbs. The live minimap publishes one instant per body; a retained
 *     series of them is the owner's (chronicle rule 7). A stranger replaying the
 *     night sees bodies move and speak but not their working captions.
 *   - Signed-out speech. The anonymous Plaza SSE carries spectator lines live;
 *     the chronicle gives an anonymous reader no speech at all. Replay inherits
 *     the stricter answer rather than widening the chronicle for it.
 *
 * ---------------------------------------------------------------------------
 * SHAPE
 * ---------------------------------------------------------------------------
 * The first page (no cursor) carries three extra things:
 *   keyframe  where every visible body stood at `since`: each actor's last
 *             visible join/leave in the KEYFRAME_LOOKBACK before the window.
 *             A body that entered before the lookback and never moved since is
 *             not drawn — the honest limit of a ledger with no snapshots.
 *   density   visible events per bucket, so the scrubber can draw activity
 *             before the events themselves have finished loading.
 *   trailing  work spans that began inside the window but whose row landed
 *             after it (a span's row is written when the stretch closes).
 * Later pages carry only `entries`, oldest first, keyset-paged on the ledger id.
 *
 * Scrubbing does not re-read: the client builds checkpoints over the loaded
 * events (packages/protocol/src/replay.ts), so seeking is "nearest checkpoint +
 * a few hundred events", never "replay from zero".
 */

/** The longest window one replay may ask for. "The last day" and no more. */
export const REPLAY_MAX_WINDOW_MS = 24 * 3600 * 1000;
/** How far before `since` the keyframe looks for each body's last movement. */
export const REPLAY_KEYFRAME_LOOKBACK_MS = 24 * 3600 * 1000;
/** How long after `until` a span may close and still belong to the window. */
const TRAILING_SPAN_MS = 24 * 3600 * 1000;
const PAGE_DEFAULT = 500;
const PAGE_MAX = 1000;
/** Aim for about this many density buckets across a window. */
const DENSITY_TARGET_BUCKETS = 120;

export interface ReplayQuery {
  since: string;
  until: string;
  worldId: string;
  cursor?: string | null;
  limit?: number | null;
}

export interface ReplayKeyframeBody {
  actorId: string;
  kind: "human" | "agent" | "unknown";
  displayName: string;
  slug: string | null;
  roomId: string | null;
  roomName: string | null;
  /** When the movement that put it there happened. */
  since: string;
  eventId: string;
}

export interface ReplayPage {
  window: { since: string; until: string };
  worldId: string;
  keyframe: { at: string; lookbackSince: string; bodies: ReplayKeyframeBody[] } | null;
  density: ChronicleDensity | null;
  trailing: ChronicleEntry[];
  /** Oldest first. */
  entries: ChronicleEntry[];
  nextCursor: string | null;
}

function iso(value: string, field: string): number {
  const t = Date.parse(value);
  if (!value || Number.isNaN(t)) throw new GroveError("INVALID", `${field} must be an ISO timestamp.`);
  return t;
}

/** Pick a bucket width a person would choose: 10s, 30s, 1m, 5m, 10m, 15m, 30m, 1h. */
export function densityBucketSeconds(windowMs: number): number {
  const raw = windowMs / 1000 / DENSITY_TARGET_BUCKETS;
  for (const step of [10, 30, 60, 300, 600, 900, 1800, 3600]) if (raw <= step) return step;
  return 3600;
}

export class ReplayService {
  constructor(private chronicle: ChronicleService) {}

  async window(viewer: ChronicleViewer, query: ReplayQuery): Promise<ReplayPage> {
    const sinceMs = iso(query.since, "since");
    const untilMs = iso(query.until, "until");
    if (untilMs <= sinceMs) throw new GroveError("INVALID", "until must be after since.");
    if (untilMs - sinceMs > REPLAY_MAX_WINDOW_MS) {
      throw new GroveError("INVALID", "A replay window may be at most 24 hours.");
    }
    const since = new Date(sinceMs).toISOString();
    const until = new Date(untilMs).toISOString();
    const worldId = query.worldId;
    const limit = Math.max(1, Math.min(PAGE_MAX, Math.trunc(Number(query.limit ?? PAGE_DEFAULT)) || PAGE_DEFAULT));
    const first = !query.cursor;

    const page = await this.chronicle.read(
      viewer,
      { since, until, worldId, cursor: query.cursor ?? null, limit, order: "asc" },
      { maxLimit: PAGE_MAX, withTotals: false },
    );

    if (!first) {
      return {
        window: { since, until },
        worldId,
        keyframe: null,
        density: null,
        trailing: [],
        entries: page.entries,
        nextCursor: page.nextCursor,
      };
    }

    const lookbackSince = new Date(sinceMs - REPLAY_KEYFRAME_LOOKBACK_MS).toISOString();
    const [moves, density, trailingPage] = await Promise.all([
      this.chronicle.lastMovements(viewer, { since: lookbackSince, until: since, worldId }),
      this.chronicle.density(viewer, {
        since,
        until,
        worldId,
        bucketSeconds: densityBucketSeconds(untilMs - sinceMs),
      }),
      this.chronicle.read(
        viewer,
        {
          since: until,
          until: new Date(untilMs + TRAILING_SPAN_MS).toISOString(),
          worldId,
          types: ["agent_phase"],
          limit: PAGE_MAX,
          order: "asc",
        },
        { maxLimit: PAGE_MAX, withTotals: false },
      ),
    ]);

    const bodies: ReplayKeyframeBody[] = moves
      .filter((m) => m.type === "actor_joined_room" && m.actor)
      .map((m) => ({
        actorId: m.actor!.id,
        kind: m.actor!.kind,
        displayName: m.actor!.displayName,
        slug: m.actor!.slug,
        roomId: m.roomId,
        roomName: m.roomName,
        since: m.createdAt,
        eventId: m.id,
      }))
      // Stable, id-ordered: the same window always yields the same keyframe.
      .sort((a, b) => (BigInt(a.eventId) < BigInt(b.eventId) ? -1 : 1));

    const trailing = trailingPage.entries.filter((e) => {
      const started = Date.parse(String(e.detail.started_at ?? ""));
      return Number.isFinite(started) && started < untilMs;
    });

    return {
      window: { since, until },
      worldId,
      keyframe: { at: since, lookbackSince, bodies },
      density,
      trailing,
      entries: page.entries,
      nextCursor: page.nextCursor,
    };
  }
}
