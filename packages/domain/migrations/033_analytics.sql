-- First-party analytics (queue #31): counts, never people.
--
-- AnalyticsService (services/analytics.ts) writes these; docs/PRIVACY.md is the
-- stance in plain words. Nothing here holds an IP, a user agent, a handle, a
-- session or an id.
--
--   analytics_daily    one counter per (UTC day, event). The only thing kept
--                      beyond the current day/week. Pruned after 90 days.
--   analytics_salts    one random salt per (scope, period): 'visitor' rotates
--                      daily, 'active' weekly. Deleted once its period is over,
--                      which is what makes old buckets unjoinable.
--   analytics_buckets  truncated HMACs under the current salt, only so a
--                      second visit (or a second action that week) is not
--                      counted twice. Deleted with their salt.
--   analytics_cohorts  week of first sign-in x week active -> count. No ids.
--
-- Re-runnable. No RLS; grove_runtime gets grants via default privileges.

CREATE TABLE IF NOT EXISTS analytics_daily (
  day     DATE   NOT NULL,
  event   TEXT   NOT NULL,
  n       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event)
);

CREATE TABLE IF NOT EXISTS analytics_salts (
  scope   TEXT  NOT NULL,
  period  DATE  NOT NULL,
  salt    BYTEA NOT NULL,
  PRIMARY KEY (scope, period)
);

CREATE TABLE IF NOT EXISTS analytics_buckets (
  scope   TEXT NOT NULL,
  period  DATE NOT NULL,
  bucket  TEXT NOT NULL,
  PRIMARY KEY (scope, period, bucket)
);

CREATE TABLE IF NOT EXISTS analytics_cohorts (
  cohort_week DATE   NOT NULL,
  active_week DATE   NOT NULL,
  n           BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (cohort_week, active_week)
);

CREATE INDEX IF NOT EXISTS analytics_cohorts_active_week ON analytics_cohorts (active_week);
