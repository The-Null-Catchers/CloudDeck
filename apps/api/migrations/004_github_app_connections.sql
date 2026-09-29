CREATE TABLE github_connection_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK(phase IN ('install','oauth')),
  installation_id bigint,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_connection_states_expiry_idx ON github_connection_states(expires_at);

CREATE TABLE github_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id bigint NOT NULL UNIQUE,
  account_login text NOT NULL,
  account_type text NOT NULL,
  repository_selection text,
  permissions jsonb NOT NULL DEFAULT '{}',
  linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_installations_org_idx ON github_installations(organization_id, linked_at DESC);
