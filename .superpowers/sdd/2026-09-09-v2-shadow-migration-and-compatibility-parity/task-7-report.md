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
