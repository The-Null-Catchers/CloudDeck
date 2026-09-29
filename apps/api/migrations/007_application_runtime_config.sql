ALTER TABLE applications
  ADD COLUMN container_name text,
  ADD COLUMN container_port integer CHECK(container_port BETWEEN 1 AND 65535),
  ADD COLUMN host_port integer CHECK(host_port BETWEEN 1 AND 65535),
  ADD COLUMN restart_policy text CHECK(restart_policy IN ('no','always','unless-stopped','on-failure')),
  ADD COLUMN compose_project text;

ALTER TABLE deployments
  ADD COLUMN container_name text,
  ADD COLUMN container_port integer CHECK(container_port BETWEEN 1 AND 65535),
  ADD COLUMN host_port integer CHECK(host_port BETWEEN 1 AND 65535),
  ADD COLUMN restart_policy text CHECK(restart_policy IN ('no','always','unless-stopped','on-failure')),
  ADD COLUMN compose_project text;

CREATE UNIQUE INDEX applications_server_container_name_idx
  ON applications(server_id,container_name)
  WHERE container_name IS NOT NULL;

CREATE UNIQUE INDEX applications_server_host_port_idx
  ON applications(server_id,host_port)
  WHERE host_port IS NOT NULL;

CREATE UNIQUE INDEX applications_server_compose_project_idx
  ON applications(server_id,compose_project)
  WHERE compose_project IS NOT NULL;

ALTER TABLE applications
  ADD CONSTRAINT applications_runtime_shape CHECK (
    deployment_type IS NULL
    OR (deployment_type='dockerfile' AND container_name IS NOT NULL AND compose_project IS NULL)
    OR (deployment_type='compose' AND compose_project IS NOT NULL AND container_name IS NULL AND container_port IS NULL AND host_port IS NULL AND restart_policy IS NULL)
  ) NOT VALID;
