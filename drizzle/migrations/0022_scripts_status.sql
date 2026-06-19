-- Add status column to scripts table.
-- Backfills existing rows to 'active' (so they remain usable in the UI),
-- and sets the default for new rows to 'draft' (matching the create form).
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS status text;
UPDATE scripts SET status = 'active' WHERE status IS NULL;
ALTER TABLE scripts ALTER COLUMN status SET NOT NULL;
ALTER TABLE scripts ALTER COLUMN status SET DEFAULT 'draft';
