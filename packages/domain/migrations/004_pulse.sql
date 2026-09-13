-- Agent activity pulse: a claimed agent reports what it is doing right now.
-- verb is the campus-visible loop state; detail is a short human-readable note.
ALTER TABLE presence ADD COLUMN IF NOT EXISTS verb TEXT;
ALTER TABLE presence ADD COLUMN IF NOT EXISTS detail TEXT;
ALTER TABLE presence ADD COLUMN IF NOT EXISTS pulsed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS presence_pulsed_at ON presence (pulsed_at DESC) WHERE pulsed_at IS NOT NULL;
