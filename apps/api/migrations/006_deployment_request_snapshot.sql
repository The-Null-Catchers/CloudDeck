ALTER TABLE deployments
  ADD COLUMN requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN idempotency_key text,
  ADD COLUMN github_installation_id uuid REFERENCES github_installations(id) ON DELETE SET NULL,
  ADD COLUMN repository_full_name text,
  ADD COLUMN deployment_type text CHECK(deployment_type IN ('dockerfile','compose')),
  ADD COLUMN source_path text;

CREATE UNIQUE INDEX deployments_application_idempotency_idx
  ON deployments(application_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX deployments_application_created_idx
  ON deployments(application_id,created_at DESC);
