import type { Migration } from "../migration.js";

const PRECONDITION = "MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED";

const FINAL_BINDINGS_INVALID = `
  NEW.final_ending_scope_bindings_json IS NOT NULL AND (
    NOT json_valid(NEW.final_ending_scope_bindings_json)
    OR json_type(NEW.final_ending_scope_bindings_json) <> 'array'
    OR json(NEW.final_ending_scope_bindings_json)
      <> NEW.final_ending_scope_bindings_json
    OR length(CAST(NEW.final_ending_scope_bindings_json AS BLOB)) > 262144
    OR json_array_length(NEW.final_ending_scope_bindings_json) > 100
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.final_ending_scope_bindings_json) AS binding
      WHERE json_type(binding.value) <> 'object'
        OR (SELECT count(*) FROM json_each(binding.value)) <> 10
        OR EXISTS (
          SELECT 1 FROM json_each(binding.value) AS field
          WHERE field.key NOT IN (
            'bindingVersion', 'bindingKind', 'childSessionId', 'childState',
            'lastEventPosition', 'streamVersion', 'checkpointId',
            'checkpointEventPosition', 'transferTicketId',
            'transferTicketEventPosition'
          )
        )
        OR json_type(binding.value, '$.bindingVersion') <> 'integer'
        OR json_extract(binding.value, '$.bindingVersion') <> 1
        OR json_type(binding.value, '$.bindingKind') <> 'text'
        OR json_extract(binding.value, '$.bindingKind') NOT IN (
          'current-child', 'carry-forward-ticket'
        )
        OR json_type(binding.value, '$.childSessionId') <> 'text'
        OR length(json_extract(binding.value, '$.childSessionId')) <> 36
        OR lower(json_extract(binding.value, '$.childSessionId'))
          <> json_extract(binding.value, '$.childSessionId')
        OR json_extract(binding.value, '$.childSessionId') NOT GLOB
          '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
        OR json_type(binding.value, '$.childState') <> 'text'
        OR json_extract(binding.value, '$.childState') NOT IN (
          'active', 'completion-proposed', 'completed', 'suspended', 'transferred'
        )
        OR json_type(binding.value, '$.lastEventPosition') <> 'text'
        OR json_extract(binding.value, '$.lastEventPosition') = '0'
        OR json_extract(binding.value, '$.lastEventPosition') GLOB '*[^0-9]*'
        OR json_extract(binding.value, '$.lastEventPosition') GLOB '0*'
        OR json_type(binding.value, '$.streamVersion') <> 'text'
        OR json_extract(binding.value, '$.streamVersion') = '0'
        OR json_extract(binding.value, '$.streamVersion') GLOB '*[^0-9]*'
        OR json_extract(binding.value, '$.streamVersion') GLOB '0*'
        OR (json_extract(binding.value, '$.checkpointId') IS NULL)
          <> (json_extract(binding.value, '$.checkpointEventPosition') IS NULL)
        OR (json_extract(binding.value, '$.checkpointEventPosition') IS NOT NULL AND (
          json_type(binding.value, '$.checkpointEventPosition') <> 'text'
          OR json_extract(binding.value, '$.checkpointEventPosition') = '0'
          OR json_extract(binding.value, '$.checkpointEventPosition') GLOB '*[^0-9]*'
          OR json_extract(binding.value, '$.checkpointEventPosition') GLOB '0*'
          OR CAST(json_extract(binding.value, '$.checkpointEventPosition') AS INTEGER)
            > CAST(json_extract(binding.value, '$.lastEventPosition') AS INTEGER)
          OR NOT EXISTS (
            SELECT 1 FROM events AS checkpoint_event
            WHERE checkpoint_event.project_id = NEW.project_id
              AND checkpoint_event.global_position = CAST(
                json_extract(binding.value, '$.checkpointEventPosition') AS INTEGER
              )
              AND checkpoint_event.session_id = json_extract(binding.value, '$.childSessionId')
              AND checkpoint_event.event_type = 'SessionCheckpointRecorded'
              AND checkpoint_event.event_schema_version IN (1, 2)
              AND json_extract(checkpoint_event.payload_json, '$.checkpoint.checkpointId')
                = json_extract(binding.value, '$.checkpointId')
          )
        ))
        OR (json_extract(binding.value, '$.bindingKind') = 'current-child' AND (
          json_extract(binding.value, '$.transferTicketId') IS NOT NULL
          OR json_extract(binding.value, '$.transferTicketEventPosition') IS NOT NULL
        ))
        OR (json_extract(binding.value, '$.bindingKind') = 'carry-forward-ticket' AND (
          json_extract(binding.value, '$.childState') <> 'transferred'
          OR json_extract(binding.value, '$.checkpointId') IS NULL
          OR json_extract(binding.value, '$.transferTicketId') IS NULL
          OR json_extract(binding.value, '$.transferTicketEventPosition') IS NULL
          OR json_extract(binding.value, '$.lastEventPosition')
            <> json_extract(binding.value, '$.transferTicketEventPosition')
          OR NOT EXISTS (
            SELECT 1
            FROM child_transfer_tickets AS ticket
            JOIN events AS transfer_event
              ON transfer_event.project_id = ticket.project_id
              AND transfer_event.global_position = ticket.created_event_position
              AND transfer_event.session_id = ticket.source_child_session_id
              AND transfer_event.event_type = 'ChildWorkTransferCreated'
              AND transfer_event.event_schema_version = 1
              AND json_extract(transfer_event.payload_json, '$.transferTicketId')
                = ticket.transfer_ticket_id
              AND json_extract(transfer_event.payload_json, '$.checkpointId')
                = ticket.checkpoint_id
            WHERE ticket.project_id = NEW.project_id
              AND ticket.transfer_ticket_id = json_extract(binding.value, '$.transferTicketId')
              AND ticket.source_child_session_id
                = json_extract(binding.value, '$.childSessionId')
              AND ticket.checkpoint_id = json_extract(binding.value, '$.checkpointId')
              AND ticket.created_event_position = CAST(
                json_extract(binding.value, '$.transferTicketEventPosition') AS INTEGER
              )
          )
        ))
        OR json(binding.value) <> json_object(
          'bindingKind', json_extract(binding.value, '$.bindingKind'),
          'bindingVersion', json_extract(binding.value, '$.bindingVersion'),
          'checkpointEventPosition', json_extract(binding.value, '$.checkpointEventPosition'),
          'checkpointId', json_extract(binding.value, '$.checkpointId'),
          'childSessionId', json_extract(binding.value, '$.childSessionId'),
          'childState', json_extract(binding.value, '$.childState'),
          'lastEventPosition', json_extract(binding.value, '$.lastEventPosition'),
          'streamVersion', json_extract(binding.value, '$.streamVersion'),
          'transferTicketEventPosition',
            json_extract(binding.value, '$.transferTicketEventPosition'),
          'transferTicketId', json_extract(binding.value, '$.transferTicketId')
        )
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.final_ending_scope_bindings_json) AS left_binding
      JOIN json_each(NEW.final_ending_scope_bindings_json) AS right_binding
        ON CAST(right_binding.key AS INTEGER) = CAST(left_binding.key AS INTEGER) + 1
      WHERE json_extract(left_binding.value, '$.childSessionId')
        >= json_extract(right_binding.value, '$.childSessionId')
    )
  )`;

const FROZEN_GROUP_INVALID = `
  NEW.evidence_frozen_checkpoint_event_position IS NOT NULL AND (
    NEW.evidence_frozen_generation > NEW.generation
    OR NOT json_valid(NEW.result_json)
    OR coalesce(
      json_extract(NEW.result_json, '$.status.sessionId'),
      json_extract(NEW.result_json, '$.sessionId')
    ) IS NOT NEW.session_id
    OR coalesce(
      json_extract(NEW.result_json, '$.status.workflowId'),
      json_extract(NEW.result_json, '$.workflowId')
    ) IS NOT NEW.workflow_id
    OR coalesce(
      json_extract(NEW.result_json, '$.status.workflowGeneration'),
      json_extract(NEW.result_json, '$.workflowGeneration')
    ) <> NEW.generation
    OR coalesce(
      json_extract(NEW.result_json, '$.status.phase'),
      json_extract(NEW.result_json, '$.phase')
    ) IS NOT NEW.phase
    OR coalesce(
      json_extract(NEW.result_json, '$.status.finalCheckpointEventPosition'),
      json_extract(NEW.result_json, '$.finalCheckpointEventPosition')
    ) IS NOT CAST(NEW.evidence_frozen_checkpoint_event_position AS TEXT)
    OR NOT EXISTS (
      SELECT 1 FROM events AS final_checkpoint_event
      WHERE final_checkpoint_event.project_id = NEW.project_id
        AND final_checkpoint_event.session_id = NEW.session_id
        AND final_checkpoint_event.global_position
          = NEW.evidence_frozen_checkpoint_event_position
        AND final_checkpoint_event.event_type = 'SessionCheckpointRecorded'
        AND final_checkpoint_event.event_schema_version IN (1, 2)
        AND json_extract(final_checkpoint_event.payload_json,
          '$.checkpoint.checkpointId') IS coalesce(
            json_extract(NEW.result_json, '$.status.finalCheckpointId'),
            json_extract(NEW.result_json, '$.finalCheckpointId')
          )
        AND json_extract(final_checkpoint_event.payload_json,
          '$.checkpoint.checkpointEventPosition')
          IS CAST(NEW.evidence_frozen_checkpoint_event_position AS TEXT)
    )
  )`;

export const qualifiedCheckpointCoverageMigration: Migration = {
  version: 3,
  name: "qualified-checkpoint-coverage",
  sql: `
CREATE TEMP TABLE IF NOT EXISTS qualified_checkpoint_v3_stage_rows (
  workflow_id TEXT PRIMARY KEY,
  source_generation INTEGER NOT NULL CHECK (source_generation > 0),
  source_phase TEXT NOT NULL CHECK (length(source_phase) > 0),
  evidence_frozen_checkpoint_event_position INTEGER,
  evidence_frozen_generation INTEGER,
  evidence_window_state TEXT NOT NULL CHECK (evidence_window_state IN ('open', 'sealed')),
  final_ending_scope_bindings_json TEXT,
  CHECK (
    (evidence_frozen_checkpoint_event_position IS NULL
      AND evidence_frozen_generation IS NULL
      AND final_ending_scope_bindings_json IS NULL)
    OR
    (evidence_frozen_checkpoint_event_position IS NOT NULL
      AND evidence_frozen_checkpoint_event_position > 0
      AND evidence_frozen_generation IS NOT NULL
      AND evidence_frozen_generation > 0
      AND final_ending_scope_bindings_json IS NOT NULL)
  )
) STRICT;

CREATE TEMP TABLE IF NOT EXISTS qualified_checkpoint_v3_stage_marker (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  project_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  source_schema_version INTEGER NOT NULL CHECK (source_schema_version = 2),
  target_schema_version INTEGER NOT NULL CHECK (target_schema_version = 3),
  staged_row_count INTEGER NOT NULL CHECK (staged_row_count >= 0),
  sealed INTEGER NOT NULL CHECK (sealed = 1)
) STRICT;

CREATE TEMP TABLE qualified_checkpoint_v3_guard(value INTEGER NOT NULL) STRICT;
CREATE TEMP TRIGGER qualified_checkpoint_v3_guard_abort
BEFORE INSERT ON qualified_checkpoint_v3_guard
WHEN NEW.value <> 1
BEGIN
  SELECT RAISE(ABORT, '${PRECONDITION}');
END;

INSERT INTO qualified_checkpoint_v3_guard(value)
SELECT CASE WHEN
  (SELECT count(*) FROM qualified_checkpoint_v3_stage_marker) = 1
  AND (SELECT singleton FROM qualified_checkpoint_v3_stage_marker) = 1
  AND (SELECT source_schema_version FROM qualified_checkpoint_v3_stage_marker) = 2
  AND (SELECT target_schema_version FROM qualified_checkpoint_v3_stage_marker) = 3
  AND (SELECT sealed FROM qualified_checkpoint_v3_stage_marker) = 1
  AND (SELECT staged_row_count FROM qualified_checkpoint_v3_stage_marker)
    = (SELECT count(*) FROM qualified_checkpoint_v3_stage_rows)
  AND (SELECT count(*) FROM temp.sqlite_schema
       WHERE type = 'trigger' AND name IN (
         'qualified_checkpoint_v3_stage_marker_no_insert',
         'qualified_checkpoint_v3_stage_marker_no_update',
         'qualified_checkpoint_v3_stage_marker_no_delete',
         'qualified_checkpoint_v3_stage_rows_no_insert',
         'qualified_checkpoint_v3_stage_rows_no_update',
         'qualified_checkpoint_v3_stage_rows_no_delete'
       )) = 6
  AND (SELECT count(*) FROM qualified_checkpoint_v3_stage_rows)
    = (SELECT count(*) FROM workflow_instances WHERE session_id IS NOT NULL)
  AND (SELECT count(*) FROM project_meta) = 1
  AND EXISTS (
    SELECT 1
    FROM project_meta AS meta
    JOIN qualified_checkpoint_v3_stage_marker AS marker ON marker.singleton = 1
    WHERE meta.singleton = 1
      AND meta.schema_version = 2
      AND marker.project_id = meta.project_id
      AND marker.vault_id = meta.vault_id
      AND marker.store_id = meta.store_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM qualified_checkpoint_v3_stage_rows AS stage
    LEFT JOIN workflow_instances AS workflow
      ON workflow.workflow_id = stage.workflow_id
      AND workflow.session_id IS NOT NULL
    WHERE workflow.workflow_id IS NULL
      OR workflow.generation <> stage.source_generation
      OR workflow.phase <> stage.source_phase
      OR stage.evidence_window_state <> 'sealed'
      OR (
        stage.final_ending_scope_bindings_json IS NOT NULL
        AND (
          NOT json_valid(stage.final_ending_scope_bindings_json)
          OR json_type(stage.final_ending_scope_bindings_json) <> 'array'
          OR json(stage.final_ending_scope_bindings_json)
            <> stage.final_ending_scope_bindings_json
          OR length(CAST(stage.final_ending_scope_bindings_json AS BLOB)) > 262144
        )
      )
      OR (
        (stage.evidence_frozen_checkpoint_event_position IS NULL)
          <> (stage.evidence_frozen_generation IS NULL)
        OR (stage.evidence_frozen_checkpoint_event_position IS NULL)
          <> (stage.final_ending_scope_bindings_json IS NULL)
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM workflow_instances AS workflow
    WHERE workflow.session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM qualified_checkpoint_v3_stage_rows AS stage
        WHERE stage.workflow_id = workflow.workflow_id
      )
  )
  AND NOT EXISTS (SELECT 1 FROM session_evidence_coverage)
  AND NOT EXISTS (SELECT 1 FROM session_evidence_fingerprints)
  AND NOT EXISTS (
    SELECT 1 FROM events
    WHERE stream_type = 'session' AND session_id IS NOT NULL
      AND event_type = 'EvidenceCoverageRecorded'
  )
  AND NOT EXISTS (
    SELECT 1 FROM events
    WHERE stream_type = 'session' AND session_id IS NOT NULL
      AND event_type IN (
        'SessionStarted', 'SessionOwnerTransferred', 'SessionOwnershipRecovered',
        'SessionSuspendRequested', 'SessionSuspended', 'SessionResumed',
        'SessionCheckpointRecorded', 'EvidenceCoverageRecorded', 'SessionForked',
        'ChildAssignmentAmended', 'ChildWorkReported', 'ChildWorkDispositioned',
        'ChildCompletionProposed', 'ChildSessionCompleted', 'ChildSessionSuspended',
        'ChildWorkTransferCreated', 'ChildWorkTransferClaimed', 'SessionEndRequested',
        'SessionEndAmended', 'SessionValidationResultRecorded',
        'SessionEndVerificationPassed', 'SessionEndVerificationFailed',
        'SessionEndVerificationInvalidated', 'SessionEndCancelled',
        'SessionAbandoned', 'SessionEnded'
      )
      AND event_schema_version <> 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM events
    WHERE stream_type = 'session' AND session_id IS NOT NULL
      AND event_type = 'SessionCheckpointRecorded'
      AND (
        json_type(payload_json, '$.checkpoint.checkpointVersion') IS NOT 'integer'
        OR json_extract(payload_json, '$.checkpoint.checkpointVersion') IS NOT 1
        OR json_type(payload_json, '$.checkpoint.evidenceCoverage') IS NOT 'object'
        OR json_extract(payload_json,
          '$.checkpoint.evidenceCoverage.highestContiguousOrdinal') IS NOT NULL
        OR json_type(payload_json,
          '$.checkpoint.evidenceCoverage.missingIntervals') IS NOT 'array'
        OR json_array_length(json_extract(payload_json,
          '$.checkpoint.evidenceCoverage.missingIntervals')) <> 0
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM events
    WHERE stream_type = 'session' AND session_id IS NOT NULL
      AND (
        (event_type = 'SessionEndRequested'
          AND json_type(payload_json, '$.requestVersion') IS NOT NULL)
        OR (event_type = 'SessionEndAmended'
          AND json_type(payload_json, '$.amendmentVersion') IS NOT NULL)
      )
  )
THEN 1 ELSE 0 END;

ALTER TABLE session_evidence_coverage
  ADD COLUMN coverage_fingerprint_algorithm TEXT NOT NULL DEFAULT 'hmac-sha256'
  CHECK (coverage_fingerprint_algorithm = 'hmac-sha256');
ALTER TABLE session_evidence_coverage
  ADD COLUMN coverage_fingerprint_schema_version INTEGER NOT NULL DEFAULT 1
  CHECK (coverage_fingerprint_schema_version = 1);
ALTER TABLE session_evidence_coverage
  ADD COLUMN coverage_fingerprint_key_id TEXT NOT NULL DEFAULT '';
ALTER TABLE session_evidence_coverage
  ADD COLUMN coverage_fingerprint_domain TEXT NOT NULL DEFAULT 'pm-evidence-coverage-v1'
  CHECK (coverage_fingerprint_domain = 'pm-evidence-coverage-v1');
ALTER TABLE session_evidence_coverage
  ADD COLUMN coverage_fingerprint_value TEXT NOT NULL DEFAULT '${"0".repeat(64)}'
  CHECK (
    length(coverage_fingerprint_value) = 64
    AND coverage_fingerprint_value NOT GLOB '*[^0-9a-f]*'
  );

CREATE UNIQUE INDEX session_evidence_coverage_project_adapter
ON session_evidence_coverage(project_id, adapter_session_id);

CREATE TABLE session_evidence_coverage_transitions (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  adapter_session_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  batch_event_position INTEGER NOT NULL CHECK (batch_event_position > 0),
  batch_first_ordinal INTEGER NOT NULL CHECK (batch_first_ordinal >= 0),
  batch_last_ordinal INTEGER NOT NULL CHECK (batch_last_ordinal >= batch_first_ordinal),
  coverage_first_ordinal INTEGER NOT NULL CHECK (coverage_first_ordinal = 0),
  coverage_last_ordinal INTEGER NOT NULL CHECK (coverage_last_ordinal >= 0),
  highest_contiguous_ordinal INTEGER NOT NULL CHECK (
    highest_contiguous_ordinal >= -1
    AND highest_contiguous_ordinal <= coverage_last_ordinal
  ),
  missing_intervals_json TEXT NOT NULL CHECK (
    json_valid(missing_intervals_json)
    AND json_type(missing_intervals_json) = 'array'
    AND json(missing_intervals_json) = missing_intervals_json
    AND json_array_length(missing_intervals_json) <= 200
  ),
  frame_fingerprint_algorithm TEXT NOT NULL CHECK (frame_fingerprint_algorithm = 'hmac-sha256'),
  frame_fingerprint_schema_version INTEGER NOT NULL CHECK (frame_fingerprint_schema_version = 1),
  frame_fingerprint_key_id TEXT NOT NULL CHECK (length(trim(frame_fingerprint_key_id)) > 0),
  frame_fingerprint_domain TEXT NOT NULL CHECK (frame_fingerprint_domain = 'pm-evidence-frame-v1'),
  previous_coverage_fingerprint_value TEXT CHECK (
    previous_coverage_fingerprint_value IS NULL
    OR (
      length(previous_coverage_fingerprint_value) = 64
      AND previous_coverage_fingerprint_value NOT GLOB '*[^0-9a-f]*'
    )
  ),
  coverage_fingerprint_algorithm TEXT NOT NULL CHECK (coverage_fingerprint_algorithm = 'hmac-sha256'),
  coverage_fingerprint_schema_version INTEGER NOT NULL CHECK (coverage_fingerprint_schema_version = 1),
  coverage_fingerprint_key_id TEXT NOT NULL CHECK (
    length(trim(coverage_fingerprint_key_id)) > 0
    AND coverage_fingerprint_key_id = frame_fingerprint_key_id
  ),
  coverage_fingerprint_domain TEXT NOT NULL CHECK (coverage_fingerprint_domain = 'pm-evidence-coverage-v1'),
  coverage_fingerprint_value TEXT NOT NULL CHECK (
    length(coverage_fingerprint_value) = 64
    AND coverage_fingerprint_value NOT GLOB '*[^0-9a-f]*'
  ),
  new_frame_count INTEGER NOT NULL CHECK (new_frame_count >= 0),
  capture_mode TEXT NOT NULL CHECK (capture_mode = 'coverage-only'),
  content_retained INTEGER NOT NULL CHECK (content_retained = 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id, adapter_session_id, batch_event_position),
  UNIQUE (project_id, adapter_session_id, batch_id),
  FOREIGN KEY (project_id, session_id, adapter_session_id)
    REFERENCES session_evidence_coverage(project_id, session_id, adapter_session_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (batch_event_position)
    REFERENCES events(global_position)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX session_evidence_coverage_transitions_snapshot
ON session_evidence_coverage_transitions(
  project_id, session_id, adapter_session_id, batch_event_position DESC
);

ALTER TABLE workflow_instances
  ADD COLUMN evidence_frozen_checkpoint_event_position INTEGER;
ALTER TABLE workflow_instances
  ADD COLUMN evidence_frozen_generation INTEGER;
ALTER TABLE workflow_instances
  ADD COLUMN evidence_window_state TEXT CHECK (evidence_window_state IN ('open', 'sealed'));
ALTER TABLE workflow_instances
  ADD COLUMN final_ending_scope_bindings_json TEXT;

UPDATE workflow_instances
SET evidence_frozen_checkpoint_event_position = (
      SELECT stage.evidence_frozen_checkpoint_event_position
      FROM qualified_checkpoint_v3_stage_rows AS stage
      WHERE stage.workflow_id = workflow_instances.workflow_id
    ),
    evidence_frozen_generation = (
      SELECT stage.evidence_frozen_generation
      FROM qualified_checkpoint_v3_stage_rows AS stage
      WHERE stage.workflow_id = workflow_instances.workflow_id
    ),
    evidence_window_state = (
      SELECT stage.evidence_window_state
      FROM qualified_checkpoint_v3_stage_rows AS stage
      WHERE stage.workflow_id = workflow_instances.workflow_id
    ),
    final_ending_scope_bindings_json = (
      SELECT stage.final_ending_scope_bindings_json
      FROM qualified_checkpoint_v3_stage_rows AS stage
      WHERE stage.workflow_id = workflow_instances.workflow_id
    )
WHERE session_id IS NOT NULL;

DELETE FROM qualified_checkpoint_v3_guard;
INSERT INTO qualified_checkpoint_v3_guard(value)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1
    FROM workflow_instances AS workflow
    JOIN qualified_checkpoint_v3_stage_rows AS stage
      ON stage.workflow_id = workflow.workflow_id
    WHERE workflow.generation <> stage.source_generation
      OR workflow.phase <> stage.source_phase
      OR workflow.evidence_frozen_checkpoint_event_position
        IS NOT stage.evidence_frozen_checkpoint_event_position
      OR workflow.evidence_frozen_generation IS NOT stage.evidence_frozen_generation
      OR workflow.evidence_window_state IS NOT stage.evidence_window_state
      OR workflow.final_ending_scope_bindings_json
        IS NOT stage.final_ending_scope_bindings_json
  )
  AND NOT EXISTS (
    SELECT 1 FROM workflow_instances
    WHERE session_id IS NULL AND (
      evidence_frozen_checkpoint_event_position IS NOT NULL
      OR evidence_frozen_generation IS NOT NULL
      OR evidence_window_state IS NOT NULL
      OR final_ending_scope_bindings_json IS NOT NULL
    )
  )
THEN 1 ELSE 0 END;

CREATE TRIGGER session_evidence_coverage_v3_insert_guard
BEFORE INSERT ON session_evidence_coverage
WHEN NEW.first_ordinal <> 0
  OR NEW.coverage_fingerprint_algorithm <> 'hmac-sha256'
  OR NEW.coverage_fingerprint_schema_version <> 1
  OR NEW.coverage_fingerprint_key_id <> NEW.fingerprint_key_id
  OR NEW.coverage_fingerprint_domain <> 'pm-evidence-coverage-v1'
  OR length(NEW.coverage_fingerprint_value) <> 64
  OR NEW.coverage_fingerprint_value GLOB '*[^0-9a-f]*'
  OR (SELECT count(*) FROM session_evidence_coverage
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id) >= 200
  OR (SELECT coalesce(sum(json_array_length(missing_intervals_json)), 0)
      FROM session_evidence_coverage
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id)
      + json_array_length(NEW.missing_intervals_json) > 200
  OR NOT EXISTS (
    SELECT 1 FROM session_evidence_coverage_transitions AS transition
    WHERE transition.project_id = NEW.project_id
      AND transition.session_id = NEW.session_id
      AND transition.adapter_session_id = NEW.adapter_session_id
      AND transition.batch_id = NEW.latest_batch_id
      AND transition.batch_event_position = NEW.latest_batch_event_position
      AND transition.coverage_first_ordinal = NEW.first_ordinal
      AND transition.coverage_last_ordinal = NEW.last_ordinal
      AND transition.highest_contiguous_ordinal = NEW.highest_contiguous_ordinal
      AND transition.missing_intervals_json IS NEW.missing_intervals_json
      AND transition.frame_fingerprint_algorithm IS NEW.fingerprint_algorithm
      AND transition.frame_fingerprint_schema_version = NEW.fingerprint_schema_version
      AND transition.frame_fingerprint_key_id IS NEW.fingerprint_key_id
      AND transition.frame_fingerprint_domain IS NEW.fingerprint_domain
      AND transition.coverage_fingerprint_algorithm IS NEW.coverage_fingerprint_algorithm
      AND transition.coverage_fingerprint_schema_version = NEW.coverage_fingerprint_schema_version
      AND transition.coverage_fingerprint_key_id IS NEW.coverage_fingerprint_key_id
      AND transition.coverage_fingerprint_domain IS NEW.coverage_fingerprint_domain
      AND transition.coverage_fingerprint_value IS NEW.coverage_fingerprint_value
      AND transition.capture_mode IS NEW.capture_mode
      AND transition.content_retained = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'SESSION_EVIDENCE_COVERAGE_INVALID');
END;

CREATE TRIGGER session_evidence_coverage_v3_update_guard
BEFORE UPDATE ON session_evidence_coverage
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.adapter_session_id IS NOT OLD.adapter_session_id
  OR NEW.capture_mode IS NOT OLD.capture_mode
  OR NEW.first_ordinal IS NOT OLD.first_ordinal
  OR NEW.fingerprint_algorithm IS NOT OLD.fingerprint_algorithm
  OR NEW.fingerprint_schema_version IS NOT OLD.fingerprint_schema_version
  OR NEW.fingerprint_key_id IS NOT OLD.fingerprint_key_id
  OR NEW.fingerprint_domain IS NOT OLD.fingerprint_domain
  OR NEW.coverage_fingerprint_algorithm IS NOT OLD.coverage_fingerprint_algorithm
  OR NEW.coverage_fingerprint_schema_version IS NOT OLD.coverage_fingerprint_schema_version
  OR NEW.coverage_fingerprint_key_id IS NOT OLD.coverage_fingerprint_key_id
  OR NEW.coverage_fingerprint_domain IS NOT OLD.coverage_fingerprint_domain
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.last_ordinal < OLD.last_ordinal
  OR NEW.highest_contiguous_ordinal < OLD.highest_contiguous_ordinal
  OR NEW.latest_batch_event_position <= OLD.latest_batch_event_position
  OR NEW.coverage_fingerprint_key_id <> NEW.fingerprint_key_id
  OR (SELECT coalesce(sum(json_array_length(missing_intervals_json)), 0)
      FROM session_evidence_coverage
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id
        AND NOT (
          project_id = OLD.project_id AND session_id = OLD.session_id
          AND adapter_session_id = OLD.adapter_session_id
        )) + json_array_length(NEW.missing_intervals_json) > 200
  OR NOT EXISTS (
    SELECT 1 FROM session_evidence_coverage_transitions AS transition
    WHERE transition.project_id = NEW.project_id
      AND transition.session_id = NEW.session_id
      AND transition.adapter_session_id = NEW.adapter_session_id
      AND transition.batch_id = NEW.latest_batch_id
      AND transition.batch_event_position = NEW.latest_batch_event_position
      AND transition.coverage_first_ordinal = NEW.first_ordinal
      AND transition.coverage_last_ordinal = NEW.last_ordinal
      AND transition.highest_contiguous_ordinal = NEW.highest_contiguous_ordinal
      AND transition.missing_intervals_json IS NEW.missing_intervals_json
      AND transition.frame_fingerprint_algorithm IS NEW.fingerprint_algorithm
      AND transition.frame_fingerprint_schema_version = NEW.fingerprint_schema_version
      AND transition.frame_fingerprint_key_id IS NEW.fingerprint_key_id
      AND transition.frame_fingerprint_domain IS NEW.fingerprint_domain
      AND transition.coverage_fingerprint_algorithm IS NEW.coverage_fingerprint_algorithm
      AND transition.coverage_fingerprint_schema_version = NEW.coverage_fingerprint_schema_version
      AND transition.coverage_fingerprint_key_id IS NEW.coverage_fingerprint_key_id
      AND transition.coverage_fingerprint_domain IS NEW.coverage_fingerprint_domain
      AND transition.coverage_fingerprint_value IS NEW.coverage_fingerprint_value
      AND transition.capture_mode IS NEW.capture_mode
      AND transition.content_retained = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'SESSION_EVIDENCE_COVERAGE_INVALID');
END;

CREATE TRIGGER session_evidence_coverage_no_delete
BEFORE DELETE ON session_evidence_coverage
BEGIN
  SELECT RAISE(ABORT, 'SESSION_EVIDENCE_COVERAGE_IMMUTABLE');
END;

CREATE TRIGGER session_evidence_coverage_transitions_insert_guard
BEFORE INSERT ON session_evidence_coverage_transitions
WHEN NEW.coverage_first_ordinal <> 0
  OR NEW.batch_last_ordinal > NEW.coverage_last_ordinal
  OR NEW.new_frame_count <> NEW.batch_last_ordinal - NEW.batch_first_ordinal + 1
  OR NEW.frame_fingerprint_algorithm <> 'hmac-sha256'
  OR NEW.frame_fingerprint_schema_version <> 1
  OR NEW.frame_fingerprint_domain <> 'pm-evidence-frame-v1'
  OR NEW.coverage_fingerprint_algorithm <> 'hmac-sha256'
  OR NEW.coverage_fingerprint_schema_version <> 1
  OR NEW.coverage_fingerprint_key_id <> NEW.frame_fingerprint_key_id
  OR NEW.coverage_fingerprint_domain <> 'pm-evidence-coverage-v1'
  OR NOT EXISTS (
    SELECT 1 FROM events AS event
    WHERE event.global_position = NEW.batch_event_position
      AND event.project_id = NEW.project_id
      AND event.session_id = NEW.session_id
      AND event.stream_type = 'session'
      AND event.event_type = 'EvidenceCoverageRecorded'
      AND event.event_schema_version = 2
      AND json_extract(event.payload_json, '$.adapterSessionId') = NEW.adapter_session_id
      AND json_extract(event.payload_json, '$.batchId') = NEW.batch_id
      AND CAST(json_extract(event.payload_json, '$.batchFirstOrdinal') AS INTEGER)
        = NEW.batch_first_ordinal
      AND CAST(json_extract(event.payload_json, '$.batchLastOrdinal') AS INTEGER)
        = NEW.batch_last_ordinal
      AND CAST(json_extract(event.payload_json, '$.coverageFirstOrdinal') AS INTEGER)
        = NEW.coverage_first_ordinal
      AND CAST(json_extract(event.payload_json, '$.coverageLastOrdinal') AS INTEGER)
        = NEW.coverage_last_ordinal
      AND coalesce(CAST(json_extract(event.payload_json,
        '$.highestContiguousOrdinal') AS INTEGER), -1) = NEW.highest_contiguous_ordinal
      AND json_array_length(json_extract(event.payload_json, '$.missingIntervals'))
        = json_array_length(NEW.missing_intervals_json)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(event.payload_json, '$.missingIntervals') AS interval
        WHERE CAST(json_extract(interval.value, '$.firstOrdinal') AS INTEGER)
            <> json_extract(NEW.missing_intervals_json,
              '$[' || interval.key || '][0]')
          OR CAST(json_extract(interval.value, '$.lastOrdinal') AS INTEGER)
            <> json_extract(NEW.missing_intervals_json,
              '$[' || interval.key || '][1]')
      )
      AND json_extract(event.payload_json, '$.frameFingerprintAlgorithm')
        IS NEW.frame_fingerprint_algorithm
      AND json_extract(event.payload_json, '$.frameFingerprintSchemaVersion')
        = NEW.frame_fingerprint_schema_version
      AND json_extract(event.payload_json, '$.frameFingerprintKeyId')
        IS NEW.frame_fingerprint_key_id
      AND json_extract(event.payload_json, '$.frameFingerprintDomain')
        IS NEW.frame_fingerprint_domain
      AND json_extract(event.payload_json, '$.coverageFingerprintAlgorithm')
        IS NEW.coverage_fingerprint_algorithm
      AND json_extract(event.payload_json, '$.coverageFingerprintSchemaVersion')
        = NEW.coverage_fingerprint_schema_version
      AND json_extract(event.payload_json, '$.coverageFingerprintKeyId')
        IS NEW.coverage_fingerprint_key_id
      AND json_extract(event.payload_json, '$.coverageFingerprintDomain')
        IS NEW.coverage_fingerprint_domain
      AND json_extract(event.payload_json, '$.coverageFingerprint')
        IS NEW.coverage_fingerprint_value
      AND json_array_length(json_extract(event.payload_json, '$.frames'))
        = NEW.new_frame_count
      AND json_extract(event.payload_json, '$.captureMode') IS NEW.capture_mode
      AND json_extract(event.payload_json, '$.contentRetained') = NEW.content_retained
  )
  OR (
    NEW.previous_coverage_fingerprint_value IS NULL
      AND EXISTS (
        SELECT 1 FROM session_evidence_coverage_transitions AS prior
        WHERE prior.project_id = NEW.project_id
          AND prior.session_id = NEW.session_id
          AND prior.adapter_session_id = NEW.adapter_session_id
      )
  )
  OR (
    NEW.previous_coverage_fingerprint_value IS NOT NULL
      AND NEW.previous_coverage_fingerprint_value IS NOT (
        SELECT prior.coverage_fingerprint_value
        FROM session_evidence_coverage_transitions AS prior
        WHERE prior.project_id = NEW.project_id
          AND prior.session_id = NEW.session_id
          AND prior.adapter_session_id = NEW.adapter_session_id
        ORDER BY prior.batch_event_position DESC LIMIT 1
      )
  )
  OR EXISTS (
    SELECT 1 FROM session_evidence_coverage_transitions AS prior
    WHERE prior.project_id = NEW.project_id
      AND prior.session_id = NEW.session_id
      AND prior.adapter_session_id = NEW.adapter_session_id
      AND prior.batch_event_position = (
        SELECT max(latest.batch_event_position)
        FROM session_evidence_coverage_transitions AS latest
        WHERE latest.project_id = NEW.project_id
          AND latest.session_id = NEW.session_id
          AND latest.adapter_session_id = NEW.adapter_session_id
      )
      AND (
        NEW.batch_event_position <= prior.batch_event_position
        OR NEW.coverage_last_ordinal < prior.coverage_last_ordinal
        OR NEW.highest_contiguous_ordinal < prior.highest_contiguous_ordinal
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'SESSION_EVIDENCE_COVERAGE_TRANSITION_INVALID');
END;

CREATE TRIGGER session_evidence_coverage_transitions_no_update
BEFORE UPDATE ON session_evidence_coverage_transitions
BEGIN
  SELECT RAISE(ABORT, 'SESSION_EVIDENCE_COVERAGE_TRANSITION_IMMUTABLE');
END;

CREATE TRIGGER session_evidence_coverage_transitions_no_delete
BEFORE DELETE ON session_evidence_coverage_transitions
BEGIN
  SELECT RAISE(ABORT, 'SESSION_EVIDENCE_COVERAGE_TRANSITION_IMMUTABLE');
END;

CREATE TRIGGER events_lifecycle_version_v3_guard
BEFORE INSERT ON events
WHEN NEW.stream_type = 'session' AND NEW.session_id IS NOT NULL AND (
  (NEW.event_type = 'EvidenceCoverageRecorded' AND NEW.event_schema_version <> 2)
  OR (NEW.event_type = 'SessionCheckpointRecorded' AND NOT (
    (NEW.event_schema_version = 1
      AND json_type(NEW.payload_json, '$.checkpoint.checkpointVersion') IS 'integer'
      AND json_extract(NEW.payload_json, '$.checkpoint.checkpointVersion') IS 1)
    OR (NEW.event_schema_version = 2
      AND json_type(NEW.payload_json, '$.checkpoint.checkpointVersion') IS 'integer'
      AND json_extract(NEW.payload_json, '$.checkpoint.checkpointVersion') IS 2)
  ))
  OR (NEW.event_type = 'SessionEndRequested' AND NOT (
    (NEW.event_schema_version = 1
      AND json_type(NEW.payload_json, '$.requestVersion') IS NULL)
    OR (NEW.event_schema_version = 2
      AND json_type(NEW.payload_json, '$.requestVersion') IS 'integer'
      AND json_extract(NEW.payload_json, '$.requestVersion') IS 2)
  ))
  OR (NEW.event_type = 'SessionEndAmended' AND NOT (
    (NEW.event_schema_version = 1
      AND json_type(NEW.payload_json, '$.amendmentVersion') IS NULL)
    OR (NEW.event_schema_version = 2
      AND json_type(NEW.payload_json, '$.amendmentVersion') IS 'integer'
      AND json_extract(NEW.payload_json, '$.amendmentVersion') IS 2)
  ))
  OR (NEW.event_type IN (
    'SessionStarted', 'SessionOwnerTransferred', 'SessionOwnershipRecovered',
    'SessionSuspendRequested', 'SessionSuspended', 'SessionResumed',
    'SessionForked', 'ChildAssignmentAmended', 'ChildWorkReported',
    'ChildWorkDispositioned', 'ChildCompletionProposed', 'ChildSessionCompleted',
    'ChildSessionSuspended', 'ChildWorkTransferCreated', 'ChildWorkTransferClaimed',
    'SessionValidationResultRecorded', 'SessionEndVerificationPassed',
    'SessionEndVerificationFailed', 'SessionEndVerificationInvalidated',
    'SessionEndCancelled', 'SessionAbandoned', 'SessionEnded'
  ) AND NEW.event_schema_version <> 1)
)
BEGIN
  SELECT RAISE(ABORT, 'LIFECYCLE_EVENT_VERSION_INVALID');
END;

CREATE TRIGGER workflow_instances_evidence_v3_insert_guard
BEFORE INSERT ON workflow_instances
WHEN
  (NEW.session_id IS NULL AND (
    NEW.evidence_frozen_checkpoint_event_position IS NOT NULL
    OR NEW.evidence_frozen_generation IS NOT NULL
    OR NEW.evidence_window_state IS NOT NULL
    OR NEW.final_ending_scope_bindings_json IS NOT NULL
  ))
  OR (NEW.session_id IS NOT NULL AND (
    NEW.evidence_window_state IS NULL
    OR (NEW.evidence_frozen_checkpoint_event_position IS NULL)
      <> (NEW.evidence_frozen_generation IS NULL)
    OR (NEW.evidence_frozen_checkpoint_event_position IS NULL)
      <> (NEW.final_ending_scope_bindings_json IS NULL)
    OR (${FINAL_BINDINGS_INVALID})
    OR (${FROZEN_GROUP_INVALID})
    OR (NEW.evidence_window_state = 'open' AND (
      NEW.evidence_frozen_checkpoint_event_position IS NOT NULL
      OR NEW.phase NOT IN ('requested', 'children-resolved')
    ))
    OR (NEW.phase = 'cancelled' AND (
      NEW.evidence_window_state <> 'sealed'
      OR NEW.evidence_frozen_checkpoint_event_position IS NOT NULL
    ))
    OR (NEW.phase IN (
      'final-checkpoint-recorded', 'ending-materialization-queued', 'validating',
      'verification-passed', 'verification-failed', 'completion-appended',
      'completed-materialization-confirmed', 'completed'
    ) AND NEW.evidence_frozen_checkpoint_event_position IS NULL)
  ))
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_EVIDENCE_STATE_INVALID');
END;

CREATE TRIGGER workflow_instances_evidence_v3_update_guard
BEFORE UPDATE ON workflow_instances
WHEN
  (NEW.session_id IS NULL AND (
    NEW.evidence_frozen_checkpoint_event_position IS NOT NULL
    OR NEW.evidence_frozen_generation IS NOT NULL
    OR NEW.evidence_window_state IS NOT NULL
    OR NEW.final_ending_scope_bindings_json IS NOT NULL
  ))
  OR (NEW.session_id IS NOT NULL AND (
    NEW.evidence_window_state IS NULL
    OR (NEW.evidence_frozen_checkpoint_event_position IS NULL)
      <> (NEW.evidence_frozen_generation IS NULL)
    OR (NEW.evidence_frozen_checkpoint_event_position IS NULL)
      <> (NEW.final_ending_scope_bindings_json IS NULL)
    OR (${FINAL_BINDINGS_INVALID})
    OR (${FROZEN_GROUP_INVALID})
    OR (NEW.evidence_window_state = 'open' AND (
      NEW.evidence_frozen_checkpoint_event_position IS NOT NULL
      OR NEW.phase NOT IN ('requested', 'children-resolved')
    ))
    OR (NEW.phase = 'cancelled' AND (
      NEW.evidence_window_state <> 'sealed'
      OR NEW.evidence_frozen_checkpoint_event_position IS NOT NULL
    ))
    OR (NEW.phase IN (
      'final-checkpoint-recorded', 'ending-materialization-queued', 'validating',
      'verification-passed', 'verification-failed', 'completion-appended',
      'completed-materialization-confirmed', 'completed'
    ) AND NEW.evidence_frozen_checkpoint_event_position IS NULL)
    OR (
      (NEW.evidence_frozen_checkpoint_event_position IS NOT OLD.evidence_frozen_checkpoint_event_position
        OR NEW.evidence_frozen_generation IS NOT OLD.evidence_frozen_generation
        OR NEW.evidence_window_state IS NOT OLD.evidence_window_state
        OR NEW.final_ending_scope_bindings_json IS NOT OLD.final_ending_scope_bindings_json)
      AND NOT (
        (OLD.evidence_window_state = 'sealed' AND NEW.evidence_window_state = 'open'
          AND NEW.generation = OLD.generation + 1
          AND NEW.evidence_frozen_checkpoint_event_position IS NULL)
        OR (OLD.evidence_window_state = 'open' AND NEW.evidence_window_state = 'sealed'
          AND NEW.generation = OLD.generation + 1
          AND NEW.evidence_frozen_checkpoint_event_position IS NULL)
        OR (OLD.evidence_window_state = 'sealed' AND NEW.evidence_window_state = 'sealed'
          AND OLD.evidence_frozen_checkpoint_event_position IS NULL
          AND NEW.evidence_frozen_checkpoint_event_position IS NOT NULL
          AND NEW.generation = OLD.generation
          AND NEW.evidence_frozen_generation = NEW.generation)
        OR (OLD.phase <> 'cancelled' AND NEW.phase = 'cancelled'
          AND NEW.generation = OLD.generation
          AND NEW.evidence_window_state = 'sealed'
          AND NEW.evidence_frozen_checkpoint_event_position IS NULL)
        OR (OLD.phase = 'cancelled' AND NEW.phase = 'requested'
          AND NEW.generation = OLD.generation + 1
          AND NEW.evidence_window_state = 'sealed'
          AND NEW.evidence_frozen_checkpoint_event_position IS NULL)
      )
    )
  ))
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_EVIDENCE_STATE_INVALID');
END;

DROP TRIGGER qualified_checkpoint_v3_stage_marker_no_insert;
DROP TRIGGER qualified_checkpoint_v3_stage_marker_no_update;
DROP TRIGGER qualified_checkpoint_v3_stage_marker_no_delete;
DROP TRIGGER qualified_checkpoint_v3_stage_rows_no_insert;
DROP TRIGGER qualified_checkpoint_v3_stage_rows_no_update;
DROP TRIGGER qualified_checkpoint_v3_stage_rows_no_delete;
DROP TRIGGER qualified_checkpoint_v3_guard_abort;
DROP TABLE qualified_checkpoint_v3_guard;
DROP TABLE qualified_checkpoint_v3_stage_marker;
DROP TABLE qualified_checkpoint_v3_stage_rows;
`,
};
