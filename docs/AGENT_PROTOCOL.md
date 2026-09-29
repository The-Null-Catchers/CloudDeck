# Agent protocol v0.1

`POST /api/v1/agent/pair` accepts `{serverId, token}` exactly once during a 10-minute window. It returns `{credential}`. Only the digest is kept by the API. The agent should store the credential in a root-owned 0600 file and delete its installation token from environment/service configuration after pairing.

Agent opens `wss://<api>/api/v1/agent/connect/<serverId>` with `Authorization: Bearer <credential>` through the reverse proxy. A connection without the right per-server credential closes with WebSocket code 1008. Messages above 8 KiB or with invalid shape are rejected.

Messages from agent:

```json
{"type":"hello","hostname":"server-01","operatingSystem":"linux","architecture":"arm64","agentVersion":"0.2.0"}
{"type":"metrics","cpuPercent":24,"memoryPercent":52,"diskPercent":61,"load1":0.8,"networkRxBytes":1234,"networkTxBytes":5678}
```

The API replies `{"type":"ack"}` after persistence. Metrics values are bounded and grouped into minute buckets. A missing message for 90 seconds closes the socket; a 30-second sweep marks the server offline after 90 seconds without a sample and creates an alert.

API → agent commands are sent only after a workspace permission check. The active command allowlist is:

```json
{"type":"command","requestId":"<uuid>","action":"docker.listContainers","payload":{}}
{"type":"command","requestId":"<uuid>","action":"docker.restartContainer","payload":{"containerId":"<12-64 hex chars>"}}
```

The agent responds with `{"type":"command.result","requestId":"<uuid>","success":true,"data":...}` or `success:false` and a bounded error. The API times out after 15 seconds, rejects unmatched results, validates response shape, and audits restart requests/outcomes. Docker access is disabled unless a local Unix socket path is configured. Agent processes never accept arbitrary shell commands or remote Docker endpoints. Terminal sessions require a separate protocol and permission. The command registry currently lives in API memory and supports one API instance; multi-instance routing requires Redis pub/sub or a dedicated gateway.
