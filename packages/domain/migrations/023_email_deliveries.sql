-- ONB-07: magic-link deliverability.
--
-- Login is nothing but emailed magic links, so a rejected send, a bounce or a
-- link filed as spam is a total outage that /health and /ready both report as
-- green. This table is the record that lets somebody notice.
--
-- One row per send ATTEMPT (a resend is a new row with a new token).
--
-- Three separate truths, kept in separate columns on purpose, because they are
-- routinely conflated and each one lies about the next:
--   send_status      what the provider said SYNCHRONOUSLY. `accepted` means the
--                    API took the message. It does NOT mean delivered.
--   delivery_status  what the provider said LATER (event API poll). Stays
--                    `unknown` for transports that never tell us (SMTP, stdout).
--   redeemed_at      whether a human actually clicked the link. Provider
--                    independent, and the strongest signal we have.
--
-- Privacy: the address is never stored in plain. recipient_hash is an HMAC
-- (keyed, so a dictionary of addresses cannot reverse it from a dump) used only
-- to group attempts for the same person; recipient_hint is a masked form for a
-- human operator ("p***@teqdr.com"). token_hash is sha256 of the magic token so
-- redemption can be joined back without the token ever touching the database.
CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'magic_link',
  transport TEXT NOT NULL CHECK (transport IN ('resend', 'smtp', 'stdout', 'noop')),
  recipient_hash TEXT NOT NULL,
  recipient_hint TEXT NOT NULL,
  recipient_domain TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  send_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (send_status IN ('pending', 'accepted', 'rejected', 'error', 'not_sent')),
  send_error TEXT,
  send_ms INTEGER,
  provider_message_id TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (delivery_status IN ('unknown', 'sent', 'delivered', 'delayed', 'bounced', 'complained', 'failed')),
  delivery_detail TEXT,
  delivery_event_at TIMESTAMPTZ,
  polls INTEGER NOT NULL DEFAULT 0,
  next_poll_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS email_deliveries_created ON email_deliveries (created_at DESC);
CREATE INDEX IF NOT EXISTS email_deliveries_recipient ON email_deliveries (recipient_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS email_deliveries_poll ON email_deliveries (next_poll_at)
  WHERE next_poll_at IS NOT NULL;
