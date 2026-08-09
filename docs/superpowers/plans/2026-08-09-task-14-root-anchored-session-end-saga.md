# Task 14 Root-Anchored Session-End Saga Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Approach A session-end workflow through a durable `ending-materialization-queued` boundary, including schema 4, event-carried effective state, one-child-at-a-time carry-forward, and deterministic lifecycle outbox planning without enabling Version 2 production routing.

**Architecture:** A root `SessionEndRequested` Version 3 event anchors one deterministic workflow UUID and one bounded effective-state snapshot. A coordinator advances at most one durable action per drive, delegating child carry-forward to a dedicated child-targeted internal semantic command. Task 14Q plans compatibility-log bytes and inserts the immutable lifecycle outbox row atomically with the triggering event; Task 15 later validates and appends terminal semantics, while Task 16 alone owns mutable claims, filesystem replacement, and acknowledgement.

**Tech Stack:** TypeScript 5.8, Node.js 22 test runner, SQLite migrations/transactions, canonical JSON, Node `crypto`, existing lifecycle semantic/operational stores and worker runtime.

---

## Authority, prerequisite, and execution rules

- Approved design: `docs/superpowers/specs/2026-08-09-task-14-root-anchored-session-end-saga-design.md` at commit `72f4fce6c6a867c96be02b2afbf4506447c6964e`.
- Parent plan: `docs/superpowers/plans/2026-07-14-root-child-lifecycle-and-checkpoints.md`; its amended Task 14-16 boundaries are authoritative over the superseded prose in older `.superpowers/sdd/task-*.md` briefs.
- Execute slices in strict order: **14M → 14Q → 14R → 14S → 14W**. Within a slice, execute tasks in order unless the plan explicitly permits independent test-only preparation.
- Start every slice from a clean tracked worktree and the prior slice's reviewed commit. Do not stage ignored `.superpowers` reports.
- Use fresh implementer and fresh spec/quality reviewers for every slice. Resolve all Critical and Important findings before starting the next slice.
- Use strict RED → GREEN for each named behavior. A compile failure is not the behavioral RED: add the smallest typed scaffold, rebuild, then run the exact named test and record its intended assertion failure.
- Cap any repeated focused run at five attempts unless systematic debugging identifies and fixes a deterministic cause. Do not hide flaky or over-cap runs.
- Do not run the full `npm test` until Task 14W. Earlier slices use only the focused commands listed here.
- Keep migrations 0002 and 0003 byte-for-byte frozen. Never edit their source or regenerate their hashes.
- Do not enable public Version 2 routing, validation execution, or filesystem materialization.

### Mandatory per-behavior micro-cycle

Any checklist item that lists several cases is a manifest, not permission to batch production code. For each named case, repeat this exact 2-5 minute loop before moving to the next case:

1. add one valid control and one minimal failing assertion;
2. run `npm run test:build`;
3. run only that exact test name and record the intended RED assertion;
4. make the smallest production change for that assertion;
5. rerun only that exact test to GREEN; and
6. refactor only while the exact test remains green.

The grouped commands below are consolidation gates after every constituent case has already completed its own RED → GREEN loop.

### Specification coverage map

| Approved design sections | Owning plan tasks |
|---|---|
| 4-5 identities and event-carried effective state | 14M.1-14M.2 |
| 6 migration 0004, compatibility, fingerprints, integrity | 14M.3-14M.5 |
| 7 six-key stored plan codec/overlays | 14M.4; Task 15 constructs and persists plans |
| 8 request transaction | 14R.1-14R.2 |
| 9 root-anchored per-child saga | 14S.1-14S.2 |
| 9.4 bounded all-history resolution | 14S.3 |
| 10-11 amendment, cancellation, reopening | 14R.3 |
| 12 final checkpoint/frozen scope | 14S.3 |
| 13 deterministic queue planning | 14Q.1-14Q.6 and 14S.3 integration |
| 14 Task 15/16 boundaries | amended parent Tasks 15-16 |
| 15-17 phase/runtime/error ownership | 14R-14W |
| 18 crash/replay acceptance matrix | 14W.2 |
| 19 decomposition and 20 parent amendments | this plan and amended parent plan |

## Frozen constants and cross-slice invariants

```ts
export const SESSION_END_WORKFLOW_NAMESPACE =
  "4af569cd-c120-5fc1-874a-d4640afc5977";
export const SESSION_END_EFFECTIVE_STATE_MAX_CANONICAL_BYTES = 1_048_576;
export const SESSION_END_VALIDATION_PLANS_MAX_CANONICAL_BYTES = 262_144;
export const MAX_ROOT_CHILD_HISTORY_V1 = 1_000;
export const COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND =
  "compatibility-session-log";
```

- UUIDv5 name is UTF-8 `session-end/{lowercaseSessionId}`. Golden input `44444444-4444-4444-8444-444444444444` yields `b6c2d359-82a6-567e-86c7-bf9e780cf20b`.
- Migration 0002 hash remains `68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06`; migration 0003 remains `C023A8EDB88A94B749D4837F7300A76D081C843BF41BE058C3AA4AD5D6A158C4`.
- Schema 4 adds migration `0004-session-end-effective-state`; Version 1 remains the production authority.
- `SessionEndRequested`, `SessionEndAmended`, and current cancellation use Version 3. Legacy Version 1/2 event decoding remains immutable, including legacy Version 1 cancellation replay. `ChildWorkTransferCreated` Version 1 remains byte-for-byte unchanged; only the internal Task 14 child path may emit the Version 2 dual-checkpoint transfer.
- Current workflow fingerprint is Version 2. Legacy Version 1 fingerprints remain replayable and are never silently rewritten.
- Every lifecycle materialization projection has `triggeringEventIndex === 0`, every pending descriptor has `eventIndex === 0`, every referenced event has `command_event_index = 0`, and `materializationRevision === triggeringEventPosition`.
- `command_dedup.command_hash` remains the authoritative lifecycle intent hash. The lifecycle target remains in `command_dedup.outbox_order_json`; the descriptor is bound by its canonical payload/content hash, target ordering, actual triggering event, deterministic path/revision/origin, and predecessor fingerprint chain.
- Initial and reopened `SessionEndRequested` never queue materialization.
- Queue planning ends at immutable row confirmation. Task 16 retains claim/renew/takeover/materialize/replace/fsync/private acknowledgement/failure.

## Slice 14M — schema and effective-state foundation

### Task 14M.1: Add deterministic workflow identities and the bounded effective-state codec

**Files:**

- Create: `src/orchestrator/lifecycle/session-end-identifiers.ts`
- Create: `src/orchestrator/crypto/uuid-v5.ts`
- Create: `src/orchestrator/lifecycle/session-end-effective-state.ts`
- Create: `tests/session-end-identifiers.test.ts`
- Create: `tests/session-end-effective-state.test.ts`
- Create: `tests/support/session-end-effective-state-reference.ts`
- Modify: `src/orchestrator/lifecycle/contracts/session-end.ts`
- Modify: `tests/lifecycle-contracts.test.ts`

- [ ] **Step 1: Write the identity RED tests**

Add the RFC 4122 UUIDv5 reference vectors, the frozen session vector, lowercase-only session input, deterministic internal phase command IDs, and automatic transfer-ticket IDs. Compute expected UUID bytes independently in the test with Node `createHash("sha1")`; do not import the production derivation into the reference path.

```ts
it("derives RFC and session-end UUIDv5 golden vectors", () => {
  assert.equal(
    sessionEndWorkflowId(asSessionId("44444444-4444-4444-8444-444444444444")),
    "b6c2d359-82a6-567e-86c7-bf9e780cf20b",
  );
  assert.throws(
    () => sessionEndWorkflowId("44444444-4444-4444-8444-44444444444A" as SessionId),
    hasCode("LIFECYCLE_INPUT_INVALID"),
  );
});
```

- [ ] **Step 2: Run the identity RED, then implement only identity derivation**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^derives RFC and session-end UUIDv5 golden vectors$" dist-test/tests/session-end-identifiers.test.js
```

Implement one local RFC 4122 UUIDv5 byte routine in `src/orchestrator/crypto/uuid-v5.ts` and domain-specific exported helpers in `session-end-identifiers.ts`. Set version/variant bits explicitly, accept only strict lowercase UUIDs, and zero transient name/hash buffers in `finally`.

- [ ] **Step 3: Write the effective-state RED tests**

Cover exact keys, canonical sorting, deep freeze, strict request/policy/context correlation, hash stability, own `__proto__` preservation/rejection, 1,048,576 UTF-8 bytes accepted, 1,048,577 rejected, and multibyte fixtures whose scalar count differs from byte count.

```ts
it("strictly decodes and hashes bounded effective state at exact UTF-8 cap", () => {
  const exact = effectiveStateAtCanonicalBytes(SESSION_END_EFFECTIVE_STATE_MAX_CANONICAL_BYTES);
  assert.deepEqual(decodeSessionEndEffectiveStateV1(exact), exact);
  assert.match(sessionEndEffectiveStateHashV1(exact), /^[0-9a-f]{64}$/);
  assert.throws(
    () => decodeSessionEndEffectiveStateV1(effectiveStateAtCanonicalBytes(1_048_577)),
    hasCode("LIFECYCLE_INPUT_INVALID"),
  );
});
```

- [ ] **Step 4: Run the codec RED, then implement the exact approved snapshot**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^strictly decodes and hashes bounded effective state at exact UTF-8 cap$" dist-test/tests/session-end-effective-state.test.js
```

Implement `SessionEndEffectiveStateV1`, its exact-key decoders, canonical UTF-8 cap, domain-separated SHA-256 hash, immutable policy/context fields, and evidence-window/context correlation helpers from design sections 5.1-5.4. Reuse existing strict canonical JSON helpers; copy own properties with descriptors so `__proto__` cannot disappear.

```ts
export interface PersistedQualityPolicyInputV1 {
  readonly qualityPolicyVersion: 1;
  readonly profiles: readonly QualityProfileV1[];
  readonly qualityThreshold: number;
  readonly requireFullEvidence: boolean;
  readonly requireMaterialization: boolean;
}

export interface SessionEndEffectiveStateV1 {
  readonly effectiveStateVersion: 1;
  readonly effectiveStateDomain: "project-memory/session-end-effective-state/v1";
  readonly request: SessionEndRequestV1 | SessionEndRequestV2;
  readonly effectivePolicy: PersistedQualityPolicyInputV1;
  readonly effectiveFinalCheckpoint: CheckpointDraftV1 | CheckpointDraftV2;
  readonly effectiveStateHash: string;
}
```

Hash the canonical object without `effectiveStateHash` behind the exact prefix `project-memory/session-end-effective-state/v1\n`. `totalEffectiveWeight` is derived, never persisted, and the canonical request draft must byte-equal `effectiveFinalCheckpoint`.

- [ ] **Step 5: Run 14M.1 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-identifiers.test.js dist-test/tests/session-end-effective-state.test.js dist-test/tests/lifecycle-contracts.test.js
npm run typecheck
git add src/orchestrator/crypto/uuid-v5.ts src/orchestrator/lifecycle/session-end-identifiers.ts src/orchestrator/lifecycle/session-end-effective-state.ts src/orchestrator/lifecycle/contracts/session-end.ts tests/session-end-identifiers.test.ts tests/session-end-effective-state.test.ts tests/support/session-end-effective-state-reference.ts tests/lifecycle-contracts.test.ts
git commit -m "feat: define session end effective state"
```

### Task 14M.2: Add current event codecs without weakening legacy replay

**Files:**

- Modify: `src/orchestrator/lifecycle/contracts/events.ts`
- Modify: `src/orchestrator/lifecycle/session-aggregate.ts`
- Modify: `tests/lifecycle-contracts.test.ts`
- Modify: `tests/session-aggregate.test.ts`

- [ ] **Step 1: Write the current/legacy event matrix RED**

Add table-driven cases for request/amend Version 1/2 replay, cancellation Version 1 replay, explicit cancellation Version 2 rejection, exact Version 3 current payloads, strict G+1 cancellation, and canonical G1 request → G2 cancel → G3 reopen. Add a separate matrix proving `ChildWorkTransferCreated` Version 1 is unchanged and Version 2 has exactly `transferTicketId`, `suspensionCheckpointId`, `checkpointId`, and `authorityCommitment`.

```ts
it("keeps legacy request amend cancel decoders and accepts only V3 current events", () => {
  assertLegacyFixturesDecodeByteForByte();
  assert.deepEqual(decodeLifecycleEvent(requestedV3()), requestedV3());
  assert.throws(() => decodeLifecycleEvent(requestedV3({ unknown: true })), hasCode("LIFECYCLE_INPUT_INVALID"));
});

it("keeps ChildWorkTransferCreated V1 frozen and admits only the internal V2 dual-checkpoint shape", () => {
  assert.deepEqual(decodeLifecycleEvent(legacyTransferV1()), legacyTransferV1());
  assert.equal(decodeLifecycleEvent(internalTransferV2()).eventSchemaVersion, 2);
});
```

- [ ] **Step 2: Run the exact RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(keeps legacy request amend cancel decoders and accepts only V3 current events|keeps ChildWorkTransferCreated V1 frozen and admits only the internal V2 dual-checkpoint shape)$" dist-test/tests/lifecycle-contracts.test.js dist-test/tests/session-aggregate.test.js
```

- [ ] **Step 3: Implement only codec/type dispatch and aggregate compatibility**

Add Version 3 payload types and strict decoders. Request and amendment Version 3 carry the complete effective snapshot/hash; cancellation Version 3 carries no snapshot and the generation fold inherits the predecessor effective-state pointer/hash. Preserve request/amend Version 1/2 and cancellation Version 1 decoder branches exactly, and reject cancellation Version 2. Add Version 2 transfer decoding, but do not yet allow public creation or implement ticket/projection semantics; that belongs to 14S. Aggregate replay may retain the two checkpoint IDs so later 14S dispatch can validate them, while Version 1 retains its original single-checkpoint meaning.

- [ ] **Step 4: Run 14M.2 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-contracts.test.js dist-test/tests/session-aggregate.test.js
npm run typecheck
git add src/orchestrator/lifecycle/contracts/events.ts src/orchestrator/lifecycle/session-aggregate.ts tests/lifecycle-contracts.test.ts tests/session-aggregate.test.ts
git commit -m "feat: version session end lifecycle events"
```

### Task 14M.3: Add migration 0004 and its read-only compatibility preflight

**Files:**

- Create: `src/orchestrator/storage/migrations/0004-session-end-effective-state.ts`
- Create: `src/orchestrator/storage/session-end-effective-state-migration-preflight.ts`
- Create: `tests/session-end-effective-state-migration.test.ts`
- Modify: `src/orchestrator/storage/migrations/registry.ts`
- Modify: `src/orchestrator/storage/schema-compatibility.ts`
- Modify: `src/orchestrator/storage/migration-runner.ts`
- Modify: `src/orchestrator/storage/project-store-upgrade.service.ts`
- Modify: `tests/migration-registry.test.ts`
- Modify: `tests/migration-runner.test.ts`
- Modify: `tests/project-store-upgrade.test.ts`
- Modify: `tests/qualified-checkpoint-migration.test.ts`

- [ ] **Step 1: Write migration/preflight RED tests against schema 3 fixtures**

Cover each requirement in design section 6.5 with its own RED: terminal-only compatible history; every nonterminal legacy workflow; strict-valid disallowed outer versions; schema-1/2/3 pending migration rollback; unsorted plans and independent duplicate profile/run/result/command/idempotency identities; plan byte over-cap; exact 1,000 and 1,001 direct-child and source-ticket histories; duplicate/invalid ticket lineage; exact/cap-plus-one effective snapshots; no staging table or migration-3 sealed-stage assertion for Version 4; every generic Version 4 fault boundary; hostile raw SQL against snapshot/generation/plan/fold guards; and frozen 0002/0003 hashes.

```ts
it("rejects schema-3 nonterminal workflows with zero writes", () => {
  const before = snapshotDatabase(connection);
  assert.throws(
    () => upgradeToCurrent(connection),
    hasCode("MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED"),
  );
  assert.deepEqual(snapshotDatabase(connection), before);
});

it("rejects every independent schema-4 validation-plan preflight violation", () => {
  for (const hostile of schema4PlanPreflightViolations()) {
    assertMigration4PreflightRollsBack(hostile);
  }
});

it("accepts exactly 1000 and rejects 1001 lifetime child and ticket rows", () => {
  assertSchema4HistoryBoundary({ directChildren: 1_000, sourceTickets: 1_000 }, "accepted");
  assertSchema4HistoryBoundary({ directChildren: 1_001, sourceTickets: 1_000 }, "rejected");
  assertSchema4HistoryBoundary({ directChildren: 1_000, sourceTickets: 1_001 }, "rejected");
});
```

- [ ] **Step 2: Run the migration RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(applies migration 0004 and preserves frozen 0002 0003 hashes|rejects schema-3 nonterminal workflows with zero writes|rejects strict-valid disallowed outer versions before schema 4|upgrades compatible terminal history without rewriting events|rolls schema 1 2 and 3 back when migration-4 preflight fails|rejects every independent schema-4 validation-plan preflight violation|accepts exactly 1000 and rejects 1001 lifetime child and ticket rows|measures schema-4 effective snapshots by exact UTF-8 bytes|keeps migration-4 preflight read-only and outside migration-3 staging|runs every generic migration-4 fault boundary|blocks hostile raw SQL from schema-4 lifecycle guards)$" dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/migration-registry.test.js dist-test/tests/migration-runner.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/qualified-checkpoint-migration.test.js
```

- [ ] **Step 3: Implement schema 4 overlays and preflight**

Migration 0004 must add the approved snapshot/hash/fingerprint/plan columns, exact canonical/byte/nullability overlays, lifecycle outbox descriptor overlays, lifetime child/ticket guards and unique source-child ticket index. It must not rewrite historical lifecycle events. The preflight interface is exact:

```ts
export interface SessionEndEffectiveStateMigrationPreflight {
  assertEligible(connection: SqliteConnection, context: ProjectContext): void;
}
```

It runs inside the existing `BEGIN IMMEDIATE` after the pre-hook lease renewal and before the second renewal and migration 4 SQL. Preserve both renewals and their ordering. In the runner catch, roll back first, then apply `sessionEndEffectiveStateMigrationFailure(error) ?? qualifiedCheckpointMigrationFailure(error) ?? error`; each normalizer recognizes only its own approved surface and the original error otherwise remains authoritative.

Change the migration hook deliberately:

```ts
if (migration.version === 3) {
  this.#qualifiedCheckpointPreflight.assertEligibleAndStage(connection, context);
}
if (migration.version === 4) {
  this.#sessionEndPreflight.assertEligible(connection, context);
}
```

Do not collapse Version 3's staged preflight and Version 4's read-only preflight into one interface. Preserve original-error precedence on rollback.

- [ ] **Step 4: Run 14M.3 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/migration-registry.test.js dist-test/tests/migration-runner.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/qualified-checkpoint-migration.test.js
npm run typecheck
git diff --exit-code 72f4fce -- src/orchestrator/storage/migrations/0002-session-lifecycle.ts src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts
git add src/orchestrator/storage/migrations/0004-session-end-effective-state.ts src/orchestrator/storage/session-end-effective-state-migration-preflight.ts src/orchestrator/storage/migrations/registry.ts src/orchestrator/storage/schema-compatibility.ts src/orchestrator/storage/migration-runner.ts src/orchestrator/storage/project-store-upgrade.service.ts tests/session-end-effective-state-migration.test.ts tests/migration-registry.test.ts tests/migration-runner.test.ts tests/project-store-upgrade.test.ts tests/qualified-checkpoint-migration.test.ts
git commit -m "feat: migrate session end effective state"
```

### Task 14M.4: Add workflow fingerprint V2, snapshot folds, and the six-key plan storage seam

**Files:**

- Create: `src/orchestrator/storage/session-end.repository.ts`
- Create: `tests/session-end.repository.test.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-projection-folds.ts`
- Modify: `src/orchestrator/storage/lifecycle-projection.repository.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-intent-witness.ts`
- Modify: `tests/lifecycle-projection-folds.test.ts`
- Modify: `tests/lifecycle-intent.test.ts`

- [ ] **Step 1: Write fingerprint/snapshot/plan RED tests**

Use independent golden preimages for initial V2, Version-1-to-Version-2, and Version-2-to-Version-2 predecessor chains. Mutate each preimage field independently. Add repository tests for event-position hydration, exact snapshot/hash agreement, binary profile ordering, unique `(profileId, profileVersion)`, 1..64 entries, and exact 262,144/262,145-byte plan limits.

The persisted entry is exactly:

```ts
export interface PersistedValidationAttemptPlanV1 {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly runId: string;
  readonly resultId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
}
```

There is no persisted `profileConfigurationHash`; Task 15 derives and verifies it from the immutable trusted registry while expanding this six-key entry into the public 18-key identity. Uniqueness covers the profile tuple plus `runId`, `resultId`, `commandId`, and `idempotencyKey`.

Workflow fingerprint V2 uses prefix `project-memory/lifecycle/workflow-generation/v2\n` and this exact canonical array order:

```text
[
  projectId,
  workflowId,
  workflowGeneration as canonical decimal string,
  sessionId,
  triggerEventPosition as canonical decimal string,
  triggerEventHash,
  rootCommandId,
  evidenceWindowState,
  replacementCheckpointVersion,
  effectiveCheckpointVersion,
  effectiveDraftSourceEventPosition as canonical decimal string,
  effectiveStateSourceEventPosition as canonical decimal string or null,
  effectiveStateVersion,
  effectiveStateHash,
  previousFingerprintSchemaVersion,
  previousFingerprint
]
```

The initial V2 pair is null/null; a V1 predecessor contributes `1` plus its frozen V1 fingerprint; a V2 predecessor contributes `2` plus its V2 fingerprint. `triggerEventHash` and predecessor version come only from exact immutable rows.

```ts
it("computes exact V2 workflow-generation fingerprint predecessor chains", () => {
  assert.equal(workflowFingerprintV2(initialFixture), INITIAL_V2_GOLDEN);
  assert.equal(workflowFingerprintV2(fromV1Fixture), V1_TO_V2_GOLDEN);
  assert.equal(workflowFingerprintV2(fromV2Fixture), V2_TO_V2_GOLDEN);
});

it("strictly decodes the six-key persisted validation plan and rejects ordering identity cap violations", () => {
  assert.deepEqual(decodePersistedValidationPlansV1(validPlans()), validPlans());
  for (const hostile of invalidPlanFixtures()) {
    assert.throws(() => decodePersistedValidationPlansV1(hostile), hasCode("INTEGRITY_FAILURE"));
  }
});
```

- [ ] **Step 2: Run the focused RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(computes exact V2 workflow-generation fingerprint predecessor chains|strictly decodes the six-key persisted validation plan and rejects ordering identity cap violations)$" dist-test/tests/session-end.repository.test.js dist-test/tests/lifecycle-projection-folds.test.js
```

- [ ] **Step 3: Implement immutable repository hydration and folds**

Keep storage transaction ownership outside the repository. Expose connection-taking storage methods and connection-bound facades separately. Store only the approved six keys per validation attempt; Task 15 expands derived run/result/command/idempotency identities deterministically. Decode event-carried snapshots from the exact triggering event, cross-check authoritative intent and workflow row, and fail closed on malformed or mixed-version state.

- [ ] **Step 4: Run 14M.4 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end.repository.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/lifecycle-intent.test.js
npm run typecheck
git add src/orchestrator/storage/session-end.repository.ts src/orchestrator/lifecycle/lifecycle-projection-folds.ts src/orchestrator/storage/lifecycle-projection.repository.ts src/orchestrator/lifecycle/lifecycle-intent-witness.ts tests/session-end.repository.test.ts tests/lifecycle-projection-folds.test.ts tests/lifecycle-intent.test.ts
git commit -m "feat: bind session end workflow generations"
```

### Task 14M.5: Extend schema/integrity/bootstrap authority to version 4

**Files:**

- Modify: `src/orchestrator/integrity/lifecycle-integrity.service.ts`
- Modify: `src/orchestrator/storage/project-store-bootstrap.service.ts`
- Modify: `src/orchestrator/runtime/project-store-upgrade-phase-runner.ts`
- Modify: `tests/qualified-checkpoint-quick-integrity.test.ts`
- Modify: `tests/qualified-checkpoint-full-integrity.test.ts`
- Modify: `tests/project-store-bootstrap.test.ts`
- Modify: `tests/project-store-upgrade-phase-runner.test.ts`
- Modify: `tests/support/current-project-store-schema.ts`
- Modify: `scripts/smoke-worker.js`

- [ ] **Step 1: Write integrity and bundled-upgrade RED tests**

Add exact corruptions for event snapshot versus intent, workflow row versus trigger, V2 predecessor fingerprint, six-key plans, schema-4 lifetime guards, and lifecycle outbox overlay shape. Require bootstrap to install schema 4 directly and bundled upgrade to apply `[2, 3, 4]` with the existing worker phase protocol.

- [ ] **Step 2: Run RED anchors, then implement the minimum integrity dispatch**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(quick full integrity detects snapshot fold workflow disagreement|bundled upgrade applies 2 3 4)$" dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js
```

Do not yet implement the Version 2 transfer ticket's semantic lineage dispatch; 14S owns aggregate/projection/ticket-claim validation because it lands with the only producer. 14M integrity covers codec/schema validity and effective-state/workflow/fingerprint consistency.

- [ ] **Step 3: Run the complete 14M gate**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-identifiers.test.js dist-test/tests/session-end-effective-state.test.js dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/session-end.repository.test.js dist-test/tests/lifecycle-contracts.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/lifecycle-intent.test.js dist-test/tests/migration-registry.test.js dist-test/tests/migration-runner.test.js dist-test/tests/qualified-checkpoint-migration.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
npm run typecheck
npm run build
npm run test:build-artifacts
git diff --check
git diff --exit-code 72f4fce -- src/orchestrator/storage/migrations/0002-session-lifecycle.ts src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts
```

- [ ] **Step 4: Commit and review slice 14M**

```powershell
git add src/orchestrator/integrity/lifecycle-integrity.service.ts src/orchestrator/storage/project-store-bootstrap.service.ts src/orchestrator/runtime/project-store-upgrade-phase-runner.ts tests/qualified-checkpoint-quick-integrity.test.ts tests/qualified-checkpoint-full-integrity.test.ts tests/project-store-bootstrap.test.ts tests/project-store-upgrade-phase-runner.test.ts tests/support/current-project-store-schema.ts scripts/smoke-worker.js
git commit -m "feat: verify schema 4 lifecycle state"
git status --short
```

Request fresh spec and quality reviews over the complete 14M commit range. Do not start 14Q until both approve with no Critical/Important findings.

## Slice 14Q — deterministic queue-planning prerequisite

### Normative compatibility-log byte grammar

Task 14Q freezes the literal renderer contract before production code. The renderer projection has these exact DTOs; all records are strict own-data, exact-key, deeply frozen canonical JSON:

```ts
export interface CompatibilityLogIdentityV2 {
  readonly documentVersion: 2;
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly branchScopeId: BranchScopeId | null;
  readonly branchRef: string | null;
  readonly sessionId: SessionId;
  readonly startedAt: string;
}

export interface CompatibilityLogSourceV2 {
  readonly streamId: `session/${SessionId}`;
  readonly streamType: "session";
  readonly startEventPosition: string;
  readonly throughEventPosition: string;
}

export interface CompatibilityLogLifecycleV2 {
  readonly rootState: "active" | "suspended" | "ending" | "abandoned" | "ended";
  readonly workflowId: WorkflowId | null;
  readonly workflowGeneration: number | null;
  readonly childEndPolicy: ChildEndPolicy | null;
  readonly evidenceWindowState: "open" | "sealed" | null;
}

export type CompatibilityLogReportCategoryV2 =
  | "findings"
  | "proposedDecisions"
  | "filesObservedOrChanged"
  | "verificationPerformed"
  | "openFollowUps"
  | "blockers";

export interface CompatibilityLogAcceptedChildItemV2 {
  readonly childSessionId: SessionId;
  readonly reportId: ReportId;
  readonly category: CompatibilityLogReportCategoryV2;
  readonly itemIndex: number;
  readonly itemId: ReportItemId;
  readonly summary: string;
  readonly evidenceReferences: readonly string[];
  readonly confidence: MaterialConfidence;
}

export type CompatibilityLogUnresolvedFollowUpV2 =
  | {
      readonly kind: "deferred-child-item" | "rejected-child-item";
      readonly sourceChildSessionId: SessionId;
      readonly reportId: ReportId;
      readonly category: CompatibilityLogReportCategoryV2;
      readonly itemIndex: number;
      readonly itemId: ReportItemId;
      readonly summary: string;
      readonly evidenceReferences: readonly string[];
      readonly confidence: MaterialConfidence;
    }
  | {
      readonly kind: "carry-forward-ticket";
      readonly sourceChildSessionId: SessionId;
      readonly transferTicketId: TransferTicketId;
      readonly checkpointId: CheckpointId;
      readonly blockers: readonly string[];
      readonly followUps: readonly string[];
    };

export interface CompatibilityLogQualifiedEvidenceCoverageV2 {
  readonly coverageVersion: 2;
  readonly captureMode: "coverage-only";
  readonly contentRetained: false;
  readonly adapterSessions: readonly {
    readonly adapterSessionId: AdapterSessionId;
    readonly coverageFirstOrdinal: "0";
    readonly coverageLastOrdinal: string;
    readonly highestContiguousOrdinal: string | null;
    readonly missingIntervals: readonly MissingOrdinalIntervalV1[];
    readonly latestBatchId: EvidenceBatchId;
    readonly latestBatchEventPosition: string;
  }[];
}

export type CompatibilityLogFinalCheckpointV2 =
  | {
      readonly checkpointFingerprint: string;
      readonly checkpoint: Omit<CheckpointV1, "evidenceCoverage"> & {
        readonly evidenceCoverage: CheckpointEvidenceCoverageV1;
      };
    }
  | {
      readonly checkpointFingerprint: string;
      readonly checkpoint: Omit<CheckpointV2, "evidenceCoverage"> & {
        readonly evidenceCoverage: CompatibilityLogQualifiedEvidenceCoverageV2;
      };
    };

export interface CompatibilityLogValidationV2 {
  readonly verificationStatus: "not-run" | "passed" | "failed" | "invalidated";
  readonly validationResultIds: readonly ValidationResultId[];
  readonly qualityScore: number | null;
  readonly safeFailureCode: string | null;
  readonly results: readonly ValidationResultV1[];
}

export interface CompatibilityLogMaterializationV2 {
  readonly artifactKind: "compatibility-session-log";
  readonly artifactPath: string;
  readonly targetKey: string;
  readonly materializationRevision: string;
  readonly triggeringEventType: LifecycleMaterializationTriggerType;
  readonly triggeringEventSchemaVersion: number;
  readonly triggeringEventPosition: string;
  readonly triggeringPayloadHash: string;
}

export interface CompatibilityLogProjectionV2 {
  readonly identity: CompatibilityLogIdentityV2;
  readonly source: CompatibilityLogSourceV2;
  readonly lifecycle: CompatibilityLogLifecycleV2;
  readonly acceptedChildren: readonly CompatibilityLogAcceptedChildItemV2[];
  readonly unresolvedFollowUps: readonly CompatibilityLogUnresolvedFollowUpV2[];
  readonly finalCheckpoint: CompatibilityLogFinalCheckpointV2 | null;
  readonly validation: CompatibilityLogValidationV2 | null;
  readonly materialization: CompatibilityLogMaterializationV2;
}
```

Event-to-field mapping is closed:

- `identity`, `source.streamId`, `source.streamType`, and `source.startEventPosition` come only from the first strict committed root `SessionStarted`; `source.streamId` must equal the canonical `session/${identity.sessionId}` and context fields must match every included event. `source.through*` comes from the exact planned/committed trigger.
- `lifecycle` is the strict root aggregate through the candidate trigger plus the already-decoded workflow origin. Request/amend effective state supplies child policy/window; cancellation restores active/suspended; abandonment and end produce their terminal states. Direct abandonment has null workflow/policy/window.
- `acceptedChildren` includes only report items selected by the latest valid accepted/partially-accepted disposition through the trigger. It sorts by binary `(childSessionId, reportId, category, itemIndex, itemId)`.
- `unresolvedFollowUps` includes the complementary deferred/rejected disposition items plus still-unclaimed source-root carry-forward tickets. It sorts by binary `(kind, sourceChildSessionId, reportId-or-transferTicketId, category-or-empty, itemIndex-or-minus-one, itemId-or-empty)`.
- `finalCheckpoint` is the latest strictly bound root checkpoint through the trigger plus the workflow's frozen fingerprint, or null. Version 1 coverage is copied exactly. Version 2 coverage maps only the DTO above, sorted by binary `adapterSessionId`; frame/coverage algorithms, key IDs, domains, fingerprints, and ordinal frames are excluded.
- `validation` follows the exhaustive fold table below. `results` contains only strict retained results for the rendered workflow state and sorts by binary `resultId`; every non-null `validationResultIds` array uses the same order. Committed start/completion times and validation output fingerprint metadata remain because they are semantic event fields, not renderer state.
- `materialization` is derived before rendering from `MaterializationProjectionInputV1` and the exact candidate. It explicitly excludes `expectedPriorFingerprint`, `nextFingerprint`, row `content_hash`, status, attempts, claims, tokens, failure data, and acknowledgement data; including any of them would create a circular or operationally unstable byte contract.
- Every event/checkpoint/materialization position is a positive canonical decimal string; coverage ordinals and stream versions use their existing nonnegative canonical rules. The declared JSON numbers are `documentVersion`, workflow generation, item index, checkpoint/profile versions, and quality score. Every timestamp is an already-committed canonical semantic timestamp; `recordedAt`, current time, and process time are never rendered.

Validation projection is closed over strict workflow replay; it never reads mutable runner state:

| Fold state at the candidate trigger | `validation` | `validationResultIds` / `results` | `qualityScore` | `safeFailureCode` |
|---|---|---|---|---|
| Direct terminal `SessionAbandoned` with null workflow origin | `null` | absent with the whole object | absent | absent |
| Workflow exists but no pass/fail/invalidation is currently in force, including before validation and while results are accumulating | status `not-run` | all retained current workflow result IDs and their exact strict `ValidationResultV1` values, both binary-sorted by `resultId` | `null` | `null` |
| Latest in-force verdict is `SessionEndVerificationPassed` | status `passed` | exactly the event's complete sorted `validationResultIds` and the matching strict results | exact event `qualityScore` | `null` |
| Latest in-force verdict is `SessionEndVerificationFailed` | status `failed` | exactly the event's complete sorted `validationResultIds` and the matching strict results | `null` | exact event `safeFailureCode` |
| Latest in-force verdict is `SessionEndVerificationInvalidated` | status `invalidated` | carry exactly the IDs/results from the passed event named by `previousVerificationEventPosition`; the invalidation event cannot replace them | reset to `null` | exact invalidation event `safeFailureCode` |

A new/reopened request starts the retained set empty. An `open` amendment and cancellation clear it and emit `not-run` if materialized; `seal` and `unchanged` preserve the folded set/verdict exactly. A workflow-origin abandonment preserves the last folded validation projection. `SessionEnded` preserves the passed projection whose event position it names. Any missing/extra result, result from another workflow lineage, unsorted/duplicate ID, verdict/result-set mismatch, or invalidation that does not name the in-force passed event is `INTEGRITY_FAILURE`. The committed golden fixtures cover `not-run` (`ending-v2` and `cancelled-v2`), `passed` (`completed-v2`), `failed` (`failed-v2`), `invalidated` (`invalidated-v2`), and null (`abandoned-v2`).

The renderer emits exactly these sections in this order, with `\n` line endings and one terminal newline:

```text
# Compatibility Session Log v2

## Identity
{canonicalJson(projection.identity)}

## Source
{canonicalJson(projection.source)}

## Lifecycle
{canonicalJson(projection.lifecycle)}
{literal `> SESSION ENDING` line only when rootState is `ending`}

## Accepted Children
{canonicalJson(projection.acceptedChildren)}

## Unresolved Follow-ups
{canonicalJson(projection.unresolvedFollowUps)}

## Final Checkpoint
{canonicalJson(projection.finalCheckpoint)}

## Validation
{canonicalJson(projection.validation)}

## Materialization
{canonicalJson(projection.materialization)}
```

Every section is present. Empty repeated sections are `[]`; unavailable singletons are `null`; absent optionals are explicit JSON `null`. Each section value is one compact `canonicalJson(...)` line with JSON scalar escaping. When the ending marker is absent there is no replacement line. The projection excludes event IDs, random IDs, `recordedAt`, current clock, process/locale/topic state, raw evidence/frames, commands, raw output, authority/capability/approval material, and secrets.

The first pre-reviewed literal fixture is authoritative and must be copied byte-for-byte into `tests/fixtures/compatibility-log/ending-v2.md`:

<!-- ending-v2-fixture-start -->
```text
# Compatibility Session Log v2

## Identity
{"branchRef":"refs/heads/main","branchScopeId":null,"documentVersion":2,"projectId":"11111111-1111-4111-8111-111111111111","sessionId":"44444444-4444-4444-8444-444444444444","startedAt":"2026-08-09T00:00:00.000Z","storeId":"33333333-3333-4333-8333-333333333333","vaultId":"22222222-2222-4222-8222-222222222222","workspaceId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}

## Source
{"startEventPosition":"1","streamId":"session/44444444-4444-4444-8444-444444444444","streamType":"session","throughEventPosition":"7"}

## Lifecycle
{"childEndPolicy":"suspend-and-carry-forward","evidenceWindowState":"open","rootState":"ending","workflowGeneration":2,"workflowId":"b6c2d359-82a6-567e-86c7-bf9e780cf20b"}
> SESSION ENDING

## Accepted Children
[]

## Unresolved Follow-ups
[{"blockers":["รอ \"API\""],"checkpointId":"55555555-5555-4555-8555-555555555555","followUps":["ทดสอบ\nซ้ำ"],"kind":"carry-forward-ticket","sourceChildSessionId":"66666666-6666-4666-8666-666666666666","transferTicketId":"77777777-7777-4777-8777-777777777777"}]

## Final Checkpoint
null

## Validation
{"qualityScore":null,"results":[],"safeFailureCode":null,"validationResultIds":[],"verificationStatus":"not-run"}

## Materialization
{"artifactKind":"compatibility-session-log","artifactPath":"05_Agent_Session_Logs/2026-08-09-session-44444444-4444-4444-8444-444444444444.md","materializationRevision":"7","targetKey":"lifecycle-log/44444444-4444-4444-8444-444444444444/7","triggeringEventPosition":"7","triggeringEventSchemaVersion":3,"triggeringEventType":"SessionEndAmended","triggeringPayloadHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
```
<!-- ending-v2-fixture-end -->

Expected UTF-8 byte length: `1729`. Expected SHA-256: `9c8c7650657a0f9f2c7a8828dedfad89bbff44f25d87cac1e51b1d2a539e72ce`. The test also commits failed/cancelled/invalidated/abandoned/completed literals from the same exact DTOs. Any future renderer format change requires a new document version; Task 14Q never rewrites Version 2 fixture bytes.

### Task 14Q.1: Freeze lifecycle queue contracts and the trigger/origin matrix

**Files:**

- Create: `src/orchestrator/lifecycle/materialization-queue.port.ts`
- Create: `tests/lifecycle-materialization-queue.test.ts`
- Modify: `src/orchestrator/contracts/event.ts`

- [ ] **Step 1: Write strict contract RED tests**

Table every allowed trigger/origin pair and every forbidden cross-pair. Require strict own keys, deep freeze, canonical decimal revision, exact outer/payload target agreement, fixed artifact kind, and both indices equal zero. Prove the generic `PendingOutbox` branch rejects `materialize-lifecycle-log`.

```ts
const WORKFLOW_TRIGGERS = [
  "SessionCheckpointRecorded",
  "SessionEndAmended",
  "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated",
  "SessionEndCancelled",
  "SessionAbandoned",
  "SessionEnded",
] as const;

it("strict-decodes every lifecycle materialization trigger and origin pair", () => {
  for (const trigger of WORKFLOW_TRIGGERS) assertValid(workflowPending(trigger));
  assertValid(directTerminalPending("SessionAbandoned"));
  assertRejectsEveryOtherPair();
});
```

- [ ] **Step 2: Run RED, implement exact closed unions, and rerun GREEN**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(strict-decodes every lifecycle materialization trigger and origin pair|rejects lifecycle outbox event indexes other than zero|rejects the lifecycle kind through the generic pending outbox branch|deep-freezes the canonical lifecycle pending descriptor)$" dist-test/tests/lifecycle-materialization-queue.test.js
```

Implement the exact types/codecs from approved design section 13.3. Keep the brand private to the queue port. Do not put `expectedPriorFingerprint` on projection, prepared, payload, or insert input.

```ts
export interface LifecycleMaterializationQueuePort {
  prepare(input: MaterializationProjectionInputV1): PreparedMaterializationQueueV1;
  assertPlanned(
    prepared: PreparedMaterializationQueueV1,
    plannedTrigger: StoredEvent,
  ): void;
  assertCommitted(
    prepared: PreparedMaterializationQueueV1,
    committedTrigger: StoredEvent,
  ): LifecycleOutboxPlannedRevision;
}
```

`PreparedMaterializationQueueV1` exposes only its private brand and one `PendingLifecycleOutboxV1`; the lifecycle pending descriptor has kind `materialize-lifecycle-log`, fixed event index zero, and the closed payload/origin union. The concrete queue, not a semantic caller, owns all rendering and fingerprint derivation.

- [ ] **Step 3: Run 14Q.1 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/event-append-transaction.test.js
npm run typecheck
git add src/orchestrator/lifecycle/materialization-queue.port.ts src/orchestrator/contracts/event.ts tests/lifecycle-materialization-queue.test.ts
git commit -m "feat: freeze lifecycle materialization queue contracts"
```

### Task 14Q.2: Implement the canonical path and pure renderer

**Files:**

- Create: `src/orchestrator/materialization/vault-artifact-path.ts`
- Create: `src/orchestrator/materialization/compatibility-log.renderer.ts`
- Create: `tests/compatibility-log-renderer.test.ts`
- Create: `tests/fixtures/compatibility-log/ending-v2.md`
- Create: `tests/fixtures/compatibility-log/failed-v2.md`
- Create: `tests/fixtures/compatibility-log/cancelled-v2.md`
- Create: `tests/fixtures/compatibility-log/invalidated-v2.md`
- Create: `tests/fixtures/compatibility-log/abandoned-v2.md`
- Create: `tests/fixtures/compatibility-log/completed-v2.md`

- [ ] **Step 1: Commit literal RED fixtures and independent expected projections**

Write literal UTF-8/LF fixtures by hand from the normative grammar above. Cover both checkpoint versions across the fixture set, accepted child results, transferred/unresolved work, qualified adapter ordering, null/empty shapes, JSON escaping, the conditional ending marker, the canonical session stream, candidate position without an unavailable event hash, and all five validation projections with their carry/reset rules. The test reads literal bytes and must not generate its expected value through production helpers.

- [ ] **Step 2: Run renderer/path RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(derives one canonical path and revision-bearing target|renders compatibility log golden bytes deterministically|binds source stream to the canonical root session and candidate position|folds every validation byte state with exact carry and reset semantics|renders committed prefix plus the exact candidate identically to committed replay|omits random ids clocks locale topics secrets and raw evidence)$" dist-test/tests/compatibility-log-renderer.test.js
```

- [ ] **Step 3: Implement pure projection and rendering**

Derive `05_Agent_Session_Logs/{yyyy-mm-dd}-session-{sessionId}.md` only from the first committed `SessionStarted` UTC date. Validate the lowercase session UUID and contained relative path. Fold only the strict ordered committed prefix plus optional exact candidate, reject gaps/foreign sessions/future positions, build the narrow projection, render the fixed section grammar with canonical JSON, and zero transient byte buffers after the caller fingerprints them. No filesystem access belongs in the renderer.

- [ ] **Step 4: Run 14Q.2 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/compatibility-log-renderer.test.js
npm run typecheck
git add src/orchestrator/materialization/vault-artifact-path.ts src/orchestrator/materialization/compatibility-log.renderer.ts tests/compatibility-log-renderer.test.ts tests/fixtures/compatibility-log/ending-v2.md tests/fixtures/compatibility-log/failed-v2.md tests/fixtures/compatibility-log/cancelled-v2.md tests/fixtures/compatibility-log/invalidated-v2.md tests/fixtures/compatibility-log/abandoned-v2.md tests/fixtures/compatibility-log/completed-v2.md
git commit -m "feat: render deterministic compatibility session logs"
```

### Task 14Q.3: Persist and read exact immutable lifecycle outbox plans

**Files:**

- Create: `src/orchestrator/storage/lifecycle-outbox.repository.ts`
- Create: `tests/lifecycle-outbox.repository.test.ts`
- Modify: `src/orchestrator/storage/lifecycle-storage.types.ts`

- [ ] **Step 1: Write repository RED tests**

Test no predecessor, immediate lower revision across every operational status, gaps, key rotation, malformed tuples, canonical path drift, foreign trigger, wrong content hash, wrong origin, non-immediate predecessor, and strict absence versus corruption. Separately table pending, claimed, completed, and failed as the status of the exact queried row: `getExactPlannedRevision`/`assertExactPlannedRevision` return identical immutable plan data for all four without rerender/refingerprint. The predecessor lookup key is exactly `(project_id, session_id, artifact_kind)` and never includes path.

- [ ] **Step 2: Run repository RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(derives prior fingerprint from the immediate lower revision regardless of status|uses null prior only when no lower revision exists|rejects a lower revision on a foreign canonical path|returns the exact planned revision in every operational status|returns only an exact strictly bound planned revision|rejects malformed rows instead of reporting absence)$" dist-test/tests/lifecycle-outbox.repository.test.js
```

- [ ] **Step 3: Implement storage-only insert/read seams**

```ts
export class LifecycleOutboxRepository {
  insertLifecycle(
    connection: SqliteConnection,
    pending: PendingLifecycleOutboxV1,
    triggeringEvent: StoredEvent,
    createdAt: string,
  ): void;
  getExactPlannedRevision(
    connection: SqliteConnection,
    query: ExactPlannedRevisionQuery,
  ): LifecycleOutboxPlannedRevision | null;
  assertExactPlannedRevision(
    connection: SqliteConnection,
    query: ExactPlannedRevisionQuery,
  ): LifecycleOutboxPlannedRevision;
}
```

Insert only after the event row exists. Revalidate the payload against the actual event, derive the original-session path independently, select and fully verify the immediate predecessor inside the same `BEGIN IMMEDIATE`, copy its complete keyed fingerprint tuple, and write the immutable row. Return null only for true absence.

- [ ] **Step 4: Run 14Q.3 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/session-lifecycle-migration.test.js
npm run typecheck
git add src/orchestrator/storage/lifecycle-outbox.repository.ts src/orchestrator/storage/lifecycle-storage.types.ts tests/lifecycle-outbox.repository.test.ts
git commit -m "feat: persist immutable lifecycle materialization plans"
```

### Task 14Q.4: Plan provider-keyed fingerprints through a one-use connection-bound queue

**Files:**

- Create: `src/orchestrator/materialization/sqlite-lifecycle-materialization-queue.ts`
- Modify: `tests/lifecycle-materialization-queue.test.ts`

- [ ] **Step 1: Write branded-state and zeroization RED tests**

Inject read/renderer/key-provider spies. Prove the queue receives only tail/prefix/predecessor reads, checks the exact next global position, renders once, fingerprints once, zeroizes bytes even on failure, returns a deeply frozen instance-owned plan, rejects foreign/reused plans, and asserts planned/committed events without rerendering.

- [ ] **Step 2: Run RED, implement, and rerun GREEN**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(plans one provider-keyed fingerprint and zeroizes render bytes|requires the transaction next global position|accepts its opaque prepared plan exactly once|asserts planned and committed triggers without rerendering)$" dist-test/tests/lifecycle-materialization-queue.test.js
```

Use a private `WeakMap` state machine (`prepared -> planned -> committed`) and instance token. The constructor accepts only `LifecycleMaterializationPlanningReads`, the provider-keyed fingerprint service, path deriver, renderer, and immutable plan reader; it never receives `LifecycleCommandTransaction` or mutable workflow/authority capabilities.

- [ ] **Step 3: Commit 14Q.4**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/lifecycle-outbox.repository.test.js
npm run typecheck
git add src/orchestrator/materialization/sqlite-lifecycle-materialization-queue.ts tests/lifecycle-materialization-queue.test.ts
git commit -m "feat: plan lifecycle materialization fingerprints"
```

### Task 14Q.5: Insert typed lifecycle outbox rows inside event append

**Files:**

- Modify: `src/orchestrator/storage/event-append-transaction.ts`
- Modify: `tests/event-append-transaction.test.ts`

- [ ] **Step 1: Write append-order/hash/rollback RED tests**

Prove strict normalization preserves the full descriptor, the generic branch cannot insert the lifecycle kind, the actual event is inserted before the lifecycle row, an insertion failure rolls back event/outbox/projection/dedup, replay retains one target without reinsertion, and `command_dedup.command_hash` is still the supplied authoritative intent hash.

- [ ] **Step 2: Run the exact RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(preserves authoritative lifecycle command hash while recording the outbox target|inserts lifecycle outbox only after its actual event|rolls back event and lifecycle row when planning insertion fails|replay retains one ordered lifecycle target without reinsertion)$" dist-test/tests/event-append-transaction.test.js
```

- [ ] **Step 3: Implement the strict append union**

Give `SqliteEventAppendStatements` the connection-bound planning writer. `validateAppendCommand` retains the typed descriptor. `appendPlanned` dispatches `materialize-lifecycle-log` to `insertLifecycle(pending, actualStoredEvent, recordedAt)` and all other kinds to the existing generic insert. Do not add a lifecycle `afterAppend` side channel and do not hash the descriptor into the authoritative intent hash.

- [ ] **Step 4: Run 14Q.5 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-append-transaction.test.js dist-test/tests/event-integrity.test.js dist-test/tests/lifecycle-command-store.test.js
npm run typecheck
git add src/orchestrator/storage/event-append-transaction.ts tests/event-append-transaction.test.ts
git commit -m "feat: append typed lifecycle materialization plans atomically"
```

### Task 14Q.6: Expose immutable plan reads and repair source-state/integrity constants

**Files:**

- Modify: `src/orchestrator/lifecycle/lifecycle-operational.store.ts`
- Modify: `src/orchestrator/lifecycle/source-state.provider.ts`
- Modify: `src/orchestrator/integrity/event-integrity.service.ts`
- Modify: `src/orchestrator/integrity/lifecycle-integrity.service.ts`
- Modify: `tests/lifecycle-operational-store.test.ts`
- Modify: `tests/source-state.provider.test.ts`
- Modify: `tests/event-integrity.test.ts`
- Modify: `tests/qualified-checkpoint-quick-integrity.test.ts`
- Modify: `tests/qualified-checkpoint-full-integrity.test.ts`
- Modify: `tests/session-end-effective-state-migration.test.ts`

- [ ] **Step 1: Write capability/source/integrity RED tests**

Require `WorkflowOperationalTransaction.outboxPlans` to expose only exact immutable get/assert. Prove claim/acknowledge are absent. Replace the stale `session-log` query literal with the shared `compatibility-session-log` constant and prove it is not retained as an alias. Table every allowed and forbidden trigger-origin pair at codec/queue, migration hostile-SQL, repository, quick-integrity, and full-integrity layers. At the codec/queue boundary independently reject a nonzero `MaterializationProjectionInputV1.triggeringEventIndex` and a nonzero pending descriptor `eventIndex`. At migration, repository, quick-integrity, and full-integrity boundaries require the referenced `events.command_event_index` to be zero. Strict payload decoding must reject invented keys, including `triggeringEventIndex`; that key is never added to the lifecycle payload union. Corrupt each payload/event/path/fingerprint predecessor binding independently. The matrix includes workflow-origin `SessionAbandoned` and direct terminal-event/null-workflow `SessionAbandoned`; no other terminal-event trigger is legal.

- [ ] **Step 2: Run RED anchors and implement exact read-only boundaries**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(exposes immutable outbox plans only to workflow operations|does not expose claim or acknowledgement to workflow operations|excludes compatibility log targets with the canonical artifact kind|does not retain session-log as a source-state alias|rejects every lifecycle trigger origin and index violation in schema 4|repository enforces the complete lifecycle trigger origin and index matrix|quick integrity enforces the complete lifecycle trigger origin and index matrix|full integrity enforces the complete lifecycle trigger origin and index matrix|integrity binds lifecycle payload content hash and triggering event|full integrity verifies immediate fingerprint lineage and canonical path|lifecycle descriptor integrity does not redefine command hash)$" dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/source-state.provider.test.js dist-test/tests/event-integrity.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
```

- [ ] **Step 3: Run the complete 14Q gate**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/event-append-transaction.test.js dist-test/tests/event-integrity.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/source-state.provider.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
npm run typecheck
npm run build
npm run test:build-artifacts
git diff --check
```

- [ ] **Step 4: Commit and review slice 14Q**

```powershell
git add src/orchestrator/lifecycle/lifecycle-operational.store.ts src/orchestrator/lifecycle/source-state.provider.ts src/orchestrator/integrity/event-integrity.service.ts src/orchestrator/integrity/lifecycle-integrity.service.ts tests/lifecycle-operational-store.test.ts tests/source-state.provider.test.ts tests/event-integrity.test.ts tests/qualified-checkpoint-quick-integrity.test.ts tests/qualified-checkpoint-full-integrity.test.ts tests/session-end-effective-state-migration.test.ts
git commit -m "fix: separate lifecycle plan reads from materialization operations"
git status --short
```

Request fresh spec and quality reviews over the complete 14Q range. Do not start 14R until both approve with no Critical/Important findings.

## Slice 14R — request, repository, and policy lifecycle

### Task 14R.1: Implement policy arithmetic and connection-bound workflow operations

**Files:**

- Create: `src/orchestrator/lifecycle/session-end-policy.ts`
- Create: `src/orchestrator/lifecycle/session-end-workflow.service.ts`
- Create: `tests/session-end-policy.test.ts`
- Create: `tests/session-end-workflow.test.ts`
- Modify: `src/orchestrator/storage/session-end.repository.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-command.store.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-operational.store.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-command.processor.ts`
- Modify: `src/orchestrator/lifecycle/contracts/session-end.ts`
- Modify: `src/orchestrator/storage/lifecycle-storage.types.ts`
- Modify: `tests/session-end.repository.test.ts`
- Modify: `tests/lifecycle-command-store.test.ts`
- Modify: `tests/lifecycle-operational-store.test.ts`

- [ ] **Step 1: Write policy and repository RED tests**

Cover required/optional profiles, weight/threshold arithmetic without floating point, `requireFullEvidence`, Version 1 whole-scope eligibility, request-version evidence windows, exact workflow hydration, binary claim order `(triggering_event_position, workflow_id)`, lease/token CAS, expired takeover, release, eventless phase advancement, immutable exact replay, and no raw connection escaping the store callback.

```ts
it("claims session-end workflows in triggering-position workflow-id order", () => {
  seedWorkflowsInReverseOrder(connection);
  assert.deepEqual(claimNext(connection, request), expectedFirstIdentity);
});
```

- [ ] **Step 2: Run RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(computes session end policy with integer arithmetic|hydrates one strict event-carried workflow generation|claims session-end workflows in triggering-position workflow-id order|fences eventless workflow phases by live owner and token)$" dist-test/tests/session-end-policy.test.js dist-test/tests/session-end.repository.test.js dist-test/tests/session-end-workflow.test.js dist-test/tests/lifecycle-operational-store.test.js
```

- [ ] **Step 3: Implement focused repository and store facades**

`SessionEndRepository` remains storage-only. Build `ConnectionBoundSessionEndWorkflowOperations` for exact current reads, create/reopen/update, claim/renew/release/recovery scan, plan persistence, and phase CAS. `WorkflowOperationalTransaction` exposes only workflows, validation-plan reads/writes, immutable outbox plans, and the approved read-only authority/transfer/coverage facades. It must not expose event append or mutable outbox operations.

- [ ] **Step 4: Run 14R.1 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-policy.test.js dist-test/tests/session-end.repository.test.js dist-test/tests/session-end-workflow.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-operational-store.test.js
npm run typecheck
git add src/orchestrator/lifecycle/session-end-policy.ts src/orchestrator/lifecycle/session-end-workflow.service.ts src/orchestrator/storage/session-end.repository.ts src/orchestrator/lifecycle/lifecycle-command.store.ts src/orchestrator/lifecycle/lifecycle-operational.store.ts src/orchestrator/lifecycle/lifecycle-command.processor.ts src/orchestrator/lifecycle/contracts/session-end.ts src/orchestrator/storage/lifecycle-storage.types.ts tests/session-end-policy.test.ts tests/session-end-workflow.test.ts tests/session-end.repository.test.ts tests/lifecycle-command-store.test.ts tests/lifecycle-operational-store.test.ts
git commit -m "feat: persist session end workflow state"
```

### Task 14R.2: Anchor request and cancelled-row reopening in one root transaction

**Files:**

- Modify: `src/orchestrator/lifecycle/session-end-workflow.service.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-command.processor.ts`
- Modify: `src/orchestrator/lifecycle/contracts/commands.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-intent.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-intent-witness.ts`
- Modify: `src/orchestrator/storage/session-authority.repository.ts`
- Modify: `src/orchestrator/storage/session-lease.repository.ts`
- Modify: `tests/session-end-workflow.test.ts`
- Modify: `tests/lifecycle-command-processor.test.ts`
- Modify: `tests/lifecycle-intent.test.ts`

- [ ] **Step 1: Write request/reopen RED tests**

Cover authority/context/checkpoint/source/policy/capacity failures before identity allocation; require-completed active child rejection; conservative carry-forward capacity; Version 1 sealed versus Version 2 open window; one Version 3 request event; root `ending`; deterministic G1 workflow; request response loss; cancelled G2 row reopened as G3; no second workflow row; retained tickets; and zero outbox for both initial and reopened requests. Add raw-row cases proving reopen replaces the effective snapshot pointer/hash, prior-root state, root command and trigger position; clears terminal, claim, retry, failure, validation-plan/result, frozen-group, final-checkpoint, score, and safe-failure fields; and renews root authority in the same transaction. Inject a failure at each clearing/update boundary and prove complete rollback.

```ts
it("requests G1 without outbox and reopens cancelled G2 as G3", () => {
  const first = requestSessionEnd(v2Request());
  assert.equal(first.workflowGeneration, 1);
  assert.equal(listLifecycleOutbox().length, 0);
  cancelSessionEnd(first);
  const reopened = requestSessionEnd(v2Request());
  assert.equal(reopened.workflowGeneration, 3);
  assert.equal(countWorkflowRows(first.workflowId), 1);
  assert.equal(listLifecycleOutbox().length, 1); // cancellation only
});
```

- [ ] **Step 2: Run the request/reopen RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(requests G1 without outbox and reopens cancelled G2 as G3|initializes evidence window from request version|rejects unfinishable carry-forward before identity allocation|replaces every cancelled-row semantic pointer on reopen|clears every stale cancelled-row operational and final field on reopen|binds reopened trigger position and renews root authority atomically|rolls reopen back at every field-update boundary|replays a committed request before current authority checks)$" dist-test/tests/session-end-workflow.test.js dist-test/tests/lifecycle-command-processor.test.js
```

- [ ] **Step 3: Implement the root anchor transaction**

The semantic store callback performs every live check, appends exactly one Version 3 `SessionEndRequested`, updates root authority/state, creates or reopens the deterministic row, projection, and dedup, and commits before returning. It does not inspect or mutate a selected child and it supplies `outbox: []`. Exact dedup replay occurs before fresh authority/generation checks.

- [ ] **Step 4: Run 14R.2 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-workflow.test.js dist-test/tests/lifecycle-command-processor.test.js dist-test/tests/lifecycle-intent.test.js dist-test/tests/lifecycle-command-store.test.js
npm run typecheck
git add src/orchestrator/lifecycle/session-end-workflow.service.ts src/orchestrator/lifecycle/lifecycle-command.processor.ts src/orchestrator/lifecycle/contracts/commands.ts src/orchestrator/lifecycle/lifecycle-intent.ts src/orchestrator/lifecycle/lifecycle-intent-witness.ts src/orchestrator/storage/session-authority.repository.ts src/orchestrator/storage/session-lease.repository.ts tests/session-end-workflow.test.ts tests/lifecycle-command-processor.test.ts tests/lifecycle-intent.test.ts
git commit -m "feat: anchor session end requests"
```

### Task 14R.3: Implement amendment and cancellation generation fencing

**Files:**

- Modify: `src/orchestrator/lifecycle/session-end-workflow.service.ts`
- Modify: `src/orchestrator/lifecycle/session-end-policy.ts`
- Modify: `src/orchestrator/storage/session-end.repository.ts`
- Modify: `src/orchestrator/storage/session-authority.repository.ts`
- Modify: `src/orchestrator/lifecycle/checkpoint.service.ts`
- Modify: `tests/session-end-workflow.test.ts`
- Modify: `tests/session-end-policy.test.ts`
- Modify: `tests/checkpoint.service.test.ts`
- Modify: `tests/event-integrity.test.ts`

- [ ] **Step 1: Write open/seal/unchanged/cancel RED tests**

Cover exact G+1, stale-claim fencing, one amendment row, one cancel row, sealed-to-open and open-to-sealed guards, open clearing frozen/validation fields, open returning to `requested` when eligible child work remains and otherwise `children-resolved`, seal requiring a current qualifying Version 2 checkpoint with direct-scope/evidence equality, seal evidence-race rollback with zero effect, unchanged byte preservation, unchanged rewind rejection, Version 1 whole-scope gate with null draft, child-policy changes, cancellation authority/proof/pre-transition-checkpoint prerequisites, cancellation sealing the window and clearing claim/retry/failure/plan/frozen fields, cancellation retaining tickets/transferred children, child-before-cancel and cancel-before-child ordering, and exact old dedup replay after generation change. For amendment and cancellation separately, prove the queued row passes event integrity and exact replay inserts neither an event nor a second row.

```ts
it("amend unchanged preserves phase and frozen bytes", () => {
  const before = loadWorkflowBytes();
  amendSessionEnd({ evidenceWindowAction: "unchanged", ...unchangedAmendment() });
  assert.equal(loadWorkflow().phase, before.phase);
  assert.equal(loadWorkflowRawFrozenGroup(), before.frozenGroup);
});
```

- [ ] **Step 2: Run amendment/cancellation RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(amend unchanged preserves phase and frozen bytes|rejects open unless sealed and seal unless open|open branches to requested or children-resolved from current child work|seal rejects a direct-scope or evidence race with zero effect|open and seal fence old generation work|rejects unchanged when a rewind is required|cancel requires current authority proof and pre-transition checkpoint|cancel clears the exact operational validation and frozen field set|cancel restores only root and queues exactly one revision|amendment and cancellation rows pass event integrity and replay without reinsertion|retains a child ticket across cancel and reopen)$" dist-test/tests/session-end-workflow.test.js dist-test/tests/session-end-policy.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/event-integrity.test.js
```

- [ ] **Step 3: Implement deterministic fold, queue, and generation transitions**

Fold amendment over the prior event snapshot, derive a new bounded snapshot/hash, increment generation, append Version 3, clear only the fields required by `open`/`seal`/`unchanged`, prepare exactly one 14Q amendment row, and fence old work. Cancellation appends Version 3 with exact previous/G+1, restores only the persisted root state, clears workflow operational/frozen fields, retains tickets and child state, and prepares exactly one restored-state 14Q row. Use the Task 14Q prepare → append descriptor → assert flow; never insert through `afterAppend`.

- [ ] **Step 4: Run the complete 14R gate, commit, and review**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-policy.test.js dist-test/tests/session-end.repository.test.js dist-test/tests/session-end-workflow.test.js dist-test/tests/lifecycle-command-processor.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/lifecycle-intent.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/lifecycle-outbox.repository.test.js
npm run typecheck
npm run build
git diff --check
git add src/orchestrator/lifecycle/session-end-workflow.service.ts src/orchestrator/lifecycle/session-end-policy.ts src/orchestrator/storage/session-end.repository.ts src/orchestrator/storage/session-authority.repository.ts src/orchestrator/lifecycle/checkpoint.service.ts tests/session-end-workflow.test.ts tests/session-end-policy.test.ts tests/checkpoint.service.test.ts tests/event-integrity.test.ts
git commit -m "feat: fence session end amendment and cancellation"
git status --short
```

Request fresh spec and quality reviews over the complete 14R range. Do not start 14S until both approve with no Critical/Important findings.

## Slice 14S — per-child saga and final freeze

### Task 14S.1: Split root and child internal workflow contracts

**Files:**

- Create: `src/orchestrator/lifecycle/session-end-child.service.ts`
- Create: `tests/session-end-child-saga.test.ts`
- Modify: `src/orchestrator/lifecycle/contracts/commands.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-intent.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-intent-witness.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-command.store.ts`
- Modify: `src/orchestrator/runtime/lifecycle-worker-protocol.ts`
- Modify: `tests/lifecycle-contracts.test.ts`
- Modify: `tests/lifecycle-intent.test.ts`
- Modify: `tests/lifecycle-command-store.test.ts`
- Modify: `tests/lifecycle-worker-protocol.test.ts`

- [ ] **Step 1: Write planned/authoritative action and result-codec RED tests**

Add the exact `CarryForwardChildActionV1`, root-plan/child-plan split, authoritative command split, Version 1 result, nested version 1, root authorization audience plus child target, root+child affected-session binding, and strict result correlation. Test active/proposed +2 versus suspended +1 stream formulas and positive canonical global positions without incorrectly equating a global position to a stream version.

```ts
export interface CarryForwardChildActionV1 {
  readonly action: "carry-forward-child";
  readonly actionVersion: 1;
  readonly rootSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly expectedChildState: "active" | "completion-proposed" | "suspended";
  readonly expectedChildHeadEventPosition: string;
  readonly expectedChildStreamVersion: string;
  readonly expectedChildAuthorityCommitment: string;
  readonly expectedChildCapabilityGeneration: string;
  readonly expectedSuspensionEventPosition: string | null;
  readonly checkpointId: CheckpointId;
  readonly checkpointEventPosition: string;
  readonly checkpointFingerprint: string;
}
```

The result contract is exactly:

```ts
export type CarryForwardChildResultV1 = JsonValue & {
  readonly resultVersion: 1;
  readonly action: "carry-forward-child";
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly plannedWorkId: string;
  readonly rootSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly previousChildState: "active" | "completion-proposed" | "suspended";
  readonly childState: "transferred";
  readonly transferTicketId: TransferTicketId;
  readonly suspensionEventPosition: string;
  readonly transferTicketEventPosition: string;
  readonly finalChildStreamVersion: string;
};
```

- [ ] **Step 2: Run internal-contract RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(strictly decodes the carry-forward child action and result|maps carry-forward plans to Version 1 child results|binds root audience and child target for carry-forward|registers both root and child as affected sessions|rejects swapped carry-forward result identities and stream formulas)$" dist-test/tests/lifecycle-contracts.test.js dist-test/tests/lifecycle-worker-protocol.test.js dist-test/tests/lifecycle-command-store.test.js
```

- [ ] **Step 3: Implement the exact union split**

Use the approved interfaces in design section 9.2. `LifecycleInternalResultFor<I>` selects by decoded planned action. Keep public `create-child-transfer` reserved/unavailable. Do not adapt a child result into `SessionEndPhaseResultV2`. Ensure intent/witness hashing includes stable action fields but excludes live claim owner/token/expiry.

- [ ] **Step 4: Run 14S.1 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-contracts.test.js dist-test/tests/lifecycle-worker-protocol.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-intent.test.js dist-test/tests/session-end-child-saga.test.js
npm run typecheck
git add src/orchestrator/lifecycle/session-end-child.service.ts src/orchestrator/lifecycle/contracts/commands.ts src/orchestrator/lifecycle/lifecycle-intent.ts src/orchestrator/lifecycle/lifecycle-intent-witness.ts src/orchestrator/lifecycle/lifecycle-command.store.ts src/orchestrator/runtime/lifecycle-worker-protocol.ts tests/session-end-child-saga.test.ts tests/lifecycle-contracts.test.ts tests/lifecycle-intent.test.ts tests/lifecycle-command-store.test.ts tests/lifecycle-worker-protocol.test.ts
git commit -m "feat: define internal child carry-forward work"
```

### Task 14S.2: Implement one-child carry-forward with Version 2 lineage

**Files:**

- Modify: `src/orchestrator/lifecycle/session-end-child.service.ts`
- Modify: `src/orchestrator/lifecycle/child-workflow.service.ts`
- Modify: `src/orchestrator/lifecycle/session-aggregate.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-projection-folds.ts`
- Modify: `src/orchestrator/storage/child-transfer.repository.ts`
- Modify: `src/orchestrator/storage/session-authority.repository.ts`
- Modify: `src/orchestrator/storage/lifecycle-projection.repository.ts`
- Modify: `src/orchestrator/storage/lifecycle-storage.types.ts`
- Modify: `src/orchestrator/integrity/lifecycle-integrity.service.ts`
- Modify: `tests/session-end-child-saga.test.ts`
- Modify: `tests/child-workflow.test.ts`
- Modify: `tests/session-aggregate.test.ts`
- Modify: `tests/lifecycle-projection-folds.test.ts`
- Modify: `tests/qualified-checkpoint-quick-integrity.test.ts`
- Modify: `tests/qualified-checkpoint-full-integrity.test.ts`
- Modify: `tests/lifecycle-storage.repositories.test.ts`
- Modify: `tests/session-authority.repository.test.ts`

- [ ] **Step 1: Write semantic transaction RED tests**

Cover deterministic binary selection proposal, full re-read after selection, active/proposed two-event append, already-suspended transfer-only append, non-adjacent suspension witness with a newer governing checkpoint, blockers/follow-ups byte equality, current checkpoint/source-state/authority binding, deterministic ticket, source child uniqueness, root+child integrity registration, response-loss replay, stale selection zero effect, and a valid existing-child write that commits after the root request and is preserved by the subsequent rescan.

Before production lineage code, add one valid Version 1 control and one valid Version 2 control to each aggregate, projection, repository/ticket-claim, ending-scope, quick-integrity, and full-integrity suite. Independently corrupt suspension/checkpoint/transfer event positions, `suspensionCheckpointId`, governing `checkpointId`, blockers, follow-ups, source state, authority commitment, workflow/generation/planned-work identity, parent/child/correlation identity, and ticket identity. Each named mutation must RED in its owning validator before the minimal dispatch change.

Add exact service-level history boundaries for all four creation/claim paths: `fork-child`, `claim-child-transfer` into a target parent, public `suspend-child-session` (the suspend-and-transfer ticket producer), and automatic `carry-forward-child`. Each accepts exactly 1,000 applicable immutable rows (including terminal children and claimed tickets), rejects the 1,001st before UUID/random ID allocation or any mutation, and records zero identity-generator calls on rejection. SQL/hostile direct-write enforcement remains in 14M.

```ts
it("carries an already suspended child with a newer governing checkpoint", () => {
  const result = carryForward(selectedSuspendedChildWithLaterCheckpoint());
  assert.equal(result.previousChildState, "suspended");
  assert.equal(result.finalChildStreamVersion, expectedPlusOne);
  assert.deepEqual(lastTransferPayload(), {
    transferTicketId: result.transferTicketId,
    suspensionCheckpointId: originalSuspensionCheckpointId,
    checkpointId: newerGoverningCheckpointId,
    authorityCommitment: transferredCommitment,
  });
});
```

- [ ] **Step 2: Run transaction RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(selects one eligible child by binary UUID order|carries active and proposed children with suspension then transfer|carries an already suspended child with a newer governing checkpoint|rejects stale child selection with zero effect|replays committed carry-forward after response loss|version-specific aggregate rejects every dual-checkpoint lineage mutation|version-specific projection rejects every dual-checkpoint lineage mutation|ticket claim rejects every dual-checkpoint lineage mutation|ending scope rejects every dual-checkpoint lineage mutation|quick integrity rejects every dual-checkpoint lineage mutation|full integrity rejects every dual-checkpoint lineage mutation|fork child accepts 1000 and rejects the 1001st before identity allocation|claim child transfer accepts 1000 and rejects the 1001st before identity allocation|suspend child session accepts 1000 and rejects the 1001st before identity allocation|automatic carry forward accepts 1000 and rejects the 1001st before identity allocation)$" dist-test/tests/session-end-child-saga.test.js dist-test/tests/child-workflow.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/lifecycle-storage.repositories.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
```

- [ ] **Step 3: Implement Version 2 semantic/projection/ticket dispatch**

This is the 14S half of the explicit M/S ownership split: 14M supplied codec and SQL authorization; 14S supplies the only producer plus aggregate, projection, ticket claim, ending-scope, and quick/full integrity lineage rules. Version 1 keeps adjacent same-checkpoint rules. Version 2 directly validates `suspensionEventPosition`, `checkpointEventPosition`, and `transferEventPosition` from `SessionEndCarryForwardTicketLineageV1` and permits the two checkpoint IDs to differ only as approved. Add the exact 1,000/1,001 before-ID guards to `fork-child`, `claim-child-transfer`, public `suspend-child-session`, and internal `carry-forward-child`; do not rely on schema triggers as the service error boundary.

```ts
export interface SessionEndCarryForwardTicketLineageV1 {
  readonly lineageKind: "session-end-carry-forward-v1";
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly plannedWorkId: string;
  readonly previousParentSessionId: SessionId;
  readonly previousChildSessionId: SessionId;
  readonly correlationId: string;
  readonly suspensionEventPosition: string;
  readonly checkpointEventPosition: string;
  readonly transferEventPosition: string;
}
```

- [ ] **Step 4: Run 14S.2 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-child-saga.test.js dist-test/tests/child-workflow.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/lifecycle-storage.repositories.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
npm run typecheck
git add src/orchestrator/lifecycle/session-end-child.service.ts src/orchestrator/lifecycle/child-workflow.service.ts src/orchestrator/lifecycle/session-aggregate.ts src/orchestrator/lifecycle/lifecycle-projection-folds.ts src/orchestrator/storage/child-transfer.repository.ts src/orchestrator/storage/session-authority.repository.ts src/orchestrator/storage/lifecycle-projection.repository.ts src/orchestrator/storage/lifecycle-storage.types.ts src/orchestrator/integrity/lifecycle-integrity.service.ts tests/session-end-child-saga.test.ts tests/child-workflow.test.ts tests/session-aggregate.test.ts tests/lifecycle-projection-folds.test.ts tests/lifecycle-storage.repositories.test.ts tests/session-authority.repository.test.ts tests/qualified-checkpoint-quick-integrity.test.ts tests/qualified-checkpoint-full-integrity.test.ts
git commit -m "feat: carry session end child work forward"
```

### Task 14S.3: Prove all children resolved and atomically freeze the final checkpoint/outbox row

**Files:**

- Create: `src/orchestrator/lifecycle/session-end.coordinator.ts`
- Create: `tests/session-end.coordinator.test.ts`
- Modify: `src/orchestrator/lifecycle/session-end-workflow.service.ts`
- Modify: `src/orchestrator/lifecycle/checkpoint.service.ts`
- Modify: `src/orchestrator/storage/session-end.repository.ts`
- Modify: `src/orchestrator/storage/child-transfer.repository.ts`
- Modify: `src/orchestrator/storage/session-authority.repository.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-operational.store.ts`
- Modify: `tests/session-end-workflow.test.ts`
- Modify: `tests/checkpoint.service.test.ts`
- Modify: `tests/lifecycle-operational-store.test.ts`

- [ ] **Step 1: Write children-resolved proof RED tests**

Scan all direct child and source-root ticket history with binary order and `MAX_ROOT_CHILD_HISTORY_V1 + 1`. Validate claimed and unclaimed tickets, all-null/all-non-null claim tuples, transferred child exactly-one-ticket, no current-child/ticket double representation, terminal/claimed history counting, overflow as integrity failure, eventless CAS response loss, and no semantic event/outbox during the proof.

- [ ] **Step 2: Write final freeze/confirmation RED tests**

Cover sealed window, exact root/descendant coverage, direct historical checkpoint reads, canonical ending-scope union, capacity boundary, typed pending descriptor before append prepare, actual event/outbox atomicity, authoritative command hash, target order, rollback at renderer/key/repository/index/after-append boundaries, and a later eventless exact-row assertion before phase CAS.

```ts
it("rolls back final checkpoint and outbox together at every fault boundary", () => {
  for (const boundary of FINAL_QUEUE_FAULTS) {
    const before = snapshotSemanticState();
    assert.throws(() => recordFinalWithFault(boundary), expectedFault(boundary));
    assert.deepEqual(snapshotSemanticState(), before);
  }
});
```

- [ ] **Step 3: Run the exact RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(proves children resolved from all bounded child and ticket history|treats a 1001-row proof read as integrity failure|freezes only current children and validated unclaimed tickets|rolls back final checkpoint and outbox together at every fault boundary|confirms the exact planned row before advancing phase|leaves phase unchanged when the planned row is absent or mismatched)$" dist-test/tests/session-end.coordinator.test.js dist-test/tests/session-end-workflow.test.js dist-test/tests/checkpoint.service.test.js
```

- [ ] **Step 4: Implement one-action-per-drive coordination and final queue ordering**

Each `driveOnce` claims or renews, performs at most one child command or one root phase action, commits/returns, and never loops while SQLite is locked. After no child selection, the operational proof moves `requested -> children-resolved`. The semantic final transaction follows design section 13.5 exactly: queue prepare, append planning, `assertPlanned`, actual event plus lifecycle insert, checkpoint/frozen phase update, `assertCommitted`, projection/dedup, commit. The next eventless operation asserts the exact row and only then CASes `final-checkpoint-recorded -> ending-materialization-queued`.

- [ ] **Step 5: Run complete 14S gate, commit, and review**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-child-saga.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/session-end-workflow.test.js dist-test/tests/child-workflow.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/event-append-transaction.test.js dist-test/tests/event-integrity.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
npm run typecheck
npm run build
npm run test:build-artifacts
git diff --check
git add src/orchestrator/lifecycle/session-end.coordinator.ts src/orchestrator/lifecycle/session-end-workflow.service.ts src/orchestrator/lifecycle/checkpoint.service.ts src/orchestrator/storage/session-end.repository.ts src/orchestrator/storage/child-transfer.repository.ts src/orchestrator/storage/session-authority.repository.ts src/orchestrator/lifecycle/lifecycle-operational.store.ts tests/session-end.coordinator.test.ts tests/session-end-workflow.test.ts tests/checkpoint.service.test.ts tests/lifecycle-operational-store.test.ts
git commit -m "feat: freeze completed session end scope"
git status --short
```

Request fresh spec and quality reviews over the complete 14S range. Do not start 14W until both approve with no Critical/Important findings.

## Slice 14W — runtime, crash/replay, and final integration

### Task 14W.1: Replace reserved Task 14 runtime routes with exact owners

**Files:**

- Modify: `src/orchestrator/runtime/lifecycle-worker-runtime.ts`
- Modify: `src/orchestrator/runtime/lifecycle-worker-runtime.factory.ts`
- Modify: `src/orchestrator/runtime/lifecycle-worker-protocol.ts`
- Modify: `tests/lifecycle-worker-runtime.test.ts`
- Modify: `tests/lifecycle-worker-protocol.test.ts`
- Modify: `tests/lifecycle-executor.test.ts`

- [ ] **Step 1: Write exact routing/ownership RED tests**

Require semantic `request-session-end`, `amend-session-end`, and `cancel-session-end` to reach the one session-end service. Require `workflow-claim-next`, `workflow-claim`, `workflow-renew`, `workflow-release`, `workflow-eventless-phase`, and `workflow-recovery` to reach the one operational owner. Require internal `carry-forward-child` to reach the child service while every root action reaches the root service. Pin and prove the factory graph: semantic services receive only the one prepare/assert queue; that queue receives only read-only planning operations plus the immutable plan reader; `SqliteEventAppendStatements` receives a separate insert-only `insertLifecycle` writer facet backed by the same repository/connection. Neither services nor queue receive the writer, and append statements never receive the queue. All resources dispose before the active store closes.

Also prove `create-child-transfer`, internal validation-result execution, `outbox-claim-next`, `outbox-claim`, `outbox-renew`, `outbox-materialize`, and `outbox-failure` remain unavailable until their owning tasks land.

- [ ] **Step 2: Run runtime RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(routes Task 14 semantic and fenced operations to exact shared owners|routes carry-forward only to the dedicated child-target handler|keeps public transfer validation and materialization unavailable|constructs one connection-bound Task 14 runtime|disposes Task 14 resources before active store close)$" dist-test/tests/lifecycle-worker-runtime.test.js dist-test/tests/lifecycle-worker-protocol.test.js dist-test/tests/lifecycle-executor.test.js
```

- [ ] **Step 3: Implement runtime composition without enabling Version 2 production routing**

Materialize strict wire DTOs before domain calls. Do not pass raw worker records to services. Preserve the external executor's request/result correlation and unknown-outcome behavior. The factory owns exactly one connection, queue, repository set, semantic service, operational service, child service, and coordinator adapter.

- [ ] **Step 4: Run 14W.1 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-worker-runtime.test.js dist-test/tests/lifecycle-worker-protocol.test.js dist-test/tests/lifecycle-executor.test.js dist-test/tests/project-store-executor.test.js
npm run typecheck
git add src/orchestrator/runtime/lifecycle-worker-runtime.ts src/orchestrator/runtime/lifecycle-worker-runtime.factory.ts src/orchestrator/runtime/lifecycle-worker-protocol.ts tests/lifecycle-worker-runtime.test.ts tests/lifecycle-worker-protocol.test.ts tests/lifecycle-executor.test.ts
git commit -m "feat: route session end workflow operations"
```

### Task 14W.2: Close crash/replay, integrity, scope, and full-project gates

**Files:**

- Create: `tests/session-end.crash.test.ts`
- Modify: `tests/session-end.coordinator.test.ts`
- Modify: `tests/session-end-child-saga.test.ts`
- Modify: `tests/project-store-executor.test.ts`
- Modify: `tests/project-store-upgrade.test.ts`
- Modify: `scripts/smoke-worker.js`

- [ ] **Step 1: Consolidate the already-GREEN 42-case acceptance ledger as independent named tests**

Before adding this consolidation file, audit every design-section-18 item to an exact owning task and already-GREEN named test. If an item lacks one, return to that owning M/Q/R/S/W.1 task, add its behavioral RED, authorize the required production/test scope there, make it GREEN, rerun that slice review, and only then resume W.2. W.2 introduces no new behavioral RED and no production change.

Create one table with 42 unique case IDs/names and an explicit `ownerTask`/`ownerAnchor` for each request/child/CAS response loss, takeover, stale selection, G1/G2/G3, Version 1 cancellation replay, binary ordering, Version 2 dual checkpoint, 1,000/1,001 boundary, open/seal/unchanged, final-queue fault, trigger matrix, predecessor derivation, migration rollback, runtime routing, and disposal behavior. Register every case as an independent Node test, then add a separate manifest test for count, unique IDs/names, and nonempty owner mapping. Every negative calls a separately proven valid control.

```ts
for (const testCase of CRASH_REPLAY_CASES) {
  test(testCase.name, testCase.run);
}

test("covers every approved Task 14 crash and replay case", () => {
  assert.equal(CRASH_REPLAY_CASES.length, 42);
  assert.equal(new Set(CRASH_REPLAY_CASES.map(({ id }) => id)).size, 42);
  assert.equal(new Set(CRASH_REPLAY_CASES.map(({ name }) => name)).size, 42);
  assert.ok(CRASH_REPLAY_CASES.every(({ ownerTask, ownerAnchor }) => (
    ownerTask.length > 0 && ownerAnchor.length > 0
  )));
});
```

- [ ] **Step 2: Run the exact Task 14 anchor gate**

```powershell
npm run test:build
$pattern = '^(derives RFC and session-end UUIDv5 golden vectors|strictly decodes and hashes bounded effective state at exact UTF-8 cap|keeps legacy request amend cancel decoders and accepts only V3 current events|keeps ChildWorkTransferCreated V1 frozen and admits only the internal V2 dual-checkpoint shape|applies migration 0004 and preserves frozen 0002 0003 hashes|rejects schema-3 nonterminal workflows with zero writes|computes exact V2 workflow-generation fingerprint predecessor chains|strictly decodes the six-key persisted validation plan and rejects ordering identity cap violations|renders compatibility log golden bytes deterministically|derives prior fingerprint from the immediate lower revision regardless of status|preserves authoritative lifecycle command hash while recording the outbox target|requests G1 without outbox and reopens cancelled G2 as G3|amend unchanged preserves phase and frozen bytes|selects one eligible child by binary UUID order|carries an already suspended child with a newer governing checkpoint|proves children resolved from all bounded child and ticket history|rolls back final checkpoint and outbox together at every fault boundary|confirms the exact planned row before advancing phase|routes carry-forward only to the dedicated child-target handler|covers every approved Task 14 crash and replay case)$'
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern=$pattern dist-test/tests/session-end-identifiers.test.js dist-test/tests/session-end-effective-state.test.js dist-test/tests/lifecycle-contracts.test.js dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/session-end.repository.test.js dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/event-append-transaction.test.js dist-test/tests/session-end-workflow.test.js dist-test/tests/session-end-child-saga.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/lifecycle-worker-runtime.test.js dist-test/tests/session-end.crash.test.js
```

Confirm all 20 names appear in output; file-level zero-match wrapper entries do not count as anchors.

- [ ] **Step 3: Run the focused Task 14 boundary suite**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-identifiers.test.js dist-test/tests/session-end-effective-state.test.js dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/session-end.repository.test.js dist-test/tests/session-end-policy.test.js dist-test/tests/session-end-workflow.test.js dist-test/tests/session-end-child-saga.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/session-end.crash.test.js dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/lifecycle-contracts.test.js dist-test/tests/lifecycle-intent.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/lifecycle-worker-protocol.test.js dist-test/tests/lifecycle-worker-runtime.test.js dist-test/tests/lifecycle-executor.test.js dist-test/tests/event-append-transaction.test.js dist-test/tests/event-integrity.test.js dist-test/tests/source-state.provider.test.js dist-test/tests/child-workflow.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js
```

- [ ] **Step 4: Run full verification and immutable-scope checks**

```powershell
npm run typecheck
npm run build
npm run test:build-artifacts
npm test
git diff --check
git diff --exit-code 72f4fce -- src/orchestrator/storage/migrations/0002-session-lifecycle.ts src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts
git status --short
```

The first full-suite failure may be diagnosed once with the exact failing test, then one capped full-suite rerun. Do not repeatedly rerun a native/environmental failure without evidence.

- [ ] **Step 5: Commit the final test closure and obtain independent reviews**

```powershell
git add tests/session-end.crash.test.ts tests/session-end.coordinator.test.ts tests/session-end-child-saga.test.ts tests/project-store-executor.test.ts tests/project-store-upgrade.test.ts scripts/smoke-worker.js
git commit -m "test: close Task 14 crash and replay gates"
git status --short
```

Request fresh spec and quality reviews over the complete Task 14 range from the pre-14M base. Reviewers must explicitly audit migration immutability, event/source-of-truth correlation, command-hash versus descriptor integrity, root/child authorization audience, dual-checkpoint lineage, lifetime bounds, exact-row-before-CAS ordering, Task 15/16 ownership, unavailable routes, and resource disposal. Resolve all Critical/Important findings with new RED → GREEN evidence and rerun the exact final gates affected by each fix.

## Task 14 completion boundary

Task 14 is complete only when:

- schema 4 is the current build/bootstrap/upgrade authority and migrations 0002/0003 are unchanged;
- a request can durably reach `ending-materialization-queued` with an exact immutable compatibility-log planned row;
- no filesystem target has been created or replaced;
- Task 15 can consume six-key plans and the real immutable queue reader without changing Task 14Q contracts;
- Task 16 can extend the plan reader with mutable materialization operations without moving planning ownership back;
- that extension is explicitly `LifecycleOutboxOperationalRepository extends LifecycleOutboxPlanReader`, while Task 14Q types remain unchanged;
- production Version 2 routing remains disabled; and
- the reviewed final commit leaves the tracked worktree and index clean.
