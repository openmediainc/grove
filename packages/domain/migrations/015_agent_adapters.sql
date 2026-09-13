-- The adapter registry: how Grove REACHES an agent.
--
-- Everything before this migration is inbound. An agent authenticates and calls
-- Grove; Grove answers. Grove holds no notion of where an agent lives, so it can
-- never ask one for anything — it can only wait to be asked. `mailbox` is the
-- closest thing that exists, and it is still a thing the agent has to come and
-- collect.
--
-- This table is the other direction, and ONLY the declaration of it. Nothing in
-- this migration or the service above it makes an outbound call, queues one, or
-- retries one. Declaring how an agent is reached and actually reaching out are
-- two pieces of work with two different threat models; this is the first.
--
-- WHY ONE ROW PER AGENT (agent_id as the primary key)
-- "How is this agent reached" must have exactly one answer, for the same reason
-- 012 made a public key name exactly one agent. A list would make a future
-- dispatcher choose between destinations, and a dispatcher that chooses will
-- eventually fan out — turning one owner-declared URL into an amplifier.
--
-- WHY config IS JSONB AND STILL NOT FREE-FORM
-- The shape differs per kind (a URL for `webhook`, an opaque id for
-- `paperclip`, nothing at all for `mailbox`), so a column per field would be
-- mostly nulls. The CHECK below pins what the DATABASE can be sure of — the
-- kind vocabulary, and that config is an object rather than a scalar or an
-- array. Everything else is pinned in IdentityService.validateAdapterConfig,
-- which rejects unknown keys outright rather than dropping them. jsonb is not a
-- licence to store what arrived; it is storage for what survived validation.
--
-- WHAT MAY NEVER BE IN HERE
-- No credential, of any kind, ever. The comparable registry on this machine
-- (Paperclip) carries bearer tokens and an Ed25519 device PRIVATE KEY in the
-- equivalent column, and that is precisely the outcome this table is shaped to
-- make impossible: the validator has no credential-bearing field to put one in,
-- and refuses the attempt by name so the owner is told rather than ignored.
-- See docs/ADAPTERS.md for how an adapter that needs Grove to authenticate
-- itself should do it instead (Grove signs; nobody shares a secret).
--
-- Re-runnable: the API may call migrate() at boot, so every statement is
-- guarded. No CREATE INDEX CONCURRENTLY — the runner wraps each file in a
-- transaction.

CREATE TABLE IF NOT EXISTS agent_adapters (
  agent_id        TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Declaring is not arming. Ships FALSE for the same reason webhooks do: an
  -- owner writing down a URL has not yet said "and start calling it".
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  -- The identity the thing at the far end must later PROVE it is.
  --
  -- An adapter on its own says only where to knock, and "where" is a claim the
  -- owner made that nobody checked. Pinning an Ed25519 key from 012 is what
  -- turns it into a claim that can be verified: the adapter says where, the key
  -- says who. Nullable because it is opt-in, and ON DELETE SET NULL because the
  -- adapter outlives any one credential. Revocation is an UPDATE rather than a
  -- DELETE, so a revoked pin survives here and has to be re-checked at the
  -- moment of use — see listDispatchableAdapters(), which joins revoked_at.
  verified_key_id TEXT REFERENCES agent_keys(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_adapters_kind') THEN
    ALTER TABLE agent_adapters ADD CONSTRAINT agent_adapters_kind
      CHECK (kind IN ('mailbox', 'webhook', 'mcp', 'paperclip'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_adapters_config_object') THEN
    -- An array and a scalar are both valid jsonb. Neither is a config.
    ALTER TABLE agent_adapters ADD CONSTRAINT agent_adapters_config_object
      CHECK (jsonb_typeof(config) = 'object');
  END IF;
END
$$;

-- The one read a future dispatcher makes: every armed adapter, nothing else.
-- Partial, so it holds only the rows that could ever be dispatched to and stays
-- small however many agents write a disabled row down.
CREATE INDEX IF NOT EXISTS agent_adapters_enabled
  ON agent_adapters (kind) WHERE enabled = TRUE;
