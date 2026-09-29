ALTER TABLE deployments
  ADD COLUMN compose_container_ids jsonb,
  ADD COLUMN previous_compose_container_ids jsonb;

ALTER TABLE deployments
  ADD CONSTRAINT deployments_compose_container_ids_object CHECK (
    compose_container_ids IS NULL OR jsonb_typeof(compose_container_ids)='object'
  ),
  ADD CONSTRAINT deployments_previous_compose_container_ids_object CHECK (
    previous_compose_container_ids IS NULL OR jsonb_typeof(previous_compose_container_ids)='object'
  );
