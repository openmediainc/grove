import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";

export type FreezeFlag = "freeze.register" | "freeze.enter" | "freeze.speech" | "freeze.agent_speak";

export class FlagService {
  constructor(private store: GroveStore) {}

  async getAll(): Promise<Record<FreezeFlag, boolean>> {
    const { rows } = await this.store.pg.query<{ flag: FreezeFlag; value: boolean }>(
      "SELECT flag, value FROM world_flags",
    );
    const out: Record<string, boolean> = {
      "freeze.register": false,
      "freeze.enter": false,
      "freeze.speech": false,
      "freeze.agent_speak": false,
    };
    for (const r of rows) out[r.flag] = r.value;
    return out as Record<FreezeFlag, boolean>;
  }

  async isFrozen(flag: FreezeFlag): Promise<boolean> {
    const { rows } = await this.store.pg.query<{ value: boolean }>(
      "SELECT value FROM world_flags WHERE flag = $1",
      [flag],
    );
    return Boolean(rows[0]?.value);
  }

  async assertNotFrozen(flag: FreezeFlag, message: string): Promise<void> {
    if (await this.isFrozen(flag)) {
      throw new GroveError("FROZEN", message);
    }
  }

  async set(flag: FreezeFlag, value: boolean, updatedBy: string): Promise<void> {
    await this.store.pg.query(
      `INSERT INTO world_flags (flag, value, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (flag) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
      [flag, value, updatedBy],
    );
  }
}
