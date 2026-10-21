import type { Migration } from "../migration.js";
import { sessionLifecycleMigration } from "./0002-session-lifecycle.js";

function priorTriggerSql(name: string): string {
  const marker = `CREATE TRIGGER ${name}`;
  const start = sessionLifecycleMigration.sql.indexOf(marker);
  const end = sessionLifecycleMigration.sql.indexOf("\nEND;", start);
  if (start < 0 || end < 0) throw new Error(`Missing frozen migration trigger: ${name}`);
  return sessionLifecycleMigration.sql.slice(start, end + 5);
}

const WORKFLOW_LIFECYCLE_V5_UPDATE_GUARD = (() => {
  const prior = priorTriggerSql("workflow_instances_lifecycle_update_guard");
  const immutableLifecycleIdentity = `OR (NEW.generation = OLD.generation AND (
      NEW.root_command_id IS NOT OLD.root_command_id
      OR NEW.triggering_event_position IS NOT OLD.triggering_event_position
      OR NEW.expected_authority_commitment IS NOT OLD.expected_authority_commitment
    ))`;
  const finalCheckpointTransition = `OR (NEW.generation = OLD.generation AND (
      NEW.expected_authority_commitment IS NOT OLD.expected_authority_commitment
      OR (
        (
          NEW.root_command_id IS NOT OLD.root_command_id
          OR NEW.triggering_event_position IS NOT OLD.triggering_event_position
        )
        AND NOT (
          OLD.phase = 'children-resolved'
          AND NEW.phase = 'final-checkpoint-recorded'
          AND NEW.root_command_id IS NOT OLD.root_command_id
          AND NEW.triggering_event_position > OLD.triggering_event_position
          AND NEW.evidence_frozen_checkpoint_event_position = NEW.triggering_event_position
          AND NEW.evidence_frozen_generation = NEW.generation
          AND NEW.evidence_window_state = 'sealed'
          AND NEW.final_ending_scope_bindings_json IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM events AS final_checkpoint_event
            WHERE final_checkpoint_event.project_id = NEW.project_id
              AND final_checkpoint_event.global_position = NEW.triggering_event_position
              AND final_checkpoint_event.session_id = NEW.session_id
              AND final_checkpoint_event.parent_session_id IS NULL
              AND final_checkpoint_event.stream_type = 'session'
              AND final_checkpoint_event.stream_id = 'session/' || NEW.session_id
              AND final_checkpoint_event.command_id = NEW.root_command_id
              AND final_checkpoint_event.command_event_index = 0
              AND final_checkpoint_event.event_type = 'SessionCheckpointRecorded'
              AND final_checkpoint_event.event_schema_version = 3
              AND json_extract(final_checkpoint_event.payload_json, '$.workflowId')
                = NEW.workflow_id
              AND json_extract(final_checkpoint_event.payload_json, '$.workflowGeneration')
                = NEW.generation
              AND json_extract(
                final_checkpoint_event.payload_json, '$.checkpoint.checkpointEventPosition'
              ) = CAST(NEW.triggering_event_position AS TEXT)
          )
        )
      )
    ))`;
  const replacement = prior.replace(immutableLifecycleIdentity, finalCheckpointTransition);
  if (replacement === prior) {
    throw new Error("Missing immutable lifecycle identity guard for schema-5 transition");
  }
  return replacement;
})();

/** Allows only the committed schema-3 final-checkpoint marker to become the
 * immutable lifecycle trigger for its already-sealed workflow generation. */
export const sessionEndFinalCheckpointTransitionMigration: Migration = {
  version: 5,
  name: "session-end-final-checkpoint-transition",
  sql: `
DROP TRIGGER workflow_instances_lifecycle_update_guard;

${WORKFLOW_LIFECYCLE_V5_UPDATE_GUARD}
`,
};
