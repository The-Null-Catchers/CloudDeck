# Security model and current limits

Passwords use Argon2id. Access JWTs expire in 10 minutes. Refresh tokens are random 256-bit values, SHA-256 hashed at rest, rotated atomically and stored in HttpOnly, SameSite=Strict cookies (Secure in production). Session revocation is checked on each API request. Password reset revokes all sessions. Authentication routes have rate limits. Cross-origin mutation requests are rejected when an Origin header is present and does not match `APP_ORIGIN`.

The agent pairing token lasts 10 minutes, is stored only as a digest, and is invalidated after first use. The exchanged credential is shown once and stored by the agent in a 0600 file. Agents are outbound-only and require TLS except on loopback. Never publish port 4000 without HTTPS and a trusted proxy.

RBAC: viewer reads inventory/metrics/audit; operator may eventually perform approved actions; admin adds servers/manages members; owner can eventually delete the organization. The latter permission names do not create endpoints.

Known release blockers: agent credentials have no rotation UI; no TOTP, CSRF token for deployments with cookie sessions, stale heartbeat sweep, log redaction pipeline, comprehensive audit coverage, alert delivery, secret encryption key management, or remote action service. The installed auth API and pairing endpoint should be assessed before internet exposure. Do not set production credentials in the repository.
