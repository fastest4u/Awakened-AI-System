# Task 6 implementation report

Status: DONE

## Scope

- Added `V2ShadowImporter` and exact V1 source/artifact wrapper contracts.
- Added deterministic command, event, clock, response, receipt, replay, and result behavior.
- Kept schema 7 registration, public V2 routes, deployment, and V2 activation out of scope.

## RED evidence

- Initial module RED (preserved from the prior implementer): `npm run test:build` failed with TS2307 because `v2-shadow-importer` did not exist.
- Initial behavior RED: the first three importer tests rejected the production package envelope as `MIGRATION_SOURCE_INVALID`.
- Limits RED: the canonical EventStore over-limit test expected `MIGRATION_LIMIT_EXCEEDED` but received `MIGRATION_IDENTITY_CONFLICT`; the cause was `EventStoreError: COMMAND_TOO_LARGE`.
- Policy-byte RED: the exact-minus-one policy test completed successfully instead of throwing `MIGRATION_LIMIT_EXCEEDED`, proving that the WIP planner counted payload bytes rather than the full canonical command.
- Response-integrity test setup initially attempted a forbidden SQLite update and received `COMMAND_DEDUP_IMMUTABLE`; it was corrected to inject the malformed replay result through the `EventAppendStatements` read boundary without weakening production immutability.

## GREEN implementation

- Validates package binding and unchanged identity before writing.
- Revalidates record length/hash and performs fatal UTF-8 plus byte-for-byte round-trip validation for legacy artifacts.
- Plans batches against the stricter policy/EventStore event and full canonical-command byte bounds.
- Uses deterministic UUIDs, command identity, correlation identity, clock, event IDs, source references, wrapper payloads, and public responses.
- Reuses the same deterministic command after an unknown outcome; a committed append replays and cannot duplicate events.
- Verifies replay response/event IDs and committed payloads before inserting immutable import receipts.
- Returns a frozen result with a frozen event-ID array and deterministic imported-events checksum.

## Verification

- Focused importer gate after the final exact-byte test: 12 tests, 12 passed, 0 failed.
- Combined regression gate: 64 tests, 64 passed, 0 failed (`v2-shadow-importer`, `event-store`, and `event-append-transaction`).
- `npm run typecheck`: passed.
- Coverage includes exact wrapper streams/types/source refs/metadata, full production authentication, three-store deterministic IDs/hashes/checksum/positions, policy and EventStore count/byte exact and plus-one boundaries, oversized single-event zero-write failure, malformed artifacts, changed package bytes, committed-response/receipt conflicts, unknown-outcome recovery, replay, and result immutability.

## Fix round 1

- Replaced complete-package planning with incremental bounded-batch consumption; a regression proves the first count-bounded batch is durably appended before the next package record is consumed.
- Corrected `maxEventBytes` to use the authenticated source record byte length. Exact bytes pass and plus one fails with zero writes; full canonical command sizing remains exclusively under the batch/EventStore limits.
- Hardened receipt replay by loading the exact durable event at the receipt position, resolving its predecessor, authenticating it with the production authenticator, and checking receipt position/hash/time plus wrapper type, payload, stream, and source reference.
- RED selector initially failed 7/7 across eager consumption, source-byte exact boundary, and independent receipt position/hash/time/missing-event cases. After remediation it passed 7/7.
- Final importer suite passed 19/19. Final combined importer/EventStore/event-append regression gate passed 71/71, and `npm run typecheck` passed.

### Remaining specification blocker

Task 6 requires each batch time to be `manifest.createdAt + batchOrdinal milliseconds`, but the approved `V2MigrationPackageManifestV1` contract has no `createdAt` member. Adding it canonically requires changing Task 4's manifest key set, package writer, parser/checksum behavior, and tests outside the Task 6 two-file implementation scope. This fix round therefore does not invent an epoch or silently expand the package contract; deterministic package-clock compliance remains blocked pending explicit scope/authority expansion.

## Fix round 2

- The controller authorized the smallest upstream dependency repair in the package contract: required `createdAt` is copied from the already verified source manifest, retained in the exact manifest key set, and included in the existing canonical package checksum and derived migration identity.
- Strict reopen validation rejects missing and unknown keys plus malformed, non-canonical, and impossible timestamp forms. A valid timestamp alteration with the old checksum/identity is rejected.
- The importer now derives its sole batch clock from `manifest.createdAt + batchOrdinal milliseconds`; source-event time and the invented 1970 artifact fallback are removed.
- The importer clock fixture deliberately separates package creation time (`2026-09-10T00:00:10.000Z`) from source-event recorded time (`2026-09-10T00:00:00.000Z`). Exact stored `occurredAt` and `recordedAt` are covered for source-only, artifact-only, mixed, multi-batch, and replay imports.

### RED evidence

- `npm run test:build` — exited 1 with two expected `TS2339` errors because `V2MigrationPackageManifestV1.createdAt` did not exist.
- After the minimal package-contract amendment, `npm run test:build` — exited 0.
- `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-migration-package.test.js` — 22 tests, 22 passed, 0 failed.
- `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="uses manifest creation time" dist-test/tests/v2-shadow-importer.test.js` — exited 1; 5 tests, 0 passed, 5 failed. Source-only/mixed/multi-batch used source-event time and artifact-only used the 1970 fallback instead of package creation time.

### GREEN evidence

- `npm run test:build` — exited 0.
- `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-migration-package.test.js dist-test/tests/v2-shadow-importer.test.js` — 46 tests, 46 passed, 0 failed.
- `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-migration-package.test.js dist-test/tests/v2-shadow-importer.test.js dist-test/tests/event-store.test.js dist-test/tests/event-append-transaction.test.js` — 98 tests, 98 passed, 0 failed.
- `npm run typecheck` — exited 0.
- `git diff --check` — exited 0; only line-ending notices were emitted. The controller-owned tracked implementation-plan change remained untouched and is excluded from this Task 6 commit.

## Fix round 3

- Replaced caller-derived hash-bearing wrapper context with a dedicated immutable internal migration context. It retains the manifest-verified project/vault/store/workspace binding, uses least-authority `untrusted`, uses `v2-shadow-importer:<migrationIdentity>` as the client identity, and is always non-Git/branch-neutral.
- Caller context is not mutated. Existing manifest binding checks remain before internal context construction, while embedded authenticated source-event principal and branch provenance remain byte-exact.
- The three-target regression now varies caller actor roles, client instance IDs, Git/non-Git workspace shape, branch metadata, and supplied branch scope, then compares complete stored authenticated event chains and import results.
- Replay and commit-before-receipt recovery retry under a different maintenance/Git caller, proving the same deterministic command is reused without caller metadata entering authenticated migration evidence.

### RED evidence

- `npm run test:build` — exited 0 with test-only changes.
- `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="commits exact|produces identical" dist-test/tests/v2-shadow-importer.test.js` — exited 1; 2 tests, 0 passed, 2 failed. Stored wrapper role was caller `primary` rather than `untrusted`, and a maintenance/Git caller changed the terminal event hash and `importedEventsChecksum` for the same sealed package.

### GREEN evidence

- `npm run test:build` — exited 0.
- `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="commits exact|produces identical|reconciles commit-before-receipt" dist-test/tests/v2-shadow-importer.test.js` — 3 tests, 3 passed, 0 failed.
- `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-importer.test.js dist-test/tests/event-store.test.js dist-test/tests/event-append-transaction.test.js` — 76 tests, 76 passed, 0 failed.
- `npm run typecheck` — exited 0.
