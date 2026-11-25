# CloudDeck portfolio evidence (in progress)

This is an evidence log, not a production-readiness certificate.

## Source and scope
- Repository: `The-Null-Catchers/CloudDeck`
- Baseline main SHA: `8aa1486dd7d9892ea085325c5f429cd1dc4f57aa`
- Working branch: `portfolio/clouddeck-completion`
- Verification target: the latest head of the working branch; confirm the exact SHA in GitHub Actions before merging.

## Confirmed historical CI evidence
GitHub Actions run [44915953761](https://github.com/The-Null-Catchers/CloudDeck/actions/runs/44915953761), head `8cd70eaafc14fb20e98c7e5098e54fa1b559b8ae`:
- Node.js: pass (lint, typecheck, tests, production build)
- Browser E2E: pass
- Flutter Android: pass (analyze, tests, release APK build with placeholder API URL)
- Flutter iOS: pass (unsigned build only)
- Go agent: fail (four existing backup/restore tests were not configured for mandatory encryption).

These results predate the latest fixes and MUST NOT be presented as validation of the current head.

## Verified CI after backup fixes
Both [run 44917477816](https://github.com/The-Null-Catchers/CloudDeck/actions/runs/44917477816) and [run 44917494754](https://github.com/The-Null-Catchers/CloudDeck/actions/runs/44917494754) completed successfully at exact head `a71bb0767c72c8cb48c35e253ed31164fabc257d`. Each reported green jobs for Node, browser E2E, Go agent, Android, and unsigned iOS. This verifies that historical commit, **not any later documentation or implementation changes**.

## Changes pending latest CI verification
- Fix malformed Go JSON struct tags for backup encryption metadata.
- Require authenticated encryption for local and S3 backup payloads.
- Return AES-256-GCM chunked algorithm, key version, and ciphertext SHA-256 to the API for verified local and S3 backups.
- Verify S3 HEAD key-version metadata.
- Update synthetic filesystem and S3 fixtures to supply a deterministic test-only encryption key.
- Assert local/S3 ciphertext metadata and integrity while retaining checksum failure coverage.

## Unverified and manual requirements
- Current-head Go test/build and full CI status.
- End-to-end disaster-recovery rehearsal in isolated PostgreSQL/object storage.
- Real Linux host permission checks, Docker socket opt-in, systemd boundaries, and multi-instance fault injection.
- Real UI screenshots, browser recording, physical mobile-device testing, store signing.
- Performance numbers and SLOs. No performance figures are claimed.

## Safety
No production servers or production data are used for this evidence. Tests use temporary directories, a synthetic S3 HTTP fixture, and dummy encryption keys. Never publish credentials or screenshots containing tokens.

## Reproduction
From a clean checkout of the **exact commit** being reviewed:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
cd services/agent
go test ./...
go build ./...
```

API/browser integration tests require the PostgreSQL and Redis services and migrations configured by `.github/workflows/ci.yml`. Inspect the workflow run for the exact head SHA rather than reusing a historical green badge.

## November 25 continuation

The previous portfolio PR [#83](https://github.com/The-Null-Catchers/CloudDeck/pull/83) was merged at `b5b9ece8643a01a2eb639080a774563b1b9e55ed`. Its exact head `5ce929831113333c2002a2b86d868d9cc16bf094` passed all five jobs in [CI 44928879638](https://github.com/The-Null-Catchers/CloudDeck/actions/runs/44928879638): Node (including migrations), Chromium E2E and graceful shutdown, Go test/build, Flutter analyze/test/Android release, and unsigned iOS build. No pull-request-triggered run was returned for the merge commit by the connector; do not conflate the two revisions.

New changes on the reused feature branch:
- Installer validates decoded key length and version before pairing.
- Disposable directory restore test checks rotated keys, missing/wrong key, corrupted ciphertext, file mode, and unrelated file preservation.
- Chromium capture test requests six actual screenshots of the labeled synthetic UI; CI uploads them as `clouddeck-portfolio-screenshots`. Logs are a synthetic snapshot, and backups show the honest empty/read-only state. These are not live-host evidence.

All new checks remain pending until CI completes at the new PR head. Review artifact contents before publishing any PNG under docs/images/portfolio. The local execution environment cannot resolve GitHub and has no Docker or Flutter executable; no new local builds or full infrastructure rehearsal were performed. No production systems were contacted.
