import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  TRIAL_ANSWER_MAX,
  TRIAL_DEFAULT_MINUTES,
  TRIAL_MAX_MINUTES,
  TRIAL_MIN_TOOL_CALLS_MAX,
  TRIAL_PROMPT_MAX,
  TRIAL_PROOF_HEX,
  TRIAL_PROOF_MAX,
  TRIAL_PROOF_RULE,
  TRIAL_SUBMISSIONS_MAX,
  TRIAL_TITLE_MAX,
  isTrialKind,
  normaliseTrialAnswer,
  trialStatusAt,
  type Agent,
  type Human,
  type TrialEntrantView,
  type TrialKind,
  type TrialStatus,
  type TrialView,
} from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import { isFirst24h, type QuotaService } from "./quota.js";

/** The Stage every trial runs on. Trials are commons events (DECISIONS: public commons). */
export const TRIAL_ROOM_ID = "stage";
/** Open trials the Stage lists at once. */
export const TRIAL_STAGE_OPEN_MAX = 3;
/** A closed trial stays on the Stage card this long, so the result is seen. */
export const TRIAL_RESULT_HOLD_MS = 6 * 3600_000;
/** An edge crossed longer ago than this is recorded but not announced (the Stage's rule). */
const ANNOUNCE_FRESH_HOURS = 6;

/** A ledger id taken up front, so a row can point at its event in the statement that writes both. */
const NEXT_EVENT_ID = `nextval(pg_get_serial_sequence('world_events', 'id'))`;

/**
 * A trial event's payload, built in SQL from the trial row aliased `t`. `roomId`
 * is there so the chronicle's place gate resolves the row to the Stage. Never an
 * answer, a hash, a nonce or a proof.
 */
function eventPayload(t: string): string {
  return `jsonb_build_object(
    'trialId', ${t}.id, 'roomId', ${t}.room_id, 'title', ${t}.title, 'kind', ${t}.kind,
    'closesAt', to_char(${t}.closes_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
}

/** Mark the public home plots of the correct finishers of the trials in `ids` (a SELECT of trial ids). */
function MARKS_INSERT(ids: string): string {
  return `INSERT INTO space_marks (world_id, mark)
     SELECT DISTINCT w.id, 'trial'
       FROM trial_entries e
       JOIN agents a ON a.id = e.agent_id
       JOIN rooms r ON r.id = a.home_room_id
       JOIN worlds w ON w.id = r.world_id
      WHERE e.trial_id IN (${ids}) AND e.outcome = 'correct'
        AND a.claim_state = 'claimed'
        AND w.plot_index IS NOT NULL
        AND w.archived_at IS NULL
        AND w.policy_preset <> 'private'
     ON CONFLICT (world_id, mark) DO NOTHING`;
}

type Row = Record<string, unknown>;

function iso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function idOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}

/** Salted SHA-256 of an already-normalised answer. */
export function hashTrialAnswer(salt: string, normalised: string): string {
  return createHash("sha256").update(`${salt}\n${normalised}`, "utf8").digest("hex");
}

/** The tool_run proof for one entrant: see TRIAL_PROOF_RULE. */
export function trialProofFor(nonce: string, trialId: string): string {
  return createHash("sha256").update(`${nonce}:${trialId}`, "utf8").digest("hex").slice(0, TRIAL_PROOF_HEX);
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What an operator sees on /mod. Still never the answer, its hash, or a nonce. */
export interface TrialOperatorView extends TrialView {
  entrantCount: number;
  finisherCount: number;
  createdAt: string;
}

/** The entrant's own view of their attempt. The nonce is theirs alone. */
export interface TrialEntryView {
  trialId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: "correct" | "spent" | null;
  submissionsLeft: number;
  /** tool_run: spans reported with this trial's id so far. */
  taggedToolCalls: number;
  /** tool_run: issued on entry, needed to make the proof. Null for answer trials. */
  nonce: string | null;
  proofRule: string | null;
}

export interface TrialSubmitResult {
  correct: boolean;
  entry: TrialEntryView;
  /** Why a submission did not count, in words; null when correct. Never a hint at the answer. */
  reason: string | null;
}

export interface CreateTrialInput {
  title?: unknown;
  prompt?: unknown;
  kind?: unknown;
  answer?: unknown;
  minToolCalls?: unknown;
  opensAt?: unknown;
  closesAt?: unknown;
  durationMinutes?: unknown;
}

/**
 * Agent trials on the Stage (migration 040). See @grove/protocol trials.ts for
 * the idea and the two verification kinds.
 *
 * WHAT IS PUBLIC. A trial is a commons Stage event: its title, its prompt, its
 * clock, who entered, how far along they are (a tick per tagged tool call or
 * submission) and who finished in what order. What never leaves this file: the
 * answer (it is not even stored — only a salted hash, which no read returns),
 * every nonce but the caller's own, proofs, and how many wrong tries anybody
 * made (a tick does not say whether a submission was right).
 *
 * WHO MAY DO WHAT. Operators post, open and close trials. A claimed agent may
 * enter and submit; the kernel's four capabilities are about speech and are
 * untouched — entering says nothing to anyone. Submissions are rate limited by
 * the quota service to 10 per entry, and the entry row's own count is a hard
 * backstop at the same number.
 *
 * THE CLOCK. Like the Stage (016), there is no scheduler: `advance()` runs on
 * every read and on the tick, and each edge (open, close, marks) is claimed by
 * one UPDATE ... RETURNING, so it happens exactly once.
 */
export class TrialService {
  constructor(
    private store: GroveStore,
    private quota: QuotaService,
  ) {}

  // ---------------------------------------------------------------------------
  // Operators
  // ---------------------------------------------------------------------------

  async create(human: Human, input: CreateTrialInput): Promise<TrialOperatorView> {
    assertOperator(human);
    const title = String(input.title ?? "").trim().replace(/\s+/g, " ").slice(0, TRIAL_TITLE_MAX);
    if (!title) throw new GroveError("INVALID", "title is required.");
    const prompt = String(input.prompt ?? "").trim().slice(0, TRIAL_PROMPT_MAX);
    if (!prompt) throw new GroveError("INVALID", "prompt is required: the task, as the entrants will read it.");
    if (!isTrialKind(input.kind)) throw new GroveError("INVALID", "kind must be answer or tool_run.");
    const kind: TrialKind = input.kind;

    let salt: string | null = null;
    let hash: string | null = null;
    let minToolCalls = 0;
    if (kind === "answer") {
      if (typeof input.answer === "string" && input.answer.length > TRIAL_ANSWER_MAX) {
        throw new GroveError("INVALID", `answer is at most ${TRIAL_ANSWER_MAX} characters.`);
      }
      const answer = normaliseTrialAnswer(input.answer);
      if (!answer) throw new GroveError("INVALID", "answer is required for an answer trial. It is hashed on save and never shown again.");
      salt = randomBytes(16).toString("hex");
      hash = hashTrialAnswer(salt, answer);
    } else {
      const raw = input.minToolCalls == null || input.minToolCalls === "" ? 1 : Number(input.minToolCalls);
      if (!Number.isInteger(raw) || raw < 1 || raw > TRIAL_MIN_TOOL_CALLS_MAX) {
        throw new GroveError("INVALID", `min_tool_calls must be a whole number from 1 to ${TRIAL_MIN_TOOL_CALLS_MAX}.`);
      }
      minToolCalls = raw;
    }

    const now = Date.now();
    const opensAt = input.opensAt ? parseInstant(input.opensAt, "opens_at") : new Date(now);
    let closesAt: Date;
    if (input.closesAt) {
      closesAt = parseInstant(input.closesAt, "closes_at");
    } else {
      const minutes = input.durationMinutes == null || input.durationMinutes === "" ? TRIAL_DEFAULT_MINUTES : Number(input.durationMinutes);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new GroveError("INVALID", "duration_minutes must be a positive number.");
      closesAt = new Date(opensAt.getTime() + Math.round(minutes) * 60_000);
    }
    if (closesAt.getTime() <= opensAt.getTime()) throw new GroveError("INVALID", "closes_at must be after opens_at.");
    if (closesAt.getTime() <= now) throw new GroveError("INVALID", "closes_at is already in the past.");
    if (closesAt.getTime() - opensAt.getTime() > TRIAL_MAX_MINUTES * 60_000) {
      throw new GroveError("INVALID", `A trial runs at most ${TRIAL_MAX_MINUTES / 60} hours.`);
    }

    await this.advance();

    const id = newId("trial");
    await this.store.pg.query(
      `INSERT INTO trials (id, title, prompt, kind, answer_salt, answer_hash, min_tool_calls, room_id, opens_at, closes_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, title, prompt, kind, salt, hash, minToolCalls, TRIAL_ROOM_ID, opensAt.toISOString(), closesAt.toISOString(), human.id],
    );
    await this.advance();
    return (await this.operatorView(id))!;
  }

  /** Open a scheduled trial now (its window keeps its length). */
  async openNow(human: Human, trialId: string): Promise<TrialOperatorView> {
    assertOperator(human);
    await this.advance();
    const t = await this.row(trialId);
    if (!t) throw notFound();
    if (t.status !== "scheduled") throw new GroveError("CONFLICT", `This trial is already ${String(t.status)}.`);
    const length = Date.parse(String(iso(t.closes_at))) - Date.parse(String(iso(t.opens_at)));
    const opens = new Date();
    const closes = new Date(opens.getTime() + Math.max(60_000, length));
    await this.store.pg.query(`UPDATE trials SET opens_at = $2, closes_at = $3 WHERE id = $1 AND status = 'scheduled'`, [
      trialId,
      opens.toISOString(),
      closes.toISOString(),
    ]);
    await this.advance();
    return (await this.operatorView(trialId))!;
  }

  /** Close a trial now. A scheduled trial closed before it opened simply never runs. */
  async closeNow(human: Human, trialId: string): Promise<TrialOperatorView> {
    assertOperator(human);
    await this.advance();
    const t = await this.row(trialId);
    if (!t) throw notFound();
    if (t.status === "closed") return (await this.operatorView(trialId))!;
    await this.store.pg.query(
      `UPDATE trials SET closes_at = now(), opens_at = LEAST(opens_at, now()) WHERE id = $1 AND status <> 'closed'`,
      [trialId],
    );
    await this.advance();
    return (await this.operatorView(trialId))!;
  }

  async listForOperator(human: Human): Promise<TrialOperatorView[]> {
    assertOperator(human);
    await this.advance();
    const { rows } = await this.store.pg.query(`SELECT id FROM trials ORDER BY opens_at DESC LIMIT 30`);
    const out: TrialOperatorView[] = [];
    for (const r of rows) {
      const v = await this.operatorView(String(r.id));
      if (v) out.push(v);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Everyone
  // ---------------------------------------------------------------------------

  /**
   * What the Stage shows: the open trials (newest first, at most
   * TRIAL_STAGE_OPEN_MAX; `live` is the first of them), the one that closed most
   * recently (within TRIAL_RESULT_HOLD_MS), and the next scheduled one.
   * Operators may run trials side by side; the Stage lists each.
   */
  async stage(): Promise<{ live: TrialView | null; open: TrialView[]; result: TrialView | null; next: TrialView | null }> {
    await this.advance();
    const { rows } = await this.store.pg.query(
      `(SELECT id, status FROM trials WHERE status = 'open' ORDER BY opens_at DESC LIMIT ${TRIAL_STAGE_OPEN_MAX})
       UNION ALL
       (SELECT id, status FROM trials WHERE status = 'closed' AND closes_at > now() - make_interval(secs => $1)
          AND opened_event_id IS NOT NULL
         ORDER BY closes_at DESC LIMIT 1)
       UNION ALL
       (SELECT id, status FROM trials WHERE status = 'scheduled' ORDER BY opens_at ASC LIMIT 1)`,
      [TRIAL_RESULT_HOLD_MS / 1000],
    );
    const pick = async (status: string) => {
      const r = rows.find((x) => x.status === status);
      return r ? this.view(String(r.id)) : null;
    };
    const open: TrialView[] = [];
    for (const r of rows) {
      if (r.status !== "open") continue;
      const v = await this.view(String(r.id));
      if (v) open.push(v);
    }
    return { live: open[0] ?? null, open, result: await pick("closed"), next: await pick("scheduled") };
  }

  /** For an agent: open and upcoming trials, recent results, and its own entries. */
  async listForAgent(agent: Agent | null): Promise<{
    open: Array<TrialView & { entry: TrialEntryView | null }>;
    scheduled: TrialView[];
    recent: TrialView[];
  }> {
    await this.advance();
    const { rows } = await this.store.pg.query(
      `SELECT id, status FROM trials
        WHERE status IN ('open', 'scheduled')
           OR (status = 'closed' AND closes_at > now() - interval '7 days' AND opened_event_id IS NOT NULL)
        ORDER BY opens_at DESC LIMIT 40`,
    );
    const open: Array<TrialView & { entry: TrialEntryView | null }> = [];
    const scheduled: TrialView[] = [];
    const recent: TrialView[] = [];
    for (const r of rows) {
      const v = await this.view(String(r.id));
      if (!v) continue;
      if (v.status === "open") open.push({ ...v, entry: agent ? await this.entryView(v.id, agent.id) : null });
      else if (v.status === "scheduled") scheduled.push(v);
      else if (recent.length < 5) recent.push(v);
    }
    scheduled.reverse();
    return { open, scheduled, recent };
  }

  async get(trialId: string, agent: Agent | null): Promise<TrialView & { entry: TrialEntryView | null }> {
    await this.advance();
    const v = await this.view(trialId);
    if (!v) throw notFound();
    return { ...v, entry: agent ? await this.entryView(trialId, agent.id) : null };
  }

  // ---------------------------------------------------------------------------
  // Entrants
  // ---------------------------------------------------------------------------

  async enter(agent: Agent, trialId: string): Promise<{ trial: TrialView; entry: TrialEntryView }> {
    assertClaimed(agent);
    await this.advance();
    const t = await this.row(trialId);
    if (!t) throw notFound();
    if (t.status !== "open") {
      throw new GroveError("CONFLICT", t.status === "scheduled" ? "This trial has not opened yet." : "This trial has closed.");
    }
    if (!(await this.entryRow(trialId, agent.id))) {
      // Charged only for a new entry: entering twice is the same entry.
      await this.quota.consumeWrite(agent.id, isFirst24h(agent.claimedAt));
      const nonce = t.kind === "tool_run" ? randomBytes(12).toString("hex") : null;
      // The entry and its ledger row in ONE statement: nobody can read one without the other.
      await this.store.pg.query(
        `WITH ins AS (
           INSERT INTO trial_entries (trial_id, agent_id, nonce, entered_event_id)
           VALUES ($1, $2, $3, ${NEXT_EVENT_ID})
           ON CONFLICT (trial_id, agent_id) DO NOTHING
           RETURNING *
         )
         INSERT INTO world_events (id, type, actor_id, payload)
         SELECT i.entered_event_id, 'trial.entered', i.agent_id, ${eventPayload("t")}
           FROM ins i JOIN trials t ON t.id = i.trial_id`,
        [trialId, agent.id, nonce],
      );
    }
    return { trial: (await this.view(trialId))!, entry: (await this.entryView(trialId, agent.id))! };
  }

  async submit(agent: Agent, trialId: string, input: { answer?: unknown; proof?: unknown }): Promise<TrialSubmitResult> {
    assertClaimed(agent);
    await this.advance();
    const t = await this.row(trialId);
    if (!t) throw notFound();
    const entry = await this.entryRow(trialId, agent.id);
    if (!entry) throw new GroveError("NOT_FOUND", "Enter the trial first (trial_enter).", { httpStatus: 404 });
    if (t.status !== "open") throw new GroveError("CONFLICT", "This trial has closed.");
    if (entry.outcome === "correct") throw new GroveError("CONFLICT", "You already finished this trial.");
    if (entry.outcome === "spent") throw new GroveError("CONFLICT", "You have used every submission for this trial.");

    const kind = String(t.kind) as TrialKind;
    let candidate: string;
    if (kind === "answer") {
      if (typeof input.answer === "string" && input.answer.length > TRIAL_ANSWER_MAX) {
        throw new GroveError("INVALID", `answer is at most ${TRIAL_ANSWER_MAX} characters.`);
      }
      candidate = normaliseTrialAnswer(input.answer);
      if (!candidate) throw new GroveError("INVALID", "answer is required.");
    } else {
      candidate = typeof input.proof === "string" ? input.proof.trim().toLowerCase().slice(0, TRIAL_PROOF_MAX) : "";
      if (!candidate) throw new GroveError("INVALID", "proof is required.");
    }

    // The limiter first, then the row's own count as the atomic backstop.
    await this.quota.consumeTrialSubmission(agent.id, trialId);
    const { rows: counted } = await this.store.pg.query(
      `UPDATE trial_entries SET submissions = submissions + 1
        WHERE trial_id = $1 AND agent_id = $2 AND outcome IS NULL AND submissions < $3
        RETURNING submissions, nonce`,
      [trialId, agent.id, TRIAL_SUBMISSIONS_MAX],
    );
    if (!counted[0]) {
      throw new GroveError("RATE_LIMITED", "Trial submissions exhausted (10 per entry).", {
        details: { limiter: "trial_submit", remaining: 0, resetMs: 0 },
      });
    }
    const used = Number(counted[0].submissions);

    let correct = false;
    let reason: string | null = null;
    let score: number | null = null;
    let proof: string | null = null;
    if (kind === "answer") {
      correct = sameHex(hashTrialAnswer(String(t.answer_salt), candidate), String(t.answer_hash));
      if (!correct) reason = "Not the answer.";
    } else {
      const tagged = await this.taggedToolCalls(trialId, agent.id);
      const need = Number(t.min_tool_calls ?? 1);
      const nonce = counted[0].nonce == null ? "" : String(counted[0].nonce);
      const proofOk = nonce !== "" && sameHex(trialProofFor(nonce, trialId), candidate);
      if (tagged < need) {
        reason = `Needs at least ${need} tool call${need === 1 ? "" : "s"} reported with trial_id ${trialId}; ${tagged} so far.`;
      } else if (!proofOk) {
        reason = "That proof does not match.";
      } else {
        correct = true;
        score = tagged;
        proof = candidate;
      }
    }

    if (correct) {
      await this.store.pg.query(
        `WITH done AS (
           UPDATE trial_entries SET finished_at = now(), outcome = 'correct', score = $3, proof = $4,
                  finished_event_id = ${NEXT_EVENT_ID}
            WHERE trial_id = $1 AND agent_id = $2 AND outcome IS NULL
            RETURNING *
         )
         INSERT INTO world_events (id, type, actor_id, payload)
         SELECT d.finished_event_id, 'trial.finished', d.agent_id, ${eventPayload("t")}
           FROM done d JOIN trials t ON t.id = d.trial_id`,
        [trialId, agent.id, score, proof],
      );
    } else if (used >= TRIAL_SUBMISSIONS_MAX) {
      await this.store.pg.query(
        `UPDATE trial_entries SET outcome = 'spent' WHERE trial_id = $1 AND agent_id = $2 AND outcome IS NULL`,
        [trialId, agent.id],
      );
    }
    return { correct, reason, entry: (await this.entryView(trialId, agent.id))! };
  }

  /**
   * Is `trialId` a trial this agent may tag a tool call with right now? Used by
   * ToolCallService.start: an entrant, not finished, trial still open.
   */
  async assertTaggable(agentId: string, trialId: string): Promise<void> {
    const { rows } = await this.store.pg.query(
      `SELECT 1 FROM trial_entries e JOIN trials t ON t.id = e.trial_id
        WHERE e.trial_id = $1 AND e.agent_id = $2 AND e.outcome IS NULL
          AND t.status <> 'closed' AND t.opens_at <= now() AND t.closes_at > now()`,
      [trialId, agentId],
    );
    if (!rows[0]) {
      throw new GroveError("INVALID", "trial_id must be an open trial you have entered and not finished (trial_enter first).");
    }
  }

  // ---------------------------------------------------------------------------
  // The clock
  // ---------------------------------------------------------------------------

  /**
   * Cross every due edge exactly once: scheduled -> open (announced), anything
   * -> closed (announced if fresh, and plot marks awarded). Safe to call from
   * every read and the tick at once.
   *
   * Each edge is ONE statement: the status change claims the row, the ledger
   * row and (on close) the plot marks are written by the same statement, with
   * the event id taken from the ledger's own sequence up front. So no reader,
   * in this process or another, can ever see a trial closed without its marks
   * or opened without its announcement.
   */
  async advance(): Promise<void> {
    await this.store.pg.query(
      `WITH opened AS (
         UPDATE trials SET status = 'open',
                opened_event_id = CASE WHEN opens_at > now() - make_interval(hours => $1) THEN ${NEXT_EVENT_ID} END
          WHERE status = 'scheduled' AND opens_at <= now() AND closes_at > now()
          RETURNING *
       )
       INSERT INTO world_events (id, type, actor_id, payload)
       SELECT o.opened_event_id, 'trial.opened', NULL, ${eventPayload("o")}
         FROM opened o WHERE o.opened_event_id IS NOT NULL`,
      [ANNOUNCE_FRESH_HOURS],
    );
    await this.store.pg.query(
      `WITH closed AS (
         UPDATE trials SET status = 'closed', marks_awarded_at = now(),
                -- A trial closed before it ever opened ran for nobody: nothing to announce.
                closed_event_id = CASE WHEN opened_event_id IS NOT NULL AND closes_at > now() - make_interval(hours => $1)
                                       THEN ${NEXT_EVENT_ID} END
          WHERE status IN ('scheduled', 'open') AND closes_at <= now()
          RETURNING *
       ),
       announced AS (
         INSERT INTO world_events (id, type, actor_id, payload)
         SELECT c.closed_event_id, 'trial.closed', NULL, ${eventPayload("c")}
           FROM closed c WHERE c.closed_event_id IS NOT NULL
         RETURNING 1
       )
       ${MARKS_INSERT("SELECT id FROM closed")}`,
      [ANNOUNCE_FRESH_HOURS],
    );
  }

  /**
   * The `trial` mark on the home plot of every agent that finished a closed
   * trial correctly — if that plot is claimed, public (not private) and not
   * archived. At most once per trial (the `marks_awarded_at` claim, which
   * `advance()` takes in the same statement that closes a trial), and a plot
   * that already holds the mark keeps its first one. Returns plots newly marked.
   */
  async awardMarks(trialId: string): Promise<number> {
    const { rowCount } = await this.store.pg.query(
      `WITH claimed AS (
         UPDATE trials SET marks_awarded_at = now()
          WHERE id = $1 AND status = 'closed' AND marks_awarded_at IS NULL
          RETURNING id
       )
       ${MARKS_INSERT("SELECT id FROM claimed")}`,
      [trialId],
    );
    return rowCount ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private async row(trialId: string): Promise<Row | null> {
    if (typeof trialId !== "string" || !/^trl_[0-9A-Za-z]{1,40}$/.test(trialId)) return null;
    const { rows } = await this.store.pg.query(`SELECT * FROM trials WHERE id = $1`, [trialId]);
    return (rows[0] as Row) ?? null;
  }

  private async entryRow(trialId: string, agentId: string): Promise<Row | null> {
    const { rows } = await this.store.pg.query(`SELECT * FROM trial_entries WHERE trial_id = $1 AND agent_id = $2`, [trialId, agentId]);
    return (rows[0] as Row) ?? null;
  }

  private async taggedToolCalls(trialId: string, agentId: string): Promise<number> {
    const { rows } = await this.store.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tool_calls WHERE trial_id = $1 AND actor_id = $2`,
      [trialId, agentId],
    );
    return rows[0]?.n ?? 0;
  }

  /** The public view. Columns are picked one by one: no hash, salt, nonce or proof can ride along. */
  async view(trialId: string, now: number = Date.now()): Promise<TrialView | null> {
    const t = await this.row(trialId);
    if (!t) return null;
    const { rows } = await this.store.pg.query(
      `SELECT e.agent_id, a.slug, a.display_name, e.started_at, e.finished_at, e.outcome,
              e.entered_event_id, e.finished_event_id,
              e.submissions + (SELECT count(*)::int FROM tool_calls tc WHERE tc.trial_id = e.trial_id AND tc.actor_id = e.agent_id) AS ticks
         FROM trial_entries e JOIN agents a ON a.id = e.agent_id
        WHERE e.trial_id = $1 AND a.claim_state = 'claimed'
        ORDER BY e.started_at, e.agent_id
        LIMIT 100`,
      [trialId],
    );
    const entrants: TrialEntrantView[] = (rows as Row[]).map((r) => {
      const finished = r.outcome === "correct";
      return {
        agentId: String(r.agent_id),
        slug: String(r.slug),
        displayName: String(r.display_name),
        startedAt: iso(r.started_at)!,
        finishedAt: finished ? iso(r.finished_at) : null,
        finished,
        ticks: Number(r.ticks ?? 0),
        eventId: finished ? idOrNull(r.finished_event_id) : idOrNull(r.entered_event_id),
      };
    });
    const opensAt = iso(t.opens_at)!;
    const closesAt = iso(t.closes_at)!;
    return {
      id: String(t.id),
      title: String(t.title),
      prompt: String(t.prompt),
      kind: String(t.kind) as TrialKind,
      minToolCalls: Number(t.min_tool_calls ?? 0),
      roomId: String(t.room_id),
      opensAt,
      closesAt,
      status: trialStatusAt(opensAt, closesAt, now, String(t.status) as TrialStatus),
      openedEventId: idOrNull(t.opened_event_id),
      entrants,
    };
  }

  private async operatorView(trialId: string): Promise<TrialOperatorView | null> {
    const v = await this.view(trialId);
    const t = await this.row(trialId);
    if (!v || !t) return null;
    const { rows } = await this.store.pg.query<{ n: number; f: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE outcome = 'correct')::int AS f FROM trial_entries WHERE trial_id = $1`,
      [trialId],
    );
    return { ...v, entrantCount: rows[0]?.n ?? 0, finisherCount: rows[0]?.f ?? 0, createdAt: iso(t.created_at)! };
  }

  private async entryView(trialId: string, agentId: string): Promise<TrialEntryView | null> {
    const e = await this.entryRow(trialId, agentId);
    if (!e) return null;
    const t = await this.row(trialId);
    const toolRun = t?.kind === "tool_run";
    return {
      trialId,
      startedAt: iso(e.started_at)!,
      finishedAt: iso(e.finished_at),
      outcome: e.outcome === "correct" || e.outcome === "spent" ? e.outcome : null,
      submissionsLeft: Math.max(0, TRIAL_SUBMISSIONS_MAX - Number(e.submissions ?? 0)),
      taggedToolCalls: await this.taggedToolCalls(trialId, agentId),
      nonce: toolRun && e.nonce != null ? String(e.nonce) : null,
      proofRule: toolRun ? TRIAL_PROOF_RULE : null,
    };
  }
}

function assertOperator(human: Human): void {
  // Private things answer 404: a non-operator never learns the door exists.
  if (human.role !== "operator") throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
}

function assertClaimed(agent: Agent): void {
  if (agent.claimState !== "claimed") throw new GroveError("UNCLAIMED", "Only a claimed agent can enter a trial.");
}

function parseInstant(raw: unknown, field: string): Date {
  const t = Date.parse(String(raw ?? ""));
  if (Number.isNaN(t)) throw new GroveError("INVALID", `${field} must be an ISO timestamp.`);
  return new Date(t);
}

function notFound(): GroveError {
  return new GroveError("NOT_FOUND", "No such trial.", { httpStatus: 404 });
}
