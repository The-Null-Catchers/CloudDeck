# Recovery rehearsal and operational limits

This is a repeatable lab procedure, not a record of a completed control-plane disaster recovery drill. Use isolated PostgreSQL 17, Redis 7, object storage, and a disposable Linux agent. Never run it against production.

## Preserve before a failure

Record the exact Git SHA, migration level, OS, CPU/RAM, tool versions, replica count, workspace/agent count, dataset sizes, and UTC timestamps. Take a consistent PostgreSQL dump using a protected credentials file. Back up persistent local/S3 objects independently. Preserve the control-plane master key, agent credentials, active backup key and every retained historical key in protected offline storage; do not put keys in the evidence log. Losing a key can make otherwise intact ciphertext unrecoverable.

Redis stores dispatch and ephemeral routing state. PostgreSQL stores deployment/notification state, identities, workspace metadata, backup manifests and history. Redis Pub/Sub traffic cannot be replayed. Preserve Redis persistence where configured, but do not treat a Redis snapshot as a substitute for PostgreSQL or backup objects.

## Rehearsal sequence

1. Start a clean isolated control plane at the recorded revision with matching configuration. Disable external notifications, health probes, auto-deploy and scheduled backups until verification finishes.
2. Restore PostgreSQL into a separate empty database. Apply only migrations required by the selected application revision. Validate organization/member counts, server identities, deployments, backup manifests, restore history and secret metadata.
3. Restore persistent object/local backup data and compare object count, byte count, plaintext and ciphertext checksums with the recorded manifest. Configure the retained keyring without printing it.
4. Start private Redis and one API replica. PostgreSQL reconcilers enqueue **queued** deployments and pending notifications. Inspect retained BullMQ completed/failed job IDs: a reconciler calling `add` does not itself reset an existing completed job. Preserve evidence before removing any stale lab queue entry.
5. Review active deployments and running backup/restore rows manually. Automatic safe completion after a crash is not established: active deployment state is not replayed by the queued-only reconciler; backup/restore rows can remain `running`. A lease expiry alone does not prove a host process stopped. Inspect the disposable agent/runtime before resolving state; never blindly retry a destructive operation.
6. Reconnect the lab agent with its original protected credential. Verify a new heartbeat, fresh metric bucket, offline-to-online behavior and authorized read. Confirm a viewer cannot restart a container or open a terminal.
7. Check API/web readiness, workspace counts and deployment history. Test terminal/log subscriptions with HTTP-to-WebSocket replica affinity. Restart one API, then Redis, and record reconnect behavior and any lost transient stream data.
8. Restore one encrypted directory backup into its original **disposable** source path; verify contents, root/nested/file permissions and unrelated files. Rotate keys and repeat with the historical key. Reject missing/wrong keys and corrupt ciphertext without target changes. Assert no plaintext staging remains.
9. Repeat database restores against separate disposable PostgreSQL/MySQL sources with deterministic row counts and content hashes. Exercise wrong credentials and interruption. MySQL SQL restore and current PostgreSQL restore are not guaranteed atomic; preserve a pre-restore database snapshot and rehearse operator recovery.
10. Repeat S3 PUT/HEAD/GET/delete against an isolated MinIO or equivalent service that verifies actual SigV4 signatures. The repository HTTP fixture checks protocol shape but is not an independent S3 implementation.

## Measurement record

For every operation record start/end monotonic duration, outcome, object/row/file counts, dataset size, checksum results, permissions, failure injection and cleanup. Record backup duration, restore duration and time until application readiness separately. Measure multiple runs and report failures alongside successes. No RPO/RTO or production throughput is established by this runbook.

## Candidate SLOs (unmeasured)

Potential pilot objectives: 99.9% successful authenticated read availability over 30 days; p95 read latency below 300 ms at a declared workload; 99% of valid agent samples visible within 30 seconds; 99% of queued deployments claimed within 30 seconds while dependencies are healthy. These are proposed targets, not compliance claims. Measure request/error counts, latency histograms, oldest queued job age, failed jobs and worker/reconciler activity before adopting them.

Fastify emits structured request logs with request IDs. Review request URL sensitivity, access controls and retention before shipping logs to shared storage. Dedicated Prometheus metrics, OpenTelemetry traces and a worker health dashboard remain unimplemented.
