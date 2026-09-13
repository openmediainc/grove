-- 039. Transfer & relocate (queue #35): a space changes hands, or moves plot.
--
--   space_transfers  one offer from a space's holder to a recipient. A human
--                    recipient must already be a member; an org recipient must
--                    be bound to the space, and its owner is who accepts. At
--                    most one offer per space is pending. An offer runs out
--                    7 days after it is made (expires_at); readers treat an
--                    old 'pending' row as expired and mark it so lazily.
--                    `from_leaves` is the holder's own choice to leave the
--                    space once the offer is accepted (default: stay a member).
--
--   worlds.owner_org_id  set when a space was handed to an org: the org's owner
--                        holds it (owner_human_id) on the org's behalf. Cleared
--                        by a later hand-over to a person.
--   worlds.relocated_at  the last move. A space moves at most once per 7 days.
--
-- The move itself relies on the existing unique index worlds_plot_index (005):
-- the UPDATE runs under SELECT ... FOR UPDATE and a lost race on the target plot
-- surfaces as a unique violation, answered as "that plot was just taken".
--
-- Additive and re-runnable. No RLS; grove_runtime gets grants via default
-- privileges.

CREATE TABLE IF NOT EXISTS space_transfers (
  id             TEXT PRIMARY KEY,
  world_id       TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  from_human_id  TEXT NOT NULL REFERENCES humans(id) ON DELETE CASCADE,
  to_human_id    TEXT NOT NULL REFERENCES humans(id) ON DELETE CASCADE,
  to_org_id      TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  from_leaves    BOOLEAN NOT NULL DEFAULT FALSE,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  decided_at     TIMESTAMPTZ
);

ALTER TABLE space_transfers DROP CONSTRAINT IF EXISTS space_transfers_status_check;
ALTER TABLE space_transfers ADD CONSTRAINT space_transfers_status_check
  CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired'));

CREATE UNIQUE INDEX IF NOT EXISTS space_transfers_one_pending ON space_transfers (world_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS space_transfers_recipient ON space_transfers (to_human_id, created_at DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS space_transfers_world_time ON space_transfers (world_id, created_at DESC);

ALTER TABLE worlds ADD COLUMN IF NOT EXISTS owner_org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS relocated_at TIMESTAMPTZ;
