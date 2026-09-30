# Security model and current limits

Passwords use Argon2id. Access JWTs expire in 10 minutes. Refresh tokens are random 256-bit values, SHA-256 hashed at rest, rotated atomically and stored in HttpOnly, SameSite=Strict cookies (Secure in production). Session revocation is checked on each API request. Password reset revokes all sessions. Authentication routes have rate limits. Cross-origin mutation requests are rejected when an Origin header is present and does not match `APP_ORIGIN`.

The agent pairing token lasts 10 minutes, is stored only as a digest, and is invalidated after first use. The exchanged credential is shown once and stored by the agent in a 0600 file. Agents are outbound-only and require TLS except on loopback. The local installer uses a dedicated system account and removes the pairing token from its service configuration.

Remote operations are action-specific. There is no generic command execution endpoint. Docker container IDs and systemd service names are strictly validated; service controls call `systemctl` directly without a shell. Journal reads are capped by line count and response bytes. API RBAC and audit logging protect service mutations. Docker socket access remains opt-in and root-equivalent on typical Linux hosts, so deployments should grant it only when Docker management is needed.

RBAC: viewers can read inventory, metrics and logs; operators can perform approved server actions and open audited terminal sessions; admins can add servers/manage members; owners have full workspace authority as features are implemented.

Realtime Docker/systemd log streams use one-time tickets and are forwarded in memory without log persistence. Browser terminal sessions also use one-time tickets, a dedicated `terminal.access` permission, PTYs, a 30-minute hard timeout, and start/stop audit records. Terminal contents are not stored.

Known production blockers remain: agent credential rotation UI, TOTP, distributed agent/stream/terminal routing, richer log redaction policy, comprehensive alert delivery, encrypted secret key management, backup/restore verification workflow, deployments, additional terminal isolation controls, and a completed external security assessment. Do not publish the API without TLS and a trusted reverse proxy, and never commit production credentials.


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
