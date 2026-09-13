-- Supporters (queue #47): an optional, cosmetic supporter tier paid through
-- Stripe Checkout. Plumbing only: nothing writes here until the owner sets
-- STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_SUPPORTER_PRICE_ID and
-- GROVE_SUPPORTER_ENABLED=1. Without them the table stays empty and inert.
--
-- SupporterService (services/supporters.ts) writes these from verified Stripe
-- webhooks only. Supporter status is cosmetic (a signboard trim, extra decor).
-- It never gates access, speech, plots or visibility: the permission kernel
-- does not read it (packages/policy/test/supporter-ignored.test.ts).
--
--   supporters  one row per person who ever started a supporter subscription.
--               last_event_at is the Stripe event `created` (epoch seconds) of
--               the newest event applied, so a replayed or out-of-order older
--               event never rolls status back.
--
-- Re-runnable. No RLS; grove_runtime gets grants via default privileges.

CREATE TABLE IF NOT EXISTS supporters (
  human_id                TEXT PRIMARY KEY REFERENCES humans(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL,
  current_period_end      TIMESTAMPTZ,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  last_event_at           BIGINT NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE supporters DROP CONSTRAINT IF EXISTS supporters_status_check;
ALTER TABLE supporters ADD CONSTRAINT supporters_status_check
  CHECK (status IN ('active', 'canceled', 'past_due'));

CREATE UNIQUE INDEX IF NOT EXISTS supporters_subscription ON supporters (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS supporters_customer ON supporters (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
