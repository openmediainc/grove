import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";

export type FreezeFlag = "freeze.register" | "freeze.enter" | "freeze.speech" | "freeze.agent_speak";

/** The four kill switches, in the order the operator console shows them. */
export const FREEZE_FLAGS: readonly FreezeFlag[] = [
  "freeze.register",
  "freeze.enter",
  "freeze.speech",
  "freeze.agent_speak",
];

/** What each switch actually stops, so the console can say it rather than guess. */
export const FREEZE_FLAG_EFFECTS: Record<FreezeFlag, string> = {
  "freeze.register": "Blocks POST /agents/register. Nobody new can bring an agent in.",
  "freeze.enter": "Blocks human embody and agent room join. Nobody new enters a room.",
  "freeze.speech": "Blocks room_say and emote for everyone. Owner channels stay live.",
  "freeze.agent_speak": "Blocks agent room_say only. Humans can still talk.",
};

export function isFreezeFlag(value: unknown): value is FreezeFlag {
  return typeof value === "string" && (FREEZE_FLAGS as readonly string[]).includes(value);
}

/** A switch plus the provenance that makes it reviewable: who flipped it, when, and why. */
export interface FreezeFlagState {
  flag: FreezeFlag;
  value: boolean;
  effect: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Handle of the operator who last flipped it, when they are still a known human. */
  updatedByHandle: string | null;
  /** The reason recorded on the most recent `mod.freeze` audit row for this flag. */
  reason: string | null;
}

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

  /**
   * The kill switch with its provenance.
   *
   * `world_flags` has carried `updated_at`/`updated_by` since 001 and nothing
   * ever read them, so a frozen world looked exactly like a healthy one to
   * anybody who had not been told. The reason is joined from the `mod.freeze`
   * audit row rather than stored a second time on the flag row: the ledger is
   * the record, this is a projection of it.
   *
   * Always returns all four, in FREEZE_FLAGS order, even before a flag has ever
   * been written — a missing row means "off", never "unknown".
   */
  async states(): Promise<FreezeFlagState[]> {
    const { rows } = await this.store.pg.query<{
      flag: string;
      value: boolean;
      updated_at: string | null;
      updated_by: string | null;
      handle: string | null;
      reason: string | null;
    }>(
      `SELECT f.flag, f.value, f.updated_at, f.updated_by, h.handle,
              (SELECT w.payload->>'reason' FROM world_events w
                WHERE w.type = 'mod.freeze' AND w.payload->>'flag' = f.flag
                ORDER BY w.created_at DESC LIMIT 1) AS reason
         FROM world_flags f
         LEFT JOIN humans h ON h.id = f.updated_by`,
    );
    const byFlag = new Map(rows.map((r) => [r.flag, r]));
    return FREEZE_FLAGS.map((flag) => {
      const r = byFlag.get(flag);
      return {
        flag,
        value: Boolean(r?.value),
        effect: FREEZE_FLAG_EFFECTS[flag],
        updatedAt: r?.updated_at ? new Date(r.updated_at).toISOString() : null,
        updatedBy: r?.updated_by ?? null,
        updatedByHandle: r?.handle ?? null,
        reason: r?.reason ?? null,
      };
    });
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

  /**
   * Flip a switch, and record that it was flipped.
   *
   * The audit row is written HERE rather than by the caller on purpose: this is
   * the only way to reach `world_flags`, so auditing at this level means no
   * route can ever freeze the world silently. The pre-existing
   * POST /api/v1/ops/freeze gains the audit trail without being touched.
   *
   * The flag name is validated rather than trusted: it arrives off the wire as
   * a bare string, and an unknown name used to insert a dead row that no
   * `isFrozen` check would ever consult — a switch that looked set and did
   * nothing. That is the worst possible failure for a kill switch.
   */
  async set(flag: FreezeFlag, value: boolean, updatedBy: string, reason?: string | null): Promise<void> {
    if (!isFreezeFlag(flag)) {
      throw new GroveError("INVALID", `Unknown freeze flag. Expected one of: ${FREEZE_FLAGS.join(", ")}.`);
    }
    await this.store.pg.query(
      `INSERT INTO world_flags (flag, value, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (flag) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
      [flag, value, updatedBy],
    );
    await this.store.pg.query(
      `INSERT INTO world_events (type, actor_id, payload) VALUES ('mod.freeze', $1, $2)`,
      [updatedBy, JSON.stringify({ flag, value, reason: reason ?? null })],
    );
  }
}
