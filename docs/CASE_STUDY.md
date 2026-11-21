# CloudDeck: engineering case study

## Problem and users
CloudDeck is a self-hosted control plane for developers and small DevOps teams managing multiple Linux servers. It consolidates telemetry, alerting, Docker and systemd inventory, deployments, logs, backups, and audited operator workflows across workspaces.

## Architecture and boundaries
- **Next.js** supplies the web operations console; **Flutter** supplies mobile monitoring and scoped actions.
- **Fastify/Node.js** handles identity, workspace authorization, APIs, WebSocket connections, orchestration, and audit records.
- **PostgreSQL** is the durable source of truth for application state, telemetry aggregates, and operational history.
- **Redis/BullMQ** supports asynchronous work and distributed routing. Redis is not the durable source of truth.
- A **Go Linux agent** maintains an outbound authenticated WebSocket to the control plane. Go offers a compact native executable and access to Linux host APIs without a Node runtime on managed hosts.

Privileged host operations are separate from the control plane. Typed actions have validated payloads; the agent does not accept arbitrary command strings. Docker socket access is opt-in and effectively root-equivalent, so it requires an explicit threat-model decision. systemd permissions must be narrowly scoped.

## Security decisions
- One-time pairing token exchange and protected agent credential storage.
- Rotating/revocable sessions, optional TOTP, workspace RBAC, and auditable sensitive actions.
- One-time browser realtime/terminal tickets and a time-limited terminal session. Terminal contents are not stored as persistent audit records.
- Secrets are encrypted and plaintext values are not exposed through metadata APIs.
- Backups use AES-256-GCM chunked authenticated encryption at rest, with key version metadata and ciphertext SHA-256. The plaintext archive is separately checksummed and validated before restore. Key rotation requires retention of old keys until dependent backups expire.

## Monitoring and realtime
Agents emit heartbeats and CPU/memory/disk/load/network telemetry. The API persists minute aggregates and hourly rollups. The control plane handles offline detection and recovery alerts. Realtime log subscriptions use bounded messages and a distinct lifecycle from short request-response commands.

## Deployment lifecycle
An authorized GitHub App installation scopes repository and branch discovery. A deployment resolves a commit, enters a persisted state machine, and is handled by a BullMQ worker with an application-scoped execution lease. The agent performs typed Dockerfile/Compose actions, reports bounded progress/logs, checks readiness, and attempts controlled rollback where supported. Retries and worker crashes must be tested for duplicate execution before production scaling.

## Backup and recovery
Allowlisted directories, local Docker volumes, and PostgreSQL/MySQL sources can be archived to local or S3-compatible storage. Archives are validated, encrypted, and accompanied by checksums and versioned key metadata. Filesystem restoration stages data before replacement, preserving a rollback path. Database restore is sensitive and must be rehearsed only against disposable databases.

## Engineering trade-offs
- **Outbound agent versus inbound SSH:** outbound TLS avoids opening management ports on every host, at the cost of WebSocket reconnection and distributed routing complexity.
- **Typed operations versus arbitrary shell:** narrower flexibility but a smaller attack surface and more precise authorization/audit behavior.
- **PostgreSQL plus Redis versus Redis-only queues/state:** durable history and recovery at the cost of maintaining two stateful services.
- **Single-target rollout versus canary orchestration:** a smaller reproducible first milestone, with rollout sophistication deferred until measurable deployment needs justify it.

## Known limitations and evidence
See [Feature status](FEATURE_STATUS.md), [Agent protocol](AGENT_PROTOCOL.md), and [Portfolio evidence](PORTFOLIO_EVIDENCE.md). CI results do not replace production-host permission testing, disaster-recovery drills, multi-instance failure injection, or mobile signing. The project is not claimed production-ready until these gates are verified.
