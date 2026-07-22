import type { Migration } from "../migration.js";

const PRECONDITION = "MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED";
const SQLITE_INT64_MAX_TEXT = "9223372036854775807";
const UUID_GLOB = "[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-5][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]";

function strictUnsignedDecimal(expression: string): string {
  return `(
    typeof(${expression}) = 'text'
    AND length(${expression}) BETWEEN 1 AND 19
    AND ${expression} NOT GLOB '*[^0-9]*'
    AND (${expression} = '0' OR ${expression} NOT GLOB '0*')
    AND (length(${expression}) < 19 OR ${expression} <= '${SQLITE_INT64_MAX_TEXT}')
  )`;
}

function canonicalUuid(expression: string): string {
  return `(
    typeof(${expression}) = 'text'
    AND length(${expression}) = 36
    AND lower(${expression}) = ${expression}
    AND ${expression} GLOB '${UUID_GLOB}'
  )`;
}

const LEGACY_V1_PAYLOAD_KEYS = Object.freeze({
  SessionStarted: [
    "sessionKind", "ownerGeneration", "continuityKey", "clientNamespace",
    "creatingAgentId", "creatingClientInstanceId", "authorityCommitment",
  ],
  SessionOwnerTransferred: [
    "previousOwnerGeneration", "ownerGeneration", "authorityCommitment",
  ],
  SessionOwnershipRecovered: [
    "previousOwnerGeneration", "ownerGeneration", "approvalId", "authorityCommitment",
  ],
  SessionSuspendRequested: ["checkpointId"],
  SessionSuspended: ["authorityCommitment"],
  SessionResumed: ["ownerGeneration"],
  SessionCheckpointRecorded: ["checkpoint", "baseEventPosition", "checkpointEventPosition"],
  EvidenceCoverageRecorded: [
    "adapterSessionId", "batchId", "firstOrdinal", "lastOrdinal",
    "highestContiguousOrdinal", "missingIntervals", "fingerprintSchemaVersion",
    "fingerprintKeyId", "fingerprintDomain", "coverageFingerprint", "captureMode",
    "contentRetained", "frames",
  ],
  SessionForked: [
    "parentSessionId", "assignment", "rootOwnerGeneration", "directAccessEnabled",
    "authorityCommitment", "sourceTransferTicketId",
  ],
  ChildAssignmentAmended: [
    "previousAssignmentRevision", "assignmentRevision", "assignment", "reasonCode",
  ],
  ChildWorkReported: ["report", "childAuthorAgentId", "primaryRecorderAgentId"],
  ChildWorkDispositioned: ["disposition"],
  ChildCompletionProposed: ["reportId"],
  ChildSessionCompleted: ["reportId", "authorityCommitment"],
  ChildSessionSuspended: ["checkpointId", "blockers", "followUps", "authorityCommitment"],
  ChildWorkTransferCreated: ["transferTicketId", "checkpointId", "authorityCommitment"],
  ChildWorkTransferClaimed: [
    "transferTicketId", "previousChildSessionId", "previousTransferEventPosition",
  ],
  SessionEndRequested: [
    "workflowId", "workflowGeneration", "previousState", "childEndPolicy",
    "qualityThreshold", "requireFullEvidence", "requireMaterialization",
  ],
  SessionEndAmended: [
    "workflowId", "previousWorkflowGeneration", "workflowGeneration",
    "preTransitionCheckpointId",
  ],
  SessionValidationResultRecorded: [
    "workflowId", "workflowGeneration", "plannedWorkId", "validationResult",
  ],
  SessionEndVerificationPassed: [
    "workflowId", "workflowGeneration", "validationResultIds", "qualityScore",
  ],
  SessionEndVerificationFailed: [
    "workflowId", "workflowGeneration", "validationResultIds", "safeFailureCode",
  ],
  SessionEndVerificationInvalidated: [
    "workflowId", "workflowGeneration", "previousVerificationEventPosition",
    "safeFailureCode",
  ],
  SessionEndCancelled: [
    "workflowId", "workflowGeneration", "restoredState", "preTransitionCheckpointId",
  ],
  SessionAbandoned: [
    "workflowId", "workflowGeneration", "approvalId", "preTransitionCheckpointId",
    "reasonCode", "authorityCommitment",
  ],
  SessionEnded: [
    "workflowId", "workflowGeneration", "verificationEventPosition", "authorityCommitment",
  ],
} as const);

const LEGACY_V1_PAYLOAD_SHAPE_VALID = Object.entries(LEGACY_V1_PAYLOAD_KEYS)
  .map(([eventType, keys]) => `(
    legacy_event.event_type = '${eventType}'
    AND (SELECT count(*) FROM json_each(legacy_event.payload_json)) = ${keys.length}
    AND (SELECT count(DISTINCT field.key)
         FROM json_each(legacy_event.payload_json) AS field) = ${keys.length}
    AND NOT EXISTS (
      SELECT 1 FROM json_each(legacy_event.payload_json) AS field
      WHERE field.key NOT IN (${keys.map((key) => `'${key}'`).join(", ")})
    )
  )`)
  .join("\nOR\n");
const LEGACY_V1_EVENT_TYPES_SQL = Object.keys(LEGACY_V1_PAYLOAD_KEYS)
  .map((eventType) => `'${eventType}'`)
  .join(", ");

const FINAL_BINDINGS_INVALID = `
  NEW.final_ending_scope_bindings_json IS NOT NULL AND (
    NOT json_valid(NEW.final_ending_scope_bindings_json)
    OR json_type(NEW.final_ending_scope_bindings_json) <> 'array'
    OR json(NEW.final_ending_scope_bindings_json)
      <> NEW.final_ending_scope_bindings_json
    OR length(CAST(NEW.final_ending_scope_bindings_json AS BLOB)) > 262144
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.final_ending_scope_bindings_json) AS binding
      WHERE json_type(binding.value) <> 'object'
        OR (SELECT count(*) FROM json_each(binding.value)) <> 10
        OR (SELECT count(DISTINCT field.key)
            FROM json_each(binding.value) AS field) <> 10
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
        OR NOT ${canonicalUuid("json_extract(binding.value, '$.childSessionId')")}
        OR json_type(binding.value, '$.childState') <> 'text'
        OR json_extract(binding.value, '$.childState') NOT IN (
          'active', 'completion-proposed', 'completed', 'suspended', 'transferred'
        )
        OR NOT ${strictUnsignedDecimal("json_extract(binding.value, '$.lastEventPosition')")}
        OR json_extract(binding.value, '$.lastEventPosition') = '0'
        OR NOT ${strictUnsignedDecimal("json_extract(binding.value, '$.streamVersion')")}
        OR json_extract(binding.value, '$.streamVersion') = '0'
        OR (json_extract(binding.value, '$.checkpointId') IS NULL)
          <> (json_extract(binding.value, '$.checkpointEventPosition') IS NULL)
        OR (json_extract(binding.value, '$.checkpointId') IS NOT NULL
          AND NOT ${canonicalUuid("json_extract(binding.value, '$.checkpointId')")})
        OR (json_extract(binding.value, '$.checkpointEventPosition') IS NOT NULL AND (
          NOT ${strictUnsignedDecimal("json_extract(binding.value, '$.checkpointEventPosition')")}
          OR json_extract(binding.value, '$.checkpointEventPosition') = '0'
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
          OR NOT EXISTS (
            SELECT 1
            FROM session_authority AS child
            JOIN streams AS child_stream
              ON child_stream.project_id = child.project_id
              AND child_stream.stream_id = child.stream_id
            JOIN events AS child_event
              ON child_event.project_id = child.project_id
              AND child_event.global_position = CAST(
                json_extract(binding.value, '$.lastEventPosition') AS INTEGER
              )
              AND child_event.session_id = child.session_id
              AND child_event.stream_version = child_stream.current_version
            WHERE child.project_id = NEW.project_id
              AND child.session_id = json_extract(binding.value, '$.childSessionId')
              AND child.session_kind = 'child'
              AND child.parent_session_id = NEW.session_id
              AND child.semantic_state = json_extract(binding.value, '$.childState')
              AND coalesce(child.terminal_event_position, child.authority_event_position)
                = child_event.global_position
              AND CAST(child_stream.current_version AS TEXT)
                = json_extract(binding.value, '$.streamVersion')
              AND child.latest_checkpoint_id
                IS json_extract(binding.value, '$.checkpointId')
          )
        ))
        OR (json_extract(binding.value, '$.bindingKind') = 'carry-forward-ticket' AND (
          json_extract(binding.value, '$.childState') <> 'transferred'
          OR json_extract(binding.value, '$.checkpointId') IS NULL
          OR json_extract(binding.value, '$.transferTicketId') IS NULL
          OR NOT ${canonicalUuid("json_extract(binding.value, '$.transferTicketId')")}
          OR json_extract(binding.value, '$.transferTicketEventPosition') IS NULL
          OR NOT ${strictUnsignedDecimal("json_extract(binding.value, '$.transferTicketEventPosition')")}
          OR json_extract(binding.value, '$.transferTicketEventPosition') = '0'
          OR json_extract(binding.value, '$.lastEventPosition')
            <> json_extract(binding.value, '$.transferTicketEventPosition')
          OR NOT EXISTS (
            SELECT 1
            FROM child_transfer_tickets AS ticket
            JOIN events AS transfer_event
              ON transfer_event.project_id = ticket.project_id
              AND transfer_event.global_position = ticket.created_event_position
              AND transfer_event.session_id = ticket.source_child_session_id
              AND transfer_event.parent_session_id = ticket.source_parent_session_id
              AND transfer_event.event_type = 'ChildWorkTransferCreated'
              AND transfer_event.event_schema_version = 1
              AND json_extract(transfer_event.payload_json, '$.transferTicketId')
                = ticket.transfer_ticket_id
              AND json_extract(transfer_event.payload_json, '$.checkpointId')
                = ticket.checkpoint_id
            JOIN session_authority AS source_child
              ON source_child.project_id = ticket.project_id
              AND source_child.session_id = ticket.source_child_session_id
              AND source_child.session_kind = 'child'
              AND source_child.parent_session_id = ticket.source_parent_session_id
              AND source_child.semantic_state = 'transferred'
              AND source_child.terminal_event_position = ticket.created_event_position
              AND source_child.latest_checkpoint_id = ticket.checkpoint_id
            JOIN streams AS source_stream
              ON source_stream.project_id = source_child.project_id
              AND source_stream.stream_id = source_child.stream_id
              AND source_stream.current_version = transfer_event.stream_version
            WHERE ticket.project_id = NEW.project_id
              AND ticket.source_parent_session_id = NEW.session_id
              AND ticket.transfer_ticket_id = json_extract(binding.value, '$.transferTicketId')
              AND ticket.source_child_session_id
                = json_extract(binding.value, '$.childSessionId')
              AND ticket.checkpoint_id = json_extract(binding.value, '$.checkpointId')
              AND ticket.created_event_position = CAST(
                json_extract(binding.value, '$.transferTicketEventPosition') AS INTEGER
              )
              AND CAST(source_stream.current_version AS TEXT)
                = json_extract(binding.value, '$.streamVersion')
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

function resultStatusValue(path: string): string {
  return `(CASE
    WHEN json_type(NEW.result_json, '$.status') = 'object'
      THEN json_extract(NEW.result_json, '$.status${path}')
    ELSE json_extract(NEW.result_json, '$${path}')
  END)`;
}

function resultStatusType(path: string): string {
  return `(CASE
    WHEN json_type(NEW.result_json, '$.status') = 'object'
      THEN json_type(NEW.result_json, '$.status${path}')
    ELSE json_type(NEW.result_json, '$${path}')
  END)`;
}

const STATUS_KEYS = `
  'resultVersion', 'sessionId', 'workflowId', 'workflowGeneration', 'phase',
  'priorRootState', 'triggeringEventPosition', 'finalCheckpointId',
  'finalCheckpointEventPosition', 'evidenceWindow', 'validationPlansReady',
  'qualityScore', 'safeFailureCode', 'materializationRequired'
`;

const RESULT_INVALID = `
  NEW.result_json IS NOT NULL AND (
    NOT json_valid(NEW.result_json)
    OR json_type(NEW.result_json) IS NOT 'object'
    OR json(NEW.result_json) <> NEW.result_json
    OR NOT (
      (
        (SELECT count(*) FROM json_each(NEW.result_json)) = 14
        AND (SELECT count(DISTINCT field.key)
             FROM json_each(NEW.result_json) AS field) = 14
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.result_json) AS field
          WHERE field.key NOT IN (${STATUS_KEYS})
        )
      )
      OR
      (
        (SELECT count(*) FROM json_each(NEW.result_json)) = 5
        AND (SELECT count(DISTINCT field.key)
             FROM json_each(NEW.result_json) AS field) = 5
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.result_json) AS field
          WHERE field.key NOT IN (
            'resultVersion', 'action', 'progressed', 'previousPhase', 'status'
          )
        )
        AND json_type(NEW.result_json, '$.resultVersion') = 'integer'
        AND json_extract(NEW.result_json, '$.resultVersion') = 2
        AND json_type(NEW.result_json, '$.action') = 'text'
        AND json_extract(NEW.result_json, '$.action') IN (
          'mark-children-resolved', 'record-final-checkpoint-and-queue-ending',
          'confirm-ending-materialization', 'begin-validation',
          'record-verification-failed', 'record-verification-passed',
          'invalidate-verification', 'append-terminal-completion',
          'confirm-completed-materialization', 'complete-without-materialization',
          'complete-after-materialization'
        )
        AND json_type(NEW.result_json, '$.progressed') IN ('true', 'false')
        AND json_type(NEW.result_json, '$.previousPhase') = 'text'
        AND json_extract(NEW.result_json, '$.previousPhase') IN (
          'requested', 'children-resolved', 'final-checkpoint-recorded',
          'ending-materialization-queued', 'validating', 'verification-passed',
          'verification-failed', 'completion-appended',
          'completed-materialization-confirmed', 'completed', 'cancelled', 'abandoned'
        )
        AND json_type(NEW.result_json, '$.status') = 'object'
        AND (SELECT count(*) FROM json_each(NEW.result_json, '$.status')) = 14
        AND (SELECT count(DISTINCT field.key)
             FROM json_each(NEW.result_json, '$.status') AS field) = 14
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.result_json, '$.status') AS field
          WHERE field.key NOT IN (${STATUS_KEYS})
        )
      )
    )
    OR ${resultStatusType(".resultVersion")} IS NOT 'integer'
    OR ${resultStatusValue(".resultVersion")} <> 2
    OR ${resultStatusType(".sessionId")} IS NOT 'text'
    OR NOT ${canonicalUuid(resultStatusValue(".sessionId"))}
    OR ${resultStatusValue(".sessionId")} IS NOT NEW.session_id
    OR ${resultStatusType(".workflowId")} IS NOT 'text'
    OR ${resultStatusValue(".workflowId")} IS NOT NEW.workflow_id
    OR ${resultStatusType(".workflowGeneration")} IS NOT 'integer'
    OR ${resultStatusValue(".workflowGeneration")} <> NEW.generation
    OR ${resultStatusValue(".workflowGeneration")} <= 0
    OR ${resultStatusType(".phase")} IS NOT 'text'
    OR ${resultStatusValue(".phase")} IS NOT NEW.phase
    OR ${resultStatusValue(".phase")} NOT IN (
      'requested', 'children-resolved', 'final-checkpoint-recorded',
      'ending-materialization-queued', 'validating', 'verification-passed',
      'verification-failed', 'completion-appended',
      'completed-materialization-confirmed', 'completed', 'cancelled', 'abandoned'
    )
    OR ${resultStatusType(".priorRootState")} IS NOT 'text'
    OR ${resultStatusValue(".priorRootState")} NOT IN ('active', 'suspended')
    OR ${resultStatusType(".triggeringEventPosition")} IS NOT 'text'
    OR NOT ${strictUnsignedDecimal(resultStatusValue(".triggeringEventPosition"))}
    OR ${resultStatusValue(".triggeringEventPosition")} = '0'
    OR ${resultStatusValue(".triggeringEventPosition")}
      IS NOT CAST(NEW.triggering_event_position AS TEXT)
    OR ${resultStatusType(".finalCheckpointId")} NOT IN ('null', 'text')
    OR (${resultStatusType(".finalCheckpointId")} = 'text'
      AND NOT ${canonicalUuid(resultStatusValue(".finalCheckpointId"))})
    OR ${resultStatusType(".finalCheckpointEventPosition")} NOT IN ('null', 'text')
    OR (${resultStatusType(".finalCheckpointEventPosition")} = 'text' AND (
      NOT ${strictUnsignedDecimal(resultStatusValue(".finalCheckpointEventPosition"))}
      OR ${resultStatusValue(".finalCheckpointEventPosition")} = '0'
    ))
    OR (${resultStatusType(".finalCheckpointId")} = 'null')
      <> (${resultStatusType(".finalCheckpointEventPosition")} = 'null')
    OR ${resultStatusType(".evidenceWindow")} IS NOT 'object'
    OR (
      CASE WHEN json_type(NEW.result_json, '$.status') = 'object'
        THEN (SELECT count(*) FROM json_each(NEW.result_json, '$.status.evidenceWindow'))
        ELSE (SELECT count(*) FROM json_each(NEW.result_json, '$.evidenceWindow'))
      END
    ) <> 3
    OR (
      CASE WHEN json_type(NEW.result_json, '$.status') = 'object'
        THEN (SELECT count(DISTINCT field.key)
              FROM json_each(NEW.result_json, '$.status.evidenceWindow') AS field)
        ELSE (SELECT count(DISTINCT field.key)
              FROM json_each(NEW.result_json, '$.evidenceWindow') AS field)
      END
    ) <> 3
    OR EXISTS (
      SELECT 1 FROM json_each(
        NEW.result_json,
        CASE WHEN json_type(NEW.result_json, '$.status') = 'object'
          THEN '$.status.evidenceWindow' ELSE '$.evidenceWindow' END
      ) AS field
      WHERE field.key NOT IN (
        'evidenceWindowState', 'evidenceFrozenCheckpointEventPosition',
        'evidenceFrozenGeneration'
      )
    )
    OR ${resultStatusType(".evidenceWindow.evidenceWindowState")} IS NOT 'text'
    OR ${resultStatusValue(".evidenceWindow.evidenceWindowState")}
      IS NOT NEW.evidence_window_state
    OR ${resultStatusType(".evidenceWindow.evidenceFrozenCheckpointEventPosition")}
      NOT IN ('null', 'text')
    OR (${resultStatusType(".evidenceWindow.evidenceFrozenCheckpointEventPosition")} = 'text'
      AND (
        NOT ${strictUnsignedDecimal(
          resultStatusValue(".evidenceWindow.evidenceFrozenCheckpointEventPosition"),
        )}
        OR ${resultStatusValue(".evidenceWindow.evidenceFrozenCheckpointEventPosition")} = '0'
      ))
    OR ${resultStatusValue(".evidenceWindow.evidenceFrozenCheckpointEventPosition")}
      IS NOT CASE WHEN NEW.evidence_frozen_checkpoint_event_position IS NULL
        THEN NULL ELSE CAST(NEW.evidence_frozen_checkpoint_event_position AS TEXT) END
    OR ${resultStatusType(".evidenceWindow.evidenceFrozenGeneration")}
      NOT IN ('null', 'integer')
    OR (${resultStatusType(".evidenceWindow.evidenceFrozenGeneration")} = 'integer'
      AND (${resultStatusValue(".evidenceWindow.evidenceFrozenGeneration")} <= 0
        OR ${resultStatusValue(".evidenceWindow.evidenceFrozenGeneration")} > NEW.generation))
    OR ${resultStatusValue(".evidenceWindow.evidenceFrozenGeneration")}
      IS NOT NEW.evidence_frozen_generation
    OR ${resultStatusType(".validationPlansReady")} NOT IN ('true', 'false')
    OR ${resultStatusType(".qualityScore")} NOT IN ('null', 'integer')
    OR (${resultStatusType(".qualityScore")} = 'integer'
      AND ${resultStatusValue(".qualityScore")} NOT BETWEEN 0 AND 10000)
    OR ${resultStatusType(".safeFailureCode")} NOT IN ('null', 'text')
    OR ${resultStatusType(".materializationRequired")} NOT IN ('true', 'false')
  )`;

const FROZEN_GROUP_INVALID = `
  (NEW.evidence_frozen_checkpoint_event_position IS NOT NULL AND (
    NEW.evidence_frozen_generation IS NULL
    OR NEW.evidence_frozen_generation <= 0
    OR NEW.evidence_frozen_generation > NEW.generation
    OR NEW.result_json IS NULL
    OR ${resultStatusValue(".finalCheckpointEventPosition")}
      IS NOT CAST(NEW.evidence_frozen_checkpoint_event_position AS TEXT)
    OR NOT EXISTS (
      SELECT 1 FROM events AS final_checkpoint_event
      WHERE final_checkpoint_event.project_id = NEW.project_id
        AND final_checkpoint_event.session_id = NEW.session_id
        AND final_checkpoint_event.global_position
          = NEW.evidence_frozen_checkpoint_event_position
        AND final_checkpoint_event.event_type = 'SessionCheckpointRecorded'
        AND final_checkpoint_event.event_schema_version IN (1, 2)
        AND json_extract(final_checkpoint_event.payload_json,
          '$.checkpoint.checkpointId') IS ${resultStatusValue(".finalCheckpointId")}
        AND json_extract(final_checkpoint_event.payload_json,
          '$.checkpoint.checkpointEventPosition')
          IS CAST(NEW.evidence_frozen_checkpoint_event_position AS TEXT)
        AND json_type(final_checkpoint_event.payload_json,
          '$.checkpoint.childSummaries') = 'array'
        AND json_array_length(final_checkpoint_event.payload_json,
          '$.checkpoint.childSummaries')
          = json_array_length(NEW.final_ending_scope_bindings_json)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(NEW.final_ending_scope_bindings_json) AS binding
          WHERE json_extract(binding.value, '$.childSessionId') IS NOT json_extract(
              final_checkpoint_event.payload_json,
              '$.checkpoint.childSummaries[' || binding.key || '].childSessionId'
            )
            OR json_extract(binding.value, '$.childState') IS NOT json_extract(
              final_checkpoint_event.payload_json,
              '$.checkpoint.childSummaries[' || binding.key || '].state'
            )
            OR json_extract(binding.value, '$.lastEventPosition') IS NOT json_extract(
              final_checkpoint_event.payload_json,
              '$.checkpoint.childSummaries[' || binding.key || '].lastEventPosition'
            )
            OR json_extract(binding.value, '$.streamVersion') IS NOT json_extract(
              final_checkpoint_event.payload_json,
              '$.checkpoint.childSummaries[' || binding.key || '].streamVersion'
            )
            OR json_extract(binding.value, '$.checkpointId') IS NOT json_extract(
              final_checkpoint_event.payload_json,
              '$.checkpoint.childSummaries[' || binding.key || '].latestCheckpointId'
            )
        )
    )
  ))
  OR (NEW.evidence_frozen_checkpoint_event_position IS NULL
    AND NEW.result_json IS NOT NULL
    AND (${resultStatusType(".finalCheckpointId")} <> 'null'
      OR ${resultStatusType(".finalCheckpointEventPosition")} <> 'null'))`;

const EVIDENCE_GROUP_PRESERVED = `
  NEW.evidence_frozen_checkpoint_event_position
    IS OLD.evidence_frozen_checkpoint_event_position
  AND NEW.evidence_frozen_generation IS OLD.evidence_frozen_generation
  AND NEW.evidence_window_state IS OLD.evidence_window_state
  AND NEW.final_ending_scope_bindings_json IS OLD.final_ending_scope_bindings_json
`;

const NULL_SEALED_EVIDENCE_GROUP = `
  NEW.evidence_window_state = 'sealed'
  AND NEW.evidence_frozen_checkpoint_event_position IS NULL
  AND NEW.evidence_frozen_generation IS NULL
  AND NEW.final_ending_scope_bindings_json IS NULL
`;

const STRICT_WORKFLOW_UPDATE_INVALID = `
  NOT (
    (
      NEW.generation = OLD.generation
      AND NEW.phase IS OLD.phase
      AND NEW.result_json IS OLD.result_json
      AND ${EVIDENCE_GROUP_PRESERVED}
    )
    OR
    (
      NEW.generation = OLD.generation
      AND NEW.phase IS NOT OLD.phase
      AND json_type(NEW.result_json, '$.status') = 'object'
      AND json_type(NEW.result_json, '$.progressed') = 'true'
      AND json_extract(NEW.result_json, '$.previousPhase') IS OLD.phase
      AND (
        (OLD.phase = 'requested' AND NEW.phase = 'children-resolved'
          AND json_extract(NEW.result_json, '$.action') = 'mark-children-resolved')
        OR (OLD.phase = 'children-resolved' AND NEW.phase = 'final-checkpoint-recorded'
          AND json_extract(NEW.result_json, '$.action')
            = 'record-final-checkpoint-and-queue-ending')
        OR (OLD.phase = 'final-checkpoint-recorded'
          AND NEW.phase = 'ending-materialization-queued'
          AND json_extract(NEW.result_json, '$.action') = 'confirm-ending-materialization')
        OR (OLD.phase = 'ending-materialization-queued' AND NEW.phase = 'validating'
          AND json_extract(NEW.result_json, '$.action') = 'begin-validation')
        OR (OLD.phase = 'validating' AND NEW.phase = 'verification-failed'
          AND json_extract(NEW.result_json, '$.action') = 'record-verification-failed')
        OR (OLD.phase = 'validating' AND NEW.phase = 'verification-passed'
          AND json_extract(NEW.result_json, '$.action') = 'record-verification-passed')
        OR (OLD.phase = 'verification-passed' AND NEW.phase = 'verification-failed'
          AND json_extract(NEW.result_json, '$.action') = 'invalidate-verification')
        OR (OLD.phase = 'verification-passed' AND NEW.phase = 'completion-appended'
          AND json_extract(NEW.result_json, '$.action') = 'append-terminal-completion')
        OR (OLD.phase = 'completion-appended'
          AND NEW.phase = 'completed-materialization-confirmed'
          AND json_extract(NEW.result_json, '$.action')
            = 'confirm-completed-materialization')
        OR (OLD.phase = 'completion-appended' AND NEW.phase = 'completed'
          AND json_extract(NEW.result_json, '$.action') = 'complete-without-materialization')
        OR (OLD.phase = 'completed-materialization-confirmed' AND NEW.phase = 'completed'
          AND json_extract(NEW.result_json, '$.action') = 'complete-after-materialization')
      )
      AND (
        (OLD.phase = 'children-resolved' AND NEW.phase = 'final-checkpoint-recorded'
          AND OLD.evidence_window_state = 'sealed'
          AND OLD.evidence_frozen_checkpoint_event_position IS NULL
          AND NEW.evidence_window_state = 'sealed'
          AND NEW.evidence_frozen_checkpoint_event_position IS NOT NULL
          AND NEW.evidence_frozen_generation = NEW.generation
          AND NEW.final_ending_scope_bindings_json IS NOT NULL)
        OR
        (NOT (OLD.phase = 'children-resolved'
          AND NEW.phase = 'final-checkpoint-recorded')
          AND ${EVIDENCE_GROUP_PRESERVED})
      )
    )
    OR
    (
      NEW.generation = OLD.generation + 1
      AND OLD.evidence_window_state = 'sealed'
      AND NEW.evidence_window_state = 'open'
      AND NEW.phase IN ('requested', 'children-resolved')
      AND NEW.evidence_frozen_checkpoint_event_position IS NULL
      AND NEW.evidence_frozen_generation IS NULL
      AND NEW.final_ending_scope_bindings_json IS NULL
      AND NEW.result_json IS NOT NULL
      AND json_type(NEW.result_json, '$.status') IS NULL
    )
    OR
    (
      NEW.generation = OLD.generation + 1
      AND OLD.evidence_window_state = 'open'
      AND NEW.evidence_window_state = 'sealed'
      AND NEW.phase IN ('requested', 'children-resolved')
      AND NEW.evidence_frozen_checkpoint_event_position IS NULL
      AND NEW.evidence_frozen_generation IS NULL
      AND NEW.final_ending_scope_bindings_json IS NULL
      AND NEW.result_json IS NOT NULL
      AND json_type(NEW.result_json, '$.status') IS NULL
    )
    OR
    (
      NEW.generation = OLD.generation + 1
      AND NEW.phase IS OLD.phase
      AND NEW.phase NOT IN ('cancelled', 'abandoned', 'completed')
      AND ${EVIDENCE_GROUP_PRESERVED}
      AND NEW.result_json IS NOT NULL
      AND json_type(NEW.result_json, '$.status') IS NULL
    )
    OR
    (
      NEW.generation = OLD.generation + 1
      AND OLD.phase NOT IN ('cancelled', 'abandoned', 'completed')
      AND NEW.phase = 'cancelled'
      AND ${NULL_SEALED_EVIDENCE_GROUP}
      AND NEW.result_json IS NOT NULL
      AND json_type(NEW.result_json, '$.status') IS NULL
    )
    OR
    (
      NEW.generation = OLD.generation + 1
      AND OLD.phase = 'cancelled'
      AND NEW.phase = 'requested'
      AND ${NULL_SEALED_EVIDENCE_GROUP}
      AND NEW.result_json IS NULL
      AND NEW.root_command_id IS NOT OLD.root_command_id
      AND NEW.triggering_event_position > OLD.triggering_event_position
    )
    OR
    (
      NEW.generation = OLD.generation + 1
      AND OLD.phase NOT IN ('abandoned', 'completed')
      AND NEW.phase = 'abandoned'
      AND NEW.evidence_window_state = 'sealed'
      AND NEW.evidence_frozen_checkpoint_event_position
        IS OLD.evidence_frozen_checkpoint_event_position
      AND NEW.evidence_frozen_generation IS OLD.evidence_frozen_generation
      AND NEW.final_ending_scope_bindings_json IS OLD.final_ending_scope_bindings_json
      AND NEW.result_json IS NOT NULL
      AND json_type(NEW.result_json, '$.status') IS NULL
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
  AND NOT EXISTS (
    SELECT 1 FROM events AS legacy_event
    WHERE legacy_event.stream_type = 'session'
      AND legacy_event.session_id IS NOT NULL
      AND legacy_event.event_type IN (${LEGACY_V1_EVENT_TYPES_SQL})
      AND (
        legacy_event.event_schema_version <> 1
        OR NOT json_valid(legacy_event.payload_json)
        OR json_type(legacy_event.payload_json) <> 'object'
        OR json(legacy_event.payload_json) <> legacy_event.payload_json
        OR NOT (${LEGACY_V1_PAYLOAD_SHAPE_VALID})
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

CREATE UNIQUE INDEX session_evidence_coverage_latest_transition
ON session_evidence_coverage(
  project_id, session_id, adapter_session_id, latest_batch_event_position
);

CREATE TABLE session_evidence_coverage_transition_heads (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  adapter_session_id TEXT NOT NULL,
  batch_event_position INTEGER NOT NULL CHECK (batch_event_position > 0),
  PRIMARY KEY (project_id, session_id, adapter_session_id),
  FOREIGN KEY (project_id, session_id, adapter_session_id, batch_event_position)
    REFERENCES session_evidence_coverage_transitions(
      project_id, session_id, adapter_session_id, batch_event_position
    ) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, session_id, adapter_session_id, batch_event_position)
    REFERENCES session_evidence_coverage(
      project_id, session_id, adapter_session_id, latest_batch_event_position
    ) DEFERRABLE INITIALLY DEFERRED
) STRICT;

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
  OR NEW.frame_fingerprint_algorithm <> 'hmac-sha256'
  OR NEW.frame_fingerprint_schema_version <> 1
  OR NEW.frame_fingerprint_domain <> 'pm-evidence-frame-v1'
  OR NEW.coverage_fingerprint_algorithm <> 'hmac-sha256'
  OR NEW.coverage_fingerprint_schema_version <> 1
  OR NEW.coverage_fingerprint_key_id <> NEW.frame_fingerprint_key_id
  OR NEW.coverage_fingerprint_domain <> 'pm-evidence-coverage-v1'
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.missing_intervals_json) AS interval
    WHERE interval.type <> 'array'
      OR json_array_length(interval.value) <> 2
      OR json_type(interval.value, '$[0]') <> 'integer'
      OR json_type(interval.value, '$[1]') <> 'integer'
      OR json_extract(interval.value, '$[0]') < 0
      OR json_extract(interval.value, '$[1]') < json_extract(interval.value, '$[0]')
      OR json_extract(interval.value, '$[1]') > NEW.coverage_last_ordinal
      OR (
        json_extract(interval.value, '$[0]') <= NEW.batch_last_ordinal
        AND json_extract(interval.value, '$[1]') >= NEW.batch_first_ordinal
      )
  )
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.missing_intervals_json) AS prior
    JOIN json_each(NEW.missing_intervals_json) AS following
      ON CAST(following.key AS INTEGER) = CAST(prior.key AS INTEGER) + 1
    WHERE json_extract(following.value, '$[0]')
      <= json_extract(prior.value, '$[1]') + 1
  )
  OR (
    json_array_length(NEW.missing_intervals_json) = 0
    AND NEW.highest_contiguous_ordinal <> NEW.coverage_last_ordinal
  )
  OR (
    json_array_length(NEW.missing_intervals_json) > 0
    AND json_extract(NEW.missing_intervals_json, '$[0][0]')
      <> NEW.highest_contiguous_ordinal + 1
  )
  OR NOT EXISTS (
    SELECT 1 FROM events AS event
    WHERE event.global_position = NEW.batch_event_position
      AND event.project_id = NEW.project_id
      AND event.session_id = NEW.session_id
      AND event.stream_type = 'session'
      AND event.event_type = 'EvidenceCoverageRecorded'
      AND event.event_schema_version = 2
      AND json_valid(event.payload_json)
      AND json_type(event.payload_json) = 'object'
      AND json(event.payload_json) = event.payload_json
      AND (SELECT count(*) FROM json_each(event.payload_json)) = 20
      AND (SELECT count(DISTINCT field.key)
           FROM json_each(event.payload_json) AS field) = 20
      AND NOT EXISTS (
        SELECT 1 FROM json_each(event.payload_json) AS field
        WHERE field.key NOT IN (
          'adapterSessionId', 'batchId', 'batchFirstOrdinal', 'batchLastOrdinal',
          'coverageFirstOrdinal', 'coverageLastOrdinal', 'highestContiguousOrdinal',
          'missingIntervals', 'frameFingerprintAlgorithm',
          'frameFingerprintSchemaVersion', 'frameFingerprintKeyId',
          'frameFingerprintDomain', 'coverageFingerprintAlgorithm',
          'coverageFingerprintSchemaVersion', 'coverageFingerprintKeyId',
          'coverageFingerprintDomain', 'coverageFingerprint', 'captureMode',
          'contentRetained', 'frames'
        )
      )
      AND ${canonicalUuid("json_extract(event.payload_json, '$.adapterSessionId')")}
      AND ${canonicalUuid("json_extract(event.payload_json, '$.batchId')")}
      AND json_extract(event.payload_json, '$.adapterSessionId') = NEW.adapter_session_id
      AND json_extract(event.payload_json, '$.batchId') = NEW.batch_id
      AND json_type(event.payload_json, '$.batchFirstOrdinal') = 'text'
      AND ${strictUnsignedDecimal("json_extract(event.payload_json, '$.batchFirstOrdinal')")}
      AND CAST(NEW.batch_first_ordinal AS TEXT)
        = json_extract(event.payload_json, '$.batchFirstOrdinal')
      AND json_type(event.payload_json, '$.batchLastOrdinal') = 'text'
      AND ${strictUnsignedDecimal("json_extract(event.payload_json, '$.batchLastOrdinal')")}
      AND CAST(NEW.batch_last_ordinal AS TEXT)
        = json_extract(event.payload_json, '$.batchLastOrdinal')
      AND json_type(event.payload_json, '$.coverageFirstOrdinal') = 'text'
      AND ${strictUnsignedDecimal("json_extract(event.payload_json, '$.coverageFirstOrdinal')")}
      AND CAST(NEW.coverage_first_ordinal AS TEXT)
        = json_extract(event.payload_json, '$.coverageFirstOrdinal')
      AND json_type(event.payload_json, '$.coverageLastOrdinal') = 'text'
      AND ${strictUnsignedDecimal("json_extract(event.payload_json, '$.coverageLastOrdinal')")}
      AND CAST(NEW.coverage_last_ordinal AS TEXT)
        = json_extract(event.payload_json, '$.coverageLastOrdinal')
      AND (
        (NEW.highest_contiguous_ordinal = -1
          AND json_type(event.payload_json, '$.highestContiguousOrdinal') = 'null')
        OR
        (NEW.highest_contiguous_ordinal >= 0
          AND json_type(event.payload_json, '$.highestContiguousOrdinal') = 'text'
          AND ${strictUnsignedDecimal("json_extract(event.payload_json, '$.highestContiguousOrdinal')")}
          AND CAST(NEW.highest_contiguous_ordinal AS TEXT)
            = json_extract(event.payload_json, '$.highestContiguousOrdinal'))
      )
      AND json_type(event.payload_json, '$.missingIntervals') = 'array'
      AND json_array_length(event.payload_json, '$.missingIntervals')
        = json_array_length(NEW.missing_intervals_json)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(event.payload_json, '$.missingIntervals') AS interval
        WHERE interval.type <> 'object'
          OR (SELECT count(*) FROM json_each(interval.value)) <> 2
          OR (SELECT count(DISTINCT field.key)
              FROM json_each(interval.value) AS field) <> 2
          OR EXISTS (
            SELECT 1 FROM json_each(interval.value) AS field
            WHERE field.key NOT IN ('firstOrdinal', 'lastOrdinal')
          )
          OR json_type(interval.value, '$.firstOrdinal') <> 'text'
          OR NOT ${strictUnsignedDecimal("json_extract(interval.value, '$.firstOrdinal')")}
          OR json_type(interval.value, '$.lastOrdinal') <> 'text'
          OR NOT ${strictUnsignedDecimal("json_extract(interval.value, '$.lastOrdinal')")}
          OR CAST(json_extract(interval.value, '$.firstOrdinal') AS INTEGER)
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
      AND json_type(event.payload_json, '$.frames') = 'array'
      AND json_array_length(event.payload_json, '$.frames')
        = NEW.batch_last_ordinal - NEW.batch_first_ordinal + 1
      AND json_array_length(event.payload_json, '$.frames') BETWEEN 1 AND 2000
      AND NOT EXISTS (
        SELECT 1 FROM json_each(event.payload_json, '$.frames') AS frame
        WHERE frame.type <> 'object'
          OR (SELECT count(*) FROM json_each(frame.value)) <> 5
          OR (SELECT count(DISTINCT field.key)
              FROM json_each(frame.value) AS field) <> 5
          OR EXISTS (
            SELECT 1 FROM json_each(frame.value) AS field
            WHERE field.key NOT IN (
              'frameId', 'ordinal', 'sourceKind', 'observedAt', 'contentFingerprint'
            )
          )
          OR NOT ${canonicalUuid("json_extract(frame.value, '$.frameId')")}
          OR json_type(frame.value, '$.ordinal') <> 'text'
          OR NOT ${strictUnsignedDecimal("json_extract(frame.value, '$.ordinal')")}
          OR CAST(json_extract(frame.value, '$.ordinal') AS INTEGER)
            <> NEW.batch_first_ordinal + CAST(frame.key AS INTEGER)
          OR json_type(frame.value, '$.sourceKind') <> 'text'
          OR json_extract(frame.value, '$.sourceKind') NOT IN (
            'model-turn', 'tool-request', 'tool-result', 'adapter-event',
            'external-observation'
          )
          OR json_type(frame.value, '$.observedAt') <> 'text'
          OR strftime('%Y-%m-%dT%H:%M:%fZ',
            json_extract(frame.value, '$.observedAt'))
            IS NOT json_extract(frame.value, '$.observedAt')
          OR json_type(frame.value, '$.contentFingerprint') <> 'text'
          OR length(json_extract(frame.value, '$.contentFingerprint')) <> 64
          OR json_extract(frame.value, '$.contentFingerprint') GLOB '*[^0-9a-f]*'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(event.payload_json, '$.frames') AS left_frame
        JOIN json_each(event.payload_json, '$.frames') AS right_frame
          ON CAST(right_frame.key AS INTEGER) > CAST(left_frame.key AS INTEGER)
        WHERE json_extract(right_frame.value, '$.frameId')
          = json_extract(left_frame.value, '$.frameId')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(event.payload_json, '$.frames') AS frame
        JOIN session_evidence_fingerprints AS fingerprint
          ON fingerprint.project_id = NEW.project_id
          AND fingerprint.session_id = NEW.session_id
          AND fingerprint.adapter_session_id = NEW.adapter_session_id
          AND fingerprint.ordinal = CAST(
            json_extract(frame.value, '$.ordinal') AS INTEGER
          )
        WHERE fingerprint.frame_id IS NOT json_extract(frame.value, '$.frameId')
          OR fingerprint.source_kind IS NOT json_extract(frame.value, '$.sourceKind')
          OR fingerprint.observed_at IS NOT json_extract(frame.value, '$.observedAt')
          OR fingerprint.fingerprint_algorithm IS NOT NEW.frame_fingerprint_algorithm
          OR fingerprint.fingerprint_schema_version <> NEW.frame_fingerprint_schema_version
          OR fingerprint.fingerprint_key_id IS NOT NEW.frame_fingerprint_key_id
          OR fingerprint.fingerprint_domain IS NOT NEW.frame_fingerprint_domain
          OR fingerprint.fingerprint_value IS NOT json_extract(
            frame.value, '$.contentFingerprint'
          )
      )
      AND (
        SELECT count(*)
        FROM json_each(event.payload_json, '$.frames') AS frame
        WHERE NOT EXISTS (
          SELECT 1 FROM session_evidence_fingerprints AS fingerprint
          WHERE fingerprint.project_id = NEW.project_id
            AND fingerprint.session_id = NEW.session_id
            AND fingerprint.adapter_session_id = NEW.adapter_session_id
            AND fingerprint.ordinal = CAST(
              json_extract(frame.value, '$.ordinal') AS INTEGER
            )
            AND fingerprint.frame_id IS json_extract(frame.value, '$.frameId')
            AND fingerprint.source_kind IS json_extract(frame.value, '$.sourceKind')
            AND fingerprint.observed_at IS json_extract(frame.value, '$.observedAt')
            AND fingerprint.fingerprint_algorithm IS NEW.frame_fingerprint_algorithm
            AND fingerprint.fingerprint_schema_version = NEW.frame_fingerprint_schema_version
            AND fingerprint.fingerprint_key_id IS NEW.frame_fingerprint_key_id
            AND fingerprint.fingerprint_domain IS NEW.frame_fingerprint_domain
            AND fingerprint.fingerprint_value IS json_extract(
              frame.value, '$.contentFingerprint'
            )
        )
      ) = NEW.new_frame_count
      AND json_extract(event.payload_json, '$.captureMode') IS NEW.capture_mode
      AND json_type(event.payload_json, '$.contentRetained') = 'false'
      AND NEW.content_retained = 0
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

CREATE TRIGGER session_evidence_coverage_transitions_advance_head
AFTER INSERT ON session_evidence_coverage_transitions
BEGIN
  INSERT INTO session_evidence_coverage_transition_heads(
    project_id, session_id, adapter_session_id, batch_event_position
  ) VALUES (
    NEW.project_id, NEW.session_id, NEW.adapter_session_id, NEW.batch_event_position
  )
  ON CONFLICT(project_id, session_id, adapter_session_id) DO UPDATE SET
    batch_event_position = excluded.batch_event_position;
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
    OR (${RESULT_INVALID})
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
    OR (${RESULT_INVALID})
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
    OR (${STRICT_WORKFLOW_UPDATE_INVALID})
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
