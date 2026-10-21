# Task 14 Root-Anchored Session-End Saga Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Approach A session-end workflow through a durable `ending-materialization-queued` boundary, including schema 4, event-carried effective state, one-child-at-a-time carry-forward, an explicit Version 3 final-checkpoint marker, and deterministic event-authoritative lifecycle-log planning without enabling Version 2 production routing.

**Architecture:** A root `SessionEndRequested` Version 3 event anchors one deterministic workflow UUID and one bounded effective-state snapshot. A coordinator advances at most one durable action per drive, delegating child carry-forward to a dedicated child-targeted internal semantic command. Task 14Q renders one authenticated root/direct-child/foreign-claim event closure, uses an exact outer Version 3 checkpoint as the final marker, and inserts the immutable lifecycle outbox row atomically with the triggering event; Task 15 later validates and appends terminal semantics, while Task 16 alone owns mutable claims, filesystem replacement, and acknowledgement.

**Tech Stack:** TypeScript 5.8, Node.js 22 test runner, SQLite migrations/transactions, canonical JSON, Node `crypto`, existing lifecycle semantic/operational stores and worker runtime.

---

## Global Constraints

- Approved design: `docs/superpowers/specs/2026-08-09-task-14-root-anchored-session-end-saga-design.md` at commit `72f4fce6c6a867c96be02b2afbf4506447c6964e`.
- Approved Task 14Q.2 addendum: `docs/superpowers/specs/2026-08-11-task-14q-2-compatibility-log-renderer-contract-addendum-design.md` at commit `2b0f045`; it is authoritative for Q.2-Q.6 and the affected S.3 integration wherever it conflicts with the 2026-08-09 design or this plan's older prose.
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
| Q.2 addendum Sections 3-5 final marker, normalization, closure | 14Q.2a, 14Q.3-14Q.5 |
| Q.2 addendum Sections 6-9 frozen epochs, validation, bytes, handle state | 14Q.2b, 14Q.4, 14Q.6, 14S.3 |
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
- Only outer `SessionCheckpointRecorded` Version 3 is a final marker. Its exact payload keys are `checkpoint`, `baseEventPosition`, `checkpointEventPosition`, `finalCheckpointBindingVersion`, `workflowId`, and `workflowGeneration`; its nested checkpoint remains Version 1 or Version 2. Outer checkpoint Version 1/2 stays ordinary forever.
- Renderer authority is the strict source-root stream, every lifetime direct-child stream, and the exact foreign claimant-child fork/claim pair for source-root tickets claimed before the trigger. Global positions may gap; each included stream prefix is contiguous.
- At the Version 3 marker, accepted, deferred, rejected, and unresolved-ticket bytes freeze together with the exact checkpoint and per-child heads. Post-marker child events or claims cannot rewrite a preserved revision.
- Outer Version 1/2 amendments reset validation. Outer Version 3 `open` resets; outer Version 3 `seal`/`unchanged` preserve. Marker/child-snapshot action dispatch is separate from validation dispatch.
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

Cover exact keys, canonical sorting, deep freeze, strict request/policy/context correlation, hash stability, and own `__proto__` preservation/rejection. Preserve every subordinate checkpoint/profile/request limit. Exercise the whole-state 1 MiB defense-in-depth limit through a raw canonical-size guard independently of subordinate decoding: exactly 1,048,576 canonical UTF-8 bytes passes the size guard and 1,048,577 fails it. Separately prove that genuinely decodable effective states remain valid under their authoritative subordinate maxima. Use multibyte fixtures whose scalar count differs from byte count. Never claim that an exact-cap raw probe is a valid effective state.

```ts
it("enforces the session end effective-state raw UTF-8 guard at exact cap", () => {
  const exact = rawCanonicalProbeAtBytes(SESSION_END_EFFECTIVE_STATE_MAX_CANONICAL_BYTES);
  assert.doesNotThrow(() => assertSessionEndEffectiveStateCanonicalSizeV1(exact));
  assert.throws(
    () => assertSessionEndEffectiveStateCanonicalSizeV1(rawCanonicalProbeAtBytes(1_048_577)),
    hasCode("LIFECYCLE_INPUT_INVALID"),
  );
});
```

- [ ] **Step 4: Run the codec RED, then implement the exact approved snapshot**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^enforces the session end effective-state raw UTF-8 guard at exact cap$" dist-test/tests/session-end-effective-state.test.js
```

Implement `SessionEndEffectiveStateV1`, its exact-key decoders, the shared raw canonical-size guard `assertSessionEndEffectiveStateCanonicalSizeV1`, canonical UTF-8 cap, domain-separated SHA-256 hash, immutable policy/context fields, and evidence-window/context correlation helpers from design sections 5.1-5.4. The decoder must call the same guard, but an exact-cap raw probe is not claimed to be a valid effective state. Reuse existing strict canonical JSON helpers; copy own properties with descriptors so `__proto__` cannot disappear.

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
- Modify: `src/orchestrator/storage/session-authority.repository.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-projection-folds.ts`
- Modify: `src/orchestrator/storage/lifecycle-projection.repository.ts`
- Modify: `src/orchestrator/integrity/lifecycle-integrity.service.ts`
- Modify: `tests/lifecycle-contracts.test.ts`
- Modify: `tests/session-aggregate.test.ts`
- Modify if required: `tests/session-authority.repository.test.ts`
- Modify if required: `tests/lifecycle-projection-folds.test.ts`
- Modify if required: `tests/lifecycle-storage.repositories.test.ts`
- Modify if required: `tests/qualified-checkpoint-quick-integrity.test.ts`
- Modify if required: `tests/qualified-checkpoint-full-integrity.test.ts`

- [ ] **Approved fix: make raw decoding truthful and deferred consumers fail closed**

`decodeLifecycleEvent(value: unknown)` returns the complete V1/V2/V3 codec
union. Add one explicit Version 1/Version 2-only decoder that rejects outer
Version 3. Route exactly the six unready raw-storage calls in session authority,
projection folds, projection repository, and lifecycle integrity through that
temporary decoder. Do not implement their Version 3 semantics in this task.
Their owning later tasks replace the boundary as specified in design section
5.3.

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^keeps raw lifecycle decoding truthful while legacy consumers fail closed$" dist-test/tests/lifecycle-contracts.test.js
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-contracts.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/lifecycle-storage.repositories.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
npm run typecheck
git diff --check
```

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

- `identity`, `source.streamId`, `source.streamType`, and `source.startEventPosition` come only from the first strict committed root `SessionStarted`; `source.streamId` must equal the canonical `session/${identity.sessionId}`. Source-root/direct-child events match that full context. A foreign claim pair matches source project/vault/store and matches itself on workspace/branch, but never replaces rendered source identity. `source.through*` comes from the exact planned/committed trigger.
- `lifecycle` is the strict root aggregate through the candidate trigger plus the already-decoded workflow origin. Request/amend effective state supplies child policy/window; cancellation restores active/suspended; abandonment and end produce their terminal states. Direct abandonment has null workflow/policy/window.
- `acceptedChildren` resolves dispositions per report. No disposition or latest `superseded` omits that report; accepted emits every item; partially accepted splits accepted from deferred/rejected; rejected emits every item as unresolved. Before a marker it folds at the trigger cutoff. While a marker is in force it folds at the exact frozen per-child heads. It sorts by binary `(childSessionId, reportId, category, itemIndex, itemId)`.
- `unresolvedFollowUps` includes the complementary deferred/rejected disposition items plus source-root carry-forward tickets unclaimed at the active cutoff. A Version 3 final marker freezes these bytes with accepted children; preserving triggers reuse them even if a later claim commits. It sorts by binary `(kind, sourceChildSessionId, reportId-or-transferTicketId, category-or-empty, itemIndex-or-minus-one, itemId-or-empty)`.
- `finalCheckpoint` is non-null only while an outer Version 3 `SessionCheckpointRecorded` marker is in force. Its exact six-key payload binds workflow ID/generation and nests strict Checkpoint V1 or V2. The fingerprint is recomputed as SHA-256 over `project-memory/checkpoint/v{checkpointVersion}\n` plus canonical checkpoint JSON; it is not duplicated in the event. Version 1 coverage is copied exactly. Version 2 coverage maps only the DTO above, sorted by binary `adapterSessionId`; frame/coverage algorithms, key IDs, domains, fingerprints, and ordinal frames are excluded.
- `validation` follows the exhaustive fold table below. `results` contains only strict retained results for the rendered workflow state and sorts by binary `resultId`; every non-null `validationResultIds` array uses the same order. Committed start/completion times and validation output fingerprint metadata remain because they are semantic event fields, not renderer state.
- `materialization` is derived before rendering from `MaterializationProjectionInputV1` and the exact candidate. It explicitly excludes `expectedPriorFingerprint`, `nextFingerprint`, row `content_hash`, status, attempts, claims, tokens, failure data, and acknowledgement data; including any of them would create a circular or operationally unstable byte contract.
- Every event/checkpoint/materialization position is a positive canonical decimal string; coverage ordinals and stream versions use their existing nonnegative canonical rules. The declared JSON numbers are `documentVersion`, workflow generation, item index, checkpoint/profile versions, and quality score. Every timestamp is an already-committed canonical semantic timestamp; `recordedAt`, current time, and process time are never rendered.

The renderer input is one authenticated closure at positions strictly before the trigger plus one normalized trigger. The closure contains the complete source-root prefix, every lifetime direct-child prefix, and the exact foreign `SessionForked` stream-version-1 plus `ChildWorkTransferClaimed` stream-version-2 pair for each pre-trigger claim. Global gaps are legal; every included stream starts at version 1 and is contiguous. Candidate input and committed `StoredEvent` normalize to one semantic shape; no unavailable event, command, clock, intent, or hash field is fabricated.

Validation projection is closed over strict workflow replay; it never reads mutable runner state:

| Fold state at the candidate trigger | `validation` | `validationResultIds` / `results` | `qualityScore` | `safeFailureCode` |
|---|---|---|---|---|
| Direct terminal `SessionAbandoned` with null workflow origin | `null` | absent with the whole object | absent | absent |
| Workflow exists but no pass/fail/invalidation is currently in force, including before validation and while results are accumulating | status `not-run` | all retained current workflow result IDs and their exact strict `ValidationResultV1` values, both binary-sorted by `resultId` | `null` | `null` |
| Latest in-force verdict is `SessionEndVerificationPassed` | status `passed` | exactly the event's complete sorted `validationResultIds` and the matching strict results | exact event `qualityScore` | `null` |
| Latest in-force verdict is `SessionEndVerificationFailed` | status `failed` | exactly the event's complete sorted `validationResultIds` and the matching strict results | `null` | exact event `safeFailureCode` |
| Latest in-force verdict is `SessionEndVerificationInvalidated` | status `invalidated` | carry exactly the IDs/results from the passed event named by `previousVerificationEventPosition`; the invalidation event cannot replace them | reset to `null` | exact invalidation event `safeFailureCode` |

A new/reopened request starts the retained set empty. Outer Version 1/2 `SessionEndAmended` always resets validation, including Version 2 `seal`/`unchanged`. Outer Version 3 `open` and cancellation reset; outer Version 3 `seal`/`unchanged` preserve exactly. Marker/child-snapshot dispatch remains separate: Version 1 implicit unchanged and Version 2/3 explicit unchanged preserve the frozen marker epoch. A workflow-origin abandonment preserves the last valid validation projection. `SessionEnded` preserves the passed projection whose event position it names. Any missing/extra result, result from another workflow lineage without a contiguous Version 3 carry chain, unsorted/duplicate ID, verdict/result-set mismatch, post-verdict result, or invalidation/end that does not name the in-force passed event is `INTEGRITY_FAILURE`. The committed golden fixtures cover `not-run` (`ending-v2` and `cancelled-v2`), `passed` (`completed-v2`), `failed` (`failed-v2`), `invalidated` (`invalidated-v2`), and null (`abandoned-v2`).

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

### Task 14Q.2a: Add the Version 3 final marker and authenticated closure contract

**Files:**

- Modify: `src/orchestrator/lifecycle/contracts/events.ts`
- Modify: `src/orchestrator/lifecycle/materialization-queue.port.ts`
- Modify: `src/orchestrator/lifecycle/session-aggregate.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-command.store.ts`
- Modify: `src/orchestrator/lifecycle/child-workflow.service.ts`
- Create: `src/orchestrator/materialization/prepared-materialization-handle.ts`
- Modify: `src/orchestrator/storage/session-authority.repository.ts`
- Modify: `src/orchestrator/storage/session-end-effective-state-migration-preflight.ts`
- Modify: `src/orchestrator/storage/migrations/0004-session-end-effective-state.ts`
- Modify: `src/orchestrator/integrity/lifecycle-integrity.service.ts`
- Modify: `tests/lifecycle-contracts.test.ts`
- Modify: `tests/lifecycle-materialization-queue.test.ts`
- Modify: `tests/session-aggregate.test.ts`
- Modify: `tests/lifecycle-projection-folds.test.ts`
- Modify: `tests/lifecycle-command-store.test.ts`
- Modify: `tests/session-authority.repository.test.ts`
- Modify: `tests/session-end-effective-state-migration.test.ts`
- Modify: `tests/migration-registry.test.ts`
- Modify: `tests/qualified-checkpoint-quick-integrity.test.ts`
- Modify: `tests/qualified-checkpoint-full-integrity.test.ts`

**Interfaces:**

- Consumes: strict `CheckpointV1`/`CheckpointV2`, `LifecycleEventBaseV1`, Q.1 `MaterializationProjectionInputV1`, workflow origin, and the existing lifecycle intent witness hash/domain.
- Produces: `SessionCheckpointRecordedPayloadV3`, a Version 3 checkpoint member in `LifecycleEventV3`, `LifecycleRenderEventV1`, `LifecycleRenderClosureV1`, `readStrictLifecycleClosure(projectId, rootSessionId, throughPositionExclusive)`, and a queue-private prepared-handle owner for Q.2b/Q.4.

```ts
export interface SessionCheckpointRecordedPayloadV3 {
  readonly checkpoint: CheckpointV1 | CheckpointV2;
  readonly baseEventPosition: string;
  readonly checkpointEventPosition: string;
  readonly finalCheckpointBindingVersion: 1;
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
}

export interface LifecycleRenderEventV1 {
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly branchScopeId: BranchScopeId | null;
  readonly branchRef: string | null;
  readonly streamId: string;
  readonly streamVersion: string;
  readonly globalPosition: string;
  readonly sessionId: SessionId;
  readonly parentSessionId: SessionId | null;
  readonly eventType: LifecycleEventType;
  readonly eventSchemaVersion: number;
  readonly occurredAt: string;
  readonly payload: JsonValue;
  readonly materializationOrigin: LifecycleMaterializationOriginV1 | null;
  readonly legacyIntentSemantics: {
    readonly effectiveState: SessionEndEffectiveStateV1;
    readonly evidenceWindowAction: "unchanged" | "open" | "seal" | null;
  } | null;
}

export type LifecycleRenderTriggerV1 = LifecycleRenderEventV1 & {
  readonly materializationOrigin: LifecycleMaterializationOriginV1;
};

export interface LifecycleRenderClosureV1 {
  readonly root: readonly LifecycleRenderEventV1[];
  readonly directChildren: readonly Readonly<{
    childSessionId: SessionId;
    events: readonly LifecycleRenderEventV1[];
  }>[];
  readonly foreignClaims: readonly Readonly<{
    fork: LifecycleRenderEventV1;
    claim: LifecycleRenderEventV1;
  }>[];
}

export interface LifecycleMaterializationPlanningReads {
  readGlobalTailPosition(): bigint;
  readStrictLifecycleClosure(
    projectId: ProjectId,
    rootSessionId: SessionId,
    throughPositionExclusive: bigint,
  ): LifecycleRenderClosureV1;
  readVerifiedImmediatePredecessor(
    projectId: ProjectId,
    sessionId: SessionId,
    artifactKind: "compatibility-session-log",
    beforeRevision: bigint,
  ): LifecycleOutboxPlannedRevision | null;
}

export class PreparedMaterializationHandleOwner {
  create(pendingOutbox: PendingLifecycleOutboxV1): PreparedMaterializationQueueV1;
  capturePlanned(
    handle: PreparedMaterializationQueueV1,
    event: StoredEvent,
    validate: (event: StoredEvent) => void,
  ): void;
  consumeCommitted(
    handle: PreparedMaterializationQueueV1,
    event: StoredEvent,
    validate: (event: StoredEvent) => void,
  ): void;
}
```

The planning-read interface is exported only from this internal module so the
concrete queue can receive it; do not re-export it from a public semantic API.
Both handle transition methods first enter a non-reentrant internal validating
state, then run the validator inside the owner. On success they snapshot and
advance; on throw they move the handle to terminal `failed` before rethrowing,
so callers cannot forget a separate cleanup call.

- [ ] **Step 1: Write the exact Version 3 marker codec RED**

Add one valid nested-V1 marker and one valid nested-V2 marker. Mutate each of the six payload keys independently, add an extra key, use explicit null, move the event to a child stream, mismatch checkpoint/event positions/session, use a malformed workflow UUID, and use zero/unsafe workflow generation. An exact but foreign workflow ID/generation is codec-valid and is rejected later by aggregate/Q.1/SQL/integrity binding tests.

```ts
it("decodes only exact root-bound Version 3 final checkpoint markers", () => {
  assert.equal(decodeLifecycleEventV3(finalMarker(1)).eventType, "SessionCheckpointRecorded");
  assert.equal(decodeLifecycleEventV3(finalMarker(2)).eventType, "SessionCheckpointRecorded");
  for (const hostile of hostileFinalMarkers()) {
    expectCode("LIFECYCLE_INPUT_INVALID", () => decodeLifecycleEventV3(hostile));
  }
});
```

- [ ] **Step 2: Run the codec RED, add the exact type/decoder, and return GREEN**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^decodes only exact root-bound Version 3 final checkpoint markers$" dist-test/tests/lifecycle-contracts.test.js
```

Expected RED: `SessionCheckpointRecorded` is outside `LIFECYCLE_EVENT_TYPES_V3` or the valid marker is rejected. Add the new union member, exact `decodePayloadV3` branch, nested checkpoint-version dispatch, root/session/position correlations, and deep freeze. Do not change outer Version 1/2 decoders.

- [ ] **Step 3: Write aggregate and authority-reader RED cases**

Require a valid marker only on an ending root whose current workflow ID/generation matches. Require `requireCheckpointAtEventPosition`, authority `loadEvents`, and `latestCheckpoint` to accept nested V1/V2 inside outer V3 while retaining exact outer Version 1/2 reads and selecting by the nested checkpoint's fingerprint domain. Widen the authority return type to `LifecycleEventCodecResult` and update child-workflow type guards so current child operations still admit only their exact historical event variants. After codec GREEN, retain the existing projection-classifier cases as characterization regressions; do not claim them as behavioral RED because classification by event type is already correct.

```ts
it("binds a Version 3 final marker to the current ending workflow", () => {
  const ending = foldSession([started(), requestedV3(WORKFLOW_ID, 1)]);
  assert.doesNotThrow(() => evolveSession(ending, finalMarkerEvent(WORKFLOW_ID, 1)));
  expectLifecycleCode(
    "INTEGRITY_FAILURE",
    () => evolveSession(ending, finalMarkerEvent(WORKFLOW_ID, 2)),
  );
});
```

- [ ] **Step 4: Run the replay REDs, implement the allowlists/bindings, and return GREEN**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(binds a Version 3 final marker to the current ending workflow|reads outer Version 3 final checkpoints with nested Version 1 or Version 2 bodies|selects the latest outer Version 3 checkpoint by its nested checkpoint domain)$" dist-test/tests/session-aggregate.test.js dist-test/tests/session-authority.repository.test.js
```

Expected RED: the aggregate allowlist rejects the event and the authority reader uses `decodeLegacyLifecycleEvent`/three-key payload assumptions. Extend only the current Version 3 allowlist; use `decodeLifecycleEvent`, dispatch the nested checkpoint by `checkpointVersion`, and require exact marker workflow binding without changing schema-2/schema-3 legacy preflight behavior.

- [ ] **Step 5: Write migration-0004/index RED cases**

Apply current schema, insert one production-decodable authenticated marker/outbox control with each nested checkpoint version, then independently corrupt payload keys, SQL nulls, canonical root stream/parent, source workspace, command index, internal action/intent, workflow phase/generation, sealed evidence window, existing frozen checkpoint, base/global/checkpoint correlation, outbox schema, and origin binding. Exercise both workflow-evidence INSERT and UPDATE paths so neither can freeze an outer Version 1/2 checkpoint. Add a positive generation-G2 row reached by Version 3 `unchanged` that preserves a marker created at G1, plus a negative that rewrites any frozen pointer/bytes during that carry; the guard binds marker payload generation to `evidence_frozen_generation` (G1), not the current workflow generation (G2). Assert the direct-child and claim event indexes exist and `EXPLAIN QUERY PLAN` selects them for exact lookups. Before applying 0004, seed each direction of schema-3 ticket/claim pointer drift, fork/authority drift, and an active frozen pointer or checkpoint-origin lifecycle row that treats outer Version 1/2 as final; require preflight to reject each with zero migration writes while ordinary Version 1/2 checkpoint history remains upgradeable. As the positive identity control, upgrade an otherwise-valid schema-3 foreign fork/claim pair whose claimant workspace/branch differs from the source but whose project/vault/store and internal pair relation are exact. Reassert frozen 0002/0003 hashes.

```ts
it("admits only authenticated Version 3 final markers at schema 4", () => {
  const store = schema4Store();
  assert.doesNotThrow(() => insertAuthenticatedFinalMarker(store));
  for (const mutation of FINAL_MARKER_SQL_MUTATIONS) {
    assert.throws(() => insertMutatedFinalMarker(schema4Store(), mutation));
  }
});

it("indexes direct-child forks and transfer claims as immutable event witnesses", () => {
  const indexes = migrationIndexes(sessionEndEffectiveStateMigration);
  assert(indexes.has("events_lifecycle_direct_child_v4"));
  assert(indexes.has("events_lifecycle_transfer_claim_v4"));
});
```

- [ ] **Step 6: Run the migration REDs, change only 0004, and return GREEN**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(rejects schema-3 ticket claim pointer drift before schema 4|rejects schema-3 fork authority drift before schema 4|rejects schema-3 legacy final pointers before schema 4|upgrades an authenticated cross-workspace foreign claim pair|admits only authenticated Version 3 final markers at schema 4|requires Version 3 markers in both workflow evidence guards|preserves an earlier Version 3 marker through unchanged workflow carry|rejects frozen marker rewrite during unchanged workflow carry|binds Version 3 checkpoint outbox origin directly to payload workflow identity|indexes direct-child forks and transfer claims as immutable event witnesses|applies migration 0004 and preserves frozen 0002 0003 hashes)$" dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/migration-registry.test.js
```

Expected RED: schema 4 rejects outer Version 3 checkpoints and the indexes are absent. Add null-total guards to 0004; drop and recreate both copied `workflow_instances_evidence_v3_insert_guard` and `workflow_instances_evidence_v3_update_guard` so a new or changed frozen group requires the exact marker; require checkpoint outbox outer Version 3 and direct payload/origin equality; and add:

```sql
CREATE INDEX events_lifecycle_direct_child_v4
ON events(project_id, parent_session_id, global_position)
WHERE stream_type = 'session'
  AND event_type = 'SessionForked'
  AND event_schema_version = 1;

CREATE INDEX events_lifecycle_transfer_claim_v4
ON events(project_id, json_extract(payload_json, '$.transferTicketId'), global_position)
WHERE stream_type = 'session'
  AND event_type = 'ChildWorkTransferClaimed'
  AND event_schema_version = 1;
```

The claim command inserts fork/claim events before its ticket CAS. Therefore no event INSERT trigger may require the mutable ticket pointer to be set already. Add a ticket UPDATE guard that proves any null-to-claimed tuple against the already-inserted indexed fork/claim pair. Preflight proves fork/authority and ticket/claim equivalence in both directions before 0004, including orphan/duplicate/null-pointer negatives and exact fork-v1/claim-v2 command/index/causation linkage. Full integrity repeats the event-authoritative proof after upgrade. Do not reorder the command, edit migrations 0002/0003, or let schema-3 preflight admit Version 3.

After the SQL and all mutation tests are GREEN, compute migration 0004's new
checksum once and commit it as an independent literal assertion in
`migration-registry.test.ts`; never derive the expected value from the migration
object under test. This freezes the unreleased schema-4 contract from Q.2a
forward while the source-file hashes for 0002/0003 remain unchanged.

- [ ] **Step 7: Write queue-contract, frozen-workflow, and integrity RED cases**

At Q.1 input, table the complete prospective trigger schema/payload/origin matrix: checkpoint/amend/cancel are current outer Version 3; verification failure/invalidation, workflow/direct abandonment, and ended retain their frozen outer versions; only direct abandonment accepts terminal-event origin. Promote the port's private artifact literal to the exported `COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND` and reuse it throughout the port. Reuse a shared payload-only decoder; never duplicate event codecs or synthesize a fake event envelope. Checkpoint adds exact six-key payload, position/session/workspace correlations, and workflow-origin equality. Branch scope/ref is authenticated later from the closure; the Q.1 `context.branchScopeId` remains assertion-only. Rename the private read seam to `readStrictLifecycleClosure`. Add an executable prepared-handle owner with an owner-local `WeakMap`, full immutable planned-`StoredEvent` capture, fail-first validator wrappers, and exact prepared → planned → committed progression. The owner module contains the sole audited cast/factory that can construct the private branded handle; assert by source/API review that the concrete queue and every other module have no `as PreparedMaterializationQueueV1` construction site. In command-store/full replay, outer V1/V2 checkpoints never create final state; outer V3 does. An earlier marker may survive only a contiguous marker-preserving amendment chain; open/cancel/reopen clear it. Quick/full integrity must reject marker/payload/intent/workflow/outbox mismatches.

```ts
it("requires Version 3 final checkpoint triggers to match workflow origin", () => {
  assert.doesNotThrow(() => decodeMaterializationProjectionInputV1(finalProjection(3)));
  assert.throws(() => decodeMaterializationProjectionInputV1(finalProjection(2)));
  assert.throws(() => decodeMaterializationProjectionInputV1(finalProjection(3, { foreignOrigin: true })));
});

it("owns and burns opaque prepared handles at runtime", () => {
  const owner = new PreparedMaterializationHandleOwner();
  const handle = owner.create(pendingLifecycle());
  owner.capturePlanned(handle, plannedEvent(), () => undefined);
  owner.consumeCommitted(handle, plannedEvent(), () => undefined);
  assert.throws(() => owner.consumeCommitted(handle, plannedEvent(), () => undefined));
});
```

- [ ] **Step 8: Run the invariant REDs, implement the smallest replay changes, and return GREEN**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(enforces the complete prospective trigger schema payload and origin matrix|requires Version 3 final checkpoint triggers to match workflow origin|owns and burns opaque prepared handles at runtime|uses one audited opaque handle construction site|burns handles when planned or committed validation throws|rejects forged foreign skipped reversed and reused handles|captures the complete planned StoredEvent before commit|treats only Version 3 checkpoint markers as frozen final state|carries an earlier final marker only through marker-preserving amendments|quick integrity binds the Version 3 final marker|full integrity binds the Version 3 final marker)$" dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
```

Expected RED: Q.1 accepts checkpoint schema 1/2 and replay infers finality from intent/position. Make marker presence event-version-driven. Preserve legacy amendment validation behavior; do not reinterpret outer Version 1/2 validation here.

- [ ] **Step 9: Run the Q.2a consolidation gate and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-contracts.test.js dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/child-workflow.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/migration-registry.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
npm run typecheck
git diff --check
git diff --exit-code 72f4fce -- src/orchestrator/storage/migrations/0002-session-lifecycle.ts src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts
git add src/orchestrator/lifecycle/contracts/events.ts src/orchestrator/lifecycle/materialization-queue.port.ts src/orchestrator/lifecycle/session-aggregate.ts src/orchestrator/lifecycle/lifecycle-command.store.ts src/orchestrator/lifecycle/child-workflow.service.ts src/orchestrator/materialization/prepared-materialization-handle.ts src/orchestrator/storage/session-authority.repository.ts src/orchestrator/storage/session-end-effective-state-migration-preflight.ts src/orchestrator/storage/migrations/0004-session-end-effective-state.ts src/orchestrator/integrity/lifecycle-integrity.service.ts tests/lifecycle-contracts.test.ts tests/lifecycle-materialization-queue.test.ts tests/session-aggregate.test.ts tests/lifecycle-projection-folds.test.ts tests/lifecycle-command-store.test.ts tests/session-authority.repository.test.ts tests/session-end-effective-state-migration.test.ts tests/migration-registry.test.ts tests/qualified-checkpoint-quick-integrity.test.ts tests/qualified-checkpoint-full-integrity.test.ts
git commit -m "feat: mark final workflow checkpoints explicitly"
```

### Task 14Q.2b: Implement semantic normalization, projection, and literal rendering

**Files:**

- Create: `src/orchestrator/materialization/vault-artifact-path.ts`
- Create: `src/orchestrator/materialization/lifecycle-render-event.ts`
- Create: `src/orchestrator/materialization/sqlite-lifecycle-render-closure.reader.ts`
- Create: `src/orchestrator/materialization/compatibility-log.projection.ts`
- Create: `src/orchestrator/materialization/compatibility-log.renderer.ts`
- Create: `tests/support/compatibility-log-reference.ts`
- Create: `tests/lifecycle-render-closure.reader.test.ts`
- Create: `tests/compatibility-log-renderer.test.ts`
- Create: `tests/fixtures/compatibility-log/.gitattributes`
- Create: `tests/fixtures/compatibility-log/ending-v2.md`
- Create: `tests/fixtures/compatibility-log/failed-v2.md`
- Create: `tests/fixtures/compatibility-log/cancelled-v2.md`
- Create: `tests/fixtures/compatibility-log/invalidated-v2.md`
- Create: `tests/fixtures/compatibility-log/abandoned-v2.md`
- Create: `tests/fixtures/compatibility-log/completed-v2.md`

**Interfaces:**

- Consumes: Q.2a `LifecycleRenderClosureV1`, `LifecycleRenderEventV1`, strict committed `StoredEvent`, Q.1 projection input/origin, canonical JSON, and the frozen compatibility DTO grammar above.
- Produces: canonical artifact target derivation, two strict trigger normalizers, one pure projection fold, and one fresh caller-owned UTF-8/LF render buffer for Q.4.

```ts
export interface CompatibilityLogTargetV1 {
  readonly artifactPath: string;
  readonly targetKey: string;
  readonly materializationRevision: string;
}

export interface CompatibilityLogProjectionInputV2 {
  readonly closure: LifecycleRenderClosureV1;
  readonly trigger: LifecycleRenderTriggerV1;
  readonly target: CompatibilityLogTargetV1;
}

export interface AuthenticatedLifecycleCommandV1 {
  readonly commandHash: string;
  readonly lifecycleAuthorizationKind: LifecycleIntentAuthorizationKind | null;
  readonly intentWitnessJson: string | null;
  readonly witnessEventId: string | null;
}

export interface AuthenticatedStoredLifecycleEventV1 {
  readonly event: StoredEvent;
  readonly command: AuthenticatedLifecycleCommandV1;
}

export function deriveCompatibilityLogTarget(
  startedAt: string,
  sessionId: SessionId,
  triggeringEventPosition: bigint,
): CompatibilityLogTargetV1;

export function normalizeCandidateLifecycleRenderEvent(
  input: MaterializationProjectionInputV1,
  closure: LifecycleRenderClosureV1,
): LifecycleRenderTriggerV1;

export function normalizeCommittedLifecycleRenderEvent(
  input: AuthenticatedStoredLifecycleEventV1,
): LifecycleRenderTriggerV1;

export function normalizeCommittedLifecycleClosureEvent(
  input: AuthenticatedStoredLifecycleEventV1,
): LifecycleRenderEventV1;

export class SqliteLifecycleRenderClosureReader {
  constructor(connection: SqliteConnection);
  readStrictLifecycleClosure(
    projectId: ProjectId,
    rootSessionId: SessionId,
    throughPositionExclusive: bigint,
  ): LifecycleRenderClosureV1;
}

export function projectCompatibilityLogV2(
  input: CompatibilityLogProjectionInputV2,
): CompatibilityLogProjectionV2;

export function renderCompatibilityLogV2(
  projection: CompatibilityLogProjectionV2,
): Buffer;
```

- [ ] **Step 1: Add literal fixtures, the independent oracle, and typed throwing scaffolds**

Put `*.md text eol=lf` in the scoped `.gitattributes`. Copy `ending-v2.md` byte-for-byte from this plan. Before importing or implementing any production renderer code, hand-author all six exact structural projections and an independent canonical/reference renderer in `tests/support/compatibility-log-reference.ts`. That helper imports only Node primitives, declares its own local structural types, and must not import production DTOs, fixtures, canonical JSON, sort, checkpoint-fingerprint, projector, or renderer code.

```ts
export interface CompatibilityLogReferenceCase {
  readonly fixtureName:
    | "ending-v2.md"
    | "failed-v2.md"
    | "cancelled-v2.md"
    | "invalidated-v2.md"
    | "abandoned-v2.md"
    | "completed-v2.md";
  readonly projection: Readonly<Record<string, unknown>>;
  readonly literalUtf8: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export function compatibilityLogReferenceCases():
  readonly CompatibilityLogReferenceCase[];
```

The six hand-authored cases are exhaustive and fixed before production GREEN:

| Fixture | Trigger | Frozen/final state | Validation |
|---|---|---|---|
| `ending-v2.md` | Version 3 `SessionEndAmended` at position 7 | live, no marker, one carry ticket; use the already reviewed literal/hash above | empty `not-run` |
| `failed-v2.md` | Version 1 `SessionEndVerificationFailed` | Version 3 marker with nested Checkpoint V1, one accepted and one rejected/deferred child item | one exact retained result, `failed` |
| `cancelled-v2.md` | Version 3 `SessionEndCancelled` | marker cleared; live ticket/item state at cancellation | reset empty `not-run` |
| `invalidated-v2.md` | Version 1 `SessionEndVerificationInvalidated` | Version 3 marker with nested Checkpoint V2 qualified coverage and frozen child/ticket bytes | retain the exact named passed result, null score, conflict code |
| `abandoned-v2.md` | Version 1 direct-origin `SessionAbandoned` | live child/ticket projection, null workflow and final checkpoint | whole validation object is null |
| `completed-v2.md` | Version 1 `SessionEnded` | preserve the same nested-V2 marker/frozen projection | preserve the exact named passed result and score |

Every projection record spells every field literally; no object is produced by spreading a production/test fixture. The local reference renderer yields `literalUtf8`; copy those bytes into the five new Markdown fixtures, then calculate each byte length/SHA-256 once with Node primitives and paste both as hard-coded literals back into the reference cases. The test first asserts the reviewed ending case remains exactly 1729 bytes/`9c8c...72ce`, then asserts every hard-coded digest against the committed file. It must not calculate the expected digest from the file during the assertion. Do not add production throwing scaffolds until the six literal files and six literal digest records are complete and reviewed in the diff.

Load the source directory from compiled tests with:

```ts
const FIXTURE_ROOT = new URL(
  "../../tests/fixtures/compatibility-log/",
  import.meta.url,
);
```

Add only typed production exports that throw `new LifecycleError("INTEGRITY_FAILURE")` so `npm run test:build` succeeds before accepting a behavioral RED. The first behavioral RED compares those throwing exports to the already-frozen independent cases; do not revise reference objects, fixture bytes, lengths, or hashes to make production GREEN.

- [ ] **Step 2: Write and run path/normalization RED cases**

```ts
it("normalizes candidate and committed triggers without fabricating storage fields", () => {
  const candidate = normalizeCandidateLifecycleRenderEvent(projectionInput(), closure());
  const committed = normalizeCommittedLifecycleRenderEvent(authenticatedCommittedTrigger());
  assert.deepEqual(candidate, committed);
  assert.equal("eventId" in candidate, false);
  assert.equal("eventHash" in candidate, false);
});
```

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(derives one canonical path and revision-bearing target|normalizes candidate and committed triggers without fabricating storage fields|accepts global gaps and rejects incomplete lifecycle closure|authenticates an exact cross-workspace foreign fork claim pair|authenticates a multi-event command from its event-zero intent witness|rejects every malformed foreign fork claim pair|discovers post-cutoff claims for pointer proof but excludes them from the closure|derives candidate branch scope from the authenticated root closure|derives legacy effective state before stripping the intent witness|rejects unauthenticated legacy intent semantics before reduction)$" dist-test/tests/lifecycle-render-closure.reader.test.js dist-test/tests/compatibility-log-renderer.test.js
```

In the reader test, make `authenticates an exact cross-workspace foreign fork
claim pair` and `rejects every malformed foreign fork claim pair` operate on raw
authenticated `StoredEvent` rows before reduction. The positive pair matches
the source on project/vault/store while retaining one internally consistent
foreign workspace/branch. Independently mutate stream versions, command
indexes, command/idempotency identity, consecutive global positions,
fork/claim causation, source transfer event ID/position, ticket/source child,
context, and strict intent relation. Prove the reader queries each source ticket
through the expression index even when its mutable claim pointer is null, and
that it discovers every direct child from the immutable fork index rather than
trusting the authority table. Add a later legitimate claim whose mutable pointer
is already non-null but whose fork/claim positions are at or after the render
cutoff: the reader discovers and authenticates it for two-way pointer proof,
then excludes it from the returned semantic closure so the earlier marker still
freezes the ticket as unresolved.

Expected RED: throwing scaffolds return `INTEGRITY_FAILURE`. Implement path containment/lowercase UUID/canonical date, full committed envelope/hash/witness validation before reduction, root-derived candidate branch scope, exact next root stream version, global numeric ordering, per-stream continuity, and the complete raw foreign-pair relation above. The reader groups events by exact command/idempotency identity and joins the command to its dedup row. For an authorized command, require exactly its command-event-index-zero event to carry the strict witness, prove `commandHash === lifecycleIntentHashFromWitnessSource(indexZero.lifecycleIntentJson)` once, and require later command events to carry null witness while sharing the authenticated command context. Thus the fork authenticates the index-one claim; the claim is not required to duplicate the witness. Legacy request/amend semantics may be derived only from this authenticated event-zero witness. Missing, duplicate, generic-domain, or mismatched witness/command linkage fails. Only after the command-level proof may `normalizeCommittedLifecycleClosureEvent` strip storage/command/intent fields. Global-position gaps remain valid; unrelated foreign streams and incomplete child/root prefixes fail closed.

- [ ] **Step 3: Write per-report and live/frozen child-ticket epoch RED cases**

Cover multiple reports in one child, accepted/partial/rejected/superseded dispositions, exact partition and supersession positions, live pre-marker claims, marker-time freeze, post-marker child events/claims, unchanged carry to a later generation, open/cancel clear, seal-live state, and refreeze. Use checkpoint summaries for nonterminal heads and terminal events for completed/transferred heads. Independently reject a missing/extra/wrong nonterminal checkpoint summary or named head, an omitted child without exactly one completed/transferred terminal head, a terminal head at/after checkpoint base, and any report/disposition consumed after the selected frozen head. Table marker-epoch dispatch separately from validation: outer Version 1 implicit `unchanged` and outer Version 2/3 explicit `unchanged` preserve; Version 2/3 `open`, cancellation, and reopen clear; `seal` stays live after that clear. Direct abandonment uses live children/tickets with null final/validation, while failure/pass/invalidation/workflow abandonment/end preserve the entire frozen child/ticket/checkpoint projection.

```ts
it("freezes every child and ticket byte at the Version 3 marker", () => {
  const atMarker = projectCompatibilityLogV2(markerHistory());
  const afterClaim = projectCompatibilityLogV2(postMarkerClaimHistory());
  assert.deepEqual(afterClaim.acceptedChildren, atMarker.acceptedChildren);
  assert.deepEqual(afterClaim.unresolvedFollowUps, atMarker.unresolvedFollowUps);
  assert.deepEqual(afterClaim.finalCheckpoint, atMarker.finalCheckpoint);
});
```

- [ ] **Step 4: Run the child/ticket REDs, implement the fold, and return GREEN**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(folds every child disposition independently per report|enforces exact supersession event ordering|excludes claims committed before the live cutoff|freezes every child and ticket byte at the Version 3 marker|rejects checkpoint child summary and frozen head drift|rejects terminal child heads outside the marker base|ignores every report and disposition after the frozen head|dispatches the frozen marker epoch by outer amendment schema|preserves the frozen epoch through every preserving trigger|clears frozen child and ticket state on open cancel and reopen|keeps seal live until a replacement marker|renders direct abandonment from live scope with null final state)$" dist-test/tests/compatibility-log-renderer.test.js
```

Expected RED: projection scaffolds throw or drift after the post-marker claim. Implement first an event-time live projection, then an explicit marker epoch that captures the exact per-child heads and unresolved ticket set. Never read mutable workflow/ticket state as semantic authority.

- [ ] **Step 5: Write and run schema-aware validation RED cases**

Table outer V1 reset, outer V2 `unchanged`/`seal` reset, outer V3 `open` reset, outer V3 `seal`/`unchanged` carry, command-V1-inside-outer-V3 carry, cancel/reopen reset, accumulating not-run results, pass, fail, invalidation, workflow/direct abandonment, and ended named-pass preservation. Require the Version 3 marker to precede every result/verdict in the finalized generation. Reject unsorted/duplicate/missing/extra IDs, wrong lineage/checkpoint/generation, old result resurrection, result-after-verdict, validation-before-marker, and wrong invalidation/end position.

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(resets validation on every outer Version 1 or Version 2 amendment|carries validation only through Version 3 preserving amendments|rejects validation that precedes the final marker|rejects old validation results after an epoch reset|renders not-run passed failed invalidated and null validation exactly|requires invalidation and end to name the in-force passed event)$" dist-test/tests/compatibility-log-renderer.test.js
```

Expected RED: no validation fold exists. Implement an independent epoch state; do not call `foldSession` or use workflow/runner rows as the expected oracle.

- [ ] **Step 6: Write and run the literal-byte, parity, and ownership RED cases**

For all six fixtures, compare exact bytes, independent projection, SHA-256, absence of CR/BOM, and one terminal LF. Cover both nested checkpoint versions, qualified adapter ordering, JSON escaping, null/empty shapes, conditional ending marker, omissions, and fresh detached buffers. Candidate and committed replay must match bytes/payload hash. Fingerprint equality is tested only under one fixed algorithm/schema/key-ID/domain/key tuple; Q.3/Q.4 preserve and carry rotated tuples while Q.6 performs historical-key verification, so rotation never changes document bytes. Every direct renderer test wraps the returned caller-owned buffer in `try/finally { bytes.fill(0); }`.

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(renders all six compatibility log literals byte for byte|renders candidate and committed replay identically|returns fresh caller-owned buffers detached from projection input|omits random ids clocks locale topics secrets commands and raw evidence)$" dist-test/tests/compatibility-log-renderer.test.js
```

Expected RED: render scaffolds throw or fixture bytes differ. Render exactly the frozen section order with compact `canonicalJson`, LF separators, and one terminal LF. Return a new `Buffer` and retain no reference; Q.4 owns `fill(0)` after hashing.

- [ ] **Step 7: Run the Q.2b consolidation gate and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-render-closure.reader.test.js dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/lifecycle-contracts.test.js dist-test/tests/lifecycle-materialization-queue.test.js
npm run typecheck
git diff --check
git add src/orchestrator/materialization/vault-artifact-path.ts src/orchestrator/materialization/lifecycle-render-event.ts src/orchestrator/materialization/sqlite-lifecycle-render-closure.reader.ts src/orchestrator/materialization/compatibility-log.projection.ts src/orchestrator/materialization/compatibility-log.renderer.ts tests/support/compatibility-log-reference.ts tests/lifecycle-render-closure.reader.test.ts tests/compatibility-log-renderer.test.ts tests/fixtures/compatibility-log/.gitattributes tests/fixtures/compatibility-log/ending-v2.md tests/fixtures/compatibility-log/failed-v2.md tests/fixtures/compatibility-log/cancelled-v2.md tests/fixtures/compatibility-log/invalidated-v2.md tests/fixtures/compatibility-log/abandoned-v2.md tests/fixtures/compatibility-log/completed-v2.md
git commit -m "feat: render event-authoritative compatibility logs"
```

### Task 14Q.3: Persist and read exact immutable lifecycle outbox plans

**Files:**

- Create: `src/orchestrator/storage/lifecycle-outbox.repository.ts`
- Create: `tests/lifecycle-outbox.repository.test.ts`
- Modify: `src/orchestrator/storage/lifecycle-storage.types.ts`

**Interfaces:**

- Consumes: Q.1 exact pending payload/origin codecs, Q.2a Version 3 marker contract, Q.2b canonical path/target derivation, actual committed `StoredEvent`, and stored keyed fingerprint tuples.
- Produces: the exact `insertLifecycle`, `getExactPlannedRevision`, and `assertExactPlannedRevision` methods consumed by Q.4-Q.6 and S.3.

- [ ] **Step 1: Write repository RED tests**

Test no predecessor, immediate lower revision across every operational status, gaps, key rotation, malformed tuples, canonical path drift, foreign trigger, wrong content hash, wrong origin, non-immediate predecessor, and strict absence versus corruption. A checkpoint trigger is legal only when the actual event is outer Version 3 and payload workflow ID/generation equal the workflow origin; outer Version 1/2 checkpoints are rejected even when otherwise authentic. Separately table pending, claimed, completed, and failed as the status of the exact queried row: `getExactPlannedRevision`/`assertExactPlannedRevision` return identical immutable plan data for all four without rerender/refingerprint. The predecessor lookup key is exactly `(project_id, session_id, artifact_kind)` and never includes path. After key rotation, repository reads preserve the complete stored predecessor/current tuples byte-for-byte; cryptographic re-verification belongs to Q.6 full replay because this storage-only layer does not have the historical render bytes.

```ts
it("requires a Version 3 checkpoint and direct workflow-origin binding", () => {
  assert.doesNotThrow(() => repository.insertLifecycle(db, pendingFinal(), finalMarkerV3(), NOW));
  assert.throws(() => repository.insertLifecycle(db, pendingFinal(), ordinaryCheckpointV2(), NOW));
  assert.throws(() => repository.insertLifecycle(db, foreignOriginFinal(), finalMarkerV3(), NOW));
});
```

- [ ] **Step 2: Run repository RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(requires a Version 3 checkpoint and direct workflow-origin binding|recomputes lifecycle content hash before insert and read|derives prior fingerprint from the immediate lower revision regardless of status|uses null prior only when no lower revision exists|rejects a lower revision on a foreign canonical path|preserves historical key tuples without replacing them after rotation|returns the exact planned revision in every operational status|returns only an exact strictly bound planned revision|rejects malformed rows instead of reporting absence)$" dist-test/tests/lifecycle-outbox.repository.test.js
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

Insert only after the event row exists. Strict-decode and recompute `outboxHash(payload)`, revalidate the complete trigger/origin matrix against the actual event, and apply the checkpoint-specific outer-Version-3/direct-payload-origin rule. Derive the original-session path independently, select and structurally/cross-row verify the immediate predecessor inside the same `BEGIN IMMEDIATE`, and copy its complete stored algorithm/schema/key-ID/domain/value tuple. Historical reads preserve that tuple and never mint a replacement with the current provider key; Q.6 full replay performs cryptographic verification against historical render bytes. Return null only for true absence; malformed or cross-bound rows are `INTEGRITY_FAILURE`.

- [ ] **Step 4: Run 14Q.3 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/session-lifecycle-migration.test.js dist-test/tests/compatibility-log-renderer.test.js
npm run typecheck
git add src/orchestrator/storage/lifecycle-outbox.repository.ts src/orchestrator/storage/lifecycle-storage.types.ts tests/lifecycle-outbox.repository.test.ts
git commit -m "feat: persist immutable lifecycle materialization plans"
```

### Task 14Q.4: Plan provider-keyed fingerprints through a one-use connection-bound queue

**Files:**

- Create: `src/orchestrator/materialization/sqlite-lifecycle-materialization-planning-reads.ts`
- Create: `src/orchestrator/materialization/sqlite-lifecycle-materialization-queue.ts`
- Modify: `tests/lifecycle-materialization-queue.test.ts`

**Interfaces:**

- Consumes: Q.2a planning-read contract and prepared-handle owner, Q.2b `SqliteLifecycleRenderClosureReader` plus target/normalizer/projector/renderer, Q.3 immutable plan reader, and the existing provider-keyed fingerprint service.
- Produces: the concrete `LifecycleMaterializationQueuePort` used by semantic transactions in R/S, without exposing raw reads or mutable workflow operations.

- [ ] **Step 1: Write branded-state and zeroization RED tests**

Inject read/renderer/key-provider spies. Prove the queue receives only indexed tail/strict-closure/immediate-predecessor reads, never scans unrelated project history, checks the exact next global position, derives candidate branch scope from the authenticated root closure, renders once, fingerprints once, and zeroizes the caller-owned buffer in `finally` after every key/hash/fingerprint/predecessor success or failure once rendering has returned it. A renderer throw returns no buffer to the queue and must not expose a handle or cached state. The queue constructs one private handle owner per instance, returns a deeply frozen instance-owned plan, burns failed post-prepare validations, rejects handles from another queue plus reused/out-of-order handles, captures the complete actual planned `StoredEvent`, and asserts the committed event/row without rerendering. Mutate every captured field family independently: event/command/correlation/causation/idempotency IDs, actor/agent/client, branch/source envelope, stream/global positions, semantic and recorded times, payload object/JSON/hash, previous/event hashes, visibility/confidence/verification, refs/digests, and lifecycle authorization/intent witness.

```ts
it("zeroizes returned render bytes on every later planning failure", () => {
  for (const fault of POST_RENDER_PLANNING_FAULTS) {
    const bytes = Buffer.from("secret render bytes", "utf8");
    const harness = queueHarness({ fault, renderedBytes: bytes });
    assert.throws(() => harness.queue.prepare(harness.input));
    assert(bytes.every((value) => value === 0));
  }
});
```

- [ ] **Step 2: Run RED, implement, and rerun GREEN**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(plans one provider-keyed fingerprint from an authenticated lifecycle closure|uses indexed closure reads without scanning unrelated project history|derives candidate branch scope from the root closure|requires the transaction next global position|returns no handle when rendering fails|zeroizes returned render bytes on every later planning failure|accepts its opaque prepared plan exactly once|rejects a handle created by another queue instance|captures every planned StoredEvent field before commit|asserts planned intent action and complete envelope before insert|asserts committed trigger and exact row without rerendering|carries historical predecessor tuples without reminting after rotation)$" dist-test/tests/lifecycle-materialization-queue.test.js
```

Expected RED: the concrete queue does not exist. Implement `SqliteLifecycleMaterializationPlanningReads` as the narrow connection-bound composition of exact global tail, Q.2b strict closure reader, and Q.3 immediate-predecessor reader; it exposes no general query capability. Implement `prepare` as Q.1 decode/correlation → exact tail → strict exclusive closure → semantic candidate → target/projection/render → predecessor → keyed fingerprint, with the render buffer owned by one `try/finally { bytes.fill(0); }`. `prepare` validates only facts available from Q.1 input and closure. `assertPlanned` receives the actual planned event and passes the exact authoritative-intent/action/command/branch/full-envelope validation closure into `owner.capturePlanned`; the owner enters a non-reentrant validating state, captures/advances on success, and moves to terminal failed before rethrowing on error. `assertCommitted` likewise delegates exact stored-event/row comparison to `owner.consumeCommitted`, never rerenders/refingerprints/inserts, and consumes only on success. Every thrown validator terminally burns the handle.

The constructor accepts only `LifecycleMaterializationPlanningReads`, the provider-keyed fingerprint service, target deriver, projector/renderer, and immutable plan reader; it privately constructs its own `PreparedMaterializationHandleOwner` and never shares it or receives `LifecycleCommandTransaction`/mutable workflow/authority capabilities.

- [ ] **Step 3: Commit 14Q.4**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/lifecycle-render-closure.reader.test.js dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/lifecycle-outbox.repository.test.js
npm run typecheck
git add src/orchestrator/materialization/sqlite-lifecycle-materialization-planning-reads.ts src/orchestrator/materialization/sqlite-lifecycle-materialization-queue.ts tests/lifecycle-materialization-queue.test.ts
git commit -m "feat: plan lifecycle materialization fingerprints"
```

### Task 14Q.5: Insert typed lifecycle outbox rows inside event append

**Files:**

- Modify: `src/orchestrator/storage/event-append-transaction.ts`
- Modify: `tests/event-append-transaction.test.ts`

**Interfaces:**

- Consumes: the Q.1 strict pending-outbox union, Q.3 `LifecycleOutboxRepository.insertLifecycle`, and the actual `StoredEvent` created for pending `eventIndex: 0`.
- Produces: one atomic event-plus-lifecycle-plan write path; it does not render, fingerprint, mutate prepared-handle state, or redefine the authoritative lifecycle command hash.

- [ ] **Step 1: Write append-order/hash/rollback RED tests**

Prove strict normalization preserves the complete lifecycle descriptor and its zero event index; the generic branch cannot insert the reserved lifecycle kind; the actual trigger row is visible before lifecycle insertion; the repository receives that exact committed identity rather than a fabricated event; and event/payload/origin/path/hash drift is rejected. Inject faults after the event insert and during lifecycle insertion and prove event/outbox/projection/dedup all roll back. Replay of the same command returns the original one-target result without rerendering or reinsertion. `command_dedup.command_hash` remains the supplied authoritative lifecycle-intent-witness hash and generic non-lifecycle commands keep their existing generic hash domain.

- [ ] **Step 2: Run the exact RED anchors**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(preserves authoritative lifecycle command hash while recording the outbox target|keeps generic command hashing outside the lifecycle witness domain|never routes the reserved lifecycle kind through generic outbox insertion|inserts lifecycle outbox only after its exact actual event|rejects a lifecycle descriptor bound to a different actual event|rolls back event and lifecycle row when planning insertion fails|replay retains one ordered lifecycle target without reinsertion)$" dist-test/tests/event-append-transaction.test.js
```

- [ ] **Step 3: Implement the strict append union**

Give `SqliteEventAppendStatements` the connection-bound lifecycle-plan writer. `validateAppendCommand` strict-decodes and retains the typed descriptor. In `appendPlanned`, build the exact stored identity once, insert its event row first, then dispatch `materialize-lifecycle-log` to `insertLifecycle(connection, pending, actualStoredEvent, recordedAt)`; route every other kind through the existing generic insertion. Let any writer error abort the surrounding transaction. Do not add a lifecycle `afterAppend` side channel, synthesize a second event object, rerender/refingerprint, or hash the descriptor into the authoritative intent hash. Q.4/S.3 own `assertPlanned` before this method and `assertCommitted` after the exact row exists.

- [ ] **Step 4: Run 14Q.5 GREEN and commit**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-append-transaction.test.js dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/event-integrity.test.js dist-test/tests/lifecycle-command-store.test.js
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
- Modify: `tests/lifecycle-outbox.repository.test.ts`
- Modify: `tests/qualified-checkpoint-quick-integrity.test.ts`
- Modify: `tests/qualified-checkpoint-full-integrity.test.ts`
- Modify: `tests/session-end-effective-state-migration.test.ts`

**Interfaces:**

- Consumes: Q.3 `LifecycleOutboxPlanReader`, the shared `compatibility-session-log` artifact kind, exact event/outbox rows, Q.2a marker/closure rules, and Q.2b committed replay/rendering.
- Produces: a read-only workflow capability plus quick/full proofs that independently bind descriptor bytes, trigger identity, canonical path, immediate predecessor, provider-keyed fingerprint tuple, Version 3 marker, and event-authoritative child/claim closure.

- [ ] **Step 1: Write capability and source-state RED tests**

Require `WorkflowOperationalTransaction.outboxPlans` to expose only exact immutable get/assert. Prove claim, lease, acknowledge, fail, retry, and generic outbox mutation are absent both structurally and at runtime. Replace the stale `session-log` query literal with the shared `compatibility-session-log` constant and prove the old string is not retained as an alias or query fallback.

- [ ] **Step 2: Write the descriptor/hash/lineage integrity RED matrix**

Reuse Q.2a's complete prospective trigger schema/payload/origin table at migration, repository, quick-integrity, and full-integrity layers. Independently reject nonzero pending `eventIndex` and referenced `events.command_event_index`, invented payload keys such as `triggeringEventIndex`, wrong event type/schema/position/payload hash, checkpoint outer Version 1/2, workflow/direct-abandonment origin confusion, foreign path, and wrong materialization revision. Start from an authenticated full control whose sync and async reports are exactly empty.

Corrupt only `content_hash` to another valid lowercase 64-hex value and require `EventIntegrityService` to recompute `outboxHash(decodedPayload)` for the lifecycle-authoritative branch. Then corrupt descriptor fields coherently with their row columns and require the same mismatch. The authenticated test fixture may temporarily drop only the exact immutable outbox guards needed for corruption, but must reinstall their byte-identical current-schema SQL before the integrity call so schema fingerprinting remains clean; assert the control reports exactly zero sync and async issues before each independent mutation. Preserve the lifecycle witness-domain `command_dedup.command_hash`; prove the non-lifecycle branch still reconstructs generic `commandHash`.

For lineage, cover null predecessor only at the first revision, every operational predecessor status, a missing/duplicate/non-immediate/foreign-path predecessor, stored algorithm/schema/key-ID/domain/value drift, historical-key verification after rotation, and a fabricated first-row predecessor. Quick integrity validates the exact local row/event/predecessor tuple through indexed reads. Full integrity additionally replays the authenticated closure through the committed trigger, renders fresh bytes, verifies the trigger payload hash and provider-keyed next fingerprint under the row's stored tuple, and zeroizes its buffer in `finally`. It treats only outer Version 3 as a final marker and proves fork/authority plus ticket/claim equivalence in both directions while accepting the approved cross-workspace foreign claimant pair.

- [ ] **Step 3: Run RED anchors and implement exact read-only/integrity boundaries**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(exposes immutable outbox plans only to workflow operations|does not expose lifecycle plan mutation capabilities to workflow operations|excludes compatibility log targets with the canonical artifact kind|does not retain session-log as a source-state alias|rejects every lifecycle trigger origin and index violation in schema 4|repository enforces the complete lifecycle trigger origin and index matrix|quick integrity enforces the complete lifecycle trigger origin and index matrix|full integrity enforces the complete lifecycle trigger origin and index matrix|event integrity recomputes lifecycle outbox content hash|lifecycle descriptor integrity does not redefine command hash|generic descriptor integrity retains generic command hashing|quick integrity verifies immediate fingerprint lineage and canonical path|full integrity rerenders and verifies provider-keyed fingerprint lineage|full integrity accepts an authenticated cross-workspace claim closure|full integrity rejects fork authority and ticket claim drift)$" dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/source-state.provider.test.js dist-test/tests/event-integrity.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
```

Implement the operational wrapper as a narrow `LifecycleOutboxPlanReader` delegation. Use the shared artifact-kind constant in source-state exclusion. In event integrity, strict-decode lifecycle payloads and compare `content_hash` with `outboxHash(payload)` before any branch-specific command reconstruction; lifecycle command hashes continue to use `lifecycleIntentHashFromWitnessSource`, while null-authorization/generic rows continue to use `commandHash`. In quick integrity, prove the exact V3 event/origin/index/path/predecessor tuple without project-wide replay. In full integrity, use Q.2a's strict closure and Q.2b's committed normalizer/projector/renderer, verify with the stored fingerprint algorithm/schema/key ID/domain and key material, and zero the render buffer on success and every failure. Mutable workflow, authority, and ticket rows are cross-checks/locators only, never renderer authority.

- [ ] **Step 4: Run the complete 14Q gate**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-contracts.test.js dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/lifecycle-render-closure.reader.test.js dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/child-workflow.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/event-append-transaction.test.js dist-test/tests/event-integrity.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/source-state.provider.test.js dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/migration-registry.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
npm run typecheck
npm run build
npm run test:build-artifacts
git diff --check
git diff --exit-code 72f4fce -- src/orchestrator/storage/migrations/0002-session-lifecycle.ts src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts
```

- [ ] **Step 5: Commit and review slice 14Q**

```powershell
git add src/orchestrator/lifecycle/lifecycle-operational.store.ts src/orchestrator/lifecycle/source-state.provider.ts src/orchestrator/integrity/event-integrity.service.ts src/orchestrator/integrity/lifecycle-integrity.service.ts tests/lifecycle-operational-store.test.ts tests/source-state.provider.test.ts tests/event-integrity.test.ts tests/lifecycle-outbox.repository.test.ts tests/qualified-checkpoint-quick-integrity.test.ts tests/qualified-checkpoint-full-integrity.test.ts tests/session-end-effective-state-migration.test.ts
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

**Interfaces:**

- Consumes: a claimed `children-resolved` workflow with sealed evidence, the event-authoritative bounded child/ticket proof, Q.2a `SessionCheckpointRecordedPayloadV3`, Q.1/Q.4 prepared queue, Q.3 exact plan reader, and the existing nested `CheckpointV1 | CheckpointV2` builders/fingerprint domain.
- Produces: the sole `record-final-checkpoint-and-queue-ending` producer of an outer Version 3 marker plus its atomic lifecycle plan/frozen workflow transition. Ordinary public/internal non-final checkpoints continue to emit their historical outer Version 1 or Version 2 envelope.

```ts
export interface FinalCheckpointPhasePreparationInput {
  readonly command: RecordCheckpointCommandV2 | RecordCheckpointCommandV3;
  readonly materializationTarget: string;
  readonly workflowClaim: WorkflowClaimAssertionV1;
}
```

The checkpoint service uses `workflowClaim.workflowId` and
`workflowClaim.workflowGeneration` for the marker but must revalidate the whole
claim token/owner/expiry against the same connection-bound workflow row; caller
values alone are never authority.

- [ ] **Step 1: Write children-resolved proof RED tests**

Scan all direct-child and source-root ticket history with binary order and `MAX_ROOT_CHILD_HISTORY_V1 + 1`. Authenticate each child from its immutable event stream and each foreign claim from the exact fork-v1/claim-v2 witness pair; mutable authority/ticket tuples are locator/CAS cross-checks only. Validate claimed and unclaimed tickets, all-null/all-non-null claim tuples, transferred child exactly-one-ticket, no current-child/ticket double representation, terminal/claimed history counting, approved cross-workspace claims, duplicate/orphan/mismatched claims, overflow as integrity failure, eventless CAS response loss, and no semantic event/outbox during the proof.

- [ ] **Step 2: Write final freeze/confirmation RED tests**

Cover sealed window, exact root/descendant coverage, direct historical checkpoint reads, canonical ending-scope union, capacity boundary, and both nested checkpoint versions. The final path must emit the exact six-key outer Version 3 payload, bind workflow ID/generation to the claimed `children-resolved` row and authoritative intent, use `command_event_index = 0`, and supply that same marker to Q.1 preparation. Prove ordinary checkpoints remain outer Version 1/2 and cannot become final by intent inference. Cover actual event/outbox atomicity, authoritative command hash, target order, rollback at renderer/key/repository/index/after-append boundaries, and a later eventless exact-row assertion before phase CAS.

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
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(proves children resolved from all bounded child and ticket history|authenticates cross-root transfer claims from immutable fork claim witnesses|treats a 1001-row proof read as integrity failure|emits only an exact Version 3 marker for the final workflow checkpoint|keeps ordinary Version 1 and Version 2 checkpoints non-final|binds the marker projection origin intent and claimed workflow exactly|freezes only current children and validated unclaimed tickets|rolls back final checkpoint and outbox together at every fault boundary|confirms the exact planned row before advancing phase|leaves phase unchanged when the planned row is absent or mismatched)$" dist-test/tests/session-end.coordinator.test.js dist-test/tests/session-end-workflow.test.js dist-test/tests/checkpoint.service.test.js
```

- [ ] **Step 4: Implement one-action-per-drive coordination and final queue ordering**

Each `driveOnce` claims or renews, performs at most one child command or one root phase action, commits/returns, and never loops while SQLite is locked. After no child selection, the operational proof moves `requested -> children-resolved`. In the final checkpoint service, leave `pendingCheckpointEvent` unchanged for ordinary writes and add a final-only builder that wraps its strict nested checkpoint in outer schema Version 3 with `finalCheckpointBindingVersion: 1`, the exact workflow ID/generation, and correlated base/checkpoint positions. Require source phase `children-resolved`, sealed evidence, no active frozen marker, and action `record-final-checkpoint-and-queue-ending` before returning it.

The semantic final transaction follows design section 13.5 exactly: derive the expected next position; queue `prepare` with the Version 3 candidate; append planning; queue `assertPlanned` so the owner captures the complete actual envelope; insert the actual event then lifecycle row; update checkpoint/frozen phase using the marker's workflow binding and nested-checkpoint fingerprint; queue `assertCommitted` against the exact event/row; apply projection/dedup; commit. Every fault rolls back and burns the handle. The next eventless operation calls `assertExactPlannedRevision` and only then CASes `final-checkpoint-recorded -> ending-materialization-queued`.

- [ ] **Step 5: Run complete 14S gate, commit, and review**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-child-saga.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/session-end-workflow.test.js dist-test/tests/child-workflow.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/lifecycle-contracts.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/lifecycle-render-closure.reader.test.js dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/event-append-transaction.test.js dist-test/tests/event-integrity.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js
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
$pattern = '^(derives RFC and session-end UUIDv5 golden vectors|enforces the session end effective-state raw UTF-8 guard at exact cap|keeps legacy request amend cancel decoders and accepts only V3 current events|keeps ChildWorkTransferCreated V1 frozen and admits only the internal V2 dual-checkpoint shape|decodes only exact root-bound Version 3 final checkpoint markers|applies migration 0004 and preserves frozen 0002 0003 hashes|rejects schema-3 nonterminal workflows with zero writes|computes exact V2 workflow-generation fingerprint predecessor chains|strictly decodes the six-key persisted validation plan and rejects ordering identity cap violations|selects the latest outer Version 3 checkpoint by its nested checkpoint domain|authenticates an exact cross-workspace foreign fork claim pair|renders all six compatibility log literals byte for byte|derives prior fingerprint from the immediate lower revision regardless of status|preserves authoritative lifecycle command hash while recording the outbox target|event integrity recomputes lifecycle outbox content hash|full integrity rerenders and verifies provider-keyed fingerprint lineage|requests G1 without outbox and reopens cancelled G2 as G3|amend unchanged preserves phase and frozen bytes|selects one eligible child by binary UUID order|carries an already suspended child with a newer governing checkpoint|proves children resolved from all bounded child and ticket history|rolls back final checkpoint and outbox together at every fault boundary|confirms the exact planned row before advancing phase|routes carry-forward only to the dedicated child-target handler|covers every approved Task 14 crash and replay case)$'
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern=$pattern dist-test/tests/session-end-identifiers.test.js dist-test/tests/session-end-effective-state.test.js dist-test/tests/lifecycle-contracts.test.js dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/session-end.repository.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/lifecycle-render-closure.reader.test.js dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/event-append-transaction.test.js dist-test/tests/event-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js dist-test/tests/session-end-workflow.test.js dist-test/tests/session-end-child-saga.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/lifecycle-worker-runtime.test.js dist-test/tests/session-end.crash.test.js
```

Confirm all 25 names appear in output; file-level zero-match wrapper entries do not count as anchors.

- [ ] **Step 3: Run the focused Task 14 boundary suite**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/session-end-identifiers.test.js dist-test/tests/session-end-effective-state.test.js dist-test/tests/session-end-effective-state-migration.test.js dist-test/tests/session-end.repository.test.js dist-test/tests/session-end-policy.test.js dist-test/tests/session-end-workflow.test.js dist-test/tests/session-end-child-saga.test.js dist-test/tests/session-end.coordinator.test.js dist-test/tests/session-end.crash.test.js dist-test/tests/lifecycle-materialization-queue.test.js dist-test/tests/lifecycle-render-closure.reader.test.js dist-test/tests/lifecycle-outbox.repository.test.js dist-test/tests/compatibility-log-renderer.test.js dist-test/tests/lifecycle-contracts.test.js dist-test/tests/lifecycle-intent.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-operational-store.test.js dist-test/tests/lifecycle-worker-protocol.test.js dist-test/tests/lifecycle-worker-runtime.test.js dist-test/tests/lifecycle-executor.test.js dist-test/tests/event-append-transaction.test.js dist-test/tests/event-integrity.test.js dist-test/tests/source-state.provider.test.js dist-test/tests/child-workflow.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/session-aggregate.test.js dist-test/tests/lifecycle-projection-folds.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js
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
