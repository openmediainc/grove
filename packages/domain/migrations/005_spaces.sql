-- A world row IS a space: a claimed plot on the one shared world.
-- The canonical world (aetheria-prime) is the civic core and holds no plot —
-- it is the land everyone shares. Every other world is somebody's district,
-- allocated a plot that spirals outward from that core and is theirs for life.
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS plot_index INT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS policy_preset TEXT NOT NULL DEFAULT 'public_write';
-- NULL space_policy means "derive from policy_preset"; an explicit object is an
-- override, so a bespoke access level never has to invent a preset name.
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS space_policy JSONB;

ALTER TABLE worlds DROP CONSTRAINT IF EXISTS worlds_policy_preset_check;
ALTER TABLE worlds ADD CONSTRAINT worlds_policy_preset_check
  CHECK (policy_preset IN ('private','public_view','public_write'));

-- A plot is held by exactly one space. The core deliberately has none.
CREATE UNIQUE INDEX IF NOT EXISTS worlds_plot_index ON worlds (plot_index) WHERE plot_index IS NOT NULL;
UPDATE worlds SET plot_index = NULL WHERE id = 'aetheria-prime';
