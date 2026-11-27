# CloudDeck verification evidence

This log distinguishes implementation, synthetic integration evidence and actual disposable infrastructure. It is not a production-readiness certificate.

## Source and GitHub scope

- Initial main: `b5b9ece8643a01a2eb639080a774563b1b9e55ed`.
- Initial feature head: `42d836fcc65f9994d447ae1959930908599ad914`.
- Continued branch: `portfolio/clouddeck-completion`; existing [PR #84](https://github.com/The-Null-Catchers/CloudDeck/pull/84), open and unmerged.
- Connected account verified as `MohammedEmad333`. No duplicate branch/PR, merge, external deployment, signing, license change or release.

## Historical CI and screenshot provenance

[Run 45998307131](https://github.com/The-Null-Catchers/CloudDeck/actions/runs/45998307131) passed `node`, `agent`, `e2e`, `mobile` and `mobile-ios` for source head `42d836fcc65f9994d447ae1959930908599ad914`. Its E2E checkout log records merge revision `96cabed69d6f2345e58985cfc161c184a89298fc` against the initial main above. These results establish that revision, not later changes.

[Artifact 15197650400](https://github.com/The-Null-Catchers/CloudDeck/actions/runs/45998307131/artifacts/15197650400) was downloaded, unpacked and all six images visually inspected. The [historical gallery](images/portfolio/historical-42d836f/README.md) retains the unmodified artifact images and SHA-256 checksums; the main gallery now contains the later local captures. No credentials or loading/broken states were visible. The log image is a three-line synthetic snapshot; the backup image is an honest empty/read-only state. Neither proves a real host operation.

The same source head's [push run 45998298769](https://github.com/The-Null-Catchers/CloudDeck/actions/runs/45998298769) failed waiting five seconds for the demo banner. The test called `isVisible()` before asynchronous workspace loading completed, skipped demo initialization and then asserted its result. The fix waits for either the initialized banner or the creation button, checks the creation response, and uses a separate portfolio account so demo-first workspace ordering cannot affect operator fixtures. A deliberate response delay exercises this race.

CI now triggers on main pushes, PRs and explicit dispatch; feature pushes no longer create duplicate conflicting check sets. Required job names remain unchanged. The active repository ruleset `27353822` requires these five contexts from GitHub Actions, an up-to-date branch and resolved review threads, with no bypass actors. The initial PR rollup contained both a failed push `e2e` and successful PR `e2e` and reported BLOCKED. No protections were altered. Re-check the final head rather than inferring mergeability from the historical green run.

## November 27 local verification

The environment is a local Linux workstation, not a VPS: Linux `7.2.15-4-omarchy`, x86_64, Intel Core i5-1035G1, eight logical CPUs, approximately 15 GiB RAM. Disposable PostgreSQL 17.12 and Redis 7.4.2 run on loopback ports 55432/56379 under `/tmp`, separate from other projects. Node 22.23.5, npm 11.9.0 and Go 1.23.12 were prepared in temporary directories. Host PostgreSQL client tools are 18.6; that client/server difference is explicitly part of the database evidence. Flutter is not installed locally; unsigned iOS requires CI macOS.

Executed successfully:

- Locked dependency installation; registry audit reports zero known npm advisories after Next.js 15.5.29, Nodemailer 10.6.1 and PostCSS 8.5.28. `npm ls` still diagnoses the upstream exact PostCSS edge as invalid despite the root override and installed patched bytes; this tooling diagnostic remains open. See [dependency review](DEPENDENCY_REVIEW.md).
- All 29 database migrations, lint and typecheck.
- API test suite: 78 pass, zero fail/skip. Includes real PostgreSQL-backed workspace/session/lease/state tests, separate-process Redis command/log/terminal routing, synthetic agent heartbeat recovery, direct demo mutation denial and disposable SMTP delivery.
- Browser client tests: two pass, covering shared rotating refresh, transport recovery and revoked-session refusal.
- Go test/build and race checks pass, including isolated installer validation, rotated-key filesystem recovery, archive rejection, root/nested/file modes and S3 fixture redirect/interruption/key-version failures.
- Production API/web build; Docker Compose configuration validation (configuration only, no Docker daemon access).

Initial Node attempts failed because validation began before dependency installation/migrations completed. Those setup failures were discarded and the sequential checks above rerun. No product assertions were weakened.

## Actual disposable PostgreSQL recovery

`TestDisposablePostgresEncryptedRecovery` creates a fixed synthetic table in the explicitly provisioned loopback-only `clouddeck_recovery` database, records 100 rows and a deterministic content hash, runs the real pg_dump/pg_restore tools, and verifies encrypted local backup, wrong-credential refusal, pre-cancelled restore refusal, historical-key recovery after rotation and staging cleanup.

The initial observed run took 198.221 ms to back up and 51.279 ms to restore, recovered one 1,349-byte encrypted object, and matched row/content hash `100:ace2109d029a4a53b1240f942bd8aa4f`. These are tiny local measurements, not RPO/RTO or production backup throughput. The opt-in test records fresh checksums and durations on every run; the archive includes fresh authenticated-encryption randomness.

Provision only a disposable cluster/role/database, then run:

```sh
cd services/agent
# The database and role must both be clouddeck_recovery on loopback.
# Set a nonprivileged disposable port and its password through protected env input.
CLOUDDECK_PG_REHEARSAL=1 go test -run TestDisposablePostgresEncryptedRecovery -v
```

Required environment variables: `CLOUDDECK_PG_REHEARSAL_PORT` and `CLOUDDECK_PG_REHEARSAL_PASSWORD`. This test never accepts a remote hostname. MySQL, a mid-restore database interruption and control-plane disaster recovery are not established by it.

## Performance scope

`go test -run '^$' -bench BenchmarkBackupPayload -benchtime=3x -count=3` measures 8 MiB deterministic incompressible local payload encryption/decryption including file sync/deletion on `/tmp` tmpfs. The initial observed encrypt range was 538.77–571.80 MB/s and decrypt 531.63–548.78 MB/s. Three iterations per sample and a memory-backed filesystem do not establish physical-disk, S3 or production throughput. This is a microbenchmark, not end-to-end backup throughput or encryption-overhead isolation.

`scripts/benchmark-local.mjs` provides a bounded local synthetic dashboard/fleet workload with 60 requests, concurrency four, ten warmup requests and measured percentiles/error counts. It refuses external endpoints and requires synthetic credentials from the environment. No unexecuted API latency figures are claimed here.

## Remaining gates and limitations

- Final-head CI must be checked before delivery; the local browser and measurement results below are already recorded.
- Independent MinIO/S3 SigV4 verification, actual S3 recovery/retention/interruption: not verified. Local Docker access is denied, sudo requires a password, and the attempted official MinIO binary download returned HTTP 410. HTTP S3 fixtures are not an independent S3 implementation.
- MySQL consistency/recovery, real Docker/systemd/volume operations, disposable Linux VM pairing and real deployment activation/rollback: not verified in this session.
- Active worker crash recovery, Redis interruption and full control-plane DR: incomplete. Queued-only reconciliation does not recover all active states; backup/restore rows can remain running after API loss. See [recovery runbook](RECOVERY_RUNBOOK.md).
- Log/terminal tickets remain process-local and require HTTP/upgrade affinity. Redis routing tests do not establish arbitrary load-balancer behavior or fault-tolerant Pub/Sub replay. Metrics are database-persisted, not a distributed browser push stream.
- Physical mobile-device checks, signing and store readiness: not verified. Android and unsigned iOS builds are packaging evidence only.
- Prometheus metrics, traces, queue/worker dashboard and measured SLO compliance: not implemented by this work. Canary/blue-green modes are deliberately not added without safe orchestration tests.
- The [90-second shot list](PORTFOLIO_DEMO.md) is documentation, not a fabricated video recording.

The [release checklist](RELEASE_CHECKLIST.md) tracks remaining gates. No production infrastructure or customer data was used.


## Later exact-source local results

At source `95ff51f7e902d7cb066b915c90184327448af2b7`, the full Chromium suite passed **4/4** from a fresh migrated/seeded database in 11.4 s. The six-screen capture also passed **3/3 consecutive runs** in 20.5 s with deliberately delayed workspace responses, without retries. The initial stronger error check incorrectly matched Next.js’s empty ARIA route announcer; it was corrected to assert absence of application notices while preserving loaded-content/read-only assertions. All six new images were visually inspected and committed in the [current gallery](images/portfolio/README.md); original CI PNGs remain archived separately.

At clean source `2ae580f6bbefabc2b8427d1df90707af6d76cf72`, [raw measurements](evidence/2026-11-27/README.md) record a 60-request loopback burst (concurrency 4, ten warmups): p50 **19.746 ms**, p95 **26.015 ms**, p99 **27.638 ms**, **196.455 requests/s**, **0/60 errors**, measured over **305.413 ms**. The short run is not steady-state capacity or a production claim. A fresh real PostgreSQL rehearsal backed up in **170.011 ms** and restored in **40.547 ms**, recovered 100 rows/one 1,349-byte object and matched content/checksums. The fresh 8 MiB tmpfs crypto sample ranges are encrypt **528.82–538.69 MB/s**, decrypt **526.05–544.25 MB/s**; they do not isolate encryption overhead.

CI [46050085841](https://github.com/The-Null-Catchers/CloudDeck/actions/runs/46050085841) at source `95ff51f7e902d7cb066b915c90184327448af2b7` passed Node, agent and E2E. Flutter analysis and all **10 tests** passed; APK packaging failed on Maven Central **HTTP 429** while fetching Kotlin artifacts. The subsequent CI change pins Ubuntu 24.04 and JDK 17 and caches Gradle dependencies. This does not hide the network failure or relax any tests; verify final packaging independently.
