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
