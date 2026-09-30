ALTER TABLE github_connection_states
  ADD COLUMN return_to text NOT NULL DEFAULT '/dashboard'
  CHECK(return_to IN ('/dashboard','/deployments','/applications/new'));
