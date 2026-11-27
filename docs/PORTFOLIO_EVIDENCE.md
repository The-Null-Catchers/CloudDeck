# CloudDeck verification evidence

This log distinguishes implementation, synthetic integration evidence and actual disposable infrastructure. It is not a production-readiness certificate.

## Source and GitHub scope

- Initial main: `b5b9ece8643a01a2eb639080a774563b1b9e55ed`.
- Initial feature head: `42d836fcc65f9994d447ae1959930908599ad914`.
- Continued branch: `portfolio/clouddeck-completion`; existing [PR #84](https://github.com/The-Null-Catchers/CloudDeck/pull/84), open and unmerged.
- Connected account verified as `MohammedEmad333`. No duplicate branch/PR, merge, external deployment, signing, license change or release.

## Historical CI and screenshot provenance

[Run 45998307131](https://github.com/The-Null-Catchers/CloudDeck/actions/runs/45998307131) passed `node`, `agent`, `e2e`, `mobile` and `mobile-ios` for source head `42d836fcc65f9994d447ae1959930908599ad914`. Its E2E checkout log records merge revision `96cabed69d6f2345e58985cfc161c184a89298fc` against the initial main above. These results establish that revision, not later changes.

[Artifact 15197650400](https://github.com/The-Null-Catchers/CloudDeck/actions/runs/45998307131/artifacts/15197650400) was downloaded, unpacked and all six images visually inspected. The [gallery](images/portfolio/README.md) includes the unmodified images and SHA-256 checksums. No credentials or loading/broken states were visible. The log image is a three-line synthetic snapshot; the backup image is an honest empty/read-only state. Neither proves a real host operation.

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

- Final-head CI, repeated browser capture and any later measurement results must be recorded before delivery.
- Independent MinIO/S3 SigV4 verification, actual S3 recovery/retention/interruption: not verified. Local Docker access is denied, sudo requires a password, and the attempted official MinIO binary download returned HTTP 410. HTTP S3 fixtures are not an independent S3 implementation.
- MySQL consistency/recovery, real Docker/systemd/volume operations, disposable Linux VM pairing and real deployment activation/rollback: not verified in this session.
- Active worker crash recovery, Redis interruption and full control-plane DR: incomplete. Queued-only reconciliation does not recover all active states; backup/restore rows can remain running after API loss. See [recovery runbook](RECOVERY_RUNBOOK.md).
- Log/terminal tickets remain process-local and require HTTP/upgrade affinity. Redis routing tests do not establish arbitrary load-balancer behavior or fault-tolerant Pub/Sub replay. Metrics are database-persisted, not a distributed browser push stream.
- Physical mobile-device checks, signing and store readiness: not verified. Android and unsigned iOS builds are packaging evidence only.
- Prometheus metrics, traces, queue/worker dashboard and measured SLO compliance: not implemented by this work. Canary/blue-green modes are deliberately not added without safe orchestration tests.
- The [90-second shot list](PORTFOLIO_DEMO.md) is documentation, not a fabricated video recording.

The [release checklist](RELEASE_CHECKLIST.md) tracks remaining gates. No production infrastructure or customer data was used.
