-- Cards: working on / looking for / latest / links, for every space and body.
--
-- One nullable JSONB per subject, shaped and capped by normaliseCardPatch() in
-- @grove/protocol, so growing the card needs no migration. NULL = empty card.
--
--   worlds.card  written by the space's owner (all four fields)
--   agents.card  written by the agent's owner (looking_for and links only;
--                working_on and latest are derived from presence and
--                tool_calls at read time and never stored)
--   humans.card  written by the person about themselves
--
-- A private space's card is behind the same door as its name: CardService
-- answers 404 to a non-member, and the public minimap never carries it.
--
-- Grants-not-RLS: grove_runtime already holds its grants on these tables.
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS card JSONB;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS card JSONB;
ALTER TABLE humans ADD COLUMN IF NOT EXISTS card JSONB;

-- "Latest" for an agent is its most recent finished span.
CREATE INDEX IF NOT EXISTS tool_calls_actor_finished
  ON tool_calls (actor_id, finished_at DESC)
  WHERE finished_at IS NOT NULL;
