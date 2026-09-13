-- Operator dashboard: the indexes its anomaly lines need.
--
-- /mod's Overview tab asks one question of each busy table: "how many rows
-- landed in each of the last eight 24-hour windows". That is a range scan on
-- created_at, and four of the tables it reads had no index that starts with
-- created_at (speech's only time index leads with room_id; messages' lead with
-- a sender or recipient; reactions and follows are keyed by who, not when).
-- Without these the dashboard is a sequential scan per metric per load.
--
-- world_events (type, created_at), tool_calls (finished_at), usage_events
-- (created_at) and email_deliveries (created_at) already have what they need.
--
-- Plain (non-CONCURRENT) builds: migrate() runs each file in a transaction.
-- These tables are small today; if one is ever in the millions before this
-- lands, run the statement by hand with CONCURRENTLY first and IF NOT EXISTS
-- turns this file into a no-op.
--
-- Additive only and safe to re-run.

CREATE INDEX IF NOT EXISTS speech_created_at ON speech (created_at DESC);
CREATE INDEX IF NOT EXISTS messages_created_at ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS reactions_created_at ON reactions (created_at DESC);
CREATE INDEX IF NOT EXISTS follows_created_at ON follows (created_at DESC);
CREATE INDEX IF NOT EXISTS reports_created_at ON reports (created_at DESC);
