CREATE TABLE deployment_logs (
  id bigserial PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK(stage IN ('cloning','building','deploying','health-checking')),
  stream text NOT NULL CHECK(stream IN ('system','build','stdout','stderr')),
  line text NOT NULL CHECK(char_length(line) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deployment_logs_deployment_id_idx
  ON deployment_logs(deployment_id,id);

CREATE TABLE deployment_log_tickets (
  token_hash text PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deployment_log_tickets_expiry_idx
  ON deployment_log_tickets(expires_at);
