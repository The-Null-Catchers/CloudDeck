ALTER TABLE users
  ADD COLUMN totp_enabled_at timestamptz;

CREATE TABLE user_totp (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL CHECK(octet_length(iv)=12),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
  key_version integer NOT NULL CHECK(key_version>0),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_recovery_codes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,code_hash)
);

CREATE INDEX user_recovery_codes_unused_idx
  ON user_recovery_codes(user_id)
  WHERE used_at IS NULL;

CREATE TABLE two_factor_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  client_type text NOT NULL CHECK(client_type IN ('web','mobile')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX two_factor_challenges_user_idx
  ON two_factor_challenges(user_id,expires_at DESC);
