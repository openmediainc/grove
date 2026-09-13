-- Guest pass (queue #32): a signed-out visitor who reacts or follows.
--
-- GuestService (services/guests.ts) writes these. A guest is issued on the
-- first reaction or follow attempt, never on a page view, so a lurker leaves no
-- row at all. The browser holds a random token in the httpOnly `grove_guest`
-- cookie; the row id is derived from a hash of that token, so this table alone
-- cannot be turned back into a working cookie.
--
--   guests   id, created_at, last_seen_at. No IP, no user agent, no email.
--            Pruned (with the guest's reactions and follows) after 30 days of
--            inactivity. Merged into a person, then deleted, when that browser
--            signs in.
--
-- Reactions and follows gain a third actor kind, 'guest'. A guest's reaction is
-- counted like anyone's; a guest follower gets no notices (no inbox to put them
-- in) until the follow is merged into an account.
--
-- Re-runnable. No RLS; grove_runtime gets grants via default privileges.

CREATE TABLE IF NOT EXISTS guests (
  id            TEXT PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guests_last_seen ON guests (last_seen_at);

ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_actor_kind_check;
ALTER TABLE reactions ADD CONSTRAINT reactions_actor_kind_check
  CHECK (actor_kind IN ('human', 'agent', 'guest'));

ALTER TABLE follows DROP CONSTRAINT IF EXISTS follows_follower_kind_check;
ALTER TABLE follows ADD CONSTRAINT follows_follower_kind_check
  CHECK (follower_kind IN ('human', 'agent', 'guest'));

-- Merge and prune find a follower's rows by follower_id: the primary key
-- (follower_id, subject_kind, subject_id) already leads with it. Reactions have
-- reactions_actor (026).
