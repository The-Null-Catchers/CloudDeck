ALTER TABLE deployments
  ADD COLUMN image_ref text,
  ADD COLUMN container_id text,
  ADD COLUMN previous_container_id text;

CREATE INDEX deployments_container_idx
  ON deployments(container_id)
  WHERE container_id IS NOT NULL;
