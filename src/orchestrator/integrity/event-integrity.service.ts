import { readFileSync } from "node:fs";
import { assertRetainedStoredEvent, decodeRetainedEvidenceAuthority, decodeRetainedEvidenceStoredResult, retainedEvidenceIntentHash, verifyRetainedEvidenceTransport } from "../privacy/retained-evidence-codec.js";
import { assertStoredGovernedNoteCorrespondence, GovernedNoteRepository } from "../governed-notes/repository.js";
import { retainedStringMetrics } from "../privacy/evidence-contracts.js";
import {
  commandHash,
  outboxHash,
  payloadHash,
  responseHash,
} from "../crypto/event-hash.js";
import type { StoredEvent } from "../contracts/event.js";
import type { ProjectContext } from "../identity/contracts.js";
import { parseProjectDescriptor } from "../identity/project-descriptor.schema.js";
import { parseStoreManifest } from "../identity/store-manifest.schema.js";
import { PROJECT_MEMORY_APPLICATION_ID } from "../runtime/runtime-capabilities.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import {
  decodeLifecycleIntentWitness,
  lifecycleIntentHashFromWitnessSource,
} from "../lifecycle/lifecycle-intent-witness.js";
import {
  decodeLifecycleEventPayload,
  type LifecycleEventType,
} from "../lifecycle/contracts/events.js";
import {
  COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND,
  decodePendingLifecycleOutboxV1,
  type LifecycleMaterializationPayloadV1,
} from "../lifecycle/materialization-queue.port.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-chain-constants.js";
import type { Migration } from "../storage/migration.js";
import { migrationChecksum } from "../storage/migration-runner.js";
import { PROJECT_STORE_MIGRATIONS } from "../storage/migrations/registry.js";
import {
  expectedSchemaFingerprint,
  schemaFingerprint,
  type SchemaQueryConnection,
} from "../storage/schema-fingerprint.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteRow,
} from "../storage/sqlite-driver.js";
import {
  IntegrityInputError,
  type AsyncIntegrityExtension,
  type IntegrityExtension,
  type IntegrityIssue,
  type IntegrityIssueCode,
  type IntegrityIssueSink,
  type IntegrityMode,
  type IntegrityReport,
} from "./integrity.types.js";
import {
  authenticateStoredEvent,
  StoredEventAuthenticationError,
} from "./stored-event-authenticator.js";

export const DEFAULT_QUICK_TAIL_EVENTS = 256;
/** Provider-free event/blob/authorization/result/head join, shared with private reads.
 * Earlier batches remain readable when the authenticated conversation head advances. */
export function assertStoredRetainedEvidenceCorrespondence(connection: SqliteConnection, event: StoredEvent): void {
  const invalid = (): never => { throw new Error("INTEGRITY_FAILURE"); };
  const parsed = (row: SqliteRow, key: string): unknown => {
    const value = row[key]; if (typeof value !== "string") return invalid();
    retainedStringMetrics(value, 2_097_152, "INTEGRITY_FAILURE"); return JSON.parse(value) as unknown;
  };
  try {
    const payload = assertRetainedStoredEvent(event); if (payload === null) return;
    const w = payload.witness, params = { $p: event.projectId, $c: event.commandId, $i: event.idempotencyKey };
    if (event.streamType !== "retained-evidence" || event.streamId !== `retained-evidence/${w.targetSessionId}/${w.conversationId}`
      || event.sourceRefs.length !== 0 || (event.lifecycleIntentJson !== undefined && event.lifecycleIntentJson !== null)) invalid();
    const a = connection.prepare("SELECT * FROM retained_evidence_command_authorizations WHERE project_id=$p AND command_id=$c AND idempotency_key=$i").get(params);
    const d = connection.prepare("SELECT * FROM command_dedup WHERE project_id=$p AND command_id=$c AND idempotency_key=$i").get(params);
    if (!a || !d || a.event_id !== event.eventId || a.event_position !== event.globalPosition) invalid();
    const authorization = decodeRetainedEvidenceAuthority(parsed(a!, "authorization_json"));
    const result = decodeRetainedEvidenceStoredResult(parsed(d!, "response_json")), receipt = result.response;
    if (canonicalJson(authorization) !== a!.authorization_json || canonicalJson(authorization) !== canonicalJson(w.authority)
      || d!.state !== "committed" || d!.command_type !== "retain-evidence-batch" || d!.command_hash !== retainedEvidenceIntentHash(w)
      || d!.lifecycle_authorization_kind !== null || d!.outbox_order_json !== "[]"
      || d!.first_global_position !== event.globalPosition || d!.last_global_position !== event.globalPosition || d!.final_stream_version !== event.streamVersion
      || d!.event_ids_json !== canonicalJson([event.eventId]) || d!.response_json !== canonicalJson(result) || d!.response_hash !== responseHash(result)
      || result.eventIds[0] !== event.eventId || result.firstGlobalPosition !== String(event.globalPosition) || result.finalStreamVersion !== String(event.streamVersion)
      || receipt.commandId !== event.commandId || receipt.idempotencyKey !== event.idempotencyKey || receipt.targetSessionId !== w.targetSessionId
      || receipt.conversationId !== w.conversationId || canonicalJson(receipt.evidenceIds) !== canonicalJson(event.evidenceRefs)) invalid();
    const rows = connection.prepare("SELECT * FROM retained_evidence_blobs WHERE project_id=$p AND event_id=$e ORDER BY item_index").all({ $p: event.projectId, $e: event.eventId });
    if (rows.length !== payload.items.length) invalid();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!, item = verifyRetainedEvidenceTransport(parsed(row, "encrypted_item_json")), b = item.binding;
      const { formatVersion: _v, algorithm: _a, nonce: _n, tag: _t, ciphertext: _c, wrappedKey: _k, ...metadata } = item;
      if (canonicalJson(item) !== row.encrypted_item_json || canonicalJson(metadata) !== canonicalJson(payload.items[index])
        || row.project_id !== b.projectId || row.vault_id !== b.vaultId || row.store_id !== b.storeId || row.evidence_id !== b.evidenceId || row.event_id !== b.eventId
        || row.event_position !== event.globalPosition || row.command_id !== event.commandId || row.idempotency_key !== event.idempotencyKey || row.item_index !== BigInt(index)
        || row.target_session_id !== b.targetSessionId || row.conversation_id !== b.conversationId || row.frame_id !== b.frameId || row.ordinal !== BigInt(item.frame.ordinal)) invalid();
    }
    const stream = { $p: event.projectId, $t: w.targetSessionId, $c: w.conversationId };
    const head = connection.prepare("SELECT * FROM retained_evidence_stream_heads WHERE project_id=$p AND target_session_id=$t AND conversation_id=$c").get(stream);
    const latest = connection.prepare("SELECT * FROM retained_evidence_blobs WHERE project_id=$p AND target_session_id=$t AND conversation_id=$c ORDER BY ordinal DESC LIMIT 1").get(stream);
    const counts = connection.prepare("SELECT count(*) AS frames, count(DISTINCT event_id) AS batches, min(ordinal) AS first, max(ordinal) AS last FROM retained_evidence_blobs WHERE project_id=$p AND target_session_id=$t AND conversation_id=$c").get(stream);
    if (!head || !latest || !counts || counts.first !== 0n || counts.frames !== (counts.last as bigint) + 1n
      || head.last_frame_id !== latest.frame_id || head.last_ordinal !== latest.ordinal || head.version !== counts.batches
      || event.streamVersion > (head.version as bigint)) invalid();
    const first = w.frames[0]!;
    if (first.ordinal !== "0") {
      const previous = connection.prepare("SELECT frame_id FROM retained_evidence_blobs WHERE project_id=$p AND target_session_id=$t AND conversation_id=$c AND ordinal=$o").get({ ...stream, $o: BigInt(first.ordinal) - 1n });
      if (!previous || previous.frame_id !== first.previousFrameId) invalid();
    } else if (first.previousFrameId !== null) invalid();
  } catch { invalid(); }
}
export const MAX_QUICK_TAIL_EVENTS = 4096;
export const MAX_INTEGRITY_RANGE_EVENTS = 4096;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const STORED_RESPONSE_KEYS = [
  "eventIds",
  "finalStreamVersion",
  "firstGlobalPosition",
  "lastGlobalPosition",
  "response",
].sort().join("\n");
const COMMAND_WITNESS_DATA_ERRORS = new Set([
  "CANONICAL_JSON_INVALID",
  "INTEGRITY_JSON_NONCANONICAL",
  "INTEGRITY_ROW_INVALID",
]);
const LIFECYCLE_EVENT_TYPES = new Set([
  "SessionStarted",
  "SessionOwnerTransferred",
  "SessionOwnershipRecovered",
  "SessionSuspendRequested",
  "SessionSuspended",
  "SessionResumed",
  "SessionCheckpointRecorded",
  "EvidenceCoverageRecorded",
  "SessionForked",
  "ChildAssignmentAmended",
  "ChildWorkReported",
  "ChildWorkDispositioned",
  "ChildCompletionProposed",
  "ChildSessionCompleted",
  "ChildSessionSuspended",
  "ChildWorkTransferCreated",
  "ChildWorkTransferClaimed",
  "SessionEndRequested",
  "SessionEndAmended",
  "SessionValidationResultRecorded",
  "SessionEndVerificationPassed",
  "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated",
  "SessionEndCancelled",
  "SessionAbandoned",
  "SessionEnded",
]);

const ISSUE_MESSAGES: Record<IntegrityIssueCode, string> = {
  PROJECT_ID_MISMATCH: "Project identity does not match the bound project",
  VAULT_ID_MISMATCH: "Vault identity does not match the bound vault",
  STORE_ID_MISMATCH: "Store identity does not match the bound store",
  STORE_APPLICATION_ID_MISMATCH: "SQLite application identity does not match project memory",
  SQLITE_QUICK_CHECK_FAILED: "SQLite quick_check reported corruption",
  SQLITE_INTEGRITY_CHECK_FAILED: "SQLite integrity_check reported corruption",
  SQLITE_FOREIGN_KEY_CHECK_FAILED: "SQLite foreign-key verification reported corruption",
  MIGRATION_CHECKSUM_MISMATCH: "Recorded migration history does not match the required migrations",
  PROJECT_SCHEMA_VERSION_MISMATCH: "Project schema version does not match the required migrations",
  SCHEMA_FINGERPRINT_MISMATCH: "Authoritative SQLite schema fingerprint does not match",
  STREAM_HEAD_VERSION_MISMATCH: "Stream head version does not match its maximum event version",
  STREAM_TYPE_MISMATCH: "Stream metadata type does not match its events",
  COMMAND_RANGE_FOREIGN_EVENT: "Command range contains an event owned by another command",
  COMMAND_RANGE_MISSING_EVENT: "Command range does not contain every event owned by the command",
  COMMAND_EVENT_INDEX_MISMATCH: "Command event indexes are not zero-based and contiguous",
  COMMAND_HASH_MISMATCH: "Stored command hash does not match reconstructable command material",
  COMMAND_METADATA_MISMATCH: "Committed command metadata does not match its indexed events",
  COMMAND_RESPONSE_HASH_MISMATCH: "Stored command response does not match its response hash",
  GLOBAL_POSITION_NONCONTIGUOUS: "Global event positions are not contiguous",
  STREAM_VERSION_NONCONTIGUOUS: "Per-stream event versions are not contiguous",
  EVENT_PAYLOAD_HASH_MISMATCH: "Stored event payload does not match its payload hash",
  EVENT_PREVIOUS_HASH_MISMATCH: "Stored event predecessor hash does not match the prior event",
  EVENT_HASH_MISMATCH: "Stored event does not match its event hash",
  EVENT_TIMESTAMP_INVALID: "Stored event timestamp is not strict RFC3339",
  ORPHAN_COMMAND: "Committed command has no owned event",
  ORPHAN_EVENT: "Event has no committed command record",
  RANGE_INVALID: "Requested integrity range is invalid or exceeds the bounded maximum",
  RANGE_OUT_OF_BOUNDS: "Requested integrity range extends beyond the authoritative event tail",
  TAIL_LIMIT_INVALID: "Requested quick-check tail limit is invalid or exceeds the bounded maximum",
  COMMAND_AUTHORIZATION_METADATA_MISMATCH: "Lifecycle command authorization metadata is incomplete or inconsistent",
  SESSION_AUTHORITY_FOLD_MISMATCH: "Session authority does not match its immutable lifecycle event fold",
  SESSION_LEASE_INVARIANT_MISMATCH: "Session lease generations or release state are inconsistent",
  SESSION_EVIDENCE_COVERAGE_MISMATCH: "Session evidence coverage does not match immutable ordinal evidence",
  LIFECYCLE_APPROVAL_CONSUMPTION_MISMATCH: "Lifecycle approval consumption metadata is incomplete or inconsistent",
  LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH: "Lifecycle workflow state or claims are inconsistent",
  LIFECYCLE_VALIDATION_RESULT_MISMATCH: "Lifecycle validation results are not bound to their immutable event and scope",
  LIFECYCLE_OUTBOX_INVARIANT_MISMATCH: "Lifecycle outbox materialization revisions or fingerprints are inconsistent",
};

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

interface EventIndexRow {
  globalPosition: bigint;
  eventId: string;
  projectId: string;
  vaultId: string;
  storeId: string;
  streamId: string;
  streamType: string;
  streamVersion: bigint;
  commandId: string;
  idempotencyKey: string;
  commandEventIndex: bigint;
  eventHash: string;
}

interface StreamRow {
  projectId: string;
  streamId: string;
  streamType: string;
  currentVersion: bigint;
}

interface CommandRow {
  projectId: string;
  idempotencyKey: string;
  commandId: string;
  commandType: string;
  commandHash: string;
  lifecycleAuthorizationKind: string | null;
  authorizationProofVersion: bigint | null;
  authorizationProofNonce: string | null;
  authorizationProofDigest: string | null;
  authorizationSessionId: string | null;
  targetSessionId: string | null;
  presentingActorRole: string | null;
  presentingClientInstanceId: string | null;
  targetActorRole: string | null;
  targetClientInstanceId: string | null;
  internalWorkflowId: string | null;
  internalWorkflowGeneration: bigint | null;
  internalPlannedWorkId: string | null;
  workspaceHeadCommit: string | null;
  outboxOrderJson: string;
  state: string;
  firstGlobalPosition: bigint;
  lastGlobalPosition: bigint;
  finalStreamVersion: bigint;
  eventIdsJson: string;
  responseJson: string;
  responseHash: string;
  committedAt: string;
}

interface StructuralCheck {
  schemaFingerprint: string;
  events: EventIndexRow[];
  streams: StreamRow[];
  commands: CommandRow[];
}

class CommandWitnessInvalidError extends Error {}
class LifecycleOutboxInvalidError extends Error {}

function isCommandWitnessInvalid(error: unknown): boolean {
  return error instanceof CommandWitnessInvalidError
    || error instanceof SyntaxError
    || (error instanceof Error && COMMAND_WITNESS_DATA_ERRORS.has(error.message));
}

class IssueCollector implements IntegrityIssueSink {
  readonly #issues = new Map<string, IntegrityIssue>();

  add(
    code: IntegrityIssueCode,
    location: Omit<IntegrityIssue, "code" | "message"> = {},
  ): void {
    const issue: IntegrityIssue = { code, message: ISSUE_MESSAGES[code], ...location };
    const key = [
      code,
      issue.globalPosition ?? "",
      issue.streamId ?? "",
      issue.commandId ?? "",
    ].join("\u0000");
    if (!this.#issues.has(key)) this.#issues.set(key, issue);
  }

  sorted(): IntegrityIssue[] {
    return [...this.#issues.values()].sort((left, right) => {
      const code = left.code.localeCompare(right.code);
      if (code !== 0) return code;
      if (left.globalPosition !== right.globalPosition) {
        if (left.globalPosition === undefined) return -1;
        if (right.globalPosition === undefined) return 1;
        const leftPosition = BigInt(left.globalPosition);
        const rightPosition = BigInt(right.globalPosition);
        if (leftPosition !== rightPosition) return leftPosition < rightPosition ? -1 : 1;
      }
      const stream = (left.streamId ?? "").localeCompare(right.streamId ?? "");
      return stream !== 0
        ? stream
        : (left.commandId ?? "").localeCompare(right.commandId ?? "");
    });
  }
}

interface QuickReportState {
  readonly issues: IssueCollector;
  readonly structural: StructuralCheck;
  readonly indexedRows: EventIndexRow[];
}

interface FullReportState {
  readonly issues: IssueCollector;
  readonly structural: StructuralCheck;
}

function stringValue(row: SqliteRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error("INTEGRITY_ROW_INVALID");
  return value;
}

function nullableStringValue(row: SqliteRow, name: string): string | null {
  const value = row[name];
  if (value !== null && typeof value !== "string") {
    throw new Error("INTEGRITY_ROW_INVALID");
  }
  return value;
}

function bigintValue(row: SqliteRow, name: string): bigint {
  const value = row[name];
  if (typeof value !== "bigint") throw new Error("INTEGRITY_ROW_INVALID");
  return value;
}

function nullableBigintValue(row: SqliteRow, name: string): bigint | null {
  const value = row[name];
  if (value !== null && typeof value !== "bigint") {
    throw new Error("INTEGRITY_ROW_INVALID");
  }
  return value;
}

function safeNumber(value: bigint): number | undefined {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : undefined;
}

function jsonValue(source: string): unknown {
  return JSON.parse(source) as unknown;
}

function canonicalJsonValue(source: string): unknown {
  const value = jsonValue(source);
  if (canonicalJson(value) !== source) throw new Error("INTEGRITY_JSON_NONCANONICAL");
  return value;
}

function storedEventForAuthentication(row: SqliteRow): StoredEvent {
  const eventSchemaVersion = safeNumber(bigintValue(row, "event_schema_version"));
  const commandEventIndex = safeNumber(bigintValue(row, "command_event_index"));
  if (eventSchemaVersion === undefined || commandEventIndex === undefined) {
    throw new Error("INTEGRITY_ROW_INVALID");
  }
  const lifecycleIntentJson = row.lifecycle_intent_json;
  if (
    lifecycleIntentJson !== undefined
    && lifecycleIntentJson !== null
    && typeof lifecycleIntentJson !== "string"
  ) {
    throw new Error("INTEGRITY_ROW_INVALID");
  }
  return {
    globalPosition: bigintValue(row, "global_position"),
    eventId: stringValue(row, "event_id"),
    projectId: stringValue(row, "project_id") as StoredEvent["projectId"],
    vaultId: stringValue(row, "vault_id") as StoredEvent["vaultId"],
    storeId: stringValue(row, "store_id") as StoredEvent["storeId"],
    workspaceId: stringValue(row, "workspace_id") as StoredEvent["workspaceId"],
    branchScopeId: nullableStringValue(row, "branch_scope_id") as StoredEvent["branchScopeId"],
    branchRef: nullableStringValue(row, "branch_ref"),
    streamId: stringValue(row, "stream_id"),
    streamType: stringValue(row, "stream_type"),
    streamVersion: bigintValue(row, "stream_version"),
    eventType: stringValue(row, "event_type"),
    eventSchemaVersion,
    sessionId: nullableStringValue(row, "session_id"),
    parentSessionId: nullableStringValue(row, "parent_session_id"),
    actorRole: stringValue(row, "actor_role") as StoredEvent["actorRole"],
    agentId: stringValue(row, "agent_id"),
    clientInstanceId: stringValue(row, "client_instance_id"),
    correlationId: stringValue(row, "correlation_id"),
    causationId: nullableStringValue(row, "causation_id"),
    commandId: stringValue(row, "command_id"),
    idempotencyKey: stringValue(row, "idempotency_key"),
    commandEventIndex,
    occurredAt: stringValue(row, "occurred_at"),
    recordedAt: stringValue(row, "recorded_at"),
    visibilityScope: stringValue(row, "visibility_scope") as StoredEvent["visibilityScope"],
    confidence: stringValue(row, "confidence") as StoredEvent["confidence"],
    verificationStatus: stringValue(row, "verification_status") as StoredEvent["verificationStatus"],
    sourceRefs: canonicalJsonValue(stringValue(row, "source_refs_json")) as StoredEvent["sourceRefs"],
    evidenceRefs: canonicalJsonValue(stringValue(row, "evidence_refs_json")) as StoredEvent["evidenceRefs"],
    evidenceDigests: canonicalJsonValue(stringValue(row, "evidence_digests_json")) as StoredEvent["evidenceDigests"],
    payload: Object.freeze({}),
    payloadJson: stringValue(row, "payload_json"),
    payloadHash: stringValue(row, "payload_hash"),
    previousGlobalHash: stringValue(row, "previous_global_hash"),
    eventHash: stringValue(row, "event_hash"),
    ...(lifecycleIntentJson === undefined ? {} : { lifecycleIntentJson }),
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictRfc3339(value: string): boolean {
  const match = RFC3339.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1
    && month >= 1 && month <= 12
    && day >= 1 && day <= (monthDays[month - 1] ?? 0)
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59
    && offsetHour >= 0 && offsetHour <= 23
    && offsetMinute >= 0 && offsetMinute <= 59;
}

function eventIndex(row: SqliteRow): EventIndexRow {
  return {
    globalPosition: bigintValue(row, "global_position"),
    eventId: stringValue(row, "event_id"),
    projectId: stringValue(row, "project_id"),
    vaultId: stringValue(row, "vault_id"),
    storeId: stringValue(row, "store_id"),
    streamId: stringValue(row, "stream_id"),
    streamType: stringValue(row, "stream_type"),
    streamVersion: bigintValue(row, "stream_version"),
    commandId: stringValue(row, "command_id"),
    idempotencyKey: stringValue(row, "idempotency_key"),
    commandEventIndex: bigintValue(row, "command_event_index"),
    eventHash: stringValue(row, "event_hash"),
  };
}

function lowerBoundGlobalPosition(
  events: readonly EventIndexRow[],
  target: bigint,
): number {
  let lower = 0;
  let upper = events.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (events[middle]!.globalPosition < target) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function upperBoundGlobalPosition(
  events: readonly EventIndexRow[],
  target: bigint,
): number {
  let lower = 0;
  let upper = events.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (events[middle]!.globalPosition <= target) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function eventCountInRange(
  events: readonly EventIndexRow[],
  first: bigint,
  last: bigint,
): number {
  if (last < first) return 0;
  return upperBoundGlobalPosition(events, last) - lowerBoundGlobalPosition(events, first);
}

function streamRow(row: SqliteRow): StreamRow {
  return {
    projectId: stringValue(row, "project_id"),
    streamId: stringValue(row, "stream_id"),
    streamType: stringValue(row, "stream_type"),
    currentVersion: bigintValue(row, "current_version"),
  };
}

function commandRow(row: SqliteRow): CommandRow {
  return {
    projectId: stringValue(row, "project_id"),
    idempotencyKey: stringValue(row, "idempotency_key"),
    commandId: stringValue(row, "command_id"),
    commandType: stringValue(row, "command_type"),
    commandHash: stringValue(row, "command_hash"),
    lifecycleAuthorizationKind: nullableStringValue(row, "lifecycle_authorization_kind"),
    authorizationProofVersion: nullableBigintValue(row, "authorization_proof_version"),
    authorizationProofNonce: nullableStringValue(row, "authorization_proof_nonce"),
    authorizationProofDigest: nullableStringValue(row, "authorization_proof_digest"),
    authorizationSessionId: nullableStringValue(row, "authorization_session_id"),
    targetSessionId: nullableStringValue(row, "target_session_id"),
    presentingActorRole: nullableStringValue(row, "presenting_actor_role"),
    presentingClientInstanceId: nullableStringValue(row, "presenting_client_instance_id"),
    targetActorRole: nullableStringValue(row, "target_actor_role"),
    targetClientInstanceId: nullableStringValue(row, "target_client_instance_id"),
    internalWorkflowId: nullableStringValue(row, "internal_workflow_id"),
    internalWorkflowGeneration: nullableBigintValue(row, "internal_workflow_generation"),
    internalPlannedWorkId: nullableStringValue(row, "internal_planned_work_id"),
    workspaceHeadCommit: nullableStringValue(row, "workspace_head_commit"),
    outboxOrderJson: stringValue(row, "outbox_order_json"),
    state: stringValue(row, "state"),
    firstGlobalPosition: bigintValue(row, "first_global_position"),
    lastGlobalPosition: bigintValue(row, "last_global_position"),
    finalStreamVersion: bigintValue(row, "final_stream_version"),
    eventIdsJson: stringValue(row, "event_ids_json"),
    responseJson: stringValue(row, "response_json"),
    responseHash: stringValue(row, "response_hash"),
    committedAt: stringValue(row, "committed_at"),
  };
}

function transactionRollback(connection: SqliteConnection): void {
  try { connection.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
}

function hasQuickCheckAsync(
  extension: IntegrityExtension,
): extension is IntegrityExtension & Pick<AsyncIntegrityExtension, "quickCheckAsync"> {
  return typeof (extension as Partial<AsyncIntegrityExtension>).quickCheckAsync === "function";
}

function hasFullCheckAsync(
  extension: IntegrityExtension,
): extension is IntegrityExtension & Pick<AsyncIntegrityExtension, "fullCheckAsync"> {
  return typeof (extension as Partial<AsyncIntegrityExtension>).fullCheckAsync === "function";
}

export class EventIntegrityService {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly migrations: readonly Migration[] = PROJECT_STORE_MIGRATIONS,
    private readonly extensions: readonly IntegrityExtension[] = [],
  ) {}

  quickCheck(
    context: ProjectContext,
    tailLimit = DEFAULT_QUICK_TAIL_EVENTS,
  ): IntegrityReport {
    if (
      !Number.isSafeInteger(tailLimit)
      || tailLimit < 1
      || tailLimit > MAX_QUICK_TAIL_EVENTS
    ) {
      throw new IntegrityInputError("TAIL_LIMIT_INVALID");
    }
    return this.inTransaction(() => this.quickReport(context, tailLimit));
  }

  fullCheck(context: ProjectContext): IntegrityReport {
    return this.inTransaction(() => this.fullReport(context));
  }

  quickCheckAsync(
    context: ProjectContext,
    tailLimit = DEFAULT_QUICK_TAIL_EVENTS,
  ): Promise<IntegrityReport> {
    if (
      !Number.isSafeInteger(tailLimit)
      || tailLimit < 1
      || tailLimit > MAX_QUICK_TAIL_EVENTS
    ) {
      throw new IntegrityInputError("TAIL_LIMIT_INVALID");
    }
    return this.inTransactionAsync(() => this.quickReportAsync(context, tailLimit));
  }

  fullCheckAsync(context: ProjectContext): Promise<IntegrityReport> {
    return this.inTransactionAsync(() => this.fullReportAsync(context));
  }

  verifyRange(
    context: ProjectContext,
    first: bigint,
    last: bigint,
  ): IntegrityReport {
    if (
      first < 1n
      || last < first
      || first > SQLITE_INT64_MAX
      || last > SQLITE_INT64_MAX
      || last - first + 1n > BigInt(MAX_INTEGRITY_RANGE_EVENTS)
    ) {
      throw new IntegrityInputError("RANGE_INVALID");
    }
    return this.inTransaction(() => this.rangeReport(context, first, last));
  }

  private inTransaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN DEFERRED");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      transactionRollback(this.connection);
      throw error;
    }
  }

  private async inTransactionAsync<T>(operation: () => Promise<T>): Promise<T> {
    this.connection.exec("BEGIN DEFERRED");
    try {
      const result = await operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      transactionRollback(this.connection);
      throw error;
    }
  }

  private quickReport(context: ProjectContext, tailLimit: number): IntegrityReport {
    const state = this.buildQuickReport(context, tailLimit);
    for (const extension of this.extensions) {
      extension.quickCheck(context, state.issues);
    }
    return this.report(
      "quick",
      context,
      state.structural.schemaFingerprint,
      state.indexedRows,
      state.structural.streams.length,
      state.structural.commands.length,
      state.issues,
    );
  }

  private async quickReportAsync(
    context: ProjectContext,
    tailLimit: number,
  ): Promise<IntegrityReport> {
    const state = this.buildQuickReport(context, tailLimit);
    for (const extension of this.extensions) {
      if (hasQuickCheckAsync(extension)) {
        await extension.quickCheckAsync(context, state.issues);
      } else {
        extension.quickCheck(context, state.issues);
      }
    }
    return this.report(
      "quick",
      context,
      state.structural.schemaFingerprint,
      state.indexedRows,
      state.structural.streams.length,
      state.structural.commands.length,
      state.issues,
    );
  }

  private buildQuickReport(
    context: ProjectContext,
    tailLimit: number,
  ): QuickReportState {
    const issues = new IssueCollector();
    this.checkPragma("quick_check", "SQLITE_QUICK_CHECK_FAILED", issues);
    this.checkForeignKeys(issues);
    const structural = this.checkStructural(context, issues);
    this.checkProjectSchemaVersion(issues);
    this.checkStreams(structural.streams, structural.events, issues);
    this.checkCommands(structural.commands, structural.events, issues);
    const rows = this.connection.prepare(`
      SELECT * FROM (
        SELECT * FROM events ORDER BY global_position DESC LIMIT $limit
      ) ORDER BY global_position
    `).all({ $limit: tailLimit });
    const indexedRows = rows.map(eventIndex);
    const predecessor = indexedRows.length === 0
      ? undefined
      : this.predecessor(indexedRows[0]!.globalPosition, structural.events);
    this.checkEventRows(context, rows, {
      expectedFirst: indexedRows[0]?.globalPosition ?? 1n,
      expectedPreviousHash: indexedRows[0]?.globalPosition === 1n
        ? GENESIS_GLOBAL_HASH
        : predecessor?.eventHash,
      verifyTimestamps: false,
      verifyStreamVersions: false,
      initialStreamVersions: new Map(),
    }, issues);
    return { issues, structural, indexedRows };
  }

  private fullReport(context: ProjectContext): IntegrityReport {
    const state = this.buildFullReport(context);
    for (const extension of this.extensions) {
      extension.fullCheck(context, state.issues);
    }
    return this.report(
      "full",
      context,
      state.structural.schemaFingerprint,
      state.structural.events,
      state.structural.streams.length,
      state.structural.commands.length,
      state.issues,
    );
  }

  private async fullReportAsync(context: ProjectContext): Promise<IntegrityReport> {
    const state = this.buildFullReport(context);
    for (const extension of this.extensions) {
      if (hasFullCheckAsync(extension)) {
        await extension.fullCheckAsync(context, state.issues);
      } else {
        extension.fullCheck(context, state.issues);
      }
    }
    return this.report(
      "full",
      context,
      state.structural.schemaFingerprint,
      state.structural.events,
      state.structural.streams.length,
      state.structural.commands.length,
      state.issues,
    );
  }

  private buildFullReport(context: ProjectContext): FullReportState {
    const issues = new IssueCollector();
    this.checkPragma("quick_check", "SQLITE_QUICK_CHECK_FAILED", issues);
    this.checkPragma("integrity_check", "SQLITE_INTEGRITY_CHECK_FAILED", issues);
    this.checkForeignKeys(issues);
    const structural = this.checkStructural(context, issues);
    this.checkProjectSchemaVersion(issues);
    this.checkStreams(structural.streams, structural.events, issues);
    const rows = this.connection.prepare(`
      SELECT * FROM events ORDER BY global_position
    `).all();
    this.checkCommands(structural.commands, structural.events, issues, rows);
    this.checkEventRows(context, rows, {
      expectedFirst: 1n,
      expectedPreviousHash: GENESIS_GLOBAL_HASH,
      verifyTimestamps: true,
      verifyStreamVersions: true,
      initialStreamVersions: new Map(),
    }, issues);
    return { issues, structural };
  }

  private rangeReport(
    context: ProjectContext,
    first: bigint,
    last: bigint,
  ): IntegrityReport {
    const issues = new IssueCollector();
    const structural = this.checkStructural(context, issues, false);
    const tail = structural.events.at(-1)?.globalPosition ?? 0n;
    if (last > tail) throw new IntegrityInputError("RANGE_OUT_OF_BOUNDS");
    const rows = this.connection.prepare(`
      SELECT * FROM events
      WHERE global_position BETWEEN $first AND $last
      ORDER BY global_position
    `).all({ $first: first, $last: last });
    const indexedRows = rows.map(eventIndex);
    if (BigInt(indexedRows.length) !== last - first + 1n) {
      const positions = new Set(indexedRows.map((event) => event.globalPosition));
      let missing = first;
      while (missing <= last && positions.has(missing)) missing += 1n;
      issues.add("GLOBAL_POSITION_NONCONTIGUOUS", {
        globalPosition: (missing <= last ? missing : first).toString(),
      });
    }
    const predecessor = first === 1n ? undefined : this.predecessor(first, structural.events);
    const initialStreamVersions = new Map<string, bigint>();
    for (const event of structural.events) {
      if (event.globalPosition >= first) break;
      initialStreamVersions.set(event.streamId, event.streamVersion);
    }
    this.checkEventRows(context, rows, {
      expectedFirst: first,
      expectedPreviousHash: first === 1n ? GENESIS_GLOBAL_HASH : predecessor?.eventHash,
      verifyTimestamps: true,
      verifyStreamVersions: true,
      initialStreamVersions,
    }, issues);
    const selectedStreams = new Set(indexedRows.map((event) => event.streamId));
    const selectedCommands = new Set(indexedRows.map((event) => event.commandId));
    return this.report(
      "range",
      context,
      structural.schemaFingerprint,
      indexedRows,
      selectedStreams.size,
      selectedCommands.size,
      issues,
      first,
      last,
    );
  }

  private checkStructural(
    context: ProjectContext,
    issues: IssueCollector,
    includeStreamsAndCommands = true,
  ): StructuralCheck {
    this.checkIdentity(context, issues);
    this.checkApplicationId(issues);
    this.checkMigrations(issues);
    const observedSchemaFingerprint = schemaFingerprint(
      this.connection as unknown as SchemaQueryConnection,
    );
    if (observedSchemaFingerprint !== expectedSchemaFingerprint(this.migrations)) {
      issues.add("SCHEMA_FINGERPRINT_MISMATCH");
    }
    const events = this.connection.prepare(`
      SELECT global_position, event_id, project_id, vault_id, store_id,
             stream_id, stream_type, stream_version, command_id, idempotency_key,
             command_event_index, event_hash
      FROM events ORDER BY global_position
    `).all().map(eventIndex);
    this.checkEventIdentities(context, events, issues);
    const streams = includeStreamsAndCommands
      ? this.connection.prepare(`
          SELECT project_id, stream_id, stream_type, current_version
          FROM streams ORDER BY project_id, stream_id
        `).all().map(streamRow)
      : [];
    const lifecycleAuthorizationColumns = (this.migrations.at(-1)?.version ?? 0) >= 2
      ? `lifecycle_authorization_kind, authorization_proof_version,
         authorization_proof_nonce, authorization_proof_digest,
         authorization_session_id, target_session_id,
         presenting_actor_role, presenting_client_instance_id,
         target_actor_role, target_client_instance_id, internal_workflow_id,
         internal_workflow_generation, internal_planned_work_id`
      : `NULL AS lifecycle_authorization_kind, NULL AS authorization_proof_version,
         NULL AS authorization_proof_nonce, NULL AS authorization_proof_digest,
         NULL AS authorization_session_id,
         NULL AS target_session_id, NULL AS presenting_actor_role,
         NULL AS presenting_client_instance_id, NULL AS target_actor_role,
         NULL AS target_client_instance_id, NULL AS internal_workflow_id,
         NULL AS internal_workflow_generation, NULL AS internal_planned_work_id`;
    const commands = includeStreamsAndCommands
      ? this.connection.prepare(`
          SELECT project_id, idempotency_key, command_id, first_global_position,
                 command_type, command_hash, workspace_head_commit,
                 ${lifecycleAuthorizationColumns},
                 outbox_order_json, state, last_global_position, final_stream_version,
                 event_ids_json, response_json, response_hash, committed_at
          FROM command_dedup
          ORDER BY project_id, first_global_position, command_id
        `).all().map(commandRow)
      : [];
    return { schemaFingerprint: observedSchemaFingerprint, events, streams, commands };
  }

  private checkIdentity(context: ProjectContext, issues: IssueCollector): void {
    const binding = context.binding;
    try {
      const descriptor = parseProjectDescriptor(
        JSON.parse(readFileSync(binding.descriptorPath, "utf8")) as unknown,
      );
      if (descriptor.projectId !== binding.projectId) issues.add("PROJECT_ID_MISMATCH");
      if (descriptor.vaultId !== binding.vaultId) issues.add("VAULT_ID_MISMATCH");
    } catch {
      issues.add("PROJECT_ID_MISMATCH");
      issues.add("VAULT_ID_MISMATCH");
    }
    try {
      const manifest = parseStoreManifest(
        JSON.parse(readFileSync(binding.storeRoute.storeManifestPath, "utf8")) as unknown,
      );
      if (manifest.projectId !== binding.projectId) issues.add("PROJECT_ID_MISMATCH");
      if (manifest.vaultId !== binding.vaultId) issues.add("VAULT_ID_MISMATCH");
      if (manifest.storeId !== binding.storeId) issues.add("STORE_ID_MISMATCH");
    } catch {
      issues.add("PROJECT_ID_MISMATCH");
      issues.add("VAULT_ID_MISMATCH");
      issues.add("STORE_ID_MISMATCH");
    }
    const metaRows = this.connection.prepare(`
      SELECT project_id, vault_id, store_id FROM project_meta WHERE singleton = 1
    `).all();
    if (metaRows.length !== 1) {
      issues.add("PROJECT_ID_MISMATCH");
      issues.add("VAULT_ID_MISMATCH");
      issues.add("STORE_ID_MISMATCH");
      return;
    }
    const meta = metaRows[0]!;
    if (meta.project_id !== binding.projectId) issues.add("PROJECT_ID_MISMATCH");
    if (meta.vault_id !== binding.vaultId) issues.add("VAULT_ID_MISMATCH");
    if (meta.store_id !== binding.storeId) issues.add("STORE_ID_MISMATCH");
  }

  private checkApplicationId(issues: IssueCollector): void {
    const value = this.connection.prepare("PRAGMA application_id").get()?.application_id;
    if ((typeof value !== "bigint" && typeof value !== "number")
      || Number(value) !== PROJECT_MEMORY_APPLICATION_ID) {
      issues.add("STORE_APPLICATION_ID_MISMATCH");
    }
  }

  private checkMigrations(issues: IssueCollector): void {
    const rows = this.connection.prepare(`
      SELECT version, name, checksum FROM schema_migrations ORDER BY version
    `).all();
    if (rows.length !== this.migrations.length) {
      issues.add("MIGRATION_CHECKSUM_MISMATCH");
      return;
    }
    for (let index = 0; index < this.migrations.length; index += 1) {
      const migration = this.migrations[index]!;
      const row = rows[index]!;
      const version = row.version;
      if (
        (typeof version !== "bigint" && typeof version !== "number")
        || Number(version) !== migration.version
        || row.name !== migration.name
        || row.checksum !== migrationChecksum(migration)
      ) {
        issues.add("MIGRATION_CHECKSUM_MISMATCH");
        return;
      }
    }
  }

  private checkProjectSchemaVersion(issues: IssueCollector): void {
    const expectedVersion = this.migrations.at(-1)?.version;
    const rows = this.connection.prepare(`
      SELECT schema_version FROM project_meta WHERE singleton = 1
    `).all();
    if (
      expectedVersion === undefined
      || rows.length !== 1
      || (typeof rows[0]?.schema_version !== "bigint"
        && typeof rows[0]?.schema_version !== "number")
      || Number(rows[0]!.schema_version) !== expectedVersion
    ) {
      issues.add("PROJECT_SCHEMA_VERSION_MISMATCH");
    }
  }

  private checkPragma(
    pragma: "quick_check" | "integrity_check",
    code: "SQLITE_QUICK_CHECK_FAILED" | "SQLITE_INTEGRITY_CHECK_FAILED",
    issues: IssueCollector,
  ): void {
    const rows = this.connection.prepare(`PRAGMA ${pragma}`).all();
    if (rows.length === 0 || rows.some((row) => row[pragma] !== "ok")) issues.add(code);
  }

  private checkForeignKeys(issues: IssueCollector): void {
    if (this.connection.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      issues.add("SQLITE_FOREIGN_KEY_CHECK_FAILED");
    }
  }

  private checkEventIdentities(
    context: ProjectContext,
    events: readonly EventIndexRow[],
    issues: IssueCollector,
  ): void {
    for (const event of events) {
      const location = { globalPosition: event.globalPosition.toString() };
      if (event.projectId !== context.binding.projectId) {
        issues.add("PROJECT_ID_MISMATCH", location);
      }
      if (event.vaultId !== context.binding.vaultId) {
        issues.add("VAULT_ID_MISMATCH", location);
      }
      if (event.storeId !== context.binding.storeId) {
        issues.add("STORE_ID_MISMATCH", location);
      }
    }
  }

  private checkStreams(
    streams: readonly StreamRow[],
    events: readonly EventIndexRow[],
    issues: IssueCollector,
  ): void {
    const byKey = new Map(streams.map((stream) => [
      `${stream.projectId}\u0000${stream.streamId}`,
      stream,
    ]));
    const maximumVersions = new Map<string, bigint>();
    for (const event of events) {
      const key = `${event.projectId}\u0000${event.streamId}`;
      const current = maximumVersions.get(key) ?? 0n;
      if (event.streamVersion > current) maximumVersions.set(key, event.streamVersion);
      const stream = byKey.get(key);
      if (stream === undefined || stream.streamType !== event.streamType) {
        issues.add("STREAM_TYPE_MISMATCH", { streamId: event.streamId });
      }
    }
    for (const stream of streams) {
      const key = `${stream.projectId}\u0000${stream.streamId}`;
      if (stream.currentVersion !== (maximumVersions.get(key) ?? 0n)) {
        issues.add("STREAM_HEAD_VERSION_MISMATCH", { streamId: stream.streamId });
      }
    }
  }

  private checkCommands(
    commands: readonly CommandRow[],
    events: readonly EventIndexRow[],
    issues: IssueCollector,
    fullEventRows?: readonly SqliteRow[],
  ): void {
    const commandIds = new Set(commands.map((command) => command.commandId));
    const eventsByCommand = new Map<string, EventIndexRow[]>();
    const fullRowsByCommand = new Map<string, SqliteRow[]>();
    for (const row of fullEventRows ?? []) {
      const commandId = stringValue(row, "command_id");
      const rows = fullRowsByCommand.get(commandId) ?? [];
      rows.push(row);
      fullRowsByCommand.set(commandId, rows);
    }
    for (const event of events) {
      const ownEvents = eventsByCommand.get(event.commandId) ?? [];
      ownEvents.push(event);
      eventsByCommand.set(event.commandId, ownEvents);
      if (!commandIds.has(event.commandId)) {
        issues.add("ORPHAN_EVENT", {
          globalPosition: event.globalPosition.toString(),
          commandId: event.commandId,
        });
      }
    }
    for (const command of commands) {
      const ownEvents = eventsByCommand.get(command.commandId) ?? [];
      const firstOwnEvent = ownEvents[0];
      const lastOwnEvent = ownEvents.at(-1);
      const rangeEventCount = eventCountInRange(
        events,
        command.firstGlobalPosition,
        command.lastGlobalPosition,
      );
      const ownRangeEventCount = eventCountInRange(
        ownEvents,
        command.firstGlobalPosition,
        command.lastGlobalPosition,
      );
      const span = command.lastGlobalPosition - command.firstGlobalPosition + 1n;
      if (ownEvents.length === 0) {
        issues.add("ORPHAN_COMMAND", { commandId: command.commandId });
      }
      const hasForeignRangeEvent = rangeEventCount > ownRangeEventCount;
      if (hasForeignRangeEvent) {
        issues.add("COMMAND_RANGE_FOREIGN_EVENT", { commandId: command.commandId });
      }
      if (
        ownEvents.length !== ownRangeEventCount
        || BigInt(rangeEventCount) < span
        || (lastOwnEvent !== undefined
          && command.finalStreamVersion !== lastOwnEvent.streamVersion)
      ) {
        issues.add("COMMAND_RANGE_MISSING_EVENT", { commandId: command.commandId });
      }
      for (let index = 0; index < ownEvents.length; index += 1) {
        if (ownEvents[index]!.commandEventIndex !== BigInt(index)) {
          issues.add("COMMAND_EVENT_INDEX_MISMATCH", { commandId: command.commandId });
          break;
        }
      }
      try {
        const storedEventIds = canonicalJsonValue(command.eventIdsJson);
        const observedEventIds = ownEvents.map((event) => event.eventId);
        if (
          !Array.isArray(storedEventIds)
          || storedEventIds.length !== observedEventIds.length
          || storedEventIds.some((value, index) => value !== observedEventIds[index])
        ) {
          issues.add("COMMAND_RANGE_MISSING_EVENT", { commandId: command.commandId });
        }
      } catch {
        issues.add("COMMAND_RANGE_MISSING_EVENT", { commandId: command.commandId });
      }
      try {
        const response = jsonValue(command.responseJson);
        if (
          canonicalJson(response) !== command.responseJson
          || responseHash(response) !== command.responseHash
        ) {
          issues.add("COMMAND_RESPONSE_HASH_MISMATCH", { commandId: command.commandId });
        }
        const observedEventIds = ownEvents.map((event) => event.eventId);
        if (
          !plainRecord(response)
          || Object.keys(response).sort().join("\n") !== STORED_RESPONSE_KEYS
          || !Array.isArray(response.eventIds)
          || response.eventIds.length !== observedEventIds.length
          || response.eventIds.some((value, index) => value !== observedEventIds[index])
          || firstOwnEvent === undefined
          || lastOwnEvent === undefined
          || response.firstGlobalPosition !== firstOwnEvent.globalPosition.toString()
          || response.lastGlobalPosition !== lastOwnEvent.globalPosition.toString()
          || response.finalStreamVersion !== lastOwnEvent.streamVersion.toString()
        ) {
          issues.add("COMMAND_RANGE_MISSING_EVENT", { commandId: command.commandId });
        }
      } catch {
        issues.add("COMMAND_RESPONSE_HASH_MISMATCH", { commandId: command.commandId });
        issues.add("COMMAND_RANGE_MISSING_EVENT", { commandId: command.commandId });
      }
      if (fullEventRows !== undefined && ownEvents.length !== 0) {
        const commandEventRows = fullRowsByCommand.get(command.commandId) ?? [];
        this.checkCommandMetadata(command, ownEvents, commandEventRows, issues);
      }
    }
  }

  private checkCommandMetadata(
    command: CommandRow,
    events: readonly EventIndexRow[],
    rows: readonly SqliteRow[],
    issues: IssueCollector,
  ): void {
    const location = { commandId: command.commandId };
    const first = rows[0];
    let metadataMatches = rows.length === events.length
      && command.state === "committed"
      && command.commandType.trim().length !== 0
      && strictRfc3339(command.committedAt);
    if (first !== undefined) {
      const commonFields = [
        "project_id",
        "store_id",
        "workspace_id",
        "stream_id",
        "stream_type",
        "correlation_id",
        "agent_id",
        "branch_scope_id",
        "branch_ref",
      ] as const;
      for (const row of rows) {
        if (
          stringValue(row, "command_id") !== command.commandId
          || stringValue(row, "project_id") !== command.projectId
          || stringValue(row, "idempotency_key") !== command.idempotencyKey
          || stringValue(row, "recorded_at") !== command.committedAt
          || commonFields.some((field) => row[field] !== first[field])
        ) {
          metadataMatches = false;
        }
      }
    }
    if (events.some((event) => event.idempotencyKey !== command.idempotencyKey)) {
      metadataMatches = false;
    }
    if (!metadataMatches) issues.add("COMMAND_METADATA_MISMATCH", location);

    try {
      this.validateLifecycleOutboxDescriptors(command, rows);
      const expectedHash = command.commandType === "create-governed-note"
        ? this.reconstructGovernedNoteHash(command)
        : command.commandType === "retain-evidence-batch"
        ? this.reconstructRetainedEvidenceHash(command, rows)
        : command.lifecycleAuthorizationKind === null
        ? this.reconstructCommandHash(command, rows)
        : this.reconstructLifecycleIntentHash(command, rows);
      if (expectedHash !== command.commandHash) {
        issues.add("COMMAND_HASH_MISMATCH", location);
      }
    } catch (error) {
      if (error instanceof LifecycleOutboxInvalidError) {
        // The lifecycle intent witness remains the authoritative command hash;
        // an outbox descriptor failure must not redefine that hash domain.
        issues.add("COMMAND_METADATA_MISMATCH", location);
        return;
      }
      if (!isCommandWitnessInvalid(error)) throw error;
      issues.add("COMMAND_METADATA_MISMATCH", location);
      if (command.lifecycleAuthorizationKind !== null) {
        issues.add("COMMAND_HASH_MISMATCH", location);
      }
    }
  }

  private validateLifecycleOutboxDescriptors(
    command: CommandRow,
    sourceRows: readonly SqliteRow[],
  ): void {
    const invalid = (): never => {
      throw new LifecycleOutboxInvalidError("LIFECYCLE_OUTBOX_INVALID");
    };
    let parsedOrder: unknown;
    try {
      parsedOrder = canonicalJsonValue(command.outboxOrderJson);
    } catch {
      return invalid();
    }
    if (
      !Array.isArray(parsedOrder)
      || parsedOrder.some((target) => typeof target !== "string" || target.length === 0)
      || new Set(parsedOrder).size !== parsedOrder.length
    ) return invalid();
    const outboxColumns = new Set(this.connection.prepare(`
      PRAGMA table_info(outbox)
    `).all().map((row) => row.name));
    if (!outboxColumns.has("artifact_kind")) return;
    if ([
      "session_id",
      "origin_kind",
      "workflow_id",
      "workflow_generation",
      "artifact_path",
      "materialization_revision",
      "next_fingerprint",
      "fingerprint_algorithm",
      "fingerprint_schema_version",
      "fingerprint_key_id",
      "fingerprint_domain",
    ].some((column) => !outboxColumns.has(column))) return invalid();
    const outboxRows = this.connection.prepare(`
      SELECT outbox.target_key, outbox.kind, outbox.payload_json,
             outbox.content_hash, outbox.event_position,
             outbox.session_id, outbox.origin_kind, outbox.workflow_id,
             outbox.workflow_generation, outbox.artifact_kind,
             outbox.artifact_path, outbox.materialization_revision,
             outbox.next_fingerprint, outbox.fingerprint_algorithm,
             outbox.fingerprint_schema_version, outbox.fingerprint_key_id,
             outbox.fingerprint_domain,
             events.global_position AS triggering_global_position,
             events.event_type AS triggering_event_type,
             events.event_schema_version AS triggering_event_schema_version,
             events.payload_json AS triggering_payload_json,
             events.payload_hash AS triggering_payload_hash,
             events.command_event_index AS triggering_command_event_index,
             events.command_id AS triggering_command_id,
             events.session_id AS triggering_session_id,
             events.parent_session_id AS triggering_parent_session_id,
             events.stream_type AS triggering_stream_type,
             events.stream_id AS triggering_stream_id
      FROM outbox
      LEFT JOIN events
        ON events.project_id = outbox.project_id
       AND events.global_position = outbox.event_position
      WHERE outbox.project_id = $projectId
        AND outbox.target_key IN (${parsedOrder.map((_, index) => `$target${index}`).join(", ")})
    `).all({
      $projectId: command.projectId,
      ...Object.fromEntries(parsedOrder.map((target, index) => [`$target${index}`, target])),
    } as SqliteParams);
    if (outboxRows.length !== parsedOrder.length) return invalid();
    const rowsByTarget = new Map<string, SqliteRow>();
    for (const row of outboxRows) {
      const target = stringValue(row, "target_key");
      if (rowsByTarget.has(target)) return invalid();
      rowsByTarget.set(target, row);
    }
    for (const targetValue of parsedOrder) {
      const target = targetValue as string;
      const row = rowsByTarget.get(target);
      if (row === undefined) return invalid();
      const kind = stringValue(row, "kind");
      if (kind !== "materialize-lifecycle-log") continue;
      if (command.lifecycleAuthorizationKind === null) return invalid();

      let payload: LifecycleMaterializationPayloadV1;
      try {
        const pending = decodePendingLifecycleOutboxV1({
          targetKey: target,
          kind,
          eventIndex: 0,
          payload: canonicalJsonValue(stringValue(row, "payload_json")),
        });
        payload = pending.payload;
      } catch {
        return invalid();
      }
      if (outboxHash(payload) !== stringValue(row, "content_hash")) return invalid();
      const descriptor = payload;
      const origin = descriptor.origin;
      const nextFingerprint = descriptor.nextFingerprint;
      const eventPosition = bigintValue(row, "event_position");
      const triggeringPosition = row.triggering_global_position;
      if (
        typeof triggeringPosition !== "bigint"
        || triggeringPosition !== eventPosition
        || row.session_id !== descriptor.sessionId
        || row.origin_kind !== origin.kind
        || row.workflow_id !== origin.workflowId
        || row.workflow_generation !== (
          origin.workflowGeneration === null ? null : BigInt(origin.workflowGeneration)
        )
        || descriptor.artifactKind !== COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND
        || row.artifact_kind !== descriptor.artifactKind
        || row.artifact_path !== descriptor.artifactPath
        || descriptor.materializationRevision !== eventPosition.toString()
        || row.materialization_revision !== eventPosition
        || row.next_fingerprint !== nextFingerprint.value
        || row.fingerprint_algorithm !== nextFingerprint.algorithm
        || row.fingerprint_schema_version !== BigInt(nextFingerprint.schemaVersion)
        || row.fingerprint_key_id !== nextFingerprint.keyId
        || row.fingerprint_domain !== nextFingerprint.domain
        || descriptor.sessionId !== row.triggering_session_id
        || row.triggering_command_id !== command.commandId
        || row.triggering_parent_session_id !== null
        || row.triggering_stream_type !== "session"
        || row.triggering_stream_id !== `session/${String(descriptor.sessionId)}`
        || row.triggering_command_event_index !== 0n
        || row.triggering_event_type !== descriptor.triggeringEventType
        || row.triggering_payload_hash !== descriptor.triggeringPayloadHash
      ) return invalid();
      const eventType = descriptor.triggeringEventType;
      if (typeof eventType !== "string") return invalid();
      const expectedSchemaVersion = eventType === "SessionCheckpointRecorded"
        || eventType === "SessionEndAmended"
        || eventType === "SessionEndCancelled"
        ? 3
        : 1;
      if (row.triggering_event_schema_version !== BigInt(expectedSchemaVersion)) return invalid();
      let eventPayload: unknown;
      try {
        eventPayload = canonicalJsonValue(String(row.triggering_payload_json));
        if (payloadHash(eventPayload) !== String(row.triggering_payload_hash)) return invalid();
        const decoded = decodeLifecycleEventPayload(
          eventType as LifecycleEventType,
          expectedSchemaVersion,
          eventPayload,
        ) as Record<string, unknown>;
        if (canonicalJson(decoded) !== String(row.triggering_payload_json)) return invalid();
        if (origin.kind === "terminal-event") {
          if (
            eventType !== "SessionAbandoned"
            || decoded.workflowId !== null
            || decoded.workflowGeneration !== null
          ) return invalid();
        } else if (
          origin.kind !== "workflow"
          || decoded.workflowId !== origin.workflowId
          || decoded.workflowGeneration !== origin.workflowGeneration
        ) return invalid();
      } catch {
        return invalid();
      }
      const starts = this.connection.prepare(`
        SELECT occurred_at
        FROM events
        WHERE project_id = $projectId
          AND session_id = $sessionId
          AND stream_id = $streamId
          AND stream_version = 1
          AND event_type = 'SessionStarted'
          AND event_schema_version = 1
        LIMIT 2
      `).all({
        $projectId: command.projectId,
        $sessionId: String(descriptor.sessionId),
        $streamId: `session/${String(descriptor.sessionId)}`,
      });
      if (
        starts.length !== 1
        || typeof starts[0]?.occurred_at !== "string"
        || descriptor.artifactPath
          !== `05_Agent_Session_Logs/${String(starts[0]!.occurred_at).slice(0, 10)}-session-${String(descriptor.sessionId)}.md`
      ) return invalid();
      const sourceEvent = sourceRows.find((candidate) => (
        candidate.command_event_index === 0n
      ));
      if (
        sourceEvent === undefined
        || bigintValue(sourceEvent, "command_event_index") !== 0n
        || bigintValue(sourceEvent, "global_position") !== eventPosition
      ) return invalid();
    }
  }

  private reconstructLifecycleIntentHash(
    command: CommandRow,
    sourceRows: readonly SqliteRow[],
  ): string {
    const invalid = (): never => {
      throw new CommandWitnessInvalidError("COMMAND_WITNESS_INVALID");
    };
    const rows = [...sourceRows].sort((left, right) => {
      const leftIndex = bigintValue(left, "command_event_index");
      const rightIndex = bigintValue(right, "command_event_index");
      return leftIndex === rightIndex ? 0 : leftIndex < rightIndex ? -1 : 1;
    });
    let witnessSource: string | undefined;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const source = row.lifecycle_intent_json;
      if (source !== null && source !== undefined && typeof source !== "string") return invalid();
      if (typeof source !== "string") continue;
      if (index !== 0 || bigintValue(row, "command_event_index") !== 0n) return invalid();
      const sessionId = nullableStringValue(row, "session_id");
      if (
        stringValue(row, "stream_type") !== "session"
        || sessionId === null
        || stringValue(row, "stream_id") !== `session/${sessionId}`
        || !LIFECYCLE_EVENT_TYPES.has(stringValue(row, "event_type"))
      ) {
        return invalid();
      }
      if (witnessSource !== undefined) return invalid();
      witnessSource = source;
    }
    if (witnessSource === undefined) return invalid();
    try {
      const witness = decodeLifecycleIntentWitness(witnessSource);
      const assertions = witness.persistedAssertions;
      const generation = command.internalWorkflowGeneration === null
        ? null
        : safeNumber(command.internalWorkflowGeneration);
      const proofFields = [
        command.authorizationProofVersion,
        command.authorizationProofNonce,
        command.authorizationProofDigest,
      ];
      const proofPresent = proofFields.every((value) => value !== null);
      const proofAbsent = proofFields.every((value) => value === null);
      const capabilityPairPresent = assertions.capabilityKind !== null
        && assertions.capabilityGeneration !== null;
      if (
        (!proofPresent && !proofAbsent)
        || proofPresent !== capabilityPairPresent
        || assertions.authorizationKind !== command.lifecycleAuthorizationKind
        || assertions.authorizationSessionId !== command.authorizationSessionId
        || assertions.targetSessionId !== command.targetSessionId
        || assertions.presentingActorRole !== command.presentingActorRole
        || assertions.presentingClientInstanceId !== command.presentingClientInstanceId
        || assertions.targetActorRole !== command.targetActorRole
        || assertions.targetClientInstanceId !== command.targetClientInstanceId
        || assertions.internalWorkflowId !== command.internalWorkflowId
        || assertions.internalWorkflowGeneration !== generation
        || assertions.internalPlannedWorkId !== command.internalPlannedWorkId
      ) return invalid();

      const first = rows[0]!;
      const semanticCommand = witness.intent.command;
      const binding = witness.intent.binding;
      const firstSessionId = nullableStringValue(first, "session_id");
      const childCreationCommand = semanticCommand.commandType === "fork-child"
        ? semanticCommand.parentSessionId === assertions.targetSessionId && rows.length === 1
        : semanticCommand.commandType === "claim-child-transfer"
          && semanticCommand.rootSessionId === assertions.targetSessionId
          && rows.length === 2
          && stringValue(rows[1]!, "event_type") === "ChildWorkTransferClaimed";
      const ordinaryTargetBinding = assertions.targetSessionId === firstSessionId;
      const childCreationBinding = assertions.authorizationKind === "protected"
        && typeof assertions.targetSessionId === "string"
        && assertions.authorizationSessionId === assertions.targetSessionId
        && childCreationCommand
        && firstSessionId !== null
        && firstSessionId !== assertions.targetSessionId
        && stringValue(first, "event_type") === "SessionForked"
        && nullableStringValue(first, "parent_session_id") === assertions.targetSessionId
        && rows.every((row) => nullableStringValue(row, "session_id") === firstSessionId
          && nullableStringValue(row, "parent_session_id") === assertions.targetSessionId
          && stringValue(row, "stream_type") === "session"
          && stringValue(row, "stream_id") === `session/${firstSessionId}`);
      if (
        semanticCommand.commandId !== command.commandId
        || semanticCommand.idempotencyKey !== command.idempotencyKey
        || semanticCommand.commandType !== command.commandType
        || semanticCommand.agentId !== stringValue(first, "agent_id")
        || binding.projectId !== stringValue(first, "project_id")
        || binding.vaultId !== stringValue(first, "vault_id")
        || binding.storeId !== stringValue(first, "store_id")
        || binding.workspaceId !== stringValue(first, "workspace_id")
        || semanticCommand.expectedProjectId !== stringValue(first, "project_id")
        || semanticCommand.expectedVaultId !== stringValue(first, "vault_id")
        || semanticCommand.expectedWorkspaceId !== stringValue(first, "workspace_id")
        || semanticCommand.expectedBranchRef !== nullableStringValue(first, "branch_ref")
        || (!ordinaryTargetBinding && !childCreationBinding)
        || assertions.presentingActorRole !== stringValue(first, "actor_role")
        || assertions.presentingClientInstanceId !== stringValue(first, "client_instance_id")
      ) return invalid();

      if (assertions.authorizationKind !== "initial-authority") {
        if (assertions.authorizationSessionId === null) return invalid();
        const authorityRows = this.connection.prepare(`
          SELECT workspace_id, client_namespace
          FROM session_authority
          WHERE project_id = $projectId AND session_id = $sessionId
        `).all({
          $projectId: binding.projectId,
          $sessionId: assertions.authorizationSessionId,
        });
        if (
          authorityRows.length !== 1
          || stringValue(authorityRows[0]!, "workspace_id") !== binding.workspaceId
          || stringValue(authorityRows[0]!, "client_namespace") !== binding.clientNamespace
        ) return invalid();
      }

      if (semanticCommand.commandType === "root-start") {
        const payload = canonicalJsonValue(stringValue(first, "payload_json"));
        const storedResponse = canonicalJsonValue(command.responseJson);
        if (
          stringValue(first, "event_type") !== "SessionStarted"
          || !plainRecord(payload)
          || payload.sessionKind !== "root"
          || payload.ownerGeneration !== 1
          || payload.continuityKey !== semanticCommand.continuityKey
          || payload.clientNamespace !== binding.clientNamespace
          || payload.creatingAgentId !== semanticCommand.agentId
          || payload.creatingClientInstanceId !== assertions.targetClientInstanceId
          || !plainRecord(storedResponse)
          || !plainRecord(storedResponse.response)
          || storedResponse.response.sessionId !== assertions.targetSessionId
        ) return invalid();
      }
      return lifecycleIntentHashFromWitnessSource(witnessSource);
    } catch {
      return invalid();
    }
  }

  private reconstructCommandHash(
    command: CommandRow,
    sourceRows: readonly SqliteRow[],
  ): string {
    const invalid = (): never => {
      throw new CommandWitnessInvalidError("COMMAND_WITNESS_INVALID");
    };
    const rows = [...sourceRows].sort((left, right) => {
      const leftIndex = bigintValue(left, "command_event_index");
      const rightIndex = bigintValue(right, "command_event_index");
      return leftIndex === rightIndex ? 0 : leftIndex < rightIndex ? -1 : 1;
    });
    const first = rows[0];
    if (first === undefined) return invalid();
    const tupleFields = [
      "project_id",
      "store_id",
      "workspace_id",
      "stream_id",
      "stream_type",
      "correlation_id",
      "agent_id",
      "branch_scope_id",
      "branch_ref",
    ] as const;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (
        bigintValue(row, "command_event_index") !== BigInt(index)
        || tupleFields.some((field) => row[field] !== first[field])
        || !this.matchesEventHash(row)
      ) {
        return invalid();
      }
      const payload = canonicalJsonValue(stringValue(row, "payload_json"));
      if (payloadHash(payload) !== stringValue(row, "payload_hash")) return invalid();
    }

    const branchScopeId = nullableStringValue(first, "branch_scope_id");
    const branchRef = nullableStringValue(first, "branch_ref");
    const workspaceHeadCommit = command.workspaceHeadCommit;
    let git: {
      headCommit: string;
      branchRef: string | null;
      detached: boolean;
    } | null;
    if (branchScopeId === null) {
      if (branchRef !== null || workspaceHeadCommit !== null) return invalid();
      git = null;
    } else {
      if (
        branchScopeId.length === 0
        || workspaceHeadCommit === null
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(workspaceHeadCommit)
        || (branchRef !== null && branchRef.length === 0)
      ) {
        return invalid();
      }
      const scopeRows = this.connection.prepare(`
        SELECT created_head
        FROM branch_scopes
        WHERE project_id = $projectId AND branch_scope_id = $branchScopeId
      `).all({
        $projectId: stringValue(first, "project_id"),
        $branchScopeId: branchScopeId,
      });
      if (
        scopeRows.length !== 1
        || (branchRef === null
          && stringValue(scopeRows[0]!, "created_head") !== workspaceHeadCommit)
      ) {
        return invalid();
      }
      git = {
        headCommit: workspaceHeadCommit,
        branchRef,
        detached: branchRef === null,
      };
    }

    const parsedOrder = canonicalJsonValue(command.outboxOrderJson);
    if (
      !Array.isArray(parsedOrder)
      || parsedOrder.some((target) => typeof target !== "string" || target.length === 0)
      || new Set(parsedOrder).size !== parsedOrder.length
    ) {
      return invalid();
    }
    const outboxRows = this.connection.prepare(`
      SELECT outbox.target_key, outbox.kind, outbox.payload_json,
             outbox.content_hash, outbox.event_position, events.command_event_index
      FROM outbox
      JOIN events ON events.global_position = outbox.event_position
      WHERE outbox.project_id = $projectId
        AND events.project_id = $projectId
        AND events.command_id = $commandId
    `).all({
      $projectId: command.projectId,
      $commandId: command.commandId,
    });
    if (outboxRows.length !== parsedOrder.length) return invalid();
    const outboxByTarget = new Map<string, SqliteRow>();
    for (const row of outboxRows) {
      const targetKey = stringValue(row, "target_key");
      if (outboxByTarget.has(targetKey)) return invalid();
      outboxByTarget.set(targetKey, row);
    }
    const outbox = parsedOrder.map((targetKey) => {
      const row = outboxByTarget.get(targetKey as string);
      if (row === undefined) return invalid();
      const eventIndex = safeNumber(bigintValue(row, "command_event_index"));
      const payload = canonicalJsonValue(stringValue(row, "payload_json"));
      if (
        eventIndex === undefined
        || rows[eventIndex] === undefined
        || bigintValue(row, "event_position") !== bigintValue(rows[eventIndex]!, "global_position")
        || outboxHash(payload) !== stringValue(row, "content_hash")
      ) {
        return invalid();
      }
      const kind = stringValue(row, "kind");
      if (kind.length === 0) return invalid();
      return {
        targetKey: targetKey as string,
        kind,
        eventIndex,
        payload,
      };
    });
    const normalizedEvents = rows.map((row) => {
      const eventSchemaVersion = safeNumber(bigintValue(row, "event_schema_version"));
      if (eventSchemaVersion === undefined) return invalid();
      return {
        eventType: stringValue(row, "event_type"),
        eventSchemaVersion,
        occurredAt: stringValue(row, "occurred_at"),
        visibilityScope: stringValue(row, "visibility_scope"),
        sessionId: nullableStringValue(row, "session_id"),
        parentSessionId: nullableStringValue(row, "parent_session_id"),
        causationId: nullableStringValue(row, "causation_id"),
        confidence: stringValue(row, "confidence"),
        verificationStatus: stringValue(row, "verification_status"),
        payload: canonicalJsonValue(stringValue(row, "payload_json")),
        sourceRefs: canonicalJsonValue(stringValue(row, "source_refs_json")),
        evidenceRefs: canonicalJsonValue(stringValue(row, "evidence_refs_json")),
        evidenceDigests: canonicalJsonValue(stringValue(row, "evidence_digests_json")),
      };
    });
    const firstStreamVersion = bigintValue(first, "stream_version");
    if (firstStreamVersion < 1n) return invalid();
    return commandHash({
      commandId: command.commandId,
      commandType: command.commandType,
      projectId: command.projectId,
      storeId: stringValue(first, "store_id"),
      workspaceId: stringValue(first, "workspace_id"),
      git,
      streamId: stringValue(first, "stream_id"),
      streamType: stringValue(first, "stream_type"),
      expectedStreamVersion: (firstStreamVersion - 1n).toString(),
      correlationId: stringValue(first, "correlation_id"),
      agentId: stringValue(first, "agent_id"),
      events: normalizedEvents,
      outbox,
    });
  }

  private reconstructRetainedEvidenceHash(command: CommandRow, rows: readonly SqliteRow[]): string {
    try {
      if (rows.length !== 1 || command.lifecycleAuthorizationKind !== null) throw new Error();
      const event = storedEventForAuthentication(rows[0]!);
      const payload = assertRetainedStoredEvent(event); if (!payload) throw new Error();
      assertStoredRetainedEvidenceCorrespondence(this.connection, event);
      return retainedEvidenceIntentHash(payload.witness);
    } catch { throw new CommandWitnessInvalidError("COMMAND_WITNESS_INVALID"); }
  }

  private reconstructGovernedNoteHash(command: CommandRow): string {
    try {
      const prior = new GovernedNoteRepository(this.connection).findGovernedNotePrior(command.commandId, command.idempotencyKey);
      if (!prior) throw new Error(); return prior.commandHash;
    } catch { throw new CommandWitnessInvalidError("COMMAND_WITNESS_INVALID"); }
  }

  private checkEventRows(
    context: ProjectContext,
    rows: readonly SqliteRow[],
    options: {
      expectedFirst: bigint;
      expectedPreviousHash: string | undefined;
      verifyTimestamps: boolean;
      verifyStreamVersions: boolean;
      initialStreamVersions: Map<string, bigint>;
    },
    issues: IssueCollector,
  ): void {
    let expectedPosition = options.expectedFirst;
    let expectedPreviousHash = options.expectedPreviousHash;
    const streamVersions = new Map(options.initialStreamVersions);
    for (const row of rows) {
      const position = bigintValue(row, "global_position");
      const globalPosition = position.toString();
      const streamId = stringValue(row, "stream_id");
      try {
        const stored = storedEventForAuthentication(row);
        try {
          authenticateStoredEvent(stored, {
            expectedPosition,
            previousEventHash: expectedPreviousHash ?? "",
          });
        } finally {
          // Even a broken incoming chain cursor must not suppress companion authentication.
          assertStoredGovernedNoteCorrespondence(this.connection, stored);
        }
        assertStoredRetainedEvidenceCorrespondence(this.connection, stored);
      } catch (error) {
        if (error instanceof StoredEventAuthenticationError) {
          if (error.failures.position) {
            issues.add("GLOBAL_POSITION_NONCONTIGUOUS", { globalPosition });
          }
          if (error.failures.predecessor) {
            issues.add("EVENT_PREVIOUS_HASH_MISMATCH", { globalPosition });
          }
          if (error.failures.payload) {
            issues.add("EVENT_PAYLOAD_HASH_MISMATCH", { globalPosition });
          }
          if (error.failures.eventHash) {
            issues.add("EVENT_HASH_MISMATCH", { globalPosition });
          }
        } else {
          issues.add("EVENT_HASH_MISMATCH", { globalPosition });
        }
      }
      if (options.verifyTimestamps) {
        if (
          !strictRfc3339(stringValue(row, "occurred_at"))
          || !strictRfc3339(stringValue(row, "recorded_at"))
        ) {
          issues.add("EVENT_TIMESTAMP_INVALID", { globalPosition });
        }
      }
      if (options.verifyStreamVersions) {
        const observedVersion = bigintValue(row, "stream_version");
        const expectedVersion = (streamVersions.get(streamId) ?? 0n) + 1n;
        if (observedVersion !== expectedVersion) {
          issues.add("STREAM_VERSION_NONCONTIGUOUS", { globalPosition, streamId });
        }
        streamVersions.set(streamId, observedVersion);
      }
      const event = eventIndex(row);
      this.checkEventIdentities(context, [event], issues);
      expectedPosition = position + 1n;
      expectedPreviousHash = event.eventHash;
    }
  }

  private matchesEventHash(row: SqliteRow): boolean {
    try {
      const event = storedEventForAuthentication(row);
      authenticateStoredEvent(event, {
        expectedPosition: event.globalPosition,
        previousEventHash: event.previousGlobalHash,
      });
      return true;
    } catch (error) {
      return error instanceof StoredEventAuthenticationError
        ? !error.failures.eventHash
        : false;
    }
  }

  private predecessor(
    firstPosition: bigint,
    events: readonly EventIndexRow[],
  ): EventIndexRow | undefined {
    if (firstPosition <= 1n) return undefined;
    return events.find((event) => event.globalPosition === firstPosition - 1n);
  }

  private report(
    mode: IntegrityMode,
    context: ProjectContext,
    observedSchemaFingerprint: string,
    events: readonly EventIndexRow[],
    streamsVerified: number,
    commandsVerified: number,
    collector: IssueCollector,
    requestedFirst?: bigint,
    requestedLast?: bigint,
  ): IntegrityReport {
    const issues = collector.sorted();
    const first = requestedFirst ?? events[0]?.globalPosition ?? 0n;
    const last = requestedLast ?? events.at(-1)?.globalPosition ?? 0n;
    const terminal = events.find((event) => event.globalPosition === last)?.eventHash
      ?? events.at(-1)?.eventHash
      ?? GENESIS_GLOBAL_HASH;
    return {
      ok: issues.length === 0,
      mode,
      projectId: context.binding.projectId,
      storeId: context.binding.storeId,
      firstGlobalPosition: first.toString(),
      lastGlobalPosition: last.toString(),
      eventsVerified: events.length,
      streamsVerified,
      commandsVerified,
      schemaFingerprint: observedSchemaFingerprint,
      terminalEventHash: terminal,
      issues,
    };
  }
}
