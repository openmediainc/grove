-- Grove talks to Postgres through Fastify, never through the Supabase Data API.
--
-- Lock the Data API with GRANTS, not RLS. On Supabase the app connects as
-- `grove_runtime`, a grantee that does not own the tables and has no BYPASSRLS,
-- so `ENABLE ROW LEVEL SECURITY` with no policies would make every table read
-- as empty to Grove itself. Without grants, anon/authenticated are refused
-- before RLS is ever consulted.
--
-- Supabase also grants anon/authenticated on every FUTURE table via default
-- privileges, so revoke those too, or the next migration re-opens the hole.
-- Mini's local Postgres has no anon/authenticated roles, so all of this is gated.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
