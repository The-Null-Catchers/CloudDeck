# Architecture

The API is the only publicly reachable service. Agents initiate outbound WebSocket connections. PostgreSQL owns identity, sessions, membership, inventory, metrics, durable notification delivery state, and append-only audit history. Redis backs BullMQ deployment execution and notification email delivery queues. The web client keeps its access token in memory and refreshes through an HttpOnly SameSite cookie.

Metric samples arrive every 15 seconds and are aggregated into one row per server per minute. The primary key `(server_id, bucket_at)` bounds row growth. A retention/downsampling worker is still required before long-term monitoring use. PostgreSQL can later migrate metric partitions to TimescaleDB without changing endpoint shapes.

All multi-tenant reads join or check organization membership before accessing server resources. Only owners/admins may create servers. Agents have per-server credentials hashed in storage; they cannot call user routes. The API sends only typed, allowlisted Docker, systemd, log, terminal-session, and deployment actions after resource authorization, validation, and audit checks. See `AGENT_PROTOCOL.md`.

Some database tables still reserve schema for later modules; schema existence alone does not imply a completed product surface.


## Health checks and alerts

CloudDeck runs external HTTP, HTTPS, and TCP health checks from the API tier. Due checks are claimed in PostgreSQL using `FOR UPDATE SKIP LOCKED`, and `next_check_at` is advanced before network I/O. This makes scheduling safe across multiple API replicas without a single in-memory scheduler owner.

Each result records latency, success, HTTP status when applicable, and a bounded error. Consecutive failures are tracked on the check. Once `failure_threshold` is reached, CloudDeck opens one health-check alert and creates notifications for workspace members. A later successful probe resolves the alert and creates recovery notifications.

The central runner is intended for public endpoints. Private-network checks should use the managed-server Agent in a later phase rather than turning the CloudDeck API into a private-network proxy.


## Notification delivery

In-app notifications are inserted in the same PostgreSQL transaction that opens or resolves an alert. Verified recipients also receive a row in the durable `notification_deliveries` outbox. A reconciler places pending delivery IDs onto the `clouddeck-notifications` BullMQ queue, and an email worker delivers them with bounded exponential retries.

The queue payload contains only the delivery ID; email addresses, titles, bodies, and links remain in PostgreSQL. Workers claim a pending row before delivery, persist attempt state, and mark terminal failures after the configured BullMQ attempts are exhausted. Stale `sending` rows are returned to `pending` after a lease-style timeout so worker crashes do not permanently strand mail.

Operational email links accept only internal CloudDeck paths and are expanded against `APP_ORIGIN`. SMTP failures do not roll back health results or alert creation. The delivery model is intentionally channel-oriented so webhook, Slack, and Telegram adapters can be added later without changing alert generation.
