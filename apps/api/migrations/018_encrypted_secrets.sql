DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM secrets) THEN
    RAISE EXCEPTION 'Cannot migrate legacy placeholder secrets: existing rows have no authenticated-encryption contract';
  END IF;
END $$;

ALTER TABLE secrets
  DROP CONSTRAINT IF EXISTS secrets_organization_id_fkey,
  DROP CONSTRAINT IF EXISTS secrets_name_key,
  DROP COLUMN ciphertext,
  DROP COLUMN nonce,
  DROP COLUMN key_version,
  ADD COLUMN kind text NOT NULL DEFAULT 'other' CHECK(kind IN ('environment','api_key','deployment','backup','other')),
  ADD COLUMN description text CHECK(description IS NULL OR char_length(description)<=500),
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT secrets_organization_id_fkey FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  ADD CONSTRAINT secrets_name_length_check CHECK(char_length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT secrets_organization_name_key UNIQUE(organization_id,name);

ALTER TABLE secrets ALTER COLUMN kind DROP DEFAULT;

CREATE TABLE secret_values (
  secret_id uuid PRIMARY KEY REFERENCES secrets(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL CHECK(octet_length(iv)=12),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
  key_version integer NOT NULL DEFAULT 1 CHECK(key_version>=1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX secrets_org_kind_idx ON secrets(organization_id,kind,created_at DESC);
