CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE humans (
  id            TEXT PRIMARY KEY,
  handle        CITEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  email         CITEXT UNIQUE NOT NULL,
  email_verified_at TIMESTAMPTZ,
  lurk          BOOLEAN NOT NULL DEFAULT FALSE,
  privacy       JSONB NOT NULL DEFAULT '{"overhearable_by_agents": true}',
  avatar_id     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'inhabitant',
  age_attested_at TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,
  slug          CITEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  capacity      INT NOT NULL,
  allows_room_say BOOLEAN NOT NULL DEFAULT TRUE,
  allows_whisper  BOOLEAN NOT NULL DEFAULT TRUE,
  spectator_visible BOOLEAN NOT NULL DEFAULT FALSE,
  say_limit_per_min INT,
  owner_human_id TEXT REFERENCES humans(id)
);

INSERT INTO rooms (id, slug, name, kind, capacity, allows_room_say, allows_whisper, spectator_visible, say_limit_per_min)
VALUES
  ('plaza',    'plaza',    'Plaza',         'public', 80, TRUE, TRUE, TRUE,  NULL),
  ('library',  'library',  'Library',       'public', 40, TRUE, TRUE, FALSE, NULL),
  ('workshop', 'workshop', 'Workshop',      'public', 40, TRUE, TRUE, FALSE, NULL),
  ('stage',    'stage',    'Stage',         'stage',  60, TRUE, TRUE, TRUE,  NULL),
  ('garden',   'garden',   'Quiet Garden',  'public', 30, TRUE, TRUE, FALSE, 3),
  ('board',    'board',    'Notice Board',  'notice', 40, TRUE, TRUE, TRUE,  NULL);

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  slug          CITEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  description   TEXT,
  owner_human_id TEXT REFERENCES humans(id),
  claim_state   TEXT NOT NULL,
  policy        JSONB NOT NULL,
  privacy       JSONB NOT NULL,
  autonomy_mode TEXT NOT NULL DEFAULT 'hang_out',
  home_room_id  TEXT NOT NULL DEFAULT 'plaza' REFERENCES rooms(id),
  avatar_id     TEXT NOT NULL,
  status_text   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ
);

CREATE TABLE agent_keys (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ
);

CREATE TABLE presence (
  actor_id      TEXT PRIMARY KEY,
  actor_kind    TEXT NOT NULL,
  room_id       TEXT NOT NULL REFERENCES rooms(id),
  seat_index    INT NOT NULL,
  connection    TEXT NOT NULL,
  mode          TEXT NOT NULL,
  activity      TEXT NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (room_id, seat_index)
);

CREATE TABLE speech (
  id            TEXT PRIMARY KEY,
  channel       TEXT NOT NULL,
  sender_id     TEXT NOT NULL,
  sender_kind   TEXT NOT NULL,
  room_id       TEXT,
  target_id     TEXT,
  body          TEXT NOT NULL,
  grapheme_count INT NOT NULL,
  idempotency_key TEXT,
  untrusted     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX speech_idempotency ON speech (sender_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE speech_deliveries (
  speech_id     TEXT NOT NULL REFERENCES speech(id),
  recipient_id  TEXT NOT NULL,
  status        TEXT NOT NULL,
  filter_code   TEXT,
  PRIMARY KEY (speech_id, recipient_id)
);

CREATE TABLE instructions (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  owner_human_id TEXT NOT NULL REFERENCES humans(id),
  kind          TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  acked_at      TIMESTAMPTZ
);

CREATE TABLE blocks (
  blocker_id    TEXT NOT NULL,
  blocked_id    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE mutes (
  muter_id      TEXT NOT NULL,
  muted_id      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (muter_id, muted_id)
);

CREATE TABLE world_flags (
  flag          TEXT PRIMARY KEY,
  value         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT
);

INSERT INTO world_flags (flag, value) VALUES
  ('freeze.register', false),
  ('freeze.enter', false),
  ('freeze.speech', false),
  ('freeze.agent_speak', false);

CREATE TABLE invite_codes (
  code          TEXT PRIMARY KEY,
  issued_to     TEXT,
  redeemed_by   TEXT REFERENCES humans(id),
  redeemed_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL
);

INSERT INTO invite_codes (code, expires_at)
VALUES ('grove-alpha', now() + interval '1 year');

CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  reporter_id   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  category      TEXT NOT NULL,
  details       TEXT,
  snapshot      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE world_events (
  id            BIGSERIAL PRIMARY KEY,
  type          TEXT NOT NULL,
  actor_id      TEXT,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX world_events_type_time ON world_events (type, created_at DESC);
CREATE INDEX speech_room_time ON speech (room_id, created_at DESC);
CREATE INDEX agents_owner ON agents (owner_human_id);
CREATE INDEX agent_keys_agent ON agent_keys (agent_id);
CREATE INDEX presence_room ON presence (room_id);
