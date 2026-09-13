-- Verb history: give the pulse a past.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- `presence` carries verb / detail / url / error_text / pulsed_at, and every
-- one of them is OVERWRITTEN IN PLACE by the next pulse. The map can therefore
-- answer "what is this agent doing right now" and nothing else. An owner
-- cannot ask "how long has it been blocked", "did it fault overnight", or
-- "how much of today did it actually spend working" — not because the data is
-- private, but because it was never kept.
--
-- This migration keeps it, and keeps it in `world_events`, not in a private
-- table of its own. That is a deliberate choice:
--
--   * world_events already has a reader with a permission model expressed in
--     SQL (ChronicleService). A side table would need a second reader, a
--     second gate and a second route — three chances to get a disclosure rule
--     wrong, when the rule is already written once and fails closed.
--   * A phase span IS a world event. "agt_x was blocked for four hours" is the
--     same class of fact as "agt_x walked into the workshop", which has lived
--     in this ledger since 001.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER
-- ---------------------------------------------------------------------------
-- The write happens in the database, not in PresenceService, for two reasons.
-- One: there is more than one writer of `presence.verb` today (the REST pulse
-- route and the MCP `pulse` tool both land in PresenceService.pulse, and the
-- observer bridge in docs/PULSE.md is a third caller), and a trigger cannot be
-- forgotten by a path added later. Two: it keeps this change out of a file
-- another worker owns.
--
-- ---------------------------------------------------------------------------
-- WHAT IT COSTS, AND THE TWO RULES THAT BOUND IT
-- ---------------------------------------------------------------------------
-- The naive version — one ledger row per pulse — is unaffordable. PULSE.md
-- tells a well-behaved observer to pulse on a FIXED 30s cycle whether or not
-- anything changed, so a single quiet agent would write ~2,880 rows a day of
-- pure repetition. Two rules bring it back to the size of a human account:
--
--   1. COALESCE BY VERB. Consecutive pulses of the same verb extend one open
--      span instead of writing rows. A four-hour block is ONE row, not 480.
--      The cost is therefore proportional to phase CHANGES, not to pulse rate.
--      (The caption follows the latest pulse, so an agent hammering `tool`
--      with a different tool name each time is one `tool` stretch labelled
--      with what it was doing last.)
--
--   2. A NOISE FLOOR OF 180 SECONDS. A stretch shorter than that is absorbed
--      into the stretch that follows it: its time is carried forward, so the
--      timeline still tiles exactly and no seconds are lost, but it gets no
--      row of its own. 180s is not a new number — it is STALL_AFTER_SECONDS,
--      the threshold Grove already uses for "long enough to mean something".
--      The cost of the floor is honest and bounded: at most 180 seconds of
--      elapsed time can end up labelled with its neighbour's verb.
--
--      Faults are NEVER absorbed. `error`, `blocked`, `offline` and any span
--      that ended in silence emit however brief they were, because "it faulted
--      twice overnight" is the whole point and must not be optimised away.
--
-- Net: a hard-working agent writes tens of rows a day, not thousands. On this
-- database world_events is 268 rows total, so there is no volume pressure now;
-- the rules exist so there is none later either.
--
-- ---------------------------------------------------------------------------
-- HONESTY ABOUT A DEAD RUNTIME
-- ---------------------------------------------------------------------------
-- An agent that claims `tool` and then dies must not be recorded as having
-- worked for the six hours until eviction noticed. A span therefore ends no
-- later than `last_pulse_at + 180s` — again the stall threshold — and when the
-- real end is past that cut the row is marked `silent`. `idle` and `offline`
-- are exempt from both, exactly as PULSE.md exempts them from stalling: an
-- agent correctly saying it is at rest is not a crashed one.
--
-- ---------------------------------------------------------------------------
-- SAFE TO RE-RUN, SAFE AGAINST ROWS
-- ---------------------------------------------------------------------------
-- Every object is IF NOT EXISTS / OR REPLACE, and the triggers are dropped
-- before they are created. Nothing here rewrites an existing row or backfills
-- history: there is no history to backfill, because until now none was kept.
-- The index build is a plain (non-CONCURRENT) build because migrate() wraps
-- each file in a transaction; it is partial and world_events is small.

-- The open span. Exactly one row per body that is currently pulsing; it is the
-- only mutable state this feature keeps, and it never outlives its presence
-- row (the DELETE trigger below closes and removes it).
CREATE TABLE IF NOT EXISTS agent_phase_open (
  actor_id      TEXT PRIMARY KEY,
  verb          TEXT NOT NULL,
  detail        TEXT,
  url           TEXT,
  error_text    TEXT,
  -- The start of the STRETCH, which may be earlier than the current verb's
  -- first pulse when sub-floor spans were absorbed into it. This is what makes
  -- the emitted timeline tile without gaps.
  started_at    TIMESTAMPTZ NOT NULL,
  last_pulse_at TIMESTAMPTZ NOT NULL
);

-- Close one span and, if it clears the floor, write it to the ledger.
-- Returns TRUE when a row was written, FALSE when the span was absorbed —
-- the caller uses that to decide whether the next stretch inherits its start.
CREATE OR REPLACE FUNCTION grove_close_phase(
  p_actor      TEXT,
  p_verb       TEXT,
  p_detail     TEXT,
  p_url        TEXT,
  p_error      TEXT,
  p_started    TIMESTAMPTZ,
  p_last_pulse TIMESTAMPTZ,
  p_raw_end    TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $fn$
DECLARE
  -- `idle` and `offline` are rest, not work: they never stall and are never
  -- cut short. Same rule as STALL_AFTER_SECONDS in presence.ts.
  v_restful  BOOLEAN     := p_verb IN ('idle', 'offline');
  v_cut      TIMESTAMPTZ := p_last_pulse + interval '180 seconds';
  v_end      TIMESTAMPTZ;
  v_silent   BOOLEAN;
  v_seconds  INT;
BEGIN
  IF p_verb IS NULL THEN RETURN TRUE; END IF;
  v_end    := CASE WHEN v_restful THEN p_raw_end ELSE LEAST(p_raw_end, v_cut) END;
  v_silent := NOT v_restful AND p_raw_end > v_cut;
  IF v_end < p_started THEN v_end := p_started; END IF;
  v_seconds := GREATEST(0, floor(extract(epoch FROM (v_end - p_started)))::int);

  -- The floor. Faults and silences are never absorbed.
  IF v_seconds < 180 AND NOT v_silent AND p_verb NOT IN ('error', 'blocked', 'offline') THEN
    RETURN FALSE;
  END IF;

  -- created_at is left to default to now() on purpose. The chronicle pages on
  -- a keyset over `id` while filtering on `created_at`, so id order and time
  -- order must not diverge; the span's OWN clock lives in the payload, and the
  -- reader renders those, not the row's insert time.
  INSERT INTO world_events (type, actor_id, payload)
  VALUES (
    'agent_phase',
    p_actor,
    jsonb_strip_nulls(jsonb_build_object(
      'verb',       p_verb,
      'detail',     p_detail,
      'url',        p_url,
      'error_text', p_error,
      'seconds',    v_seconds,
      'started_at', p_started,
      'ended_at',   v_end,
      'silent',     CASE WHEN v_silent THEN TRUE ELSE NULL END
    ))
  );
  RETURN TRUE;
END;
$fn$;

-- A pulse landed. Open, extend, or roll over the span.
CREATE OR REPLACE FUNCTION grove_presence_phase_pulse() RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  o       agent_phase_open%ROWTYPE;
  emitted BOOLEAN;
  carry   TIMESTAMPTZ;
BEGIN
  -- Only an actual pulse moves pulsed_at. A heartbeat, a seat change or a
  -- connection downgrade must not extend a stretch or invent one.
  IF NEW.verb IS NULL OR NEW.pulsed_at IS NOT DISTINCT FROM OLD.pulsed_at THEN
    RETURN NULL;
  END IF;

  SELECT * INTO o FROM agent_phase_open WHERE actor_id = NEW.actor_id FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO agent_phase_open (actor_id, verb, detail, url, error_text, started_at, last_pulse_at)
    VALUES (NEW.actor_id, NEW.verb, NEW.detail, NEW.url, NEW.error_text, NEW.pulsed_at, NEW.pulsed_at);
    RETURN NULL;
  END IF;

  IF o.verb = NEW.verb THEN
    -- Same phase. The caption follows the latest pulse; the fault text is kept
    -- if the agent stopped repeating it, because presence clears error_text on
    -- the next healthy pulse and a fault reason should outlive that here.
    UPDATE agent_phase_open SET
      detail        = NEW.detail,
      url           = NEW.url,
      error_text    = COALESCE(NEW.error_text, agent_phase_open.error_text),
      last_pulse_at = NEW.pulsed_at
    WHERE actor_id = NEW.actor_id;
    RETURN NULL;
  END IF;

  emitted := grove_close_phase(o.actor_id, o.verb, o.detail, o.url, o.error_text,
                               o.started_at, o.last_pulse_at, NEW.pulsed_at);
  -- Absorbed: the new stretch inherits the old one's start, so the timeline
  -- still tiles and the seconds are not lost, only relabelled.
  carry := CASE WHEN emitted THEN NEW.pulsed_at ELSE o.started_at END;

  UPDATE agent_phase_open SET
    verb          = NEW.verb,
    detail        = NEW.detail,
    url           = NEW.url,
    error_text    = NEW.error_text,
    started_at    = carry,
    last_pulse_at = NEW.pulsed_at
  WHERE actor_id = NEW.actor_id;
  RETURN NULL;
END;
$fn$;

-- The body left, moved room, or was evicted. Close the open span against
-- now() — the moment we learned it was gone — so a runtime that died mid-`tool`
-- is recorded as having gone silent rather than as having worked until
-- eviction happened to notice, ten minutes later.
CREATE OR REPLACE FUNCTION grove_presence_phase_leave() RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE o agent_phase_open%ROWTYPE;
BEGIN
  SELECT * INTO o FROM agent_phase_open WHERE actor_id = OLD.actor_id FOR UPDATE;
  IF FOUND THEN
    PERFORM grove_close_phase(o.actor_id, o.verb, o.detail, o.url, o.error_text,
                              o.started_at, o.last_pulse_at, GREATEST(now(), o.last_pulse_at));
    DELETE FROM agent_phase_open WHERE actor_id = OLD.actor_id;
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS presence_phase_pulse ON presence;
CREATE TRIGGER presence_phase_pulse
  AFTER UPDATE ON presence
  FOR EACH ROW
  WHEN (NEW.actor_kind = 'agent')
  EXECUTE FUNCTION grove_presence_phase_pulse();

DROP TRIGGER IF EXISTS presence_phase_leave ON presence;
CREATE TRIGGER presence_phase_leave
  AFTER DELETE ON presence
  FOR EACH ROW
  WHEN (OLD.actor_kind = 'agent')
  EXECUTE FUNCTION grove_presence_phase_leave();

-- "This agent's working day" is the query this whole feature exists for.
-- world_events_actor (actor_id, id DESC) already serves the keyset; this
-- partial index keeps the type filter from walking every row an agent ever
-- produced.
CREATE INDEX IF NOT EXISTS world_events_agent_phase
  ON world_events (actor_id, id DESC)
  WHERE type = 'agent_phase';
