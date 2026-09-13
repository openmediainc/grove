import type { Agent, Human } from "@grove/protocol";
import { WORLD_ID } from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newUlid } from "../ids.js";
import { withTx } from "../db.js";

/**
 * Cost burn (AGT-11, migration 021): the Age of Empires resource.
 *
 * Agents report what a turn cost; owners read what a day cost. Three rules run
 * through every function in this file, and every one of them is about honesty:
 *
 *   1. UNKNOWN IS NOT ZERO. A report without a price stores cost as NULL, and
 *      every total says how many of its reports were priced. A reader that gets
 *      `costMicros: null` must render "not reported", never "$0.00".
 *   2. INTEGER MICRO-DOLLARS. Paperclip's cents are too coarse for one turn; a
 *      day of small turns would round to nothing. 1 cent = 10,000 micros.
 *   3. SPEND IS MEMBERS-ONLY. Presence in a public space is public; what it
 *      cost is not. Nobody but the agent's owner, the members of the space it
 *      was spent in, or an operator can read a row — see `visibleRow()`.
 */

export const MICROS_PER_USD = 1_000_000;
export const MICROS_PER_CENT = 10_000;
/** A request may batch this many reports (one per model is the usual reason). */
export const USAGE_MAX_REPORTS = 20;
/** Reports may be backdated this far, e.g. a runtime flushing after a restart. */
export const USAGE_BACKDATE_DAYS = 7;
/** Clock skew tolerated on `occurred_at` in the future. */
export const USAGE_FUTURE_SKEW_SECONDS = 300;
/** The minimap shows a carried load for reports that landed this recently. */
export const DEPOSIT_WINDOW_SECONDS = 120;
/** Month-to-date spend at or over this share of the budget reads "near". */
export const BUDGET_NEAR_RATIO = 0.8;
/** One report cannot claim more than this: $1M, or 10^12 tokens. A typo guard, not a policy. */
const MAX_COUNT = 1_000_000_000_000;
const MAX_TEXT = 128;
const MAX_MODEL = 120;

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
type TokenField = (typeof TOKEN_FIELDS)[number];

/**
 * Anthropic's own names, accepted as aliases so a Claude Code hook can pass a
 * transcript `usage` block straight through. Keys arrive camelised by the route.
 */
const TOKEN_ALIASES: Record<TokenField, string[]> = {
  inputTokens: ["inputTokens"],
  outputTokens: ["outputTokens"],
  cacheReadTokens: ["cacheReadTokens", "cacheReadInputTokens"],
  cacheWriteTokens: ["cacheWriteTokens", "cacheCreationInputTokens"],
};

/** A validated report. Token fields are null when the caller did not send them. */
export interface UsageReport {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Null = the caller did not say what this cost. Never coerced to 0. */
  costMicros: number | null;
  cumulative: boolean;
  sessionId: string | null;
  clientId: string | null;
  spanId: string | null;
  occurredAt: Date;
}

function invalid(message: string): GroveError {
  return new GroveError("INVALID", message);
}

function optionalCount(raw: unknown, name: string): number | null {
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_COUNT) {
    throw invalid(`${name} must be a non-negative integer.`);
  }
  return n;
}

function optionalText(raw: unknown, name: string, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > max) throw invalid(`${name} must be ${max} characters or fewer.`);
  return s;
}

/**
 * Validate one report off the wire (keys already camelised).
 *
 * Cost may be given as `cost_micros` (integer) or `cost_usd` (number, rounded
 * to the nearest micro). Both at once must agree. Neither means "not reported",
 * which is a legal report as long as it carries tokens: a report with neither a
 * price nor a token count says nothing and is refused.
 */
export function normaliseUsageReport(raw: unknown, now: number = Date.now()): UsageReport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("A usage report must be an object.");
  const b = raw as Record<string, unknown>;

  const tokens = {} as Record<TokenField, number | null>;
  for (const field of TOKEN_FIELDS) {
    const alias = TOKEN_ALIASES[field].find((k) => b[k] !== undefined && b[k] !== null);
    tokens[field] = alias ? optionalCount(b[alias], field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)) : null;
  }

  const micros = optionalCount(b.costMicros, "cost_micros");
  let fromUsd: number | null = null;
  if (b.costUsd !== undefined && b.costUsd !== null) {
    const usd = typeof b.costUsd === "string" && b.costUsd.trim() !== "" ? Number(b.costUsd) : b.costUsd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || usd * MICROS_PER_USD > MAX_COUNT) {
      throw invalid("cost_usd must be a non-negative number.");
    }
    fromUsd = Math.round(usd * MICROS_PER_USD);
  }
  if (micros !== null && fromUsd !== null && Math.abs(micros - fromUsd) > 1) {
    throw invalid("cost_micros and cost_usd disagree. Send one.");
  }
  const costMicros = micros ?? fromUsd;

  if (b.currency !== undefined && b.currency !== null && String(b.currency).trim().toUpperCase() !== "USD") {
    throw invalid("Only USD is supported. Convert before reporting, or omit the cost.");
  }

  if (costMicros === null && TOKEN_FIELDS.every((f) => tokens[f] === null)) {
    throw invalid("A usage report needs a cost or at least one token count.");
  }

  const cumulative = b.cumulative === true || b.cumulative === "true";
  const sessionId = optionalText(b.sessionId, "session_id", MAX_TEXT);
  if (cumulative && !sessionId) throw invalid("A cumulative report needs a session_id to accumulate against.");

  let occurredAt = new Date(now);
  if (b.occurredAt !== undefined && b.occurredAt !== null && b.occurredAt !== "") {
    const at = Date.parse(String(b.occurredAt));
    if (!Number.isFinite(at)) throw invalid("occurred_at must be an ISO-8601 timestamp.");
    if (at < now - USAGE_BACKDATE_DAYS * 86_400_000) {
      throw invalid(`occurred_at may be at most ${USAGE_BACKDATE_DAYS} days in the past.`);
    }
    if (at > now + USAGE_FUTURE_SKEW_SECONDS * 1000) throw invalid("occurred_at is in the future.");
    occurredAt = new Date(at);
  }

  return {
    model: optionalText(b.model, "model", MAX_MODEL),
    ...tokens,
    costMicros,
    cumulative,
    sessionId,
    clientId: optionalText(b.id ?? b.clientId ?? b.idempotencyKey, "id", MAX_TEXT),
    spanId: optionalText(b.spanId, "span_id", MAX_TEXT),
    occurredAt,
  };
}

/** Accept `{...report}` or `{ reports: [...] }`. */
export function normaliseUsageBody(body: unknown, now: number = Date.now()): UsageReport[] {
  const b = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(b.reports)) {
    if (b.reports.length === 0) throw invalid("reports is empty.");
    if (b.reports.length > USAGE_MAX_REPORTS) throw invalid(`At most ${USAGE_MAX_REPORTS} reports per request.`);
    return b.reports.map((r) => normaliseUsageReport(r, now));
  }
  return [normaliseUsageReport(b, now)];
}

/** What one report became once Grove had read it. */
export interface UsageRecorded {
  id: string | null;
  /** A delta report whose `id` was already accepted: stored once, not twice. */
  duplicate: boolean;
  /** A cumulative report that moved no total: nothing new to record. */
  unchanged: boolean;
  model: string | null;
  /** What was ADDED to the day. For a cumulative report, the increment. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number | null;
  occurredAt: string;
  worldId: string | null;
}

export interface UsageTotals {
  reports: number;
  costedReports: number;
  uncostedReports: number;
  /** Null when no report in this bucket carried a price. Not reported is not zero. */
  costMicros: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type BudgetState = "none" | "unknown" | "ok" | "near" | "over";

export interface AgentBudget {
  monthlyMicros: number | null;
  /** Month-to-date spend over costed reports, or null if none was priced. */
  monthToDateMicros: number | null;
  monthUncostedReports: number;
  /** Straight-line projection to month end; null when not computable. */
  projectedMicros: number | null;
  state: BudgetState;
}

export type UsageScopeKind = "mine" | "agent" | "org" | "space";

export interface UsageDay {
  scope: { kind: UsageScopeKind; id: string | null; label: string };
  day: string;
  currency: "USD";
  totals: UsageTotals;
  byAgent: Array<UsageTotals & { agentId: string; displayName: string; budget: AgentBudget | null }>;
  byModel: Array<UsageTotals & { model: string | null }>;
  /** 24 entries, UTC hours. */
  byHour: Array<UsageTotals & { hour: number }>;
  /** Budgets of the viewer's own agents that are near or over, whatever they spent today. */
  budgetAlerts: Array<{ agentId: string; displayName: string; budget: AgentBudget }>;
  /** Claimed agents the viewer owns. Lets a client hide a counter with nothing to count. */
  ownedAgents: number;
  /** Orgs the viewer may switch the scope to. */
  orgs: Array<{ id: string; slug: string; name: string }>;
}

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function totalsOf(r: Record<string, unknown>): UsageTotals {
  const costed = num(r.costed_reports);
  const uncosted = num(r.uncosted_reports);
  return {
    reports: costed + uncosted,
    costedReports: costed,
    uncostedReports: uncosted,
    costMicros: costed > 0 ? num(r.cost_micros) : null,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheWriteTokens: num(r.cache_write_tokens),
  };
}

const EMPTY_TOTALS: UsageTotals = totalsOf({});

/** Rollup columns, summed. `cost` is the per-row cost expression. */
function sums(costedExpr: string, uncostedExpr: string, costExpr: string): string {
  return `COALESCE(sum(input_tokens),0) AS input_tokens,
          COALESCE(sum(output_tokens),0) AS output_tokens,
          COALESCE(sum(cache_read_tokens),0) AS cache_read_tokens,
          COALESCE(sum(cache_write_tokens),0) AS cache_write_tokens,
          COALESCE(sum(${costExpr}),0) AS cost_micros,
          COALESCE(sum(${costedExpr}),0) AS costed_reports,
          COALESCE(sum(${uncostedExpr}),0) AS uncosted_reports`;
}
const DAILY_SUMS = sums("costed_reports", "uncosted_reports", "cost_micros");
const EVENT_SUMS = sums(
  "CASE WHEN cost_micros IS NOT NULL THEN 1 ELSE 0 END",
  "CASE WHEN cost_micros IS NULL THEN 1 ELSE 0 END",
  "cost_micros",
);

/** `YYYY-MM-DD` for a UTC day. */
export function utcDay(at: Date | number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The budget verdict. Pure, so the web and the tests agree on the arithmetic.
 *
 * `unknown` is its own state on purpose: an agent with a budget that has never
 * priced a report is not "ok" — nobody knows what it spent.
 */
export function budgetVerdict(input: {
  monthlyMicros: number | null;
  monthToDateMicros: number | null;
  monthUncostedReports: number;
  /** Share of the month elapsed, 0..1. Null for a past month (projection meaningless). */
  monthElapsed: number | null;
}): AgentBudget {
  const { monthlyMicros, monthToDateMicros, monthUncostedReports, monthElapsed } = input;
  const projectedMicros =
    monthToDateMicros !== null && monthElapsed !== null && monthElapsed > 0
      ? Math.round(monthToDateMicros / Math.min(1, monthElapsed))
      : null;
  let state: BudgetState = "none";
  if (monthlyMicros !== null) {
    if (monthToDateMicros === null) state = "unknown";
    else if (monthToDateMicros >= monthlyMicros) state = "over";
    else if (monthToDateMicros >= monthlyMicros * BUDGET_NEAR_RATIO) state = "near";
    else state = "ok";
  }
  return { monthlyMicros, monthToDateMicros, monthUncostedReports, projectedMicros, state };
}

interface ScopeSql {
  kind: UsageScopeKind;
  id: string | null;
  label: string;
  /** Predicate over a table aliased `u`; `$1` is always the viewer id. */
  where: (worldCol: string) => string;
  params: unknown[];
}

export class UsageService {
  constructor(private store: GroveStore) {}

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /**
   * Record reports from one agent. All-or-nothing: one invalid report refuses
   * the batch (validation happens before this is called), and the rows land in
   * one transaction with their rollups so a day can never disagree with its
   * events.
   */
  async record(agent: Pick<Agent, "id" | "ownerHumanId">, reports: UsageReport[]): Promise<UsageRecorded[]> {
    const { rows: where } = await this.store.pg.query(
      `SELECT p.room_id, r.world_id FROM presence p JOIN rooms r ON r.id = p.room_id WHERE p.actor_id = $1`,
      [agent.id],
    );
    const roomId = where[0] ? String(where[0].room_id) : null;
    const worldId = where[0] ? String(where[0].world_id) : null;
    const owner = agent.ownerHumanId ?? null;

    return withTx(this.store.pg, async (c) => {
      const out: UsageRecorded[] = [];
      for (const r of reports) {
        const inc = {
          inputTokens: r.inputTokens ?? 0,
          outputTokens: r.outputTokens ?? 0,
          cacheReadTokens: r.cacheReadTokens ?? 0,
          cacheWriteTokens: r.cacheWriteTokens ?? 0,
        };
        let costInc = r.costMicros;

        if (r.cumulative) {
          const modelKey = r.model ?? "";
          const { rows: prevRows } = await c.query(
            `SELECT * FROM usage_sessions WHERE agent_id = $1 AND session_id = $2 AND model_key = $3 FOR UPDATE`,
            [agent.id, r.sessionId, modelKey],
          );
          const prev = prevRows[0] as Record<string, unknown> | undefined;
          const column: Record<TokenField, string> = {
            inputTokens: "input_tokens",
            outputTokens: "output_tokens",
            cacheReadTokens: "cache_read_tokens",
            cacheWriteTokens: "cache_write_tokens",
          };
          const next = {} as Record<TokenField, number>;
          for (const f of TOKEN_FIELDS) {
            const before = prev ? num(prev[column[f]]) : 0;
            const now = r[f];
            // A total that goes backwards is treated as a stale report arriving
            // late, not as a reset: it adds nothing and never lowers the mark.
            // Re-counting would be the dishonest failure, so this is the safe one.
            inc[f] = now === null ? 0 : Math.max(0, now - before);
            next[f] = now === null ? before : Math.max(before, now);
          }
          const prevCost = prev && prev.cost_micros !== null ? num(prev.cost_micros) : null;
          costInc = r.costMicros === null ? null : prevCost === null ? r.costMicros : Math.max(0, r.costMicros - prevCost);
          const nextCost =
            r.costMicros === null ? prevCost : prevCost === null ? r.costMicros : Math.max(prevCost, r.costMicros);
          await c.query(
            `INSERT INTO usage_sessions (agent_id, session_id, model_key, input_tokens, output_tokens,
                                         cache_read_tokens, cache_write_tokens, cost_micros, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
             ON CONFLICT (agent_id, session_id, model_key) DO UPDATE SET
               input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
               cache_read_tokens = EXCLUDED.cache_read_tokens, cache_write_tokens = EXCLUDED.cache_write_tokens,
               cost_micros = EXCLUDED.cost_micros, updated_at = now()`,
            [agent.id, r.sessionId, modelKey, next.inputTokens, next.outputTokens, next.cacheReadTokens,
              next.cacheWriteTokens, nextCost],
          );
          const moved = TOKEN_FIELDS.some((f) => inc[f] > 0) || (costInc !== null && costInc > 0);
          if (!moved) {
            out.push({ id: null, duplicate: false, unchanged: true, model: r.model, ...inc, costMicros: null,
              occurredAt: r.occurredAt.toISOString(), worldId });
            continue;
          }
          // A report that sent no cost leaves costInc null: its tokens were
          // not priced, which reads "not reported", never $0.00.
        }

        const id = `use_${newUlid()}`;
        const { rows: inserted } = await c.query(
          `INSERT INTO usage_events (id, agent_id, owner_human_id, world_id, room_id, model,
                                     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                     cost_micros, kind, session_id, client_id, span_id, occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (agent_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [id, agent.id, owner, worldId, roomId, r.model, inc.inputTokens, inc.outputTokens, inc.cacheReadTokens,
            inc.cacheWriteTokens, costInc, r.cumulative ? "cumulative" : "report", r.sessionId,
            r.cumulative ? null : r.clientId, r.spanId, r.occurredAt.toISOString()],
        );
        if (!inserted[0]) {
          out.push({ id: null, duplicate: true, unchanged: false, model: r.model, inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: null, occurredAt: r.occurredAt.toISOString(), worldId });
          continue;
        }
        await c.query(
          `INSERT INTO usage_daily (day, agent_id, world_key, model_key, owner_human_id, input_tokens, output_tokens,
                                    cache_read_tokens, cache_write_tokens, cost_micros, costed_reports, uncosted_reports)
           VALUES (($1::timestamptz AT TIME ZONE 'UTC')::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (day, agent_id, world_key, model_key) DO UPDATE SET
             owner_human_id     = EXCLUDED.owner_human_id,
             input_tokens       = usage_daily.input_tokens + EXCLUDED.input_tokens,
             output_tokens      = usage_daily.output_tokens + EXCLUDED.output_tokens,
             cache_read_tokens  = usage_daily.cache_read_tokens + EXCLUDED.cache_read_tokens,
             cache_write_tokens = usage_daily.cache_write_tokens + EXCLUDED.cache_write_tokens,
             cost_micros        = usage_daily.cost_micros + EXCLUDED.cost_micros,
             costed_reports     = usage_daily.costed_reports + EXCLUDED.costed_reports,
             uncosted_reports   = usage_daily.uncosted_reports + EXCLUDED.uncosted_reports`,
          [r.occurredAt.toISOString(), agent.id, worldId ?? "", r.model ?? "", owner, inc.inputTokens,
            inc.outputTokens, inc.cacheReadTokens, inc.cacheWriteTokens, costInc ?? 0,
            costInc === null ? 0 : 1, costInc === null ? 1 : 0],
        );
        out.push({ id: String(inserted[0].id), duplicate: false, unchanged: false, model: r.model, ...inc,
          costMicros: costInc, occurredAt: r.occurredAt.toISOString(), worldId });
      }
      return out;
    });
  }

  /** Owner (or operator) sets or clears an agent's monthly budget. */
  async setBudget(human: Human, agentId: string, monthlyMicros: number | null): Promise<number | null> {
    if (monthlyMicros !== null && (!Number.isInteger(monthlyMicros) || monthlyMicros <= 0 || monthlyMicros > MAX_COUNT)) {
      throw invalid("A budget must be a positive amount, or null to clear it.");
    }
    const { rows } = await this.store.pg.query(
      `UPDATE agents SET budget_monthly_micros = $2
        WHERE id = $1 AND (owner_human_id = $3 OR $4::boolean)
        RETURNING budget_monthly_micros`,
      [agentId, monthlyMicros, human.id, human.role === "operator"],
    );
    // Same convention as the rest of the owner surface: not yours is not there.
    if (!rows[0]) throw new GroveError("NOT_FOUND", "Agent not found.", { httpStatus: 404 });
    return rows[0].budget_monthly_micros === null ? null : num(rows[0].budget_monthly_micros);
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * The row-level rule, once. A non-operator viewer ($1) reads a usage row only
   * if they owned the agent when it was spent, or are a member (or owner) of
   * the space it was spent in. The civic core has no members to speak of, so
   * commons spend is its owner's alone — except through an org, below.
   */
  private visibleRow(worldCol: string): string {
    return `(u.owner_human_id = $1
             OR (NULLIF(${worldCol}, '') IS NOT NULL AND ${worldCol} <> '${WORLD_ID}' AND EXISTS (
                   SELECT 1 FROM worlds vw LEFT JOIN world_members vm ON vm.world_id = vw.id AND vm.human_id = $1
                    WHERE vw.id = ${worldCol} AND (vw.owner_human_id = $1 OR vm.human_id IS NOT NULL))))`;
  }

  private async resolveScope(viewer: Human, raw: string | undefined): Promise<ScopeSql> {
    const operator = viewer.role === "operator";
    const value = (raw ?? "mine").trim() || "mine";
    const [kindRaw, ...rest] = value.split(":");
    const ref = rest.join(":");
    // `$1::text IS NOT NULL` rather than TRUE: every predicate must mention the
    // viewer parameter, or Postgres cannot type $1 and refuses the query.
    const gate = (worldCol: string) => (operator ? "$1::text IS NOT NULL" : this.visibleRow(worldCol));
    const notFound = () => new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });

    if (kindRaw === "mine") {
      return { kind: "mine", id: null, label: "your agents", where: () => `u.owner_human_id = $1`, params: [] };
    }
    if (kindRaw === "agent" && ref) {
      const { rows } = await this.store.pg.query(`SELECT id, display_name, owner_human_id FROM agents WHERE id = $1`, [ref]);
      if (!rows[0] || (!operator && rows[0].owner_human_id !== viewer.id)) throw notFound();
      return {
        kind: "agent",
        id: String(rows[0].id),
        label: String(rows[0].display_name),
        where: (w) => `u.agent_id = $2 AND ${gate(w)}`,
        params: [rows[0].id],
      };
    }
    if (kindRaw === "org" && ref) {
      const { rows } = await this.store.pg.query(
        `SELECT o.id, o.name FROM orgs o
          WHERE (o.id = $1 OR o.slug = $1)
            AND ($3::boolean OR o.owner_human_id = $2
                 OR EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id AND m.human_id = $2))`,
        [ref, viewer.id, operator],
      );
      if (!rows[0]) throw notFound();
      return {
        kind: "org",
        id: String(rows[0].id),
        label: String(rows[0].name),
        // Org spend: agents whose owner is in the org. Commons spend (or spend
        // with no body) is shared with fellow members; spend inside a space
        // still needs membership of THAT space, so an org is never a way to
        // read a private plot you are not in.
        where: (w) => `u.owner_human_id IN (SELECT human_id FROM org_members WHERE org_id = $2
                                            UNION SELECT owner_human_id FROM orgs WHERE id = $2)
                       AND (${operator ? "$1::text IS NOT NULL" : `(NULLIF(${w}, '') IS NULL OR ${w} = '${WORLD_ID}' OR ${this.visibleRow(w)})`})`,
        params: [rows[0].id],
      };
    }
    if (kindRaw === "space" && ref) {
      const { rows } = await this.store.pg.query(
        `SELECT w.id, w.name, w.owner_human_id,
                EXISTS (SELECT 1 FROM world_members m WHERE m.world_id = w.id AND m.human_id = $2) AS member
           FROM worlds w WHERE w.id = $1 OR w.slug = $1`,
        [ref, viewer.id],
      );
      const w = rows[0];
      if (!w) throw notFound();
      // The commons is everyone's, so "the commons' spend" would be every
      // owner's spend at once: operators only. A space is its members'.
      const allowed = operator || (w.id !== WORLD_ID && (w.owner_human_id === viewer.id || w.member === true));
      if (!allowed) throw notFound();
      return {
        kind: "space",
        id: String(w.id),
        label: String(w.name),
        where: (col) => `${col} = $2 AND $1::text IS NOT NULL`,
        params: [w.id],
      };
    }
    throw invalid("scope must be mine, agent:<id>, org:<id|slug> or space:<id|slug>.");
  }

  /** What a day cost, for one scope. `day` is a UTC `YYYY-MM-DD`, default today. */
  async day(viewer: Human, opts: { scope?: string; day?: string } = {}, now: number = Date.now()): Promise<UsageDay> {
    const today = utcDay(now);
    const day = opts.day?.trim() || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))) {
      throw invalid("day must be YYYY-MM-DD (UTC).");
    }
    if (day > today) throw invalid("day is in the future.");
    const scope = await this.resolveScope(viewer, opts.scope);
    const params = [viewer.id, ...scope.params];
    const p = (n: number) => `$${params.length + n}`;
    const pg = this.store.pg;

    const [agentRows, modelRows, hourRows, owned, orgs] = await Promise.all([
      pg.query(
        `SELECT u.agent_id, a.display_name, ${DAILY_SUMS}
           FROM usage_daily u JOIN agents a ON a.id = u.agent_id
          WHERE u.day = ${p(1)} AND ${scope.where("u.world_key")}
          GROUP BY u.agent_id, a.display_name
          ORDER BY COALESCE(sum(u.cost_micros),0) DESC, a.display_name`,
        [...params, day],
      ),
      pg.query(
        `SELECT u.model_key, ${DAILY_SUMS}
           FROM usage_daily u
          WHERE u.day = ${p(1)} AND ${scope.where("u.world_key")}
          GROUP BY u.model_key
          ORDER BY COALESCE(sum(u.cost_micros),0) DESC, u.model_key`,
        [...params, day],
      ),
      pg.query(
        `SELECT extract(hour FROM u.occurred_at AT TIME ZONE 'UTC')::int AS hour, ${EVENT_SUMS}
           FROM usage_events u
          WHERE u.occurred_at >= ${p(1)}::date AT TIME ZONE 'UTC'
            AND u.occurred_at <  (${p(1)}::date + 1) AT TIME ZONE 'UTC'
            AND ${scope.where("u.world_id")}
          GROUP BY 1`,
        [...params, day],
      ),
      pg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agents WHERE owner_human_id = $1 AND claim_state = 'claimed'`,
        [viewer.id],
      ),
      pg.query(
        `SELECT o.id, o.slug, o.name FROM orgs o
          WHERE o.owner_human_id = $1 OR EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id AND m.human_id = $1)
          ORDER BY o.created_at`,
        [viewer.id],
      ),
    ]);

    const byAgentBase = agentRows.rows.map((r) => ({
      agentId: String(r.agent_id),
      displayName: String(r.display_name),
      ...totalsOf(r),
    }));

    // Budgets: only for agents the viewer owns (an operator sees every one in
    // view). Another owner's budget is their business, even inside a shared org.
    const budgets = await this.budgets(viewer, day, now, byAgentBase.map((a) => a.agentId));

    const total = byAgentBase.reduce<UsageTotals>(
      (acc, a) => {
        const costed = acc.costedReports + a.costedReports;
        return {
          reports: acc.reports + a.reports,
          costedReports: costed,
          uncostedReports: acc.uncostedReports + a.uncostedReports,
          costMicros: costed > 0 ? (acc.costMicros ?? 0) + (a.costMicros ?? 0) : null,
          inputTokens: acc.inputTokens + a.inputTokens,
          outputTokens: acc.outputTokens + a.outputTokens,
          cacheReadTokens: acc.cacheReadTokens + a.cacheReadTokens,
          cacheWriteTokens: acc.cacheWriteTokens + a.cacheWriteTokens,
        };
      },
      { ...EMPTY_TOTALS },
    );

    const hours = new Map(hourRows.rows.map((r) => [num(r.hour), totalsOf(r)]));
    return {
      scope: { kind: scope.kind, id: scope.id, label: scope.label },
      day,
      currency: "USD",
      totals: total,
      byAgent: byAgentBase.map((a) => ({ ...a, budget: budgets.get(a.agentId)?.budget ?? null })),
      byModel: modelRows.rows.map((r) => ({ model: r.model_key ? String(r.model_key) : null, ...totalsOf(r) })),
      byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, ...(hours.get(hour) ?? EMPTY_TOTALS) })),
      budgetAlerts: [...budgets.values()]
        .filter((b) => b.budget.state === "near" || b.budget.state === "over")
        .map((b) => ({ agentId: b.agentId, displayName: b.displayName, budget: b.budget })),
      ownedAgents: owned.rows[0]?.n ?? 0,
      orgs: orgs.rows.map((o) => ({ id: String(o.id), slug: String(o.slug), name: String(o.name) })),
    };
  }

  /**
   * Month-to-date against budget for the viewer's own budgeted agents, plus any
   * extra agents in view the viewer is allowed to see a budget for.
   */
  private async budgets(
    viewer: Human,
    day: string,
    now: number,
    inView: string[],
  ): Promise<Map<string, { agentId: string; displayName: string; budget: AgentBudget }>> {
    const operator = viewer.role === "operator";
    const monthStart = `${day.slice(0, 7)}-01`;
    const { rows } = await this.store.pg.query(
      `SELECT a.id, a.display_name, a.budget_monthly_micros,
              COALESCE(sum(u.cost_micros),0) AS cost_micros,
              COALESCE(sum(u.costed_reports),0) AS costed_reports,
              COALESCE(sum(u.uncosted_reports),0) AS uncosted_reports
         FROM agents a
         LEFT JOIN usage_daily u
           ON u.agent_id = a.id AND u.day >= $2::date AND u.day <= $3::date
          -- Spend under a previous owner is not this owner's burn.
          AND u.owner_human_id IS NOT DISTINCT FROM a.owner_human_id
        WHERE (a.owner_human_id = $1 AND (a.budget_monthly_micros IS NOT NULL OR a.id = ANY($4::text[])))
           OR ($5::boolean AND a.id = ANY($4::text[]))
        GROUP BY a.id, a.display_name, a.budget_monthly_micros`,
      [viewer.id, monthStart, day, inView, operator],
    );
    const start = Date.parse(`${monthStart}T00:00:00Z`);
    const d = new Date(start);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    // A projection only means something for the month we are in.
    const elapsed = utcDay(now).slice(0, 7) === day.slice(0, 7) ? (now - start) / (end - start) : null;
    const out = new Map<string, { agentId: string; displayName: string; budget: AgentBudget }>();
    for (const r of rows) {
      const costed = num(r.costed_reports);
      out.set(String(r.id), {
        agentId: String(r.id),
        displayName: String(r.display_name),
        budget: budgetVerdict({
          monthlyMicros: r.budget_monthly_micros === null ? null : num(r.budget_monthly_micros),
          monthToDateMicros: costed > 0 ? num(r.cost_micros) : null,
          monthUncostedReports: num(r.uncosted_reports),
          monthElapsed: elapsed,
        }),
      });
    }
    return out;
  }

  /**
   * Bodies that just finished a costed (or uncosted) turn, for the carry-and-
   * deposit animation on the map. Timestamp and a boolean only — the minimap is
   * readable by anyone who can see the world, and an amount is not theirs.
   */
  async recentDeposits(agentIds: string[]): Promise<Map<string, { at: string; costed: boolean }>> {
    const out = new Map<string, { at: string; costed: boolean }>();
    if (agentIds.length === 0) return out;
    const { rows } = await this.store.pg.query(
      `SELECT DISTINCT ON (u.agent_id) u.agent_id, u.created_at, u.cost_micros IS NOT NULL AS costed
         FROM usage_events u
         JOIN unnest($1::text[]) AS want(id) ON want.id = u.agent_id
        WHERE u.created_at > now() - make_interval(secs => $2)
          AND u.occurred_at > now() - interval '10 minutes'
        ORDER BY u.agent_id, u.created_at DESC`,
      [agentIds, DEPOSIT_WINDOW_SECONDS],
    );
    for (const r of rows) {
      out.set(String(r.agent_id), { at: new Date(r.created_at as string).toISOString(), costed: r.costed === true });
    }
    return out;
  }
}
