# Qualified Checkpoint Evidence Coverage Amendment

Date: 2026-07-18

Status: Ready for user review

Amends:
`docs/superpowers/specs/2026-07-14-root-child-lifecycle-and-checkpoints-design.md`

Implementation plan to amend after approval:
`docs/superpowers/plans/2026-07-14-root-child-lifecycle-and-checkpoints.md`

Primary-mode cutover: Still forbidden in Subproject 2

## 1. Problem

The approved checkpoint contract has one unqualified
`CheckpointEvidenceCoverageV1`, while durable evidence coverage is keyed by
`(projectId, sessionId, adapterSessionId)` and intentionally permits multiple
adapter sessions for one lifecycle session. Ordinals are local to an adapter
session. Combining rows by ordinal can hide real gaps, and choosing the most
recent row silently omits other authorized coverage.

No approved rule identifies one active adapter session or binds an
`adapterSessionId` to lifecycle ownership. The implementation must not infer
such a rule from latest event time, client identity, or UUID ordering.

The existing strict outer event schema also embeds only `CheckpointV1`, and the
schema-2 coverage aggregate does not cache the cumulative coverage digest.
Therefore nested-only evolution would break old readers, while reconstructing
the digest during every checkpoint would create an unbounded ordinal scan
inside `BEGIN IMMEDIATE`.

## 2. Decision

Add all of the following as one coherent compatibility boundary:

- `CheckpointV2`, containing every adapter session as a qualified,
  deterministically ordered coverage snapshot;
- immutable `LifecycleEventV2` variants for corrected evidence coverage,
  Version 2 checkpoints, and Version 2 end request/amendment semantics, while
  leaving `LifecycleEventV1` unchanged;
- project-store migration `0003-qualified-checkpoint-coverage`, which stores
  the cumulative coverage-digest profile/value in the aggregate and fences old
  readers before any Version 2 event can commit; and
- strict Version 1/Version 2 DTO, result, repository, intent, worker, and
  session-end unions rather than widening a type named `V1`.

The system never unions ordinal ranges across adapter sessions and never picks
one adapter as representative. Every adapter entry retains its own ordinal
namespace and fingerprint lineage.

Fresh Version 2-aware checkpoint paths use `CheckpointDraftV2` and emit
`CheckpointV2`. `CheckpointDraftV2` is valid before evidence exists and then
contains an empty adapter list. A fresh `CheckpointDraftV1` remains legal only
when the target is demonstrably coverage-clean: it has no coverage event,
ordinal row, aggregate row, or coverage-bearing checkpoint. Otherwise it fails
before source capture, UUID generation, enrichment, or mutation with
`CHECKPOINT_EVIDENCE_VERSION_REQUIRED`.

Historical Version 1 checkpoints remain byte-compatible and valid at their
original event positions. They are never retrofitted with later evidence.
Coverage-only evidence remains incomplete for policy purposes: both checkpoint
versions retain `contentRetained: false`, and neither can satisfy
`requireFullEvidence` in Subproject 2.

Here, a coverage-bearing checkpoint means a Version 2 checkpoint with at least
one adapter entry, or a Version 1 checkpoint whose unqualified coverage has a
non-null highest ordinal or a nonempty missing-interval list. This extra check
is corruption defense; healthy schema-3 state derives coverage from the event,
ordinal, and aggregate records.

## 3. Checkpoint contract

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

export type Checkpoint = CheckpointV1 | CheckpointV2;
export type CheckpointDraft = CheckpointDraftV1 | CheckpointDraftV2;
```

`decodeCheckpointDraft` and `decodeCheckpoint` read the discriminator once and
dispatch to strict version-specific decoders. They reject missing, unknown, or
unsupported versions and never try another decoder after a failure.
`decodeCheckpointV1`, its accepted keys, and its bounds remain unchanged.

`adapterSessions` is sorted by canonical lowercase `adapterSessionId` using
UTF-8 bytewise lexical order. Duplicate or reordered adapter IDs are invalid.
`missingIntervals` is inclusive, numeric, sorted, nonoverlapping, and coalesced
within one adapter namespace. `coverageFirstOrdinal` is always the string
`"0"`; prefix gaps therefore remain visible when the first captured frame has a
higher ordinal. The adapter list is empty only when no coverage state exists.

Every entry is copied from a bounded, quick-healthy aggregate state at or
before the checkpoint's `baseEventPosition`. `latestBatchEventPosition`
identifies that state. No coverage field is caller-authored. Full integrity,
not checkpoint capture, proves the aggregate against immutable ordinal rows.

The unchanged `CheckpointChildSummaryV1` shape is also the exact
server-derived carry-forward ticket encoding for a final root checkpoint. For
each ticket retained by the current session-end workflow generation, the final
checkpoint contains one summary with `childSessionId` equal to the ticket's
source child, `state: "transferred"`, `lastEventPosition` equal to the ticket's
`createdEventPosition`, `streamVersion` equal to the terminal transferred child
fold, and `latestCheckpointId` equal to the ticket's non-null `checkpointId`.
The `ChildWorkTransferCreated` event at that globally unique position supplies
the `transferTicketId`, which must byte-match the immutable ticket row. These
entries are sorted and unique with all other child summaries and are never
caller-authored. This reuses an existing strict Version 1 field shape, so the
Version 1 decoder and checkpoint hash domain remain unchanged while the ticket
reference is canonical and independently recoverable. The internal frozen
baseline additionally stores the referenced child checkpoint event position so
integrity can resolve that historical checkpoint by its indexed global event
position after the mutable latest-checkpoint pointer advances.

## 4. Evidence event and cumulative digest

Do not add required keys to the existing strict
`EvidenceCoverageRecordedV1`. Introduce this outer
`eventSchemaVersion: 2` payload instead:

```ts
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
```

`batchFirstOrdinal` and `batchLastOrdinal` are the first and last frame in this
event. `coverageFirstOrdinal`, `coverageLastOrdinal`,
`highestContiguousOrdinal`, `missingIntervals`, and `coverageFingerprint` are
the prospective cumulative state after applying the batch. This deliberately
separates the batch bounds that Version 1 already defined from cumulative
coverage bounds.

The trusted evidence provider supplies both profiles. Both algorithms are
HMAC-SHA-256, both schema versions are 1, and the coverage key ID must equal the
frame key ID. The domains differ. A caller may assert the existing frame
schema/key/domain fields, but the server validates them against the bound
provider; a caller never chooses either algorithm or the coverage profile.
`currentKey(scope, "evidence-fingerprint")` is consulted only when creating a
new adapter aggregate. Later batches use the aggregate's recorded key ID and
require `status` to remain `available`; provider rotation never mutates an
existing adapter profile. Every fresh checkpoint snapshot and every final
freshness gate likewise requires `available` status for each included recorded
profile; neither operation rekeys or recomputes the accumulator.

The coverage fingerprint is a rolling authenticated accumulator, not a flat
hash of all historical frames. `prepareBatch` determines which incoming frames
are genuinely new by comparing only the at-most-2,000 incoming ordinals and
frame IDs with their immutable rows. New frames are sorted by numeric ordinal;
identical overlaps are excluded. The accumulator body is exactly:

```ts
{
  coverageAccumulatorVersion: 1,
  projectId,
  storeId,
  sessionId,
  adapterSessionId,
  previousCoverageFingerprint,
  captureMode: "coverage-only",
  contentRetained: false,
  frameFingerprintProfile: {
    algorithm: "hmac-sha256",
    schemaVersion: 1,
    keyId: frameFingerprintKeyId,
    domain: "pm-evidence-frame-v1"
  },
  coverageFingerprintProfile: {
    algorithm: "hmac-sha256",
    schemaVersion: 1,
    keyId: coverageFingerprintKeyId,
    domain: "pm-evidence-coverage-v1"
  },
  coverageFirstOrdinal: "0",
  coverageLastOrdinal,
  highestContiguousOrdinal,
  missingIntervals,
  newFrames: [
    { ordinal, frameId, sourceKind, observedAt, contentFingerprint }
  ]
}
```

`previousCoverageFingerprint` is `null` for the first accepted frame and the
prior aggregate's 64-character digest thereafter. The cumulative summary is
the prospective state after all new frames. Batch IDs, event positions,
per-row `recordedEventPosition`, and creation timestamps are excluded.

Let `bytes` be a fresh mutable UTF-8 encoding of `canonicalJson` for that exact
object. The only permitted operation is:

```ts
provider.fingerprint({
  projectId,
  storeId,
  purpose: "evidence-fingerprint",
  keyId: coverageFingerprintKeyId,
  domain: "pm-evidence-coverage-v1",
  bytes
})
```

For the fixed evidence-fingerprint profile, that provider operation is
HMAC-SHA-256 with a key scoped by
`(projectId, storeId, purpose, keyId)` and the existing provider framing
`UTF8(domain) || 0x00 || bytes`. The service never obtains raw key bytes and
must not add another domain prefix or newline. It calls `currentKey` only for a
new adapter profile and calls `status` for a recorded profile with the same
scope and purpose before later writes, fresh snapshots/final gates, or
historical verification. Any status other than `available` fails closed as
`EVIDENCE_HISTORICAL_KEY_UNAVAILABLE`.

The provider returns exactly 64 lowercase hexadecimal characters. The caller
zeroes only its caller-owned mutable `bytes` in `finally`; the provider must not
retain them. When a valid batch inserts zero new frames, the service does not
call `fingerprint` and preserves the previous coverage fingerprint exactly.
Thus identical-overlap batches may advance latest-batch linkage without
changing the authenticated accumulator.

The accumulator is intentionally history-sensitive: two legal recordings that
introduce the same final ordinal set in different new-frame batches may have
different digests. Event order is authoritative, and full integrity must
reproduce that exact rolling history rather than normalize it to a set hash.

Coverage intervals are also updated incrementally. Starting from the bounded
aggregate intervals, extend the tail gap if a new maximum ordinal appears and
remove each newly captured ordinal, splitting intervals as needed. Derive
`highestContiguousOrdinal` from the first remaining gap, then enforce the final
200-interval bound. This costs `O(incomingFrames + currentIntervals)` and never
reads unrelated historical ordinal rows.

An adapter session has one immutable pair of profiles. Reconnects and exact
retries reuse the same adapter ID, ordinal namespace, and profiles. Key rotation
requires a new adapter ID and consumes another lifetime adapter slot.

## 5. Event and store version fence

`LifecycleEventV1` and `decodeLifecycleEventV1` remain unchanged. Add
`LifecycleEventV2` with exactly four allowed combinations:

- `eventSchemaVersion: 2`, `eventType: "EvidenceCoverageRecorded"`, and
  `EvidenceCoverageRecordedV2`; and
- `eventSchemaVersion: 2`, `eventType: "SessionCheckpointRecorded"`, and a
  strict `SessionCheckpointRecordedPayloadV2`;
- `eventSchemaVersion: 2`, `eventType: "SessionEndRequested"`, and a strict
  `SessionEndRequestedPayloadV2`; and
- `eventSchemaVersion: 2`, `eventType: "SessionEndAmended"`, and a strict
  `SessionEndAmendedPayloadV2`.

```ts
export interface SessionCheckpointRecordedPayloadV2
  extends Omit<
    LifecycleEventPayloadMapV1["SessionCheckpointRecorded"],
    "checkpoint"
  > {
  readonly checkpoint: CheckpointV2;
}

export interface SessionEndRequestedPayloadV2
  extends LifecycleEventPayloadMapV1["SessionEndRequested"] {
  readonly requestVersion: 2;
}

export interface SessionEndAmendedPayloadV2
  extends LifecycleEventPayloadMapV1["SessionEndAmended"] {
  readonly amendmentVersion: 2;
  readonly finalCheckpointVersion: 2 | null;
  readonly evidenceWindowAction: "unchanged" | "open" | "seal";
}
```

The duplicated payload `baseEventPosition` and `checkpointEventPosition`
retain the existing strict cross-bindings to the same fields inside
`CheckpointV2`. `SessionEndRequestedPayloadV2.requestVersion` must match the
stored Version 2 request. An `"open"` amendment requires
`finalCheckpointVersion: 2`; every amendment event is cross-checked against the
workflow's stored draft, window transition, and generation.

`decodeLifecycleEvent` dispatches on the outer event schema version.
Version 1 checkpoint events may contain only `CheckpointV1`; Version 2
checkpoint events may contain only `CheckpointV2`. All mixed or unsupported
outer/nested combinations fail closed. Session folds, repository reads, event
integrity, and lifecycle integrity consume `LifecycleEventV1 |
LifecycleEventV2` explicitly. A Version 2 request/amendment emits the matching
outer Version 2 event; Version 1 DTOs retain the unchanged outer Version 1
payload. Other semantic events continue to emit outer Version 1.

Create `src/orchestrator/storage/migrations/0003-qualified-checkpoint-coverage.ts`
and register it as project-store schema 3. Migration `0002-session-lifecycle`
remains byte-for-byte unchanged. Migration 0003 adds these explicit aggregate
columns and fixed-profile guards:

- `coverage_fingerprint_algorithm = 'hmac-sha256'`;
- `coverage_fingerprint_schema_version = 1`;
- `coverage_fingerprint_key_id`, equal to `fingerprint_key_id`;
- `coverage_fingerprint_domain = 'pm-evidence-coverage-v1'`; and
- `coverage_fingerprint_value`, exactly 64 lowercase hexadecimal characters.

Migration 0003 also creates immutable
`session_evidence_coverage_transitions`. Each compact row stores project,
session, adapter, batch ID/event position, batch bounds, the normalized
cumulative bounds/intervals, both profiles, previous/current coverage
fingerprints, new-frame count, fixed capture/nonretention flags, and creation
time. It stores no frame, `observedAt`, content fingerprint, body, or raw
evidence reference. Its primary/indexed lookup identifies one transition by
`(projectId, sessionId, adapterSessionId, batchEventPosition)` and makes batch
identity unique within that adapter namespace. Update and delete are forbidden.
The aggregate's latest batch/profile/cumulative/digest fields must byte-match
its indexed latest transition projection.

Migration 0003 additionally adds the nullable pair
`evidence_frozen_checkpoint_event_position` and
`evidence_frozen_generation`, lifecycle-only
`evidence_window_state: "open" | "sealed"`, and nullable
`final_ending_scope_bindings_json` to `workflow_instances`. The last column is
canonical JSON, at most 262,144 UTF-8 bytes, with this exact logical schema:

```ts
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
```

`decodeFinalEndingScopeBindingsV1` accepts only those exact keys, strict
canonical UUID/decimal/state values and kind-specific null groups, verifies the
canonical UTF-8 byte limit before returning a deeply frozen array, and never
falls back to a looser workflow-result decoder.

The array is sorted by canonical lowercase `childSessionId`, contains no
duplicate child, and is empty when the final checkpoint binds no child. A
row's `checkpointId` and `checkpointEventPosition` are both null or both
non-null. A `current-child` row has both ticket fields null and byte-matches its
checkpoint child-summary projection after omitting the extra indexed checkpoint
position. A `carry-forward-ticket` row has state `transferred`, non-null
checkpoint/ticket fields, `lastEventPosition` equal to
`transferTicketEventPosition`, and byte-matches the canonical transferred
child-summary projection defined above plus its immutable ticket/event row.
Every non-null `checkpointEventPosition` directly identifies the exact child
`SessionCheckpointRecorded` event whose body, session, checkpoint ID, and index
binding match; it is never recovered from the mutable latest-checkpoint pointer.

Non-lifecycle workflows keep all four new fields null; migrated session-end rows
start `sealed`. The frozen pair and binding JSON form one group: all are null
before a final checkpoint, or both pair members and the canonical JSON array are
non-null. Backfill derives the complete group from strict event/result,
checkpoint-summary, child-fold, and transfer-ticket bindings, never from an
assumed phase ordering. The quiesced preflight builds one linear
checkpoint-ID-to-event-position map from strict checkpoint events and persists
that position in every non-null child binding; it never performs a prefix scan
per workflow row. Missing, duplicate, or cross-session checkpoint identity is
ambiguous and fails closed. `requested` and `children-resolved` rows have a null
group. A row in the forward chain from `final-checkpoint-recorded` through
`completed` receives the strictly verified checkpoint position/generation and
scope bindings. `cancelled` and `abandoned` may have been reached on either side
of that boundary. Backfill verifies any earlier final before clearing every
`cancelled` row to sealed/null; an `abandoned` row receives the group if and
only if its retained history strictly binds a final checkpoint and complete
ending scope. Otherwise it remains null. Any ambiguous, incomplete, over-bound,
or contradictory history fails migration preflight.

The frozen group references a real Version 1 or Version 2 final-checkpoint event
and a current or historical workflow generation, and makes both the freeze and
its ending scope durable indexed facts rather than phase-text inferences. A new
final checkpoint requires a sealed window and replaces the whole group. An
authorized evidence-window `open` transition clears the group and blocks
final-checkpoint execution; `seal` leaves it null until the replacement final
checkpoint commits. Cancellation atomically clears the group and sets the
window sealed before the restored root or child may accept evidence. A
`cancelled` row is writable only in that sealed/null shape and is then ignored
by the evidence write gate; a genuinely reopened end request begins from the
same sealed/null shape under the existing generation-reset rules. An ordinary
`"unchanged"` amendment preserves the whole group even when it resets to a
pre-final phase, and terminal workflows remain protected by their existing
state gates.

Migration 0003 adds workflow insert/update triggers for these new columns;
migration-0002 guards cannot enforce them. The triggers require all four
columns null on non-lifecycle workflows, atomic frozen-group nullability and
canonical/bounded binding JSON, paired child checkpoint ID/event-position fields
with direct event/session/body cross-bindings, a real matching final-checkpoint
event/generation/scope for every non-null group, an open window with a null
group and a strict effective Version 2 final draft only before final-checkpoint
progress, a non-null group throughout active post-final progress, allowance for
a preserved historical group after an `"unchanged"` reset to a sealed pre-final
phase, and a sealed/null `cancelled` row. They admit only the specified
generation-fenced open, seal, final-freeze, cancel-clear, reopen/reset, and
unchanged-preserve transitions; every other raw-SQL rewrite aborts.

A lineage trigger forbids aggregate updates to project, session, adapter,
capture mode, zero lower bound, either fingerprint algorithm/schema/key/domain,
or `created_at`. `last_ordinal` and the normalized highest-contiguous value are
monotonic, and latest event position must advance. Only cumulative last/highest,
intervals, current coverage digest, latest batch linkage, and `updated_at` may
change. Key rotation therefore requires a new adapter ID. Insert/update guards
enforce the lifetime adapter and total-interval bounds by excluding the OLD
target row and adding the NEW row; a no-delete guard prevents slot reuse. A
project-scoped unique index on `adapter_session_id` prevents rebinding within a
project store. No cross-store UUID-uniqueness claim is made: the same UUID in a
different project store is a distinct provider-scoped namespace. Application
checks still produce the stable public errors before these defense-in-depth
guards fire.

The event insert guard is scoped only to lifecycle session-stream rows. In that
scope it permits `EvidenceCoverageRecorded` only at outer Version 2; permits
`SessionCheckpointRecorded` only as matching outer/nested `1/1` or `2/2`;
permits `SessionEndRequested` and `SessionEndAmended` only with their matching
Version 1 or Version 2 payloads; and requires outer Version 1 for every other
current lifecycle event. Generic event-core streams retain their existing
contract accepting any positive event schema version.

No supported writer has emitted schema-2 evidence or populated its coverage
tables. Before applying 0003, a quiesced
`QualifiedCheckpointMigrationPreflight` in `ProjectStoreUpgradeService` must
verify:

- both schema-2 coverage tables are empty and every lifecycle
  `EvidenceCoverageRecorded` event is absent;
- every existing lifecycle event satisfies the Version 1 matrix and every
  Version 1 checkpoint is coverage-empty;
- every existing session-end workflow has a strict phase/result binding from
  which the sealed window and complete frozen group, when one exists, can be
  derived;
- unrelated generic event-core versions are ignored; and
- every existing live session satisfies the conservative minimal Version 2
  checkpoint and 262,144-byte canonical ending-scope-binding capacity bounds,
  including prospective carry-forward ticket representations.

The upgrade maintenance fence prevents a write between preflight and migration.
The static migration SQL rechecks the evidence/lifecycle conditions atomically
using a temporary guard table, trigger, and probe because top-level SQLite
`RAISE()` is invalid outside a trigger; it drops the temporary objects before
return. Any preflight or SQL-guard failure maps to
`MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED`, leaves schema version 2 untouched,
and never guesses a legacy digest or rewrites an event. The operator must use a
schema-2 runtime to resolve excessive active children, or restore/export an
unsupported store, before retrying the upgrade.

Adding migration 0003 also renames the hard-coded upgrade fault boundary
`after-0002-ddl-before-migration-row` to the version-neutral
`after-target-ddl-before-migration-row` and updates all rollback/fault tests.

Schema-3 writers continue to emit outer Version 1 where the matrix above
requires it. Their only permitted outer Version 2 lifecycle forms are the four
listed above; evidence recording always uses its Version 2 form. Older binaries
see schema 3 and fail with `SCHEMA_TOO_NEW` before reading Version 2 events. New
binaries must complete migration 0003 before enabling any Version 2 writer;
there is no rollback-to-schema-2 promise after a Version 2 event commits.

## 6. Bounds, lifetime, and checkpointability

The authoritative bounds are:

- at most 200 adapter sessions over the lifetime of one lifecycle session;
- at most 200 missing intervals across all current adapter aggregates, while
  the existing per-adapter 200-interval guard remains;
- at most 196,608 canonical UTF-8 bytes for the complete
  `CheckpointEvidenceCoverageV2` subdocument;
- at most 262,144 canonical UTF-8 bytes for the complete enriched checkpoint;
- at most 262,144 canonical UTF-8 bytes for
  `final_ending_scope_bindings_json`; and
- all existing UUID, signed-64-bit ordinal/position, timestamp, 128-scalar key
  ID, fingerprint, path, scalar, and list bounds.

Adapter aggregate rows never retire, so 200 is a lifetime limit, not a
concurrent-connection limit. `adapterSessionId` is a canonical opaque UUID and
must not encode user content, credentials, tenant names, or secrets. Key IDs
and the fixed schema/domain values are bounded nonsecret metadata. One adapter
ID binds to exactly one session and immutable profile within one project store;
the same UUID in another project store is a distinct namespace.

Inside the serialized evidence transaction, `prepareBatch` computes:

```text
prospectiveAdapters = currentAdapterCount + (targetRowExists ? 0 : 1)
prospectiveIntervals =
  currentTotalIntervals - targetPriorIntervals + targetProspectiveIntervals
```

It then canonicalizes the prospective coverage subdocument from at most 200
aggregate rows and 200 intervals. For the not-yet-allocated target event
position it uses a 19-digit signed-64-bit placeholder, unless the append planner
already supplies the exact position. This is a conservative upper bound and
does not scan ordinal rows. A 201st adapter, 201st total interval, or byte-cap
violation fails before append. `persistPrepared` rechecks the actual committed
position before writing; any disagreement rolls back the whole transaction.

The 196,608-byte cap nominally reserves 65,536 bytes, but that reservation alone
is not treated as proof because the number of relevant child summaries is not a
fixed constant. `prepareBatch` must also build a conservative
`minimumCheckpointUpperBound` from the prospective coverage, a minimal valid
draft, every policy-derived ending-scope binding, and maximum-width
server-derived identity, source-state, child-checkpoint/event,
carry-forward-ticket, and decimal-position fields. Each current child reserves the larger of its
possible live-summary and carry-forward-ticket representation. It rejects the
batch when that upper bound exceeds 262,144 bytes, even if the coverage
subdocument alone fits. It separately builds
`minimumFinalEndingScopeBindingsUpperBound` from the same prospective child and
ticket projections and rejects when the canonical binding array could exceed
262,144 bytes. Passing one estimator never substitutes for passing the other.

For an unknown string bounded to `n` Unicode scalars, the conservative JSON
string budget is exactly `2 + (6 * n)` UTF-8 bytes: two quote bytes and the
six-byte `\uXXXX` worst case per scalar. Known strings use their actual
canonical UTF-8 length. UUID/hash/enum widths are fixed, every future positive
SQLite position reserves 19 digits, and a nullable future child checkpoint ID
reserves both the UUID and its paired 19-digit checkpoint event position rather
than `null`. Tests cover quotes, backslashes, control characters, and non-BMP
input so the estimator can never undercount the canonical serializer.

Every child-authority creation path performs the symmetric check with the
prospective relevant-child set and current root coverage. `fork-child` adds the
new child; `claim-child-transfer` folds both the old child's terminal transfer
state and the replacement child rather than temporarily double-counting them.
The session-end suspend-and-carry-forward path prospectively replaces each live
child reservation with its exact ticket binding. These checks occur before
append, child/ticket UUID generation, authority insertion, or ticket mutation.
All other child-summary and ticket-binding fields are already reserved at their
maximum width, so later child state, checkpoint ID, stream version, event
position, or transfer representation cannot exceed the reservation. These
state-growing paths preserve the invariant that a successful command leaves at
least one minimal mandatory Version 2 checkpoint representable. User-authored
draft content shares the complete cap and may still need to be reduced.
`decodeCheckpointV2` checks both the coverage subdocument and the final fully
enriched body after source state and child summaries are added;
`decodeFinalEndingScopeBindingsV1` checks the independently persisted baseline.
Exact-limit passes; limit-plus-one has zero persistent effect.

## 7. Transaction and snapshot ordering

`ConnectionBoundEvidenceCoverage` is no longer empty. It exposes synchronous,
connection-bound operations for:

- bounded `assertQuickHealthy` and Version 1 eligibility;
- read-only `prepareBatch`;
- `persistPrepared(prepared, committedEvidenceEvent)` after the exact committed
  event exists;
- read-only `snapshotV2(sessionId, baseEventPosition)` from aggregates; and
- conservative `minimumCheckpointUpperBound` and
  `minimumFinalEndingScopeBindingsUpperBound` checks shared with every
  child-authority creation and carry-forward path.

`LifecycleCommandStore.execute` also receives a central fresh-integrity port
that derives the exact affected session IDs from the trusted semantic envelope.
Its mandatory order is:

1. `BEGIN IMMEDIATE`;
2. exact command replay and immediate return on a match;
3. command/idempotency identity and append-allowed validation;
4. for a fresh evidence-batch command,
   `assertEvidenceWindowWritable(targetSessionId)`;
5. bounded quick evidence health for every affected existing session;
6. the fresh semantic callback;
7. event append and connection-bound post-append writes;
8. deduplication insert and commit.

`assertEvidenceWindowWritable` is a central transaction-bound gate, not an
implementation detail of `prepareBatch`. It strictly reads the target
`session_authority` row and obtains the ending root in constant time: the
target session ID for a root, or its immutable `parent_session_id` for a child.
It then reads the deterministic `session-end/{rootSessionId}` workflow through
the indexed `(project_id, workflow_id)` key. Absence of a matching workflow row
permits the write. A `cancelled` row must be sealed with a null frozen group or
the gate returns `INTEGRITY_FAILURE`; in its valid shape it is ignored because
cancellation restored the root, and only a later end request may reopen that
same row at a fenced generation. Normal append-allowed validation has already
rejected an ended or abandoned target.

For every other session-end row, the gate first strict-decodes the bounded
window/group metadata and binding JSON without performing current-state
freshness. A valid complete non-null frozen group returns
`SESSION_END_EVIDENCE_FROZEN`. A null group is writable only while the window is
`open`, or while it is `sealed` in a phase strictly before
`final-checkpoint-recorded`. A malformed binding, half-null pair, disagreement
between the pair and binding JSON, an open window at or beyond the
final-checkpoint phase, or a sealed row at or beyond that phase without its
frozen group is `INTEGRITY_FAILURE`. The gate runs before coverage quick health,
the evidence provider, the coverage repository, UUID generation, and batch
preparation. Exact committed replay remains earlier than the gate and therefore
never depends on the current workflow window.

Root start is a no-op for step 5 because its session does not exist yet. If a
fresh callback server-resolves an additional descendant, it must register and
quick-check that exact session before any semantic write. No fresh lifecycle
mutation bypasses this hook. Exact replay deliberately precedes current-state
health, version, provider, repository, source-state, and UUID work.

For evidence recording, the callback runs read-only `prepareBatch`, appends one
`EvidenceCoverageRecorded` Version 2 event, and calls `persistPrepared` with its
exact committed event. `prepareBatch` starts only from an aggregate that quick
health has matched to its immutable latest compact transition, compares only
incoming ordinals/frame IDs, updates the bounded interval set, and hashes only
genuinely new frames. `persistPrepared` first requires the committed
type/schema/batch/cumulative projection to byte-match the frozen prepared plan,
then atomically writes one immutable compact transition, the aggregate, and the
new immutable ordinal rows in the order below. A fault at any point rolls all
of them and the event back.

After the event append, persistence orders writes as compact transition,
aggregate insert/update, then immutable ordinal rows. The transition references
the exact event and session authority; any transition-to-aggregate foreign key
is `DEFERRABLE INITIALLY DEFERRED`, so the transition can precede the first
aggregate. Updating/inserting the aggregate before ordinal rows satisfies the
existing immediate fingerprint-to-aggregate foreign key. No intermediate order
is externally visible, and a dedicated first/later-batch fault test at every
boundary proves that event, transition, aggregate, and ordinals either all
commit or all disappear.

For a checkpoint, the version gate and `snapshotV2` run before source capture,
UUID generation, or other enrichment. Snapshotting reads at most 200 aggregate
rows, their indexed latest compact transitions, and 200 total intervals. It
strict-decodes profiles and storage sentinels, requires byte equality between
every aggregate cached field and its transition projection, checks event
metadata linkage and
`latestBatchEventPosition <= baseEventPosition`, checks historical-key status
for each distinct recorded profile, sorts the entries, and returns one frozen
object. It never reads `session_evidence_fingerprints`, recomputes a HMAC, or
decodes the latest event's frame array.

The checkpoint event is then appended and the checkpoint index/marker updated
through the existing post-append compare-and-swap path. Root, child, root
suspension, and final checkpointing share this one version-aware preparation
path. No service fabricates an empty list when verified aggregate rows exist.

## 8. Versioned fingerprint, DTO, and repository boundaries

Checkpoint fingerprinting uses these exact byte contracts:

```text
CheckpointV1 (unchanged):
lowerhex(SHA-256(UTF8("project-memory/checkpoint/v1\n" || canonicalJson(checkpoint))))

CheckpointV2:
lowerhex(SHA-256(UTF8("project-memory/checkpoint/v2\n" || canonicalJson(checkpoint))))
```

Each newline is one LF byte. Repository and integrity code dispatch exactly
once on `checkpointVersion`; they never try both domains and never rewrite an
old index. Independent fixed vectors cover Checkpoint V1, Checkpoint V2, and
the cumulative coverage HMAC.

Versioning must propagate through every binding boundary:

- preserve `CheckpointRecordedResultV1`; add `CheckpointRecordedResultV2` and
  a discriminated result union;
- preserve `SessionEndRequestV1` and `SessionEndAmendmentV1`; add strict
  `SessionEndRequestV2`/`SessionEndAmendmentV2` requiring
  `CheckpointDraftV2`;
- preserve `RootSuspendCommandV2`, `RecordCheckpointCommandV2`,
  `RequestSessionEndCommandV2`, and `AmendSessionEndCommandV2`; add
  `RootSuspendCommandV3`, `RecordCheckpointCommandV3`,
  `RequestSessionEndCommandV3`, and `AmendSessionEndCommandV3` for the Version 2
  nested DTOs, then dispatch same-name operations on the nested discriminator;
- make `SessionAuthorityRepository.latestCheckpoint`, checkpoint age/risky
  transition guards, diagnostics, fixtures, and replay-result decoding return
  the versioned union;
- add Version 2 variants for `SemanticSessionEndAction`, internal final
  checkpoint action, root-suspension preparation, and lifecycle intent witness;
  and
- include the nested checkpoint/request version in candidate and authoritative
  intent hashes, worker request/result tags, and deterministic internal command
  identity.

The result and session-end shapes are normative:

```ts
export type CheckpointRecordedResultV2 =
  Omit<CheckpointRecordedResultV1, "checkpointVersion"> & {
    readonly checkpointVersion: 2;
  };
export type CheckpointRecordedResult =
  CheckpointRecordedResultV1 | CheckpointRecordedResultV2;

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
```

The safe session-end status/result and Task 13 worker codec carry
`SessionEndEvidenceWindowStatusV2`, so a caller can distinguish “submit
evidence,” “seal the window,” and “amend a stale final checkpoint” without
receiving provider/key material.

`SemanticSessionEndActionV2` and the Version 2 internal final-checkpoint action
carry `CheckpointV2`; they do not widen an action declared as Version 1.

A fresh Version 1 checkpoint path after target-session coverage fails the
version gate. For a Version 1 end request, or a Version 1 amendment that
supplies or retains a Version 1 final draft, the gate reads the root and the
exact policy-derived ending scope: every current relevant child plus every
carry-forward ticket binding retained by that workflow generation. Any coverage
artifact anywhere in that scope fails with zero event/workflow effect.
Root-clean plus child-covered is not eligible. An exact replay of an older
Version 1 command still returns its stored Version 1 result before that gate.
Reusing its command or idempotency identity with Version 2 input is
`IDEMPOTENCY_CONFLICT`, not an upgrade.

The gate covers record-checkpoint, root suspension, end request/amendment, and
internal final-checkpoint execution. If evidence is recorded after a Version 1
end workflow was requested, that workflow cannot silently finalize its stored
Version 1 draft. It requires `SessionEndAmendmentV2` with a non-null
`CheckpointDraftV2`; a null Version 2 amendment is legal only when the workflow
already stores a Version 2 final draft. The coordinator returns
`CHECKPOINT_EVIDENCE_VERSION_REQUIRED` without advancing phase until that
durable amendment exists.

Evidence becomes generation-frozen when an ending workflow commits
`final-checkpoint-recorded`. The freeze covers the root and every descendant
whose stream state is summarized or otherwise bound by that final checkpoint.
A fresh evidence command in that scope fails before provider/repository access
with `SESSION_END_EVIDENCE_FROZEN`; an exact replay of evidence committed before
the freeze still returns first.

`CheckpointService.recordFinal` sets the frozen checkpoint position/generation
in the same semantic transaction as the checkpoint event and workflow phase.
An ordinary manual checkpoint, including the pre-seal checkpoint described
below, never sets or clears this workflow freeze.

Before appending a root final checkpoint, `recordFinal` also constructs the
exact ending-scope child-binding set under that transaction. It is the canonical
union of (a) every current relevant child represented by an authoritative child
summary and (b) every immutable carry-forward ticket retained by this workflow
generation, even though its source child is now terminal `transferred` and no
longer appears in the current relevant-child query. The checkpoint's child
summaries must represent that union exactly, using the canonical transferred
summary encoding for every ticket. The
`final_ending_scope_bindings_json` column persists the corresponding canonical
binding set beside the final-checkpoint position/generation so later gates can
compare it without guessing from current child state or a rewritten phase
result.

For a summary binding, the child's folded state, event position, stream version,
and latest-checkpoint identity must equal the summary, and the binding's
checkpoint event position must equal the current authority/index position at
baseline creation. For a carry-forward binding, the ticket's project, root,
source-child, ticket ID, checkpoint ID, created event position, linked
`ChildWorkTransferCreated` event, and terminal source-child fold must all match.
Every non-null checkpoint pair resolves by direct global event-position lookup
and cross-checks its child/session/checkpoint ID before coverage comparison. No
latest checkpoint is allowed only for a coverage-clean summary binding; a
Version 1 referenced checkpoint requires coverage-clean; and a Version 2
referenced checkpoint's qualified adapter snapshot must byte-equal that child's
current quick-healthy aggregate/transition snapshot. A ticket always has its
non-null referenced checkpoint pair. Thus child evidence committed
before the root final checkpoint cannot be hidden behind an older child
checkpoint or disappear merely because carry-forward made the child terminal.
Any baseline mismatch returns `SESSION_END_COVERAGE_CHANGED` before checkpoint,
phase, or outbox mutation.

`SessionEndAmendmentV2.evidenceWindowAction` supplies an explicit two-step
reopen protocol:

- `"open"` is legal only as a `sealed`-to-`open` transition with a non-null
  `CheckpointDraftV2`. It increments the workflow generation, fences prior
  coordinator/outbox/validation work, clears
  final-checkpoint and validation bindings, clears the frozen group, sets the
  window open, and resets to `children-resolved` (or an earlier phase required
  by other fields). The coordinator must not record a final checkpoint while
  open, so one or more evidence batches can commit without racing it. An open
  row already at `children-resolved` is ineligible for both `claimNext` and
  `scanRecoverable`; their indexed eligibility predicate omits it. An open row
  reset earlier may be claimed only to finish prerequisite child resolution,
  then becomes waiting at `children-resolved`. As defense in depth, the
  in-transaction final-checkpoint action rechecks the latch and returns
  `SESSION_END_EVIDENCE_WINDOW_OPEN` with no phase, event, outbox, attempt, or
  failure-counter effect.
- `"seal"` is legal only for an open window whose stored final draft is Version
  2. It increments/fences the generation, closes the window, and permits the
  coordinator to record the replacement final checkpoint. The existing risky
  amendment rule still requires a current pre-transition Version 2 checkpoint:
  the caller records that ordinary checkpoint after its last intended evidence
  batch while the window is open. Any descendant that received evidence first
  records its own Version 2 checkpoint; the root pre-transition checkpoint and
  the seal guard require the exact ending-scope binding set and the same
  per-child/ticket coverage equality used by `recordFinal`. That ordinary root
  checkpoint does not close/freeze the window. Evidence racing after it makes
  the seal's checkpoint-base assertion stale and forces a retry. After a
  successful seal, root evidence racing the final checkpoint is serialized:
  evidence-first is included directly; checkpoint-first restores the freeze and
  rejects the evidence. Descendant evidence-first instead makes that child's
  referenced checkpoint stale, so `recordFinal` returns
  `SESSION_END_COVERAGE_CHANGED` with zero effect until a fresh child Version 2
  checkpoint exists; retry then includes it. Final-checkpoint-first freezes the
  descendant and rejects its evidence as usual.
- `"unchanged"` preserves the window/frozen group and retains ordinary amendment
  semantics. It cannot accidentally reopen evidence even if other fields reset
  the workflow to an earlier phase.

Every open row's effective stored final draft is strictly Version 2. A Version
1 amendment with a non-null Version 1 final draft is rejected while open with
`CHECKPOINT_EVIDENCE_VERSION_REQUIRED`; a null Version 1 amendment can only
preserve the existing Version 2 draft and acts as window `"unchanged"`. The
service, workflow trigger, and quick/full integrity all enforce this invariant,
so an open latch cannot be stranded with a draft that `"seal"` cannot accept.

Both `"open"` and `"seal"` fence all prior-generation coordinator owner/token
actions, validation-attempt planning and result/pass acceptance, and claimed
outbox materialization/acknowledgement. A stale fresh action has no phase,
artifact, outbox acknowledgement, attempt, or failure effect. Exact replay of
an already committed old-generation action remains idempotent, while the newer
amendment materialization revision is authoritative and cannot be overwritten
or acknowledged by the stale claim.

This explicit open/seal latch prevents the coordinator from immediately
recapturing a checkpoint before the caller can submit the intended evidence.
The action is committed by candidate/authoritative intent and the Version 2
`SessionEndAmended` event; the workflow row never changes it silently.

Defense in depth remains mandatory even with the write freeze. Before starting
validation, accepting verification pass, and appending `SessionEnded`, the
coordinator calls bounded `assertFinalCheckpointCoverageFresh`. It quick-checks
the root authority/fold and requires its current latest-checkpoint ID, event
position, body fingerprint, and index to remain the exact workflow-bound final
checkpoint and frozen position. Its checkpoint-required reason/event-position
pair must also be both null; ownership recovery or any other risky transition
after final therefore makes the final baseline stale. A later manual checkpoint
may clear that marker but changes the latest-checkpoint binding and still
requires a session-end amendment. It also quick-checks the root
aggregate/transition state and requires exact equality with the final
checkpoint's qualified adapter list and latest batch identities/positions. It
also reconstructs the canonical ending-scope binding set and rejects any extra,
missing, or changed current-child or carry-forward-ticket binding relative to
the persisted final baseline. Every child summary and immutable ticket/event
identity must still satisfy the rules above, and every referenced checkpoint
must still match that child's current quick-healthy coverage snapshot. For a
Version 1 root final checkpoint, the entire ending scope, including every
carry-forward ticket's source child, must instead remain coverage-clean. A
Version 2 comparison also checks `available` status once per distinct recorded
profile; unavailability returns `EVIDENCE_HISTORICAL_KEY_UNAVAILABLE` with no
phase/event/outbox effect. Any equality mismatch returns
`SESSION_END_COVERAGE_CHANGED`, likewise makes no phase/event/outbox effect, and
requires a Version 2 amendment that invalidates the stale final checkpoint. Use
the open/seal protocol when more evidence must be submitted before replacement.
`BEGIN IMMEDIATE`, workflow-generation CAS, and this comparison make
evidence-versus-final-checkpoint races one-winner across processes.

## 9. Storage sentinel and integrity

The logical coverage range always begins at ordinal zero. Storage writes
`first_ordinal = 0` in both the aggregate and compact transition. When ordinal
zero has not been captured, both store `highest_contiguous_ordinal = -1`;
strict row decoding maps only that sentinel to public JSON `null`. When ordinal
zero exists, the stored value is nonnegative and maps to its decimal string.
Public events, checkpoints, results, and intents never contain `-1`, and
integrity comparisons normalize the storage sentinel before comparing logical
state.

Quick integrity is bounded. It verifies:

- adapter count, total interval count, and coverage-subdocument byte cap;
- the conservative minimum-checkpoint upper bound for current coverage and
  policy-derived ending-scope bindings;
- strict aggregate shape, zero lower bound, sentinel rules, canonical interval
  JSON, fixed frame/coverage profiles, and lowercase digest shape;
- byte equality of every aggregate cumulative/profile/digest/latest-batch field
  with its indexed immutable latest transition, plus linkage from that
  transition to an event row with the same project, session, event type, and
  outer schema version, without decoding frames;
- session-end window/frozen-group shape and generation; canonical, bounded, and
  strictly decoded `final_ending_scope_bindings_json`; byte equality with the
  linked final checkpoint's child summaries after projecting each binding;
  every carry-forward ticket/event, event-time child fold, referenced
  checkpoint resolved by its stored global event position, and indexed immutable
  transition snapshot at the frozen checkpoint base; a strict Version 2
  effective draft for an open window; and
  the open-window prohibition on final-checkpoint/validation progress; and
- strict checkpoint body/order/bounds plus checkpoint index/event/body/hash
  agreement for either checkpoint version.

Quick mode does not recompute a coverage HMAC, scan immutable ordinal rows,
decode/compare the event's frame-bearing payload, or reconstruct a historical
checkpoint snapshot. The immutable compact transition prevents a shape-valid
aggregate mutation from becoming a newly signed successor or checkpoint, while
full mode remains responsible for proving that projection against the event and
ordinal history.

Both integrity modes validate a frozen group at its recorded event-time
baseline. They do not require it to equal current mutable authority folds,
latest-checkpoint indexes, checkpoint-required markers, ticket claim state, or
coverage aggregates. Legal later work, an `"unchanged"` pre-final reset, or a
cancel-then-evidence sequence may make an old final baseline stale without
making storage corrupt. Only the three
`assertFinalCheckpointCoverageFresh` gates perform current-state equality and
map a stale active final to `SESSION_END_COVERAGE_CHANGED`.

Full integrity additionally performs one advancing replay over ordered evidence
events, compact transitions, immutable ordinal rows, and checkpoints. It does
not rescan an ordinal prefix for each event or checkpoint. It:

- validates every Version 2 batch's frame bounds and immutable overlap;
- advances zero-based first/last/highest/missing state from prior intervals and
  genuinely new rows with bigint adjacency, never a numeric range loop;
- recomputes each rolling accumulator once from the prior digest and that
  event's genuinely new frames through provider-scoped historical-key lookup,
  then compares ordinal rows, transition projection, event payload, aggregate,
  and checkpoint entry;
- enforces adapter, total-interval, byte, and profile invariants at every
  historical evidence transition, not only at the latest aggregate;
- reconstructs each historical Version 2 adapter list at its base and compares
  the complete ordered snapshot byte-for-byte;
- replays Version 2 request/amendment window actions, workflow generations,
  final-freeze/unchanged-preserve/cancel-clear/reopen transitions, frozen
  groups, and validation/pass/completion freshness witnesses; reconstructs every
  historical ending-scope baseline from checkpoint summaries, event-time child
  folds, transfer events/tickets, and directly bound child checkpoint event
  positions; permits
  later legal state/coverage evolution; and proves legacy migration backfill
  would yield the same canonical binding JSON; and
- rejects a Version 1 checkpoint committed after any earlier coverage state,
  while leaving earlier Version 1 checkpoints valid.

The full pass is `O(lifecycleEvents + eventFrameEntries + immutableOrdinalRows +
transitions + checkpoints + endingScopeBindings + transferTickets)`. It may
hold one identity map for the immutable ordinal rows, but it never serializes or
rescans all prior frames to verify the next transition.

Missing historical key material returns
`EVIDENCE_HISTORICAL_KEY_UNAVAILABLE`; mismatches produce
`SESSION_EVIDENCE_COVERAGE_MISMATCH` or `INTEGRITY_FAILURE` at the existing
boundary. No integrity path repairs an aggregate, event, checkpoint, index, or
fingerprint.

## 10. Compatibility and rollout

Version 1 production MCP behavior remains unchanged and authoritative.
Lifecycle Version 2 remains unregistered in the production composition root,
and schema migration alone does not enable routing.

Task 13's worker codec supports both strict checkpoint/request versions and
both stored checkpoint-result versions without exposing bearer material.
Tasks 14 and 15 consume the strict union. A Version 1 end request may produce a
Version 1 final checkpoint only while the complete ending scope is
coverage-clean; Version 2 is required as soon as coverage exists. A historical
Version 1 checkpoint may still guard resume or another risky transition.

Task 14 owns the durable evidence freeze/open/seal generation transitions, and
Task 15 owns the coverage/child-summary freshness assertions at validation, pass,
and terminal completion. Neither task may treat source-state freshness as a
substitute for evidence freshness.

Task 16 decodes and renders both checkpoint versions. It preserves the sorted
qualified adapter list but never renders or materializes frames, per-ordinal
content fingerprints, `observedAt`, or raw evidence. Task 17 keeps the enabled
Version 1 production/shadow mapping as pass-through only; it neither downgrades
nor synthesizes a Version 2 checkpoint while lifecycle Version 2 routing is
disabled. Task 19 proves that the new migration, codecs, and worker seams do
not enable primary-mode behavior.

Subproject 4 may add retained encrypted evidence only through a later
checkpoint/evidence version. It must not reinterpret Version 1 or Version 2
coverage-only state as retained evidence.

## 11. Stable failures

Task 12 adds these safe, nonretryable lifecycle failures and recovery actions:

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

The existing `EVIDENCE_COVERAGE_TOO_FRAGMENTED` remains nonretryable with
`reduce-evidence-fragmentation`. Corruption remains fail-closed with
`run-integrity-recovery`. `MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED` is an
internal schema-upgrade failure, not a semantic lifecycle response.

## 12. Rejected alternatives

### Union adapter ordinals

Rejected because adapter ordinals are independent namespaces. Unioning can turn
two incomplete streams into an apparently contiguous stream.

### Select the latest adapter session

Rejected because latest event position is not an authority mapping and would
silently omit other committed coverage.

### Add a trusted active-adapter mapping

Rejected for this subproject because no such lifecycle authority exists. It
would add a new ownership state machine while discarding nonselected coverage.

### Keep outer event Version 1 and evolve only nested bodies

Rejected because the current strict Version 1 decoder embeds `CheckpointV1`
and the old evidence payload has different batch-bound semantics. Silent nested
evolution would break old readers without a store-level compatibility fence.

### Recompute coverage during every checkpoint

Rejected because immutable ordinal history is unbounded and semantic write
transactions must stay short. The aggregate caches the digest; full integrity
owns historical recomputation.

### Flat-HMAC every cumulative frame after each batch

Rejected because gap filling permits insertion before existing ordinals. A flat
HMAC would force every evidence command to reread and serialize all prior rows
inside `BEGIN IMMEDIATE`, and historical verification would become quadratic.
The rolling accumulator authenticates only new frames against the prior digest
and prospective summary.

### Keep every fresh checkpoint at Version 1

Rejected because one unqualified object cannot identify or audit multiple
adapter-local coverage states.

## 13. Required tests

The amended implementation plan must require at least:

- unchanged strict Version 1 decoder/hash vectors and strict Version 2
  draft/checkpoint/event/result/request/amendment decoding, plus strict
  `FinalEndingScopeBindingV1` canonical JSON decoding and paired nullable
  checkpoint-ID/event-position rejection;
- outer/nested version matrices, including rejection of every unsupported
  event/checkpoint combination and old-reader `SCHEMA_TOO_NEW` fencing;
- migration-3 quiesced preflight and SQL guard, atomic failure on unsupported
  schema-2 evidence, coverage-bearing Version 1 checkpoints, or over-capacity
  legacy sessions, while unrelated generic outer-Version-2 events survive;
- event/result-derived backfill fixtures for pre-final and every forward
  post-final phase; cancelled rows cleared after verification of any historical
  final; abandoned rows both with and without a strictly bound final checkpoint;
  one-pass checkpoint-ID/event-position mapping; exact reconstructed
  ending-scope binding JSON; and rejection of missing, duplicate, cross-session,
  incomplete, over-bound, or ambiguous history;
- fixed aggregate/transition columns, project-scoped adapter uniqueness,
  immutable lineage/transition/no-delete guards, correct OLD/NEW cross-row
  formulas, the version-neutral upgrade fault boundary, and unchanged migration
  0002 checksum;
- raw-SQL workflow-trigger tests for non-lifecycle nulls, frozen-group atomicity
  and event/generation binding, binding-JSON canonicality/262,144-byte bound,
  child-summary/ticket/event/checkpoint-ID/checkpoint-position cross-binding,
  open/pre-final and sealed/post-final phase shapes, strict Version 2 effective
  drafts for open rows, and only the authorized open, seal, final-freeze,
  cancel-clear, reopen/reset, and unchanged-preserve transitions;
- separate batch versus cumulative bounds, including first captured ordinal
  above zero and the storage `-1` to public `null` mapping;
- fixed rolling-accumulator vectors for first, mixed overlap/new, gap-fill, and
  zero-new batches; identical overlap preserving both digest and provider-call
  count; partial overlap hashing only new frames; history-sensitive batching;
  exact provider scope/purpose/key/domain-NUL framing; domain separation from
  frame fingerprints; historical key success/unavailability during later
  batches, snapshots, all three final gates, and full integrity; distinct-profile
  status-call counts; and caller-buffer cleanup on provider error;
- instrumentation proving `prepareBatch` reads only incoming ordinal/frame-ID
  matches plus bounded aggregate intervals and never scans prior frame history;
- deterministic adapter ordering and rejection of reordered, duplicate, or
  unqualified entries;
- independent overlapping ordinals across two adapters without unioning;
- empty, 200, and 201 lifetime adapter boundaries, including key rotation;
- 200 versus 201 total missing intervals across adapters and the prospective
  replace-target formula;
- exact 196,608-byte coverage and 262,144-byte enriched-checkpoint boundaries,
  exact 262,144-byte final-ending-scope baseline boundary, limit-plus-one
  rollback, dynamic minimum-checkpoint upper bounds with many children, and
  symmetric evidence-batch/fork/transfer-claim/session-end carry-forward
  capacity enforcement;
- connection-bound prepare/persist/snapshot operations and fault rollback after
  event append but before ordinal/transition/aggregate persistence;
- exact replay before quick health, provider, repository, snapshot, source
  capture, or UUID access;
- transaction-order tests for `assertEvidenceWindowWritable`: constant-time
  root/child-to-workflow lookup, no-workflow and cancelled-row allowance,
  open and sealed-pre-final allowance, frozen-root and frozen-descendant
  rejection before coverage/provider/UUID access, malformed
  window/pair/binding/phase integrity failure, and exact pre-freeze replay
  before the gate;
- central quick-health blocking for fresh mutations, including raw cross-row
  bound/profile/link corruption and a shape-valid aggregate mutation that no
  longer matches its immutable latest transition;
- root, child, suspension, transfer/risky guard, and final Version 2 checkpoint
  paths through one preparation service; exact canonical transferred-child
  summary encoding, ticket-ID recovery through its bound transfer event, and
  direct referenced-checkpoint lookup through the stored checkpoint event
  position;
- Version 1 fresh-checkpoint rejection after any coverage artifact, historical
  Version 1 validity, exact Version 1 replay after later coverage, and
  cross-version idempotency conflict;
- Version 1 end request followed by evidence, blocked finalization, mandatory
  non-null Version 2 amendment, advertised amend-or-cancel recovery, and
  successful Version 2 continuation, with immediate zero-effect rejection when
  the root is clean but a current or carry-forward child has coverage;
- root and descendant evidence racing the final checkpoint in both commit
  orders; root evidence-first direct inclusion; descendant evidence-first
  zero-effect final rejection followed by a fresh child Version 2 checkpoint
  and successful retry; frozen evidence after final checkpoint, after
  validation, and immediately before completion;
  exact pre-freeze evidence replay; descendant-scope freeze; and explicit
  evidence-window open/seal generation fencing, multiple batches while open,
  sealed-to-open-only enforcement, rejection of a non-null Version 1 draft
  downgrade while open, null Version 1 amendment preserving the Version 2
  effective draft, `claimNext`/`scanRecoverable` exclusion at open
  `children-resolved`, bounded
  prerequisite progress before that phase, coordinator refusal while open with
  zero attempt/failure effect, current pre-transition checkpoint required for
  seal, evidence-after-that-checkpoint staleness, and a replacement final
  checkpoint after seal;
- after both `open` and `seal`, stale-current-generation cases for coordinator
  owner/token actions, validation attempt/result persistence and pass
  acceptance, and claimed outbox materialization/acknowledgement; old fresh work
  is fenced with zero phase/file/outbox-ack effect, old exact committed replay
  remains idempotent, and the newer amendment materialization revision wins;
- cancel-after-final clearing the frozen group, restored root/child evidence,
  quick and full integrity success, and a later Version 2 end request, plus an
  `"unchanged"` amendment that preserves a historical group while resetting
  pre-final, permits legal later state movement, and replaces the group at the
  next final checkpoint;
- freshness rechecks at validation start, verification pass, and `SessionEnded`
  for exact root latest-checkpoint ID/event position/body/index binding, a manual
  root checkpoint after final, ownership recovery after final setting a
  checkpoint-required marker, a subsequent manual checkpoint still requiring
  amendment, root adapter state, zero-new latest-batch movement, and child
  summary event/stream/latest-checkpoint movement; exact ending-scope binding
  equality; a later child checkpoint replacing the mutable authority index while
  quick integrity still resolves the old frozen checkpoint by its stored event
  position;
  immutable carry-forward ticket/event/child/checkpoint bindings; and each
  referenced child's latest-checkpoint coverage versus its current
  aggregate/transition snapshot, including a carry-forward child with Version 2
  coverage, Version 1 rejection for that scope, child evidence committed before
  the root final checkpoint, and evidence committed after it, with zero
  phase/outbox effect on mismatch;
- linear single-pass historical full integrity for transition, aggregate,
  ordinal, event, adapter ordering, global bounds, byte cap, checkpoint snapshot,
  ending-scope baseline/ticket/backfill tampering, and accumulator/hash
  tampering, with visit/provider-call counts that kill a prefix-rescan or
  quadratic implementation;
- Task 13 worker round trips for both versions; Tasks 14-15 Version 2 final
  checkpointing; Task 16 privacy-preserving rendering; and Task 17/19 disabled
  production isolation; and
- `requireFullEvidence` rejection even when every adapter is contiguous.

## 14. Implementation-plan impact

Task 12 now owns the Version 2 checkpoint/evidence contracts, migration 0003,
coverage HMAC, bounded aggregate snapshot, prospective global/byte bounds,
the strict `FinalEndingScopeBindingV1` codec and storage guards, central
fresh-integrity hook, and version-aware checkpoint service in addition to the
original immutable ordinal repository. Its file inventory must include:

- checkpoint, event, command, session-end, error, intent-witness, and fixture
  contracts;
- migration registry/schema compatibility, migration runner,
  `project-store-upgrade.service.ts` preflight, the version-neutral upgrade
  fault boundary, `project-store-upgrade.test.ts`, and migration/DDL fault
  tests;
- lifecycle command store/transaction facade and evidence provider;
- evidence aggregate plus immutable compact-transition repositories, their DDL
  and mutation-guard tests, and provider-scope/reference-vector tests;
- checkpoint service, root suspension, child fork/transfer claim, session
  aggregate, authority and child-transfer repositories,
  risky-transition/checkpoint-age helpers, and replay-result decoding; and
- quick/full lifecycle and event integrity.

Task 13 carries both versions through the worker protocol and executor. Tasks
14 and 15 carry Version 2 through the session-end workflow and trusted
validation/finalization. Task 14 owns canonical transferred-child checkpoint
summaries, frozen-group persistence/replacement/cancellation clearing,
open/seal generation transitions, and open-row claim exclusion. Task 15 owns
the three repeated current-state freshness gates; neither task may substitute
event-time integrity for current freshness or vice versa. Task 16 renders both
versions without evidence detail.
Task 17 remains pass-through/disabled. Task 18 adds cross-process, crash,
provider-failure, global-bound, byte-bound, and snapshot-ordering coverage.
Task 19 keeps all new routing disabled and reruns the complete production
isolation gate.
