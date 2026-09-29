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
