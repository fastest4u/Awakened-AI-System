# Bounded lifecycle projections for qualified-checkpoint integrity

## Decision and scope

Task 12I quick integrity must do fixed, protocol-bounded work. A SQL history
query remains data-sized even if its text contains `LIMIT`, so schema 3 adds two
append-only binding-fold slices: one row per child lifecycle event and one row
per lifecycle workflow generation. They authenticate event-time facts; they are
not mutable authority. Migration 0003 is registered and schema 3 is current.
Only lifecycle V2 routing/composition remains disabled in production.
Migration 0002 stays byte-for-byte identical.

## Child-event binding-fold slice

Migration `0003-qualified-checkpoint-coverage.ts` creates:

```sql
CREATE TABLE lifecycle_child_event_folds (
  project_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  event_position INTEGER NOT NULL CHECK (event_position > 0),
  stream_version INTEGER NOT NULL CHECK (stream_version > 0),
  root_session_id TEXT NOT NULL,
  child_state TEXT NOT NULL CHECK (child_state IN (
    'active', 'completion-proposed', 'completed', 'suspended', 'transferred'
  )),
  latest_checkpoint_id TEXT,
  latest_checkpoint_event_position INTEGER
    CHECK (latest_checkpoint_event_position IS NULL OR latest_checkpoint_event_position > 0),
  authority_commitment TEXT NOT NULL CHECK (
    length(authority_commitment) = 64
    AND authority_commitment NOT GLOB '*[^0-9a-f]*'
  ),
  terminal_event_type TEXT CHECK (
    terminal_event_type IS NULL
    OR terminal_event_type IN ('ChildSessionCompleted', 'ChildWorkTransferCreated')
  ),
  terminal_event_position INTEGER
    CHECK (terminal_event_position IS NULL OR terminal_event_position > 0),
  report_count INTEGER NOT NULL CHECK (report_count BETWEEN 0 AND 200),
  latest_report_id TEXT,
  report_index_fingerprint TEXT NOT NULL CHECK (
    length(report_index_fingerprint) = 64
    AND report_index_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  completion_report_id TEXT,
  reported_report_id TEXT,
  reported_item_count INTEGER
    CHECK (reported_item_count IS NULL OR reported_item_count BETWEEN 0 AND 200),
  reported_item_set_fingerprint TEXT CHECK (
    reported_item_set_fingerprint IS NULL
    OR (
      length(reported_item_set_fingerprint) = 64
      AND reported_item_set_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  previous_fingerprint TEXT CHECK (
    previous_fingerprint IS NULL
    OR (
      length(previous_fingerprint) = 64
      AND previous_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (project_id, child_session_id, event_position),
  UNIQUE (project_id, child_session_id, stream_version),
  CHECK ((latest_checkpoint_id IS NULL) = (latest_checkpoint_event_position IS NULL)),
  CHECK ((terminal_event_type IS NULL) = (terminal_event_position IS NULL)),
  CHECK ((report_count = 0) = (latest_report_id IS NULL)),
  CHECK (
    (reported_report_id IS NULL)
      = (reported_item_count IS NULL)
    AND (reported_report_id IS NULL)
      = (reported_item_set_fingerprint IS NULL)
  ),
  CHECK (completion_report_id IS NULL OR report_count > 0),
  CHECK (
    (child_state = 'completed'
      AND terminal_event_type = 'ChildSessionCompleted')
    OR (child_state = 'transferred'
      AND terminal_event_type = 'ChildWorkTransferCreated')
    OR (child_state IN ('active', 'completion-proposed', 'suspended')
      AND terminal_event_type IS NULL)
  ),
  CHECK (terminal_event_position IS NULL OR terminal_event_position <= event_position),
  CHECK (
    latest_checkpoint_event_position IS NULL
    OR latest_checkpoint_event_position <= event_position
  ),
  FOREIGN KEY (event_position) REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (latest_checkpoint_event_position) REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (terminal_event_position) REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX lifecycle_child_event_folds_at_event
  ON lifecycle_child_event_folds(project_id, child_session_id, event_position);
CREATE INDEX lifecycle_child_event_folds_root_at_event
  ON lifecycle_child_event_folds(project_id, root_session_id, event_position);
CREATE UNIQUE INDEX lifecycle_child_event_folds_report_witness
  ON lifecycle_child_event_folds(project_id, child_session_id, reported_report_id)
  WHERE reported_report_id IS NOT NULL;

CREATE TRIGGER lifecycle_child_event_folds_no_update
BEFORE UPDATE ON lifecycle_child_event_folds
BEGIN SELECT RAISE(ABORT, 'LIFECYCLE_CHILD_EVENT_FOLD_IMMUTABLE'); END;
CREATE TRIGGER lifecycle_child_event_folds_no_delete
BEFORE DELETE ON lifecycle_child_event_folds
BEGIN SELECT RAISE(ABORT, 'LIFECYCLE_CHILD_EVENT_FOLD_IMMUTABLE'); END;
```

The single-column foreign keys are deliberate: `events(global_position)` is
the parent key. Insert guards separately require every referenced event to have
the same `project_id`; the target event must additionally have the same child
session/stream identity and `stream_version`.

### Exact hashes

Every hash below is lowercase SHA-256 over the domain bytes followed immediately
by UTF-8 canonical JSON for the listed array. The domain includes its final LF:

```text
report item set domain = "project-memory/lifecycle/report-item-set/v1\n"
tuple = [projectId, childSessionId, reportId, sortedReportItemIds]

report witness domain = "project-memory/lifecycle/report-witness/v1\n"
tuple = [projectId, childSessionId, eventPositionDecimal, streamVersionDecimal,
         reportId, reportedItemCount, reportedItemSetFingerprint]

report-index domain = "project-memory/lifecycle/report-index/v1\n"
genesis tuple = [projectId, childSessionId, 0, null, null, null]
advance tuple = [projectId, childSessionId, reportCount, latestReportId,
                 previousReportIndexFingerprint, reportWitnessFingerprint]

child projection domain = "project-memory/lifecycle/child-event-fold/v1\n"
tuple = [projectId, childSessionId, eventPositionDecimal, streamVersionDecimal,
         rootSessionId, childState, latestCheckpointIdOrNull,
         latestCheckpointEventPositionDecimalOrNull, authorityCommitment,
         terminalEventTypeOrNull, terminalEventPositionDecimalOrNull,
         reportCount, latestReportIdOrNull, reportIndexFingerprint,
         completionReportIdOrNull, reportedReportIdOrNull,
         reportedItemCountOrNull, reportedItemSetFingerprintOrNull,
         previousFingerprintOrNull]
```

`sortedReportItemIds` is the ascending UTF-8 byte-order set of the strict
report's `allReportItemIds`; its size is `reported_item_count`. A
`ChildWorkReported` row stores the event-local triple and advances the
report-index from its predecessor using the computed report-witness hash.
Every other event stores all three event-local fields as null and carries
`report_count`, `latest_report_id`, and `report_index_fingerprint` unchanged.
The child projection genesis has `previous_fingerprint = NULL`; every successor
stores the immediately preceding row fingerprint. SHA computation belongs to
the application writer because SQLite has no built-in SHA-256. SQL guards check
identity, adjacency, null/source linkage, and predecessor equality; quick and
full integrity independently recompute hashes.

### Exact fold semantics

`SessionForked` is genesis: state `active`, zero reports, null latest/completion/
terminal/checkpoint fields, genesis report-index hash, and the event's root
lineage and authority commitment. All subsequent child events advance stream
version by one and event position strictly:

- `ChildWorkReported` requires a new report ID and at most 200 reports, advances
  the report witness/index fields, and carries state, completion, checkpoint,
  and terminal values.
- `ChildCompletionProposed` requires a directly witnessed report ID, sets state
  `completion-proposed` and `completion_report_id` to that ID.
- `ChildWorkDispositioned` requires a directly witnessed report whose exact
  item-set fingerprint matches the disposition. If state is
  `completion-proposed`, disposition kind is not `accepted`, and its report ID
  equals `completion_report_id`, it resets state to `active` and clears
  `completion_report_id`; every other disposition carries both.
- `ChildSessionCompleted` requires a witnessed report and, when currently
  proposed, the same completion report. It sets state `completed`, sets the
  terminal tuple to this event, and otherwise carries the report/checkpoint
  fold (including any existing completion report ID).
- `ChildSessionSuspended` requires its checkpoint ID to equal the carried latest
  checkpoint, sets state `suspended`, and carries report/completion values.
- `ChildWorkTransferCreated` requires the suspended checkpoint to equal the
  carried latest checkpoint, sets state `transferred`, sets the terminal tuple
  to this event, and carries report/completion/checkpoint values.
- `SessionCheckpointRecorded` strictly decodes V1/V2, replaces the latest
  checkpoint pair with its own checkpoint ID/event position, and carries all
  report, completion, state, and terminal values. `EvidenceCoverageRecorded`,
  `ChildAssignmentAmended`, and `ChildWorkTransferClaimed` carry every field in
  this bounded slice except authority commitment/event identity advanced by the
  normal aggregate fold.

The insert guard rejects a missing predecessor for non-genesis, a predecessor
for genesis, wrong prior fingerprint, non-adjacent stream version, non-increasing
event position, duplicate/late report witness, malformed pair/enum, or any
target/checkpoint/terminal/report event whose project/session/stream/type/payload
identity does not justify the row.

Quick verification reads exactly: target row by the primary key; predecessor by
the unique stream-version key when non-genesis; target event by global position;
and, only when the target transition refers to a report, the partial-unique
report-witness row and its raw source event. The witness event position and
stream version must both precede the consuming target. Quick recomputes the
standalone report-item-set and report-witness hashes from that raw event, but it
does not read the witness row's predecessor or prove that witness's historical
report-index advance/link. The target row still gets its own predecessor check.
Checkpoint/terminal source events are also direct global-position reads. These
are constant-count, protocol-bounded lookups. Quick integrity proves the target
binding and its direct reachable dependencies; Task 12J full replay alone
proves every historical report-index/projection link and transition.

## Workflow-generation effective-checkpoint slice

No draft JSON is copied. The immutable row records only version/provenance:

```sql
CREATE TABLE lifecycle_workflow_generation_folds (
  project_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_generation INTEGER NOT NULL CHECK (workflow_generation > 0),
  session_id TEXT NOT NULL,
  trigger_event_position INTEGER NOT NULL CHECK (trigger_event_position > 0),
  root_command_id TEXT NOT NULL,
  evidence_window_state TEXT NOT NULL
    CHECK (evidence_window_state IN ('open', 'sealed')),
  replacement_checkpoint_version INTEGER
    CHECK (replacement_checkpoint_version IS NULL
      OR replacement_checkpoint_version IN (1, 2)),
  effective_checkpoint_version INTEGER NOT NULL
    CHECK (effective_checkpoint_version IN (1, 2)),
  effective_draft_source_event_position INTEGER NOT NULL
    CHECK (effective_draft_source_event_position > 0),
  previous_fingerprint TEXT CHECK (
    previous_fingerprint IS NULL
    OR (length(previous_fingerprint) = 64
      AND previous_fingerprint NOT GLOB '*[^0-9a-f]*')
  ),
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (project_id, workflow_id, workflow_generation),
  UNIQUE (project_id, workflow_id, trigger_event_position),
  CHECK (
    evidence_window_state <> 'open'
    OR effective_checkpoint_version = 2
  ),
  CHECK (
    replacement_checkpoint_version IS NULL
    OR (
      effective_checkpoint_version = replacement_checkpoint_version
      AND effective_draft_source_event_position = trigger_event_position
    )
  ),
  CHECK (effective_draft_source_event_position <= trigger_event_position),
  FOREIGN KEY (trigger_event_position) REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (effective_draft_source_event_position) REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX lifecycle_workflow_generation_folds_session
  ON lifecycle_workflow_generation_folds(
    project_id, session_id, workflow_id, workflow_generation
  );
CREATE TRIGGER lifecycle_workflow_generation_folds_no_update
BEFORE UPDATE ON lifecycle_workflow_generation_folds
BEGIN SELECT RAISE(ABORT, 'LIFECYCLE_WORKFLOW_GENERATION_FOLD_IMMUTABLE'); END;
CREATE TRIGGER lifecycle_workflow_generation_folds_no_delete
BEFORE DELETE ON lifecycle_workflow_generation_folds
BEGIN SELECT RAISE(ABORT, 'LIFECYCLE_WORKFLOW_GENERATION_FOLD_IMMUTABLE'); END;
```

The workflow hash is lowercase SHA-256 of:

```text
domain = "project-memory/lifecycle/workflow-generation/v1\n"
tuple = [projectId, workflowId, workflowGenerationDecimal, sessionId,
         triggerEventPositionDecimal, rootCommandId, evidenceWindowState,
         replacementCheckpointVersionOrNull, effectiveCheckpointVersion,
         effectiveDraftSourceEventPositionDecimal, previousFingerprintOrNull]
```

`workflowGenerationDecimal` is the canonical unsigned base-10 string with no
leading zero.

Generation 1 has a null predecessor; every later row uses the immediately prior
generation's fingerprint. Initial request, cancelled-row reopen, and an
amendment with a non-null replacement set replacement/effective version from
the strict request/amendment and set source to the trigger event. A null
amendment carries prior effective version/source and records null replacement.
The `open` action specifically requires a supplied V2 replacement, effective
V2, source equal to the trigger, and window `open`. A later `unchanged` action
while that window remains open may use a null amendment and carry the prior V2
effective version/source. `seal` records window `sealed`; a non-null replacement
uses it, while a null replacement carries effective/source. `unchanged` has the
same replace-or-carry rule and preserves window state. Every non-null
replacement equals the effective version and makes the trigger its source.
Schema-3 cancel and ending-abandon generation rows have null replacement and
carry effective version/source; cancel clears the frozen evidence group, not
draft provenance, and records window `sealed`; ending-abandon records the
schema-3 guarded sealed window. Same-generation phase progress creates no row.

For live schema 3, the row trigger and root command are exact: generation 1 is
the `SessionEndRequested` event/command; every amend, including `open`, `seal`,
and `unchanged`, is the corresponding `SessionEndAmended` event/command at
generation + 1; cancel is `SessionEndCancelled` at generation + 1; a
cancelled-to-request reopen is its new `SessionEndRequested` event/command at
generation + 1; and ending-abandon is `SessionAbandoned` at generation + 1.
Same-generation phase updates emit no row. Task 14 must align the event payload,
root aggregate generation, and `workflow_instances.generation` for every one of
these generation-causing events, including cancel and abandon. Task 12 records
that downstream contract but does not change it.

Schema-2 compatibility history may place cancel or ending-abandon at the same
generation as its preceding request/amend/reopen. Preflight still emits exactly
one row for each distinct generation. It deterministically collapses that
generation's staged row to the last generation-semantic event by global
position: cancel or abandon becomes `trigger_event_position` and supplies
`root_command_id`/window state, replacement becomes null, and effective
version/source carry from that generation's strict request/amend/reopen.
Preflight then recomputes the collapsed row hash and every downstream
`previous_fingerprint`/fingerprint. It invents neither an event nor a
generation. A history without a strict request/amend/reopen draft source or a
contiguous generation chain fails preflight. The current lifecycle workflow
generation must equal the maximum staged generation.

`lifecycle_intent_json` exists only on the command's
`command_event_index = 0`. The application writer and preflight therefore
strict-decode the exact trigger/source event plus that event's indexed command
event 0. SQL insert guards join by project and command ID to event 0, require
the row's root command ID, session/workflow/generation/event type and source
position to agree, and enforce generation/predecessor/null/open rules. They do
not compute SHA. Quick integrity reads target and predecessor by their keys,
trigger and source by global position, and command event 0 by the existing
indexed `(project_id, command_id, command_event_index)` lookup: a fixed number
of rows.

## Store-owned writer ordering

Introduce a store-owned `LifecycleProjectionWriter` port. For a fresh command,
`LifecycleCommandStore.execute` retains one `BEGIN IMMEDIATE` and this order:

1. prepare/plan and run service-owned `beforeAppend`;
2. append the planned immutable event batch and assert committed/plan equality;
3. run the service-owned `next.afterAppend` semantic writes;
4. call `LifecycleProjectionWriter.append(committedBatch, transaction)` once;
5. insert dedup, then commit.

The projection writer receives the immutable committed batch and processes
events in ascending committed global position. Arbitrary service callbacks do
not own projection writes. A replay executes none of steps 2-5. Any projection
failure rolls back events, service state, projections, and dedup atomically.

## Schema-1/2 upgrade

Keep the existing immutable TEMP freeze stage and add:

```text
qualified_checkpoint_v3_stage_child_event_folds
qualified_checkpoint_v3_stage_workflow_generation_folds
qualified_checkpoint_v3_stage_marker
```

The one marker contains project/vault/store identity, source schema `2`, target
schema `3`, `freeze_row_count`, `child_fold_row_count`,
`workflow_generation_row_count`, and `sealed = 1`. Each TEMP table and the
marker has insert/update/delete denial triggers after sealing. Every bootstrap
or schema-1 path first reaches schema 2; only the 2-to-3 hook builds these
stages.

Under the upgrade transaction, preflight takes one ascending global-position
pass, strict-decodes lifecycle events and each indexed command-event-0 intent,
and builds the existing freeze rows plus both projection stages with the same
pure folds/hash domains as the live writer. Before sealing, the application
preflight computes every staged hash. After sealing and immediately before
executing migration SQL, the application
`assertQualifiedCheckpointMigrationStage` verifier independently recomputes
every staged hash and rejects any tamper. Migration 0003 SQL has no SHA
function/UDF: it verifies marker identity, three separate counts, row shape,
strict cardinality (one child row per eligible child event and one workflow row
per distinct generation), predecessor/source/target linkage, and exact-copy
equality only. It copies the already verified sealed rows exactly once,
installs indexes/guards, and drops all stage tables/triggers/marker. Any
mismatch aborts and rolls the source database back exactly to schema 2 with no
partial persistent object. The live writer computes new hashes; quick/full
integrity independently recompute persisted hashes.

## Quick and full integrity

Quick integrity uses the exact direct query shapes above, direct checkpoint and
coverage-transition-by-base lookups, and direct immutable transfer-ticket
ID/created-position lookup. It never scans lifecycle/ticket history, walks a
projection chain, reads ordinal/frame rows, decodes frames, recomputes coverage
HMAC, repairs state, or compares a frozen baseline with current authority.

For the target and only its directly reachable dependencies, any missing,
malformed, cross-project/session/stream, non-adjacent, bad-hash, bad-carry, or
bad-event/source/intent projection is `INTEGRITY_FAILURE`. Quick cannot discover
an arbitrary orphan/extra projection row. Task 12J's full ordered merge cursor
detects every such orphan/extra row and maps it to `INTEGRITY_FAILURE`.
Authenticated coverage accumulator/content mismatch is
`SESSION_EVIDENCE_COVERAGE_MISMATCH`. Missing historical key material remains
`EVIDENCE_HISTORICAL_KEY_UNAVAILABLE`; only a fresh-final gate maps legal later
state to `SESSION_END_COVERAGE_CHANGED`.

Task 12J uses two synchronized merge-cursor replays: event cursor plus child
projection cursor, and generation-causing event/intent cursor plus workflow
projection cursor. Each expected event/generation consumes exactly one row;
position/key ordering detects a missing row before advancing and a leftover
cursor row detects an extra row. It recomputes every report set/witness/index
and both projection chains, including the exact schema-2 cancel/abandon
same-generation compatibility collapse and downstream re-fingerprinting.
Coverage replay keeps its existing advancing ordinal/transition cursors. Work
is linear in events plus projection rows; no prefix is rescanned and no repair
is attempted.

## Required tests and rollout boundary

Migration/raw-SQL tests cover every CHECK/FK/index, target/source identity,
genesis/predecessor, report partial uniqueness, insert adjacency, and immutable
update/delete guards; staged schema-1/2 backfill covers all three counts,
cardinality, legacy same-generation cancel/abandon collapse, missing strict
draft-source rejection, application verification failure for a tampered sealed
stage hash, exact rollback, and the frozen migration-0002 SHA-256. Writer tests
cover multi-event ascending order, service-afterAppend ordering, dedup ordering,
replay no-op, and atomic rollback. Quick tests instrument zero history scans
while tampering every field/hash/source, after legal later child/workflow
evolution, and for legal open-window `unchanged` null carry. They also prove a
report consumer checks witness ordering and raw report hashes without reading
the witness predecessor. Full tests prove exact visit counts, schema-2 collapse,
and full-only orphan/extra detection for both cursor pairs.

The schema-3 projection writer supports existing V1 writes. Task 13 may expose
strict V2/V3 worker command/result codecs but must not enable lifecycle V2
production routing. Rejected alternatives are history scans with `LIMIT`
(data-sized), mutable current snapshots (reject legal later work), copied draft
JSON (unbounded and unnecessary), and partial/expression indexes over mutable
state (tampering can change membership).
