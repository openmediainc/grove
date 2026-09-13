-- Unclaiming a space ARCHIVES it; it never deletes it.
--
-- Two reasons. `rooms` references `worlds` with no cascade, so a delete would
-- fail on the space's own rooms -- and forcing it would orphan every speech row
-- and chronicle event that happened there, rewriting history to tidy a list.
-- And a plot is allocated for life on purpose: stability is the point. Archiving
-- returns the LAND without destroying the RECORD.
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Releasing plot_index to NULL hands the plot back to the allocator. The
-- existing partial unique index already permits many NULLs, so an archived
-- space simply stops holding ground and the next claim reuses it.
CREATE INDEX IF NOT EXISTS worlds_archived ON worlds (archived_at) WHERE archived_at IS NOT NULL;
