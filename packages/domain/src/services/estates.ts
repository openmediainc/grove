import { readEstateName, type Human } from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import type { CampusService } from "./campus.js";

export interface EstateNames {
  /** The caller's own estate name, or null (the sign reads "@handle"). */
  mine: string | null;
  handle: string;
  /** Orgs the caller owns, with their estate names (null = the org name). */
  orgs: Array<{ id: string; name: string; estateName: string | null }>;
}

/**
 * Estate names (queue #37, migration 038). Estates themselves are computed in
 * the minimap from plot adjacency (@grove/protocol estates.ts); the only stored
 * thing is an optional display name for the shared sign.
 *
 *  - a person names their own estate (humans.estate_name);
 *  - an org's owner names the org's estate (orgs.estate_name). Anyone else
 *    asking to rename an org gets the same 404 as "no such org".
 */
export class EstateService {
  constructor(
    private store: GroveStore,
    private campus: CampusService,
  ) {}

  async names(human: Human): Promise<EstateNames> {
    const [{ rows: me }, { rows: orgs }] = await Promise.all([
      this.store.pg.query<{ estate_name: string | null }>(`SELECT estate_name FROM humans WHERE id = $1`, [human.id]),
      this.store.pg.query<{ id: string; name: string; estate_name: string | null }>(
        `SELECT id, name, estate_name FROM orgs WHERE owner_human_id = $1 ORDER BY created_at, id`,
        [human.id],
      ),
    ]);
    const clean = (v: string | null | undefined) => {
      const r = readEstateName(v ?? null);
      return r.ok ? r.name : null;
    };
    return {
      mine: clean(me[0]?.estate_name),
      handle: human.handle,
      orgs: orgs.map((o) => ({ id: o.id, name: o.name, estateName: clean(o.estate_name) })),
    };
  }

  /** Set (or clear with null / "") an estate name: the caller's own, or an org's they own. */
  async setName(human: Human, input: { orgId?: string | null; name: unknown }): Promise<EstateNames> {
    const r = readEstateName(input.name);
    if (!r.ok) throw new GroveError("INVALID", r.message);
    if (input.orgId) {
      const org = await this.campus.getOrg(input.orgId);
      if (!org) throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
      await this.campus.assertOwnsOrg(human, org);
      await this.store.pg.query(`UPDATE orgs SET estate_name = $2 WHERE id = $1`, [org.id, r.name]);
    } else {
      await this.store.pg.query(`UPDATE humans SET estate_name = $2 WHERE id = $1`, [human.id, r.name]);
    }
    return this.names(human);
  }
}
