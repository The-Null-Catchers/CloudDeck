CREATE TABLE secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK(kind IN ('environment','api_key','deployment','backup','other')),
  description text CHECK(description IS NULL OR char_length(description)<=500),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,name)
);

CREATE TABLE secret_values (
  secret_id uuid PRIMARY KEY REFERENCES secrets(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL CHECK(octet_length(iv)=12),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
  key_version integer NOT NULL DEFAULT 1 CHECK(key_version>=1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX secrets_org_kind_idx ON secrets(organization_id,kind,created_at DESC);
