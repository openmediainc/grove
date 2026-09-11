import type { Human } from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import type { QuotaService } from "./quota.js";
import type { IdentityService } from "./identity.js";
import type { FlagService, FreezeFlag } from "./flags.js";
import type { PresenceService } from "./presence.js";

const REPORT_CATEGORIES = ["harassment", "spam", "illegal", "prompt_injection", "impersonation", "other"] as const;

export class ModerationService {
  constructor(
    private store: GroveStore,
    private quota: QuotaService,
    private identity: IdentityService,
    private flags?: FlagService,
    private presence?: PresenceService,
  ) {}

  async block(human: Human, targetId: string) {
    if (targetId === human.id) throw new GroveError("INVALID", "Cannot block yourself.");
    await this.store.pg.query(
      `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [human.id, targetId],
    );
    await this.identity.audit("block", human.id, { targetId });
    return { ok: true };
  }

  async mute(human: Human, targetId: string) {
    await this.store.pg.query(
      `INSERT INTO mutes (muter_id, muted_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [human.id, targetId],
    );
    return { ok: true };
  }

  async report(human: Human, input: { targetId: string; category: string; details?: string }) {
    await this.quota.consumeReport(human.id, false);
    if (!(REPORT_CATEGORIES as readonly string[]).includes(input.category)) {
      throw new GroveError("INVALID", "Unknown report category.");
    }
    const id = newId("report");
    const { rows } = await this.store.pg.query(
      `SELECT id, sender_id, body, created_at FROM speech
       WHERE room_id IN (SELECT room_id FROM presence WHERE actor_id = $1)
       ORDER BY created_at DESC LIMIT 20`,
      [input.targetId],
    );
    await this.store.pg.query(
      `INSERT INTO reports (id, reporter_id, target_id, category, details, snapshot)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, human.id, input.targetId, input.category, input.details ?? null, JSON.stringify({ last20: rows })],
    );
    await this.identity.audit("report", human.id, { reportId: id, targetId: input.targetId });
    if (this.store.config.operatorEmail) {
      console.log(`[grove] report ${id} ${input.category} target=${input.targetId} by=${human.handle}`);
    }
    return { id, status: "open" };
  }

  async audit(agentId: string, ownerId: string) {
    const { rows } = await this.store.pg.query(
      `SELECT type, payload, created_at FROM world_events
       WHERE actor_id = $1 OR (payload->>'owner' = $2) OR (payload->>'by' = $2 AND payload->>'agentId' = $1)
       ORDER BY created_at DESC LIMIT 100`,
      [agentId, ownerId],
    );
    const { rows: speech } = await this.store.pg.query(
      `SELECT id, channel, body, created_at FROM speech WHERE sender_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [agentId],
    );
    return {
      events: rows.map((r) => ({
        type: r.type,
        payload: r.payload,
        createdAt: new Date(r.created_at as string).toISOString(),
      })),
      speech: speech.map((r) => ({
        id: r.id,
        channel: r.channel,
        body: r.body,
        createdAt: new Date(r.created_at as string).toISOString(),
      })),
    };
  }

  async listReports(status = "open") {
    const { rows } = await this.store.pg.query(
      `SELECT * FROM reports WHERE ($1 = 'all' OR status = $1) ORDER BY created_at DESC LIMIT 100`,
      [status],
    );
    return rows.map((r) => ({
      id: r.id as string,
      reporterId: r.reporter_id as string,
      targetId: r.target_id as string,
      category: r.category as string,
      details: r.details as string | null,
      snapshot: r.snapshot,
      createdAt: new Date(r.created_at as string).toISOString(),
      status: r.status as string,
    }));
  }

  async resolveReport(
    operator: Human,
    reportId: string,
    input: { status: "resolved" | "rejected"; action?: "suspend_agent" | "suspend_human" | "freeze_speech" },
  ) {
    const { rows } = await this.store.pg.query(`SELECT * FROM reports WHERE id = $1`, [reportId]);
    if (!rows[0]) throw new GroveError("NOT_FOUND", "Report not found.", { httpStatus: 404 });
    await this.store.pg.query(`UPDATE reports SET status = $2 WHERE id = $1`, [reportId, input.status]);
    if (input.action === "suspend_agent" || input.action === "suspend_human") {
      await this.suspend(rows[0].target_id as string, operator.id);
    }
    if (input.action === "freeze_speech") {
      await this.flags?.set("freeze.speech" as FreezeFlag, true, operator.id);
    }
    await this.identity.audit("report_resolved", operator.id, {
      reportId,
      status: input.status,
      action: input.action ?? null,
    });
    return { id: reportId, status: input.status, action: input.action ?? null };
  }

  async suspend(actorId: string, by: string) {
    if (actorId.startsWith("agt_")) {
      const { rowCount } = await this.store.pg.query(
        `UPDATE agents SET claim_state = 'suspended' WHERE id = $1`,
        [actorId],
      );
      if (!rowCount) throw new GroveError("NOT_FOUND", "Actor not found.", { httpStatus: 404 });
    } else if (actorId.startsWith("hum_")) {
      const { rowCount } = await this.store.pg.query(
        `UPDATE humans SET suspended_at = now() WHERE id = $1`,
        [actorId],
      );
      if (!rowCount) throw new GroveError("NOT_FOUND", "Actor not found.", { httpStatus: 404 });
    } else {
      throw new GroveError("INVALID", "actor_id must be hum_ or agt_.");
    }
    await this.presence?.leave(actorId);
    await this.identity.audit("suspended", actorId, { by });
    return { actorId, suspended: true };
  }
}
