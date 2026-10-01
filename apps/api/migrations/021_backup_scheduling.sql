ALTER TABLE backup_jobs
  ADD COLUMN next_run_at timestamptz,
  ADD COLUMN last_scheduled_at timestamptz;

ALTER TABLE backup_jobs
  DROP CONSTRAINT IF EXISTS backup_jobs_schedule_check,
  ADD CONSTRAINT backup_jobs_schedule_check CHECK(schedule IN ('manual','hourly','daily','weekly'));

UPDATE backup_jobs
SET schedule='manual',next_run_at=NULL
WHERE schedule IS NULL OR schedule NOT IN ('manual','hourly','daily','weekly');

CREATE INDEX backup_jobs_due_idx
  ON backup_jobs(next_run_at)
  WHERE enabled=true AND schedule<>'manual';
