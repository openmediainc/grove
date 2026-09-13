import {
  DEFAULT_SPACE_POLICY_PRESET,
  PUBLIC_ROOMS,
  SPACE_POLICY_PRESETS,
  WORLD_ID,
  spacePolicyForPreset,
  type Human,
  type SpacePolicy,
  type SpacePolicyPreset,
} from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId, newUlid } from "../ids.js";
import { randomToken } from "../crypto.js";
import { withTx } from "../db.js";

export interface WorldRow {
  id: string;
  slug: string;
  name: string;
  ownerHumanId: string | null;
  createdAt: string;
  /** Plot on the shared world. NULL only for the civic core. */
  plotIndex: number | null;
  /** Set when the space was given back; its plot is released and it cannot be entered. */
  archivedAt: string | null;
  policyPreset: SpacePolicyPreset;
  /** Explicit override; when null the preset supplies the policy. */
  spacePolicy: SpacePolicy | null;
  /** How bound orgs are painted here. See orgRenderFor(). */
  orgRenderMode: OrgRenderMode;
}

/**
 * 'shared' hosts several orgs at once and tints each body by its own org;
 * 'dedicated' makes the space one org's home and tints every body the same.
 * Both read the same world_orgs bindings — this is the toggle between them.
 */
export type OrgRenderMode = "shared" | "dedicated";

export const ORG_RENDER_MODES: OrgRenderMode[] = ["shared", "dedicated"];

export function isOrgRenderMode(value: unknown): value is OrgRenderMode {
  return value === "shared" || value === "dedicated";
}

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  /** #rrggbb, for the renderer. */
  colour: string;
  ownerHumanId: string;
  createdAt: string;
}

/** One body's tint: which org it reads as here, and in what colour. */
export interface OrgBodyTint {
  humanId: string;
  orgId: string;
  colour: string;
}

export interface SpaceOrgRender {
  mode: OrgRenderMode;
  orgs: OrgRow[];
  bodies: OrgBodyTint[];
}

export interface JoinRequestRow {
  id: string;
  worldId: string;
  humanId: string;
  handle: string;
  displayName: string;
  note: string | null;
  status: "pending" | "approved" | "declined";
  createdAt: string;
  decidedAt: string | null;
}

/**
 * One person still waiting at a door this human owns, for the owner's half of
 * the human inbox. Everything here is already readable by this owner through
 * listJoinRequests() — it is their own space's name and slug, and the handle of
 * someone who chose to knock. Nobody else can ever be handed one of these.
 */
export interface OwnerJoinRequestItem {
  requestId: string;
  worldId: string;
  worldSlug: string;
  worldName: string;
  plotIndex: number | null;
  humanId: string;
  handle: string;
  displayName: string;
  note: string | null;
  createdAt: string;
}

/**
 * What came of something THIS human asked for, for the asker's half of the
 * inbox. The redaction is listDirectory()'s rule applied a second time rather
 * than assumed: a declined ask at a `private` space carries its plot and access
 * level and nothing more — no name, no slug, no owner handle.
 *
 * There is deliberately no `reason` and no `decidedBy`. The table stores no
 * reason at all, and decided_by is never read here: a decline must not hand
 * back the owner's thinking, and on a private space it must not even confirm
 * which human holds the plot.
 */
export interface AskerJoinAnswerItem {
  requestId: string;
  worldId: string;
  plotIndex: number | null;
  policyPreset: SpacePolicyPreset;
  status: "approved" | "declined";
  decidedAt: string | null;
  /** Null on a `private` space the asker was not let into. */
  slug: string | null;
  name: string | null;
  ownerHandle: string | null;
}

export interface SpaceInviteRow {
  code: string;
  worldId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  /** null = unlimited uses until expiry or revocation. */
  maxUses: number | null;
  uses: number;
  revokedAt: string | null;
  /** Precomputed so a list does not have to re-derive the three conditions. */
  active: boolean;
}

/**
 * One row of the public space directory. The redaction here is the same rule
 * the minimap applies (world.minimap): permission state is public, the contents
 * behind it are not. A `private` space the viewer is not in shows that the plot
 * is held and at what level, and nothing else — no name, slug, or owner.
 */
export interface SpaceDirectoryEntry {
  id: string;
  plotIndex: number;
  policyPreset: SpacePolicyPreset;
  occupancy: number;
  /** Null when the viewer may not see it (private, viewer not a member). */
  slug: string | null;
  name: string | null;
  ownerHandle: string | null;
  isMember: boolean;
  isOwner: boolean;
  /** Orgs bound to this plot, and how they are painted. Empty when redacted. */
  orgRenderMode: OrgRenderMode;
  orgs: Array<{ id: string; slug: string; name: string; colour: string }>;
}

export interface SpaceRoomRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  capacity: number;
  occupancy: number;
}

export interface SpaceMemberRow {
  humanId: string;
  handle: string;
  displayName: string;
  isOwner: boolean;
}

/** Runtime guard for the DB CHECK constraint on worlds.policy_preset. */
export function isSpacePolicyPreset(value: unknown): value is SpacePolicyPreset {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SPACE_POLICY_PRESETS, value);
}

/**
 * How long an event runs when whoever scheduled it named no end.
 *
 * An event with no end never ends, and "the Stage is permanently live" is the
 * same nothing the Stage had before — a room that always looks the same. One
 * hour, applied in ONE place (`endsAtEffective`), so the clock the service uses
 * and the clock the SQL uses cannot disagree.
 */
export const STAGE_DEFAULT_MINUTES = 60;

export interface StageEventRow {
  id: string;
  worldId: string;
  roomId: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  createdBy: string;
  /** `endsAt`, or `startsAt` + STAGE_DEFAULT_MINUTES. Always a real instant. */
  endsAtEffective: string;
  /** Derived from the clock, never stored: a status column would go stale. */
  status: StageEventStatus;
}

export type StageEventStatus = "scheduled" | "live" | "over";

/**
 * What the Stage is doing, right now.
 *
 * This is the whole mechanic. `stage_events` has had a time window since
 * migration 003 and nothing ever read it, so the Stage behaved exactly like the
 * Plaza. Reading it turns the window into a state the room is IN — and because
 * the state is in the data rather than in a renderer, every surface (the map,
 * the room page, an agent's observation) agrees about it without any of them
 * knowing that "stage" is a special word.
 */
export interface StageNow {
  worldId: string;
  roomId: string;
  /** Running right now, or null. */
  live: StageEventRow | null;
  /** The soonest event still to start. Null when nothing is scheduled. */
  next: StageEventRow | null;
  /** Everything still to come, soonest first. */
  upcoming: StageEventRow[];
  /** Just finished, for a room that should not go blank the second it ends. */
  justEnded: StageEventRow | null;
  defaultMinutes: number;
}

export interface RoleRow {
  id: string;
  worldId: string;
  key: string;
  label: string;
  prompt: string;
  cadenceMinutes: number;
  holderAgentId: string | null;
  assignedAt: string | null;
}

/** How many times a plot collision is absorbed before it is treated as a bug. */
const PLOT_CLAIM_ATTEMPTS = 8;

/**
 * `worlds` carries more than one unique constraint, so a bare 23505 check
 * cannot tell a slug clash (the caller's problem) from a plot race (ours).
 */
function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && e?.constraint === constraint;
}

export class CampusService {
  constructor(private store: GroveStore) {}

  async getWorld(idOrSlug: string): Promise<WorldRow | null> {
    const { rows } = await this.store.pg.query(
      `SELECT * FROM worlds WHERE id = $1 OR slug = $1`,
      [idOrSlug],
    );
    return rows[0] ? mapWorld(rows[0] as Record<string, unknown>) : null;
  }

  async requireWorld(idOrSlug: string): Promise<WorldRow> {
    const w = await this.getWorld(idOrSlug);
    if (!w) throw new GroveError("NOT_FOUND", "World not found.", { httpStatus: 404 });
    return w;
  }

  async listForHuman(humanId: string): Promise<WorldRow[]> {
    const { rows } = await this.store.pg.query(
      // EXISTS rather than DISTINCT + LEFT JOIN: Postgres rejects a DISTINCT
      // whose ORDER BY expression is not in the select list (42P10).
      `SELECT w.*
       FROM worlds w
       WHERE w.id = $2
          OR w.owner_human_id = $1
          OR EXISTS (SELECT 1 FROM world_members m WHERE m.world_id = w.id AND m.human_id = $1)
       ORDER BY CASE WHEN w.id = $2 THEN 0 ELSE 1 END, w.created_at`,
      [humanId, WORLD_ID],
    );
    return rows.map((r) => mapWorld(r as Record<string, unknown>));
  }

  /**
   * Every claimed plot on the shared world, for the space directory. Unlike
   * listForHuman this is deliberately NOT scoped to the viewer: a held plot is
   * public knowledge. What is behind a private one is not, so the row is
   * redacted unless the viewer owns it or is a member.
   *
   * Pass null for a signed-out viewer; membership then reads false everywhere.
   */
  /**
   * Give a space back. The land is released, the record is kept: rooms, speech
   * and every chronicle event that happened there survive, because tidying a
   * directory is not a reason to rewrite what happened. Anyone standing in it
   * is returned to the commons rather than stranded in a space nobody can enter.
   */
  async archiveWorld(human: Human, idOrSlug: string): Promise<WorldRow> {
    const world = await this.requireWorld(idOrSlug);
    if (world.id === WORLD_ID) {
      throw new GroveError("INVALID", "The commons cannot be given back.");
    }
    await this.assertOperate(human, world);
    await withTx(this.store.pg, async (c) => {
      await c.query(
        `DELETE FROM presence WHERE room_id IN (SELECT id FROM rooms WHERE world_id = $1)`,
        [world.id],
      );
      await c.query(
        `UPDATE worlds SET archived_at = now(), plot_index = NULL WHERE id = $1`,
        [world.id],
      );
    });
    const after = await this.getWorld(world.id);
    if (!after) throw new GroveError("NOT_FOUND", "Space not found.", { httpStatus: 404 });
    return after;
  }

  async listDirectory(humanId: string | null): Promise<SpaceDirectoryEntry[]> {
    const { rows } = await this.store.pg.query(
      `SELECT w.id, w.slug, w.name, w.plot_index, w.policy_preset, w.owner_human_id,
              w.org_render_mode,
              h.handle AS owner_handle,
              (SELECT count(*)::int FROM presence p
                 JOIN rooms r ON r.id = p.room_id WHERE r.world_id = w.id) AS occupancy,
              EXISTS (SELECT 1 FROM world_members m
                        WHERE m.world_id = w.id AND m.human_id = $1) AS is_member,
              -- Bound orgs inline: the minimap tints a plot without a second
              -- round trip per space. COALESCE keeps an unbound plot an array.
              COALESCE((SELECT json_agg(json_build_object(
                          'id', o.id, 'slug', o.slug, 'name', o.name, 'colour', o.colour)
                          ORDER BY wo.created_at, o.id)
                        FROM world_orgs wo JOIN orgs o ON o.id = wo.org_id
                        WHERE wo.world_id = w.id), '[]'::json) AS orgs
       FROM worlds w LEFT JOIN humans h ON h.id = w.owner_human_id
       WHERE w.archived_at IS NULL AND w.plot_index IS NOT NULL
       ORDER BY w.plot_index`,
      [humanId],
    );
    return rows.map((r) => {
      const preset = (r.policy_preset as SpacePolicyPreset) ?? DEFAULT_SPACE_POLICY_PRESET;
      const isOwner = Boolean(humanId && r.owner_human_id && String(r.owner_human_id) === humanId);
      const isMember = isOwner || Boolean(r.is_member);
      // Mirrors world.minimap: only `private` hides anything, and membership lifts it.
      const visible = preset !== "private" || isMember;
      return {
        id: String(r.id),
        plotIndex: Number(r.plot_index),
        policyPreset: preset,
        occupancy: Number(r.occupancy),
        slug: visible ? String(r.slug) : null,
        name: visible ? String(r.name) : null,
        ownerHandle: visible && r.owner_handle ? String(r.owner_handle) : null,
        isMember,
        isOwner,
        orgRenderMode: isOrgRenderMode(r.org_render_mode) ? r.org_render_mode : "shared",
        // Which orgs live on a plot is part of what is behind a private door,
        // so it redacts with the name and the owner rather than separately.
        orgs: visible ? (r.orgs as SpaceDirectoryEntry["orgs"]) ?? [] : [],
      };
    });
  }

  /** The public rooms of a space, with live occupancy. */
  async roomsOf(worldId: string): Promise<SpaceRoomRow[]> {
    const { rows } = await this.store.pg.query(
      `SELECT r.id, r.slug, r.name, r.kind, r.capacity,
              (SELECT count(*)::int FROM presence p WHERE p.room_id = r.id) AS occupancy
       FROM rooms r WHERE r.world_id = $1 ORDER BY r.name`,
      [worldId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      name: String(r.name),
      kind: String(r.kind),
      capacity: Number(r.capacity),
      occupancy: Number(r.occupancy),
    }));
  }

  /**
   * Humans at a space's full ceiling. The owner is included even with no
   * world_members row, which is the same union memberIdsOf() takes — the two
   * must not disagree about who is a member.
   */
  async membersOf(worldId: string): Promise<SpaceMemberRow[]> {
    const { rows } = await this.store.pg.query(
      `SELECT h.id, h.handle, h.display_name, (w.owner_human_id = h.id) AS is_owner
       FROM humans h
       JOIN worlds w ON w.id = $1
       WHERE h.id = w.owner_human_id
          OR EXISTS (SELECT 1 FROM world_members m WHERE m.world_id = w.id AND m.human_id = h.id)
       ORDER BY is_owner DESC, h.handle`,
      [worldId],
    );
    return rows.map((r) => ({
      humanId: String(r.id),
      handle: String(r.handle),
      displayName: String(r.display_name),
      isOwner: Boolean(r.is_owner),
    }));
  }

  /**
   * Rename a space or change its access level. Owner-only (assertOperate hides
   * a space the caller does not operate as a 404, as everywhere else).
   *
   * The preset is validated against SPACE_POLICY_PRESETS before it goes near
   * the database: worlds.policy_preset carries a CHECK constraint, and a bad
   * value reaching it would surface as an opaque 500 instead of an INVALID.
   */
  async updateWorld(
    human: Human,
    idOrSlug: string,
    input: { name?: string | undefined; policyPreset?: unknown; orgRenderMode?: unknown },
  ): Promise<WorldRow> {
    const world = await this.requireWorld(idOrSlug);
    await this.assertOperate(human, world);

    const sets: string[] = [];
    const params: unknown[] = [world.id];

    if (input.name !== undefined) {
      const name = String(input.name).trim().slice(0, 64);
      if (!name) throw new GroveError("INVALID", "name cannot be empty.");
      params.push(name);
      sets.push(`name = $${params.length}`);
    }

    if (input.policyPreset !== undefined) {
      // The civic core is the commons, not a district: spacePolicyForRoom()
      // short-circuits it to "no ceiling", so a preset there would be a lie.
      if (world.id === WORLD_ID) {
        throw new GroveError("INVALID", "The civic core has no access level to change.");
      }
      if (!isSpacePolicyPreset(input.policyPreset)) {
        throw new GroveError(
          "INVALID",
          `policy_preset must be one of: ${Object.keys(SPACE_POLICY_PRESETS).join(", ")}.`,
        );
      }
      params.push(input.policyPreset);
      sets.push(`policy_preset = $${params.length}`);
    }

    if (input.orgRenderMode !== undefined) {
      if (!isOrgRenderMode(input.orgRenderMode)) {
        throw new GroveError("INVALID", `org_render_mode must be one of: ${ORG_RENDER_MODES.join(", ")}.`);
      }
      // 'dedicated' means this space IS one org's home, so it cannot be turned
      // on while several orgs are bound — the render would have to pick one
      // silently. Unbind down to one first; that is the honest order.
      if (input.orgRenderMode === "dedicated") {
        const bound = await this.orgsOf(world.id);
        if (bound.length > 1) {
          throw new GroveError(
            "INVALID",
            `A dedicated space renders one org. Unbind ${bound.length - 1} of the ${bound.length} bound here first.`,
          );
        }
      }
      params.push(input.orgRenderMode);
      sets.push(`org_render_mode = $${params.length}`);
    }

    if (!sets.length) {
      throw new GroveError("INVALID", "name, policy_preset or org_render_mode is required.");
    }

    const { rows } = await this.store.pg.query(
      `UPDATE worlds SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );
    return mapWorld(rows[0] as Record<string, unknown>);
  }

  async createWorld(
    owner: Human,
    input: { name: string; slug: string; preset?: SpacePolicyPreset },
  ): Promise<WorldRow> {
    const name = input.name.trim().slice(0, 64);
    const slug = input.slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    if (!name || slug.length < 2) throw new GroveError("INVALID", "name and slug are required.");
    if (slug === WORLD_ID || slug === "grove") {
      throw new GroveError("SLUG_TAKEN", "That campus slug is reserved.");
    }
    const id = newId("world");
    const preset: SpacePolicyPreset = input.preset ?? DEFAULT_SPACE_POLICY_PRESET;
    try {
      // Smallest free plot, so the world fills inward-out and stays compact.
      //
      // The subselect READS the free plot and the INSERT writes it, which is not
      // atomic: two people claiming a space in the same moment compute the same
      // number and one loses on `worlds_plot_index`. The plot is allocated by us,
      // not chosen by them, so losing that race is our problem to absorb — retry
      // and they get the next one. Only a genuine slug clash is theirs to fix.
      const rows = await this.insertWorldWithPlot({ id, slug, name, ownerId: owner.id, preset });
      await this.store.pg.query(
        `INSERT INTO world_members (world_id, human_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [id, owner.id],
      );
      for (const tmpl of PUBLIC_ROOMS) {
        const roomId = `${id}:${tmpl.id}`;
        await this.store.pg.query(
          `INSERT INTO rooms (id, slug, name, kind, capacity, allows_room_say, allows_whisper, spectator_visible, say_limit_per_min, world_id)
           VALUES ($1,$2,$3,$4,$5,TRUE,TRUE,$6,$7,$8)`,
          [
            roomId,
            tmpl.slug,
            tmpl.name,
            tmpl.kind,
            tmpl.capacity,
            tmpl.spectatorVisible,
            tmpl.sayLimitPerMin,
            id,
          ],
        );
      }
      return mapWorld(rows[0] as Record<string, unknown>);
    } catch (err) {
      if (isUniqueViolationOn(err, "worlds_slug_key")) {
        throw new GroveError("SLUG_TAKEN", "That campus slug is taken.");
      }
      throw err;
    }
  }

  /**
   * Insert the world, retrying when another claim took the plot we picked.
   * Bounded, because a persistent failure here is a bug and must surface rather
   * than spin. A slug clash is not retried — it would fail identically forever.
   */
  private async insertWorldWithPlot(w: {
    id: string;
    slug: string;
    name: string;
    ownerId: string;
    preset: SpacePolicyPreset;
  }): Promise<Array<Record<string, unknown>>> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { rows } = await this.store.pg.query(
          `INSERT INTO worlds (id, slug, name, owner_human_id, plot_index, policy_preset)
           SELECT $1,$2,$3,$4,
                  (SELECT coalesce(min(g.i), 0) FROM generate_series(
                     0, (SELECT count(*) FROM worlds WHERE plot_index IS NOT NULL)) AS g(i)
                   WHERE NOT EXISTS (SELECT 1 FROM worlds w WHERE w.plot_index = g.i)),
                  $5
           RETURNING *`,
          [w.id, w.slug, w.name, w.ownerId, w.preset],
        );
        return rows as Array<Record<string, unknown>>;
      } catch (err) {
        if (attempt >= PLOT_CLAIM_ATTEMPTS - 1 || !isUniqueViolationOn(err, "worlds_plot_index")) throw err;
      }
    }
  }

  /**
   * The access ceiling for a room, resolved from the space that owns it.
   * The civic core is always fully open — it is the commons, not a district.
   */
  async spacePolicyForRoom(roomId: string): Promise<SpacePolicy | undefined> {
    const { rows } = await this.store.pg.query(
      `SELECT w.policy_preset, w.space_policy, w.id AS world_id
       FROM rooms r JOIN worlds w ON w.id = r.world_id WHERE r.id = $1`,
      [roomId],
    );
    const row = rows[0];
    if (!row || row.world_id === WORLD_ID) return undefined;
    return (
      toSpacePolicy(row.space_policy) ??
      spacePolicyForPreset((row.policy_preset as SpacePolicyPreset) ?? DEFAULT_SPACE_POLICY_PRESET)
    );
  }

  /**
   * Human ids that sit at a space's full ceiling. Returns null for the civic
   * core, meaning "everyone is a member" — callers must treat null as all-access
   * rather than as an empty set, or the commons would go dark.
   */
  async memberIdsOf(worldId: string): Promise<Set<string> | null> {
    if (worldId === WORLD_ID) return null;
    const { rows } = await this.store.pg.query(
      `SELECT human_id FROM world_members WHERE world_id = $1
       UNION SELECT owner_human_id FROM worlds WHERE id = $1 AND owner_human_id IS NOT NULL`,
      [worldId],
    );
    return new Set(rows.map((r) => String(r.human_id)));
  }

  /** The world a room belongs to, for scoping membership. */
  async worldIdForRoom(roomId: string): Promise<string> {
    const { rows } = await this.store.pg.query(`SELECT world_id FROM rooms WHERE id = $1`, [roomId]);
    return rows[0] ? String(rows[0].world_id) : WORLD_ID;
  }

  async addMember(worldId: string, humanId: string): Promise<void> {
    await this.store.pg.query(
      `INSERT INTO world_members (world_id, human_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [worldId, humanId],
    );
  }

  async isMember(worldId: string, humanId: string): Promise<boolean> {
    if (worldId === WORLD_ID) return true;
    const { rowCount } = await this.store.pg.query(
      `SELECT 1 FROM worlds w
       LEFT JOIN world_members m ON m.world_id = w.id AND m.human_id = $2
       WHERE w.id = $1 AND (w.owner_human_id = $2 OR m.human_id IS NOT NULL)`,
      [worldId, humanId],
    );
    return (rowCount ?? 0) > 0;
  }

  canOperate(human: Human, world: WorldRow): boolean {
    if (human.role === "operator") return true;
    return Boolean(world.ownerHumanId && world.ownerHumanId === human.id);
  }

  async assertOperate(human: Human, world: WorldRow): Promise<void> {
    if (!this.canOperate(human, world)) {
      throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    }
  }

  // ---------------------------------------------------------------------
  // SPC-05 / SPC-06 — two ways into a space.
  //
  // Until now membership was owner-grants-by-handle only, which requires the
  // owner to already know your handle. These are the two directions that fixes:
  // the outsider asks, or the owner hands out a link.
  // ---------------------------------------------------------------------

  /**
   * Ask to be let into a space.
   *
   * The reply carries nothing the directory did not already show — no name, no
   * slug, no owner — so asking about a `private` space is not a way to read it.
   * For the same reason a private space is addressable here by **id only**: its
   * id is public on the directory, its slug is not, and honouring a guessed
   * slug would confirm one.
   *
   * Re-asking while a request is still pending returns the same row rather than
   * erroring: a double-tap should not look like a failure, and the caller's
   * rate limiter has already been charged by the route.
   */
  async requestJoin(
    human: Human,
    idOrSlug: string,
    note?: string | null,
  ): Promise<{ id: string; worldId: string; status: string; createdAt: string }> {
    const world = await this.requireWorld(idOrSlug);
    if (world.id === WORLD_ID) {
      throw new GroveError("INVALID", "The civic core is open to everyone; there is nothing to ask for.");
    }
    if (world.policyPreset === "private" && idOrSlug !== world.id) {
      throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    }
    if (await this.isMember(world.id, human.id)) {
      throw new GroveError("CONFLICT", "You are already a member of this space.");
    }
    const trimmed = note == null ? null : String(note).trim().slice(0, 280) || null;
    const id = `sjr_${newUlid()}`;
    const { rows } = await this.store.pg.query(
      `INSERT INTO space_join_requests (id, world_id, human_id, note)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (world_id, human_id) WHERE status = 'pending' DO NOTHING
       RETURNING id, world_id, status, created_at`,
      [id, world.id, human.id, trimmed],
    );
    const row =
      rows[0] ??
      (
        await this.store.pg.query(
          `SELECT id, world_id, status, created_at FROM space_join_requests
           WHERE world_id = $1 AND human_id = $2 AND status = 'pending'`,
          [world.id, human.id],
        )
      ).rows[0];
    return {
      id: String(row.id),
      worldId: String(row.world_id),
      status: String(row.status),
      createdAt: new Date(String(row.created_at)).toISOString(),
    };
  }

  /** Everyone who has asked. Owner-only; assertOperate hides the rest as a 404. */
  async listJoinRequests(human: Human, idOrSlug: string): Promise<JoinRequestRow[]> {
    const world = await this.requireWorld(idOrSlug);
    await this.assertOperate(human, world);
    const { rows } = await this.store.pg.query(
      `SELECT r.*, h.handle, h.display_name
       FROM space_join_requests r JOIN humans h ON h.id = r.human_id
       WHERE r.world_id = $1
       ORDER BY (r.status = 'pending') DESC, r.created_at DESC
       LIMIT 100`,
      [world.id],
    );
    return rows.map((r) => mapJoinRequest(r as Record<string, unknown>));
  }

  /**
   * Approve or decline one ask. The UPDATE is the guard: it only matches a
   * request that is still pending AND belongs to this space, so a request id
   * lifted from another space decides nothing and reads as a 404.
   */
  async decideJoinRequest(
    human: Human,
    idOrSlug: string,
    requestId: string,
    decision: "approve" | "decline",
  ): Promise<JoinRequestRow> {
    const world = await this.requireWorld(idOrSlug);
    await this.assertOperate(human, world);
    const status = decision === "approve" ? "approved" : "declined";
    const { rows } = await this.store.pg.query(
      `UPDATE space_join_requests r
          SET status = $3, decided_at = now(), decided_by = $4
        FROM humans h
       WHERE r.id = $1 AND r.world_id = $2 AND r.status = 'pending' AND h.id = r.human_id
       RETURNING r.*, h.handle, h.display_name`,
      [requestId, world.id, status, human.id],
    );
    const row = rows[0];
    if (!row) throw new GroveError("NOT_FOUND", "No pending request with that id.", { httpStatus: 404 });
    if (decision === "approve") await this.addMember(world.id, String(row.human_id));
    return mapJoinRequest(row as Record<string, unknown>);
  }

  // ---------------------------------------------------------------------
  // The two halves of the inbox.
  //
  // A request queue nobody is notified about is a dead letterbox: until this,
  // an ask was only visible if the owner happened to open that one space's
  // detail page. Both halves are DERIVED from space_join_requests rather than
  // copied into notification rows of their own, which is what makes them
  // idempotent with requestJoin(): a re-ask folds onto the SAME pending row, so
  // there is exactly one row per live ask and no second notification exists to
  // send. Deciding a request likewise clears the owner's half with no second
  // write to keep in step.
  // ---------------------------------------------------------------------

  /** Every ask still waiting at any door this human owns, newest first. */
  async pendingJoinRequestsForOwner(humanId: string, limit = 50): Promise<OwnerJoinRequestItem[]> {
    const { rows } = await this.store.pg.query(
      `SELECT r.id, r.world_id, r.human_id, r.note, r.created_at,
              h.handle, h.display_name,
              w.slug AS world_slug, w.name AS world_name, w.plot_index
         FROM space_join_requests r
         JOIN worlds w ON w.id = r.world_id
         JOIN humans h ON h.id = r.human_id
        WHERE w.owner_human_id = $1 AND r.status = 'pending'
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [humanId, limit],
    );
    return rows.map((r) => ({
      requestId: String(r.id),
      worldId: String(r.world_id),
      worldSlug: String(r.world_slug),
      worldName: String(r.world_name),
      plotIndex: r.plot_index == null ? null : Number(r.plot_index),
    archivedAt: r.archived_at ? new Date(String(r.archived_at)).toISOString() : null,
      humanId: String(r.human_id),
      handle: String(r.handle),
      displayName: String(r.display_name),
      note: r.note == null ? null : String(r.note),
      createdAt: new Date(String(r.created_at)).toISOString(),
    }));
  }

  /**
   * The badge number. Counted rather than derived from the list above so a
   * capped list never under-reports how many people are waiting.
   */
  async pendingJoinRequestCountForOwner(humanId: string): Promise<number> {
    const { rows } = await this.store.pg.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM space_join_requests r JOIN worlds w ON w.id = r.world_id
        WHERE w.owner_human_id = $1 AND r.status = 'pending'`,
      [humanId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Answers to this human's own asks that they have not dismissed yet.
   *
   * `visible` is the same test listDirectory() and world.minimap apply, and it
   * is recomputed here rather than trusted from anywhere else: an approval
   * makes the asker a member and so unredacts the space they were just let
   * into, while a decline leaves a private space exactly as opaque as the
   * public directory already had it.
   */
  async joinAnswersForAsker(humanId: string, limit = 50): Promise<AskerJoinAnswerItem[]> {
    const { rows } = await this.store.pg.query(
      `SELECT r.id, r.world_id, r.status, r.decided_at,
              w.slug, w.name, w.plot_index, w.policy_preset,
              oh.handle AS owner_handle,
              (w.owner_human_id = r.human_id
               OR EXISTS (SELECT 1 FROM world_members m
                           WHERE m.world_id = w.id AND m.human_id = r.human_id)) AS is_member
         FROM space_join_requests r
         JOIN worlds w ON w.id = r.world_id
         LEFT JOIN humans oh ON oh.id = w.owner_human_id
        WHERE r.human_id = $1 AND r.status <> 'pending' AND r.seen_by_asker_at IS NULL
        ORDER BY r.decided_at DESC NULLS LAST, r.created_at DESC
        LIMIT $2`,
      [humanId, limit],
    );
    return rows.map((r) => {
      const preset = (r.policy_preset as SpacePolicyPreset) ?? DEFAULT_SPACE_POLICY_PRESET;
      const visible = preset !== "private" || Boolean(r.is_member);
      return {
        requestId: String(r.id),
        worldId: String(r.world_id),
        plotIndex: r.plot_index == null ? null : Number(r.plot_index),
        policyPreset: preset,
        status: String(r.status) as AskerJoinAnswerItem["status"],
        decidedAt: r.decided_at ? new Date(String(r.decided_at)).toISOString() : null,
        slug: visible ? String(r.slug) : null,
        name: visible ? String(r.name) : null,
        ownerHandle: visible && r.owner_handle ? String(r.owner_handle) : null,
      };
    });
  }

  /**
   * Dismiss answers from your own inbox. Mirrors mailbox.markRead(): human_id
   * scopes the UPDATE, so this can only ever clear the caller's own rows and a
   * borrowed request id clears nothing and says nothing.
   */
  async markJoinAnswersSeen(humanId: string, ids?: string[]): Promise<number> {
    if (ids?.length) {
      const { rowCount } = await this.store.pg.query(
        `UPDATE space_join_requests SET seen_by_asker_at = now()
          WHERE human_id = $1 AND id = ANY($2) AND status <> 'pending' AND seen_by_asker_at IS NULL`,
        [humanId, ids],
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await this.store.pg.query(
      `UPDATE space_join_requests SET seen_by_asker_at = now()
        WHERE human_id = $1 AND status <> 'pending' AND seen_by_asker_at IS NULL`,
      [humanId],
    );
    return rowCount ?? 0;
  }

  /**
   * Mint an invite link. Owner-only. `singleUse` sets max_uses to 1; otherwise
   * the link is unlimited until it expires or is revoked. The expiry is
   * mandatory by construction — there is no "never expires" value — because a
   * link with no end is a permanent hole in a private space.
   */
  async createInvite(
    human: Human,
    idOrSlug: string,
    input: { expiresInHours?: number | undefined; singleUse?: boolean | undefined },
  ): Promise<SpaceInviteRow> {
    const world = await this.requireWorld(idOrSlug);
    await this.assertOperate(human, world);
    if (world.id === WORLD_ID) {
      throw new GroveError("INVALID", "The civic core needs no invite.");
    }
    const hours = Math.max(1, Math.min(24 * 30, Number(input.expiresInHours ?? 168) || 168));
    const code = randomToken(24);
    const { rows } = await this.store.pg.query(
      `INSERT INTO space_invites (code, world_id, created_by, expires_at, max_uses)
       VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval, $5)
       RETURNING *`,
      [code, world.id, human.id, String(hours), input.singleUse ? 1 : null],
    );
    return mapInvite(rows[0] as Record<string, unknown>);
  }

  async listInvites(human: Human, idOrSlug: string): Promise<SpaceInviteRow[]> {
    const world = await this.requireWorld(idOrSlug);
    await this.assertOperate(human, world);
    const { rows } = await this.store.pg.query(
      `SELECT * FROM space_invites WHERE world_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [world.id],
    );
    return rows.map((r) => mapInvite(r as Record<string, unknown>));
  }

  /** Revocation is immediate and permanent; the row stays so the log is honest. */
  async revokeInvite(human: Human, idOrSlug: string, code: string): Promise<SpaceInviteRow> {
    const world = await this.requireWorld(idOrSlug);
    await this.assertOperate(human, world);
    const { rows } = await this.store.pg.query(
      `UPDATE space_invites SET revoked_at = coalesce(revoked_at, now())
       WHERE code = $1 AND world_id = $2 RETURNING *`,
      [code, world.id],
    );
    if (!rows[0]) throw new GroveError("NOT_FOUND", "No such invite.", { httpStatus: 404 });
    return mapInvite(rows[0] as Record<string, unknown>);
  }

  /**
   * Redeem an invite. Fails closed: revoked, expired, exhausted and simply
   * unknown all raise the SAME 404, so holding a dead code tells you nothing
   * about whether it was ever real or which space it pointed at.
   *
   * The use is burned inside the UPDATE that checks it, so two holders racing
   * on a single-use link cannot both be admitted. A human who is already a
   * member short-circuits before the burn — re-opening the link you were
   * admitted with must not silently spend somebody else's seat.
   */
  async redeemInvite(human: Human, code: string): Promise<{ world: WorldRow; alreadyMember: boolean }> {
    const invalid = () =>
      new GroveError("NOT_FOUND", "That invite link is not valid.", { httpStatus: 404 });
    const found = await this.store.pg.query(`SELECT world_id FROM space_invites WHERE code = $1`, [code]);
    if (!found.rows[0]) throw invalid();
    const worldId = String(found.rows[0].world_id);
    if (await this.isMember(worldId, human.id)) {
      return { world: await this.requireWorld(worldId), alreadyMember: true };
    }
    const burned = await this.store.pg.query(
      `UPDATE space_invites SET uses = uses + 1
       WHERE code = $1
         AND revoked_at IS NULL
         AND expires_at > now()
         AND (max_uses IS NULL OR uses < max_uses)
       RETURNING world_id`,
      [code],
    );
    if (!burned.rows[0]) throw invalid();
    await this.store.pg.query(
      `INSERT INTO space_invite_redemptions (code, human_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [code, human.id],
    );
    await this.addMember(worldId, human.id);
    return { world: await this.requireWorld(worldId), alreadyMember: false };
  }

  // ---------------------------------------------------------------------
  // SPC-03 — orgs bound to spaces.
  //
  // "Multiple orgs in one space" and "a dedicated space per org" are the same
  // mechanism: a many-to-many binding plus one render mode on the space. An org
  // is deliberately thin — name, slug, colour, owner, a member list. No billing,
  // no roles, no invitations of its own; a space already has all of that.
  // ---------------------------------------------------------------------

  async createOrg(
    owner: Human,
    input: { name: string; slug?: string | undefined; colour?: string | undefined },
  ): Promise<OrgRow> {
    const name = String(input.name ?? "").trim().slice(0, 64);
    const slug = slugify(input.slug || name);
    if (!name || slug.length < 2) throw new GroveError("INVALID", "name and slug are required.");
    const colour = normaliseColour(input.colour);
    const id = `org_${newUlid()}`;
    try {
      const { rows } = await this.store.pg.query(
        `INSERT INTO orgs (id, slug, name, colour, owner_human_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, slug, name, colour, owner.id],
      );
      await this.store.pg.query(
        `INSERT INTO org_members (org_id, human_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [id, owner.id],
      );
      return mapOrg(rows[0] as Record<string, unknown>);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new GroveError("SLUG_TAKEN", "That org slug is taken.");
      }
      throw err;
    }
  }

  async getOrg(idOrSlug: string): Promise<OrgRow | null> {
    const { rows } = await this.store.pg.query(`SELECT * FROM orgs WHERE id = $1 OR slug = $1`, [idOrSlug]);
    return rows[0] ? mapOrg(rows[0] as Record<string, unknown>) : null;
  }

  async requireOrg(idOrSlug: string): Promise<OrgRow> {
    const org = await this.getOrg(idOrSlug);
    if (!org) throw new GroveError("NOT_FOUND", "Org not found.", { httpStatus: 404 });
    return org;
  }

  /** Same convention as assertOperate: an org you do not own is simply not there. */
  async assertOwnsOrg(human: Human, org: OrgRow): Promise<void> {
    if (human.role !== "operator" && org.ownerHumanId !== human.id) {
      throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    }
  }

  /** Orgs this human owns or belongs to. */
  async listOrgsForHuman(humanId: string): Promise<OrgRow[]> {
    const { rows } = await this.store.pg.query(
      `SELECT o.* FROM orgs o
       WHERE o.owner_human_id = $1
          OR EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id AND m.human_id = $1)
       ORDER BY o.created_at`,
      [humanId],
    );
    return rows.map((r) => mapOrg(r as Record<string, unknown>));
  }

  async addOrgMember(human: Human, orgIdOrSlug: string, humanId: string): Promise<OrgRow> {
    const org = await this.requireOrg(orgIdOrSlug);
    await this.assertOwnsOrg(human, org);
    await this.store.pg.query(
      `INSERT INTO org_members (org_id, human_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [org.id, humanId],
    );
    return org;
  }

  async orgMemberIds(orgId: string): Promise<string[]> {
    const { rows } = await this.store.pg.query(
      `SELECT human_id FROM org_members WHERE org_id = $1 ORDER BY created_at`,
      [orgId],
    );
    return rows.map((r) => String(r.human_id));
  }

  /**
   * Bind an org to a space. Both ends are owned things, so the caller must
   * operate the space AND own the org — otherwise anyone could paint their
   * colour onto somebody else's plot, or drag a stranger's org into theirs.
   */
  async bindOrg(human: Human, worldIdOrSlug: string, orgIdOrSlug: string): Promise<OrgRow[]> {
    const world = await this.requireWorld(worldIdOrSlug);
    await this.assertOperate(human, world);
    const org = await this.requireOrg(orgIdOrSlug);
    await this.assertOwnsOrg(human, org);
    if (world.orgRenderMode === "dedicated") {
      const existing = await this.orgsOf(world.id);
      if (existing.length && !existing.some((o) => o.id === org.id)) {
        throw new GroveError(
          "INVALID",
          "This space renders as one org's home. Unbind the current org, or switch it to shared first.",
        );
      }
    }
    await this.store.pg.query(
      `INSERT INTO world_orgs (world_id, org_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [world.id, org.id],
    );
    return this.orgsOf(world.id);
  }

  async unbindOrg(human: Human, worldIdOrSlug: string, orgIdOrSlug: string): Promise<OrgRow[]> {
    const world = await this.requireWorld(worldIdOrSlug);
    await this.assertOperate(human, world);
    const org = await this.requireOrg(orgIdOrSlug);
    await this.store.pg.query(`DELETE FROM world_orgs WHERE world_id = $1 AND org_id = $2`, [
      world.id,
      org.id,
    ]);
    return this.orgsOf(world.id);
  }

  /** Orgs bound to a space, in binding order. */
  async orgsOf(worldId: string): Promise<OrgRow[]> {
    const { rows } = await this.store.pg.query(
      `SELECT o.* FROM world_orgs wo JOIN orgs o ON o.id = wo.org_id
       WHERE wo.world_id = $1 ORDER BY wo.created_at, o.id`,
      [worldId],
    );
    return rows.map((r) => mapOrg(r as Record<string, unknown>));
  }

  /**
   * Everything a renderer needs to tint bodies in this space by org, and the
   * only place the two modes differ:
   *
   *   shared    — a body takes the colour of ITS OWN org, provided that org is
   *               bound here. A body in no bound org gets no tint.
   *   dedicated — the space IS one org's home, so every body in it takes that
   *               org's colour whether or not the human is an org member.
   *
   * Same tables, same bindings. The mode is the toggle, not a second model.
   */
  async orgRenderFor(worldId: string): Promise<SpaceOrgRender> {
    const world = await this.requireWorld(worldId);
    const orgs = await this.orgsOf(world.id);
    const mode = world.orgRenderMode;

    if (mode === "dedicated") {
      const org = orgs[0];
      if (!org) return { mode, orgs, bodies: [] };
      const memberIds = await this.memberIdsOf(world.id);
      const ids = memberIds ? [...memberIds] : [];
      return {
        mode,
        orgs,
        bodies: ids.map((humanId) => ({ humanId, orgId: org.id, colour: org.colour })),
      };
    }

    const { rows } = await this.store.pg.query(
      // DISTINCT ON keeps one tint per body: a human in two bound orgs takes the
      // one bound first, so the map never flickers between two colours.
      `SELECT DISTINCT ON (m.human_id) m.human_id, o.id AS org_id, o.colour
       FROM (SELECT human_id FROM world_members WHERE world_id = $1
             UNION SELECT owner_human_id FROM worlds WHERE id = $1 AND owner_human_id IS NOT NULL) m
       JOIN org_members om ON om.human_id = m.human_id
       JOIN world_orgs wo ON wo.org_id = om.org_id AND wo.world_id = $1
       JOIN orgs o ON o.id = wo.org_id
       ORDER BY m.human_id, wo.created_at, o.id`,
      [world.id],
    );
    return {
      mode,
      orgs,
      bodies: rows.map((r) => ({
        humanId: String(r.human_id),
        orgId: String(r.org_id),
        colour: String(r.colour),
      })),
    };
  }

  async createEvent(
    human: Human,
    input: { worldId?: string; roomId?: string; title: string; startsAt: string; endsAt?: string | null },
  ): Promise<StageEventRow> {
    const world = await this.requireWorld(input.worldId ?? WORLD_ID);
    await this.assertOperate(human, world);
    const title = input.title.trim().slice(0, 140);
    if (!title) throw new GroveError("INVALID", "title is required.");
    // Validated here rather than left to Postgres. An unparseable timestamp used
    // to surface as a raw driver error with a 500 attached; a window that ends
    // before it starts used to be accepted and then never be `live` on any
    // clock, which is the worst kind of bug — the feature simply never happens.
    const startsAt = parseInstant(input.startsAt, "starts_at");
    const endsAt = input.endsAt ? parseInstant(input.endsAt, "ends_at") : null;
    if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new GroveError("INVALID", "ends_at must be after starts_at.");
    }
    const roomId = input.roomId ?? this.stageRoomId(world.id);
    // The room has to belong to this world, or an event would show up on a
    // Stage in a space the scheduler has no standing in.
    const { rowCount } = await this.store.pg.query(
      `SELECT 1 FROM rooms WHERE id = $1 AND world_id = $2`,
      [roomId, world.id],
    );
    if (!rowCount) throw new GroveError("NOT_FOUND", "No such room in this space.", { httpStatus: 404 });
    const id = newId("event");
    const { rows } = await this.store.pg.query(
      `INSERT INTO stage_events (id, world_id, room_id, title, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, world.id, roomId, title, startsAt.toISOString(), endsAt ? endsAt.toISOString() : null, human.id],
    );
    return mapEvent(rows[0] as Record<string, unknown>);
  }

  async listEvents(worldId: string): Promise<StageEventRow[]> {
    const { rows } = await this.store.pg.query(
      `SELECT * FROM stage_events WHERE world_id = $1 ORDER BY starts_at DESC LIMIT 50`,
      [worldId],
    );
    return rows.map((r) => mapEvent(r as Record<string, unknown>));
  }

  /** The Stage of a space. The civic core's is just `stage`. */
  stageRoomId(worldId: string): string {
    return worldId === WORLD_ID ? "stage" : `${worldId}:stage`;
  }

  /**
   * What is on, on this Stage, right now.
   *
   * Reading also ADVANCES the world: `announceStage()` runs first, so the
   * transition into and out of an event happens on the first read after the
   * clock passes. Grove has no scheduler, and inventing one for this would have
   * been a daemon to deploy, monitor and forget to restart. A lazy transition
   * has one real cost — an event nobody looks at is announced late — and one
   * real guarantee, which is the one that matters: it is announced exactly once,
   * whoever looks and however many look at the same moment.
   */
  async stageNow(worldId: string = WORLD_ID, roomId?: string): Promise<StageNow> {
    const world = await this.requireWorld(worldId);
    const room = roomId ?? this.stageRoomId(world.id);
    await this.announceStage(world.id);

    const { rows } = await this.store.pg.query(
      // A window either side of now: what is on, what is next, and what has just
      // come down — a Stage that blanks the instant an event ends reads as
      // broken rather than as finished.
      `SELECT * FROM stage_events
        WHERE world_id = $1 AND room_id = $2
          AND starts_at > now() - interval '1 day'
        ORDER BY starts_at
        LIMIT 50`,
      [world.id, room],
    );
    const now = Date.now();
    const events = rows.map((r) => mapEvent(r as Record<string, unknown>, now));

    const live = events.find((e) => e.status === "live") ?? null;
    const upcoming = events.filter((e) => e.status === "scheduled");
    const over = events.filter((e) => e.status === "over");
    return {
      worldId: world.id,
      roomId: room,
      live,
      next: upcoming[0] ?? null,
      upcoming,
      justEnded: over.length ? over[over.length - 1]! : null,
      defaultMinutes: STAGE_DEFAULT_MINUTES,
    };
  }

  /**
   * Cross the two edges of an event's window, exactly once each.
   *
   * `UPDATE ... WHERE started_announced_at IS NULL ... RETURNING` is the whole
   * trick: the row is claimed and reported in one statement, so of N readers
   * arriving in the same millisecond exactly one gets the row back and writes
   * the ledger entry. A read-then-write would announce N times.
   *
   * Events older than the freshness window are stamped but NOT announced. A
   * space that imports a season of history should not detonate six months of
   * "now starting" into a room in one request.
   */
  private async announceStage(worldId: string): Promise<void> {
    const started = await this.store.pg.query(
      `UPDATE stage_events SET started_announced_at = now()
        WHERE world_id = $1
          AND started_announced_at IS NULL
          AND starts_at <= now()
        RETURNING *, (starts_at > now() - interval '6 hours') AS fresh`,
      [worldId],
    );
    for (const r of started.rows) {
      if (r.fresh) await this.publishStage("stage.started", r as Record<string, unknown>);
    }

    const ended = await this.store.pg.query(
      `UPDATE stage_events SET ended_announced_at = now()
        WHERE world_id = $1
          AND ended_announced_at IS NULL
          AND started_announced_at IS NOT NULL
          AND COALESCE(ends_at, starts_at + make_interval(mins => $2::int)) <= now()
        RETURNING *, (starts_at > now() - interval '6 hours') AS fresh`,
      [worldId, STAGE_DEFAULT_MINUTES],
    );
    for (const r of ended.rows) {
      if (r.fresh) await this.publishStage("stage.ended", r as Record<string, unknown>);
    }
  }

  /**
   * One transition: a ledger row and a frame into the room.
   *
   * `roomId` is in the payload on purpose — `chronicle.ts` resolves an event to
   * a world by joining `rooms` on exactly that key, so without it a stage
   * transition would be worldless and escape the world gate. The ledger row
   * carries no body and no identity beyond the scheduler who already owns the
   * event, so there is nothing here a reader of the Stage could not see by
   * standing in it.
   */
  private async publishStage(type: "stage.started" | "stage.ended", r: Record<string, unknown>): Promise<void> {
    const event = mapEvent(r);
    await this.store.pg.query(
      `INSERT INTO world_events (type, actor_id, payload) VALUES ($1, $2, $3)`,
      [
        type,
        String(r.created_by),
        JSON.stringify({
          eventId: event.id,
          roomId: event.roomId,
          title: event.title,
          startsAt: event.startsAt,
          endsAt: event.endsAtEffective,
        }),
      ],
    );
    await this.store.redis.publish(
      `pubsub:room:${event.roomId}`,
      JSON.stringify({
        type,
        event_id: event.id,
        room_id: event.roomId,
        title: event.title,
        starts_at: event.startsAt,
        ends_at: event.endsAtEffective,
      }),
    );
  }

  async assignRole(
    human: Human,
    input: {
      worldId?: string;
      key: string;
      label: string;
      prompt: string;
      cadenceMinutes?: number;
      holderAgentId: string;
    },
  ): Promise<RoleRow> {
    const world = await this.requireWorld(input.worldId ?? WORLD_ID);
    await this.assertOperate(human, world);
    const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
    const label = input.label.trim().slice(0, 64);
    const prompt = input.prompt.trim().slice(0, 4000);
    if (!key || !label || !prompt) throw new GroveError("INVALID", "key, label, and prompt are required.");
    if (!input.holderAgentId) throw new GroveError("INVALID", "holder_agent_id is required.");
    const cadence = Math.max(1, Math.min(24 * 60, Number(input.cadenceMinutes ?? 60) || 60));
    const existing = await this.store.pg.query(`SELECT id FROM roles WHERE world_id = $1 AND key = $2`, [
      world.id,
      key,
    ]);
    const id = (existing.rows[0]?.id as string | undefined) ?? newId("role");
    const { rows } = await this.store.pg.query(
      `INSERT INTO roles (id, world_id, key, label, prompt, cadence_minutes, holder_agent_id, assigned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (world_id, key) DO UPDATE SET
         label = EXCLUDED.label,
         prompt = EXCLUDED.prompt,
         cadence_minutes = EXCLUDED.cadence_minutes,
         holder_agent_id = EXCLUDED.holder_agent_id,
         assigned_at = now(),
         last_briefed_at = NULL
       RETURNING *`,
      [id, world.id, key, label, prompt, cadence, input.holderAgentId],
    );
    return mapRole(rows[0] as Record<string, unknown>);
  }

  async dueBriefings(agentId: string, worldId: string): Promise<Array<{ role: string; prompt: string; message: string }>> {
    const { rows } = await this.store.pg.query(
      `SELECT * FROM roles WHERE holder_agent_id = $1 AND world_id = $2`,
      [agentId, worldId],
    );
    const out: Array<{ role: string; prompt: string; message: string }> = [];
    for (const r of rows) {
      const cadenceMin = Number(r.cadence_minutes) || 60;
      const last = r.last_briefed_at ? new Date(r.last_briefed_at as string).getTime() : 0;
      if (last && Date.now() - last < cadenceMin * 60_000) continue;
      out.push({
        role: String(r.key),
        prompt: String(r.prompt),
        message: `Role briefing (${r.label}): act on this cadence. ${r.prompt}`,
      });
      await this.store.pg.query(`UPDATE roles SET last_briefed_at = now() WHERE id = $1`, [r.id]);
    }
    return out;
  }
}

function mapWorld(r: Record<string, unknown>): WorldRow {
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    ownerHumanId: (r.owner_human_id as string | null) ?? null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    plotIndex: r.plot_index == null ? null : Number(r.plot_index),
    archivedAt: r.archived_at ? new Date(String(r.archived_at)).toISOString() : null,
    policyPreset: (r.policy_preset as SpacePolicyPreset) ?? DEFAULT_SPACE_POLICY_PRESET,
    spacePolicy: toSpacePolicy(r.space_policy),
    orgRenderMode: isOrgRenderMode(r.org_render_mode) ? r.org_render_mode : "shared",
  };
}

function mapOrg(r: Record<string, unknown>): OrgRow {
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    colour: String(r.colour),
    ownerHumanId: String(r.owner_human_id),
    createdAt: new Date(String(r.created_at)).toISOString(),
  };
}

function mapJoinRequest(r: Record<string, unknown>): JoinRequestRow {
  return {
    id: String(r.id),
    worldId: String(r.world_id),
    humanId: String(r.human_id),
    handle: String(r.handle),
    displayName: String(r.display_name),
    note: r.note == null ? null : String(r.note),
    status: String(r.status) as JoinRequestRow["status"],
    createdAt: new Date(String(r.created_at)).toISOString(),
    decidedAt: r.decided_at ? new Date(String(r.decided_at)).toISOString() : null,
  };
}

function mapInvite(r: Record<string, unknown>): SpaceInviteRow {
  const expiresAt = new Date(String(r.expires_at));
  const maxUses = r.max_uses == null ? null : Number(r.max_uses);
  const uses = Number(r.uses);
  return {
    code: String(r.code),
    worldId: String(r.world_id),
    createdBy: String(r.created_by),
    createdAt: new Date(String(r.created_at)).toISOString(),
    expiresAt: expiresAt.toISOString(),
    maxUses,
    uses,
    revokedAt: r.revoked_at ? new Date(String(r.revoked_at)).toISOString() : null,
    active: !r.revoked_at && expiresAt.getTime() > Date.now() && (maxUses == null || uses < maxUses),
  };
}

/** Lowercase, dashed, clipped — the same shape createWorld() settles on. */
function slugify(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * #rrggbb or nothing. The colour reaches a renderer as a literal, so anything
 * that is not plainly a hex triple is refused rather than sanitised into a
 * surprise — an unparseable tint would silently paint every body the same.
 */
function normaliseColour(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "#9aa7ff";
  const v = String(raw).trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (!/^#[0-9a-f]{6}$/.test(v)) {
    throw new GroveError("INVALID", "colour must be a hex triple such as #7c5cff.");
  }
  return v;
}

/** JSONB override -> SpacePolicy. Anything malformed falls back to the preset. */
function toSpacePolicy(raw: unknown): SpacePolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const keys = ["speak_to_agents", "speak_to_humans", "listen_to_agents", "listen_to_humans"] as const;
  if (!keys.every((k) => typeof o[k] === "boolean")) return null;
  return {
    speakToAgents: Boolean(o.speak_to_agents),
    speakToHumans: Boolean(o.speak_to_humans),
    listenToAgents: Boolean(o.listen_to_agents),
    listenToHumans: Boolean(o.listen_to_humans),
  };
}

/** An ISO instant or a refusal. Never a silent `Invalid Date` into a TIMESTAMPTZ. */
function parseInstant(raw: string, field: string): Date {
  const t = Date.parse(String(raw ?? ""));
  if (Number.isNaN(t)) throw new GroveError("INVALID", `${field} must be an ISO timestamp.`);
  return new Date(t);
}

function mapEvent(r: Record<string, unknown>, now: number = Date.now()): StageEventRow {
  const startsAt = new Date(String(r.starts_at));
  const endsAt = r.ends_at ? new Date(String(r.ends_at)) : null;
  // One definition of "when does this end", used by the mapper and by every
  // query below via the same arithmetic. A second definition is how a room ends
  // up live on one surface and over on another.
  const endsEffective = endsAt ?? new Date(startsAt.getTime() + STAGE_DEFAULT_MINUTES * 60_000);
  const status: StageEventStatus =
    now < startsAt.getTime() ? "scheduled" : now < endsEffective.getTime() ? "live" : "over";
  return {
    id: String(r.id),
    worldId: String(r.world_id),
    roomId: String(r.room_id),
    title: String(r.title),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt ? endsAt.toISOString() : null,
    createdBy: String(r.created_by),
    endsAtEffective: endsEffective.toISOString(),
    status,
  };
}

function mapRole(r: Record<string, unknown>): RoleRow {
  return {
    id: String(r.id),
    worldId: String(r.world_id),
    key: String(r.key),
    label: String(r.label),
    prompt: String(r.prompt),
    cadenceMinutes: Number(r.cadence_minutes),
    holderAgentId: (r.holder_agent_id as string | null) ?? null,
    assignedAt: r.assigned_at ? new Date(String(r.assigned_at)).toISOString() : null,
  };
}
