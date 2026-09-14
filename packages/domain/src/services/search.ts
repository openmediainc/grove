import { WORLD_ID, ringForPlotIndex } from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { visibleOccupancySql } from "../visibility.js";
import type { CampusService } from "./campus.js";

/**
 * `/` search: agents, humans, spaces and rooms by name, plus who is online now.
 *
 * The rule is the one every other public read already follows, applied before
 * anything leaves this file rather than redacted afterwards:
 *
 *  - A `private` space is not a result for anyone outside it. Not a redacted
 *    row, not a count: absent, exactly as a space that does not exist. Its
 *    owner and members find it.
 *  - A room is a result when the viewer could walk in or watch: a commons room
 *    (never an owner lounge), any room of a space they belong to, or a room of
 *    a non-private space whose own door admits non-members (campus.visitableRoom,
 *    the same rule the room routes use). A lobby opened on a private plot is left
 *    out for non-members: it would be a result with no space around it to name.
 *  - People and agents are as public as /u/:handle and /a/:slug (pending agents
 *    and suspended people are not). Where they ARE is only ever read off the
 *    public commons minimap, so a body standing in a private space shows no
 *    location and is not in "online now". Owner handles and space membership are
 *    never searched, so a query cannot confirm who is behind a private door.
 */

export const SEARCH_QUERY_MAX = 64;
export const SEARCH_LIMIT = 8;
export const ONLINE_LIMIT = 60;

export interface SearchBody {
  kind: "agent" | "human";
  slug: string;
  name: string;
  /** Present only when the body stands on the public commons map. */
  roomSlug: string | null;
  roomName: string | null;
  /** The pulse verb, or the presence activity, as the map shows it. */
  doing: string | null;
  stalled: boolean;
}

export interface SearchAgent {
  slug: string;
  name: string;
  ownerHandle: string | null;
  online: boolean;
  roomSlug: string | null;
  roomName: string | null;
}

export interface SearchHuman {
  handle: string;
  name: string;
  online: boolean;
  roomSlug: string | null;
  roomName: string | null;
}

export interface SearchSpace {
  slug: string;
  name: string;
  policyPreset: string;
  ownerHandle: string | null;
  occupancy: number;
  isMember: boolean;
  /**
   * The block ring of the space's plot (#38), for "in Ring N". Null for a space
   * with no plot. Only on rows this viewer may already see, like the rest.
   */
  ring: number | null;
}

export interface SearchRoom {
  slug: string;
  name: string;
  kind: string;
  occupancy: number;
  /** Null for a commons room. */
  spaceSlug: string | null;
  spaceName: string | null;
}

export interface SearchResults {
  query: string;
  agents: SearchAgent[];
  humans: SearchHuman[];
  spaces: SearchSpace[];
  rooms: SearchRoom[];
  online: SearchBody[];
}

/** Trim, collapse whitespace, cap. An empty string means "no query". */
export function normaliseSearchQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, SEARCH_QUERY_MAX);
}

/** A LIKE pattern that matches the query literally: `%`, `_` and `\` are escaped. */
export function likePattern(q: string, prefix = false): string {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return prefix ? `${escaped}%` : `%${escaped}%`;
}

/** The minimum a minimap body needs to be listed; see world.minimap(). */
interface MapBody {
  id: string;
  kind: "human" | "agent";
  displayName: string;
  slug: string;
  roomId: string;
  roomSlug: string;
  activity: string;
  verb: string | null;
  stalled: boolean;
}

interface MapSnapshot {
  rooms: Array<{ id: string; slug: string; name: string }>;
  bodies: MapBody[];
}

const MEMBER = (world: string, viewer: string) => `(${viewer}::text IS NOT NULL AND (
  ${world}.owner_human_id = ${viewer}::text
  OR EXISTS (SELECT 1 FROM world_members m WHERE m.world_id = ${world}.id AND m.human_id = ${viewer}::text)))`;

export class SearchService {
  constructor(
    private store: GroveStore,
    private campus: CampusService,
    /** The public commons minimap: the one source of who is where. */
    private commonsMap: () => Promise<MapSnapshot>,
  ) {}

  /** `viewerHumanId`: the human looking, or an agent's owner; null signed out. */
  async search(viewerHumanId: string | null, rawQuery: unknown): Promise<SearchResults> {
    const query = normaliseSearchQuery(rawQuery);
    const map = await this.commonsMap();
    const roomName = new Map(map.rooms.map((r) => [r.id, r.name]));
    const onMap = new Map(map.bodies.map((b) => [`${b.kind}:${b.id}`, b]));

    const online: SearchBody[] = map.bodies.map((b) => ({
      kind: b.kind,
      slug: b.slug,
      name: b.displayName,
      roomSlug: b.roomSlug,
      roomName: roomName.get(b.roomId) ?? b.roomSlug,
      doing: b.verb ?? b.activity ?? null,
      stalled: Boolean(b.stalled),
    }));
    // Online, agents first (they are the ones doing visible work), then by name.
    // Sorted BEFORE the cap, so which bodies make the list never depends on the
    // order rooms and seats happen to come back in.
    online.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "agent" ? -1 : 1));
    online.length = Math.min(online.length, ONLINE_LIMIT);

    if (!query) return { query, agents: [], humans: [], spaces: [], rooms: [], online };

    const like = likePattern(query);
    const prefix = likePattern(query, true);
    const where = (b: MapBody | undefined) => ({
      online: Boolean(b),
      roomSlug: b?.roomSlug ?? null,
      roomName: b ? (roomName.get(b.roomId) ?? b.roomSlug) : null,
    });

    const [agents, humans, spaces, rooms] = await Promise.all([
      this.store.pg.query(
        `SELECT a.id, a.slug, a.display_name, oh.handle AS owner_handle
           FROM agents a LEFT JOIN humans oh ON oh.id = a.owner_human_id
          WHERE a.claim_state <> 'pending'
            AND (a.slug ILIKE $1 ESCAPE '\\' OR a.display_name ILIKE $1 ESCAPE '\\')
          ORDER BY (a.slug ILIKE $2 ESCAPE '\\' OR a.display_name ILIKE $2 ESCAPE '\\') DESC,
                   a.display_name, a.slug
          LIMIT $3`,
        [like, prefix, SEARCH_LIMIT],
      ),
      this.store.pg.query(
        `SELECT h.id, h.handle, h.display_name
           FROM humans h
          WHERE h.suspended_at IS NULL
            AND (h.handle ILIKE $1 ESCAPE '\\' OR h.display_name ILIKE $1 ESCAPE '\\')
          ORDER BY (h.handle ILIKE $2 ESCAPE '\\' OR h.display_name ILIKE $2 ESCAPE '\\') DESC,
                   h.display_name, h.handle
          LIMIT $3`,
        [like, prefix, SEARCH_LIMIT],
      ),
      this.store.pg.query(
        `SELECT w.slug, w.name, w.policy_preset, w.plot_index, h.handle AS owner_handle, ${MEMBER("w", "$4")} AS is_member,
                ${visibleOccupancySql("w", "$4")} AS occupancy
           FROM worlds w LEFT JOIN humans h ON h.id = w.owner_human_id
          WHERE w.id <> '${WORLD_ID}' AND w.archived_at IS NULL
            AND (w.slug ILIKE $1 ESCAPE '\\' OR w.name ILIKE $1 ESCAPE '\\')
            AND (w.policy_preset <> 'private' OR ${MEMBER("w", "$4")})
          ORDER BY (w.slug ILIKE $2 ESCAPE '\\' OR w.name ILIKE $2 ESCAPE '\\') DESC, w.name
          LIMIT $3`,
        [like, prefix, SEARCH_LIMIT, viewerHumanId],
      ),
      this.store.pg.query(
        `SELECT r.id, r.slug, r.name, r.kind, COALESCE(r.world_id, '${WORLD_ID}') AS world_id,
                w.slug AS space_slug, w.name AS space_name, w.policy_preset AS space_preset,
                ${MEMBER("w", "$4")} AS is_member,
                (SELECT count(*)::int FROM presence p WHERE p.room_id = r.id) AS occupancy
           FROM rooms r LEFT JOIN worlds w ON w.id = r.world_id
          WHERE r.kind <> 'owner_lounge'
            AND (r.slug ILIKE $1 ESCAPE '\\' OR r.name ILIKE $1 ESCAPE '\\')
            AND (COALESCE(r.world_id, '${WORLD_ID}') = '${WORLD_ID}'
                 OR (w.archived_at IS NULL AND (w.policy_preset <> 'private' OR ${MEMBER("w", "$4")})))
          ORDER BY (COALESCE(r.world_id, '${WORLD_ID}') = '${WORLD_ID}') DESC,
                   ${MEMBER("w", "$4")} DESC,
                   (r.slug ILIKE $2 ESCAPE '\\' OR r.name ILIKE $2 ESCAPE '\\') DESC, r.name, w.name
          LIMIT $3`,
        [like, prefix, SEARCH_LIMIT * 3, viewerHumanId],
      ),
    ]);

    const roomResults: SearchRoom[] = [];
    for (const r of rooms.rows) {
      if (roomResults.length >= SEARCH_LIMIT) break;
      const commons = String(r.world_id) === WORLD_ID;
      // A non-member of a public space sees only the rooms its door admits them to.
      if (!commons && !r.is_member && !(await this.campus.visitableRoom(String(r.world_id), String(r.id)))) continue;
      roomResults.push({
        slug: String(r.slug),
        name: String(r.name),
        kind: String(r.kind),
        occupancy: Number(r.occupancy),
        spaceSlug: commons ? null : String(r.space_slug),
        spaceName: commons ? null : String(r.space_name),
      });
    }

    return {
      query,
      agents: agents.rows.map((a) => ({
        slug: String(a.slug),
        name: String(a.display_name),
        ownerHandle: a.owner_handle ? String(a.owner_handle) : null,
        ...where(onMap.get(`agent:${String(a.id)}`)),
      })),
      humans: humans.rows.map((h) => ({
        handle: String(h.handle),
        name: String(h.display_name),
        ...where(onMap.get(`human:${String(h.id)}`)),
      })),
      spaces: spaces.rows.map((s) => ({
        slug: String(s.slug),
        name: String(s.name),
        policyPreset: String(s.policy_preset),
        ownerHandle: s.owner_handle ? String(s.owner_handle) : null,
        occupancy: Number(s.occupancy),
        isMember: Boolean(s.is_member),
        ring: s.plot_index == null ? null : ringForPlotIndex(Number(s.plot_index)),
      })),
      rooms: roomResults,
      online,
    };
  }
}
