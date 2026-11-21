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
