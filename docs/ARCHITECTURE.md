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


## Domains and TLS monitoring

Domains are attached to applications and record the intended reverse-proxy type plus a validated loopback target port. The API normalizes hostnames to ASCII DNS form and stores certificate status separately from proxy configuration state.

A distributed TLS runner claims due domains with PostgreSQL `FOR UPDATE SKIP LOCKED`, advances `next_tls_check_at` before network I/O, and checks each public hostname on port 443 every six hours. DNS answers are rejected if any address is private, loopback, link-local, carrier-grade NAT, multicast, documentation, benchmark, or otherwise reserved. The TLS socket connects to the validated address while retaining the original hostname for SNI and certificate verification context.

Certificate expiry warnings use the normal alert and notification pipeline. The default warning window is 14 days and can be bounded with `SSL_EXPIRY_WARNING_DAYS`. Expiry alerts are de-duplicated per domain and resolve automatically after a later valid certificate has more than the warning window remaining.

Reverse-proxy mutation is intentionally not performed by the unprivileged agent in this stage. The production agent runs with `NoNewPrivileges=true` and a strict writable-path sandbox; Caddy/Nginx automation will use a separate constrained privileged helper instead of weakening that sandbox.


## Encrypted secret storage

Secret metadata is stored in `secrets` while encrypted values live in the separate `secret_values` table. Values use AES-256-GCM with a fresh 96-bit IV per write and a versioned key reference. The API never returns plaintext secret values; list/create/update responses expose metadata and a configured-value marker only.

The current key provider reads a 32-byte base64 master key from `CLOUDDECK_MASTER_KEY` at encryption/decryption time. This keeps the crypto boundary isolated behind `secret-crypto.ts` so a KMS/Vault provider and multi-version key rotation can replace local key material later without changing the database or public API contract. Server-side consumers must resolve values through the internal service helper rather than adding a reveal endpoint.


## Verified local backups

Backup jobs belong to an organization and target one managed server. Manual backup jobs support allowlisted directories, local Docker volumes, PostgreSQL, and MySQL with Agent-local storage. Database jobs reference encrypted workspace backup secrets instead of storing credentials on the job row. Job metadata lives in PostgreSQL, while archive contents remain on the managed server.

A run creates a durable `backups` row before dispatch. The API then issues the typed `backup.execute` action over the already-authenticated outbound Agent channel. The Agent creates a gzip/tar archive under its configured backup directory, computes SHA-256, closes and syncs the file, reopens the archive, and reads every entry for structural verification. Only a result containing `verified:true` can transition the durable row to `successful`; failures transition it to `failed` with a bounded error.

Retention never deletes only PostgreSQL metadata. Once the configured successful-backup count is exceeded, CloudDeck asks the Agent to remove the UUID-derived local archive first and deletes the corresponding row only after the constrained delete succeeds. PostgreSQL uses direct `pg_dump` plus `pg_restore --list` validation; MySQL uses direct `mysqldump`. Neither path invokes a shell. Database passwords are delivered to the Agent only for the active command and written into temporary 0600 client credential files inside the Agent staging directory, which is removed after archival. S3-compatible targets, encryption of backup payloads, durable scheduled dispatch, and restore workflows remain separate follow-up slices.


### Backup scheduling

Backup jobs may be manual, hourly, daily, or weekly. The API stores the next due timestamp and a lightweight runner atomically claims due rows with PostgreSQL `FOR UPDATE SKIP LOCKED`, advances their next due time, and then invokes the same typed verified backup execution path used by manual runs. This prevents two API replicas from claiming the same due job while keeping scheduling state durable across restarts. Scheduled runs use a null actor plus `scheduler` audit metadata; normal user-triggered runs preserve the requesting actor.
