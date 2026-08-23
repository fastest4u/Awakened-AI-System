import { canonicalJson } from "../serialization/canonical-json.js";

export const LIFECYCLE_ERROR_CODES = Object.freeze([
  "PROJECT_BINDING_REQUIRED",
  "PROJECT_ID_MISMATCH",
  "VAULT_ID_MISMATCH",
  "WORKSPACE_AMBIGUOUS",
  "STORE_UNAVAILABLE",
  "SQLITE_CAPABILITY_MISSING",
  "EVENT_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "COMMAND_OUTCOME_UNKNOWN",
  "OPERATION_OUTCOME_UNKNOWN",
  "SESSION_NOT_FOUND",
  "SESSION_AMBIGUOUS",
  "SESSION_ALREADY_OWNED",
  "SESSION_HANDLE_STALE",
  "SESSION_OWNERSHIP_MISMATCH",
  "CONTINUITY_CONFLICT",
  "SESSION_STATE_CONFLICT",
  "SESSION_CHILDREN_ACTIVE",
  "SESSION_END_INCOMPLETE",
  "PROJECTION_LAG",
  "PROVIDER_UNAVAILABLE",
  "SESSION_CAPABILITY_INVALID",
  "SESSION_CAPABILITY_KEY_UNAVAILABLE",
  "SESSION_CAPABILITY_EXPIRED",
  "SESSION_RECOVERY_APPROVAL_REQUIRED",
  "LIFECYCLE_APPROVAL_INVALID",
  "LIFECYCLE_APPROVAL_EXPIRED",
  "LIFECYCLE_APPROVAL_REPLAYED",
  "SESSION_SOURCE_STATE_CONFLICT",
  "SESSION_VALIDATION_RESULT_INVALID",
  "CHECKPOINT_BASE_INVALID",
  "EVIDENCE_CAPTURE_INCOMPLETE",
  "EVIDENCE_COVERAGE_TOO_FRAGMENTED",
  "CHECKPOINT_EVIDENCE_VERSION_REQUIRED",
  "EVIDENCE_ADAPTER_SESSION_LIMIT",
  "EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE",
  "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE",
  "CHECKPOINT_CAPACITY_EXCEEDED",
  "SESSION_END_EVIDENCE_FROZEN",
  "SESSION_END_EVIDENCE_WINDOW_OPEN",
  "SESSION_END_COVERAGE_CHANGED",
  "MATERIALIZATION_CONFLICT",
  "SCHEMA_UPGRADE_REQUIRED",
  "SCHEMA_TOO_NEW",
  "MIGRATION_CHECKSUM_MISMATCH",
  "SCHEMA_FINGERPRINT_MISMATCH",
  "INTEGRITY_FAILURE",
  "CHILD_REPORT_INVALID",
  "CHILD_DISPOSITION_INVALID",
  "LIFECYCLE_INPUT_INVALID",
  "LIFECYCLE_V2_DISABLED",
  "LIFECYCLE_OPERATION_UNAVAILABLE",
  "STORE_ID_MISMATCH",
  "WORKER_PROTOCOL_ERROR",
] as const);

export type LifecycleErrorCode = (typeof LIFECYCLE_ERROR_CODES)[number];

export const LIFECYCLE_RECOVERY_ACTIONS = Object.freeze([
  "establish-project-binding",
  "select-intended-project",
  "select-intended-vault",
  "select-intended-workspace",
  "verify-store-and-retry",
  "install-supported-runtime",
  "reload-and-retry",
  "retry-original-command",
  "retry-original-operation",
  "select-session-explicitly",
  "resume-with-current-authority",
  "request-authorized-recovery",
  "resolve-continuity-conflict",
  "resolve-session-state",
  "resolve-active-children",
  "amend-or-cancel-session-end",
  "wait-for-projection",
  "retry-with-local-retrieval",
  "restore-capability-key",
  "request-new-approval",
  "refresh-source-state",
  "rerun-trusted-validation",
  "record-current-checkpoint",
  "record-required-evidence",
  "reduce-evidence-fragmentation",
  "record-version-2-checkpoint",
  "start-new-lifecycle-session",
  "restore-evidence-fingerprint-key",
  "reduce-checkpoint-draft",
  "seal-session-end-evidence",
  "reconcile-materialization",
  "upgrade-store-schema",
  "upgrade-runtime",
  "restore-approved-migration",
  "run-integrity-recovery",
  "correct-lifecycle-input",
  "enable-lifecycle-v2",
  "attach-intended-store",
  "restart-trusted-worker",
] as const);

export type LifecycleRecoveryAction = (typeof LIFECYCLE_RECOVERY_ACTIONS)[number];

interface LifecycleFailureDefinition {
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly recoveryActions: readonly LifecycleRecoveryAction[];
}

function failure(
  safeMessage: string,
  retryable: boolean,
  ...recoveryActions: LifecycleRecoveryAction[]
): LifecycleFailureDefinition {
  return Object.freeze({
    safeMessage,
    retryable,
    recoveryActions: Object.freeze(recoveryActions),
  });
}

const FAILURE_DEFINITIONS: Readonly<Record<LifecycleErrorCode, LifecycleFailureDefinition>> = Object.freeze({
  PROJECT_BINDING_REQUIRED: failure("A trusted project binding is required", false, "establish-project-binding"),
  PROJECT_ID_MISMATCH: failure("Project identity does not match the bound store", false, "select-intended-project"),
  VAULT_ID_MISMATCH: failure("Vault identity does not match the bound store", false, "select-intended-vault"),
  WORKSPACE_AMBIGUOUS: failure("The bound workspace identity is unavailable or changed", false, "select-intended-workspace"),
  STORE_UNAVAILABLE: failure("The authoritative project store is unavailable", true, "verify-store-and-retry"),
  SQLITE_CAPABILITY_MISSING: failure("The runtime lacks a required SQLite capability", false, "install-supported-runtime"),
  EVENT_CONFLICT: failure("Lifecycle state changed before the operation committed", true, "reload-and-retry"),
  IDEMPOTENCY_CONFLICT: failure("The retry identity is already bound to different input", false, "resolve-session-state"),
  COMMAND_OUTCOME_UNKNOWN: failure("The lifecycle command outcome is unknown", true, "retry-original-command"),
  OPERATION_OUTCOME_UNKNOWN: failure("The lifecycle operation outcome is unknown", true, "retry-original-operation"),
  SESSION_NOT_FOUND: failure("The requested session was not found", false, "select-session-explicitly"),
  SESSION_AMBIGUOUS: failure("More than one session matches the requested continuity", false, "select-session-explicitly"),
  SESSION_ALREADY_OWNED: failure("The session currently has another active owner", true, "resume-with-current-authority"),
  SESSION_HANDLE_STALE: failure("Session authority is stale", false, "request-authorized-recovery"),
  SESSION_OWNERSHIP_MISMATCH: failure("Session ownership does not match the trusted caller", false, "request-authorized-recovery"),
  CONTINUITY_CONFLICT: failure("The lifecycle continuity key is already in use", false, "resolve-continuity-conflict"),
  SESSION_STATE_CONFLICT: failure("The requested lifecycle transition is not valid", false, "resolve-session-state"),
  SESSION_CHILDREN_ACTIVE: failure("One or more child sessions still require disposition", false, "resolve-active-children"),
  SESSION_END_INCOMPLETE: failure("Session end is already in progress or requires amendment", false, "amend-or-cancel-session-end"),
  PROJECTION_LAG: failure("The required projection consistency was not reached", true, "wait-for-projection"),
  PROVIDER_UNAVAILABLE: failure("An optional retrieval provider is unavailable", true, "retry-with-local-retrieval"),
  SESSION_CAPABILITY_INVALID: failure("Session authority could not be verified", false, "request-authorized-recovery"),
  SESSION_CAPABILITY_KEY_UNAVAILABLE: failure("The session authority key is unavailable", false, "restore-capability-key"),
  SESSION_CAPABILITY_EXPIRED: failure("Session authority has expired", false, "request-authorized-recovery"),
  SESSION_RECOVERY_APPROVAL_REQUIRED: failure("Explicit recovery approval is required", false, "request-new-approval"),
  LIFECYCLE_APPROVAL_INVALID: failure("Lifecycle approval could not be verified", false, "request-new-approval"),
  LIFECYCLE_APPROVAL_EXPIRED: failure("Lifecycle approval has expired", false, "request-new-approval"),
  LIFECYCLE_APPROVAL_REPLAYED: failure("Lifecycle approval has already been consumed", false, "request-new-approval"),
  SESSION_SOURCE_STATE_CONFLICT: failure("Project source state changed during finalization", true, "refresh-source-state"),
  SESSION_VALIDATION_RESULT_INVALID: failure("A trusted validation result is missing or incompatible", false, "rerun-trusted-validation"),
  CHECKPOINT_BASE_INVALID: failure("The checkpoint base does not match current lifecycle state", true, "record-current-checkpoint"),
  EVIDENCE_CAPTURE_INCOMPLETE: failure("Required evidence coverage is incomplete", false, "record-required-evidence"),
  EVIDENCE_COVERAGE_TOO_FRAGMENTED: failure("Evidence coverage contains too many missing intervals", false, "reduce-evidence-fragmentation"),
  CHECKPOINT_EVIDENCE_VERSION_REQUIRED: failure(
    "Evidence coverage requires a Version 2 checkpoint",
    false,
    "record-version-2-checkpoint",
    "amend-or-cancel-session-end",
  ),
  EVIDENCE_ADAPTER_SESSION_LIMIT: failure(
    "The lifecycle session has reached its evidence adapter limit",
    false,
    "start-new-lifecycle-session",
  ),
  EVIDENCE_COVERAGE_SNAPSHOT_TOO_LARGE: failure(
    "The evidence coverage snapshot is too large",
    false,
    "start-new-lifecycle-session",
  ),
  EVIDENCE_HISTORICAL_KEY_UNAVAILABLE: failure(
    "Historical evidence fingerprint key material is unavailable",
    false,
    "restore-evidence-fingerprint-key",
  ),
  CHECKPOINT_CAPACITY_EXCEEDED: failure(
    "The lifecycle session can no longer fit a required checkpoint",
    false,
    "reduce-checkpoint-draft",
    "resolve-active-children",
    "start-new-lifecycle-session",
  ),
  SESSION_END_EVIDENCE_FROZEN: failure(
    "Evidence is frozen for the active session-end workflow",
    false,
    "amend-or-cancel-session-end",
  ),
  SESSION_END_EVIDENCE_WINDOW_OPEN: failure(
    "The session-end evidence window must be sealed",
    false,
    "seal-session-end-evidence",
  ),
  SESSION_END_COVERAGE_CHANGED: failure(
    "Evidence coverage changed after the final checkpoint",
    false,
    "record-version-2-checkpoint",
    "amend-or-cancel-session-end",
  ),
  MATERIALIZATION_CONFLICT: failure("Compatibility materialization could not be reconciled", true, "reconcile-materialization"),
  SCHEMA_UPGRADE_REQUIRED: failure("The project store schema must be upgraded", false, "upgrade-store-schema"),
  SCHEMA_TOO_NEW: failure("The project store schema requires newer software", false, "upgrade-runtime"),
  MIGRATION_CHECKSUM_MISMATCH: failure("A recorded migration does not match the approved migration", false, "restore-approved-migration"),
  SCHEMA_FINGERPRINT_MISMATCH: failure("The project store schema fingerprint is invalid", false, "run-integrity-recovery"),
  INTEGRITY_FAILURE: failure("Lifecycle integrity verification failed", false, "run-integrity-recovery"),
  CHILD_REPORT_INVALID: failure("The child report is invalid", false, "correct-lifecycle-input"),
  CHILD_DISPOSITION_INVALID: failure("The child report disposition is invalid", false, "correct-lifecycle-input"),
  LIFECYCLE_INPUT_INVALID: failure("Lifecycle input is invalid", false, "correct-lifecycle-input"),
  LIFECYCLE_V2_DISABLED: failure("Lifecycle Version 2 is disabled", false, "enable-lifecycle-v2"),
  LIFECYCLE_OPERATION_UNAVAILABLE: failure(
    "The lifecycle operation is not available in this runtime",
    false,
    "upgrade-runtime",
  ),
  STORE_ID_MISMATCH: failure("Store identity does not match the manifest", false, "attach-intended-store"),
  WORKER_PROTOCOL_ERROR: failure("The lifecycle worker protocol rejected the message", false, "restart-trusted-worker"),
});

const ERROR_CODE_SET = new Set<string>(LIFECYCLE_ERROR_CODES);
const IDENTITY_DETAIL_KEYS = new Set([
  "projectId",
  "sessionId",
  "commandId",
  "operationId",
  "workflowId",
  "checkpointId",
  "reportId",
  "storeId",
  "vaultId",
  "workspaceId",
]);
const POSITION_DETAIL_KEYS = new Set([
  "position",
  "expectedPosition",
  "actualPosition",
  "streamVersion",
  "globalPosition",
  "ownerGeneration",
  "workflowGeneration",
  "attempt",
]);
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOWER_HASH = /^[0-9a-f]{64}$/;
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;
const SQLITE_INT64_MAX_DECIMAL = "9223372036854775807";
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_.\[\]-]{0,127}$/;
const SAFE_PHASE = /^[a-z][a-z0-9-]{0,63}$/;

export const MAX_SESSION_AMBIGUITY_SUMMARIES = 16;
export const MAX_SESSION_AMBIGUITY_JSON_BYTES = 16_384;

export interface RedactedSessionAmbiguitySummaryV1 {
  readonly sessionId: string;
  readonly state: "active" | "suspended";
  readonly ownerGeneration: string;
  readonly latestCheckpointEventPosition: string | null;
  readonly checkpointRequired: boolean;
}

export interface SessionAmbiguitySummariesV1 {
  readonly schemaVersion: 1;
  readonly candidates: readonly RedactedSessionAmbiguitySummaryV1[];
  readonly truncated: boolean;
}

export const LIFECYCLE_IDEMPOTENCY_KEY_MAX_SCALARS = 512;

export function isBoundedLifecycleString(
  value: unknown,
  maximumScalars: number,
  allowEmpty = false,
): value is string {
  return typeof value === "string"
    && (allowEmpty || value.length > 0)
    && Array.from(value).length <= maximumScalars;
}

export interface LifecycleErrorEnvelope {
  readonly code: LifecycleErrorCode;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly candidateSummaries?: SessionAmbiguitySummariesV1;
  readonly recoveryActions: readonly LifecycleRecoveryAction[];
}

function isSafeDecimalString(value: string): boolean {
  return UNSIGNED_DECIMAL.test(value)
    && (
      value.length < SQLITE_INT64_MAX_DECIMAL.length
      || (value.length === SQLITE_INT64_MAX_DECIMAL.length && value <= SQLITE_INT64_MAX_DECIMAL)
    );
}

function exactPlainRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Lifecycle ambiguity summaries must be plain records");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Lifecycle ambiguity summaries must be plain records");
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError("Lifecycle ambiguity summaries contain unknown fields");
  }
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Lifecycle ambiguity summaries require enumerable data properties");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function decodeSessionAmbiguitySummariesJson(value: unknown): SessionAmbiguitySummariesV1 {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > MAX_SESSION_AMBIGUITY_JSON_BYTES
  ) throw new TypeError("Lifecycle ambiguity summaries must be bounded canonical JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
    if (canonicalJson(parsed) !== value) throw new TypeError("noncanonical");
  } catch {
    throw new TypeError("Lifecycle ambiguity summaries must be bounded canonical JSON");
  }
  const envelope = exactPlainRecord(parsed, ["schemaVersion", "candidates", "truncated"]);
  if (
    envelope.schemaVersion !== 1
    || typeof envelope.truncated !== "boolean"
    || !Array.isArray(envelope.candidates)
    || envelope.candidates.length < 2
    || envelope.candidates.length > MAX_SESSION_AMBIGUITY_SUMMARIES
  ) throw new TypeError("Lifecycle ambiguity summaries have invalid bounds");
  let previousSessionId: string | null = null;
  const candidates = Object.freeze(envelope.candidates.map((candidate) => {
    const item = exactPlainRecord(candidate, [
      "sessionId",
      "state",
      "ownerGeneration",
      "latestCheckpointEventPosition",
      "checkpointRequired",
    ]);
    if (
      typeof item.sessionId !== "string"
      || !LOWER_UUID.test(item.sessionId)
      || (previousSessionId !== null && item.sessionId <= previousSessionId)
      || (item.state !== "active" && item.state !== "suspended")
      || typeof item.ownerGeneration !== "string"
      || !isSafeDecimalString(item.ownerGeneration)
      || item.ownerGeneration === "0"
      || (
        item.latestCheckpointEventPosition !== null
        && (
          typeof item.latestCheckpointEventPosition !== "string"
          || !isSafeDecimalString(item.latestCheckpointEventPosition)
          || item.latestCheckpointEventPosition === "0"
        )
      )
      || typeof item.checkpointRequired !== "boolean"
    ) throw new TypeError("Lifecycle ambiguity summary contains invalid fields");
    previousSessionId = item.sessionId;
    return Object.freeze({
      sessionId: item.sessionId,
      state: item.state,
      ownerGeneration: item.ownerGeneration,
      latestCheckpointEventPosition: item.latestCheckpointEventPosition,
      checkpointRequired: item.checkpointRequired,
    }) as RedactedSessionAmbiguitySummaryV1;
  }));
  return Object.freeze({
    schemaVersion: 1,
    candidates,
    truncated: envelope.truncated,
  });
}

export function encodeSessionAmbiguitySummaries(
  candidates: readonly RedactedSessionAmbiguitySummaryV1[],
  truncated: boolean,
): string {
  const encoded = canonicalJson({ schemaVersion: 1, candidates, truncated });
  decodeSessionAmbiguitySummariesJson(encoded);
  return encoded;
}

function readSafeDetails(
  code: LifecycleErrorCode,
  value: unknown,
): Readonly<Record<string, string | number | bigint>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Lifecycle error details must be a plain safe-scalar record");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Lifecycle error details must be a plain safe-scalar record");
  }
  const output: Record<string, string | number | bigint> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string"
      || (
        !IDENTITY_DETAIL_KEYS.has(key)
        && !POSITION_DETAIL_KEYS.has(key)
        && key !== "idempotencyKey"
        && key !== "field"
        && key !== "phase"
        && key !== "candidateSummariesJson"
      )
    ) {
      throw new TypeError("Lifecycle error details contain a non-allowlisted key");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Lifecycle error details must contain enumerable data properties only");
    }
    const detail = descriptor.value as unknown;
    if (key === "candidateSummariesJson") {
      if (code !== "SESSION_AMBIGUOUS") {
        throw new TypeError("Lifecycle ambiguity summaries are valid only for SESSION_AMBIGUOUS");
      }
      decodeSessionAmbiguitySummariesJson(detail);
      output[key] = detail as string;
      continue;
    }
    if (key === "idempotencyKey") {
      if (!isBoundedLifecycleString(detail, LIFECYCLE_IDEMPOTENCY_KEY_MAX_SCALARS)) {
        throw new TypeError("Lifecycle error idempotency details must be bounded opaque strings");
      }
      output[key] = detail;
      continue;
    }
    if (IDENTITY_DETAIL_KEYS.has(key)) {
      const validIdentity = key === "workspaceId"
        ? typeof detail === "string" && LOWER_HASH.test(detail)
        : typeof detail === "string" && LOWER_UUID.test(detail);
      if (!validIdentity) {
        throw new TypeError("Lifecycle error identity details must use their canonical representation");
      }
      output[key] = detail as string;
      continue;
    }
    if (POSITION_DETAIL_KEYS.has(key)) {
      if (typeof detail === "number") {
        if (!Number.isSafeInteger(detail) || detail < 0) {
          throw new TypeError("Lifecycle error numeric details must be unsigned safe integers");
        }
        output[key] = detail;
        continue;
      }
      if (typeof detail === "bigint") {
        if (detail < 0n || detail > 9_223_372_036_854_775_807n) {
          throw new TypeError("Lifecycle error position details must fit SQLite int64");
        }
        output[key] = detail;
        continue;
      }
      if (typeof detail !== "string" || !isSafeDecimalString(detail)) {
        throw new TypeError("Lifecycle error position strings must be canonical SQLite int64 decimals");
      }
      output[key] = detail;
      continue;
    }
    if (key === "field" && typeof detail === "string" && SAFE_FIELD.test(detail)) {
      output[key] = detail;
      continue;
    }
    if (key === "phase" && typeof detail === "string" && SAFE_PHASE.test(detail)) {
      output[key] = detail;
      continue;
    }
    throw new TypeError("Lifecycle error details contain an invalid typed assertion");
  }
  return Object.freeze(output);
}

export class LifecycleError extends Error implements LifecycleErrorEnvelope {
  readonly code: LifecycleErrorCode;
  readonly retryable: boolean;
  readonly safeMessage: string;
  declare readonly projectId?: string;
  declare readonly sessionId?: string;
  readonly recoveryActions: readonly LifecycleRecoveryAction[];
  readonly details!: Readonly<Record<string, string | number | bigint>>;
  declare readonly candidateSummaries?: SessionAmbiguitySummariesV1;

  constructor(code: LifecycleErrorCode, details: unknown = {}) {
    if (!ERROR_CODE_SET.has(code)) throw new TypeError("Unknown lifecycle error code");
    const safeDetails = readSafeDetails(code, details);
    const definition = FAILURE_DEFINITIONS[code];
    super(`${code}: ${definition.safeMessage}`);
    Object.defineProperty(this, "name", { value: "LifecycleError", enumerable: false });
    this.code = code;
    this.retryable = definition.retryable;
    this.safeMessage = definition.safeMessage;
    this.recoveryActions = definition.recoveryActions;
    Object.defineProperty(this, "details", {
      value: safeDetails,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    if (typeof safeDetails.projectId === "string") this.projectId = safeDetails.projectId;
    if (typeof safeDetails.sessionId === "string") this.sessionId = safeDetails.sessionId;
    if (typeof safeDetails.candidateSummariesJson === "string") {
      this.candidateSummaries = decodeSessionAmbiguitySummariesJson(
        safeDetails.candidateSummariesJson,
      );
    }
  }

  toJSON(): LifecycleErrorEnvelope {
    return Object.freeze({
      code: this.code,
      retryable: this.retryable,
      safeMessage: this.safeMessage,
      ...(this.projectId === undefined ? {} : { projectId: this.projectId }),
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.candidateSummaries === undefined
        ? {}
        : { candidateSummaries: this.candidateSummaries }),
      recoveryActions: this.recoveryActions,
    });
  }
}
