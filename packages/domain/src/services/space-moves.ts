import {
  WORLD_ID,
  confirmsSlug,
  nextRelocationAt,
  plotForIndex,
  relocationOptions,
  relocationRefusal,
  transferExpiresAt,
  type Human,
  type PlotRect,
  type RelocationOption,
  type SpacePolicyPreset,
  type TransferStatus,
} from "@grove/protocol";
import type { PoolClient } from "pg";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newUlid } from "../ids.js";
import { withTx } from "../db.js";
import type { CampusService, WorldRow } from "./campus.js";

const NOT_FOUND = () => new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
const CORE_REFUSED = () => new GroveError("INVALID", "The commons can't move or change hands.");
const NOT_CONFIRMED = () =>
  new GroveError("INVALID", "Type the space's slug to confirm.", { details: { reason: "confirmation" } });

/** One hand-over offer, as its holder or its recipient reads it. */
export interface SpaceTransfer {
  id: string;
  worldId: string;
  worldSlug: string;
  worldName: string;
  plotIndex: number | null;
  policyPreset: SpacePolicyPreset;
  from: { humanId: string; handle: string; displayName: string };
  to: { humanId: string; handle: string; displayName: string };
  /** Set when the space is handed to an org; `to` is then the org's owner. */
  toOrg: { id: string; slug: string; name: string; colour: string } | null;
  fromLeaves: boolean;
  status: TransferStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export interface TransferCandidates {
  members: Array<{ humanId: string; handle: string; displayName: string }>;
  orgs: Array<{ id: string; slug: string; name: string; colour: string; ownerHandle: string }>;
}

export interface RelocationPlan {
  current: number;
  currentRect: PlotRect;
  nextAllowedAt: string | null;
  options: Array<RelocationOption & { rect: PlotRect }>;
  /** Plots held by other spaces, for the mini preview. Indices only, never names. */
  taken: number[];
  /** This holder's other plots (the anchors "next to" suggestions are measured from). */
  anchors: number[];
}

const TRANSFER_SELECT = `
  SELECT t.*, w.slug AS world_slug, w.name AS world_name, w.plot_index, w.policy_preset,
         fh.handle::text AS from_handle, fh.display_name AS from_name,
         th.handle::text AS to_handle, th.display_name AS to_name,
         o.slug::text AS org_slug, o.name AS org_name, o.colour AS org_colour
    FROM space_transfers t
    JOIN worlds w ON w.id = t.world_id
    JOIN humans fh ON fh.id = t.from_human_id
    JOIN humans th ON th.id = t.to_human_id
    LEFT JOIN orgs o ON o.id = t.to_org_id`;

/**
 * Transfer & relocate (queue #35), adapted from office moves.
 *
 * Both are the HOLDER's acts — the human in worlds.owner_human_id. Operators
 * operate every space, but handing somebody's space away or moving their plot
 * is not moderation, so an operator who does not hold the space gets the same
 * 404 as anyone else. The civic core holds no plot and no owner: it can do
 * neither, and says so.
 *
 * Transfer is an OFFER the recipient accepts; nothing changes hands until then.
 * A human recipient must already be a member; an org recipient must be bound to
 * the space, and the org's owner accepts on its behalf. Branding, card, marks,
 * rooms and bindings are columns and rows of the space, so they simply stay.
 *
 * Every completed act writes a world_events row (`space.transferred`,
 * `space.relocated`) carrying the space's plaza as `roomId`, so the chronicle's
 * shared place gate (visibility.ts) resolves it to the space: members only on a
 * private plot. The operator log reads them too.
 */
export class SpaceMoveService {
  constructor(
    private store: GroveStore,
    private campus: CampusService,
  ) {}

  // -------------------------------------------------------------------------
  // Transfer
  // -------------------------------------------------------------------------

  private async holdWorld(human: Human, ref: string): Promise<WorldRow> {
    const world = await this.campus.getWorld(ref);
    if (!world) throw NOT_FOUND();
    if (world.id === WORLD_ID) throw CORE_REFUSED();
    if (world.archivedAt || world.ownerHumanId !== human.id) throw NOT_FOUND();
    return world;
  }

  /** Offers past their week become 'expired'. Cheap: the partial index covers pending rows. */
  async expireStale(worldId?: string): Promise<number> {
    const { rowCount } = await this.store.pg.query(
      `UPDATE space_transfers SET status = 'expired', decided_at = expires_at
        WHERE status = 'pending' AND expires_at <= now() AND ($1::text IS NULL OR world_id = $1::text)`,
      [worldId ?? null],
    );
    return rowCount ?? 0;
  }

  /** Who this space can be handed to: its other members, and orgs bound to it that someone else owns. */
  async candidates(human: Human, ref: string): Promise<TransferCandidates> {
    const world = await this.holdWorld(human, ref);
    const members = await this.store.pg.query(
      `SELECT h.id, h.handle::text AS handle, h.display_name
         FROM world_members m JOIN humans h ON h.id = m.human_id
        WHERE m.world_id = $1 AND h.id <> $2 AND h.suspended_at IS NULL
        ORDER BY h.handle LIMIT 200`,
      [world.id, human.id],
    );
    const orgs = await this.store.pg.query(
      `SELECT o.id, o.slug::text AS slug, o.name, o.colour, h.handle::text AS owner_handle
         FROM world_orgs wo JOIN orgs o ON o.id = wo.org_id JOIN humans h ON h.id = o.owner_human_id
        WHERE wo.world_id = $1 AND o.owner_human_id <> $2 AND h.suspended_at IS NULL
        ORDER BY wo.created_at, o.id`,
      [world.id, human.id],
    );
    return {
      members: members.rows.map((r) => ({ humanId: String(r.id), handle: String(r.handle), displayName: String(r.display_name) })),
      orgs: orgs.rows.map((r) => ({
        id: String(r.id),
        slug: String(r.slug),
        name: String(r.name),
        colour: String(r.colour),
        ownerHandle: String(r.owner_handle),
      })),
    };
  }

  /** The holder's view: the pending offer, if any, and the latest decided one. */
  async transferState(human: Human, ref: string): Promise<{ pending: SpaceTransfer | null; last: SpaceTransfer | null }> {
    const world = await this.holdWorld(human, ref);
    await this.expireStale(world.id);
    const { rows } = await this.store.pg.query(
      `${TRANSFER_SELECT} WHERE t.world_id = $1 AND t.from_human_id = $2 ORDER BY (t.status = 'pending') DESC, t.created_at DESC LIMIT 2`,
      [world.id, human.id],
    );
    const all = rows.map(mapTransfer);
    return {
      pending: all.find((t) => t.status === "pending") ?? null,
      last: all.find((t) => t.status !== "pending") ?? null,
    };
  }

  async offerTransfer(
    human: Human,
    ref: string,
    input: { toHandle?: unknown; toHumanId?: unknown; toOrgId?: unknown; confirm?: unknown; leave?: unknown },
  ): Promise<SpaceTransfer> {
    const world = await this.holdWorld(human, ref);
    if (!confirmsSlug(input.confirm, world.slug)) throw NOT_CONFIRMED();
    await this.expireStale(world.id);

    let toHumanId: string;
    let toOrgId: string | null = null;
    if (typeof input.toOrgId === "string" && input.toOrgId) {
      const { rows } = await this.store.pg.query(
        `SELECT o.id, o.owner_human_id, h.suspended_at FROM world_orgs wo
           JOIN orgs o ON o.id = wo.org_id JOIN humans h ON h.id = o.owner_human_id
          WHERE wo.world_id = $1 AND (o.id = $2 OR o.slug = $2)`,
        [world.id, input.toOrgId],
      );
      const org = rows[0];
      if (!org) throw new GroveError("INVALID", "Only an org bound to this space can take it.");
      if (String(org.owner_human_id) === human.id) {
        throw new GroveError("INVALID", "You already own that org, so the space is already in its hands.");
      }
      if (org.suspended_at) throw new GroveError("INVALID", "That org's owner can't take a space right now.");
      toOrgId = String(org.id);
      toHumanId = String(org.owner_human_id);
    } else {
      const handle = typeof input.toHandle === "string" ? input.toHandle.trim().replace(/^@/, "") : "";
      const id = typeof input.toHumanId === "string" ? input.toHumanId : "";
      if (!handle && !id) throw new GroveError("INVALID", "Pick a member or an org to hand the space to.");
      // Only members resolve: a handle that is not in the space reads the same
      // as a handle that does not exist, so this is not a way to probe people.
      const { rows } = await this.store.pg.query(
        `SELECT h.id FROM world_members m JOIN humans h ON h.id = m.human_id
          WHERE m.world_id = $1 AND h.suspended_at IS NULL AND (h.id = $2 OR h.handle = $3)`,
        [world.id, id || null, handle || null],
      );
      const to = rows[0];
      if (!to) throw new GroveError("INVALID", "Only a member of this space can take it. Admit them first.");
      toHumanId = String(to.id);
      if (toHumanId === human.id) throw new GroveError("INVALID", "You already hold this space.");
    }

    const id = `stx_${newUlid()}`;
    try {
      await this.store.pg.query(
        `INSERT INTO space_transfers (id, world_id, from_human_id, to_human_id, to_org_id, from_leaves, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, world.id, human.id, toHumanId, toOrgId, input.leave === true, transferExpiresAt()],
      );
    } catch (err) {
      if ((err as { code?: string; constraint?: string }).constraint === "space_transfers_one_pending") {
        throw new GroveError("CONFLICT", "This space already has an offer out. Cancel it first.");
      }
      throw err;
    }
    return (await this.getTransfer(id))!;
  }

  async cancelTransfer(human: Human, ref: string): Promise<SpaceTransfer> {
    const world = await this.holdWorld(human, ref);
    await this.expireStale(world.id);
    const { rows } = await this.store.pg.query(
      `UPDATE space_transfers SET status = 'cancelled', decided_at = now()
        WHERE world_id = $1 AND from_human_id = $2 AND status = 'pending' RETURNING id`,
      [world.id, human.id],
    );
    if (!rows[0]) throw new GroveError("NOT_FOUND", "No offer is waiting.", { httpStatus: 404 });
    return (await this.getTransfer(String(rows[0].id)))!;
  }

  /** Offers waiting for this human to answer, newest first. */
  async incoming(humanId: string, limit = 20): Promise<SpaceTransfer[]> {
    await this.expireStale();
    const { rows } = await this.store.pg.query(
      `${TRANSFER_SELECT} WHERE t.to_human_id = $1 AND t.status = 'pending' AND t.expires_at > now()
         AND w.archived_at IS NULL
       ORDER BY t.created_at DESC LIMIT $2`,
      [humanId, limit],
    );
    return rows.map(mapTransfer);
  }

  /**
   * Accept or decline an offer made to you. Anyone else — the holder included —
   * gets a 404: an offer id is not a way to learn about a space.
   *
   * Accepting re-checks everything the offer assumed, under a lock on the space
   * row, and swaps the holder in the same transaction that closes the offer:
   * the space was not archived, still belongs to whoever offered it, and the
   * recipient still qualifies (a member; or the org is still bound and still
   * theirs). An offer that no longer applies is cancelled and says so.
   */
  async answer(human: Human, transferId: string, decision: "accept" | "decline"): Promise<SpaceTransfer> {
    await this.expireStale();
    const outcome = await withTx(this.store.pg, async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM space_transfers WHERE id = $1 AND to_human_id = $2 FOR UPDATE`,
        [transferId, human.id],
      );
      const t = rows[0];
      if (!t) throw NOT_FOUND();
      if (t.status !== "pending") {
        throw new GroveError("CONFLICT", t.status === "expired" ? "This offer ran out." : "This offer was already answered.");
      }
      if (decision === "decline") {
        await c.query(`UPDATE space_transfers SET status = 'declined', decided_at = now() WHERE id = $1`, [transferId]);
        return { ok: true as const };
      }
      const { rows: ws } = await c.query(`SELECT * FROM worlds WHERE id = $1 FOR UPDATE`, [t.world_id]);
      const w = ws[0];
      const stillApplies = await this.stillApplies(c, t, w);
      if (!stillApplies) {
        await c.query(`UPDATE space_transfers SET status = 'cancelled', decided_at = now() WHERE id = $1`, [transferId]);
        return { ok: false as const };
      }
      await c.query(`UPDATE worlds SET owner_human_id = $2, owner_org_id = $3 WHERE id = $1`, [
        w.id,
        t.to_human_id,
        t.to_org_id ?? null,
      ]);
      await c.query(`INSERT INTO world_members (world_id, human_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [w.id, t.to_human_id]);
      if (t.from_leaves) {
        await c.query(`DELETE FROM world_members WHERE world_id = $1 AND human_id = $2`, [w.id, t.from_human_id]);
      } else {
        await c.query(`INSERT INTO world_members (world_id, human_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [w.id, t.from_human_id]);
      }
      await c.query(`UPDATE space_transfers SET status = 'accepted', decided_at = now() WHERE id = $1`, [transferId]);
      await c.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ('space.transferred', $1, $2)`, [
        String(t.from_human_id),
        JSON.stringify({
          roomId: `${w.id}:plaza`,
          worldId: w.id,
          space: String(w.slug),
          plot: w.plot_index == null ? null : Number(w.plot_index),
          from: String(t.from_human_id),
          to: String(t.to_human_id),
          orgId: t.to_org_id ?? null,
          fromLeft: Boolean(t.from_leaves),
          transferId,
        }),
      ]);
      return { ok: true as const };
    });
    if (!outcome.ok) throw new GroveError("CONFLICT", "This offer no longer applies, so it was withdrawn.");
    return (await this.getTransfer(transferId))!;
  }

  private async stillApplies(c: PoolClient, t: Record<string, unknown>, w: Record<string, unknown> | undefined): Promise<boolean> {
    if (!w || w.archived_at || w.id === WORLD_ID || w.owner_human_id !== t.from_human_id) return false;
    const { rows: sus } = await c.query(`SELECT suspended_at FROM humans WHERE id = $1`, [t.to_human_id]);
    if (!sus[0] || sus[0].suspended_at) return false;
    if (t.to_org_id) {
      const { rowCount } = await c.query(
        `SELECT 1 FROM world_orgs wo JOIN orgs o ON o.id = wo.org_id
          WHERE wo.world_id = $1 AND o.id = $2 AND o.owner_human_id = $3`,
        [w.id, t.to_org_id, t.to_human_id],
      );
      return (rowCount ?? 0) > 0;
    }
    const { rowCount } = await c.query(`SELECT 1 FROM world_members WHERE world_id = $1 AND human_id = $2`, [
      w.id,
      t.to_human_id,
    ]);
    return (rowCount ?? 0) > 0;
  }

  private async getTransfer(id: string): Promise<SpaceTransfer | null> {
    const { rows } = await this.store.pg.query(`${TRANSFER_SELECT} WHERE t.id = $1`, [id]);
    return rows[0] ? mapTransfer(rows[0]) : null;
  }

  /** The org a space is held for, if it was handed to one. Past the space's door only. */
  async holderOrg(worldId: string): Promise<{ id: string; slug: string; name: string; colour: string } | null> {
    const { rows } = await this.store.pg.query(
      `SELECT o.id, o.slug::text AS slug, o.name, o.colour FROM worlds w JOIN orgs o ON o.id = w.owner_org_id
        WHERE w.id = $1 AND o.owner_human_id = w.owner_human_id`,
      [worldId],
    );
    const r = rows[0];
    return r ? { id: String(r.id), slug: String(r.slug), name: String(r.name), colour: String(r.colour) } : null;
  }

  // -------------------------------------------------------------------------
  // Relocate
  // -------------------------------------------------------------------------

  async relocationPlan(human: Human, ref: string): Promise<RelocationPlan> {
    const world = await this.holdWorld(human, ref);
    if (world.plotIndex === null) throw CORE_REFUSED();
    const { rows } = await this.store.pg.query(
      `SELECT w.id, w.plot_index, w.owner_human_id = $2 AS mine,
              EXISTS (SELECT 1 FROM world_orgs a JOIN world_orgs b ON b.org_id = a.org_id
                       WHERE a.world_id = w.id AND b.world_id = $1) AS shares_org
         FROM worlds w WHERE w.plot_index IS NOT NULL AND w.archived_at IS NULL`,
      [world.id, human.id],
    );
    const { rows: me } = await this.store.pg.query(`SELECT relocated_at FROM worlds WHERE id = $1`, [world.id]);
    const taken = rows.map((r) => Number(r.plot_index));
    const anchors = rows.filter((r) => r.id !== world.id && (r.mine || r.shares_org)).map((r) => Number(r.plot_index));
    const options = relocationOptions({ taken, current: world.plotIndex, claimed: taken.length, anchors }).map((o) => ({
      ...o,
      rect: plotForIndex(o.plotIndex),
    }));
    const next = nextRelocationAt(me[0]?.relocated_at ?? null);
    return {
      current: world.plotIndex,
      currentRect: plotForIndex(world.plotIndex),
      nextAllowedAt: next && next.getTime() > Date.now() ? next.toISOString() : null,
      options,
      taken: taken.filter((i) => i !== world.plotIndex),
      anchors,
    };
  }

  /**
   * Move a space to a free plot. One transaction: lock the space row, check the
   * weekly limit and the target under that lock, then take the plot. The unique
   * index on worlds.plot_index is the guard against a concurrent claim or move
   * landing on the same plot; losing that race is a CONFLICT, and nothing moved.
   */
  async relocate(human: Human, ref: string, input: { plotIndex?: unknown; confirm?: unknown }): Promise<WorldRow> {
    const world = await this.holdWorld(human, ref);
    if (world.plotIndex === null) throw CORE_REFUSED();
    if (!confirmsSlug(input.confirm, world.slug)) throw NOT_CONFIRMED();
    const target = typeof input.plotIndex === "string" && /^\d+$/.test(input.plotIndex) ? Number(input.plotIndex) : input.plotIndex;
    try {
      await withTx(this.store.pg, async (c) => {
        const { rows } = await c.query(
          `SELECT id, plot_index, owner_human_id, archived_at, relocated_at FROM worlds WHERE id = $1 FOR UPDATE`,
          [world.id],
        );
        const w = rows[0];
        if (!w || w.archived_at || w.owner_human_id !== human.id) throw NOT_FOUND();
        if (w.plot_index == null) throw CORE_REFUSED();
        const { rows: cnt } = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM worlds WHERE plot_index IS NOT NULL AND archived_at IS NULL`,
        );
        const cooling = nextRelocationAt(w.relocated_at ?? null);
        if (cooling && cooling.getTime() > Date.now()) {
          throw new GroveError(
            "RATE_LIMITED",
            `A space can move once a week. This one can move again after ${cooling.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
            { httpStatus: 429, details: { next_allowed_at: cooling.toISOString() } },
          );
        }
        const refusal = relocationRefusal({
          target,
          current: Number(w.plot_index),
          claimed: Number(cnt[0]?.n ?? 1),
          relocatedAt: null,
        });
        if (refusal) throw new GroveError("INVALID", refusal);
        const { rowCount } = await c.query(`SELECT 1 FROM worlds WHERE plot_index = $1`, [target]);
        if (rowCount) throw new GroveError("CONFLICT", "That plot is taken. Pick another.");
        await c.query(`UPDATE worlds SET plot_index = $2, relocated_at = now() WHERE id = $1`, [world.id, target]);
        await c.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ('space.relocated', $1, $2)`, [
          human.id,
          JSON.stringify({
            roomId: `${world.id}:plaza`,
            worldId: world.id,
            space: world.slug,
            fromPlot: Number(w.plot_index),
            toPlot: target,
          }),
        ]);
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === "23505" && e.constraint === "worlds_plot_index") {
        throw new GroveError("CONFLICT", "That plot was just taken. Pick another.");
      }
      throw err;
    }
    return this.campus.requireWorld(world.id);
  }
}

function iso(v: unknown): string {
  return new Date(String(v)).toISOString();
}

function mapTransfer(r: Record<string, unknown>): SpaceTransfer {
  return {
    id: String(r.id),
    worldId: String(r.world_id),
    worldSlug: String(r.world_slug),
    worldName: String(r.world_name),
    plotIndex: r.plot_index == null ? null : Number(r.plot_index),
    policyPreset: r.policy_preset as SpacePolicyPreset,
    from: { humanId: String(r.from_human_id), handle: String(r.from_handle), displayName: String(r.from_name) },
    to: { humanId: String(r.to_human_id), handle: String(r.to_handle), displayName: String(r.to_name) },
    toOrg: r.to_org_id
      ? { id: String(r.to_org_id), slug: String(r.org_slug), name: String(r.org_name), colour: String(r.org_colour) }
      : null,
    fromLeaves: Boolean(r.from_leaves),
    status: String(r.status) as TransferStatus,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    decidedAt: r.decided_at ? iso(r.decided_at) : null,
  };
}
