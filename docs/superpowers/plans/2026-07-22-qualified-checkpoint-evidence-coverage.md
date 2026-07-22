# Qualified Checkpoint Evidence Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Task 12 by adding schema-fenced, adapter-qualified Version 2 checkpoints and authenticated coverage without changing historical Version 1 bytes or enabling production lifecycle routing.

**Architecture:** Keep Version 1 contracts immutable and introduce strict discriminator-based Version 2 unions. Migration 0003 adds compact authenticated coverage transitions plus bounded session-end freeze metadata; semantic writes remain in one `BEGIN IMMEDIATE` transaction, while checkpoints read only bounded aggregates and full integrity alone replays history. Execute Tasks 12A through 12J in order, with a fresh specification review and code-quality review after each commit.

**Tech Stack:** TypeScript 5.8 strict NodeNext, Node.js 22.22.3 minimum / 24.16.0 recommended, `node:sqlite`, SQLite 3.51.3+, Node core crypto, existing canonical JSON and provider abstractions, native `node:test`, PowerShell-compatible npm scripts.

## Global Constraints

- This is the normative companion for Task 12 in `docs/superpowers/plans/2026-07-14-root-child-lifecycle-and-checkpoints.md` and implements `docs/superpowers/specs/2026-07-18-qualified-checkpoint-evidence-coverage-design.md`.
- Tasks 1 through 11 are complete. Do not redo, squash, or rewrite their commits; extend their public seams compatibly.
- `LifecycleEventV1`, `decodeLifecycleEventV1`, `CheckpointV1`, `CheckpointDraftV1`, `decodeCheckpointV1`, `decodeCheckpointDraftV1`, and the Version 1 checkpoint fingerprint domain remain byte-compatible.
- `src/orchestrator/storage/migrations/0002-session-lifecycle.ts` remains byte-for-byte unchanged at SHA-256 `68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06`.
- Schema 3 is introduced only by `0003-qualified-checkpoint-coverage`; a schema-2 binary reports `SCHEMA_TOO_NEW` before reading Version 2 lifecycle events.
- The only outer Version 2 lifecycle events are `EvidenceCoverageRecorded`, `SessionCheckpointRecorded`, `SessionEndRequested`, and `SessionEndAmended`, each with its matching strict Version 2 payload. Every other lifecycle event stays outer Version 1.
- Every adapter session owns an independent ordinal namespace. Never union ordinals across adapters and never pick a representative adapter.
- Evidence remains coverage-only: `captureMode: "coverage-only"`, `contentRetained: false`, no frame body/reference retention, and no path that satisfies `requireFullEvidence`.
- The rolling accumulator invokes the existing provider exactly once for genuinely new frames, with purpose `evidence-fingerprint`, domain `pm-evidence-coverage-v1`, provider framing `UTF8(domain) || 0x00 || bytes`, and no service-added prefix or newline.
- Any recorded historical key status other than `available` fails closed as `EVIDENCE_HISTORICAL_KEY_UNAVAILABLE`; a zero-new batch preserves the digest and makes no fingerprint call.
- Bounds are lifetime 200 adapters per lifecycle session, 200 missing intervals per adapter, 200 missing intervals across all current adapters, 196,608 canonical UTF-8 bytes for qualified coverage, 262,144 bytes for the enriched checkpoint, and 262,144 bytes for final ending-scope bindings.
- Capacity checks run before append, provider work where specified, and UUID/ticket/authority mutation. Exact-limit inputs pass; limit-plus-one leaves zero persistent effect.
- Fresh command ordering is exact replay, identity/append validation, evidence-window gate for evidence commands, bounded quick health, semantic callback, append/postwrites, dedup, commit.
- Quick integrity is bounded and compares aggregate/transition/event/index sentinels. Full integrity performs one advancing historical replay; no checkpoint path scans immutable ordinal history.
- Frozen session-end bindings are checked at their recorded event-time baseline by integrity. Only the three Task 15 freshness gates compare that baseline with current mutable state.
- All production registration roots remain untouched and lifecycle Version 2 remains disabled after schema 3, codecs, worker seams, and tests exist.

### Per-Task Review Protocol

After each Task 12A-12J commit, invoke `superpowers:requesting-code-review`
twice on that task's recorded BASE..HEAD range: first for approved-spec
compliance, then with a fresh reviewer for implementation quality/security.
Resolve every Critical/Important finding with focused RED/GREEN evidence,
re-run that task's GREEN gate, and repeat both reviews against the corrected
HEAD before starting the next task. The Task 12J exit review below is an
additional whole-Task-12 range review; it does not replace these per-commit
reviews.

### Deterministic RED Protocol

Every RED gate in Tasks 12A-12J has two explicit phases and must start from the
task's recorded base commit. First run `npm run test:build` after adding the
named tests. If it fails only because a named new module/export does not yet
exist, record those exact `TS2307`/`TS2305` diagnostics, add only the smallest
typed module/export skeleton whose methods throw `NOT_IMPLEMENTED`, and rerun
`npm run test:build` until it succeeds. No semantic branch, SQL, provider call,
or mutation may be implemented in that scaffold. Second, and only after a
successful build, run the listed `dist-test` command and observe the named
anchor tests fail for `NOT_IMPLEMENTED` or their exact missing behavior. Never
invoke Node against a failed build or reuse stale `dist-test` output. Any
unrelated compile/test failure is fixed before proceeding.

The required anchor test titles and initial behavioral failures are:

| Task | Exact anchor test title | Required RED failure |
| --- | --- | --- |
| 12A | `keeps every Version 1 checkpoint vector byte-for-byte unchanged` | V2 union/decoder export is absent while the frozen V1 vector stays green. |
| 12A | `rejects every mixed outer and nested lifecycle event version` | Strict V2 event dispatcher is `NOT_IMPLEMENTED`. |
| 12A | `rejects limit-plus-one checkpoint and ending-scope capacity` | Capacity estimator is `NOT_IMPLEMENTED`. |
| 12B | `requires migration-3 preflight for every explicit upgrade` | Explicit-upgrade hook/default is absent. |
| 12B | `consumes and drops the canonical staged backfill exactly once` | Migration 0003/staging handoff is absent. |
| 12B | `rolls schema-1 and schema-2 sources back after staged-backfill failure` | Version-3 rollback guard is absent. |
| 12C | `advances one adapter accumulator without rescanning historical ordinals` | Accumulator preparation is `NOT_IMPLEMENTED`. |
| 12C | `rejects adapter interval and byte limits before provider work` | Bounded repository preparation is `NOT_IMPLEMENTED`. |
| 12D | `returns replay before window health provider or repository access` | Central replay-first ordering is absent. |
| 12D | `commits evidence event transition aggregate and ordinals atomically` | Evidence service/postwrite path is `NOT_IMPLEMENTED`. |
| 12E | `dispatches checkpoint preparation once on checkpointVersion` | V2 preparation/result decoder is `NOT_IMPLEMENTED`. |
| 12E | `resolves a historical checkpoint only by its stored global position` | Direct-position lookup is absent. |
| 12F | `uses shared checkpoint preparation for root suspension` | Suspension still follows the V1-only path. |
| 12F | `rejects every state-growing path before capacity is exceeded` | Shared capacity calls are absent. |
| 12G | `async integrity holds one deferred transaction and invokes each extension once` | Async extension transaction/dispatch is absent. |
| 12G | `synchronous integrity fails closed when qualified coverage requires authentication` | Sync integrity incorrectly reports ordinary success. |
| 12H | `integrity provider broker preserves backend ownership and strict request correlation` | Strict ownership/correlation is absent. |
| 12H | `integrity provider broker terminates malformed concurrent or out-of-order traffic` | Broker state-machine rejection is absent. |
| 12I | `bounded quick integrity rejects aggregate transition and checkpoint tampering without ordinal reads` | Bounded structural checks are absent. |
| 12I | `bounded quick integrity resolves frozen version 2 checkpoints at the recorded event-time baseline` | Recorded-base lookup is absent. |
| 12I | `bounded quick integrity rejects one-byte prospective capacity overflow` | Capacity recomputation is absent. |
| 12I | `bounded quick integrity checks status once per distinct current profile` | Distinct-profile status calls are absent. |
| 12J | `full integrity advances each qualified coverage row exactly once` | Advancing replay is absent. |
| 12J | `full integrity fingerprints each non-zero transition exactly once` | Provider call count is wrong. |
| 12J | `full integrity reconstructs version 2 checkpoints and frozen snapshots at their historical bases` | Historical reconstruction is absent. |
| 12J | `full integrity reports unavailable historical keys and never repairs state` | Failure/no-repair behavior is absent. |

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/orchestrator/lifecycle/contracts/checkpoint.ts` | Immutable V1 codecs plus strict V2 qualified coverage/checkpoint unions and canonical bounds. |
| `src/orchestrator/lifecycle/contracts/events.ts` | Immutable V1 event codec plus the exact four-form `LifecycleEventV2` matrix and union dispatcher. |
| `src/orchestrator/lifecycle/contracts/commands.ts` | V3 command variants for nested V2 checkpoint/end DTOs and versioned internal actions. |
| `src/orchestrator/lifecycle/contracts/session-end.ts` | V2 request/amendment/window status and strict bounded `FinalEndingScopeBindingV1` codec. |
| `src/orchestrator/lifecycle/checkpoint-capacity.ts` | Exact capacity-input contracts plus pure conservative checkpoint and ending-scope byte estimators shared by migration and writers. |
| `src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts` | Schema-3 aggregate profiles/digest, immutable transitions, workflow freeze fields, guards, and backfill SQL. |
| `src/orchestrator/storage/qualified-checkpoint-migration-preflight.ts` | Mandatory quiesced schema-2 eligibility plus sealed immutable TEMP staging for one-pass canonical backfill. |
| `src/orchestrator/storage/evidence-coverage.repository.ts` | Bounded aggregate/transition/ordinal comparison, prepare/persist, snapshots, and capacity reads. |
| `src/orchestrator/lifecycle/evidence-coverage-accumulator.ts` | Pure canonical rolling-accumulator input and incremental interval logic. |
| `src/orchestrator/lifecycle/evidence-coverage.service.ts` | Authorized Version 2 evidence recording through the semantic transaction facade. |
| `src/orchestrator/lifecycle/checkpoint.service.ts` | Shared V1/V2 preparation, versioned hashing/results, snapshots, final bindings, and marker handling. |
| `src/orchestrator/integrity/lifecycle-integrity.service.ts` | Bounded quick checks and linear coverage/checkpoint/session-end historical replay. |
| `src/orchestrator/integrity/event-integrity.service.ts` | Strict event union decoding and outer/nested version enforcement. |
| `src/orchestrator/runtime/worker-protocol.ts` | Strict internal integrity-provider status/fingerprint request/response codecs, separate from public worker request/result unions. |
| `src/orchestrator/runtime/worker-integrity-provider-client.ts` | One-in-flight integrity-child status/fingerprint client with exact correlation and transferred-buffer ownership. |
| `src/orchestrator/runtime/project-store-worker-backend.ts` / `src/workers/project-store.worker.ts` | Provider-owning broker endpoint and child routing; no provider object or raw key crosses `workerData` or messages. |
| `tests/support/qualified-checkpoint-reference.ts` | Independent V2 checkpoint SHA-256, rolling HMAC, UTF-8 ordering, and byte-budget reference helpers. |
| `tests/qualified-checkpoint-contracts.test.ts` | V1 compatibility, V2 strict codecs, fixed vectors, bounds, and intent versioning. |
| `tests/qualified-checkpoint-migration.test.ts` | Migration 0003 DDL, preflight, backfill, trigger, compatibility, and rollback corpus. |
| `tests/evidence-coverage.test.ts` | Accumulator, provider, interval, overlap, transaction-order, snapshot, and capacity behavior. |
| `tests/event-integrity.test.ts` | One deferred async integrity transaction, exactly-once extension dispatch, rollback, and synchronous qualified-coverage fail-closed behavior. |
| `tests/integrity-provider-broker.test.ts` | Strict provider IPC correlation, backend ownership, transfer limits, failure mapping, and zeroization. |
| `tests/qualified-checkpoint-quick-integrity.test.ts` | Bounded aggregate/transition/index, capacity, and frozen event-time checks with no ordinal scan. |
| `tests/qualified-checkpoint-full-integrity.test.ts` | One-pass authenticated replay, historical snapshots, provider counts, failure mapping, and no repair. |
| Existing checkpoint, command-store, child, upgrade, migration, and integrity tests | Cross-service integration and regression coverage. |

---

### Task 12A: Freeze Versioned Contracts, Canonical Bounds, and Safe Failures

**Files:**
- Create: `src/orchestrator/lifecycle/checkpoint-capacity.ts`
- Create: `tests/support/qualified-checkpoint-reference.ts`
- Create: `tests/qualified-checkpoint-contracts.test.ts`
- Modify: `src/orchestrator/lifecycle/contracts/checkpoint.ts`
- Modify: `src/orchestrator/lifecycle/contracts/events.ts`
- Modify: `src/orchestrator/lifecycle/contracts/commands.ts`
- Modify: `src/orchestrator/lifecycle/contracts/session-end.ts`
- Modify: `src/orchestrator/lifecycle/errors.ts`
- Modify: `src/orchestrator/lifecycle/session-aggregate.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-intent.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-intent-witness.ts`
- Modify: `tests/lifecycle-contracts.test.ts`
- Modify: `tests/lifecycle-intent.test.ts`
- Modify: `tests/session-aggregate.test.ts`

**Interfaces:**
- Consumes: Existing strict V1 identifiers, canonical JSON, `CheckpointV1`, lifecycle event names, semantic intent hashing, and `LifecycleError` mapping.
- Produces: Strict `CheckpointDraft`/`Checkpoint`, `LifecycleEvent`, request/amendment, command, and internal-action unions; `FinalEndingScopeBindingV1`; exact capacity-input contracts; pure upper-bound estimators; stable recovery actions used by Tasks 12B-19. `checkpoint.service.ts` remains the sole owner of checkpoint result types until Task 12E.

```ts
export type CheckpointDraft = CheckpointDraftV1 | CheckpointDraftV2;
export type Checkpoint = CheckpointV1 | CheckpointV2;
export type LifecycleEvent = LifecycleEventV1 | LifecycleEventV2;

export function decodeCheckpointDraft(value: unknown): CheckpointDraft;
export function decodeCheckpoint(value: unknown): Checkpoint;
export function decodeLifecycleEvent(value: unknown): LifecycleEvent;
export function decodeFinalEndingScopeBindingsV1(
  value: unknown,
): readonly FinalEndingScopeBindingV1[];

export function minimumCheckpointUpperBound(
  input: MinimumCheckpointCapacityInput,
): number;
export function minimumFinalEndingScopeBindingsUpperBound(
  input: MinimumEndingScopeCapacityInput,
): number;
```

```ts
export interface CheckpointAdapterCoverageV2 {
  readonly adapterSessionId: AdapterSessionId;
  readonly coverageFirstOrdinal: "0";
  readonly coverageLastOrdinal: string;
  readonly highestContiguousOrdinal: string | null;
  readonly missingIntervals: readonly MissingOrdinalIntervalV1[];
  readonly frameFingerprintAlgorithm: "hmac-sha256";
  readonly frameFingerprintSchemaVersion: 1;
  readonly frameFingerprintKeyId: string;
  readonly frameFingerprintDomain: "pm-evidence-frame-v1";
  readonly coverageFingerprintAlgorithm: "hmac-sha256";
  readonly coverageFingerprintSchemaVersion: 1;
  readonly coverageFingerprintKeyId: string;
  readonly coverageFingerprintDomain: "pm-evidence-coverage-v1";
  readonly coverageFingerprint: string;
  readonly latestBatchId: EvidenceBatchId;
  readonly latestBatchEventPosition: string;
}

export interface CheckpointEvidenceCoverageV2 {
  readonly coverageVersion: 2;
  readonly captureMode: "coverage-only";
  readonly contentRetained: false;
  readonly adapterSessions: readonly CheckpointAdapterCoverageV2[];
}

export interface CheckpointDraftV2
  extends Omit<CheckpointDraftV1, "checkpointVersion"> {
  readonly checkpointVersion: 2;
}

export interface CheckpointV2
  extends Omit<CheckpointV1, "checkpointVersion" | "evidenceCoverage"> {
  readonly checkpointVersion: 2;
  readonly evidenceCoverage: CheckpointEvidenceCoverageV2;
}

export interface EvidenceCoverageRecordedV2 {
  readonly adapterSessionId: AdapterSessionId;
  readonly batchId: EvidenceBatchId;
  readonly batchFirstOrdinal: string;
  readonly batchLastOrdinal: string;
  readonly coverageFirstOrdinal: "0";
  readonly coverageLastOrdinal: string;
  readonly highestContiguousOrdinal: string | null;
  readonly missingIntervals: readonly MissingOrdinalIntervalV1[];
  readonly frameFingerprintAlgorithm: "hmac-sha256";
  readonly frameFingerprintSchemaVersion: 1;
  readonly frameFingerprintKeyId: string;
  readonly frameFingerprintDomain: "pm-evidence-frame-v1";
  readonly coverageFingerprintAlgorithm: "hmac-sha256";
  readonly coverageFingerprintSchemaVersion: 1;
  readonly coverageFingerprintKeyId: string;
  readonly coverageFingerprintDomain: "pm-evidence-coverage-v1";
  readonly coverageFingerprint: string;
  readonly captureMode: "coverage-only";
  readonly contentRetained: false;
  readonly frames: readonly LifecycleEvidenceFrameRecordedV1[];
}

export interface SessionCheckpointRecordedPayloadV2
  extends Omit<
    LifecycleEventPayloadMapV1["SessionCheckpointRecorded"],
    "checkpoint"
  > {
  readonly checkpoint: CheckpointV2;
}

export type SessionEndRequestedPayloadV2 =
  LifecycleEventPayloadMapV1["SessionEndRequested"] & {
  readonly requestVersion: 2;
};

export type SessionEndAmendedPayloadV2 =
  LifecycleEventPayloadMapV1["SessionEndAmended"] & {
  readonly amendmentVersion: 2;
  readonly finalCheckpointVersion: 2 | null;
  readonly evidenceWindowAction: "unchanged" | "open" | "seal";
};

type LifecycleEventBaseV2<
  T extends
    | "EvidenceCoverageRecorded"
    | "SessionCheckpointRecorded"
    | "SessionEndRequested"
    | "SessionEndAmended",
  P,
> = Omit<LifecycleEventBaseV1<T>, "eventSchemaVersion" | "payload"> & {
  readonly eventSchemaVersion: 2;
  readonly payload: P;
};

export type LifecycleEventV2 =
  | LifecycleEventBaseV2<"EvidenceCoverageRecorded", EvidenceCoverageRecordedV2>
  | LifecycleEventBaseV2<"SessionCheckpointRecorded", SessionCheckpointRecordedPayloadV2>
  | LifecycleEventBaseV2<"SessionEndRequested", SessionEndRequestedPayloadV2>
  | LifecycleEventBaseV2<"SessionEndAmended", SessionEndAmendedPayloadV2>;

export interface SessionEndRequestV2
  extends Omit<SessionEndRequestV1, "requestVersion" | "finalCheckpoint"> {
  readonly requestVersion: 2;
  readonly finalCheckpoint: CheckpointDraftV2;
}

export interface SessionEndAmendmentV2
  extends Omit<SessionEndAmendmentV1, "amendmentVersion" | "finalCheckpoint"> {
  readonly amendmentVersion: 2;
  readonly finalCheckpoint: CheckpointDraftV2 | null;
  readonly evidenceWindowAction: "unchanged" | "open" | "seal";
}

export interface SessionEndEvidenceWindowStatusV2 {
  readonly evidenceWindowState: "open" | "sealed";
  readonly evidenceFrozenCheckpointEventPosition: string | null;
  readonly evidenceFrozenGeneration: number | null;
}

export type SessionEndPhaseActionV2 =
  | "mark-children-resolved"
  | "record-final-checkpoint-and-queue-ending"
  | "confirm-ending-materialization"
  | "begin-validation"
  | "record-verification-failed"
  | "record-verification-passed"
  | "invalidate-verification"
  | "append-terminal-completion"
  | "confirm-completed-materialization"
  | "complete-without-materialization"
  | "complete-after-materialization";

export type SessionEndStatusV2 = JsonValue & {
  readonly resultVersion: 2;
  readonly sessionId: SessionId;
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly phase: SessionEndPhase;
  readonly priorRootState: "active" | "suspended";
  readonly triggeringEventPosition: string;
  readonly finalCheckpointId: CheckpointId | null;
  readonly finalCheckpointEventPosition: string | null;
  readonly evidenceWindow: SessionEndEvidenceWindowStatusV2;
  readonly validationPlansReady: boolean;
  readonly qualityScore: number | null;
  readonly safeFailureCode: string | null;
  readonly materializationRequired: boolean;
};

export type SessionEndPhaseResultV2 = JsonValue & {
  readonly resultVersion: 2;
  readonly action: SessionEndPhaseActionV2;
  readonly progressed: boolean;
  readonly previousPhase: SessionEndPhase;
  readonly status: SessionEndStatusV2;
};

export type ValidationResultRecordedResultV1 = JsonValue & {
  readonly resultVersion: 1;
  readonly resultId: ValidationResultId;
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly eventPosition: string;
  readonly finalStreamVersion: string;
};

export type SessionEndRequest = SessionEndRequestV1 | SessionEndRequestV2;
export type SessionEndAmendment =
  | SessionEndAmendmentV1
  | SessionEndAmendmentV2;

export interface RootSuspendCommandV3
  extends Omit<RootSuspendCommandV2, "checkpoint"> {
  readonly checkpoint: CheckpointDraftV2;
}

export interface RecordCheckpointCommandV3
  extends Omit<RecordCheckpointCommandV2, "draft"> {
  readonly draft: CheckpointDraftV2;
}

export interface RequestSessionEndCommandV3
  extends Omit<RequestSessionEndCommandV2, "request"> {
  readonly request: SessionEndRequestV2;
}

export interface AmendSessionEndCommandV3
  extends Omit<AmendSessionEndCommandV2, "amendment"> {
  readonly amendment: SessionEndAmendmentV2;
}

export interface RecordFinalCheckpointAndQueueEndingActionV1 {
  readonly action: "record-final-checkpoint-and-queue-ending";
  readonly finalCheckpoint: CheckpointV1;
  readonly materializationTarget: string;
}

export interface RecordFinalCheckpointAndQueueEndingActionV2 {
  readonly action: "record-final-checkpoint-and-queue-ending";
  readonly finalCheckpoint: CheckpointV2;
  readonly materializationTarget: string;
}

export type NonCheckpointSemanticSessionEndAction =
  | {
      readonly action: "record-verification-failed";
      readonly validationResultIds: readonly ValidationResultId[];
      readonly safeFailureCode: string;
    }
  | {
      readonly action: "record-verification-passed";
      readonly validationResultIds: readonly ValidationResultId[];
      readonly qualityScore: number;
    }
  | {
      readonly action: "invalidate-verification";
      readonly safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT";
    }
  | {
      readonly action: "append-terminal-completion";
      readonly verificationEventPosition: string;
      readonly materializationTarget: string;
    };

export type SemanticSessionEndActionV1 =
  | RecordFinalCheckpointAndQueueEndingActionV1
  | NonCheckpointSemanticSessionEndAction;
export type SemanticSessionEndActionV2 =
  | RecordFinalCheckpointAndQueueEndingActionV2
  | NonCheckpointSemanticSessionEndAction;
export type SemanticSessionEndAction =
  | SemanticSessionEndActionV1
  | SemanticSessionEndActionV2;

export interface PlanFinalCheckpointAndQueueEndingActionV1 {
  readonly action: "prepare-final-checkpoint-and-queue-ending";
  readonly finalCheckpointDraft: CheckpointDraftV1;
  readonly materializationTarget: string;
}

export interface PlanFinalCheckpointAndQueueEndingActionV2 {
  readonly action: "prepare-final-checkpoint-and-queue-ending";
  readonly finalCheckpointDraft: CheckpointDraftV2;
  readonly materializationTarget: string;
}

export type PlannedSemanticSessionEndAction =
  | PlanFinalCheckpointAndQueueEndingActionV1
  | PlanFinalCheckpointAndQueueEndingActionV2
  | NonCheckpointSemanticSessionEndAction;

export interface InternalWorkflowPhasePlan
  extends Omit<InternalWorkflowPhaseCommand, "action"> {
  readonly plannedAction: PlannedSemanticSessionEndAction;
}

export type InternalWorkflowExecutionPlan =
  | InternalValidationResultCommand
  | InternalWorkflowPhasePlan;

export interface FinalEndingScopeBindingV1 {
  readonly bindingVersion: 1;
  readonly bindingKind: "current-child" | "carry-forward-ticket";
  readonly childSessionId: SessionId;
  readonly childState: ChildSessionState;
  readonly lastEventPosition: string;
  readonly streamVersion: string;
  readonly checkpointId: CheckpointId | null;
  readonly checkpointEventPosition: string | null;
  readonly transferTicketId: TransferTicketId | null;
  readonly transferTicketEventPosition: string | null;
}

export interface MinimumCheckpointCapacityInput {
  readonly evidenceCoverage: CheckpointEvidenceCoverageV2;
  readonly endingScopeBindings: readonly FinalEndingScopeBindingV1[];
}

export interface MinimumEndingScopeCapacityInput {
  readonly endingScopeBindings: readonly FinalEndingScopeBindingV1[];
}
```

`checkpoint-capacity.ts` owns both input interfaces. Callers supply one canonical,
sorted, duplicate-free projection of every current relevant child and retained
carry-forward ticket. The estimator treats every decimal as 19 digits, every
nullable future child-checkpoint reference as a non-null UUID/position pair, and
every `current-child` entry as the larger of its maximum-width live-summary and
carry-forward-ticket encodings; current short/null values never reduce the
reservation.

Add exactly these safe codes and recovery actions:

| Code | Recovery action |
| --- | --- |
| `CHECKPOINT_EVIDENCE_VERSION_REQUIRED` | `record-version-2-checkpoint` or `amend-or-cancel-session-end` |
| `EVIDENCE_ADAPTER_SESSION_LIMIT` | `start-new-lifecycle-session` |
| `EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE` | `start-new-lifecycle-session` |
| `EVIDENCE_HISTORICAL_KEY_UNAVAILABLE` | `restore-evidence-fingerprint-key` |
| `CHECKPOINT_CAPACITY_EXCEEDED` | `reduce-checkpoint-draft`, `resolve-active-children`, or `start-new-lifecycle-session` |
| `SESSION_END_EVIDENCE_FROZEN` | `amend-or-cancel-session-end` |
| `SESSION_END_EVIDENCE_WINDOW_OPEN` | `seal-session-end-evidence` |
| `SESSION_END_COVERAGE_CHANGED` | `record-version-2-checkpoint` or `amend-or-cancel-session-end` |

- [ ] **Step 1: Write failing V1 immutability and V2 strict-codec tests**

Freeze independent V1 decoder/fingerprint vectors before editing production contracts. Add V2 draft/checkpoint qualified-adapter ordering, duplicate/reordered adapter, zero-based gap, empty-list, 196,608/262,144-byte, unsupported discriminator, and no-fallback tests. Add exact `LifecycleEventV2` matrix tests for the four allowed forms and every mixed outer/nested rejection.

```ts
assert.deepEqual(decodeCheckpointV1(V1_CHECKPOINT_VECTOR), V1_CHECKPOINT_VECTOR);
assert.equal(checkpointFingerprint(V1_CHECKPOINT_VECTOR), V1_CHECKPOINT_HASH);
assert.equal(decodeCheckpoint(V2_CHECKPOINT_VECTOR).checkpointVersion, 2);
assert.throws(
  () => decodeLifecycleEvent(v2Event("SessionStarted", {})),
  /LIFECYCLE_INPUT_INVALID/,
);
```

- [ ] **Step 2: Write failing DTO, final-binding, intent, and error tests**

Cover V2 request/amendment, `evidenceWindowAction`, V3 commands, safe window status, paired-null checkpoint ID/event position, kind-specific ticket null groups, canonical child sorting, deeply frozen decoded arrays/records, 262,144-byte binding JSON, exact capacity-input projections, nested-version intent hash separation, exact old replay, cross-version idempotency conflict, and all eight new stable failures/recovery actions. Checkpoint result-union tests belong to Task 12E with their owning service.

- [ ] **Step 3: Run the RED contract gate**

```powershell
npm run test:build
if ($LASTEXITCODE -ne 0) { throw "Compile RED recorded; add only the Task 12A typed stubs, then rerun this gate" }
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(keeps every Version 1 checkpoint vector byte-for-byte unchanged|rejects every mixed outer and nested lifecycle event version|rejects limit-plus-one checkpoint and ending-scope capacity)$" dist-test/tests/qualified-checkpoint-contracts.test.js
```

Expected after the compile-only scaffold: all three named anchors execute; the
V1 vector stays green while the strict V2 dispatcher and capacity behaviors
fail for `NOT_IMPLEMENTED` or the exact missing rejection. A failed build stops
the command before Node, so stale output is never accepted as RED evidence.

- [ ] **Step 4: Implement strict checkpoint, event, and final-binding dispatch**

Read each discriminator exactly once, call only the selected strict decoder, and reject missing/unknown versions. Keep V1 accepted keys and bounds unchanged. Enforce lowercase UUID byte ordering, independent adapter-local intervals, fixed profiles, fixed coverage flags, and complete canonical byte caps.

```ts
export function decodeCheckpoint(value: unknown): Checkpoint {
  const version = readExactDiscriminator(value, "checkpointVersion");
  if (version === 1) return decodeCheckpointV1(value);
  if (version === 2) return decodeCheckpointV2(value);
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field: "checkpointVersion" });
}
```

Implement `LifecycleEventV2` as an explicit four-member union; do not widen `LifecycleEventPayloadMapV1`. Session folds consume the event union while preserving every Version 1 transition.

- [ ] **Step 5: Implement versioned DTOs, commands, and intent witnesses**

Add the exact V3 command and V1/V2 action interfaces above. Keep every existing
V2 command byte/shape compatible, and include each V2/V3 variant exactly once in
`LifecycleSemanticCommandDraft`. Dispatch same-name operations once on
`checkpoint.checkpointVersion`, `draft.checkpointVersion`,
`request.requestVersion`, or `amendment.amendmentVersion`. Dispatch the internal
final action once on `finalCheckpoint.checkpointVersion`; never widen the V1
member or fall back after the selected decoder fails. At contract decode,
`evidenceWindowAction: "open"` requires a non-null V2 final draft; Task 14 owns
the workflow-dependent legality of null/unchanged/seal. Include the nested
version in candidate/authoritative intent hashes and deterministic planned-work
identities. Do not move or duplicate `CheckpointRecordedResultV1`; Task 12E
extends that type in `checkpoint.service.ts`.

Keep the planned and authoritative internal types distinct. The trusted
coordinator/executor carries `InternalWorkflowPhasePlan`, whose final member has
only the strict stored draft and stable workflow/command/planned-work identity.
It never pretends that a future checkpoint already exists. On a fresh semantic
dedup miss, Task 12E prepares the full checkpoint inside the same transaction;
only then does the worker construct the persisted
`InternalWorkflowPhaseCommand` with `RecordFinalCheckpointAndQueueEndingActionV1
| V2`. Exact replay returns from the stored plan identity before preparation.
Neither type is accepted by an external decoder.

- [ ] **Step 6: Implement conservative capacity primitives**

Use actual canonical UTF-8 length for known strings; reserve `2 + 6n` bytes for an unknown `n`-scalar JSON string, 19 digits for future positive SQLite positions, and both UUID plus position for a nullable future child checkpoint pair. Export pure estimators with exact-limit success and limit-plus-one rejection tests.

- [ ] **Step 7: Run the GREEN contract gate**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/qualified-checkpoint-contracts.test.js dist-test/tests/lifecycle-contracts.test.js dist-test/tests/lifecycle-intent.test.js dist-test/tests/session-aggregate.test.js
npm run typecheck
```

Expected: V1 vectors remain unchanged; strict V2 codecs, intent separation, binding/capacity contracts, bounds, and error mappings pass.

- [ ] **Step 8: Commit Task 12A and run both per-task reviews**

```powershell
git add src/orchestrator/lifecycle/contracts/checkpoint.ts src/orchestrator/lifecycle/contracts/events.ts src/orchestrator/lifecycle/contracts/commands.ts src/orchestrator/lifecycle/contracts/session-end.ts src/orchestrator/lifecycle/checkpoint-capacity.ts src/orchestrator/lifecycle/errors.ts src/orchestrator/lifecycle/session-aggregate.ts src/orchestrator/lifecycle/lifecycle-intent.ts src/orchestrator/lifecycle/lifecycle-intent-witness.ts tests/support/qualified-checkpoint-reference.ts tests/qualified-checkpoint-contracts.test.ts tests/lifecycle-contracts.test.ts tests/lifecycle-intent.test.ts tests/session-aggregate.test.ts
git commit -m "feat: add qualified checkpoint contracts"
```

---

### Task 12B: Add Migration 0003, Quiesced Preflight, and Immutable Storage Guards

**Files:**
- Create: `src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts`
- Create: `src/orchestrator/storage/qualified-checkpoint-migration-preflight.ts`
- Create: `tests/qualified-checkpoint-migration.test.ts`
- Modify: `src/orchestrator/storage/migrations/registry.ts`
- Modify: `src/orchestrator/storage/schema-compatibility.ts`
- Modify: `src/orchestrator/storage/migration-runner.ts`
- Modify: `src/orchestrator/storage/project-store-bootstrap.service.ts`
- Modify: `src/orchestrator/storage/schema-fingerprint.ts`
- Modify: `src/orchestrator/storage/project-store-upgrade.service.ts`
- Modify: `tests/migration-runner.test.ts`
- Modify: `tests/migration-registry.test.ts`
- Modify: `tests/session-lifecycle-migration.test.ts`
- Modify: `tests/project-store-bootstrap.test.ts`
- Modify: `tests/project-store-upgrade.test.ts`
- Modify: `tests/event-integrity.test.ts`

**Interfaces:**
- Consumes: Task 12A codecs/capacity estimators, migration registry/runner, maintenance fence, strict event and workflow rows.
- Produces: Schema 3, deterministic preflight/backfill, immutable coverage transition/aggregate/workflow guards, version-neutral upgrade fault boundary, and `SCHEMA_TOO_NEW` fencing.

```ts
export interface QualifiedCheckpointMigrationPreflight {
  assertEligibleAndStage(
    connection: SqliteConnection,
    context: ProjectContext,
  ): void;
}

export class SqliteQualifiedCheckpointMigrationPreflight
  implements QualifiedCheckpointMigrationPreflight {
  assertEligibleAndStage(
    connection: SqliteConnection,
    context: ProjectContext,
  ): void;
}

export const QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE =
  "qualified_checkpoint_v3_stage_marker";
export const QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE =
  "qualified_checkpoint_v3_stage_rows";

// The existing dependencies object gains no optional bypass field. Tests that
// need an override use the explicit two-argument overload.
export class ProjectStoreUpgradeService {
  constructor();
  constructor(dependencies: ProjectStoreUpgradeServiceDependencies);
  constructor(
    dependencies: ProjectStoreUpgradeServiceDependencies,
    preflightOverride: QualifiedCheckpointMigrationPreflight,
  );
}

export type MigrationBeforeHook = (
  connection: SqliteConnection,
  migration: Migration,
) => void;

// Both modes require the hook; migration 3 never accepts an absent stage.
export type MigrationApplyMode =
  | {
      readonly kind: "bootstrap-empty";
      readonly beforeMigration: MigrationBeforeHook;
    }
  | {
      readonly kind: "explicit-upgrade";
      readonly expectedAppliedVersion: number;
      readonly beforeMigration: MigrationBeforeHook;
      // Existing renewal and fault-injector members remain unchanged.
    };

export function qualifiedCheckpointMigrationFailure(
  error: unknown,
): SchemaCompatibilityError | undefined;

export const CURRENT_PROJECT_STORE_SCHEMA_VERSION = 3;

export type ProjectStoreUpgradeFaultBoundary =
  | "after-fence-before-prefix-integrity"
  | "after-target-ddl-before-migration-row"
  | "after-migration-row-before-project-version"
  | "after-project-version-before-commit"
  | "after-commit-before-full-integrity"
  | "after-full-integrity-before-manifest-record"
  | "after-manifest-record-before-fence-release";
```

Migration 0003 adds these exact workflow columns:

```text
evidence_frozen_checkpoint_event_position
evidence_frozen_generation
evidence_window_state
final_ending_scope_bindings_json
```

It adds aggregate columns `coverage_fingerprint_algorithm`,
`coverage_fingerprint_schema_version`, `coverage_fingerprint_key_id`,
`coverage_fingerprint_domain`, and `coverage_fingerprint_value`, plus immutable
`session_evidence_coverage_transitions`.

- [ ] **Step 1: Write failing registry, immutability, and schema-3 tests**

Assert registry `[1, 2, 3]`, current schema 3, manifest version 1, the raw-file migration-0002 SHA-256, fresh bootstrap history, explicit schema-2-to-3 upgrade, atomic schema-1-to-3 upgrade, schema-3 old-reader `SCHEMA_TOO_NEW`, and renamed `after-target-ddl-before-migration-row` rollback behavior. A successful schema-1 source returns `[2, 3]`; a schema-2 source returns `[3]`.

- [ ] **Step 2: Write failing DDL, trigger, and raw-SQL tests**

Cover aggregate coverage-profile/digest columns, immutable compact transitions, project-scoped adapter uniqueness, no update/delete/slot reuse, fixed profile/lineage guards, OLD/NEW adapter and total-interval formulas, transition-to-event/aggregate linkage, outer/nested lifecycle event matrix, and generic event-core positive versions remaining legal.

Cover workflow non-lifecycle nulls, atomic frozen group, canonical/bounded final bindings, direct child checkpoint event-position cross-binding, strict open/sealed/final phase shapes, and only open, seal, final-freeze, cancel-clear, reopen/reset, and unchanged-preserve rewrites. Measure the binding cap with `length(CAST(final_ending_scope_bindings_json AS BLOB))`, never text-character length: accept exactly 262,144 UTF-8 bytes and reject 262,145 bytes, including a multibyte fixture whose character count remains below the byte limit.

- [ ] **Step 3: Write failing preflight and backfill tests**

Exercise empty coverage tables, absent lifecycle evidence, coverage-empty V1 checkpoints, unrelated generic outer V2 events, pre-final/post-final/cancelled/abandoned workflows, one-pass checkpoint-ID-to-position mapping, exact binding JSON, and rejection of missing/duplicate/cross-session/ambiguous/over-bound history. Add runner-order tests proving the Version 3 hook sees the complete uncommitted schema-2 tables, migration-history row 2, and `project_meta.schema_version = 2`, but no Version 3 object in bootstrap, schema-1, and schema-2 paths. Prove default bootstrap and both default `new ProjectStoreUpgradeService()` constructors cannot bypass preflight, an explicit two-argument upgrade test override is called exactly once for migration 3, and a direct runner call in either mode with a missing/no-op hook fails before 0003 SQL. Cover a zero-workflow sealed marker; missing/extra/mutated staged rows; wrong project/store/source generation/phase; immutable TEMP triggers; byte-identical staged/final values; and cleanup after success/failure. Assert any preflight or target-SQL failure maps to `MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED` only for the exact recognized condition, commits no partial DDL or temporary guard object, and rolls back to the exact source version: fresh bootstrap remains empty, schema 1 stays 1, and schema 2 stays 2.

- [ ] **Step 4: Run the RED migration gate**

```powershell
npm run test:build
if ($LASTEXITCODE -ne 0) { throw "Compile RED recorded; add only the Task 12B typed stubs, then rerun this gate" }
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(requires migration-3 preflight for every explicit upgrade|consumes and drops the canonical staged backfill exactly once|rolls schema-1 and schema-2 sources back after staged-backfill failure)$" dist-test/tests/qualified-checkpoint-migration.test.js dist-test/tests/migration-runner.test.js dist-test/tests/project-store-upgrade.test.js
```

Expected after the compile-only scaffold: the named tests fail because the
mandatory hook/default, staged consumption, and exact source-version rollback
are not implemented. Node is not invoked after a failed build.

- [ ] **Step 5: Implement migration 0003 and static SQL guards**

Add fixed coverage profile/digest columns; immutable `session_evidence_coverage_transitions`; workflow window/frozen pair/binding JSON; deferrable transition-to-aggregate linkage; adapter/interval/lineage guards; scoped lifecycle event version guards; direct checkpoint-position bindings; and static temporary-trigger/probe preconditions dropped before return. Do not edit migration 0002.

- [ ] **Step 6: Implement the mandatory in-transaction Version 3 preflight and staged handoff**

Extend both runner mode members with required
`readonly beforeMigration: MigrationBeforeHook`; validate that it is callable.
For each pending migration execute `renew lease -> beforeMigration(connection,
migration) -> renew/assert lease -> target SQL -> migration-history row ->
project_meta.schema_version`. Immediately before Version 3 SQL the runner also
requires the exact sealed TEMP marker and staged-row count; a missing/no-op hook
fails closed. Prior migrations in the same `BEGIN IMMEDIATE` transaction are
therefore visible to the next hook.

`ProjectStoreUpgradeService` always owns a concrete preflight: its zero- and
one-argument constructors construct `SqliteQualifiedCheckpointMigrationPreflight`;
only the explicit two-argument overload accepts a non-null test override. No
dependency property, `undefined`, or no-op mode can disable it. The service's required hook
invokes `assertEligibleAndStage` exactly when `migration.version === 3`, after
the maintenance fence and prefix-integrity pass. Thus a schema-1 source applies
0002, stages against that uncommitted schema-2 state, and applies 0003
atomically; any callback or target failure rolls the whole transaction back to
schema 1. A schema-2 source follows the same hook and rolls back to schema 2.
`ProjectStoreBootstrapService` also constructs the same concrete preflight and
passes a required hook; after uncommitted schema 2 exists, the hook proves all
semantic tables empty and stages the same sealed zero-row marker. Bootstrap
failure rolls the whole transaction back to the original empty file.

Within preflight, build one linear checkpoint-ID/event-position map and validate
complete event/result/child/ticket bindings plus both capacity estimators.
Create two connection-local `STRICT TEMP` tables with the constant names above:
a singleton marker bound to project/store/source schema 2/target schema 3 and
the exact staged-row count, plus one row per existing lifecycle session-end
workflow. Each row stores source workflow ID, generation, and phase together
with `evidence_frozen_checkpoint_event_position`,
`evidence_frozen_generation`, `evidence_window_state`, and the exact canonical
`final_ending_scope_bindings_json`. Insert the sealed marker last, then install
TEMP triggers forbidding insert/update/delete. No stage row is caller-authored.
Backfill cancelled rows to sealed/null after validating historical finals;
retain an abandoned group only when a complete final exists.

Migration 0003 creates the TEMP shapes `IF NOT EXISTS`, then requires exactly
one matching sealed marker in every mode, no
missing/extra workflow row, unchanged workflow identity/generation/phase,
atomic frozen-group nullability, canonical JSON, and exact UTF-8 byte counts.
After adding the columns, it copies those staged values byte-for-byte, verifies
affected-row counts and final guards, and drops every staging trigger/table
before returning. It never rebuilds checkpoint positions or binding JSON from
history. Any preflight, staging, consumption, or cleanup mismatch is normalized
to `MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED`; rollback leaves
`temp.sqlite_schema` clean.

- [ ] **Step 7: Register schema 3 and update compatibility/fault handling**

Register migration 0003 last, update current-version checks/bootstrap/schema fingerprints, and rename the public target-DDL fault boundary everywhere. Keep the runner's generic internal `after-ddl-before-migration-row` callback and map it to `after-target-ddl-before-migration-row` only when `migration.version === 3`. `qualifiedCheckpointMigrationFailure` recognizes only an existing `SchemaCompatibilityError("MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED")` or SQLite's exact guard abort tuple `(message, code, errcode) = ("MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED", "ERR_SQLITE_ERROR", 1811)`; unrelated SQL and programming failures retain their identity.

- [ ] **Step 8: Run the GREEN migration gate**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/qualified-checkpoint-migration.test.js dist-test/tests/migration-runner.test.js dist-test/tests/migration-registry.test.js dist-test/tests/session-lifecycle-migration.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/event-integrity.test.js
npm run typecheck
```

Expected: schema-1-to-3 and schema-2-to-3 ordering/backfill/guards pass; successful `result.plan` remains the locked source plan; a pre-commit failure restores the exact source schema and retry returns `[2, 3]` or `[3]`; a post-commit fault leaves schema 3 and retry returns `[]` with `resumedPostCommit: true`; no rejected call exposes partial `appliedVersions`; and migration 0002 retains its frozen raw-byte hash.

- [ ] **Step 9: Commit Task 12B and run both per-task reviews**

```powershell
git add src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts src/orchestrator/storage/qualified-checkpoint-migration-preflight.ts src/orchestrator/storage/migrations/registry.ts src/orchestrator/storage/schema-compatibility.ts src/orchestrator/storage/migration-runner.ts src/orchestrator/storage/project-store-bootstrap.service.ts src/orchestrator/storage/schema-fingerprint.ts src/orchestrator/storage/project-store-upgrade.service.ts tests/qualified-checkpoint-migration.test.ts tests/migration-runner.test.ts tests/migration-registry.test.ts tests/session-lifecycle-migration.test.ts tests/project-store-bootstrap.test.ts tests/project-store-upgrade.test.ts tests/event-integrity.test.ts
git commit -m "feat: add qualified checkpoint migration"
```

---

### Task 12C: Persist the Rolling Accumulator and Bounded Coverage Projection

**Files:**
- Create: `src/orchestrator/lifecycle/evidence-coverage-accumulator.ts`
- Create: `src/orchestrator/storage/evidence-coverage.repository.ts`
- Create: `tests/evidence-coverage.test.ts`
- Modify: `src/orchestrator/storage/lifecycle-storage.types.ts`

**Interfaces:**
- Consumes: Schema-3 rows/guards, provider `currentKey`/`status`/`fingerprint`, Task 12A capacity helpers, and exact committed event rows.
- Produces: Pure rolling accumulator plus a bounded prepare/persist/snapshot repository. It does not yet authorize or append a semantic command.

```ts
export interface EvidenceCoverageBatchInput {
  readonly context: ProjectContext;
  readonly command: RecordEvidenceBatchCommandV2;
  readonly prospectiveEndingScopeBindings: readonly FinalEndingScopeBindingV1[];
  readonly plannedEventPosition: bigint | null;
}

// Module-private unique symbol: only EvidenceCoverageRepository.prepareBatch
// can construct a value accepted by persistPrepared.
declare const PREPARED_EVIDENCE_COVERAGE_BATCH: unique symbol;

export interface PreparedEvidenceCoverageBatch {
  readonly [PREPARED_EVIDENCE_COVERAGE_BATCH]: true;
  readonly projectId: ProjectId;
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  readonly adapterSessionId: AdapterSessionId;
  readonly expectedPriorLatestBatchEventPosition: bigint | null;
  readonly previousCoverageFingerprint: string | null;
  readonly eventPayload: EvidenceCoverageRecordedV2;
  readonly newFrames: readonly LifecycleEvidenceFrameRecordedV1[];
}

export class EvidenceCoverageRepository {
  constructor(
    provider: Pick<
      CapabilityKeyProvider,
      "currentKey" | "status" | "fingerprint"
    >,
  );
  prepareBatch(
    connection: SqliteConnection,
    input: EvidenceCoverageBatchInput,
  ): PreparedEvidenceCoverageBatch;
  persistPrepared(
    connection: SqliteConnection,
    prepared: PreparedEvidenceCoverageBatch,
    committedEvent: StoredEvent,
  ): void;
  assertQuickHealthy(
    connection: SqliteConnection,
    sessionIds: readonly SessionId[],
  ): void;
  assertVersion1Eligible(
    connection: SqliteConnection,
    sessionIds: readonly SessionId[],
  ): void;
  snapshotV2(
    connection: SqliteConnection,
    sessionId: SessionId,
    baseEventPosition: bigint,
  ): CheckpointEvidenceCoverageV2;
  snapshotFromTransitionsV2(
    connection: SqliteConnection,
    sessionId: SessionId,
    baseEventPosition: bigint,
  ): CheckpointEvidenceCoverageV2;
  minimumCheckpointUpperBound(
    connection: SqliteConnection,
    input: MinimumCheckpointCapacityInput,
  ): number;
  minimumFinalEndingScopeBindingsUpperBound(
    connection: SqliteConnection,
    input: MinimumEndingScopeCapacityInput,
  ): number;
}
```

`EvidenceCoverageBatchInput` and the branded prepared plan are owned by
`evidence-coverage.repository.ts`. `context` supplies the authoritative
project/store scope; `command` supplies the already-decoded batch; the ending
scope feeds both Task 12A estimators; and `plannedEventPosition` is either the
append planner's exact position or `null`, which selects the 19-digit
placeholder only for capacity calculation. The deeply frozen prepared plan is
the complete persistence authority: `eventPayload` contains the whole incoming
batch plus prospective cumulative projection, `newFrames` is the sorted
genuinely-new subset, and the prior position/digest bind the expected aggregate.
`persistPrepared` derives transition, aggregate, and ordinal rows only from
those fields plus the committed event's actual position/time and rejects any
brand, CAS, byte, project, session, adapter, batch, or payload mismatch.

- [ ] **Step 1: Write failing pure accumulator and interval tests**

Add independent vectors for first batch, mixed overlap/new, gap fill, zero-new, history-sensitive batching, first captured ordinal above zero, storage `-1` to public `null`, and bigint adjacency. Assert `currentKey` is called only for a new adapter profile, later writes call `status` on the recorded profile, partial overlap hashes only new frames, and zero-new calls neither `currentKey` nor `fingerprint`.

```ts
assert.equal(provider.calls.fingerprint, 0);
assert.equal(zeroNew.coverageFingerprint, prior.coverageFingerprint);
assert.deepEqual(firstAboveZero.missingIntervals, [
  { firstOrdinal: "0", lastOrdinal: "4" },
]);
```

- [ ] **Step 2: Write failing repository/provider/bound tests**

Cover immutable ordinal/frame-ID overlap, contradiction before append, fixed frame/coverage profiles, later-write historical-key status, exact provider project/store/purpose/key/domain inputs, caller-buffer zeroization on provider failure, adapter 200/201, per-adapter and total interval 200/201, coverage byte cap, both prospective capacity estimators, the exact/null planned-position branch, deeply frozen unforgeable prepared plans, and instrumentation proving no prior ordinal scan.

- [ ] **Step 3: Write failing repository persistence and fault tests**

Require `persistPrepared` to byte-match an existing Version 2 evidence event and write transition → aggregate → ordinal rows. Inject a repository fault at each boundary for first and later batches; the surrounding test transaction rolls back every repository row. Reject a missing/wrong-session/wrong-batch/wrong-cumulative committed event.

- [ ] **Step 4: Run the RED evidence gate**

```powershell
npm run test:build
if ($LASTEXITCODE -ne 0) { throw "Compile RED recorded; add only the Task 12C typed stubs, then rerun this gate" }
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(advances one adapter accumulator without rescanning historical ordinals|rejects adapter interval and byte limits before provider work)$" dist-test/tests/evidence-coverage.test.js
```

Expected after the compile-only scaffold: the named accumulator and bound tests
fail without reading historical ordinals or invoking a provider. Node is not
invoked after a failed build.

- [ ] **Step 5: Implement the pure accumulator and bounded prepare plan**

Start from the bounded aggregate intervals. Compare only incoming ordinal/frame IDs, sort genuinely new frames numerically, update/coalesce intervals incrementally, derive the zero-based contiguous prefix, enforce all prospective bounds, and canonicalize the exact accumulator body from the approved spec.

Encode fresh mutable canonical JSON bytes, call only:

```ts
provider.fingerprint({
  projectId,
  storeId,
  purpose: "evidence-fingerprint",
  keyId: coverageFingerprintKeyId,
  domain: "pm-evidence-coverage-v1",
  bytes,
});
```

Validate a 64-character lowercase hex result and zero only caller-owned bytes in `finally`.

- [ ] **Step 6: Implement immutable transition, aggregate, and ordinal persistence**

Require the committed event and frozen prepared plan to match exactly, then write transition → aggregate → ordinal rows. Preserve lineage/profile fields, advance latest linkage monotonically, use the storage `-1` sentinel only internally, and rely on the caller's transaction for all-or-none rollback.

- [ ] **Step 7: Implement bounded health, eligibility, and snapshot reads**

`assertQuickHealthy` and `snapshotV2` read at most 200 aggregates/latest transitions plus 200 intervals, require distinct-profile `available` status where mandated, require every latest batch event position to be at or before the requested base, sort adapter IDs bytewise, and never read ordinal rows or decode frame arrays. `snapshotFromTransitionsV2` is the separate event-time seam: for each of at most 200 lifetime adapters it selects the single immutable transition with maximum `batchEventPosition <= baseEventPosition` through the `(project, session, adapter, batchEventPosition)` index, returns the same canonical snapshot type, and never consults a current aggregate. `assertVersion1Eligible` also rejects every coverage artifact and coverage-bearing checkpoint.

- [ ] **Step 8: Run the GREEN evidence gate**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/evidence-coverage.test.js dist-test/tests/session-lifecycle-migration.test.js
npm run typecheck
```

Expected: vectors, provider scope/calls, overlap/gaps, global bounds, immutable write ordering, rollback, eligibility, and bounded snapshots pass.

- [ ] **Step 9: Commit Task 12C and run both per-task reviews**

```powershell
git add src/orchestrator/lifecycle/evidence-coverage-accumulator.ts src/orchestrator/storage/evidence-coverage.repository.ts src/orchestrator/storage/lifecycle-storage.types.ts tests/evidence-coverage.test.ts
git commit -m "feat: persist authenticated evidence coverage"
```

---

### Task 12D: Record Coverage-Only Evidence Through the Central Fresh-Integrity Gate

**Files:**
- Create: `src/orchestrator/lifecycle/evidence-coverage.service.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-command.store.ts`
- Modify: `src/orchestrator/lifecycle/contracts/commands.ts`
- Modify: `src/orchestrator/lifecycle/contracts/events.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-intent.ts`
- Modify: `src/orchestrator/lifecycle/lifecycle-intent-witness.ts`
- Modify: `tests/evidence-coverage.test.ts`
- Modify: `tests/lifecycle-command-store.test.ts`
- Modify: `tests/lifecycle-contracts.test.ts`

**Interfaces:**
- Consumes: Task 12C repository, exact event append planning, semantic authorization, authority lineage, and schema-3 workflow window fields.
- Produces: Expanded connection-bound facade, mandatory replay/window/health order, authorized Version 2 evidence events, and coverage-only results.

```ts
export interface ConnectionBoundEvidenceCoverage {
  assertEvidenceWindowWritable(sessionId: SessionId): void;
  assertQuickHealthy(sessionIds: readonly SessionId[]): void;
  assertVersion1Eligible(sessionIds: readonly SessionId[]): void;
  prepareBatch(input: EvidenceCoverageBatchInput): PreparedEvidenceCoverageBatch;
  persistPrepared(
    prepared: PreparedEvidenceCoverageBatch,
    committedEvent: StoredEvent,
  ): void;
  snapshotV2(
    sessionId: SessionId,
    baseEventPosition: bigint,
  ): CheckpointEvidenceCoverageV2;
  minimumCheckpointUpperBound(input: MinimumCheckpointCapacityInput): number;
  minimumFinalEndingScopeBindingsUpperBound(
    input: MinimumEndingScopeCapacityInput,
  ): number;
}

export type EvidenceCoverageRecordedResultV2 = JsonValue & {
  readonly resultVersion: 2;
  readonly operation: "record-evidence-batch";
  readonly sessionId: SessionId;
  readonly adapterSessionId: AdapterSessionId;
  readonly batchId: EvidenceBatchId;
  readonly batchFirstOrdinal: string;
  readonly batchLastOrdinal: string;
  readonly coverageFirstOrdinal: "0";
  readonly coverageLastOrdinal: string;
  readonly highestContiguousOrdinal: string | null;
  readonly missingIntervals: readonly MissingOrdinalIntervalV1[];
  readonly captureMode: "coverage-only";
  readonly contentRetained: false;
  readonly eventPosition: string;
  readonly finalStreamVersion: string;
};

export function decodeEvidenceCoverageRecordedResultV2(
  value: unknown,
): EvidenceCoverageRecordedResultV2;

export class EvidenceCoverageService {
  record(
    transaction: LifecycleCommandTransaction,
    command: RecordEvidenceBatchCommandV2,
  ): FreshLifecycleEffect<EvidenceCoverageRecordedResultV2>;
}
```

- [ ] **Step 1: Write failing authorization, event, and result tests**

Cover root-to-descendant and child-self scope, generation/proof binding, batch versus cumulative fields, fixed provider profiles, no caller algorithm, no raw body/reference, coverage-only result, exact retry, conflicting reuse, and zero-new latest-batch movement.

- [ ] **Step 2: Write failing command-store order and evidence-window tests**

Prove exact replay returns before window/health/provider/repository/UUID access. For fresh evidence prove constant-time root/child workflow lookup; valid absent/cancelled/open/sealed-pre-final allowance; malformed shape `INTEGRITY_FAILURE`; frozen root/descendant `SESSION_END_EVIDENCE_FROZEN`; and quick health before the callback. Prove root start skips health for its not-yet-existing session, while a callback that resolves an additional existing descendant must register and quick-check it before any semantic write.

- [ ] **Step 3: Write failing append/postwrite rollback tests**

Inject faults after event append and before/after transition, aggregate, and ordinal persistence. Every first/later batch must commit event, transition, aggregate, and ordinal rows together or leave all absent.

- [ ] **Step 4: Run the RED service gate**

```powershell
npm run test:build
if ($LASTEXITCODE -ne 0) { throw "Compile RED recorded; add only the Task 12D typed stubs, then rerun this gate" }
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(returns replay before window health provider or repository access|commits evidence event transition aggregate and ordinals atomically)$" dist-test/tests/evidence-coverage.test.js dist-test/tests/lifecycle-command-store.test.js
```

Expected after the compile-only scaffold: the replay-first and atomic postwrite
anchors fail for the exact missing order/behavior. Node is not invoked after a
failed build.

- [ ] **Step 5: Implement mandatory fresh-command ordering**

After replay and identity/append validation, derive affected session IDs only from the trusted envelope. For fresh evidence call `assertEvidenceWindowWritable` before quick health; quick-check every affected existing session; invoke the semantic callback only afterward. Preserve append/postwrites, dedup, and commit as the final stages.

- [ ] **Step 6: Implement authorized evidence recording and the exact result seam**

Decode/recompute the command intent, verify authority scope, derive the trusted
current ending-scope projection, and pass it together with the append planner's
exact event position to read-only `prepareBatch`. Append exactly one outer
Version 2 `EvidenceCoverageRecorded`, and call `persistPrepared` only from
`afterAppend` with that committed event. Return the exact deeply frozen result
above using the committed event position/final stream version. The result
exposes no fingerprint, profile/key ID, frame, `observedAt`, provider material,
or raw evidence. Its strict decoder rejects extra/missing/malformed fields and
never infers the version from shape.

- [ ] **Step 7: Run the GREEN service gate**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/evidence-coverage.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-contracts.test.js dist-test/tests/session-lifecycle-migration.test.js
npm run typecheck
```

Expected: authorization, replay-first behavior, window/freeze checks, quick health, Version 2 events, postwrite ordering, and rollback pass.

- [ ] **Step 8: Commit Task 12D and run both per-task reviews**

```powershell
git add src/orchestrator/lifecycle/evidence-coverage.service.ts src/orchestrator/lifecycle/lifecycle-command.store.ts src/orchestrator/lifecycle/contracts/commands.ts src/orchestrator/lifecycle/contracts/events.ts src/orchestrator/lifecycle/lifecycle-intent.ts src/orchestrator/lifecycle/lifecycle-intent-witness.ts tests/evidence-coverage.test.ts tests/lifecycle-command-store.test.ts tests/lifecycle-contracts.test.ts
git commit -m "feat: record coverage-only evidence batches"
```

---

### Task 12E: Make Checkpoint and Replay Paths Version-Aware

**Files:**
- Modify: `src/orchestrator/lifecycle/checkpoint.service.ts`
- Modify: `src/orchestrator/lifecycle/session-aggregate.ts`
- Modify: `src/orchestrator/storage/session-authority.repository.ts`
- Modify: `src/orchestrator/storage/lifecycle-storage.types.ts`
- Modify: `src/orchestrator/lifecycle/source-state.provider.ts`
- Modify: `tests/checkpoint.service.test.ts`
- Modify: `tests/session-authority.repository.test.ts`
- Modify: `tests/support/lifecycle-fixtures.ts`

**Interfaces:**
- Consumes: Task 12C bounded snapshots/eligibility facade, Task 12A versioned contracts, existing source-state provider and checkpoint marker CAS.
- Produces: One V1/V2 checkpoint preparation path for manual root/child and later suspension/final callers, versioned repository/index/result decoding, V1 eligibility, and direct historical checkpoint lookup.

```ts
export type CheckpointRecordedResult =
  | CheckpointRecordedResultV1
  | CheckpointRecordedResultV2;

export type CheckpointRecordedResultV2 = JsonValue & {
  readonly checkpointVersion: 2;
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly baseEventPosition: string;
  readonly checkpointEventPosition: string;
  readonly finalStreamVersion: string;
  readonly checkpointRequiredCleared: boolean;
};

export function decodeCheckpointRecordedResult(
  value: unknown,
): CheckpointRecordedResult;

export interface CheckpointAtEventPositionInput {
  readonly projectId: ProjectId;
  readonly sessionId: SessionId;
  readonly checkpointId: CheckpointId;
  readonly checkpointEventPosition: bigint;
}

export class SessionAuthorityRepository {
  latestCheckpoint(
    connection: SqliteConnection,
    authority: SessionAuthorityRecord,
  ): Checkpoint | null;
  requireCheckpointAtEventPosition(
    connection: SqliteConnection,
    input: CheckpointAtEventPositionInput,
  ): Checkpoint;
}

export interface FinalCheckpointPhasePreparationInput {
  readonly command: RecordCheckpointCommandV2 | RecordCheckpointCommandV3;
  readonly materializationTarget: string;
}

declare const PREPARED_FINAL_CHECKPOINT_PHASE: unique symbol;

export interface PreparedFinalCheckpointPhase {
  readonly [PREPARED_FINAL_CHECKPOINT_PHASE]: true;
  readonly action:
    | RecordFinalCheckpointAndQueueEndingActionV1
    | RecordFinalCheckpointAndQueueEndingActionV2;
  readonly effect: FreshLifecycleEffect<CheckpointRecordedResult>;
}

export class CheckpointService {
  record(
    tx: LifecycleCommandTransaction,
    command: RecordCheckpointCommandV2 | RecordCheckpointCommandV3,
  ): FreshLifecycleEffect<CheckpointRecordedResult>;
  prepareFinalPhase(
    tx: LifecycleCommandTransaction,
    input: FinalCheckpointPhasePreparationInput,
  ): PreparedFinalCheckpointPhase;
  recordPreparedFinal(
    tx: LifecycleCommandTransaction,
    prepared: PreparedFinalCheckpointPhase,
  ): FreshLifecycleEffect<CheckpointRecordedResult>;
}
```

- [ ] **Step 1: Write failing V1 eligibility, V2 snapshot, and hash tests**

Cover fresh V1 before evidence, rejection after any event/ordinal/aggregate/coverage-bearing checkpoint, historical V1 validity and exact replay, V2 empty-before-evidence, two adapters with overlapping ordinals kept separate, deterministic order, latest batch linkage, key unavailability before source/UUID work, independent V1/V2 hash vectors, strict V1/V2 checkpoint result decoding, and mixed result/index/body/version rejection.

- [ ] **Step 2: Write failing shared manual/final preparation tests**

Exercise manual root, child, and internal final preparation through one version-aware path. Prove caller-supplied identity/position/source/child assertions never become authoritative unless equal, and both versions retain the same marker/index compare-and-swap semantics. For final preparation, prove the input contains only the stable draft/materialization target, `prepareFinalPhase` creates the full V1/V2 action and branded effect inside the active transaction, `recordPreparedFinal` accepts only that same-transaction brand once, and a replay hit invokes neither method.

- [ ] **Step 3: Write failing ending-scope binding and direct lookup tests**

Require a non-null checkpoint ID/event-position pair to resolve one exact `SessionCheckpointRecorded` event with matching project/session/body/index binding. Move the mutable child latest-checkpoint index afterward and prove historical lookup still resolves the old checkpoint directly by global event position.

- [ ] **Step 4: Run the RED checkpoint gate**

```powershell
npm run test:build
if ($LASTEXITCODE -ne 0) { throw "Compile RED recorded; add only the Task 12E typed stubs, then rerun this gate" }
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(dispatches checkpoint preparation once on checkpointVersion|resolves a historical checkpoint only by its stored global position)$" dist-test/tests/checkpoint.service.test.js dist-test/tests/session-authority.repository.test.js
```

Expected after the compile-only scaffold: the versioned preparation/result and
direct-position lookup anchors fail. Node is not invoked after a failed build.

- [ ] **Step 5: Implement one discriminator-driven checkpoint preparation path**

After dedup, establish the base position, run version eligibility or bounded V2 snapshot, and only then capture source state/generate UUID/enrich. Hash once with `project-memory/checkpoint/v1\n` or `project-memory/checkpoint/v2\n` according to the nested version; never try both. Keep marker clearing and latest-index CAS shared.

For an internal final phase, the semantic store first checks replay using the
stable `InternalWorkflowPhasePlan`. Only on a miss, while its one
`LifecycleCommandTransaction` is active, call `prepareFinalPhase`; it performs
the same versioned enrichment and returns a branded full action/effect. The
fresh callback then constructs the authoritative persisted
`InternalWorkflowPhaseCommand`, verifies its nested version equals the plan,
persists authorization, and calls `recordPreparedFinal` before the shared
append/postwrite path. The brand is transaction-local, single-use, and cannot be
decoded or supplied by the coordinator. No source capture, UUID, or checkpoint
body is needed to construct the pre-store replay expectation.

- [ ] **Step 6: Propagate unions through repository, diagnostics, and replay**

Return `Checkpoint` from `SessionAuthorityRepository.latestCheckpoint`. Add `requireCheckpointAtEventPosition(connection, { projectId, sessionId, checkpointId, checkpointEventPosition })`, which performs one indexed global-position read and requires an exact project/session/event-type/outer-version/body/index binding before returning `Checkpoint`; it never consults the mutable latest pointer. In `checkpoint.service.ts`, widen only `CheckpointAgeDiagnosticInputV1.checkpoint` and `RiskyTransitionCheckpointInputV1.checkpoint` to `Checkpoint | null`, make their existing diagnostic/risky functions dispatch once on `checkpointVersion`, and add the strict result decoder above. Keep `checkpointFixture()` explicitly V1 and add `qualifiedCheckpointFixture()` explicitly V2 in `tests/support/lifecycle-fixtures.ts` rather than weakening either builder to an inferred union.

The clean-scope seam is exactly `transaction.coverage.assertVersion1Eligible(sessionIds: readonly SessionId[]): void` from Task 12D; Task 12F and Task 14 call that method after replay using the complete trusted root/ending-scope IDs. The direct historical seam is exactly `SessionAuthorityRepository.requireCheckpointAtEventPosition` above, bound through the existing transaction authority facade by downstream private operation adapters. No second lookup helper or shape-based fallback is introduced.

- [ ] **Step 7: Run the GREEN checkpoint gate**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/checkpoint.service.test.js dist-test/tests/session-authority.repository.test.js dist-test/tests/evidence-coverage.test.js dist-test/tests/qualified-checkpoint-contracts.test.js
npm run typecheck
```

Expected: V1 compatibility/eligibility, V2 snapshots/hashes, repository unions, direct lookup, and shared checkpoint preparation pass.

- [ ] **Step 8: Commit Task 12E and run both per-task reviews**

```powershell
git add src/orchestrator/lifecycle/checkpoint.service.ts src/orchestrator/lifecycle/session-aggregate.ts src/orchestrator/storage/session-authority.repository.ts src/orchestrator/storage/lifecycle-storage.types.ts src/orchestrator/lifecycle/source-state.provider.ts tests/checkpoint.service.test.ts tests/session-authority.repository.test.ts tests/support/lifecycle-fixtures.ts
git commit -m "feat: record qualified lifecycle checkpoints"
```

---

### Task 12F: Share Checkpoint Preparation and Capacity Across State-Growing Paths

**Files:**
- Modify: `src/orchestrator/lifecycle/lifecycle-command.processor.ts`
- Modify: `src/orchestrator/lifecycle/child-workflow.service.ts`
- Modify: `src/orchestrator/lifecycle/checkpoint.service.ts`
- Modify: `src/orchestrator/storage/child-transfer.repository.ts`
- Modify: `tests/lifecycle-command-processor.test.ts`
- Modify: `tests/child-workflow.test.ts`
- Modify: `tests/checkpoint.service.test.ts`

**Interfaces:**
- Consumes: Task 12E version-aware checkpoint preparation and Task 12A capacity estimators.
- Produces: No duplicated V1-only suspension builder and symmetric capacity enforcement for evidence, fork, transfer claim, and the carry-forward seam used by Task 14.

The cross-task capacity seam is the pair already owned by
`ConnectionBoundEvidenceCoverage`; there is no unnamed adapter:

```ts
const minimumCheckpointBytes: number = transaction.coverage.minimumCheckpointUpperBound({
  evidenceCoverage,
  endingScopeBindings: prospectiveEndingScopeBindings,
} satisfies MinimumCheckpointCapacityInput);

const minimumEndingScopeBytes: number = transaction.coverage.minimumFinalEndingScopeBindingsUpperBound({
  endingScopeBindings: prospectiveEndingScopeBindings,
} satisfies MinimumEndingScopeCapacityInput);
```

Every caller rejects a first result above `CHECKPOINT_MAX_CANONICAL_BYTES` or a
second result above `FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES` with
`CHECKPOINT_CAPACITY_EXCEEDED`. Task 14 calls these exact two methods with its
canonical prospective carry-forward replacement set before any ticket UUID,
append, workflow, or authority mutation.

- [ ] **Step 1: Write failing root-suspension shared-path tests**

Prove `RootSuspendCommandV2` and V3 invoke the same checkpoint preparation used by manual recording, preserve their nested version/result tag, snapshot before source/UUID work, and apply the correct fingerprint domain and marker/index rules. After replay, the V2 path calls `transaction.coverage.assertVersion1Eligible` with the trusted root plus complete current ending-scope IDs; the V3 path uses bounded Version 2 snapshots for the same scope.

- [ ] **Step 2: Write failing child/ticket capacity tests**

Cover exact and limit-plus-one checkpoint/binding estimates for fork and transfer claim, with quotes, backslashes, control characters, non-BMP strings, maximum-width positions, and nullable future checkpoint pairs. Verify rejection before UUID, append, authority insert, or ticket mutation.

- [ ] **Step 3: Write failing replacement/carry-forward projection tests**

`claim-child-transfer` must fold the old terminal transferred child and replacement without double-counting. Build one canonical `prospectiveEndingScopeBindings` array and feed it to both named facade methods above. A `current-child` input reserves the larger live-summary/ticket representation; a `carry-forward-ticket` input reserves its maximum-width checkpoint/ticket pairs. Task 14 consumes the same methods and input types, not a new helper.

- [ ] **Step 4: Run the RED transition-capacity gate**

```powershell
npm run test:build
if ($LASTEXITCODE -ne 0) { throw "Task 12F consumes established seams and must compile before behavioral RED" }
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(uses shared checkpoint preparation for root suspension|rejects every state-growing path before capacity is exceeded)$" dist-test/tests/lifecycle-command-processor.test.js dist-test/tests/child-workflow.test.js
```

Expected: compilation is green because Task 12F introduces no new public seam;
the named tests fail because suspension still has its V1-only builder or a
state-growing path mutates before both estimators pass.

- [ ] **Step 5: Replace duplicated suspension enrichment with the shared service**

Delete the local V1-only decode/build/hash/empty-coverage path. Pass the versioned draft through Task 12E preparation and keep suspension authority/event mutation in the existing semantic transaction.

- [ ] **Step 6: Enforce both estimators before every state-growing mutation**

Use current root coverage plus the prospective relevant-child/ticket set. Evidence already calls both methods from `EvidenceCoverageRepository.prepareBatch`; fork and transfer claim call both here; Task 14 calls both before suspend-and-carry-forward. Compare the returned byte counts to the two exported limits before append/UUID/authority/ticket work. Passing one estimator never substitutes for the other, and no call site substitutes current mutable latest-child state for the canonical prospective projection.

- [ ] **Step 7: Run the GREEN transition-capacity gate**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/lifecycle-command-processor.test.js dist-test/tests/child-workflow.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/evidence-coverage.test.js
npm run typecheck
```

Expected: suspension uses the shared version-aware path and all currently implemented state-growing paths preserve mandatory future checkpointability.

- [ ] **Step 8: Commit Task 12F and run both per-task reviews**

```powershell
git add src/orchestrator/lifecycle/lifecycle-command.processor.ts src/orchestrator/lifecycle/child-workflow.service.ts src/orchestrator/lifecycle/checkpoint.service.ts src/orchestrator/storage/child-transfer.repository.ts tests/lifecycle-command-processor.test.ts tests/child-workflow.test.ts tests/checkpoint.service.test.ts
git commit -m "feat: enforce lifecycle checkpoint capacity"
```

---

### Task 12G: Add Async Integrity Orchestration and Fail Closed Synchronously

**Files:**
- Modify: `src/orchestrator/integrity/integrity.types.ts`
- Modify: `src/orchestrator/integrity/event-integrity.service.ts`
- Modify: `src/orchestrator/integrity/lifecycle-integrity.service.ts`
- Modify: `tests/event-integrity.test.ts`

**Interfaces:**
- Consumes: Existing synchronous integrity extension lifecycle.
- Produces: Provider-port and async-extension contracts, one deferred async read transaction, exactly-once extension dispatch, and unambiguous synchronous fail-closed behavior. It adds no IPC or worker routing.

```ts
export interface HistoricalEvidenceIntegrityProviderPort {
  status(keyId: string): Promise<"available" | "revoked" | "unavailable">;
  fingerprint(keyId: string, bytes: Uint8Array): Promise<string>;
}

export interface AsyncIntegrityExtension extends IntegrityExtension {
  quickCheckAsync(context: ProjectContext, sink: IntegrityIssueSink): Promise<void>;
  fullCheckAsync(context: ProjectContext, sink: IntegrityIssueSink): Promise<void>;
}

export class EventIntegrityService {
  quickCheckAsync(context: ProjectContext, tailLimit?: number): Promise<IntegrityReport>;
  fullCheckAsync(context: ProjectContext): Promise<IntegrityReport>;
}

export class LifecycleIntegrityService implements AsyncIntegrityExtension {
  constructor(
    connection: SqliteConnection,
    provider?: HistoricalEvidenceIntegrityProviderPort,
  );
}
```

Async methods hold one `BEGIN DEFERRED` transaction across awaited extensions,
commit once, and roll back preserving the original error. Each extension runs
exactly once—async when available, otherwise sync. Sync checks stay unchanged
only for Version 1/no-coverage stores; qualified coverage makes sync
`quickCheck`/`fullCheck` throw `EVIDENCE_HISTORICAL_KEY_UNAVAILABLE`, never an
ordinary success report.

- [ ] **Step 1: Write the two exact failing orchestration tests**

Declare exactly `async integrity holds one deferred transaction and invokes
each extension once` and `synchronous integrity fails closed when qualified
coverage requires authentication`. Cover commit/rollback/original-error,
async-over-sync selection, no double call, V1/no-coverage compatibility, and
qualified-coverage sync failure.

- [ ] **Step 2: Run the deterministic RED orchestration gate**

```powershell
npm run test:build
if ($LASTEXITCODE -ne 0) { throw "Compile RED recorded; add only the Task 12G typed stubs, then rerun this gate" }
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(async integrity holds one deferred transaction and invokes each extension once|synchronous integrity fails closed when qualified coverage requires authentication)$" dist-test/tests/event-integrity.test.js
```

Expected: both exact anchors execute and fail for missing async transaction or
sync fail-closed behavior.

- [ ] **Step 3: Implement only orchestration and sync fail-closed semantics**

Implement the interfaces and invariants above with in-process provider fakes.
Do not add protocol codecs, worker messages, bounded quick semantics, or replay.

- [ ] **Step 4: Run GREEN, commit Task 12G, and run both per-task reviews**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-integrity.test.js
npm run typecheck
git add src/orchestrator/integrity/integrity.types.ts src/orchestrator/integrity/event-integrity.service.ts src/orchestrator/integrity/lifecycle-integrity.service.ts tests/event-integrity.test.ts
git commit -m "feat: add async lifecycle integrity orchestration"
```

---

### Task 12H: Broker Historical Integrity Provider Operations

**Files:**
- Create: `src/orchestrator/runtime/worker-integrity-provider-client.ts`
- Create: `tests/integrity-provider-broker.test.ts`
- Modify: `src/orchestrator/runtime/worker-protocol.ts`
- Modify: `src/orchestrator/runtime/project-store-worker-backend.ts`
- Modify: `src/workers/project-store.worker.ts`
- Modify: `tests/support/lifecycle-authority-reference.ts`
- Modify: `tests/project-store-executor.test.ts`

**Interfaces:**
- Consumes: Task 12G's exact provider port/async methods and the existing integrity child lifecycle.
- Produces: Strict one-in-flight status/fingerprint IPC, backend-owned provider scope, exact failure mapping, and provider/key isolation. It adds no quick/replay semantics.

`worker-protocol.ts` owns messages outside public worker unions:

```ts
export const MAX_INTEGRITY_PROVIDER_INPUT_BYTES = 4 * 1024 * 1024;

export type IntegrityProviderRequestWire =
  | { readonly type: "integrity-provider-request"; readonly integrityRequestId: string; readonly providerRequestId: string; readonly operation: "status"; readonly keyId: string }
  | { readonly type: "integrity-provider-request"; readonly integrityRequestId: string; readonly providerRequestId: string; readonly operation: "fingerprint"; readonly keyId: string; readonly bytes: Uint8Array };

export type IntegrityProviderResponseWire =
  | { readonly type: "integrity-provider-response"; readonly integrityRequestId: string; readonly providerRequestId: string; readonly operation: "status"; readonly ok: true; readonly status: "available" | "revoked" | "unavailable" }
  | { readonly type: "integrity-provider-response"; readonly integrityRequestId: string; readonly providerRequestId: string; readonly operation: "fingerprint"; readonly ok: true; readonly fingerprint: string }
  | { readonly type: "integrity-provider-response"; readonly integrityRequestId: string; readonly providerRequestId: string; readonly operation: "status" | "fingerprint"; readonly ok: false; readonly code: "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE" | "INTEGRITY_FAILURE" };

export function decodeIntegrityProviderRequestWire(value: unknown): IntegrityProviderRequestWire;
export function decodeIntegrityProviderResponseWire(value: unknown): IntegrityProviderResponseWire;

export interface ProjectStoreWorkerBackendOptions {
  readonly keyProvider?: CapabilityKeyProvider;
}

export class WorkerIntegrityProviderClient implements HistoricalEvidenceIntegrityProviderPort {
  constructor(port: Pick<import("node:worker_threads").MessagePort, "postMessage">, integrityRequestId: string, mode: "quick" | "full");
  accept(value: unknown): void;
  dispose(error?: Error): void;
  status(keyId: string): Promise<"available" | "revoked" | "unavailable">;
  fingerprint(keyId: string, bytes: Uint8Array): Promise<string>;
}

export function runIntegrityChild(
  context: ProjectContext,
  request: Extract<WorkerRequest, { type: "quickIntegrity" | "fullIntegrity" }>,
  provider?: HistoricalEvidenceIntegrityProviderPort,
): Promise<IntegrityReport>;
```

The backend owns the optional provider and Task 13 reuses that exact instance;
production still injects none. `workerData` stays `{ role: "integrity", binding
}`. Backend-derived project/store/purpose/domain and provider/key material never
cross the wire. Key IDs are at most 128 Unicode scalars. Fingerprint input is a
nonempty, non-shared, whole-buffer `Uint8Array` up to 4 MiB; transfer once,
invoke once, and zero in backend `finally`. Responses contain only status or a
64-lowerhex digest. Every ID/tag matches the active request; status is legal in
quick/full and fingerprint only in full. Extra, duplicate, concurrent,
out-of-order, malformed, or second-terminal traffic is `WORKER_PROTOCOL_ERROR`
and terminates the child. Missing/non-available provider maps to
`EVIDENCE_HISTORICAL_KEY_UNAVAILABLE`; provider throw/malformed output maps to
`INTEGRITY_FAILURE` without details. Legacy integrity makes zero broker calls.

- [ ] **Step 1: Write the two exact failing broker tests**

Declare exactly `integrity provider broker preserves backend ownership and
strict request correlation` and `integrity provider broker terminates malformed
concurrent or out-of-order traffic`. Cover codecs, correlation, limits/types,
real child exchange, quick fingerprint rejection, one-in-flight ordering,
missing/throwing provider, child death/close, provider scope/bytes,
zeroization, and canary absence.

- [ ] **Step 2: Run deterministic RED broker gate**

```powershell
npm run test:build
if ($LASTEXITCODE -ne 0) { throw "Compile RED recorded; add only the Task 12H typed stubs, then rerun this gate" }
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(integrity provider broker preserves backend ownership and strict request correlation|integrity provider broker terminates malformed concurrent or out-of-order traffic)$" dist-test/tests/integrity-provider-broker.test.js dist-test/tests/project-store-executor.test.js
```

Expected: both exact broker anchors execute and fail for the absent/stubbed IPC
state machine or ownership boundary.

- [ ] **Step 3: Implement only strict broker routing and ownership**

Route child provider messages before terminal response decoding, reject every
other second message, keep the child in the tracked close/termination set, and
always await Task 12G's async method. Do not add quick/replay semantics.

- [ ] **Step 4: Run GREEN, commit Task 12H, and run both per-task reviews**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/integrity-provider-broker.test.js dist-test/tests/project-store-executor.test.js
npm run typecheck
git add src/orchestrator/runtime/worker-integrity-provider-client.ts src/orchestrator/runtime/worker-protocol.ts src/orchestrator/runtime/project-store-worker-backend.ts src/workers/project-store.worker.ts tests/support/lifecycle-authority-reference.ts tests/integrity-provider-broker.test.ts tests/project-store-executor.test.ts
git commit -m "feat: broker lifecycle integrity provider operations"
```

---

### Task 12I: Prove Bounded Quick Integrity

**Files:**
- Create: `tests/qualified-checkpoint-quick-integrity.test.ts`
- Modify: `src/orchestrator/integrity/lifecycle-integrity.service.ts`
- Modify: `tests/event-integrity.test.ts`
- Modify: `tests/evidence-coverage.test.ts`
- Modify: `tests/checkpoint.service.test.ts`
- Modify: `tests/qualified-checkpoint-migration.test.ts`

**Interfaces:**
- Consumes: Task 12G async orchestration, Task 12H brokered status port, strict event/checkpoint/binding codecs, aggregate/latest-transition/event/index rows, direct historical checkpoint lookup, and event-time transition snapshots.
- Produces: Bounded quick health usable before fresh commands; no ordinal scan, frame decode, HMAC replay, repair, or comparison of frozen baselines with current mutable authority.

- [ ] **Step 1: Write failing bounded quick-integrity tests**

Use the exact anchor titles `bounded quick integrity rejects aggregate
transition and checkpoint tampering without ordinal reads`, `bounded quick
integrity resolves frozen version 2 checkpoints at the recorded event-time
baseline`, `bounded quick integrity rejects one-byte prospective capacity
overflow`, and `bounded quick integrity checks status once per distinct current
profile`. After valid commits, tamper each aggregate/profile/digest/interval,
latest transition/event, checkpoint body/index/hash/version, frozen group,
ticket/direct-position binding, and open-window shape independently. Instrument
zero ordinal/frame reads. Advance a child's coverage legally after freezing,
then tamper only its transition at the frozen base.

- [ ] **Step 2: Run the deterministic RED quick-integrity gate**

Follow the global compile/scaffold protocol, then run:

```powershell
npm run test:build
if ($LASTEXITCODE -ne 0) { throw "Task 12I consumes established seams and must compile before behavioral RED" }
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(bounded quick integrity rejects aggregate transition and checkpoint tampering without ordinal reads|bounded quick integrity resolves frozen version 2 checkpoints at the recorded event-time baseline|bounded quick integrity rejects one-byte prospective capacity overflow|bounded quick integrity checks status once per distinct current profile)$" dist-test/tests/qualified-checkpoint-quick-integrity.test.js
```

Expected: aggregate/transition linkage, recorded-base resolution, capacity
recomputation, or distinct-profile status checks are absent.

- [ ] **Step 3: Implement bounded structural and event-time checks**

Validate adapter/interval/byte counts, the storage `-1` sentinel, fixed
profiles, aggregate equality with indexed latest transition/event metadata,
checkpoint body/index/domain, and frozen bindings resolved by stored global
positions. Recompute both pure capacity estimates from current quick-healthy
coverage plus policy-derived prospective ending scope. For each frozen V2
child/ticket checkpoint use
`SessionAuthorityRepository.requireCheckpointAtEventPosition` and
`EvidenceCoverageRepository.snapshotFromTransitionsV2(connection,
childSessionId, checkpointBaseEventPosition)`; compare with the immutable
transition projection at that base, never current aggregate. A referenced V1
checkpoint requires an event-time clean scope. Async quick calls status once
per distinct current profile. Do not recompute HMAC, scan ordinals, decode
frames, or compare frozen groups with current mutable folds/latest indexes.

- [ ] **Step 4: Run the GREEN quick-integrity gate**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/event-integrity.test.js dist-test/tests/evidence-coverage.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/qualified-checkpoint-migration.test.js
npm run typecheck
```

- [ ] **Step 5: Commit Task 12I and run both per-task reviews**

```powershell
git add src/orchestrator/integrity/lifecycle-integrity.service.ts tests/qualified-checkpoint-quick-integrity.test.ts tests/event-integrity.test.ts tests/evidence-coverage.test.ts tests/checkpoint.service.test.ts tests/qualified-checkpoint-migration.test.ts
git commit -m "feat: verify bounded qualified checkpoint integrity"
```

---

### Task 12J: Prove Linear Authenticated Historical Replay

**Files:**
- Create: `tests/qualified-checkpoint-full-integrity.test.ts`
- Modify: `src/orchestrator/integrity/lifecycle-integrity.service.ts`
- Modify: `src/orchestrator/integrity/event-integrity.service.ts`
- Modify: `tests/support/lifecycle-authority-reference.ts`
- Modify: `tests/event-integrity.test.ts`
- Modify: `tests/evidence-coverage.test.ts`
- Modify: `tests/checkpoint.service.test.ts`
- Modify: `tests/qualified-checkpoint-migration.test.ts`

**Interfaces:**
- Consumes: Task 12G async orchestration, Task 12H brokered status/fingerprint port, and Task 12I structural checks.
- Produces: One advancing authenticated full replay, exact typed provider/mismatch failures, complexity evidence, and no repair behavior.

- [ ] **Step 1: Write failing replay, complexity, and failure-mapping tests**

Use the exact anchor titles `full integrity advances each qualified coverage row
exactly once`, `full integrity fingerprints each non-zero transition exactly
once`, `full integrity reconstructs version 2 checkpoints and frozen snapshots
at their historical bases`, and `full integrity reports unavailable historical
keys and never repairs state`. Cover first/mixed/gap-fill/zero-new histories,
overlap, all global bounds, accumulator/transition/ordinal/event tampering, V1
after prior coverage, migration-backfill equivalence, and later legal evolution.
Also replay Version 2 request/amendment window actions, generation increments,
final-freeze, unchanged-preserve, cancel-clear, cancelled-row reopen, frozen
groups, and validation/pass/completion freshness witnesses. Reconstruct every
historical ending baseline from checkpoint summaries, event-time child folds,
transfer events/tickets, and directly bound child checkpoint positions; prove
later legal work/coverage does not corrupt that baseline.
Instrument visits and provider calls: status once per distinct recorded profile,
fingerprint once per non-zero-new transition, none for zero-new, no prefix
rescan/quadratic work.

- [ ] **Step 2: Run the deterministic RED full-integrity gate**

Follow the global compile/scaffold protocol, then run:

```powershell
npm run test:build
if ($LASTEXITCODE -ne 0) { throw "Task 12J consumes established seams and must compile before behavioral RED" }
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern="^(full integrity advances each qualified coverage row exactly once|full integrity fingerprints each non-zero transition exactly once|full integrity reconstructs version 2 checkpoints and frozen snapshots at their historical bases|full integrity reports unavailable historical keys and never repairs state)$" dist-test/tests/qualified-checkpoint-full-integrity.test.js
```

Expected: no advancing authenticated replay exists, visit/provider counts are
not linear, snapshots use mutable state, or failures/repair behavior are wrong.

- [ ] **Step 3: Implement one advancing replay and exact failures**

Walk ordered lifecycle/evidence events, compact transitions, ordinal rows,
checkpoints, workflow generations/window/freeze transitions, validation and
completion witnesses, ending bindings, child folds, and tickets once. Maintain bounded maps/cursors, determine
genuinely new frames per event, reproduce each accumulator after historical key
status, advance intervals with bigint adjacency, reconstruct each V2 snapshot
at its base, and compare the complete immutable tuple using writer domains
exactly. Reproduce every `open`/`seal`/`unchanged`, final-freeze,
cancel-clear, and cancelled-row reopen state transition, and prove each
validation/pass/completion witness against its historical frozen group without
comparing it to later mutable state. Reconstruct canonical ending-scope binding
JSON from the same historical child/ticket/checkpoint sources used by migration
preflight. The measured complexity is
`O(lifecycleEvents + eventFrameEntries + immutableOrdinalRows + transitions + checkpoints + endingScopeBindings + transferTickets)`.
Return `EVIDENCE_HISTORICAL_KEY_UNAVAILABLE` for unavailable key
material, `SESSION_EVIDENCE_COVERAGE_MISMATCH` for authenticated mismatch, and
`INTEGRITY_FAILURE` at the existing corruption boundary. Never rewrite state.

- [ ] **Step 4: Run the GREEN full-integrity and Task-12 exit gates**

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/qualified-checkpoint-contracts.test.js dist-test/tests/qualified-checkpoint-migration.test.js dist-test/tests/evidence-coverage.test.js dist-test/tests/checkpoint.service.test.js dist-test/tests/lifecycle-command-store.test.js dist-test/tests/lifecycle-command-processor.test.js dist-test/tests/child-workflow.test.js dist-test/tests/integrity-provider-broker.test.js dist-test/tests/qualified-checkpoint-quick-integrity.test.js dist-test/tests/qualified-checkpoint-full-integrity.test.js dist-test/tests/event-integrity.test.js dist-test/tests/project-store-executor.test.js
npm run typecheck
npm test
git diff --check
```

Expected: focused/full gates pass; quick work is bounded, full work is linear,
provider operations cross only the strict broker, sync coverage checks fail
closed, provider/key material never crosses, and production registration stays
disabled.

- [ ] **Step 5: Commit Task 12J and run both per-task reviews**

```powershell
git add src/orchestrator/integrity/lifecycle-integrity.service.ts src/orchestrator/integrity/event-integrity.service.ts tests/support/lifecycle-authority-reference.ts tests/qualified-checkpoint-full-integrity.test.ts tests/event-integrity.test.ts tests/evidence-coverage.test.ts tests/checkpoint.service.test.ts tests/qualified-checkpoint-migration.test.ts
git commit -m "feat: replay qualified checkpoint integrity"
```

- [ ] **Step 6: Run Task 12 specification and quality reviews**

Invoke `superpowers:requesting-code-review` twice on the complete Task 12 range:
first for approved-spec compliance, then for implementation quality/security.
Resolve every Critical/Important finding with focused RED/GREEN proof, rerun the
Task-12 exit gate, and do not start Task 13 until both reviewers approve the
same final commit.

---

## Required Downstream Amendments

The following requirements augment and override the named tasks in the parent plan. They are not optional Task 12 cleanup.

### Task 13 Worker and Executor

- [ ] Round-trip `RootSuspendCommandV2 | V3`, `RecordCheckpointCommandV2 | V3`, `RequestSessionEndCommandV2 | V3`, and `AmendSessionEndCommandV2 | V3` under the same operation names by nested discriminator.
- [ ] Decode `CheckpointRecordedResultV1 | V2`, versioned end results, and `SessionEndEvidenceWindowStatusV2`; reject mixed tags and unsupported outer/nested versions.
- [ ] Bind nested versions into candidate/authoritative intent, worker result tags, and deterministic internal work identity; old exact replay precedes current gates and cross-version identity reuse conflicts.
- [ ] Prove schema 3/codecs alone never inject a runtime or enable production routing.

### Task 14 Session-End Freeze and Evidence Window

- [ ] Accept V2/V3 end commands and versioned internal final-checkpoint actions/results.
- [ ] Require whole ending-scope coverage-clean state for Version 1 request/amend/finalization, including current children and retained tickets.
- [ ] Persist the exact canonical current-child plus carry-forward binding set, final checkpoint event position, and generation atomically with `final-checkpoint-recorded`.
- [ ] Implement `open`, `seal`, and `unchanged` exactly: generation fencing, strict effective V2 draft while open, claim/recovery exclusion at open `children-resolved`, pre-seal V2 checkpoint, frozen-group clear/preserve/replace, cancel sealed/null, and abandoned group only when a final exists.
- [ ] Cover root/descendant evidence race orders, multiple open-window batches, descendant fresh checkpoint retry, and stale workflow/validation/outbox work after both open and seal.

### Task 15 Current-State Freshness

- [ ] Invoke the same bounded `assertFinalCheckpointCoverageFresh` before validation start, before verification pass, and inside the terminal `SessionEnded` transaction.
- [ ] Compare root latest checkpoint ID/event/body/index, null checkpoint-required marker, root coverage, exact ending bindings, child folds/latest checkpoints, tickets/events, direct historical checkpoint positions, child coverage, and distinct historical-key status.
- [ ] Return `EVIDENCE_HISTORICAL_KEY_UNAVAILABLE` or `SESSION_END_COVERAGE_CHANGED` with zero phase/event/outbox/attempt/failure effect; source-state freshness remains separate.
- [ ] Prove manual root checkpoint, ownership recovery marker, later marker-clearing checkpoint, zero-new batch movement, child index movement, carry-forward coverage, and evidence before/after final at all three gates.

### Task 16 Materialization

- [ ] Strict-decode and render both checkpoint versions with independent golden bytes.
- [ ] Preserve the sorted qualified adapter summary for V2 while omitting frames, ordinal rows/fingerprints, `observedAt`, provider/key material, and raw evidence.
- [ ] Treat open/seal amendments as newer revisions; stale old-generation materialize/ack work has zero effect and exact committed replay remains idempotent.

### Task 17 Disabled Compatibility

- [ ] Prove the disabled adapter does not decode, downgrade, or synthesize V2 checkpoints/requests/results even on schema 3.
- [ ] Keep exact V1 identity pass-through; shadow output remains redacted, diagnostic, and `executable: false`.
- [ ] Prove migration 0003, codecs, and worker seams register no production lifecycle tool and invoke no lifecycle executor/provider/store factory.

### Task 18 Process, Crash, Provider, and Boundaries

- [ ] Add provider-broker current/status/fingerprint failure, rotation, and unavailable historical-profile cases without transferring key bytes.
- [ ] Add cross-process two-adapter ordinal independence, root/descendant final races, open/seal fencing, three freshness-gate races, and exact old evidence replay before current gates.
- [ ] Add crashes after evidence append and at transition/aggregate/ordinal boundaries; restart observes all-or-none state.
- [ ] Exercise accumulator provider-call counts/buffer cleanup, adapter/interval 200/201, exact coverage/checkpoint/binding byte limits, symmetric evidence/fork/transfer/end capacity, and bounded snapshot query counts.
- [ ] Extend every stress seed with multiple adapters, key rotation, V2 child/root checkpoints, open → evidence batches → seal → replacement final.

### Task 19 CI and Isolation

- [ ] Require migration history `[1, 2, 3]`, database schema 3, manifest version 1, exact migration-0002 hash, explicit schema-2-to-3 preflight/backfill, and old-reader `SCHEMA_TOO_NEW`.
- [ ] Include contract, migration/upgrade, evidence, checkpoint, integrity, worker, end, validation, recovery, rendering, compatibility, process, crash, and security suites in the Subproject 2 gate.
- [ ] Prove a schema-3 production worker still returns `LIFECYCLE_V2_DISABLED` with zero lifecycle event/dedup/workflow effect and that protected Version 1 production files remain unchanged from the immutable base.

## Task 12 Completion Gate

Task 12 is complete only when Tasks 12A-12J are separately committed and reviewed, all focused/full commands above pass from the same final commit, migration 0002 retains its frozen hash, the worktree is clean, and the parent plan is updated to point at this companion plan. Continue directly with Task 13 only after that gate.
