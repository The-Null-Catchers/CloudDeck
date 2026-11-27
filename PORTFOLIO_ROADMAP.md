# CloudDeck portfolio roadmap

Baseline reviewed on November 17, 2026. Repository roadmap published on November 18, 2026.

This roadmap applies to this repository and follows the shared Null Catchers portfolio plan. Verify the documented state against the current code and runs before starting work.

**Estimated initial demo effort** 30–50 hours for a developer familiar with the project. The estimate excludes external reviews, store accounts, target environment setup, and later milestones.

## Project priorities

**Documented state** The Go agent provides monitoring, typed operations, terminal sessions, deployment, backups, and restore. The feature status records operational, scale, and recovery evidence gaps. Check existing backup encryption code and tests before planning changes.

**P0 — Demo** Record agent pairing, disconnection, recovery, and a permission-controlled operation on a lab host. Replace the placeholder screenshot with evidence from a real run.

**P1 — Validation and depth** Verify ownership, permissions, cancellation, unsupported files, and the restored directory root. Check local and S3 encryption and round trips. Rehearse control-plane restore in staging and record elapsed time and recovered data.

**P2 — Later** Add tracing, queue SLOs, and staged rollout when a pilot can measure their value. Address mobile signing after the console walkthrough.

**Acceptance criteria** Only permitted operations run. Interrupted terminal sessions clean up, and backups restore the tested data and permissions. Public demos use read-only access or scoped operations on a lab host.

**Demo scenario** Increased load → alert → logs → permitted restart → recovery → audit record. [FEATURE_STATUS](https://github.com/The-Null-Catchers/CloudDeck/blob/main/docs/FEATURE_STATUS.md), [PR #77](https://github.com/The-Null-Catchers/CloudDeck/pull/77).

## Next milestones

The [feature status](docs/FEATURE_STATUS.md) documents pairing, heartbeats, access roles, and auditing.

1. [ ] Pair an agent and show its metrics. Stop and restart it, confirming offline and online transitions and resumed measurements.
2. [ ] Run an authorized operation on a test service and verify that a read-only account is denied. Record both outcomes.
3. [ ] Capture pairing, status, and audit evidence with a SHA, timestamps, and test roles. Use synthetic or redacted pairing data.

## Portfolio acceptance checklist

- [ ] Another person can reproduce the primary workflow from a clean checkout using the README and test credentials or fixtures.
- [ ] The demo tells one complete story with a defined user, problem, and saved result.
- [ ] Tests cover the main flow, an important failure, and access boundaries when multiple accounts are involved.
- [ ] Demo data is labeled synthetic and reproducible. Review screenshots and recordings for secrets and customer data.
- [ ] Include four to six real screenshots where appropriate, a 60–120 second recording, and working links. Identify the revision used for capture.
- [ ] The README describes implemented capabilities, setup, architecture, limits, tests, and the demo.
- [ ] A short case study explains two engineering decisions, a considered alternative, and how the system handles an actual failure.
- [ ] Release evidence records the commit SHA, CI, prerequisites, and limits. Performance data includes workload, hardware, and method.
- [ ] Licensing and contributor attribution are settled before distribution. Choose the license for each repository individually.

A hosted demo is optional. Code execution, server administration, and secret management can be demonstrated through a recording and a reproducible isolated environment. Keep public demo access scoped to the activities it needs.

## Implementation and follow-up

- Break P0 into tasks with expected behavior, acceptance criteria, and a suitable test.
- Verify existing functionality first. Update this plan when evidence tied to a commit or PR closes a milestone.
- Record the fixture source, the revision used for evidence, and the tested limits.
- Review the final diff and verify required checks for its exact SHA before merging. Follow branch protection.
- For documentation-only changes with no applicable workflow, verify content and links and record the checks actually performed.
- Tie performance, security, and readiness claims to supporting evidence.

## Continuation: November 25, 2026

Baseline is merged PR #83, main `b5b9ece8643a01a2eb639080a774563b1b9e55ed`. See the evidence ledger for the verified previous PR CI. Priorities for the new branch:

1. P0: verify new screenshot capture and inspect the six actual Chromium artifacts before adding them to README. Keep synthetic log snapshots and empty backup inventory labeled accurately.
2. P0: verify installer validation and rotated-key directory recovery regression in CI.
3. P1: rehearse real S3-compatible storage and isolated database recovery, including interrupted backups and retention.
4. P1: exercise GitHub App deployment, rollback, Redis interruption, worker restart and multi-instance routing on disposable infrastructure.
5. P2: improve control-plane metrics and mobile parity based on measured gaps; perform physical-device and signing checks separately.

Do not mark any pending milestone complete before its exact-revision evidence is available.


## November 27 verified continuation of PR #84

Completed in this continuation: six inspected historical Chromium images with exact checkout/run/checksum provenance; installer pre-pairing validation and token argv protection; root/read-only-directory restore permission fix and unsafe archive regressions; stronger per-failure staging checks; browser refresh sharing; backend demo mutation denial; mobile timeouts and failure tests; security dependency updates; Compose master-key/GitHub App forwarding; recovery/release/dependency documentation. The actual local PostgreSQL rehearsal recovered 100 rows through historical-key rotation; Go tests/race/build and database-backed API tests passed. See [evidence](docs/PORTFOLIO_EVIDENCE.md) for exact limits and results.

Next priorities remain:

1. Verify final-head five-job CI and repeated cold/reused demo capture.
2. Independent S3 and MySQL restore/retention/interruption in disposable services.
3. Real lab Linux pairing, Docker/systemd permission operations and deployment failure/rollback.
4. Worker/API/Redis crash recovery and two-instance fault injection, including ticket affinity.
5. Full control-plane DR rehearsal and representative load measurements.
6. Physical mobile device/accessibility checks, approved licensing and maintainer release review.

Do not mark host operations, S3/MySQL recovery, production performance or signed mobile distribution complete from synthetic fixtures or unsigned builds.
