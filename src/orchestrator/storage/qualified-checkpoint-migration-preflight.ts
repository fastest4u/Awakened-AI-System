import type { ProjectContext } from "../identity/contracts.js";
import {
  CHECKPOINT_MAX_CANONICAL_BYTES,
  decodeCheckpointV1,
  type CheckpointEvidenceCoverageV2,
  type CheckpointV1,
} from "../lifecycle/contracts/checkpoint.js";
import type { ChildSessionState } from "../lifecycle/contracts/identifiers.js";
import {
  LIFECYCLE_EVENT_TYPES,
  decodeLifecycleEventV1,
  type LifecycleEventV1,
} from "../lifecycle/contracts/events.js";
import type { StoredEvent } from "../contracts/event.js";
import {
  decodeFinalEndingScopeBindingsV1,
  FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES,
  type FinalEndingScopeBindingV1,
} from "../lifecycle/contracts/session-end.js";
import {
  minimumCheckpointUpperBound,
  minimumFinalEndingScopeBindingsUpperBound,
} from "../lifecycle/checkpoint-capacity.js";
import {
  foldChildEventProjection,
  foldWorkflowGenerationProjection,
  type ChildEventFoldProjection,
  type WorkflowGenerationFoldProjection,
} from "../lifecycle/lifecycle-projection-folds.js";
import {
  decodeLifecycleIntentWitness,
  type LifecycleIntentWitnessV1,
} from "../lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { SchemaCompatibilityError } from "./schema-compatibility.js";
import type { SqliteConnection, SqliteRow } from "./sqlite-driver.js";

export const QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE =
  "qualified_checkpoint_v3_stage_marker";
export const QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE =
  "qualified_checkpoint_v3_stage_rows";
export const QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE =
  "qualified_checkpoint_v3_stage_child_event_folds";
export const QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE =
  "qualified_checkpoint_v3_stage_workflow_generation_folds";

const PRECONDITION = "MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED" as const;
const STAGE_TRIGGER_SPECS = Object.freeze([
  ["qualified_checkpoint_v3_stage_marker_no_insert", QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE, "INSERT"],
  ["qualified_checkpoint_v3_stage_marker_no_update", QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE, "UPDATE"],
  ["qualified_checkpoint_v3_stage_marker_no_delete", QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE, "DELETE"],
  ["qualified_checkpoint_v3_stage_rows_no_insert", QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE, "INSERT"],
  ["qualified_checkpoint_v3_stage_rows_no_update", QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE, "UPDATE"],
  ["qualified_checkpoint_v3_stage_rows_no_delete", QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE, "DELETE"],
  [
    "qualified_checkpoint_v3_stage_child_event_folds_no_insert",
    QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE,
    "INSERT",
  ],
  [
    "qualified_checkpoint_v3_stage_child_event_folds_no_update",
    QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE,
    "UPDATE",
  ],
  [
    "qualified_checkpoint_v3_stage_child_event_folds_no_delete",
    QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE,
    "DELETE",
  ],
  [
    "qualified_checkpoint_v3_stage_workflow_generation_folds_no_insert",
    QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE,
    "INSERT",
  ],
  [
    "qualified_checkpoint_v3_stage_workflow_generation_folds_no_update",
    QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE,
    "UPDATE",
  ],
  [
    "qualified_checkpoint_v3_stage_workflow_generation_folds_no_delete",
    QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE,
    "DELETE",
  ],
] as const);
const POST_FINAL_PHASES = new Set([
  "final-checkpoint-recorded",
  "ending-materialization-queued",
  "validating",
  "verification-passed",
  "verification-failed",
  "completion-appended",
  "completed-materialization-confirmed",
  "completed",
]);
const PREFINAL_PHASES = new Set(["requested", "children-resolved"]);
const CHILD_STATES = new Set<ChildSessionState>([
  "active",
  "completion-proposed",
  "completed",
  "suspended",
  "transferred",
]);
const LIFECYCLE_EVENT_TYPE_SET = new Set<string>(LIFECYCLE_EVENT_TYPES);
const CHILD_PROJECTION_EVENT_TYPES = new Set<string>([
  "SessionForked",
  "SessionCheckpointRecorded",
  "EvidenceCoverageRecorded",
  "ChildAssignmentAmended",
  "ChildWorkReported",
  "ChildWorkDispositioned",
  "ChildCompletionProposed",
  "ChildSessionCompleted",
  "ChildSessionSuspended",
  "ChildWorkTransferCreated",
  "ChildWorkTransferClaimed",
]);
const SESSION_END_PHASES = new Set([
  ...PREFINAL_PHASES,
  ...POST_FINAL_PHASES,
  "cancelled",
  "abandoned",
]);
const SESSION_END_ACTIONS = new Set([
  "mark-children-resolved",
  "record-final-checkpoint-and-queue-ending",
  "confirm-ending-materialization",
  "begin-validation",
  "record-verification-failed",
  "record-verification-passed",
  "invalidate-verification",
  "append-terminal-completion",
  "confirm-completed-materialization",
  "complete-without-materialization",
  "complete-after-materialization",
]);
const EMPTY_COVERAGE: CheckpointEvidenceCoverageV2 = Object.freeze({
  coverageVersion: 2,
  captureMode: "coverage-only",
  contentRetained: false,
  adapterSessions: Object.freeze([]),
});

interface IndexedCheckpoint {
  readonly checkpoint: CheckpointV1;
  readonly eventPosition: string;
}

interface IndexedLifecycleHistory {
  readonly checkpoints: ReadonlyMap<string, IndexedCheckpoint>;
  readonly eventsByPosition: ReadonlyMap<string, LifecycleEventV1>;
  readonly childFoldsByEvent: ReadonlyMap<string, ChildEventFoldProjection>;
  readonly childEventFolds: readonly ChildEventFoldProjection[];
  readonly workflowGenerationFolds: readonly WorkflowGenerationFoldProjection[];
}

interface StageRow {
  readonly workflowId: string;
  readonly sourceGeneration: number;
  readonly sourcePhase: string;
  readonly frozenCheckpointEventPosition: string | null;
  readonly frozenGeneration: number | null;
  readonly evidenceWindowState: "sealed";
  readonly finalEndingScopeBindingsJson: string | null;
}

export interface QualifiedCheckpointMigrationPreflight {
  assertEligibleAndStage(
    connection: SqliteConnection,
    context: ProjectContext,
  ): void;
}

function fail(): never {
  throw new SchemaCompatibilityError(PRECONDITION);
}

function scalarInteger(row: SqliteRow | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== "number" && typeof value !== "bigint") fail();
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) fail();
  return numeric;
}

function positiveInt64Decimal(row: SqliteRow, key: string): string {
  const value = row[key];
  const integer = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : fail();
  if (integer <= 0n || integer > 9_223_372_036_854_775_807n) fail();
  return integer.toString();
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) fail();
  return value;
}

function nullableString(row: SqliteRow, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") fail();
  return value;
}

function parseCanonicalJson(source: string): unknown {
  try {
    const parsed: unknown = JSON.parse(source);
    if (canonicalJson(parsed as never) !== source) fail();
    return parsed;
  } catch (error) {
    if (error instanceof SchemaCompatibilityError) throw error;
    fail();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) fail();
  return value as Record<string, unknown>;
}

function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) fail();
  try {
    if (BigInt(value) < 0n || BigInt(value) > 9_223_372_036_854_775_807n) fail();
  } catch {
    fail();
  }
  return value;
}

function count(connection: SqliteConnection, sql: string): number {
  return scalarInteger(connection.prepare(sql).get(), "count");
}

function tableExists(connection: SqliteConnection, schema: "main" | "temp", name: string): boolean {
  return scalarInteger(connection.prepare(`
    SELECT count(*) AS count FROM ${schema}.sqlite_schema
    WHERE type = 'table' AND name = $name
  `).get({ $name: name }), "count") === 1;
}

function normalizedSql(source: string): string {
  return source.replace(/\s+/g, " ").trim().replace(/^CREATE TEMP TRIGGER /, "CREATE TRIGGER ");
}

function assertStageTriggers(connection: SqliteConnection): void {
  const rows = connection.prepare(`
    SELECT name, tbl_name, sql
    FROM temp.sqlite_schema
    WHERE type = 'trigger' AND name GLOB 'qualified_checkpoint_v3_stage_*'
    ORDER BY name
  `).all();
  if (rows.length !== STAGE_TRIGGER_SPECS.length) fail();
  const byName = new Map(rows.map((row) => [requiredString(row, "name"), row]));
  for (const [name, table, operation] of STAGE_TRIGGER_SPECS) {
    const row = byName.get(name);
    if (row === undefined || row.tbl_name !== table) fail();
    const expected = normalizedSql(
      `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table}
       BEGIN SELECT RAISE(ABORT, '${PRECONDITION}'); END`,
    );
    if (normalizedSql(requiredString(row, "sql")) !== expected) fail();
  }
}

function assertStoreIdentity(
  connection: SqliteConnection,
  context: ProjectContext,
): { projectId: string; vaultId: string; storeId: string } {
  const projectId = context.binding.projectId;
  const vaultId = context.binding.vaultId;
  const storeId = context.binding.storeId;
  if (![projectId, vaultId, storeId].every((value) => typeof value === "string" && value.length > 0)) {
    fail();
  }
  const rows = connection.prepare(`
    SELECT project_id, vault_id, store_id, schema_version FROM project_meta
  `).all();
  if (rows.length !== 1) fail();
  const row = rows[0]!;
  if (
    row.project_id !== projectId
    || row.vault_id !== vaultId
    || row.store_id !== storeId
    || scalarInteger(row, "schema_version") !== 2
  ) fail();
  return { projectId, vaultId, storeId };
}

function assertCoverageEmpty(connection: SqliteConnection): void {
  if (
    count(connection, "SELECT count(*) AS count FROM session_evidence_coverage") !== 0
    || count(connection, "SELECT count(*) AS count FROM session_evidence_fingerprints") !== 0
    || count(connection, `
      SELECT count(*) AS count FROM events
      WHERE stream_type = 'session' AND session_id IS NOT NULL
        AND event_type = 'EvidenceCoverageRecorded'
    `) !== 0
  ) fail();
}

function indexLifecycleHistory(connection: SqliteConnection): IndexedLifecycleHistory {
  const checkpoints = new Map<string, IndexedCheckpoint>();
  const eventsByPosition = new Map<string, LifecycleEventV1>();
  const childFoldsByEvent = new Map<string, ChildEventFoldProjection>();
  const childEventFolds: ChildEventFoldProjection[] = [];
  const workflowGenerationFolds: WorkflowGenerationFoldProjection[] = [];
  const childHeads = new Map<string, ChildEventFoldProjection>();
  const reportWitnesses = new Map<
    string,
    Map<string, ChildEventFoldProjection>
  >();
  const commandIntents = new Map<string, {
    readonly witness: LifecycleIntentWitnessV1;
    readonly sessionId: string;
    readonly streamId: string;
  }>();
  const workflowHeads = new Map<string, WorkflowGenerationFoldProjection>();
  // Trigger type is contextual provenance, not part of the approved row/hash.
  // Preflight must retain it while folding so only a cancelled row can reopen.
  const workflowHeadTriggerTypes = new Map<string, LifecycleEventV1["eventType"]>();
  const workflowIndexes = new Map<string, number>();
  const lifecycleRows = connection.prepare(`
    SELECT global_position, event_id, project_id, vault_id, store_id,
           workspace_id, stream_id, stream_type, stream_version,
           event_type, event_schema_version, session_id, parent_session_id,
           correlation_id, causation_id, command_id, idempotency_key,
           command_event_index, occurred_at, recorded_at, payload_json,
           lifecycle_intent_json
    FROM events
    WHERE stream_type = 'session' AND session_id IS NOT NULL
    ORDER BY global_position
  `).all();
  const authorityCommitments = new Map<string, string>();
  for (const row of lifecycleRows) {
    const eventType = requiredString(row, "event_type");
    const commandEventIndex = scalarInteger(row, "command_event_index");
    const commandKey = `${
      requiredString(row, "project_id")
    }\u0000${requiredString(row, "command_id")}`;
    const indexedIntentSource = nullableString(row, "lifecycle_intent_json");
    if (commandEventIndex === 0 && indexedIntentSource !== null) {
      if (commandIntents.has(commandKey)) fail();
      try {
        commandIntents.set(commandKey, {
          witness: decodeLifecycleIntentWitness(indexedIntentSource),
          sessionId: requiredString(row, "session_id"),
          streamId: requiredString(row, "stream_id"),
        });
      } catch {
        fail();
      }
    }
    if (!LIFECYCLE_EVENT_TYPE_SET.has(eventType)) continue;
    const schemaVersion = scalarInteger(row, "event_schema_version");
    if (schemaVersion !== 1 || eventType === "EvidenceCoverageRecorded") fail();
    const payload = record(parseCanonicalJson(requiredString(row, "payload_json")));
    const streamId = requiredString(row, "stream_id");
    if (typeof payload.authorityCommitment === "string") {
      authorityCommitments.set(streamId, payload.authorityCommitment);
    }
    const authorityCommitment = authorityCommitments.get(streamId);
    if (authorityCommitment === undefined) fail();
    let decoded: LifecycleEventV1;
    try {
      decoded = decodeLifecycleEventV1({
        eventSchemaVersion: schemaVersion,
        eventId: row.event_id,
        projectId: row.project_id,
        vaultId: row.vault_id,
        storeId: row.store_id,
        workspaceId: row.workspace_id,
        streamId,
        streamVersion: positiveInt64Decimal(row, "stream_version"),
        globalPosition: positiveInt64Decimal(row, "global_position"),
        sessionId: row.session_id,
        parentSessionId: row.parent_session_id,
        eventType,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        commandId: row.command_id,
        idempotencyKey: row.idempotency_key,
        occurredAt: row.occurred_at,
        authorityCommitment,
        payload,
      });
    } catch {
      fail();
    }
    const sessionId = requiredString(row, "session_id");
    if (eventsByPosition.has(decoded.globalPosition)) fail();
    eventsByPosition.set(decoded.globalPosition, decoded);

    const globalPosition = BigInt(positiveInt64Decimal(row, "global_position"));
    const streamVersion = BigInt(positiveInt64Decimal(row, "stream_version"));
    const stored = {
      globalPosition,
      eventId: decoded.eventId,
      projectId: decoded.projectId,
      vaultId: decoded.vaultId,
      storeId: decoded.storeId,
      workspaceId: decoded.workspaceId,
      branchScopeId: null,
      branchRef: null,
      streamId: decoded.streamId,
      streamType: "session",
      streamVersion,
      eventType: decoded.eventType,
      eventSchemaVersion: decoded.eventSchemaVersion,
      sessionId: decoded.sessionId,
      parentSessionId: decoded.parentSessionId,
      actorRole: "primary",
      agentId: "migration-preflight",
      clientInstanceId: "migration-preflight",
      correlationId: decoded.correlationId,
      causationId: decoded.causationId,
      commandId: decoded.commandId,
      idempotencyKey: decoded.idempotencyKey,
      commandEventIndex,
      occurredAt: decoded.occurredAt,
      recordedAt: requiredString(row, "recorded_at"),
      visibilityScope: "session",
      confidence: "high",
      verificationStatus: "verified",
      sourceRefs: [],
      evidenceRefs: [],
      evidenceDigests: [],
      payload,
      payloadJson: requiredString(row, "payload_json"),
      payloadHash: "0".repeat(64),
      previousGlobalHash: "0".repeat(64),
      eventHash: "0".repeat(64),
      lifecycleIntentJson: nullableString(row, "lifecycle_intent_json"),
    } as unknown as StoredEvent;

    if (
      decoded.parentSessionId !== null
      && CHILD_PROJECTION_EVENT_TYPES.has(decoded.eventType)
    ) {
      const previous = childHeads.get(decoded.sessionId) ?? null;
      const childReports = reportWitnesses.get(decoded.sessionId)
        ?? new Map<string, ChildEventFoldProjection>();
      let reportId: string | null = null;
      if (decoded.eventType === "ChildCompletionProposed") {
        reportId = decoded.payload.reportId;
      } else if (decoded.eventType === "ChildWorkDispositioned") {
        reportId = decoded.payload.disposition.reportId;
      } else if (decoded.eventType === "ChildSessionCompleted") {
        reportId = decoded.payload.reportId;
      }
      const reportWitness = reportId === null
        ? null
        : childReports.get(reportId) ?? null;
      if (
        decoded.eventType === "ChildWorkReported"
        && childReports.has(decoded.payload.report.reportId)
      ) fail();
      let projection: ChildEventFoldProjection;
      try {
        projection = foldChildEventProjection(previous, stored, reportWitness);
      } catch {
        fail();
      }
      childHeads.set(decoded.sessionId, projection);
      childEventFolds.push(projection);
      childFoldsByEvent.set(
        `${projection.childSessionId}\u0000${projection.eventPosition}`,
        projection,
      );
      if (projection.reportedReportId !== null) {
        childReports.set(projection.reportedReportId, projection);
        reportWitnesses.set(decoded.sessionId, childReports);
      }
    }

    let projectionWorkflowId: string | null = null;
    switch (decoded.eventType) {
      case "SessionEndRequested":
      case "SessionEndAmended":
      case "SessionEndCancelled":
        projectionWorkflowId = decoded.payload.workflowId;
        break;
      case "SessionAbandoned":
        projectionWorkflowId = decoded.payload.workflowId;
        break;
      default:
        break;
    }
    if (projectionWorkflowId !== null) {
      const workflowId = projectionWorkflowId;
      const previous = workflowHeads.get(workflowId) ?? null;
      if (
        decoded.eventType === "SessionEndRequested"
        && previous !== null
        && workflowHeadTriggerTypes.get(workflowId) !== "SessionEndCancelled"
      ) fail();
      const indexedIntent = commandIntents.get(commandKey);
      if (
        indexedIntent === undefined
        || indexedIntent.sessionId !== decoded.sessionId
        || indexedIntent.streamId !== decoded.streamId
      ) fail();
      let projection: WorkflowGenerationFoldProjection;
      try {
        projection = foldWorkflowGenerationProjection(
          previous,
          stored,
          indexedIntent.witness,
          "schema-2-preflight",
        );
      } catch {
        fail();
      }
      const existingIndex = workflowIndexes.get(workflowId);
      const existing = workflowHeads.get(workflowId);
      if (
        existing !== undefined
        && projection.workflowGeneration === existing.workflowGeneration
      ) {
        if (existingIndex === undefined) fail();
        workflowGenerationFolds[existingIndex] = projection;
      } else {
        workflowIndexes.set(workflowId, workflowGenerationFolds.length);
        workflowGenerationFolds.push(projection);
      }
      workflowHeads.set(workflowId, projection);
      workflowHeadTriggerTypes.set(workflowId, decoded.eventType);
    }

    if (eventType === "SessionCheckpointRecorded") {
      const checkpointEvent = decoded as Extract<
        LifecycleEventV1,
        { readonly eventType: "SessionCheckpointRecorded" }
      >;
      const checkpoint = decodeCheckpointV1(checkpointEvent.payload.checkpoint);
      const eventPosition = checkpointEvent.globalPosition;
      const emptyCoverage = (
        checkpoint.evidenceCoverage.highestContiguousOrdinal === null
        && checkpoint.evidenceCoverage.missingIntervals.length === 0
      );
      if (
        checkpointEvent.payload.baseEventPosition !== checkpoint.baseEventPosition
        || checkpointEvent.payload.checkpointEventPosition !== eventPosition
        || checkpoint.checkpointEventPosition !== eventPosition
        || !emptyCoverage
        || checkpoints.has(checkpoint.checkpointId)
      ) fail();
      checkpoints.set(checkpoint.checkpointId, { checkpoint, eventPosition });
    }
  }
  return {
    checkpoints,
    eventsByPosition,
    childFoldsByEvent,
    childEventFolds,
    workflowGenerationFolds: workflowGenerationFolds.sort((left, right) =>
      left.triggerEventPosition < right.triggerEventPosition
        ? -1
        : left.triggerEventPosition > right.triggerEventPosition
          ? 1
          : 0),
  };
}

function eventAt(
  history: IndexedLifecycleHistory,
  projectId: string,
  sessionId: string,
  eventPosition: string,
): LifecycleEventV1 {
  const event = history.eventsByPosition.get(eventPosition);
  if (
    event === undefined
    || event.projectId !== projectId
    || event.sessionId !== sessionId
  ) fail();
  return event;
}

function checkpointPosition(
  checkpoints: ReadonlyMap<string, IndexedCheckpoint>,
  checkpointId: string | null,
  childSessionId: string,
  lastEventPosition: string,
): string | null {
  if (checkpointId === null) return null;
  const indexed = checkpoints.get(checkpointId);
  if (
    indexed === undefined
    || indexed.checkpoint.sessionId !== childSessionId
    || BigInt(indexed.eventPosition) > BigInt(lastEventPosition)
  ) fail();
  return indexed.eventPosition;
}

function bindingForSummary(
  connection: SqliteConnection,
  projectId: string,
  rootSessionId: string,
  history: IndexedLifecycleHistory,
  summaryValue: unknown,
): FinalEndingScopeBindingV1 {
  const summary = record(summaryValue);
  const childSessionId = requiredString(summary as unknown as SqliteRow, "childSessionId");
  const childState = requiredString(summary as unknown as SqliteRow, "state") as ChildSessionState;
  if (!CHILD_STATES.has(childState)) fail();
  const lastEventPosition = decimal(summary.lastEventPosition);
  const streamVersion = decimal(summary.streamVersion);
  const checkpointId = summary.latestCheckpointId === null
    ? null
    : requiredString(summary as unknown as SqliteRow, "latestCheckpointId");
  const checkpointEventPosition = checkpointPosition(
    history.checkpoints,
    checkpointId,
    childSessionId,
    lastEventPosition,
  );
  const event = eventAt(history, projectId, childSessionId, lastEventPosition);
  if (event.streamVersion !== streamVersion) fail();
  const aggregate = history.childFoldsByEvent.get(
    `${childSessionId}\u0000${lastEventPosition}`,
  );
  if (
    aggregate === undefined
    || aggregate.rootSessionId !== rootSessionId
    || aggregate.childState !== childState
    || aggregate.streamVersion !== BigInt(streamVersion)
    || aggregate.latestCheckpointId !== checkpointId
    || aggregate.latestCheckpointEventPosition
      !== (checkpointEventPosition === null ? null : BigInt(checkpointEventPosition))
  ) fail();
  const authorityRows = connection.prepare(`
    SELECT authority.session_kind, authority.parent_session_id,
           authority.semantic_state, authority.authority_event_position,
           authority.latest_checkpoint_id, authority.latest_checkpoint_event_position,
           authority.terminal_event_position, stream.current_version
    FROM session_authority AS authority
    JOIN streams AS stream
      ON stream.project_id = authority.project_id
      AND stream.stream_id = authority.stream_id
    WHERE authority.project_id = $projectId
      AND authority.session_id = $childSessionId
  `).all({ $projectId: projectId, $childSessionId: childSessionId });
  if (authorityRows.length !== 1) fail();
  const authority = authorityRows[0]!;
  if (
    authority.session_kind !== "child"
    || authority.parent_session_id !== rootSessionId
    || authority.semantic_state !== aggregate.childState
    || positiveInt64Decimal(authority, "authority_event_position")
      !== aggregate.eventPosition.toString()
    || nullableString(authority, "latest_checkpoint_id") !== aggregate.latestCheckpointId
    || (authority.latest_checkpoint_event_position === null
      ? null
      : positiveInt64Decimal(authority, "latest_checkpoint_event_position"))
      !== (aggregate.latestCheckpointEventPosition?.toString() ?? null)
    || (authority.terminal_event_position === null
      ? null
      : positiveInt64Decimal(authority, "terminal_event_position"))
      !== (aggregate.terminalEventPosition?.toString() ?? null)
    || positiveInt64Decimal(authority, "current_version") !== aggregate.streamVersion.toString()
  ) fail();

  const tickets = childState === "transferred" && checkpointId !== null
    ? connection.prepare(`
        SELECT ticket.transfer_ticket_id, ticket.created_event_position,
               event.parent_session_id
        FROM child_transfer_tickets AS ticket
        JOIN events AS event
          ON event.global_position = ticket.created_event_position
          AND event.project_id = ticket.project_id
          AND event.session_id = ticket.source_child_session_id
          AND event.event_type = 'ChildWorkTransferCreated'
          AND event.event_schema_version = 1
          AND event.parent_session_id = ticket.source_parent_session_id
          AND json_extract(event.payload_json, '$.transferTicketId') = ticket.transfer_ticket_id
          AND json_extract(event.payload_json, '$.checkpointId') = ticket.checkpoint_id
        WHERE ticket.project_id = $projectId
          AND ticket.source_parent_session_id = $rootSessionId
          AND ticket.source_child_session_id = $childSessionId
          AND ticket.checkpoint_id = $checkpointId
          AND ticket.created_event_position = $lastEventPosition
      `).all({
        $projectId: projectId,
        $rootSessionId: rootSessionId,
        $childSessionId: childSessionId,
        $checkpointId: checkpointId,
        $lastEventPosition: BigInt(lastEventPosition),
      })
    : [];
  if (
    (childState === "transferred" && (checkpointId === null || tickets.length !== 1))
    || (childState !== "transferred" && tickets.length !== 0)
  ) fail();
  const ticket = tickets[0];
  return Object.freeze({
    bindingVersion: 1,
    bindingKind: ticket === undefined ? "current-child" : "carry-forward-ticket",
    childSessionId: childSessionId as FinalEndingScopeBindingV1["childSessionId"],
    childState,
    lastEventPosition,
    streamVersion,
    checkpointId: checkpointId as FinalEndingScopeBindingV1["checkpointId"],
    checkpointEventPosition,
    transferTicketId: ticket === undefined
      ? null
      : requiredString(ticket, "transfer_ticket_id") as FinalEndingScopeBindingV1["transferTicketId"],
    transferTicketEventPosition: ticket === undefined
      ? null
      : positiveInt64Decimal(ticket, "created_event_position"),
  });
}

function bindingsForCheckpoint(
  connection: SqliteConnection,
  projectId: string,
  history: IndexedLifecycleHistory,
  checkpoint: CheckpointV1,
): readonly FinalEndingScopeBindingV1[] {
  const bindings = checkpoint.childSummaries
    .map((summary) => bindingForSummary(
      connection,
      projectId,
      checkpoint.sessionId,
      history,
      summary,
    ))
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.childSessionId, "utf8"),
      Buffer.from(right.childSessionId, "utf8"),
    ));
  try {
    const decoded = decodeFinalEndingScopeBindingsV1(bindings);
    const retainedTickets = connection.prepare(`
      SELECT transfer_ticket_id
      FROM child_transfer_tickets
      WHERE project_id = $projectId
        AND source_parent_session_id = $rootSessionId
        AND created_event_position <= $checkpointEventPosition
        AND claimed_event_position IS NULL
      ORDER BY transfer_ticket_id
    `).all({
      $projectId: projectId,
      $rootSessionId: checkpoint.sessionId,
      $checkpointEventPosition: BigInt(checkpoint.checkpointEventPosition),
    });
    const boundTicketIds = decoded
      .filter((binding) => binding.bindingKind === "carry-forward-ticket")
      .map((binding) => binding.transferTicketId)
      .sort();
    if (
      retainedTickets.length !== boundTicketIds.length
      || retainedTickets.some(
        (ticket, index) => requiredString(ticket, "transfer_ticket_id") !== boundTicketIds[index],
      )
    ) fail();
    return decoded;
  } catch {
    fail();
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
}

function workflowResultStatus(source: string): Record<string, unknown> {
  const result = record(parseCanonicalJson(source));
  let status = result;
  if ("status" in result) {
    exactKeys(result, ["resultVersion", "action", "progressed", "previousPhase", "status"]);
    if (
      result.resultVersion !== 2
      || typeof result.action !== "string"
      || !SESSION_END_ACTIONS.has(result.action)
      || typeof result.progressed !== "boolean"
      || typeof result.previousPhase !== "string"
      || !SESSION_END_PHASES.has(result.previousPhase)
    ) fail();
    status = record(result.status);
  }
  exactKeys(status, [
    "resultVersion", "sessionId", "workflowId", "workflowGeneration", "phase",
    "priorRootState", "triggeringEventPosition", "finalCheckpointId",
    "finalCheckpointEventPosition", "evidenceWindow", "validationPlansReady",
    "qualityScore", "safeFailureCode", "materializationRequired",
  ]);
  const window = record(status.evidenceWindow);
  exactKeys(window, [
    "evidenceWindowState", "evidenceFrozenCheckpointEventPosition",
    "evidenceFrozenGeneration",
  ]);
  if (
    status.resultVersion !== 2
    || typeof status.sessionId !== "string"
    || typeof status.workflowId !== "string"
    || typeof status.workflowGeneration !== "number"
    || !Number.isSafeInteger(status.workflowGeneration)
    || status.workflowGeneration <= 0
    || typeof status.phase !== "string"
    || !SESSION_END_PHASES.has(status.phase)
    || (status.priorRootState !== "active" && status.priorRootState !== "suspended")
    || decimal(status.triggeringEventPosition) === "0"
    || (status.finalCheckpointId !== null && typeof status.finalCheckpointId !== "string")
    || (status.finalCheckpointEventPosition !== null
      && decimal(status.finalCheckpointEventPosition) === "0")
    || (status.finalCheckpointId === null) !== (status.finalCheckpointEventPosition === null)
    || (window.evidenceWindowState !== "open" && window.evidenceWindowState !== "sealed")
    || (window.evidenceFrozenCheckpointEventPosition !== null
      && decimal(window.evidenceFrozenCheckpointEventPosition) === "0")
    || (window.evidenceFrozenGeneration !== null
      && (typeof window.evidenceFrozenGeneration !== "number"
        || !Number.isSafeInteger(window.evidenceFrozenGeneration)
        || window.evidenceFrozenGeneration <= 0))
    || (window.evidenceFrozenCheckpointEventPosition === null)
      !== (window.evidenceFrozenGeneration === null)
    || typeof status.validationPlansReady !== "boolean"
    || (status.qualityScore !== null
      && (typeof status.qualityScore !== "number" || !Number.isFinite(status.qualityScore)))
    || (status.safeFailureCode !== null && typeof status.safeFailureCode !== "string")
    || typeof status.materializationRequired !== "boolean"
  ) fail();
  return status;
}

function finalForWorkflow(
  connection: SqliteConnection,
  projectId: string,
  history: IndexedLifecycleHistory,
  row: SqliteRow,
): { eventPosition: string; bindings: readonly FinalEndingScopeBindingV1[] } | null {
  const source = nullableString(row, "result_json");
  if (source === null) return null;
  const status = workflowResultStatus(source);
  const generation = scalarInteger(row, "generation");
  const window = record(status.evidenceWindow);
  if (
    status.sessionId !== row.session_id
    || status.workflowId !== row.workflow_id
    || status.workflowGeneration !== generation
    || status.phase !== row.phase
    || status.triggeringEventPosition
      !== positiveInt64Decimal(row, "triggering_event_position")
    || window.evidenceWindowState !== "sealed"
  ) fail();
  const finalCheckpointId = status.finalCheckpointId;
  if (finalCheckpointId === null || finalCheckpointId === undefined) {
    if (
      status.finalCheckpointEventPosition !== null
      || window.evidenceFrozenCheckpointEventPosition !== null
      || window.evidenceFrozenGeneration !== null
    ) fail();
    return null;
  }
  if (typeof finalCheckpointId !== "string") fail();
  const indexed = history.checkpoints.get(finalCheckpointId);
  if (indexed === undefined || indexed.checkpoint.sessionId !== row.session_id) fail();
  if (
    status.finalCheckpointEventPosition !== indexed.eventPosition
  ) fail();
  if (
    window.evidenceFrozenCheckpointEventPosition !== indexed.eventPosition
    || window.evidenceFrozenGeneration !== generation
  ) fail();
  eventAt(history, projectId, requiredString(row, "session_id"), indexed.eventPosition);
  return {
    eventPosition: indexed.eventPosition,
    bindings: bindingsForCheckpoint(connection, projectId, history, indexed.checkpoint),
  };
}

function assertCapacity(bindings: readonly FinalEndingScopeBindingV1[]): void {
  if (
    minimumCheckpointUpperBound({
      evidenceCoverage: EMPTY_COVERAGE,
      endingScopeBindings: bindings,
    }) > CHECKPOINT_MAX_CANONICAL_BYTES
    || minimumFinalEndingScopeBindingsUpperBound({ endingScopeBindings: bindings })
      > FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES
  ) fail();
}

function stageRows(
  connection: SqliteConnection,
  projectId: string,
  history: IndexedLifecycleHistory,
): StageRow[] {
  const result: StageRow[] = [];
  const workflows = connection.prepare(`
    SELECT workflow_id, workflow_type, generation, state, phase, session_id,
           triggering_event_position, result_json
    FROM workflow_instances
    WHERE session_id IS NOT NULL
    ORDER BY workflow_id
  `).all();
  for (const row of workflows) {
    const workflowId = requiredString(row, "workflow_id");
    const phase = requiredString(row, "phase");
    const generation = scalarInteger(row, "generation");
    if (
      row.workflow_type !== "session-end"
      || row.session_id === null
      || generation <= 0
      || (!PREFINAL_PHASES.has(phase)
        && !POST_FINAL_PHASES.has(phase)
        && phase !== "cancelled"
        && phase !== "abandoned")
    ) fail();
    const final = finalForWorkflow(connection, projectId, history, row);
    const requiresFinal = POST_FINAL_PHASES.has(phase);
    if (requiresFinal && final === null) fail();
    if (PREFINAL_PHASES.has(phase) && final !== null) fail();
    if (phase === "abandoned" && final === null) {
      // Abandonment before a final checkpoint intentionally remains unfrozen.
    } else if (phase !== "cancelled" && final !== null) {
      assertCapacity(final.bindings);
    }
    result.push({
      workflowId,
      sourceGeneration: generation,
      sourcePhase: phase,
      frozenCheckpointEventPosition: phase === "cancelled" ? null : final?.eventPosition ?? null,
      frozenGeneration: phase === "cancelled" ? null : final === null ? null : generation,
      evidenceWindowState: "sealed",
      finalEndingScopeBindingsJson: phase === "cancelled" || final === null
        ? null
        : canonicalJson(final.bindings),
    });
  }
  return result;
}

function assertWorkflowProjectionCoverage(
  connection: SqliteConnection,
  history: IndexedLifecycleHistory,
): void {
  const workflows = connection.prepare(`
    SELECT workflow_id, generation, session_id, root_command_id,
           triggering_event_position
    FROM workflow_instances
    WHERE session_id IS NOT NULL
    ORDER BY workflow_id
  `).all();
  const heads = new Map<string, WorkflowGenerationFoldProjection>();
  for (const projection of history.workflowGenerationFolds) {
    const current = heads.get(projection.workflowId);
    if (
      current === undefined
        ? projection.workflowGeneration !== 1
        : projection.workflowGeneration !== current.workflowGeneration + 1
    ) fail();
    heads.set(projection.workflowId, projection);
  }
  if (heads.size !== workflows.length) fail();
  for (const workflow of workflows) {
    const workflowId = requiredString(workflow, "workflow_id");
    const head = heads.get(workflowId);
    if (
      head === undefined
      || head.sessionId !== requiredString(workflow, "session_id")
      || head.workflowGeneration !== scalarInteger(workflow, "generation")
      || head.rootCommandId !== requiredString(workflow, "root_command_id")
      || head.triggerEventPosition.toString()
        !== positiveInt64Decimal(workflow, "triggering_event_position")
    ) fail();
  }
}

function assertEveryLiveRootCapacity(
  connection: SqliteConnection,
  projectId: string,
  history: IndexedLifecycleHistory,
): void {
  const roots = connection.prepare(`
    SELECT session_id FROM session_authority
    WHERE project_id = $projectId AND session_kind = 'root'
      AND terminal_event_position IS NULL
    ORDER BY session_id
  `).all({ $projectId: projectId });
  for (const root of roots) {
    const children = connection.prepare(`
      SELECT child.session_id AS child_session_id, child.semantic_state,
             coalesce(child.terminal_event_position, child.authority_event_position) AS last_event_position,
             stream.current_version AS stream_version, child.latest_checkpoint_id
      FROM session_authority AS child
      JOIN streams AS stream
        ON stream.project_id = child.project_id AND stream.stream_id = child.stream_id
      WHERE child.project_id = $projectId AND child.parent_session_id = $rootSessionId
        AND child.semantic_state <> 'transferred'
      ORDER BY child.session_id
    `).all({
      $projectId: projectId,
      $rootSessionId: requiredString(root, "session_id"),
    });
    const bindings = children.map((child) => bindingForSummary(
      connection,
      projectId,
      requiredString(root, "session_id"),
      history,
      {
        childSessionId: child.child_session_id,
        state: child.semantic_state,
        lastEventPosition: String(child.last_event_position),
        streamVersion: String(child.stream_version),
        latestCheckpointId: child.latest_checkpoint_id,
      },
    ));
    const tickets = connection.prepare(`
      SELECT ticket.transfer_ticket_id, ticket.source_child_session_id,
             ticket.checkpoint_id, ticket.created_event_position,
             event.stream_version
      FROM child_transfer_tickets AS ticket
      JOIN events AS event
        ON event.project_id = ticket.project_id
        AND event.global_position = ticket.created_event_position
        AND event.session_id = ticket.source_child_session_id
        AND event.event_type = 'ChildWorkTransferCreated'
        AND event.event_schema_version = 1
        AND event.parent_session_id = ticket.source_parent_session_id
        AND json_extract(event.payload_json, '$.transferTicketId') = ticket.transfer_ticket_id
        AND json_extract(event.payload_json, '$.checkpointId') = ticket.checkpoint_id
      JOIN session_authority AS child
        ON child.project_id = ticket.project_id
        AND child.session_id = ticket.source_child_session_id
        AND child.session_kind = 'child'
        AND child.parent_session_id = ticket.source_parent_session_id
        AND child.semantic_state = 'transferred'
        AND child.terminal_event_position = ticket.created_event_position
        AND child.latest_checkpoint_id = ticket.checkpoint_id
      JOIN streams AS stream
        ON stream.project_id = child.project_id
        AND stream.stream_id = child.stream_id
        AND stream.current_version = event.stream_version
      WHERE ticket.project_id = $projectId
        AND ticket.source_parent_session_id = $rootSessionId
      ORDER BY ticket.source_child_session_id, ticket.created_event_position
    `).all({
      $projectId: projectId,
      $rootSessionId: requiredString(root, "session_id"),
    });
    for (const ticket of tickets) {
      const childSessionId = requiredString(ticket, "source_child_session_id");
      const checkpointId = requiredString(ticket, "checkpoint_id");
      const eventPosition = positiveInt64Decimal(ticket, "created_event_position");
      const checkpointEventPosition = checkpointPosition(
        history.checkpoints,
        checkpointId,
        childSessionId,
        eventPosition,
      );
      if (checkpointEventPosition === null) fail();
      bindings.push(Object.freeze({
        bindingVersion: 1,
        bindingKind: "carry-forward-ticket",
        childSessionId: childSessionId as FinalEndingScopeBindingV1["childSessionId"],
        childState: "transferred",
        lastEventPosition: eventPosition,
        streamVersion: positiveInt64Decimal(ticket, "stream_version"),
        checkpointId: checkpointId as FinalEndingScopeBindingV1["checkpointId"],
        checkpointEventPosition,
        transferTicketId: requiredString(
          ticket,
          "transfer_ticket_id",
        ) as FinalEndingScopeBindingV1["transferTicketId"],
        transferTicketEventPosition: eventPosition,
      }));
    }
    assertCapacity(bindings);
  }
}

function dropStage(connection: SqliteConnection): void {
  for (const [name] of STAGE_TRIGGER_SPECS) {
    connection.exec(`DROP TRIGGER IF EXISTS temp.${name}`);
  }
  connection.exec(`
    DROP TABLE IF EXISTS temp.${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE};
    DROP TABLE IF EXISTS temp.${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE};
    DROP TABLE IF EXISTS temp.${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE};
    DROP TABLE IF EXISTS temp.${QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE};
  `);
}

function createStage(
  connection: SqliteConnection,
  identity: { projectId: string; vaultId: string; storeId: string },
  rows: readonly StageRow[],
  childEventFolds: readonly ChildEventFoldProjection[],
  workflowGenerationFolds: readonly WorkflowGenerationFoldProjection[],
): void {
  if (
    tableExists(connection, "temp", QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE)
    || tableExists(connection, "temp", QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE)
    || tableExists(
      connection,
      "temp",
      QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE,
    )
    || tableExists(
      connection,
      "temp",
      QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE,
    )
  ) fail();
  try {
    connection.exec(`
      CREATE TEMP TABLE ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE} (
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
      CREATE TEMP TABLE ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE} (
        project_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        event_position INTEGER NOT NULL CHECK (event_position > 0),
        stream_version INTEGER NOT NULL CHECK (stream_version > 0),
        root_session_id TEXT NOT NULL,
        child_state TEXT NOT NULL CHECK (child_state IN (
          'active', 'completion-proposed', 'completed', 'suspended', 'transferred'
        )),
        latest_checkpoint_id TEXT,
        latest_checkpoint_event_position INTEGER CHECK (
          latest_checkpoint_event_position IS NULL
          OR latest_checkpoint_event_position > 0
        ),
        authority_commitment TEXT NOT NULL CHECK (
          length(authority_commitment) = 64
          AND authority_commitment NOT GLOB '*[^0-9a-f]*'
        ),
        terminal_event_type TEXT CHECK (
          terminal_event_type IS NULL
          OR terminal_event_type IN (
            'ChildSessionCompleted', 'ChildWorkTransferCreated'
          )
        ),
        terminal_event_position INTEGER CHECK (
          terminal_event_position IS NULL OR terminal_event_position > 0
        ),
        report_count INTEGER NOT NULL CHECK (report_count BETWEEN 0 AND 200),
        latest_report_id TEXT,
        report_index_fingerprint TEXT NOT NULL CHECK (
          length(report_index_fingerprint) = 64
          AND report_index_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        completion_report_id TEXT,
        reported_report_id TEXT,
        reported_item_count INTEGER CHECK (
          reported_item_count IS NULL OR reported_item_count BETWEEN 0 AND 200
        ),
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
          length(fingerprint) = 64
          AND fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        PRIMARY KEY (project_id, child_session_id, event_position),
        UNIQUE (project_id, child_session_id, stream_version),
        CHECK (
          (latest_checkpoint_id IS NULL)
            = (latest_checkpoint_event_position IS NULL)
        ),
        CHECK ((terminal_event_type IS NULL) = (terminal_event_position IS NULL)),
        CHECK ((report_count = 0) = (latest_report_id IS NULL)),
        CHECK (
          (reported_report_id IS NULL) = (reported_item_count IS NULL)
          AND (reported_report_id IS NULL)
            = (reported_item_set_fingerprint IS NULL)
        ),
        CHECK (completion_report_id IS NULL OR report_count > 0),
        CHECK (
          (child_state = 'completed'
            AND terminal_event_type IS 'ChildSessionCompleted')
          OR (child_state = 'transferred'
            AND terminal_event_type IS 'ChildWorkTransferCreated')
          OR (child_state IN ('active', 'completion-proposed', 'suspended')
            AND terminal_event_type IS NULL)
        ),
        CHECK (
          terminal_event_position IS NULL
          OR terminal_event_position <= event_position
        ),
        CHECK (
          latest_checkpoint_event_position IS NULL
          OR latest_checkpoint_event_position <= event_position
        )
      ) STRICT;
      CREATE TEMP TABLE ${QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE} (
        project_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_generation INTEGER NOT NULL CHECK (workflow_generation > 0),
        session_id TEXT NOT NULL,
        trigger_event_position INTEGER NOT NULL CHECK (trigger_event_position > 0),
        root_command_id TEXT NOT NULL,
        evidence_window_state TEXT NOT NULL CHECK (
          evidence_window_state IN ('open', 'sealed')
        ),
        replacement_checkpoint_version INTEGER CHECK (
          replacement_checkpoint_version IS NULL
          OR replacement_checkpoint_version IN (1, 2)
        ),
        effective_checkpoint_version INTEGER NOT NULL CHECK (
          effective_checkpoint_version IN (1, 2)
        ),
        effective_draft_source_event_position INTEGER NOT NULL CHECK (
          effective_draft_source_event_position > 0
        ),
        previous_fingerprint TEXT CHECK (
          previous_fingerprint IS NULL
          OR (
            length(previous_fingerprint) = 64
            AND previous_fingerprint NOT GLOB '*[^0-9a-f]*'
          )
        ),
        fingerprint TEXT NOT NULL CHECK (
          length(fingerprint) = 64
          AND fingerprint NOT GLOB '*[^0-9a-f]*'
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
        CHECK (
          effective_draft_source_event_position <= trigger_event_position
        )
      ) STRICT;
      CREATE UNIQUE INDEX qualified_checkpoint_v3_stage_child_event_folds_report_witness
      ON ${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}(
        project_id, child_session_id, reported_report_id
      ) WHERE reported_report_id IS NOT NULL;
      CREATE TEMP TABLE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE} (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        project_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        source_schema_version INTEGER NOT NULL CHECK (source_schema_version = 2),
        target_schema_version INTEGER NOT NULL CHECK (target_schema_version = 3),
        freeze_row_count INTEGER NOT NULL CHECK (freeze_row_count >= 0),
        child_fold_row_count INTEGER NOT NULL CHECK (child_fold_row_count >= 0),
        workflow_generation_row_count INTEGER NOT NULL CHECK (
          workflow_generation_row_count >= 0
        ),
        sealed INTEGER NOT NULL CHECK (sealed = 1)
      ) STRICT;
    `);
    const insertRow = connection.prepare(`
      INSERT INTO temp.${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}(
        workflow_id, source_generation, source_phase,
        evidence_frozen_checkpoint_event_position, evidence_frozen_generation,
        evidence_window_state, final_ending_scope_bindings_json
      ) VALUES (
        $workflowId, $sourceGeneration, $sourcePhase,
        $frozenPosition, $frozenGeneration, 'sealed', $bindingsJson
      )
    `);
    for (const row of rows) {
      insertRow.run({
        $workflowId: row.workflowId,
        $sourceGeneration: row.sourceGeneration,
        $sourcePhase: row.sourcePhase,
        $frozenPosition: row.frozenCheckpointEventPosition === null
          ? null
          : BigInt(row.frozenCheckpointEventPosition),
        $frozenGeneration: row.frozenGeneration,
        $bindingsJson: row.finalEndingScopeBindingsJson,
      });
    }
    const insertChildFold = connection.prepare(`
      INSERT INTO temp.${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}(
        project_id, child_session_id, event_position, stream_version,
        root_session_id, child_state, latest_checkpoint_id,
        latest_checkpoint_event_position, authority_commitment,
        terminal_event_type, terminal_event_position, report_count,
        latest_report_id, report_index_fingerprint, completion_report_id,
        reported_report_id, reported_item_count,
        reported_item_set_fingerprint, previous_fingerprint, fingerprint
      ) VALUES (
        $projectId, $childSessionId, $eventPosition, $streamVersion,
        $rootSessionId, $childState, $latestCheckpointId,
        $latestCheckpointEventPosition, $authorityCommitment,
        $terminalEventType, $terminalEventPosition, $reportCount,
        $latestReportId, $reportIndexFingerprint, $completionReportId,
        $reportedReportId, $reportedItemCount,
        $reportedItemSetFingerprint, $previousFingerprint, $fingerprint
      )
    `);
    for (const row of childEventFolds) {
      insertChildFold.run({
        $projectId: row.projectId,
        $childSessionId: row.childSessionId,
        $eventPosition: row.eventPosition,
        $streamVersion: row.streamVersion,
        $rootSessionId: row.rootSessionId,
        $childState: row.childState,
        $latestCheckpointId: row.latestCheckpointId,
        $latestCheckpointEventPosition: row.latestCheckpointEventPosition,
        $authorityCommitment: row.authorityCommitment,
        $terminalEventType: row.terminalEventType,
        $terminalEventPosition: row.terminalEventPosition,
        $reportCount: row.reportCount,
        $latestReportId: row.latestReportId,
        $reportIndexFingerprint: row.reportIndexFingerprint,
        $completionReportId: row.completionReportId,
        $reportedReportId: row.reportedReportId,
        $reportedItemCount: row.reportedItemCount,
        $reportedItemSetFingerprint: row.reportedItemSetFingerprint,
        $previousFingerprint: row.previousFingerprint,
        $fingerprint: row.fingerprint,
      });
    }
    const insertWorkflowFold = connection.prepare(`
      INSERT INTO temp.${QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE}(
        project_id, workflow_id, workflow_generation, session_id,
        trigger_event_position, root_command_id, evidence_window_state,
        replacement_checkpoint_version, effective_checkpoint_version,
        effective_draft_source_event_position, previous_fingerprint, fingerprint
      ) VALUES (
        $projectId, $workflowId, $workflowGeneration, $sessionId,
        $triggerEventPosition, $rootCommandId, $evidenceWindowState,
        $replacementCheckpointVersion, $effectiveCheckpointVersion,
        $effectiveDraftSourceEventPosition, $previousFingerprint, $fingerprint
      )
    `);
    for (const row of workflowGenerationFolds) {
      insertWorkflowFold.run({
        $projectId: row.projectId,
        $workflowId: row.workflowId,
        $workflowGeneration: row.workflowGeneration,
        $sessionId: row.sessionId,
        $triggerEventPosition: row.triggerEventPosition,
        $rootCommandId: row.rootCommandId,
        $evidenceWindowState: row.evidenceWindowState,
        $replacementCheckpointVersion: row.replacementCheckpointVersion,
        $effectiveCheckpointVersion: row.effectiveCheckpointVersion,
        $effectiveDraftSourceEventPosition:
          row.effectiveDraftSourceEventPosition,
        $previousFingerprint: row.previousFingerprint,
        $fingerprint: row.fingerprint,
      });
    }
    connection.prepare(`
      INSERT INTO temp.${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}(
        singleton, project_id, vault_id, store_id, source_schema_version,
        target_schema_version, freeze_row_count, child_fold_row_count,
        workflow_generation_row_count, sealed
      ) VALUES (
        1, $projectId, $vaultId, $storeId, 2, 3, $freezeRowCount,
        $childFoldRowCount, $workflowGenerationRowCount, 1
      )
    `).run({
      $projectId: identity.projectId,
      $vaultId: identity.vaultId,
      $storeId: identity.storeId,
      $freezeRowCount: rows.length,
      $childFoldRowCount: childEventFolds.length,
      $workflowGenerationRowCount: workflowGenerationFolds.length,
    });
    for (const [name, table, operation] of STAGE_TRIGGER_SPECS) {
      connection.exec(`
        CREATE TEMP TRIGGER ${name}
        BEFORE ${operation} ON ${table}
        BEGIN SELECT RAISE(ABORT, '${PRECONDITION}'); END
      `);
    }
  } catch (error) {
    try { dropStage(connection); } catch { /* rollback remains authoritative */ }
    const normalized = qualifiedCheckpointMigrationFailure(error);
    throw normalized ?? error;
  }
}

export function qualifiedCheckpointMigrationFailure(
  error: unknown,
): SchemaCompatibilityError | undefined {
  if (
    error instanceof SchemaCompatibilityError
    && error.code === PRECONDITION
  ) return error;
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

function nullablePositiveInt64(row: SqliteRow, key: string): bigint | null {
  return row[key] === null ? null : BigInt(positiveInt64Decimal(row, key));
}

function assertChildFoldStageRows(
  connection: SqliteConnection,
  expected: readonly ChildEventFoldProjection[],
): void {
  const actual = connection.prepare(`
    SELECT project_id, child_session_id, event_position, stream_version,
           root_session_id, child_state, latest_checkpoint_id,
           latest_checkpoint_event_position, authority_commitment,
           terminal_event_type, terminal_event_position, report_count,
           latest_report_id, report_index_fingerprint, completion_report_id,
           reported_report_id, reported_item_count,
           reported_item_set_fingerprint, previous_fingerprint, fingerprint
    FROM temp.${QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE}
    ORDER BY event_position
  `).all();
  if (actual.length !== expected.length) fail();
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index]!;
    const observed = actual[index]!;
    if (
      requiredString(observed, "project_id") !== wanted.projectId
      || requiredString(observed, "child_session_id") !== wanted.childSessionId
      || BigInt(positiveInt64Decimal(observed, "event_position"))
        !== wanted.eventPosition
      || BigInt(positiveInt64Decimal(observed, "stream_version"))
        !== wanted.streamVersion
      || requiredString(observed, "root_session_id") !== wanted.rootSessionId
      || requiredString(observed, "child_state") !== wanted.childState
      || nullableString(observed, "latest_checkpoint_id")
        !== wanted.latestCheckpointId
      || nullablePositiveInt64(observed, "latest_checkpoint_event_position")
        !== wanted.latestCheckpointEventPosition
      || requiredString(observed, "authority_commitment")
        !== wanted.authorityCommitment
      || nullableString(observed, "terminal_event_type")
        !== wanted.terminalEventType
      || nullablePositiveInt64(observed, "terminal_event_position")
        !== wanted.terminalEventPosition
      || scalarInteger(observed, "report_count") !== wanted.reportCount
      || nullableString(observed, "latest_report_id") !== wanted.latestReportId
      || requiredString(observed, "report_index_fingerprint")
        !== wanted.reportIndexFingerprint
      || nullableString(observed, "completion_report_id")
        !== wanted.completionReportId
      || nullableString(observed, "reported_report_id")
        !== wanted.reportedReportId
      || (
        observed.reported_item_count === null
          ? null
          : scalarInteger(observed, "reported_item_count")
      ) !== wanted.reportedItemCount
      || nullableString(observed, "reported_item_set_fingerprint")
        !== wanted.reportedItemSetFingerprint
      || nullableString(observed, "previous_fingerprint")
        !== wanted.previousFingerprint
      || requiredString(observed, "fingerprint") !== wanted.fingerprint
    ) fail();
  }
}

function assertWorkflowFoldStageRows(
  connection: SqliteConnection,
  expected: readonly WorkflowGenerationFoldProjection[],
): void {
  const actual = connection.prepare(`
    SELECT project_id, workflow_id, workflow_generation, session_id,
           trigger_event_position, root_command_id, evidence_window_state,
           replacement_checkpoint_version, effective_checkpoint_version,
           effective_draft_source_event_position, previous_fingerprint, fingerprint
    FROM temp.${QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE}
    ORDER BY trigger_event_position
  `).all();
  if (actual.length !== expected.length) fail();
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index]!;
    const observed = actual[index]!;
    if (
      requiredString(observed, "project_id") !== wanted.projectId
      || requiredString(observed, "workflow_id") !== wanted.workflowId
      || scalarInteger(observed, "workflow_generation")
        !== wanted.workflowGeneration
      || requiredString(observed, "session_id") !== wanted.sessionId
      || BigInt(positiveInt64Decimal(observed, "trigger_event_position"))
        !== wanted.triggerEventPosition
      || requiredString(observed, "root_command_id") !== wanted.rootCommandId
      || requiredString(observed, "evidence_window_state")
        !== wanted.evidenceWindowState
      || (
        observed.replacement_checkpoint_version === null
          ? null
          : scalarInteger(observed, "replacement_checkpoint_version")
      ) !== wanted.replacementCheckpointVersion
      || scalarInteger(observed, "effective_checkpoint_version")
        !== wanted.effectiveCheckpointVersion
      || BigInt(positiveInt64Decimal(
        observed,
        "effective_draft_source_event_position",
      )) !== wanted.effectiveDraftSourceEventPosition
      || nullableString(observed, "previous_fingerprint")
        !== wanted.previousFingerprint
      || requiredString(observed, "fingerprint") !== wanted.fingerprint
    ) fail();
  }
}

export function assertQualifiedCheckpointMigrationStage(
  connection: SqliteConnection,
): void {
  try {
    if (
      !tableExists(connection, "temp", QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE)
      || !tableExists(connection, "temp", QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE)
      || !tableExists(
        connection,
        "temp",
        QUALIFIED_CHECKPOINT_STAGE_CHILD_EVENT_FOLDS_TABLE,
      )
      || !tableExists(
        connection,
        "temp",
        QUALIFIED_CHECKPOINT_STAGE_WORKFLOW_GENERATION_FOLDS_TABLE,
      )
    ) fail();
    const markers = connection.prepare(`
      SELECT singleton, project_id, vault_id, store_id, source_schema_version,
             target_schema_version, freeze_row_count, child_fold_row_count,
             workflow_generation_row_count, sealed
      FROM temp.${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
    `).all();
    if (markers.length !== 1) fail();
    const marker = markers[0]!;
    const markerIdentity = {
      projectId: requiredString(marker, "project_id"),
      vaultId: requiredString(marker, "vault_id"),
      storeId: requiredString(marker, "store_id"),
    };
    if (
      scalarInteger(marker, "singleton") !== 1
      || scalarInteger(marker, "source_schema_version") !== 2
      || scalarInteger(marker, "target_schema_version") !== 3
      || scalarInteger(marker, "sealed") !== 1
    ) fail();
    const identity = assertStoreIdentity(connection, {
      binding: markerIdentity,
    } as ProjectContext);
    assertCoverageEmpty(connection);
    const history = indexLifecycleHistory(connection);
    assertWorkflowProjectionCoverage(connection, history);
    assertEveryLiveRootCapacity(connection, identity.projectId, history);
    const expected = stageRows(connection, identity.projectId, history);
    const actual = connection.prepare(`
      SELECT workflow_id, source_generation, source_phase,
             evidence_frozen_checkpoint_event_position, evidence_frozen_generation,
             evidence_window_state, final_ending_scope_bindings_json
      FROM temp.${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
      ORDER BY workflow_id
    `).all();
    if (
      scalarInteger(marker, "freeze_row_count") !== expected.length
      || actual.length !== expected.length
      || scalarInteger(marker, "child_fold_row_count")
        !== history.childEventFolds.length
      || scalarInteger(marker, "workflow_generation_row_count")
        !== history.workflowGenerationFolds.length
    ) fail();
    for (let index = 0; index < expected.length; index += 1) {
      const wanted = expected[index]!;
      const observed = actual[index]!;
      const frozenPosition = observed.evidence_frozen_checkpoint_event_position === null
        ? null
        : positiveInt64Decimal(observed, "evidence_frozen_checkpoint_event_position");
      const frozenGeneration = observed.evidence_frozen_generation === null
        ? null
        : scalarInteger(observed, "evidence_frozen_generation");
      if (
        requiredString(observed, "workflow_id") !== wanted.workflowId
        || scalarInteger(observed, "source_generation") !== wanted.sourceGeneration
        || requiredString(observed, "source_phase") !== wanted.sourcePhase
        || frozenPosition !== wanted.frozenCheckpointEventPosition
        || frozenGeneration !== wanted.frozenGeneration
        || requiredString(observed, "evidence_window_state") !== wanted.evidenceWindowState
        || nullableString(observed, "final_ending_scope_bindings_json")
          !== wanted.finalEndingScopeBindingsJson
      ) fail();
    }
    assertChildFoldStageRows(connection, history.childEventFolds);
    assertWorkflowFoldStageRows(connection, history.workflowGenerationFolds);
    assertStageTriggers(connection);
  } catch (error) {
    const normalized = qualifiedCheckpointMigrationFailure(error);
    if (normalized !== undefined) throw normalized;
    throw error;
  }
}

export class SqliteQualifiedCheckpointMigrationPreflight
implements QualifiedCheckpointMigrationPreflight {
  assertEligibleAndStage(
    connection: SqliteConnection,
    context: ProjectContext,
  ): void {
    try {
      const identity = assertStoreIdentity(connection, context);
      assertCoverageEmpty(connection);
      const history = indexLifecycleHistory(connection);
      assertWorkflowProjectionCoverage(connection, history);
      assertEveryLiveRootCapacity(connection, identity.projectId, history);
      const rows = stageRows(connection, identity.projectId, history);
      createStage(
        connection,
        identity,
        rows,
        history.childEventFolds,
        history.workflowGenerationFolds,
      );
    } catch (error) {
      const normalized = qualifiedCheckpointMigrationFailure(error);
      if (normalized !== undefined) throw normalized;
      throw error;
    }
  }
}
