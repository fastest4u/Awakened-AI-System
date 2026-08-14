# Task 14Q.2c Legacy Effective-State Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make historical outer V1/V2 session-end events renderable only when an immutable, hash-bound complete effective-state sidecar has been explicitly backfilled.

**Architecture:** Amend schema-4 migration 0004 with an append-only `lifecycle_legacy_effective_state_sources` table and null-total SQLite guards. Add a focused TypeScript backfill/read module that decodes complete effective state, binds it to an immutable legacy event and committed command witness, and validates the immutable predecessor sidecar for amendments. Feed only the validated state into the existing committed Q2b normalizer; missing or divergent sources remain `INTEGRITY_FAILURE`.

**Tech Stack:** TypeScript 5.8, Node.js 22 test runner, SQLite `DatabaseSync`, canonical JSON, existing lifecycle decoders, SHA-256 event/command hashes.

---

## Task 1: Freeze the red contract and migration surface

**Files:**
- Create: `tests/legacy-effective-state-source.test.ts`
- Modify: `tests/session-end-effective-state-migration.test.ts`
- Modify: `tests/migration-registry.test.ts`

- [ ] **Step 1: Add a valid production-built legacy request fixture and failing source API assertions.**

  Build the lifecycle intent with `buildLifecycleIntentWitness`, insert the
  immutable event and `command_dedup` row through the existing fixture helpers,
  and assert that `persistLegacySessionEndEffectiveStateSourceV1` accepts a
  complete `SessionEndEffectiveStateV1` plus its source bindings. Add the
  missing-source reader assertion first so the current implementation fails
  with `INTEGRITY_FAILURE` for the intended reason.

- [ ] **Step 2: Add migration RED assertions for the sidecar contract.**

  Assert that schema 4 exposes the named table, that a valid sidecar row can be
  inserted only through the strict binding, and that independent raw SQL
  mutations of source hash, command hash, explicit JSON null, update, and
  delete are rejected. Keep the existing 0002/0003 file-hash assertions.

- [ ] **Step 3: Run the focused RED tests.**

  Run:

  ```text
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="legacy effective-state sidecar|schema-4 legacy effective-state source" dist-test/tests/legacy-effective-state-source.test.js dist-test/tests/session-end-effective-state-migration.test.js
  ```

  Expected result: the new source API/table assertions fail because the sidecar
  table and reader seam do not exist; pre-existing tests remain green.

## Task 2: Implement the immutable sidecar schema and strict source module

**Files:**
- Create: `src/orchestrator/storage/legacy-session-end-effective-state-source.ts`
- Modify: `src/orchestrator/storage/migrations/0004-session-end-effective-state.ts`

- [ ] **Step 1: Add the smallest schema-4 table, indexes, and immutable guards.**

  Add strict columns for the fields in the approved spec, a composite primary
  key, command uniqueness, exact source-position lookup, append-only update and
  delete triggers, and a null-total insert guard joining `events` to
  `command_dedup`. Require legacy event type/schema, root stream, index zero,
  matching workflow identity, canonical-valid bounded JSON, lower-case hashes,
  and paired predecessor nullability.

- [ ] **Step 2: Add strict DTO decoding and hash-bound persistence.**

  Implement `persistLegacySessionEndEffectiveStateSourceV1` and
  `readLegacySessionEndEffectiveStateSourceV1`. Decode the complete state with
  `decodeSessionEndEffectiveStateV1`, canonicalize the stored JSON, validate
  event/command/witness bindings, require a prior sidecar row for generation
  greater than one, and reject any mismatch with `INTEGRITY_FAILURE`.

- [ ] **Step 3: Run the source RED tests to GREEN.**

  Run the exact focused test command from Task 1. Expected result: the valid
  request/source control passes and each independent mutation fails at the
  intended schema or TypeScript integrity boundary.

## Task 3: Integrate committed Q2b normalization

**Files:**
- Modify: `src/orchestrator/materialization/sqlite-lifecycle-render-closure.reader.ts`
- Modify: `src/orchestrator/materialization/lifecycle-render-event.ts`
- Modify: `tests/lifecycle-render-closure.reader.test.ts`

- [ ] **Step 1: Add the failing committed legacy request and amendment cases.**

  Assert that an authenticated legacy request with a valid sidecar exposes its
  decoded effective state after witness stripping, that an amendment validates
  its predecessor/evidence transition, and that missing or divergent sidecar
  rows fail closed. Keep V3 fixtures unchanged.

- [ ] **Step 2: Load sidecar state during command authentication.**

  Extend the authenticated command seam with an optional decoded legacy state.
  After the existing command/witness/hash checks, read the exact source row for
  legacy index-zero request/amendment events and validate its predecessor. Do
  not query mutable workflow or validation projection rows.

- [ ] **Step 3: Consume only the authenticated state in legacy semantics.**

  Make `legacySemantics` use the authenticated sidecar state for outer V1/V2
  events and retain `INTEGRITY_FAILURE` when it is absent. Preserve the
  existing event-authoritative V3 path and all output DTO keys.

- [ ] **Step 4: Run the exact reader tests to GREEN.**

  Run:

  ```text
  npm run test:build
  node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="legacy|authenticated|effective state" dist-test/tests/lifecycle-render-closure.reader.test.js
  ```

## Task 4: Consolidate migration/preflight and adversarial coverage

**Files:**
- Modify: `tests/legacy-effective-state-source.test.ts`
- Modify: `tests/session-end-effective-state-migration.test.ts`
- Modify: `tests/migration-registry.test.ts`
- Modify: `docs/superpowers/specs/2026-08-14-task-14q-2c-legacy-effective-state-sidecar-contract-design.md`

- [ ] **Step 1: Add explicit-null-total and production-decoder controls.**

  Derive hostile rows from a valid witness/state control, assert explicit JSON
  nulls reject, and verify the schema guard never depends on a command key that
  the production lifecycle decoder does not accept.

- [ ] **Step 2: Verify schema and frozen-source invariants.**

  Assert the migration checksum update is intentional, migrations 0002/0003
  retain their exact existing hashes, the sidecar lookup uses the source
  position index, and no mutable workflow fallback appears in the reader.

- [ ] **Step 3: Run the focused consolidation gates.**

  Run `npm run test:build`, `npm run typecheck`, the legacy-source, migration,
  reader, renderer, lifecycle-contract, and materialization-queue tests, then
  run `git diff --check` and targeted `rg` scans for mutable fallback and
  accidental edits to migration 0002/0003.

## Task 5: Final review and branch handoff

**Files:**
- No additional production files; review the complete branch diff.

- [ ] **Step 1: Dispatch a spec-compliance reviewer.**

  Confirm every approved design clause and every plan task is represented in
  code/tests, especially missing-backfill fail-closed behavior and amendment
  predecessor binding. Resolve all findings before quality review.

- [ ] **Step 2: Dispatch a code-quality reviewer.**

  Review error boundaries, canonical JSON/hash handling, SQL null-totality,
  index usage, type ownership, and scope. Resolve all Important/Critical
  findings and rerun focused tests.

- [ ] **Step 3: Run final verification and record handoff.**

  Verify clean intended scope, typecheck/build/tests/diff checks, then use the
  finishing-a-development-branch workflow for the branch handoff without
  rewriting unrelated user changes.
