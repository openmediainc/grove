-- Self-owned agent identity: an Ed25519 public key an agent holds itself.
--
-- The bearer token model makes an agent's identity a row Grove minted and can
-- reproduce: `agent_keys.key_hash` is the argon2 hash of a secret THIS SERVER
-- generated. Nothing about it can be proven to a third party, and it does not
-- survive the platform. A public key is the opposite: the agent generates it,
-- Grove never sees the secret half, and the key is the same identity anywhere
-- it is presented.
--
-- Why this lives IN agent_keys and not in a table of its own:
--   * revocation, `last_used_at`, the owner-facing list and the owner-facing
--     revoke are already implemented here and already exposed (listKeys /
--     revokeKey). A separate table would fork all of that, and the moment the
--     owner's "revoke this credential" button covers only one of two tables it
--     is lying to them.
--   * a credential is a credential. "Which of my agent's credentials are live"
--     must be one question with one answer.
-- The cost is that key_hash goes nullable, so the shape of each kind is pinned
-- by a CHECK constraint instead of by NOT NULL.
--
-- Re-runnable: the live API may call migrate() at boot, and every statement
-- here is guarded.

ALTER TABLE agent_keys ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'bearer';
ALTER TABLE agent_keys ADD COLUMN IF NOT EXISTS public_key TEXT;
ALTER TABLE agent_keys ADD COLUMN IF NOT EXISTS algorithm TEXT;
ALTER TABLE agent_keys ADD COLUMN IF NOT EXISTS label TEXT;

-- Existing rows are all bearer tokens and keep their hash; only the new kind
-- may omit it.
ALTER TABLE agent_keys ALTER COLUMN key_hash DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_keys_kind_shape') THEN
    ALTER TABLE agent_keys ADD CONSTRAINT agent_keys_kind_shape CHECK (
      (kind = 'bearer'  AND key_hash   IS NOT NULL AND public_key IS NULL)
      OR
      (kind = 'ed25519' AND public_key IS NOT NULL AND key_hash   IS NULL AND algorithm = 'ed25519')
    );
  END IF;
END
$$;

-- A public key is a GLOBAL identity, so it may name exactly one agent. Without
-- this, two agents could claim the same key and "who signed this" would have no
-- single answer.
--
-- Deliberately NOT partial on revoked_at: a revoked key stays burnt forever. If
-- revocation freed the key for rebinding, a compromised key could simply be
-- re-registered onto an attacker's agent, which is the exact thing revocation
-- is supposed to end.
CREATE UNIQUE INDEX IF NOT EXISTS agent_keys_public_key_uniq
  ON agent_keys (public_key) WHERE public_key IS NOT NULL;

-- Bearer lookup is by prefix and now also filters on kind; keep it indexed.
CREATE INDEX IF NOT EXISTS agent_keys_prefix_live_idx
  ON agent_keys (prefix) WHERE revoked_at IS NULL;
