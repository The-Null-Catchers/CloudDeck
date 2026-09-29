ALTER TABLE deployments
  ADD COLUMN requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN failure_code text,
  ADD COLUMN rollback_of_deployment_id uuid REFERENCES deployments(id) ON DELETE SET NULL;

CREATE INDEX deployments_application_time_idx ON deployments(application_id, created_at DESC);
CREATE INDEX deployment_events_deployment_time_idx ON deployment_events(deployment_id, created_at ASC);
