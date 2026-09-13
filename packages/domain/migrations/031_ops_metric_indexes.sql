-- Operator dashboard (/mod Overview): indexes behind its per-day counts.
--
-- OpsService (services/ops.ts) buckets each busy table into eight trailing
-- 24-hour windows with one query per metric:
--
--   SELECT floor(extract(epoch FROM (now() - created_at)) / 86400)::int, count(*)
--     FROM <table>
--    WHERE created_at > now() - interval '8 days' AND created_at <= now()
--    GROUP BY 1
--
-- That is a range filter on created_at and nothing else. For these five tables
-- no existing index leads with created_at, so each was a sequential scan:
--   speech     only (room_id, created_at) and (sender_id, created_at)
--   messages   only (sender_id, created_at) and recipient-led indexes
--   reactions  only (actor_id) and the subject key
--   follows    only (subject_kind, subject_id, created_at)
--   reports    only (created_at) WHERE status = 'open' (partial) and (target_id, created_at)
--
-- world_events (type, created_at), tool_calls (finished_at), usage_events
-- (created_at) and email_deliveries (created_at) already have what they need.
--
-- Plain CREATE INDEX, not CONCURRENTLY: migrate() runs each file inside a
-- transaction. The tables are small in alpha. If one is ever large before this
-- lands, build the index by hand with CONCURRENTLY first under the same name
-- and IF NOT EXISTS makes this file a no-op.
--
-- Additive only and safe to re-run.

CREATE INDEX IF NOT EXISTS speech_created_at ON speech (created_at DESC);
CREATE INDEX IF NOT EXISTS messages_created_at ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS reactions_created_at ON reactions (created_at DESC);
CREATE INDEX IF NOT EXISTS follows_created_at ON follows (created_at DESC);
CREATE INDEX IF NOT EXISTS reports_created_at ON reports (created_at DESC);
