# CloudDeck reproducible portfolio demo

This guide describes a **synthetic lab**. Do not point the demo at production servers, databases, or buckets.

## Prerequisites
- A checkout of the exact commit recorded in [Portfolio evidence](PORTFOLIO_EVIDENCE.md).
- Node 22, npm 11, Go 1.23, PostgreSQL 17, Redis, and a browser with Chromium/Playwright.
- For actual Linux agent/Docker/systemd operations: a **disposable Linux VM** with a test-only Docker Engine and a deliberately scoped test service. Do not grant the agent unrestricted sudo.
- A test GitHub App installation/repository if demonstrating live GitHub-backed deployments.
- For backups: a disposable allowlisted directory, temporary backup directory, and a 32-byte base64 encryption key stored only in the test environment.

## Automated synthetic evidence
The repository CI workflow runs migrations, seeds browser fixtures, builds the API/web, and executes browser E2E tests. The API integration suite pairs a synthetic agent over WebSocket, simulates heartbeat expiry/recovery, and exercises an authorized service restart against a fixture (not real systemd). The Go agent suite includes local and mock-S3 backup/restore tests.

Run the commands from [Portfolio evidence](PORTFOLIO_EVIDENCE.md) and inspect `.github/workflows/ci.yml` for the database/Redis-backed browser setup. Capture the run URL and exact SHA. **Do not describe a fixture acknowledgement as a real host operation.**

## Manual disposable-VM walkthrough
1. Start the control plane using the README setup and isolated database/Redis.
2. Sign in with a synthetic test workspace and open the fleet dashboard.
3. Create a lab server and pair the Go agent using a one-time token; never record the token.
4. Observe telemetry and note timestamp, host, and reporting interval.
5. Stop the lab agent, wait for the configured offline threshold, and capture the offline alert.
6. Restart the agent and verify online recovery and new telemetry.
7. Inspect Docker inventory on a test-only Docker socket. If socket access is not granted, show the explicit permission boundary rather than bypassing it.
8. Restart only a disposable fixture container or narrowly authorized test service; compare an operator with a read-only viewer. Capture the corresponding audit entry without secret values.
9. Open bounded Docker/systemd logs, monitoring charts, alert history, and deployment history.
10. Create a backup of synthetic data in a test-only allowlisted directory. Check the returned manifest, plaintext SHA-256, ciphertext SHA-256, algorithm, and key version.
11. Restore into an isolated disposable directory/database and verify recovered content and file modes. Test wrong-key and corrupted-ciphertext failures; confirm unrelated files remain untouched.
12. Demonstrate a test deployment only against the disposable VM. Confirm resolved commit, state transitions, progress, health, failure/rollback evidence when supported.

## Screenshot capture
Capture **genuine running UI** with synthetic labels and redacted tokens at:
- `docs/images/portfolio/fleet-dashboard.png`
- `docs/images/portfolio/server-details.png`
- `docs/images/portfolio/docker-inventory.png`
- `docs/images/portfolio/realtime-logs.png`
- `docs/images/portfolio/deployment-history.png`
- `docs/images/portfolio/backup-management.png`

These files must not be fabricated. Only commit them after capturing the actual running application.

## 90-second recording script
- 0–12s: Problem, architecture, fleet overview.
- 12–27s: Pair a synthetic agent and show telemetry.
- 27–40s: Disconnect and recover the lab agent; show offline/online alerts.
- 40–54s: Docker inventory, permission-controlled fixture operation, audit trail.
- 54–66s: Bounded logs and historical metrics.
- 66–80s: Encrypted backup metadata and isolated restore result.
- 80–90s: Deployment history, architecture, and explicitly disclosed limitations.

## Evidence checklist
Record the SHA, CI URL, fixture source, exact commands, screenshots, host/OS details (if using a VM), tests actually performed, failures, and remaining manual gates in [Portfolio evidence](PORTFOLIO_EVIDENCE.md). Do not claim a physical-device test, real host restart, or disaster-recovery drill based solely on mocked integration tests.
