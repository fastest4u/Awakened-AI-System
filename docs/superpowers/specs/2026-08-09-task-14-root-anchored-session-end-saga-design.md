# Task 14: Root-Anchored Session-End Saga and Durable Effective State

Date: 2026-08-09

Status: Conversational design approved; written-spec review required before
implementation planning

Parent specification:
`docs/superpowers/specs/2026-07-14-root-child-lifecycle-and-checkpoints-design.md`

Parent implementation plan:
`docs/superpowers/plans/2026-07-14-root-child-lifecycle-and-checkpoints.md`

Architecture decision: Approach A — root-request-anchored per-child saga,
event-carried effective-state snapshots, and an earlier queue-planning slice

Production cutover: Forbidden. This design does not authorize Version 2 as the
production MCP lifecycle authority.

## 1. Decision summary

Task 14 will implement session end without adding a multi-stream semantic
writer. A root `SessionEndRequested` event and generation-fenced workflow row
commit first. While that workflow remains in `requested`, the coordinator
rescans durable state and executes at most one deterministic child-targeted
internal semantic command per drive. Each child command mutates only that
child's session stream and atomically persists its authority update, immutable
transfer ticket, and semantic dedup record. An eventless fenced compare-and-swap
advances the workflow to `children-resolved` only after a new durable rescan
proves that no eligible child remains.

Every new request and amendment event carries a complete, bounded snapshot of
the current generation's effective request, server-effective quality policy,
and effective final checkpoint draft. The event is semantic source truth;
`workflow_instances` and `lifecycle_workflow_generation_folds` remain
rebuildable indexes.

Task 14 also gains a prerequisite queue-planning slice, called Task 14Q in this
specification. Task 14Q owns deterministic compatibility-log rendering, path
derivation, keyed fingerprint planning, immutable outbox insertion, and strict
planned-row reads. Task 16 continues to own outbox claiming, file replacement,
fsync, acknowledgement, failure handling, and crash recovery.

The product-visible consequence of this design is intentional: cancellation
restores only the root. Child transfers that committed before cancellation and
their immutable tickets remain durable historical work. No cross-stream
compensation is attempted.

## 2. Controlling invariants

The following invariants are mandatory:

1. Migrations 0002 and 0003 remain byte-for-byte frozen.
2. Events, not workflow rows, projection folds, or outbox rows, are semantic
   source truth.
3. One semantic mutation uses one synchronous `BEGIN IMMEDIATE` transaction.
4. Every event stays on its aggregate's canonical `session/{sessionId}` stream.
5. A command may append to only one stream through the existing event append
   transaction.
6. Child work never appears on the root stream.
7. Workflow and claim fencing is generation-, owner-, token-, and expiry-bound.
8. Exact semantic replay is evaluated before current-state authorization so a
   lost response can be recovered after generation or claim rotation.
9. A fresh internal semantic mutation must verify the current claim and current
   root/child state inside its transaction.
10. No coordinator holds SQLite open across asynchronous work.
11. No Task 14 component opens a second project-store connection.
12. Version 1 remains the production lifecycle authority until the later
    explicit cutover project.

The current frozen migration hashes are acceptance fixtures:

- migration 0002 SHA-256:
  `68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06`
- migration 0003 SHA-256:
  `C023A8EDB88A94B749D4837F7300A76D081C843BF41BE058C3AA4AD5D6A158C4`

## 3. Scope and non-goals

### 3.1 In scope

- Migration 0004 and schema version 4.
- Event schema Version 2 for Task 14 internal `ChildWorkTransferCreated`, plus
  Version 3 for new session-end request, amendment, and cancellation events.
- Bounded effective-state snapshots and one-event current-generation hydration.
- Deterministic UUIDv5 workflow and automatic transfer-ticket identities.
- Effective policy calculation and strict persisted codecs.
- Root request, amendment, cancellation, cancelled-row reopening, and workflow
  status persistence.
- One-child-at-a-time carry-forward under a root-request-anchored saga.
- Exact evidence-window `open`, `seal`, and `unchanged` behavior.
- Final checkpoint freezing and deterministic materialization queue planning.
- Strict planned-row verification before the queue-confirmed phase.
- Runtime/factory bindings for the Task 13 reserved session-end operations.
- Quick/full integrity and upgrade/bootstrap/build-artifact coverage.

### 3.2 Out of scope

- A general multi-stream append transaction.
- Cross-stream rollback or compensation of committed child transfers.
- Mutable semantic side tables for request/policy/draft bytes.
- External validation process execution, which remains Task 15.
- Outbox claiming, file writes, atomic replacement, fsync, acknowledgement, and
  materializer failure recovery, which remain Task 16.
- Production MCP cutover or changes to the Version 1 lifecycle implementation.
- Unrelated schema, authority, or retrieval refactoring.

## 4. Deterministic identities

### 4.1 Workflow identity

`WorkflowId` is a canonical lowercase UUID. The literal text
`session-end/{sessionId}` must never be stored as a workflow ID.

Task 14 introduces:

```ts
export const SESSION_END_WORKFLOW_NAMESPACE =
  "4af569cd-c120-5fc1-874a-d4640afc5977";

export function sessionEndWorkflowId(sessionId: SessionId): WorkflowId;
```

The namespace is the UUIDv5 value derived under the RFC URL namespace from
`https://awakened-ai.system/memory-event-core/workflows`. The workflow name is
the UTF-8 text `session-end/{lowercaseSessionId}`.

Golden vector:

```text
sessionId:  44444444-4444-4444-8444-444444444444
workflowId: b6c2d359-82a6-567e-86c7-bf9e780cf20b
```

The UUIDv5 implementation is local, deterministic, and tested with RFC and
project vectors. SHA-1 is used only as required by UUIDv5 name derivation, not
as a security primitive.

### 4.2 Internal phase command identity

Coordinator-origin semantic actions retain the already-approved namespace:

```text
a7b47792-6ad9-5b32-9f20-6f53f5dc2f31
```

For a canonical action tuple:

```text
(projectId, workflowId, generation, sourcePhase, action)
```

derive:

```text
commandId      = UUIDv5(phase namespace, canonical action bytes)
idempotencyKey = lifecycle-phase-v1/{sha256(canonical action bytes)}
plannedWorkId  = sha256(
  "pm-lifecycle-phase-planned-work-v1\n" ||
  canonical action bytes || commandId || idempotencyKey
)
```

Claim owner/token/expiry are excluded from stable identity. A takeover must
reproduce the same semantic command while proving its new live claim on a
dedup miss.

### 4.3 Automatic transfer-ticket identity

Automatic session-end tickets use a distinct fixed namespace:

```text
89378abd-6226-5669-ad6d-f24d4297935e
```

It is derived under the RFC URL namespace from
`https://awakened-ai.system/memory-event-core/session-end-transfer-tickets`.
The ticket name is the canonical JSON tuple:

```text
(projectId, workflowId, generation, childSessionId)
```

The ticket UUID is derived only after every capacity and stale-state check has
passed. Golden vectors pin the namespace, canonical tuple encoding, version
bits, and lowercase output.

The lifetime-history bound used by every root/child/ticket repository is:

```ts
export const MAX_ROOT_CHILD_HISTORY_V1 = 1_000;
```

It is a count of immutable history, not current ending scope. For one
`(projectId, rootSessionId)`, both the total number of direct child authority
rows and the total number of transfer tickets whose `source_parent_session_id`
is that root are independently capped at 1,000. Terminal children and claimed
tickets continue to count forever. This bound makes the later all-history proof
finite without deleting or paging over semantic history.

## 5. Event-carried effective state

### 5.1 Effective-state codec

Every new `SessionEndRequested` and `SessionEndAmended` event contains:

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
  readonly effectiveStateDomain:
    "project-memory/session-end-effective-state/v1";
  readonly request: SessionEndRequestV1 | SessionEndRequestV2;
  readonly effectivePolicy: PersistedQualityPolicyInputV1;
  readonly effectiveFinalCheckpoint: CheckpointDraftV1 | CheckpointDraftV2;
  readonly effectiveStateHash: string;
}
```

`totalEffectiveWeight` is derived by `decodeQualityPolicyV1` and is never an
input key. The decoder rejects unknown, inherited, accessor, duplicate,
noncanonical, or out-of-range data under the existing strict codec rules.

The effective-policy resolver retains the parent contract: required trusted
profiles cannot be omitted or reweighted; caller profiles must be allowlisted;
profile tuples are unique and canonically ordered; total weight is positive and
checked with bigint arithmetic; the effective threshold is the stronger trusted
or requested threshold; and the two effective booleans are the trusted/caller
logical OR. A caller cannot weaken a trusted default.

`request` is the complete request after folding the current amendment. It
includes its final checkpoint. `effectiveFinalCheckpoint` deliberately repeats
that draft as an explicit current-draft carrier. Their canonical bytes must be
identical. The duplication removes ambiguity between caller intent folding and
the finalization input while remaining below the bounded payload ceiling.

The effective request and draft versions must agree. A Version 1 amendment with
a null draft may preserve an already-effective Version 2 request/draft, in
which case the snapshot remains Version 2 while the immutable lifecycle intent
continues to record the Version 1 amendment command.

### 5.2 Hash and size rules

The hash preimage is:

```text
"project-memory/session-end-effective-state/v1\n" ||
canonicalJson({
  effectiveStateVersion,
  effectiveStateDomain,
  request,
  effectivePolicy,
  effectiveFinalCheckpoint
})
```

`effectiveStateHash` is the lowercase SHA-256 hex digest of those bytes.

The complete canonical `effectiveState`, including its hash, has a
defense-in-depth cap of exactly 1,048,576 UTF-8 bytes. The shared raw
canonical-size guard is tested independently at exactly 1,048,576 bytes and at
1,048,577 bytes. Those raw boundary probes are not claimed to be valid
effective states. Separately, genuinely decodable effective-state fixtures
prove the strict codec under every authoritative subordinate limit. Existing
subordinate limits remain authoritative:

- checkpoint draft: 262,144 canonical UTF-8 bytes;
- effective profiles: 1 through 64;
- final ending-scope bindings: 262,144 canonical UTF-8 bytes;
- lifecycle intent witness: 1,048,576 canonical UTF-8 bytes; and
- whole lifecycle command/wire snapshot: 4,194,304 canonical UTF-8 bytes.

Tests must cover exact-cap and cap-plus-one values using multibyte UTF-8, not
JavaScript character count.

### 5.3 Version 3 event payloads

Every newly written request, amendment, or cancellation event uses
`eventSchemaVersion: 3`, regardless of whether the caller command carries a
Version 1 or Version 2 request body.

```ts
export interface SessionEndRequestedPayloadV3 {
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly previousState: "active" | "suspended";
  readonly effectiveState: SessionEndEffectiveStateV1;
}

export interface SessionEndAmendedPayloadV3 {
  readonly workflowId: WorkflowId;
  readonly previousWorkflowGeneration: number;
  readonly workflowGeneration: number;
  readonly preTransitionCheckpointId: CheckpointId;
  readonly evidenceWindowAction: "unchanged" | "open" | "seal";
  readonly effectiveState: SessionEndEffectiveStateV1;
}

export interface SessionEndCancelledPayloadV3 {
  readonly cancellationVersion: 1;
  readonly workflowId: WorkflowId;
  readonly previousWorkflowGeneration: number;
  readonly workflowGeneration: number;
  readonly restoredState: "active" | "suspended";
  readonly preTransitionCheckpointId: CheckpointId;
}
```

The event decoder retains the historical request/amendment Version 1 and
Version 2 variants and the historical cancellation Version 1 variant
unchanged. New cancellation writes are Version 3 so strict G+1 semantics are
distinguishable from legacy same-generation history. The decoder does not
silently generalize a historical migration preflight to accept later outer
versions.

The public unknown-input decoder returns the truthful complete codec union:
Version 1, Version 2, or Version 3. Consumers whose owning task has not yet
implemented Version 3 semantics must call the separate explicit Version
1/Version 2-only decoder, which rejects every outer Version 3 event before it
crosses that boundary. Task 14M.4 replaces this temporary boundary in workflow
projection folds and their repository; Task 14M.5 replaces it in lifecycle
integrity; Tasks 14R.2 and 14R.3 replace it in session-authority replay before
the Version 3 producers land. Task 14S.2 remains responsible for the Version 2
transfer projection, authority, and integrity lineage semantics. No overload
may claim an unknown input returns only a historical subset while accepting a
newer version at runtime.

### 5.4 Intent and context correlation

The service and integrity paths independently prove:

- event outer project/vault/store/workspace/session/branch context equals the
  stored event and active project context;
- event command/idempotency/agent/presenting identity equals event zero's
  lifecycle intent witness;
- request snapshots equal the request command;
- amendment snapshots equal the deterministic fold of the predecessor snapshot
  and amendment command;
- event workflow/generation equals the root aggregate and workflow row;
- snapshot request session equals event/root session;
- snapshot hash equals independently recomputed canonical bytes.

The semantic write service additionally proves that the effective policy is
the trusted resolver's current result before append. That is a write-time
authorization fact, not a claim that later integrity can reconstruct historical
external configuration from the snapshot alone. After commit, the durable
effective-policy output is semantic source truth; quick/full integrity proves
its strict canonical form, hash, request/context correlation, and immutable
profile tuple validity. Task 15's configuration-drift checks use the separate
immutable version-addressed validation registry described below.

Strict decoding alone is not accepted as proof of storage provenance.

## 6. Migration 0004 and compatibility

### 6.1 Registry and name

Create:

```text
src/orchestrator/storage/migrations/0004-session-end-effective-state.ts
```

with:

```text
version: 4
name: session-end-effective-state
```

The migration registry becomes exactly `[1, 2, 3, 4]`, and
`CURRENT_PROJECT_STORE_SCHEMA_VERSION` becomes `4`.

Migration 0004 may drop and recreate guards introduced by migration 0003, but
must not edit migration 0002 or 0003. Tests pin both frozen source hashes.

### 6.2 Event and workflow guards

Migration 0004 replaces the current request/amend/cancel/transfer event-version
guard so:

- historical rows keep Version 1/2 rules;
- new request/amend/cancel rows use Version 3 with exact outer and nested key
  sets;
- canonical JSON, UUIDs, generation arithmetic, snapshot versions, size cap,
  lowercase hash, request/draft agreement, and event-intent provenance are
  enforced;
- historical `ChildWorkTransferCreated` Version 1 retains its frozen rule that
  the transfer checkpoint equals the suspension checkpoint;
- only Task 14's internal `carry-forward-child` route may append
  `ChildWorkTransferCreated` Version 2 with the exact dual-checkpoint contract
  in Section 9.2; existing public transfer routes remain Version 1; and
- no other lifecycle event gains an unapproved Version 3 variant.

Migration 0004 also overlays lifecycle-outbox insert guards. A row with
`kind = 'materialize-lifecycle-log'` must have the exact Version 1 payload keys,
matching outer/payload target, session, artifact kind/path, revision/event
position, trigger type, origin columns, and fingerprint metadata. Conversely, a
generic row cannot use that kind. SQL enforces canonical JSON and relational
cross-bindings; repository and quick/full integrity independently recompute the
cryptographic payload/content hash and predecessor chain. Frozen migration-0002
outbox guards remain unchanged.

Those outbox overlays also require the referenced
`events.command_event_index = 0` and enforce the closed origin/trigger matrix:
`terminal-event` is legal only for direct
`SessionAbandoned`; the other six trigger types and workflow-ending
`SessionAbandoned` require non-null workflow origin and generation. Migration
0004 additionally creates the lifetime child/ticket count triggers and unique
source-child ticket index described in Section 9.4. Preflight proves legacy rows
already meet every new invariant before these overlays are installed.

Workflow guards are revised so a reopened cancelled Version 2 request is
`requested/open/null`, not the migration-0003 legacy `requested/sealed/null`
shape. Version 1 request/reopen remains `requested/sealed/null`.

Every new Version 3 cancellation must use exactly current generation plus one.
Initial request G1, cancellation G2, and reopened request G3 are the canonical
sequence. The root aggregate, projection fold, workflow row, SQL guards, quick
integrity, and full integrity dispatch on the cancellation event version:

- historical Version 1 replay retains the frozen compatibility rule that
  accepts either the predecessor generation or predecessor plus one;
- the schema-4 command/write boundary forbids new Version 1 cancellations; and
- Version 3 requires `previousWorkflowGeneration` to equal the predecessor and
  `workflowGeneration` to equal predecessor plus one.

Legacy bytes and hashes are never rewritten merely to obtain the new rule.

### 6.3 Workflow generation folds

`lifecycle_workflow_generation_folds` remains an immutable projection. Migration
0004 adds:

```text
fingerprint_schema_version INTEGER NOT NULL DEFAULT 1
effective_state_source_event_position INTEGER NULL
effective_state_version INTEGER NULL
effective_state_hash TEXT NULL
```

Legacy fold rows remain fingerprint schema Version 1 with the three
effective-state columns null. New Version 3 request/amend/cancel rows use
fingerprint schema Version 2. Request and amendment point the effective-state
source at their trigger event. Cancellation retains the predecessor's
effective-state source/version/hash when one exists; a cancellation immediately
after legacy history retains nulls. The Version 2 fingerprint domain and exact
ordered canonical preimage are:

```text
domain = "project-memory/lifecycle/workflow-generation/v2\n"

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

`triggerEventHash` is the immutable `events.event_hash` after lifecycle-intent
binding. The initial Version 2 row uses null/null for the previous-version and
previous-fingerprint pair. A Version 2 row after a legacy predecessor binds
`1` and that predecessor's Version 1 fingerprint; a Version 2 successor binds
`2` and the predecessor's Version 2 fingerprint. The Version 1 domain,
preimage, and function remain byte-for-byte unchanged. Recalculation obtains
the trigger hash and predecessor version through their exact immutable rows;
no untrusted caller supplies either value.

The fold is rebuildable. Deleting it must not delete semantic bytes, and an
event plus its history must be sufficient to reconstruct it.

### 6.4 Migration-4 preflight

Task 14 creates
`src/orchestrator/storage/session-end-effective-state-migration-preflight.ts`
with the exact read-only interface:

```ts
export interface SessionEndEffectiveStateMigrationPreflight {
  assertEligible(connection: SqliteConnection, context: ProjectContext): void;
}
```

`ProjectStoreUpgradeService` calls `assertEligible` from its existing
`beforeMigration` hook only when `migration.version === 4`. The call occurs
inside `MigrationRunner`'s one `BEGIN IMMEDIATE`, after the applicable lease
renewal and before migration-0004 SQL. It creates no staging table and performs
no write. It explicitly gates the incoming outer schema before selecting
version-specific decoders and rejects every schema-3 nonterminal session-end
workflow because its historical server-effective policy cannot be reconstructed
truthfully.

The preflight also validates every existing non-null persisted validation-plan
array, including terminal history, against the complete schema-4 overlay:
canonical six-key entries, 1-through-64 cardinality, the 262,144-byte canonical
UTF-8 cap, binary profile ordering, and uniqueness of the profile tuple,
`runId`, `resultId`, `commandId`, and `idempotencyKey`. It rejects rather than
grandfathers a legacy plan that migration 0002 accepted but schema 4 would not.
It likewise rejects a root with more than `MAX_ROOT_CHILD_HISTORY_V1` direct
children or source tickets, duplicate tickets for one source child, or a
transferred source child/ticket relation that cannot pass the schema-4 lineage
proof. These are read-only eligibility checks before any migration SQL.

The stable failure code is
`MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED`.
`sessionEndEffectiveStateMigrationFailure` normalizes only the preflight's
known `SchemaCompatibilityError`/SQLite-abort surface in the migration-runner
catch, after rollback, just as the qualified-checkpoint preflight has its own
normalizer. Any preflight, SQL, migration-row, project-version, lease-renewal,
or fault-injection failure rolls back every pending migration in that apply
call, leaving the database byte-for-byte unchanged.

Compatible terminal `cancelled`, `completed`, and `abandoned` history may
remain. Compatibility includes the complete validation-plan and lifetime
history preflight above. A legacy cancelled row is reopenable only when its
workflow ID is the canonical UUIDv5 identity for its session and its terminal
lineage passes strict integrity. Otherwise upgrade or reopening fails closed;
no ID or immutable event is rewritten.

No migration fabricates a policy, snapshot, hash, event, validation result, or
materialization row. Backfill is structural projection metadata only.

### 6.5 Required migration gates

Tests prove:

- clean bootstrap applies `[1, 2, 3, 4]` exactly once;
- schema-1, schema-2, and schema-3 explicit upgrades apply every pending
  registered migration in order;
- build-artifact smoke expects the complete registry;
- a strict-valid disallowed outer event version is rejected by preflight;
- a nonterminal legacy workflow rejects with zero writes;
- compatible terminal history upgrades without rewriting event bytes/hashes;
- legacy terminal plans that are unsorted, duplicate any schema-4 identity, or
  exceed the schema-4 byte cap fail preflight with zero writes;
- exactly 1,000 historical direct children/source tickets upgrade, while 1,001
  fail preflight with zero writes;
- exact and over-cap snapshots are handled by UTF-8 byte count;
- migration-4 preflight failure from schema 1/2/3 rolls back all earlier pending
  migrations in that apply call;
- all three generic migration fault boundaries execute for migration 4 and
  preserve the original failure after rollback;
- migration 4 creates no preflight staging table and is not passed through the
  migration-3 sealed-stage assertion;
- historical transfer Version 1 keeps same-checkpoint folding, while internal
  Version 2 accepts only an exact suspension/latest-checkpoint pair and hostile
  public or malformed Version 2 inserts fail with zero effect;
- hostile raw SQL cannot bypass snapshot, generation, validation-plan, or fold
  guards; and
- quick/full integrity detect event/snapshot/fold/workflow pointer disagreement.

## 7. Validation-attempt plan persistence

Migration 0002 accepts exactly six persisted keys. Task 14 does not replace
that frozen shape with the 18-key public API object.

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

The canonical array:

- has one entry per effective policy profile;
- contains 1 through 64 entries;
- is sorted by `(profileId, profileVersion)`;
- has unique profile, run, result, command, and idempotency identities;
- is capped at 262,144 canonical UTF-8 bytes; and
- is written at most once per workflow generation.

Migration 0004 adds workflow insert/update overlay guards without changing
migration 0002. In addition to the frozen six-key/type/canonical/1-through-64
rules, the overlay enforces the 262,144 UTF-8 byte cap using BLOB byte length,
binary `(profileId, profileVersion)` ordering, and uniqueness of `runId`,
`resultId`, `commandId`, and `idempotencyKey`. The existing unique profile tuple
rule remains authoritative. The strict repository decoder and quick/full
integrity independently enforce the same invariants. Hostile raw-SQL tests
exercise every added invariant rather than treating strict service decoding as
storage provenance.

Task 14 owns the strict repository codec and storage seam. Task 15 owns the
trusted validation registry and deterministic expansion to
`ValidationAttemptPlanIdentityV1`. Expansion combines the six stored keys with
immutable project/workflow/snapshot/final-checkpoint state and the current
trusted profile configuration hash. It re-derives every deterministic ID.
Configuration drift or any stored-ID mismatch fails closed before validation.

Registry entries are immutable and addressed by `(profileId, profileVersion)`.
Publishing different configuration bytes under an existing tuple is an
integrity/configuration failure, not an in-place update. This makes the
configuration hash derivable at first plan creation and prevents silent drift
between the request snapshot and validation planning.

Task 14 ends at a durably confirmed `ending-materialization-queued` phase. Task
15 owns plan construction/persistence and the transition into `validating`.

## 8. Request transaction

### 8.1 Preconditions

A new request requires:

- attached trusted primary root authority and current proof;
- root state `active` or `suspended`;
- exact project/vault/store/workspace/branch/session binding;
- current required pre-end checkpoint and source-state checks;
- strict request and effective-policy decoding;
- deterministic workflow identity; and
- prospective checkpoint/scope capacity checks.

Every request also proves the lifetime bounds. For
`suspend-and-carry-forward`, the current source-ticket count plus all eligible
direct children that do not already have their one ticket must be at most
`MAX_ROOT_CHILD_HISTORY_V1`. Claimed and terminal history is included in the
base count. Capacity rejection happens before workflow/event identity or any
mutation.

`require-completed` rejects with `SESSION_CHILDREN_ACTIVE` and zero effect when
any direct child is `active`, `completion-proposed`, or `suspended`.

`suspend-and-carry-forward` does not mutate children in the request transaction.
Before committing the anchor, it nevertheless runs conservative capacity checks
against the exact prospective current-child and ticket set so an obviously
unfinishable saga does not start.

For a Version 1 request, the root, every relevant current child, and every
retained ticket source child must pass whole-scope Version 1 coverage
eligibility.

### 8.2 Atomic effect

One root semantic transaction:

1. revalidates authority, root, checkpoint, source state, policy, and capacity;
2. appends one Version 3 `SessionEndRequested` event to the root stream;
3. moves the root to `ending` and stores prior root state;
4. creates generation 1 or reopens the deterministic cancelled row at its
   current generation plus one;
5. points `triggering_event_position` at the request event;
6. stores the exact status/evidence-window shape;
7. clears stale claim/failure/validation/frozen/final fields on reopen;
8. renews root authority as specified by the lifecycle contract;
9. writes projection and semantic dedup; and
10. commits before returning.

The initial and reopened request does not create a materialization outbox row.

Evidence-window initialization is:

| Request | Phase | Window | Frozen checkpoint/generation |
|---|---|---|---|
| Version 1 | `requested` | `sealed` | null/null |
| Version 2 | `requested` | `open` | null/null |

## 9. Root-anchored per-child saga

### 9.1 Durable selection

No request-time child worklist or cursor is persisted. Each coordinator drive
queries current direct children and selects at most one eligible child using:

```sql
ORDER BY session_id COLLATE BINARY ASC
LIMIT 1
```

Eligible states are `active`, `completion-proposed`, and `suspended`. Lowercase
fixed-width UUID ordering makes selection deterministic. The selection is a
proposal only; every mutable fact is re-read and revalidated in the semantic
transaction.

Root state `ending` prevents new public child forks. A previously in-flight
child mutation may nevertheless commit after the request because existing
direct-child report, checkpoint, evidence, and allowed state operations do not
all require an `active` root. This is intentional. The saga never trusts its
selection: the carry-forward transaction revalidates the exact child head,
state, authority, governing checkpoint, and suspension provenance. A direct
child write that wins first therefore causes `EVENT_CONFLICT` or a changed
selection and a complete rescan; a new public fork remains blocked.

### 9.2 Internal action

```ts
export interface CarryForwardChildActionV1 {
  readonly action: "carry-forward-child";
  readonly actionVersion: 1;
  readonly rootSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly expectedChildState:
    | "active"
    | "completion-proposed"
    | "suspended";
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

For `active`/`completion-proposed`, `expectedSuspensionEventPosition` is null
and the checkpoint tuple is the current risky-transition checkpoint that the
new suspension will cite. For `suspended`, it is the direct position of the
strict `ChildSessionSuspended` event that established the current suspended
state; the checkpoint tuple is the current governing checkpoint. The governing
checkpoint may be newer than the suspension event because checkpoint, evidence,
assignment, and report events are legal while suspended.

Task 14 makes that distinction event-source-truth with a new exact payload:

```ts
export interface ChildWorkTransferCreatedPayloadV2 {
  readonly transferTicketId: TransferTicketId;
  readonly suspensionCheckpointId: CheckpointId;
  readonly checkpointId: CheckpointId;
  readonly authorityCommitment: string;
}
```

Every Task 14 `carry-forward-child` action writes
`ChildWorkTransferCreated` event schema Version 2. `suspensionCheckpointId`
comes only from the directly re-read `ChildSessionSuspended` witness;
`checkpointId` is the selected `latestCheckpointId` and must match the action's
governing checkpoint tuple. For a newly suspended active/proposed child the two
IDs are equal. For an already-suspended child they may differ when a later legal
checkpoint became authoritative. Version 1 decoding and folding remain
byte-for-byte unchanged.

The Version 2 aggregate fold requires both
`payload.suspensionCheckpointId === state.suspensionCheckpointId` and
`payload.checkpointId === state.latestCheckpointId`. Event/projection codecs,
the authority fold, child-transfer repository/projections, ticket claim,
ending-scope reads, migration-0004 SQL guards, and quick/full integrity all
dispatch on the transfer event schema version. They retain the Version 1
same-checkpoint/adjacent-suspension rules and apply the Version 2
dual-checkpoint/explicit-lineage rules. This is an intentional Task 14 contract
amendment to current source, not an assertion about existing behavior.

The internal contract is split by action instead of pretending that every
`internal-workflow-phase` command returns a root phase result:

```ts
export interface InternalWorkflowPhaseBase extends LifecycleCommandBase {
  readonly commandType: "internal-workflow-phase";
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly sourcePhase: string;
  readonly plannedWorkId: string;
  readonly claim: WorkflowClaimAssertionV1;
}

export interface InternalRootWorkflowPhasePlan
  extends InternalWorkflowPhaseBase {
  readonly plannedAction: PlannedSemanticSessionEndAction;
}

export interface InternalCarryForwardChildPlanV1
  extends InternalWorkflowPhaseBase {
  readonly sourcePhase: "requested";
  readonly plannedAction: CarryForwardChildActionV1;
}

export interface InternalRootWorkflowPhaseCommand
  extends InternalWorkflowPhaseBase {
  readonly action: SemanticSessionEndAction;
}

export interface InternalCarryForwardChildCommandV1
  extends InternalWorkflowPhaseBase {
  readonly sourcePhase: "requested";
  readonly action: CarryForwardChildActionV1;
}

export type InternalWorkflowPhasePlan =
  | InternalRootWorkflowPhasePlan
  | InternalCarryForwardChildPlanV1;

export type InternalWorkflowPhaseCommand =
  | InternalRootWorkflowPhaseCommand
  | InternalCarryForwardChildCommandV1;

export type CarryForwardChildResultV1 = JsonValue & {
  readonly resultVersion: 1;
  readonly action: "carry-forward-child";
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly plannedWorkId: string;
  readonly rootSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly previousChildState:
    | "active"
    | "completion-proposed"
    | "suspended";
  readonly childState: "transferred";
  readonly transferTicketId: TransferTicketId;
  readonly suspensionEventPosition: string;
  readonly transferTicketEventPosition: string;
  readonly finalChildStreamVersion: string;
};
```

`LifecycleInternalResultFor<I>` maps a carry-forward plan to
`CarryForwardChildResultV1`, a root phase plan to `SessionEndPhaseResultV2`, and
an internal validation result to its existing result. The nested contract
version for carry-forward is exactly `1`. The strict worker codec selects the
result decoder from the already-decoded planned-action subtype and correlates
the result's action, workflow, generation, planned-work ID, root, child,
previous state, deterministic ticket ID, and final child stream version to the
request. It also enforces:

- active/proposed: the two new committed event positions are consecutive,
  suspension precedes transfer, and final stream version is expected plus two;
- already suspended: the returned suspension position equals the requested
  historical witness, transfer follows the selected child head, and final
  stream version is expected plus one; and
- all paths: positions are positive canonical decimals and transfer follows
  suspension.

The global suspension position is not asserted as child-head plus one: events
from other streams may already follow that child's head. Only the two events in
the same new append are globally consecutive.

The internal authorization audience is:

```text
authorizationSessionId = rootSessionId
targetSessionId        = childSessionId
```

The action crosses only the existing internal semantic mutation boundary. It
does not expose or repurpose the reserved public `create-child-transfer` route.

### 9.3 Child semantic transaction

On a dedup miss, in this order:

1. verify live workflow generation, phase `requested`, claim owner/token/expiry;
2. verify the root remains `ending` under that workflow/generation;
3. re-read/fold the child and verify state, head, authority, generation, and
   checkpoint tuple; for `suspended`, directly re-read the selected suspension
   witness and prove the child remained suspended through the selected head;
4. compute the prospective final-scope replacement using other current
   children, the validated unclaimed subset of every source-root ticket, and
   this future ticket;
5. recheck that the source root has fewer than
   `MAX_ROOT_CHILD_HISTORY_V1` lifetime tickets and that this source child has
   no ticket;
6. run both existing Task 12 capacity estimators;
7. derive the deterministic ticket identity and planned event positions;
8. append `ChildSessionSuspended` Version 1 then
   `ChildWorkTransferCreated` Version 2 for `active` or
   `completion-proposed`;
9. append only `ChildWorkTransferCreated` Version 2 for an already `suspended`
   child;
10. compare-and-swap child authority to `transferred`;
11. insert the immutable ticket using the committed transfer position;
12. write semantic dedup and commit.

The workflow remains `requested`. The child stream version returned by this
command is the child stream version, never a fabricated root version.

Automatic suspension deterministically copies blocker summaries from the
checkpoint's `blockers` and follow-ups from `nextActions`. No untrusted
free-form transfer payload is added to the root request.

Automatic tickets use this exact new lineage codec:

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

For active/proposed children, the newly appended suspension is exactly the
transfer event's immediate predecessor. For an already-suspended child, the
repository locates the latest strict `ChildSessionSuspended` event on the exact
child stream at or before the selected head using the existing stream/version
index, then the semantic transaction re-reads it by the selected global
position. Non-adjacency is legal: only `SessionCheckpointRecorded`,
`EvidenceCoverageRecorded`, `ChildAssignmentAmended`, and `ChildWorkReported`
may appear between that witness and transfer, and the authoritative aggregate
must still be `suspended`.

The ticket's blockers/follow-ups byte-match the suspension event. Its
`checkpointId`, `sourceState`, and `checkpointEventPosition` bind the current
governing checkpoint, which may be newer than the original suspension
checkpoint and must equal the aggregate/authority latest checkpoint at
transfer. The `ChildWorkTransferCreated` payload cites that same governing
checkpoint and separately cites the original suspension checkpoint. This new
Version 2 contract authorizes a newer suspended-child checkpoint to govern
transfer while preserving the original suspension as immutable lineage.
Ticket claim, ending-scope projection, migration-0004 SQL guards, quick
integrity, and full integrity dispatch on the lineage codec: legacy tickets
retain their legacy adjacent witness rule; new session-end lineage uses the two
explicit witness positions, requires a Version 2 transfer event, and validates
every referenced event directly.

Fresh-integrity registration covers both root and child. A stale selection
returns retryable `EVENT_CONFLICT` with zero effect, releases or renews the
claim as appropriate, and rescans from the start.

### 9.4 Children-resolved proof

After no child is selected, a separate eventless `BEGIN IMMEDIATE` transaction:

1. revalidates workflow generation, requested phase, owner/token/expiry;
2. calls bounded, binary-ordered ticket and direct-child history reads, each
   with a hard limit of `MAX_ROOT_CHILD_HISTORY_V1 + 1`; the ticket read returns
   claimed and unclaimed rows, and the child read includes terminal rows;
3. proves no eligible nonterminal child remains, every transferred source child
   has exactly one immutable ticket, every ticket names that transferred source
   child, and each ticket's all-null or all-non-null claim tuple matches its
   immutable claim event;
4. compare-and-swaps `requested` to `children-resolved`; and
5. commits without event append, semantic dedup, or outbox write.

`listBySourceRoot(projectId, rootSessionId, limit)` orders by binary
`(source_child_session_id, transfer_ticket_id)` and uses the same limit-plus-one
overflow rule as the direct-child history read. Schema 4 makes more than 1,000
rows impossible after a successful migration: migration preflight validates
legacy rows, insert overlays reject the 1,001st row, and service-level creation
checks return the bounded capacity error before identity or mutation. An
overflow observed by a proof read is therefore persisted corruption and fails
`INTEGRITY_FAILURE`; it is never treated as an empty or complete page. Only the
validated unclaimed subset enters the source root's later ending scope. A
claimed ticket is excluded from that scope only after its complete claim tuple
and event have passed validation; absence cannot be confused with a legitimate
claim.

Migration 0004 adds matching child-authority and transfer-ticket insert
overlays. `fork-child` and `claim-child-transfer` count all direct child rows for
the target parent before allocating IDs or mutating. Public suspend/transfer and
the Task 14 automatic transfer count all lifetime tickets for the source root
and enforce exactly one ticket per source child. A unique schema-4 index on
`(project_id, source_parent_session_id, source_child_session_id)` plus overlay
checks protects the same invariant from hostile SQL. The exact-cap boundary is
accepted; the 1,001st child or ticket is rejected atomically.

A lost eventless response is recovered by reading the already-advanced durable
status; it does not append an event.

## 10. Amendment semantics

Every accepted amendment appends a Version 3 `SessionEndAmended`, increments
generation by exactly one, points the workflow at the new snapshot event,
clears prior claim/validation work as required, and queues exactly one
`SessionEndAmended` compatibility-log revision in the same transaction.

The effective request is obtained by strict deterministic folding of the prior
snapshot and the amendment. No unbounded replay is needed for routine hydration.

### 10.1 Open

`open` is sealed-to-open only and requires a non-null Version 2 final draft. It:

- clears frozen checkpoint/generation/bindings, final checkpoint fields,
  validation plans/results, quality score, and safe failure;
- preserves `requested` when eligible child work remains;
- otherwise resets to `children-resolved`; and
- prevents final checkpoint append while open.

### 10.2 Seal

`seal` is open-to-sealed only. It requires an effective Version 2 draft and a
current qualifying ordinary Version 2 pre-transition checkpoint whose direct
scope and evidence coverage still match. It keeps the current
`requested`/`children-resolved` phase. Evidence racing after the checkpoint
makes the seal assertion stale and forces retry with zero effect.

### 10.3 Unchanged

`unchanged`, including implicit Version 1 behavior, preserves the exact phase
and the complete frozen group byte-for-byte. If any changed field would
invalidate already-completed child, finalization, materialization, or validation
work, the amendment is rejected. The caller must explicitly open, provide the
new draft/state, and seal/refinalize.

At `requested`, fields may change without a rewind because the workflow is
already at the earliest phase. At later phases, the service computes the
earliest affected phase and rejects `unchanged` whenever that phase precedes the
current durable phase or changes frozen bytes.

Every Version 1 amendment, including a null Version 1 draft that preserves a
Version 2 effective draft, runs whole-scope Version 1 eligibility after folding
and before event, workflow, outbox, claim, or failure effects.

### 10.4 Child-policy changes

Already-created tickets remain historical carry-forward work across amendment
generations. Switching to `require-completed` is allowed only when no eligible
direct child remains; otherwise it returns `SESSION_CHILDREN_ACTIVE` with zero
effect. Retained tickets do not become active children and are not deleted.

Fresh dedup-miss child commands from an older generation fail their generation
gate. An exact retry of an old-generation child command that committed before
the amendment returns its stored semantic result before current generation,
phase, root, child, or claim authorization checks.

## 11. Cancellation and reopening

### 11.1 Cancellation

Cancellation requires current root authority and the applicable pre-transition
checkpoint. It appends Version 3 `SessionEndCancelled` with
`previousWorkflowGeneration` equal to current generation and
`workflowGeneration` exactly one greater, and atomically:

- restores only the persisted root state (`active` or `suspended`);
- moves the workflow to durable `cancelled`;
- seals the evidence window and clears the frozen group;
- clears claims, retries, failures, and validation plans;
- fences old coordinator/validation/outbox work;
- queues one deterministic `SessionEndCancelled` materialization revision after
  root restoration; and
- writes projection and dedup before commit.

It never deletes a ticket, rewinds a transferred child, or emits compensation.

Race order is deterministic under `BEGIN IMMEDIATE`:

- child commits first: cancellation retains the ticket;
- cancellation commits first: the fresh child command fails generation/root/
  claim checks with zero effect; and
- child response is lost, then cancellation commits: exact retry of the old
  child identity returns the stored dedup result before current-state gates.

### 11.2 Reopening

A later authorized request reopens the same deterministic cancelled workflow
row at cancelled generation plus one. The sequence is:

```text
request G1 -> cancel G2 -> reopen request G3
```

Reopen replaces request/policy/draft snapshot pointer and prior root state,
clears terminal/claim/validation/final fields, and returns to `requested`.
It never inserts a second workflow row.

Unclaimed tickets whose `source_parent_session_id` is this root remain in scope
across generations. A later legitimate external ticket claim removes that
ticket from the source root's unresolved final scope according to durable
ticket state.

Reopen appends only `SessionEndRequested`; it does not queue a materialization
revision. Its next ending revision is the later final checkpoint event.

## 12. Final checkpoint and frozen ending scope

The final checkpoint action is available only when:

- workflow phase is `children-resolved`;
- evidence window is `sealed`;
- claim and generation are live/current;
- root and descendant coverage still matches the sealed checkpoint;
- every non-null child/ticket checkpoint is proven by direct global event
  position; and
- both final checkpoint and ending-scope capacity estimates pass.

The canonical final scope is the sorted union of:

- exactly one `current-child` binding for each authority row whose
  `session_kind = 'child'`, `parent_session_id` equals this root,
  `terminal_event_position IS NULL`, and semantic state is exactly `active`,
  `completion-proposed`, or `suspended`; and
- still-unclaimed carry-forward tickets sourced from this root, including
  tickets created by earlier workflow generations.

Completed and transferred authority rows are never `current-child` bindings.
A transferred source child appears only through its one validated unclaimed
ticket; a claimed ticket and a completed child are excluded.

There is exactly one binding per `childSessionId`, ordered by binary lowercase
child UUID as required by `decodeFinalEndingScopeBindingsV1`. A transferred
source child with an unclaimed ticket is represented only by a
`carry-forward-ticket` binding. Duplicate tickets, a transferred source child
without its required durable ticket, or a current-child/ticket double
representation is `INTEGRITY_FAILURE`. A legitimately claimed ticket is no
longer part of the source root's ending scope.

One root semantic transaction prepares the final `SessionCheckpointRecorded`
and its typed Task 14Q pending outbox descriptor before event-store prepare.
The descriptor is part of `AppendCommand.outbox`, strict append validation, and
the dedup outbox-order ledger. Lifecycle `command_dedup.command_hash` remains
the authoritative lifecycle-intent-witness hash required for exact replay; it
is not redefined as an outbox-descriptor hash. `appendPlanned` atomically
inserts the event and the extended immutable lifecycle outbox row. In
`afterAppend`, the service records the checkpoint authority tuple, freezes
workflow generation/bindings, advances to `final-checkpoint-recorded`, and
asserts the exact inserted row; it does not perform a second outbox insert. Any
failure rolls the entire transaction back.

No `MaterializationQueued` semantic event is invented.

## 13. Task 14Q: deterministic queue planning

### 13.1 Canonical constants

```text
artifact_kind:      compatibility-session-log
legacy outbox kind: materialize-lifecycle-log
target_key:         lifecycle-log/{sessionId}/{materializationRevision}
fingerprint domain: pm-materialization-fingerprint-v1
artifact path:      05_Agent_Session_Logs/{yyyy-mm-dd}-session-{sessionId}.md
content hash:       outboxHash(canonical lifecycle payload)
```

The date comes only from committed `SessionStarted` UTC time. All code,
integrity queries, source-state exclusion, tests, and materializer contracts use
`compatibility-session-log`; the current `session-log` source-state literal is
not retained as an alias.

### 13.2 Ownership moved into Task 14Q

Task 14Q creates and owns:

- `src/orchestrator/storage/lifecycle-outbox.repository.ts` planning inserts and
  immutable planned-row reads;
- `src/orchestrator/materialization/vault-artifact-path.ts`;
- `src/orchestrator/materialization/compatibility-log.renderer.ts`;
- `src/orchestrator/materialization/sqlite-lifecycle-materialization-queue.ts`;
- the lifecycle branch of `PendingOutbox` and event-append validation/insertion;
- queue/renderer/repository tests; and
- the writer and read-only transaction capabilities needed by Task 14.

The renderer is pure over a strict ordered lifecycle-event sequence. Queue
planning supplies the committed prefix plus one exact candidate event at the
transaction's known next global position; a later independent render uses the
committed sequence through that same position. It emits deterministic UTF-8/LF
bytes and never includes raw evidence, secret material, wall clock, locale,
process ID, random event ID, or current topic state.

### 13.3 Queue port

Caller-supplied `expectedPriorFingerprint` is removed from projection,
prepared, and insert inputs. There is no authoritative caller source for it.

```ts
export interface WorkflowMaterializationOriginV1 {
  readonly kind: "workflow";
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
}

export interface DirectTerminalMaterializationOriginV1 {
  readonly kind: "terminal-event";
  readonly workflowId: null;
  readonly workflowGeneration: null;
}

export type LifecycleMaterializationOriginV1 =
  | WorkflowMaterializationOriginV1
  | DirectTerminalMaterializationOriginV1;

export type LifecycleMaterializationTriggerType =
  | "SessionCheckpointRecorded"
  | "SessionEndAmended"
  | "SessionEndVerificationFailed"
  | "SessionEndVerificationInvalidated"
  | "SessionEndCancelled"
  | "SessionAbandoned"
  | "SessionEnded";

export interface LifecycleMaterializationPayloadCommonV1 {
  readonly payloadVersion: 1;
  readonly targetKey: string;
  readonly sessionId: SessionId;
  readonly artifactKind: "compatibility-session-log";
  readonly artifactPath: string;
  readonly materializationRevision: string;
  readonly triggeringPayloadHash: string;
  readonly nextFingerprint: KeyedFingerprintV1;
}

export type LifecycleMaterializationPayloadV1 = JsonValue
  & LifecycleMaterializationPayloadCommonV1
  & (
    | {
        readonly origin: WorkflowMaterializationOriginV1;
        readonly triggeringEventType: LifecycleMaterializationTriggerType;
      }
    | {
        readonly origin: DirectTerminalMaterializationOriginV1;
        readonly triggeringEventType: "SessionAbandoned";
      }
  );

export interface PendingLifecycleOutboxV1 extends PendingOutbox {
  readonly targetKey: string;
  readonly kind: "materialize-lifecycle-log";
  readonly eventIndex: 0;
  readonly payload: LifecycleMaterializationPayloadV1;
}

export interface MaterializationProjectionInputCommonV1 {
  readonly context: ProjectContext;
  readonly sessionId: SessionId;
  readonly artifactKind: "compatibility-session-log";
  readonly triggeringEventIndex: 0;
  readonly expectedTriggerPosition: bigint;
  readonly triggeringEventSchemaVersion: number;
  readonly triggeringOccurredAt: string;
  readonly triggeringEventPayload: JsonValue;
}

export type MaterializationProjectionInputV1 =
  MaterializationProjectionInputCommonV1
  & (
    | {
        readonly origin: WorkflowMaterializationOriginV1;
        readonly triggeringEventType: LifecycleMaterializationTriggerType;
      }
    | {
        readonly origin: DirectTerminalMaterializationOriginV1;
        readonly triggeringEventType: "SessionAbandoned";
      }
  );

declare const PREPARED_MATERIALIZATION_QUEUE_V1: unique symbol;

export interface PreparedMaterializationQueueV1 {
  readonly [PREPARED_MATERIALIZATION_QUEUE_V1]: true;
  readonly pendingOutbox: PendingLifecycleOutboxV1;
}

export interface ExactPlannedRevisionQueryCommon {
  readonly projectId: ProjectId;
  readonly sessionId: SessionId;
  readonly artifactKind: "compatibility-session-log";
  readonly materializationRevision: bigint;
  readonly triggeringEventPosition: bigint;
}

export type ExactPlannedRevisionQuery =
  ExactPlannedRevisionQueryCommon
  & (
    | {
        readonly origin: WorkflowMaterializationOriginV1;
        readonly triggeringEventType: LifecycleMaterializationTriggerType;
      }
    | {
        readonly origin: DirectTerminalMaterializationOriginV1;
        readonly triggeringEventType: "SessionAbandoned";
      }
  );

export type LifecycleOutboxPlannedRevision =
  ExactPlannedRevisionQuery
  & {
  readonly targetKey: string;
  readonly artifactPath: string;
  readonly triggeringPayloadHash: string;
  readonly expectedPriorFingerprint: KeyedFingerprintV1 | null;
  readonly nextFingerprint: KeyedFingerprintV1;
  readonly createdAt: string;
};

export interface LifecycleOutboxPlanReader {
  getExactPlannedRevision(
    query: ExactPlannedRevisionQuery,
  ): LifecycleOutboxPlannedRevision | null;
  assertExactPlannedRevision(
    query: ExactPlannedRevisionQuery,
  ): LifecycleOutboxPlannedRevision;
}

interface LifecycleMaterializationPlanningReads {
  readGlobalTailPosition(): bigint;
  readStrictLifecyclePrefix(
    projectId: ProjectId,
    sessionId: SessionId,
    throughPositionExclusive: bigint,
  ): readonly StoredEvent[];
  readVerifiedImmediatePredecessor(
    projectId: ProjectId,
    sessionId: SessionId,
    artifactKind: "compatibility-session-log",
    beforeRevision: bigint,
  ): LifecycleOutboxPlannedRevision | null;
}

export interface LifecycleMaterializationQueuePort {
  prepare(
    input: MaterializationProjectionInputV1,
  ): PreparedMaterializationQueueV1;
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

`prepare` is synchronous and connection-bound. The concrete queue privately
receives only `LifecycleMaterializationPlanningReads`, its key provider, path
deriver, renderer, and immutable plan reader; semantic callers never receive
those raw reads or a full `LifecycleCommandTransaction`. It verifies that the
event index is exactly zero and `expectedTriggerPosition` is the transaction's
next global position, derives the canonical artifact path/target/revision,
strict-decodes the complete trigger/origin union, renders the committed prefix
plus exact candidate, verifies/loads the immediate predecessor, computes the
provider-keyed `nextFingerprint`, zeroizes transient render bytes, and returns a
deeply frozen pending descriptor. The opaque object is accepted only by the
queue instance that created it and progresses once through prepared, planned,
and committed assertions. `assertPlanned` and `assertCommitted` verify exact
project/vault/store/workspace/session, zero event index, position, type, schema,
occurred-at, canonical payload hash, origin, target, path, revision, and
fingerprint binding; neither renders, fingerprints, nor inserts.

`LifecycleMaterializationPayloadV1` and both origin variants are exact-key,
strict canonical JSON codecs. The discriminator matrix is closed: a
`terminal-event` origin is legal only with a direct non-workflow
`SessionAbandoned`; every other trigger requires `workflow` origin, and an
ending-workflow `SessionAbandoned` also uses `workflow`. Repository insertion,
migration-0004 SQL overlays, quick/full integrity, and codec tests enforce that
same matrix. `materializationRevision` is the canonical decimal form of the
trigger position, outer and payload target keys must match, and `content_hash`
is exactly `outboxHash(payload)`. Task 14Q freezes the complete trigger union
above; Task 15 is not allowed to extend it later.

Repository behavior is split into immutable planning/read seams:

```ts
insertLifecycle(
  connection,
  pending: PendingLifecycleOutboxV1,
  triggeringEvent: StoredEvent,
  createdAt: string,
): void;
getExactPlannedRevision(connection, query):
  LifecycleOutboxPlannedRevision | null;
assertExactPlannedRevision(connection, query):
  LifecycleOutboxPlannedRevision;
```

`insertLifecycle` is callable only from the event append statement adapter after
the referenced event row has been inserted. It revalidates the strict pending
payload against that actual event and derives `expectedPriorFingerprint` from
the immediately preceding lower revision selected by
`(project_id, session_id, artifact_kind)` inside the same `BEGIN IMMEDIATE`,
regardless of whether that row is pending, claimed, completed, or failed. It
does not include `artifact_path` in predecessor selection. Null is legal only
when no lower revision exists.

The canonical path is independently derived from the original
`SessionStarted` event for both current and predecessor rows. A predecessor on a
different path is corruption, not a second chain. Before copying its
`next_fingerprint` value, the repository strictly verifies the predecessor's
complete algorithm/schema/key/domain/value tuple, target/revision/event
binding, content hash, canonical payload, and path. Key rotation therefore
does not make the prior tuple ambiguous.

`getExactPlannedRevision` returns null only for absence. Malformed or
cross-bound rows throw `INTEGRITY_FAILURE`. `assertExactPlannedRevision` also
throws for absence. It joins the triggering event and original `SessionStarted`
and verifies type, payload/content hash, project/session/origin, path, target
key, revision, algorithm/schema/key/domain, and immediate fingerprint lineage.
It accepts any operational status and does not rerender or refingerprint.

The generic event append contract becomes a strict union. A generic pending
outbox cannot use kind `materialize-lifecycle-log`; that literal must decode as
`PendingLifecycleOutboxV1`. `validateAppendCommand` preserves and validates the
full typed descriptor in the normalized append plan, but for lifecycle commands
the persisted `command_dedup.command_hash` remains exactly
`authoritativeIntentHash`; `EventAppendTransaction.prepare` continues to prove
that it equals the lifecycle-intent-witness hash. `appendPlanned` dispatches the
lifecycle branch to `insertLifecycle` with the actual stored event; all other
kinds retain the base insert. The lifecycle target key remains in
`command_dedup.outbox_order_json`, so replay and event integrity observe the
same ordered targets. Exact descriptor integrity is instead proved by the
strict canonical payload/content hash, actual triggering-event binding,
deterministic path/revision/origin derivation, verified predecessor fingerprint
chain, and exact-row quick/full integrity. A direct `afterAppend` insertion is
forbidden.

### 13.4 Capability separation

- Semantic services receive only the queue's prepare/assert capability and
  place its frozen descriptor in `AppendCommand.outbox`; they receive no raw
  lifecycle outbox writer, planning reads, or command transaction.
- The concrete connection-bound queue privately receives only the three
  read-only operations in `LifecycleMaterializationPlanningReads`; it cannot
  mutate authority, leases, approvals, transfers, workflows, or validation.
- `EventAppendStatements` owns the connection-bound immutable planning writer
  used by `appendPlanned`.
- `WorkflowOperationalTransaction.outboxPlans` exposes immutable get/assert
  only.
- Task 16 may define `LifecycleOutboxOperationalRepository extends
  LifecycleOutboxPlanReader` with mutable claim, renewal, lower-history,
  failure, materialization, and private acknowledgement operations; the Task
  14Q planning writer/reader signatures do not change.

A workflow operation cannot claim or acknowledge an outbox row. A materializer
operation cannot mutate workflow semantic state.

### 13.5 Atomic final queue insertion

The exact ordering is:

1. `LifecycleCommandStore` opens `BEGIN IMMEDIATE`.
2. The semantic service finishes all checks, obtains the exact next global
   position, and calls queue `prepare` with the candidate checkpoint event.
3. The returned `pendingOutbox` is included in the append command before
   `EventAppendTransaction.prepare`; strict append planning validates it while
   the lifecycle command hash remains the authoritative intent hash.
4. `planPrepared` materializes the exact stored checkpoint event;
   `beforeAppend` calls queue `assertPlanned` on that event.
5. `appendPlanned` inserts `SessionCheckpointRecorded`, derives the immediate
   predecessor fingerprint, and inserts the extended lifecycle outbox row from
   the typed descriptor.
6. `afterAppend` receives the committed event, `recordPreparedFinal` persists
   checkpoint/frozen-group/phase state, and queue `assertCommitted` confirms the
   exact row without inserting it.
7. Projection and semantic dedup, including the same ordered lifecycle target,
   are written.
8. The transaction commits.

Renderer, key-provider, fingerprint, row, or index failure rolls back the event,
checkpoint authority, frozen group, phase, outbox row, projection, and dedup.
The same prepare/plan/append/assert ordering is used for every trigger in the
frozen union, not only the final checkpoint. An event-integrity acceptance test
must pass after each lifecycle row is queued, proving no hidden post-ledger row
exists.

### 13.6 Exact-row confirmation

The later `final-checkpoint-recorded -> ending-materialization-queued` action is
eventless. In a new `BEGIN IMMEDIATE`, it:

1. revalidates workflow generation, owner, token, phase, and live expiry;
2. calls `outboxPlans.assertExactPlannedRevision` using the frozen final
   checkpoint event position;
3. compare-and-swaps the workflow phase only after assertion succeeds; and
4. commits without event, dedup, rendering, fingerprinting, or outbox write.

A missing or mismatched row has zero phase effect.

### 13.7 Trigger ownership

Task 14 queues:

- final `SessionCheckpointRecorded` — exactly one ending revision;
- every committed `SessionEndAmended` — exactly one generation-bound revision;
  and
- `SessionEndCancelled` — exactly one restored-state revision.

Task 15 uses the already-frozen Task 14Q codecs to queue exactly one revision
for each committed `SessionEndVerificationFailed`,
`SessionEndVerificationInvalidated`, `SessionAbandoned`, and `SessionEnded`.
An ending-workflow abandonment uses workflow origin; a direct non-workflow
abandonment uses terminal-event origin.

Initial and reopened `SessionEndRequested` events never queue a row.

## 14. Task 15 and Task 16 boundaries

### 14.1 Task 15

Task 15 consumes the real Task 14Q queue, not a recording fake. It owns:

- trusted validation profile registry and runner;
- persisted-plan expansion/configuration-drift checks;
- atomic plan persistence and `ending-materialization-queued -> validating`;
- validation result/failure/invalidation/terminal semantic events;
- real planned revisions for failure, invalidation, completion, and abandonment;
  and
- recovery reporting of due outbox work without executing it.

With `requireMaterialization: false`, the workflow may reach `completed`.
With `requireMaterialization: true`, it stops durably at
`completion-appended`/materialization-pending after one `SessionEnded` and one
exact completed-revision insert.

Task 15 may add a read-only ordered outbox recovery scan. It does not modify the
queue port's trigger union or claim/materialize rows.

The eventless begin-validation operation uses one `BEGIN IMMEDIATE` with this
exact order:

1. return an already-committed exact phase/plan replay when applicable;
2. revalidate workflow ID/generation, phase
   `ending-materialization-queued`, claim owner/token/live expiry, sealed
   evidence window, and exact Task 14Q ending row;
3. hydrate the immutable effective snapshot and final checkpoint, derive the
   ordered trusted registry entries, expand every six-key plan, and strict
   decode/rederive all stable identities;
4. assert final-checkpoint authority, frozen ending scope, and coverage are
   still current for that generation using only bounded database-backed reads;
5. persist the canonical six-key plan array at most once for the current
   generation; and
6. compare-and-swap the phase to `validating`, then commit.

Steps 3 through 6 remain inside the same synchronous transaction. Plan conflict,
configuration drift, freshness failure, or phase CAS failure rolls back both
the plan write and phase change. Only after commit does the validation runner
asynchronously capture and strict-decode validation-start source state before
external process execution; that witness is persisted with the immutable
validation result. No filesystem, process, or asynchronous source-state capture
runs while SQLite is locked. The later short terminal `SessionEnded`
transaction is the only Task 15 SQLite transaction allowed to perform the
separately approved synchronous completion-source-state capture.

`WorkflowOperationalTransaction` exposes exactly these focused facades to that
operation: `workflows`, `validationPlans`, immutable `outboxPlans`, read-only
`authority`, read-only `transfers`, and read-only `coverage`. It exposes no
`SourceStateProvider`, event append, or outbox insert/claim/acknowledge.
The Task 15 runtime factory receives the one active connection, workflow and
validation-plan repositories, the Task 14Q plan reader, the read-only
authority/transfer/coverage providers, immutable validation registry, trusted
clock, and fault hooks. The outer validation runner separately receives the
asynchronous source-state provider after the begin-validation transaction has
committed. It opens no second SQLite connection.

### 14.2 Task 16

Task 16 retains:

- outbox claim-next, exact claim, renewal, takeover, and failure/backoff;
- lower-revision fingerprint history;
- deterministic staging and atomic artifact replacement;
- file and directory fsync;
- symlink/path substitution defense;
- private acknowledgement inside replacement reconciliation;
- completed replay and lost-response handling;
- worker routing for claim/materialize/failure;
- `completion-appended -> completed-materialization-confirmed -> completed`; and
- crash, stale-generation, permanent conflict, and handle-closure tests.

Task 16 consumes the Task 14Q renderer/path/queue/planning API unchanged.
Its mutable repository is a separate extension:

```ts
export interface LifecycleOutboxOperationalRepository
  extends LifecycleOutboxPlanReader {
  claimNext(input: OutboxClaimRequest): LifecycleOutboxClaim | null;
  getExactClaim(input: ExactOutboxClaimQuery): LifecycleOutboxClaim;
  renewClaim(input: OutboxClaimRenewal): LifecycleOutboxClaim;
  listCommittedLowerRevisionFingerprints(
    claim: LifecycleOutboxClaim,
  ): readonly KeyedFingerprintV1[];
  recordFailure(input: OutboxFailure): LifecycleOutboxClaim;
  acknowledgeAfterReplacement(
    input: OutboxAcknowledgement,
  ): MaterializationResultV1;
}
```

The Task 16 factory receives the same active connection, that operational
extension, Task 14Q renderer/path derivation and plan reader, provider-keyed
fingerprint service, contained atomic replacer, trusted clock, and fault hooks.
`OutboxOperationalTransaction` exposes only claim/history/failure/private-ack
capabilities. Task 16 may add methods to the operational extension, but it does
not alter `LifecycleMaterializationQueuePort`, `PendingLifecycleOutboxV1`,
`LifecycleMaterializationPayloadV1`, or `LifecycleOutboxPlanReader`.

## 15. Phase ownership after amendment

| Phase/action | Owner |
|---|---|
| request/amend/cancel | Task 14 semantic service |
| carry forward one child | Task 14 internal semantic service |
| `requested -> children-resolved` | Task 14 operational service |
| final checkpoint + ending row | Task 14 + Task 14Q |
| exact row confirmation to `ending-materialization-queued` | Task 14Q-backed operational service |
| persist plans and enter `validating` | Task 15 |
| validation/failure/invalidation/terminal event | Task 15 |
| claim/materialize/replace/ack/failure | Task 16 |
| materialization-confirmed completion | Task 16 |

Task 14 therefore has an executable, honest exit boundary: a workflow can reach
`ending-materialization-queued` with an exact immutable outbox row, without any
filesystem write.

## 16. Runtime and transaction composition

Task 14 modifies both runtime owner files required by the approved Task 13
handoff:

- `src/orchestrator/runtime/lifecycle-worker-runtime.ts`; and
- `src/orchestrator/runtime/lifecycle-worker-runtime.factory.ts`.

The same connection owns policy, repositories, command services, operational
facades, queue planning, and coordinator adapters. Disposal completes before
`ActiveStore` closes the connection.

Task 13's reserved request/amend/cancel, workflow claim/renew/release/scan,
internal workflow phase, and session-status bindings are replaced only by their
typed Task 14 implementations. Unsupported public transfer/materialization/
validation routes remain unavailable until their owning task lands.

The `internal-workflow-phase` runtime handler first strict-decodes the plan
subtype. `carry-forward-child` is routed to the dedicated internal child
semantic service with root authorization audience and child target; every root
phase action remains on the root session-end service. The handler never adapts a
carry-forward result into `SessionEndPhaseResultV2`. Command-store affected
session derivation registers both `rootSessionId` and `childSessionId` for the
carry subtype, while root phase actions retain root-only registration. The
runtime factory supplies the same connection-bound queue instance to semantic
services and the lifecycle event-append writer, so no post-append side channel
or second connection exists.

The external executor still transports strict wire DTOs. Domain services do
not accept raw worker records, and storage repositories do not own a
transaction.

## 17. Error and retry semantics

- `EVENT_CONFLICT`: retryable selection, head, generation, or source-state
  drift; zero effect.
- `SESSION_CHILDREN_ACTIVE`: require-completed policy has an eligible child;
  zero effect.
- `CHECKPOINT_BASE_INVALID`: required child/root checkpoint is absent or stale.
- `CHECKPOINT_CAPACITY_EXCEEDED`: prospective scope/draft exceeds capacity;
  detected before identity or mutation.
- `SESSION_CHILD_HISTORY_CAPACITY_EXCEEDED`: the lifetime direct-child or
  source-ticket count would exceed 1,000; detected before ID allocation or
  mutation.
- `SESSION_END_EVIDENCE_WINDOW_OPEN`: finalization attempted while open; zero
  event/phase/outbox/plan/failure effect.
- `IDEMPOTENCY_CONFLICT`: a stable identity is reused with different stable
  semantic input.
- `INTEGRITY_FAILURE`: impossible persisted event/workflow/fold/ticket/outbox
  disagreement; no automatic semantic repair.
- `MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED`: schema-4 upgrade
  eligibility failed before migration SQL; the complete migration transaction
  is rolled back.

External invalid input returns bounded lifecycle errors. Stored canonical
corruption becomes integrity failure. Migration ineligibility uses the existing
upgrade compatibility boundary and never partially applies migration 0004.

Coordinator recovery is position-ordered and one-action-per-drive. It never
loops asynchronously inside a transaction, trusts PID/liveness, or infers
success after uncertain delivery. Unknown outcomes are inspected through
durable dedup/workflow/ticket/outbox state using exact identities.

## 18. Crash and replay acceptance matrix

Task 14 tests at least:

1. crash before request commit — zero effect;
2. request commit/response loss — external dedup returns the same workflow/G1;
3. crash before child commit — child events/authority/ticket/dedup roll back;
4. child commit/response loss — exact internal retry returns dedup;
5. crash after one child — restart selects the next UUID child;
6. crash after last child before phase CAS — restart marks children resolved;
7. eventless CAS response loss — durable status reports the advanced phase;
8. expired claim takeover — same semantic identity, new live token, no duplicate
   ticket;
9. child changes after selection — `EVENT_CONFLICT`, zero effect, rescan;
10. request commits first, then a valid existing-child write commits — the next
    saga drive sees the new head and neither corrupts nor loses that write;
11. amendment/cancel before a fresh stale child dedup miss — old generation is
    rejected;
12. child commits before amendment/cancel — immutable ticket is retained and an
    exact old-generation retry returns dedup after the generation change;
13. request G1/cancel G2/reopen G3 — prior dedup and unclaimed tickets retained;
14. legacy Version 1 same-generation cancellation still replays, while every
    new Version 3 cancellation requires exact previous/G+1 fields;
15. child insertion order changes — binary UUID action order remains identical;
16. active/proposed child — suspend plus transfer events and exact Version 1
    carry-forward result correlation;
17. already suspended child — Version 2 transfer event only, including a newer
    governing checkpoint and report after the non-adjacent suspension witness;
    Version 1 transfer folding retains its frozen same-checkpoint rule;
18. suspension-lineage, governing-checkpoint, blockers/follow-ups, source-state,
    dual-checkpoint transfer payload, ticket, and transfer mutations each fail
    quick/full/claim validation;
19. children-resolved validates claimed and unclaimed ticket rows, detects a
    transferred child with zero or multiple tickets, and freezes only the
    validated unclaimed subset;
20. exactly 1,000 lifetime direct children and source tickets remain provable
    even when all are terminal/claimed; the 1,001st fork, transfer claim, public
    ticket, or automatic ticket rejects before identity/write, migration
    preflight rejects legacy overflow, and hostile SQL is blocked;
21. exact scope/byte capacity succeeds and one-byte-over capacity mutates
    nothing;
22. Version 1/2 request and reopen evidence-window shapes;
23. open workflow reaches but cannot pass `children-resolved`;
24. `unchanged` never rewinds and preserves frozen bytes;
25. Version 1 amendment whole-scope gate runs even with null draft;
26. final checkpoint/renderer/key-provider/outbox insert/index failure rolls
    back everything;
27. the lifecycle pending descriptor is strictly planned while
    `command_dedup.command_hash` remains the exact authoritative intent hash;
    its target is present in `outbox_order_json`, and full descriptor/event
    integrity passes after queueing;
28. every lifecycle trigger uses event index zero; nonzero indices reject before
    append, terminal-event origin accepts only direct `SessionAbandoned`, and
    every invalid origin/trigger pair fails codec, SQL, and integrity checks;
29. exact row confirmation occurs before phase CAS;
30. missing/mismatched planned row has zero phase effect;
31. initial/reopen request creates no outbox row;
32. amendment/cancel each creates one row and replay creates none;
33. all seven workflow trigger payload variants strict-decode, hash, and bind to
    their actual event; `SessionEndRequested` is rejected as a trigger;
34. expected prior fingerprint is repository-derived under the same transaction;
35. a lower revision on a foreign path is corruption rather than a new null
    lineage root;
36. renderer golden bytes are deterministic and secret/raw-evidence free;
37. validation-plan exact-cap/over-cap, ordering, and each identity-uniqueness
    rule reject hostile raw SQL and fail quick/full integrity;
38. Version 2 workflow fingerprints cover initial, Version-1-to-Version-2, and
    Version-2-to-Version-2 predecessor chains with exact golden preimages;
39. migration-4 preflight and every migration-4 fault boundary roll back all
    pending migrations without a staging-table residue;
40. quick/full integrity detects snapshot/fold/workflow/ticket/outbox corruption;
41. runtime routes carry-forward to the dedicated child-targeted handler and
    every other Task 14 semantic/fenced operation to the exact shared instance;
    and
42. disposal completes before the active store closes.

## 19. Implementation decomposition

The implementation plan should decompose Task 14 rather than produce one giant
change:

1. **Task 14M — schema/effective-state foundation**
   - UUIDv5 identities, snapshot/policy codecs, request/amend/cancel event
     Version 3, internal transfer event Version 2, migration 0004, read-only
     preflight, fingerprint Version 2, validation-plan overlay guards,
     projections, integrity, registry, and upgrade gates.
2. **Task 14Q — queue-planning prerequisite**
   - path, renderer, fingerprint planning, typed pending-outbox/event-append
     integration, outbox planning repository, exact-row reads, focused
     transaction capabilities, and source-state constant repair.
3. **Task 14R — request/repository/policy lifecycle**
   - workflow repository, request/reopen, amendment, cancellation, generation,
     evidence windows, and status/claim mechanics.
4. **Task 14S — per-child saga and final freeze**
   - child selection/action/result wire, dedicated internal child mutation,
     Version 2 dual-checkpoint aggregate/projection/claim/integrity dispatch,
     suspension/ticket lineage, all-ticket resolution proof, capacity,
     children-resolved CAS, final checkpoint/outbox atomicity, coordinator.
5. **Task 14W — runtime/integrity integration**
   - worker routing/factory ownership, executor regressions, crash/recovery,
     complete focused and full gates.

Each slice uses strict red-green TDD, receives an independent spec/quality
review, commits only its declared scope, and preserves a clean worktree before
the next slice.

## 20. Parent-plan amendments required

Before implementation, the written implementation plan must remove or replace
all contradictory Task 14 text:

- remove child carry-forward "before `SessionEndRequested`" and "same lifecycle
  command plan" requirements;
- replace literal `session-end/{sessionId}` workflow IDs with UUIDv5;
- add migration 0004, request/amend/cancel event Version 3, and effective-state
  snapshot scope;
- add internal `ChildWorkTransferCreated` Version 2 with separate suspension and
  governing checkpoint identities; preserve Version 1 semantics and update the
  aggregate, projection, ticket-claim, SQL, and quick/full integrity dispatch;
- derive request/reopen evidence-window state from request version;
- preserve Version 1 cancellation replay compatibility while requiring Version
  3 exact G+1 and canonical G1/G2/G3 tests;
- replace full 18-key persisted validation plans with the six-key codec plus
  deterministic expansion and migration-0004 overlay guards;
- move queue planning/renderer/path/repository/read seam from Task 16 to Task
  14Q;
- replace post-append lifecycle row insertion with a typed
  `AppendCommand.outbox` branch covered by strict append planning, dedup target
  order, payload/content hash, triggering-event binding, and exact-row
  integrity, while retaining the authoritative lifecycle intent hash as
  `command_dedup.command_hash`;
- remove recording-fake-only queue acceptance from Tasks 14 and 15;
- remove queue insertion from initial/reopened request;
- add the carry-forward planned/authoritative command split, Version 1 result,
  dedicated child runtime route, and root-plus-child affected-session binding;
- permit valid existing-child writes after the root request and rely on exact
  child CAS/rescan rather than a nonexistent universal active-root gate;
- validate all claimed/unclaimed source-root tickets, explicit suspension
  lineage, the lifetime 1,000-row child/ticket bounds, and the exact nonterminal
  current-child ending-scope predicate;
- make `unchanged` preserve phase/frozen bytes and reject required rewinds;
- include both runtime owner files and build-artifact migration smoke;
- move validation plan construction and begin-validation ownership to Task 15,
  with its exact one-transaction ordering and focused facades;
  and
- leave claim/materialize/replace/fsync/ack/failure in Task 16 through a separate
  mutable repository extension.

Task 15 and Task 16 file lists, interfaces, focused gates, staging commands, and
acceptance text must be updated consistently. No implementation begins from the
old contradictory steps.

## 21. Documentation and review gate

This document records the approved conversational design but is not yet an
implementation plan. After it is committed:

1. the user reviews the exact written specification;
2. requested changes are applied and the spec self-review is rerun;
3. only explicit written-spec approval unlocks the Superpowers
   `writing-plans` workflow; and
4. implementation remains forbidden until the amended plan itself is reviewed.
