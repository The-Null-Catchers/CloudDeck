# Security model and current limits

Passwords use Argon2id. Access JWTs expire in 10 minutes. Refresh tokens are random 256-bit values, SHA-256 hashed at rest, rotated atomically and stored in HttpOnly, SameSite=Strict cookies (Secure in production). Session revocation is checked on each API request. Password reset revokes all sessions. Authentication routes have rate limits. Cross-origin mutation requests are rejected when an Origin header is present and does not match `APP_ORIGIN`.

The agent pairing token lasts 10 minutes, is stored only as a digest, and is invalidated after first use. The exchanged credential is shown once and stored by the agent in a 0600 file. Agents are outbound-only and require TLS except on loopback. The local installer uses a dedicated system account and removes the pairing token from its service configuration.

Remote operations are action-specific. There is no generic command execution endpoint. Docker container IDs and systemd service names are strictly validated; service controls call `systemctl` directly without a shell. Journal reads are capped by line count and response bytes. API RBAC and audit logging protect service mutations. Docker socket access remains opt-in and root-equivalent on typical Linux hosts, so deployments should grant it only when Docker management is needed.

RBAC: viewers can read inventory, metrics and logs; operators can perform approved server actions and open audited terminal sessions; admins can add servers/manage members; owners have full workspace authority as features are implemented.

Realtime Docker/systemd log streams use one-time tickets and are forwarded in memory without log persistence. Browser terminal sessions also use one-time tickets, a dedicated `terminal.access` permission, PTYs, a 30-minute hard timeout, and start/stop audit records. Terminal contents are not stored.

Known production blockers remain: agent credential rotation UI, TOTP, distributed agent/stream/terminal routing, richer log redaction policy, notification preferences and non-email channels, external KMS-backed secret key rotation, encrypted backup payloads, restore workflow, additional terminal isolation controls, and a completed external security assessment. Do not publish the API without TLS and a trusted reverse proxy, and never commit production credentials.


## Health-check SSRF boundary

Health checks are user-configurable network requests, so the API treats every target as untrusted.

The central probe runner:

- accepts only `http://`, `https://`, or explicit `host:port` TCP targets matching the selected check kind;
- rejects credentials and URL fragments;
- resolves DNS itself before connecting;
- rejects a hostname if any resolved address is loopback, private, link-local, carrier-grade NAT, multicast, documentation, benchmark, or otherwise reserved;
- connects to the validated resolved address rather than resolving the hostname again in the HTTP/TCP client, reducing DNS-rebinding exposure;
- keeps the original Host header and HTTPS SNI hostname for normal virtual hosting and certificate validation;
- does not automatically follow redirects;
- bounds timeout, interval, target length, and stored error length.

This means central health checks cannot intentionally reach localhost, cloud metadata endpoints such as link-local addresses, or RFC1918/ULA networks. Private infrastructure monitoring should be performed through a future typed Agent health-check action.


## Notification email boundary

Operational email is asynchronous. Alert transactions store in-app notifications and durable email-delivery records, then BullMQ workers perform SMTP I/O outside the alert transaction. Queue jobs contain only a delivery identifier rather than recipient addresses or message bodies.

Only users with a verified email address receive email-delivery rows. Notification links are restricted to single-slash internal paths before they are combined with `APP_ORIGIN`; protocol-relative or external destinations are ignored. Titles have CR/LF removed before being used as mail subjects. SMTP errors are bounded before persistence and retried without logging credentials, access tokens, or message secrets.


## Domain and TLS boundary

Domain hostnames are treated as untrusted network destinations. CloudDeck canonicalizes them with IDNA/ASCII conversion, rejects IP literals and malformed labels, resolves DNS before connecting, and refuses the probe when any returned address is private or reserved. The TLS probe connects to the validated public address on port 443 with the user hostname retained as SNI.

Certificate metadata is bounded before storage. Expiry alerts reference the domain but domain deletion preserves alert history by nulling the foreign key; active domain alerts are resolved before detach.

The agent does not receive filesystem paths, proxy snippets, or arbitrary reload commands from the API. Caddy/Nginx configuration is not written by the main agent service because it runs unprivileged with `NoNewPrivileges=true`. Future proxy automation must cross a narrow privileged-helper boundary with typed hostname/port/proxy operations and root-owned configuration templates.


## Encrypted secrets boundary

Workspace secret values are encrypted before persistence with AES-256-GCM and a fresh random IV for every write. Ciphertext, IV, authentication tag, and key version are stored separately from secret metadata. Plaintext is never included in API responses, audit metadata, or application logs, and Fastify redaction includes request `body.value`.

Only admins and owners can create, rotate, rename, or delete secrets; operators and viewers can inspect metadata but cannot retrieve values. Deletes require an explicit confirmation body and all writes are audited without recording secret contents. `CLOUDDECK_MASTER_KEY` must decode to exactly 32 bytes and must be injected from deployment secret storage. Production hardening still requires external KMS/Vault-backed key wrapping, version rotation, and key recovery procedures.


## Local backup boundary

Backup execution is not a generic archive or filesystem API. Directory jobs are accepted only when the resolved source stays within administrator-configured `CLOUDDECK_BACKUP_SOURCE_ROOTS`; symlinks and special files are rejected. Docker-volume jobs require a strict named volume, the local Docker driver, and a resolved mountpoint inside `CLOUDDECK_DOCKER_VOLUME_ROOT`.

The API never chooses an Agent destination path. Archives are stored only in `CLOUDDECK_BACKUP_DIR` using a UUID-derived filename and mode 0600. Successful status requires a full post-write archive read plus SHA-256 metadata. Retention and deletion use the separate `backup.deleteLocal` action, which accepts only the UUID-derived storage key rather than arbitrary paths.

Backup creation and deletion require `backup.manage` (admins/owners); viewers and operators receive metadata-only `backup.read`. PostgreSQL and MySQL jobs reference encrypted `backup` secrets. The API decrypts credentials only at execution time and sends a strict structured object over the authenticated Agent channel; credentials are never copied into backup job metadata or audit records. The Agent invokes fixed database dump binaries directly without a shell, puts passwords in temporary 0600 client credential files rather than command arguments, discards command stderr, and removes staging credentials after archival. PostgreSQL dumps additionally require `pg_restore --list` to succeed before archival verification. Remote S3 durability, payload encryption, scheduled execution, and restore support remain pending.

Database backup archives contain only the dump directory. Temporary PostgreSQL/MySQL credential files remain in a separate parent staging directory and are removed with staging on success or failure. Passwords containing NUL or line breaks and option-shaped database names are rejected before execution. Regression tests inspect both archive formats and failed-run cleanup.


### Scheduled backups

Recurring backup execution never creates a shell command surface. The scheduler only selects pre-validated backup jobs and reuses the same allowlisted Agent action, encrypted database-secret boundary, archive verification, retention cleanup, and audit trail as manual runs. Due jobs are claimed atomically to prevent duplicate execution across API replicas.


## S3-compatible backup boundary

S3 credentials are stored only as encrypted workspace secrets. The API validates target metadata, decrypts the target secret only for an active backup or retention operation, and sends the structured credential object over the already-authenticated Agent WebSocket. Credentials are never persisted into backup rows, manifests, audit metadata, or Agent configuration.

The Agent accepts HTTPS S3 endpoints only; plain HTTP is limited to loopback development endpoints. Endpoint credentials, paths, queries, and fragments are rejected. Uploads use AWS Signature V4 implemented over fixed HTTP PUT/HEAD/DELETE operations rather than a shell or external CLI, and redirects are disabled so signed credentials cannot be forwarded to another host.

An S3 backup is staged under the existing Agent-controlled backup directory and must pass the complete local archive verification first. The Agent then uploads the archive with its SHA-256 in object metadata and issues a signed HEAD request. CloudDeck records success only when the remote object size and SHA-256 metadata exactly match the verified local archive. The staging file is removed after either upload success or failure.

S3 retention deletion accepts only object keys ending in the UUID-derived backup filename and, when a prefix is configured, refuses keys outside that prefix. The API deletes PostgreSQL backup metadata only after the typed `backup.deleteS3` operation succeeds. Bucket-wide listing, arbitrary object reads, and arbitrary object deletion are not exposed.
