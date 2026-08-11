import type {
  JsonValue,
  PendingOutbox,
  StoredEvent,
} from "../contracts/event.js";
import type {
  BranchScopeId,
  ProjectContext,
  ProjectId,
  ProjectStoreRoute,
  StoreId,
  VaultId,
  WorkspaceId,
  WorkspaceSnapshot,
} from "../identity/contracts.js";
import type {
  ProjectBindingSource,
  TrustedActorRole,
} from "../identity/project-binding.request.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import {
  parseCanonicalTimestamp,
  parseCanonicalUuid,
  parseInteger,
  parseLifecycleId,
  type SessionId,
  type WorkflowId,
} from "./contracts/identifiers.js";
import { LifecycleError } from "./errors.js";

const LOWER_HASH = /^[0-9a-f]{64}$/u;
const LOWER_GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const SQLITE_INT64_MAX_DECIMAL = "9223372036854775807";
const ARTIFACT_KIND = "compatibility-session-log";
const LIFECYCLE_OUTBOX_KIND = "materialize-lifecycle-log";
const FINGERPRINT_DOMAIN = "pm-materialization-fingerprint-v1";

const TRIGGERS = Object.freeze([
  "SessionCheckpointRecorded",
  "SessionEndAmended",
  "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated",
  "SessionEndCancelled",
  "SessionAbandoned",
  "SessionEnded",
] as const);

const PROJECT_BINDING_SOURCES = new Set<ProjectBindingSource>([
  "stdio-explicit-root",
  "mcp-roots",
  "trusted-ide-adapter",
  "explicit-cli",
]);
const TRUSTED_ACTOR_ROLES = new Set<TrustedActorRole>([
  "primary",
  "maintenance",
  "untrusted",
]);

function invalid(field: string): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
}

function strictRecord(
  value: unknown,
  expectedKeys: readonly string[] | undefined,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(field);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return invalid(field);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || key === "__proto__")) {
    return invalid(field);
  }
  if (
    expectedKeys !== undefined
    && (
      keys.length !== expectedKeys.length
      || keys.some((key) => !expectedKeys.includes(key as string))
    )
  ) return invalid(field);

  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid(field);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return snapshot;
}

function strictJsonSnapshot(value: unknown, field: string): JsonValue {
  const ancestors = new Set<object>();
  const copy = (current: unknown, currentField: string): JsonValue => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return invalid(currentField);
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== "object" || ancestors.has(current)) return invalid(currentField);

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) return invalid(currentField);
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const length = Reflect.getOwnPropertyDescriptor(current, "length")?.value;
        if (!Number.isSafeInteger(length) || Number(length) < 0) return invalid(currentField);
        const expectedKeys = [
          ...Array.from({ length: Number(length) }, (_, index) => String(index)),
          "length",
        ];
        const keys = Reflect.ownKeys(current);
        if (
          keys.length !== expectedKeys.length
          || keys.some((key, index) => key !== expectedKeys[index])
        ) return invalid(currentField);
        const items: JsonValue[] = [];
        for (let index = 0; index < Number(length); index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            return invalid(`${currentField}[${index}]`);
          }
          items.push(copy(descriptor.value, `${currentField}[${index}]`));
        }
        return Object.freeze(items) as unknown as JsonValue;
      }

      const record = strictRecord(current, undefined, currentField);
      const result: Record<string, JsonValue> = {};
      for (const key of Object.keys(record)) {
        Object.defineProperty(result, key, {
          value: copy(record[key], `${currentField}.${key}`),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(current);
    }
  };

  const snapshot = copy(value, field);
  canonicalJson(snapshot);
  return snapshot;
}

function stringValue(
  value: unknown,
  field: string,
  maximumScalars: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Array.from(value).length > maximumScalars
  ) return invalid(field);
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) return invalid(field);
  return value as T[number];
}

function hashValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !LOWER_HASH.test(value)) return invalid(field);
  return value;
}

function positiveDecimal(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !POSITIVE_DECIMAL.test(value)
    || value.length > SQLITE_INT64_MAX_DECIMAL.length
    || (
      value.length === SQLITE_INT64_MAX_DECIMAL.length
      && value > SQLITE_INT64_MAX_DECIMAL
    )
  ) return invalid(field);
  return value;
}

function positiveSqliteInt64(value: unknown, field: string): bigint {
  if (
    typeof value !== "bigint"
    || value < 1n
    || value > SQLITE_INT64_MAX
  ) return invalid(field);
  return value;
}

function timestampValue(value: unknown, field: string): string {
  try {
    return parseCanonicalTimestamp(value, field);
  } catch {
    return invalid(field);
  }
}

function uuidValue<T extends string>(value: unknown, field: string): T {
  try {
    return parseCanonicalUuid(value, field) as T;
  } catch {
    return invalid(field);
  }
}

function lifecycleId<T extends string>(value: unknown, field: string): T {
  try {
    return parseLifecycleId<T>(value, field);
  } catch {
    return invalid(field);
  }
}

function positiveSafeInteger(value: unknown, field: string): number {
  try {
    return parseInteger(value, field, 1, Number.MAX_SAFE_INTEGER);
  } catch {
    return invalid(field);
  }
}

function exactZero(value: unknown, field: string): 0 {
  if (value !== 0) return invalid(field);
  return 0;
}

export interface KeyedFingerprintV1 {
  readonly algorithm: "hmac-sha256";
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly domain: "pm-materialization-fingerprint-v1";
  readonly value: string;
}

export function decodeKeyedFingerprintV1(value: unknown): KeyedFingerprintV1 {
  const source = strictRecord(
    value,
    ["algorithm", "schemaVersion", "keyId", "domain", "value"],
    "keyedFingerprint",
  );
  if (source.algorithm !== "hmac-sha256") return invalid("keyedFingerprint.algorithm");
  if (source.schemaVersion !== 1) return invalid("keyedFingerprint.schemaVersion");
  const keyId = stringValue(source.keyId, "keyedFingerprint.keyId", 128);
  if (source.domain !== FINGERPRINT_DOMAIN) return invalid("keyedFingerprint.domain");
  return Object.freeze({
    algorithm: "hmac-sha256",
    schemaVersion: 1,
    keyId,
    domain: FINGERPRINT_DOMAIN,
    value: hashValue(source.value, "keyedFingerprint.value"),
  });
}

export interface WorkflowMaterializationOriginV1 {
  readonly kind: "workflow";
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
}

export interface DirectTerminalMaterializationOriginV1 {
  readonly kind: "terminal-event";
  readonly workflowId: null;
  readonly workflowGeneration: null;
}

export type LifecycleMaterializationOriginV1 =
  | WorkflowMaterializationOriginV1
  | DirectTerminalMaterializationOriginV1;

export type LifecycleMaterializationTriggerType = (typeof TRIGGERS)[number];

interface DecodedTriggerOrigin {
  readonly origin: LifecycleMaterializationOriginV1;
  readonly triggeringEventType: LifecycleMaterializationTriggerType;
}

function decodeTriggerOrigin(
  originValue: unknown,
  triggerValue: unknown,
  field: string,
): DecodedTriggerOrigin {
  const origin = strictRecord(
    originValue,
    ["kind", "workflowId", "workflowGeneration"],
    `${field}.origin`,
  );
  const triggeringEventType = enumValue(
    triggerValue,
    TRIGGERS,
    `${field}.triggeringEventType`,
  );
  if (origin.kind === "workflow") {
    return Object.freeze({
      origin: Object.freeze({
        kind: "workflow" as const,
        workflowId: lifecycleId<WorkflowId>(origin.workflowId, `${field}.origin.workflowId`),
        workflowGeneration: positiveSafeInteger(
          origin.workflowGeneration,
          `${field}.origin.workflowGeneration`,
        ),
      }),
      triggeringEventType,
    });
  }
  if (origin.kind === "terminal-event") {
    if (
      origin.workflowId !== null
      || origin.workflowGeneration !== null
      || triggeringEventType !== "SessionAbandoned"
    ) return invalid(`${field}.origin`);
    return Object.freeze({
      origin: Object.freeze({
        kind: "terminal-event" as const,
        workflowId: null,
        workflowGeneration: null,
      }),
      triggeringEventType: "SessionAbandoned",
    });
  }
  return invalid(`${field}.origin.kind`);
}

export interface LifecycleMaterializationPayloadCommonV1 {
  readonly payloadVersion: 1;
  readonly targetKey: string;
  readonly sessionId: SessionId;
  readonly artifactKind: "compatibility-session-log";
  readonly artifactPath: string;
  readonly materializationRevision: string;
  readonly triggeringPayloadHash: string;
  readonly nextFingerprint: KeyedFingerprintV1;
}

export type LifecycleMaterializationPayloadV1 = JsonValue
  & LifecycleMaterializationPayloadCommonV1
  & (
    | {
        readonly origin: WorkflowMaterializationOriginV1;
        readonly triggeringEventType: LifecycleMaterializationTriggerType;
      }
    | {
        readonly origin: DirectTerminalMaterializationOriginV1;
        readonly triggeringEventType: "SessionAbandoned";
      }
  );

export function decodeLifecycleMaterializationPayloadV1(
  value: unknown,
): LifecycleMaterializationPayloadV1 {
  const source = strictRecord(value, [
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
  ], "lifecycleMaterializationPayload");
  if (source.payloadVersion !== 1) {
    return invalid("lifecycleMaterializationPayload.payloadVersion");
  }
  if (source.artifactKind !== ARTIFACT_KIND) {
    return invalid("lifecycleMaterializationPayload.artifactKind");
  }
  const sessionId = lifecycleId<SessionId>(
    source.sessionId,
    "lifecycleMaterializationPayload.sessionId",
  );
  const materializationRevision = positiveDecimal(
    source.materializationRevision,
    "lifecycleMaterializationPayload.materializationRevision",
  );
  const targetKey = stringValue(
    source.targetKey,
    "lifecycleMaterializationPayload.targetKey",
    4_096,
  );
  if (targetKey !== `lifecycle-log/${sessionId}/${materializationRevision}`) {
    return invalid("lifecycleMaterializationPayload.targetKey");
  }
  const relation = decodeTriggerOrigin(
    source.origin,
    source.triggeringEventType,
    "lifecycleMaterializationPayload",
  );
  const decoded = {
    payloadVersion: 1 as const,
    targetKey,
    sessionId,
    artifactKind: ARTIFACT_KIND,
    artifactPath: stringValue(
      source.artifactPath,
      "lifecycleMaterializationPayload.artifactPath",
      4_096,
    ),
    materializationRevision,
    triggeringPayloadHash: hashValue(
      source.triggeringPayloadHash,
      "lifecycleMaterializationPayload.triggeringPayloadHash",
    ),
    nextFingerprint: decodeKeyedFingerprintV1(source.nextFingerprint),
    origin: relation.origin,
    triggeringEventType: relation.triggeringEventType,
  };
  canonicalJson(decoded);
  return Object.freeze(decoded) as unknown as LifecycleMaterializationPayloadV1;
}

export interface PendingLifecycleOutboxV1 extends PendingOutbox {
  readonly targetKey: string;
  readonly kind: "materialize-lifecycle-log";
  readonly eventIndex: 0;
  readonly payload: LifecycleMaterializationPayloadV1;
}

export function decodePendingLifecycleOutboxV1(value: unknown): PendingLifecycleOutboxV1 {
  const source = strictRecord(
    value,
    ["targetKey", "kind", "eventIndex", "payload"],
    "pendingLifecycleOutbox",
  );
  if (source.kind !== LIFECYCLE_OUTBOX_KIND) return invalid("pendingLifecycleOutbox.kind");
  const eventIndex = exactZero(source.eventIndex, "pendingLifecycleOutbox.eventIndex");
  const payload = decodeLifecycleMaterializationPayloadV1(source.payload);
  const targetKey = stringValue(source.targetKey, "pendingLifecycleOutbox.targetKey", 4_096);
  if (targetKey !== payload.targetKey) return invalid("pendingLifecycleOutbox.targetKey");
  return Object.freeze({
    targetKey,
    kind: LIFECYCLE_OUTBOX_KIND,
    eventIndex,
    payload,
  });
}

export interface MaterializationProjectionInputCommonV1 {
  readonly context: ProjectContext;
  readonly sessionId: SessionId;
  readonly artifactKind: "compatibility-session-log";
  readonly triggeringEventIndex: 0;
  readonly expectedTriggerPosition: bigint;
  readonly triggeringEventSchemaVersion: number;
  readonly triggeringOccurredAt: string;
  readonly triggeringEventPayload: JsonValue;
}

export type MaterializationProjectionInputV1 =
  MaterializationProjectionInputCommonV1
  & (
    | {
        readonly origin: WorkflowMaterializationOriginV1;
        readonly triggeringEventType: LifecycleMaterializationTriggerType;
      }
    | {
        readonly origin: DirectTerminalMaterializationOriginV1;
        readonly triggeringEventType: "SessionAbandoned";
      }
  );

function decodeStoreRoute(value: unknown): ProjectStoreRoute {
  const source = strictRecord(value, [
    "kind",
    "storeRoot",
    "eventsPath",
    "storeManifestPath",
    "projectionManifestPath",
  ], "materializationProjection.context.binding.storeRoute");
  if (source.kind !== "git-common" && source.kind !== "vault-local") {
    return invalid("materializationProjection.context.binding.storeRoute.kind");
  }
  return Object.freeze({
    kind: source.kind,
    storeRoot: stringValue(source.storeRoot, "materializationProjection.context.binding.storeRoute.storeRoot", 4_096),
    eventsPath: stringValue(source.eventsPath, "materializationProjection.context.binding.storeRoute.eventsPath", 4_096),
    storeManifestPath: stringValue(
      source.storeManifestPath,
      "materializationProjection.context.binding.storeRoute.storeManifestPath",
      4_096,
    ),
    projectionManifestPath: stringValue(
      source.projectionManifestPath,
      "materializationProjection.context.binding.storeRoute.projectionManifestPath",
      4_096,
    ),
  });
}

function workspaceIdValue(value: unknown, field: string): WorkspaceId {
  return hashValue(value, field) as WorkspaceId;
}

function decodeWorkspace(value: unknown, field: string): WorkspaceSnapshot {
  const observed = strictRecord(value, undefined, field);
  if (observed.kind === "non-git") {
    const source = strictRecord(value, ["kind", "workspaceRoot", "workspaceId"], field);
    return Object.freeze({
      kind: "non-git" as const,
      workspaceRoot: stringValue(source.workspaceRoot, `${field}.workspaceRoot`, 4_096),
      workspaceId: workspaceIdValue(source.workspaceId, `${field}.workspaceId`),
    });
  }
  if (observed.kind === "git") {
    const source = strictRecord(value, [
      "kind",
      "worktreeRoot",
      "gitDir",
      "gitCommonDir",
      "headCommit",
      "branchRef",
      "detached",
      "workspaceId",
    ], field);
    if (typeof source.headCommit !== "string" || !LOWER_GIT_COMMIT.test(source.headCommit)) {
      return invalid(`${field}.headCommit`);
    }
    if (source.branchRef !== null && typeof source.branchRef !== "string") {
      return invalid(`${field}.branchRef`);
    }
    if (source.detached !== true && source.detached !== false) {
      return invalid(`${field}.detached`);
    }
    return Object.freeze({
      kind: "git" as const,
      worktreeRoot: stringValue(source.worktreeRoot, `${field}.worktreeRoot`, 4_096),
      gitDir: stringValue(source.gitDir, `${field}.gitDir`, 4_096),
      gitCommonDir: stringValue(source.gitCommonDir, `${field}.gitCommonDir`, 4_096),
      headCommit: source.headCommit,
      branchRef: source.branchRef === null
        ? null
        : stringValue(source.branchRef, `${field}.branchRef`, 1_024),
      detached: source.detached,
      workspaceId: workspaceIdValue(source.workspaceId, `${field}.workspaceId`),
    });
  }
  return invalid(`${field}.kind`);
}

function decodeProjectContext(value: unknown): ProjectContext {
  const observed = strictRecord(value, undefined, "materializationProjection.context");
  const contextKeys = Object.prototype.hasOwnProperty.call(observed, "branchScopeId")
    ? ["binding", "workspace", "branchScopeId", "checkedAt"]
    : ["binding", "workspace", "checkedAt"];
  const source = strictRecord(value, contextKeys, "materializationProjection.context");
  const binding = strictRecord(source.binding, [
    "projectBindingId",
    "generation",
    "contextFingerprint",
    "source",
    "projectId",
    "vaultId",
    "storeId",
    "workspaceId",
    "clientNamespace",
    "clientInstanceId",
    "actorRole",
    "projectRoot",
    "vaultRoot",
    "descriptorPath",
    "storeRoute",
    "workspace",
    "establishedAt",
  ], "materializationProjection.context.binding");
  if (!PROJECT_BINDING_SOURCES.has(binding.source as ProjectBindingSource)) {
    return invalid("materializationProjection.context.binding.source");
  }
  if (!TRUSTED_ACTOR_ROLES.has(binding.actorRole as TrustedActorRole)) {
    return invalid("materializationProjection.context.binding.actorRole");
  }
  const bindingWorkspace = decodeWorkspace(
    binding.workspace,
    "materializationProjection.context.binding.workspace",
  );
  const workspace = decodeWorkspace(
    source.workspace,
    "materializationProjection.context.workspace",
  );
  const workspaceId = workspaceIdValue(
    binding.workspaceId,
    "materializationProjection.context.binding.workspaceId",
  );
  if (
    workspaceId !== workspace.workspaceId
    || workspaceId !== bindingWorkspace.workspaceId
    || canonicalJson(workspace) !== canonicalJson(bindingWorkspace)
  ) return invalid("materializationProjection.context.workspace");

  const branchScopeId = Object.prototype.hasOwnProperty.call(source, "branchScopeId")
    ? uuidValue<BranchScopeId>(
        source.branchScopeId,
        "materializationProjection.context.branchScopeId",
      )
    : undefined;
  const decodedBinding = Object.freeze({
    projectBindingId: uuidValue(
      binding.projectBindingId,
      "materializationProjection.context.binding.projectBindingId",
    ),
    generation: positiveSafeInteger(
      binding.generation,
      "materializationProjection.context.binding.generation",
    ),
    contextFingerprint: hashValue(
      binding.contextFingerprint,
      "materializationProjection.context.binding.contextFingerprint",
    ),
    source: binding.source as ProjectBindingSource,
    projectId: uuidValue<ProjectId>(binding.projectId, "materializationProjection.context.binding.projectId"),
    vaultId: uuidValue<VaultId>(binding.vaultId, "materializationProjection.context.binding.vaultId"),
    storeId: uuidValue<StoreId>(binding.storeId, "materializationProjection.context.binding.storeId"),
    workspaceId,
    clientNamespace: stringValue(
      binding.clientNamespace,
      "materializationProjection.context.binding.clientNamespace",
      1_024,
    ),
    clientInstanceId: stringValue(
      binding.clientInstanceId,
      "materializationProjection.context.binding.clientInstanceId",
      1_024,
    ),
    actorRole: binding.actorRole as TrustedActorRole,
    projectRoot: stringValue(binding.projectRoot, "materializationProjection.context.binding.projectRoot", 4_096),
    vaultRoot: stringValue(binding.vaultRoot, "materializationProjection.context.binding.vaultRoot", 4_096),
    descriptorPath: stringValue(
      binding.descriptorPath,
      "materializationProjection.context.binding.descriptorPath",
      4_096,
    ),
    storeRoute: decodeStoreRoute(binding.storeRoute),
    workspace: bindingWorkspace,
    establishedAt: timestampValue(
      binding.establishedAt,
      "materializationProjection.context.binding.establishedAt",
    ),
  });
  return Object.freeze({
    binding: decodedBinding,
    workspace,
    ...(branchScopeId === undefined ? {} : { branchScopeId }),
    checkedAt: timestampValue(source.checkedAt, "materializationProjection.context.checkedAt"),
  });
}

export function decodeMaterializationProjectionInputV1(
  value: unknown,
): MaterializationProjectionInputV1 {
  const source = strictRecord(value, [
    "context",
    "sessionId",
    "artifactKind",
    "triggeringEventIndex",
    "expectedTriggerPosition",
    "triggeringEventSchemaVersion",
    "triggeringOccurredAt",
    "triggeringEventPayload",
    "origin",
    "triggeringEventType",
  ], "materializationProjection");
  if (source.artifactKind !== ARTIFACT_KIND) {
    return invalid("materializationProjection.artifactKind");
  }
  const relation = decodeTriggerOrigin(
    source.origin,
    source.triggeringEventType,
    "materializationProjection",
  );
  return Object.freeze({
    context: decodeProjectContext(source.context),
    sessionId: lifecycleId<SessionId>(source.sessionId, "materializationProjection.sessionId"),
    artifactKind: ARTIFACT_KIND,
    triggeringEventIndex: exactZero(
      source.triggeringEventIndex,
      "materializationProjection.triggeringEventIndex",
    ),
    expectedTriggerPosition: positiveSqliteInt64(
      source.expectedTriggerPosition,
      "materializationProjection.expectedTriggerPosition",
    ),
    triggeringEventSchemaVersion: positiveSafeInteger(
      source.triggeringEventSchemaVersion,
      "materializationProjection.triggeringEventSchemaVersion",
    ),
    triggeringOccurredAt: timestampValue(
      source.triggeringOccurredAt,
      "materializationProjection.triggeringOccurredAt",
    ),
    triggeringEventPayload: strictJsonSnapshot(
      source.triggeringEventPayload,
      "materializationProjection.triggeringEventPayload",
    ),
    origin: relation.origin,
    triggeringEventType: relation.triggeringEventType,
  }) as MaterializationProjectionInputV1;
}

declare const PREPARED_MATERIALIZATION_QUEUE_V1: unique symbol;

export interface PreparedMaterializationQueueV1 {
  readonly [PREPARED_MATERIALIZATION_QUEUE_V1]: true;
  readonly pendingOutbox: PendingLifecycleOutboxV1;
}

export interface ExactPlannedRevisionQueryCommon {
  readonly projectId: ProjectId;
  readonly sessionId: SessionId;
  readonly artifactKind: "compatibility-session-log";
  readonly materializationRevision: bigint;
  readonly triggeringEventPosition: bigint;
}

export type ExactPlannedRevisionQuery =
  ExactPlannedRevisionQueryCommon
  & (
    | {
        readonly origin: WorkflowMaterializationOriginV1;
        readonly triggeringEventType: LifecycleMaterializationTriggerType;
      }
    | {
        readonly origin: DirectTerminalMaterializationOriginV1;
        readonly triggeringEventType: "SessionAbandoned";
      }
  );

export type LifecycleOutboxPlannedRevision = ExactPlannedRevisionQuery & {
  readonly targetKey: string;
  readonly artifactPath: string;
  readonly triggeringPayloadHash: string;
  readonly expectedPriorFingerprint: KeyedFingerprintV1 | null;
  readonly nextFingerprint: KeyedFingerprintV1;
  readonly createdAt: string;
};

export interface LifecycleOutboxPlanReader {
  getExactPlannedRevision(
    query: ExactPlannedRevisionQuery,
  ): LifecycleOutboxPlannedRevision | null;
  assertExactPlannedRevision(
    query: ExactPlannedRevisionQuery,
  ): LifecycleOutboxPlannedRevision;
}

interface LifecycleMaterializationPlanningReads {
  readGlobalTailPosition(): bigint;
  readStrictLifecyclePrefix(
    projectId: ProjectId,
    sessionId: SessionId,
    throughPositionExclusive: bigint,
  ): readonly StoredEvent[];
  readVerifiedImmediatePredecessor(
    projectId: ProjectId,
    sessionId: SessionId,
    artifactKind: "compatibility-session-log",
    beforeRevision: bigint,
  ): LifecycleOutboxPlannedRevision | null;
}

export interface LifecycleMaterializationQueuePort {
  prepare(
    input: MaterializationProjectionInputV1,
  ): PreparedMaterializationQueueV1;
  assertPlanned(
    prepared: PreparedMaterializationQueueV1,
    plannedTrigger: StoredEvent,
  ): void;
  assertCommitted(
    prepared: PreparedMaterializationQueueV1,
    committedTrigger: StoredEvent,
  ): LifecycleOutboxPlannedRevision;
}
