-- Achievement marks on plots: a space's sign remembers real work.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- A plot's signboard (item #6) says what a space is called and who may walk
-- in. It cannot say "work has happened here", because the only record of a
-- tool call, `tool_calls` (020), is pruned seven days after the call finishes.
-- A lifetime fact ("its agents have made a thousand tool calls") needs a tally
-- that outlives the prune. None of the existing durable ledgers holds one:
-- usage_daily (024) counts cost REPORTS, not calls, and the 017 verb history
-- coalesces a whole afternoon of calls into one `tool` stretch on purpose.
--
-- ---------------------------------------------------------------------------
-- SHAPE
-- ---------------------------------------------------------------------------
--   tool_call_daily  per UTC day x space, how many tool-call spans started in
--                    that space's rooms. Written ONLY by the prune: the same
--                    statement that deletes a finished span adds it here. So a
--                    span is counted exactly once, in exactly one place, and
--                    lifetime = sum(tool_call_daily) + count(live tool_calls).
--                    Nothing is added to the hot path of a call starting, and
--                    every span already in tool_calls counts without a backfill.
--   space_marks      a mark a space has EARNED, with when. Earned once and kept:
--                    a later agent deletion (which cascades its live spans) or a
--                    quiet month never takes a mark back.
--
-- Space, not agent: a mark belongs to the ground the work happened on, which
-- is what the map draws. Work attributed by the room the span started in, the
-- same snapshot-at-the-time rule usage_daily uses.
--
-- ---------------------------------------------------------------------------
-- NO POINTS, NO RANKING
-- ---------------------------------------------------------------------------
-- The tally is never published. The only thing that leaves the database is the
-- set of mark keys a space holds, so there is nothing to sort a leaderboard by.
-- A private plot's marks are never published at all (the reader redacts them
-- with its name).
--
-- Additive only: two new tables. Safe to re-run: IF NOT EXISTS throughout, and
-- the CHECK is dropped before it is added.

CREATE TABLE IF NOT EXISTS tool_call_daily (
  day       DATE NOT NULL,
  world_id  TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  calls     BIGINT NOT NULL DEFAULT 0 CHECK (calls >= 0),
  PRIMARY KEY (world_id, day)
);

CREATE TABLE IF NOT EXISTS space_marks (
  world_id   TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  mark       TEXT NOT NULL,
  earned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, mark)
);

ALTER TABLE space_marks DROP CONSTRAINT IF EXISTS space_marks_mark_check;
ALTER TABLE space_marks ADD CONSTRAINT space_marks_mark_check
  CHECK (mark IN ('thousand_calls', 'week_streak'));
