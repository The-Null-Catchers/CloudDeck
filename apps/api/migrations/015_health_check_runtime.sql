ALTER TABLE health_checks
  ADD COLUMN name text,
  ADD COLUMN enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN last_success_at timestamptz,
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0);

UPDATE health_checks
SET name=kind||' check'
WHERE name IS NULL;

ALTER TABLE health_checks
  ALTER COLUMN name SET NOT NULL;

ALTER TABLE health_check_results
  ADD COLUMN status_code integer,
  ADD COLUMN error text CHECK(error IS NULL OR char_length(error)<=500);

ALTER TABLE alerts
  ADD COLUMN health_check_id uuid REFERENCES health_checks(id) ON DELETE CASCADE,
  ADD COLUMN resolved_at timestamptz;

CREATE INDEX health_checks_due_idx
  ON health_checks(next_check_at)
  WHERE enabled=true;

CREATE UNIQUE INDEX alerts_open_health_check_idx
  ON alerts(health_check_id)
  WHERE health_check_id IS NOT NULL AND state IN ('open','acknowledged');
