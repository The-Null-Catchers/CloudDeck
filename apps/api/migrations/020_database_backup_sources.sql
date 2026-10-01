ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_kind_check;

ALTER TABLE backup_jobs
  ADD COLUMN source_secret_id uuid REFERENCES secrets(id) ON DELETE RESTRICT,
  ADD CONSTRAINT backup_jobs_kind_check CHECK(kind IN ('directory','docker_volume','postgres','mysql')),
  ADD CONSTRAINT backup_jobs_source_secret_check CHECK(
    (kind IN ('directory','docker_volume') AND source_secret_id IS NULL)
    OR
    (kind IN ('postgres','mysql') AND source_secret_id IS NOT NULL)
  );

CREATE INDEX backup_jobs_source_secret_idx
  ON backup_jobs(source_secret_id)
  WHERE source_secret_id IS NOT NULL;
