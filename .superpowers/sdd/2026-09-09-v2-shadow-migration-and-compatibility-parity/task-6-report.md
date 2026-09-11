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
