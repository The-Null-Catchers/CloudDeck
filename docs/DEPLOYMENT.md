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
