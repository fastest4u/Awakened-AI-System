import type {
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../../identity/contracts.js";
import {
  LIFECYCLE_ERROR_CODES,
  LifecycleError,
  type LifecycleErrorCode,
} from "../errors.js";
import { decodeCheckpointV1, type CheckpointV1 } from "./checkpoint.js";
import {
  decodeChildDispositionV1,
  decodeChildReportV1,
  type ChildDispositionV1,
  type ChildReportV1,
} from "./child.js";
import {
  exactRecord,
  parseBoolean,
  parseBoundedString,
  parseCanonicalTimestamp,
  parseDecimalString,
  parseEnum,
  parseInteger,
  parseLifecycleId,
  parseNullableBoundedString,
  parseNullableUuid,
  strictArray,
  type AdapterSessionId,
  type ApprovalId,
  type CheckpointId,
  type ChildEndPolicy,
  type EvidenceBatchId,
  type EvidenceFrameId,
  type ReportId,
  type SessionId,
  type TransferTicketId,
  type ValidationResultId,
  type WorkflowId,
} from "./identifiers.js";
import {
  decodeValidationResultV1,
  type ValidationResultV1,
} from "./session-end.js";

export const LIFECYCLE_EVENT_TYPES = Object.freeze([
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
] as const);

export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

const LOWER_HASH = /^[0-9a-f]{64}$/;
const ROOT_PREVIOUS_STATES = ["active", "suspended"] as const;
const EVIDENCE_SOURCE_KINDS = [
  "model-turn",
  "tool-request",
  "tool-result",
  "adapter-event",
  "external-observation",
] as const;
const CHILD_END_POLICIES = ["require-completed", "suspend-and-carry-forward"] as const;
const EVENT_BASE_KEYS = [
  "eventSchemaVersion",
  "eventId",
  "projectId",
  "vaultId",
  "storeId",
  "workspaceId",
  "streamId",
  "streamVersion",
  "globalPosition",
  "sessionId",
  "parentSessionId",
  "eventType",
  "correlationId",
  "causationId",
  "commandId",
  "idempotencyKey",
  "occurredAt",
  "authorityCommitment",
  "payload",
] as const;

export interface LifecycleAssignmentV1 {
  readonly assignmentId: string;
  readonly summary: string;
  readonly scope: string;
}

export interface LifecycleMissingOrdinalIntervalV1 {
  readonly firstOrdinal: string;
  readonly lastOrdinal: string;
}

export interface LifecycleEvidenceFrameRecordedV1 {
  readonly frameId: EvidenceFrameId;
  readonly ordinal: string;
  readonly sourceKind: (typeof EVIDENCE_SOURCE_KINDS)[number];
  readonly observedAt: string;
  readonly contentFingerprint: string;
}

export interface LifecycleEventPayloadMapV1 {
  readonly SessionStarted: {
    readonly sessionKind: "root";
    readonly ownerGeneration: number;
    readonly continuityKey: string;
    readonly clientNamespace: string;
    readonly creatingAgentId: string;
    readonly creatingClientInstanceId: string;
    readonly authorityCommitment: string;
  };
  readonly SessionOwnerTransferred: {
    readonly previousOwnerGeneration: number;
    readonly ownerGeneration: number;
    readonly authorityCommitment: string;
  };
  readonly SessionOwnershipRecovered: {
    readonly previousOwnerGeneration: number;
    readonly ownerGeneration: number;
    readonly approvalId: ApprovalId;
    readonly authorityCommitment: string;
  };
  readonly SessionSuspendRequested: { readonly checkpointId: CheckpointId };
  readonly SessionSuspended: { readonly authorityCommitment: string };
  readonly SessionResumed: { readonly ownerGeneration: number };
  readonly SessionCheckpointRecorded: {
    readonly checkpoint: CheckpointV1;
    readonly baseEventPosition: string;
    readonly checkpointEventPosition: string;
  };
  readonly EvidenceCoverageRecorded: {
    readonly adapterSessionId: AdapterSessionId;
    readonly batchId: EvidenceBatchId;
    readonly firstOrdinal: string;
    readonly lastOrdinal: string;
    readonly highestContiguousOrdinal: string | null;
    readonly missingIntervals: readonly LifecycleMissingOrdinalIntervalV1[];
    readonly fingerprintSchemaVersion: 1;
    readonly fingerprintKeyId: string;
    readonly fingerprintDomain: "pm-evidence-frame-v1";
    readonly coverageFingerprint: string;
    readonly captureMode: "coverage-only";
    readonly contentRetained: false;
    readonly frames: readonly LifecycleEvidenceFrameRecordedV1[];
  };
  readonly SessionForked: {
    readonly parentSessionId: SessionId;
    readonly assignment: LifecycleAssignmentV1;
    readonly rootOwnerGeneration: number;
    readonly directAccessEnabled: boolean;
    readonly authorityCommitment: string;
    readonly sourceTransferTicketId: TransferTicketId | null;
  };
  readonly ChildAssignmentAmended: {
    readonly previousAssignmentRevision: number;
    readonly assignmentRevision: number;
    readonly assignment: LifecycleAssignmentV1;
    readonly reasonCode: string;
  };
  readonly ChildWorkReported: {
    readonly report: ChildReportV1;
    readonly childAuthorAgentId: string;
    readonly primaryRecorderAgentId: string | null;
  };
  readonly ChildWorkDispositioned: { readonly disposition: ChildDispositionV1 };
  readonly ChildCompletionProposed: { readonly reportId: ReportId };
  readonly ChildSessionCompleted: {
    readonly reportId: ReportId;
    readonly authorityCommitment: string;
  };
  readonly ChildSessionSuspended: {
    readonly checkpointId: CheckpointId;
    readonly blockers: readonly string[];
    readonly followUps: readonly string[];
    readonly authorityCommitment: string;
  };
  readonly ChildWorkTransferCreated: {
    readonly transferTicketId: TransferTicketId;
    readonly checkpointId: CheckpointId;
    readonly authorityCommitment: string;
  };
  readonly ChildWorkTransferClaimed: {
    readonly transferTicketId: TransferTicketId;
    readonly previousChildSessionId: SessionId;
    readonly previousTransferEventPosition: string;
  };
  readonly SessionEndRequested: {
    readonly workflowId: WorkflowId;
    readonly workflowGeneration: number;
    readonly previousState: (typeof ROOT_PREVIOUS_STATES)[number];
    readonly childEndPolicy: ChildEndPolicy;
    readonly qualityThreshold: number;
    readonly requireFullEvidence: boolean;
    readonly requireMaterialization: boolean;
  };
  readonly SessionEndAmended: {
    readonly workflowId: WorkflowId;
    readonly previousWorkflowGeneration: number;
    readonly workflowGeneration: number;
    readonly preTransitionCheckpointId: CheckpointId;
  };
  readonly SessionValidationResultRecorded: {
    readonly workflowId: WorkflowId;
    readonly workflowGeneration: number;
    readonly plannedWorkId: string;
    readonly validationResult: ValidationResultV1;
  };
  readonly SessionEndVerificationPassed: {
    readonly workflowId: WorkflowId;
    readonly workflowGeneration: number;
    readonly validationResultIds: readonly ValidationResultId[];
    readonly qualityScore: number;
  };
  readonly SessionEndVerificationFailed: {
    readonly workflowId: WorkflowId;
    readonly workflowGeneration: number;
    readonly validationResultIds: readonly ValidationResultId[];
    readonly safeFailureCode: LifecycleErrorCode;
  };
  readonly SessionEndVerificationInvalidated: {
    readonly workflowId: WorkflowId;
    readonly workflowGeneration: number;
    readonly previousVerificationEventPosition: string;
    readonly safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT";
  };
  readonly SessionEndCancelled: {
    readonly workflowId: WorkflowId;
    readonly workflowGeneration: number;
    readonly restoredState: (typeof ROOT_PREVIOUS_STATES)[number];
    readonly preTransitionCheckpointId: CheckpointId;
  };
  readonly SessionAbandoned: {
    readonly workflowId: WorkflowId | null;
    readonly workflowGeneration: number | null;
    readonly approvalId: ApprovalId;
    readonly preTransitionCheckpointId: CheckpointId;
    readonly reasonCode: string;
    readonly authorityCommitment: string;
  };
  readonly SessionEnded: {
    readonly workflowId: WorkflowId;
    readonly workflowGeneration: number;
    readonly verificationEventPosition: string;
    readonly authorityCommitment: string;
  };
}

export type LifecycleEventPayloadV1<
  T extends LifecycleEventType = LifecycleEventType,
> = LifecycleEventPayloadMapV1[T];

export interface LifecycleEventBaseV1<T extends LifecycleEventType = LifecycleEventType> {
  readonly eventSchemaVersion: 1;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly streamId: string;
  readonly streamVersion: string;
  readonly globalPosition: string;
  readonly sessionId: SessionId;
  readonly parentSessionId: SessionId | null;
  readonly eventType: T;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly authorityCommitment: string;
  readonly payload: LifecycleEventPayloadMapV1[T];
}

export type LifecycleEventV1 = {
  readonly [T in LifecycleEventType]: LifecycleEventBaseV1<T>;
}[LifecycleEventType];

function invalid(field: string): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID", { field });
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !LOWER_HASH.test(value)) invalid(field);
  return value;
}

function generation(value: unknown, field: string): number {
  return parseInteger(value, field, 1, Number.MAX_SAFE_INTEGER);
}

function assignment(value: unknown, field: string): LifecycleAssignmentV1 {
  const item = exactRecord(value, ["assignmentId", "summary", "scope"], field);
  return Object.freeze({
    assignmentId: parseLifecycleId(item.assignmentId, `${field}.assignmentId`),
    summary: parseBoundedString(item.summary, `${field}.summary`, 4_000),
    scope: parseBoundedString(item.scope, `${field}.scope`, 4_000),
  });
}

function stringList(value: unknown, field: string): readonly string[] {
  const source = strictArray(value, field);
  if (source.length > 100) invalid(field);
  return Object.freeze(source.map((item, index) =>
    parseBoundedString(item, `${field}[${index}]`, 4_000)));
}

function validationResultIds(value: unknown, field: string): readonly ValidationResultId[] {
  const source = strictArray(value, field);
  if (source.length > 64) invalid(field);
  const ids = source.map((item, index) =>
    parseLifecycleId<ValidationResultId>(item, `${field}[${index}]`));
  if (new Set(ids).size !== ids.length) invalid(field);
  return Object.freeze(ids);
}

function interval(value: unknown, field: string): LifecycleMissingOrdinalIntervalV1 {
  const item = exactRecord(value, ["firstOrdinal", "lastOrdinal"], field);
  const firstOrdinal = parseDecimalString(item.firstOrdinal, `${field}.firstOrdinal`);
  const lastOrdinal = parseDecimalString(item.lastOrdinal, `${field}.lastOrdinal`);
  if (BigInt(firstOrdinal) > BigInt(lastOrdinal)) invalid(field);
  return Object.freeze({ firstOrdinal, lastOrdinal });
}

function intervals(value: unknown, field: string): readonly LifecycleMissingOrdinalIntervalV1[] {
  const source = strictArray(value, field);
  if (source.length > 200) invalid(field);
  const decoded = source.map((item, index) => interval(item, `${field}[${index}]`));
  for (let index = 1; index < decoded.length; index += 1) {
    const previous = decoded[index - 1];
    const current = decoded[index];
    if (
      previous === undefined
      || current === undefined
      || BigInt(current.firstOrdinal) <= BigInt(previous.lastOrdinal) + 1n
    ) invalid(field);
  }
  return Object.freeze(decoded);
}

function evidenceFrame(value: unknown, field: string): LifecycleEvidenceFrameRecordedV1 {
  const frame = exactRecord(
    value,
    ["frameId", "ordinal", "sourceKind", "observedAt", "contentFingerprint"],
    field,
  );
  return Object.freeze({
    frameId: parseLifecycleId<EvidenceFrameId>(frame.frameId, `${field}.frameId`),
    ordinal: parseDecimalString(frame.ordinal, `${field}.ordinal`),
    sourceKind: parseEnum(frame.sourceKind, EVIDENCE_SOURCE_KINDS, `${field}.sourceKind`),
    observedAt: parseCanonicalTimestamp(frame.observedAt, `${field}.observedAt`),
    contentFingerprint: hash(frame.contentFingerprint, `${field}.contentFingerprint`),
  });
}

function evidenceFrames(value: unknown): readonly LifecycleEvidenceFrameRecordedV1[] {
  const source = strictArray(value, "event.payload.frames");
  if (source.length === 0 || source.length > 2_000) invalid("event.payload.frames");
  const decoded = source.map((item, index) => evidenceFrame(item, `event.payload.frames[${index}]`));
  for (let index = 1; index < decoded.length; index += 1) {
    const previous = decoded[index - 1];
    const current = decoded[index];
    if (
      previous === undefined
      || current === undefined
      || BigInt(current.ordinal) !== BigInt(previous.ordinal) + 1n
    ) invalid("event.payload.frames");
  }
  if (new Set(decoded.map((frame) => frame.frameId)).size !== decoded.length) {
    invalid("event.payload.frames");
  }
  return Object.freeze(decoded);
}

function workflowId(value: unknown, field = "event.payload.workflowId"): WorkflowId {
  return parseLifecycleId<WorkflowId>(value, field);
}

function checkpointId(value: unknown, field: string): CheckpointId {
  return parseLifecycleId<CheckpointId>(value, field);
}

function decodePayload(
  eventType: LifecycleEventType,
  value: unknown,
): LifecycleEventPayloadV1 {
  switch (eventType) {
    case "SessionStarted": {
      const payload = exactRecord(value, [
        "sessionKind",
        "ownerGeneration",
        "continuityKey",
        "clientNamespace",
        "creatingAgentId",
        "creatingClientInstanceId",
        "authorityCommitment",
      ], "event.payload");
      if (payload.sessionKind !== "root" || payload.ownerGeneration !== 1) invalid("event.payload");
      return Object.freeze({
        sessionKind: "root" as const,
        ownerGeneration: 1,
        continuityKey: parseBoundedString(payload.continuityKey, "event.payload.continuityKey", 1_024),
        clientNamespace: parseBoundedString(payload.clientNamespace, "event.payload.clientNamespace", 256),
        creatingAgentId: parseBoundedString(payload.creatingAgentId, "event.payload.creatingAgentId", 256),
        creatingClientInstanceId: parseBoundedString(
          payload.creatingClientInstanceId,
          "event.payload.creatingClientInstanceId",
          256,
        ),
        authorityCommitment: hash(payload.authorityCommitment, "event.payload.authorityCommitment"),
      });
    }
    case "SessionOwnerTransferred":
    case "SessionOwnershipRecovered": {
      const recovered = eventType === "SessionOwnershipRecovered";
      const payload = exactRecord(value, [
        "previousOwnerGeneration",
        "ownerGeneration",
        ...(recovered ? ["approvalId"] : []),
        "authorityCommitment",
      ], "event.payload");
      const previousOwnerGeneration = generation(payload.previousOwnerGeneration, "event.payload.previousOwnerGeneration");
      const ownerGeneration = generation(payload.ownerGeneration, "event.payload.ownerGeneration");
      if (ownerGeneration !== previousOwnerGeneration + 1) invalid("event.payload.ownerGeneration");
      const common = {
        previousOwnerGeneration,
        ownerGeneration,
        authorityCommitment: hash(payload.authorityCommitment, "event.payload.authorityCommitment"),
      };
      return recovered
        ? Object.freeze({
            ...common,
            approvalId: parseLifecycleId<ApprovalId>(payload.approvalId, "event.payload.approvalId"),
          })
        : Object.freeze(common);
    }
    case "SessionSuspendRequested": {
      const payload = exactRecord(value, ["checkpointId"], "event.payload");
      return Object.freeze({ checkpointId: checkpointId(payload.checkpointId, "event.payload.checkpointId") });
    }
    case "SessionSuspended": {
      const payload = exactRecord(value, ["authorityCommitment"], "event.payload");
      return Object.freeze({ authorityCommitment: hash(payload.authorityCommitment, "event.payload.authorityCommitment") });
    }
    case "SessionResumed": {
      const payload = exactRecord(value, ["ownerGeneration"], "event.payload");
      return Object.freeze({ ownerGeneration: generation(payload.ownerGeneration, "event.payload.ownerGeneration") });
    }
    case "SessionCheckpointRecorded": {
      const payload = exactRecord(
        value,
        ["checkpoint", "baseEventPosition", "checkpointEventPosition"],
        "event.payload",
      );
      const checkpoint = decodeCheckpointV1(payload.checkpoint);
      const baseEventPosition = parseDecimalString(payload.baseEventPosition, "event.payload.baseEventPosition");
      const checkpointEventPosition = parseDecimalString(
        payload.checkpointEventPosition,
        "event.payload.checkpointEventPosition",
      );
      if (
        checkpoint.baseEventPosition !== baseEventPosition
        || checkpoint.checkpointEventPosition !== checkpointEventPosition
      ) invalid("event.payload.checkpoint");
      return Object.freeze({ checkpoint, baseEventPosition, checkpointEventPosition });
    }
    case "EvidenceCoverageRecorded": {
      const payload = exactRecord(value, [
        "adapterSessionId",
        "batchId",
        "firstOrdinal",
        "lastOrdinal",
        "highestContiguousOrdinal",
        "missingIntervals",
        "fingerprintSchemaVersion",
        "fingerprintKeyId",
        "fingerprintDomain",
        "coverageFingerprint",
        "captureMode",
        "contentRetained",
        "frames",
      ], "event.payload");
      if (
        payload.fingerprintSchemaVersion !== 1
        || payload.fingerprintDomain !== "pm-evidence-frame-v1"
        || payload.captureMode !== "coverage-only"
        || payload.contentRetained !== false
      ) invalid("event.payload");
      const firstOrdinal = parseDecimalString(payload.firstOrdinal, "event.payload.firstOrdinal");
      const lastOrdinal = parseDecimalString(payload.lastOrdinal, "event.payload.lastOrdinal");
      const frames = evidenceFrames(payload.frames);
      const highestContiguousOrdinal = payload.highestContiguousOrdinal === null
        ? null
        : parseDecimalString(payload.highestContiguousOrdinal, "event.payload.highestContiguousOrdinal");
      const missingIntervals = intervals(payload.missingIntervals, "event.payload.missingIntervals");
      if (
        BigInt(firstOrdinal) > BigInt(lastOrdinal)
        || frames[0]?.ordinal !== firstOrdinal
        || frames.at(-1)?.ordinal !== lastOrdinal
      ) invalid("event.payload.frames");
      const firstMissingInterval = missingIntervals[0];
      if (
        firstMissingInterval !== undefined
        && BigInt(firstMissingInterval.firstOrdinal) !== (
          highestContiguousOrdinal === null ? 0n : BigInt(highestContiguousOrdinal) + 1n
        )
      ) invalid("event.payload.missingIntervals");
      return Object.freeze({
        adapterSessionId: parseLifecycleId<AdapterSessionId>(payload.adapterSessionId, "event.payload.adapterSessionId"),
        batchId: parseLifecycleId<EvidenceBatchId>(payload.batchId, "event.payload.batchId"),
        firstOrdinal,
        lastOrdinal,
        highestContiguousOrdinal,
        missingIntervals,
        fingerprintSchemaVersion: 1,
        fingerprintKeyId: parseBoundedString(payload.fingerprintKeyId, "event.payload.fingerprintKeyId", 128),
        fingerprintDomain: "pm-evidence-frame-v1" as const,
        coverageFingerprint: hash(payload.coverageFingerprint, "event.payload.coverageFingerprint"),
        captureMode: "coverage-only" as const,
        contentRetained: false as const,
        frames,
      });
    }
    case "SessionForked": {
      const payload = exactRecord(value, [
        "parentSessionId",
        "assignment",
        "rootOwnerGeneration",
        "directAccessEnabled",
        "authorityCommitment",
        "sourceTransferTicketId",
      ], "event.payload");
      return Object.freeze({
        parentSessionId: parseLifecycleId<SessionId>(payload.parentSessionId, "event.payload.parentSessionId"),
        assignment: assignment(payload.assignment, "event.payload.assignment"),
        rootOwnerGeneration: generation(payload.rootOwnerGeneration, "event.payload.rootOwnerGeneration"),
        directAccessEnabled: parseBoolean(payload.directAccessEnabled, "event.payload.directAccessEnabled"),
        authorityCommitment: hash(payload.authorityCommitment, "event.payload.authorityCommitment"),
        sourceTransferTicketId: parseNullableUuid<TransferTicketId>(
          payload.sourceTransferTicketId,
          "event.payload.sourceTransferTicketId",
        ),
      });
    }
    case "ChildAssignmentAmended": {
      const payload = exactRecord(value, [
        "previousAssignmentRevision",
        "assignmentRevision",
        "assignment",
        "reasonCode",
      ], "event.payload");
      const previousAssignmentRevision = generation(
        payload.previousAssignmentRevision,
        "event.payload.previousAssignmentRevision",
      );
      const assignmentRevision = generation(payload.assignmentRevision, "event.payload.assignmentRevision");
      if (assignmentRevision !== previousAssignmentRevision + 1) invalid("event.payload.assignmentRevision");
      return Object.freeze({
        previousAssignmentRevision,
        assignmentRevision,
        assignment: assignment(payload.assignment, "event.payload.assignment"),
        reasonCode: parseBoundedString(payload.reasonCode, "event.payload.reasonCode", 128),
      });
    }
    case "ChildWorkReported": {
      const payload = exactRecord(
        value,
        ["report", "childAuthorAgentId", "primaryRecorderAgentId"],
        "event.payload",
      );
      return Object.freeze({
        report: decodeChildReportV1(payload.report),
        childAuthorAgentId: parseBoundedString(payload.childAuthorAgentId, "event.payload.childAuthorAgentId", 256),
        primaryRecorderAgentId: parseNullableBoundedString(
          payload.primaryRecorderAgentId,
          "event.payload.primaryRecorderAgentId",
          256,
        ),
      });
    }
    case "ChildWorkDispositioned": {
      const payload = exactRecord(value, ["disposition"], "event.payload");
      return Object.freeze({ disposition: decodeChildDispositionV1(payload.disposition) });
    }
    case "ChildCompletionProposed": {
      const payload = exactRecord(value, ["reportId"], "event.payload");
      return Object.freeze({ reportId: parseLifecycleId<ReportId>(payload.reportId, "event.payload.reportId") });
    }
    case "ChildSessionCompleted": {
      const payload = exactRecord(value, ["reportId", "authorityCommitment"], "event.payload");
      return Object.freeze({
        reportId: parseLifecycleId<ReportId>(payload.reportId, "event.payload.reportId"),
        authorityCommitment: hash(payload.authorityCommitment, "event.payload.authorityCommitment"),
      });
    }
    case "ChildSessionSuspended": {
      const payload = exactRecord(
        value,
        ["checkpointId", "blockers", "followUps", "authorityCommitment"],
        "event.payload",
      );
      return Object.freeze({
        checkpointId: checkpointId(payload.checkpointId, "event.payload.checkpointId"),
        blockers: stringList(payload.blockers, "event.payload.blockers"),
        followUps: stringList(payload.followUps, "event.payload.followUps"),
        authorityCommitment: hash(payload.authorityCommitment, "event.payload.authorityCommitment"),
      });
    }
    case "ChildWorkTransferCreated": {
      const payload = exactRecord(
        value,
        ["transferTicketId", "checkpointId", "authorityCommitment"],
        "event.payload",
      );
      return Object.freeze({
        transferTicketId: parseLifecycleId<TransferTicketId>(payload.transferTicketId, "event.payload.transferTicketId"),
        checkpointId: checkpointId(payload.checkpointId, "event.payload.checkpointId"),
        authorityCommitment: hash(payload.authorityCommitment, "event.payload.authorityCommitment"),
      });
    }
    case "ChildWorkTransferClaimed": {
      const payload = exactRecord(
        value,
        ["transferTicketId", "previousChildSessionId", "previousTransferEventPosition"],
        "event.payload",
      );
      return Object.freeze({
        transferTicketId: parseLifecycleId<TransferTicketId>(payload.transferTicketId, "event.payload.transferTicketId"),
        previousChildSessionId: parseLifecycleId<SessionId>(
          payload.previousChildSessionId,
          "event.payload.previousChildSessionId",
        ),
        previousTransferEventPosition: parseDecimalString(
          payload.previousTransferEventPosition,
          "event.payload.previousTransferEventPosition",
        ),
      });
    }
    case "SessionEndRequested": {
      const payload = exactRecord(value, [
        "workflowId",
        "workflowGeneration",
        "previousState",
        "childEndPolicy",
        "qualityThreshold",
        "requireFullEvidence",
        "requireMaterialization",
      ], "event.payload");
      return Object.freeze({
        workflowId: workflowId(payload.workflowId),
        workflowGeneration: generation(payload.workflowGeneration, "event.payload.workflowGeneration"),
        previousState: parseEnum(payload.previousState, ROOT_PREVIOUS_STATES, "event.payload.previousState"),
        childEndPolicy: parseEnum(payload.childEndPolicy, CHILD_END_POLICIES, "event.payload.childEndPolicy"),
        qualityThreshold: parseInteger(payload.qualityThreshold, "event.payload.qualityThreshold", 0, 10_000),
        requireFullEvidence: parseBoolean(payload.requireFullEvidence, "event.payload.requireFullEvidence"),
        requireMaterialization: parseBoolean(payload.requireMaterialization, "event.payload.requireMaterialization"),
      });
    }
    case "SessionEndAmended": {
      const payload = exactRecord(value, [
        "workflowId",
        "previousWorkflowGeneration",
        "workflowGeneration",
        "preTransitionCheckpointId",
      ], "event.payload");
      const previousWorkflowGeneration = generation(
        payload.previousWorkflowGeneration,
        "event.payload.previousWorkflowGeneration",
      );
      const workflowGeneration = generation(payload.workflowGeneration, "event.payload.workflowGeneration");
      if (workflowGeneration !== previousWorkflowGeneration + 1) invalid("event.payload.workflowGeneration");
      return Object.freeze({
        workflowId: workflowId(payload.workflowId),
        previousWorkflowGeneration,
        workflowGeneration,
        preTransitionCheckpointId: checkpointId(
          payload.preTransitionCheckpointId,
          "event.payload.preTransitionCheckpointId",
        ),
      });
    }
    case "SessionValidationResultRecorded": {
      const payload = exactRecord(
        value,
        ["workflowId", "workflowGeneration", "plannedWorkId", "validationResult"],
        "event.payload",
      );
      const decodedWorkflowId = workflowId(payload.workflowId);
      const workflowGeneration = generation(payload.workflowGeneration, "event.payload.workflowGeneration");
      const plannedWorkId = hash(payload.plannedWorkId, "event.payload.plannedWorkId");
      const validationResult = decodeValidationResultV1(payload.validationResult);
      if (
        validationResult.workflowId !== decodedWorkflowId
        || validationResult.workflowGeneration !== workflowGeneration
      ) invalid("event.payload.validationResult");
      return Object.freeze({
        workflowId: decodedWorkflowId,
        workflowGeneration,
        plannedWorkId,
        validationResult,
      });
    }
    case "SessionEndVerificationPassed": {
      const payload = exactRecord(
        value,
        ["workflowId", "workflowGeneration", "validationResultIds", "qualityScore"],
        "event.payload",
      );
      return Object.freeze({
        workflowId: workflowId(payload.workflowId),
        workflowGeneration: generation(payload.workflowGeneration, "event.payload.workflowGeneration"),
        validationResultIds: validationResultIds(payload.validationResultIds, "event.payload.validationResultIds"),
        qualityScore: parseInteger(payload.qualityScore, "event.payload.qualityScore", 0, 10_000),
      });
    }
    case "SessionEndVerificationFailed": {
      const payload = exactRecord(
        value,
        ["workflowId", "workflowGeneration", "validationResultIds", "safeFailureCode"],
        "event.payload",
      );
      return Object.freeze({
        workflowId: workflowId(payload.workflowId),
        workflowGeneration: generation(payload.workflowGeneration, "event.payload.workflowGeneration"),
        validationResultIds: validationResultIds(payload.validationResultIds, "event.payload.validationResultIds"),
        safeFailureCode: parseEnum(payload.safeFailureCode, LIFECYCLE_ERROR_CODES, "event.payload.safeFailureCode"),
      });
    }
    case "SessionEndVerificationInvalidated": {
      const payload = exactRecord(value, [
        "workflowId",
        "workflowGeneration",
        "previousVerificationEventPosition",
        "safeFailureCode",
      ], "event.payload");
      if (payload.safeFailureCode !== "SESSION_SOURCE_STATE_CONFLICT") invalid("event.payload.safeFailureCode");
      return Object.freeze({
        workflowId: workflowId(payload.workflowId),
        workflowGeneration: generation(payload.workflowGeneration, "event.payload.workflowGeneration"),
        previousVerificationEventPosition: parseDecimalString(
          payload.previousVerificationEventPosition,
          "event.payload.previousVerificationEventPosition",
        ),
        safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT" as const,
      });
    }
    case "SessionEndCancelled": {
      const payload = exactRecord(
        value,
        ["workflowId", "workflowGeneration", "restoredState", "preTransitionCheckpointId"],
        "event.payload",
      );
      return Object.freeze({
        workflowId: workflowId(payload.workflowId),
        workflowGeneration: generation(payload.workflowGeneration, "event.payload.workflowGeneration"),
        restoredState: parseEnum(payload.restoredState, ROOT_PREVIOUS_STATES, "event.payload.restoredState"),
        preTransitionCheckpointId: checkpointId(
          payload.preTransitionCheckpointId,
          "event.payload.preTransitionCheckpointId",
        ),
      });
    }
    case "SessionAbandoned": {
      const payload = exactRecord(value, [
        "workflowId",
        "workflowGeneration",
        "approvalId",
        "preTransitionCheckpointId",
        "reasonCode",
        "authorityCommitment",
      ], "event.payload");
      const decodedWorkflowId = payload.workflowId === null ? null : workflowId(payload.workflowId);
      const workflowGeneration = payload.workflowGeneration === null
        ? null
        : generation(payload.workflowGeneration, "event.payload.workflowGeneration");
      if ((decodedWorkflowId === null) !== (workflowGeneration === null)) invalid("event.payload.workflowId");
      return Object.freeze({
        workflowId: decodedWorkflowId,
        workflowGeneration,
        approvalId: parseLifecycleId<ApprovalId>(payload.approvalId, "event.payload.approvalId"),
        preTransitionCheckpointId: checkpointId(
          payload.preTransitionCheckpointId,
          "event.payload.preTransitionCheckpointId",
        ),
        reasonCode: parseBoundedString(payload.reasonCode, "event.payload.reasonCode", 128),
        authorityCommitment: hash(payload.authorityCommitment, "event.payload.authorityCommitment"),
      });
    }
    case "SessionEnded": {
      const payload = exactRecord(
        value,
        ["workflowId", "workflowGeneration", "verificationEventPosition", "authorityCommitment"],
        "event.payload",
      );
      return Object.freeze({
        workflowId: workflowId(payload.workflowId),
        workflowGeneration: generation(payload.workflowGeneration, "event.payload.workflowGeneration"),
        verificationEventPosition: parseDecimalString(
          payload.verificationEventPosition,
          "event.payload.verificationEventPosition",
        ),
        authorityCommitment: hash(payload.authorityCommitment, "event.payload.authorityCommitment"),
      });
    }
  }
}

const ROOT_ONLY_EVENTS = new Set<LifecycleEventType>([
  "SessionStarted",
  "SessionOwnerTransferred",
  "SessionOwnershipRecovered",
  "SessionSuspendRequested",
  "SessionSuspended",
  "SessionResumed",
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

const CHILD_ONLY_EVENTS = new Set<LifecycleEventType>([
  "SessionForked",
  "ChildAssignmentAmended",
  "ChildWorkReported",
  "ChildWorkDispositioned",
  "ChildCompletionProposed",
  "ChildSessionCompleted",
  "ChildSessionSuspended",
  "ChildWorkTransferCreated",
  "ChildWorkTransferClaimed",
]);

export function decodeLifecycleEventV1(value: unknown): LifecycleEventV1 {
  try {
    const event = exactRecord(value, EVENT_BASE_KEYS, "lifecycleEvent");
    if (event.eventSchemaVersion !== 1) invalid("eventSchemaVersion");
    const eventType = parseEnum(event.eventType, LIFECYCLE_EVENT_TYPES, "eventType");
    const workspaceId = event.workspaceId;
    if (typeof workspaceId !== "string" || !LOWER_HASH.test(workspaceId)) invalid("workspaceId");
    const streamVersion = parseDecimalString(event.streamVersion, "streamVersion");
    const globalPosition = parseDecimalString(event.globalPosition, "globalPosition");
    if (streamVersion === "0" || globalPosition === "0") invalid("event.position");
    const parentSessionId = parseNullableUuid<SessionId>(event.parentSessionId, "parentSessionId");
    if (ROOT_ONLY_EVENTS.has(eventType) && parentSessionId !== null) invalid("parentSessionId");
    if (CHILD_ONLY_EVENTS.has(eventType) && parentSessionId === null) invalid("parentSessionId");
    if (eventType === "SessionForked" && streamVersion !== "1") invalid("streamVersion");
    const payload = decodePayload(eventType, event.payload);
    const authorityCommitment = hash(event.authorityCommitment, "authorityCommitment");
    if ("authorityCommitment" in payload && payload.authorityCommitment !== authorityCommitment) {
      invalid("event.payload.authorityCommitment");
    }
    if (
      eventType === "SessionForked"
      && (payload as LifecycleEventPayloadMapV1["SessionForked"]).parentSessionId !== parentSessionId
    ) invalid("event.payload.parentSessionId");
    if (eventType === "SessionCheckpointRecorded") {
      const checkpointPayload = payload as LifecycleEventPayloadMapV1["SessionCheckpointRecorded"];
      if (
        checkpointPayload.checkpointEventPosition !== globalPosition
        || checkpointPayload.checkpoint.sessionId !== event.sessionId
        || checkpointPayload.checkpoint.parentSessionId !== parentSessionId
      ) invalid("event.payload.checkpoint");
    }
    if (eventType === "ChildWorkReported") {
      const reportPayload = payload as LifecycleEventPayloadMapV1["ChildWorkReported"];
      if (
        reportPayload.report.childSessionId !== event.sessionId
        || reportPayload.report.parentSessionId !== parentSessionId
      ) invalid("event.payload.report");
    }
    if (eventType === "SessionValidationResultRecorded") {
      const validationPayload = payload as LifecycleEventPayloadMapV1["SessionValidationResultRecorded"];
      if (
        validationPayload.validationResult.projectId !== event.projectId
        || validationPayload.validationResult.vaultId !== event.vaultId
        || validationPayload.validationResult.storeId !== event.storeId
        || validationPayload.validationResult.workspaceId !== workspaceId
        || validationPayload.validationResult.sessionId !== event.sessionId
      ) invalid("event.payload.validationResult");
    }
    return Object.freeze({
      eventSchemaVersion: 1,
      eventId: parseLifecycleId(event.eventId, "eventId"),
      projectId: parseLifecycleId<ProjectId>(event.projectId, "projectId"),
      vaultId: parseLifecycleId<VaultId>(event.vaultId, "vaultId"),
      storeId: parseLifecycleId<StoreId>(event.storeId, "storeId"),
      workspaceId: workspaceId as WorkspaceId,
      streamId: parseBoundedString(event.streamId, "streamId", 512),
      streamVersion,
      globalPosition,
      sessionId: parseLifecycleId<SessionId>(event.sessionId, "sessionId"),
      parentSessionId,
      eventType,
      correlationId: parseLifecycleId(event.correlationId, "correlationId"),
      causationId: parseNullableUuid(event.causationId, "causationId"),
      commandId: parseLifecycleId(event.commandId, "commandId"),
      idempotencyKey: parseLifecycleId(event.idempotencyKey, "idempotencyKey"),
      occurredAt: parseCanonicalTimestamp(event.occurredAt, "occurredAt"),
      authorityCommitment,
      payload,
    }) as LifecycleEventV1;
  } catch {
    invalid("lifecycleEvent");
  }
}
