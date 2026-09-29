ALTER TABLE applications
  ADD COLUMN auto_deploy boolean NOT NULL DEFAULT false;

CREATE TABLE github_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event_name text NOT NULL,
  installation_id bigint,
  repository_full_name text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX github_webhook_deliveries_received_idx
  ON github_webhook_deliveries(received_at DESC);
