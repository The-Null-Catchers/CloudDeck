ALTER TABLE applications
  ADD COLUMN github_installation_id uuid REFERENCES github_installations(id) ON DELETE SET NULL,
  ADD COLUMN repository_full_name text,
  ADD COLUMN branch text,
  ADD COLUMN deployment_type text CHECK(deployment_type IN ('dockerfile','compose')),
  ADD COLUMN source_path text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX applications_org_time_idx ON applications(organization_id, created_at DESC);
