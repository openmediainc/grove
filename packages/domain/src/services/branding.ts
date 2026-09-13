import {
  EMPTY_BRANDING,
  WORLD_ID,
  mergeBranding,
  normaliseBrandingPatch,
  readStoredBranding,
  type Human,
  type SpaceBranding,
} from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import type { CampusService } from "./campus.js";

const NOT_FOUND = () => new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });

/**
 * Space branding (migration 035): accent colour, sign text, emblem.
 *
 * Visibility is the name's, in one place:
 *  - read: a private space's branding answers 404 to a non-member, identical to
 *    "no such space". The public minimap redacts it with the name (world.ts).
 *  - write: the space's operator only; anyone else gets the same 404.
 * Validation is @grove/protocol's, so the Manage preview and the server agree.
 */
export class BrandingService {
  constructor(
    private store: GroveStore,
    private campus: CampusService,
  ) {}

  /** Raw read for a caller that has already passed the space's door. */
  async ofWorld(worldId: string): Promise<SpaceBranding | null> {
    const { rows } = await this.store.pg.query<{ branding: unknown }>(`SELECT branding FROM worlds WHERE id = $1`, [worldId]);
    return readStoredBranding(rows[0]?.branding);
  }

  async spaceBranding(viewer: Human | null, ref: string): Promise<SpaceBranding | null> {
    const world = await this.campus.getWorld(ref);
    if (!world || world.archivedAt) throw NOT_FOUND();
    const member = viewer ? await this.campus.isMember(world.id, viewer.id) : false;
    if (world.policyPreset === "private" && world.id !== WORLD_ID && !member) throw NOT_FOUND();
    return this.ofWorld(world.id);
  }

  async setSpaceBranding(human: Human, ref: string, raw: unknown): Promise<SpaceBranding | null> {
    const world = await this.campus.requireWorld(ref);
    if (world.archivedAt) throw NOT_FOUND();
    await this.campus.assertOperate(human, world);
    const r = normaliseBrandingPatch(raw);
    if (!r.ok) throw new GroveError("INVALID", r.message);
    const next = mergeBranding((await this.ofWorld(world.id)) ?? EMPTY_BRANDING, r.patch);
    const empty = !next.accent && !next.signText && !next.emblem;
    await this.store.pg.query(`UPDATE worlds SET branding = $2 WHERE id = $1`, [world.id, empty ? null : JSON.stringify(next)]);
    return this.ofWorld(world.id);
  }
}
