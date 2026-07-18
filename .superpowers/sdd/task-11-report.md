# Task 11 Implementation Report

## Status

DONE

Commit subject: `feat: enforce durable lifecycle checkpoints`

## Implementation

- Added `CheckpointService.record` and `recordFinal` as one strict synchronous enrichment/append path for roots and children inside `LifecycleCommandStore` transactions.
- Derived checkpoint identity, creator attribution, source-state witness, global base/event positions, stream version, nonterminal child folds, and coverage-only evidence state in trusted worker code.
- Added specialized latest-checkpoint compare-and-swap persistence and covering-only checkpoint-required marker clearing.
- Added a shared latest-at-tip risky-transition guard with exact checkpoint fingerprint, stream fold, base watermark, explicit checkpoint ID, and relevant-child summary checks.
- Enforced that guard for ownership transfer, ownership recovery, child suspension/transfer, and carry-forward claim. Nonterminal transitions set their exact post-transition marker; terminal child transfer sets no impossible marker.
- Reworked root suspension to capture a trusted source witness and exact sorted child summaries before atomically appending its checkpoint and suspension.
- Added a pure fixed 15-minute checkpoint-age diagnostic which reports missed triggers without creating a lifecycle event.
- Added `FilesystemSourceStateProvider`, `DeterministicSourceStateProvider`, and a SQLite-backed trusted scope resolver. Git capture uses exactly four fixed, bounded, no-shell invocations with no caller environment.
- Scoped source witnesses exclude only the exact descriptor, contained store/private roots, committed compatibility targets, and committed matching temp tuples. Linked worktree Git-common stores are supported.
- Hardened non-Git and Git inventory capture with pre-read count/size checks, bounded synchronous streaming, a live 64 MiB byte budget, and non-traversed symlink records.
- Corrected checkpoint contract semantics: canonical JSON byte accounting, explicit `contentRetained: false`, and no unrelated 200-entry cap on child summaries.
- Added canonical existing-path and containment helpers that reject absolute, traversal, external-scheme, and symlink-substituted checkpoint paths.

## Files

Production:

- `src/orchestrator/identity/canonical-path.ts`
- `src/orchestrator/lifecycle/checkpoint.service.ts`
- `src/orchestrator/lifecycle/child-workflow.service.ts`
- `src/orchestrator/lifecycle/contracts/checkpoint.ts`
- `src/orchestrator/lifecycle/lifecycle-command.processor.ts`
- `src/orchestrator/lifecycle/source-state.provider.ts`
- `src/orchestrator/storage/lifecycle-storage.types.ts`
- `src/orchestrator/storage/session-authority.repository.ts`

Tests:

- `tests/checkpoint.service.test.ts`
- `tests/child-workflow.test.ts`
- `tests/lifecycle-command-processor.test.ts`
- `tests/lifecycle-contracts.test.ts`
- `tests/source-state.provider.test.ts`
- `tests/support/lifecycle-fixtures.ts`

## RED/GREEN Evidence

1. The initial behavioral RED used dynamic test seams and failed because the checkpoint service/source-state provider behavior was absent. Minimal contract and service implementation made the original checkpoint cases green.
2. Checkpoint-age coverage failed 1/12 with `checkpointAgeDiagnosticV1` undefined. The pure diagnostic implementation made the suite green without adding an event surface.
3. Review assertions covered the second checkpoint crash seam, exact store replay before enrichment, relevant-child summary drift, exact 4,000-scalar/200-interval boundaries, external schemes, exact Git arguments, descriptor exclusion, committed temp tuple mismatch, and every post-transition marker.
4. A review regression exposed non-Git files being read before the aggregate byte bound. The provider now rejects an oversized file from metadata, streams accepted files in 64 KiB chunks under the remaining budget, and caps traversed nodes before descent; the source-state suite passed 12/12.
5. Exact checkpoint retry is proven through the real `LifecycleCommandStore`: replay returns the stored response after `BEGIN IMMEDIATE`/`ROLLBACK` without constructing transaction facades, capturing source state, or invoking fresh enrichment.

## Final Verification

- Exact Task 11 focused gate from the brief — PASS, 106/106 tests, 0 failures.
- `npm run typecheck` — PASS, exit 0.
- `npm test` — PASS, 1,246 tests; 1,236 passed; 10 skipped; 0 failed.
- `git diff --check` — PASS, exit 0 (line-ending conversion warnings only).

## Self-Review

- Bounds now have exact acceptance plus over-limit rejection for body bytes, task/result/path scalars, list/material counts, and evidence intervals.
- Redaction rejects raw output, raw commands, environment dumps, secrets, raw evidence, and caller-supplied authoritative checkpoint fields.
- Source capture proves exact fixed Git arguments, bounded output/time, deterministic Git/non-Git witnesses, ordinary-edit sensitivity, linked worktrees, descriptor/store/private/target/temp exclusions, and tuple mismatch failure.
- Checkpoint CAS and both crash seams preserve transactional marker behavior; exact replay bypasses all fresh work.
- Ownership transfer/recovery, suspension, carry-forward claim, and terminal transfer marker semantics are asserted. Relevant child fold drift and stale bases fail closed.
- No migration or public schema was changed. Task 12 remains the owner of non-empty evidence-coverage ingestion; Task 11 records the honest coverage-only empty state where no evidence adapter is yet present.

## Concerns

None blocking.

## Post-Review Hardening Wave

The blocking review findings were resolved in a test-first follow-up:

- `CheckpointService.record` now calls the repository's full latest-checkpoint verifier before enrichment or any checkpoint-index overwrite. An indexed event/ID/position/fingerprint mismatch therefore fails with `INTEGRITY_FAILURE` and leaves the existing authority state untouched.
- Root suspension uses the same exported trusted checkpoint-draft validator as standalone checkpoint recording. Project-relative file, artifact, and source paths are containment-checked through existing filesystem components, and every persisted `filesTouched[].branchRef` must exactly equal the worker-captured source witness.
- Suspension now appends all three committed events before its authority/index/marker CAS and lease renewal. The post-append callback verifies the committed global positions and performs the final authority mutation in the same command transaction. A first-insert fault observes the original active authority with no checkpoint or marker, and the whole command still rolls back.
- Source inventory file capture now uses `O_NOFOLLOW` where the platform exposes it, verifies the opened descriptor with `fstat`, compares pre-open/path/opened identities and file types, revalidates project containment after open, and confirms the descriptor identity/size again after the bounded read. A deterministic `after-lstat-before-open` fault seam proves that replacing an intermediate directory with an escaping junction fails closed.

### Deferred Session-End Boundary

`amend-session-end`, `cancel-session-end`, and `abandon-session` currently have strict command/event contracts, intent witnesses, aggregate fold rules, SQL/integrity representation, and fixed risky-transition names. There is no production session-end command coordinator or worker dispatch path that executes those commands or emits their events in this subproject. Consequently there is no callable transition on which to install the shared pre-transition checkpoint guard yet; doing so here would fabricate the coordinator owned by the later session-end work. That future coordinator must call `requireRiskyTransitionCheckpointV1` before each of those three transitions.

### RED/GREEN and Final Verification

- RED: the directly affected focused run executed 59 tests with 54 passing and exactly 5 intended failures: corrupt prior checkpoint fingerprint, caller-selected file branch, pre-append suspension authority mutation, suspension junction escape, and the lstat/open junction substitution seam.
- GREEN: directly affected focused gate — PASS, 59/59 tests, 0 failures.
- Prescribed five-file Task 11 gate after the first hardening wave — PASS, 110/110 tests, 0 failures. This corrects the prior 122 figure, which included suite headings instead of reporting only the prescribed gate's Node test count.
- `npm run typecheck` — PASS, exit 0.
- `npm test` — PASS, 1,250 tests; 1,240 passed; 10 skipped; 0 failed.

## Child Checkpoint Integrity Follow-Up

The final call-site audit found four places where a nonterminal child was folded and its latest checkpoint ID was trusted without verifying the indexed checkpoint event and fingerprint. Each path now calls the repository's full `latestCheckpoint(child)` verifier before folding or using the child aggregate:

- root checkpoint and final-checkpoint child-summary enrichment;
- root suspension child-summary enrichment;
- root ownership-transfer/recovery risky-transition child collection; and
- carry-forward claim risky-transition child collection.

No mismatch is repaired implicitly. A corrupt child checkpoint index fails with `INTEGRITY_FAILURE` before source capture or any event, checkpoint index, marker, authority, lease, deduplication, or transfer-ticket mutation.

### Follow-Up RED/GREEN and Verification

- RED: direct affected run — 35 tests; 32 passed and exactly 3 intended corrupt-child-fingerprint regressions failed because no exception was raised.
- GREEN: direct affected run — PASS, 35/35 tests, 0 failures.
- Exact prescribed five-file Task 11 gate — PASS, 113/113 tests, 0 failures.
- `npm run typecheck` — PASS, exit 0.
- `npm test` — PASS, 1,253 tests; 1,243 passed; 10 skipped; 0 failed.
