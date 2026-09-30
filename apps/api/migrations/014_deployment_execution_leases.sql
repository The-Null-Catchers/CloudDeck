CREATE TABLE deployment_execution_leases (
  application_id uuid PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  deployment_id uuid NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  lease_token uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX deployment_execution_leases_expiry_idx
  ON deployment_execution_leases(expires_at);
