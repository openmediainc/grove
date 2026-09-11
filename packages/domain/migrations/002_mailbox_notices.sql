CREATE TABLE mailbox (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX mailbox_agent_unread ON mailbox (agent_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE notices (
  id           TEXT PRIMARY KEY,
  author_id    TEXT NOT NULL,
  author_kind  TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  pinned       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX notices_pinned_time ON notices (pinned DESC, created_at DESC);

ALTER TABLE humans ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
