-- Follows: a heart on a space or an agent, and the notices it earns.
--
-- follows          one row per (follower, subject). A follower is a human, or
--                  an agent following on its own key. Following a private
--                  space needs membership at the time (FollowService answers
--                  404 otherwise), and every notice is judged again by
--                  authorize() when it is written, so a follower who later
--                  loses access simply stops hearing.
--
-- follow_notices   a human follower's inbox rows. Written once, on the event
--                  (a pulse of `error`, a tool call finishing, a Stage event
--                  opening), never by a polling loop. An agent follower gets a
--                  mailbox row instead. No foreign keys: the subject may be
--                  archived or deleted, and a notice is history.
--
-- The vocabularies (subject_kind, kind) are enforced in @grove/protocol
-- (FOLLOW_SUBJECTS, FOLLOW_NOTICE_KINDS), so growing them needs no migration.
--
-- Grants-not-RLS: grove_runtime receives its grants through default privileges.
CREATE TABLE IF NOT EXISTS follows (
  follower_id   TEXT NOT NULL,
  follower_kind TEXT NOT NULL CHECK (follower_kind IN ('human', 'agent')),
  subject_kind  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, subject_kind, subject_id)
);

-- The fan-out lookup: who follows this subject.
CREATE INDEX IF NOT EXISTS follows_subject ON follows (subject_kind, subject_id, created_at);

CREATE TABLE IF NOT EXISTS follow_notices (
  id           TEXT PRIMARY KEY,
  human_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS follow_notices_human_time ON follow_notices (human_id, created_at DESC);
CREATE INDEX IF NOT EXISTS follow_notices_human_unread
  ON follow_notices (human_id, created_at DESC) WHERE read_at IS NULL;
