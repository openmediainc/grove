-- The ledger finally has a reader (ChronicleService), so it needs the indexes a
-- reader implies. Until now world_events carried exactly one index beyond the
-- primary key — (type, created_at DESC) — which serves "all evictions ever" and
-- nothing else. The chronicle asks three other questions.
--
-- Safe to re-run: every statement is IF NOT EXISTS, and nothing here rewrites a
-- row or takes an exclusive lock on an existing one.
--
-- Safe against a large table, with one honest caveat: migrate() wraps each file
-- in a transaction, and CREATE INDEX CONCURRENTLY cannot run inside one. These
-- are therefore plain builds, which hold a SHARE lock (readers fine, inserts
-- wait) for the length of the build. world_events is a few hundred rows today
-- and grows by one row per world action, so the build is milliseconds. If this
-- table is ever in the millions before this migration lands, run these five
-- statements by hand with CONCURRENTLY first — the IF NOT EXISTS then makes the
-- migration a no-op rather than a second build.

-- "What happened between 02:00 and 09:00" with no type filter. The existing
-- composite index is useless without a type, so this was a full scan + sort.
CREATE INDEX IF NOT EXISTS world_events_created_at
  ON world_events (created_at DESC);

-- "Everything this actor did", the second filter the reader exposes. Ordered by
-- id so it also serves the keyset cursor without a sort.
CREATE INDEX IF NOT EXISTS world_events_actor
  ON world_events (actor_id, id DESC)
  WHERE actor_id IS NOT NULL;

-- The space gate. Every event is resolved to a world by joining `rooms` on the
-- room id buried in the payload (speech writes 'roomId', presence writes
-- 'room'), and that join drove a sequential scan with a per-row jsonb
-- extraction. This is the expression the join actually uses.
CREATE INDEX IF NOT EXISTS world_events_room
  ON world_events ((COALESCE(payload->>'roomId', payload->>'room')));

-- The speech gate joins `speech` and `speech_deliveries` on the speech id in
-- the payload, for every speech row on the page.
CREATE INDEX IF NOT EXISTS world_events_speech_id
  ON world_events ((payload->>'speechId'))
  WHERE type = 'speech';

-- ...and the other side of that gate: "was this line delivered to me?".
-- speech_deliveries is keyed (speech_id, recipient_id), so a lookup by
-- recipient had no index at all.
CREATE INDEX IF NOT EXISTS speech_deliveries_recipient
  ON speech_deliveries (recipient_id, status);
