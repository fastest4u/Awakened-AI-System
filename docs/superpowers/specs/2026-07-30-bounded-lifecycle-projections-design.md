# Bounded lifecycle projections for qualified-checkpoint integrity

## Decision

Task 12I's quick path is a fixed-work verifier.  It must not derive an
event-time child state or an effective workflow draft by scanning event history,
even when the SQL text has `LIMIT`.  Schema 3 therefore gains two append-only,
SHA-256-chained projections.  They are integrity evidence, not mutable read
models.  Migration `0002` remains byte-identical.

## 1. Immutable child-event fold

Migration `0003-qualified-checkpoint-coverage.ts` creates this table after the
existing schema-3 objects (the table is populated by the central lifecycle
writer, not by a SQLite trigger):

```sql
CREATE TABLE lifecycle_child_event_folds (
  project_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  event_position INTEGER NOT NULL CHECK (event_position > 0),
  stream_version INTEGER NOT NULL CHECK (stream_version > 0),
  root_session_id TEXT NOT NULL,
  child_state TEXT NOT NULL,
  latest_checkpoint_id TEXT,
  latest_checkpoint_event_position INTEGER,
  authority_commitment TEXT NOT NULL,
  terminal_event_type TEXT,
  terminal_event_position INTEGER,
  completion_disposition TEXT,
  completion_carry_json TEXT,
  previous_fingerprint TEXT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (project_id, child_session_id, event_position),
  UNIQUE (project_id, child_session_id, stream_version),
  CHECK ((latest_checkpoint_id IS NULL) = (latest_checkpoint_event_position IS NULL)),
  CHECK ((terminal_event_type IS NULL) = (terminal_event_position IS NULL)),
  CHECK ((completion_disposition IS NULL) = (completion_carry_json IS NULL)),
  CHECK (previous_fingerprint IS NULL OR (length(previous_fingerprint) = 64 AND previous_fingerprint NOT GLOB '*[^0-9a-f]*')),
  FOREIGN KEY (project_id, event_position) REFERENCES events(project_id, global_position)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX lifecycle_child_event_folds_at_event
  ON lifecycle_child_event_folds(project_id, child_session_id, event_position DESC);
CREATE INDEX lifecycle_child_event_folds_root_at_event
  ON lifecycle_child_event_folds(project_id, root_session_id, event_position DESC);
CREATE TRIGGER lifecycle_child_event_folds_no_update BEFORE UPDATE ON lifecycle_child_event_folds
BEGIN SELECT RAISE(ABORT, 'LIFECYCLE_CHILD_EVENT_FOLD_IMMUTABLE'); END;
CREATE TRIGGER lifecycle_child_event_folds_no_delete BEFORE DELETE ON lifecycle_child_event_folds
BEGIN SELECT RAISE(ABORT, 'LIFECYCLE_CHILD_EVENT_FOLD_IMMUTABLE'); END;
```

`event_position` is the just-appended child event's global position.  The
writer inserts exactly one row for every appended child-stream lifecycle event;
there is no row for non-lifecycle/session events.  `root_session_id` is the
event-time root lineage. `child_state`, latest-checkpoint pair, and authority
commitment are the post-event authority fold.  `terminal_*` records the first
terminal event tuple where applicable. `completion_disposition` and
`completion_carry_json` are the minimal strict, canonical carry needed by a
later child disposition (no whole event payload, frames, or mutable ticket
claim state is copied).  The pair is both null before a completion proposal and
is retained thereafter exactly as the decoded child completion contract
requires.

The child fingerprint is lower-case SHA-256 of the UTF-8 bytes:

```
sha256("pm-lifecycle-child-fold-v1\\0" + canonicalJson([
  projectId, childSessionId, eventPositionDecimal, streamVersionDecimal,
  rootSessionId, childState, latestCheckpointIdOrNull,
  latestCheckpointEventPositionDecimalOrNull, authorityCommitment,
  terminalEventTypeOrNull, terminalEventPositionDecimalOrNull,
  completionDispositionOrNull, completionCarryJsonOrNull,
  previousFingerprintOrNull
]))
```

The genesis row has `previous_fingerprint = NULL`; every later row must equal
the immediately preceding row's `fingerprint` for the same
`(project_id, child_session_id)`. Insert guards require the matching `events`
row, child session ID, global position and stream version, enforce increasing
positions/versions, and recompute the exact tuple.  A row whose parent/root,
checkpoint pair, terminal tuple, or null-carry semantics disagrees with the
strict decoded event is rejected with `INTEGRITY_FAILURE` at the writer before
the insert.  Trigger guards also reject a non-genesis null/wrong predecessor.

## 2. Immutable effective-draft generation slice

Migration 0003 also creates:

```sql
CREATE TABLE lifecycle_workflow_generation_drafts (
  project_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_generation INTEGER NOT NULL CHECK (workflow_generation > 0),
  session_id TEXT NOT NULL,
  trigger_event_position INTEGER NOT NULL CHECK (trigger_event_position > 0),
  root_command_id TEXT NOT NULL,
  replacement_draft_json TEXT,
  effective_draft_json TEXT,
  effective_draft_source_event_position INTEGER,
  previous_fingerprint TEXT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (project_id, workflow_id, workflow_generation),
  CHECK ((effective_draft_json IS NULL) = (effective_draft_source_event_position IS NULL)),
  CHECK (replacement_draft_json IS NULL OR json(replacement_draft_json) = replacement_draft_json),
  CHECK (effective_draft_json IS NULL OR json(effective_draft_json) = effective_draft_json),
  CHECK (previous_fingerprint IS NULL OR (length(previous_fingerprint) = 64 AND previous_fingerprint NOT GLOB '*[^0-9a-f]*')),
  FOREIGN KEY (project_id, trigger_event_position) REFERENCES events(project_id, global_position)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX lifecycle_workflow_generation_drafts_session
  ON lifecycle_workflow_generation_drafts(project_id, session_id, workflow_id, workflow_generation DESC);
CREATE TRIGGER lifecycle_workflow_generation_drafts_no_update BEFORE UPDATE ON lifecycle_workflow_generation_drafts
BEGIN SELECT RAISE(ABORT, 'LIFECYCLE_WORKFLOW_GENERATION_DRAFT_IMMUTABLE'); END;
CREATE TRIGGER lifecycle_workflow_generation_drafts_no_delete BEFORE DELETE ON lifecycle_workflow_generation_drafts
BEGIN SELECT RAISE(ABORT, 'LIFECYCLE_WORKFLOW_GENERATION_DRAFT_IMMUTABLE'); END;
```

One row exists for every lifecycle workflow generation: the request creates
generation 1 and each amendment/open/seal/reopen generation creates its next
row.  `trigger_event_position` is that request/amend event; `root_command_id`
is its authoritative command.  `replacement_draft_json` is the strictly
decoded supplied draft, or null. `effective_draft_json` is the post-event
effective draft, and its source is either the triggering event (non-null
replacement) or the earlier event position that supplied the carried draft.
Both are null only where the strict V1 workflow contract has no draft.  For an
open window, the effective draft is strictly V2.  `unchanged` and a null
Version-1 amendment carry the previous effective draft and source unchanged;
cancel-clear yields a null replacement and null effective pair; reopen/open and
seal use the decoded amendment semantics, never current `workflow_instances`.

Its hash is:

```
sha256("pm-lifecycle-workflow-draft-v1\\0" + canonicalJson([
  projectId, workflowId, workflowGenerationDecimal, sessionId,
  triggerEventPositionDecimal, rootCommandId, replacementDraftJsonOrNull,
  effectiveDraftJsonOrNull, effectiveDraftSourceEventPositionDecimalOrNull,
  previousFingerprintOrNull
]))
```

Genesis has a null predecessor; later rows chain strictly by generation for the
same workflow.  The writer verifies event identity/schema, canonical JSON,
generation adjacency, prior hash, draft source and the exact hash before each
insert.  No partial/expression index may select an "open" draft: a corrupt row
could otherwise leave the index and make absence look healthy.

## 3. Writer, upgrade and integrity protocol

For a non-replay command, `LifecycleCommandStore.execute` keeps its existing
order: `appendPlanned`, plan/commit equality assertion, then `afterAppend`.
The `afterAppend` callback performs, in the same `BEGIN IMMEDIATE` transaction,
the normal semantic writes followed by (a) child fold rows in ascending appended
event order and (b) workflow generation slices in ascending appended event
order. It validates all projection inserts before returning. Only then may
`insertDedup` run, followed by `COMMIT`. A deduplicated replay writes neither
projection. Any projection failure rolls back events, ordinary semantic rows,
and dedup together.

Schema-1/2 explicit upgrade preflight takes one ordered lifecycle history pass,
strict-decodes it, folds child state and effective drafts with the same pure
functions, and seals immutable TEMP rows plus a marker carrying project/vault/
store identity, source schema and count. The stage contains both projection
row shapes and their fingerprints. Migration 0003 copies every staged row
exactly once, checks count/identity/hash/adjacency, creates indexes and guards,
then drops the stage marker and rows. Failure rolls the source schema back and
leaves no schema-3 partial projection. Existing 0003 preflight safeguards
remain; 0002 is not edited or rehashed.

Quick integrity uses only exact indexed lookups: child fold by
`(project, child, checkpoint/event position)`, workflow slice by
`(project, workflow, generation)`, event/checkpoint index by stored global
position, coverage-transition snapshot by stored base, and transfer-ticket by
its immutable ID/created event position. It validates strict row shapes,
predecessor/hash chains, cross-row identity, event-time root/state/checkpoint/
authority/terminal/carry values, and effective-draft/window rules. It never
scans events or tickets, walks a child/workflow history, reads ordinal/frame
rows, decodes frames, recomputes HMAC, repairs data, or compares an old frozen
baseline to mutable current authority. Structural corruption maps at the
existing `INTEGRITY_FAILURE`/`SESSION_EVIDENCE_COVERAGE_MISMATCH` boundary;
unavailable recorded profile material maps to
`EVIDENCE_HISTORICAL_KEY_UNAVAILABLE`; only fresh final gates map legal staleness
to `SESSION_END_COVERAGE_CHANGED`.

Task 12J full integrity is allowed one ordered linear replay. It replays the
two projection chains alongside events, coverage transitions/ordinals,
checkpoints, tickets and workflow events; recomputes each canonical tuple and
requires exactly one projection visit per row, predecessor adjacency, event
identity and writer ordering. It reconstructs frozen bindings using the
projection at the recorded positions, not mutable heads. It performs no repair.

## 4. Tests, rollout, and boundary

Add migration/raw-SQL tests for every CHECK, FK, insert predecessor/hash,
update/delete guard, index lookup and schema-1/2 staged backfill/rollback;
writer tests for multi-event ordering and rollback before dedup; quick tests
that instrument zero history scans under legal later child/draft changes and
tamper every tuple/hash; and full tests for one-pass exact chain visits and
historical reconstruction. Reconfirm the frozen migration-0002 SHA-256.

Lifecycle V2 and schema migration remain unregistered in production. Task 13
may consume the strict projection read contracts only for worker V2/V3
command/result codecs; it must neither enable routing nor add a mutable
projection writer. Rejected alternatives are: SQL history scans with `LIMIT`
(data-sized), a current-state snapshot (invalidates legal later work), and
partial/expression indexes over mutable workflow state (corruption can change
membership).
