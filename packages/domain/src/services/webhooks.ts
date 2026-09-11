import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import { randomToken } from "../crypto.js";
import { signWebhookBody } from "../webhook-sign.js";

export interface WebhookRow {
  id: string;
  ownerHumanId: string;
  url: string;
  secret?: string;
  enabled: boolean;
  createdAt: string;
}

export class WebhookService {
  constructor(private store: GroveStore) {}

  async create(ownerHumanId: string, url: string): Promise<WebhookRow> {
    const parsed = parseWebhookUrl(url);
    const id = newId("webhook");
    const secret = randomToken(24);
    const { rows } = await this.store.pg.query(
      `INSERT INTO webhooks (id, owner_human_id, url, secret, enabled) VALUES ($1,$2,$3,$4,FALSE) RETURNING *`,
      [id, ownerHumanId, parsed, secret],
    );
    return mapHook(rows[0] as Record<string, unknown>, true);
  }

  async patch(ownerHumanId: string, id: string, patch: { enabled?: boolean; url?: string }): Promise<WebhookRow> {
    const existing = await this.store.pg.query(`SELECT * FROM webhooks WHERE id = $1 AND owner_human_id = $2`, [
      id,
      ownerHumanId,
    ]);
    if (!existing.rows[0]) throw new GroveError("NOT_FOUND", "Webhook not found.", { httpStatus: 404 });
    const url = patch.url ? parseWebhookUrl(patch.url) : (existing.rows[0].url as string);
    const enabled = typeof patch.enabled === "boolean" ? patch.enabled : Boolean(existing.rows[0].enabled);
    const { rows } = await this.store.pg.query(
      `UPDATE webhooks SET url = $3, enabled = $4 WHERE id = $1 AND owner_human_id = $2 RETURNING *`,
      [id, ownerHumanId, url, enabled],
    );
    return mapHook(rows[0] as Record<string, unknown>, false);
  }

  async list(ownerHumanId: string): Promise<WebhookRow[]> {
    const { rows } = await this.store.pg.query(
      `SELECT id, owner_human_id, url, enabled, created_at FROM webhooks WHERE owner_human_id = $1 ORDER BY created_at`,
      [ownerHumanId],
    );
    return rows.map((r) => mapHook(r as Record<string, unknown>, false));
  }

  async enqueueWake(agentId: string, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!agentId.startsWith("agt_")) return;
    const { rows: agents } = await this.store.pg.query<{ owner_human_id: string | null }>(
      `SELECT owner_human_id FROM agents WHERE id = $1`,
      [agentId],
    );
    const ownerId = agents[0]?.owner_human_id;
    if (!ownerId) return;
    const { rows: hooks } = await this.store.pg.query(
      `SELECT id FROM webhooks WHERE owner_human_id = $1 AND enabled = TRUE`,
      [ownerId],
    );
    if (!hooks.length) return;
    for (const h of hooks) {
      const jobId = newId("job");
      await this.store.pg.query(
        `INSERT INTO jobs (id, kind, payload, run_at) VALUES ($1,'wake',$2, now())`,
        [
          jobId,
          JSON.stringify({
            webhookId: h.id,
            agentId,
            ownerHumanId: ownerId,
            reason,
            ...extra,
          }),
        ],
      );
    }
  }
}

export class JobService {
  constructor(private store: GroveStore) {}

  async processDue(limit = 20): Promise<number> {
    const { rows } = await this.store.pg.query(
      `SELECT * FROM jobs WHERE done_at IS NULL AND run_at <= now() AND attempts < 8 ORDER BY run_at LIMIT $1`,
      [limit],
    );
    let n = 0;
    for (const row of rows) {
      await this.store.pg.query(`UPDATE jobs SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      try {
        if (row.kind === "wake") await this.deliverWake(row.payload as Record<string, unknown>);
        await this.store.pg.query(`UPDATE jobs SET done_at = now() WHERE id = $1`, [row.id]);
        n += 1;
      } catch (err) {
        if (Number(row.attempts) + 1 >= 8) {
          await this.store.pg.query(`UPDATE jobs SET done_at = now() WHERE id = $1`, [row.id]);
        }
        console.warn("[grove] job failed", row.id, (err as Error).message);
      }
    }
    return n;
  }

  private async deliverWake(payload: Record<string, unknown>): Promise<void> {
    const webhookId = String(payload.webhookId ?? "");
    const { rows } = await this.store.pg.query(`SELECT * FROM webhooks WHERE id = $1`, [webhookId]);
    const hook = rows[0];
    if (!hook || !hook.enabled) return;
    const body = JSON.stringify({
      event: "wake",
      agent_id: payload.agentId,
      reason: payload.reason,
      created_at: new Date().toISOString(),
    });
    const sig = signWebhookBody(String(hook.secret), body);
    const res = await fetch(String(hook.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Grove-Signature": sig,
      },
      body,
    });
    if (!res.ok) throw new Error(`webhook ${res.status}`);
  }
}

function parseWebhookUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GroveError("INVALID", "url must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new GroveError("INVALID", "url must be http(s).");
  }
  const host = parsed.hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol === "http:" && !local) {
    throw new GroveError("INVALID", "http webhooks are only allowed on localhost.");
  }
  return parsed.toString();
}

function mapHook(r: Record<string, unknown>, withSecret: boolean): WebhookRow {
  return {
    id: String(r.id),
    ownerHumanId: String(r.owner_human_id),
    url: String(r.url),
    secret: withSecret && r.secret != null ? String(r.secret) : undefined,
    enabled: Boolean(r.enabled),
    createdAt: new Date(String(r.created_at)).toISOString(),
  };
}
