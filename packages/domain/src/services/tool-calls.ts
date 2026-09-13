import {
  TOOL_ARGS_MAX,
  TOOL_OPEN_MAX,
  TOOL_RESULT_MAX,
  TOOL_RESULT_VISIBLE_SECONDS,
  isReportableOutcome,
  normaliseCallId,
  normaliseProgress,
  normaliseToolName,
  sanitiseCaption,
  type ReportableOutcome,
  type ToolCallOutcome,
  type ToolCallView,
} from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newUlid } from "../ids.js";
import type { PresenceService } from "./presence.js";
import { STALL_AFTER_SECONDS } from "./presence.js";
import type { QuotaService } from "./quota.js";
import type { FollowHooks } from "./follows.js";
import { MarkService } from "./marks.js";

/** Finished spans older than this are pruned by sweep(). */
export const TOOL_CALL_RETENTION_DAYS = 7;
/**
 * An open span silent for this long is closed as `stalled` by sweep(). Ten
 * minutes is presence's own eviction horizon: past it the body itself is gone,
 * so there is nobody left on the map for the call to belong to.
 */
export const TOOL_CALL_ABANDON_SECONDS = 600;

export interface StartToolCall {
  callId?: string | null;
  name: unknown;
  args?: unknown;
  /** Tag the span as work on a trial you entered (040). Counted toward a tool_run trial. */
  trialId?: unknown;
}

export interface ProgressToolCall {
  progress?: unknown;
  done?: unknown;
  total?: unknown;
}

export interface FinishToolCall {
  outcome: unknown;
  result?: unknown;
}

type Row = Record<string, unknown>;

function iso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** One row as published. `stalled` is decided here, once, with one clock. */
export function toToolCallView(r: Row, now: number = Date.now()): ToolCallView {
  const startedAt = iso(r.started_at)!;
  const updatedAt = iso(r.updated_at)!;
  const finishedAt = iso(r.finished_at);
  const open = finishedAt === null;
  return {
    callId: String(r.call_id),
    name: String(r.name),
    args: r.args == null ? null : String(r.args),
    startedAt,
    updatedAt,
    finishedAt,
    outcome: (r.outcome as ToolCallOutcome | null) ?? null,
    progress: r.progress == null ? null : Number(r.progress),
    progressDone: r.progress_done == null ? null : Number(r.progress_done),
    progressTotal: r.progress_total == null ? null : Number(r.progress_total),
    result: r.result == null ? null : String(r.result),
    durationMs: finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
    stalled: open && now - Date.parse(updatedAt) > STALL_AFTER_SECONDS * 1000,
  };
}

/**
 * Tool calls as spans (migration 020). See docs/PULSE.md "Tool calls".
 *
 * Every write here is also a pulse: a span start says `tool`, and the body is
 * kept alive by its reports exactly as it is by /world/pulse, so the stall rule
 * and the 017 verb history keep working without knowing spans exist.
 */
export class ToolCallService {
  /** Late-bound by GroveApp: followers hear a long call finish or error (028). */
  follows?: FollowHooks;
  /** Plot marks (030): the prune folds spans into their durable tally. */
  readonly marks: MarkService;
  /** Late-bound by GroveApp: checks a span's trial tag (040). */
  trials?: { assertTaggable(agentId: string, trialId: string): Promise<void> };

  constructor(
    private store: GroveStore,
    private quota: QuotaService,
    private presence: PresenceService,
  ) {
    this.marks = new MarkService(store);
  }

  async start(actorId: string, input: StartToolCall): Promise<ToolCallView> {
    const name = normaliseToolName(input.name);
    if (!name) throw new GroveError("INVALID", "name is required: the tool being called, e.g. Bash or Edit.");
    let callId: string | null = null;
    if (input.callId != null && input.callId !== "") {
      callId = normaliseCallId(input.callId);
      if (!callId) {
        throw new GroveError("INVALID", "call_id must be 1-128 characters of letters, digits, _ . : or -.");
      }
    }
    const args = sanitiseCaption(input.args, TOOL_ARGS_MAX);
    let trialId: string | null = null;
    if (input.trialId != null && input.trialId !== "") {
      trialId = String(input.trialId).slice(0, 64);
      if (!this.trials) throw new GroveError("INVALID", "Trials are not available here.");
      await this.trials.assertTaggable(actorId, trialId);
    }
    await this.quota.consumeToolCall(actorId);

    const presence = await this.presence.getPresence(actorId);
    if (!presence) throw new GroveError("NOT_FOUND", "Join a room first (POST /world/join).", { httpStatus: 404 });

    const { rows: open } = await this.store.pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tool_calls WHERE actor_id = $1 AND finished_at IS NULL",
      [actorId],
    );
    if ((open[0]?.n ?? 0) >= TOOL_OPEN_MAX) {
      throw new GroveError(
        "INVALID",
        `Too many open tool calls (${TOOL_OPEN_MAX}). Finish the ones that ended before starting more.`,
      );
    }

    const id = `tc_${newUlid()}`;
    const cid = callId ?? id;
    // Idempotent on (actor, call_id): a retried start is the same call, not a
    // second one, and it must not reset the clock the first start set.
    const { rows } = await this.store.pg.query(
      `INSERT INTO tool_calls (id, actor_id, call_id, room_id, name, args, trial_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (actor_id, call_id) DO UPDATE SET actor_id = tool_calls.actor_id
       RETURNING *`,
      [id, actorId, cid, presence.roomId, name, args, trialId],
    );
    const view = toToolCallView(rows[0] as Row);
    if (!view.outcome) {
      await this.presence.pulseFromSpan(actorId, "tool", args ? `${name} · ${args}` : name);
    }
    await this.publish(actorId, presence.roomId, "start", view);
    return view;
  }

  async progress(actorId: string, rawCallId: unknown, input: ProgressToolCall): Promise<ToolCallView> {
    const callId = this.requireCallId(rawCallId);
    const p = normaliseProgress(input);
    await this.quota.consumeToolCall(actorId);
    // A progress report with no numbers is still a report: "still running".
    // It keeps the span (and the body) out of the stall verdict without
    // inventing a percentage.
    const { rows } = await this.store.pg.query(
      `UPDATE tool_calls SET
         updated_at = now(),
         progress = COALESCE($3, progress),
         progress_done = CASE WHEN $3::real IS NULL THEN progress_done ELSE $4 END,
         progress_total = CASE WHEN $3::real IS NULL THEN progress_total ELSE $5 END
       WHERE actor_id = $1 AND call_id = $2 AND finished_at IS NULL
       RETURNING *`,
      [actorId, callId, p?.progress ?? null, p?.done ?? null, p?.total ?? null],
    );
    if (!rows[0]) throw new GroveError("NOT_FOUND", "No open tool call with that call_id.", { httpStatus: 404 });
    const view = toToolCallView(rows[0] as Row);
    const presence = await this.touchBody(actorId, view);
    await this.publish(actorId, presence ?? String((rows[0] as Row).room_id ?? ""), "progress", view);
    return view;
  }

  async finish(actorId: string, rawCallId: unknown, input: FinishToolCall): Promise<ToolCallView> {
    const callId = this.requireCallId(rawCallId);
    if (!isReportableOutcome(input.outcome)) {
      throw new GroveError("INVALID", "outcome must be one of ok|error|cancelled.");
    }
    const outcome: ReportableOutcome = input.outcome;
    const result = sanitiseCaption(input.result, TOOL_RESULT_MAX);
    await this.quota.consumeToolCall(actorId);
    // A late real finish overwrites the server's `stalled` verdict: that verdict
    // only ever meant "we stopped hearing", and now we have heard.
    const { rows } = await this.store.pg.query(
      `UPDATE tool_calls SET
         finished_at = now(), updated_at = now(), outcome = $3, result = $4
       WHERE actor_id = $1 AND call_id = $2 AND (finished_at IS NULL OR outcome = 'stalled')
       RETURNING *`,
      [actorId, callId, outcome, result],
    );
    if (!rows[0]) {
      const { rows: done } = await this.store.pg.query(
        "SELECT * FROM tool_calls WHERE actor_id = $1 AND call_id = $2",
        [actorId, callId],
      );
      // Finishing twice is a retry, not an error: hand back what was recorded.
      if (done[0]) return toToolCallView(done[0] as Row);
      throw new GroveError("NOT_FOUND", "No tool call with that call_id. Start it first.", { httpStatus: 404 });
    }
    const view = toToolCallView(rows[0] as Row);
    const room = await this.afterFinish(actorId, view);
    const roomId = room ?? String((rows[0] as Row).room_id ?? "");
    await this.publish(actorId, roomId, "finish", view);
    // The room the call ran in, not wherever the body wandered since.
    const ranIn = String((rows[0] as Row).room_id ?? "") || roomId;
    if (ranIn) await this.follows?.toolCallFinished(actorId, ranIn, view);
    return view;
  }

  /**
   * Open spans plus the ones that finished recently enough to still show their
   * outcome, for many bodies in one statement. Newest first per body, capped.
   */
  async forActors(actorIds: readonly string[], now: number = Date.now(), perActor = 4): Promise<Map<string, ToolCallView[]>> {
    const out = new Map<string, ToolCallView[]>();
    if (!actorIds.length) return out;
    const { rows } = await this.store.pg.query(
      `SELECT * FROM (
         SELECT t.*, row_number() OVER (PARTITION BY actor_id ORDER BY (finished_at IS NULL) DESC, started_at DESC) AS rn
           FROM tool_calls t
          WHERE actor_id = ANY($1::text[])
            AND (finished_at IS NULL OR finished_at > now() - make_interval(secs => $2))
       ) x WHERE rn <= $3
       ORDER BY actor_id, (finished_at IS NULL) DESC, started_at DESC`,
      [[...actorIds], TOOL_RESULT_VISIBLE_SECONDS, perActor],
    );
    for (const r of rows) {
      const id = String((r as Row).actor_id);
      const list = out.get(id) ?? [];
      list.push(toToolCallView(r as Row, now));
      out.set(id, list);
    }
    return out;
  }

  /**
   * Close what nobody will ever finish, and forget what is old.
   *
   *  - An open span silent for TOOL_CALL_ABANDON_SECONDS, or whose body has no
   *    presence row any more, is closed as `stalled`. It ends at
   *    updated_at + STALL_AFTER_SECONDS — the last moment anything was known —
   *    not at whenever this sweep happened to run.
   *  - Finished spans past retention are deleted, each folded into its
   *    space's durable daily tally in the same statement (030), and marks a
   *    space has newly earned are awarded (throttled; see MarkService).
   */
  async sweep(): Promise<{ stalled: number; pruned: number }> {
    const { rowCount: stalled } = await this.store.pg.query(
      `UPDATE tool_calls t SET
         outcome = 'stalled',
         finished_at = LEAST(now(), t.updated_at + make_interval(secs => $1))
       WHERE t.finished_at IS NULL
         AND (t.updated_at < now() - make_interval(secs => $2)
              OR NOT EXISTS (SELECT 1 FROM presence p WHERE p.actor_id = t.actor_id))`,
      [STALL_AFTER_SECONDS, TOOL_CALL_ABANDON_SECONDS],
    );
    const pruned = await this.marks.pruneIntoTally(TOOL_CALL_RETENTION_DAYS);
    await this.marks.maybeEvaluate().catch(() => {});
    return { stalled: stalled ?? 0, pruned: pruned ?? 0 };
  }

  private requireCallId(raw: unknown): string {
    const id = normaliseCallId(raw);
    if (!id) throw new GroveError("INVALID", "call_id is required (the id you started the call with).");
    return id;
  }

  /** A progress report is a sign of life: refresh the body's pulse without changing its caption. */
  private async touchBody(actorId: string, view: ToolCallView): Promise<string | null> {
    const presence = await this.presence.getPresence(actorId);
    if (!presence) return null;
    const caption = view.args ? `${view.name} · ${view.args}` : view.name;
    // Only re-assert `tool` when the body still says tool: a progress report
    // must not overwrite a `blocked` the agent sent in the meantime.
    if (presence.verb === "tool" || presence.verb == null) {
      await this.presence.pulseFromSpan(actorId, "tool", presence.detail ?? caption);
    } else {
      await this.store.pg.query(
        "UPDATE presence SET last_seen_at = now() WHERE actor_id = $1",
        [actorId],
      );
    }
    return presence.roomId;
  }

  /**
   * The call ended. If it was the last one open and the body still says `tool`,
   * hand it back to the loop as `think`: a finished tool call returns control
   * to the agent, and leaving `tool` on would be exactly the lie spans exist to
   * end. Any other verb the agent set in the meantime is left alone.
   */
  private async afterFinish(actorId: string, view: ToolCallView): Promise<string | null> {
    const presence = await this.presence.getPresence(actorId);
    if (!presence) return null;
    const { rows } = await this.store.pg.query<{ call_id: string; name: string; args: string | null }>(
      `SELECT call_id, name, args FROM tool_calls
        WHERE actor_id = $1 AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [actorId],
    );
    const still = rows[0];
    if (presence.verb === "tool") {
      if (still) {
        await this.presence.pulseFromSpan(actorId, "tool", still.args ? `${still.name} · ${still.args}` : still.name);
      } else {
        await this.presence.pulseFromSpan(actorId, "think", `after ${view.name}`);
      }
    }
    return presence.roomId;
  }

  private async publish(actorId: string, roomId: string, phase: "start" | "progress" | "finish", view: ToolCallView) {
    if (!roomId) return;
    const payload = JSON.stringify({ type: "tool_call", actor_id: actorId, room_id: roomId, phase, tool_call: view });
    await this.store.redis.publish(`pubsub:room:${roomId}`, payload);
    if (roomId === "plaza") await this.store.redis.publish("sse:plaza", payload);
  }
}
