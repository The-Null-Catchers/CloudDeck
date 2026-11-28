# CloudDeck release checklist

PR #84 stays open until maintainers review it. This list does not authorize merge, deployment, signing, licensing, or publication.

- [ ] Record the final feature SHA and exact-head CI run; require `agent`, `node`, `e2e`, `mobile`, `mobile-ios` without weakening the active ruleset.
- [ ] Review the entire diff; preserve newer contributor changes; no force push.
- [ ] Confirm source revisions and checksums in the six-image gallery; distinguish UI fixtures from host operations.
- [ ] Run the screenshot flow repeatedly without retries hiding failures; test cold demo creation and reuse.
- [ ] Rehearse installer/key validation and protected credential handling on a disposable Linux VM.
- [ ] Run encrypted recovery and historical key rotation on a real lab filesystem; record permissions, failed-decrypt preservation and cleanup.
- [ ] Verify S3 with an independent isolated SigV4 implementation, retention and interruption.
- [ ] Rehearse PostgreSQL and MySQL consistency, wrong credentials and interrupted restore recovery.
- [ ] Test actual Docker/systemd boundaries and container lifecycle authorization.
- [ ] Test successful/failed/cancelled deployments, activation rollback, worker crash, agent loss and Redis outage.
- [ ] Verify two API/worker replicas, ticket affinity, terminal/log routing and lease fencing under faults.
- [ ] Execute the control-plane recovery runbook and record actual recovery durations and integrity.
- [ ] Measure a declared workload: p50/p95/p99, throughput/error rate, telemetry/reconnect and backup/restore throughput.
- [ ] Review dependency advisories and transitive licenses; resolve or explicitly accept each finding.
- [ ] Obtain maintainer authorization for a repository license; none is added by this work.
- [ ] Validate Android/iOS on physical devices, accessibility and offline recovery. Unsigned iOS CI is packaging evidence only.
- [ ] Record a genuine 60–120 second demo or use the disclosed shot list in PORTFOLIO_DEMO.md.
- [ ] Verify installation/environment/GitHub App documentation and links.
- [ ] Obtain explicit maintainer approval before merge or any external release/deployment.
