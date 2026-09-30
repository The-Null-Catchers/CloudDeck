# Deployment

This is a development foundation, not a supported production rollout. Populate `POSTGRES_PASSWORD`, `JWT_SECRET`, `APP_ORIGIN`, and `PUBLIC_API_URL` in a local `.env` at the repository root. Run `docker compose -f infra/docker-compose.yml up -d --build`, then `docker compose -f infra/docker-compose.yml exec api npm run migrate -w @clouddeck/api`. Place a TLS reverse proxy in front of loopback ports 3000/4000, forwarding WebSocket Upgrade headers for `/api/v1/agent/connect/*`. Set `APP_ORIGIN` to the exact web origin and `PUBLIC_API_URL` to the external API origin.

The image currently includes development dependencies to run migrations, and Compose does not start a job worker. Replace local Mailpit with a real SMTP relay, and configure database backups, monitoring retention, and secret management before production. Never use a demo server as evidence of live health. Install the agent from a locally built binary using `services/agent/install.sh` as described in the README. Its dedicated service account has no Docker access by default.


## Application deployment lifecycle

CloudDeck models deployment progress as an explicit state machine. Workers must use the shared transition helper rather than writing `deployments.state` directly.

Allowed transitions:

```text
queued -> cloning -> building -> deploying -> health-checking -> successful
   \         \          \          \               \
    +---------> failed <---+----------+----------------+
successful -> rolled-back
```

Skipping phases, retrying terminal states, or mutating a failed/rolled-back deployment is rejected. Every successful transition appends a `deployment_events` record. The deployment row records start/finish timestamps and a bounded failure code when applicable.

The public API currently exposes deployment history/read endpoints only. Enqueueing and transition mutation stay internal until the BullMQ worker, GitHub source resolution, image build, agent deployment, health activation, and rollback orchestration are implemented together. This prevents queued records from pretending work is happening when no worker exists.


## GitHub App connection

CloudDeck uses a GitHub App installation flow rather than personal access tokens.

Configure:

- `GITHUB_APP_SLUG`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_OAUTH_CALLBACK_URL`
- `GITHUB_APP_PRIVATE_KEY`

Set the GitHub App **Setup URL** to `<PUBLIC_API_URL>/api/v1/github/setup` and its OAuth callback URL to the configured `GITHUB_APP_OAUTH_CALLBACK_URL`.

The connection flow is deliberately two-step. The install URL carries a random state token tied to a CloudDeck workspace/user. The setup callback records the candidate `installation_id`, then redirects through GitHub OAuth. CloudDeck exchanges the short-lived authorization code, calls `GET /user/installations`, and only links the candidate if that installation is visible to the authorizing GitHub user. The GitHub user access token is used only for that verification request and is never written to PostgreSQL or logs.

Local disconnect removes the CloudDeck link only; it does not uninstall the GitHub App from GitHub. Repository listing and installation-token generation are a separate follow-up and will use installation-scoped credentials rather than stored user tokens.


Repository and branch discovery use short-lived installation access tokens generated from a GitHub App JWT signed with `RS256`. The private key remains server-side in `GITHUB_APP_PRIVATE_KEY`; installation tokens are generated on demand, used for a single GitHub API request, and never stored. Repository listing uses `GET /installation/repositories`; branch listing uses the linked installation token against the selected repository.


## Application source configuration

Creating an application requires a workspace server, a linked GitHub App installation, a repository, a branch, a deployment type (`dockerfile` or `compose`), and a source path.

CloudDeck validates all of these before writing the application row:

1. the target server belongs to the workspace;
2. the GitHub installation link belongs to the same workspace;
3. the selected repository/branch is accessible through an installation-scoped token;
4. the configured `Dockerfile` or Compose file exists on that branch and is a file.

Source paths must be relative, contain no `.`/`..` segments, and use a conservative filename character set. Application creation is audited with repository, branch, deployment type, and the verified commit SHA. The branch remains the configured source; the deployment worker will resolve and persist the exact commit SHA again when a deployment is actually enqueued.


## Deployment request contract

`POST /api/v1/applications/:applicationId/deployments` creates a durable deployment request after re-validating the configured GitHub source.

Requirements and guarantees:

- requires `deployment.manage` for the application's workspace
- requires an `Idempotency-Key` header (8-128 URL/header-safe characters)
- resolves the configured branch through the linked GitHub App
- pins the request to the resolved 40-character commit SHA
- verifies the configured Dockerfile or Compose file at that pinned commit, not at a moving branch ref
- snapshots repository, branch, deployment type, source path, installation connection and requesting user onto the deployment
- inserts the initial `queued` event and audit record in the same PostgreSQL transaction
- duplicate requests with the same application + idempotency key return the existing deployment instead of creating another deployment

The `queued` state currently means a durable, validated request exists. A later worker change is responsible for handing queued records to BullMQ and advancing them through `cloning -> building -> deploying -> health-checking`. The API never marks a deployment successful merely because it was requested.


## Application runtime targets

A verified GitHub source is not enough to activate a deployment. CloudDeck also requires an explicit, validated runtime target so the deployment worker never guesses how repository contents should run on a server.

For Dockerfile applications, runtime configuration includes:

- a strict container name
- optional container port
- optional host port (only valid when a container port is set)
- restart policy: `no`, `always`, `unless-stopped`, or `on-failure`

For Docker Compose applications, runtime configuration includes a strict Compose project name. Compose service topology remains sourced from the verified Compose file.

Runtime targets are unique per server where collisions would be unsafe: container names, published host ports, and Compose project names. Existing applications created before this schema can be completed through `PUT /api/v1/applications/:applicationId/runtime`.

Every new deployment snapshots its runtime target together with the pinned source commit. Editing the application later therefore cannot silently mutate an already-created deployment or rollback record.


## Durable deployment dispatch

Deployment creation and Redis queue delivery are deliberately decoupled so a temporary Redis outage cannot lose a validated deployment request.

After the PostgreSQL transaction commits, the API adds a BullMQ job to `clouddeck-deployments`. The job payload contains only the deployment UUID; repository metadata, runtime configuration, credentials, and secrets stay in PostgreSQL or are minted just-in-time by later execution stages.

Queue jobs use the deployment UUID as the BullMQ job ID, making repeated dispatch idempotent while the job is retained. They use bounded exponential retries.

If Redis is unavailable when a deployment is created:

- the durable deployment remains in PostgreSQL with state `queued`
- the API returns `dispatch: "pending"` instead of claiming queue delivery succeeded
- an informational deployment event records the deferred dispatch
- the API reconciler periodically scans queued deployments and retries BullMQ insertion

When queue insertion succeeds the response reports `dispatch: "enqueued"`.

This change provides durable dispatch and recovery only. State execution remains separate from queue delivery: a deployment is never advanced to `cloning`, `building`, or `successful` merely because BullMQ accepted the job.


## Dockerfile deployment execution

BullMQ jobs are now consumed by an in-process deployment worker so the worker can reuse the authenticated outbound Agent WebSocket registry. This is intentionally a single-API-instance design; horizontal execution routing remains a future Redis/gateway concern.

For Dockerfile applications, the worker:

1. verifies the deployment is still `queued`;
2. waits/retries while the target Agent is disconnected;
3. mints a short-lived GitHub App installation token;
4. transitions to `cloning`;
5. sends one allowlisted `deployment.execute` command over the authenticated Agent WebSocket;
6. persists typed progress as `building`, `deploying`, and `health-checking`;
7. records the resulting image/container IDs;
8. marks the deployment `successful` only after the Agent reports the new container running and healthy (when Docker health metadata exists).

The GitHub installation token is ephemeral, is not written to PostgreSQL, BullMQ, deployment events, or logs, and exists only in the encrypted Agent WebSocket command payload.

The Agent downloads the pinned commit archive, rejects unsafe archive entries, applies file-count/size limits, builds through the Docker Engine API, and activates the configured runtime target. Existing containers are stopped and renamed before replacement. If create/start/readiness fails, the Agent removes the replacement and restores the previous container name/state before reporting failure. Successful deployments retain the previous container ID for the rollback workflow.

Docker Compose execution is handled by a Compose-spec-aware Agent path rather than a shell or `docker compose` CLI invocation.

### Docker Compose deployment execution

Compose applications use the same pinned GitHub source, BullMQ worker, typed progress, and Agent trust boundary as Dockerfile applications. The Agent parses the Compose YAML with strict field checking and currently supports a deliberately bounded production subset:

- `image` or string `build` context
- `ports`
- map-form `environment`
- `restart`
- list-form `depends_on`

Services are topologically ordered by dependencies. Public images are pulled through the Docker Engine API; build services are built from repository-local contexts. CloudDeck creates an isolated project default network and labels containers with standard Compose project/service metadata plus the deployment ID.

The executor rejects dependency cycles, scaled pre-existing services, unsafe build paths, and unsupported features such as bind/named volumes, custom networks, `network_mode`, `privileged`, devices, custom command/entrypoint, and map-form advanced Compose constructs. Rejection is explicit; unsupported settings are never silently ignored.

Existing project containers are stopped and renamed before replacement. If any service create/start/readiness step fails, the executor removes the partially created project and restores the previous project containers. Successful deployments persist service-to-container maps for later multi-service rollback support.


## One-click Dockerfile rollback

A successful Dockerfile deployment that replaced an existing container can be rolled back through:

`POST /api/v1/deployments/:deploymentId/rollback`

Body:

```json
{"confirm":true}
```

The endpoint requires `deployment.manage`. It rejects non-successful deployments and deployments that do not have both current and previous container IDs.

Rollback is intentionally two-phase:

1. CloudDeck records `deployment.rollback.requested` in the audit log.
2. The Agent verifies that the currently named container still matches the deployment being rolled back.
3. The current container is stopped and renamed aside.
4. The preserved previous container is restored to the configured runtime name and started.
5. The Agent waits for running/healthy readiness.
6. Only after readiness succeeds does the API transition `successful -> rolled-back`, swap persisted container metadata, and append `deployment.rollback.completed`.

If Agent-side restoration fails, the Agent attempts to restore the current container and CloudDeck records `deployment.rollback.failed`; the deployment remains `successful` because the requested rollback was not completed.


## One-click Docker Compose rollback

The existing confirmed rollback endpoint also supports successful Compose deployments when a previous project container map was preserved.

CloudDeck sends the current and previous service-to-container maps to the typed `deployment.rollbackCompose` Agent action. Before changing anything, the Agent verifies that every currently named `<project>-<service>-1` container still matches the recorded current deployment IDs and that every previous container still exists.

The Agent then stops and renames the current project aside, restores the previous service containers to their runtime names, starts them, and requires every restored service to pass running/health readiness. If restoration fails, it attempts to put the current project back before reporting failure.

Only after Agent-side success does the API transition `successful -> rolled-back` and swap the persisted Compose container maps. Request, failure, and completion are audited with deployment type and service metadata.


## GitHub push auto-deploy

Applications can opt into branch-based automatic deployment with:

`PUT /api/v1/applications/:applicationId/auto-deploy`

Body:

```json
{"enabled":true}
```

Enabling requires `deployment.manage` and a complete runtime configuration.

Configure the GitHub App webhook URL as:

`<PUBLIC_API_URL>/api/v1/webhooks/github`

and set the same strong secret in `GITHUB_WEBHOOK_SECRET`. The webhook endpoint consumes the raw JSON body and requires a valid `X-Hub-Signature-256` HMAC before parsing or performing database lookups.

For signed `push` events CloudDeck matches applications by GitHub App installation ID, repository, and exact branch. It uses the pushed `after` commit SHA directly, verifies the configured Dockerfile/Compose source path at that exact commit, and creates a deployment snapshot without resolving the moving branch head again.

Webhook delivery IDs and per-application idempotency keys make GitHub retries safe. Re-delivering the same push cannot create duplicate deployments. Non-push events, branch deletions, and unmatched branches are acknowledged without deployment. Source validation failures that indicate an invalid pushed source are audited as skipped auto-deploys; transient upstream failures are allowed to fail the webhook so GitHub can retry.

The BullMQ job still contains only the deployment UUID. GitHub credentials remain short-lived and are minted later by the deployment worker.


## Durable deployment logs

Deployment execution now emits structured log envelopes in addition to state transitions. CloudDeck persists these lines in PostgreSQL so build/runtime output remains available after page refreshes, reconnects, API restarts, or after the deployment has completed.

Each persisted line is scoped to one deployment and includes:

- deployment stage: `cloning`, `building`, `deploying`, or `health-checking`
- stream: `system`, `build`, `stdout`, or `stderr`
- bounded line content (maximum 4,000 characters)
- server timestamp

The web UI loads durable history, then requests a short-lived one-time stream ticket. Tickets are stored only as SHA-256 hashes in PostgreSQL and are atomically consumed by the WebSocket endpoint. The live stream resumes from the last numeric log ID, so reconnects do not require replaying the whole deployment.

Build output comes from Docker Engine build/pull JSON streams. Runtime output is captured from the newly started container(s) during readiness. Application stdout/stderr may contain sensitive application data, so deployment log access requires `deployment.read` within the owning workspace.

BullMQ jobs continue to contain only the deployment UUID. GitHub installation credentials are never persisted into deployment logs.


## Deployment cancellation

Queued and active deployments can be cancelled through:

`POST /api/v1/deployments/:deploymentId/cancel`

with:

```json
{"confirm":true}
```

The endpoint requires `deployment.manage`. Cancellation is durable and uses `cancel_requested_at` rather than optimistically marking an active deployment cancelled.

- If the deployment is still queued, CloudDeck removes the BullMQ job when possible and transitions `queued -> cancelled` before execution begins.
- If execution has started, CloudDeck records the cancellation request and sends the typed `deployment.cancel` action to the target Agent.
- The Agent cancels only the context registered for that deployment UUID.
- Dockerfile replacement rollback uses an independent cleanup context so cancelling the execution cannot also cancel recovery of the previous runtime.
- Compose partial-deployment recovery already uses independent cleanup operations.
- The worker transitions an interrupted deployment to `cancelled` only after the execution command has actually returned.
- If activation completed successfully before the cancellation reached the Agent, the deployment remains `successful`; CloudDeck clears the stale cancellation request and records that completion won the race.

`cancelled` is terminal. It cannot be resumed or mutated into `successful`. A new deployment request must be created for another attempt.
