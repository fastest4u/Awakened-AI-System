import type { ProjectContext } from "../identity/contracts.js";
import { sessionEndWorkflowId } from "../lifecycle/session-end-identifiers.js";
import type { SessionId } from "../lifecycle/contracts/identifiers.js";
import { parseCanonicalUuid } from "../lifecycle/contracts/identifiers.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { SchemaCompatibilityError } from "./schema-compatibility.js";
import type { SqliteConnection } from "./sqlite-driver.js";

const PRECONDITION = "MIGRATION_SESSION_END_EFFECTIVE_STATE_PRECONDITION_FAILED";

function fail(): never {
  throw new SchemaCompatibilityError(PRECONDITION);
}

function integer(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "bigint") return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

const PLAN_KEYS = [
  "commandId",
  "idempotencyKey",
  "profileId",
  "profileVersion",
  "resultId",
  "runId",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LOWER_HASH = /^[0-9a-f]{64}$/u;

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

const OUTBOX_PAYLOAD_KEYS = [
  "payloadVersion",
  "targetKey",
  "sessionId",
  "artifactKind",
  "artifactPath",
  "materializationRevision",
  "triggeringPayloadHash",
  "nextFingerprint",
  "origin",
  "triggeringEventType",
] as const;
const NEXT_FINGERPRINT_KEYS = [
  "algorithm", "schemaVersion", "keyId", "domain", "value",
] as const;
const ORIGIN_KEYS = ["kind", "workflowId", "workflowGeneration"] as const;
const LIFECYCLE_TRIGGER_TYPES = new Set([
  "SessionCheckpointRecorded",
  "SessionEndAmended",
  "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated",
  "SessionEndCancelled",
  "SessionAbandoned",
  "SessionEnded",
]);

function assertLifecycleOutboxDescriptor(
  connection: SqliteConnection,
  row: Readonly<Record<string, unknown>>,
): void {
  try {
    if (typeof row.payload_json !== "string") fail();
    const parsed: unknown = JSON.parse(row.payload_json);
    if (canonicalJson(parsed) !== row.payload_json) fail();
    const payload = jsonRecord(parsed);
    if (payload === undefined || !hasExactKeys(payload, OUTBOX_PAYLOAD_KEYS)) fail();
    const nextFingerprint = jsonRecord(payload.nextFingerprint);
    const origin = jsonRecord(payload.origin);
    const eventPosition = integer(row.event_position);
    const revision = integer(row.materialization_revision);
    const workflowGeneration = row.workflow_generation === null
      ? null
      : integer(row.workflow_generation);
    if (
      typeof row.project_id !== "string"
      || typeof row.session_id !== "string"
      || typeof row.target_key !== "string"
      || typeof row.artifact_kind !== "string"
      || typeof row.artifact_path !== "string"
      || eventPosition === undefined
      || revision === undefined
      || eventPosition !== revision
      || payload.payloadVersion !== 1
      || payload.targetKey !== row.target_key
      || payload.sessionId !== row.session_id
      || payload.artifactKind !== "compatibility-session-log"
      || payload.artifactKind !== row.artifact_kind
      || payload.artifactPath !== row.artifact_path
      || payload.materializationRevision !== String(revision)
      || row.target_key !== `lifecycle-log/${row.session_id}/${revision}`
      || typeof payload.triggeringPayloadHash !== "string"
      || !LOWER_HASH.test(payload.triggeringPayloadHash)
      || typeof payload.triggeringEventType !== "string"
      || !LIFECYCLE_TRIGGER_TYPES.has(payload.triggeringEventType)
      || nextFingerprint === undefined
      || !hasExactKeys(nextFingerprint, NEXT_FINGERPRINT_KEYS)
      || nextFingerprint.algorithm !== "hmac-sha256"
      || nextFingerprint.algorithm !== row.fingerprint_algorithm
      || nextFingerprint.schemaVersion !== 1
      || nextFingerprint.schemaVersion !== integer(row.fingerprint_schema_version)
      || typeof nextFingerprint.keyId !== "string"
      || nextFingerprint.keyId.length < 1
      || nextFingerprint.keyId.length > 128
      || nextFingerprint.keyId !== row.fingerprint_key_id
      || nextFingerprint.domain !== "pm-materialization-fingerprint-v1"
      || nextFingerprint.domain !== row.fingerprint_domain
      || typeof nextFingerprint.value !== "string"
      || !LOWER_HASH.test(nextFingerprint.value)
      || nextFingerprint.value !== row.next_fingerprint
      || origin === undefined
      || !hasExactKeys(origin, ORIGIN_KEYS)
      || origin.kind !== row.origin_kind
      || origin.workflowId !== row.workflow_id
      || (origin.workflowGeneration === null
        ? workflowGeneration !== null
        : integer(origin.workflowGeneration) !== workflowGeneration)
      || typeof row.content_hash !== "string"
      || !LOWER_HASH.test(row.content_hash)
    ) fail();

    const trigger = connection.prepare(`
      SELECT event_type, event_schema_version, payload_json, payload_hash, command_event_index,
             session_id, stream_type, stream_id
      FROM events
      WHERE project_id = $projectId AND global_position = $eventPosition
    `).get({
      $projectId: row.project_id,
      $eventPosition: eventPosition,
    });
    if (
      trigger === undefined
      || trigger.session_id !== row.session_id
      || trigger.stream_type !== "session"
      || trigger.stream_id !== `session/${row.session_id}`
      || integer(trigger.command_event_index) !== 0
      || trigger.event_type !== payload.triggeringEventType
      || trigger.payload_hash !== payload.triggeringPayloadHash
      || typeof trigger.payload_json !== "string"
    ) fail();
    const triggerPayload = jsonRecord(JSON.parse(trigger.payload_json));
    if (triggerPayload === undefined) fail();
    if (row.origin_kind === "terminal-event") {
      if (
        row.workflow_id !== null
        || workflowGeneration !== null
        || trigger.event_type !== "SessionAbandoned"
        || triggerPayload.workflowId !== null
        || triggerPayload.workflowGeneration !== null
      ) fail();
    } else if (row.origin_kind === "workflow") {
      if (
        typeof row.workflow_id !== "string"
        || !UUID.test(row.workflow_id)
        || workflowGeneration === undefined
        || workflowGeneration === null
        || workflowGeneration < 1
      ) fail();
      if (trigger.event_type === "SessionCheckpointRecorded") {
        if (
          integer(trigger.event_schema_version) !== 3
          || triggerPayload.workflowId !== row.workflow_id
          || integer(triggerPayload.workflowGeneration) !== workflowGeneration
        ) fail();
        const workflow = connection.prepare(`
          SELECT 1
          FROM workflow_instances
          WHERE project_id = $projectId
            AND workflow_id = $workflowId
            AND session_id = $sessionId
            AND generation = $workflowGeneration
        `).get({
          $projectId: row.project_id,
          $workflowId: row.workflow_id,
          $sessionId: row.session_id,
          $workflowGeneration: workflowGeneration,
        });
        if (workflow === undefined) fail();
      } else if (
        triggerPayload.workflowId !== row.workflow_id
        || integer(triggerPayload.workflowGeneration) !== workflowGeneration
      ) fail();
    } else {
      fail();
    }

    const started = connection.prepare(`
      SELECT occurred_at
      FROM events
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND stream_id = $streamId
        AND stream_version = 1
        AND event_type = 'SessionStarted'
        AND event_schema_version = 1
    `).get({
      $projectId: row.project_id,
      $sessionId: row.session_id,
      $streamId: `session/${row.session_id}`,
    });
    if (
      started === undefined
      || typeof started.occurred_at !== "string"
      || row.artifact_path !== `05_Agent_Session_Logs/${
        started.occurred_at.slice(0, 10)
      }-session-${row.session_id}.md`
    ) fail();
  } catch (error) {
    if (error instanceof SchemaCompatibilityError && error.code === PRECONDITION) {
      throw error;
    }
    fail();
  }
}

function assertValidationPlans(source: string): void {
  try {
    if (Buffer.byteLength(source, "utf8") > 262_144) fail();
    const parsed: unknown = JSON.parse(source);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 64) fail();
    if (canonicalJson(parsed) !== source) fail();
    const profiles = new Set<string>();
    const runs = new Set<string>();
    const results = new Set<string>();
    const commands = new Set<string>();
    const idempotencyKeys = new Set<string>();
    let previous: { readonly profileId: string; readonly profileVersion: number } | undefined;
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) fail();
      const plan = entry as Record<string, unknown>;
      const keys = Object.keys(plan).sort();
      if (
        keys.length !== PLAN_KEYS.length
        || keys.some((key, index) => key !== PLAN_KEYS[index])
        || typeof plan.profileId !== "string"
        || plan.profileId.length === 0
        || !Number.isSafeInteger(plan.profileVersion)
        || Number(plan.profileVersion) <= 0
        || typeof plan.runId !== "string"
        || !UUID.test(plan.runId)
        || typeof plan.resultId !== "string"
        || !UUID.test(plan.resultId)
        || typeof plan.commandId !== "string"
        || !UUID.test(plan.commandId)
        || typeof plan.idempotencyKey !== "string"
        || plan.idempotencyKey.length === 0
      ) fail();
      const profileId = plan.profileId;
      const profileVersion = Number(plan.profileVersion);
      if (previous !== undefined) {
        const order = Buffer.compare(
          Buffer.from(previous.profileId, "utf8"),
          Buffer.from(profileId, "utf8"),
        );
        if (order > 0 || (order === 0 && previous.profileVersion >= profileVersion)) fail();
      }
      previous = { profileId, profileVersion };
      const profile = `${profileId}\0${profileVersion}`;
      if (
        profiles.has(profile)
        || runs.has(plan.runId)
        || results.has(plan.resultId)
        || commands.has(plan.commandId)
        || idempotencyKeys.has(plan.idempotencyKey)
      ) fail();
      profiles.add(profile);
      runs.add(plan.runId);
      results.add(plan.resultId);
      commands.add(plan.commandId);
      idempotencyKeys.add(plan.idempotencyKey);
    }
  } catch (error) {
    if (error instanceof SchemaCompatibilityError && error.code === PRECONDITION) throw error;
    fail();
  }
}

export interface SessionEndEffectiveStateMigrationPreflight {
  assertEligible(connection: SqliteConnection, context: ProjectContext): void;
}

export function sessionEndEffectiveStateMigrationFailure(
  error: unknown,
): SchemaCompatibilityError | undefined {
  if (error instanceof SchemaCompatibilityError && error.code === PRECONDITION) {
    return error;
  }
  try {
    if (
      typeof error === "object"
      && error !== null
      && Reflect.get(error, "message") === PRECONDITION
      && Reflect.get(error, "code") === "ERR_SQLITE_ERROR"
      && Reflect.get(error, "errcode") === 1811
    ) return new SchemaCompatibilityError(PRECONDITION);
  } catch {
    return undefined;
  }
  return undefined;
}

export class SqliteSessionEndEffectiveStateMigrationPreflight
implements SessionEndEffectiveStateMigrationPreflight {
  assertEligible(connection: SqliteConnection, context: ProjectContext): void {
    const identities = connection.prepare(`
      SELECT project_id, vault_id, store_id, schema_version
      FROM project_meta WHERE singleton = 1
    `).all();
    const identity = identities[0];
    if (
      identities.length !== 1
      || identity?.project_id !== context.binding.projectId
      || identity.vault_id !== context.binding.vaultId
      || identity.store_id !== context.binding.storeId
      || integer(identity.schema_version) !== 3
    ) fail();
    const disallowedOuterVersions = integer(connection.prepare(`
      SELECT count(*) AS count
      FROM events
      WHERE stream_type = 'session'
        AND session_id IS NOT NULL
        AND (
          (event_type = 'EvidenceCoverageRecorded' AND event_schema_version <> 2)
          OR (event_type = 'SessionCheckpointRecorded'
            AND event_schema_version NOT IN (1, 2))
          OR (event_type IN ('SessionEndRequested', 'SessionEndAmended')
            AND event_schema_version NOT IN (1, 2))
          OR (event_type IN (
            'SessionStarted', 'SessionOwnerTransferred',
            'SessionOwnershipRecovered', 'SessionSuspendRequested',
            'SessionSuspended', 'SessionResumed', 'SessionForked',
            'ChildAssignmentAmended', 'ChildWorkReported',
            'ChildWorkDispositioned', 'ChildCompletionProposed',
            'ChildSessionCompleted', 'ChildSessionSuspended',
            'ChildWorkTransferCreated', 'ChildWorkTransferClaimed',
            'SessionValidationResultRecorded', 'SessionEndVerificationPassed',
            'SessionEndVerificationFailed',
            'SessionEndVerificationInvalidated', 'SessionEndCancelled',
            'SessionAbandoned', 'SessionEnded'
          ) AND event_schema_version <> 1)
        )
    `).get()?.count);
    if (disallowedOuterVersions === undefined || disallowedOuterVersions !== 0) fail();

    const nonterminal = integer(connection.prepare(`
      SELECT count(*) AS count
      FROM workflow_instances
      WHERE session_id IS NOT NULL
        AND workflow_type = 'session-end'
        AND phase NOT IN ('cancelled', 'completed', 'abandoned')
    `).get()?.count);
    if (nonterminal === undefined || nonterminal !== 0) fail();

    const terminalWorkflows = connection.prepare(`
      SELECT workflow_id, session_id
      FROM workflow_instances
      WHERE session_id IS NOT NULL AND workflow_type = 'session-end'
    `).all();
    for (const workflow of terminalWorkflows) {
      if (
        typeof workflow.workflow_id !== "string"
        || typeof workflow.session_id !== "string"
      ) fail();
      try {
        const sessionId = parseCanonicalUuid(
          workflow.session_id,
          "sessionId",
        ) as SessionId;
        if (sessionEndWorkflowId(sessionId) !== workflow.workflow_id) fail();
      } catch {
        fail();
      }
    }

    const plans = connection.prepare(`
      SELECT validation_attempt_plans_json
      FROM workflow_instances
      WHERE validation_attempt_plans_json IS NOT NULL
    `).all();
    for (const row of plans) {
      if (typeof row.validation_attempt_plans_json !== "string") fail();
      assertValidationPlans(row.validation_attempt_plans_json);
    }

    const invalidTerminalLineage = connection.prepare(`
      SELECT 1
      FROM workflow_instances AS workflow
      LEFT JOIN lifecycle_workflow_generation_folds AS head
        ON head.project_id = workflow.project_id
        AND head.workflow_id = workflow.workflow_id
        AND head.workflow_generation = workflow.generation
        AND head.session_id = workflow.session_id
        AND head.trigger_event_position = workflow.triggering_event_position
        AND head.root_command_id = workflow.root_command_id
      LEFT JOIN events AS head_event
        ON head_event.project_id = workflow.project_id
        AND head_event.global_position = head.trigger_event_position
        AND head_event.session_id = workflow.session_id
        AND head_event.parent_session_id IS NULL
        AND head_event.stream_type = 'session'
        AND head_event.stream_id = 'session/' || workflow.session_id
      LEFT JOIN session_authority AS authority
        ON authority.project_id = workflow.project_id
        AND authority.session_id = workflow.session_id
        AND authority.session_kind = 'root'
      WHERE workflow.session_id IS NOT NULL
        AND workflow.workflow_type = 'session-end'
        AND workflow.phase IN ('cancelled', 'completed', 'abandoned')
        AND (
          head.workflow_id IS NULL
          OR head_event.global_position IS NULL
          OR json_extract(head_event.payload_json, '$.workflowId')
            IS NOT workflow.workflow_id
          OR json_extract(head_event.payload_json, '$.workflowGeneration')
            IS NOT workflow.generation
          OR NOT EXISTS (
            SELECT 1 FROM events AS intent_event
            WHERE intent_event.project_id = head_event.project_id
              AND intent_event.command_id = head_event.command_id
              AND intent_event.command_event_index = 0
              AND intent_event.session_id = head_event.session_id
              AND intent_event.stream_id = head_event.stream_id
              AND intent_event.lifecycle_intent_json IS NOT NULL
          )
          OR (
            SELECT count(*)
            FROM lifecycle_workflow_generation_folds AS generation
            WHERE generation.project_id = workflow.project_id
              AND generation.workflow_id = workflow.workflow_id
              AND generation.session_id = workflow.session_id
              AND generation.workflow_generation BETWEEN 1 AND workflow.generation
          ) <> workflow.generation
          OR EXISTS (
            SELECT 1
            FROM lifecycle_workflow_generation_folds AS generation
            LEFT JOIN lifecycle_workflow_generation_folds AS predecessor
              ON predecessor.project_id = generation.project_id
              AND predecessor.workflow_id = generation.workflow_id
              AND predecessor.session_id = generation.session_id
              AND predecessor.workflow_generation
                = generation.workflow_generation - 1
            LEFT JOIN events AS trigger_event
              ON trigger_event.project_id = generation.project_id
              AND trigger_event.global_position = generation.trigger_event_position
              AND trigger_event.session_id = generation.session_id
              AND trigger_event.parent_session_id IS NULL
              AND trigger_event.stream_type = 'session'
              AND trigger_event.stream_id = 'session/' || generation.session_id
            WHERE generation.project_id = workflow.project_id
              AND generation.workflow_id = workflow.workflow_id
              AND generation.session_id = workflow.session_id
              AND generation.workflow_generation BETWEEN 1 AND workflow.generation
              AND (
                trigger_event.global_position IS NULL
                OR json_extract(trigger_event.payload_json, '$.workflowId')
                  IS NOT generation.workflow_id
                OR json_extract(
                  trigger_event.payload_json, '$.workflowGeneration'
                ) IS NOT generation.workflow_generation
                OR NOT EXISTS (
                  SELECT 1 FROM events AS intent_event
                  WHERE intent_event.project_id = trigger_event.project_id
                    AND intent_event.command_id = trigger_event.command_id
                    AND intent_event.command_event_index = 0
                    AND intent_event.session_id = trigger_event.session_id
                    AND intent_event.stream_id = trigger_event.stream_id
                    AND intent_event.lifecycle_intent_json IS NOT NULL
                )
                OR (
                  generation.workflow_generation = 1
                  AND (
                    generation.previous_fingerprint IS NOT NULL
                    OR predecessor.workflow_generation IS NOT NULL
                  )
                )
                OR (
                  generation.workflow_generation > 1
                  AND (
                    predecessor.workflow_generation
                      IS NOT generation.workflow_generation - 1
                    OR predecessor.trigger_event_position
                      >= generation.trigger_event_position
                    OR generation.previous_fingerprint
                      IS NOT predecessor.fingerprint
                  )
                )
              )
          )
          OR authority.session_id IS NULL
          OR (
            workflow.phase = 'cancelled'
            AND (
              head_event.event_type <> 'SessionEndCancelled'
              OR head_event.event_schema_version <> 1
              OR head.evidence_window_state <> 'sealed'
              OR authority.semantic_state IS NOT json_extract(
                head_event.payload_json, '$.restoredState'
              )
              OR authority.terminal_event_position IS NOT NULL
              OR authority.terminal_event_type IS NOT NULL
              OR authority.terminal_at IS NOT NULL
            )
          )
          OR (
            workflow.phase = 'abandoned'
            AND (
              head_event.event_type <> 'SessionAbandoned'
              OR head_event.event_schema_version <> 1
              OR authority.semantic_state <> 'abandoned'
              OR authority.terminal_event_position IS NOT head_event.global_position
              OR authority.terminal_event_type <> 'SessionAbandoned'
            )
          )
          OR (
            workflow.phase = 'completed'
            AND (
              authority.semantic_state <> 'completed'
              OR authority.terminal_event_type <> 'SessionEnded'
              OR authority.terminal_event_position IS NULL
              OR authority.terminal_event_position < head.trigger_event_position
              OR NOT EXISTS (
                SELECT 1 FROM events AS terminal_event
                WHERE terminal_event.project_id = workflow.project_id
                  AND terminal_event.global_position
                    = authority.terminal_event_position
                  AND terminal_event.session_id = workflow.session_id
                  AND terminal_event.parent_session_id IS NULL
                  AND terminal_event.event_type = 'SessionEnded'
                  AND terminal_event.event_schema_version = 1
                  AND json_extract(
                    terminal_event.payload_json, '$.workflowId'
                  ) = workflow.workflow_id
                  AND json_extract(
                    terminal_event.payload_json, '$.workflowGeneration'
                  ) = workflow.generation
              )
            )
          )
        )
      LIMIT 1
    `).get();
    if (invalidTerminalLineage !== undefined) fail();

    const lifecycleOutboxRows = connection.prepare(`
      SELECT project_id, target_key, event_position, payload_json, content_hash,
             session_id, origin_kind, workflow_id, workflow_generation,
             artifact_kind, artifact_path, materialization_revision,
             next_fingerprint, fingerprint_algorithm, fingerprint_schema_version,
             fingerprint_key_id, fingerprint_domain
      FROM outbox
      WHERE kind = 'materialize-lifecycle-log'
    `).all();
    for (const row of lifecycleOutboxRows) {
      assertLifecycleOutboxDescriptor(connection, row);
    }

    const legacyFinalPointer = connection.prepare(`
      SELECT 1
      FROM workflow_instances
      WHERE session_id IS NOT NULL
        AND workflow_type = 'session-end'
        AND (
          evidence_frozen_checkpoint_event_position IS NOT NULL
          OR evidence_frozen_generation IS NOT NULL
          OR final_ending_scope_bindings_json IS NOT NULL
        )
      LIMIT 1
    `).get();
    if (legacyFinalPointer !== undefined) fail();

    const forkAuthorityDrift = connection.prepare(`
      SELECT 1
      FROM session_authority AS child
      WHERE child.session_kind = 'child'
        AND (
          SELECT count(*)
          FROM events AS fork
          WHERE fork.project_id = child.project_id
            AND fork.session_id = child.session_id
            AND fork.stream_id = child.stream_id
            AND fork.stream_type = 'session'
            AND fork.stream_version = 1
            AND fork.event_type = 'SessionForked'
            AND fork.event_schema_version = 1
            AND fork.parent_session_id IS child.parent_session_id
            AND fork.workspace_id = child.workspace_id
            AND json_extract(fork.payload_json, '$.parentSessionId')
              IS child.parent_session_id
        ) <> 1
      UNION ALL
      SELECT 1
      FROM events AS fork
      WHERE fork.stream_type = 'session'
        AND fork.event_type = 'SessionForked'
        AND fork.event_schema_version = 1
        AND fork.stream_version = 1
        AND NOT EXISTS (
          SELECT 1
          FROM session_authority AS child
          WHERE child.project_id = fork.project_id
            AND child.session_id = fork.session_id
            AND child.stream_id = fork.stream_id
            AND child.session_kind = 'child'
            AND child.parent_session_id IS fork.parent_session_id
            AND child.workspace_id = fork.workspace_id
        )
      LIMIT 1
    `).get();
    if (forkAuthorityDrift !== undefined) fail();

    const ticketClaimDrift = connection.prepare(`
      SELECT 1
      FROM child_transfer_tickets AS ticket
      LEFT JOIN events AS source_transfer
        ON source_transfer.project_id = ticket.project_id
        AND source_transfer.global_position = ticket.created_event_position
        AND source_transfer.session_id = ticket.source_child_session_id
        AND source_transfer.parent_session_id IS ticket.source_parent_session_id
        AND source_transfer.event_type = 'ChildWorkTransferCreated'
        AND source_transfer.event_schema_version IN (1, 2)
        AND json_extract(source_transfer.payload_json, '$.transferTicketId')
          IS ticket.transfer_ticket_id
        AND json_extract(source_transfer.payload_json, '$.checkpointId')
          IS ticket.checkpoint_id
      LEFT JOIN events AS claim
        ON claim.project_id = ticket.project_id
        AND json_extract(claim.payload_json, '$.transferTicketId')
          IS ticket.transfer_ticket_id
        AND claim.event_type = 'ChildWorkTransferClaimed'
        AND claim.event_schema_version = 1
      LEFT JOIN events AS fork
        ON fork.project_id = claim.project_id
        AND fork.stream_id = claim.stream_id
        AND fork.stream_version = 1
        AND fork.event_type = 'SessionForked'
        AND fork.event_schema_version = 1
      WHERE source_transfer.global_position IS NULL
        OR (
          ticket.claimed_event_position IS NULL
          AND claim.global_position IS NOT NULL
        )
        OR (
          ticket.claimed_event_position IS NOT NULL
          AND (
            claim.global_position IS NULL
            OR claim.global_position IS NOT ticket.claimed_event_position
            OR claim.session_id IS NOT ticket.claimed_child_session_id
            OR claim.parent_session_id IS NOT ticket.claimed_by_root_session_id
            OR claim.stream_id IS NOT 'session/' || ticket.claimed_child_session_id
            OR claim.stream_version IS NOT 2
            OR claim.command_event_index IS NOT 1
            OR fork.global_position IS NULL
            OR fork.global_position + 1 IS NOT claim.global_position
            OR fork.session_id IS NOT claim.session_id
            OR fork.parent_session_id IS NOT claim.parent_session_id
            OR fork.command_event_index IS NOT 0
            OR fork.command_id IS NOT claim.command_id
            OR fork.idempotency_key IS NOT claim.idempotency_key
            OR claim.causation_id IS NOT fork.event_id
            OR fork.causation_id IS NOT source_transfer.event_id
            OR fork.vault_id IS NOT claim.vault_id
            OR fork.store_id IS NOT claim.store_id
            OR fork.workspace_id IS NOT claim.workspace_id
            OR fork.branch_scope_id IS NOT claim.branch_scope_id
            OR fork.branch_ref IS NOT claim.branch_ref
            OR json_extract(fork.payload_json, '$.sourceTransferTicketId')
              IS NOT ticket.transfer_ticket_id
            OR json_extract(claim.payload_json, '$.previousChildSessionId')
              IS NOT ticket.source_child_session_id
            OR json_extract(
              claim.payload_json, '$.previousTransferEventPosition'
            ) IS NOT CAST(ticket.created_event_position AS TEXT)
          )
        )
      GROUP BY ticket.project_id, ticket.transfer_ticket_id
      HAVING count(claim.global_position) <> CASE
        WHEN ticket.claimed_event_position IS NULL THEN 0 ELSE 1 END
        OR source_transfer.global_position IS NULL
        OR ticket.claimed_event_position IS NOT NULL AND (
          min(claim.global_position) IS NOT ticket.claimed_event_position
          OR min(fork.global_position) + 1 IS NOT min(claim.global_position)
        )
      LIMIT 1
    `).get();
    if (ticketClaimDrift !== undefined) fail();

    const orphanClaim = connection.prepare(`
      SELECT 1
      FROM events AS claim
      WHERE claim.stream_type = 'session'
        AND claim.event_type = 'ChildWorkTransferClaimed'
        AND claim.event_schema_version = 1
        AND (
          SELECT count(*)
          FROM child_transfer_tickets AS ticket
          WHERE ticket.project_id = claim.project_id
            AND ticket.transfer_ticket_id IS json_extract(
              claim.payload_json, '$.transferTicketId'
            )
            AND ticket.claimed_event_position IS claim.global_position
            AND ticket.claimed_child_session_id IS claim.session_id
            AND ticket.claimed_by_root_session_id IS claim.parent_session_id
        ) <> 1
      LIMIT 1
    `).get();
    if (orphanClaim !== undefined) fail();

    const overChildHistory = connection.prepare(`
      SELECT 1
      FROM session_authority
      WHERE session_kind = 'child'
      GROUP BY project_id, parent_session_id
      HAVING count(*) > 1000
      LIMIT 1
    `).get();
    if (overChildHistory !== undefined) fail();
    const overTicketHistory = connection.prepare(`
      SELECT 1
      FROM child_transfer_tickets
      GROUP BY project_id, source_parent_session_id
      HAVING count(*) > 1000
      LIMIT 1
    `).get();
    if (overTicketHistory !== undefined) fail();
    const duplicateTicket = connection.prepare(`
      SELECT 1
      FROM child_transfer_tickets
      GROUP BY project_id, source_parent_session_id, source_child_session_id
      HAVING count(*) <> 1
      LIMIT 1
    `).get();
    if (duplicateTicket !== undefined) fail();
    const invalidTicket = connection.prepare(`
      SELECT 1
      FROM child_transfer_tickets AS ticket
      LEFT JOIN session_authority AS child
        ON child.project_id = ticket.project_id
        AND child.session_id = ticket.source_child_session_id
      WHERE child.session_id IS NULL
        OR child.session_kind <> 'child'
        OR child.parent_session_id IS NOT ticket.source_parent_session_id
        OR child.semantic_state <> 'transferred'
      LIMIT 1
    `).get();
    if (invalidTicket !== undefined) fail();
    const transferredWithoutExactTicket = connection.prepare(`
      SELECT 1
      FROM session_authority AS child
      WHERE child.session_kind = 'child'
        AND child.semantic_state = 'transferred'
        AND (
          SELECT count(*)
          FROM child_transfer_tickets AS ticket
          WHERE ticket.project_id = child.project_id
            AND ticket.source_parent_session_id IS child.parent_session_id
            AND ticket.source_child_session_id = child.session_id
        ) <> 1
      LIMIT 1
    `).get();
    if (transferredWithoutExactTicket !== undefined) fail();
  }
}
