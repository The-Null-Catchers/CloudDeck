# Agent protocol v0.2

`POST /api/v1/agent/pair` accepts `{serverId, token}` exactly once during a 10-minute window. It returns `{credential}`. Only the digest is kept by the API. The agent stores the exchanged credential in a 0600 file and the installer removes the one-time pairing token from service configuration.

The agent opens `wss://<api>/api/v1/agent/connect/<serverId>` with `Authorization: Bearer <credential>`. Agents are outbound-only; CloudDeck never opens an inbound agent listener. Invalid credentials close with WebSocket code 1008. Invalid or oversized envelopes are rejected.

Telemetry from the agent:

```json
{"type":"hello","hostname":"server-01","operatingSystem":"linux","architecture":"arm64","agentVersion":"0.2.0"}
{"type":"metrics","cpuPercent":24,"memoryPercent":52,"diskPercent":61,"load1":0.8,"networkRxBytes":1234,"networkTxBytes":5678}
```

Metrics are persisted into one-minute aggregate buckets. Missing messages beyond the heartbeat threshold close the socket and the offline sweep can create an alert.

## Typed command protocol

Every API-issued command has a UUID request ID, an allowlisted action, and a validated payload. The agent does not expose a generic shell/exec action.

Current allowlist includes explicit Docker inventory, lifecycle, inspection, and bounded log actions:

- `docker.listContainers`
- `docker.startContainer`
- `docker.stopContainer`
- `docker.restartContainer`
- `docker.pauseContainer`
- `docker.unpauseContainer`
- `docker.removeContainer`
- `docker.listComposeProjects`
- `docker.startComposeService`
- `docker.stopComposeService`
- `docker.restartComposeService`
- `docker.inspectContainer`
- `docker.getContainerStats`
- `docker.tailContainerLogs`
- `systemd.listServices`
- `systemd.startService`
- `systemd.stopService`
- `systemd.restartService`
- `systemd.tailLogs`
- `backup.execute`
- `backup.deleteLocal`

Compose operations resolve containers by `com.docker.compose.project` and `com.docker.compose.service` labels and then call the Docker Engine API. They do not invoke a shell or depend on the Docker Compose CLI. Project and service names are strictly validated. Container inspection intentionally excludes environment variables and command arguments.

Examples:

```json
{"type":"command","requestId":"<uuid>","action":"docker.restartContainer","payload":{"containerId":"<12-64 hex chars>"}}
{"type":"command","requestId":"<uuid>","action":"docker.restartComposeService","payload":{"project":"clouddeck","service":"api"}}
{"type":"command","requestId":"<uuid>","action":"docker.tailContainerLogs","payload":{"containerId":"<12-64 hex chars>","limit":200}}
{"type":"command","requestId":"<uuid>","action":"systemd.restartService","payload":{"serviceName":"caddy.service"}}
{"type":"command","requestId":"<uuid>","action":"systemd.tailLogs","payload":{"serviceName":"caddy.service","limit":200}}
```

The agent returns `command.result` with either validated data or a bounded error. Service names must match a strict systemd-unit pattern and the local process invokes `systemctl`/`journalctl` with fixed argument positions; user input is never interpreted by a shell. API requests are checked against workspace RBAC and sensitive service actions are audited before and after execution.

Log tail requests are intentionally bounded to 500 lines and 256 KiB. They are snapshots, not fake realtime streams. Long-lived log streaming will use a dedicated subscription lifecycle rather than the 15-second request/response command timeout.

The in-memory connection registry currently supports a single API instance. Horizontal API scaling requires Redis-backed routing/pub-sub or a dedicated agent gateway.


## Realtime log subscriptions

Long-lived logs use a dedicated stream lifecycle and never reuse the 15-second command request/response timeout.

1. An authenticated user with `server.read` requests `POST /api/v1/servers/:serverId/logs/ticket` with a validated Docker container ID or systemd service name.
2. The API issues a random, one-time ticket valid for 30 seconds. The browser never places its access JWT in a WebSocket URL.
3. The browser connects to `/api/v1/logs/stream?ticket=<one-time-ticket>`.
4. The API consumes the ticket and sends `stream.subscribe` to the already-authenticated outbound agent connection.
5. The agent follows Docker logs through the Docker Engine API (`follow=1`) or systemd logs through `journalctl -f`, emitting bounded `stream.data` lines.
6. Closing the browser socket sends `stream.unsubscribe`; the agent cancels the stream context and terminates the underlying reader/process.

Each line is capped at 4000 characters. Docker frames larger than 64 KiB are rejected. Initial tail is capped at 500 lines. Stream data is forwarded in memory and is not persisted to PostgreSQL.

Tickets and active agent routing are currently process-local. Horizontal API scaling requires Redis-backed ticket/session routing or a dedicated gateway before multiple API replicas are enabled.


## Authorized terminal sessions

Terminal access is intentionally separate from the allowlisted command protocol. There is no `shell.exec` or arbitrary command action.

1. An authenticated operator/admin/owner requests `POST /api/v1/servers/:serverId/terminal/ticket`.
2. The API verifies `terminal.access`, returns a random one-time ticket valid for 30 seconds, and records ticket creation.
3. The browser connects to `/api/v1/terminal/connect?ticket=<one-time-ticket>`; the access JWT is not placed in the WebSocket URL.
4. The API creates a `terminal_sessions` audit record and asks the already-authenticated outbound agent to open a PTY using a dedicated `terminal.open` envelope.
5. Input, resize, output, exit, and close use `terminal.input`, `terminal.resize`, `terminal.data`, `terminal.exit`, and `terminal.close` envelopes. Terminal data is base64-framed and bounded; browser input is capped at 4096 bytes per message.
6. Sessions have a 30-minute server-side maximum lifetime. Closing the browser cancels the agent PTY and records an end reason.

Terminal contents are never persisted by CloudDeck. Audit records contain actor, server, timestamps, session ID, and close reason only. The shell is started directly through a PTY, not through the typed command dispatcher. The agent accepts an absolute local shell path via `CLOUDDECK_TERMINAL_SHELL` (default `/bin/bash`).

Terminal tickets and routing are process-local in this phase. Horizontal API scaling requires distributed session routing before multiple API replicas are enabled.


## Deployment execution

`deployment.execute` is an explicit allowlisted long-running action; it is not a generic shell command. Its payload is strictly validated and supports Dockerfile deployments only in this phase.

The Agent emits bounded `deployment.progress` envelopes for `cloning`, `building`, `deploying`, and `health-checking`. The API maps those envelopes onto the guarded deployment state machine.

Source handling is defensive: GitHub archives are pinned to the requested commit SHA, path traversal and link/device entries are rejected, extraction is bounded, and the configured Dockerfile must exist after extraction. Image build and container lifecycle operations use the Docker Engine Unix socket directly.

Replacement is rollback-aware. The current named container is stopped and renamed before activation of the replacement. If replacement activation or readiness fails, the Agent removes the new container and restores the previous one. Terminal access remains the only arbitrary-shell path and is governed by its dedicated session protocol.


### Typed deployment rollback

`deployment.rollback` restores only the container IDs recorded by a successful CloudDeck deployment. The command requires a deployment UUID, strict container name, current container ID, and preserved previous container ID. It does not accept shell text, image names, arbitrary Docker arguments, or filesystem paths.

The Agent verifies that the configured runtime name still resolves to the expected current container before making changes. The previous container is restored and readiness-checked. If restoration fails, the Agent attempts to put the current container back under the runtime name and restart it before returning an error.


### Safe Docker Compose executor

For `deployment.execute` requests with `deploymentType: "compose"`, the Agent reads the pinned Compose file with strict YAML field validation. It never invokes a shell or the Docker Compose CLI.

The current supported subset is intentionally limited to image/build services, ports, environment, restart policies, and list-form dependencies. Unsupported privileged/device/mount/network/command features are rejected before changing runtime state.

Services are dependency-sorted, images are pulled or built through the Docker Engine API, and containers receive Compose-compatible project/service labels. The project default bridge network is created through the Docker Engine API. Every service must pass running/health readiness before the deployment is considered successful. On partial failure, newly created containers are removed and previously preserved project containers are restored.


### Typed Compose rollback

`deployment.rollbackCompose` accepts only a deployment UUID, strict Compose project name, and bounded current/previous service-to-container maps. Service names and Docker IDs are validated; arbitrary Docker arguments are not accepted.

The Agent verifies the active project identity before mutation, restores all previous service containers, checks readiness per service, and attempts to recover the current project if any step fails. The API does not mark the deployment rolled back until this command completes successfully.


### Deployment log envelopes

During `deployment.execute`, the Agent may emit:

```json
{
  "type": "deployment.log",
  "deploymentId": "<uuid>",
  "stage": "building",
  "stream": "build",
  "line": "Step 4/8 : RUN npm ci"
}
```

Allowed stages are `cloning`, `building`, `deploying`, and `health-checking`. Allowed streams are `system`, `build`, `stdout`, and `stderr`. Empty lines and control characters are discarded; each line is capped at 4,000 characters before transmission.

Dockerfile and Compose builds forward bounded Docker Engine build/pull status output. After a newly created container reaches readiness, the Agent forwards a bounded tail of container runtime logs. These envelopes never include the GitHub installation token, which is used only for the source archive request.


### Targeted deployment cancellation

`deployment.cancel` accepts only a deployment UUID. The Agent maintains a process-local map from active deployment IDs to Go context cancellation functions. It does not accept PIDs, container IDs, shell commands, signals, or arbitrary process selectors.

When cancellation is requested, only the matching deployment context is cancelled. Source downloads and Docker Engine requests inherit this context. Runtime recovery paths use independent cleanup contexts so cancellation does not prevent restoration of the previously active container/project.

A cancellation command returns whether an active matching deployment execution was found. The API does not treat that acknowledgement as completion; the durable deployment state changes to `cancelled` only after the deployment worker observes the execution command stop.


## Verified backup commands

`backup.execute` is a long-running typed action with backup UUID, kind, source, target type, and optional structured database/S3 credential objects. It accepts `directory`, `docker_volume`, `postgres`, and `mysql` sources with either `local` or `s3` targets. It never accepts shell text or an arbitrary destination filesystem path from the API.

Directory sources must resolve inside one of the comma-separated absolute roots configured in `CLOUDDECK_BACKUP_SOURCE_ROOTS`. Symlinks and special files are rejected while walking the source tree. Local Docker-volume backups accept only strict volume names, require the Docker `local` driver, and require the resolved mountpoint to stay under `CLOUDDECK_DOCKER_VOLUME_ROOT` (default `/var/lib/docker/volumes`).

For PostgreSQL/MySQL sources the Agent validates host, port, username, database, and SSL mode, then calls fixed `pg_dump`/`mysqldump` binaries directly without a shell. Passwords are placed in temporary 0600 client credential files rather than command arguments. PostgreSQL custom-format dumps must additionally pass `pg_restore --list`. Database tool paths default to `/usr/bin/pg_dump`, `/usr/bin/pg_restore`, and `/usr/bin/mysqldump`; optional overrides must be absolute executable paths.

Archives are written under the Agent-controlled `CLOUDDECK_BACKUP_DIR` (default `/var/lib/clouddeck-agent/backups`) with mode 0600. The filename is derived only from the CloudDeck backup UUID. After closing and syncing the gzip/tar archive, the Agent reopens and fully reads it, rejects unsafe entry paths, and only then returns `verified:true`, SHA-256, size, and entry count. The API cannot persist a backup as `successful` without that validated result.

`backup.deleteLocal` accepts only a UUID-derived `<backup-id>.tar.gz` storage key. It is used for retention cleanup and confirmed backup-job deletion, and never accepts an arbitrary path.

For `targetType: "s3"`, the payload also contains a validated transient S3 configuration: endpoint, region, bucket, access key, secret key, optional session token, and optional object prefix. The Agent creates the archive locally first, verifies it, uploads with a signed PUT, and then performs a signed HEAD. The HEAD must return the exact archive size and the same SHA-256 stored in `x-amz-meta-clouddeck-sha256` before the command can return `verified:true`.

`backup.deleteS3` accepts only a previously persisted object key plus the structured S3 target configuration. The object key must end in the UUID-derived archive name and remain under the configured prefix. The action exposes no list/read/copy operation and does not accept arbitrary bucket changes or shell text.


### Typed database restore

`backup.restoreDatabase` accepts only a backup UUID, database kind/name, recorded target type/storage key, expected SHA-256, and the structured database/S3 credentials needed for that single restore. The API builds the payload from a successful verified backup row; the browser cannot choose a filesystem path, S3 key, target database, or command arguments.

For local targets the storage key must equal `<backup-id>.tar.gz`. For S3 targets the key must end with the same UUID-derived filename and remain inside the configured object prefix. The Agent verifies the full archive checksum before extracting only `dump/database.dump` (PostgreSQL) or `dump/database.sql` (MySQL).

PostgreSQL restores use fixed `pg_restore` arguments with clean/if-exists and exit-on-error behavior. MySQL restores use the fixed `mysql` client with the dump on stdin. Neither path invokes a shell or accepts arbitrary SQL from the API.


### Typed filesystem restore

`backup.restoreFilesystem` accepts only the persisted backup UUID, kind (`directory` or `docker_volume`), recorded source identifier, target type/storage key, expected SHA-256, and optional structured S3 credentials. It does not accept a destination path separate from the original backup job source.

For directories the Agent resolves the recorded source through the same allowlisted-root checks used by backup creation. For Docker volumes it resolves only a strict local-driver named volume and refuses restoration while any container references that volume.

The Agent verifies and extracts the archive completely before replacement. Live replacement is performed with same-parent directory renames and a preserved rollback path; if the new staging directory cannot be activated, the original directory is restored before the command returns an error.
