DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM backup_jobs) OR EXISTS (SELECT 1 FROM backups) THEN
    RAISE EXCEPTION 'Cannot migrate legacy placeholder backup rows: safe source/target semantics were not recorded';
  END IF;
END $$;

ALTER TABLE backup_jobs
  ADD COLUMN name text,
  ADD COLUMN source text,
  ADD COLUMN target_type text NOT NULL DEFAULT 'local',
  ADD COLUMN enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE backup_jobs
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN source SET NOT NULL,
  ADD CONSTRAINT backup_jobs_name_length CHECK(char_length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT backup_jobs_kind_check CHECK(kind IN ('directory','docker_volume')),
  ADD CONSTRAINT backup_jobs_target_type_check CHECK(target_type IN ('local'));

ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_organization_id_fkey;
ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_server_id_fkey;
ALTER TABLE backup_jobs
  ADD CONSTRAINT backup_jobs_organization_id_fkey FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  ADD CONSTRAINT backup_jobs_server_id_fkey FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE;

ALTER TABLE backups
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN storage_key text,
  ADD COLUMN sha256 text,
  ADD COLUMN error text CHECK(error IS NULL OR char_length(error)<=500),
  ADD COLUMN manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN triggered_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE backups DROP CONSTRAINT IF EXISTS backups_job_id_fkey;
ALTER TABLE backups
  ADD CONSTRAINT backups_job_id_fkey FOREIGN KEY(job_id) REFERENCES backup_jobs(id) ON DELETE CASCADE,
  ADD CONSTRAINT backups_sha256_check CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT backups_storage_key_check CHECK(storage_key IS NULL OR char_length(storage_key)<=500);

CREATE INDEX backup_jobs_org_idx ON backup_jobs(organization_id,created_at DESC);
CREATE INDEX backups_job_time_idx ON backups(job_id,created_at DESC);
