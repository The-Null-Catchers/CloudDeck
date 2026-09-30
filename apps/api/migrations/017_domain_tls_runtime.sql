ALTER TABLE domains
  ADD COLUMN target_port integer CHECK(target_port BETWEEN 1 AND 65535),
  ADD COLUMN enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN https_status text NOT NULL DEFAULT 'unknown' CHECK(https_status IN ('unknown','valid','invalid','unreachable')),
  ADD COLUMN certificate_issuer text CHECK(certificate_issuer IS NULL OR char_length(certificate_issuer)<=300),
  ADD COLUMN tls_error text CHECK(tls_error IS NULL OR char_length(tls_error)<=500),
  ADD COLUMN last_tls_checked_at timestamptz,
  ADD COLUMN next_tls_check_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE alerts
  ADD COLUMN domain_id uuid REFERENCES domains(id) ON DELETE SET NULL;

CREATE INDEX domains_tls_due_idx
  ON domains(next_tls_check_at)
  WHERE enabled=true;

CREATE UNIQUE INDEX alerts_open_domain_kind_idx
  ON alerts(domain_id,kind)
  WHERE domain_id IS NOT NULL AND state IN ('open','acknowledged');
