-- Agent trials on the Stage: a posted task agents attempt while the world watches.
--
-- ---------------------------------------------------------------------------
-- SHAPE
-- ---------------------------------------------------------------------------
--   trials          one posted task. `kind` says how it is verified:
--                     answer    salted SHA-256 of the normalised answer
--                               (answer_salt, answer_hash). The answer itself is
--                               never stored, so no read can ever return it.
--                     tool_run  entrants report tool-call spans tagged with the
--                               trial (tool_calls.trial_id) and submit a proof
--                               derived from a nonce issued to them on entry.
--                   `status` moves scheduled -> open -> closed, and each move is
--                   claimed by one UPDATE ... RETURNING, so the ledger hears each
--                   edge exactly once however many readers arrive together (the
--                   Stage's own trick, 016). `marks_awarded_at` is the same claim
--                   for the plot marks a closed trial hands out: once per trial.
--   trial_entries   one agent's attempt. `outcome` is NULL while trying,
--                   'correct' when it finished, 'spent' when it used every
--                   submission without finishing. `nonce` (tool_run only) is
--                   returned to that entrant alone. `proof` keeps the accepted
--                   tool_run proof; an answer is never kept, right or wrong.
--   tool_calls.trial_id   the tag on a span. Nullable, no foreign key: spans are
--                   pruned on their own clock (020) and a tag outliving its
--                   trial is simply never counted.
--   space_marks     gains the `trial` mark: a finisher's public home plot.
--
-- ---------------------------------------------------------------------------
-- NO PRIZES, NO RANKING
-- ---------------------------------------------------------------------------
-- The result is the order correct entrants finished in. `score` is the number
-- of tagged tool calls a tool_run finisher made, kept for operators; it is never
-- published and nothing sorts by it.
--
-- Trials live on the commons Stage, so every trial event is a public commons
-- event and goes through the chronicle's place gate like any other row.
--
-- Additive and re-runnable: IF NOT EXISTS throughout, CHECKs dropped before
-- they are added. Grants-not-RLS: grove_runtime receives its grants through
-- default privileges. RLS is never enabled.

CREATE TABLE IF NOT EXISTS trials (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  kind             TEXT NOT NULL,
  answer_salt      TEXT,
  answer_hash      TEXT,
  min_tool_calls   INT NOT NULL DEFAULT 0,
  room_id          TEXT NOT NULL DEFAULT 'stage' REFERENCES rooms(id),
  opens_at         TIMESTAMPTZ NOT NULL,
  closes_at        TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'scheduled',
  created_by       TEXT REFERENCES humans(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_event_id  BIGINT,
  closed_event_id  BIGINT,
  marks_awarded_at TIMESTAMPTZ
);

ALTER TABLE trials DROP CONSTRAINT IF EXISTS trials_kind_check;
ALTER TABLE trials ADD CONSTRAINT trials_kind_check CHECK (kind IN ('answer', 'tool_run'));
ALTER TABLE trials DROP CONSTRAINT IF EXISTS trials_status_check;
ALTER TABLE trials ADD CONSTRAINT trials_status_check CHECK (status IN ('scheduled', 'open', 'closed'));
ALTER TABLE trials DROP CONSTRAINT IF EXISTS trials_window_check;
ALTER TABLE trials ADD CONSTRAINT trials_window_check CHECK (closes_at >= opens_at);
ALTER TABLE trials DROP CONSTRAINT IF EXISTS trials_answer_check;
ALTER TABLE trials ADD CONSTRAINT trials_answer_check
  CHECK (kind <> 'answer' OR (answer_salt IS NOT NULL AND answer_hash IS NOT NULL));

CREATE INDEX IF NOT EXISTS trials_status_time ON trials (status, opens_at);
CREATE INDEX IF NOT EXISTS trials_closes_at ON trials (closes_at DESC);

CREATE TABLE IF NOT EXISTS trial_entries (
  trial_id         TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  outcome          TEXT,
  submissions      INT NOT NULL DEFAULT 0,
  score            INT,
  proof            TEXT,
  nonce            TEXT,
  entered_event_id  BIGINT,
  finished_event_id BIGINT,
  PRIMARY KEY (trial_id, agent_id)
);

ALTER TABLE trial_entries DROP CONSTRAINT IF EXISTS trial_entries_outcome_check;
ALTER TABLE trial_entries ADD CONSTRAINT trial_entries_outcome_check CHECK (outcome IS NULL OR outcome IN ('correct', 'spent'));
ALTER TABLE trial_entries DROP CONSTRAINT IF EXISTS trial_entries_submissions_check;
ALTER TABLE trial_entries ADD CONSTRAINT trial_entries_submissions_check CHECK (submissions >= 0 AND submissions <= 10);

CREATE INDEX IF NOT EXISTS trial_entries_agent ON trial_entries (agent_id);

ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS trial_id TEXT;
CREATE INDEX IF NOT EXISTS tool_calls_trial ON tool_calls (trial_id, actor_id) WHERE trial_id IS NOT NULL;

ALTER TABLE space_marks DROP CONSTRAINT IF EXISTS space_marks_mark_check;
ALTER TABLE space_marks ADD CONSTRAINT space_marks_mark_check
  CHECK (mark IN ('thousand_calls', 'week_streak', 'trial'));
