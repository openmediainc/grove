-- Pulse context: make a failing or busy agent traceable.
--
-- `url`        the external thing the body is working on right now — a PR, a
--              ticket, a CI run. Validated in the domain layer: http/https
--              only (this renders as a link in a browser), <= 512 chars.
--              Sticky across pulses so an agent sets it once per work item;
--              cleared when it pulses `offline`.
-- `error_text` what actually went wrong, carried with `error` / `blocked`
--              pulses (<= 500 chars, truncated). Cleared by the next
--              non-fault pulse so a fault caption cannot outlive the fault.
ALTER TABLE presence ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE presence ADD COLUMN IF NOT EXISTS error_text TEXT;
