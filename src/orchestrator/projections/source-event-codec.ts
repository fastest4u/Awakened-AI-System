import type { StoredEvent } from "../contracts/event.js";
import { payloadHash } from "../crypto/event-hash.js";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../identity/contracts.js";
import { decodeCheckpoint } from "../lifecycle/contracts/checkpoint.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type {
  CheckpointArtifactItem,
  CheckpointFileItem,
  CheckpointProjectionEvent,
  CheckpointWorkItem,
  MemorySourceProjectionEvent,
  ProjectBinding,
  ProjectionEvent,
  ProjectionEventDecodeResult,
  RetrievalFeedbackProjectionEvent,
} from "./contracts.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
const MAX_EVENT_PAYLOAD_DEPTH = 128;
const MAX_EVENT_PAYLOAD_NODES = 256 * 1024;
// Every canonical object member needs at least two quotes, one colon, and one value byte.
const MAX_CANONICAL_OBJECT_KEYS = Math.floor(MAX_EVENT_PAYLOAD_BYTES / 4);
const MAX_SUMMARY_BYTES = 16 * 1024;

const STORED_EVENT_KEYS = [
  "globalPosition",
  "eventId",
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "branchScopeId",
  "branchRef",
  "streamId",
  "streamType",
  "streamVersion",
  "eventType",
  "eventSchemaVersion",
  "sessionId",
  "parentSessionId",
  "actorRole",
  "agentId",
  "clientInstanceId",
  "correlationId",
  "causationId",
  "commandId",
  "idempotencyKey",
  "commandEventIndex",
  "occurredAt",
  "recordedAt",
  "visibilityScope",
  "confidence",
  "verificationStatus",
  "sourceRefs",
  "evidenceRefs",
  "evidenceDigests",
  "payload",
  "payloadJson",
  "payloadHash",
  "previousGlobalHash",
  "eventHash",
] as const;

const BINDING_KEYS = [
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "branchScopeId",
  "branchRef",
  "sessionId",
] as const;

function integrity(): never {
  throw new Error("INTEGRITY_FAILURE");
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return integrity();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return integrity();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || key === "__proto__" || !expectedKeys.includes(key))
  ) return integrity();
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      return integrity();
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function storedEventRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return integrity();
  const names = Reflect.ownKeys(value);
  const hasIntent = names.includes("lifecycleIntentJson");
  return exactRecord(value, hasIntent ? [...STORED_EVENT_KEYS, "lifecycleIntentJson"] : STORED_EVENT_KEYS);
}

function strictArray(value: unknown, maximum = 256): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return integrity();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maximum) return integrity();
  const keys = Reflect.ownKeys(value);
  const expected = [
    ...Array.from({ length: Number(length) }, (_, index) => String(index)),
    "length",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return integrity();
  }
  const result: unknown[] = [];
  for (let index = 0; index < Number(length); index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      return integrity();
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function boundedString(value: unknown, maximumBytes: number, allowEmpty = false): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) return integrity();
  return value;
}

function uuid(value: unknown): string {
  const decoded = boundedString(value, 36);
  if (!UUID.test(decoded)) return integrity();
  return decoded;
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function hash(value: unknown): string {
  const decoded = boundedString(value, 64);
  if (!HASH.test(decoded)) return integrity();
  return decoded;
}

function timestamp(value: unknown): string {
  const decoded = boundedString(value, 24);
  const milliseconds = Date.parse(decoded);
  if (
    !TIMESTAMP.test(decoded)
    || !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== decoded
  ) return integrity();
  return decoded;
}

function positiveBigint(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n || value > SQLITE_INT64_MAX) return integrity();
  return value;
}

function positiveDecimal(value: unknown): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) return integrity();
  const decoded = BigInt(value);
  if (decoded < 1n || decoded > SQLITE_INT64_MAX) return integrity();
  return decoded;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return integrity();
  }
  return Number(value);
}

function oneOf<T extends string | number>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) return integrity();
  return value as T;
}

function nullableBoundedString(value: unknown, maximumBytes: number): string | null {
  return value === null ? null : boundedString(value, maximumBytes);
}

function decodeBinding(value: unknown): ProjectBinding {
  const source = exactRecord(value, BINDING_KEYS);
  return Object.freeze({
    projectId: hash(source.projectId) as ProjectId,
    vaultId: hash(source.vaultId) as VaultId,
    storeId: hash(source.storeId) as StoreId,
    workspaceId: hash(source.workspaceId) as WorkspaceId,
    branchScopeId: nullableUuid(source.branchScopeId) as BranchScopeId | null,
    branchRef: nullableBoundedString(source.branchRef, 1_024),
    sessionId: nullableUuid(source.sessionId),
  });
}

function sameBinding(left: ProjectBinding, right: ProjectBinding): boolean {
  return left.projectId === right.projectId
    && left.vaultId === right.vaultId
    && left.storeId === right.storeId
    && left.workspaceId === right.workspaceId
    && left.branchScopeId === right.branchScopeId
    && left.branchRef === right.branchRef
    && left.sessionId === right.sessionId;
}

interface DecodedStoredEvent {
  readonly record: Record<string, unknown>;
  readonly eventPosition: bigint;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly binding: ProjectBinding;
  readonly payload: unknown;
}

function assertBoundedJson(value: unknown): void {
  type Pending =
    | Readonly<{ kind: "value"; value: unknown; depth: number }>
    | Readonly<{ kind: "exit"; value: object }>;
  const pending: Pending[] = [{ kind: "value", value, depth: 0 }];
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const addBytes = (count: number): void => {
    bytes += count;
    if (bytes > MAX_EVENT_PAYLOAD_BYTES) return integrity();
  };
  const addJsonString = (text: string): void => {
    if (Buffer.byteLength(text, "utf8") > MAX_EVENT_PAYLOAD_BYTES - bytes) return integrity();
    addBytes(Buffer.byteLength(JSON.stringify(text), "utf8"));
  };

  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) return integrity();
    if (entry.kind === "exit") {
      ancestors.delete(entry.value);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_EVENT_PAYLOAD_NODES) return integrity();
    const current = entry.value;
    if (current === null) {
      addBytes(4);
      continue;
    }
    if (typeof current === "string") {
      addJsonString(current);
      continue;
    }
    if (typeof current === "boolean") {
      addBytes(current ? 4 : 5);
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return integrity();
      addBytes(Buffer.byteLength(JSON.stringify(current), "utf8"));
      continue;
    }
    if (typeof current !== "object") return integrity();
    if (ancestors.has(current)) return integrity();
    const isArray = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current) as unknown;
    if (
      (isArray && prototype !== Array.prototype)
      || (!isArray && prototype !== Object.prototype && prototype !== null)
    ) return integrity();
    // `current` is produced only by JSON.parse of an already byte-bounded canonical string.
    // The JSON grammar therefore proves this allocation cannot exceed the bounds above.
    const keys = Reflect.ownKeys(current);
    const valueKeys = isArray ? keys.filter((key) => key !== "length") : keys;
    if (entry.depth >= MAX_EVENT_PAYLOAD_DEPTH && valueKeys.length > 0) return integrity();
    if (isArray) {
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(current, "length");
      const length = lengthDescriptor?.value;
      if (
        !Number.isSafeInteger(length)
        || Number(length) < 0
        || Number(length) > MAX_EVENT_PAYLOAD_NODES - nodes
      ) return integrity();
      const expected = [
        ...Array.from({ length: Number(length) }, (_, index) => String(index)),
        "length",
      ];
      if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        return integrity();
      }
      addBytes(2 + Math.max(0, Number(length) - 1));
    } else {
      if (keys.length > MAX_CANONICAL_OBJECT_KEYS) return integrity();
      if (keys.some((key) => typeof key !== "string" || key === "__proto__")) return integrity();
      if (keys.length > MAX_EVENT_PAYLOAD_NODES - nodes) return integrity();
      addBytes(2 + Math.max(0, keys.length - 1));
      for (const key of keys as string[]) {
        addJsonString(key);
        addBytes(1);
      }
    }
    ancestors.add(current);
    pending.push({ kind: "exit", value: current });
    for (let index = valueKeys.length - 1; index >= 0; index -= 1) {
      const key = valueKeys[index];
      if (key === undefined) return integrity();
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
        return integrity();
      }
      pending.push({ kind: "value", value: descriptor.value, depth: entry.depth + 1 });
    }
  }
}

function decodeStoredEventEnvelope(value: unknown): DecodedStoredEvent {
  const record = storedEventRecord(value);
  const eventPosition = positiveBigint(record.globalPosition);
  uuid(record.eventId);
  const binding = decodeBinding({
    projectId: record.projectId,
    vaultId: record.vaultId,
    storeId: record.storeId,
    workspaceId: record.workspaceId,
    branchScopeId: record.branchScopeId,
    branchRef: record.branchRef,
    sessionId: record.sessionId,
  });
  nullableUuid(record.parentSessionId);
  positiveBigint(record.streamVersion);
  const eventType = boundedString(record.eventType, 128);
  const eventSchemaVersion = safeInteger(record.eventSchemaVersion, 1, 1_000);
  boundedString(record.streamId, 1_024);
  boundedString(record.streamType, 128);
  oneOf(record.actorRole, ["primary", "maintenance", "untrusted"] as const);
  boundedString(record.agentId, 256);
  boundedString(record.clientInstanceId, 256);
  uuid(record.correlationId);
  nullableUuid(record.causationId);
  uuid(record.commandId);
  boundedString(record.idempotencyKey, 1_024);
  safeInteger(record.commandEventIndex, 0, 127);
  const occurredAt = timestamp(record.occurredAt);
  const recordedAt = timestamp(record.recordedAt);
  oneOf(record.visibilityScope, ["session", "workspace", "branch", "project"] as const);
  oneOf(record.confidence, ["high", "medium", "low", "guess"] as const);
  oneOf(record.verificationStatus, ["unverified", "provisional", "verified", "conflicted"] as const);
  for (const reference of strictArray(record.sourceRefs, 128)) boundedString(reference, 2_048);
  if (strictArray(record.evidenceRefs, 0).length !== 0) return integrity();
  if (strictArray(record.evidenceDigests, 0).length !== 0) return integrity();
  hash(record.payloadHash);
  hash(record.previousGlobalHash);
  hash(record.eventHash);
  if (record.lifecycleIntentJson !== undefined && record.lifecycleIntentJson !== null) {
    boundedString(record.lifecycleIntentJson, MAX_EVENT_PAYLOAD_BYTES);
  }
  return Object.freeze({
    record,
    eventPosition,
    eventType,
    eventSchemaVersion,
    occurredAt,
    recordedAt,
    binding,
    payload: record.payload,
  });
}

function validateKnownPayload(source: DecodedStoredEvent): DecodedStoredEvent {
  // ECMAScript has no exact own-key cardinality primitive that does not first materialize
  // the keys. Treat the event store's bounded canonical bytes as the payload representation;
  // the redundant object is checked only as an opaque plain container and never enumerated.
  const payloadJson = boundedString(source.record.payloadJson, MAX_EVENT_PAYLOAD_BYTES, true);
  if (typeof source.payload !== "object" || source.payload === null || Array.isArray(source.payload)) {
    return integrity();
  }
  const payloadPrototype = Object.getPrototypeOf(source.payload) as unknown;
  if (payloadPrototype !== Object.prototype && payloadPrototype !== null) return integrity();
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson) as unknown;
  } catch {
    return integrity();
  }
  assertBoundedJson(payload);
  if (canonicalJson(payload) !== payloadJson) return integrity();
  if (payloadHash(payload) !== hash(source.record.payloadHash)) return integrity();
  return Object.freeze({ ...source, payload });
}

function baseProjection(source: DecodedStoredEvent) {
  return {
    sourceEventId: uuid(source.record.eventId),
    sourceEventPosition: source.eventPosition,
    sourceEventSchemaVersion: source.eventSchemaVersion,
    occurredAt: source.occurredAt,
    recordedAt: source.recordedAt,
    binding: source.binding,
  };
}

function workItems(checkpoint: ReturnType<typeof decodeCheckpoint>): readonly CheckpointWorkItem[] {
  const sections = [
    ["completed", checkpoint.completedItems],
    ["in-progress", checkpoint.inProgressItems],
    ["blocker", checkpoint.blockers],
    ["next-action", checkpoint.nextActions],
    ["decision", checkpoint.decisions],
    ["assumption", checkpoint.assumptions],
    ["conflict", checkpoint.unresolvedConflicts],
  ] as const;
  return Object.freeze(sections.flatMap(([kind, items]) => items.map((item, ordinal) => Object.freeze({
    kind,
    ordinal,
    summary: item.summary,
    confidence: item.confidence,
  }))));
}

function checkpointFiles(checkpoint: ReturnType<typeof decodeCheckpoint>): readonly CheckpointFileItem[] {
  return Object.freeze(checkpoint.filesTouched.map((file, ordinal) => Object.freeze({
    ordinal,
    path: file.path,
    action: file.action,
    contentHash: file.contentHash,
    branchRef: file.branchRef,
    confidence: file.confidence,
  })));
}

function checkpointArtifacts(
  checkpoint: ReturnType<typeof decodeCheckpoint>,
): readonly CheckpointArtifactItem[] {
  return Object.freeze(checkpoint.artifactReferences.map((artifact, ordinal) => Object.freeze({
    ordinal,
    artifactId: artifact.artifactId,
    path: artifact.path,
    summary: artifact.summary,
    contentHash: artifact.contentHash,
    confidence: artifact.confidence,
  })));
}

function decodeCheckpointEvent(source: DecodedStoredEvent): ProjectionEventDecodeResult {
  if (![1, 2, 3].includes(source.eventSchemaVersion)) return integrity();
  const payload = source.eventSchemaVersion === 3
    ? exactRecord(source.payload, [
        "checkpoint",
        "baseEventPosition",
        "checkpointEventPosition",
        "finalCheckpointBindingVersion",
        "workflowId",
        "workflowGeneration",
      ])
    : exactRecord(source.payload, ["checkpoint", "baseEventPosition", "checkpointEventPosition"]);
  if (source.eventSchemaVersion === 3) {
    if (payload.finalCheckpointBindingVersion !== 1) return integrity();
    uuid(payload.workflowId);
    positiveDecimal(payload.workflowGeneration);
  }
  const checkpoint = decodeCheckpoint(payload.checkpoint);
  const baseEventPosition = positiveDecimal(payload.baseEventPosition);
  const checkpointEventPosition = positiveDecimal(payload.checkpointEventPosition);
  if (
    checkpointEventPosition !== source.eventPosition
    || checkpoint.baseEventPosition !== baseEventPosition.toString()
    || checkpoint.checkpointEventPosition !== checkpointEventPosition.toString()
    || checkpoint.sessionId !== source.binding.sessionId
    || checkpoint.parentSessionId !== source.record.parentSessionId
    || checkpoint.sourceState.workspaceId !== source.binding.workspaceId
    || checkpoint.sourceState.branchRef !== source.binding.branchRef
    || source.record.streamId !== `session/${checkpoint.sessionId}`
    || source.record.streamType !== "session"
    || source.record.visibilityScope !== "session"
    || checkpoint.creatorAgentId !== source.record.agentId
    || checkpoint.creatorClientInstanceId !== source.record.clientInstanceId
    || (source.eventSchemaVersion !== 3 && checkpoint.checkpointVersion !== source.eventSchemaVersion)
  ) return integrity();
  const event = validateProjectionEvent({
    kind: "checkpoint",
    ...baseProjection(source),
    checkpointId: checkpoint.checkpointId,
    checkpointVersion: checkpoint.checkpointVersion,
    baseEventPosition,
    taskSummary: checkpoint.taskSummary,
    workItems: workItems(checkpoint),
    files: checkpointFiles(checkpoint),
    artifacts: checkpointArtifacts(checkpoint),
  });
  return Object.freeze({ kind: "projected", event });
}

function decodeMemorySource(source: DecodedStoredEvent): ProjectionEventDecodeResult {
  if (source.eventSchemaVersion !== 1) return integrity();
  const payload = exactRecord(source.payload, [
    "sourceVersion",
    "binding",
    "itemId",
    "normalizedKey",
    "status",
    "confidence",
    "verificationMethod",
    "validFrom",
    "validTo",
    "summary",
    "contentHash",
  ]);
  if (payload.sourceVersion !== 1) return integrity();
  const payloadBinding = decodeBinding(payload.binding);
  if (!sameBinding(payloadBinding, source.binding)) return integrity();
  const event = validateProjectionEvent({
    kind: "memory-source",
    ...baseProjection(source),
    itemId: payload.itemId,
    normalizedKey: payload.normalizedKey,
    status: payload.status,
    confidence: payload.confidence,
    verificationMethod: payload.verificationMethod,
    validFrom: payload.validFrom,
    validTo: payload.validTo,
    summary: payload.summary,
    contentHash: payload.contentHash,
  });
  return Object.freeze({ kind: "projected", event });
}

function decodeFeedback(source: DecodedStoredEvent): ProjectionEventDecodeResult {
  if (source.eventSchemaVersion !== 1) return integrity();
  const payload = exactRecord(source.payload, [
    "feedbackVersion",
    "binding",
    "feedbackId",
    "itemId",
    "outcome",
    "usefulness",
    "sourceItemEventPosition",
  ]);
  if (payload.feedbackVersion !== 1) return integrity();
  const payloadBinding = decodeBinding(payload.binding);
  if (!sameBinding(payloadBinding, source.binding)) return integrity();
  const event = validateProjectionEvent({
    kind: "retrieval-feedback",
    ...baseProjection(source),
    feedbackId: payload.feedbackId,
    itemId: payload.itemId,
    outcome: payload.outcome,
    usefulness: payload.usefulness,
    sourceItemEventPosition: positiveDecimal(payload.sourceItemEventPosition),
  });
  return Object.freeze({ kind: "projected", event });
}

const PROJECTION_BASE_KEYS = [
  "kind",
  "sourceEventId",
  "sourceEventPosition",
  "sourceEventSchemaVersion",
  "occurredAt",
  "recordedAt",
  "binding",
] as const;

function validateWorkItem(value: unknown): CheckpointWorkItem {
  const source = exactRecord(value, ["kind", "ordinal", "summary", "confidence"]);
  const ordinal = safeInteger(source.ordinal, 0, 99);
  return Object.freeze({
    kind: oneOf(source.kind, [
      "completed",
      "in-progress",
      "blocker",
      "next-action",
      "decision",
      "assumption",
      "conflict",
    ] as const),
    ordinal,
    summary: boundedString(source.summary, MAX_SUMMARY_BYTES),
    confidence: oneOf(source.confidence, ["high", "medium", "low", "guess"] as const),
  });
}

function validateWorkItems(value: unknown): readonly CheckpointWorkItem[] {
  const nextOrdinal = new Map<CheckpointWorkItem["kind"], number>();
  return Object.freeze(strictArray(value, 700).map((item) => {
    const decoded = validateWorkItem(item);
    const expected = nextOrdinal.get(decoded.kind) ?? 0;
    if (decoded.ordinal !== expected) return integrity();
    nextOrdinal.set(decoded.kind, expected + 1);
    return decoded;
  }));
}

function validateFiles(value: unknown): readonly CheckpointFileItem[] {
  return Object.freeze(strictArray(value, 200).map((item, index) => {
    const decoded = validateFile(item);
    if (decoded.ordinal !== index) return integrity();
    return decoded;
  }));
}

function validateArtifacts(value: unknown): readonly CheckpointArtifactItem[] {
  return Object.freeze(strictArray(value, 200).map((item, index) => {
    const decoded = validateArtifact(item);
    if (decoded.ordinal !== index) return integrity();
    return decoded;
  }));
}

function validateFile(value: unknown): CheckpointFileItem {
  const source = exactRecord(value, [
    "ordinal",
    "path",
    "action",
    "contentHash",
    "branchRef",
    "confidence",
  ]);
  return Object.freeze({
    ordinal: safeInteger(source.ordinal, 0, 199),
    path: boundedString(source.path, 2_048),
    action: oneOf(source.action, ["created", "modified", "deleted", "observed", "renamed"] as const),
    contentHash: source.contentHash === null ? null : hash(source.contentHash),
    branchRef: nullableBoundedString(source.branchRef, 1_024),
    confidence: oneOf(source.confidence, ["high", "medium", "low", "guess"] as const),
  });
}

function validateArtifact(value: unknown): CheckpointArtifactItem {
  const source = exactRecord(value, [
    "ordinal",
    "artifactId",
    "path",
    "summary",
    "contentHash",
    "confidence",
  ]);
  return Object.freeze({
    ordinal: safeInteger(source.ordinal, 0, 199),
    artifactId: uuid(source.artifactId),
    path: boundedString(source.path, 2_048),
    summary: boundedString(source.summary, MAX_SUMMARY_BYTES),
    contentHash: hash(source.contentHash),
    confidence: oneOf(source.confidence, ["high", "medium", "low", "guess"] as const),
  });
}

/** Revalidates a projection event at every fold boundary and returns a frozen snapshot. */
export function validateProjectionEvent(value: unknown): ProjectionEvent {
  try {
    const discriminator = exactRecord(value, Reflect.ownKeys(value as object).map(String));
    const kind = discriminator.kind;
    if (kind === "checkpoint") {
      const source = exactRecord(value, [
        ...PROJECTION_BASE_KEYS,
        "checkpointId",
        "checkpointVersion",
        "baseEventPosition",
        "taskSummary",
        "workItems",
        "files",
        "artifacts",
      ]);
      const sourceEventPosition = positiveBigint(source.sourceEventPosition);
      const baseEventPosition = positiveBigint(source.baseEventPosition);
      if (baseEventPosition > sourceEventPosition) return integrity();
      const binding = decodeBinding(source.binding);
      if (binding.sessionId === null) return integrity();
      return Object.freeze({
        kind: "checkpoint",
        sourceEventId: uuid(source.sourceEventId),
        sourceEventPosition,
        sourceEventSchemaVersion: safeInteger(source.sourceEventSchemaVersion, 1, 3),
        occurredAt: timestamp(source.occurredAt),
        recordedAt: timestamp(source.recordedAt),
        binding,
        checkpointId: uuid(source.checkpointId),
        checkpointVersion: oneOf(source.checkpointVersion, [1, 2] as const),
        baseEventPosition,
        taskSummary: boundedString(source.taskSummary, MAX_SUMMARY_BYTES),
        workItems: validateWorkItems(source.workItems),
        files: validateFiles(source.files),
        artifacts: validateArtifacts(source.artifacts),
      }) as CheckpointProjectionEvent;
    }
    if (kind === "memory-source") {
      const source = exactRecord(value, [
        ...PROJECTION_BASE_KEYS,
        "itemId",
        "normalizedKey",
        "status",
        "confidence",
        "verificationMethod",
        "validFrom",
        "validTo",
        "summary",
        "contentHash",
      ]);
      const normalizedKey = boundedString(source.normalizedKey, 512);
      if (normalizedKey.normalize("NFKC").trim().toLowerCase() !== normalizedKey) return integrity();
      const validFrom = timestamp(source.validFrom);
      const validTo = source.validTo === null ? null : timestamp(source.validTo);
      if (validTo !== null && Date.parse(validTo) <= Date.parse(validFrom)) return integrity();
      return Object.freeze({
        kind: "memory-source",
        sourceEventId: uuid(source.sourceEventId),
        sourceEventPosition: positiveBigint(source.sourceEventPosition),
        sourceEventSchemaVersion: safeInteger(source.sourceEventSchemaVersion, 1, 1),
        occurredAt: timestamp(source.occurredAt),
        recordedAt: timestamp(source.recordedAt),
        binding: decodeBinding(source.binding),
        itemId: uuid(source.itemId),
        normalizedKey,
        status: oneOf(source.status, [
          "candidate",
          "provisional",
          "verified",
          "conflicted",
          "superseded",
          "retracted",
          "expired",
          "erased-evidence",
        ] as const),
        confidence: oneOf(source.confidence, ["high", "medium", "low", "guess"] as const),
        verificationMethod: boundedString(source.verificationMethod, 128),
        validFrom,
        validTo,
        summary: boundedString(source.summary, MAX_SUMMARY_BYTES),
        contentHash: hash(source.contentHash),
      }) as MemorySourceProjectionEvent;
    }
    if (kind === "retrieval-feedback") {
      const source = exactRecord(value, [
        ...PROJECTION_BASE_KEYS,
        "feedbackId",
        "itemId",
        "outcome",
        "usefulness",
        "sourceItemEventPosition",
      ]);
      const sourceEventPosition = positiveBigint(source.sourceEventPosition);
      const sourceItemEventPosition = positiveBigint(source.sourceItemEventPosition);
      if (sourceItemEventPosition > sourceEventPosition) return integrity();
      return Object.freeze({
        kind: "retrieval-feedback",
        sourceEventId: uuid(source.sourceEventId),
        sourceEventPosition,
        sourceEventSchemaVersion: safeInteger(source.sourceEventSchemaVersion, 1, 1),
        occurredAt: timestamp(source.occurredAt),
        recordedAt: timestamp(source.recordedAt),
        binding: decodeBinding(source.binding),
        feedbackId: uuid(source.feedbackId),
        itemId: uuid(source.itemId),
        outcome: oneOf(source.outcome, ["accepted", "dismissed", "corrected"] as const),
        usefulness: safeInteger(source.usefulness, 0, 10_000),
        sourceItemEventPosition,
      }) as RetrievalFeedbackProjectionEvent;
    }
    return integrity();
  } catch (error) {
    if (error instanceof Error && error.message === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}

export function decodeProjectionEvent(event: StoredEvent): ProjectionEventDecodeResult {
  try {
    const envelope = decodeStoredEventEnvelope(event);
    if (envelope.eventType === "SessionCheckpointRecorded") {
      return decodeCheckpointEvent(validateKnownPayload(envelope));
    }
    if (envelope.eventType === "MemorySourceRecorded") {
      return decodeMemorySource(validateKnownPayload(envelope));
    }
    if (envelope.eventType === "RetrievalFeedbackRecorded") {
      return decodeFeedback(validateKnownPayload(envelope));
    }
    return Object.freeze({
      kind: "unprojected",
      eventPosition: envelope.eventPosition,
      eventType: envelope.eventType,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}
