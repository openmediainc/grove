-- Cinematic sequences (queue #39): a camera path over the map, shared as a link.
--
-- Most sequences ride in the link itself (`?seq=<base64url>`, @grove/protocol
-- sequences.ts). Only one too long for a link (over ~1.5 KB encoded) is stored
-- here and linked as `?seq=seq_<ulid>`.
--
--   camera_sequences   public, unlisted, immutable. There is no list route and
--                      no update route: a record is read by its id alone and
--                      never changes. `body` is the canonical, validated JSON
--                      (at most 32 KB): camera positions, shot kinds and
--                      durations, an optional one-line title, and per shot at
--                      most the slug of a body to follow. It never names a plot
--                      or a space; a follow is resolved against the public
--                      minimap when the sequence plays.
--   created_by         who saved it (for rate limits and moderation), never
--                      published. SET NULL when the person is deleted: the
--                      shared link keeps working and says nothing about them.
--
-- Additive and re-runnable. Grants-not-RLS: grove_runtime receives its grants
-- through default privileges. RLS is never enabled.

CREATE TABLE IF NOT EXISTS camera_sequences (
  id          TEXT PRIMARY KEY,
  body        JSONB NOT NULL,
  created_by  TEXT REFERENCES humans(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE camera_sequences DROP CONSTRAINT IF EXISTS camera_sequences_body_size;
ALTER TABLE camera_sequences ADD CONSTRAINT camera_sequences_body_size CHECK (octet_length(body::text) <= 40000);

CREATE INDEX IF NOT EXISTS camera_sequences_created_by_idx ON camera_sequences (created_by, created_at);
