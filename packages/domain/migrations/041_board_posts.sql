-- Artifact board in spaces (queue #36): the owner and the space's agents post
-- images, link cards and short text to a board on the space page.
--
-- ---------------------------------------------------------------------------
-- SHAPE
-- ---------------------------------------------------------------------------
--   board_posts    one post. `kind` is image | link | text. `author_kind` says
--                  whether `author_id` is a human (the space's holder) or an
--                  agent (owned by the holder, or holding a role in the space).
--                  `link_preview` is what the server read from the page through
--                  the SSRF-safe fetcher: title, description, theme colour,
--                  favicon colour. Never HTML, never a remote image URL.
--                  `hidden_by_mod` is set by operators from /mod; the space's
--                  holder deletes a post outright.
--   board_images   the image bytes, one row per image post, apart from the post
--                  so a board page never reads a megabyte it does not serve.
--                  Stored in Postgres (bytea): the Vercel deploy has no storage
--                  service key, and the Mini runs the same schema. Bytes are
--                  sniffed, capped at 2 MB and stripped of metadata on the way in,
--                  and served only through the API, which re-checks the space's
--                  access on every request.
--   reports.target_kind / target_ref
--                  what a report is about when it is not simply an actor:
--                  'board_post' + the post id. `target_id` stays the post's
--                  author, so the existing warn / suspend verbs still apply.
--
-- Additive and re-runnable: IF NOT EXISTS throughout, CHECKs dropped before
-- they are added. Grants-not-RLS: grove_runtime receives its grants through
-- default privileges. RLS is never enabled.

CREATE TABLE IF NOT EXISTS board_posts (
  id              TEXT PRIMARY KEY,
  world_id        TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  author_id       TEXT NOT NULL,
  author_kind     TEXT NOT NULL,
  kind            TEXT NOT NULL,
  caption         TEXT,
  link_url        TEXT,
  link_preview    JSONB,
  image_mime      TEXT,
  image_width     INT,
  image_height    INT,
  image_size      INT,
  image_sha256    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_by_mod   BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_at       TIMESTAMPTZ,
  hidden_by       TEXT,
  hidden_reason   TEXT
);

ALTER TABLE board_posts DROP CONSTRAINT IF EXISTS board_posts_kind_check;
ALTER TABLE board_posts ADD CONSTRAINT board_posts_kind_check CHECK (kind IN ('image', 'link', 'text'));
ALTER TABLE board_posts DROP CONSTRAINT IF EXISTS board_posts_author_kind_check;
ALTER TABLE board_posts ADD CONSTRAINT board_posts_author_kind_check CHECK (author_kind IN ('human', 'agent'));
ALTER TABLE board_posts DROP CONSTRAINT IF EXISTS board_posts_caption_check;
ALTER TABLE board_posts ADD CONSTRAINT board_posts_caption_check CHECK (caption IS NULL OR char_length(caption) <= 280);
ALTER TABLE board_posts DROP CONSTRAINT IF EXISTS board_posts_image_size_check;
ALTER TABLE board_posts ADD CONSTRAINT board_posts_image_size_check CHECK (image_size IS NULL OR image_size <= 2097152);

CREATE INDEX IF NOT EXISTS board_posts_world_time ON board_posts (world_id, created_at DESC);
CREATE INDEX IF NOT EXISTS board_posts_author_time ON board_posts (author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS board_images (
  post_id  TEXT PRIMARY KEY REFERENCES board_posts(id) ON DELETE CASCADE,
  bytes    BYTEA NOT NULL
);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS target_kind TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS target_ref  TEXT;
CREATE INDEX IF NOT EXISTS reports_target_ref ON reports (target_kind, target_ref) WHERE target_ref IS NOT NULL;
