-- Keep the proof, not just the verdict.
--
-- Migration 012 gave an agent a keypair it holds itself, and apps/api verifies
-- a signature on every signed request. But the signature is verified and then
-- THROWN AWAY, so every row in `world_events` is still true only on Grove's
-- say-so: Grove could fabricate an action and nobody outside Grove could tell.
-- docs/KEYPAIR.md names this gap in its own "Limits" section. This closes it.
--
-- WHAT IS STORED, AND WHAT IT IS WORTH
--
-- `agent_request_proofs` keeps the exact bytes an agent signed and the exact
-- signature it produced. Given the agent's public key, anyone can verify that
-- pair with ten lines of any language and no Grove credential, no Grove code
-- and no Grove goodwill. Grove has never held the private half, so Grove
-- cannot manufacture a row here. That is the whole point.
--
-- It is worth being blunt about the ceiling, because a verifiable record that
-- proves less than a reader assumes is worse than none. The auth signature
-- covers domain, METHOD, PATH, timestamp and nonce, and deliberately NOT the
-- request body (see docs/KEYPAIR.md — canonicalising bodies is where interop
-- bugs live, and each one is an unexplainable 401 for an honest agent). So an
-- `grove-auth-v1` proof establishes:
--     this key signed a request to this method and path at this second.
-- and NOT:
--     this key said these words.
-- The bind proofs (`grove-bind-v1`) are different in kind: their canonical
-- message contains the agent id and the public key, so they are a complete
-- proof of the action they attest. Both are kept, and both are labelled with
-- the domain they were made under so nobody has to guess which they are
-- holding. docs/EVENT-PROOFS.md states the limit in the same words.
--
-- WHY TWO TABLES RATHER THAN A COLUMN ON world_events
--
--  * "Unsigned" must be the honest default. Nearly every event is written by a
--    bearer request, a human session or an internal trigger; on live Grove
--    that is all ~270 of them. A nullable proof column would put an empty
--    field on every row of the busiest table in the schema and invite the
--    reading that NULL means "checked and unsigned" rather than "never had
--    anything to do with a signature". The absence of a row in
--    `world_event_proofs` says exactly the second thing, needs no backfill and
--    cannot be misread.
--  * A proof is ~350 bytes -- bigger than most events. Hanging it off the hot
--    table would bloat every scan the chronicle already does over it.
--  * One signed request can produce several events, or none at all (a signed
--    GET writes nothing). A request-shaped table with a link table models 0, 1
--    and N without duplicating a signature per row.
--
-- WHY THE LINK IS A SEPARATE, EXPLICIT ACT
--
-- `world_event_proofs` is written only by an explicit call naming both ids
-- (IdentityService.attestEvent, and the automatic bind link below). It is
-- never inferred from "the most recent proof by this actor", which would be a
-- guess dressed as evidence -- and a guess is precisely what this feature
-- exists to remove. An event with no row here is not attested, and says so.
--
-- Re-runnable, and safe against tables with rows: nothing here alters
-- world_events, adds no column to it and takes no lock on it beyond the FK
-- validation of an empty child table.

CREATE TABLE IF NOT EXISTS agent_request_proofs (
  id            TEXT PRIMARY KEY,
  -- CASCADE: an agent that is gone has no record to keep, and the test sweep
  -- (test/support/fixtures.ts) deletes agents without knowing this table.
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE. Which credential row was used is bookkeeping; the
  -- proof stands on the public key recorded beside it, which is the thing a
  -- verifier actually needs.
  key_id        TEXT REFERENCES agent_keys(id) ON DELETE SET NULL,
  public_key    TEXT NOT NULL,
  algorithm     TEXT NOT NULL DEFAULT 'ed25519',
  -- 'grove-auth-v1' or 'grove-bind-v1'. Stored rather than parsed out of the
  -- message, so a reader never has to split on a newline to know what kind of
  -- claim they are holding.
  domain        TEXT NOT NULL,
  -- The canonical string, verbatim. Every other column below is ALSO a line of
  -- this string, kept separately so a verifier can rebuild the message from
  -- the structured fields and check the two agree -- which is what makes a
  -- row that has been edited in the database detectable rather than merely
  -- unverifiable.
  message       TEXT NOT NULL,
  signature     TEXT NOT NULL,
  method        TEXT,
  path          TEXT,
  covered_agent_id TEXT,
  signed_at     BIGINT NOT NULL,
  nonce         TEXT NOT NULL,
  verified_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The shape of each domain, pinned the way 012 pins the shape of each key kind.
-- An auth proof has a method and a path and covers no agent id; a bind proof
-- covers an agent id (the EMPTY STRING at registration, which is a value, not a
-- gap) and has neither method nor path.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_request_proofs_domain_shape') THEN
    ALTER TABLE agent_request_proofs ADD CONSTRAINT agent_request_proofs_domain_shape CHECK (
      (domain = 'grove-auth-v1' AND method IS NOT NULL AND path IS NOT NULL AND covered_agent_id IS NULL)
      OR
      (domain = 'grove-bind-v1' AND covered_agent_id IS NOT NULL AND method IS NULL AND path IS NULL)
    );
  END IF;
END
$$;

-- A signature is single-use, and the ledger of signatures says so too.
--
-- The Redis nonce store (NONCE_TTL_SEC) already refuses a replay, but it
-- forgets after 300 seconds; this index never does. It cannot fire on an
-- honest request -- a repeat inside the window is refused before the insert,
-- and one outside it is refused by the skew check -- so what it actually
-- guards is the database itself never holding the same signature twice under
-- two different event stories.
CREATE UNIQUE INDEX IF NOT EXISTS agent_request_proofs_nonce_uniq
  ON agent_request_proofs (public_key, nonce);

CREATE INDEX IF NOT EXISTS agent_request_proofs_agent
  ON agent_request_proofs (agent_id, verified_at DESC);

-- For pruning. A proof whose request produced no event is evidence of a
-- request nobody asked about; it is safe to delete by age, and a LINKED proof
-- never is (see docs/EVENT-PROOFS.md, "Retention").
CREATE INDEX IF NOT EXISTS agent_request_proofs_verified_at
  ON agent_request_proofs (verified_at);

CREATE TABLE IF NOT EXISTS world_event_proofs (
  -- PRIMARY KEY, not just an index: "was this event authorised by a signature,
  -- and by which one" must have ONE answer, for the same reason 012 makes a
  -- public key name exactly one agent.
  event_id  BIGINT PRIMARY KEY REFERENCES world_events(id) ON DELETE CASCADE,
  proof_id  TEXT NOT NULL REFERENCES agent_request_proofs(id) ON DELETE CASCADE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS world_event_proofs_proof
  ON world_event_proofs (proof_id);
