import { PUBLIC_ROOMS, WORLD_ID, type Human } from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";

export interface WorldRow {
  id: string;
  slug: string;
  name: string;
  ownerHumanId: string | null;
  createdAt: string;
}

export interface StageEventRow {
  id: string;
  worldId: string;
  roomId: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  createdBy: string;
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
      `SELECT DISTINCT w.*
       FROM worlds w
       LEFT JOIN world_members m ON m.world_id = w.id AND m.human_id = $1
       WHERE w.id = $2 OR w.owner_human_id = $1 OR m.human_id IS NOT NULL
       ORDER BY CASE WHEN w.id = $2 THEN 0 ELSE 1 END, w.created_at`,
      [humanId, WORLD_ID],
    );
    return rows.map((r) => mapWorld(r as Record<string, unknown>));
  }

  async createWorld(owner: Human, input: { name: string; slug: string }): Promise<WorldRow> {
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
    try {
      const { rows } = await this.store.pg.query(
        `INSERT INTO worlds (id, slug, name, owner_human_id) VALUES ($1,$2,$3,$4) RETURNING *`,
        [id, slug, name, owner.id],
      );
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
      const code = (err as { code?: string }).code;
      if (code === "23505") throw new GroveError("SLUG_TAKEN", "That campus slug is taken.");
      throw err;
    }
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

  async createEvent(
    human: Human,
    input: { worldId?: string; roomId?: string; title: string; startsAt: string; endsAt?: string | null },
  ): Promise<StageEventRow> {
    const world = await this.requireWorld(input.worldId ?? WORLD_ID);
    await this.assertOperate(human, world);
    const title = input.title.trim().slice(0, 140);
    if (!title) throw new GroveError("INVALID", "title is required.");
    const roomId = input.roomId ?? (world.id === WORLD_ID ? "stage" : `${world.id}:stage`);
    const id = newId("event");
    const { rows } = await this.store.pg.query(
      `INSERT INTO stage_events (id, world_id, room_id, title, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, world.id, roomId, title, input.startsAt, input.endsAt ?? null, human.id],
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
  };
}

function mapEvent(r: Record<string, unknown>): StageEventRow {
  return {
    id: String(r.id),
    worldId: String(r.world_id),
    roomId: String(r.room_id),
    title: String(r.title),
    startsAt: new Date(String(r.starts_at)).toISOString(),
    endsAt: r.ends_at ? new Date(String(r.ends_at)).toISOString() : null,
    createdBy: String(r.created_by),
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
