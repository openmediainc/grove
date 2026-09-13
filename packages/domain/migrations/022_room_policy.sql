-- 022 — SPC-07 per-room access override + SPC-10 member ceilings.
--
-- Every column is NULLABLE and NULL means "inherit", so this is a no-op on
-- every existing row: no room changes behaviour until an owner sets one.
--
--   rooms.room_preset     the room's own NON-member access level. NULL =
--                         inherit the space (worlds.policy_preset/space_policy).
--                         A non-private value also opens THIS room's door to
--                         non-members (a public lobby on a private plot).
--   rooms.member_policy   the room's own MEMBER ceiling, four booleans in wire
--                         spelling. NULL = inherit worlds.member_policy.
--   worlds.member_policy  the space's MEMBER ceiling. NULL = members sit at
--                         the full ceiling (today's rule).
--
-- Precedence is code, not SQL: @grove/protocol resolveCeiling().
ALTER TABLE rooms  ADD COLUMN IF NOT EXISTS room_preset   TEXT;
ALTER TABLE rooms  ADD COLUMN IF NOT EXISTS member_policy JSONB;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS member_policy JSONB;

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_room_preset_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_room_preset_check
  CHECK (room_preset IS NULL OR room_preset IN ('private','public_view','public_write'));

-- A ceiling is an object of exactly the four capability booleans or nothing.
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_member_policy_shape;
ALTER TABLE rooms ADD CONSTRAINT rooms_member_policy_shape CHECK (
  member_policy IS NULL OR (
    jsonb_typeof(member_policy) = 'object'
    AND jsonb_typeof(member_policy->'speak_to_agents') = 'boolean'
    AND jsonb_typeof(member_policy->'speak_to_humans') = 'boolean'
    AND jsonb_typeof(member_policy->'listen_to_agents') = 'boolean'
    AND jsonb_typeof(member_policy->'listen_to_humans') = 'boolean'
  )
);
ALTER TABLE worlds DROP CONSTRAINT IF EXISTS worlds_member_policy_shape;
ALTER TABLE worlds ADD CONSTRAINT worlds_member_policy_shape CHECK (
  member_policy IS NULL OR (
    jsonb_typeof(member_policy) = 'object'
    AND jsonb_typeof(member_policy->'speak_to_agents') = 'boolean'
    AND jsonb_typeof(member_policy->'speak_to_humans') = 'boolean'
    AND jsonb_typeof(member_policy->'listen_to_agents') = 'boolean'
    AND jsonb_typeof(member_policy->'listen_to_humans') = 'boolean'
  )
);

-- The civic core is the commons: it never carries an override.
UPDATE rooms SET room_preset = NULL, member_policy = NULL
  WHERE world_id = 'aetheria-prime' AND (room_preset IS NOT NULL OR member_policy IS NOT NULL);

-- Directory + minimap look up the open rooms of every plot.
CREATE INDEX IF NOT EXISTS rooms_open_to_visitors
  ON rooms (world_id) WHERE room_preset IS NOT NULL AND room_preset <> 'private';
