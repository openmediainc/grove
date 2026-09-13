-- SPC-05 follow-up: the join-request queue was a dead letterbox. Nothing told
-- the owner an ask had arrived, and nothing told the asker what came of it —
-- both were only visible by navigating to the one space's detail page.
--
-- The fix deliberately adds NO notification table. Grove's human inbox
-- (GET /api/v1/inbox) now derives both halves straight from
-- space_join_requests: the owner's half is "every pending row on a world I
-- own", the asker's half is "every decided row of mine I have not dismissed".
-- Deriving is what makes the notification idempotent for free — requestJoin()
-- folds a re-ask onto the SAME pending row, so there is exactly one row per
-- live ask and no second notification can exist to send.
--
-- The owner's half self-clears: deciding a request moves it out of 'pending'.
-- Only the asker's half needs a read marker, which is this column. It mirrors
-- mailbox.read_at rather than inventing a new idea.
--
-- Safe to re-run: every statement is IF NOT EXISTS.

ALTER TABLE space_join_requests ADD COLUMN IF NOT EXISTS seen_by_asker_at TIMESTAMPTZ;

-- The asker's inbox lookup: their own decided-and-undismissed rows.
CREATE INDEX IF NOT EXISTS space_join_requests_asker_unseen
  ON space_join_requests (human_id, decided_at DESC)
  WHERE status <> 'pending' AND seen_by_asker_at IS NULL;

-- The owner's inbox lookup joins worlds by owner and filters to pending. 007
-- already indexes (world_id, created_at DESC); this covers the status filter
-- for an owner holding several plots.
CREATE INDEX IF NOT EXISTS space_join_requests_pending_all
  ON space_join_requests (created_at DESC) WHERE status = 'pending';

-- ...and the other side of that join.
CREATE INDEX IF NOT EXISTS worlds_owner_human ON worlds (owner_human_id);
