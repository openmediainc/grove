import type { Human } from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import type { QuotaService } from "./quota.js";
import type { IdentityService } from "./identity.js";
import type { MailboxService } from "./mailbox.js";
import { isFreezeFlag, type FlagService, type FreezeFlag } from "./flags.js";
import type { PresenceService } from "./presence.js";

export const REPORT_CATEGORIES = [
  "harassment",
  "spam",
  "illegal",
  "prompt_injection",
  "impersonation",
  "other",
] as const;

/**
 * Triage order. `illegal` is the one category with a legal clock on it, so it
 * sorts first however old it is; `other` is the bucket people use when they are
 * not sure, so it sorts last. Within a band the queue is newest-first.
 */
const CATEGORY_RANK: Record<string, number> = {
  illegal: 0,
  harassment: 1,
  impersonation: 2,
  prompt_injection: 3,
  spam: 4,
  other: 5,
};

/**
 * What a moderator can actually DO about a report. Every one of these either
 * already existed in the domain layer (`suspend`, `flags.set`) or is recorded
 * as an event in the same ledger (`dismiss`, `warn`) — there is no fifth verb
 * hiding in the UI.
 */
export const MOD_DECISIONS = ["dismiss", "warn", "suspend", "freeze"] as const;
export type ModDecision = (typeof MOD_DECISIONS)[number];

export function isModDecision(value: unknown): value is ModDecision {
  return typeof value === "string" && (MOD_DECISIONS as readonly string[]).includes(value);
}

export const INJECTION_OUTCOMES = ["benign", "actioned"] as const;
export type InjectionOutcome = (typeof INJECTION_OUTCOMES)[number];

/** Who an id belongs to, resolved once so no surface has to render a bare `agt_…`. */
export interface ActorRef {
  id: string;
  kind: "human" | "agent" | "unknown";
  displayName: string;
  /** Human handle or agent slug. */
  handle: string | null;
  ownerHumanId: string | null;
  ownerHandle: string | null;
  suspended: boolean;
  claimState: string | null;
  role: string | null;
}

export interface SpeechLine {
  id: string;
  channel: string | null;
  roomId: string | null;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: string;
}

export interface ReportSummary {
  id: string;
  reporterId: string;
  targetId: string;
  reporter: ActorRef;
  target: ActorRef;
  category: string;
  details: string | null;
  snapshot: unknown;
  createdAt: string;
  status: string;
  resolution: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedByHandle: string | null;
  resolvedAt: string | null;
  /** How many times this target has ever been reported, this report included. */
  targetReportCount: number;
  /** How many warnings this target already carries. Escalation is a judgement call; this is the input to it. */
  targetWarnCount: number;
  /** Unreviewed prompt-injection flags standing against this target. */
  targetInjectionFlagCount: number;
  /** What the report is about when it is not just an actor: 'board_post' (041), else null. */
  targetKind: string | null;
  /** The reported thing's id (a board post id), else null. */
  targetRef: string | null;
  /** The reported board post as it stands now; null when it was deleted or the report is about an actor. */
  boardPost: ReportedBoardPost | null;
}

/** A reported board post, for the queue. `imageUrl` is the operator-only image route. */
export interface ReportedBoardPost {
  id: string;
  kind: string;
  caption: string | null;
  linkUrl: string | null;
  linkTitle: string | null;
  imageUrl: string | null;
  hiddenByMod: boolean;
  hiddenReason: string | null;
  spaceId: string;
  spaceSlug: string;
  spaceName: string;
  createdAt: string;
}

export interface ReportDetail extends ReportSummary {
  /** The transcript captured at report time, with sender names filled in. */
  snapshotLines: SpeechLine[];
  /** What the target said either side of the report — the snapshot cannot show what happened next. */
  targetSpeech: SpeechLine[];
  /** The reporter's own lines in the same window, so provocation is visible too. */
  reporterSpeech: SpeechLine[];
  /** Every previous moderator action against this target. */
  targetHistory: ModActionEntry[];
}

export interface ModActionEntry {
  id: string;
  type: string;
  actorId: string | null;
  actorHandle: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface InjectionFlag {
  eventId: string;
  actor: ActorRef;
  channel: string | null;
  createdAt: string;
  /** The line that tripped the heuristic, when it survived to be stored. */
  speech: SpeechLine | null;
  reviewed: boolean;
  outcome: string | null;
  note: string | null;
  reviewedBy: string | null;
  reviewedByHandle: string | null;
  reviewedAt: string | null;
}

const UNKNOWN_ACTOR = (id: string): ActorRef => ({
  id,
  kind: "unknown",
  displayName: id,
  handle: null,
  ownerHumanId: null,
  ownerHandle: null,
  suspended: false,
  claimState: null,
  role: null,
});

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/** Free text a moderator typed. Kept, trimmed, capped — never silently dropped. */
const REASON_MAX = 1000;
function reason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, REASON_MAX);
}

export class ModerationService {
  constructor(
    private store: GroveStore,
    private quota: QuotaService,
    private identity: IdentityService,
    private flags?: FlagService,
    private presence?: PresenceService,
    private mailbox?: MailboxService,
  ) {}

  // -------------------------------------------------------------------------
  // Inhabitant-facing: block, mute, report. Unchanged behaviour.
  // -------------------------------------------------------------------------

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

  /** Owner-facing audit of one of their agents. Unchanged. */
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
        createdAt: iso(r.created_at),
      })),
      speech: speech.map((r) => ({
        id: r.id,
        channel: r.channel,
        body: r.body,
        createdAt: iso(r.created_at),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Identity resolution.
  // -------------------------------------------------------------------------

  /**
   * Resolve a batch of actor ids to something a moderator can read.
   *
   * Batched on purpose: a queue page holds two ids per report and would
   * otherwise fire 2N round trips. An id with no row comes back as `unknown`
   * rather than being dropped — a report against a deleted actor is still a
   * report, and silently losing it would be the wrong kind of quiet.
   */
  private async describeActors(ids: readonly string[]): Promise<Map<string, ActorRef>> {
    const out = new Map<string, ActorRef>();
    const wanted = [...new Set(ids.filter(Boolean))];
    if (!wanted.length) return out;

    const humans = await this.store.pg.query(
      `SELECT id, handle::text AS handle, display_name, role, (suspended_at IS NOT NULL) AS suspended
         FROM humans WHERE id = ANY($1::text[])`,
      [wanted],
    );
    for (const r of humans.rows) {
      out.set(String(r.id), {
        id: String(r.id),
        kind: "human",
        displayName: String(r.display_name),
        handle: r.handle === null ? null : String(r.handle),
        ownerHumanId: null,
        ownerHandle: null,
        suspended: Boolean(r.suspended),
        claimState: null,
        role: r.role === null ? null : String(r.role),
      });
    }

    const agents = await this.store.pg.query(
      `SELECT a.id, a.slug::text AS slug, a.display_name, a.claim_state, a.owner_human_id,
              oh.handle::text AS owner_handle
         FROM agents a
         LEFT JOIN humans oh ON oh.id = a.owner_human_id
        WHERE a.id = ANY($1::text[])`,
      [wanted],
    );
    for (const r of agents.rows) {
      out.set(String(r.id), {
        id: String(r.id),
        kind: "agent",
        displayName: String(r.display_name),
        handle: r.slug === null ? null : String(r.slug),
        ownerHumanId: r.owner_human_id === null ? null : String(r.owner_human_id),
        ownerHandle: r.owner_handle === null ? null : String(r.owner_handle),
        suspended: r.claim_state === "suspended",
        claimState: r.claim_state === null ? null : String(r.claim_state),
        role: null,
      });
    }

    for (const id of wanted) if (!out.has(id)) out.set(id, UNKNOWN_ACTOR(id));
    return out;
  }

  /** One actor, or NOT_FOUND. Used by every verb that takes an actor id off the wire. */
  async describeActor(id: string): Promise<ActorRef> {
    if (!id) throw new GroveError("INVALID", "actor_id is required.");
    const found = (await this.describeActors([id])).get(id);
    if (!found || found.kind === "unknown") {
      throw new GroveError("NOT_FOUND", "Actor not found.", { httpStatus: 404 });
    }
    return found;
  }

  private linesFrom(rows: Array<Record<string, unknown>>, names: Map<string, ActorRef>): SpeechLine[] {
    return rows.map((r) => {
      const senderId = String(r.sender_id ?? "");
      return {
        id: String(r.id ?? ""),
        channel: r.channel === null || r.channel === undefined ? null : String(r.channel),
        roomId: r.room_id === null || r.room_id === undefined ? null : String(r.room_id),
        senderId,
        senderName: names.get(senderId)?.displayName ?? senderId,
        body: String(r.body ?? ""),
        createdAt: iso(r.created_at),
      };
    });
  }

  // -------------------------------------------------------------------------
  // The queue.
  // -------------------------------------------------------------------------

  /**
   * The triage list.
   *
   * One query for the reports (counts folded in as correlated subselects so a
   * page of 50 is still one round trip), one to name every actor mentioned.
   * Sorted open-first, then by category severity, then newest — a moderator
   * working top-down is working the right thing.
   */
  async queue(input: { status?: string; limit?: number } = {}): Promise<ReportSummary[]> {
    const status = input.status ?? "open";
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
    const { rows } = await this.store.pg.query(
      `SELECT r.*,
              (SELECT count(*) FROM reports r2 WHERE r2.target_id = r.target_id) AS target_report_count,
              (SELECT count(*) FROM world_events w
                WHERE w.type = 'mod.warn' AND w.payload->>'targetId' = r.target_id) AS target_warn_count,
              (SELECT count(*) FROM world_events w
                LEFT JOIN injection_reviews ir ON ir.event_id = w.id
                WHERE w.type = 'prompt_injection_flag' AND w.actor_id = r.target_id
                  AND ir.event_id IS NULL) AS target_injection_flag_count,
              rh.handle::text AS resolved_by_handle
         FROM reports r
         LEFT JOIN humans rh ON rh.id = r.resolved_by
        WHERE ($1 = 'all' OR r.status = $1)
        ORDER BY (r.status = 'open') DESC,
                 COALESCE(($2::jsonb)->>r.category, '9')::int,
                 r.created_at DESC
        LIMIT $3`,
      [status, JSON.stringify(CATEGORY_RANK), limit],
    );
    const names = await this.describeActors(rows.flatMap((r) => [String(r.reporter_id), String(r.target_id)]));
    const posts = await this.reportedBoardPosts(rows);
    return rows.map((r) => this.toSummary(r, names, posts));
  }

  /** Board posts named by `target_ref` on 'board_post' reports, in one query. */
  private async reportedBoardPosts(rows: Array<Record<string, unknown>>): Promise<Map<string, ReportedBoardPost>> {
    const out = new Map<string, ReportedBoardPost>();
    const ids = [
      ...new Set(rows.filter((r) => r.target_kind === "board_post" && r.target_ref).map((r) => String(r.target_ref))),
    ];
    if (!ids.length) return out;
    const { rows: posts } = await this.store.pg.query(
      `SELECT p.id, p.kind, p.caption, p.link_url, p.link_preview->>'title' AS link_title, p.hidden_by_mod,
              p.hidden_reason, p.created_at, w.id AS world_id, w.slug::text AS world_slug, w.name AS world_name
         FROM board_posts p JOIN worlds w ON w.id = p.world_id
        WHERE p.id = ANY($1::text[])`,
      [ids],
    );
    for (const p of posts) {
      const id = String(p.id);
      out.set(id, {
        id,
        kind: String(p.kind),
        caption: p.caption == null ? null : String(p.caption),
        linkUrl: p.link_url == null ? null : String(p.link_url),
        linkTitle: p.link_title == null ? null : String(p.link_title),
        imageUrl: p.kind === "image" ? `/api/v1/mod/board/posts/${encodeURIComponent(id)}/image` : null,
        hiddenByMod: Boolean(p.hidden_by_mod),
        hiddenReason: p.hidden_reason == null ? null : String(p.hidden_reason),
        spaceId: String(p.world_id),
        spaceSlug: String(p.world_slug),
        spaceName: String(p.world_name),
        createdAt: iso(p.created_at),
      });
    }
    return out;
  }

  private toSummary(
    r: Record<string, unknown>,
    names: Map<string, ActorRef>,
    posts: Map<string, ReportedBoardPost> = new Map(),
  ): ReportSummary {
    const reporterId = String(r.reporter_id);
    const targetId = String(r.target_id);
    return {
      id: String(r.id),
      reporterId,
      targetId,
      reporter: names.get(reporterId) ?? UNKNOWN_ACTOR(reporterId),
      target: names.get(targetId) ?? UNKNOWN_ACTOR(targetId),
      category: String(r.category),
      details: r.details === null || r.details === undefined ? null : String(r.details),
      snapshot: r.snapshot ?? null,
      createdAt: iso(r.created_at),
      status: String(r.status),
      resolution: r.resolution === null || r.resolution === undefined ? null : String(r.resolution),
      resolutionNote:
        r.resolution_note === null || r.resolution_note === undefined ? null : String(r.resolution_note),
      resolvedBy: r.resolved_by === null || r.resolved_by === undefined ? null : String(r.resolved_by),
      resolvedByHandle:
        r.resolved_by_handle === null || r.resolved_by_handle === undefined
          ? null
          : String(r.resolved_by_handle),
      resolvedAt: isoOrNull(r.resolved_at),
      targetReportCount: Number(r.target_report_count ?? 0),
      targetWarnCount: Number(r.target_warn_count ?? 0),
      targetInjectionFlagCount: Number(r.target_injection_flag_count ?? 0),
      targetKind: r.target_kind == null ? null : String(r.target_kind),
      targetRef: r.target_ref == null ? null : String(r.target_ref),
      boardPost: r.target_kind === "board_post" && r.target_ref ? (posts.get(String(r.target_ref)) ?? null) : null,
    };
  }

  /** The list reader that already existed. Same shape plus the new fields. */
  async listReports(status = "open"): Promise<ReportSummary[]> {
    return this.queue({ status });
  }

  /**
   * One report with everything needed to decide it without leaving the page.
   *
   * The snapshot alone is not enough: it is the room's last 20 lines at the
   * moment the reporter hit the button, so it can miss the reply that mattered
   * and it never shows what happened AFTER. The window either side, for both
   * parties, is what turns "they were rude" into a decision.
   */
  async reportDetail(reportId: string): Promise<ReportDetail> {
    const { rows } = await this.store.pg.query(
      `SELECT r.*,
              (SELECT count(*) FROM reports r2 WHERE r2.target_id = r.target_id) AS target_report_count,
              (SELECT count(*) FROM world_events w
                WHERE w.type = 'mod.warn' AND w.payload->>'targetId' = r.target_id) AS target_warn_count,
              (SELECT count(*) FROM world_events w
                LEFT JOIN injection_reviews ir ON ir.event_id = w.id
                WHERE w.type = 'prompt_injection_flag' AND w.actor_id = r.target_id
                  AND ir.event_id IS NULL) AS target_injection_flag_count,
              rh.handle::text AS resolved_by_handle
         FROM reports r
         LEFT JOIN humans rh ON rh.id = r.resolved_by
        WHERE r.id = $1`,
      [reportId],
    );
    const row = rows[0];
    if (!row) throw new GroveError("NOT_FOUND", "Report not found.", { httpStatus: 404 });

    const reporterId = String(row.reporter_id);
    const targetId = String(row.target_id);
    const snapshotRows = readSnapshotLines(row.snapshot);

    // ±30 minutes around the report. Wide enough to hold a conversation, narrow
    // enough that a busy actor's page is still the incident and not their week.
    const window = "interval '30 minutes'";
    const speechFor = async (actorId: string, cap: number) => {
      const res = await this.store.pg.query(
        `SELECT id, channel, room_id, sender_id, body, created_at
           FROM speech
          WHERE sender_id = $1
            AND created_at BETWEEN $2::timestamptz - ${window} AND $2::timestamptz + ${window}
          ORDER BY created_at ASC
          LIMIT $3`,
        [actorId, row.created_at, cap],
      );
      return res.rows as Array<Record<string, unknown>>;
    };
    const [targetRows, reporterRows, history] = await Promise.all([
      speechFor(targetId, 60),
      speechFor(reporterId, 30),
      this.actionsAgainst(targetId),
    ]);

    const names = await this.describeActors([
      reporterId,
      targetId,
      ...snapshotRows.map((s) => s.senderId),
      ...targetRows.map((r) => String(r.sender_id)),
      ...reporterRows.map((r) => String(r.sender_id)),
    ]);

    return {
      ...this.toSummary(row, names, await this.reportedBoardPosts([row])),
      snapshotLines: snapshotRows.map((s) => ({
        ...s,
        senderName: names.get(s.senderId)?.displayName ?? s.senderId,
      })),
      targetSpeech: this.linesFrom(targetRows, names),
      reporterSpeech: this.linesFrom(reporterRows, names),
      targetHistory: history,
    };
  }

  // -------------------------------------------------------------------------
  // Decisions.
  // -------------------------------------------------------------------------

  /**
   * Act on a report.
   *
   * `status` keeps its old vocabulary so the pre-existing /ops reader is not
   * disturbed; `resolution` records the verb the moderator actually chose. Both
   * are stored, and the audit row carries the reason, because six months from
   * now "why was this account suspended" must have an answer that is not
   * somebody's memory.
   *
   * A reason is REQUIRED for anything that touches an inhabitant (warn,
   * suspend, freeze). Dismissal may be silent — there is nothing to justify.
   */
  async decide(
    operator: Human,
    reportId: string,
    input: {
      decision: ModDecision;
      reason?: string | null;
      freezeFlag?: FreezeFlag;
      status?: "resolved" | "rejected";
    },
  ) {
    if (!isModDecision(input.decision)) {
      throw new GroveError("INVALID", `decision must be one of: ${MOD_DECISIONS.join(", ")}.`);
    }
    const { rows } = await this.store.pg.query(`SELECT * FROM reports WHERE id = $1`, [reportId]);
    const report = rows[0];
    if (!report) throw new GroveError("NOT_FOUND", "Report not found.", { httpStatus: 404 });

    const why = reason(input.reason);
    if (input.decision !== "dismiss" && !why) {
      throw new GroveError("INVALID", "A reason is required for warn, suspend and freeze.");
    }

    const targetId = String(report.target_id);
    const status = input.status ?? (input.decision === "dismiss" ? "rejected" : "resolved");
    let effect: Record<string, unknown> = {};

    if (input.decision === "warn") {
      effect = await this.warn(operator, targetId, why, { reportId });
    } else if (input.decision === "suspend") {
      effect = await this.suspend(targetId, operator.id, why, reportId);
    } else if (input.decision === "freeze") {
      const flag = input.freezeFlag ?? "freeze.speech";
      effect = await this.setFreeze(operator, flag, true, why);
    }

    await this.store.pg.query(
      `UPDATE reports
          SET status = $2, resolution = $3, resolution_note = $4, resolved_by = $5, resolved_at = now()
        WHERE id = $1`,
      [reportId, status, input.decision, why, operator.id],
    );

    // The report decision is audited separately from the effect it triggered:
    // one row says "this report was closed as X", the other says "this actor
    // was suspended". Collapsing them would lose the report on the actor's page.
    await this.identity.audit("mod.report_decided", operator.id, {
      reportId,
      status,
      decision: input.decision,
      reason: why,
      targetId,
      category: String(report.category),
    });

    return {
      id: reportId,
      status,
      decision: input.decision,
      resolution: input.decision,
      reason: why,
      // Legacy key: the pre-existing /ops/reports/:id reader reads `action`.
      action: input.decision === "dismiss" ? null : input.decision,
      effect,
    };
  }

  /**
   * The pre-existing resolve entry point, kept verbatim in signature so
   * apps/api/src/routes.ts continues to compile and behave. It is a thin
   * translation onto `decide`, so the old route now audits and records a
   * resolution like the new one does.
   */
  async resolveReport(
    operator: Human,
    reportId: string,
    input: {
      status: "resolved" | "rejected";
      action?: "suspend_agent" | "suspend_human" | "freeze_speech";
      note?: string;
    },
  ) {
    const decision: ModDecision =
      input.action === "suspend_agent" || input.action === "suspend_human"
        ? "suspend"
        : input.action === "freeze_speech"
          ? "freeze"
          : "dismiss";
    return this.decide(operator, reportId, {
      decision,
      status: input.status,
      // The old route has no reason field, and warn/suspend/freeze demand one.
      // Say so plainly rather than refusing a call that used to work.
      reason: input.note ?? (decision === "dismiss" ? null : `via legacy /ops/reports/${reportId}`),
      ...(decision === "freeze" ? { freezeFlag: "freeze.speech" as FreezeFlag } : {}),
    });
  }

  /**
   * Warn an inhabitant.
   *
   * A warning that the warned party never sees is theatre, so for an agent it
   * is delivered onto the one channel agents actually read — the mailbox —
   * alongside the ledger row. For a human there is no notification channel in
   * Grove yet, so the warning is recorded and readable back through
   * `warningsFor`; the delivery surface is a deliberate gap, not an oversight.
   *
   * The audit payload carries `owner` and `agentId` so the agent's OWNER sees
   * the warning in their own audit view. Owner accountability (RULES.md) is
   * worth nothing if the owner is the last to know.
   */
  async warn(
    operator: Human,
    targetId: string,
    why: string | null,
    opts: { reportId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const text = reason(why);
    if (!text) throw new GroveError("INVALID", "A warning needs a reason.");
    const target = await this.describeActor(targetId);

    await this.identity.audit("mod.warn", operator.id, {
      targetId,
      targetKind: target.kind,
      reason: text,
      reportId: opts.reportId ?? null,
      by: operator.id,
      ...(target.kind === "agent"
        ? { agentId: target.id, owner: target.ownerHumanId }
        : {}),
    });

    let delivered = false;
    if (target.kind === "agent" && this.mailbox) {
      await this.mailbox.enqueue(target.id, "moderation_warning", {
        reason: text,
        reportId: opts.reportId ?? null,
        rules: "/docs/rules",
      });
      delivered = true;
    }

    const warnings = await this.warnCount(targetId);
    return { targetId, warned: true, delivered, warnings };
  }

  private async warnCount(targetId: string): Promise<number> {
    const { rows } = await this.store.pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM world_events
        WHERE type = 'mod.warn' AND payload->>'targetId' = $1`,
      [targetId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Warnings standing against an actor, newest first. Readable by the actor's owner too. */
  async warningsFor(actorId: string): Promise<ModActionEntry[]> {
    const { rows } = await this.store.pg.query(
      `SELECT w.id, w.type, w.actor_id, w.payload, w.created_at, h.handle::text AS handle
         FROM world_events w
         LEFT JOIN humans h ON h.id = w.actor_id
        WHERE w.type = 'mod.warn' AND w.payload->>'targetId' = $1
        ORDER BY w.created_at DESC LIMIT 50`,
      [actorId],
    );
    return rows.map(toActionEntry);
  }

  /**
   * Suspend an actor.
   *
   * Signature is backwards-compatible with the original two-argument call in
   * routes.ts. The audit row moved: it used to be written with the TARGET as
   * `actor_id` and the moderator buried in the payload, which made "what has
   * this moderator done" unanswerable. Now the moderator is the actor and the
   * target is in the payload — alongside `owner`/`agentId`, which is what keeps
   * the owner-facing audit view working.
   */
  async suspend(actorId: string, by: string, why?: string | null, reportId?: string) {
    const target = await this.describeActor(actorId);
    if (target.kind === "agent") {
      const { rowCount } = await this.store.pg.query(
        `UPDATE agents SET claim_state = 'suspended' WHERE id = $1`,
        [actorId],
      );
      if (!rowCount) throw new GroveError("NOT_FOUND", "Actor not found.", { httpStatus: 404 });
    } else if (target.kind === "human") {
      const { rowCount } = await this.store.pg.query(
        `UPDATE humans SET suspended_at = now() WHERE id = $1`,
        [actorId],
      );
      if (!rowCount) throw new GroveError("NOT_FOUND", "Actor not found.", { httpStatus: 404 });
    } else {
      throw new GroveError("INVALID", "actor_id must be hum_ or agt_.");
    }
    await this.presence?.leave(actorId);
    await this.identity.audit("mod.suspend", by, {
      targetId: actorId,
      targetKind: target.kind,
      reason: reason(why),
      reportId: reportId ?? null,
      by,
      ...(target.kind === "agent" ? { agentId: target.id, owner: target.ownerHumanId } : {}),
    });
    return { actorId, suspended: true };
  }

  /**
   * Lift a suspension.
   *
   * A queue with no way back is a queue nobody dares use. An agent's previous
   * claim state is not stored anywhere (suspend overwrites it), so it is
   * derived the only honest way: an agent with an owner was claimed, one
   * without was still pending.
   */
  async unsuspend(actorId: string, by: string, why?: string | null) {
    const target = await this.describeActor(actorId);
    if (target.kind === "agent") {
      await this.store.pg.query(
        `UPDATE agents
            SET claim_state = CASE WHEN owner_human_id IS NULL THEN 'pending' ELSE 'claimed' END
          WHERE id = $1 AND claim_state = 'suspended'`,
        [actorId],
      );
    } else if (target.kind === "human") {
      await this.store.pg.query(`UPDATE humans SET suspended_at = NULL WHERE id = $1`, [actorId]);
    } else {
      throw new GroveError("INVALID", "actor_id must be hum_ or agt_.");
    }
    await this.identity.audit("mod.unsuspend", by, {
      targetId: actorId,
      targetKind: target.kind,
      reason: reason(why),
      by,
      ...(target.kind === "agent" ? { agentId: target.id, owner: target.ownerHumanId } : {}),
    });
    return { actorId, suspended: false };
  }

  // -------------------------------------------------------------------------
  // The kill switch.
  // -------------------------------------------------------------------------

  /** All four switches with their current state and who last touched them. */
  async freezeStates() {
    if (!this.flags) throw new GroveError("INVALID", "Flags are not configured.");
    return this.flags.states();
  }

  /**
   * Flip a switch, with a reason. FlagService.set writes the `mod.freeze` audit
   * row itself, so there is no path to the kill switch that skips the ledger.
   */
  async setFreeze(operator: Human, flag: FreezeFlag, value: boolean, why?: string | null) {
    if (!this.flags) throw new GroveError("INVALID", "Flags are not configured.");
    if (!isFreezeFlag(flag)) throw new GroveError("INVALID", "Unknown freeze flag.");
    const text = reason(why);
    if (value && !text) throw new GroveError("INVALID", "Freezing the world needs a reason.");
    await this.flags.set(flag, value, operator.id, text);
    return { flag, value, reason: text };
  }

  // -------------------------------------------------------------------------
  // Prompt-injection flags.
  // -------------------------------------------------------------------------

  /**
   * The injection queue.
   *
   * speech.ts writes `prompt_injection_flag` into world_events carrying only
   * the sender and the channel — not the body, and not the speech id. That is
   * why this joins laterally back to `speech`: the flag is written immediately
   * before the row is inserted, so the offending line is that sender's next
   * line on that channel. When the line was refused by the policy kernel after
   * being flagged there IS no row, and `speech` comes back null rather than the
   * query dropping the flag entirely.
   */
  async injectionFlags(input: { state?: "open" | "reviewed" | "all"; limit?: number } = {}) {
    const state = input.state ?? "open";
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
    const { rows } = await this.store.pg.query(
      `SELECT e.id, e.actor_id, e.payload, e.created_at,
              ir.outcome, ir.note, ir.reviewed_by, ir.reviewed_at,
              rh.handle::text AS reviewed_by_handle,
              s.id AS speech_id, s.body AS speech_body, s.room_id AS speech_room,
              s.channel AS speech_channel, s.created_at AS speech_at
         FROM world_events e
         LEFT JOIN injection_reviews ir ON ir.event_id = e.id
         LEFT JOIN humans rh ON rh.id = ir.reviewed_by
         LEFT JOIN LATERAL (
           SELECT sp.id, sp.body, sp.room_id, sp.channel, sp.created_at
             FROM speech sp
            WHERE sp.sender_id = e.actor_id
              AND sp.created_at >= e.created_at - interval '5 seconds'
              AND sp.created_at <= e.created_at + interval '60 seconds'
              AND (e.payload->>'channel' IS NULL OR sp.channel = e.payload->>'channel')
            ORDER BY sp.created_at ASC
            LIMIT 1
         ) s ON TRUE
        WHERE e.type = 'prompt_injection_flag'
          AND ($1 = 'all'
               OR ($1 = 'open' AND ir.event_id IS NULL)
               OR ($1 = 'reviewed' AND ir.event_id IS NOT NULL))
        ORDER BY e.created_at DESC
        LIMIT $2`,
      [state, limit],
    );
    const names = await this.describeActors(rows.map((r) => String(r.actor_id ?? "")));
    return rows.map((r): InjectionFlag => {
      const actorId = String(r.actor_id ?? "");
      const speechId = r.speech_id === null || r.speech_id === undefined ? null : String(r.speech_id);
      return {
        eventId: String(r.id),
        actor: names.get(actorId) ?? UNKNOWN_ACTOR(actorId),
        channel: readChannel(r.payload),
        createdAt: iso(r.created_at),
        speech: speechId
          ? {
              id: speechId,
              channel: r.speech_channel === null ? null : String(r.speech_channel),
              roomId: r.speech_room === null ? null : String(r.speech_room),
              senderId: actorId,
              senderName: names.get(actorId)?.displayName ?? actorId,
              body: String(r.speech_body ?? ""),
              createdAt: iso(r.speech_at),
            }
          : null,
        reviewed: r.reviewed_at !== null && r.reviewed_at !== undefined,
        outcome: r.outcome === null || r.outcome === undefined ? null : String(r.outcome),
        note: r.note === null || r.note === undefined ? null : String(r.note),
        reviewedBy: r.reviewed_by === null || r.reviewed_by === undefined ? null : String(r.reviewed_by),
        reviewedByHandle:
          r.reviewed_by_handle === null || r.reviewed_by_handle === undefined
            ? null
            : String(r.reviewed_by_handle),
        reviewedAt: isoOrNull(r.reviewed_at),
      };
    });
  }

  /**
   * Mark an injection flag reviewed. `benign` is a false positive (the heuristic
   * is five regexes; most hits are people talking ABOUT injection). `actioned`
   * means the moderator did something about it — the something is its own
   * audited action, not implied by this one.
   */
  async reviewInjectionFlag(
    operator: Human,
    eventId: string,
    input: { outcome: InjectionOutcome; note?: string | null },
  ) {
    if (!(INJECTION_OUTCOMES as readonly string[]).includes(input.outcome)) {
      throw new GroveError("INVALID", `outcome must be one of: ${INJECTION_OUTCOMES.join(", ")}.`);
    }
    const id = Number(eventId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new GroveError("INVALID", "Bad flag id.");
    const { rows } = await this.store.pg.query(
      `SELECT id, actor_id FROM world_events WHERE id = $1 AND type = 'prompt_injection_flag'`,
      [id],
    );
    const flag = rows[0];
    if (!flag) throw new GroveError("NOT_FOUND", "Flag not found.", { httpStatus: 404 });
    const note = reason(input.note);
    await this.store.pg.query(
      `INSERT INTO injection_reviews (event_id, outcome, note, reviewed_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (event_id) DO UPDATE
         SET outcome = $2, note = $3, reviewed_by = $4, reviewed_at = now()`,
      [id, input.outcome, note, operator.id],
    );
    await this.identity.audit("mod.injection_reviewed", operator.id, {
      eventId: String(id),
      outcome: input.outcome,
      reason: note,
      targetId: flag.actor_id === null ? null : String(flag.actor_id),
    });
    return { eventId: String(id), outcome: input.outcome, note };
  }

  // -------------------------------------------------------------------------
  // The moderators' own record.
  // -------------------------------------------------------------------------

  /**
   * What the moderators have been doing. This is the half of a moderation tool
   * that is usually missing: a queue that records what happened to inhabitants
   * but not what the operators did with their own power.
   */
  async actionLog(limit = 100): Promise<ModActionEntry[]> {
    const cap = Math.min(Math.max(limit, 1), 500);
    const { rows } = await this.store.pg.query(
      `SELECT w.id, w.type, w.actor_id, w.payload, w.created_at, h.handle::text AS handle
         FROM world_events w
         LEFT JOIN humans h ON h.id = w.actor_id
        -- Queue #35: a space changing hands or plot is on the operators' record too.
        WHERE w.type LIKE 'mod.%' OR w.type IN ('space.transferred', 'space.relocated')
        ORDER BY w.created_at DESC
        LIMIT $1`,
      [cap],
    );
    return rows.map(toActionEntry);
  }

  /** Everything a moderator has ever done to one actor. Shown on the report card. */
  async actionsAgainst(actorId: string, limit = 50): Promise<ModActionEntry[]> {
    const { rows } = await this.store.pg.query(
      `SELECT w.id, w.type, w.actor_id, w.payload, w.created_at, h.handle::text AS handle
         FROM world_events w
         LEFT JOIN humans h ON h.id = w.actor_id
        WHERE w.type LIKE 'mod.%' AND w.payload->>'targetId' = $1
        ORDER BY w.created_at DESC
        LIMIT $2`,
      [actorId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map(toActionEntry);
  }
}

function toActionEntry(r: Record<string, unknown>): ModActionEntry {
  return {
    id: String(r.id),
    type: String(r.type),
    actorId: r.actor_id === null || r.actor_id === undefined ? null : String(r.actor_id),
    actorHandle: r.handle === null || r.handle === undefined ? null : String(r.handle),
    payload: (r.payload ?? {}) as Record<string, unknown>,
    createdAt: iso(r.created_at),
  };
}

function readChannel(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "channel" in payload) {
    const value = (payload as { channel?: unknown }).channel;
    return typeof value === "string" ? value : null;
  }
  return null;
}

/**
 * `reports.snapshot` is whatever `report()` stored — jsonb, so it must be read
 * defensively rather than cast. A malformed snapshot yields no lines instead of
 * throwing the whole report detail page away.
 */
function readSnapshotLines(snapshot: unknown): SpeechLine[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const last20 = (snapshot as { last20?: unknown }).last20;
  if (!Array.isArray(last20)) return [];
  const out: SpeechLine[] = [];
  for (const entry of last20) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const senderId = String(e.sender_id ?? e.senderId ?? "");
    out.push({
      id: String(e.id ?? ""),
      channel: null,
      roomId: null,
      senderId,
      senderName: senderId,
      body: String(e.body ?? ""),
      createdAt: e.created_at ? iso(e.created_at) : new Date(0).toISOString(),
    });
  }
  return out.reverse();
}
