ALTER TABLE deployments
  DROP CONSTRAINT deployments_state_check;

ALTER TABLE deployments
  ADD CONSTRAINT deployments_state_check
  CHECK(state IN ('queued','cloning','building','deploying','health-checking','successful','failed','cancelled','rolled-back')),
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancelled_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX deployments_cancel_requested_idx
  ON deployments(cancel_requested_at)
  WHERE cancel_requested_at IS NOT NULL;
