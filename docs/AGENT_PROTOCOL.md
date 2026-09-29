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

Current allowlist:

- `docker.listContainers`
- `docker.restartContainer`
- `systemd.listServices`
- `systemd.startService`
- `systemd.stopService`
- `systemd.restartService`
- `systemd.tailLogs`

Examples:

```json
{"type":"command","requestId":"<uuid>","action":"docker.restartContainer","payload":{"containerId":"<12-64 hex chars>"}}
{"type":"command","requestId":"<uuid>","action":"systemd.restartService","payload":{"serviceName":"caddy.service"}}
{"type":"command","requestId":"<uuid>","action":"systemd.tailLogs","payload":{"serviceName":"caddy.service","limit":200}}
```

The agent returns `command.result` with either validated data or a bounded error. Service names must match a strict systemd-unit pattern and the local process invokes `systemctl`/`journalctl` with fixed argument positions; user input is never interpreted by a shell. API requests are checked against workspace RBAC and sensitive service actions are audited before and after execution.

Log tail requests are intentionally bounded to 500 lines and 256 KiB. They are snapshots, not fake realtime streams. Long-lived log streaming will use a dedicated subscription lifecycle rather than the 15-second request/response command timeout.

The in-memory connection registry currently supports a single API instance. Horizontal API scaling requires Redis-backed routing/pub-sub or a dedicated agent gateway.
