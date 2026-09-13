-- Two ways into a space, so membership no longer depends on the owner already
-- knowing your handle.
--
-- Storage decision: space invites get their OWN table rather than extending
-- `invite_codes`. invite_codes is the world signup gate — it is keyed by code
-- alone, has no world scope, no issuer, no revocation and no use count, and it
-- is redeemed by IdentityService during signup. Folding space invites into it
-- would put two unrelated lifecycles on one row and make it possible for a
-- signup code to be honoured as a space invite (or the reverse). A separate
-- table also lets the redeem path be a single guarded UPDATE that fails closed.

CREATE TABLE IF NOT EXISTS space_join_requests (
  id          TEXT PRIMARY KEY,
  world_id    TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  human_id    TEXT NOT NULL REFERENCES humans(id) ON DELETE CASCADE,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ,
  decided_by  TEXT REFERENCES humans(id)
);

ALTER TABLE space_join_requests DROP CONSTRAINT IF EXISTS space_join_requests_status_check;
ALTER TABLE space_join_requests ADD CONSTRAINT space_join_requests_status_check
  CHECK (status IN ('pending','approved','declined'));

-- At most one live ask per human per space. A decided one may be re-asked.
CREATE UNIQUE INDEX IF NOT EXISTS space_join_requests_pending
  ON space_join_requests (world_id, human_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS space_join_requests_world
  ON space_join_requests (world_id, created_at DESC);

CREATE TABLE IF NOT EXISTS space_invites (
  code        TEXT PRIMARY KEY,
  world_id    TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  created_by  TEXT NOT NULL REFERENCES humans(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  -- NULL = unlimited; 1 = single-use. The count is burned inside the same
  -- UPDATE that checks it, so two holders racing cannot both get in on one use.
  max_uses    INT,
  uses        INT NOT NULL DEFAULT 0,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS space_invites_world ON space_invites (world_id, created_at DESC);

CREATE TABLE IF NOT EXISTS space_invite_redemptions (
  code        TEXT NOT NULL REFERENCES space_invites(code) ON DELETE CASCADE,
  human_id    TEXT NOT NULL REFERENCES humans(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (code, human_id)
);
