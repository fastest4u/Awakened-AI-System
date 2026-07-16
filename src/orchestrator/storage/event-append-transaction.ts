import { randomUUID } from "node:crypto";
import type {
  AppendCommand,
  AppendResult,
  DeepReadonlyJson,
  JsonValue,
  LifecycleReplayExpectation,
  PendingOutbox,
  PersistedLifecycleAuthorizationRecord,
  StoredCommandResponse,
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
import {
  decodeLifecycleIntentWitness,
  lifecycleIntentHashFromWitnessSource,
} from "../lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { BranchScopeRepository } from "./branch-scope.repository.js";
import {
  MaintenanceFence,
  MaintenanceFenceError,
} from "./maintenance-fence.js";
import type {
  SqliteConnection,
  SqliteRow,
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
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
  lifecycleIntentJson: string | null;
  lifecycleIntent: JsonValue | null;
}

interface DedupRow {
  commandId: string;
  commandHash: string;
  responseJson: string;
  responseHash: string;
  authorizationRecord: PersistedLifecycleAuthorizationRecord | null;
  stableBinding: {
    workspaceId: string;
    clientNamespace: string;
  } | null;
}

interface LifecycleAuthorityBinding {
  workspaceId: string;
  clientNamespace: string;
}

interface GlobalTail {
  globalPosition: bigint;
  eventHash: string;
}

interface StreamHead {
  currentVersion: bigint;
  streamType: string;
}

export interface EventAppendStatements {
  matchesProjectIdentity(projectId: string, vaultId: string, storeId: string): boolean;
  findDedup(projectId: string, idempotencyKey: string): DedupRow | undefined;
  findCommandId(projectId: string, commandId: string): { idempotencyKey: string } | undefined;
  readLifecycleAuthorityBinding(
    projectId: string,
    sessionId: string,
  ): LifecycleAuthorityBinding | undefined;
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
    authorization: PersistedLifecycleAuthorizationRecord | null,
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

function immutableSnapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableSnapshot(item))) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  if (!isPlainRecord(value)) throw new EventStoreError("COMMAND_INVALID");
  const snapshot: Record<string, unknown> = Object.getPrototypeOf(value) === null
    ? Object.create(null) as Record<string, unknown>
    : {};
  for (const key of Object.keys(value)) {
    snapshot[key] = immutableSnapshot(value[key]);
  }
  return Object.freeze(snapshot) as T;
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

  let lifecycleIntentJson: string | null = null;
  let lifecycleIntent: JsonValue | null = null;
  if (command.lifecycleIntentWitness !== undefined) {
    if (typeof command.lifecycleIntentWitness !== "string") {
      throw new EventStoreError("COMMAND_INVALID", { field: "lifecycleIntentWitness" });
    }
    try {
      const decoded = decodeLifecycleIntentWitness(command.lifecycleIntentWitness);
      if (canonicalJson(decoded) !== command.lifecycleIntentWitness) {
        throw new Error("noncanonical lifecycle intent witness");
      }
      lifecycleIntentJson = command.lifecycleIntentWitness;
      lifecycleIntent = JSON.parse(command.lifecycleIntentWitness) as JsonValue;
    } catch {
      throw new EventStoreError("COMMAND_INVALID", { field: "lifecycleIntentWitness" });
    }
    const first = command.events[0]!;
    if (command.streamType !== "session"
      || !nonEmptyString(first.sessionId)
      || command.streamId !== `session/${first.sessionId}`) {
      throw new EventStoreError("COMMAND_INVALID", { field: "lifecycleIntentWitness" });
    }
  }

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
  const hashMaterial: Record<string, JsonValue> = {
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
  const requestMaterial: JsonValue = {
    ...hashMaterial,
    idempotencyKey: command.idempotencyKey,
    publicResponse: command.publicResponse,
    ...(lifecycleIntent === null ? {} : { lifecycleIntent }),
  };
  const canonicalBytes = Buffer.byteLength(canonical(requestMaterial), "utf8");
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
    lifecycleIntentJson,
    lifecycleIntent,
  };
}

function buildStoredCommandResponse<T extends JsonValue>(
  publicResponse: T,
  events: readonly StoredEvent[],
): StoredCommandResponse<T> {
  return Object.freeze({
    eventIds: Object.freeze(events.map((event) => event.eventId)),
    firstGlobalPosition: events[0]!.globalPosition.toString(),
    lastGlobalPosition: events.at(-1)!.globalPosition.toString(),
    finalStreamVersion: events.at(-1)!.streamVersion.toString(),
    response: immutableSnapshot(publicResponse) as DeepReadonlyJson<T>,
  });
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
      sourceRefs: Object.freeze([...pending.sourceRefs]),
      evidenceRefs: Object.freeze([]) as readonly [],
      evidenceDigests: Object.freeze([]) as readonly [],
      payload: immutableSnapshot(pending.payload),
      payloadJson: validated.payloadJson[index]!,
      payloadHash: validated.payloadHashes[index]!,
      previousGlobalHash,
      lifecycleIntentJson: index === 0 ? validated.lifecycleIntentJson : null,
    };
    const hashMaterial: Record<string, unknown> = {
      ...storedWithoutHash,
      globalPosition: storedWithoutHash.globalPosition.toString(),
      streamVersion: storedWithoutHash.streamVersion.toString(),
    };
    delete hashMaterial.payload;
    delete hashMaterial.payloadJson;
    delete hashMaterial.lifecycleIntentJson;
    if (index === 0 && validated.lifecycleIntent !== null) {
      hashMaterial.lifecycleIntent = validated.lifecycleIntent;
    }
    const computedEventHash = eventHash(hashMaterial);
    previousGlobalHash = computedEventHash;
    return Object.freeze({ ...storedWithoutHash, eventHash: computedEventHash });
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

const LIFECYCLE_AUTH_COLUMNS = [
  "authorization_proof_version",
  "authorization_proof_nonce",
  "authorization_proof_digest",
  "authorization_approval_id",
  "authorization_approval_digest",
  "authorization_session_id",
  "target_session_id",
  "presenting_actor_role",
  "presenting_client_instance_id",
  "target_actor_role",
  "target_client_instance_id",
  "internal_workflow_id",
  "internal_workflow_generation",
  "internal_planned_work_id",
  "internal_claim_owner_id",
  "internal_claim_token",
] as const;

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function decodePrincipal(
  actorRoleValue: unknown,
  clientInstanceIdValue: unknown,
): PersistedLifecycleAuthorizationRecord["presenting"] {
  const actorRole = requiredString(actorRoleValue);
  const clientInstanceId = requiredString(clientInstanceIdValue);
  if (!ACTOR_ROLES.has(actorRole) || clientInstanceId.length === 0) {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
  return {
    actorRole: actorRole as PersistedLifecycleAuthorizationRecord["presenting"]["actorRole"],
    clientInstanceId,
  };
}

function decodeLifecycleAuthorizationRow(
  row: SqliteRow,
): PersistedLifecycleAuthorizationRecord | null {
  const kindValue = row.lifecycle_authorization_kind;
  if (kindValue === undefined) return null;
  if (kindValue === null) {
    if (LIFECYCLE_AUTH_COLUMNS.some((column) => row[column] !== null)) {
      throw new EventStoreError("INTEGRITY_FAILURE");
    }
    return null;
  }
  const kind = requiredString(kindValue);
  const presenting = decodePrincipal(
    row.presenting_actor_role,
    row.presenting_client_instance_id,
  );
  const target = decodePrincipal(row.target_actor_role, row.target_client_instance_id);
  const targetSessionId = requiredString(row.target_session_id);
  if (!LOWER_UUID.test(targetSessionId)) throw new EventStoreError("INTEGRITY_FAILURE");

  const proofVersion = row.authorization_proof_version;
  const proofNonce = nullableString(row.authorization_proof_nonce);
  const proofDigest = nullableString(row.authorization_proof_digest);
  const proof = proofVersion === null && proofNonce === null && proofDigest === null
    ? null
    : proofVersion === 1n
      && proofNonce !== null && LOWER_UUID.test(proofNonce)
      && proofDigest !== null && HASH.test(proofDigest)
      ? { version: 1 as const, nonce: proofNonce, digest: proofDigest }
      : undefined;
  if (proof === undefined) throw new EventStoreError("INTEGRITY_FAILURE");

  const approvalId = nullableString(row.authorization_approval_id);
  const approvalDigest = nullableString(row.authorization_approval_digest);
  const approval = approvalId === null && approvalDigest === null
    ? null
    : approvalId !== null && LOWER_UUID.test(approvalId)
      && approvalDigest !== null && HASH.test(approvalDigest)
      ? { approvalId, digest: approvalDigest }
      : undefined;
  if (approval === undefined) throw new EventStoreError("INTEGRITY_FAILURE");

  if (kind === "initial-authority") {
    if (row.authorization_session_id !== null
      || proof !== null || approval !== null
      || row.internal_workflow_id !== null
      || row.internal_workflow_generation !== null
      || row.internal_planned_work_id !== null
      || row.internal_claim_owner_id !== null
      || row.internal_claim_token !== null) {
      throw new EventStoreError("INTEGRITY_FAILURE");
    }
    return {
      kind,
      authorizationSessionId: null,
      targetSessionId,
      proof: null,
      approval: null,
      presenting,
      target,
    };
  }

  const authorizationSessionId = requiredString(row.authorization_session_id);
  if (!LOWER_UUID.test(authorizationSessionId)) {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
  if (kind === "protected") {
    if ((proof === null && approval === null)
      || row.internal_workflow_id !== null
      || row.internal_workflow_generation !== null
      || row.internal_planned_work_id !== null
      || row.internal_claim_owner_id !== null
      || row.internal_claim_token !== null) {
      throw new EventStoreError("INTEGRITY_FAILURE");
    }
    return {
      kind,
      authorizationSessionId,
      targetSessionId,
      proof,
      approval,
      presenting,
      target,
    };
  }
  if (kind !== "internal-workflow" || proof !== null || approval !== null) {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
  const workflowId = requiredString(row.internal_workflow_id);
  const workflowGeneration = requiredBigint(row.internal_workflow_generation, 1n);
  const plannedWorkId = requiredString(row.internal_planned_work_id);
  const claimOwnerId = requiredString(row.internal_claim_owner_id);
  const claimToken = requiredBigint(row.internal_claim_token, 1n);
  if (!LOWER_UUID.test(workflowId) || !HASH.test(plannedWorkId) || claimOwnerId.length === 0) {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
  return {
    kind,
    workflowId,
    workflowGeneration,
    plannedWorkId,
    claimOwnerId,
    claimToken,
    authorizationSessionId,
    targetSessionId,
    presenting,
    target,
  };
}

function decodeLifecycleStableBindingRow(
  row: SqliteRow,
  authorization: PersistedLifecycleAuthorizationRecord | null,
): DedupRow["stableBinding"] {
  if (authorization === null) return null;
  const eventWorkspaceId = requiredString(row.lifecycle_event_workspace_id);
  const eventSessionId = requiredString(row.lifecycle_event_session_id);
  const eventStreamId = requiredString(row.lifecycle_event_stream_id);
  const eventStreamType = requiredString(row.lifecycle_event_stream_type);
  const authoritySessionId = requiredString(row.lifecycle_authority_session_id);
  const authorityWorkspaceId = requiredString(row.lifecycle_authority_workspace_id);
  const authorityClientNamespace = requiredString(row.lifecycle_authority_client_namespace);
  const targetSessionId = authorization.targetSessionId;
  if (eventWorkspaceId.length === 0
    || authorityClientNamespace.length === 0
    || eventSessionId !== targetSessionId
    || eventStreamId !== `session/${targetSessionId}`
    || eventStreamType !== "session"
    || authoritySessionId !== targetSessionId
    || authorityWorkspaceId !== eventWorkspaceId) {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
  return {
    workspaceId: authorityWorkspaceId,
    clientNamespace: authorityClientNamespace,
  };
}

function samePrincipal(
  left: PersistedLifecycleAuthorizationRecord["presenting"],
  right: LifecycleReplayExpectation["presenting"],
): boolean {
  return left.actorRole === right.actorRole
    && left.clientInstanceId === right.clientInstanceId;
}

export function matchesLifecycleReplayAuthorization(
  record: PersistedLifecycleAuthorizationRecord,
  expectation: LifecycleReplayExpectation,
): boolean {
  if (record.kind !== expectation.kind
    || !samePrincipal(record.presenting, expectation.presenting)
    || !samePrincipal(record.target, expectation.target)) {
    return false;
  }
  if (record.kind === "initial-authority" && expectation.kind === "initial-authority") {
    return record.authorizationSessionId === null
      && LOWER_UUID.test(record.targetSessionId)
      && record.proof === null
      && record.approval === null;
  }
  if (record.kind === "protected" && expectation.kind === "protected") {
    return record.authorizationSessionId === expectation.authorizationSessionId
      && record.targetSessionId === expectation.targetSessionId
      && record.proof?.version === expectation.proof?.version
      && record.proof?.nonce === expectation.proof?.nonce
      && record.proof?.digest === expectation.proof?.digest
      && record.approval?.approvalId === expectation.approval?.approvalId
      && record.approval?.digest === expectation.approval?.digest;
  }
  return record.kind === "internal-workflow"
    && expectation.kind === "internal-workflow"
    && record.workflowId === expectation.workflowId
    && record.workflowGeneration === expectation.workflowGeneration
    && record.plannedWorkId === expectation.plannedWorkId
    && record.authorizationSessionId === expectation.authorizationSessionId
    && record.targetSessionId === expectation.targetSessionId
    && record.claimOwnerId.length > 0
    && record.claimToken > 0n;
}

function persistedAssertions(
  authorization: PersistedLifecycleAuthorizationRecord,
): JsonValue {
  const internal = authorization.kind === "internal-workflow" ? authorization : null;
  if (internal !== null && (
    internal.workflowGeneration > BigInt(Number.MAX_SAFE_INTEGER)
    || internal.workflowGeneration < 1n
  )) {
    throw new EventStoreError("COMMAND_INVALID", { field: "workflowGeneration" });
  }
  return {
    authorizationKind: authorization.kind,
    authorizationSessionId: authorization.authorizationSessionId,
    targetSessionId: authorization.targetSessionId,
    presentingActorRole: authorization.presenting.actorRole,
    presentingClientInstanceId: authorization.presenting.clientInstanceId,
    targetActorRole: authorization.target.actorRole,
    targetClientInstanceId: authorization.target.clientInstanceId,
    internalWorkflowId: internal?.workflowId ?? null,
    internalWorkflowGeneration: internal === null ? null : Number(internal.workflowGeneration),
    internalPlannedWorkId: internal?.plannedWorkId ?? null,
  };
}

export class SqliteEventAppendStatements implements EventAppendStatements {
  readonly #lifecycleSchema: boolean;
  readonly #identity: SqliteStatement;
  readonly #findDedup: SqliteStatement;
  readonly #findCommandId: SqliteStatement;
  readonly #readLifecycleAuthorityBinding: SqliteStatement | undefined;
  readonly #readStream: SqliteStatement;
  readonly #insertStream: SqliteStatement;
  readonly #readGlobalTail: SqliteStatement;
  readonly #insertEvent: SqliteStatement;
  readonly #compareAndSwapStream: SqliteStatement;
  readonly #insertOutbox: SqliteStatement;
  readonly #insertDedup: SqliteStatement;

  constructor(connection: SqliteConnection) {
    this.#lifecycleSchema = connection.prepare("PRAGMA table_info(command_dedup)")
      .all()
      .some((row) => row.name === "lifecycle_authorization_kind");
    this.#identity = connection.prepare(`
      SELECT project_id, vault_id, store_id
      FROM project_meta
      WHERE singleton = 1
    `);
    this.#findDedup = connection.prepare(this.#lifecycleSchema ? `
      SELECT dedup.command_id, dedup.command_hash, dedup.response_json, dedup.response_hash,
             dedup.lifecycle_authorization_kind,
             dedup.authorization_proof_version, dedup.authorization_proof_nonce,
             dedup.authorization_proof_digest, dedup.authorization_approval_id,
             dedup.authorization_approval_digest, dedup.authorization_session_id,
             dedup.target_session_id, dedup.presenting_actor_role,
             dedup.presenting_client_instance_id, dedup.target_actor_role,
             dedup.target_client_instance_id, dedup.internal_workflow_id,
             dedup.internal_workflow_generation, dedup.internal_planned_work_id,
             dedup.internal_claim_owner_id, dedup.internal_claim_token,
             command_event.workspace_id AS lifecycle_event_workspace_id,
             command_event.session_id AS lifecycle_event_session_id,
             command_event.stream_id AS lifecycle_event_stream_id,
             command_event.stream_type AS lifecycle_event_stream_type,
             authority.session_id AS lifecycle_authority_session_id,
             authority.workspace_id AS lifecycle_authority_workspace_id,
             authority.client_namespace AS lifecycle_authority_client_namespace
      FROM command_dedup AS dedup
      LEFT JOIN events AS command_event
        ON command_event.project_id = dedup.project_id
       AND command_event.command_id = dedup.command_id
       AND command_event.command_event_index = 0
      LEFT JOIN session_authority AS authority
        ON authority.project_id = dedup.project_id
       AND authority.session_id = dedup.target_session_id
      WHERE dedup.project_id = $projectId AND dedup.idempotency_key = $idempotencyKey
    ` : `
      SELECT command_id, command_hash, response_json, response_hash
      FROM command_dedup
      WHERE project_id = $projectId AND idempotency_key = $idempotencyKey
    `);
    this.#findCommandId = connection.prepare(`
      SELECT idempotency_key
      FROM command_dedup
      WHERE project_id = $projectId AND command_id = $commandId
    `);
    this.#readLifecycleAuthorityBinding = this.#lifecycleSchema
      ? connection.prepare(`
          SELECT workspace_id, client_namespace
          FROM session_authority
          WHERE project_id = $projectId AND session_id = $sessionId
        `)
      : undefined;
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
    this.#insertEvent = connection.prepare(this.#lifecycleSchema ? `
      INSERT INTO events(
        global_position, event_id, project_id, vault_id, store_id, workspace_id,
        branch_scope_id, branch_ref, stream_id, stream_type, stream_version,
        event_type, event_schema_version, session_id, parent_session_id,
        actor_role, agent_id, client_instance_id, correlation_id, causation_id,
        command_id, idempotency_key, command_event_index, occurred_at, recorded_at,
        visibility_scope, confidence, verification_status, source_refs_json,
        evidence_refs_json, evidence_digests_json, payload_json, payload_hash,
        previous_global_hash, event_hash, lifecycle_intent_json
      ) VALUES (
        $globalPosition, $eventId, $projectId, $vaultId, $storeId, $workspaceId,
        $branchScopeId, $branchRef, $streamId, $streamType, $streamVersion,
        $eventType, $eventSchemaVersion, $sessionId, $parentSessionId,
        $actorRole, $agentId, $clientInstanceId, $correlationId, $causationId,
        $commandId, $idempotencyKey, $commandEventIndex, $occurredAt, $recordedAt,
        $visibilityScope, $confidence, $verificationStatus, $sourceRefsJson,
        $evidenceRefsJson, $evidenceDigestsJson, $payloadJson, $payloadHash,
        $previousGlobalHash, $eventHash, $lifecycleIntentJson
      )
    ` : `
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
    this.#insertDedup = connection.prepare(this.#lifecycleSchema ? `
      INSERT INTO command_dedup(
        project_id, idempotency_key, command_id, command_type, command_hash,
        workspace_head_commit, outbox_order_json, state, first_global_position,
        last_global_position, final_stream_version, event_ids_json, response_json,
        response_hash, committed_at, lifecycle_authorization_kind,
        authorization_proof_version, authorization_proof_nonce,
        authorization_proof_digest, authorization_approval_id,
        authorization_approval_digest, authorization_session_id,
        target_session_id, presenting_actor_role,
        presenting_client_instance_id, target_actor_role,
        target_client_instance_id, internal_workflow_id,
        internal_workflow_generation, internal_planned_work_id,
        internal_claim_owner_id, internal_claim_token
      ) VALUES (
        $projectId, $idempotencyKey, $commandId, $commandType, $commandHash,
        $workspaceHeadCommit, $outboxOrderJson, 'committed', $firstGlobalPosition,
        $lastGlobalPosition, $finalStreamVersion, $eventIdsJson, $responseJson,
        $responseHash, $committedAt, $lifecycleAuthorizationKind,
        $authorizationProofVersion, $authorizationProofNonce,
        $authorizationProofDigest, $authorizationApprovalId,
        $authorizationApprovalDigest, $authorizationSessionId,
        $targetSessionId, $presentingActorRole,
        $presentingClientInstanceId, $targetActorRole,
        $targetClientInstanceId, $internalWorkflowId,
        $internalWorkflowGeneration, $internalPlannedWorkId,
        $internalClaimOwnerId, $internalClaimToken
      )
    ` : `
      INSERT INTO command_dedup(
        project_id, idempotency_key, command_id, command_type, command_hash,
        workspace_head_commit, outbox_order_json, state, first_global_position,
        last_global_position, final_stream_version, event_ids_json, response_json,
        response_hash, committed_at
      ) VALUES (
        $projectId, $idempotencyKey, $commandId, $commandType, $commandHash,
        $workspaceHeadCommit, $outboxOrderJson, 'committed', $firstGlobalPosition,
        $lastGlobalPosition, $finalStreamVersion, $eventIdsJson, $responseJson,
        $responseHash, $committedAt
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
    const authorizationRecord = decodeLifecycleAuthorizationRow(row);
    return {
      commandId,
      commandHash: commandHashValue,
      responseJson,
      responseHash: responseHashValue,
      authorizationRecord,
      stableBinding: decodeLifecycleStableBindingRow(row, authorizationRecord),
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

  readLifecycleAuthorityBinding(
    projectId: string,
    sessionId: string,
  ): LifecycleAuthorityBinding | undefined {
    if (this.#readLifecycleAuthorityBinding === undefined) {
      throw new EventStoreError("SCHEMA_UPGRADE_REQUIRED");
    }
    const row = this.#readLifecycleAuthorityBinding.get({
      $projectId: projectId,
      $sessionId: sessionId,
    });
    if (row === undefined) return undefined;
    const workspaceId = requiredString(row.workspace_id);
    const clientNamespace = requiredString(row.client_namespace);
    if (workspaceId.length === 0 || clientNamespace.length === 0) {
      throw new EventStoreError("INTEGRITY_FAILURE");
    }
    return { workspaceId, clientNamespace };
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
    const parameters = {
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
    };
    this.#insertEvent.run(this.#lifecycleSchema
      ? { ...parameters, $lifecycleIntentJson: event.lifecycleIntentJson ?? null }
      : parameters);
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
    authorization: PersistedLifecycleAuthorizationRecord | null,
  ): void {
    if (!this.#lifecycleSchema && authorization !== null) {
      throw new EventStoreError("SCHEMA_UPGRADE_REQUIRED");
    }
    const parameters = {
      $projectId: command.context.binding.projectId,
      $idempotencyKey: command.idempotencyKey,
      $commandId: command.commandId,
      $commandType: command.commandType,
      $commandHash: commandHashValue,
      $workspaceHeadCommit: command.context.workspace.kind === "git"
        ? command.context.workspace.headCommit
        : null,
      $outboxOrderJson: canonical(command.outbox.map((item) => item.targetKey)),
      $firstGlobalPosition: BigInt(response.firstGlobalPosition),
      $lastGlobalPosition: BigInt(response.lastGlobalPosition),
      $finalStreamVersion: BigInt(response.finalStreamVersion),
      $eventIdsJson: canonical(response.eventIds),
      $responseJson: canonical(response),
      $responseHash: responseHashValue,
      $committedAt: now,
    };
    if (!this.#lifecycleSchema) {
      this.#insertDedup.run(parameters);
      return;
    }
    const proof = authorization?.kind === "protected" ? authorization.proof : null;
    const approval = authorization?.kind === "protected" ? authorization.approval : null;
    const internal = authorization?.kind === "internal-workflow" ? authorization : null;
    this.#insertDedup.run({
      ...parameters,
      $lifecycleAuthorizationKind: authorization?.kind ?? null,
      $authorizationProofVersion: proof === null ? null : BigInt(proof.version),
      $authorizationProofNonce: proof?.nonce ?? null,
      $authorizationProofDigest: proof?.digest ?? null,
      $authorizationApprovalId: approval?.approvalId ?? null,
      $authorizationApprovalDigest: approval?.digest ?? null,
      $authorizationSessionId: authorization?.authorizationSessionId ?? null,
      $targetSessionId: authorization?.targetSessionId ?? null,
      $presentingActorRole: authorization?.presenting.actorRole ?? null,
      $presentingClientInstanceId: authorization?.presenting.clientInstanceId ?? null,
      $targetActorRole: authorization?.target.actorRole ?? null,
      $targetClientInstanceId: authorization?.target.clientInstanceId ?? null,
      $internalWorkflowId: internal?.workflowId ?? null,
      $internalWorkflowGeneration: internal?.workflowGeneration ?? null,
      $internalPlannedWorkId: internal?.plannedWorkId ?? null,
      $internalClaimOwnerId: internal?.claimOwnerId ?? null,
      $internalClaimToken: internal?.claimToken ?? null,
    });
  }
}

export interface PreparedEventAppend<T extends JsonValue> {
  readonly command: AppendCommand<T>;
  readonly recordedAt: string;
  readonly commandHash: string;
  readonly storedEventIds: readonly string[];
}

export interface EventAppendBatch<T extends JsonValue> {
  readonly events: readonly StoredEvent[];
  readonly storedResponse: StoredCommandResponse<T>;
  readonly responseHash: string;
}

export interface PlannedEventAppend<T extends JsonValue> extends EventAppendBatch<T> {
  readonly plannedOnly: true;
}

export interface EventAppendReplay<T extends JsonValue> extends AppendResult<T> {
  readonly authorizationRecord: PersistedLifecycleAuthorizationRecord | null;
}

export interface LifecycleReplayProbe {
  readonly context: AppendCommand<JsonValue>["context"];
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly authoritativeIntentHash: string;
  readonly replayExpectation: LifecycleReplayExpectation;
}

const PREPARED = Symbol("prepared-event-append");
const PLANNED = Symbol("planned-event-append");

type InternalPrepared<T extends JsonValue> = PreparedEventAppend<T> & {
  readonly [PREPARED]: ValidatedAppendCommand;
};

type InternalPlanned<T extends JsonValue> = PlannedEventAppend<T> & {
  readonly [PLANNED]: InternalPrepared<T>;
};

function requirePrepared<T extends JsonValue>(
  prepared: PreparedEventAppend<T>,
): InternalPrepared<T> {
  if (!(PREPARED in prepared)) throw new EventStoreError("COMMAND_INVALID");
  return prepared as InternalPrepared<T>;
}

function requirePlanned<T extends JsonValue>(
  planned: PlannedEventAppend<T>,
): InternalPlanned<T> {
  if (!(PLANNED in planned)) throw new EventStoreError("COMMAND_INVALID");
  return planned as InternalPlanned<T>;
}

export class EventAppendTransaction {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly statements: EventAppendStatements,
    private readonly maintenance: MaintenanceFence,
    private readonly branchScopes: BranchScopeRepository,
    private readonly randomId: () => string = randomUUID,
    private readonly faultInjector: EventStoreFaultInjector = NO_EVENT_STORE_FAULTS,
  ) {}

  prepare<T extends JsonValue>(
    command: AppendCommand<T>,
    recordedAt: string,
    commandHashOverride?: string,
  ): PreparedEventAppend<T> {
    const commandSnapshot = immutableSnapshot(command);
    const validated = immutableSnapshot(
      validateAppendCommand(commandSnapshot, recordedAt, this.randomId),
    );
    let matchesProjectIdentity: boolean;
    try {
      matchesProjectIdentity = this.statements.matchesProjectIdentity(
        commandSnapshot.context.binding.projectId,
        commandSnapshot.context.binding.vaultId,
        commandSnapshot.context.binding.storeId,
      );
    } catch (error) {
      throw normalizeEventStoreError(error);
    }
    if (!matchesProjectIdentity) throw new EventStoreError("PROJECT_IDENTITY_MISMATCH");
    const hash = commandHashOverride ?? commandHash(validated.hashMaterial);
    if (!HASH.test(hash)) throw new EventStoreError("COMMAND_INVALID", { field: "commandHash" });
    if (commandHashOverride !== undefined) {
      if (validated.lifecycleIntentJson === null
        || lifecycleIntentHashFromWitnessSource(validated.lifecycleIntentJson) !== hash) {
        throw new EventStoreError("IDEMPOTENCY_CONFLICT");
      }
    } else if (validated.lifecycleIntentJson !== null) {
      throw new EventStoreError("COMMAND_INVALID", { field: "lifecycleIntentWitness" });
    }
    return Object.freeze({
      command: commandSnapshot,
      recordedAt,
      commandHash: hash,
      storedEventIds: Object.freeze([...validated.eventIds]),
      [PREPARED]: validated,
    }) as InternalPrepared<T>;
  }

  findReplay<T extends JsonValue>(
    preparedInput: PreparedEventAppend<T>,
    expectation: LifecycleReplayExpectation | null,
  ): EventAppendReplay<T> | null {
    const prepared = requirePrepared(preparedInput);
    const prior = this.statements.findDedup(
      prepared.command.context.binding.projectId,
      prepared.command.idempotencyKey,
    );
    if (prior === undefined) return null;
    const authorizationMatches = expectation === null
      ? prior.authorizationRecord === null
      : prior.authorizationRecord !== null
        && matchesLifecycleReplayAuthorization(prior.authorizationRecord, expectation);
    if (prior.commandHash !== prepared.commandHash
      || prior.commandId !== prepared.command.commandId
      || !authorizationMatches) {
      throw new EventStoreError("IDEMPOTENCY_CONFLICT");
    }
    return {
      ...decodeStoredResponse<T>(prior.responseJson, prior.responseHash, true),
      authorizationRecord: prior.authorizationRecord,
    };
  }

  findLifecycleReplay<T extends JsonValue>(probe: LifecycleReplayProbe): EventAppendReplay<T> | null {
    if (!LOWER_UUID.test(probe.commandId)
      || probe.idempotencyKey.length === 0
      || !HASH.test(probe.authoritativeIntentHash)) {
      throw new EventStoreError("COMMAND_INVALID");
    }
    if (!this.statements.matchesProjectIdentity(
      probe.context.binding.projectId,
      probe.context.binding.vaultId,
      probe.context.binding.storeId,
    )) {
      throw new EventStoreError("PROJECT_IDENTITY_MISMATCH");
    }
    const prior = this.statements.findDedup(
      probe.context.binding.projectId,
      probe.idempotencyKey,
    );
    if (prior === undefined) return null;
    if (prior.commandId !== probe.commandId
      || prior.commandHash !== probe.authoritativeIntentHash
      || prior.authorizationRecord === null
      || prior.stableBinding === null
      || prior.stableBinding.workspaceId !== probe.context.binding.workspaceId
      || prior.stableBinding.clientNamespace !== probe.context.binding.clientNamespace
      || !matchesLifecycleReplayAuthorization(
        prior.authorizationRecord,
        probe.replayExpectation,
      )) {
      throw new EventStoreError("IDEMPOTENCY_CONFLICT");
    }
    const decoded = decodeStoredResponse<T>(prior.responseJson, prior.responseHash, true);
    if (prior.authorizationRecord.kind === "initial-authority") {
      if (!isPlainRecord(decoded.response)
        || decoded.response.sessionId !== prior.authorizationRecord.targetSessionId) {
        throw new EventStoreError("INTEGRITY_FAILURE");
      }
    }
    return { ...decoded, authorizationRecord: prior.authorizationRecord };
  }

  assertCommandIdentityAvailable(command: Pick<LifecycleReplayProbe, "context" | "commandId">): void {
    if (this.statements.findCommandId(
      command.context.binding.projectId,
      command.commandId,
    ) !== undefined) {
      throw new EventStoreError("IDEMPOTENCY_CONFLICT");
    }
  }

  assertCommandIdAvailable<T extends JsonValue>(preparedInput: PreparedEventAppend<T>): void {
    const prepared = requirePrepared(preparedInput);
    this.assertCommandIdentityAvailable(prepared.command);
  }

  assertAppendAllowed(): void {
    this.maintenance.assertAppendAllowed(this.connection);
  }

  planPrepared<T extends JsonValue>(
    preparedInput: PreparedEventAppend<T>,
  ): PlannedEventAppend<T> {
    const prepared = requirePrepared(preparedInput);
    const { command } = prepared;
    const branchScopeId = command.context.workspace.kind === "git"
      ? this.branchScopes.resolveOrCreate(
          this.connection,
          command.context.binding.projectId,
          {
            branchRef: command.context.workspace.branchRef,
            headCommit: command.context.workspace.headCommit,
            detached: command.context.workspace.detached,
          },
          prepared.recordedAt,
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
        prepared.recordedAt,
      );
      stream = { currentVersion: 0n, streamType: command.streamType };
    } else if (stream.streamType !== command.streamType) {
      throw new EventStoreError("STREAM_TYPE_MISMATCH", {
        expected: stream.streamType,
        actual: command.streamType,
      });
    }
    if (stream.currentVersion !== command.expectedStreamVersion) {
      throw new EventStoreError("EVENT_CONFLICT", {
        expected: command.expectedStreamVersion.toString(),
        actual: stream.currentVersion.toString(),
      });
    }
    const events = materializeEvents(
      command,
      prepared[PREPARED],
      this.statements.readGlobalTail(),
      branchScopeId,
    );
    const storedResponse = buildStoredCommandResponse(command.publicResponse, events);
    return Object.freeze({
      plannedOnly: true as const,
      events: Object.freeze(events),
      storedResponse,
      responseHash: responseHash(storedResponse),
      [PLANNED]: prepared,
    }) as InternalPlanned<T>;
  }

  appendPlanned<T extends JsonValue>(plannedInput: PlannedEventAppend<T>): EventAppendBatch<T> {
    const planned = requirePlanned(plannedInput);
    const prepared = planned[PLANNED];
    const { command } = prepared;
    const faultContext: EventStoreFaultContext = {
      projectId: command.context.binding.projectId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
    };
    for (const [index, storedEvent] of planned.events.entries()) {
      this.statements.insertEvent(storedEvent);
      if (index === 0) {
        this.faultInjector.hit("after-first-insert-before-commit", faultContext);
      }
    }
    const changes = this.statements.compareAndSwapStream(
      command.context.binding.projectId,
      command.streamId,
      command.expectedStreamVersion,
      command.expectedStreamVersion + BigInt(planned.events.length),
      prepared.recordedAt,
    );
    if (changes !== 1n) throw new EventStoreError("EVENT_CONFLICT");
    for (const pendingOutbox of command.outbox) {
      this.statements.insertOutbox(
        command.context.binding.projectId,
        pendingOutbox,
        planned.events[pendingOutbox.eventIndex]!,
        outboxHash(pendingOutbox.payload),
        prepared.recordedAt,
      );
    }
    const committedEvents = Object.freeze(
      planned.events.map((event) => immutableSnapshot(event)),
    );
    const committedResponse = immutableSnapshot(planned.storedResponse);
    return Object.freeze({
      events: committedEvents,
      storedResponse: committedResponse,
      responseHash: planned.responseHash,
    });
  }

  insertDedup<T extends JsonValue>(
    preparedInput: PreparedEventAppend<T>,
    batch: EventAppendBatch<T>,
    authorization: PersistedLifecycleAuthorizationRecord | null,
  ): void {
    const prepared = requirePrepared(preparedInput);
    const validated = prepared[PREPARED];
    if (authorization === null) {
      if (validated.lifecycleIntentJson !== null) {
        throw new EventStoreError("COMMAND_INVALID", { field: "authorization" });
      }
    } else {
      const targetSessionId = authorization.targetSessionId;
      const expectedStreamId = `session/${targetSessionId}`;
      const eventZero = batch.events[0];
      if (eventZero === undefined
        || eventZero.commandEventIndex !== 0
        || eventZero.commandId !== prepared.command.commandId
        || eventZero.projectId !== prepared.command.context.binding.projectId
        || eventZero.sessionId !== targetSessionId
        || eventZero.streamId !== expectedStreamId
        || eventZero.streamType !== "session"
        || prepared.command.streamId !== expectedStreamId
        || eventZero.workspaceId !== prepared.command.context.binding.workspaceId) {
        throw new EventStoreError("INTEGRITY_FAILURE");
      }
      const authorityBinding = this.statements.readLifecycleAuthorityBinding(
        prepared.command.context.binding.projectId,
        targetSessionId,
      );
      if (authorityBinding === undefined) {
        throw new EventStoreError("INTEGRITY_FAILURE");
      }
      if (authorityBinding.workspaceId !== prepared.command.context.binding.workspaceId
        || authorityBinding.clientNamespace !== prepared.command.context.binding.clientNamespace) {
        throw new EventStoreError("IDEMPOTENCY_CONFLICT");
      }
      if (validated.lifecycleIntent === null
        || !isPlainRecord(validated.lifecycleIntent)
        || !isPlainRecord(validated.lifecycleIntent.persistedAssertions)
        || canonical(validated.lifecycleIntent.persistedAssertions)
          !== canonical(persistedAssertions(authorization))) {
        throw new EventStoreError("IDEMPOTENCY_CONFLICT");
      }
      if (authorization.kind === "initial-authority") {
        if (!isPlainRecord(batch.storedResponse.response)
          || batch.storedResponse.response.sessionId !== authorization.targetSessionId) {
          throw new EventStoreError("COMMAND_INVALID", { field: "publicResponse" });
        }
      }
    }
    this.statements.insertDedup(
      prepared.command,
      prepared.commandHash,
      batch.storedResponse,
      batch.responseHash,
      prepared.recordedAt,
      authorization,
    );
  }

  result<T extends JsonValue>(batch: EventAppendBatch<T>, deduplicated = false): AppendResult<T> {
    return decodeStoredResponse<T>(
      canonical(batch.storedResponse),
      batch.responseHash,
      deduplicated,
    );
  }
}

export { isPrimarySqliteBusy, normalizeEventStoreError };
