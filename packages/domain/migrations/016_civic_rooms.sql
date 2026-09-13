-- 016 — give two civic rooms a mechanic.
--
-- Until now the six rooms differed only by name, floor colour and the Garden's
-- 3/min speech cap. `notices.pinned` was a column nobody read (it defaulted to
-- TRUE, so every notice was "pinned" and the word meant nothing), and
-- `stage_events` was a table with no consequence.
--
-- This migration gives each of them exactly one invariant the DATABASE holds,
-- rather than a service-layer convention that drifts:
--
--   notices      — at most one pinned notice per UTC day, and `pinned` can no
--                  longer disagree with the day it was pinned on.
--   stage_events — a start and an end are each announced at most once, ever.
--
-- Safe to re-run: every statement is IF NOT EXISTS, idempotent, or guarded.

-- ---------------------------------------------------------------------------
-- The Notice Board: one pin per UTC day.
-- ---------------------------------------------------------------------------

ALTER TABLE notices ADD COLUMN IF NOT EXISTS pinned_on DATE;

-- Collapse the legacy "everything is pinned" state. The EARLIEST notice of each
-- UTC day keeps the pin, which is the same first-come rule the service applies
-- from here on; every other historical notice becomes an ordinary board post.
-- It is not a deletion: the notice and its body stay exactly as they were.
UPDATE notices SET pinned = FALSE
 WHERE pinned
   AND id NOT IN (
     SELECT DISTINCT ON ((created_at AT TIME ZONE 'UTC')::date) id
       FROM notices
      WHERE pinned
      ORDER BY (created_at AT TIME ZONE 'UTC')::date, created_at, id
   );

UPDATE notices SET pinned_on = (created_at AT TIME ZONE 'UTC')::date
 WHERE pinned AND pinned_on IS NULL;

UPDATE notices SET pinned_on = NULL
 WHERE NOT pinned AND pinned_on IS NOT NULL;

-- THE invariant. A partial unique index, not a service check: two people
-- posting in the same millisecond must not both get the day, and the only
-- arbiter that can promise that is the index.
CREATE UNIQUE INDEX IF NOT EXISTS notices_one_pin_per_day
  ON notices (pinned_on) WHERE pinned_on IS NOT NULL;

-- `pinned` and `pinned_on` are two halves of one fact, so no code path may set
-- one without the other. ADD CONSTRAINT has no IF NOT EXISTS; catching the
-- duplicate is how this stays re-runnable.
DO $$
BEGIN
  ALTER TABLE notices
    ADD CONSTRAINT notices_pin_day CHECK (pinned = (pinned_on IS NOT NULL));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- The board is read newest-first and "today's pin" is looked up by date.
CREATE INDEX IF NOT EXISTS notices_created_at ON notices (created_at DESC);

-- ---------------------------------------------------------------------------
-- The Stage: an event that starts and ends exactly once.
-- ---------------------------------------------------------------------------

ALTER TABLE stage_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- There is no scheduler in Grove, so the transition is made by the first reader
-- to arrive after the clock passes. These two columns are what make that
-- exactly-once instead of once-per-reader: the announcement is an atomic
-- `UPDATE ... WHERE ... IS NULL RETURNING`, so only one caller ever wins.
ALTER TABLE stage_events ADD COLUMN IF NOT EXISTS started_announced_at TIMESTAMPTZ;
ALTER TABLE stage_events ADD COLUMN IF NOT EXISTS ended_announced_at   TIMESTAMPTZ;

-- "What is on in THIS room, next" is the query the Stage asks on every read.
CREATE INDEX IF NOT EXISTS stage_events_room_time ON stage_events (room_id, starts_at);

-- The pending-announcement sweep, which is the other one.
CREATE INDEX IF NOT EXISTS stage_events_unannounced
  ON stage_events (world_id, starts_at)
  WHERE started_announced_at IS NULL OR ended_announced_at IS NULL;
