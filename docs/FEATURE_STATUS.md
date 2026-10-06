# CloudDeck Feature Status

This document tracks the production-facing feature state of CloudDeck. A capability is marked **implemented** only when the repository contains the API/agent/UI path needed to perform it, with authorization and validation where the action is sensitive.

## Implemented

### Workspace and identity
- Email/password authentication with rotating refresh sessions.
- Optional TOTP two-factor authentication and recovery codes.
- Personal/team workspaces with RBAC.
- Workspace member listing, invitations, invitation revocation, invitation acceptance, role changes, member removal, and explicit owner-only ownership transfer.
- Global workspace search / command palette.
- Workspace audit-log explorer with filtering and redacted secret-like metadata.

### Server fleet
- Server onboarding with one-time agent pairing tokens.
- Centralized `/servers` fleet inventory.
- Online/offline/pending state and last-seen information.
- Current CPU, memory, and disk pressure in fleet views.
- Per-server detail with historical metrics.
- Go agent heartbeat, telemetry, reconnect, and protected credential storage.

### Metrics and observability
- One-minute metric buckets in PostgreSQL.
- Durable hourly rollups and retention for long-range queries.
- Workspace-wide `/metrics` explorer for 1h, 6h, 24h, 7d, and 30d ranges.
- CPU, memory, disk, load, network RX/TX, and reporting-server aggregation.
- Centralized `/logs` explorer for systemd and Docker sources.
- Bounded log snapshots and realtime log subscriptions.
- Redis-backed routing for realtime streams/terminal sessions when the browser and agent are connected to different API instances.

### Docker and Linux operations
- Workspace-wide Docker container inventory.
- Per-container inspect, stats, bounded logs, and lifecycle controls.
- Docker Compose project/service discovery and start/stop/restart controls.
- systemd service inventory and start/stop/restart controls.
- Sensitive actions are typed, validated, RBAC-protected, and audited.

### Deployments
- Application/source configuration through GitHub App installations.
- Repository/branch discovery scoped to the selected installation.
- BullMQ deployment queue and worker.
- Per-application execution leases and lease renewal.
- Agent-side deployment execution with progress and persisted logs.
- Dockerfile and Compose deployment paths.
- Cancellation and guarded deployment-state transitions.
- Activation metadata for current and previous containers.

### Availability and operations
- Health checks and alert lifecycle.
- Domain/TLS inventory and certificate monitoring.
- Email/in-app notification pipeline.
- Encrypted workspace secrets.
- Verified backups to local or S3-compatible targets.
- Recurring backup schedules and retention cleanup.
- PostgreSQL, MySQL, directory, and Docker-volume restore workflows.
- Optional constrained Caddy/Nginx proxy helper.

### Secure access
- Browser terminal using explicit terminal permission.
- One-time realtime tickets.
- PTY open/input/resize/close protocol.
- Session duration limit and audit records.
- No unrestricted generic remote-command endpoint.

### Mobile
- Flutter authentication/session foundation.
- Server monitoring and historical metrics.
- Alerts and notifications.
- Deployment status.
- Docker inventory, bounded logs, and confirmed restart actions.
- Android and iOS CI packaging.

## Remaining hardening / product work

The core platform is functional. Remaining work is mostly release hardening and depth rather than placeholder feature construction:

- End-to-end browser tests for critical operator flows.
- Broader API integration coverage for concurrency and failure modes; cross-workspace isolation coverage now protects the highest-value organization-scoped surfaces.
- Production observability for the CloudDeck control plane itself (structured metrics/traces, queue dashboards, SLOs).
- Encrypted backup payloads at rest before upload/storage, in addition to encrypted credentials and transport protections.
- Deployment rollout policies beyond the current single-target activation model (for example canary/blue-green orchestration where appropriate).
- Mobile release signing/store automation and broader feature parity with the web console.
- Additional multi-instance/load testing for agent routing, terminal routing, and concurrent deployments.
- Disaster-recovery runbooks and automated restore drills for the CloudDeck control plane database/object storage.

## Safety invariants

- CloudDeck does not expose a general-purpose arbitrary command API.
- Pairing and invitation tokens are stored only as digests where server-side persistence is required.
- Secret values are never returned by metadata/list APIs.
- Remote operational actions require workspace authorization and are audited.
- Log and terminal payloads are bounded and validated.
- Workspace-scoped APIs validate membership before returning operational data.
