# Task 7 implementation report

## Scope and result

Implemented `V2ImportedProjectionEventReader` with the exact public constructor, `openSnapshot`, and `openCommittedSnapshot` surface. Only authenticated committed wrappers with complete matching ledger receipts become original V1 projection input. V1 caller-facing composition remains unchanged; no activation, public routes, schema registration, or dependencies were added.

Starting state: worktree `C:/Users/Server/.codex/worktrees/subproject-3-projections`, branch `codex/subproject-3-projections`, clean HEAD `d88bd538687ebc17b75c7e39833f1fdafd0537d4`.

Files:

- `src/orchestrator/migration/v2-imported-event-reader.ts` — new reader.
- `tests/v2-imported-event-reader.test.ts` — 59 tests including nested subtests.
- `tests/support/v2-shadow-migration-fixture.ts` — minimal optional empty-source/artifact selection. Existing defaults remain two production-written events and two artifacts; alias behavior is unchanged.
- This report.

## Authority and options decision

Options are `{ driver, eventStorePath, sealedPackage, sourceManifest, busyTimeoutMs? }`. The controller approved requiring `sourceManifest` because the package manifest omits branch fields. The existing production `decodeV1SourceCopyManifestV1` strictly validates and freezes this manifest, including its canonical SHA-256 checksum. That checksum must equal the sealed package's `sourceManifestChecksum`; identity, counts, aggregate source bytes, terminal position/hash, and creation time must also agree. Snapshot binding derives from the decoded manifest, including branch fields, with `sessionId: null`. Caller binding must match it exactly. Empty and artifact-only positive controls and checksum-recomputed but package-unbound branch changes are tested.

The reader checks the sealed package unchanged assertion but never calls its `records()` iterator to obtain projection input. A test makes that iterator throw and still successfully reconstructs committed events.

## Integrity and streaming

A single read-only SQLite transaction pins project identity, migration run, receipts, and target events. Preflight checks receipt cardinality and the complete migration-stream cardinality, including events after the claimed last receipt. It authenticates every target event from genesis through the last receipt, including other streams and workspaces. Each migration wrapper must have the expected event type/schema/scope, exact payload fields, deterministic event identity, stream ordinal, and exact receipt event ID/position/hash, source ordinal/kind/hash, and timestamp. Artifact content, path, length, and digest are checked before excluding it from source projection input.

Source envelopes require exact fields and canonical decimal int64 values, reject nested import types and foreign source scope, and use the production projection codec for envelope/payload decoding. Reference fields must be actual arrays before copying, so malformed iterables cannot be silently normalized. The reader recomputes package record hashes from the wrapper envelope plus the producer's immutable content-free `payload: {}` cache. It reuses `authenticateStoredEvent` from genesis for the original chain and requires source count, terminal position, and terminal hash agreement.

Byte domains are intentionally separate:

- Sealed `aggregateSourceBytes`: authenticated original `payloadJson` UTF-8 bytes plus committed legacy artifact content bytes, matching `sealV2MigrationPackage`/`verifyV1SourceCopy`.
- Snapshot `aggregateBytes`: the original 36 stored-event columns, counting UTF-8 text/JSON bytes and eight bytes for integers/nulls, matching `ProjectionEventSnapshot`'s production SQLite row accounting. Positive reconstruction checks exact equality with the verified source snapshot.

Resource ceilings reuse the current projection replay bounds: at most 100,000 target rows through the receipt cutoff, 64 MiB aggregate target stored-row bytes, and 1 MiB per target row. Original source snapshot rows also enforce 1 MiB each and 64 MiB aggregate; package source totals are capped at 64 MiB. Thus an oversized wrapper chain fails closed even if its original source payload-only budget fits. No larger resource allowance was inferred.

Validation streams one SQLite row at a time and retains counters/cursors plus already-bounded manifest metadata, not all event payloads. Returned iterators perform one keyed source-row read per advance. Tests prohibit SQLite `.all()` and check zero source-row reads before iteration and exactly one after the first advance. No live SQLite statement crosses a caller yield, allowing close during an active iterator. Snapshot, binding, events, reference arrays, and payload caches are frozen; repeated `events()` calls reconstruct independently. Later target writes do not alter an open snapshot.

`close()` is idempotent, rolls back the read snapshot, and closes its connection exactly once. Instrumented real-SQLite tests cover close before first advance, close after one yielded event, subsequent lazy-iteration rejection, and an open-time SQL failure with exactly one connection close. Errors are redacted `ShadowMigrationError` instances with `MIGRATION_LEDGER_INTEGRITY_FAILURE` and no private underlying message/cause.

## RED → GREEN evidence

1. `npm run test:build` initially exited 1 with only TS2307 for the absent reader module, as required by the brief.
2. Initial reader implementation built successfully. First runtime assertions succeeded, but Windows test cleanup hooks failed because directory deletion ran before connection closure. Corrected test hook registration order, then the reader gate passed 8/8.
3. Expanded reader gate passed 50/51. The only failure was `Missing expected rejection` for an unknown migration-stream event after the final receipt. Added same-snapshot whole-stream cardinality validation; rebuild passed, and the focused `--test-name-pattern='unreceipted unknown'` gate passed 1/1.
4. Scoped review identified reference-array normalization. Added three genuinely sealed malformed source records (empty string replacing each reference array), for which descriptor and outer wrapper authentication succeeded. The focused `--test-name-pattern='normalize malformed'` gate failed 0/4 with expected missing rejections. Added array discrimination before copying. These cases passed in the final gate.

The adversarial matrix also covers all missing source/artifact receipts, wholly uncommitted packages, missing committed wrappers, duplicate and reordered ordinals, receipt ID/position/hash/kind/source-hash/timestamp disagreement, raw stored payload tampering, unknown wrapper types, artifacts presented as sources, nested wrappers, wrong migration identity, wrong requested/source/wrapper scope, noncanonical payload JSON, UUID/hash/timestamp/schema/int64 failures, a genuinely sealed broken original predecessor chain, cross-workspace target-chain corruption, and immutable/lazy snapshot behavior. Malformed wrappers are committed through production `EventStore` and real repository receipts; original events originate from production event writers. No test duplicates event hash authentication semantics.

## Final verification

All commands ran in the verified Task 7 worktree:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-imported-event-reader.test.js dist-test/tests/projection-source-event-codec.test.js dist-test/tests/stored-event-authenticator.test.js
npm run typecheck
git diff --check
```

Results: build exit 0; exact required three-file gate 83/83 passing (59 imported-reader, 20 source-codec, 4 authenticator), two suites, zero failures/skips; typecheck exit 0; diff whitespace check exit 0. No additional full-suite rerun was needed. Default shared-fixture execution is exercised throughout the final reader gate via real source verification, package sealing, and importer execution; the extension changes no existing default data or production path.

Project memory lifecycle used the correct vault `C:/Users/Server/Desktop/Awakened-AI-System/memory`, with startup/context retrieval, relevant complete notes, and high-risk self-check. Recorded the reusable reference-array normalization lesson through `memory_writeMistake`; session closure follows the scoped commit with verification enabled. TDD, systematic debugging, and verification-before-completion skills governed the observed failure/fix and final evidence checks.

## Remaining limits

- Reader resource bounds above are deliberately fail-closed; importing a package is not a promise that a larger target chain can be replayed within these bounds.
- Schema 7 remains unregistered until Task 13; tests explicitly apply its SQL after the current schema.
- Tasks 8–14 and independent review remain controller-owned follow-up work. No public V2 activation is authorized.

## Fix round 1 — capacity and operational classification

Review baseline: `f314c58e86040c332846e65fd7b094896ea0f69f`. Read the complete Task 7 review and verified both Important findings against the implementation and production error helpers. This section supersedes the initial report's blanket ledger-integrity error description. Fix scope is reader, reader tests, and this report only; the controller's concurrent unstaged implementation-plan edit is intentionally excluded.

Capacity checks now throw `MIGRATION_LIMIT_EXCEEDED` separately from structural/chain/receipt integrity checks. This covers source manifest count/aggregate bytes, target replay count/aggregate/per-row bytes, reconstructed source row size, and reconstructed source snapshot aggregate bytes. Existing numeric ceilings remain unchanged. Typed limit failures survive open, deferred iteration, and explicit-close catch boundaries.

The normalized failure contract approved for Task 11 is:

| Input classification | Returned safe form |
| --- | --- |
| `ShadowMigrationError` with one of the 12 explicitly allowlisted current `ShadowMigrationErrorCode` values | Fresh `ShadowMigrationError(code, Object.freeze({}))`; `message === code`, empty frozen `safeDetails`, no original cause or stack |
| Native primary SQLite busy recognized by production `isPrimarySqliteBusy` (including extended codes whose primary result is busy), or already-typed `EventStoreError` with code `SQLITE_BUSY` | Fresh `EventStoreError("SQLITE_BUSY", Object.freeze({ retryable: true }))`; `message === "SQLITE_BUSY"`, no original cause/details/stack |
| Any other failure, including unknown typed codes, message-only busy, untyped code-only busy, native locked/I/O, or error metadata that throws during classification | Fresh redacted `ShadowMigrationError("MIGRATION_LEDGER_INTEGRITY_FAILURE", Object.freeze({}))` |

The migration-code allowlist is explicit, not a prefix check. Existing migration classifications retain only their code; this reader adds no retryability to them. Task 11 should recognize the safe `EventStoreError` busy form above and retain its own outcome/reconciliation policy for other migration codes. No new transient category, retry loop, public API route, dependency, or activation was added.

Cleanup runs before normalization. Open/iteration failures preserve their original classification even when rollback and close also fail. Explicit close attempts both operations exactly once and preserves the first cleanup failure; repeated close remains a no-op. Error-code metadata is captured once before allowlist validation and error reconstruction, so an accessor cannot swap in an unvalidated second value. Classification exceptions fall back to the safe ledger error after resources have already been released.

Regression evidence:

- Initial build passed. Focused `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='capacity:|classification:' dist-test/tests/v2-imported-event-reader.test.js` established RED: 19/62 passed, 43 failed on expected lost capacity/migration/busy classifications. Exact target count/byte ceilings already passed; +1 exposed the incorrect error code.
- After the primary correction, all original 62 tests passed. An additional accessor-code regression established a second RED: 62/65 passed, with both new open/lazy cases exposing the unvalidated second code read. Capturing the code once fixed this, as verified by the final gate.
- Target boundary probes cover exact/+1 values for 100,000 rows, 64 MiB aggregate stored-row bytes, and 1 MiB per-row bytes. They override only aggregate metadata returned at the SQLite driver seam; underlying committed rows, receipts, and cryptographic authentication are real. Exact values reach successful reconstruction, while +1 rejects before event iteration and closes once.
- Source manifest count/aggregate boundary probes use explicitly substituted matching manifest metadata to isolate the capacity predicate. Exact values reach an injected downstream open marker; +1 rejects before opening SQLite. These are predicate-isolation tests, not claims of physically importing 100,000 events or 64 MiB.
- Open/lazy probes cover every allowlisted migration code, native primary/extended busy, typed busy, unknown/locked/I/O/non-typed failures, throwing classification metadata, simultaneous operation/rollback/close failures, and changing code accessors. Safe message/details/cause/stack properties and one-time rollback/close counts are asserted.

Final commands and results:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-imported-event-reader.test.js dist-test/tests/projection-source-event-codec.test.js dist-test/tests/stored-event-authenticator.test.js
npm run typecheck
git diff --check -- src/orchestrator/migration/v2-imported-event-reader.ts tests/v2-imported-event-reader.test.ts
```

Build exit 0; exact required three-file gate **148/148 passed** (124 reader, 20 codec, 4 authenticator), zero failures/skips; typecheck exit 0; scoped diff whitespace check exit 0. Inspected the complete reader/test diff. No unrelated full-suite rerun or shared-fixture edit occurred in this fix round. The controller-owned plan remains unstaged and untouched. Project memory startup/context/self-check used the correct vault; an insight records safe classification/redaction and single-read error metadata. Session closure follows the scoped commit with verification enabled. The TDD, systematic debugging, code-review reception, and verification skills guided this fix round.
