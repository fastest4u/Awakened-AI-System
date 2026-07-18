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
