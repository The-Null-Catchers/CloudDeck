# Changelog

## Unreleased — PR #84 portfolio continuation

- Prevent pairing-token exposure in installer process arguments; validate malformed/short/long keys, bounded versions and missing inputs before pairing with isolated installer tests.
- Preserve restored root and nested directory permissions, including read-only directories; reject duplicate/traversal archive entries and verify failed-restore staging cleanup.
- Enforce synthetic-workspace read-only permissions in the API, including owner host-operation requests.
- Remove the synthetic-demo hydration race; isolate portfolio fixtures from operator fixtures and assert loaded/read-only states before genuine captures.
- Run CI on main pushes and PRs without duplicate feature-push runs; pin npm 11.9.0 and retain the five required job names.
- Share browser refresh requests so parallel reads cannot race rotating cookies.
- Bound mobile API waits and cover timeout, interrupted-network and concurrent-refresh behavior.
- Update Next.js to 15.5.29 and Nodemailer to 10.6.1; exercise mail delivery against a disposable local SMTP server and repair the existing PostCSS override in the lockfile.
- Clarify the synthetic log snapshot; improve log-source form layout and visible keyboard focus.
- Add opt-in real local PostgreSQL encrypted recovery, local crypto benchmarks and a bounded synthetic API measurement script.
- Publish the six inspected historical Chromium screenshots with source/run/checksum provenance; correct stale encryption, restore, worker and routing documentation.
- Add recovery procedures and a release checklist. Real S3/MySQL, disposable host operations, full crash recovery, physical-device checks and production performance remain separate gates. No license, release, deployment or merge is authorized by these changes.
