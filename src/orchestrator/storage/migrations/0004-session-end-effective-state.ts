import type { Migration } from "../migration.js";
import { qualifiedCheckpointCoverageMigration } from "./0003-qualified-checkpoint-coverage.js";

const UUID_GLOB = "[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-5][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]";

const TRANSFER_INTENT = `coalesce(
  NEW.lifecycle_intent_json,
  (
    SELECT intent_event.lifecycle_intent_json
    FROM events AS intent_event
    WHERE intent_event.project_id = NEW.project_id
      AND intent_event.command_id = NEW.command_id
      AND intent_event.command_event_index = 0
      AND intent_event.session_id = NEW.session_id
      AND intent_event.stream_id = NEW.stream_id
  )
)`;
const TRANSFER_ACTION = `coalesce(
  json_extract(${TRANSFER_INTENT}, '$.intent.command.plannedAction'),
  json_extract(${TRANSFER_INTENT}, '$.intent.command.action')
)`;

function transferActionField(field: string): string {
  return `json_extract(${TRANSFER_ACTION}, '$.${field}')`;
}

function canonicalUuid(expression: string): string {
  return `(
    typeof(${expression}) = 'text'
    AND length(${expression}) = 36
    AND lower(${expression}) = ${expression}
    AND ${expression} GLOB '${UUID_GLOB}'
  )`;
}

function strictPositiveDecimal(expression: string): string {
  return `(
    typeof(${expression}) = 'text'
    AND length(${expression}) BETWEEN 1 AND 19
    AND ${expression} NOT GLOB '*[^0-9]*'
    AND ${expression} NOT GLOB '0*'
    AND (
      length(${expression}) < 19
      OR ${expression} <= '9223372036854775807'
    )
  )`;
}

function priorTriggerSql(name: string): string {
  const marker = `CREATE TRIGGER ${name}`;
  const start = qualifiedCheckpointCoverageMigration.sql.indexOf(marker);
  const end = qualifiedCheckpointCoverageMigration.sql.indexOf("\nEND;", start);
  if (start < 0 || end < 0) throw new Error(`Missing frozen migration trigger: ${name}`);
  return qualifiedCheckpointCoverageMigration.sql.slice(start, end + 5);
}

function withOutboxLifecycleDescriptorUpdateGuard(sql: string): string {
  const insertName = "outbox_lifecycle_descriptor_v4_insert_guard";
  const start = sql.indexOf(`CREATE TRIGGER ${insertName}`);
  const end = sql.indexOf("\nEND;", start);
  if (start < 0 || end < 0) {
    throw new Error("Missing schema-4 lifecycle outbox descriptor insert guard");
  }
  const insertTrigger = sql.slice(start, end + 5);
  const updateTrigger = insertTrigger
    .replace(insertName, "outbox_lifecycle_descriptor_v4_update_guard")
    .replace("BEFORE INSERT ON outbox", "BEFORE UPDATE ON outbox");
  if (updateTrigger === insertTrigger) {
    throw new Error("Unable to derive schema-4 lifecycle outbox update guard");
  }
  return sql.replace(insertTrigger, `${insertTrigger}\n\n${updateTrigger}`);
}

const LEGACY_WORKFLOW_FOLD_GUARD = priorTriggerSql(
  "lifecycle_workflow_generation_folds_insert_guard",
)
  .replace(
    "CREATE TRIGGER lifecycle_workflow_generation_folds_insert_guard",
    "CREATE TRIGGER lifecycle_workflow_generation_folds_v4_legacy_insert_guard",
  )
  .replace(
    "WHEN\n  NOT EXISTS (",
    "WHEN NEW.fingerprint_schema_version = 1\n  AND NOT EXISTS (",
  );

function withVersion3FinalMarkerBinding(sql: string): string {
  const versionBound = sql.replace(
    "final_checkpoint_event.event_schema_version IN (1, 2)",
    "final_checkpoint_event.event_schema_version = 3",
  );
  const checkpointPositionBinding = `AND json_extract(final_checkpoint_event.payload_json,
          '$.checkpoint.checkpointEventPosition')
          IS CAST(NEW.evidence_frozen_checkpoint_event_position AS TEXT)`;
  const workflowBinding = `${checkpointPositionBinding}
        AND json_extract(final_checkpoint_event.payload_json, '$.workflowId')
          IS NEW.workflow_id
        AND json_extract(
          final_checkpoint_event.payload_json, '$.workflowGeneration'
        ) IS NEW.evidence_frozen_generation`;
  const bound = versionBound.replace(checkpointPositionBinding, workflowBinding);
  if (versionBound === sql || bound === versionBound) {
    throw new Error("Missing frozen migration final-checkpoint binding");
  }
  return bound;
}

const WORKFLOW_EVIDENCE_V4_INSERT_GUARD = withVersion3FinalMarkerBinding(
  priorTriggerSql("workflow_instances_evidence_v3_insert_guard"),
);

const WORKFLOW_EVIDENCE_V4_UPDATE_GUARD = (() => {
  const frozen = withVersion3FinalMarkerBinding(
    priorTriggerSql("workflow_instances_evidence_v3_update_guard"),
  );
  const reopenBranch = /\(\n\s+NEW\.generation = OLD\.generation \+ 1\n\s+AND OLD\.phase = 'cancelled'\n\s+AND NEW\.phase = 'requested'\n[\s\S]*?\n\s+AND NEW\.triggering_event_position > OLD\.triggering_event_position\n\s+\)/u;
  const replacement = `(
      NEW.generation = OLD.generation + 1
      AND OLD.phase = 'cancelled'
      AND NEW.phase = 'requested'
      AND NEW.evidence_frozen_checkpoint_event_position IS NULL
      AND NEW.evidence_frozen_generation IS NULL
      AND NEW.final_ending_scope_bindings_json IS NULL
      AND NEW.result_json IS NULL
      AND NEW.root_command_id IS NOT OLD.root_command_id
      AND NEW.triggering_event_position > OLD.triggering_event_position
      AND EXISTS (
        SELECT 1
        FROM events AS reopen_event
        WHERE reopen_event.project_id = NEW.project_id
          AND reopen_event.global_position = NEW.triggering_event_position
          AND reopen_event.session_id = NEW.session_id
          AND reopen_event.parent_session_id IS NULL
          AND reopen_event.stream_type = 'session'
          AND reopen_event.stream_id = 'session/' || NEW.session_id
          AND reopen_event.command_id = NEW.root_command_id
          AND reopen_event.event_type = 'SessionEndRequested'
          AND reopen_event.event_schema_version = 3
          AND json_extract(reopen_event.payload_json, '$.workflowId')
            = NEW.workflow_id
          AND json_extract(reopen_event.payload_json, '$.workflowGeneration')
            = NEW.generation
          AND (
            (
              json_extract(
                reopen_event.payload_json,
                '$.effectiveState.request.requestVersion'
              ) = 1
              AND NEW.evidence_window_state = 'sealed'
            )
            OR (
              json_extract(
                reopen_event.payload_json,
                '$.effectiveState.request.requestVersion'
              ) = 2
              AND NEW.evidence_window_state = 'open'
            )
          )
      )
    )`;
  const updated = frozen.replace(reopenBranch, replacement);
  if (updated === frozen) {
    throw new Error("Missing frozen migration reopen evidence branch");
  }
  return updated;
})();

const VALIDATION_PLAN_V4_INVALID = `NEW.validation_attempt_plans_json IS NOT NULL AND (
  length(CAST(NEW.validation_attempt_plans_json AS BLOB)) > 262144
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.validation_attempt_plans_json) AS plan
    WHERE length(json_extract(plan.value, '$.profileId')) = 0
      OR coalesce(${canonicalUuid("json_extract(plan.value, '$.runId')")}, 0) = 0
      OR coalesce(${canonicalUuid("json_extract(plan.value, '$.resultId')")}, 0) = 0
      OR coalesce(${canonicalUuid("json_extract(plan.value, '$.commandId')")}, 0) = 0
      OR length(json_extract(plan.value, '$.idempotencyKey')) = 0
  )
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.validation_attempt_plans_json) AS left_plan
    JOIN json_each(NEW.validation_attempt_plans_json) AS right_plan
      ON CAST(right_plan.key AS INTEGER) = CAST(left_plan.key AS INTEGER) + 1
    WHERE json_extract(left_plan.value, '$.profileId') COLLATE BINARY
        > json_extract(right_plan.value, '$.profileId') COLLATE BINARY
      OR (
        json_extract(left_plan.value, '$.profileId')
          IS json_extract(right_plan.value, '$.profileId')
        AND json_extract(left_plan.value, '$.profileVersion')
          >= json_extract(right_plan.value, '$.profileVersion')
      )
  )
  OR (SELECT count(*) FROM json_each(NEW.validation_attempt_plans_json)) <>
    (SELECT count(*) FROM (
      SELECT json_extract(value, '$.profileId'),
             json_extract(value, '$.profileVersion')
      FROM json_each(NEW.validation_attempt_plans_json)
      GROUP BY 1, 2
    ))
  OR (SELECT count(*) FROM json_each(NEW.validation_attempt_plans_json)) <>
    (SELECT count(DISTINCT json_extract(value, '$.runId'))
     FROM json_each(NEW.validation_attempt_plans_json))
  OR (SELECT count(*) FROM json_each(NEW.validation_attempt_plans_json)) <>
    (SELECT count(DISTINCT json_extract(value, '$.resultId'))
     FROM json_each(NEW.validation_attempt_plans_json))
  OR (SELECT count(*) FROM json_each(NEW.validation_attempt_plans_json)) <>
    (SELECT count(DISTINCT json_extract(value, '$.commandId'))
     FROM json_each(NEW.validation_attempt_plans_json))
  OR (SELECT count(*) FROM json_each(NEW.validation_attempt_plans_json)) <>
    (SELECT count(DISTINCT json_extract(value, '$.idempotencyKey'))
     FROM json_each(NEW.validation_attempt_plans_json))
)`;

export const sessionEndEffectiveStateMigration: Migration = {
  version: 4,
  name: "session-end-effective-state",
  sql: withOutboxLifecycleDescriptorUpdateGuard(`
DROP TRIGGER events_lifecycle_version_v3_guard;
DROP TRIGGER lifecycle_workflow_generation_folds_insert_guard;
DROP TRIGGER workflow_instances_evidence_v3_insert_guard;
DROP TRIGGER workflow_instances_evidence_v3_update_guard;

ALTER TABLE lifecycle_workflow_generation_folds
  ADD COLUMN fingerprint_schema_version INTEGER NOT NULL DEFAULT 1
  CHECK (fingerprint_schema_version IN (1, 2));
ALTER TABLE lifecycle_workflow_generation_folds
  ADD COLUMN effective_state_source_event_position INTEGER
  REFERENCES events(global_position) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE lifecycle_workflow_generation_folds
  ADD COLUMN effective_state_version INTEGER
  CHECK (effective_state_version IS NULL OR effective_state_version = 1);
ALTER TABLE lifecycle_workflow_generation_folds
  ADD COLUMN effective_state_hash TEXT
  CHECK (
    effective_state_hash IS NULL OR (
      length(effective_state_hash) = 64
      AND effective_state_hash NOT GLOB '*[^0-9a-f]*'
    )
  );

${LEGACY_WORKFLOW_FOLD_GUARD}

${WORKFLOW_EVIDENCE_V4_INSERT_GUARD}

${WORKFLOW_EVIDENCE_V4_UPDATE_GUARD}

CREATE TRIGGER workflow_instances_validation_plan_v4_insert_guard
BEFORE INSERT ON workflow_instances
WHEN ${VALIDATION_PLAN_V4_INVALID}
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_VALIDATION_PLAN_V4_INVALID');
END;

CREATE TRIGGER workflow_instances_validation_plan_v4_update_guard
BEFORE UPDATE OF validation_attempt_plan_generation,
  validation_attempt_plans_json ON workflow_instances
WHEN ${VALIDATION_PLAN_V4_INVALID}
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_VALIDATION_PLAN_V4_INVALID');
END;

CREATE TRIGGER lifecycle_workflow_generation_folds_v4_insert_guard
BEFORE INSERT ON lifecycle_workflow_generation_folds
WHEN coalesce((
  (
    NEW.fingerprint_schema_version = 1
    AND NEW.effective_state_source_event_position IS NULL
    AND NEW.effective_state_version IS NULL
    AND NEW.effective_state_hash IS NULL
  )
  OR
  (
    NEW.fingerprint_schema_version = 2
    AND EXISTS (
      SELECT 1
      FROM events AS trigger_event
      JOIN events AS intent_event
        ON intent_event.project_id = trigger_event.project_id
        AND intent_event.command_id = trigger_event.command_id
        AND intent_event.command_event_index = 0
        AND intent_event.session_id = trigger_event.session_id
        AND intent_event.stream_id = trigger_event.stream_id
        AND intent_event.lifecycle_intent_json IS NOT NULL
      LEFT JOIN lifecycle_workflow_generation_folds AS predecessor
        ON predecessor.project_id = NEW.project_id
        AND predecessor.workflow_id = NEW.workflow_id
        AND predecessor.session_id = NEW.session_id
        AND predecessor.workflow_generation = NEW.workflow_generation - 1
      LEFT JOIN events AS predecessor_trigger
        ON predecessor_trigger.project_id = predecessor.project_id
        AND predecessor_trigger.global_position = predecessor.trigger_event_position
        AND predecessor_trigger.session_id = predecessor.session_id
      WHERE trigger_event.project_id = NEW.project_id
        AND trigger_event.global_position = NEW.trigger_event_position
        AND trigger_event.session_id = NEW.session_id
        AND trigger_event.parent_session_id IS NULL
        AND trigger_event.stream_type = 'session'
        AND trigger_event.stream_id = 'session/' || NEW.session_id
        AND trigger_event.command_id = NEW.root_command_id
        AND trigger_event.event_schema_version = 3
        AND trigger_event.event_type IN (
          'SessionEndRequested', 'SessionEndAmended', 'SessionEndCancelled'
        )
        AND json_extract(trigger_event.payload_json, '$.workflowId')
          = NEW.workflow_id
        AND json_extract(trigger_event.payload_json, '$.workflowGeneration')
          = NEW.workflow_generation
        AND json_extract(
          intent_event.lifecycle_intent_json, '$.intent.command.commandId'
        ) = NEW.root_command_id
        AND (
          (
            NEW.workflow_generation = 1
            AND NEW.previous_fingerprint IS NULL
            AND predecessor.workflow_generation IS NULL
          )
          OR (
            NEW.workflow_generation > 1
            AND predecessor.workflow_generation = NEW.workflow_generation - 1
            AND predecessor.trigger_event_position < NEW.trigger_event_position
            AND predecessor.fingerprint = NEW.previous_fingerprint
          )
        )
        AND CASE trigger_event.event_type
          WHEN 'SessionEndRequested' THEN
            json_extract(
              intent_event.lifecycle_intent_json, '$.intent.command.commandType'
            ) = 'request-session-end'
            AND json(json_extract(
              intent_event.lifecycle_intent_json, '$.intent.command.request'
            )) = json(json_extract(
              trigger_event.payload_json, '$.effectiveState.request'
            ))
            AND (
              NEW.workflow_generation = 1
              OR predecessor_trigger.event_type = 'SessionEndCancelled'
            )
            AND NEW.replacement_checkpoint_version = json_extract(
              trigger_event.payload_json,
              '$.effectiveState.request.requestVersion'
            )
            AND NEW.effective_checkpoint_version
              = NEW.replacement_checkpoint_version
            AND NEW.effective_draft_source_event_position
              = NEW.trigger_event_position
            AND NEW.evidence_window_state = CASE json_extract(
              trigger_event.payload_json,
              '$.effectiveState.request.requestVersion'
            ) WHEN 2 THEN 'open' ELSE 'sealed' END
            AND NEW.effective_state_source_event_position
              = NEW.trigger_event_position
            AND NEW.effective_state_version = 1
            AND NEW.effective_state_hash = json_extract(
              trigger_event.payload_json,
              '$.effectiveState.effectiveStateHash'
            )
          WHEN 'SessionEndAmended' THEN
            NEW.workflow_generation > 1
            AND json_extract(
              intent_event.lifecycle_intent_json, '$.intent.command.commandType'
            ) = 'amend-session-end'
            AND json_extract(
              intent_event.lifecycle_intent_json, '$.intent.command.sessionId'
            ) = NEW.session_id
            AND json_extract(
              intent_event.lifecycle_intent_json, '$.intent.command.workflowId'
            ) = NEW.workflow_id
            AND json_extract(
              trigger_event.payload_json, '$.previousWorkflowGeneration'
            ) = predecessor.workflow_generation
            AND NEW.replacement_checkpoint_version IS coalesce(
              json_extract(
                intent_event.lifecycle_intent_json,
                '$.intent.command.request.finalCheckpoint.checkpointVersion'
              ),
              json_extract(
                intent_event.lifecycle_intent_json,
                '$.intent.command.amendment.finalCheckpoint.checkpointVersion'
              )
            )
            AND (
              (
                NEW.replacement_checkpoint_version IS NULL
                AND NEW.effective_checkpoint_version
                  = predecessor.effective_checkpoint_version
                AND NEW.effective_draft_source_event_position
                  = predecessor.effective_draft_source_event_position
              )
              OR (
                NEW.replacement_checkpoint_version IS NOT NULL
                AND NEW.effective_checkpoint_version
                  = NEW.replacement_checkpoint_version
                AND NEW.effective_draft_source_event_position
                  = NEW.trigger_event_position
              )
            )
            AND (
              (
                json_extract(
                  trigger_event.payload_json, '$.evidenceWindowAction'
                ) = 'unchanged'
                AND NEW.evidence_window_state = predecessor.evidence_window_state
              )
              OR (
                json_extract(
                  trigger_event.payload_json, '$.evidenceWindowAction'
                ) = 'open'
                AND predecessor.evidence_window_state = 'sealed'
                AND NEW.replacement_checkpoint_version = 2
                AND NEW.evidence_window_state = 'open'
              )
              OR (
                json_extract(
                  trigger_event.payload_json, '$.evidenceWindowAction'
                ) = 'seal'
                AND predecessor.evidence_window_state = 'open'
                AND NEW.evidence_window_state = 'sealed'
              )
            )
            AND NEW.effective_state_source_event_position
              = NEW.trigger_event_position
            AND NEW.effective_state_version = 1
            AND NEW.effective_state_hash = json_extract(
              trigger_event.payload_json,
              '$.effectiveState.effectiveStateHash'
            )
          WHEN 'SessionEndCancelled' THEN
            NEW.workflow_generation > 1
            AND json_extract(
              intent_event.lifecycle_intent_json, '$.intent.command.commandType'
            ) = 'cancel-session-end'
            AND json_extract(
              intent_event.lifecycle_intent_json, '$.intent.command.sessionId'
            ) = NEW.session_id
            AND json_extract(
              intent_event.lifecycle_intent_json, '$.intent.command.workflowId'
            ) = NEW.workflow_id
            AND json_extract(
              trigger_event.payload_json, '$.previousWorkflowGeneration'
            ) = predecessor.workflow_generation
            AND NEW.replacement_checkpoint_version IS NULL
            AND NEW.evidence_window_state = 'sealed'
            AND NEW.effective_checkpoint_version
              = predecessor.effective_checkpoint_version
            AND NEW.effective_draft_source_event_position
              = predecessor.effective_draft_source_event_position
            AND (
              (
                predecessor.fingerprint_schema_version = 1
                AND NEW.effective_state_source_event_position IS NULL
                AND NEW.effective_state_version IS NULL
                AND NEW.effective_state_hash IS NULL
              )
              OR (
                predecessor.fingerprint_schema_version = 2
                AND NEW.effective_state_source_event_position
                  IS predecessor.effective_state_source_event_position
                AND NEW.effective_state_version
                  IS predecessor.effective_state_version
                AND NEW.effective_state_hash IS predecessor.effective_state_hash
              )
            )
          ELSE 0
        END
    )
  )
), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_GENERATION_FOLD_V4_INVALID');
END;

CREATE UNIQUE INDEX child_transfer_tickets_source_child_v4
ON child_transfer_tickets(
  project_id, source_parent_session_id, source_child_session_id
);

DROP TRIGGER child_transfer_tickets_update_guard;
CREATE TRIGGER child_transfer_tickets_update_guard
BEFORE UPDATE ON child_transfer_tickets
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.transfer_ticket_id IS NOT OLD.transfer_ticket_id
  OR NEW.source_parent_session_id IS NOT OLD.source_parent_session_id
  OR NEW.source_child_session_id IS NOT OLD.source_child_session_id
  OR NEW.source_assignment_json IS NOT OLD.source_assignment_json
  OR NEW.source_scope_json IS NOT OLD.source_scope_json
  OR NEW.checkpoint_id IS NOT OLD.checkpoint_id
  OR NEW.follow_ups_json IS NOT OLD.follow_ups_json
  OR NEW.source_state_json IS NOT OLD.source_state_json
  OR NEW.lineage_json IS NOT OLD.lineage_json
  OR NEW.created_event_position IS NOT OLD.created_event_position
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.claimed_by_root_session_id IS NOT NULL AND (
    NEW.claimed_by_root_session_id IS NOT OLD.claimed_by_root_session_id
    OR NEW.claimed_child_session_id IS NOT OLD.claimed_child_session_id
    OR NEW.claimed_event_position IS NOT OLD.claimed_event_position
    OR NEW.claimed_at IS NOT OLD.claimed_at
  ))
  OR (NEW.claimed_by_root_session_id IS NULL)
    <> (NEW.claimed_child_session_id IS NULL)
  OR (NEW.claimed_by_root_session_id IS NULL)
    <> (NEW.claimed_event_position IS NULL)
  OR (NEW.claimed_by_root_session_id IS NULL) <> (NEW.claimed_at IS NULL)
  OR (
    OLD.claimed_by_root_session_id IS NULL
    AND NEW.claimed_by_root_session_id IS NOT NULL
    AND coalesce((EXISTS (
      SELECT 1
      FROM events AS source_transfer
      JOIN events AS claim
        ON claim.project_id = source_transfer.project_id
        AND claim.global_position = NEW.claimed_event_position
        AND claim.session_id = NEW.claimed_child_session_id
        AND claim.parent_session_id = NEW.claimed_by_root_session_id
        AND claim.stream_id = 'session/' || NEW.claimed_child_session_id
        AND claim.stream_type = 'session'
        AND claim.stream_version = 2
        AND claim.event_type = 'ChildWorkTransferClaimed'
        AND claim.event_schema_version = 1
        AND claim.command_event_index = 1
        AND json_extract(claim.payload_json, '$.transferTicketId')
          = NEW.transfer_ticket_id
        AND json_extract(claim.payload_json, '$.previousChildSessionId')
          = NEW.source_child_session_id
        AND json_extract(
          claim.payload_json, '$.previousTransferEventPosition'
        ) = CAST(NEW.created_event_position AS TEXT)
      JOIN events AS fork
        ON fork.project_id = claim.project_id
        AND fork.stream_id = claim.stream_id
        AND fork.session_id = claim.session_id
        AND fork.parent_session_id = claim.parent_session_id
        AND fork.stream_version = 1
        AND fork.global_position + 1 = claim.global_position
        AND fork.event_type = 'SessionForked'
        AND fork.event_schema_version = 1
        AND fork.command_event_index = 0
        AND fork.command_id = claim.command_id
        AND fork.idempotency_key = claim.idempotency_key
        AND claim.causation_id = fork.event_id
        AND fork.causation_id = source_transfer.event_id
        AND fork.vault_id = claim.vault_id
        AND fork.store_id = claim.store_id
        AND fork.workspace_id = claim.workspace_id
        AND fork.branch_scope_id IS claim.branch_scope_id
        AND fork.branch_ref IS claim.branch_ref
        AND json_extract(fork.payload_json, '$.sourceTransferTicketId')
          = NEW.transfer_ticket_id
      WHERE source_transfer.project_id = NEW.project_id
        AND source_transfer.global_position = NEW.created_event_position
        AND source_transfer.session_id = NEW.source_child_session_id
        AND source_transfer.parent_session_id = NEW.source_parent_session_id
        AND source_transfer.event_type = 'ChildWorkTransferCreated'
        AND source_transfer.event_schema_version IN (1, 2)
        AND json_extract(source_transfer.payload_json, '$.transferTicketId')
          = NEW.transfer_ticket_id
        AND json_extract(source_transfer.payload_json, '$.checkpointId')
          = NEW.checkpoint_id
    )), 0) = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'CHILD_TRANSFER_TICKET_IMMUTABLE');
END;

CREATE TRIGGER session_authority_child_history_v4_insert_guard
BEFORE INSERT ON session_authority
WHEN NEW.session_kind = 'child'
  AND (
    SELECT count(*) FROM session_authority AS child
    WHERE child.project_id = NEW.project_id
      AND child.session_kind = 'child'
      AND child.parent_session_id IS NEW.parent_session_id
  ) >= 1000
BEGIN
  SELECT RAISE(ABORT, 'SESSION_CHILD_HISTORY_CAPACITY_EXCEEDED');
END;

CREATE TRIGGER child_transfer_tickets_history_v4_insert_guard
BEFORE INSERT ON child_transfer_tickets
WHEN (
  SELECT count(*) FROM child_transfer_tickets AS ticket
  WHERE ticket.project_id = NEW.project_id
    AND ticket.source_parent_session_id = NEW.source_parent_session_id
) >= 1000
BEGIN
  SELECT RAISE(ABORT, 'SESSION_CHILD_HISTORY_CAPACITY_EXCEEDED');
END;

CREATE TRIGGER outbox_lifecycle_descriptor_v4_insert_guard
BEFORE INSERT ON outbox
WHEN NEW.kind = 'materialize-lifecycle-log'
  AND coalesce((
    NEW.session_id IS NOT NULL
    AND json_valid(NEW.payload_json)
    AND json(NEW.payload_json) = NEW.payload_json
    AND json_type(NEW.payload_json) = 'object'
    AND (SELECT count(*) FROM json_each(NEW.payload_json)) = 10
    AND (SELECT count(DISTINCT key) FROM json_each(NEW.payload_json)) = 10
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.payload_json)
      WHERE key NOT IN (
        'payloadVersion', 'targetKey', 'sessionId', 'artifactKind',
        'artifactPath', 'materializationRevision', 'triggeringPayloadHash',
        'nextFingerprint', 'origin', 'triggeringEventType'
      )
    )
    AND json_extract(NEW.payload_json, '$.payloadVersion') = 1
    AND json_extract(NEW.payload_json, '$.targetKey') = NEW.target_key
    AND json_extract(NEW.payload_json, '$.sessionId') = NEW.session_id
    AND json_extract(NEW.payload_json, '$.artifactKind')
      = 'compatibility-session-log'
    AND json_extract(NEW.payload_json, '$.artifactKind') = NEW.artifact_kind
    AND json_extract(NEW.payload_json, '$.artifactPath') = NEW.artifact_path
    AND json_type(NEW.payload_json, '$.materializationRevision') = 'text'
    AND json_extract(NEW.payload_json, '$.materializationRevision')
      = CAST(NEW.materialization_revision AS TEXT)
    AND NEW.materialization_revision = NEW.event_position
    AND NEW.target_key = 'lifecycle-log/' || NEW.session_id || '/'
      || CAST(NEW.materialization_revision AS TEXT)
    AND json_type(NEW.payload_json, '$.triggeringPayloadHash') = 'text'
    AND length(json_extract(NEW.payload_json, '$.triggeringPayloadHash')) = 64
    AND json_extract(NEW.payload_json, '$.triggeringPayloadHash')
      NOT GLOB '*[^0-9a-f]*'
    AND json_type(NEW.payload_json, '$.nextFingerprint') = 'object'
    AND (SELECT count(*) FROM json_each(
      NEW.payload_json, '$.nextFingerprint'
    )) = 5
    AND (SELECT count(DISTINCT key) FROM json_each(
      NEW.payload_json, '$.nextFingerprint'
    )) = 5
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.payload_json, '$.nextFingerprint')
      WHERE key NOT IN ('algorithm', 'schemaVersion', 'keyId', 'domain', 'value')
    )
    AND json_extract(NEW.payload_json, '$.nextFingerprint.algorithm')
      = 'hmac-sha256'
    AND json_extract(NEW.payload_json, '$.nextFingerprint.algorithm')
      = NEW.fingerprint_algorithm
    AND json_extract(NEW.payload_json, '$.nextFingerprint.schemaVersion') = 1
    AND json_extract(NEW.payload_json, '$.nextFingerprint.schemaVersion')
      = NEW.fingerprint_schema_version
    AND json_type(NEW.payload_json, '$.nextFingerprint.keyId') = 'text'
    AND length(json_extract(NEW.payload_json, '$.nextFingerprint.keyId'))
      BETWEEN 1 AND 128
    AND json_extract(NEW.payload_json, '$.nextFingerprint.keyId')
      = NEW.fingerprint_key_id
    AND json_extract(NEW.payload_json, '$.nextFingerprint.domain')
      = 'pm-materialization-fingerprint-v1'
    AND json_extract(NEW.payload_json, '$.nextFingerprint.domain')
      = NEW.fingerprint_domain
    AND json_type(NEW.payload_json, '$.nextFingerprint.value') = 'text'
    AND length(json_extract(NEW.payload_json, '$.nextFingerprint.value')) = 64
    AND json_extract(NEW.payload_json, '$.nextFingerprint.value')
      NOT GLOB '*[^0-9a-f]*'
    AND json_extract(NEW.payload_json, '$.nextFingerprint.value')
      = NEW.next_fingerprint
    AND json_type(NEW.payload_json, '$.origin') = 'object'
    AND (SELECT count(*) FROM json_each(NEW.payload_json, '$.origin')) = 3
    AND (SELECT count(DISTINCT key) FROM json_each(
      NEW.payload_json, '$.origin'
    )) = 3
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.payload_json, '$.origin')
      WHERE key NOT IN ('kind', 'workflowId', 'workflowGeneration')
    )
    AND json_extract(NEW.payload_json, '$.origin.kind') = NEW.origin_kind
    AND json_extract(NEW.payload_json, '$.origin.workflowId') IS NEW.workflow_id
    AND json_extract(NEW.payload_json, '$.origin.workflowGeneration')
      IS NEW.workflow_generation
    AND length(NEW.content_hash) = 64
    AND NEW.content_hash NOT GLOB '*[^0-9a-f]*'
    AND EXISTS (
      SELECT 1
      FROM events AS trigger_event
      WHERE trigger_event.project_id = NEW.project_id
        AND trigger_event.global_position = NEW.event_position
        AND trigger_event.session_id = NEW.session_id
        AND trigger_event.stream_type = 'session'
        AND trigger_event.stream_id = 'session/' || NEW.session_id
        AND trigger_event.command_event_index = 0
        AND trigger_event.event_type = json_extract(
          NEW.payload_json, '$.triggeringEventType'
        )
        AND trigger_event.event_type IN (
          'SessionCheckpointRecorded', 'SessionEndAmended',
          'SessionEndVerificationFailed', 'SessionEndVerificationInvalidated',
          'SessionEndCancelled', 'SessionAbandoned', 'SessionEnded'
        )
        AND trigger_event.payload_hash = json_extract(
          NEW.payload_json, '$.triggeringPayloadHash'
        )
        AND (
          (
            NEW.origin_kind = 'terminal-event'
            AND NEW.workflow_id IS NULL
            AND NEW.workflow_generation IS NULL
            AND trigger_event.event_type = 'SessionAbandoned'
            AND json_extract(trigger_event.payload_json, '$.workflowId') IS NULL
            AND json_extract(
              trigger_event.payload_json, '$.workflowGeneration'
            ) IS NULL
          )
          OR (
            NEW.origin_kind = 'workflow'
            AND ${canonicalUuid("NEW.workflow_id")}
            AND NEW.workflow_generation > 0
            AND (
              (
                trigger_event.event_type = 'SessionCheckpointRecorded'
                AND trigger_event.event_schema_version = 3
                AND json_extract(trigger_event.payload_json, '$.workflowId')
                  = NEW.workflow_id
                AND json_extract(
                  trigger_event.payload_json, '$.workflowGeneration'
                ) = NEW.workflow_generation
                AND EXISTS (
                  SELECT 1 FROM workflow_instances AS workflow
                  WHERE workflow.project_id = NEW.project_id
                    AND workflow.workflow_id = NEW.workflow_id
                    AND workflow.session_id = NEW.session_id
                    AND workflow.generation = NEW.workflow_generation
                )
              )
              OR (
                trigger_event.event_type <> 'SessionCheckpointRecorded'
                AND json_extract(trigger_event.payload_json, '$.workflowId')
                  = NEW.workflow_id
                AND json_extract(
                  trigger_event.payload_json, '$.workflowGeneration'
                ) = NEW.workflow_generation
              )
            )
          )
        )
    )
    AND EXISTS (
      SELECT 1 FROM events AS started
      WHERE started.project_id = NEW.project_id
        AND started.session_id = NEW.session_id
        AND started.stream_id = 'session/' || NEW.session_id
        AND started.stream_version = 1
        AND started.event_type = 'SessionStarted'
        AND started.event_schema_version = 1
        AND NEW.artifact_path = '05_Agent_Session_Logs/'
          || substr(started.occurred_at, 1, 10)
          || '-session-' || NEW.session_id || '.md'
    )
  ), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_LIFECYCLE_DESCRIPTOR_V4_INVALID');
END;

CREATE TRIGGER events_lifecycle_version_v4_guard
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
    OR (NEW.event_schema_version = 3
      AND NEW.parent_session_id IS NULL
      AND NEW.stream_id = 'session/' || NEW.session_id
      AND json_valid(NEW.payload_json)
      AND json(NEW.payload_json) = NEW.payload_json
      AND json_type(NEW.payload_json) = 'object'
      AND (SELECT count(*) FROM json_each(NEW.payload_json)) = 6
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.payload_json)
        WHERE key NOT IN (
          'checkpoint', 'baseEventPosition', 'checkpointEventPosition',
          'finalCheckpointBindingVersion', 'workflowId', 'workflowGeneration'
        )
      )
      AND json_type(NEW.payload_json, '$.checkpoint.checkpointVersion') IS 'integer'
      AND json_extract(NEW.payload_json, '$.checkpoint.checkpointVersion') IN (1, 2)
      AND json_type(NEW.payload_json, '$.baseEventPosition') = 'text'
      AND json_type(NEW.payload_json, '$.checkpointEventPosition') = 'text'
      AND json_extract(NEW.payload_json, '$.checkpointEventPosition')
        = CAST(NEW.global_position AS TEXT)
      AND json_extract(NEW.payload_json, '$.finalCheckpointBindingVersion') IS 1
      AND ${canonicalUuid("json_extract(NEW.payload_json, '$.workflowId')")}
      AND json_type(NEW.payload_json, '$.workflowGeneration') = 'integer'
      AND json_extract(NEW.payload_json, '$.workflowGeneration') BETWEEN 1 AND 9007199254740991
      AND json_extract(NEW.payload_json, '$.checkpoint.sessionId') = NEW.session_id
      AND json_extract(NEW.payload_json, '$.checkpoint.parentSessionId') IS NULL
      AND json_extract(NEW.payload_json, '$.checkpoint.baseEventPosition')
        = json_extract(NEW.payload_json, '$.baseEventPosition')
      AND json_extract(NEW.payload_json, '$.checkpoint.checkpointEventPosition')
        = json_extract(NEW.payload_json, '$.checkpointEventPosition')
      AND json_extract(NEW.payload_json, '$.checkpoint.sourceState.workspaceId')
        = NEW.workspace_id)
  ))
  OR (NEW.event_type = 'SessionEndRequested' AND NOT (
    (NEW.event_schema_version = 1
      AND json_type(NEW.payload_json, '$.requestVersion') IS NULL)
    OR (NEW.event_schema_version = 2
      AND json_type(NEW.payload_json, '$.requestVersion') IS 'integer'
      AND json_extract(NEW.payload_json, '$.requestVersion') IS 2)
    OR NEW.event_schema_version = 3
  ))
  OR (NEW.event_type = 'SessionEndAmended' AND NOT (
    (NEW.event_schema_version = 1
      AND json_type(NEW.payload_json, '$.amendmentVersion') IS NULL)
    OR (NEW.event_schema_version = 2
      AND json_type(NEW.payload_json, '$.amendmentVersion') IS 'integer'
      AND json_extract(NEW.payload_json, '$.amendmentVersion') IS 2)
    OR NEW.event_schema_version = 3
  ))
  OR (NEW.event_type = 'ChildWorkTransferCreated'
    AND NEW.event_schema_version NOT IN (1, 2))
  OR (NEW.event_type = 'SessionEndCancelled'
    AND NEW.event_schema_version NOT IN (1, 3))
  OR (NEW.event_type IN (
    'SessionStarted', 'SessionOwnerTransferred', 'SessionOwnershipRecovered',
    'SessionSuspendRequested', 'SessionSuspended', 'SessionResumed',
    'SessionForked', 'ChildAssignmentAmended', 'ChildWorkReported',
    'ChildWorkDispositioned', 'ChildCompletionProposed', 'ChildSessionCompleted',
    'ChildSessionSuspended', 'ChildWorkTransferClaimed',
    'SessionValidationResultRecorded', 'SessionEndVerificationPassed',
    'SessionEndVerificationFailed', 'SessionEndVerificationInvalidated',
    'SessionAbandoned', 'SessionEnded'
  ) AND NEW.event_schema_version <> 1)
)
BEGIN
  SELECT RAISE(ABORT, 'LIFECYCLE_EVENT_VERSION_INVALID');
END;

CREATE TRIGGER events_final_checkpoint_v4_guard
BEFORE INSERT ON events
WHEN NEW.stream_type = 'session'
  AND NEW.session_id IS NOT NULL
  AND NEW.event_type = 'SessionCheckpointRecorded'
  AND NEW.event_schema_version = 3
  AND coalesce((
    NEW.parent_session_id IS NULL
    AND NEW.stream_id = 'session/' || NEW.session_id
    AND NEW.command_event_index = 0
    AND json_type(NEW.lifecycle_intent_json) = 'object'
    AND json(NEW.lifecycle_intent_json) = NEW.lifecycle_intent_json
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.commandType'
    ) = 'internal-workflow-phase'
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.commandId'
    ) = NEW.command_id
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.idempotencyKey'
    ) = NEW.idempotency_key
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.agentId'
    ) = NEW.agent_id
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.expectedProjectId'
    ) = NEW.project_id
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.expectedVaultId'
    ) = NEW.vault_id
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.expectedWorkspaceId'
    ) = NEW.workspace_id
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.expectedBranchRef'
    ) IS NEW.branch_ref
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.workflowId'
    ) = json_extract(NEW.payload_json, '$.workflowId')
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.workflowGeneration'
    ) = json_extract(NEW.payload_json, '$.workflowGeneration')
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.sourcePhase'
    ) = 'children-resolved'
    AND json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.action.action'
    ) = 'record-final-checkpoint-and-queue-ending'
    AND json(json_extract(
      NEW.lifecycle_intent_json, '$.intent.command.action.finalCheckpoint'
    )) = json(json_extract(NEW.payload_json, '$.checkpoint'))
    AND json_extract(
      NEW.lifecycle_intent_json,
      '$.persistedAssertions.authorizationKind'
    ) = 'internal-workflow'
    AND json_extract(
      NEW.lifecycle_intent_json,
      '$.persistedAssertions.authorizationSessionId'
    ) = NEW.session_id
    AND json_extract(
      NEW.lifecycle_intent_json, '$.persistedAssertions.targetSessionId'
    ) = NEW.session_id
    AND json_extract(
      NEW.lifecycle_intent_json, '$.persistedAssertions.internalWorkflowId'
    ) = json_extract(NEW.payload_json, '$.workflowId')
    AND json_extract(
      NEW.lifecycle_intent_json,
      '$.persistedAssertions.internalWorkflowGeneration'
    ) = json_extract(NEW.payload_json, '$.workflowGeneration')
    AND json_extract(
      NEW.lifecycle_intent_json, '$.persistedAssertions.projectId'
    ) = NEW.project_id
    AND json_extract(
      NEW.lifecycle_intent_json, '$.persistedAssertions.vaultId'
    ) = NEW.vault_id
    AND json_extract(
      NEW.lifecycle_intent_json, '$.persistedAssertions.storeId'
    ) = NEW.store_id
    AND json_extract(
      NEW.lifecycle_intent_json, '$.persistedAssertions.workspaceId'
    ) = NEW.workspace_id
    AND json_extract(
      NEW.lifecycle_intent_json, '$.persistedAssertions.presentingActorRole'
    ) = NEW.actor_role
    AND json_extract(
      NEW.lifecycle_intent_json,
      '$.persistedAssertions.presentingClientInstanceId'
    ) = NEW.client_instance_id
    AND EXISTS (
      SELECT 1
      FROM workflow_instances AS workflow
      WHERE workflow.project_id = NEW.project_id
        AND workflow.workflow_id = json_extract(
          NEW.payload_json, '$.workflowId'
        )
        AND workflow.session_id = NEW.session_id
        AND workflow.workflow_type = 'session-end'
        AND workflow.generation = json_extract(
          NEW.payload_json, '$.workflowGeneration'
        )
        AND workflow.phase = 'children-resolved'
        AND workflow.evidence_window_state = 'sealed'
        AND workflow.evidence_frozen_checkpoint_event_position IS NULL
        AND workflow.evidence_frozen_generation IS NULL
        AND workflow.final_ending_scope_bindings_json IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM session_authority AS authority
      WHERE authority.project_id = NEW.project_id
        AND authority.session_id = NEW.session_id
        AND authority.stream_id = NEW.stream_id
        AND authority.session_kind = 'root'
        AND authority.parent_session_id IS NULL
        AND authority.workspace_id = NEW.workspace_id
        AND authority.semantic_state = 'ending'
        AND authority.terminal_event_position IS NULL
    )
  ), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'FINAL_CHECKPOINT_V4_INVALID');
END;

CREATE TRIGGER events_child_work_transfer_v2_guard
BEFORE INSERT ON events
WHEN NEW.stream_type = 'session'
  AND NEW.session_id IS NOT NULL
  AND NEW.event_type = 'ChildWorkTransferCreated'
  AND NEW.event_schema_version = 2
  AND coalesce((
    NEW.parent_session_id IS NOT NULL
    AND NEW.stream_id = 'session/' || NEW.session_id
    AND NEW.command_event_index IN (0, 1)
    AND json(NEW.payload_json) = NEW.payload_json
    AND json_type(NEW.payload_json) = 'object'
    AND (SELECT count(*) FROM json_each(NEW.payload_json)) = 4
    AND (SELECT count(DISTINCT key) FROM json_each(NEW.payload_json)) = 4
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.payload_json)
      WHERE key NOT IN (
        'transferTicketId', 'suspensionCheckpointId',
        'checkpointId', 'authorityCommitment'
      )
    )
    AND ${canonicalUuid("json_extract(NEW.payload_json, '$.transferTicketId')")}
    AND ${canonicalUuid("json_extract(NEW.payload_json, '$.suspensionCheckpointId')")}
    AND ${canonicalUuid("json_extract(NEW.payload_json, '$.checkpointId')")}
    AND json_type(NEW.payload_json, '$.authorityCommitment') = 'text'
    AND length(json_extract(NEW.payload_json, '$.authorityCommitment')) = 64
    AND json_extract(NEW.payload_json, '$.authorityCommitment')
      NOT GLOB '*[^0-9a-f]*'
    AND json_type(${TRANSFER_INTENT}) = 'object'
    AND json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.authorizationKind'
    ) = 'internal-workflow'
    AND json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.authorizationSessionId'
    ) = NEW.parent_session_id
    AND json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.targetSessionId'
    ) = NEW.session_id
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.commandType'
    ) = 'internal-workflow-phase'
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.commandId'
    ) = NEW.command_id
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.idempotencyKey'
    ) = NEW.idempotency_key
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.agentId'
    ) = NEW.agent_id
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.expectedProjectId'
    ) = NEW.project_id
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.expectedVaultId'
    ) = NEW.vault_id
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.expectedWorkspaceId'
    ) = NEW.workspace_id
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.expectedBranchRef'
    ) IS NEW.branch_ref
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.workflowId'
    ) = json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.internalWorkflowId'
    )
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.workflowGeneration'
    ) = json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.internalWorkflowGeneration'
    )
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.plannedWorkId'
    ) = json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.internalPlannedWorkId'
    )
    AND json_extract(
      ${TRANSFER_INTENT}, '$.intent.command.sourcePhase'
    ) = 'requested'
    AND json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.projectId'
    ) = NEW.project_id
    AND json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.vaultId'
    ) = NEW.vault_id
    AND json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.storeId'
    ) = NEW.store_id
    AND json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.workspaceId'
    ) = NEW.workspace_id
    AND json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.presentingActorRole'
    ) = NEW.actor_role
    AND json_extract(
      ${TRANSFER_INTENT}, '$.persistedAssertions.presentingClientInstanceId'
    ) = NEW.client_instance_id
    AND EXISTS (
      SELECT 1 FROM workflow_instances AS source_workflow
      WHERE source_workflow.project_id = NEW.project_id
        AND source_workflow.workflow_id = json_extract(
          ${TRANSFER_INTENT}, '$.intent.command.workflowId'
        )
        AND source_workflow.session_id = NEW.parent_session_id
        AND source_workflow.workflow_type = 'session-end'
        AND source_workflow.generation = json_extract(
          ${TRANSFER_INTENT}, '$.intent.command.workflowGeneration'
        )
        AND source_workflow.phase = 'requested'
    )
    AND (
      (
        json_type(
          ${TRANSFER_INTENT}, '$.intent.command.plannedAction'
        ) = 'object'
        AND json_type(
          ${TRANSFER_INTENT}, '$.intent.command.action'
        ) IS NULL
      )
      OR (
        json_type(
          ${TRANSFER_INTENT}, '$.intent.command.action'
        ) = 'object'
        AND json_type(
          ${TRANSFER_INTENT}, '$.intent.command.plannedAction'
        ) IS NULL
      )
    )
    AND json_type(${TRANSFER_ACTION}) = 'object'
    AND (SELECT count(*) FROM json_each(${TRANSFER_ACTION})) = 13
    AND (SELECT count(DISTINCT key) FROM json_each(${TRANSFER_ACTION})) = 13
    AND NOT EXISTS (
      SELECT 1 FROM json_each(${TRANSFER_ACTION})
      WHERE key NOT IN (
        'action', 'actionVersion', 'rootSessionId', 'childSessionId',
        'expectedChildState', 'expectedChildHeadEventPosition',
        'expectedChildStreamVersion', 'expectedChildAuthorityCommitment',
        'expectedChildCapabilityGeneration', 'expectedSuspensionEventPosition',
        'checkpointId', 'checkpointEventPosition', 'checkpointFingerprint'
      )
    )
    AND ${transferActionField("action")} = 'carry-forward-child'
    AND ${transferActionField("actionVersion")} = 1
    AND ${transferActionField("rootSessionId")} = NEW.parent_session_id
    AND ${transferActionField("childSessionId")} = NEW.session_id
    AND ${transferActionField("expectedChildState")}
      IN ('active', 'completion-proposed', 'suspended')
    AND ${strictPositiveDecimal(transferActionField("expectedChildHeadEventPosition"))}
    AND ${strictPositiveDecimal(transferActionField("expectedChildStreamVersion"))}
    AND typeof(${transferActionField("expectedChildAuthorityCommitment")}) = 'text'
    AND length(${transferActionField("expectedChildAuthorityCommitment")}) = 64
    AND ${transferActionField("expectedChildAuthorityCommitment")}
      NOT GLOB '*[^0-9a-f]*'
    AND ${strictPositiveDecimal(transferActionField("expectedChildCapabilityGeneration"))}
    AND json_type(${TRANSFER_ACTION}, '$.expectedSuspensionEventPosition')
      IN ('null', 'text')
    AND ${canonicalUuid(transferActionField("checkpointId"))}
    AND ${strictPositiveDecimal(transferActionField("checkpointEventPosition"))}
    AND typeof(${transferActionField("checkpointFingerprint")}) = 'text'
    AND length(${transferActionField("checkpointFingerprint")}) = 64
    AND ${transferActionField("checkpointFingerprint")} NOT GLOB '*[^0-9a-f]*'
    AND ${transferActionField("checkpointId")}
      = json_extract(NEW.payload_json, '$.checkpointId')
    AND json_extract(NEW.payload_json, '$.authorityCommitment')
      = ${transferActionField("expectedChildAuthorityCommitment")}
    AND EXISTS (
      SELECT 1
      FROM session_authority AS child
      JOIN streams AS child_stream
        ON child_stream.project_id = child.project_id
        AND child_stream.stream_id = child.stream_id
        AND child_stream.stream_type = 'session'
      JOIN events AS child_head
        ON child_head.project_id = child.project_id
        AND child_head.session_id = child.session_id
        AND child_head.stream_id = child.stream_id
        AND child_head.global_position = CAST(
          ${transferActionField("expectedChildHeadEventPosition")} AS INTEGER
        )
        AND child_head.stream_version = CAST(
          ${transferActionField("expectedChildStreamVersion")} AS INTEGER
        )
      JOIN events AS checkpoint_event
        ON checkpoint_event.project_id = child.project_id
        AND checkpoint_event.session_id = child.session_id
        AND checkpoint_event.global_position = CAST(
          ${transferActionField("checkpointEventPosition")} AS INTEGER
        )
        AND checkpoint_event.event_type = 'SessionCheckpointRecorded'
        AND json_extract(
          checkpoint_event.payload_json, '$.checkpoint.checkpointId'
        ) = ${transferActionField("checkpointId")}
      WHERE child.project_id = NEW.project_id
        AND child.session_id = NEW.session_id
        AND child.session_kind = 'child'
        AND child.parent_session_id = NEW.parent_session_id
        AND child.semantic_state = ${transferActionField("expectedChildState")}
        AND child_stream.current_version = CAST(
          ${transferActionField("expectedChildStreamVersion")} AS INTEGER
        )
        AND child.authority_commitment
          = ${transferActionField("expectedChildAuthorityCommitment")}
        AND child.child_capability_generation = CAST(
          ${transferActionField("expectedChildCapabilityGeneration")} AS INTEGER
        )
        AND child.latest_checkpoint_id = ${transferActionField("checkpointId")}
        AND child.latest_checkpoint_event_position = CAST(
          ${transferActionField("checkpointEventPosition")} AS INTEGER
        )
        AND child.latest_checkpoint_fingerprint
          = ${transferActionField("checkpointFingerprint")}
    )
    AND (
      (
        NEW.command_event_index = 0
        AND ${transferActionField("expectedChildState")} = 'suspended'
        AND NEW.stream_version = CAST(
          ${transferActionField("expectedChildStreamVersion")} AS INTEGER
        ) + 1
        AND NEW.global_position > CAST(
          ${transferActionField("expectedChildHeadEventPosition")} AS INTEGER
        )
        AND ${strictPositiveDecimal(
          transferActionField("expectedSuspensionEventPosition"),
        )}
        AND EXISTS (
          SELECT 1 FROM events AS suspension_event
          WHERE suspension_event.project_id = NEW.project_id
            AND suspension_event.session_id = NEW.session_id
            AND suspension_event.stream_id = NEW.stream_id
            AND suspension_event.global_position = CAST(
              ${transferActionField("expectedSuspensionEventPosition")} AS INTEGER
            )
            AND suspension_event.global_position < NEW.global_position
            AND suspension_event.event_type = 'ChildSessionSuspended'
            AND suspension_event.event_schema_version = 1
            AND json_extract(
              suspension_event.payload_json, '$.checkpointId'
            ) = json_extract(
              NEW.payload_json, '$.suspensionCheckpointId'
            )
        )
      )
      OR (
        NEW.command_event_index = 1
        AND ${transferActionField("expectedChildState")}
          IN ('active', 'completion-proposed')
        AND NEW.stream_version = CAST(
          ${transferActionField("expectedChildStreamVersion")} AS INTEGER
        ) + 2
        AND NEW.global_position > CAST(
          ${transferActionField("expectedChildHeadEventPosition")} AS INTEGER
        )
        AND json_type(
          ${TRANSFER_ACTION}, '$.expectedSuspensionEventPosition'
        ) = 'null'
        AND json_extract(NEW.payload_json, '$.suspensionCheckpointId')
          = json_extract(NEW.payload_json, '$.checkpointId')
        AND EXISTS (
          SELECT 1 FROM events AS suspension_event
          WHERE suspension_event.project_id = NEW.project_id
            AND suspension_event.command_id = NEW.command_id
            AND suspension_event.command_event_index = 0
            AND suspension_event.session_id = NEW.session_id
            AND suspension_event.stream_id = NEW.stream_id
            AND suspension_event.global_position = NEW.global_position - 1
            AND suspension_event.stream_version = NEW.stream_version - 1
            AND suspension_event.event_type = 'ChildSessionSuspended'
            AND suspension_event.event_schema_version = 1
            AND json_extract(
              suspension_event.payload_json, '$.checkpointId'
            ) = json_extract(
              NEW.payload_json, '$.suspensionCheckpointId'
            )
        )
      )
    )
  ), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'CHILD_WORK_TRANSFER_V2_INVALID');
END;

CREATE TRIGGER events_session_end_v4_guard
BEFORE INSERT ON events
WHEN NEW.stream_type = 'session'
  AND NEW.session_id IS NOT NULL
  AND NEW.event_schema_version = 3
  AND NEW.event_type IN (
    'SessionEndRequested', 'SessionEndAmended', 'SessionEndCancelled'
  )
BEGIN
  SELECT CASE
    WHEN NEW.event_type IN ('SessionEndRequested', 'SessionEndAmended')
      AND json_type(NEW.payload_json, '$.effectiveState') = 'object'
      AND length(CAST(json_extract(
        NEW.payload_json, '$.effectiveState'
      ) AS BLOB)) > 1048576
    THEN RAISE(ABORT, 'SESSION_END_EFFECTIVE_STATE_SIZE_INVALID')
    WHEN json(NEW.payload_json) <> NEW.payload_json
      OR json_type(NEW.payload_json) <> 'object'
      OR NEW.parent_session_id IS NOT NULL
      OR (
        NEW.event_type = 'SessionEndRequested'
        AND coalesce((
          NEW.command_event_index = 0
          AND json_type(NEW.lifecycle_intent_json) = 'object'
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.commandType'
          ) = 'request-session-end'
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.commandId'
          ) = NEW.command_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.idempotencyKey'
          ) = NEW.idempotency_key
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.agentId'
          ) = NEW.agent_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.expectedProjectId'
          ) = NEW.project_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.expectedVaultId'
          ) = NEW.vault_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.expectedWorkspaceId'
          ) = NEW.workspace_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.expectedBranchRef'
          ) IS NEW.branch_ref
          AND EXISTS (
            SELECT 1
            FROM streams AS stream_head
            WHERE stream_head.project_id = NEW.project_id
              AND stream_head.stream_id = NEW.stream_id
              AND stream_head.current_version IS NEW.stream_version - 1
          )
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.binding.projectId'
          ) = NEW.project_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.binding.vaultId'
          ) = NEW.vault_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.binding.storeId'
          ) = NEW.store_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.binding.workspaceId'
          ) = NEW.workspace_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.authorizationKind'
          ) = 'protected'
          AND json_extract(
            NEW.lifecycle_intent_json,
            '$.persistedAssertions.authorizationSessionId'
          ) = NEW.session_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.targetSessionId'
          ) = NEW.session_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.projectId'
          ) = NEW.project_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.vaultId'
          ) = NEW.vault_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.storeId'
          ) = NEW.store_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.workspaceId'
          ) = NEW.workspace_id
          AND json_extract(
            NEW.lifecycle_intent_json,
            '$.persistedAssertions.presentingActorRole'
          ) = NEW.actor_role
          AND json_extract(
            NEW.lifecycle_intent_json,
            '$.persistedAssertions.presentingClientInstanceId'
          ) = NEW.client_instance_id
          AND json(json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.request'
          )) = json(json_extract(
            NEW.payload_json, '$.effectiveState.request'
          ))
          AND (
            (
              json_extract(NEW.payload_json, '$.workflowGeneration') = 1
              AND NOT EXISTS (
                SELECT 1 FROM workflow_instances AS existing_workflow
                WHERE existing_workflow.project_id = NEW.project_id
                  AND existing_workflow.workflow_id = json_extract(
                    NEW.payload_json, '$.workflowId'
                  )
              )
            )
            OR EXISTS (
              SELECT 1 FROM workflow_instances AS cancelled_workflow
              WHERE cancelled_workflow.project_id = NEW.project_id
                AND cancelled_workflow.workflow_id = json_extract(
                  NEW.payload_json, '$.workflowId'
                )
                AND cancelled_workflow.session_id = NEW.session_id
                AND cancelled_workflow.workflow_type = 'session-end'
                AND cancelled_workflow.phase = 'cancelled'
                AND cancelled_workflow.generation + 1 = json_extract(
                  NEW.payload_json, '$.workflowGeneration'
                )
            )
          )
          AND EXISTS (
            SELECT 1 FROM session_authority AS root_authority
            WHERE root_authority.project_id = NEW.project_id
              AND root_authority.session_id = NEW.session_id
              AND root_authority.session_kind = 'root'
              AND root_authority.parent_session_id IS NULL
              AND root_authority.workspace_id = NEW.workspace_id
              AND root_authority.semantic_state = json_extract(
                NEW.payload_json, '$.previousState'
              )
              AND root_authority.terminal_event_position IS NULL
              AND root_authority.terminal_event_type IS NULL
              AND root_authority.terminal_at IS NULL
          )
        ), 0) = 0
      )
      OR (
        NEW.event_type IN ('SessionEndAmended', 'SessionEndCancelled')
        AND coalesce((
          NEW.command_event_index = 0
          AND json_type(NEW.lifecycle_intent_json) = 'object'
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.commandId'
          ) = NEW.command_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.idempotencyKey'
          ) = NEW.idempotency_key
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.agentId'
          ) = NEW.agent_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.expectedProjectId'
          ) = NEW.project_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.expectedVaultId'
          ) = NEW.vault_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.expectedWorkspaceId'
          ) = NEW.workspace_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.expectedBranchRef'
          ) IS NEW.branch_ref
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.binding.projectId'
          ) = NEW.project_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.binding.vaultId'
          ) = NEW.vault_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.binding.storeId'
          ) = NEW.store_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.binding.workspaceId'
          ) = NEW.workspace_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.authorizationKind'
          ) = 'protected'
          AND json_extract(
            NEW.lifecycle_intent_json,
            '$.persistedAssertions.authorizationSessionId'
          ) = NEW.session_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.targetSessionId'
          ) = NEW.session_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.projectId'
          ) = NEW.project_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.vaultId'
          ) = NEW.vault_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.storeId'
          ) = NEW.store_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.persistedAssertions.workspaceId'
          ) = NEW.workspace_id
          AND json_extract(
            NEW.lifecycle_intent_json,
            '$.persistedAssertions.presentingActorRole'
          ) = NEW.actor_role
          AND json_extract(
            NEW.lifecycle_intent_json,
            '$.persistedAssertions.presentingClientInstanceId'
          ) = NEW.client_instance_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.sessionId'
          ) = NEW.session_id
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.workflowId'
          ) = json_extract(NEW.payload_json, '$.workflowId')
          AND json_extract(
            NEW.lifecycle_intent_json, '$.intent.command.expectedStreamVersion'
          ) = CAST(NEW.stream_version - 1 AS TEXT)
          AND CASE NEW.event_type
            WHEN 'SessionEndAmended' THEN
              json_extract(
                NEW.lifecycle_intent_json, '$.intent.command.commandType'
              ) = 'amend-session-end'
              AND (
                (
                  json_extract(
                    NEW.lifecycle_intent_json,
                    '$.intent.command.amendment.amendmentVersion'
                  ) = 1
                  AND json_extract(
                    NEW.payload_json, '$.evidenceWindowAction'
                  ) = 'unchanged'
                )
                OR (
                  json_extract(
                    NEW.lifecycle_intent_json,
                    '$.intent.command.amendment.amendmentVersion'
                  ) = 2
                  AND json_extract(
                    NEW.lifecycle_intent_json,
                    '$.intent.command.amendment.evidenceWindowAction'
                  ) = json_extract(
                    NEW.payload_json, '$.evidenceWindowAction'
                  )
                )
              )
            WHEN 'SessionEndCancelled' THEN
              json_extract(
                NEW.lifecycle_intent_json, '$.intent.command.commandType'
              ) = 'cancel-session-end'
              AND json_extract(
                NEW.lifecycle_intent_json,
                '$.intent.command.preTransitionCheckpointId'
              ) = json_extract(
                NEW.payload_json, '$.preTransitionCheckpointId'
              )
            ELSE 0
          END
          AND EXISTS (
            SELECT 1
            FROM workflow_instances AS predecessor_workflow
            JOIN session_authority AS root_authority
              ON root_authority.project_id = predecessor_workflow.project_id
              AND root_authority.session_id = predecessor_workflow.session_id
              AND root_authority.session_kind = 'root'
              AND root_authority.parent_session_id IS NULL
            JOIN events AS checkpoint_event
              ON checkpoint_event.project_id = root_authority.project_id
              AND checkpoint_event.global_position
                = root_authority.latest_checkpoint_event_position
              AND checkpoint_event.session_id = root_authority.session_id
              AND checkpoint_event.stream_id = root_authority.stream_id
              AND checkpoint_event.event_type = 'SessionCheckpointRecorded'
              AND json_extract(
                checkpoint_event.payload_json, '$.checkpoint.checkpointId'
              ) = root_authority.latest_checkpoint_id
            WHERE predecessor_workflow.project_id = NEW.project_id
              AND predecessor_workflow.workflow_id = json_extract(
                NEW.payload_json, '$.workflowId'
              )
              AND predecessor_workflow.session_id = NEW.session_id
              AND predecessor_workflow.workflow_type = 'session-end'
              AND predecessor_workflow.phase NOT IN (
                'cancelled', 'completed', 'abandoned'
              )
              AND predecessor_workflow.generation = json_extract(
                NEW.payload_json, '$.previousWorkflowGeneration'
              )
              AND root_authority.workspace_id = NEW.workspace_id
              AND root_authority.semantic_state = 'ending'
              AND root_authority.latest_checkpoint_id = json_extract(
                NEW.payload_json, '$.preTransitionCheckpointId'
              )
              AND root_authority.terminal_event_position IS NULL
              AND root_authority.terminal_event_type IS NULL
              AND root_authority.terminal_at IS NULL
              AND (
                NEW.event_type <> 'SessionEndCancelled'
                OR predecessor_workflow.state = json_extract(
                  NEW.payload_json, '$.restoredState'
                )
              )
          )
        ), 0) = 0
      )
      OR (
        NEW.event_type = 'SessionEndRequested' AND (
          (SELECT count(*) FROM json_each(NEW.payload_json)) <> 4
          OR (SELECT count(DISTINCT key) FROM json_each(NEW.payload_json)) <> 4
          OR EXISTS (
            SELECT 1 FROM json_each(NEW.payload_json)
            WHERE key NOT IN (
              'workflowId', 'workflowGeneration', 'previousState', 'effectiveState'
            )
          )
          OR json_type(NEW.payload_json, '$.workflowId') <> 'text'
          OR length(json_extract(NEW.payload_json, '$.workflowId')) <> 36
          OR lower(json_extract(NEW.payload_json, '$.workflowId'))
            <> json_extract(NEW.payload_json, '$.workflowId')
          OR json_extract(NEW.payload_json, '$.workflowId') NOT GLOB '${UUID_GLOB}'
          OR json_type(NEW.payload_json, '$.workflowGeneration') <> 'integer'
          OR json_extract(NEW.payload_json, '$.workflowGeneration') < 1
          OR json_type(NEW.payload_json, '$.previousState') IS NOT 'text'
          OR coalesce(
            json_extract(NEW.payload_json, '$.previousState')
              IN ('active', 'suspended'),
            0
          ) = 0
          OR json_type(NEW.payload_json, '$.effectiveState') <> 'object'
        )
      )
      OR (
        NEW.event_type = 'SessionEndAmended' AND (
          (SELECT count(*) FROM json_each(NEW.payload_json)) <> 6
          OR (SELECT count(DISTINCT key) FROM json_each(NEW.payload_json)) <> 6
          OR EXISTS (
            SELECT 1 FROM json_each(NEW.payload_json)
            WHERE key NOT IN (
              'workflowId', 'previousWorkflowGeneration', 'workflowGeneration',
              'preTransitionCheckpointId', 'evidenceWindowAction', 'effectiveState'
            )
          )
          OR json_type(NEW.payload_json, '$.previousWorkflowGeneration') <> 'integer'
          OR json_extract(NEW.payload_json, '$.previousWorkflowGeneration') < 1
          OR json_type(NEW.payload_json, '$.workflowGeneration') <> 'integer'
          OR json_extract(NEW.payload_json, '$.workflowGeneration')
            <> json_extract(NEW.payload_json, '$.previousWorkflowGeneration') + 1
          OR json_type(NEW.payload_json, '$.evidenceWindowAction') IS NOT 'text'
          OR coalesce(
            json_extract(NEW.payload_json, '$.evidenceWindowAction')
              IN ('unchanged', 'open', 'seal'),
            0
          ) = 0
          OR json_type(NEW.payload_json, '$.effectiveState') <> 'object'
        )
      )
      OR (
        NEW.event_type = 'SessionEndCancelled' AND (
          (SELECT count(*) FROM json_each(NEW.payload_json)) <> 6
          OR (SELECT count(DISTINCT key) FROM json_each(NEW.payload_json)) <> 6
          OR EXISTS (
            SELECT 1 FROM json_each(NEW.payload_json)
            WHERE key NOT IN (
              'cancellationVersion', 'workflowId', 'previousWorkflowGeneration',
              'workflowGeneration', 'restoredState', 'preTransitionCheckpointId'
            )
          )
          OR json_type(NEW.payload_json, '$.cancellationVersion') IS NOT 'integer'
          OR json_extract(NEW.payload_json, '$.cancellationVersion') IS NOT 1
          OR json_type(NEW.payload_json, '$.previousWorkflowGeneration') <> 'integer'
          OR json_extract(NEW.payload_json, '$.previousWorkflowGeneration') < 1
          OR json_type(NEW.payload_json, '$.workflowGeneration') <> 'integer'
          OR json_extract(NEW.payload_json, '$.workflowGeneration')
            <> json_extract(NEW.payload_json, '$.previousWorkflowGeneration') + 1
          OR json_type(NEW.payload_json, '$.restoredState') IS NOT 'text'
          OR coalesce(
            json_extract(NEW.payload_json, '$.restoredState')
              IN ('active', 'suspended'),
            0
          ) = 0
        )
      )
      OR (
        NEW.event_type IN ('SessionEndAmended', 'SessionEndCancelled') AND (
          json_type(NEW.payload_json, '$.workflowId') <> 'text'
          OR length(json_extract(NEW.payload_json, '$.workflowId')) <> 36
          OR lower(json_extract(NEW.payload_json, '$.workflowId'))
            <> json_extract(NEW.payload_json, '$.workflowId')
          OR json_extract(NEW.payload_json, '$.workflowId') NOT GLOB '${UUID_GLOB}'
          OR json_type(NEW.payload_json, '$.preTransitionCheckpointId') <> 'text'
          OR length(json_extract(NEW.payload_json, '$.preTransitionCheckpointId')) <> 36
          OR lower(json_extract(NEW.payload_json, '$.preTransitionCheckpointId'))
            <> json_extract(NEW.payload_json, '$.preTransitionCheckpointId')
          OR json_extract(NEW.payload_json, '$.preTransitionCheckpointId')
            NOT GLOB '${UUID_GLOB}'
        )
      )
      OR (
        NEW.event_type IN ('SessionEndRequested', 'SessionEndAmended') AND (
          (SELECT count(*) FROM json_each(
            NEW.payload_json, '$.effectiveState'
          )) <> 6
          OR (SELECT count(DISTINCT key) FROM json_each(
            NEW.payload_json, '$.effectiveState'
          )) <> 6
          OR EXISTS (
            SELECT 1 FROM json_each(NEW.payload_json, '$.effectiveState')
            WHERE key NOT IN (
              'effectiveStateVersion', 'effectiveStateDomain', 'request',
              'effectivePolicy', 'effectiveFinalCheckpoint', 'effectiveStateHash'
            )
          )
          OR json_type(
            NEW.payload_json, '$.effectiveState.effectiveStateVersion'
          ) IS NOT 'integer'
          OR json_extract(
            NEW.payload_json, '$.effectiveState.effectiveStateVersion'
          ) IS NOT 1
          OR json_type(
            NEW.payload_json, '$.effectiveState.effectiveStateDomain'
          ) IS NOT 'text'
          OR json_extract(NEW.payload_json, '$.effectiveState.effectiveStateDomain')
            IS NOT 'project-memory/session-end-effective-state/v1'
          OR json_type(NEW.payload_json, '$.effectiveState.request') <> 'object'
          OR json_type(NEW.payload_json, '$.effectiveState.effectivePolicy') <> 'object'
          OR json_type(NEW.payload_json, '$.effectiveState.effectiveFinalCheckpoint') <> 'object'
          OR (SELECT count(*) FROM json_each(
            NEW.payload_json, '$.effectiveState.request'
          )) <> 8
          OR (SELECT count(DISTINCT key) FROM json_each(
            NEW.payload_json, '$.effectiveState.request'
          )) <> 8
          OR EXISTS (
            SELECT 1 FROM json_each(
              NEW.payload_json, '$.effectiveState.request'
            )
            WHERE key NOT IN (
              'requestVersion', 'sessionId', 'childEndPolicy', 'finalCheckpoint',
              'validationProfileIds', 'requestedQualityThreshold',
              'requireFullEvidence', 'requireMaterialization'
            )
          )
          OR json_type(
            NEW.payload_json, '$.effectiveState.request.requestVersion'
          ) <> 'integer'
          OR json_extract(
            NEW.payload_json, '$.effectiveState.request.requestVersion'
          ) NOT IN (1, 2)
          OR json_type(
            NEW.payload_json, '$.effectiveState.request.sessionId'
          ) <> 'text'
          OR json_type(
            NEW.payload_json, '$.effectiveState.request.childEndPolicy'
          ) IS NOT 'text'
          OR coalesce(
            json_extract(
              NEW.payload_json, '$.effectiveState.request.childEndPolicy'
            ) IN ('require-completed', 'suspend-and-carry-forward'),
            0
          ) = 0
          OR json_type(
            NEW.payload_json, '$.effectiveState.request.finalCheckpoint'
          ) <> 'object'
          OR json_type(
            NEW.payload_json, '$.effectiveState.request.validationProfileIds'
          ) <> 'array'
          OR json_array_length(
            NEW.payload_json, '$.effectiveState.request.validationProfileIds'
          ) > 64
          OR EXISTS (
            SELECT 1 FROM json_each(
              NEW.payload_json,
              '$.effectiveState.request.validationProfileIds'
            ) AS profile_id
            WHERE profile_id.type <> 'text'
              OR length(profile_id.value) NOT BETWEEN 1 AND 256
          )
          OR (SELECT count(*) FROM json_each(
            NEW.payload_json,
            '$.effectiveState.request.validationProfileIds'
          )) <> (SELECT count(DISTINCT value) FROM json_each(
            NEW.payload_json,
            '$.effectiveState.request.validationProfileIds'
          ))
          OR EXISTS (
            SELECT 1
            FROM json_each(
              NEW.payload_json,
              '$.effectiveState.request.validationProfileIds'
            ) AS left_profile
            JOIN json_each(
              NEW.payload_json,
              '$.effectiveState.request.validationProfileIds'
            ) AS right_profile
              ON CAST(right_profile.key AS INTEGER)
                = CAST(left_profile.key AS INTEGER) + 1
            WHERE left_profile.value COLLATE BINARY
              >= right_profile.value COLLATE BINARY
          )
          OR json_type(
            NEW.payload_json,
            '$.effectiveState.request.requestedQualityThreshold'
          ) <> 'integer'
          OR json_extract(
            NEW.payload_json,
            '$.effectiveState.request.requestedQualityThreshold'
          ) NOT BETWEEN 0 AND 10000
          OR json_type(
            NEW.payload_json, '$.effectiveState.request.requireFullEvidence'
          ) NOT IN ('true', 'false')
          OR json_type(
            NEW.payload_json, '$.effectiveState.request.requireMaterialization'
          ) NOT IN ('true', 'false')
          OR (SELECT count(*) FROM json_each(
            NEW.payload_json, '$.effectiveState.effectivePolicy'
          )) <> 5
          OR (SELECT count(DISTINCT key) FROM json_each(
            NEW.payload_json, '$.effectiveState.effectivePolicy'
          )) <> 5
          OR EXISTS (
            SELECT 1 FROM json_each(
              NEW.payload_json, '$.effectiveState.effectivePolicy'
            )
            WHERE key NOT IN (
              'qualityPolicyVersion', 'profiles', 'qualityThreshold',
              'requireFullEvidence', 'requireMaterialization'
            )
          )
          OR json_type(
            NEW.payload_json,
            '$.effectiveState.effectivePolicy.qualityPolicyVersion'
          ) IS NOT 'integer'
          OR json_extract(
            NEW.payload_json,
            '$.effectiveState.effectivePolicy.qualityPolicyVersion'
          ) IS NOT 1
          OR json_type(
            NEW.payload_json, '$.effectiveState.effectivePolicy.profiles'
          ) <> 'array'
          OR json_array_length(
            NEW.payload_json, '$.effectiveState.effectivePolicy.profiles'
          ) NOT BETWEEN 1 AND 64
          OR EXISTS (
            SELECT 1 FROM json_each(
              NEW.payload_json, '$.effectiveState.effectivePolicy.profiles'
            ) AS profile
            WHERE profile.type <> 'object'
              OR (SELECT count(*) FROM json_each(profile.value)) <> 4
              OR (SELECT count(DISTINCT key) FROM json_each(profile.value)) <> 4
              OR EXISTS (
                SELECT 1 FROM json_each(profile.value)
                WHERE key NOT IN (
                  'profileId', 'profileVersion', 'required', 'weight'
                )
              )
              OR json_type(profile.value, '$.profileId') <> 'text'
              OR length(json_extract(profile.value, '$.profileId'))
                NOT BETWEEN 1 AND 256
              OR json_type(profile.value, '$.profileVersion') <> 'integer'
              OR json_extract(profile.value, '$.profileVersion') < 1
              OR json_type(profile.value, '$.required') NOT IN ('true', 'false')
              OR json_type(profile.value, '$.weight') <> 'integer'
              OR json_extract(profile.value, '$.weight') NOT BETWEEN 1 AND 1000000
          )
          OR (SELECT count(*) FROM json_each(
            NEW.payload_json, '$.effectiveState.effectivePolicy.profiles'
          )) <> (SELECT count(*) FROM (
            SELECT json_extract(value, '$.profileId'),
                   json_extract(value, '$.profileVersion')
            FROM json_each(
              NEW.payload_json, '$.effectiveState.effectivePolicy.profiles'
            )
            GROUP BY 1, 2
          ))
          OR EXISTS (
            SELECT 1
            FROM json_each(
              NEW.payload_json, '$.effectiveState.effectivePolicy.profiles'
            ) AS left_profile
            JOIN json_each(
              NEW.payload_json, '$.effectiveState.effectivePolicy.profiles'
            ) AS right_profile
              ON CAST(right_profile.key AS INTEGER)
                = CAST(left_profile.key AS INTEGER) + 1
            WHERE json_extract(
              left_profile.value, '$.profileId'
            ) COLLATE BINARY > json_extract(
              right_profile.value, '$.profileId'
            ) COLLATE BINARY
              OR (
                json_extract(left_profile.value, '$.profileId')
                  IS json_extract(right_profile.value, '$.profileId')
                AND json_extract(left_profile.value, '$.profileVersion')
                  >= json_extract(right_profile.value, '$.profileVersion')
              )
          )
          OR json_type(
            NEW.payload_json,
            '$.effectiveState.effectivePolicy.qualityThreshold'
          ) <> 'integer'
          OR json_extract(
            NEW.payload_json,
            '$.effectiveState.effectivePolicy.qualityThreshold'
          ) NOT BETWEEN 0 AND 10000
          OR json_type(
            NEW.payload_json,
            '$.effectiveState.effectivePolicy.requireFullEvidence'
          ) NOT IN ('true', 'false')
          OR json_type(
            NEW.payload_json,
            '$.effectiveState.effectivePolicy.requireMaterialization'
          ) NOT IN ('true', 'false')
          OR length(CAST(json_extract(
            NEW.payload_json, '$.effectiveState.effectiveFinalCheckpoint'
          ) AS BLOB)) > 262144
          OR (SELECT count(*) FROM json_each(
            NEW.payload_json, '$.effectiveState.effectiveFinalCheckpoint'
          )) <> 15
          OR (SELECT count(DISTINCT key) FROM json_each(
            NEW.payload_json, '$.effectiveState.effectiveFinalCheckpoint'
          )) <> 15
          OR EXISTS (
            SELECT 1 FROM json_each(
              NEW.payload_json, '$.effectiveState.effectiveFinalCheckpoint'
            )
            WHERE key NOT IN (
              'checkpointVersion', 'taskSummary', 'completedItems',
              'inProgressItems', 'blockers', 'nextActions', 'decisions',
              'assumptions', 'unresolvedConflicts', 'filesTouched',
              'artifactReferences', 'sourceReferences', 'commandResults',
              'testResults', 'materialClaims'
            )
          )
          OR json_type(
            NEW.payload_json,
            '$.effectiveState.effectiveFinalCheckpoint.checkpointVersion'
          ) <> 'integer'
          OR json_type(
            NEW.payload_json,
            '$.effectiveState.effectiveFinalCheckpoint.taskSummary'
          ) <> 'text'
          OR length(json_extract(
            NEW.payload_json,
            '$.effectiveState.effectiveFinalCheckpoint.taskSummary'
          )) > 2000
          OR EXISTS (
            SELECT 1 FROM json_each(
              NEW.payload_json, '$.effectiveState.effectiveFinalCheckpoint'
            )
            WHERE key IN (
              'completedItems', 'inProgressItems', 'blockers', 'nextActions',
              'decisions', 'assumptions', 'unresolvedConflicts', 'filesTouched',
              'artifactReferences', 'sourceReferences', 'commandResults',
              'testResults', 'materialClaims'
            )
              AND type <> 'array'
          )
          OR json_type(NEW.payload_json, '$.effectiveState.effectiveStateHash') <> 'text'
          OR length(json_extract(
            NEW.payload_json, '$.effectiveState.effectiveStateHash'
          )) <> 64
          OR json_extract(NEW.payload_json, '$.effectiveState.effectiveStateHash')
            GLOB '*[^0-9a-f]*'
          OR json_extract(NEW.payload_json, '$.effectiveState.request.sessionId')
            IS NOT NEW.session_id
          OR json_extract(NEW.payload_json, '$.effectiveState.request.requestVersion')
            NOT IN (1, 2)
          OR json_extract(
            NEW.payload_json,
            '$.effectiveState.effectiveFinalCheckpoint.checkpointVersion'
          ) IS NOT json_extract(
            NEW.payload_json, '$.effectiveState.request.requestVersion'
          )
          OR json(json_extract(
            NEW.payload_json, '$.effectiveState.effectiveFinalCheckpoint'
          )) <> json(json_extract(
            NEW.payload_json, '$.effectiveState.request.finalCheckpoint'
          ))
        )
      )
    THEN RAISE(ABORT, 'SESSION_END_EVENT_V3_INVALID')
  END;
END;

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
`),
};
