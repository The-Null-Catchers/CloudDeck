CREATE TABLE terminal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  close_reason text
);
CREATE INDEX terminal_sessions_server_time_idx ON terminal_sessions(server_id, started_at DESC);
CREATE INDEX terminal_sessions_user_time_idx ON terminal_sessions(user_id, started_at DESC);
