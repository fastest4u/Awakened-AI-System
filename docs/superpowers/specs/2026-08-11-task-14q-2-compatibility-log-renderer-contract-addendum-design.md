# Task 14Q.2: Compatibility-Log Renderer Contract Addendum

Date: 2026-08-11

Status: Conversational design approved; written-spec review required before
implementation planning

Parent design:
`docs/superpowers/specs/2026-08-09-task-14-root-anchored-session-end-saga-design.md`

Parent implementation plan:
`docs/superpowers/plans/2026-08-09-task-14-root-anchored-session-end-saga.md`

Architecture decision: preserve pure event-authoritative rendering by adding an
explicit Version 3 final-checkpoint marker and an authenticated lifecycle
lineage closure. Freeze the complete child-derived ending projection at that
marker.

Production cutover: Forbidden. This addendum does not authorize lifecycle V2
or V3 as the production MCP authority.

## 1. Decision summary

Task 14Q.2 keeps the already-approved compatibility-log Version 2 DTO and byte
grammar. It closes four ambiguities that prevent an event-only renderer from
being implemented safely:

1. A new outer Version 3 `SessionCheckpointRecorded` event is the only final
   checkpoint marker. Outer Version 1 and Version 2 checkpoint events remain
   ordinary checkpoints forever.
2. Rendering consumes an authenticated lifecycle closure, not only the root
   stream. The closure contains the source root, all lifetime direct children,
   and the exact foreign fork/claim witness pair for each claimed source-root
   transfer ticket.
3. The Version 3 marker freezes all child-derived compatibility bytes together:
   accepted items, deferred/rejected items, unresolved ticket data, the exact
   checkpoint, and the child heads from which they were derived. Later
   preserving triggers cannot rewrite that historical ending scope.
4. Validation carry/reset behavior is selected by the outer event schema.
   Legacy Version 1/2 amendments keep their historical reset behavior; only
   Version 3 `seal` and `unchanged` amendments preserve the current validation
   epoch.

Candidate rendering and committed replay normalize into one narrow semantic
event form and feed one fold/render implementation. A candidate is never cast
or fabricated as a `StoredEvent`.

## 2. Supersession and unchanged contracts

This addendum is normative where it conflicts with:

- parent design Sections 10.3, 12, 13.2, and 13.3;
- the parent plan's normative compatibility-log event mapping and validation
  paragraph; and
- Task 14Q.2, plus the affected Q.3, Q.4, Q.6, and S.3 plan steps.

Everything not changed here remains frozen. In particular:

- `CompatibilityLogProjectionV2`, its nested DTOs, section order, canonical JSON
  rules, UTF-8/LF encoding, and `documentVersion: 2` do not change;
- the six literal Version 2 fixture names and the approved `ending-v2.md` bytes
  and SHA-256 do not change;
- outer Version 1/2 event codecs and migrations 0002/0003 remain byte-for-byte
  compatible;
- the lifecycle materialization trigger/origin union remains closed; and
- Task 16 still owns file replacement, fsync, acknowledgement, retry, and
  materializer operations.

Migration 0004 is unreleased on this feature branch and may be amended. Its new
checksum becomes the schema-4 checksum. No already-released migration is
rewritten.

## 3. Explicit Version 3 final-checkpoint marker

### 3.1 Exact payload

The outer Version 3 checkpoint payload is exactly:

```ts
export interface SessionCheckpointRecordedPayloadV3 {
  readonly checkpoint: CheckpointV1 | CheckpointV2;
  readonly baseEventPosition: string;
  readonly checkpointEventPosition: string;
  readonly finalCheckpointBindingVersion: 1;
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
}
```

These are the only six own enumerable data keys. The decoder applies the
existing strict Version 1 or Version 2 checkpoint decoder according to the
nested `checkpointVersion`. It retains all existing checkpoint/session/parent,
base-position, event-position, workspace, and source-state correlations.

The event is legal only when all of the following are true:

- it is on the canonical root `session/{sessionId}` stream with
  `parentSessionId === null`;
- `checkpoint.sessionId` equals the event/root session and
  `checkpoint.parentSessionId === null`;
- `checkpointEventPosition`, the payload field, and the event global position
  are the same positive canonical decimal;
- the event is command event index zero for the authenticated internal
  `record-final-checkpoint-and-queue-ending` action;
- the authoritative lifecycle intent names source phase `children-resolved`
  and carries the exact same workflow ID, workflow generation, checkpoint
  bytes, project context, and expected root stream version;
- the current workflow row is the same root/workflow/generation, remains in
  `children-resolved`, has a sealed evidence window, and has no active frozen
  final checkpoint; and
- the outbox origin is `workflow` with exactly the payload's workflow ID and
  generation.

The ordinary checkpoint path continues to emit only outer Version 1 or Version
2 events. The final workflow action emits outer Version 3. No outer Version 1
or Version 2 event is inferred to be final from a workflow row, intent, outbox
row, position, or later history.

These legality checks are enforced in phases. Queue `prepare` can validate only
facts expressible or derivable from the strict Q.1 projection input and the
authenticated closure. `EventAppendTransaction.prepare`, the materialized
planned event, and queue `assertPlanned` then validate the authoritative intent,
action, command identity, and complete event envelope before insertion. SQL
guards revalidate the persisted relation. Post-append semantic recording and
quick/full integrity validate the workflow freeze. Q.1 projection input is not
expanded with a command or intent witness, and candidate rendering never
pretends to have one.

### 3.2 Fingerprint and rendered checkpoint

The marker does not duplicate a checkpoint fingerprint. The renderer and
integrity paths recompute it from the immutable nested checkpoint using the
existing preimage:

```text
UTF8("project-memory/checkpoint/v{checkpointVersion}\n")
+ UTF8(canonicalJson(checkpoint))
```

The rendered `finalCheckpoint` is non-null only while a Version 3 marker is in
force. Its Version 1 coverage is copied using the existing DTO rule; Version 2
coverage is narrowed to `CompatibilityLogQualifiedEvidenceCoverageV2` exactly
as already specified. A Version 3 outer event may therefore render either
nested checkpoint variant without changing the log document version.

### 3.3 Schema-4 admission

Migration 0004 must:

- admit `SessionCheckpointRecorded` outer schema Version 3 in the lifecycle
  version guard while preserving Version 1/2 checkpoint admission;
- add null-total exact-key/type/value guards for the six-key payload;
- require root-stream placement, the internal final-checkpoint intent/action,
  the exact workflow/generation binding, and the existing checkpoint position
  correlations;
- adapt the schema-4 workflow evidence/freeze guard so this Version 3 event is
  the only new final-checkpoint event;
- require a `SessionCheckpointRecorded` lifecycle-outbox trigger to have outer
  schema Version 3 and require payload workflow ID/generation to equal the
  outbox origin directly; and
- preserve upgrade compatibility for already-persisted ordinary Version 1/2
  checkpoint events without treating them as final markers.

The TypeScript Version 3 union, session aggregate allowlist, lifecycle
projection folds, authority repository, migration preflight, quick integrity,
and full integrity must all make the same distinction. A codec-only admission
that SQL, aggregate replay, or integrity later rejects is invalid.

## 4. One semantic renderer input

### 4.1 Closure plus one trigger

Both rendering paths use the same logical input:

```text
strict authenticated closure at positions < trigger
+ exactly one normalized trigger at trigger position
```

The private planning read seam is renamed to describe its real scope:

```ts
interface LifecycleRenderEventV1 {
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
  readonly legacyIntentSemantics:
    | {
        readonly effectiveState: SessionEndEffectiveStateV1;
        readonly evidenceWindowAction: "unchanged" | "open" | "seal" | null;
      }
    | null;
}

interface LifecycleRenderClosureV1 {
  readonly root: readonly LifecycleRenderEventV1[];
  readonly directChildren: readonly {
    readonly childSessionId: SessionId;
    readonly events: readonly LifecycleRenderEventV1[];
  }[];
  readonly foreignClaims: readonly {
    readonly fork: LifecycleRenderEventV1;
    readonly claim: LifecycleRenderEventV1;
  }[];
}

readStrictLifecycleClosure(
  projectId: ProjectId,
  rootSessionId: SessionId,
  throughPositionExclusive: bigint,
): LifecycleRenderClosureV1;
```

The exclusive boundary is deliberate. Queue preparation reads through the
position immediately before the candidate. Independent committed replay reads
the same exclusive closure and obtains the exact committed trigger separately.
Neither path computes `triggerPosition + 1`.

### 4.2 Normalization, not fabrication

The renderer owns an internal exact-key semantic event shape. It contains only
fields that can affect lifecycle folding or output: authenticated project
identity and branch context, canonical stream/session/parent identity, stream
version, global position, event type/schema, semantic occurrence time, strict
payload, a narrow derived legacy-intent semantic snapshot when required, and
materialization origin.

There are two strict normalizers:

1. `MaterializationProjectionInputV1` plus the closure becomes the candidate
   semantic trigger. The normalizer derives the canonical root stream,
   `parentSessionId: null`, next root stream version, project/vault/store/
   workspace/branch binding, and all payload/origin correlations. Branch scope
   comes from the authenticated root closure. An optional top-level Q.1
   `context.branchScopeId` is only an assertion and, when present, must equal
   the closure; it is not authority because it is outside the project-context
   fingerprint. `assertPlanned` captures and checks the actual stored branch
   scope/ref.
2. A committed `StoredEvent` is fully validated as a storage envelope first,
   then reduced to the same semantic trigger.

For a legacy Version 1/2 request or amendment that requires its persisted
`lifecycleIntentJson`, committed normalization first verifies the authoritative
intent hash, strict-decodes and correlates the witness, and derives only the
effective-state/action fields shown in `legacyIntentSemantics`. The raw intent
is stripped only after that derivation. It is never exposed to rendering or
included in bytes.

The candidate is never a synthetic `StoredEvent`. No placeholder event ID,
command ID, correlation ID, causation ID, recorded time, payload hash, previous
hash, or event hash may be invented. Storage-only fields are validated on the
committed path and by `assertPlanned`/`assertCommitted`, but are stripped before
folding so they cannot affect bytes.

The two paths must produce byte-identical projection, render bytes, and payload
hash for the same semantic history. `nextFingerprint` is also identical when
algorithm, schema, key ID, domain, prior tuple, and key material are the same.
After key rotation, committed replay verifies the stored historical fingerprint
tuple with its named key; it does not mint a replacement with the current key.

Conversely, every field captured by the prepared planning assertion remains
exact. On successful `assertPlanned`, the queue records a complete immutable
canonical identity of the actual planned `StoredEvent` in its private handle
state, including random IDs, command/correlation/causation/idempotency fields,
recorded time, payload JSON/hash, previous/event hashes, branch fields, intent,
and source envelope. `assertCommitted` compares that complete identity.
Mutating any field after planning fails even when the field is intentionally
absent from the document.

## 5. Authenticated lifecycle closure

### 5.1 Included streams

For source root `R` and an exclusive trigger cutoff, the closure contains only:

1. the complete root `R` stream prefix;
2. the complete prefix of every lifetime direct-child stream whose strict
   `SessionForked` names `R`; and
3. for each source-root transfer ticket claimed before the cutoff, the exact
   foreign claimant-child mini-stream consisting of `SessionForked` at stream
   version `1` followed by `ChildWorkTransferClaimed` at stream version `2`.

The foreign pair events retain outer event schema Version 1. The `1` and `2`
above are stream versions, not new event schema versions.

Global positions may have gaps because unrelated project streams legitimately
interleave. Each included stream starts at stream version `1`, is strictly
contiguous through its included head, and contains no duplicate or future
event. Rendering order is numeric global position with deterministic binary
tie rejection; two events cannot share a global position.

Unrelated foreign streams are not part of the closure. Missing root/child
prefixes, per-stream gaps, duplicate positions, future events, or an event that
cannot be assigned to the authenticated closure are `INTEGRITY_FAILURE`.

### 5.2 Identity rules for foreign claims

The source root and all direct-child events must match the source root's full
project/vault/store/workspace/branch identity.

Current claim semantics permit a different root in the same project store to
claim a ticket from another workspace or branch. Therefore the foreign
fork/claim pair must:

- match the source root on project, vault, and store;
- match each other exactly on workspace and branch scope/ref;
- use one canonical child stream with stream versions `1` then `2`;
- have command event indexes `0` then `1`, the same command and idempotency
  identity, and consecutive global positions;
- have claim causation equal the fork event ID and fork causation equal the
  source transfer event ID;
- bind `sourceTransferTicketId`, `transferTicketId`, source child session, and
  source transfer event position exactly; and
- carry a strict authenticated lifecycle intent whose claimant-root/child
  relation agrees with the two events.

The foreign workspace/branch does not become the rendered identity. Identity
always comes from the source root's first strict `SessionStarted`.

### 5.3 Discovery and cost

Claim discovery is event-backed. A ticket row may accelerate locating a claim,
but it is never semantic authority and every located tuple is reconstructed
from the immutable fork/claim events. Migration 0004 must provide or preserve
two authoritative partial/expression event indexes:

- source-root direct-child discovery by
  `(project_id, parent_session_id, global_position)` for `SessionForked`; and
- claim discovery by `(project_id, payload.transferTicketId, global_position)`
  for `ChildWorkTransferClaimed`.

The renderer queries the immutable claim index for every source-root ticket,
including the negative case. A mutable ticket claim pointer must be null exactly
when no indexed claim event exists, or must equal the one validated event pair.
This two-way equivalence is checked by SQL/integrity; a stale/null pointer cannot
hide a pre-cutoff claim. Direct-child authority rows may accelerate reads but
cannot prove that no fork event was omitted.

The closure is structurally bounded to the existing lifetime maximum of 1,000
direct children/tickets, but the number of events in an included stream is not
currently capped. Task 14Q.2 deliberately accepts work proportional to the
authenticated included history. It does not invent a new history cap that
could make valid persisted sessions unrenderable. Reads must use stream/ticket
indexes and must never perform a whole-project replay inside `BEGIN IMMEDIATE`.

## 6. Live and frozen ending-projection epochs

### 6.1 Live projection

Before a Version 3 final marker is in force, accepted child items, unresolved
child items, and source-root tickets are live as of the trigger cutoff. Direct
terminal abandonment also uses this live child/ticket projection, while its
`finalCheckpoint` and `validation` are null.

An `open` amendment, cancellation, or reopened request clears the active marker
and frozen ending projection. The triggering open/cancellation log is rendered
from live state at that trigger. Reopening queues no log; later triggers remain
live until a new Version 3 final marker establishes another frozen epoch.

A `seal` amendment can occur only after `open`. It preserves the already-cleared
validation epoch but the child/ticket projection remains live until the new
final marker.

### 6.2 Marker freeze

At a valid Version 3 final marker, the renderer:

1. validates the checkpoint's nonterminal child summaries and exact named
   stream heads;
2. validates every omitted terminal child's unique terminal head and folds its
   history through that head;
3. folds every report/disposition through the resulting exact per-child head;
4. reconstructs every source-root transfer ticket and every valid claim before
   the marker;
5. derives the accepted, deferred, rejected, and still-unclaimed ticket DTOs;
   and
6. freezes the complete derived projection together with the marker checkpoint.

Checkpoint child summaries name nonterminal child heads. Completed and
transferred children are not required to appear in that list; their immutable
terminal events define their heads and must precede the checkpoint base
position. Candidate rendering derives the snapshot only from the closure and
checkpoint. The workflow frozen binding does not exist yet at that point.
`recordPreparedFinal` persists the independently prepared binding after append,
and post-append assertion plus quick/full integrity compare it with the same
event-derived scope. Workflow mutable state is never a renderer input.

The compatibility document does not embed a second snapshot event or a second
fingerprint field. Later renders reproduce the frozen bytes by replaying to the
marker and the exact marker-era per-child heads defined above.

Ending-projection and validation dispatch are intentionally separate. Outer
Version 1 amendment is implicit `unchanged` for the marker/child projection.
Outer Version 2/3 `unchanged` also preserves it; outer Version 2/3 `open` clears
it, and `seal` remains live after that clear. Outer Version 1/2 still reset the
validation epoch under Section 7.

Verification failure/pass/invalidation, workflow-origin abandonment, and
`SessionEnded` preserve the complete frozen child projection and final
checkpoint. A later legitimate foreign claim changes live state but does not
retroactively change an already frozen ending revision. After a later clearing
action, that claim is reflected in live state and in the next marker's frozen
projection.

An `unchanged` amendment may advance the current lifecycle generation while
carrying a marker created by an earlier generation. The rendered lifecycle uses
the current generation; the final marker and all child-derived frozen bytes
remain byte-for-byte unchanged. Any purported `unchanged` transition that
requires different frozen bytes is an integrity failure or is rejected before
append, according to whether it is persisted or prospective.

### 6.3 Per-report disposition fold

Disposition state is resolved per report, not once per child. Multiple reports
in one child may be simultaneously in force.

For each strict `ChildWorkReported` at the active live/frozen cutoff, apply all
strict dispositions for that report in stream order:

- no disposition: omit the report from both output lists;
- latest `accepted`: emit every report item into `acceptedChildren`;
- latest `partially-accepted`: emit `acceptedItemIds` into
  `acceptedChildren`, and emit rejected/deferred IDs into
  `unresolvedFollowUps` with their respective kinds;
- latest `rejected`: emit every report item as `rejected-child-item`; and
- latest `superseded`: validate that `supersededByReportId` names a report in
  the same child whose report event is strictly after the original report's
  initial disposition and strictly before the superseding disposition, then
  omit the superseded report.

The fold validates the exact item partition, report/item identity, category,
index, evidence references, confidence, disposition sequence, and supersession
target. Missing reports, multiple initial dispositions, multiple supersessions,
backward/self/cyclic supersession, or an item-set mismatch fails closed.

The existing binary output sort keys remain unchanged.

### 6.4 Transfer-ticket fold

Each ticket DTO is derived from the strict source-child suspension/checkpoint
and `ChildWorkTransferCreated` lineage. Exactly one validated ticket may exist
per source child. A valid foreign claim strictly before the active live cutoff
removes it from the live unresolved set. A claim at or after the cutoff is ignored
for that render.

At a Version 3 marker, the then-unclaimed ticket set is part of the frozen
ending projection. Duplicate tickets, claim-only witnesses, missing forks,
wrong source child/transfer position, double claims, or a current-child/ticket
double representation is `INTEGRITY_FAILURE`.

## 7. Schema-aware validation epoch

Validation is a separate event-only fold. It never uses mutable runner rows or
the session aggregate's current operational convenience fields as an oracle.

### 7.1 Epoch boundaries

- A new request or reopened request starts empty.
- Outer Version 1 or Version 2 `SessionEndAmended` always resets retained
  results, verdict, score, failure code, and pass position. This preserves the
  historical event contract even when a Version 2 payload says `unchanged` or
  `seal`.
- Outer Version 3 `SessionEndAmended` with `open` resets the epoch.
- Outer Version 3 `seal` or `unchanged` preserves the exact epoch. A seal that
  follows an open therefore normally preserves an empty epoch.
- The nested command amendment version does not override the outer event
  schema/action. A command Version 1 represented by an outer Version 3
  `unchanged` event preserves.
- Cancellation resets the epoch. A later reopen starts another empty epoch.
- The Version 3 final checkpoint marker does not reset validation, but it is
  invalid if validation results or a verdict already precede that marker in the
  generation being finalized.

The phrase "implicit Version 1 unchanged" in the parent design continues to
describe evidence-window compatibility. It does not reinterpret historical
outer Version 1 amendment validation semantics.

### 7.2 Results and verdicts

Before a verdict, strict results accumulate in the active epoch and render as
`not-run`. Each result must bind the authenticated workflow lineage, frozen
checkpoint ID/fingerprint, profile/run identity, and event generation. Results
from an older generation may remain only through a contiguous chain of
Version 3 preserving amendments. Once an epoch is reset, an old result can
never reattach.

Pass and fail events must name the complete exact accumulated result-ID set in
binary order. No result may follow an in-force verdict in the same epoch.

- pass renders `passed`, the exact named results, and its quality score;
- fail renders `failed`, the exact named results, and its safe failure code;
- invalidation must name the exact in-force passed event position, retains that
  pass's IDs/results, clears quality score, and renders the invalidation safe
  failure code; and
- duplicate, unsorted, missing, extra, foreign-lineage, post-verdict, or
  mismatched results are `INTEGRITY_FAILURE`.

Workflow-origin `SessionAbandoned` preserves the valid folded projection.
Direct terminal abandonment renders `validation: null`. `SessionEnded` must
name the exact in-force passed event and preserves that named passed projection,
including a pass legally carried through Version 3 `unchanged` generations.

Legacy Version 1/2 amendment events do not contain all effective-state fields.
Their committed `lifecycleIntentJson` witness must therefore be strictly
decoded and correlated when replay needs those semantics. Missing, malformed,
or event-mismatched witnesses are `INTEGRITY_FAILURE`; command bytes never
enter the rendered document.

## 8. Deterministic bytes and buffer ownership

The parent Version 2 grammar remains authoritative. Every render:

- derives the artifact date only from the source root's first committed
  `SessionStarted.occurredAt` UTC date;
- derives the canonical session stream, path, target, and revision;
- emits every section in the frozen order with compact canonical JSON;
- uses UTF-8, LF only, no BOM, and exactly one terminal newline; and
- excludes random/storage IDs, recorded/current time, process/locale/topic
  state, raw evidence frames, commands, authority material, and secrets.

The renderer returns a fresh caller-owned `Buffer`, retains no reference, and
does no filesystem access. The concrete queue hashes/fingerprints that buffer
and calls `fill(0)` in `finally` on success and on every later failure,
including key-provider, predecessor, hash, and fingerprint failures. Tests that
call the renderer directly own and zero their buffers.

Literal Markdown fixtures live under
`tests/fixtures/compatibility-log/`. That directory contains a scoped
`.gitattributes` with:

```gitattributes
*.md text eol=lf
```

Compiled tests load the source fixtures explicitly because TypeScript does not
copy Markdown into `dist-test`. From the compiled test module, the fixture root
is resolved exactly as:

```ts
new URL("../../tests/fixtures/compatibility-log/", import.meta.url)
```

Tests compare literal bytes, terminal newline, absence of CR, byte length, and
SHA-256; production renderer/canonical helpers are not the expected-value
oracle.

## 9. Prepared-handle and queue state

`PreparedMaterializationQueueV1` remains opaque to semantic callers. The
compile-time private brand alone is not runtime authority. The concrete queue
owns each prepared handle in a private `WeakMap` and permits exactly one ordered
transition:

```text
prepared -> planned -> committed
```

Only the queue instance that created a handle may accept it. Reuse, skipping a
state, reversal, a foreign queue instance, or a structurally forged object
fails before row confirmation. Any validation failure moves the handle to a
terminal failed state and it cannot be retried. One narrowly audited internal
cast/factory may construct the opaque handle because the non-exported
TypeScript brand is not available to the concrete queue module; the `WeakMap`
state and its complete planned-event capture are the runtime security boundary.

`assertPlanned` and `assertCommitted` validate the complete exact event/plan
binding but never rerender, refingerprint, or insert. The candidate/committed
parity rule does not weaken exact prepared-event confirmation.

## 10. Failure model

Validation is phased without weakening atomicity:

1. the Q.1 decoder, closure reader, and queue `prepare` validate every
   input/closure/candidate fact available before event planning;
2. `EventAppendTransaction.prepare` and queue `assertPlanned` validate the
   authoritative intent, command identity, actual branch, and complete planned
   storage envelope;
3. append SQL validates the event/outbox relation; and
4. post-append semantic recording, `assertCommitted`, and integrity validate
   the persisted workflow freeze and exact row.

No usable descriptor reaches insertion until phases 1 and 2 succeed. A failure
burns the prepared handle and rolls back the transaction.

- Invalid prospective input at the public Q.1 decoder remains
  `LIFECYCLE_INPUT_INVALID`.
- Malformed, missing, contradictory, foreign, incomplete, or unauthenticated
  persisted history is `INTEGRITY_FAILURE`.
- A prospective stale position, stream version, origin, workflow, or context
  fails before append with zero event/outbox/dedup effect under the existing
  lifecycle error mapping.
- No failure path falls back to mutable ticket/workflow/projection state, drops
  a foreign claim silently, substitutes an ordinary checkpoint as final, or
  emits partial bytes.

Task 14Q.2 adds no new total-history capacity error. Introducing one later
would require prospective enforcement across every lifecycle writer plus an
upgrade preflight; it is not a local renderer change.

## 11. Required verification matrix

### 11.1 Event and SQL contract

- exact six-key Version 3 checkpoint accepts nested Checkpoint V1 and V2;
- extra/missing/null/wrong-type keys, non-root placement, wrong positions,
  wrong workflow/generation, wrong intent/action/phase, and wrong outbox origin
  fail in codec, aggregate, SQL guard, and integrity layers;
- outer Version 1/2 checkpoints remain byte-compatible and ordinary;
- migrations 0002/0003 retain their frozen hashes; and
- schema-4 migration/preflight/bootstrap/current-schema paths agree on Version
  3 admission.

### 11.2 Closure and claims

- valid source root/direct-child histories and a valid cross-workspace foreign
  fork/claim pair render successfully;
- global gaps are accepted while per-stream gaps are rejected;
- claim without fork, missing claimant stream version, nonconsecutive pair,
  wrong command/causation/ticket/source child/source position/context, duplicate
  claim, unrelated foreign stream, and post-trigger claim fail or are ignored
  exactly as specified; and
- claim discovery is proven event-backed and indexed rather than a mutable-row
  semantic shortcut, and missing direct-child/claim events are detectable via
  the authoritative partial indexes.

### 11.3 Child and ticket epochs

- accepted, partially accepted, rejected, superseded, and multiple in-force
  per-child reports fold independently per report;
- pre-marker claims are excluded from the marker snapshot;
- the marker freezes accepted, deferred, rejected, ticket, checkpoint, and child
  head inputs together;
- post-marker claims/child events cannot change `unchanged`, failure, pass,
  invalidation, workflow-abandonment, or end bytes;
- open and cancellation clear the snapshot, seal remains live, and the next
  marker refreezes current state; and
- duplicate/mismatched ticket or disposition evidence fails closed.

### 11.4 Validation

- outer Version 1 and Version 2 amend reset, including Version 2 `unchanged` and
  `seal`;
- Version 3 `open` resets and Version 3 `seal`/`unchanged` preserve;
- fail-then-legacy-amend-then-new-results/pass/end retains only the new epoch;
- not-run accumulation, pass, fail, invalidation, workflow abandonment, direct
  abandonment, and end render the exact approved DTOs;
- old results cannot reattach after open/cancel/reopen; and
- duplicate/unsorted/missing/extra IDs, wrong checkpoint/lineage/generation,
  result-after-verdict, and wrong pass/invalidation/end references fail closed.

### 11.5 Bytes, parity, and ownership

- all six literal fixtures match exact UTF-8/LF bytes and independent
  projections across both nested checkpoint versions;
- candidate projection/bytes/payload hash equal independent committed replay,
  and fingerprint equality is tested under one fixed key tuple;
- random committed envelope fields do not affect bytes, while mutation after
  preparation fails exact committed assertion;
- canonical escaping, sort order, null/empty forms, conditional ending marker,
  one terminal LF, and omission rules are explicit; and
- renderer buffers are fresh, detached from inputs, never cached, and zeroized
  by the owning caller on every success/failure path.

## 12. Implementation-plan impact

The next writing-plans pass must split the old Q.2 step so contract/schema work
lands before renderer work:

1. **14Q.2a — final-marker and closure contract:** event V3 codec/type,
   aggregate/projection/authority/integrity allowlists, migration-0004 SQL and
   direct-child/claim indexes, Q.1 cross-field rules, private read rename, and
   prepared-handle runtime ownership.
2. **14Q.2b — renderer and literals:** canonical path, strict closure
   normalization/fold, projection, renderer, scoped `.gitattributes`, six
   literal fixtures, parity tests, and zeroization ownership.

Later plan slices must also be amended:

- Q.3 repository insert/get/assert revalidate that checkpoint triggers are
  outer Version 3 and bind payload workflow ID/generation directly to origin;
- Q.4 reads the strict lifecycle closure, uses semantic candidate normalization,
  and owns buffer zeroization in `finally`;
- Q.6 quick/full integrity proves the Version 3 marker, complete frozen epoch,
  event-backed claim closure, payload content hash, and lineage;
- S.3 is the only final-checkpoint producer and emits outer Version 3 with the
  exact workflow binding; and
- aggregate/full-replay compatibility tests preserve historical outer Version
  1/2 amendment reset behavior.

No Task 14Q.2 implementation begins until this written addendum is approved and
the revised implementation plan is written and reviewed.
