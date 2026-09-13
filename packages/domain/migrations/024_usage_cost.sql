-- Cost burn: the resource Grove never modelled (AGT-11).
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- The map shows what an agent is doing and, since 017, how long it did it.
-- It cannot answer the question an owner actually asks at the end of a day:
-- "what did today cost". Paperclip models budgets in cents; Grove modelled
-- nothing. This migration gives agents somewhere to report usage, and gives
-- owners a day they can add up.
--
-- ---------------------------------------------------------------------------
-- UNITS: integer micro-dollars, not cents
-- ---------------------------------------------------------------------------
-- Paperclip keeps cents (budgetMonthlyCents / spentMonthlyCents). Cents are
-- too coarse for a single model turn: a short Haiku call costs a hundredth of
-- a cent, and summing rounded cents would report a busy day of small turns as
-- $0.00 -- a lie in exactly the direction this feature exists to prevent.
-- So every amount here is an INTEGER count of millionths of a US dollar
-- (1 cent = 10,000 micros). Paperclip figures are converted exactly on the
-- way in, never the other way. Integer, never float: a sum of a million
-- reports must still add up to the penny.
--
-- USD only, stated rather than implied: the column exists so a second currency
-- is a migration and not a silent mixing of units.
--
-- ---------------------------------------------------------------------------
-- UNKNOWN IS NOT ZERO
-- ---------------------------------------------------------------------------
-- `cost_micros` is NULLABLE and NULL means "the agent did not say what this
-- cost". A report can carry tokens and no price (Claude Code's transcript has
-- tokens but no dollars). Rollups therefore count costed and uncosted reports
-- separately, and a reader that sees `costed_reports = 0` must render "not
-- reported", never $0.00. A reported zero (a free local model) is a real 0.
--
-- ---------------------------------------------------------------------------
-- SHAPE
-- ---------------------------------------------------------------------------
--   usage_events   one row per accepted report (or per cumulative increment).
--                  The hourly view reads these; the map's deposit reads these.
--   usage_daily    per UTC day x agent x space x model rollup, written in the
--                  same transaction as the event. Month-to-date budgets and
--                  per-owner / per-org / per-space totals read this.
--   usage_sessions last cumulative totals per (agent, session, model), so a
--                  runtime that only knows a running session total (Claude
--                  Code's statusline) can report it repeatedly and be counted
--                  once. Increments, never re-counts.
--   agents.budget_monthly_micros  an optional owner-set monthly budget.
--
-- Owner and space are SNAPSHOTS taken when the report lands, not foreign keys:
-- spend belongs to whoever owned the agent and wherever it stood at the time,
-- and a later transfer or archive must not rewrite who paid for what. That is
-- also what lets the privacy rule be a plain predicate over the row.
--
-- Additive only: new tables, one nullable column. Nothing existing is touched.

CREATE TABLE IF NOT EXISTS usage_events (
  id                 TEXT PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  owner_human_id     TEXT,
  -- NULL when the agent had no body when it reported: attributable to no space.
  world_id           TEXT,
  room_id            TEXT,
  model              TEXT,
  input_tokens       BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens  BIGINT NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  cost_micros        BIGINT CHECK (cost_micros IS NULL OR cost_micros >= 0),
  currency           TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  -- 'report' = a delta the agent sent; 'cumulative' = an increment Grove derived.
  kind               TEXT NOT NULL DEFAULT 'report' CHECK (kind IN ('report', 'cumulative')),
  session_id         TEXT,
  -- Caller-chosen idempotency key for delta reports. A retry is not a second bill.
  client_id          TEXT,
  -- Optional link to a tool-call span, if the runtime has one. Plain text: the
  -- span ledger is another migration's, and cost must not fail if it is absent.
  span_id            TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_events_client_id
  ON usage_events (agent_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_events_agent_time ON usage_events (agent_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_owner_time ON usage_events (owner_human_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_world_time ON usage_events (world_id, occurred_at DESC);
-- The minimap asks "who deposited in the last two minutes" on every poll.
CREATE INDEX IF NOT EXISTS usage_events_created ON usage_events (created_at DESC);

CREATE TABLE IF NOT EXISTS usage_daily (
  day                DATE NOT NULL,
  agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- '' rather than NULL so the primary key is a real key: '' = no space.
  world_key          TEXT NOT NULL DEFAULT '',
  model_key          TEXT NOT NULL DEFAULT '',
  owner_human_id     TEXT,
  input_tokens       BIGINT NOT NULL DEFAULT 0,
  output_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  -- Sum over COSTED reports only. Meaningless when costed_reports = 0.
  cost_micros        BIGINT NOT NULL DEFAULT 0,
  costed_reports     INT NOT NULL DEFAULT 0,
  uncosted_reports   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, agent_id, world_key, model_key)
);
CREATE INDEX IF NOT EXISTS usage_daily_owner ON usage_daily (owner_human_id, day);
CREATE INDEX IF NOT EXISTS usage_daily_world ON usage_daily (world_key, day);
CREATE INDEX IF NOT EXISTS usage_daily_agent ON usage_daily (agent_id, day);

CREATE TABLE IF NOT EXISTS usage_sessions (
  agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id         TEXT NOT NULL,
  model_key          TEXT NOT NULL DEFAULT '',
  input_tokens       BIGINT NOT NULL DEFAULT 0,
  output_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  -- NULL until the session first reports a cost.
  cost_micros        BIGINT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, session_id, model_key)
);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS budget_monthly_micros BIGINT;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_budget_monthly_micros_check;
ALTER TABLE agents ADD CONSTRAINT agents_budget_monthly_micros_check
  CHECK (budget_monthly_micros IS NULL OR budget_monthly_micros > 0);
