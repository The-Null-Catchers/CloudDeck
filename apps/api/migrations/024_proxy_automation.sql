ALTER TABLE domains
  ADD COLUMN proxy_status text NOT NULL DEFAULT 'unconfigured'
    CHECK(proxy_status IN ('unconfigured','applied','error')),
  ADD COLUMN proxy_error text CHECK(proxy_error IS NULL OR char_length(proxy_error)<=500),
  ADD COLUMN proxy_applied_at timestamptz;

CREATE INDEX domains_proxy_status_idx
  ON domains(proxy_status,updated_at DESC);
