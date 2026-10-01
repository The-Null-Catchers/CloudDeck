ALTER TABLE backup_jobs
  ADD COLUMN target_secret_id uuid REFERENCES secrets(id) ON DELETE RESTRICT;

ALTER TABLE backup_jobs
  DROP CONSTRAINT IF EXISTS backup_jobs_target_type_check,
  ADD CONSTRAINT backup_jobs_target_type_check CHECK(target_type IN ('local','s3')),
  ADD CONSTRAINT backup_jobs_target_secret_check CHECK(
    (target_type='local' AND target_secret_id IS NULL)
    OR
    (target_type='s3' AND target_secret_id IS NOT NULL)
  );

CREATE INDEX backup_jobs_target_secret_idx
  ON backup_jobs(target_secret_id)
  WHERE target_secret_id IS NOT NULL;
