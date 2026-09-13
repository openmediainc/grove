-- MOD-01: the mod queue RULES.md has been promising since the alpha opened.
--
-- Three things were written and never read:
--   * `reports` had a `status` column and no reader worth the name — no record
--     of WHO decided it, WHY, or what was actually done about it.
--   * `world_events` collected `prompt_injection_flag` rows that nobody could
--     ever see, let alone mark as looked-at.
--   * `world_flags` (the kill switch) had an `updated_by` nobody surfaced.
--
-- This migration adds the smallest amount of state that turns those into a
-- queue a human can work: a resolution on a report, a review marker on an
-- injection flag, and the indexes the two queue reads need.
--
-- Deliberately NOT added: an assignment column, an SLA clock, canned-response
-- templates, a separate warnings table. A warning is an event, not a row that
-- needs its own lifecycle — it lives in `world_events` with every other
-- moderator action, which is the one audit ledger (see `mod.*` types below).
--
-- Safe to re-run: the live API may call migrate() at boot, and every statement
-- here is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

-- ---------------------------------------------------------------------------
-- Reports: how it was decided, by whom, and why.
--
-- `status` keeps its existing vocabulary (open / resolved / rejected) so the
-- pre-existing /ops/reports reader is untouched. `resolution` is the richer
-- verb the moderator actually chose — dismiss, warn, suspend, freeze — which
-- `status` alone could never carry.
-- ---------------------------------------------------------------------------
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolution      TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_by     TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at     TIMESTAMPTZ;

-- The queue read: open reports, newest first.
CREATE INDEX IF NOT EXISTS reports_open_recent ON reports (created_at DESC) WHERE status = 'open';
-- "has this actor been reported before?", shown on every card.
CREATE INDEX IF NOT EXISTS reports_target_time ON reports (target_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Prompt-injection flags: a review marker, not a copy of the flag.
--
-- The flag itself stays where speech.ts writes it (`world_events`, type
-- `prompt_injection_flag`). Duplicating it here would create a second source of
-- truth that could drift. All this table records is that a named operator
-- looked at event N and what they concluded, so the "open" queue can drain.
--
-- ON DELETE CASCADE matters for the test sweep: fixtures delete world_events by
-- actor, and a review must not outlive the flag it reviewed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS injection_reviews (
  event_id    BIGINT PRIMARY KEY REFERENCES world_events(id) ON DELETE CASCADE,
  outcome     TEXT NOT NULL,
  note        TEXT,
  reviewed_by TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes for the two derived reads.
-- ---------------------------------------------------------------------------

-- Every moderator action is a `mod.*` world_event. Two reads need it: the
-- action log (by time) and "prior warnings against this actor" on a report
-- card (by payload target). 001 already indexes (type, created_at DESC), which
-- serves the log; this one serves the per-target lookup.
CREATE INDEX IF NOT EXISTS world_events_mod_target
  ON world_events ((payload->>'targetId'), created_at DESC)
  WHERE type LIKE 'mod.%';

-- Correlating an injection flag to the line that tripped it: speech.ts writes
-- the flag immediately BEFORE inserting the speech row, carrying only the
-- sender and the channel, so the body is found by (sender_id, created_at).
CREATE INDEX IF NOT EXISTS speech_sender_time ON speech (sender_id, created_at DESC);
