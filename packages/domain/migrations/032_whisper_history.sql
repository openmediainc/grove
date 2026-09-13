-- Whispers persisted (queue #30): the reader's whisper history for a room.
--
-- Whisper rows were already written to `speech` (channel 'whisper', sender_id,
-- target_id, room_id) with a `speech_deliveries` row for the recipient; nothing
-- ever read them back, so a reload emptied the log. WhisperService
-- (services/whispers.ts) now serves them to their two parties only, re-judged
-- by authorize() at read time, and prunes them after WHISPER_RETENTION_DAYS.
--
-- Two partial indexes, whisper rows only (a small slice of speech):
--   history: WHERE channel = 'whisper' AND room_id = $1 AND created_at > cutoff
--            AND (sender_id = $me OR target_id = $me)
--   prune:   WHERE channel = 'whisper' AND created_at < cutoff
-- Re-runnable. No RLS; grove_runtime gets grants via default privileges.

CREATE INDEX IF NOT EXISTS speech_whisper_room_time
  ON speech (room_id, created_at DESC)
  WHERE channel = 'whisper';

CREATE INDEX IF NOT EXISTS speech_whisper_time
  ON speech (created_at)
  WHERE channel = 'whisper';
