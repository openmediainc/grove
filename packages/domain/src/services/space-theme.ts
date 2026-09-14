import { WORLD_ID, readStoredDefaultTheme, validateDefaultTheme, type Human, type SpaceThemeId } from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import type { CampusService } from "./campus.js";

const NOT_FOUND = () => new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });

/**
 * Owner default theme per space (queue #59, migration 045).
 *
 *  - write: the space's operator only; anyone else gets 404 (assertOperate).
 *  - read, public plots: the public minimap (world.ts), redacted for private ones.
 *  - read, private plots: the member-gated space detail, and `memberPrivate()`
 *    for the map, which lists only private spaces the viewer belongs to.
 * The id list and validation are @grove/protocol's (space-theme.ts).
 */
export class SpaceThemeService {
  constructor(
    private store: GroveStore,
    private campus: CampusService,
  ) {}

  /** Raw read for a caller that has already passed the space's door. */
  async ofWorld(worldId: string): Promise<SpaceThemeId | null> {
    const { rows } = await this.store.pg.query<{ default_theme: unknown }>(`SELECT default_theme FROM worlds WHERE id = $1`, [worldId]);
    return readStoredDefaultTheme(rows[0]?.default_theme);
  }

  async set(human: Human, ref: string, raw: unknown): Promise<SpaceThemeId | null> {
    const world = await this.campus.getWorld(ref);
    if (!world || world.archivedAt || world.id === WORLD_ID) throw NOT_FOUND();
    await this.campus.assertOperate(human, world);
    const r = validateDefaultTheme(raw);
    if (!r.ok) throw new GroveError("INVALID", r.message);
    await this.store.pg.query(`UPDATE worlds SET default_theme = $2 WHERE id = $1`, [world.id, r.theme]);
    return this.ofWorld(world.id);
  }

  /**
   * The defaults of the PRIVATE plots this human owns or is a member of, by
   * plot index. The public minimap carries none for a private plot, so this is
   * the only way the map learns them, and only for people already inside.
   */
  async memberPrivate(humanId: string): Promise<Array<{ plotIndex: number; defaultTheme: SpaceThemeId }>> {
    const { rows } = await this.store.pg.query<{ plot_index: number; default_theme: unknown }>(
      `SELECT w.plot_index, w.default_theme
         FROM worlds w
        WHERE w.policy_preset = 'private'
          AND w.plot_index IS NOT NULL
          AND w.archived_at IS NULL
          AND w.default_theme IS NOT NULL
          AND (w.owner_human_id = $1
               OR EXISTS (SELECT 1 FROM world_members m WHERE m.world_id = w.id AND m.human_id = $1))
        ORDER BY w.plot_index`,
      [humanId],
    );
    return rows.flatMap((r) => {
      const t = readStoredDefaultTheme(r.default_theme);
      return t ? [{ plotIndex: Number(r.plot_index), defaultTheme: t }] : [];
    });
  }
}
