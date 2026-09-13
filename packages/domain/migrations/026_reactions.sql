-- Reactions: a small emoji set on a spoken line or a chronicle event.
--
-- One row per (target, actor, emoji). Toggling off deletes the row, so a count
-- is COUNT(*) and nothing else. The vocabulary is enforced in the app
-- (REACTION_KEYS in @grove/protocol), not here, so growing it needs no
-- migration. Who reacted is never published: readers get counts and their own.
--
-- target_kind 'speech' -> speech.id (a room line), 'event' -> world_events.id.
-- No foreign keys: world_events is append-only and speech rows are swept by
-- moderation; a dangling reaction is simply never read, because every read
-- starts from a target the viewer can already see.
--
-- Grants-not-RLS: grove_runtime receives its grants through default privileges.
CREATE TABLE IF NOT EXISTS reactions (
  target_kind TEXT NOT NULL CHECK (target_kind IN ('speech', 'event')),
  target_id   TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent')),
  emoji       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_kind, target_id, actor_id, emoji)
);

CREATE INDEX IF NOT EXISTS reactions_actor ON reactions (actor_id);
