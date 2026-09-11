import type { GroveStore } from "../store.js";
import { newId } from "../ids.js";
import type { PresenceService } from "./presence.js";
import type { WebhookService } from "./webhooks.js";

export interface MailboxItem {
  id: string;
  agentId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export class MailboxService {
  constructor(
    private store: GroveStore,
    private presence: PresenceService,
    private webhooks?: WebhookService,
  ) {}

  async enqueue(agentId: string, kind: string, payload: Record<string, unknown>): Promise<string> {
    const id = newId("mailbox");
    await this.store.pg.query(
      `INSERT INTO mailbox (id, agent_id, kind, payload) VALUES ($1,$2,$3,$4)`,
      [id, agentId, kind, JSON.stringify(payload)],
    );
    return id;
  }

  async enqueueIfOffline(agentId: string, kind: string, payload: Record<string, unknown>): Promise<string | null> {
    if (!agentId.startsWith("agt_")) return null;
    const p = await this.presence.getPresence(agentId);
    if (p && p.connection !== "offline") return null;
    const id = await this.enqueue(agentId, kind, payload);
    await this.webhooks?.enqueueWake(agentId, kind, { mailboxId: id });
    return id;
  }

  async unreadCount(agentId: string): Promise<number> {
    const { rows } = await this.store.pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM mailbox WHERE agent_id = $1 AND read_at IS NULL`,
      [agentId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async listUnread(agentId: string, limit = 50): Promise<MailboxItem[]> {
    const { rows } = await this.store.pg.query(
      `SELECT * FROM mailbox WHERE agent_id = $1 AND read_at IS NULL ORDER BY created_at DESC LIMIT $2`,
      [agentId, limit],
    );
    return rows.map(mapRow);
  }

  async markRead(agentId: string, ids?: string[]): Promise<number> {
    if (ids?.length) {
      const { rowCount } = await this.store.pg.query(
        `UPDATE mailbox SET read_at = now() WHERE agent_id = $1 AND id = ANY($2) AND read_at IS NULL`,
        [agentId, ids],
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await this.store.pg.query(
      `UPDATE mailbox SET read_at = now() WHERE agent_id = $1 AND read_at IS NULL`,
      [agentId],
    );
    return rowCount ?? 0;
  }
}

function mapRow(r: Record<string, unknown>): MailboxItem {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    kind: String(r.kind),
    payload: (r.payload ?? {}) as Record<string, unknown>,
    createdAt: new Date(String(r.created_at)).toISOString(),
    readAt: r.read_at ? new Date(String(r.read_at)).toISOString() : null,
  };
}
