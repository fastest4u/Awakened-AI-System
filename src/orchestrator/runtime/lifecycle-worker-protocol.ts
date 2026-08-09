import type { JsonValue } from "../contracts/event.js";
import type { ProjectContext, ProjectId } from "../identity/contracts.js";
import {
  assertInternalValidationResultBinding,
  assertSemanticCommandAuthorization,
  decodeLifecycleSemanticCommandDraft,
  type CapabilityProofV1,
  type BoundedLifecycleOperation,
  type BoundedOperationAuthorization,
  type InternalValidationResultCommand,
  type InternalWorkflowExecutionPlan,
  type InternalWorkflowPhaseCommand,
  type InternalWorkflowPhasePlan,
  type LifecycleFencedOperation,
  type LifecycleSemanticCommandDraft,
  type PreparedLifecycleWorkerCommand,
  type SemanticCommandAuthorization,
} from "../lifecycle/contracts/commands.js";
import {
  type SessionId,
  type WorkflowId,
} from "../lifecycle/contracts/identifiers.js";
import type {
  SessionEndPhase,
  SessionEndPhaseResultV2,
  SessionEndStatusV2,
  ValidationResultRecordedResultV1,
} from "../lifecycle/contracts/session-end.js";
import type {
  CheckpointRecordedResult,
  CheckpointRecordedResultV1,
  CheckpointRecordedResultV2,
} from "../lifecycle/checkpoint.service.js";
import type { ChildWorkflowResultV2 } from "../lifecycle/child-workflow.service.js";
import type { EvidenceCoverageRecordedResultV2 } from "../lifecycle/evidence-coverage.service.js";
import type {
  RootLeaseRenewalResultV1,
  RootSessionPublicResultV2,
} from "../lifecycle/lifecycle-command.processor.js";
import type {
  SessionAssociationValidationV1,
  SessionStatusSummaryV1,
  SessionTreeSummaryV1,
} from "../lifecycle/lifecycle-query.service.js";
import { decodeCheckpointDraft } from "../lifecycle/contracts/checkpoint.js";
import {
  LIFECYCLE_ERROR_CODES,
  LifecycleError,
} from "../lifecycle/errors.js";
import { decodeCapabilityClaims } from "../lifecycle/authority/capability-codec.js";
import { decodeCheckpointRecordedResult } from "../lifecycle/checkpoint.service.js";
import { decodeEvidenceCoverageRecordedResultV2 } from "../lifecycle/evidence-coverage.service.js";
import { canonicalJson } from "../serialization/canonical-json.js";

export const MAX_LIFECYCLE_WIRE_CANONICAL_BYTES = 4 * 1024 * 1024;

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LOWER_HASH = /^[0-9a-f]{64}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const PHASE = /^[a-z][a-z0-9-]{0,127}$/u;

function invalid(field = "lifecycleWorkerProtocol"): never {
  throw new LifecycleError("WORKER_PROTOCOL_ERROR", { field });
}

function strictDataRecord(
  value: unknown,
  expectedKeys?: readonly string[],
  field = "lifecycleWorkerProtocol",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(field);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid(field);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) invalid(field);
  if (expectedKeys !== undefined && (
    keys.length !== expectedKeys.length
    || keys.some((key) => !expectedKeys.includes(key as string))
  )) invalid(field);
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      invalid(field);
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function strictJsonSnapshot(value: unknown, field = "lifecycleWorkerProtocol"): JsonValue {
  const ancestors = new Set<object>();
  const copy = (current: unknown, currentField: string): JsonValue => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current)) invalid(currentField);
      return current;
    }
    if (typeof current !== "object" || ancestors.has(current)) invalid(currentField);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) invalid(currentField);
        const keys = Reflect.ownKeys(current);
        const expected = [
          ...Array.from({ length: current.length }, (_, index) => String(index)),
          "length",
        ];
        if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
          invalid(currentField);
        }
        const items: JsonValue[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Reflect.getOwnPropertyDescriptor(current, String(index));
          if (
            descriptor === undefined
            || !descriptor.enumerable
            || !("value" in descriptor)
          ) invalid(`${currentField}[${index}]`);
          items.push(copy(descriptor.value, `${currentField}[${index}]`));
        }
        return Object.freeze(items) as unknown as JsonValue;
      }
      const record = strictDataRecord(current, undefined, currentField);
      const snapshot: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(record)) {
        Object.defineProperty(snapshot, key, {
          value: copy(item, `${currentField}.${key}`),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return Object.freeze(snapshot);
    } finally {
      ancestors.delete(current);
    }
  };
  return copy(value, field);
}

function exactSnapshot(
  value: unknown,
  keys: readonly string[],
  field: string,
): Readonly<Record<string, JsonValue>> {
  const source = strictDataRecord(value, keys, field);
  return strictJsonSnapshot(source, field) as Readonly<Record<string, JsonValue>>;
}

function stringValue(value: unknown, field: string, maximum = 1_024): string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maximum) {
    invalid(field);
  }
  return value;
}

function nullableStringValue(value: unknown, field: string, maximum = 1_024): string | null {
  return value === null ? null : stringValue(value, field, maximum);
}

function uuidValue(value: unknown, field: string): string {
  const decoded = stringValue(value, field, 36);
  if (!LOWER_UUID.test(decoded)) invalid(field);
  return decoded;
}

function hashValue(value: unknown, field: string): string {
  const decoded = stringValue(value, field, 64);
  if (!LOWER_HASH.test(decoded)) invalid(field);
  return decoded;
}

function decimalValue(value: unknown, field: string, minimum = 0n): string {
  const decoded = stringValue(value, field, 19);
  if (!UNSIGNED_DECIMAL.test(decoded)) invalid(field);
  const numeric = BigInt(decoded);
  if (numeric < minimum || numeric > SQLITE_INT64_MAX) invalid(field);
  return decoded;
}

function integerValue(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum
  ) invalid(field);
  return Number(value);
}

function timestampValue(value: unknown, field: string): string {
  const decoded = stringValue(value, field, 24);
  if (
    !CANONICAL_TIMESTAMP.test(decoded)
    || !Number.isFinite(Date.parse(decoded))
    || new Date(Date.parse(decoded)).toISOString() !== decoded
  ) invalid(field);
  return decoded;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}

export function assertLifecycleWireCanonicalSize(value: unknown): void {
  let snapshot: JsonValue;
  try {
    snapshot = strictJsonSnapshot(value, "lifecycleWire");
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    return invalid("lifecycleWire");
  }
  if (Buffer.byteLength(canonicalJson(snapshot), "utf8") > MAX_LIFECYCLE_WIRE_CANONICAL_BYTES) {
    invalid("lifecycleWire");
  }
}

export type BoundedOperationAuthorizationWire = Omit<
  BoundedOperationAuthorization,
  "audience"
>;

type ContextFreeBoundedOperation<O extends BoundedLifecycleOperation> =
  O extends BoundedLifecycleOperation
    ? Omit<O, "context" | "authorization"> & {
        readonly authorization: BoundedOperationAuthorizationWire;
      }
    : never;

type ContextFreeFencedOperation<O extends LifecycleFencedOperation> =
  O extends LifecycleFencedOperation ? Omit<O, "context"> : never;

type GroupedLifecycleQuery = Extract<
  BoundedLifecycleOperation,
  {
    readonly operation:
      | "read-session-tree"
      | "read-session-status"
      | "read-session-association";
  }
>;

export type LifecycleQuery = {
  readonly [K in GroupedLifecycleQuery["operation"]]:
    Omit<GroupedLifecycleQuery, "operation"> & { readonly operation: K };
}[GroupedLifecycleQuery["operation"]];

export type LifecycleBoundedMutation = Extract<
  BoundedLifecycleOperation,
  { readonly operation: "renew-root-lease" }
>;

export type LifecycleBoundedMutationInput<
  O extends LifecycleBoundedMutation = LifecycleBoundedMutation,
> = O extends LifecycleBoundedMutation ? ContextFreeBoundedOperation<O> : never;

export type LifecycleQueryInput<
  Q extends LifecycleQuery = LifecycleQuery,
> = Q extends LifecycleQuery ? ContextFreeBoundedOperation<Q> : never;

export type LifecycleFencedInput<
  O extends LifecycleFencedOperation = LifecycleFencedOperation,
> = O extends LifecycleFencedOperation ? ContextFreeFencedOperation<O> : never;

export type LifecycleBoundedMutationForInput<
  I extends LifecycleBoundedMutationInput,
> = Extract<LifecycleBoundedMutation, { readonly operation: I["operation"] }>;

export type LifecycleQueryForInput<
  I extends LifecycleQueryInput,
> = Extract<LifecycleQuery, { readonly operation: I["operation"] }>;

export type LifecycleFencedOperationForInput<
  I extends LifecycleFencedInput,
> = Extract<LifecycleFencedOperation, { readonly operation: I["operation"] }>;

export type LifecycleSemanticOperationWire<
  C extends LifecycleSemanticCommandDraft = LifecycleSemanticCommandDraft,
> = C extends LifecycleSemanticCommandDraft ? {
  readonly kind: "semantic";
  readonly operation: C["commandType"];
  readonly prepared: PreparedLifecycleWorkerCommand<C>;
} : never;

export type LifecycleInternalOperationWire<
  I extends InternalWorkflowExecutionPlan = InternalWorkflowExecutionPlan,
> = I extends InternalWorkflowExecutionPlan ? {
  readonly kind: "internal-semantic";
  readonly operation: I["commandType"];
  readonly command: I;
} : never;

export type LifecycleBoundedOperationWire<
  O extends LifecycleBoundedMutation = LifecycleBoundedMutation,
> = O extends LifecycleBoundedMutation ? {
  readonly kind: "bounded";
  readonly operation: O["operation"];
  readonly input: LifecycleBoundedMutationInput<O>;
} : never;

export type LifecycleQueryOperationWire<
  Q extends LifecycleQuery = LifecycleQuery,
> = Q extends LifecycleQuery ? {
  readonly kind: "query";
  readonly operation: Q["operation"];
  readonly input: LifecycleQueryInput<Q>;
} : never;

export type LifecycleFencedOperationWire<
  O extends LifecycleFencedOperation = LifecycleFencedOperation,
> = O extends LifecycleFencedOperation ? {
  readonly kind: "fenced";
  readonly operation: O["operation"];
  readonly input: LifecycleFencedInput<O>;
} : never;

export type LifecycleWorkerOperationWire =
  | LifecycleSemanticOperationWire
  | LifecycleInternalOperationWire
  | LifecycleBoundedOperationWire
  | LifecycleQueryOperationWire
  | LifecycleFencedOperationWire;

export type LifecycleWorkerOperation =
  | PreparedLifecycleWorkerCommand<LifecycleSemanticCommandDraft>
  | InternalWorkflowExecutionPlan
  | LifecycleBoundedMutation
  | LifecycleQuery
  | LifecycleFencedOperation;

export type LifecycleWorkerOperationName =
  | LifecycleSemanticCommandDraft["commandType"]
  | InternalWorkflowExecutionPlan["commandType"]
  | BoundedLifecycleOperation["operation"]
  | LifecycleFencedOperation["operation"];

type RootSemanticCommand = Extract<
  LifecycleSemanticCommandDraft,
  {
    readonly commandType:
      | "root-start"
      | "root-resume"
      | "root-recovery"
      | "root-suspend";
  }
>;

type ExecutableChildSemanticCommand = Extract<
  LifecycleSemanticCommandDraft,
  {
    readonly commandType:
      | "fork-child"
      | "amend-child-assignment"
      | "record-child-report"
      | "disposition-child-report"
      | "propose-child-completion"
      | "complete-child-session"
      | "suspend-child-session"
      | "claim-child-transfer";
  }
>;

type SessionEndSemanticCommand = Extract<
  LifecycleSemanticCommandDraft,
  {
    readonly commandType:
      | "request-session-end"
      | "amend-session-end"
      | "cancel-session-end"
      | "abandon-session";
  }
>;

export type LifecycleResultFor<C extends LifecycleSemanticCommandDraft> =
  C extends RootSemanticCommand ? RootSessionPublicResultV2
  : C extends ExecutableChildSemanticCommand ? ChildWorkflowResultV2
  : C extends Extract<LifecycleSemanticCommandDraft, { readonly commandType: "record-checkpoint" }>
    ? CheckpointRecordedResult
  : C extends Extract<LifecycleSemanticCommandDraft, { readonly commandType: "record-evidence-batch" }>
    ? EvidenceCoverageRecordedResultV2
  : C extends SessionEndSemanticCommand ? SessionEndStatusV2
  : never;

export type LifecycleInternalResultFor<I extends InternalWorkflowExecutionPlan> =
  I extends InternalValidationResultCommand ? ValidationResultRecordedResultV1
  : I extends InternalWorkflowPhasePlan ? SessionEndPhaseResultV2
  : never;

export type LifecycleBoundedResultFor<O extends LifecycleBoundedMutation> =
  O extends Extract<LifecycleBoundedMutation, { readonly operation: "renew-root-lease" }>
    ? RootLeaseRenewalResultV1
    : never;

export type LifecycleQueryResultFor<Q extends LifecycleQuery> =
  Q extends Extract<LifecycleQuery, { readonly operation: "read-session-tree" }>
    ? SessionTreeSummaryV1
  : Q extends Extract<LifecycleQuery, { readonly operation: "read-session-status" }>
    ? SessionStatusSummaryV1
  : Q extends Extract<LifecycleQuery, { readonly operation: "read-session-association" }>
    ? SessionAssociationValidationV1
  : never;

export type CheckpointWire = Extract<
  LifecycleSemanticOperationWire,
  { readonly operation: "record-checkpoint" }
>;

export type RootSuspendWire = Extract<
  LifecycleSemanticOperationWire,
  { readonly operation: "root-suspend" }
>;

export type SessionEndRequestWire = Extract<
  LifecycleSemanticOperationWire,
  { readonly operation: "request-session-end" }
>;

export type SessionEndAmendWire = Extract<
  LifecycleSemanticOperationWire,
  { readonly operation: "amend-session-end" }
>;

export type CheckpointResultWire =
  | CheckpointRecordedResultV1
  | CheckpointRecordedResultV2;

export type SessionEndWorkflowClaimWireV1 = JsonValue & {
  readonly resultVersion: 1;
  readonly projectId: ProjectId;
  readonly workflowId: WorkflowId;
  readonly sessionId: SessionId;
  readonly workflowGeneration: number;
  readonly phase: SessionEndPhase;
  readonly ownerId: string;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly triggeringEventPosition: string;
  readonly attemptCount: number;
};

export type LifecycleRecoveryScanResultWireV1 = JsonValue & {
  readonly resultVersion: 1;
  readonly integrityOk: boolean;
  readonly readOnly: boolean;
  readonly workflowCandidateCount: number;
  readonly outboxCandidateCount: number;
  readonly endingSessionCount: number;
  readonly expiredRootLeaseCount: number;
  readonly invariantFailureCodes: readonly string[];
};

export type LifecycleOutboxClaimWireV1 = JsonValue & {
  readonly resultVersion: 1;
  readonly projectId: ProjectId;
  readonly targetKey: string;
  readonly sessionId: SessionId;
  readonly artifactPath: string;
  readonly originKind: "workflow" | "terminal-event";
  readonly workflowId: WorkflowId | null;
  readonly workflowGeneration: number | null;
  readonly materializationRevision: string;
  readonly triggeringEventPosition: string;
  readonly ownerId: string;
  readonly claimToken: string;
  readonly claimExpiresAt: string;
  readonly attemptCount: number;
};

export type MaterializationFingerprintWireV1 = JsonValue & {
  readonly algorithm: "hmac-sha256";
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly domain: "pm-materialization-fingerprint-v1";
  readonly value: string;
};

export type MaterializationResultWireV1 = JsonValue & {
  readonly resultVersion: 1;
  readonly status: "completed" | "superseded-after-completion";
  readonly targetKey: string;
  readonly artifactPath: string;
  readonly materializationRevision: string;
  readonly fingerprint: MaterializationFingerprintWireV1;
  readonly acknowledged: boolean;
};

export type LifecycleFencedResultFor<O extends LifecycleFencedOperation> =
  O extends Extract<LifecycleFencedOperation, { readonly operation: "workflow-claim-next" }>
    ? SessionEndWorkflowClaimWireV1 | null
  : O extends Extract<LifecycleFencedOperation, { readonly operation: "workflow-claim" }>
    ? SessionEndWorkflowClaimWireV1 | null
  : O extends Extract<LifecycleFencedOperation, { readonly operation: "workflow-renew" }>
    ? SessionEndWorkflowClaimWireV1
  : O extends Extract<LifecycleFencedOperation, { readonly operation: "workflow-release" }>
    ? boolean
  : O extends Extract<LifecycleFencedOperation, { readonly operation: "workflow-eventless-phase" }>
    ? SessionEndPhaseResultV2
  : O extends Extract<LifecycleFencedOperation, { readonly operation: "workflow-recovery" }>
    ? LifecycleRecoveryScanResultWireV1
  : O extends Extract<LifecycleFencedOperation, { readonly operation: "outbox-claim-next" }>
    ? LifecycleOutboxClaimWireV1 | null
  : O extends Extract<LifecycleFencedOperation, { readonly operation: "outbox-claim" }>
    ? LifecycleOutboxClaimWireV1 | null
  : O extends Extract<LifecycleFencedOperation, { readonly operation: "outbox-renew" }>
    ? LifecycleOutboxClaimWireV1
  : O extends Extract<LifecycleFencedOperation, { readonly operation: "outbox-materialize" }>
    ? MaterializationResultWireV1
  : O extends Extract<LifecycleFencedOperation, { readonly operation: "outbox-failure" }>
    ? boolean
  : never;

export interface LifecycleWorkerSuccessWire {
  readonly operation: LifecycleWorkerOperationName;
  readonly nestedContractVersion: 1 | 2 | null;
  readonly result: JsonValue;
}

function validateLifecycleCommandBase(command: Readonly<Record<string, JsonValue>>): void {
  uuidValue(command.commandId, "command.commandId");
  stringValue(command.idempotencyKey, "command.idempotencyKey", 512);
  stringValue(command.agentId, "command.agentId", 256);
  uuidValue(command.expectedProjectId, "command.expectedProjectId");
  uuidValue(command.expectedVaultId, "command.expectedVaultId");
  hashValue(command.expectedWorkspaceId, "command.expectedWorkspaceId");
  if (command.expectedBranchRef !== null) {
    stringValue(command.expectedBranchRef, "command.expectedBranchRef", 1_024);
  }
}

function decodeSemanticOperation(
  source: Readonly<Record<string, JsonValue>>,
): LifecycleSemanticOperationWire {
  if (source.kind !== "semantic") invalid("operation.kind");
  const operation = stringValue(source.operation, "operation.operation") as LifecycleSemanticCommandDraft["commandType"];
  const prepared = exactSnapshot(
    source.prepared,
    ["command", "candidateIntentHash", "authorization"],
    "operation.prepared",
  );
  const commandInput = strictJsonSnapshot(prepared.command, "operation.prepared.command");
  const command = decodeLifecycleSemanticCommandDraft(commandInput);
  if (command.commandType !== operation) invalid("operation.operation");
  const candidateIntentHash = hashValue(
    prepared.candidateIntentHash,
    "operation.prepared.candidateIntentHash",
  );
  const authorization = strictJsonSnapshot(
    prepared.authorization,
    "operation.prepared.authorization",
  ) as unknown as SemanticCommandAuthorization;
  assertSemanticCommandAuthorization(command, authorization);
  const decodedPrepared = Object.freeze({
    command,
    candidateIntentHash,
    authorization,
  }) as PreparedLifecycleWorkerCommand<LifecycleSemanticCommandDraft>;
  return Object.freeze({
    kind: "semantic" as const,
    operation,
    prepared: decodedPrepared,
  }) as LifecycleSemanticOperationWire;
}

function validateClaim(value: JsonValue, field: string): void {
  const claim = exactSnapshot(
    value,
    ["workflowId", "workflowGeneration", "claimOwnerId", "claimToken", "claimExpiresAt"],
    field,
  );
  uuidValue(claim.workflowId, `${field}.workflowId`);
  integerValue(claim.workflowGeneration, `${field}.workflowGeneration`, 1);
  uuidValue(claim.claimOwnerId, `${field}.claimOwnerId`);
  decimalValue(claim.claimToken, `${field}.claimToken`, 1n);
  timestampValue(claim.claimExpiresAt, `${field}.claimExpiresAt`);
}

function validateValidationResultIds(value: JsonValue, field: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) invalid(field);
  const decoded = value.map((id, index) => uuidValue(id, `${field}[${index}]`));
  if (new Set(decoded).size !== decoded.length) invalid(field);
}

function validatePlannedAction(value: JsonValue): void {
  const action = strictDataRecord(value, undefined, "operation.command.plannedAction");
  switch (action.action) {
    case "prepare-final-checkpoint-and-queue-ending": {
      const planned = exactSnapshot(
        value,
        ["action", "finalCheckpointDraft", "materializationTarget"],
        "operation.command.plannedAction",
      );
      decodeCheckpointDraft(planned.finalCheckpointDraft);
      stringValue(planned.materializationTarget, "operation.command.plannedAction.materializationTarget", 1_024);
      return;
    }
    case "record-verification-failed": {
      const planned = exactSnapshot(
        value,
        ["action", "validationResultIds", "safeFailureCode"],
        "operation.command.plannedAction",
      );
      validateValidationResultIds(
        planned.validationResultIds,
        "operation.command.plannedAction.validationResultIds",
      );
      stringValue(planned.safeFailureCode, "operation.command.plannedAction.safeFailureCode", 128);
      return;
    }
    case "record-verification-passed": {
      const planned = exactSnapshot(
        value,
        ["action", "validationResultIds", "qualityScore"],
        "operation.command.plannedAction",
      );
      validateValidationResultIds(
        planned.validationResultIds,
        "operation.command.plannedAction.validationResultIds",
      );
      integerValue(
        planned.qualityScore,
        "operation.command.plannedAction.qualityScore",
        0,
        10_000,
      );
      return;
    }
    case "invalidate-verification": {
      const planned = exactSnapshot(
        value,
        ["action", "safeFailureCode"],
        "operation.command.plannedAction",
      );
      if (planned.safeFailureCode !== "SESSION_SOURCE_STATE_CONFLICT") {
        invalid("operation.command.plannedAction.safeFailureCode");
      }
      return;
    }
    case "append-terminal-completion": {
      const planned = exactSnapshot(
        value,
        ["action", "verificationEventPosition", "materializationTarget"],
        "operation.command.plannedAction",
      );
      decimalValue(planned.verificationEventPosition, "operation.command.plannedAction.verificationEventPosition", 1n);
      stringValue(planned.materializationTarget, "operation.command.plannedAction.materializationTarget", 1_024);
      return;
    }
    default:
      invalid("operation.command.plannedAction.action");
  }
}

function decodeInternalOperation(
  source: Readonly<Record<string, JsonValue>>,
): LifecycleInternalOperationWire {
  if (source.kind !== "internal-semantic") invalid("operation.kind");
  const operation = stringValue(source.operation, "operation.operation");
  const command = strictJsonSnapshot(source.command, "operation.command") as unknown as InternalWorkflowExecutionPlan;
  if (command.commandType !== operation) invalid("operation.operation");
  if (operation === "internal-validation-result") {
    assertInternalValidationResultBinding(command as InternalValidationResultCommand);
  } else if (operation === "internal-workflow-phase") {
    const record = exactSnapshot(
      command,
      [
        "commandType", "commandId", "idempotencyKey", "agentId", "expectedProjectId",
        "expectedVaultId", "expectedWorkspaceId", "expectedBranchRef", "workflowId",
        "workflowGeneration", "sourcePhase", "plannedWorkId", "claim", "plannedAction",
      ],
      "operation.command",
    );
    validateLifecycleCommandBase(record);
    uuidValue(record.workflowId, "operation.command.workflowId");
    integerValue(record.workflowGeneration, "operation.command.workflowGeneration", 1);
    stringValue(record.sourcePhase, "operation.command.sourcePhase", 128);
    hashValue(record.plannedWorkId, "operation.command.plannedWorkId");
    validateClaim(record.claim, "operation.command.claim");
    const claim = record.claim as Readonly<Record<string, JsonValue>>;
    if (
      claim.workflowId !== record.workflowId
      || claim.workflowGeneration !== record.workflowGeneration
    ) invalid("operation.command.claim");
    validatePlannedAction(record.plannedAction);
  } else {
    invalid("operation.operation");
  }
  return Object.freeze({
    kind: "internal-semantic" as const,
    operation: operation as InternalWorkflowExecutionPlan["commandType"],
    command,
  }) as LifecycleInternalOperationWire;
}

function decodeBoundedAuthorization(
  value: JsonValue,
): BoundedOperationAuthorizationWire {
  const authorization = exactSnapshot(
    value,
    ["kind", "authoritySessionId", "targetSessionId", "proof"],
    "operation.input.authorization",
  );
  if (authorization.kind !== "bounded-operation") invalid("operation.input.authorization.kind");
  const proofRecord = exactSnapshot(
    authorization.proof,
    ["proofVersion", "target", "proofNonce", "proofFingerprint"],
    "operation.input.authorization.proof",
  );
  if (proofRecord.proofVersion !== 1 || proofRecord.target !== "bounded-operation") {
    invalid("operation.input.authorization.proof");
  }
  const decodedProof: CapabilityProofV1 = Object.freeze({
    proofVersion: 1,
    target: "bounded-operation",
    proofNonce: uuidValue(proofRecord.proofNonce, "operation.input.authorization.proof.proofNonce"),
    proofFingerprint: hashValue(
      proofRecord.proofFingerprint,
      "operation.input.authorization.proof.proofFingerprint",
    ),
  });
  return Object.freeze({
    kind: "bounded-operation" as const,
    authoritySessionId: uuidValue(
      authorization.authoritySessionId,
      "operation.input.authorization.authoritySessionId",
    ) as SessionId,
    targetSessionId: uuidValue(
      authorization.targetSessionId,
      "operation.input.authorization.targetSessionId",
    ) as SessionId,
    proof: decodedProof,
  });
}

function decodeBoundedOrQueryOperation(
  source: Readonly<Record<string, JsonValue>>,
): LifecycleBoundedOperationWire | LifecycleQueryOperationWire {
  const kind = source.kind;
  if (kind !== "bounded" && kind !== "query") invalid("operation.kind");
  const operation = stringValue(source.operation, "operation.operation");
  const query = operation === "read-session-tree"
    || operation === "read-session-status"
    || operation === "read-session-association";
  if ((kind === "query") !== query && !(kind === "bounded" && operation === "renew-root-lease")) {
    invalid("operation.operation");
  }
  const keys = operation === "renew-root-lease"
    ? ["operation", "operationId", "requestId", "authorization", "sessionId", "expectedOwnerGeneration"]
    : ["operation", "operationId", "requestId", "authorization", "sessionId"];
  const input = exactSnapshot(source.input, keys, "operation.input");
  if (input.operation !== operation) invalid("operation.input.operation");
  const authorization = decodeBoundedAuthorization(input.authorization);
  const sessionId = uuidValue(input.sessionId, "operation.input.sessionId") as SessionId;
  if (
    authorization.authoritySessionId !== sessionId
    || authorization.targetSessionId !== sessionId
  ) invalid("operation.input.authorization");
  const common = {
    operation: operation as BoundedLifecycleOperation["operation"],
    operationId: uuidValue(input.operationId, "operation.input.operationId"),
    requestId: uuidValue(input.requestId, "operation.input.requestId"),
    authorization,
    sessionId,
  };
  if (operation === "renew-root-lease") {
    const decodedInput = Object.freeze({
      ...common,
      operation: "renew-root-lease" as const,
      expectedOwnerGeneration: integerValue(
        input.expectedOwnerGeneration,
        "operation.input.expectedOwnerGeneration",
        1,
      ),
    });
    return Object.freeze({
      kind: "bounded" as const,
      operation: "renew-root-lease" as const,
      input: decodedInput,
    });
  }
  const decodedInput = Object.freeze({
    ...common,
    operation: operation as LifecycleQuery["operation"],
  });
  return Object.freeze({
    kind: "query" as const,
    operation: operation as LifecycleQuery["operation"],
    input: decodedInput,
  }) as LifecycleQueryOperationWire;
}

function fencedKeys(operation: string): readonly string[] {
  switch (operation) {
    case "workflow-claim-next":
    case "outbox-claim-next":
      return ["operation", "workId", "ownerId", "observedNowMs", "ttlMs"];
    case "workflow-claim":
    case "workflow-renew":
      return [
        "operation", "workId", "ownerId", "fencingToken", "workflowId",
        "workflowGeneration", "leaseUntil",
      ];
    case "workflow-release":
      return [
        "operation", "workId", "ownerId", "fencingToken", "workflowId",
        "workflowGeneration",
      ];
    case "workflow-eventless-phase":
      return [
        "operation", "workId", "ownerId", "fencingToken", "workflowId",
        "workflowGeneration", "expectedPhase", "nextPhase",
      ];
    case "workflow-recovery":
      return ["operation", "workId", "ownerId", "fencingToken", "dueBefore", "limit"];
    case "outbox-claim":
    case "outbox-renew":
      return [
        "operation", "workId", "ownerId", "fencingToken", "targetKey",
        "materializationRevision", "leaseUntil",
      ];
    case "outbox-materialize":
      return [
        "operation", "workId", "ownerId", "fencingToken", "targetKey",
        "materializationRevision",
      ];
    case "outbox-failure":
      return [
        "operation", "workId", "ownerId", "fencingToken", "targetKey",
        "materializationRevision", "retryable", "safeErrorCode", "attempt", "nextAttemptAt",
      ];
    default:
      invalid("operation.operation");
  }
}

function decodeFencedOperation(
  source: Readonly<Record<string, JsonValue>>,
): LifecycleFencedOperationWire {
  if (source.kind !== "fenced") invalid("operation.kind");
  const operation = stringValue(source.operation, "operation.operation");
  const input = exactSnapshot(source.input, fencedKeys(operation), "operation.input");
  if (input.operation !== operation) invalid("operation.input.operation");
  const decoded: Record<string, JsonValue> = {
    operation,
    workId: stringValue(input.workId, "operation.input.workId", 256),
    ownerId: stringValue(input.ownerId, "operation.input.ownerId", 256),
  };
  if (operation === "workflow-claim-next" || operation === "outbox-claim-next") {
    decoded.observedNowMs = decimalValue(input.observedNowMs, "operation.input.observedNowMs");
    decoded.ttlMs = decimalValue(input.ttlMs, "operation.input.ttlMs", 1n);
  } else {
    decoded.fencingToken = decimalValue(input.fencingToken, "operation.input.fencingToken", 1n);
  }
  if (operation.startsWith("workflow-") && !["workflow-claim-next", "workflow-recovery"].includes(operation)) {
    decoded.workflowId = uuidValue(input.workflowId, "operation.input.workflowId");
    decoded.workflowGeneration = integerValue(
      input.workflowGeneration,
      "operation.input.workflowGeneration",
      1,
    );
  }
  if (operation.startsWith("outbox-") && operation !== "outbox-claim-next") {
    decoded.targetKey = stringValue(input.targetKey, "operation.input.targetKey", 1_024);
    decoded.materializationRevision = decimalValue(
      input.materializationRevision,
      "operation.input.materializationRevision",
      1n,
    );
  }
  if (operation === "workflow-claim" || operation === "workflow-renew"
    || operation === "outbox-claim" || operation === "outbox-renew") {
    decoded.leaseUntil = timestampValue(input.leaseUntil, "operation.input.leaseUntil");
  } else if (operation === "workflow-eventless-phase") {
    const expectedPhase = stringValue(input.expectedPhase, "operation.input.expectedPhase", 128);
    const nextPhase = stringValue(input.nextPhase, "operation.input.nextPhase", 128);
    if (!PHASE.test(expectedPhase) || !PHASE.test(nextPhase)) invalid("operation.input.phase");
    decoded.expectedPhase = expectedPhase;
    decoded.nextPhase = nextPhase;
  } else if (operation === "workflow-recovery") {
    decoded.dueBefore = timestampValue(input.dueBefore, "operation.input.dueBefore");
    decoded.limit = integerValue(input.limit, "operation.input.limit", 1);
  } else if (operation === "outbox-failure") {
    decoded.retryable = booleanValue(input.retryable, "operation.input.retryable");
    decoded.safeErrorCode = stringValue(input.safeErrorCode, "operation.input.safeErrorCode", 128);
    decoded.attempt = integerValue(input.attempt, "operation.input.attempt", 1);
    decoded.nextAttemptAt = input.nextAttemptAt === null
      ? null
      : timestampValue(input.nextAttemptAt, "operation.input.nextAttemptAt");
  }
  const frozenInput = Object.freeze(decoded) as unknown as LifecycleFencedInput;
  return Object.freeze({
    kind: "fenced" as const,
    operation: operation as LifecycleFencedOperation["operation"],
    input: frozenInput,
  }) as LifecycleFencedOperationWire;
}

export function decodeLifecycleWorkerOperationWire(
  value: unknown,
): LifecycleWorkerOperationWire {
  const observed = strictDataRecord(value, undefined, "operation");
  const payloadKey = observed.kind === "semantic"
    ? "prepared"
    : observed.kind === "internal-semantic" ? "command" : "input";
  const source = exactSnapshot(value, ["kind", "operation", payloadKey], "operation");
  switch (source.kind) {
    case "semantic": return decodeSemanticOperation(source);
    case "internal-semantic": return decodeInternalOperation(source);
    case "bounded":
    case "query": return decodeBoundedOrQueryOperation(source);
    case "fenced": return decodeFencedOperation(source);
    default: return invalid("operation.kind");
  }
}

export function materializeLifecycleWorkerOperation(
  wire: LifecycleWorkerOperationWire,
  context: ProjectContext,
): LifecycleWorkerOperation {
  if (wire.kind === "semantic") return wire.prepared;
  if (wire.kind === "internal-semantic") return wire.command;
  const workspace = Object.freeze({ ...context.workspace });
  const storeRoute = Object.freeze({ ...context.binding.storeRoute });
  const binding = Object.freeze({
    ...context.binding,
    storeRoute,
    workspace,
  });
  const contextSnapshot = Object.freeze({
    binding,
    workspace,
    ...(context.branchScopeId === undefined
      ? {}
      : { branchScopeId: context.branchScopeId }),
    checkedAt: context.checkedAt,
  }) as ProjectContext;
  if (wire.kind === "bounded" || wire.kind === "query") {
    const audience = Object.freeze({
      presentingActorRole: contextSnapshot.binding.actorRole,
      presentingClientInstanceId: contextSnapshot.binding.clientInstanceId,
      targetActorRole: contextSnapshot.binding.actorRole,
      targetClientInstanceId: contextSnapshot.binding.clientInstanceId,
    });
    const authorization = Object.freeze({
      ...wire.input.authorization,
      audience,
    });
    return Object.freeze({
      ...wire.input,
      context: contextSnapshot,
      authorization,
    }) as LifecycleBoundedMutation | LifecycleQuery;
  }
  return Object.freeze({ ...wire.input, context: contextSnapshot }) as LifecycleFencedOperation;
}

function decodeRootResult(value: JsonValue): RootSessionPublicResultV2 {
  const result = exactSnapshot(value, [
    "resultVersion", "project", "sessionId", "ownerGeneration", "continuityKey",
    "state", "resumedFromSessionId", "latestCheckpointEventPosition", "eventPosition",
    "handleIssued", "resumeTokenIssued", "contextPackUnavailable",
  ], "success.result");
  if (result.resultVersion !== 2) invalid("success.result.resultVersion");
  const project = exactSnapshot(
    result.project,
    ["projectId", "vaultId", "storeId", "workspaceId", "clientNamespace"],
    "success.result.project",
  );
  uuidValue(project.projectId, "success.result.project.projectId");
  uuidValue(project.vaultId, "success.result.project.vaultId");
  uuidValue(project.storeId, "success.result.project.storeId");
  hashValue(project.workspaceId, "success.result.project.workspaceId");
  stringValue(project.clientNamespace, "success.result.project.clientNamespace", 256);
  uuidValue(result.sessionId, "success.result.sessionId");
  decimalValue(result.ownerGeneration, "success.result.ownerGeneration", 1n);
  stringValue(result.continuityKey, "success.result.continuityKey", 1_024);
  if (!["active", "suspended", "ending", "ended", "abandoned"].includes(String(result.state))) {
    invalid("success.result.state");
  }
  if (result.resumedFromSessionId !== null) {
    uuidValue(result.resumedFromSessionId, "success.result.resumedFromSessionId");
  }
  if (result.latestCheckpointEventPosition !== null) {
    decimalValue(
      result.latestCheckpointEventPosition,
      "success.result.latestCheckpointEventPosition",
      1n,
    );
  }
  decimalValue(result.eventPosition, "success.result.eventPosition", 1n);
  booleanValue(result.handleIssued, "success.result.handleIssued");
  booleanValue(result.resumeTokenIssued, "success.result.resumeTokenIssued");
  if (result.contextPackUnavailable !== true) invalid("success.result.contextPackUnavailable");
  return result as unknown as RootSessionPublicResultV2;
}

const CHILD_SESSION_STATE_VALUES = new Set([
  "active",
  "completion-proposed",
  "completed",
  "suspended",
  "transferred",
]);
const CHILD_DISPOSITION_KIND_VALUES = new Set([
  "accepted",
  "partially-accepted",
  "rejected",
  "superseded",
]);

function decodeChildResult(value: JsonValue, operation: string): ChildWorkflowResultV2 {
  const common = [
    "resultVersion", "operation", "childSessionId", "parentSessionId", "state",
    "eventPosition", "finalStreamVersion",
  ];
  const extraByOperation: Readonly<Record<string, readonly string[]>> = {
    "fork-child": ["directAccessEnabled", "rootOwnerGeneration", "assignment", "assignmentRevision"],
    "amend-child-assignment": ["assignment", "assignmentRevision"],
    "record-child-report": ["assignmentRevision", "reportId", "reportItemIds"],
    "disposition-child-report": ["disposition"],
    "propose-child-completion": ["reportId"],
    "complete-child-session": ["reportId"],
    "suspend-child-session": ["assignment", "assignmentRevision", "transferTicketId"],
    "claim-child-transfer": [
      "previousChildSessionId", "transferTicketId", "assignment", "assignmentRevision",
      "directAccessEnabled", "rootOwnerGeneration",
    ],
  };
  const extras = extraByOperation[operation];
  if (extras === undefined) invalid("success.result.operation");
  const result = exactSnapshot(value, [...common, ...extras], "success.result");
  if (result.resultVersion !== 2 || result.operation !== operation) invalid("success.result.operation");
  uuidValue(result.childSessionId, "success.result.childSessionId");
  uuidValue(result.parentSessionId, "success.result.parentSessionId");
  decimalValue(result.eventPosition, "success.result.eventPosition", 1n);
  decimalValue(result.finalStreamVersion, "success.result.finalStreamVersion", 1n);
  if (result.directAccessEnabled !== undefined) booleanValue(result.directAccessEnabled, "success.result.directAccessEnabled");
  if (result.rootOwnerGeneration !== undefined) decimalValue(result.rootOwnerGeneration, "success.result.rootOwnerGeneration", 1n);
  if (result.assignmentRevision !== undefined) decimalValue(result.assignmentRevision, "success.result.assignmentRevision", 1n);
  for (const field of ["reportId", "transferTicketId", "previousChildSessionId"] as const) {
    if (result[field] !== undefined) uuidValue(result[field], `success.result.${field}`);
  }
  if (result.reportItemIds !== undefined) {
    if (!Array.isArray(result.reportItemIds) || result.reportItemIds.length > 200) {
      invalid("success.result.reportItemIds");
    }
    const reportItemIds = result.reportItemIds.map((id, index) =>
      uuidValue(id, `success.result.reportItemIds[${index}]`));
    if (new Set(reportItemIds).size !== reportItemIds.length) {
      invalid("success.result.reportItemIds");
    }
  }
  if (result.assignment !== undefined) {
    const assignment = exactSnapshot(
      result.assignment,
      ["assignmentId", "summary", "scope"],
      "success.result.assignment",
    );
    uuidValue(assignment.assignmentId, "success.result.assignment.assignmentId");
    stringValue(assignment.summary, "success.result.assignment.summary", 4_000);
    stringValue(assignment.scope, "success.result.assignment.scope", 4_000);
  }
  if (result.disposition !== undefined) {
    const disposition = exactSnapshot(
      result.disposition,
      ["kind", "reportId"],
      "success.result.disposition",
    );
    if (!CHILD_DISPOSITION_KIND_VALUES.has(String(disposition.kind))) {
      invalid("success.result.disposition.kind");
    }
    uuidValue(disposition.reportId, "success.result.disposition.reportId");
  }
  if (!CHILD_SESSION_STATE_VALUES.has(String(result.state))) {
    invalid("success.result.state");
  }
  return result as ChildWorkflowResultV2;
}

const SESSION_END_PHASE_VALUES = new Set([
  "requested", "children-resolved", "final-checkpoint-recorded",
  "ending-materialization-queued", "validating", "verification-passed",
  "verification-failed", "completion-appended", "completed-materialization-confirmed",
  "completed", "cancelled", "abandoned",
]);
const SESSION_END_PHASE_ACTION_VALUES = new Set([
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

function decodeSessionEndStatus(value: JsonValue): SessionEndStatusV2 {
  const result = exactSnapshot(value, [
    "resultVersion", "sessionId", "workflowId", "workflowGeneration", "phase",
    "priorRootState", "triggeringEventPosition", "finalCheckpointId",
    "finalCheckpointEventPosition", "evidenceWindow", "validationPlansReady",
    "qualityScore", "safeFailureCode", "materializationRequired",
  ], "success.result");
  if (result.resultVersion !== 2) invalid("success.result.resultVersion");
  uuidValue(result.sessionId, "success.result.sessionId");
  uuidValue(result.workflowId, "success.result.workflowId");
  integerValue(result.workflowGeneration, "success.result.workflowGeneration", 1);
  if (!SESSION_END_PHASE_VALUES.has(String(result.phase))) invalid("success.result.phase");
  if (result.priorRootState !== "active" && result.priorRootState !== "suspended") {
    invalid("success.result.priorRootState");
  }
  decimalValue(result.triggeringEventPosition, "success.result.triggeringEventPosition", 1n);
  if (result.finalCheckpointId !== null) uuidValue(result.finalCheckpointId, "success.result.finalCheckpointId");
  if (result.finalCheckpointEventPosition !== null) {
    decimalValue(result.finalCheckpointEventPosition, "success.result.finalCheckpointEventPosition", 1n);
  }
  const evidenceWindow = exactSnapshot(result.evidenceWindow, [
    "evidenceWindowState", "evidenceFrozenCheckpointEventPosition", "evidenceFrozenGeneration",
  ], "success.result.evidenceWindow");
  if (evidenceWindow.evidenceWindowState !== "open" && evidenceWindow.evidenceWindowState !== "sealed") {
    invalid("success.result.evidenceWindow.evidenceWindowState");
  }
  if (evidenceWindow.evidenceFrozenCheckpointEventPosition !== null) {
    decimalValue(
      evidenceWindow.evidenceFrozenCheckpointEventPosition,
      "success.result.evidenceWindow.evidenceFrozenCheckpointEventPosition",
      1n,
    );
  }
  if (evidenceWindow.evidenceFrozenGeneration !== null) {
    integerValue(
      evidenceWindow.evidenceFrozenGeneration,
      "success.result.evidenceWindow.evidenceFrozenGeneration",
      1,
    );
  }
  booleanValue(result.validationPlansReady, "success.result.validationPlansReady");
  if (result.qualityScore !== null) {
    integerValue(result.qualityScore, "success.result.qualityScore", 0, 10_000);
  }
  if (result.safeFailureCode !== null) stringValue(result.safeFailureCode, "success.result.safeFailureCode", 128);
  booleanValue(result.materializationRequired, "success.result.materializationRequired");
  return result as SessionEndStatusV2;
}

function decodeSessionEndPhaseResult(value: JsonValue): SessionEndPhaseResultV2 {
  const result = exactSnapshot(
    value,
    ["resultVersion", "action", "progressed", "previousPhase", "status"],
    "success.result",
  );
  if (result.resultVersion !== 2) invalid("success.result.resultVersion");
  const action = stringValue(result.action, "success.result.action", 128);
  if (!SESSION_END_PHASE_ACTION_VALUES.has(action)) invalid("success.result.action");
  booleanValue(result.progressed, "success.result.progressed");
  if (!SESSION_END_PHASE_VALUES.has(String(result.previousPhase))) invalid("success.result.previousPhase");
  const status = decodeSessionEndStatus(result.status);
  return Object.freeze({
    resultVersion: 2,
    action: result.action,
    progressed: result.progressed,
    previousPhase: result.previousPhase,
    status,
  }) as SessionEndPhaseResultV2;
}

function decodeValidationRecordedResult(value: JsonValue): ValidationResultRecordedResultV1 {
  const result = exactSnapshot(value, [
    "resultVersion", "resultId", "workflowId", "workflowGeneration",
    "eventPosition", "finalStreamVersion",
  ], "success.result");
  if (result.resultVersion !== 1) invalid("success.result.resultVersion");
  uuidValue(result.resultId, "success.result.resultId");
  uuidValue(result.workflowId, "success.result.workflowId");
  integerValue(result.workflowGeneration, "success.result.workflowGeneration", 1);
  decimalValue(result.eventPosition, "success.result.eventPosition", 1n);
  decimalValue(result.finalStreamVersion, "success.result.finalStreamVersion", 1n);
  return result as ValidationResultRecordedResultV1;
}

function decodeLeaseResult(
  value: JsonValue,
  requested: LifecycleBoundedOperationWire,
): RootLeaseRenewalResultV1 {
  const result = exactSnapshot(value, [
    "resultVersion", "operationId", "requestId", "sessionId", "ownerGeneration",
    "lastObservedAt", "expiresAt",
  ], "success.result");
  if (result.resultVersion !== 1) invalid("success.result.resultVersion");
  uuidValue(result.operationId, "success.result.operationId");
  uuidValue(result.requestId, "success.result.requestId");
  uuidValue(result.sessionId, "success.result.sessionId");
  decimalValue(result.ownerGeneration, "success.result.ownerGeneration", 1n);
  timestampValue(result.lastObservedAt, "success.result.lastObservedAt");
  timestampValue(result.expiresAt, "success.result.expiresAt");
  if (result.operationId !== requested.input.operationId) invalid("success.result.operationId");
  if (result.requestId !== requested.input.requestId) invalid("success.result.requestId");
  if (result.sessionId !== requested.input.sessionId) invalid("success.result.sessionId");
  if (result.ownerGeneration !== String(requested.input.expectedOwnerGeneration)) {
    invalid("success.result.ownerGeneration");
  }
  return result as unknown as RootLeaseRenewalResultV1;
}

function decodeSessionSummary(value: JsonValue, field: string): Readonly<Record<string, JsonValue>> {
  const result = exactSnapshot(value, [
    "sessionId", "sessionKind", "parentSessionId", "state", "ownerGeneration",
    "childCapabilityGeneration", "authorityClientInstanceId", "directAccessEnabled",
    "streamVersion", "eventPosition", "latestCheckpointEventPosition", "checkpointRequired",
  ], field);
  uuidValue(result.sessionId, `${field}.sessionId`);
  if (result.sessionKind !== "root" && result.sessionKind !== "child") invalid(`${field}.sessionKind`);
  if (result.parentSessionId !== null) uuidValue(result.parentSessionId, `${field}.parentSessionId`);
  stringValue(result.state, `${field}.state`, 128);
  for (const key of ["ownerGeneration", "childCapabilityGeneration"] as const) {
    if (result[key] !== null) decimalValue(result[key], `${field}.${key}`, 1n);
  }
  if (result.authorityClientInstanceId !== null) {
    stringValue(result.authorityClientInstanceId, `${field}.authorityClientInstanceId`, 256);
  }
  booleanValue(result.directAccessEnabled, `${field}.directAccessEnabled`);
  decimalValue(result.streamVersion, `${field}.streamVersion`);
  decimalValue(result.eventPosition, `${field}.eventPosition`, 1n);
  if (result.latestCheckpointEventPosition !== null) {
    decimalValue(result.latestCheckpointEventPosition, `${field}.latestCheckpointEventPosition`, 1n);
  }
  booleanValue(result.checkpointRequired, `${field}.checkpointRequired`);
  return result;
}

function decodeQueryResult(value: JsonValue, requested: LifecycleQueryOperationWire):
SessionTreeSummaryV1 | SessionStatusSummaryV1 | SessionAssociationValidationV1 {
  const operation = requested.operation;
  const input = requested.input;
  if (operation === "read-session-tree") {
    const result = exactSnapshot(value, [
      "resultVersion", "operation", "operationId", "requestId", "root", "children",
      "childrenTruncated",
    ], "success.result");
    if (result.resultVersion !== 1 || result.operation !== operation) invalid("success.result.operation");
    uuidValue(result.operationId, "success.result.operationId");
    uuidValue(result.requestId, "success.result.requestId");
    if (result.operationId !== input.operationId) invalid("success.result.operationId");
    if (result.requestId !== input.requestId) invalid("success.result.requestId");
    const root = decodeSessionSummary(result.root, "success.result.root");
    if (root.sessionId !== input.sessionId) invalid("success.result.root.sessionId");
    if (root.sessionKind !== "root") invalid("success.result.root.sessionKind");
    if (root.parentSessionId !== null) invalid("success.result.root.parentSessionId");
    if (!Array.isArray(result.children) || result.children.length > 200) invalid("success.result.children");
    result.children.forEach((child, index) => {
      const summary = decodeSessionSummary(child, `success.result.children[${index}]`);
      if (summary.sessionKind !== "child") {
        invalid(`success.result.children[${index}].sessionKind`);
      }
      if (summary.parentSessionId !== input.sessionId) {
        invalid(`success.result.children[${index}].parentSessionId`);
      }
    });
    booleanValue(result.childrenTruncated, "success.result.childrenTruncated");
    return result as unknown as SessionTreeSummaryV1;
  }
  if (operation === "read-session-status") {
    const result = exactSnapshot(value, [
      "resultVersion", "operation", "operationId", "requestId", "session",
    ], "success.result");
    if (result.resultVersion !== 1 || result.operation !== operation) invalid("success.result.operation");
    uuidValue(result.operationId, "success.result.operationId");
    uuidValue(result.requestId, "success.result.requestId");
    if (result.operationId !== input.operationId) invalid("success.result.operationId");
    if (result.requestId !== input.requestId) invalid("success.result.requestId");
    const session = decodeSessionSummary(result.session, "success.result.session");
    if (session.sessionId !== input.sessionId) invalid("success.result.session.sessionId");
    return result as unknown as SessionStatusSummaryV1;
  }
  const result = exactSnapshot(value, [
    "resultVersion", "operation", "operationId", "requestId", "associated",
    "sessionId", "rootSessionId",
  ], "success.result");
  if (result.resultVersion !== 1 || result.operation !== operation || result.associated !== true) {
    invalid("success.result.operation");
  }
  uuidValue(result.operationId, "success.result.operationId");
  uuidValue(result.requestId, "success.result.requestId");
  uuidValue(result.sessionId, "success.result.sessionId");
  uuidValue(result.rootSessionId, "success.result.rootSessionId");
  if (result.operationId !== input.operationId) invalid("success.result.operationId");
  if (result.requestId !== input.requestId) invalid("success.result.requestId");
  if (result.sessionId !== input.sessionId) invalid("success.result.sessionId");
  return result as unknown as SessionAssociationValidationV1;
}

function decodeWorkflowClaimResult(value: JsonValue): SessionEndWorkflowClaimWireV1 {
  const result = exactSnapshot(value, [
    "resultVersion", "projectId", "workflowId", "sessionId", "workflowGeneration", "phase",
    "ownerId", "claimToken", "claimExpiresAt", "triggeringEventPosition", "attemptCount",
  ], "success.result");
  if (result.resultVersion !== 1) invalid("success.result.resultVersion");
  uuidValue(result.projectId, "success.result.projectId");
  uuidValue(result.workflowId, "success.result.workflowId");
  uuidValue(result.sessionId, "success.result.sessionId");
  integerValue(result.workflowGeneration, "success.result.workflowGeneration", 1);
  if (!SESSION_END_PHASE_VALUES.has(String(result.phase))) invalid("success.result.phase");
  stringValue(result.ownerId, "success.result.ownerId", 256);
  decimalValue(result.claimToken, "success.result.claimToken", 1n);
  timestampValue(result.claimExpiresAt, "success.result.claimExpiresAt");
  decimalValue(result.triggeringEventPosition, "success.result.triggeringEventPosition", 1n);
  integerValue(result.attemptCount, "success.result.attemptCount", 0);
  return result as SessionEndWorkflowClaimWireV1;
}

function decodeRecoveryResult(value: JsonValue): LifecycleRecoveryScanResultWireV1 {
  const result = exactSnapshot(value, [
    "resultVersion", "integrityOk", "readOnly", "workflowCandidateCount",
    "outboxCandidateCount", "endingSessionCount", "expiredRootLeaseCount",
    "invariantFailureCodes",
  ], "success.result");
  if (result.resultVersion !== 1) invalid("success.result.resultVersion");
  booleanValue(result.integrityOk, "success.result.integrityOk");
  booleanValue(result.readOnly, "success.result.readOnly");
  for (const key of [
    "workflowCandidateCount", "outboxCandidateCount", "endingSessionCount", "expiredRootLeaseCount",
  ] as const) integerValue(result[key], `success.result.${key}`, 0);
  if (!Array.isArray(result.invariantFailureCodes)) invalid("success.result.invariantFailureCodes");
  for (const code of result.invariantFailureCodes) stringValue(code, "success.result.invariantFailureCodes", 128);
  return result as LifecycleRecoveryScanResultWireV1;
}

function decodeOutboxClaimResult(value: JsonValue): LifecycleOutboxClaimWireV1 {
  const result = exactSnapshot(value, [
    "resultVersion", "projectId", "targetKey", "sessionId", "artifactPath", "originKind",
    "workflowId", "workflowGeneration", "materializationRevision", "triggeringEventPosition",
    "ownerId", "claimToken", "claimExpiresAt", "attemptCount",
  ], "success.result");
  if (result.resultVersion !== 1) invalid("success.result.resultVersion");
  uuidValue(result.projectId, "success.result.projectId");
  stringValue(result.targetKey, "success.result.targetKey", 1_024);
  uuidValue(result.sessionId, "success.result.sessionId");
  stringValue(result.artifactPath, "success.result.artifactPath", 4_096);
  if (result.originKind !== "workflow" && result.originKind !== "terminal-event") {
    invalid("success.result.originKind");
  }
  if (result.workflowId !== null) uuidValue(result.workflowId, "success.result.workflowId");
  if (result.workflowGeneration !== null) integerValue(result.workflowGeneration, "success.result.workflowGeneration", 1);
  if ((result.workflowId === null) !== (result.workflowGeneration === null)) invalid("success.result.workflowId");
  decimalValue(result.materializationRevision, "success.result.materializationRevision", 1n);
  decimalValue(result.triggeringEventPosition, "success.result.triggeringEventPosition", 1n);
  stringValue(result.ownerId, "success.result.ownerId", 256);
  decimalValue(result.claimToken, "success.result.claimToken", 1n);
  timestampValue(result.claimExpiresAt, "success.result.claimExpiresAt");
  integerValue(result.attemptCount, "success.result.attemptCount", 0);
  return result as LifecycleOutboxClaimWireV1;
}

function decodeMaterializationResult(value: JsonValue): MaterializationResultWireV1 {
  const result = exactSnapshot(value, [
    "resultVersion", "status", "targetKey", "artifactPath", "materializationRevision",
    "fingerprint", "acknowledged",
  ], "success.result");
  if (result.resultVersion !== 1
    || (result.status !== "completed" && result.status !== "superseded-after-completion")) {
    invalid("success.result.status");
  }
  stringValue(result.targetKey, "success.result.targetKey", 1_024);
  stringValue(result.artifactPath, "success.result.artifactPath", 4_096);
  decimalValue(result.materializationRevision, "success.result.materializationRevision", 1n);
  const fingerprint = exactSnapshot(result.fingerprint, [
    "algorithm", "schemaVersion", "keyId", "domain", "value",
  ], "success.result.fingerprint");
  if (
    fingerprint.algorithm !== "hmac-sha256"
    || fingerprint.schemaVersion !== 1
    || fingerprint.domain !== "pm-materialization-fingerprint-v1"
  ) invalid("success.result.fingerprint");
  stringValue(fingerprint.keyId, "success.result.fingerprint.keyId", 128);
  hashValue(fingerprint.value, "success.result.fingerprint.value");
  booleanValue(result.acknowledged, "success.result.acknowledged");
  return result as MaterializationResultWireV1;
}

function decodeFencedResult(
  value: JsonValue,
  requested: LifecycleFencedOperationWire,
): JsonValue {
  const operation = requested.operation;
  switch (operation) {
    case "workflow-claim-next": {
      const input = requested.input as Extract<
        LifecycleFencedInput,
        { readonly operation: "workflow-claim-next" }
      >;
      if (value === null) return null;
      const result = decodeWorkflowClaimResult(value);
      if (result.ownerId !== input.ownerId) invalid("success.result.ownerId");
      return result;
    }
    case "workflow-claim": {
      const input = requested.input as Extract<
        LifecycleFencedInput,
        { readonly operation: "workflow-claim" }
      >;
      if (value === null) return null;
      const result = decodeWorkflowClaimResult(value);
      if (result.workflowId !== input.workflowId) invalid("success.result.workflowId");
      if (result.workflowGeneration !== input.workflowGeneration) {
        invalid("success.result.workflowGeneration");
      }
      if (result.ownerId !== input.ownerId) invalid("success.result.ownerId");
      if (result.claimToken !== input.fencingToken) invalid("success.result.claimToken");
      if (result.claimExpiresAt !== input.leaseUntil) invalid("success.result.claimExpiresAt");
      return result;
    }
    case "workflow-renew": {
      const input = requested.input as Extract<
        LifecycleFencedInput,
        { readonly operation: "workflow-renew" }
      >;
      const result = decodeWorkflowClaimResult(value);
      if (result.workflowId !== input.workflowId) invalid("success.result.workflowId");
      if (result.workflowGeneration !== input.workflowGeneration) {
        invalid("success.result.workflowGeneration");
      }
      if (result.ownerId !== input.ownerId) invalid("success.result.ownerId");
      if (result.claimToken !== input.fencingToken) invalid("success.result.claimToken");
      if (result.claimExpiresAt !== input.leaseUntil) invalid("success.result.claimExpiresAt");
      return result;
    }
    case "workflow-release":
    case "outbox-failure": return booleanValue(value, "success.result");
    case "workflow-eventless-phase": {
      const input = requested.input as Extract<
        LifecycleFencedInput,
        { readonly operation: "workflow-eventless-phase" }
      >;
      const result = decodeSessionEndPhaseResult(value);
      if (result.status.workflowId !== input.workflowId) {
        invalid("success.result.status.workflowId");
      }
      if (result.status.workflowGeneration !== input.workflowGeneration) {
        invalid("success.result.status.workflowGeneration");
      }
      if (result.previousPhase !== input.expectedPhase) invalid("success.result.previousPhase");
      if (result.status.phase !== input.nextPhase) invalid("success.result.status.phase");
      return result;
    }
    case "workflow-recovery": return decodeRecoveryResult(value);
    case "outbox-claim-next": {
      const input = requested.input as Extract<
        LifecycleFencedInput,
        { readonly operation: "outbox-claim-next" }
      >;
      if (value === null) return null;
      const result = decodeOutboxClaimResult(value);
      if (result.ownerId !== input.ownerId) invalid("success.result.ownerId");
      return result;
    }
    case "outbox-claim": {
      const input = requested.input as Extract<
        LifecycleFencedInput,
        { readonly operation: "outbox-claim" }
      >;
      if (value === null) return null;
      const result = decodeOutboxClaimResult(value);
      if (result.targetKey !== input.targetKey) invalid("success.result.targetKey");
      if (result.materializationRevision !== input.materializationRevision) {
        invalid("success.result.materializationRevision");
      }
      if (result.ownerId !== input.ownerId) invalid("success.result.ownerId");
      if (result.claimToken !== input.fencingToken) invalid("success.result.claimToken");
      if (result.claimExpiresAt !== input.leaseUntil) invalid("success.result.claimExpiresAt");
      return result;
    }
    case "outbox-renew": {
      const input = requested.input as Extract<
        LifecycleFencedInput,
        { readonly operation: "outbox-renew" }
      >;
      const result = decodeOutboxClaimResult(value);
      if (result.targetKey !== input.targetKey) invalid("success.result.targetKey");
      if (result.materializationRevision !== input.materializationRevision) {
        invalid("success.result.materializationRevision");
      }
      if (result.ownerId !== input.ownerId) invalid("success.result.ownerId");
      if (result.claimToken !== input.fencingToken) invalid("success.result.claimToken");
      if (result.claimExpiresAt !== input.leaseUntil) invalid("success.result.claimExpiresAt");
      return result;
    }
    case "outbox-materialize": {
      const input = requested.input as Extract<
        LifecycleFencedInput,
        { readonly operation: "outbox-materialize" }
      >;
      const result = decodeMaterializationResult(value);
      if (result.targetKey !== input.targetKey) invalid("success.result.targetKey");
      if (result.materializationRevision !== input.materializationRevision) {
        invalid("success.result.materializationRevision");
      }
      return result;
    }
  }
}

function decodeAuthorityTarget(value: JsonValue, field: string): Readonly<Record<string, JsonValue>> {
  const target = exactSnapshot(value, ["actorRole", "clientInstanceId"], field);
  if (target.actorRole !== "primary" && target.actorRole !== "untrusted") invalid(`${field}.actorRole`);
  stringValue(target.clientInstanceId, `${field}.clientInstanceId`, 256);
  return target;
}

function decodeAuthorityDescriptor(value: JsonValue): Readonly<Record<string, JsonValue>> {
  const descriptor = exactSnapshot(value, [
    "descriptorVersion", "authorityCommitment", "capabilityGeneration", "target", "materials",
  ], "success.result.authorityMaterial.descriptor");
  if (descriptor.descriptorVersion !== 1) invalid("success.result.authorityMaterial.descriptor.descriptorVersion");
  hashValue(descriptor.authorityCommitment, "success.result.authorityMaterial.descriptor.authorityCommitment");
  decimalValue(descriptor.capabilityGeneration, "success.result.authorityMaterial.descriptor.capabilityGeneration", 1n);
  decodeAuthorityTarget(descriptor.target, "success.result.authorityMaterial.descriptor.target");
  if (!Array.isArray(descriptor.materials)
    || descriptor.materials.length < 1
    || descriptor.materials.length > 2) {
    invalid("success.result.authorityMaterial.descriptor.materials");
  }
  descriptor.materials.forEach((value, index) => {
    const material = exactSnapshot(
      value,
      ["claims", "verifier"],
      `success.result.authorityMaterial.descriptor.materials[${index}]`,
    );
    decodeCapabilityClaims(material.claims);
    hashValue(
      material.verifier,
      `success.result.authorityMaterial.descriptor.materials[${index}].verifier`,
    );
  });
  return descriptor;
}

function sameAuthorityTarget(left: JsonValue, right: JsonValue): boolean {
  if (
    typeof left !== "object" || left === null || Array.isArray(left)
    || typeof right !== "object" || right === null || Array.isArray(right)
  ) return false;
  return left.actorRole === right.actorRole
    && left.clientInstanceId === right.clientInstanceId;
}

function decodeWorkerAuthorityMaterial(value: JsonValue): Readonly<Record<string, JsonValue>> {
  const material = exactSnapshot(value, [
    "status", "target", "authorityCommitment", "capabilityGeneration", "descriptor", "recoveryCode",
  ], "success.result.authorityMaterial");
  if (!["current", "stale", "unavailable", "not-issued"].includes(String(material.status))) {
    invalid("success.result.authorityMaterial.status");
  }
  if (
    material.recoveryCode !== null
    && material.recoveryCode !== "SESSION_HANDLE_STALE"
    && material.recoveryCode !== "SESSION_CAPABILITY_KEY_UNAVAILABLE"
  ) invalid("success.result.authorityMaterial.recoveryCode");
  if (material.status === "current") {
    const target = decodeAuthorityTarget(material.target, "success.result.authorityMaterial.target");
    const authorityCommitment = hashValue(
      material.authorityCommitment,
      "success.result.authorityMaterial.authorityCommitment",
    );
    const capabilityGeneration = decimalValue(
      material.capabilityGeneration,
      "success.result.authorityMaterial.capabilityGeneration",
      1n,
    );
    const descriptor = decodeAuthorityDescriptor(material.descriptor);
    if (
      material.recoveryCode !== null
      || descriptor.authorityCommitment !== authorityCommitment
      || descriptor.capabilityGeneration !== capabilityGeneration
      || !sameAuthorityTarget(descriptor.target, target)
    ) invalid("success.result.authorityMaterial");
    return Object.freeze({
      status: "current",
      target,
      authorityCommitment,
      capabilityGeneration,
      descriptor,
      recoveryCode: null,
    });
  }
  if (
    material.target !== null
    || material.authorityCommitment !== null
    || material.capabilityGeneration !== null
    || material.descriptor !== null
    || (material.status === "not-issued" && material.recoveryCode !== null)
  ) invalid("success.result.authorityMaterial");
  return material;
}

function assertSemanticResultValue(
  actual: unknown,
  expected: unknown,
  field: string,
): void {
  if (actual !== expected) invalid(field);
}

function incrementDecimal(value: string, amount: bigint): string {
  return (BigInt(value) + amount).toString();
}

function assertIssuedRootMaterial(result: RootSessionPublicResultV2): void {
  assertSemanticResultValue(result.handleIssued, true, "success.result.handleIssued");
  assertSemanticResultValue(
    result.resumeTokenIssued,
    true,
    "success.result.resumeTokenIssued",
  );
}

function assertRootResultCorrelation(
  result: RootSessionPublicResultV2,
  requested: LifecycleSemanticOperationWire,
): void {
  const command = requested.prepared.command;
  assertSemanticResultValue(
    result.project.projectId,
    command.expectedProjectId,
    "success.result.project.projectId",
  );
  assertSemanticResultValue(
    result.project.vaultId,
    command.expectedVaultId,
    "success.result.project.vaultId",
  );
  assertSemanticResultValue(
    result.project.workspaceId,
    command.expectedWorkspaceId,
    "success.result.project.workspaceId",
  );
  switch (command.commandType) {
    case "root-start":
      assertSemanticResultValue(
        result.continuityKey,
        command.continuityKey,
        "success.result.continuityKey",
      );
      assertSemanticResultValue(
        result.resumedFromSessionId,
        null,
        "success.result.resumedFromSessionId",
      );
      assertSemanticResultValue(result.ownerGeneration, "1", "success.result.ownerGeneration");
      assertSemanticResultValue(result.state, "active", "success.result.state");
      assertSemanticResultValue(
        result.latestCheckpointEventPosition,
        null,
        "success.result.latestCheckpointEventPosition",
      );
      assertIssuedRootMaterial(result);
      return;
    case "root-resume": {
      const selectedSessionId = requested.prepared.authorization.targetSessionId;
      assertSemanticResultValue(
        result.sessionId,
        selectedSessionId,
        "success.result.sessionId",
      );
      assertSemanticResultValue(
        result.resumedFromSessionId,
        selectedSessionId,
        "success.result.resumedFromSessionId",
      );
      if (command.continuityKey !== null) {
        assertSemanticResultValue(
          result.continuityKey,
          command.continuityKey,
          "success.result.continuityKey",
        );
      }
      assertSemanticResultValue(
        result.ownerGeneration,
        incrementDecimal(command.expectedOwnerGeneration, 1n),
        "success.result.ownerGeneration",
      );
      assertSemanticResultValue(result.state, "active", "success.result.state");
      assertIssuedRootMaterial(result);
      return;
    }
    case "root-recovery":
      assertSemanticResultValue(
        result.sessionId,
        command.sessionId,
        "success.result.sessionId",
      );
      assertSemanticResultValue(
        result.resumedFromSessionId,
        null,
        "success.result.resumedFromSessionId",
      );
      assertSemanticResultValue(
        result.ownerGeneration,
        incrementDecimal(command.expectedOwnerGeneration, 1n),
        "success.result.ownerGeneration",
      );
      assertIssuedRootMaterial(result);
      return;
    case "root-suspend":
      assertSemanticResultValue(
        result.sessionId,
        command.sessionId,
        "success.result.sessionId",
      );
      assertSemanticResultValue(
        result.resumedFromSessionId,
        null,
        "success.result.resumedFromSessionId",
      );
      assertSemanticResultValue(result.state, "suspended", "success.result.state");
      if (result.latestCheckpointEventPosition === null) {
        invalid("success.result.latestCheckpointEventPosition");
      }
      assertSemanticResultValue(
        result.eventPosition,
        incrementDecimal(result.latestCheckpointEventPosition, 2n),
        "success.result.eventPosition",
      );
      assertIssuedRootMaterial(result);
      return;
    default:
      return invalid("success.operation");
  }
}

function assertAssignmentCorrelation(
  result: ChildWorkflowResultV2,
  expected: { readonly assignmentId: string; readonly summary: string; readonly scope: string },
): void {
  assertSemanticResultValue(
    result.assignment?.assignmentId,
    expected.assignmentId,
    "success.result.assignment.assignmentId",
  );
  assertSemanticResultValue(
    result.assignment?.summary,
    expected.summary,
    "success.result.assignment.summary",
  );
  assertSemanticResultValue(
    result.assignment?.scope,
    expected.scope,
    "success.result.assignment.scope",
  );
}

function assertChildResultCorrelation(
  result: ChildWorkflowResultV2,
  requested: LifecycleSemanticOperationWire,
): void {
  const command = requested.prepared.command;
  switch (command.commandType) {
    case "fork-child":
      assertSemanticResultValue(
        result.parentSessionId,
        command.parentSessionId,
        "success.result.parentSessionId",
      );
      assertAssignmentCorrelation(result, command.assignment);
      assertSemanticResultValue(
        result.directAccessEnabled,
        command.directAccessRequested,
        "success.result.directAccessEnabled",
      );
      assertSemanticResultValue(
        result.assignmentRevision,
        "1",
        "success.result.assignmentRevision",
      );
      assertSemanticResultValue(result.state, "active", "success.result.state");
      assertSemanticResultValue(
        result.finalStreamVersion,
        "1",
        "success.result.finalStreamVersion",
      );
      return;
    case "amend-child-assignment":
      assertSemanticResultValue(
        result.parentSessionId,
        command.parentSessionId,
        "success.result.parentSessionId",
      );
      assertSemanticResultValue(
        result.childSessionId,
        command.childSessionId,
        "success.result.childSessionId",
      );
      assertAssignmentCorrelation(result, command.assignment);
      assertSemanticResultValue(
        result.assignmentRevision,
        incrementDecimal(command.expectedAssignmentRevision, 1n),
        "success.result.assignmentRevision",
      );
      assertSemanticResultValue(
        result.finalStreamVersion,
        incrementDecimal(command.expectedStreamVersion, 1n),
        "success.result.finalStreamVersion",
      );
      return;
    case "record-child-report":
      assertSemanticResultValue(
        result.parentSessionId,
        command.parentSessionId,
        "success.result.parentSessionId",
      );
      assertSemanticResultValue(
        result.childSessionId,
        command.childSessionId,
        "success.result.childSessionId",
      );
      assertSemanticResultValue(
        result.finalStreamVersion,
        incrementDecimal(command.expectedStreamVersion, 1n),
        "success.result.finalStreamVersion",
      );
      assertSemanticResultValue(
        result.reportItemIds?.length,
        command.report.findings.length
          + command.report.proposedDecisions.length
          + command.report.filesObservedOrChanged.length
          + command.report.verificationPerformed.length
          + command.report.openFollowUps.length
          + command.report.blockers.length,
        "success.result.reportItemIds",
      );
      return;
    case "disposition-child-report":
      assertSemanticResultValue(
        result.parentSessionId,
        command.parentSessionId,
        "success.result.parentSessionId",
      );
      assertSemanticResultValue(
        result.childSessionId,
        command.childSessionId,
        "success.result.childSessionId",
      );
      assertSemanticResultValue(
        result.disposition?.kind,
        command.disposition.kind,
        "success.result.disposition.kind",
      );
      assertSemanticResultValue(
        result.disposition?.reportId,
        command.disposition.reportId,
        "success.result.disposition.reportId",
      );
      assertSemanticResultValue(
        result.finalStreamVersion,
        incrementDecimal(command.expectedStreamVersion, 1n),
        "success.result.finalStreamVersion",
      );
      return;
    case "propose-child-completion":
      assertSemanticResultValue(
        result.childSessionId,
        command.childSessionId,
        "success.result.childSessionId",
      );
      assertSemanticResultValue(
        result.reportId,
        command.reportId,
        "success.result.reportId",
      );
      assertSemanticResultValue(
        result.finalStreamVersion,
        incrementDecimal(command.expectedStreamVersion, 1n),
        "success.result.finalStreamVersion",
      );
      assertSemanticResultValue(
        result.state,
        "completion-proposed",
        "success.result.state",
      );
      return;
    case "complete-child-session":
      assertSemanticResultValue(
        result.parentSessionId,
        command.parentSessionId,
        "success.result.parentSessionId",
      );
      assertSemanticResultValue(
        result.childSessionId,
        command.childSessionId,
        "success.result.childSessionId",
      );
      assertSemanticResultValue(
        result.reportId,
        command.reportId,
        "success.result.reportId",
      );
      assertSemanticResultValue(
        result.finalStreamVersion,
        incrementDecimal(command.expectedStreamVersion, 1n),
        "success.result.finalStreamVersion",
      );
      assertSemanticResultValue(result.state, "completed", "success.result.state");
      return;
    case "suspend-child-session":
      assertSemanticResultValue(
        result.parentSessionId,
        command.parentSessionId,
        "success.result.parentSessionId",
      );
      assertSemanticResultValue(
        result.childSessionId,
        command.childSessionId,
        "success.result.childSessionId",
      );
      assertSemanticResultValue(
        result.finalStreamVersion,
        incrementDecimal(command.expectedStreamVersion, 2n),
        "success.result.finalStreamVersion",
      );
      assertSemanticResultValue(result.state, "transferred", "success.result.state");
      return;
    case "claim-child-transfer":
      assertSemanticResultValue(
        result.parentSessionId,
        command.rootSessionId,
        "success.result.parentSessionId",
      );
      assertSemanticResultValue(
        result.transferTicketId,
        command.transferTicketId,
        "success.result.transferTicketId",
      );
      assertSemanticResultValue(
        result.assignmentRevision,
        "1",
        "success.result.assignmentRevision",
      );
      assertSemanticResultValue(
        result.directAccessEnabled,
        false,
        "success.result.directAccessEnabled",
      );
      assertSemanticResultValue(result.state, "active", "success.result.state");
      assertSemanticResultValue(
        result.finalStreamVersion,
        "2",
        "success.result.finalStreamVersion",
      );
      return;
    default:
      return invalid("success.operation");
  }
}

function decodeSemanticPublicResult(
  value: JsonValue,
  requested: LifecycleSemanticOperationWire,
): JsonValue {
  const operation = requested.operation;
  if (["root-start", "root-resume", "root-recovery", "root-suspend"].includes(operation)) {
    const result = decodeRootResult(value);
    assertRootResultCorrelation(result, requested);
    return result as unknown as JsonValue;
  }
  if ([
    "fork-child", "amend-child-assignment", "record-child-report",
    "disposition-child-report", "propose-child-completion", "complete-child-session",
    "suspend-child-session", "claim-child-transfer",
  ].includes(operation)) {
    const result = decodeChildResult(value, operation);
    assertChildResultCorrelation(result, requested);
    return result;
  }
  if (operation === "record-checkpoint") {
    const checkpoint = decodeCheckpointRecordedResult(value);
    const command = requested.prepared.command;
    if (command.commandType !== "record-checkpoint") invalid("success.operation");
    if (
      checkpoint.checkpointVersion !== lifecycleNestedContractVersion(requested)
      || checkpoint.checkpointVersion !== command.draft.checkpointVersion
    ) invalid("success.result.checkpointVersion");
    assertSemanticResultValue(
      checkpoint.sessionId,
      command.sessionId,
      "success.result.sessionId",
    );
    if (command.expectedBaseEventPosition !== null) {
      assertSemanticResultValue(
        checkpoint.baseEventPosition,
        command.expectedBaseEventPosition,
        "success.result.baseEventPosition",
      );
    }
    assertSemanticResultValue(
      checkpoint.checkpointEventPosition,
      incrementDecimal(checkpoint.baseEventPosition, 1n),
      "success.result.checkpointEventPosition",
    );
    assertSemanticResultValue(
      checkpoint.finalStreamVersion,
      incrementDecimal(command.expectedStreamVersion, 1n),
      "success.result.finalStreamVersion",
    );
    return checkpoint;
  }
  if (operation === "record-evidence-batch") {
    const result = decodeEvidenceCoverageRecordedResultV2(value);
    const command = requested.prepared.command;
    if (command.commandType !== "record-evidence-batch") invalid("success.operation");
    assertSemanticResultValue(result.sessionId, command.sessionId, "success.result.sessionId");
    assertSemanticResultValue(
      result.adapterSessionId,
      command.adapterSessionId,
      "success.result.adapterSessionId",
    );
    assertSemanticResultValue(result.batchId, command.batchId, "success.result.batchId");
    assertSemanticResultValue(
      result.batchFirstOrdinal,
      command.firstOrdinal,
      "success.result.batchFirstOrdinal",
    );
    assertSemanticResultValue(
      result.batchLastOrdinal,
      command.lastOrdinal,
      "success.result.batchLastOrdinal",
    );
    return result;
  }
  if (["request-session-end", "amend-session-end", "cancel-session-end", "abandon-session"].includes(operation)) {
    const result = decodeSessionEndStatus(value);
    const command = requested.prepared.command;
    switch (command.commandType) {
      case "request-session-end":
        assertSemanticResultValue(
          result.sessionId,
          command.request.sessionId,
          "success.result.sessionId",
        );
        break;
      case "amend-session-end":
      case "cancel-session-end":
        assertSemanticResultValue(
          result.sessionId,
          command.sessionId,
          "success.result.sessionId",
        );
        assertSemanticResultValue(
          result.workflowId,
          command.workflowId,
          "success.result.workflowId",
        );
        break;
      case "abandon-session":
        assertSemanticResultValue(
          result.sessionId,
          command.sessionId,
          "success.result.sessionId",
        );
        break;
      default:
        return invalid("success.operation");
    }
    return result;
  }
  return invalid("success.operation");
}

const LIFECYCLE_ERROR_CODE_SET = new Set<string>(LIFECYCLE_ERROR_CODES);

function decodeSemanticWorkerResult(
  value: JsonValue,
  requested: LifecycleSemanticOperationWire,
): JsonValue {
  const observed = strictDataRecord(value, undefined, "success.result");
  if (observed.kind === "success") {
    const workerResult = exactSnapshot(
      value,
      ["kind", "publicResult", "authorityMaterial"],
      "success.result",
    );
    return Object.freeze({
      kind: "success",
      publicResult: decodeSemanticPublicResult(workerResult.publicResult, requested),
      authorityMaterial: decodeWorkerAuthorityMaterial(workerResult.authorityMaterial),
    });
  }
  const workerResult = exactSnapshot(value, ["kind", "errorCode"], "success.result");
  if (workerResult.kind === "unknown") {
    if (workerResult.errorCode !== "COMMAND_OUTCOME_UNKNOWN") invalid("success.result.errorCode");
    return Object.freeze({ kind: "unknown", errorCode: "COMMAND_OUTCOME_UNKNOWN" });
  }
  if (
    workerResult.kind !== "rejected"
    || typeof workerResult.errorCode !== "string"
    || workerResult.errorCode === "WORKER_PROTOCOL_ERROR"
    || workerResult.errorCode === "COMMAND_OUTCOME_UNKNOWN"
    || workerResult.errorCode === "OPERATION_OUTCOME_UNKNOWN"
    || !LIFECYCLE_ERROR_CODE_SET.has(workerResult.errorCode)
  ) invalid("success.result.errorCode");
  return Object.freeze({ kind: "rejected", errorCode: workerResult.errorCode });
}

function decodeSuccessResult(
  value: JsonValue,
  requested: LifecycleWorkerOperationWire,
): JsonValue {
  if (requested.kind === "semantic") {
    return decodeSemanticWorkerResult(value, requested);
  }
  if (requested.kind === "internal-semantic") {
    return requested.operation === "internal-validation-result"
      ? decodeValidationRecordedResult(value)
      : decodeSessionEndPhaseResult(value);
  }
  if (requested.kind === "bounded") {
    return decodeLeaseResult(value, requested) as unknown as JsonValue;
  }
  if (requested.kind === "query") {
    return decodeQueryResult(value, requested) as unknown as JsonValue;
  }
  return decodeFencedResult(value, requested);
}

export function decodeLifecycleWorkerSuccessForOperation(
  value: unknown,
  requested: LifecycleWorkerOperationWire,
): LifecycleWorkerSuccessWire {
  const success = exactSnapshot(
    value,
    ["operation", "nestedContractVersion", "result"],
    "lifecycleSuccess",
  );
  assertLifecycleWireCanonicalSize(success);
  if (success.operation !== requested.operation) invalid("lifecycleSuccess.operation");
  if (
    success.nestedContractVersion !== null
    && success.nestedContractVersion !== 1
    && success.nestedContractVersion !== 2
  ) invalid("lifecycleSuccess.nestedContractVersion");
  const expectedVersion = lifecycleNestedContractVersion(requested);
  if (success.nestedContractVersion !== expectedVersion) {
    invalid("lifecycleSuccess.nestedContractVersion");
  }
  const result = decodeSuccessResult(success.result, requested);
  return Object.freeze({
    operation: requested.operation,
    nestedContractVersion: expectedVersion,
    result,
  });
}

export function lifecycleNestedContractVersion(
  operation:
    | LifecycleWorkerOperationWire
    | LifecycleWorkerOperation
    | InternalWorkflowPhaseCommand,
): 1 | 2 | null {
  const source = operation as unknown as Record<string, unknown>;
  let command: Record<string, unknown>;
  if (source.kind === "semantic") {
    command = (source.prepared as { command: Record<string, unknown> }).command;
  } else if (source.kind === "internal-semantic") {
    command = source.command as Record<string, unknown>;
  } else if (source.command !== undefined && source.authorization !== undefined) {
    command = source.command as Record<string, unknown>;
  } else {
    command = source;
  }
  switch (command.commandType) {
    case "root-suspend":
      return (command.checkpoint as { checkpointVersion?: unknown }).checkpointVersion === 1 ? 1
        : (command.checkpoint as { checkpointVersion?: unknown }).checkpointVersion === 2 ? 2
          : invalid("nestedContractVersion");
    case "record-checkpoint":
      return (command.draft as { checkpointVersion?: unknown }).checkpointVersion === 1 ? 1
        : (command.draft as { checkpointVersion?: unknown }).checkpointVersion === 2 ? 2
          : invalid("nestedContractVersion");
    case "request-session-end":
      return (command.request as { requestVersion?: unknown }).requestVersion === 1 ? 1
        : (command.request as { requestVersion?: unknown }).requestVersion === 2 ? 2
          : invalid("nestedContractVersion");
    case "amend-session-end":
      return (command.amendment as { amendmentVersion?: unknown }).amendmentVersion === 1 ? 1
        : (command.amendment as { amendmentVersion?: unknown }).amendmentVersion === 2 ? 2
          : invalid("nestedContractVersion");
    case "internal-workflow-phase": {
      const planned = command.plannedAction as Record<string, unknown> | undefined;
      if (planned?.action === "prepare-final-checkpoint-and-queue-ending") {
        const version = (planned.finalCheckpointDraft as { checkpointVersion?: unknown }).checkpointVersion;
        return version === 1 || version === 2 ? version : invalid("nestedContractVersion");
      }
      const authoritative = command.action as Record<string, unknown> | undefined;
      if (authoritative?.action === "record-final-checkpoint-and-queue-ending") {
        const version = (authoritative.finalCheckpoint as { checkpointVersion?: unknown }).checkpointVersion;
        return version === 1 || version === 2 ? version : invalid("nestedContractVersion");
      }
      return null;
    }
    default:
      return null;
  }
}

export interface LifecycleInternalWorkVersionBinding {
  readonly commandType: "internal-validation-result" | "internal-workflow-phase";
  readonly workflowId: WorkflowId;
  readonly workflowGeneration: number;
  readonly plannedWorkId: string;
  readonly nestedContractVersion: 1 | 2 | null;
}

export function lifecycleInternalWorkVersionBinding(
  source: InternalWorkflowExecutionPlan | InternalWorkflowPhaseCommand,
): LifecycleInternalWorkVersionBinding {
  if (source.commandType !== "internal-validation-result" && source.commandType !== "internal-workflow-phase") {
    return invalid("internalWork.commandType");
  }
  return Object.freeze({
    commandType: source.commandType,
    workflowId: source.workflowId,
    workflowGeneration: source.workflowGeneration,
    plannedWorkId: source.plannedWorkId,
    nestedContractVersion: lifecycleNestedContractVersion(source),
  });
}
