CREATE TABLE backup_restores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id uuid NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK(status IN ('running','successful','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text CHECK(error IS NULL OR char_length(error)<=500),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX backup_restores_one_running_per_job_idx
  ON backup_restores(job_id)
  WHERE status='running';

CREATE INDEX backup_restores_job_time_idx
  ON backup_restores(job_id,created_at DESC);
