# Task 12D Report: Record Coverage-Only Evidence Through the Central Fresh-Integrity Gate

## Status

DONE WITH DOCUMENTED COMPATIBILITY SEAM

## Base and scope

- Required base: `b1fd55b0f6e881decd03e50fda8c763b86111e66`
- Branch: `codex/subproject-2-lifecycle-spec`
- No schema or migration changes.
- Production lifecycle Version 2 routing remains disabled.

## Implementation

- Added `EvidenceCoverageService` for strict Version 2 command decoding, root-to-child and child-self authorization, exact append-position planning, a single `EvidenceCoverageRecorded` event, a deeply frozen coverage-only result, and connection-local `persistPrepared` postwrite execution.
- Expanded the connection-bound coverage facade over the Task 12C repository.
- Added the central fresh-integrity gate after replay and identity/append validation and before semantic work.
- Fresh evidence checks the evidence window before quick health; exact replay returns before transaction, window, health, provider, or repository access.
- Added constant-time root/child session-end workflow checks for absent, cancelled, open, sealed-pre-final, malformed, and frozen states.
- Bound record-evidence intent to protected root-handle or child-handle authorization scope and generation.
- Exported strict Version 2 event/result decoders and retained fixed evidence provider profile literals.

## Files

- `src/orchestrator/lifecycle/evidence-coverage.service.ts`
- `src/orchestrator/lifecycle/lifecycle-command.store.ts`
- `src/orchestrator/lifecycle/contracts/commands.ts`
- `src/orchestrator/lifecycle/contracts/events.ts`
- `src/orchestrator/lifecycle/lifecycle-intent.ts`
- `src/orchestrator/lifecycle/lifecycle-intent-witness.ts`
- `tests/evidence-coverage.test.ts`
- `tests/lifecycle-command-store.test.ts`
- `tests/lifecycle-contracts.test.ts`

## TDD evidence

The exact RED anchor command compiled the typed scaffold and then failed both anchors as expected:

- replay-first order observed only the semantic callback instead of `window`, `health`, then callback;
- atomic postwrite anchor reported that Task 12D had not yet proved atomic persistence.

Result: 2 tests, 0 passed, 2 failed.

The exact GREEN gate then passed:

- `npm run test:build`: exit 0
- Four-file serial Node gate: 144 passed, 0 failed
- `npm run typecheck`: exit 0

Full regression:

- `npm test`: exit 0
- 1,358 tests total; 1,348 passed; 10 skipped; 0 failed
- `git diff --check`: no whitespace errors (Git emitted only working-copy line-ending warnings)

## Self-review

- Event transition, aggregate, and ordinal persistence is invoked only from `afterAppend` with the committed event.
- Result output excludes fingerprints, provider/key/profile material, frames, `observedAt`, references, and raw evidence.
- Window corruption maps to `INTEGRITY_FAILURE`; complete frozen state maps to `SESSION_END_EVIDENCE_FROZEN`.
- No unrelated files or migrations were changed.

## Compatibility seam

`ConnectionBoundEvidenceCoverage` methods are optional at the transaction type boundary so existing production-disabled Version 1 transaction literals remain source-compatible. The `record-evidence-batch` fresh path requires `assertEvidenceWindowWritable` and `assertQuickHealthy` at runtime and fails closed with `INTEGRITY_FAILURE` if either is absent; `EvidenceCoverageService` likewise requires repository operations before semantic work. The repository-backed facade itself is complete.

---

## Fix Round 1

This section supersedes the original compatibility-seam, replay-order, and
constant-time wording above.

### Review findings closed

- Replaced the callback-revoked prepared object with an opaque primitive
  `PreparedEvidenceCoverageHandle`. Each connection-bound facade keeps a
  private handle-to-authentic-plan map, consumes the handle before persistence,
  and passes the exact repository-authenticated plan to
  `EvidenceCoverageRepository.persistPrepared`. The registry is per facade and
  per transaction execution, not global.
- Made every coverage-facade method mandatory and added
  `registerAffectedExistingSessions`. The store validates a complete own-method
  facade before every fresh semantic callback.
- Added a central fresh-integrity coordinator. Envelope-derived existing
  sessions are quick-checked before the callback; callback-discovered sessions
  are checked immediately when registered. Claim-transfer commits are
  independently inspected before append preparation and must prove that the
  discovered source child was registered.
- Root start retains an empty affected-existing-session set and therefore makes
  no health call for the not-yet-existing root.
- Bound every command-authored prepared payload field before append/result
  construction: adapter, batch ID, first/last ordinals, complete canonical
  frames, schema/profile key/domain, and non-retention mode.
- Strengthened evidence-window ancestry checks. Child parents must be canonical
  UUID roots with canonical stream identity, root generation shape, matching
  workspace, and matching namespace; missing roots, child-to-child ancestry,
  malformed parent IDs, and malformed generation groups map to
  `INTEGRITY_FAILURE`.
- Replaced the raw final-binding projection read with a fixed set of indexed
  authority/workflow/checkpoint statements. Frozen-state validation returns a
  scalar verdict, enforces the 262,144-byte/605-binding hard bounds, strictly
  validates result, checkpoint, and every binding, and verifies the
  binding-to-child-summary relationship. Query count and SQL shape are
  projection-size independent; validation work is bounded
  `O(bindingCount)`, not literal overall `O(1)`.
- Added strict frozen event stream/session identity and exact Version 2
  checkpoint decoding. Null/permissive results, malformed phase results,
  malformed nested checkpoints, forged binding kinds/tickets, relationship
  drift, and non-session checkpoint streams map to `INTEGRITY_FAILURE`.
- Replaced the fake atomic anchor with real
  `LifecycleCommandStore` + `EventAppendTransaction` +
  `EvidenceCoverageRepository` integration. First and later batches inject
  faults before and after transition, aggregate, and ordinal writes and compare
  exact event/dedup/transition/head/aggregate/ordinal/stream-version state.
- Added end-to-end root-to-descendant and child-self success, wrong
  ancestry/role/stale-generation no-effect cases, exact replay with zero new
  provider/repository work, and conflicting proof intent rejection.
- Persisted the zero-new batch and proved latest batch ID/event position advance
  while the cumulative coverage fingerprint remains unchanged.

### Replay-order correction

Exact replay returns before constructing the command transaction facade,
coverage repository, evidence provider work, window checks, health checks,
semantic callback, and event-ID generation. The established store still opens
`BEGIN IMMEDIATE` and evaluates the authority-material status callback before
returning replay. Therefore the original statement that replay returned before
the transaction was incorrect and is withdrawn.

### Fix-round TDD evidence

Focused RED anchors observed the intended defects before implementation:

- `commits evidence event transition aggregate and ordinals atomically` failed
  on the repository prepared-plan authenticity check when the callback-retained
  proxy reached `afterAppend`.
- `fails closed before a fresh non-evidence callback when quick health is
  absent` committed with the optional facade.
- `quick-checks a callback-registered existing descendant before semantic
  writes` failed because no registration channel existed.
- `rejects every command-authored prepared payload drift before append or
  result` accepted adapter/profile/ordinal/frame drift.
- `rejects missing child roots and child-to-child ancestry before workflow
  lookup` accepted malformed ancestry.

Focused GREEN evidence after the fix:

- stable real-store prepared-plan anchor: 1 passed, 0 failed;
- mandatory health/callback registration anchors: 2 passed, 0 failed;
- command/payload drift matrix: 1 passed, 0 failed;
- ancestry/frozen-window anchors: 3 passed, 0 failed;
- real first/later rollback matrix: 2 passed, 0 failed;
- authorization/replay/no-effect matrix: 3 passed, 0 failed;
- affected child-workflow/processor/event-append suites: 57 passed, 0 failed.

### Final verification

- Exact Task 12D gate:
  - `npm run test:build`: exit 0;
  - four-file serial Node gate: 157 passed, 0 failed;
  - `npm run typecheck`: exit 0.
- Full regression rerun with captured output:
  - `npm test`: exit 0;
  - 1,371 tests total; 1,361 passed; 10 skipped; 0 failed.
- The first full-suite process exceeded the initial command capture window; its
  npm log later reported exit 1 without retained test output. The immediately
  repeated fully captured run above passed. No code changed between those two
  full-suite processes.
- `git diff --check`: exit 0; only working-copy LF/CRLF notices were emitted.
- Frozen migration checksum:
  `68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06`.
- Migration 0002 and production Version 2 routing remain unchanged.

### Fix-round files

- `src/orchestrator/lifecycle/lifecycle-command.store.ts`
- `src/orchestrator/lifecycle/evidence-coverage.service.ts`
- `src/orchestrator/lifecycle/child-workflow.service.ts`
- `tests/evidence-coverage.test.ts`
- `tests/lifecycle-command-store.test.ts`
- `tests/child-workflow.test.ts`
- `tests/lifecycle-command-processor.test.ts`
- `tests/event-append-transaction.test.ts`

## Fix Round 2

### Focused RED evidence

- `npm run test:build`: exit 0 after correcting a test-only nullable fixture
  annotation; no production file had been edited.
- Focused command:
  `node --test --test-concurrency=1 --test-reporter=spec
  --test-name-pattern="quick-checks a uniquely selected null-session resume
  root before semantic mutation|allows only strict writable session-end
  evidence windows for roots and descendants|quick-checks a callback-selected
  null-session resume root synchronously"
  dist-test/tests/lifecycle-command-processor.test.js
  dist-test/tests/lifecycle-command-store.test.js
  dist-test/tests/evidence-coverage.test.js`
- Observed result: 3 tests; 1 passed; 2 failed.
- The processor RED failed with `Missing expected exception`: a uniquely
  server-selected null-session root reached semantic work without invoking the
  callback registration/health gate.
- The frozen workflow RED expected `INTEGRITY_FAILURE` but observed
  `SESSION_END_EVIDENCE_FROZEN`: a complete frozen group in the pre-final
  `requested` phase was misclassified as an ordinary freeze. The same focused
  test also contains allowed-but-wrong wrapper-transition and jointly negative
  triggering-position cases, which will be exercised after the first assertion
  is fixed.
- After that focused group turned green, the projection RED command ran the
  connection-derived current-child and bounded unclaimed-ticket anchors.
  Result: 2 tests; 0 passed; 2 failed.
- The service forwarded the invocation-injected child
  `00030d40-...` at positions `1/1` instead of deriving the connection-bound
  child `000e1d49-...` at positions `7/2`.
- The transfer repository anchor failed with
  `TypeError: repository.listUnclaimedBySourceRoot is not a function`, proving
  the bounded source-root read seam did not yet exist.

### Focused GREEN evidence

- A uniquely selected null-session root resume now registers synchronous
  quick health only after the selected authority matches the requested target
  and before proof, lease, CAS, append, or dedup mutation. Ambiguous and
  not-found searches do not health-check an arbitrary candidate; exact replay
  remains earlier.
- Evidence recording no longer accepts an invocation-authored ending-scope
  projection. The service derives a bounded projection from connection-bound
  authority and unclaimed transfer-ticket facts, sorts child identities by
  UTF-8 bytes, and runs the strict final-binding decoder before provider work.
- The current-child projection uses the actual indexed stream head for
  `lastEventPosition`, separately validates the latest authority-changing
  event and commitment, and strict-decodes the complete authority row. A final
  audit found and corrected the initially stale authority-event projection;
  the regression fixture includes a later non-authority child event.
- The carry-forward projection requires the exact unclaimed source-root ticket,
  transferred authority, stream head, immutable transfer event, authority
  commitment, and checkpoint event. Claimed tickets are excluded and payload
  provenance tampering fails without provider or atomic effects.
- Both projection reads use deterministic limit-plus-one queries. Planner
  assertions require `session_authority_parent_terminal` and
  `child_transfer_tickets_unclaimed_source_root`, and reject table scans or
  temporary sorting. Six hundred six terminal children do not consume the
  nonterminal limit, and a combined 606 live/ticket union is rejected before
  provider work.
- Frozen workflow results require exact positive positions and generations.
  Wrapper results require `progressed: true` and one exact
  previous-phase/current-phase/action transition tuple.
- Frozen reads validate only the immutable recorded checkpoint/binding
  baseline and immutable transfer provenance. A later ticket claim remains
  `SESSION_END_EVIDENCE_FROZEN`; pre-final complete groups and malformed
  baselines fail with `INTEGRITY_FAILURE`.
- The old adjacent-pair double-`json_each` ordering check was removed. Bounded
  strict decoding and canonical byte comparison now enforce ordering and
  uniqueness in linear work. The 605-binding frozen fixture contains real
  recorded child streams, events, and strict authority rows.

Focused anchor result after implementation: 4 passed, 0 failed.

### Final Round-2 verification

- `npm run test:build`: exit 0.
- Exact Task 12D four-file serial gate: 163 passed, 0 failed.
- Directly affected processor/repository/migration gate: 104 passed, 0 failed.
- `npm run typecheck`: exit 0.
- `git diff --check`: exit 0; only working-copy LF/CRLF notices were emitted.
- Migration 0002 SHA-256 remains
  `68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06`.
- The first Round-2 full suite, before the final projection-head audit
  correction, passed: 1,379 tests total; 1,369 passed; 10 skipped; 0 failed.
- After that production correction, the exact and affected gates were rerun
  and the full suite was rerun from the final source state:
  1,379 tests total; 1,369 passed; 10 skipped; 0 failed.
- Production Version 2 routing remains disabled. Migration 0002 remains
  byte-identical; migration 0003 adds only the bounded unclaimed-ticket
  projection index.

### Fix-round files

- `src/orchestrator/lifecycle/evidence-coverage.service.ts`
- `src/orchestrator/lifecycle/lifecycle-command.processor.ts`
- `src/orchestrator/lifecycle/lifecycle-command.store.ts`
- `src/orchestrator/storage/child-transfer.repository.ts`
- `src/orchestrator/storage/lifecycle-storage.types.ts`
- `src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts`
- `src/orchestrator/storage/session-authority.repository.ts`
- `tests/evidence-coverage.test.ts`
- `tests/lifecycle-command-processor.test.ts`
- `tests/lifecycle-command-store.test.ts`
- `tests/lifecycle-storage.repositories.test.ts`
- `tests/qualified-checkpoint-migration.test.ts`

## Fix Round 3

### RED evidence

- Command:
  `npm run test:build; node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="projects a live child checkpoint recorded after its authority event into evidence ending scope" dist-test/tests/evidence-coverage.test.js`
- `npm run test:build` exited 0. The new real-store/service regression then
  failed as intended: 0 passed, 1 failed with `INTEGRITY_FAILURE` from
  `decodeCurrentChildProjection`. The fixture records a child checkpoint at
  position 3 after the child's authority-changing fork at position 2, advances
  the child stream head to 3, and expects that child to be included in the
  prepared evidence ending scope.

### GREEN and verification

- Replaced the invalid checkpoint-versus-authority comparison with a
  checkpoint-versus-verified-stream-head comparison in the bounded
  current-child projection. Strict checkpoint event decoding, head validation,
  indexed query shape, immutable provenance, migrations, and production V2
  routing are otherwise unchanged.
- Focused command (`npm run test:build` plus the three relevant named
  evidence-coverage tests): 3 passed, 0 failed.
- Exact Task 12D gate: `npm run test:build`; serial four-file Node gate; and
  `npm run typecheck`: all exit 0; 164 passed, 0 failed in the Node gate.
- Full suite: `npm test` exit 0; 1,380 tests total, 1,370 passed, 10 skipped,
  0 failed. An earlier full-suite capture timed out at the runner boundary
  before producing test output; it was rerun successfully from the unchanged
  final source state.
- `git diff --check`: exit 0 (only Git LF/CRLF notices).
- Frozen migration 0002 SHA-256:
  `68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06`.

### Files and self-review

- Changed `src/orchestrator/storage/session-authority.repository.ts` and
  `tests/evidence-coverage.test.ts`; appended this report only.
- Self-review confirmed the new predicate binds the latest checkpoint to the
  already validated actual stream head, while the existing strict checkpoint
  event/identity checks and the bounded indexed projection remain in place.
- Commit: `fix: accept checkpoints after child authority events`.
