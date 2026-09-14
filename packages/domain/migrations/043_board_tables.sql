-- Turn-based boards (queue #42): a table in a room where two players, human or
-- agent, play four-in-a-row or chess turn by turn while the room watches.
--
-- ---------------------------------------------------------------------------
-- SHAPE
-- ---------------------------------------------------------------------------
--   board_tables   one table. `state` is the game (a four-in-a-row grid, or a
--                  chess FEN plus its repetition history), refereed by the pure
--                  rules in @grove/protocol boards.ts / chess.ts. Seats are
--                  actor ids (a human or an agent), no foreign key: a player who
--                  departs leaves a finished game's record intact.
--                  `status` moves waiting -> active -> ended. Every move is ONE
--                  statement guarded by `move_count`, so two moves racing for
--                  the same turn cannot both land.
--                  `turn_seat` is whose move it is (0 moves first); `turn_deadline`
--                  is when that player loses on time.
--   board_moves    the move list: seq, the seat and actor that moved, the move
--                  as sent to the referee (a column, or UCI) and as people read
--                  it (the column, or SAN).
--
-- Who may see a table is the chronicle's place gate (visibility.ts) on its
-- room; who may sit and move is the permission kernel (room_say in that room).
-- Neither rule lives in this file.
--
-- No points, no ranking: a finished game keeps a result and its moves.
--
-- Additive and re-runnable: IF NOT EXISTS throughout, CHECKs dropped before
-- they are added. Grants-not-RLS: grove_runtime receives its grants through
-- default privileges. RLS is never enabled.

CREATE TABLE IF NOT EXISTS board_tables (
  id               TEXT PRIMARY KEY,
  room_id          TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  game             TEXT NOT NULL,
  move_seconds     INT NOT NULL DEFAULT 86400,
  seat0_id         TEXT,
  seat1_id         TEXT,
  state            JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'waiting',
  move_count       INT NOT NULL DEFAULT 0,
  turn_seat        SMALLINT NOT NULL DEFAULT 0,
  turn_deadline    TIMESTAMPTZ,
  draw_offer       SMALLINT,
  winner_seat      SMALLINT,
  end_reason       TEXT,
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  created_event_id BIGINT,
  ended_event_id   BIGINT
);

ALTER TABLE board_tables DROP CONSTRAINT IF EXISTS board_tables_game_check;
ALTER TABLE board_tables ADD CONSTRAINT board_tables_game_check CHECK (game IN ('four', 'chess'));
ALTER TABLE board_tables DROP CONSTRAINT IF EXISTS board_tables_status_check;
ALTER TABLE board_tables ADD CONSTRAINT board_tables_status_check CHECK (status IN ('waiting', 'active', 'ended'));
ALTER TABLE board_tables DROP CONSTRAINT IF EXISTS board_tables_seats_check;
ALTER TABLE board_tables ADD CONSTRAINT board_tables_seats_check CHECK (seat0_id IS NULL OR seat1_id IS NULL OR seat0_id <> seat1_id);
ALTER TABLE board_tables DROP CONSTRAINT IF EXISTS board_tables_clock_check;
ALTER TABLE board_tables ADD CONSTRAINT board_tables_clock_check CHECK (move_seconds BETWEEN 60 AND 604800);
ALTER TABLE board_tables DROP CONSTRAINT IF EXISTS board_tables_seat_values_check;
ALTER TABLE board_tables ADD CONSTRAINT board_tables_seat_values_check
  CHECK (turn_seat IN (0, 1) AND (draw_offer IS NULL OR draw_offer IN (0, 1)) AND (winner_seat IS NULL OR winner_seat IN (0, 1)));

CREATE INDEX IF NOT EXISTS board_tables_room_status ON board_tables (room_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS board_tables_deadline ON board_tables (turn_deadline) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS board_tables_seat0 ON board_tables (seat0_id) WHERE status <> 'ended';
CREATE INDEX IF NOT EXISTS board_tables_seat1 ON board_tables (seat1_id) WHERE status <> 'ended';

CREATE TABLE IF NOT EXISTS board_moves (
  table_id   TEXT NOT NULL REFERENCES board_tables(id) ON DELETE CASCADE,
  seq        INT NOT NULL,
  seat       SMALLINT NOT NULL,
  actor_id   TEXT NOT NULL,
  move       TEXT NOT NULL,
  notation   TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_id   BIGINT,
  PRIMARY KEY (table_id, seq)
);
