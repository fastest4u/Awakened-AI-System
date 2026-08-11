import type { JsonValue, StoredEvent } from "../contracts/event.js";
import { eventHash, payloadHash } from "../crypto/event-hash.js";
import {
  decodeLifecycleEventPayload,
  LIFECYCLE_EVENT_TYPES,
  type LifecycleEventType,
} from "../lifecycle/contracts/events.js";
import {
  parseCanonicalTimestamp,
  parseCanonicalUuid,
  parseLifecycleId,
  type SessionId,
  type WorkflowId,
} from "../lifecycle/contracts/identifiers.js";
import { LifecycleError } from "../lifecycle/errors.js";
import {
  decodeLifecycleIntentWitness,
  lifecycleIntentHashFromWitnessSource,
  type LifecycleIntentWitnessV1,
} from "../lifecycle/lifecycle-intent-witness.js";
import {
  decodeMaterializationProjectionInputV1,
  type LifecycleMaterializationOriginV1,
  type LifecycleRenderClosureV1,
  type LifecycleRenderEventV1,
  type LifecycleRenderTriggerV1,
  type MaterializationProjectionInputV1,
} from "../lifecycle/materialization-queue.port.js";
import { decodeSessionEndEffectiveStateV1 } from "../lifecycle/session-end-effective-state.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { AuthenticatedLifecycleCommandV1 } from "./sqlite-lifecycle-render-closure.reader.js";

export interface AuthenticatedStoredLifecycleEventV1 {
  readonly event: StoredEvent;
  readonly command: AuthenticatedLifecycleCommandV1;
}

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const LOWER_HASH = /^[0-9a-f]{64}$/u;
const ACTOR_ROLES = new Set(["primary", "maintenance", "untrusted"]);
const VISIBILITY_SCOPES = new Set(["session", "workspace", "branch", "project"]);
const CONFIDENCE_VALUES = new Set(["high", "medium", "low", "guess"]);
const VERIFICATION_VALUES = new Set(["unverified", "provisional", "verified", "conflicted"]);
const EVENT_TYPES = new Set<string>(LIFECYCLE_EVENT_TYPES);
const ROOT_EVENT_TYPES = new Set<LifecycleEventType>([
  "SessionStarted", "SessionOwnerTransferred", "SessionOwnershipRecovered",
  "SessionSuspendRequested", "SessionSuspended", "SessionResumed",
  "SessionEndRequested", "SessionEndAmended", "SessionValidationResultRecorded",
  "SessionEndVerificationPassed", "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated", "SessionEndCancelled", "SessionAbandoned",
  "SessionEnded",
]);
const CHILD_EVENT_TYPES = new Set<LifecycleEventType>([
  "SessionForked", "ChildAssignmentAmended", "ChildWorkReported",
  "ChildWorkDispositioned", "ChildCompletionProposed", "ChildSessionCompleted",
  "ChildSessionSuspended", "ChildWorkTransferCreated", "ChildWorkTransferClaimed",
]);
const MATERIALIZATION_TRIGGERS = new Set<LifecycleEventType>([
  "SessionCheckpointRecorded", "SessionEndAmended", "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated", "SessionEndCancelled", "SessionAbandoned",
  "SessionEnded",
]);

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return integrity();
  return value as Record<string, unknown>;
}

function positiveSqliteInt64(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n || value > SQLITE_INT64_MAX) return integrity();
  return value;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) return integrity();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !LOWER_HASH.test(value)) return integrity();
  return value;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return integrity();
  const decoded = value.map(nonempty);
  canonicalJson(decoded);
  return decoded;
}

function authenticatedWitness(
  event: StoredEvent,
  command: AuthenticatedLifecycleCommandV1,
): LifecycleIntentWitnessV1 {
  const intentWitnessJson = command.intentWitnessJson;
  if (
    command.lifecycleAuthorizationKind === null
    || intentWitnessJson === null
    || !LOWER_HASH.test(command.commandHash)
    || lifecycleIntentHashFromWitnessSource(intentWitnessJson) !== command.commandHash
  ) return integrity();
  const witness = decodeLifecycleIntentWitness(intentWitnessJson);
  const intent = record(witness.intent);
  const intentCommand = record(intent.command);
  const binding = record(intent.binding);
  const assertions = witness.persistedAssertions;
  if (
    intentCommand.commandId !== event.commandId
    || intentCommand.idempotencyKey !== event.idempotencyKey
    || intentCommand.agentId !== event.agentId
    || binding.projectId !== event.projectId
    || binding.vaultId !== event.vaultId
    || binding.storeId !== event.storeId
    || binding.workspaceId !== event.workspaceId
    || assertions.authorizationKind !== command.lifecycleAuthorizationKind
    || assertions.projectId !== event.projectId
    || assertions.vaultId !== event.vaultId
    || assertions.storeId !== event.storeId
    || assertions.workspaceId !== event.workspaceId
    || assertions.targetActorRole !== event.actorRole
    || assertions.targetClientInstanceId !== event.clientInstanceId
  ) return integrity();
  const expectedBranchRef = intentCommand.expectedBranchRef;
  if (expectedBranchRef !== undefined && expectedBranchRef !== event.branchRef) return integrity();
  if (event.commandEventIndex === 0) {
    if (event.lifecycleIntentJson !== intentWitnessJson || command.witnessEventId !== event.eventId) {
      return integrity();
    }
  } else if (event.lifecycleIntentJson !== null || command.witnessEventId === null) {
    return integrity();
  }
  if (command.witnessEventId !== null) parseCanonicalUuid(command.witnessEventId, "witnessEventId");
  return witness;
}

function validateCommittedEnvelope(
  event: StoredEvent,
  command: AuthenticatedLifecycleCommandV1,
): { readonly payload: JsonValue; readonly witness: LifecycleIntentWitnessV1 } {
  positiveSqliteInt64(event.globalPosition);
  positiveSqliteInt64(event.streamVersion);
  parseCanonicalUuid(event.eventId, "eventId");
  parseCanonicalUuid(event.projectId, "projectId");
  parseCanonicalUuid(event.vaultId, "vaultId");
  parseCanonicalUuid(event.storeId, "storeId");
  parseCanonicalUuid(event.commandId, "commandId");
  parseCanonicalUuid(event.correlationId, "correlationId");
  if (event.causationId !== null) parseCanonicalUuid(event.causationId, "causationId");
  const sessionId = parseLifecycleId<SessionId>(event.sessionId, "sessionId");
  const parentSessionId = event.parentSessionId === null
    ? null
    : parseLifecycleId<SessionId>(event.parentSessionId, "parentSessionId");
  if (
    !LOWER_HASH.test(event.workspaceId)
    || (event.branchScopeId !== null && parseCanonicalUuid(event.branchScopeId, "branchScopeId") !== event.branchScopeId)
    || (event.branchScopeId === null && event.branchRef !== null)
    || (event.branchRef !== null && (event.branchRef.length === 0 || event.branchRef.trim().length === 0))
    || event.streamType !== "session"
    || event.streamId !== `session/${sessionId}`
    || !EVENT_TYPES.has(event.eventType)
    || !Number.isSafeInteger(event.eventSchemaVersion)
    || event.eventSchemaVersion < 1
    || !Number.isSafeInteger(event.commandEventIndex)
    || event.commandEventIndex < 0
    || event.commandEventIndex > 999
    || !ACTOR_ROLES.has(event.actorRole)
    || !VISIBILITY_SCOPES.has(event.visibilityScope)
    || !CONFIDENCE_VALUES.has(event.confidence)
    || !VERIFICATION_VALUES.has(event.verificationStatus)
  ) return integrity();
  nonempty(event.agentId);
  nonempty(event.clientInstanceId);
  nonempty(event.idempotencyKey);
  parseCanonicalTimestamp(event.occurredAt, "occurredAt");
  parseCanonicalTimestamp(event.recordedAt, "recordedAt");
  hash(event.payloadHash);
  hash(event.previousGlobalHash);
  hash(event.eventHash);
  const sourceRefs = stringArray(event.sourceRefs);
  if (!Array.isArray(event.evidenceRefs) || event.evidenceRefs.length !== 0) return integrity();
  if (!Array.isArray(event.evidenceDigests) || event.evidenceDigests.length !== 0) return integrity();
  const eventType = event.eventType as LifecycleEventType;
  if ((ROOT_EVENT_TYPES.has(eventType) && parentSessionId !== null)
    || (CHILD_EVENT_TYPES.has(eventType) && parentSessionId === null)) {
    return integrity();
  }
  const payload = decodeLifecycleEventPayload(eventType, event.eventSchemaVersion, event.payload) as JsonValue;
  if (canonicalJson(payload) !== event.payloadJson || payloadHash(payload) !== event.payloadHash) {
    return integrity();
  }
  const payloadRecord = record(payload);
  if (
    (eventType === "SessionForked"
      && (event.streamVersion !== 1n || payloadRecord.parentSessionId !== parentSessionId))
    || (eventType === "SessionCheckpointRecorded" && (
      payloadRecord.checkpointEventPosition !== event.globalPosition.toString()
      || record(payloadRecord.checkpoint).sessionId !== sessionId
      || record(payloadRecord.checkpoint).parentSessionId !== parentSessionId
      || record(record(payloadRecord.checkpoint).sourceState).workspaceId !== event.workspaceId
    ))
    || (eventType === "ChildWorkReported" && (
      record(payloadRecord.report).childSessionId !== sessionId
      || record(payloadRecord.report).parentSessionId !== parentSessionId
    ))
    || (eventType === "SessionValidationResultRecorded" && (
      record(payloadRecord.validationResult).projectId !== event.projectId
      || record(payloadRecord.validationResult).vaultId !== event.vaultId
      || record(payloadRecord.validationResult).storeId !== event.storeId
      || record(payloadRecord.validationResult).workspaceId !== event.workspaceId
      || record(payloadRecord.validationResult).sessionId !== sessionId
    ))
  ) return integrity();
  const witness = authenticatedWitness(event, command);
  const hashMaterial: Record<string, unknown> = {
    ...event,
    globalPosition: event.globalPosition.toString(),
    streamVersion: event.streamVersion.toString(),
    sourceRefs,
  };
  delete hashMaterial.eventHash;
  delete hashMaterial.payload;
  delete hashMaterial.payloadJson;
  delete hashMaterial.lifecycleIntentJson;
  if (event.commandEventIndex === 0) hashMaterial.lifecycleIntent = witness;
  if (eventHash(hashMaterial) !== event.eventHash) return integrity();
  return Object.freeze({ payload, witness });
}

function originFor(eventType: LifecycleEventType, payload: Record<string, unknown>): LifecycleMaterializationOriginV1 {
  if (!MATERIALIZATION_TRIGGERS.has(eventType)) return integrity();
  if (eventType === "SessionAbandoned" && payload.workflowId === null) {
    if (payload.workflowGeneration !== null) return integrity();
    return Object.freeze({ kind: "terminal-event", workflowId: null, workflowGeneration: null });
  }
  if (
    typeof payload.workflowId !== "string"
    || !Number.isSafeInteger(payload.workflowGeneration)
    || Number(payload.workflowGeneration) < 1
  ) return integrity();
  return Object.freeze({
    kind: "workflow",
    workflowId: parseLifecycleId<WorkflowId>(payload.workflowId, "workflowId"),
    workflowGeneration: Number(payload.workflowGeneration),
  });
}

function legacySemantics(
  eventType: LifecycleEventType,
  eventSchemaVersion: number,
  payload: Record<string, unknown>,
  witness: LifecycleIntentWitnessV1,
): LifecycleRenderEventV1["legacyIntentSemantics"] {
  if (eventType !== "SessionEndRequested" && eventType !== "SessionEndAmended") return null;
  if (eventSchemaVersion === 3) return null;
  const command = record(witness.intent.command);
  const expectedCommandType = eventType === "SessionEndRequested"
    ? "request-session-end"
    : "amend-session-end";
  if (command.commandType !== expectedCommandType) return integrity();
  const effectiveStateSource = command.effectiveState;
  if (effectiveStateSource === undefined) return integrity();
  const effectiveState = decodeSessionEndEffectiveStateV1(effectiveStateSource);
  const evidenceWindowAction = eventType === "SessionEndAmended"
    ? eventSchemaVersion === 1
      ? "unchanged"
      : payload.evidenceWindowAction
    : null;
  if (
    evidenceWindowAction !== null
    && evidenceWindowAction !== "unchanged"
    && evidenceWindowAction !== "open"
    && evidenceWindowAction !== "seal"
  ) return integrity();
  return Object.freeze({ effectiveState, evidenceWindowAction });
}

function semanticEvent(
  input: AuthenticatedStoredLifecycleEventV1,
  includeOrigin: boolean,
): LifecycleRenderEventV1 {
  const { event, command } = input;
  const validated = validateCommittedEnvelope(event, command);
  const eventType = event.eventType as LifecycleEventType;
  const payloadRecord = record(validated.payload);
  const origin = includeOrigin ? originFor(eventType, payloadRecord) : null;
  return Object.freeze({
    projectId: event.projectId,
    vaultId: event.vaultId,
    storeId: event.storeId,
    workspaceId: event.workspaceId,
    branchScopeId: event.branchScopeId,
    branchRef: event.branchRef,
    streamId: event.streamId,
    streamVersion: event.streamVersion.toString(),
    globalPosition: event.globalPosition.toString(),
    sessionId: event.sessionId as SessionId,
    parentSessionId: event.parentSessionId as SessionId | null,
    eventType,
    eventSchemaVersion: event.eventSchemaVersion,
    occurredAt: event.occurredAt,
    payload: validated.payload,
    materializationOrigin: origin,
    legacyIntentSemantics: legacySemantics(
      eventType,
      event.eventSchemaVersion,
      payloadRecord,
      validated.witness,
    ),
  });
}

export function normalizeCandidateLifecycleRenderEvent(
  inputValue: MaterializationProjectionInputV1,
  closure: LifecycleRenderClosureV1,
): LifecycleRenderTriggerV1 {
  try {
    const input = decodeMaterializationProjectionInputV1(inputValue);
    const root = closure.root[0];
    const head = closure.root.at(-1);
    if (
      root === undefined
      || head === undefined
      || root.eventType !== "SessionStarted"
      || root.streamVersion !== "1"
      || root.sessionId !== input.sessionId
      || root.parentSessionId !== null
      || root.streamId !== `session/${input.sessionId}`
      || root.projectId !== input.context.binding.projectId
      || root.vaultId !== input.context.binding.vaultId
      || root.storeId !== input.context.binding.storeId
      || root.workspaceId !== input.context.binding.workspaceId
      || root.branchRef !== (input.context.workspace.kind === "git" ? input.context.workspace.branchRef : null)
      || (input.context.branchScopeId !== undefined && input.context.branchScopeId !== root.branchScopeId)
    ) return integrity();
    const headVersion = BigInt(head.streamVersion);
    if (headVersion < 1n || headVersion >= SQLITE_INT64_MAX) return integrity();
    const nextStreamVersion = headVersion + 1n;
    return Object.freeze({
      projectId: root.projectId,
      vaultId: root.vaultId,
      storeId: root.storeId,
      workspaceId: root.workspaceId,
      branchScopeId: root.branchScopeId,
      branchRef: root.branchRef,
      streamId: root.streamId,
      streamVersion: nextStreamVersion.toString(),
      globalPosition: input.expectedTriggerPosition.toString(),
      sessionId: input.sessionId,
      parentSessionId: null,
      eventType: input.triggeringEventType,
      eventSchemaVersion: input.triggeringEventSchemaVersion,
      occurredAt: input.triggeringOccurredAt,
      payload: input.triggeringEventPayload,
      materializationOrigin: input.origin,
      legacyIntentSemantics: null,
    });
  } catch {
    return integrity();
  }
}

export function normalizeCommittedLifecycleRenderEvent(
  input: AuthenticatedStoredLifecycleEventV1,
): LifecycleRenderTriggerV1 {
  try {
    return semanticEvent(input, true) as LifecycleRenderTriggerV1;
  } catch {
    return integrity();
  }
}

export function normalizeCommittedLifecycleClosureEvent(
  input: AuthenticatedStoredLifecycleEventV1,
): LifecycleRenderEventV1 {
  try {
    return semanticEvent(input, false);
  } catch {
    return integrity();
  }
}
