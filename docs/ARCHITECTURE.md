# Architecture

The API is the only publicly reachable service. Agents initiate outbound WebSocket connections. PostgreSQL owns identity, sessions, membership, inventory, metrics and append-only audit history. Redis is reserved for future queues and fan-out; no worker currently depends on it. The web client keeps its access token in memory and refreshes through an HttpOnly SameSite cookie.

Metric samples arrive every 15 seconds and are aggregated into one row per server per minute. The primary key `(server_id, bucket_at)` bounds row growth. A retention/downsampling worker is still required before long-term monitoring use. PostgreSQL can later migrate metric partitions to TimescaleDB without changing endpoint shapes.

All multi-tenant reads join or check organization membership before accessing server resources. Only owners/admins may create servers. Agents have per-server credentials hashed in storage; they cannot call user routes. The API can send only the two allowlisted Docker commands after RBAC and audit checks. See `AGENT_PROTOCOL.md`.

The database includes tables for planned modules so foreign key relationships and constraints are established, but those modules have no API yet. Schema existence does not imply product functionality.
