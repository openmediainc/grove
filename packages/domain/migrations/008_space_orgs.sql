-- SPC-03: "people can choose whether they want multiple projects/orgs reflected
-- in the same space, or if they want dedicated spaces for each org."
--
-- Both halves of that sentence are the SAME mechanism: a many-to-many between
-- org and space, plus one render mode on the space. "Multiple orgs in one
-- space" is N bindings in 'shared' mode; "a dedicated space per org" is one
-- binding in 'dedicated' mode — and the second space is just another row with
-- its own binding. Nothing forks: moving between the two is a toggle.

CREATE TABLE IF NOT EXISTS orgs (
  id              TEXT PRIMARY KEY,
  slug            CITEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  -- #rrggbb. The renderer tints a body with this; the API validates the shape.
  colour          TEXT NOT NULL DEFAULT '#9aa7ff',
  owner_human_id  TEXT NOT NULL REFERENCES humans(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orgs_owner ON orgs (owner_human_id);

-- Who belongs to an org. This is what gives a BODY its tint in 'shared' mode.
CREATE TABLE IF NOT EXISTS org_members (
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  human_id    TEXT NOT NULL REFERENCES humans(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, human_id)
);
CREATE INDEX IF NOT EXISTS org_members_human ON org_members (human_id);

-- The many-to-many. An org may live in several spaces; a space may host several
-- orgs. Deliberately carries no per-binding settings: the render mode is a
-- property of the space, so one space never renders two ways at once.
CREATE TABLE IF NOT EXISTS world_orgs (
  world_id    TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, org_id)
);
CREATE INDEX IF NOT EXISTS world_orgs_org ON world_orgs (org_id);

-- 'shared'    : every bound org is visible; a body takes its own org's colour.
-- 'dedicated' : the space reads as one org's home; every body takes that org's
--               colour, member of it or not. At most one org may be bound.
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS org_render_mode TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE worlds DROP CONSTRAINT IF EXISTS worlds_org_render_mode_check;
ALTER TABLE worlds ADD CONSTRAINT worlds_org_render_mode_check
  CHECK (org_render_mode IN ('shared','dedicated'));
