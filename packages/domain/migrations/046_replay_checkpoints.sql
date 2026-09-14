-- Replay checkpoints (queue #63): server-side keyframes so a deep seek into a
-- busy day is "nearest checkpoint + a few minutes of ledger", not "every page
-- of the day, then replay from the window's start".
--
-- ---------------------------------------------------------------------------
-- WHAT A ROW IS
-- ---------------------------------------------------------------------------
-- The state of space `world_id` just before `at` (every event with
-- created_at < at), as a SIGNED-OUT spectator reconstructs it from the
-- chronicle: which bodies stand in which room, since when, and by which ledger
-- row. Nothing else — no speech, no verbs, no spans, no names.
--
--   bodies  [[actor_id, room_id, entered_at_ms, event_id], ...]
--   gone    [[actor_id, event_id, left_at_ms], ...]   bodies whose last public
--           movement was a departure, kept for the replay lookback so a
--           member's private-room overlay can tell "joined a closed room after
--           leaving" from "left after joining one".
--
-- ---------------------------------------------------------------------------
-- WHY IT CANNOT BYPASS VISIBILITY
-- ---------------------------------------------------------------------------
-- It is computed through ChronicleService as the anonymous viewer, so a private
-- space or a private room never enters a row. Names, rooms and the place gate
-- are re-resolved at read time with the shared predicate (visibility.ts), so a
-- room that closed after the row was written drops out of it. Viewers who may
-- see more get their extra movements layered on top from the normal chronicle.
--
-- Computed incrementally by the tick for completed 5-minute buckets (idempotent:
-- ON CONFLICT DO NOTHING, same input same row), backfilled for at most the last
-- day, pruned once older than the replay window.
--
-- Additive and re-runnable. Grants-not-RLS: grove_runtime receives its grants
-- through default privileges. RLS is never enabled.

CREATE TABLE IF NOT EXISTS replay_checkpoints (
  world_id    TEXT        NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL,
  bodies      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  gone        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Public movements folded in since the previous checkpoint (diagnostics).
  events      INT         NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, at)
);

CREATE INDEX IF NOT EXISTS replay_checkpoints_at ON replay_checkpoints (at);
