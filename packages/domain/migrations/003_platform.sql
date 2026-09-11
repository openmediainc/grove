CREATE TABLE IF NOT EXISTS worlds (
  id              TEXT PRIMARY KEY,
  slug            CITEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  owner_human_id  TEXT REFERENCES humans(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO worlds (id, slug, name, owner_human_id)
VALUES ('aetheria-prime', 'aetheria-prime', 'Grove', NULL)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS world_id TEXT NOT NULL DEFAULT 'aetheria-prime' REFERENCES worlds(id);

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_slug_key;
DROP INDEX IF EXISTS rooms_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS rooms_world_slug ON rooms (world_id, slug);

CREATE TABLE IF NOT EXISTS world_members (
  world_id    TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  human_id    TEXT NOT NULL REFERENCES humans(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, human_id)
);

CREATE TABLE IF NOT EXISTS stage_events (
  id          TEXT PRIMARY KEY,
  world_id    TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  room_id     TEXT NOT NULL DEFAULT 'stage' REFERENCES rooms(id),
  title       TEXT NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ,
  created_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stage_events_world_time ON stage_events (world_id, starts_at DESC);

CREATE TABLE IF NOT EXISTS roles (
  id                TEXT PRIMARY KEY,
  world_id          TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  label             TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  cadence_minutes   INT NOT NULL DEFAULT 60,
  holder_agent_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
  assigned_at       TIMESTAMPTZ,
  last_briefed_at   TIMESTAMPTZ,
  UNIQUE (world_id, key)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id              TEXT PRIMARY KEY,
  owner_human_id  TEXT NOT NULL REFERENCES humans(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  secret          TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhooks_owner ON webhooks (owner_human_id);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  run_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at     TIMESTAMPTZ,
  attempts    INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (run_at) WHERE done_at IS NULL;

CREATE TABLE IF NOT EXISTS hosted_brains (
  agent_id              TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  model                 TEXT NOT NULL DEFAULT 'grok-4.6',
  token_budget_month    INT NOT NULL DEFAULT 200000,
  tokens_used_month     INT NOT NULL DEFAULT 0,
  last_tick_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_grants (
  owner_agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  counterpart_id  TEXT NOT NULL,
  speak           BOOLEAN NOT NULL DEFAULT TRUE,
  listen          BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (owner_agent_id, counterpart_id)
);
