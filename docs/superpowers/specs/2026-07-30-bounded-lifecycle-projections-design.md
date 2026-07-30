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
report-witness row and its source event. Checkpoint/terminal source events are
also direct global-position reads. These are constant-count, protocol-bounded
lookups. Quick integrity proves the target binding and one link; full replay
alone proves every historical report-index/projection link and every historical
transition.

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
    OR (replacement_checkpoint_version = 2
      AND effective_checkpoint_version = 2)
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
tuple = [projectId, workflowId, workflowGeneration, sessionId,
         triggerEventPositionDecimal, rootCommandId, evidenceWindowState,
         replacementCheckpointVersionOrNull, effectiveCheckpointVersion,
         effectiveDraftSourceEventPositionDecimal, previousFingerprintOrNull]
```

Generation 1 has a null predecessor; every later row uses the immediately prior
generation's fingerprint. Initial request, cancelled-row reopen, and an
amendment with a non-null replacement set replacement/effective version from
the strict request/amendment and set source to the trigger event. A null
amendment carries prior effective version/source and records null replacement.
`open` requires a supplied V2 replacement, effective V2, source equal to the
trigger, and window `open`. `seal` records window `sealed`; a non-null
replacement uses it, while a null replacement carries effective/source.
`unchanged` has the same replace-or-carry rule and preserves window state.
Schema-3 cancel and ending-abandon generation rows have null replacement and
carry effective version/source; cancel clears the frozen evidence group, not
draft provenance, and records window `sealed`; ending-abandon records the
schema-3 guarded sealed window. Same-generation phase progress creates no row.

Thus the schema-3 generation cases are: initial request; `open`; `seal`;
same-phase amendment/`unchanged`; cancellation; cancelled-to-request reopen;
and ending-abandon. Task 14 must keep the request/amend/reopen event generation
and `workflow_instances.generation` aligned for these cases; that downstream
contract is not changed in Task 12.

Schema-2 legacy cancel/abandon history may not have a distinct generation
event. Preflight emits one row per distinct observed generation, carrying the
last effective version/source until a request, amendment, or reopen supplies a
replacement; it does not invent a duplicate row.

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
pure folds/hash domains as the live writer. Migration 0003 verifies identity,
three separate counts, strict cardinality (one child row per eligible child
event and one workflow row per distinct generation), predecessor adjacency,
source/target linkage and every hash; copies the sealed rows exactly once;
installs indexes/guards; and drops all stage tables/triggers/marker. Any
mismatch aborts and rolls the source database back exactly to schema 2 with no
partial persistent object.

## Quick and full integrity

Quick integrity uses the exact direct query shapes above, direct checkpoint and
coverage-transition-by-base lookups, and direct immutable transfer-ticket
ID/created-position lookup. It never scans lifecycle/ticket history, walks a
projection chain, reads ordinal/frame rows, decodes frames, recomputes coverage
HMAC, repairs state, or compares a frozen baseline with current authority.

Any missing, extra, malformed, cross-project/session/stream, non-adjacent,
bad-hash, bad-carry, bad-event/source/intent, or otherwise mismatched projection
is `INTEGRITY_FAILURE`. Authenticated coverage accumulator/content mismatch is
`SESSION_EVIDENCE_COVERAGE_MISMATCH`. Missing historical key material remains
`EVIDENCE_HISTORICAL_KEY_UNAVAILABLE`; only a fresh-final gate maps legal later
state to `SESSION_END_COVERAGE_CHANGED`.

Task 12J uses two synchronized merge-cursor replays: event cursor plus child
projection cursor, and generation-causing event/intent cursor plus workflow
projection cursor. Each expected event/generation consumes exactly one row;
position/key ordering detects a missing row before advancing and a leftover
cursor row detects an extra row. It recomputes every report set/witness/index
and both projection chains, while coverage replay keeps its existing advancing
ordinal/transition cursors. Work is linear in events plus projection rows; no
prefix is rescanned and no repair is attempted.

## Required tests and rollout boundary

Migration/raw-SQL tests cover every CHECK/FK/index, target/source identity,
genesis/predecessor, report partial uniqueness, insert adjacency, and immutable
update/delete guards; staged schema-1/2 backfill covers all three counts,
tampered hashes/cardinality, exact rollback, and the frozen migration-0002
SHA-256. Writer tests cover multi-event ascending order, service-afterAppend
ordering, dedup ordering, replay no-op, and atomic rollback. Quick tests
instrument zero history scans while tampering every field/hash/source and after
legal later child/workflow evolution. Full tests prove exact visit counts and
missing/extra detection for both cursor pairs.

The schema-3 projection writer supports existing V1 writes. Task 13 may expose
strict V2/V3 worker command/result codecs but must not enable lifecycle V2
production routing. Rejected alternatives are history scans with `LIMIT`
(data-sized), mutable current snapshots (reject legal later work), copied draft
JSON (unbounded and unnecessary), and partial/expression indexes over mutable
state (tampering can change membership).
