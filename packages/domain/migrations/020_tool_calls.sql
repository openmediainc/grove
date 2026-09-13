-- Tool calls: give `tool` a shape.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- `tool` is one verb that is simply "on". It covers a 40ms file read and a
-- six-minute build identically, and the map's "construction progress" was a
-- clock running on a URL because Grove had no progress field to read. A span
-- fixes that: start, finish, name, a caption, a duration, an outcome, and
-- progress ONLY when the agent actually reports it.
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AND NOT world_events
-- ---------------------------------------------------------------------------
-- 017 put verb stretches in world_events because a phase is a fact about the
-- world with a permission model already written. A tool call is different in
-- two ways that matter:
--
--   * It is MUTABLE while open. Progress lands on it, and the finish updates
--     it. world_events is append-only by design; a span would be two or three
--     rows stitched back together by every reader.
--   * It is HIGH VOLUME. A busy Claude Code turn makes dozens of calls a minute.
--     017 spent a whole essay keeping the ledger to "tens of rows a day"; this
--     table is allowed to be busy because it is pruned (see RETENTION).
--
-- The open span still reaches the ledger indirectly: starting a span pulses
-- the body `tool` (PresenceService writes presence.verb), so 017's trigger
-- records the stretch exactly as it records any other pulse.
--
-- ---------------------------------------------------------------------------
-- HONESTY
-- ---------------------------------------------------------------------------
-- An agent may report `ok`, `error` or `cancelled`. `stalled` is never a claim:
-- only the server writes it, when a span has heard nothing for long enough that
-- the only true statement is "we stopped hearing about this". A span closed as
-- stalled ends at updated_at + 180s (STALL_AFTER_SECONDS, the same cut 017
-- uses) rather than at the moment the sweep noticed. A late real finish still
-- overwrites a stalled verdict: the truth, when it arrives, wins.
--
-- Progress is NULL unless reported. The map draws NULL as indeterminate, never
-- as 0%, so a clock can never pose as a bar again.
--
-- ---------------------------------------------------------------------------
-- RETENTION
-- ---------------------------------------------------------------------------
-- Finished spans are deleted after 7 days by ToolCallService.sweep(). The
-- open-span index is partial, so it stays the size of what is running now.
--
-- Safe to re-run: IF NOT EXISTS throughout, no backfill, no existing row touched.

CREATE TABLE IF NOT EXISTS tool_calls (
  id              TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The caller's own id for the call (Claude Code's tool_use_id), so a start
  -- and a finish from two separate hook processes can find each other.
  call_id         TEXT NOT NULL,
  room_id         TEXT,
  name            TEXT NOT NULL,
  args            TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  outcome         TEXT CHECK (outcome IN ('ok', 'error', 'cancelled', 'stalled')),
  progress        REAL CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
  progress_done   INT CHECK (progress_done IS NULL OR progress_done >= 0),
  progress_total  INT CHECK (progress_total IS NULL OR progress_total > 0),
  result          TEXT,
  CONSTRAINT tool_calls_finish_has_outcome CHECK ((finished_at IS NULL) = (outcome IS NULL)),
  CONSTRAINT tool_calls_call_per_actor UNIQUE (actor_id, call_id)
);

-- What is running now, per body. The map reads this on every poll.
CREATE INDEX IF NOT EXISTS tool_calls_open
  ON tool_calls (actor_id, started_at DESC)
  WHERE finished_at IS NULL;

-- Recently finished, for the outcome a watcher can still hover, and for pruning.
CREATE INDEX IF NOT EXISTS tool_calls_finished
  ON tool_calls (finished_at DESC)
  WHERE finished_at IS NOT NULL;
