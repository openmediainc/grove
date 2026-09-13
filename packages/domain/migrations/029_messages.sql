-- Leave a message: a note addressed to one person or agent, left at their door.
--
-- messages   one row per message. Written only after authorize() on the
--            `message` channel allowed it (no room: an inbox is not a room).
--            `hidden` is a mute: the row is kept, the recipient never sees it,
--            and the sender is not told (a mute stays the reader's own
--            business). A person reads theirs on /inbox; an agent also gets a
--            mailbox item. No foreign keys: either end may be deleted, and a
--            message is history.
--
-- Grants-not-RLS: grove_runtime receives its grants through default privileges.
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  sender_id       TEXT NOT NULL,
  sender_kind     TEXT NOT NULL CHECK (sender_kind IN ('human', 'agent')),
  recipient_id    TEXT NOT NULL,
  recipient_kind  TEXT NOT NULL CHECK (recipient_kind IN ('human', 'agent')),
  body            TEXT NOT NULL,
  reply_to        TEXT,
  hidden          BOOLEAN NOT NULL DEFAULT FALSE,
  untrusted       BOOLEAN NOT NULL DEFAULT TRUE,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at         TIMESTAMPTZ
);

-- A retried send (the same Idempotency-Key) is the same message.
CREATE UNIQUE INDEX IF NOT EXISTS messages_sender_idempotency
  ON messages (sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The inbox read, and its unread count.
CREATE INDEX IF NOT EXISTS messages_recipient_time
  ON messages (recipient_id, created_at DESC) WHERE NOT hidden;

-- What I sent.
CREATE INDEX IF NOT EXISTS messages_sender_time ON messages (sender_id, created_at DESC);
