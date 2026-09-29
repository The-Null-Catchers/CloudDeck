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
