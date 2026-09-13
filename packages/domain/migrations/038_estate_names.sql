-- Estates (queue #37): a chosen display name for the shared sign.
--
-- An estate is computed, never stored: adjacent non-private plots that share
-- a primary org (or, failing that, an owner) render as one joined estate with
-- one sign. See @grove/protocol estates.ts. The only thing to keep is an
-- optional name, at most 24 characters on one line (readEstateName):
--   humans.estate_name  the owner's estate, else the sign reads "@handle"
--   orgs.estate_name    the org's estate (set by the org's owner), else the org name
-- NULL = use the default. Readers re-check the value.
--
-- Privacy: the name is only ever published on an estate, and an estate is made
-- of public plots alone, so it never reaches the map for a private plot.
--
-- Additive and re-runnable. Grants-not-RLS: grove_runtime already holds its
-- grants on both tables.
ALTER TABLE humans ADD COLUMN IF NOT EXISTS estate_name TEXT;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS estate_name TEXT;
