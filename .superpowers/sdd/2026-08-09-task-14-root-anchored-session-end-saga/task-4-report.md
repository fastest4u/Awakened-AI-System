# Task 14M.4 report

## What changed

- Added workflow-generation fingerprint V2 with the required domain and canonical preimage, including explicit V1/V2 predecessor binding.
- Extended workflow folds and SQLite projection persistence for schema-4 snapshot metadata; Version-3 request/amend events bind their event-carried effective-state hash, while cancellation carries predecessor state metadata.
- Added a strict six-key validation-plan codec, connection-taking read/write functions, and a transaction-bound facade. The codec enforces canonical byte limits, binary profile ordering, cardinality, and every unique identity.
- Added event-position effective-state hydration that cross-checks the workflow row and obtains snapshot bytes only from the immutable event.

## Files

- `src/orchestrator/lifecycle/lifecycle-projection-folds.ts`
- `src/orchestrator/storage/lifecycle-projection.repository.ts`
- `src/orchestrator/storage/session-end.repository.ts`
- `tests/lifecycle-projection-folds.test.ts`
- `tests/session-end.repository.test.ts`

## RED → GREEN evidence

RED build: `npm run test:build` passed.

RED command:

```powershell
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(computes exact V2 workflow-generation fingerprint predecessor chains|strictly decodes the six-key persisted validation plan and rejects ordering identity cap violations)$" dist-test/tests/session-end.repository.test.js dist-test/tests/lifecycle-projection-folds.test.js
```

It failed as intended: `workflowFingerprintV2` was `undefined`, and `session-end.repository.js` was absent (`ERR_MODULE_NOT_FOUND`).

GREEN command:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end.repository.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/lifecycle-intent.test.js
npm run typecheck
```

Result: build passed; 19/19 focused tests passed; typecheck passed.

## Self-review

- Confirmed V1 fingerprint function/domain remains unchanged.
- Confirmed V2 hydration derives trigger hash from the exact immutable event and predecessor schema from the exact predecessor fold.
- Confirmed no transaction boundary is exposed by the session-end repository.
- `git diff --check` passed. Test output was pristine (no test warnings/errors); Git emitted only pre-existing LF/CRLF conversion notices while inspecting the diff.

## Fix Round 1

### Findings fixed

- Included all schema-4 workflow-fold columns in targeted workflow reads, so V2 rows hydrate with their effective-state metadata rather than silently defaulting to V1.
- Made V2 verification bind the stored `previousFingerprint` to the exact predecessor fold fingerprint and reject V2-to-V1 schema downgrades during folding.
- Changed effective-state hydration to select the immutable per-generation fold first, follow its `effective_state_source_event_position`, verify the persisted hash, and correlate the exact event with its authoritative lifecycle intent. `workflow_instances` is identity-only.
- Added real in-memory SQLite coverage for one-time plan storage through connection-taking and bound facades, plus V2 fold hydration, downgrade, and complete V2 preimage mutation coverage.

### RED → GREEN

RED command: `npm run test:build; node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^rejects a legacy workflow event after a Version-2 predecessor$" dist-test/tests/lifecycle-projection-folds.test.js`

Expected failure observed: `AssertionError: Missing expected exception`; the old fold accepted a legacy Version-1 cancellation after a Version-2 predecessor.

GREEN commands: `npm run test:build`; `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end.repository.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/lifecycle-intent.test.js`; `npm run typecheck`; `git diff --check`.

Result: build passed; focused suite passed 23/23; typecheck and diff check passed. Test output had no warnings/errors (Git inspection still reports only LF/CRLF notices).

### Files and self-review

- Updated `lifecycle-projection-folds.ts`, `lifecycle-projection.repository.ts`, `session-end.repository.ts`, `lifecycle-projection-folds.test.ts`, and `session-end.repository.test.ts`.
- Rechecked that V1 fingerprint bytes remain untouched, the V2 hash comes from the exact immutable trigger event, and the repository exposes no transaction ownership methods.

## Fix Round 2

- Amendment hydration now compares every non-null amendment field with the fold-selected event's effective request, after decoding the authoritative lifecycle intent; snapshot hash and exact source position remain mandatory.
- Mixed predecessor dispatch now permits the required V1-to-V2 transition but rejects only V2-to-V1 downgrade.
- Expanded V2 preimage mutation coverage across initial, V1-predecessor, and V2-predecessor forms, including invalid null/version forms.

RED: `npm run test:build; node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^rejects a legacy workflow event after a Version-2 predecessor$" dist-test/tests/lifecycle-projection-folds.test.js` initially failed with `Missing expected exception` before the downgrade guard. GREEN: `npm run test:build`; focused session-end/lifecycle-projection/lifecycle-intent suites (23/23); `npm run typecheck`; `git diff --check` all passed.

Files: `lifecycle-projection-folds.ts`, `session-end.repository.ts`, `lifecycle-projection-folds.test.ts`. Self-review: V1-to-V2 is accepted; V2-to-V1 remains fail-closed; amendment fields are checked against immutable event snapshots rather than workflow row state.

## Fix Round 2 — integration completion

- Added real in-memory SQLite event/fold/workflow fixtures that call `hydrateSessionEndEffectiveStateV1` directly through the connection-bound facade for request, amendment, and cancellation-carried source generations.
- Negative controls independently reject authoritative intent mismatch, fold/source-position disagreement, state-hash disagreement, and a missing exact event position.
- The exact V2 array mutation matrix is `binds every V2 fingerprint preimage field across predecessor forms` in `tests/lifecycle-projection-folds.test.ts`; it executes initial/null, V1 predecessor, and V2 predecessor fixtures with all array fields covered (invalid null/version forms assert fail-closed).

RED fixture command: `npm run test:build; node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(hydrates exact request amendment and cancellation-carried effective-state sources|rejects event-position hydration intent fold hash and immutable-event disagreements)$" dist-test/tests/session-end.repository.test.js`. Initial fixture build exposed branded identifier/type fixture errors; after correcting the test fixture (not production behavior), the valid-control run exposed a missing plan-column setup and was corrected before GREEN.

GREEN command: `npm run test:build; node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end.repository.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/lifecycle-intent.test.js; npm run typecheck; git diff --check`.

Result: 25/25 focused tests passed, typecheck and diff check passed. Files: `session-end.repository.ts`, `session-end.repository.test.ts`. Self-review: facade hydration remains connection-bound and owns no transaction; immutable fold-selected source position, exact event, canonical intent, and state hash are all independently checked.

## Fix Round 3

### Changes

- Bound amendment hydration to the source-generation fold and immediate predecessor snapshot: null amendment fields must preserve the predecessor request; non-null fields must equal the immutable amended snapshot.
- Bound `amendment.evidenceWindowAction` to the immutable amendment event and fold transition: `unchanged` preserves the window; `open` is sealed-to-open with a V2 effective checkpoint; `seal` is open-to-sealed with a V2 effective checkpoint.
- Replaced the synthetic cancellation fixture with a real Version-3 `SessionEndCancelled` event at position 11. The generation-3 fold carries the legitimate generation-2 amendment source at position 10 and its matching effective-state hash; direct hydration of position 11 fails closed.
- Added malformed immutable-source-event coverage and an independent SHA-256 reference matrix that enumerates every V2 canonical preimage field for initial, V1-to-V2, and V2-to-V2 forms, including invalid singleton mutations and the valid all-null effective-state form.

### RED → GREEN

RED command:

```powershell
npm run test:build; node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^correlates every non-null amendment field and evidence-window action to the immutable fold$" dist-test/tests/session-end.repository.test.js
```

Expected behavioral RED observed: `AssertionError: Missing expected exception: {"evidenceWindowAction":"seal"}`. Before the fix, a valid `seal` command could disagree with the immutable amendment event (`open`) and its sealed-to-open fold transition.

GREEN commands:

```powershell
npm run test:build; node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(hydrates exact request amendment and cancellation-carried effective-state sources|correlates every non-null amendment field and evidence-window action to the immutable fold|rejects event-position hydration intent fold hash and immutable-event disagreements)$" dist-test/tests/session-end.repository.test.js
npm run test:build; node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^independently hashes every V2 canonical field for initial V1-to-V2 and V2-to-V2 forms$" dist-test/tests/lifecycle-projection-folds.test.js
npm run test:build; node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end.repository.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/lifecycle-intent.test.js
npm run typecheck
git diff --check
```

Results: first repository gate 3/3 passed; independent canonical-array matrix 1/1 passed; final focused suite 27/27 passed; build, typecheck, and diff check passed. The new matrix is coverage for already-correct fingerprint behavior, so it was green on its first execution; the amendment test supplied the separate behavioral RED.

### Files and self-review

- Updated `src/orchestrator/storage/session-end.repository.ts`, `tests/session-end.repository.test.ts`, and `tests/lifecycle-projection-folds.test.ts`.
- Rechecked that a cancellation-carried fold follows its source-generation row rather than decoding the cancellation as a snapshot, that predecessor request/fold state is immutable input to amendment correlation, and that the V2 matrix's reference hash does not invoke the production fingerprint helper to obtain expected values.
- Pristine output: tests, build, typecheck, and `git diff --check` were clean. Git displayed only existing LF/CRLF conversion notices while inspecting the worktree.

## Fix Round 4

### Changes

- Predecessor snapshot hydration now proves the exact immutable source event type, Version-3 schema, session, command-event identity, workflow/generation identity, event-hash shape, and effective-state version/hash against the predecessor fold before using its snapshot.
- Current-source hydration now strictly binds the Version-3 payload shape and source-fold generation, including snapshot session and independently checked event-carried/fold state hashes. The repository integration controls retain real Version-3 cancellation carry and bound-facade success, while separately covering a fold that points to a deleted event, a distinct valid rehashed event snapshot, source-fold corruption, and cancellation-target-fold corruption.
- Added independent valid controls for every nullable amendment field and for predecessor/current evidence-window transitions. Restored the design-required Version-1 null-draft amendment path as implicit `unchanged` over a Version-2 snapshot in both the repository and schema-3 fold.
- Rebuilt the V2 fingerprint matrix around real initial, V1-to-V2, and V2-to-V2 chains. Each form exercises all 16 canonical fields one at a time, asserts that valid candidates differ at exactly one preimage index, and derives expected SHA-256 values with test-local `JSON.stringify`/`createHash`, never the production fingerprint or canonical-JSON helper. `replacementCheckpointVersion` has a valid singleton alternate. `effectiveStateVersion` cannot: Version 1 is its only non-null value, and null requires the source-position/hash trio to be null together. The initial predecessor pair has the analogous null/null invariant, so both singleton mutations are independently rejected.

### RED evidence

Test scaffolding initially exposed TypeScript fixture/overload errors; those were corrected before any behavioral RED was claimed. `npm run test:build` then passed.

```powershell
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^accepts a Version-1 null-draft amendment as implicit unchanged over a Version-2 snapshot$" dist-test/tests/session-end.repository.test.js
```

Result: 0/1 passed. The valid control reached `assertAmendmentSnapshotCorrelation` and failed with `INTEGRITY_FAILURE`, proving the repository incorrectly rejected the Version-1 implicit-unchanged path.

```powershell
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^folds a Version-1 null-draft amendment as implicit unchanged over a Version-2 snapshot$" dist-test/tests/lifecycle-projection-folds.test.js
```

Result: 0/1 passed with `LIFECYCLE_PROJECTION_INVALID`, proving the schema-3 fold had the same regression.

```powershell
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^rejects malformed predecessor snapshot provenance independently$" dist-test/tests/session-end.repository.test.js
```

Result: 0/1 passed with `Missing expected exception: predecessor event type`; the payload-only predecessor read accepted a cancellation row as a snapshot source.

```powershell
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^rejects absent and independently inconsistent immutable sources$" dist-test/tests/session-end.repository.test.js
```

Result: 0/1 passed with `Missing expected exception: source workflow generation identity`; the source payload generation was not bound to its exact source fold.

The fingerprint implementation was already correct, so the new independent matrix passed on unmodified HEAD. Its behavioral mutation RED temporarily replaced only canonical element 13 (`effectiveStateVersion`) with null, rebuilt successfully, and ran:

```powershell
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^independently reference-hashes every exact V2 field across predecessor forms$" dist-test/tests/lifecycle-projection-folds.test.js
```

Result: 0/1 passed. `initial.golden` expected `edcc178050728d5b2212a7c60ccad2749365ea6ca810cb0ce22cfac30429278a` but received `57f8b2ab20d78edb637ed6a5daa5d95965fac651a0184150d730aea897cd8b45`. The one-line mutation was restored before production changes, and no fingerprint-function diff remains.

### GREEN verification

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end.repository.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/lifecycle-intent.test.js
npm run typecheck
git diff --check
```

Result: build passed; the three focused suites passed 31/31; typecheck passed; `git diff --check` passed. Test output was pristine. Git emitted only the existing LF/CRLF conversion notices during diff inspection. No full `npm test` was run, as required.

### Files and self-review

- Updated `src/orchestrator/storage/session-end.repository.ts`, `src/orchestrator/lifecycle/lifecycle-projection-folds.ts`, `tests/session-end.repository.test.ts`, and `tests/lifecycle-projection-folds.test.ts`; appended this report.
- Rechecked that schema-4 workflow columns, V1-to-V2/V2-to-V2 chains, V2-to-V1/detached-chain rejection, real Version-3 cancellation carry, and transaction ownership outside the bound repository remain intact.
- Rechecked that outer `events.event_hash` and nested/fold `effective_state_hash` remain separate hash domains, and that cancellation hydration validates payload generation against the source fold rather than the later cancellation fold.
- A fresh read-only diff review found no Critical, Important, or Minor issues and marked the Round-4 implementation ready.
