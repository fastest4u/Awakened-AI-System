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
import {
  decodeFinalEndingScopeBindingsV1,
  FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES,
  type FinalEndingScopeBindingV1,
} from "../lifecycle/contracts/session-end.js";
import {
  minimumCheckpointUpperBound,
  minimumFinalEndingScopeBindingsUpperBound,
} from "../lifecycle/checkpoint-capacity.js";
import { foldSession, type SessionAggregateState } from "../lifecycle/session-aggregate.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { SchemaCompatibilityError } from "./schema-compatibility.js";
import type { SqliteConnection, SqliteRow } from "./sqlite-driver.js";

export const QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE =
  "qualified_checkpoint_v3_stage_marker";
export const QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE =
  "qualified_checkpoint_v3_stage_rows";

const PRECONDITION = "MIGRATION_EVIDENCE_V2_PRECONDITION_FAILED" as const;
const STAGE_TRIGGER_SPECS = Object.freeze([
  ["qualified_checkpoint_v3_stage_marker_no_insert", QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE, "INSERT"],
  ["qualified_checkpoint_v3_stage_marker_no_update", QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE, "UPDATE"],
  ["qualified_checkpoint_v3_stage_marker_no_delete", QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE, "DELETE"],
  ["qualified_checkpoint_v3_stage_rows_no_insert", QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE, "INSERT"],
  ["qualified_checkpoint_v3_stage_rows_no_update", QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE, "UPDATE"],
  ["qualified_checkpoint_v3_stage_rows_no_delete", QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE, "DELETE"],
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
  readonly eventsBySession: ReadonlyMap<string, readonly LifecycleEventV1[]>;
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
  const eventsBySession = new Map<string, LifecycleEventV1[]>();
  const lifecycleRows = connection.prepare(`
    SELECT global_position, event_id, project_id, vault_id, store_id,
           workspace_id, stream_id, stream_type, stream_version,
           event_type, event_schema_version, session_id, parent_session_id,
           correlation_id, causation_id, command_id, idempotency_key,
           occurred_at, payload_json
    FROM events
    WHERE stream_type = 'session' AND session_id IS NOT NULL
    ORDER BY stream_id, stream_version
  `).all();
  const authorityCommitments = new Map<string, string>();
  for (const row of lifecycleRows) {
    const eventType = requiredString(row, "event_type");
    if (!LIFECYCLE_EVENT_TYPE_SET.has(eventType)) continue;
    const schemaVersion = scalarInteger(row, "event_schema_version");
    if (schemaVersion !== 1) fail();
    if (eventType === "EvidenceCoverageRecorded") fail();
    const payload = record(parseCanonicalJson(requiredString(row, "payload_json")));
    const streamId = requiredString(row, "stream_id");
    if (typeof payload.authorityCommitment === "string") {
      authorityCommitments.set(streamId, payload.authorityCommitment);
    }
    const authorityCommitment = authorityCommitments.get(streamId);
    if (authorityCommitment === undefined) fail();
    let decoded;
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
    const history = eventsBySession.get(sessionId) ?? [];
    history.push(decoded);
    eventsBySession.set(sessionId, history);
    if (eventType !== "SessionCheckpointRecorded") continue;
    const checkpointEvent = decoded as Extract<
      LifecycleEventV1,
      { readonly eventType: "SessionCheckpointRecorded" }
    >;
    const checkpoint = decodeCheckpointV1(checkpointEvent.payload.checkpoint);
    const eventPosition = checkpointEvent.globalPosition;
    if (
      checkpointEvent.payload.baseEventPosition !== checkpoint.baseEventPosition
      || checkpointEvent.payload.checkpointEventPosition !== eventPosition
      || checkpoint.checkpointEventPosition !== eventPosition
      || checkpoint.evidenceCoverage.highestContiguousOrdinal !== null
      || checkpoint.evidenceCoverage.missingIntervals.length !== 0
      || checkpoints.has(checkpoint.checkpointId)
    ) fail();
    checkpoints.set(checkpoint.checkpointId, { checkpoint, eventPosition });
  }
  return { checkpoints, eventsBySession };
}

function foldAt(
  history: IndexedLifecycleHistory,
  sessionId: string,
  eventPosition: string,
): SessionAggregateState {
  const events = history.eventsBySession.get(sessionId)?.filter(
    (event) => BigInt(event.globalPosition) <= BigInt(eventPosition),
  ) ?? [];
  try {
    const aggregate = foldSession(events);
    if (aggregate.eventPosition !== BigInt(eventPosition)) fail();
    return aggregate;
  } catch (error) {
    if (error instanceof SchemaCompatibilityError) throw error;
    fail();
  }
}

function eventAt(
  connection: SqliteConnection,
  projectId: string,
  sessionId: string,
  eventPosition: string,
): SqliteRow {
  const rows = connection.prepare(`
    SELECT global_position, stream_version, event_type, session_id
    FROM events
    WHERE project_id = $projectId AND global_position = $position
  `).all({ $projectId: projectId, $position: BigInt(eventPosition) });
  if (rows.length !== 1 || rows[0]!.session_id !== sessionId) fail();
  return rows[0]!;
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
  const event = eventAt(connection, projectId, childSessionId, lastEventPosition);
  if (String(event.stream_version) !== streamVersion) fail();
  const aggregate = foldAt(history, childSessionId, lastEventPosition);
  if (
    aggregate.kind !== "child"
    || aggregate.parentSessionId !== rootSessionId
    || aggregate.state !== childState
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
    || authority.semantic_state !== aggregate.state
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
  eventAt(connection, projectId, requiredString(row, "session_id"), indexed.eventPosition);
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
  connection.exec(`
    DROP TRIGGER IF EXISTS temp.qualified_checkpoint_v3_stage_marker_no_insert;
    DROP TRIGGER IF EXISTS temp.qualified_checkpoint_v3_stage_marker_no_update;
    DROP TRIGGER IF EXISTS temp.qualified_checkpoint_v3_stage_marker_no_delete;
    DROP TRIGGER IF EXISTS temp.qualified_checkpoint_v3_stage_rows_no_insert;
    DROP TRIGGER IF EXISTS temp.qualified_checkpoint_v3_stage_rows_no_update;
    DROP TRIGGER IF EXISTS temp.qualified_checkpoint_v3_stage_rows_no_delete;
    DROP TABLE IF EXISTS temp.${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE};
    DROP TABLE IF EXISTS temp.${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE};
  `);
}

function createStage(
  connection: SqliteConnection,
  identity: { projectId: string; vaultId: string; storeId: string },
  rows: readonly StageRow[],
): void {
  if (
    tableExists(connection, "temp", QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE)
    || tableExists(connection, "temp", QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE)
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
      CREATE TEMP TABLE ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE} (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        project_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        store_id TEXT NOT NULL,
        source_schema_version INTEGER NOT NULL CHECK (source_schema_version = 2),
        target_schema_version INTEGER NOT NULL CHECK (target_schema_version = 3),
        staged_row_count INTEGER NOT NULL CHECK (staged_row_count >= 0),
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
    connection.prepare(`
      INSERT INTO temp.${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}(
        singleton, project_id, vault_id, store_id, source_schema_version,
        target_schema_version, staged_row_count, sealed
      ) VALUES (1, $projectId, $vaultId, $storeId, 2, 3, $rowCount, 1)
    `).run({
      $projectId: identity.projectId,
      $vaultId: identity.vaultId,
      $storeId: identity.storeId,
      $rowCount: rows.length,
    });
    connection.exec(`
      CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_marker_no_insert
      BEFORE INSERT ON ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
      BEGIN SELECT RAISE(ABORT, '${PRECONDITION}'); END;
      CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_marker_no_update
      BEFORE UPDATE ON ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
      BEGIN SELECT RAISE(ABORT, '${PRECONDITION}'); END;
      CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_marker_no_delete
      BEFORE DELETE ON ${QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE}
      BEGIN SELECT RAISE(ABORT, '${PRECONDITION}'); END;
      CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_rows_no_insert
      BEFORE INSERT ON ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
      BEGIN SELECT RAISE(ABORT, '${PRECONDITION}'); END;
      CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_rows_no_update
      BEFORE UPDATE ON ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
      BEGIN SELECT RAISE(ABORT, '${PRECONDITION}'); END;
      CREATE TEMP TRIGGER qualified_checkpoint_v3_stage_rows_no_delete
      BEFORE DELETE ON ${QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE}
      BEGIN SELECT RAISE(ABORT, '${PRECONDITION}'); END;
    `);
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

export function assertQualifiedCheckpointMigrationStage(
  connection: SqliteConnection,
): void {
  try {
    if (
      !tableExists(connection, "temp", QUALIFIED_CHECKPOINT_STAGE_MARKER_TABLE)
      || !tableExists(connection, "temp", QUALIFIED_CHECKPOINT_STAGE_ROWS_TABLE)
    ) fail();
    const markers = connection.prepare(`
      SELECT singleton, project_id, vault_id, store_id, source_schema_version,
             target_schema_version, staged_row_count, sealed
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
      scalarInteger(marker, "staged_row_count") !== expected.length
      || actual.length !== expected.length
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
      assertEveryLiveRootCapacity(connection, identity.projectId, history);
      const rows = stageRows(connection, identity.projectId, history);
      createStage(connection, identity, rows);
    } catch (error) {
      const normalized = qualifiedCheckpointMigrationFailure(error);
      if (normalized !== undefined) throw normalized;
      throw error;
    }
  }
}
