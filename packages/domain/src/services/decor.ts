import {
  DECOR_MAX_ITEMS,
  DECOR_SLOT_COUNT,
  decorCatalogue,
  readStoredDecor,
  validateDecor,
  type DecorCatalogueEntry,
  type DecorItem,
  type DecorUnlockInput,
  type Human,
} from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import type { CampusService, WorldRow } from "./campus.js";
import type { MarkService } from "./marks.js";
import type { SupporterService } from "./supporters.js";

const NOT_FOUND = () => new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });

export interface DecorView {
  /** What is placed (shape-checked; items whose unlock lapsed are kept here so the owner sees them). */
  items: DecorItem[];
  catalogue: DecorCatalogueEntry[];
  maxItems: number;
  slotCount: number;
  /** A private plot keeps its decor but the map draws none of it. */
  hiddenWhilePrivate: boolean;
}

/**
 * Plot decor (queue #45, migration 044). Owner-only both ways: the public sees
 * decor only through the minimap (world.ts, redacted for private plots), so the
 * Manage read and write answer 404 to anyone who may not operate the space.
 * Unlocks come from the space's marks and the OWNER's supporter status (not the
 * operator's who happens to be editing). All rules are @grove/protocol decor.ts.
 */
export class DecorService {
  constructor(
    private store: GroveStore,
    private campus: CampusService,
    private marks: MarkService,
    private supporters: SupporterService,
  ) {}

  private async plotFor(human: Human, ref: string): Promise<WorldRow> {
    const world = await this.campus.getWorld(ref);
    if (!world || world.archivedAt) throw NOT_FOUND();
    await this.campus.assertOperate(human, world);
    if (world.plotIndex === null) throw new GroveError("INVALID", "This space has no plot on the map to decorate.");
    return world;
  }

  async unlocksFor(world: WorldRow): Promise<DecorUnlockInput> {
    const [marks, supporter] = await Promise.all([
      this.marks.forWorlds([world.id]),
      this.supporters.isActive(world.ownerHumanId),
    ]);
    return { marks: marks.get(world.id) ?? [], supporter };
  }

  private async view(world: WorldRow): Promise<DecorView> {
    const [{ rows }, unlocks] = await Promise.all([
      this.store.pg.query<{ decor: unknown }>(`SELECT decor FROM worlds WHERE id = $1`, [world.id]),
      this.unlocksFor(world),
    ]);
    return {
      items: readStoredDecor(rows[0]?.decor),
      catalogue: decorCatalogue(unlocks, this.supporters.enabled),
      maxItems: DECOR_MAX_ITEMS,
      slotCount: DECOR_SLOT_COUNT,
      hiddenWhilePrivate: world.policyPreset === "private",
    };
  }

  async get(human: Human, ref: string): Promise<DecorView> {
    return this.view(await this.plotFor(human, ref));
  }

  async set(human: Human, ref: string, raw: unknown): Promise<DecorView> {
    const world = await this.plotFor(human, ref);
    const r = validateDecor(raw, await this.unlocksFor(world));
    if (!r.ok) throw new GroveError("INVALID", r.message);
    await this.store.pg.query(`UPDATE worlds SET decor = $2 WHERE id = $1`, [
      world.id,
      r.items.length ? JSON.stringify(r.items) : null,
    ]);
    return this.view(world);
  }
}
