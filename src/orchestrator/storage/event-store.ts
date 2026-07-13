import { randomUUID } from "node:crypto";
import type {
  AppendCommand,
  AppendResult,
  JsonValue,
  PendingOutbox,
  StoredEvent,
  VisibilityScope,
} from "../contracts/event.js";
import {
  commandHash,
  eventHash,
  outboxHash,
  payloadHash,
  responseHash,
} from "../crypto/event-hash.js";
import type {
  BranchScopeId,
  ProjectId,
} from "../identity/contracts.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { BranchScopeRepository } from "./branch-scope.repository.js";
import {
  MaintenanceFence,
  MaintenanceFenceError,
} from "./maintenance-fence.js";
import type {
  SqliteConnection,
  SqliteStatement,
} from "./sqlite-driver.js";

export const MAX_EVENTS_PER_COMMAND = 128;
export const MAX_CANONICAL_COMMAND_BYTES = 4 * 1024 * 1024;
export const GENESIS_GLOBAL_HASH = "0".repeat(64);

export type EventStoreFaultBoundary =
  | "before-begin"
  | "after-first-insert-before-commit"
  | "after-commit-before-response";

export interface EventStoreFaultContext {
  projectId: string;
  commandId: string;
  idempotencyKey: string;
}

export interface EventStoreFaultInjector {
  hit(boundary: EventStoreFaultBoundary, context: EventStoreFaultContext): void;
}

export const NO_EVENT_STORE_FAULTS: EventStoreFaultInjector = {
  hit: () => undefined,
};

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9]\d*)$/;
const VISIBILITY_SCOPES = new Set<VisibilityScope>([
  "session",
  "workspace",
  "branch",
  "project",
  "global",
]);
const CONFIDENCE_VALUES = new Set(["high", "medium", "low", "guess"]);
const VERIFICATION_VALUES = new Set([
  "unverified",
  "provisional",
  "verified",
  "conflicted",
]);
const ACTOR_ROLES = new Set(["primary", "maintenance", "untrusted"]);

export class EventStoreError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: Record<string, JsonValue> = {},
  ) {
    super(code);
    this.name = "EventStoreError";
  }
}

interface ValidatedAppendCommand {
  recordedAt: string;
  hashMaterial: JsonValue;
  canonicalBytes: number;
  eventIds: string[];
  payloadJson: string[];
  payloadHashes: string[];
}

interface DedupRow {
  commandId: string;
  commandHash: string;
  responseJson: string;
  responseHash: string;
}

interface GlobalTail {
  globalPosition: bigint;
  eventHash: string;
}

interface StreamHead {
  currentVersion: bigint;
  streamType: string;
}

interface StoredCommandResponse<TResponse extends JsonValue> {
  eventIds: string[];
  firstGlobalPosition: string;
  lastGlobalPosition: string;
  finalStreamVersion: string;
  response: TResponse;
}

interface EventStoreStatements {
  matchesProjectIdentity(projectId: string, vaultId: string, storeId: string): boolean;
  findDedup(projectId: string, idempotencyKey: string): DedupRow | undefined;
  findCommandId(projectId: string, commandId: string): { idempotencyKey: string } | undefined;
  readStream(projectId: string, streamId: string): StreamHead | undefined;
  insertStream(projectId: string, streamId: string, streamType: string, now: string): void;
  readGlobalTail(): GlobalTail;
  insertEvent(event: StoredEvent): void;
  compareAndSwapStream(
    projectId: string,
    streamId: string,
    expected: bigint,
    next: bigint,
    now: string,
  ): bigint;
  insertOutbox(
    projectId: string,
    pending: PendingOutbox,
    event: StoredEvent,
    contentHash: string,
    now: string,
  ): void;
  insertDedup<T extends JsonValue>(
    command: AppendCommand<T>,
    commandHashValue: string,
    response: StoredCommandResponse<T>,
    responseHashValue: string,
    now: string,
  ): void;
}

function canonical(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    throw new EventStoreError("CANONICAL_VALUE_INVALID");
  }
}

function canonicalIntegrity(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
}

function assertCanonicalRfc3339(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new EventStoreError("TIMESTAMP_INVALID", { field });
  }
  const match = RFC3339.exec(value);
  if (match === null) throw new EventStoreError("TIMESTAMP_INVALID", { field });
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
  const valid = year >= 1
    && month >= 1 && month <= 12
    && day >= 1 && day <= (monthDays[month - 1] ?? 0)
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59
    && offsetHour >= 0 && offsetHour <= 23
    && offsetMinute >= 0 && offsetMinute <= 59;
  if (!valid) throw new EventStoreError("TIMESTAMP_INVALID", { field });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isPlainArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exactStringArray(value: unknown): value is string[] {
  return isPlainArray(value) && value.every((item) => typeof item === "string");
}

function sameWorkspace(
  left: unknown,
  right: unknown,
): boolean {
  if (!isPlainRecord(left) || !isPlainRecord(right) || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "git") {
    return left.worktreeRoot === right.worktreeRoot
      && left.gitDir === right.gitDir
      && left.gitCommonDir === right.gitCommonDir
      && left.headCommit === right.headCommit
      && left.branchRef === right.branchRef
      && left.detached === right.detached
      && left.workspaceId === right.workspaceId;
  }
  if (left.kind === "non-git") {
    return left.workspaceRoot === right.workspaceRoot
      && left.workspaceId === right.workspaceId;
  }
  return false;
}

function isCompleteWorkspace(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  if (value.kind === "git") {
    return nonEmptyString(value.worktreeRoot)
      && nonEmptyString(value.gitDir)
      && nonEmptyString(value.gitCommonDir)
      && nonEmptyString(value.headCommit)
      && nonEmptyString(value.workspaceId)
      && typeof value.detached === "boolean"
      && (value.detached
        ? value.branchRef === null
        : nonEmptyString(value.branchRef));
  }
  if (value.kind === "non-git") {
    return nonEmptyString(value.workspaceRoot)
      && nonEmptyString(value.workspaceId);
  }
  return false;
}

function validateProjectContext(command: AppendCommand<JsonValue>): void {
  const context = command.context as unknown;
  if (!isPlainRecord(context) || !isPlainRecord(context.binding)) {
    throw new EventStoreError("PROJECT_CONTEXT_MISMATCH");
  }
  const binding = context.binding;
  const workspace = context.workspace;
  if (
    !nonEmptyString(binding.projectId)
    || !nonEmptyString(binding.vaultId)
    || !nonEmptyString(binding.storeId)
    || !nonEmptyString(binding.workspaceId)
    || !nonEmptyString(binding.clientInstanceId)
    || !ACTOR_ROLES.has(binding.actorRole as string)
    || !Number.isSafeInteger(binding.generation)
    || Number(binding.generation) <= 0
    || !isCompleteWorkspace(binding.workspace)
    || !isCompleteWorkspace(workspace)
    || binding.workspaceId !== binding.workspace.workspaceId
    || binding.workspaceId !== workspace.workspaceId
    || !sameWorkspace(binding.workspace, workspace)
  ) {
    throw new EventStoreError("PROJECT_CONTEXT_MISMATCH");
  }
}

function optionalNonEmptyString(value: unknown): boolean {
  return value === undefined || nonEmptyString(value);
}

function validateAppendCommand<T extends JsonValue>(
  command: AppendCommand<T>,
  recordedAt: string,
  randomId: () => string,
): ValidatedAppendCommand {
  if (!isPlainRecord(command)) throw new EventStoreError("COMMAND_INVALID");
  validateProjectContext(command);
  if (typeof command.commandId !== "string" || !UUID.test(command.commandId)) {
    throw new EventStoreError("COMMAND_ID_INVALID");
  }
  assertCanonicalRfc3339(recordedAt, "recordedAt");
  for (const [field, value] of Object.entries({
    idempotencyKey: command.idempotencyKey,
    commandType: command.commandType,
    correlationId: command.correlationId,
    agentId: command.agentId,
    streamId: command.streamId,
    streamType: command.streamType,
  })) {
    if (!nonEmptyString(value)) throw new EventStoreError("COMMAND_INVALID", { field });
  }
  if (typeof command.expectedStreamVersion !== "bigint"
    || command.expectedStreamVersion < 0n
    || command.expectedStreamVersion > SQLITE_INT64_MAX) {
    throw new EventStoreError("EXPECTED_STREAM_VERSION_INVALID");
  }
  if (!isPlainArray(command.events)
    || command.events.length < 1
    || command.events.length > MAX_EVENTS_PER_COMMAND) {
    throw new EventStoreError("EVENT_BATCH_SIZE_INVALID");
  }
  if (command.expectedStreamVersion > SQLITE_INT64_MAX - BigInt(command.events.length)) {
    throw new EventStoreError("EXPECTED_STREAM_VERSION_INVALID");
  }
  if (!isPlainArray(command.outbox) || command.outbox.length > MAX_EVENTS_PER_COMMAND) {
    throw new EventStoreError("OUTBOX_BATCH_SIZE_INVALID");
  }

  const targetKeys = new Set<string>();
  const payloadJson: string[] = [];
  const payloadHashes: string[] = [];
  const eventIds: string[] = [];
  const normalizedEvents = command.events.map((event) => {
    if (!isPlainRecord(event)
      || !nonEmptyString(event.eventType)
      || !Number.isSafeInteger(event.eventSchemaVersion)
      || Number(event.eventSchemaVersion) <= 0
      || !VISIBILITY_SCOPES.has(event.visibilityScope as VisibilityScope)
      || !CONFIDENCE_VALUES.has(event.confidence as string)
      || !VERIFICATION_VALUES.has(event.verificationStatus as string)
      || !optionalNonEmptyString(event.sessionId)
      || !optionalNonEmptyString(event.parentSessionId)
      || !optionalNonEmptyString(event.causationId)
      || !exactStringArray(event.sourceRefs)
      || !isPlainArray(event.evidenceRefs)
      || !isPlainArray(event.evidenceDigests)) {
      throw new EventStoreError("EVENT_INVALID");
    }
    assertCanonicalRfc3339(event.occurredAt, "occurredAt");
    if (event.visibilityScope === "global") {
      throw new EventStoreError("GLOBAL_SCOPE_DENIED");
    }
    if (
      event.visibilityScope === "branch"
      && command.context.workspace.kind !== "git"
    ) {
      throw new EventStoreError("WORKSPACE_AMBIGUOUS");
    }
    if (event.visibilityScope === "session" && !nonEmptyString(event.sessionId)) {
      throw new EventStoreError("SESSION_NOT_FOUND");
    }
    if (event.evidenceRefs.length !== 0 || event.evidenceDigests.length !== 0) {
      throw new EventStoreError("EVIDENCE_NOT_AVAILABLE_IN_SUBPROJECT_1");
    }
    const json = canonical(event.payload);
    canonical(event.sourceRefs);
    payloadJson.push(json);
    payloadHashes.push(payloadHash(event.payload));
    const eventId = randomId();
    if (typeof eventId !== "string" || !UUID.test(eventId)) {
      throw new EventStoreError("EVENT_ID_INVALID");
    }
    eventIds.push(eventId);
    return {
      eventType: event.eventType,
      eventSchemaVersion: event.eventSchemaVersion,
      occurredAt: event.occurredAt,
      visibilityScope: event.visibilityScope,
      sessionId: event.sessionId ?? null,
      parentSessionId: event.parentSessionId ?? null,
      causationId: event.causationId ?? null,
      confidence: event.confidence,
      verificationStatus: event.verificationStatus,
      payload: event.payload,
      sourceRefs: event.sourceRefs,
      evidenceRefs: [] as JsonValue[],
      evidenceDigests: [] as JsonValue[],
    };
  });

  const normalizedOutbox = command.outbox.map((item) => {
    if (!isPlainRecord(item)
      || !nonEmptyString(item.targetKey)
      || !nonEmptyString(item.kind)) {
      throw new EventStoreError("OUTBOX_INVALID");
    }
    if (!Number.isSafeInteger(item.eventIndex)
      || Number(item.eventIndex) < 0
      || Number(item.eventIndex) >= command.events.length) {
      throw new EventStoreError("OUTBOX_EVENT_INDEX_INVALID");
    }
    if (targetKeys.has(item.targetKey)) {
      throw new EventStoreError("OUTBOX_TARGET_CONFLICT");
    }
    targetKeys.add(item.targetKey);
    canonical(item.payload);
    return {
      targetKey: item.targetKey,
      kind: item.kind,
      eventIndex: item.eventIndex,
      payload: item.payload,
    };
  });
  canonical(command.publicResponse);

  const hashMaterial: JsonValue = {
    commandId: command.commandId,
    commandType: command.commandType,
    projectId: command.context.binding.projectId,
    storeId: command.context.binding.storeId,
    workspaceId: command.context.binding.workspaceId,
    git: command.context.workspace.kind === "git" ? {
      headCommit: command.context.workspace.headCommit,
      branchRef: command.context.workspace.branchRef,
      detached: command.context.workspace.detached,
    } : null,
    streamId: command.streamId,
    streamType: command.streamType,
    expectedStreamVersion: command.expectedStreamVersion.toString(),
    correlationId: command.correlationId,
    agentId: command.agentId,
    events: normalizedEvents,
    outbox: normalizedOutbox,
  };
  const canonicalBytes = Buffer.byteLength(canonical(hashMaterial), "utf8");
  if (canonicalBytes > MAX_CANONICAL_COMMAND_BYTES) {
    throw new EventStoreError("COMMAND_TOO_LARGE");
  }
  return {
    recordedAt,
    hashMaterial,
    canonicalBytes,
    eventIds,
    payloadJson,
    payloadHashes,
  };
}

function buildStoredCommandResponse<T extends JsonValue>(
  publicResponse: T,
  events: StoredEvent[],
): StoredCommandResponse<T> {
  return {
    eventIds: events.map((event) => event.eventId),
    firstGlobalPosition: events[0]!.globalPosition.toString(),
    lastGlobalPosition: events.at(-1)!.globalPosition.toString(),
    finalStreamVersion: events.at(-1)!.streamVersion.toString(),
    response: publicResponse,
  };
}

function parseStoredDecimal(value: unknown): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
  const parsed = BigInt(value);
  if (parsed > SQLITE_INT64_MAX) throw new EventStoreError("INTEGRITY_FAILURE");
  return parsed;
}

function decodeStoredResponse<T extends JsonValue>(
  responseJson: string,
  expectedHash: string,
  deduplicated: boolean,
): AppendResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseJson) as unknown;
  } catch {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
  if (!isPlainRecord(parsed)
    || Object.keys(parsed).sort().join("\n") !== [
      "eventIds",
      "finalStreamVersion",
      "firstGlobalPosition",
      "lastGlobalPosition",
      "response",
    ].sort().join("\n")
    || canonicalIntegrity(parsed) !== responseJson
    || responseHash(parsed) !== expectedHash
    || !isPlainArray(parsed.eventIds)
    || parsed.eventIds.length < 1
    || parsed.eventIds.length > MAX_EVENTS_PER_COMMAND
    || parsed.eventIds.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
  const firstGlobalPosition = parseStoredDecimal(parsed.firstGlobalPosition);
  const lastGlobalPosition = parseStoredDecimal(parsed.lastGlobalPosition);
  const finalStreamVersion = parseStoredDecimal(parsed.finalStreamVersion);
  if (
    firstGlobalPosition < 1n
    || lastGlobalPosition < firstGlobalPosition
    || finalStreamVersion < 1n
    || new Set(parsed.eventIds).size !== parsed.eventIds.length
    || finalStreamVersion < BigInt(parsed.eventIds.length)
    || lastGlobalPosition - firstGlobalPosition + 1n !== BigInt(parsed.eventIds.length)
  ) {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
  canonicalIntegrity(parsed.response);
  return {
    deduplicated,
    firstGlobalPosition,
    lastGlobalPosition,
    finalStreamVersion,
    eventIds: parsed.eventIds as string[],
    response: parsed.response as T,
    responseHash: expectedHash,
  };
}

function materializeEvents<T extends JsonValue>(
  command: AppendCommand<T>,
  validated: ValidatedAppendCommand,
  tail: GlobalTail,
  branchScopeId: BranchScopeId | undefined,
): StoredEvent[] {
  if (tail.globalPosition > SQLITE_INT64_MAX - BigInt(command.events.length)) {
    throw new EventStoreError("GLOBAL_POSITION_EXHAUSTED");
  }
  let previousGlobalHash = tail.eventHash;
  return command.events.map((pending, index) => {
    const storedWithoutHash = {
      globalPosition: tail.globalPosition + BigInt(index + 1),
      eventId: validated.eventIds[index]!,
      projectId: command.context.binding.projectId,
      vaultId: command.context.binding.vaultId,
      storeId: command.context.binding.storeId,
      workspaceId: command.context.binding.workspaceId,
      branchScopeId: branchScopeId ?? null,
      branchRef: command.context.workspace.kind === "git"
        ? command.context.workspace.branchRef
        : null,
      streamId: command.streamId,
      streamType: command.streamType,
      streamVersion: command.expectedStreamVersion + BigInt(index + 1),
      eventType: pending.eventType,
      eventSchemaVersion: pending.eventSchemaVersion,
      sessionId: pending.sessionId ?? null,
      parentSessionId: pending.parentSessionId ?? null,
      actorRole: command.context.binding.actorRole,
      agentId: command.agentId,
      clientInstanceId: command.context.binding.clientInstanceId,
      correlationId: command.correlationId,
      causationId: pending.causationId ?? null,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      commandEventIndex: index,
      occurredAt: pending.occurredAt,
      recordedAt: validated.recordedAt,
      visibilityScope: pending.visibilityScope as Exclude<VisibilityScope, "global">,
      confidence: pending.confidence,
      verificationStatus: pending.verificationStatus,
      sourceRefs: pending.sourceRefs,
      evidenceRefs: [] as [],
      evidenceDigests: [] as [],
      payload: pending.payload,
      payloadJson: validated.payloadJson[index]!,
      payloadHash: validated.payloadHashes[index]!,
      previousGlobalHash,
    };
    const hashMaterial: Record<string, unknown> = {
      ...storedWithoutHash,
      globalPosition: storedWithoutHash.globalPosition.toString(),
      streamVersion: storedWithoutHash.streamVersion.toString(),
    };
    delete hashMaterial.payload;
    delete hashMaterial.payloadJson;
    const computedEventHash = eventHash(hashMaterial);
    previousGlobalHash = computedEventHash;
    return { ...storedWithoutHash, eventHash: computedEventHash };
  });
}

function isPrimarySqliteBusy(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "errcode" in error
    && typeof error.errcode === "number"
    && (error.errcode & 0xff) === 5;
}

function normalizeEventStoreError(error: unknown): EventStoreError {
  if (error instanceof EventStoreError) return error;
  if (error instanceof MaintenanceFenceError) {
    if (error.code === "MAINTENANCE_QUIESCING") {
      return new EventStoreError(error.code);
    }
    return new EventStoreError("STORE_UNAVAILABLE", { retryable: false });
  }
  if (isPrimarySqliteBusy(error)) {
    return new EventStoreError("SQLITE_BUSY", { retryable: true });
  }
  return new EventStoreError("STORE_UNAVAILABLE", { retryable: false });
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new EventStoreError("INTEGRITY_FAILURE");
  return value;
}

function requiredBigint(value: unknown, minimum: bigint): bigint {
  if (typeof value !== "bigint" || value < minimum || value > SQLITE_INT64_MAX) {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
  return value;
}

export class SqliteEventStoreStatements implements EventStoreStatements {
  readonly #identity: SqliteStatement;
  readonly #findDedup: SqliteStatement;
  readonly #findCommandId: SqliteStatement;
  readonly #readStream: SqliteStatement;
  readonly #insertStream: SqliteStatement;
  readonly #readGlobalTail: SqliteStatement;
  readonly #insertEvent: SqliteStatement;
  readonly #compareAndSwapStream: SqliteStatement;
  readonly #insertOutbox: SqliteStatement;
  readonly #insertDedup: SqliteStatement;

  constructor(connection: SqliteConnection) {
    this.#identity = connection.prepare(`
      SELECT project_id, vault_id, store_id
      FROM project_meta
      WHERE singleton = 1
    `);
    this.#findDedup = connection.prepare(`
      SELECT command_id, command_hash, response_json, response_hash
      FROM command_dedup
      WHERE project_id = $projectId AND idempotency_key = $idempotencyKey
    `);
    this.#findCommandId = connection.prepare(`
      SELECT idempotency_key
      FROM command_dedup
      WHERE project_id = $projectId AND command_id = $commandId
    `);
    this.#readStream = connection.prepare(`
      SELECT current_version, stream_type
      FROM streams
      WHERE project_id = $projectId AND stream_id = $streamId
    `);
    this.#insertStream = connection.prepare(`
      INSERT INTO streams(
        project_id, stream_id, stream_type, current_version, created_at, updated_at
      ) VALUES (
        $projectId, $streamId, $streamType, 0, $createdAt, $updatedAt
      )
    `);
    this.#readGlobalTail = connection.prepare(`
      SELECT global_position, event_hash
      FROM events
      ORDER BY global_position DESC
      LIMIT 1
    `);
    this.#insertEvent = connection.prepare(`
      INSERT INTO events(
        global_position, event_id, project_id, vault_id, store_id, workspace_id,
        branch_scope_id, branch_ref, stream_id, stream_type, stream_version,
        event_type, event_schema_version, session_id, parent_session_id,
        actor_role, agent_id, client_instance_id, correlation_id, causation_id,
        command_id, idempotency_key, command_event_index, occurred_at, recorded_at,
        visibility_scope, confidence, verification_status, source_refs_json,
        evidence_refs_json, evidence_digests_json, payload_json, payload_hash,
        previous_global_hash, event_hash
      ) VALUES (
        $globalPosition, $eventId, $projectId, $vaultId, $storeId, $workspaceId,
        $branchScopeId, $branchRef, $streamId, $streamType, $streamVersion,
        $eventType, $eventSchemaVersion, $sessionId, $parentSessionId,
        $actorRole, $agentId, $clientInstanceId, $correlationId, $causationId,
        $commandId, $idempotencyKey, $commandEventIndex, $occurredAt, $recordedAt,
        $visibilityScope, $confidence, $verificationStatus, $sourceRefsJson,
        $evidenceRefsJson, $evidenceDigestsJson, $payloadJson, $payloadHash,
        $previousGlobalHash, $eventHash
      )
    `);
    this.#compareAndSwapStream = connection.prepare(`
      UPDATE streams
      SET current_version = $next,
          updated_at = $updatedAt
      WHERE project_id = $projectId
        AND stream_id = $streamId
        AND current_version = $expected
    `);
    this.#insertOutbox = connection.prepare(`
      INSERT INTO outbox(
        project_id, target_key, event_position, kind, payload_json, content_hash,
        status, attempt_count, claim_owner, claim_token, claim_expires_at,
        created_at, updated_at
      ) VALUES (
        $projectId, $targetKey, $eventPosition, $kind, $payloadJson, $contentHash,
        'pending', 0, NULL, NULL, NULL, $createdAt, $updatedAt
      )
    `);
    this.#insertDedup = connection.prepare(`
      INSERT INTO command_dedup(
        project_id, idempotency_key, command_id, command_type, command_hash,
        state, first_global_position, last_global_position, final_stream_version,
        event_ids_json, response_json, response_hash, committed_at
      ) VALUES (
        $projectId, $idempotencyKey, $commandId, $commandType, $commandHash,
        'committed', $firstGlobalPosition, $lastGlobalPosition, $finalStreamVersion,
        $eventIdsJson, $responseJson, $responseHash, $committedAt
      )
    `);
  }

  matchesProjectIdentity(projectId: string, vaultId: string, storeId: string): boolean {
    const rows = this.#identity.all();
    return rows.length === 1
      && rows[0]?.project_id === projectId
      && rows[0]?.vault_id === vaultId
      && rows[0]?.store_id === storeId;
  }

  findDedup(projectId: string, idempotencyKey: string): DedupRow | undefined {
    const row = this.#findDedup.get({
      $projectId: projectId,
      $idempotencyKey: idempotencyKey,
    });
    if (row === undefined) return undefined;
    const commandId = requiredString(row.command_id);
    const commandHashValue = requiredString(row.command_hash);
    const responseJson = requiredString(row.response_json);
    const responseHashValue = requiredString(row.response_hash);
    if (!UUID.test(commandId) || !HASH.test(commandHashValue) || !HASH.test(responseHashValue)) {
      throw new EventStoreError("INTEGRITY_FAILURE");
    }
    return {
      commandId,
      commandHash: commandHashValue,
      responseJson,
      responseHash: responseHashValue,
    };
  }

  findCommandId(projectId: string, commandId: string): { idempotencyKey: string } | undefined {
    const row = this.#findCommandId.get({
      $projectId: projectId,
      $commandId: commandId,
    });
    if (row === undefined) return undefined;
    const idempotencyKey = requiredString(row.idempotency_key);
    if (idempotencyKey.length === 0) throw new EventStoreError("INTEGRITY_FAILURE");
    return { idempotencyKey };
  }

  readStream(projectId: string, streamId: string): StreamHead | undefined {
    const row = this.#readStream.get({ $projectId: projectId, $streamId: streamId });
    if (row === undefined) return undefined;
    const currentVersion = requiredBigint(row.current_version, 0n);
    const streamType = requiredString(row.stream_type);
    if (streamType.length === 0) throw new EventStoreError("INTEGRITY_FAILURE");
    return { currentVersion, streamType };
  }

  insertStream(
    projectId: string,
    streamId: string,
    streamType: string,
    now: string,
  ): void {
    this.#insertStream.run({
      $projectId: projectId,
      $streamId: streamId,
      $streamType: streamType,
      $createdAt: now,
      $updatedAt: now,
    });
  }

  readGlobalTail(): GlobalTail {
    const row = this.#readGlobalTail.get();
    if (row === undefined) {
      return { globalPosition: 0n, eventHash: GENESIS_GLOBAL_HASH };
    }
    const globalPosition = requiredBigint(row.global_position, 1n);
    const eventHashValue = requiredString(row.event_hash);
    if (!HASH.test(eventHashValue)) throw new EventStoreError("INTEGRITY_FAILURE");
    return { globalPosition, eventHash: eventHashValue };
  }

  insertEvent(event: StoredEvent): void {
    this.#insertEvent.run({
      $globalPosition: event.globalPosition,
      $eventId: event.eventId,
      $projectId: event.projectId,
      $vaultId: event.vaultId,
      $storeId: event.storeId,
      $workspaceId: event.workspaceId,
      $branchScopeId: event.branchScopeId,
      $branchRef: event.branchRef,
      $streamId: event.streamId,
      $streamType: event.streamType,
      $streamVersion: event.streamVersion,
      $eventType: event.eventType,
      $eventSchemaVersion: event.eventSchemaVersion,
      $sessionId: event.sessionId,
      $parentSessionId: event.parentSessionId,
      $actorRole: event.actorRole,
      $agentId: event.agentId,
      $clientInstanceId: event.clientInstanceId,
      $correlationId: event.correlationId,
      $causationId: event.causationId,
      $commandId: event.commandId,
      $idempotencyKey: event.idempotencyKey,
      $commandEventIndex: event.commandEventIndex,
      $occurredAt: event.occurredAt,
      $recordedAt: event.recordedAt,
      $visibilityScope: event.visibilityScope,
      $confidence: event.confidence,
      $verificationStatus: event.verificationStatus,
      $sourceRefsJson: canonical(event.sourceRefs),
      $evidenceRefsJson: "[]",
      $evidenceDigestsJson: "[]",
      $payloadJson: event.payloadJson,
      $payloadHash: event.payloadHash,
      $previousGlobalHash: event.previousGlobalHash,
      $eventHash: event.eventHash,
    });
  }

  compareAndSwapStream(
    projectId: string,
    streamId: string,
    expected: bigint,
    next: bigint,
    now: string,
  ): bigint {
    return this.#compareAndSwapStream.run({
      $next: next,
      $updatedAt: now,
      $projectId: projectId,
      $streamId: streamId,
      $expected: expected,
    }).changes;
  }

  insertOutbox(
    projectId: string,
    pending: PendingOutbox,
    event: StoredEvent,
    contentHash: string,
    now: string,
  ): void {
    this.#insertOutbox.run({
      $projectId: projectId,
      $targetKey: pending.targetKey,
      $eventPosition: event.globalPosition,
      $kind: pending.kind,
      $payloadJson: canonical(pending.payload),
      $contentHash: contentHash,
      $createdAt: now,
      $updatedAt: now,
    });
  }

  insertDedup<T extends JsonValue>(
    command: AppendCommand<T>,
    commandHashValue: string,
    response: StoredCommandResponse<T>,
    responseHashValue: string,
    now: string,
  ): void {
    this.#insertDedup.run({
      $projectId: command.context.binding.projectId,
      $idempotencyKey: command.idempotencyKey,
      $commandId: command.commandId,
      $commandType: command.commandType,
      $commandHash: commandHashValue,
      $firstGlobalPosition: BigInt(response.firstGlobalPosition),
      $lastGlobalPosition: BigInt(response.lastGlobalPosition),
      $finalStreamVersion: BigInt(response.finalStreamVersion),
      $eventIdsJson: canonical(response.eventIds),
      $responseJson: canonical(response),
      $responseHash: responseHashValue,
      $committedAt: now,
    });
  }
}

export class EventStore {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly statements: EventStoreStatements,
    private readonly maintenance: MaintenanceFence,
    private readonly branchScopes: BranchScopeRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly randomId: () => string = randomUUID,
    private readonly faultInjector: EventStoreFaultInjector = NO_EVENT_STORE_FAULTS,
  ) {}

  append<TResponse extends JsonValue>(
    command: AppendCommand<TResponse>,
  ): AppendResult<TResponse> {
    const validated = validateAppendCommand(command, this.now(), this.randomId);
    let matchesProjectIdentity: boolean;
    try {
      matchesProjectIdentity = this.statements.matchesProjectIdentity(
        command.context.binding.projectId,
        command.context.binding.vaultId,
        command.context.binding.storeId,
      );
    } catch (error) {
      throw normalizeEventStoreError(error);
    }
    if (!matchesProjectIdentity) {
      throw new EventStoreError("PROJECT_IDENTITY_MISMATCH");
    }
    const computedCommandHash = commandHash(validated.hashMaterial);
    const faultContext: EventStoreFaultContext = {
      projectId: command.context.binding.projectId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
    };
    let transactionBegan = false;
    let commitAttempted = false;
    try {
      this.faultInjector.hit("before-begin", faultContext);
      this.connection.exec("BEGIN IMMEDIATE");
      transactionBegan = true;
      const prior = this.statements.findDedup(
        command.context.binding.projectId,
        command.idempotencyKey,
      );
      if (prior !== undefined) {
        if (
          prior.commandHash !== computedCommandHash
          || prior.commandId !== command.commandId
        ) {
          throw new EventStoreError("IDEMPOTENCY_CONFLICT");
        }
        this.connection.exec("ROLLBACK");
        transactionBegan = false;
        return decodeStoredResponse<TResponse>(
          prior.responseJson,
          prior.responseHash,
          true,
        );
      }

      if (this.statements.findCommandId(
        command.context.binding.projectId,
        command.commandId,
      ) !== undefined) {
        throw new EventStoreError("IDEMPOTENCY_CONFLICT");
      }
      this.maintenance.assertAppendAllowed(this.connection);
      const branchScopeId = command.context.workspace.kind === "git"
        ? this.branchScopes.resolveOrCreate(
            this.connection,
            command.context.binding.projectId,
            {
              branchRef: command.context.workspace.branchRef,
              headCommit: command.context.workspace.headCommit,
              detached: command.context.workspace.detached,
            },
            validated.recordedAt,
          )
        : undefined;
      let stream = this.statements.readStream(
        command.context.binding.projectId,
        command.streamId,
      );
      if (stream === undefined) {
        this.statements.insertStream(
          command.context.binding.projectId,
          command.streamId,
          command.streamType,
          validated.recordedAt,
        );
        stream = { currentVersion: 0n, streamType: command.streamType };
      } else if (stream.streamType !== command.streamType) {
        throw new EventStoreError("STREAM_TYPE_MISMATCH", {
          expected: stream.streamType,
          actual: command.streamType,
        });
      }
      const currentVersion = stream.currentVersion;
      if (currentVersion !== command.expectedStreamVersion) {
        throw new EventStoreError("EVENT_CONFLICT", {
          expected: command.expectedStreamVersion.toString(),
          actual: currentVersion.toString(),
        });
      }

      const tail = this.statements.readGlobalTail();
      const storedEvents = materializeEvents(
        command,
        validated,
        tail,
        branchScopeId,
      );
      for (const [index, storedEvent] of storedEvents.entries()) {
        this.statements.insertEvent(storedEvent);
        if (index === 0) {
          this.faultInjector.hit("after-first-insert-before-commit", faultContext);
        }
      }
      const nextVersion = currentVersion + BigInt(storedEvents.length);
      const changes = this.statements.compareAndSwapStream(
        command.context.binding.projectId,
        command.streamId,
        currentVersion,
        nextVersion,
        validated.recordedAt,
      );
      if (changes !== 1n) throw new EventStoreError("EVENT_CONFLICT");
      for (const pendingOutbox of command.outbox) {
        this.statements.insertOutbox(
          command.context.binding.projectId,
          pendingOutbox,
          storedEvents[pendingOutbox.eventIndex]!,
          outboxHash(pendingOutbox.payload),
          validated.recordedAt,
        );
      }
      const storedResponse = buildStoredCommandResponse(
        command.publicResponse,
        storedEvents,
      );
      const computedResponseHash = responseHash(storedResponse);
      this.statements.insertDedup(
        command,
        computedCommandHash,
        storedResponse,
        computedResponseHash,
        validated.recordedAt,
      );
      commitAttempted = true;
      this.connection.exec("COMMIT");
      transactionBegan = false;
      this.faultInjector.hit("after-commit-before-response", faultContext);
      return decodeStoredResponse<TResponse>(
        canonical(storedResponse),
        computedResponseHash,
        false,
      );
    } catch (error) {
      let rollbackFailed = false;
      if (transactionBegan) {
        try {
          this.connection.exec("ROLLBACK");
          transactionBegan = false;
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed || (commitAttempted && !isPrimarySqliteBusy(error))) {
        throw new EventStoreError("COMMAND_OUTCOME_UNKNOWN", {
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
        });
      }
      throw normalizeEventStoreError(error);
    }
  }
}
