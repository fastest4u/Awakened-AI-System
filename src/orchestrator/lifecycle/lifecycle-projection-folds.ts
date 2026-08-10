import { createHash } from "node:crypto";
import type { StoredEvent } from "../contracts/event.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import {
  decodeLifecycleEvent,
  type LifecycleEventCodecResult,
} from "./contracts/events.js";
import type { ChildSessionState } from "./contracts/identifiers.js";
import type { LifecycleIntentWitnessV1 } from "./lifecycle-intent-witness.js";

const REPORT_ITEM_SET_DOMAIN =
  "project-memory/lifecycle/report-item-set/v1\n";
const REPORT_WITNESS_DOMAIN =
  "project-memory/lifecycle/report-witness/v1\n";
const REPORT_INDEX_DOMAIN =
  "project-memory/lifecycle/report-index/v1\n";
const CHILD_EVENT_FOLD_DOMAIN =
  "project-memory/lifecycle/child-event-fold/v1\n";
const WORKFLOW_GENERATION_DOMAIN =
  "project-memory/lifecycle/workflow-generation/v1\n";
const WORKFLOW_GENERATION_V2_DOMAIN =
  "project-memory/lifecycle/workflow-generation/v2\n";
const LOWER_HASH = /^[0-9a-f]{64}$/;
const CHILD_REPORT_LIMIT = 200;

export interface ChildEventFoldProjection {
  readonly projectId: string;
  readonly childSessionId: string;
  readonly eventPosition: bigint;
  readonly streamVersion: bigint;
  readonly rootSessionId: string;
  readonly childState: ChildSessionState;
  readonly latestCheckpointId: string | null;
  readonly latestCheckpointEventPosition: bigint | null;
  readonly authorityCommitment: string;
  readonly terminalEventType:
    | "ChildSessionCompleted"
    | "ChildWorkTransferCreated"
    | null;
  readonly terminalEventPosition: bigint | null;
  readonly reportCount: number;
  readonly latestReportId: string | null;
  readonly reportIndexFingerprint: string;
  readonly completionReportId: string | null;
  readonly reportedReportId: string | null;
  readonly reportedItemCount: number | null;
  readonly reportedItemSetFingerprint: string | null;
  readonly previousFingerprint: string | null;
  readonly fingerprint: string;
}

export interface WorkflowGenerationFoldProjection {
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly sessionId: string;
  readonly triggerEventPosition: bigint;
  readonly rootCommandId: string;
  readonly evidenceWindowState: "open" | "sealed";
  readonly replacementCheckpointVersion: 1 | 2 | null;
  readonly effectiveCheckpointVersion: 1 | 2;
  readonly effectiveDraftSourceEventPosition: bigint;
  readonly fingerprintSchemaVersion: 1 | 2;
  readonly effectiveStateSourceEventPosition: bigint | null;
  readonly effectiveStateVersion: 1 | null;
  readonly effectiveStateHash: string | null;
  readonly previousFingerprint: string | null;
  readonly fingerprint: string;
}

export interface WorkflowFingerprintV2Input {
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly sessionId: string;
  readonly triggerEventPosition: bigint;
  readonly triggerEventHash: string;
  readonly rootCommandId: string;
  readonly evidenceWindowState: "open" | "sealed";
  readonly replacementCheckpointVersion: 1 | 2 | null;
  readonly effectiveCheckpointVersion: 1 | 2;
  readonly effectiveDraftSourceEventPosition: bigint;
  readonly effectiveStateSourceEventPosition: bigint | null;
  readonly effectiveStateVersion: 1 | null;
  readonly effectiveStateHash: string | null;
  readonly previousFingerprintSchemaVersion: 1 | 2 | null;
  readonly previousFingerprint: string | null;
}

export type ChildProjectionEventClassification =
  | "child-only"
  | "dual-scope-child"
  | "none";

export type WorkflowProjectionEventClassification =
  | { readonly kind: "none" }
  | { readonly kind: "null-identity-abandon" }
  | {
      readonly kind: "identified";
      readonly workflowId: string;
      readonly workflowGeneration: number;
    };

function invalid(): never {
  throw new TypeError("LIFECYCLE_PROJECTION_INVALID");
}

export function classifyChildProjectionEvent(
  event: Pick<StoredEvent, "eventType" | "parentSessionId">,
): ChildProjectionEventClassification {
  switch (event.eventType) {
    case "SessionForked":
    case "ChildAssignmentAmended":
    case "ChildWorkReported":
    case "ChildWorkDispositioned":
    case "ChildCompletionProposed":
    case "ChildSessionCompleted":
    case "ChildSessionSuspended":
    case "ChildWorkTransferCreated":
    case "ChildWorkTransferClaimed":
      return "child-only";
    case "SessionCheckpointRecorded":
    case "EvidenceCoverageRecorded":
      return event.parentSessionId === null ? "none" : "dual-scope-child";
    default:
      return "none";
  }
}

export function classifyWorkflowProjectionEvent(
  event: Pick<StoredEvent, "eventType" | "payload">,
): WorkflowProjectionEventClassification {
  if (
    event.eventType !== "SessionEndRequested"
    && event.eventType !== "SessionEndAmended"
    && event.eventType !== "SessionEndCancelled"
    && event.eventType !== "SessionAbandoned"
  ) return Object.freeze({ kind: "none" });

  const payload = record(event.payload);
  if (
    event.eventType === "SessionAbandoned"
    && payload.workflowId === null
    && payload.workflowGeneration === null
  ) return Object.freeze({ kind: "null-identity-abandon" });
  if (
    typeof payload.workflowId !== "string"
    || payload.workflowId.trim().length === 0
    || typeof payload.workflowGeneration !== "number"
    || !Number.isSafeInteger(payload.workflowGeneration)
    || payload.workflowGeneration <= 0
  ) return invalid();
  return Object.freeze({
    kind: "identified",
    workflowId: payload.workflowId,
    workflowGeneration: payload.workflowGeneration,
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid();
  }
  return value as Readonly<Record<string, unknown>>;
}

function hash(domain: string, tuple: readonly unknown[]): string {
  return createHash("sha256")
    .update(Buffer.from(domain, "utf8"))
    .update(Buffer.from(canonicalJson(tuple), "utf8"))
    .digest("hex");
}

function assertHash(value: string): void {
  if (!LOWER_HASH.test(value)) invalid();
}

function assertPositiveInt64(value: bigint): void {
  if (value <= 0n || value > 9_223_372_036_854_775_807n) invalid();
}

function checkpointVersion(value: unknown): 1 | 2 {
  const version = record(value).checkpointVersion;
  if (version !== 1 && version !== 2) return invalid();
  return version;
}

function withoutChildFingerprint(
  row: ChildEventFoldProjection,
): Omit<ChildEventFoldProjection, "fingerprint"> {
  const { fingerprint: _fingerprint, ...without } = row;
  return without;
}

function withoutWorkflowFingerprint(
  row: WorkflowGenerationFoldProjection,
): Omit<WorkflowGenerationFoldProjection, "fingerprint"> {
  const { fingerprint: _fingerprint, ...without } = row;
  return without;
}

export function reportItemSetFingerprint(input: {
  readonly projectId: string;
  readonly childSessionId: string;
  readonly reportId: string;
  readonly allReportItemIds: readonly string[];
}): string {
  if (
    input.projectId.length === 0
    || input.childSessionId.length === 0
    || input.reportId.length === 0
    || input.allReportItemIds.length > CHILD_REPORT_LIMIT
    || input.allReportItemIds.some((itemId) =>
      typeof itemId !== "string" || itemId.length === 0)
    || new Set(input.allReportItemIds).size !== input.allReportItemIds.length
  ) invalid();
  const sorted = [...input.allReportItemIds].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  return hash(REPORT_ITEM_SET_DOMAIN, [
    input.projectId,
    input.childSessionId,
    input.reportId,
    sorted,
  ]);
}

export function reportWitnessFingerprint(row: Pick<
  ChildEventFoldProjection,
  | "projectId"
  | "childSessionId"
  | "eventPosition"
  | "streamVersion"
  | "reportedReportId"
  | "reportedItemCount"
  | "reportedItemSetFingerprint"
>): string {
  assertPositiveInt64(row.eventPosition);
  assertPositiveInt64(row.streamVersion);
  if (
    row.reportedReportId === null
    || row.reportedItemCount === null
    || row.reportedItemSetFingerprint === null
    || row.reportedItemCount < 0
    || row.reportedItemCount > CHILD_REPORT_LIMIT
  ) invalid();
  assertHash(row.reportedItemSetFingerprint);
  return hash(REPORT_WITNESS_DOMAIN, [
    row.projectId,
    row.childSessionId,
    row.eventPosition.toString(),
    row.streamVersion.toString(),
    row.reportedReportId,
    row.reportedItemCount,
    row.reportedItemSetFingerprint,
  ]);
}

export function reportIndexGenesisFingerprint(
  projectId: string,
  childSessionId: string,
): string {
  if (projectId.length === 0 || childSessionId.length === 0) invalid();
  return hash(REPORT_INDEX_DOMAIN, [
    projectId,
    childSessionId,
    0,
    null,
    null,
    null,
  ]);
}

export function advanceReportIndexFingerprint(input: {
  readonly projectId: string;
  readonly childSessionId: string;
  readonly reportCount: number;
  readonly latestReportId: string;
  readonly previousReportIndexFingerprint: string;
  readonly reportWitnessFingerprint: string;
}): string {
  if (
    !Number.isSafeInteger(input.reportCount)
    || input.reportCount < 1
    || input.reportCount > CHILD_REPORT_LIMIT
    || input.latestReportId.length === 0
  ) invalid();
  assertHash(input.previousReportIndexFingerprint);
  assertHash(input.reportWitnessFingerprint);
  return hash(REPORT_INDEX_DOMAIN, [
    input.projectId,
    input.childSessionId,
    input.reportCount,
    input.latestReportId,
    input.previousReportIndexFingerprint,
    input.reportWitnessFingerprint,
  ]);
}

export function childEventFoldFingerprint(
  row: Omit<ChildEventFoldProjection, "fingerprint">,
): string {
  assertPositiveInt64(row.eventPosition);
  assertPositiveInt64(row.streamVersion);
  assertHash(row.authorityCommitment);
  assertHash(row.reportIndexFingerprint);
  if (row.previousFingerprint !== null) assertHash(row.previousFingerprint);
  if (row.reportedItemSetFingerprint !== null) {
    assertHash(row.reportedItemSetFingerprint);
  }
  return hash(CHILD_EVENT_FOLD_DOMAIN, [
    row.projectId,
    row.childSessionId,
    row.eventPosition.toString(),
    row.streamVersion.toString(),
    row.rootSessionId,
    row.childState,
    row.latestCheckpointId,
    row.latestCheckpointEventPosition?.toString() ?? null,
    row.authorityCommitment,
    row.terminalEventType,
    row.terminalEventPosition?.toString() ?? null,
    row.reportCount,
    row.latestReportId,
    row.reportIndexFingerprint,
    row.completionReportId,
    row.reportedReportId,
    row.reportedItemCount,
    row.reportedItemSetFingerprint,
    row.previousFingerprint,
  ]);
}

export function workflowGenerationFingerprint(
  row: Omit<WorkflowGenerationFoldProjection, "fingerprint">,
): string {
  assertPositiveInt64(row.triggerEventPosition);
  assertPositiveInt64(row.effectiveDraftSourceEventPosition);
  if (
    !Number.isSafeInteger(row.workflowGeneration)
    || row.workflowGeneration <= 0
    || row.effectiveDraftSourceEventPosition > row.triggerEventPosition
  ) invalid();
  if (row.previousFingerprint !== null) assertHash(row.previousFingerprint);
  return hash(WORKFLOW_GENERATION_DOMAIN, [
    row.projectId,
    row.workflowId,
    row.workflowGeneration.toString(),
    row.sessionId,
    row.triggerEventPosition.toString(),
    row.rootCommandId,
    row.evidenceWindowState,
    row.replacementCheckpointVersion,
    row.effectiveCheckpointVersion,
    row.effectiveDraftSourceEventPosition.toString(),
    row.previousFingerprint,
  ]);
}

/** The schema-4 workflow fold fingerprint. Its preimage is deliberately
 * independent of the V1 projection shape, which remains frozen. */
export function workflowFingerprintV2(input: WorkflowFingerprintV2Input): string {
  assertPositiveInt64(input.triggerEventPosition);
  assertPositiveInt64(input.effectiveDraftSourceEventPosition);
  assertHash(input.triggerEventHash);
  if (
    input.projectId.length === 0
    || input.workflowId.length === 0
    || input.sessionId.length === 0
    || input.rootCommandId.length === 0
    || !Number.isSafeInteger(input.workflowGeneration)
    || input.workflowGeneration <= 0
    || input.effectiveDraftSourceEventPosition > input.triggerEventPosition
    || (input.evidenceWindowState !== "open" && input.evidenceWindowState !== "sealed")
    || (input.replacementCheckpointVersion !== null
      && input.replacementCheckpointVersion !== 1
      && input.replacementCheckpointVersion !== 2)
    || (input.effectiveCheckpointVersion !== 1 && input.effectiveCheckpointVersion !== 2)
    || (input.evidenceWindowState === "open" && input.effectiveCheckpointVersion !== 2)
    || (input.replacementCheckpointVersion !== null
      && (input.replacementCheckpointVersion !== input.effectiveCheckpointVersion
        || input.effectiveDraftSourceEventPosition !== input.triggerEventPosition))
    || (input.effectiveStateSourceEventPosition === null)
      !== (input.effectiveStateVersion === null)
    || (input.effectiveStateSourceEventPosition === null)
      !== (input.effectiveStateHash === null)
    || (input.effectiveStateSourceEventPosition !== null
      && (input.effectiveStateSourceEventPosition > input.triggerEventPosition
        || input.effectiveStateVersion !== 1))
    || (input.effectiveStateHash !== null && !LOWER_HASH.test(input.effectiveStateHash))
    || (input.previousFingerprintSchemaVersion === null)
      !== (input.previousFingerprint === null)
    || (input.previousFingerprintSchemaVersion !== null
      && input.previousFingerprintSchemaVersion !== 1
      && input.previousFingerprintSchemaVersion !== 2)
  ) invalid();
  if (input.previousFingerprint !== null) assertHash(input.previousFingerprint);
  return hash(WORKFLOW_GENERATION_V2_DOMAIN, [
    input.projectId,
    input.workflowId,
    input.workflowGeneration.toString(),
    input.sessionId,
    input.triggerEventPosition.toString(),
    input.triggerEventHash,
    input.rootCommandId,
    input.evidenceWindowState,
    input.replacementCheckpointVersion,
    input.effectiveCheckpointVersion,
    input.effectiveDraftSourceEventPosition.toString(),
    input.effectiveStateSourceEventPosition?.toString() ?? null,
    input.effectiveStateVersion,
    input.effectiveStateHash,
    input.previousFingerprintSchemaVersion,
    input.previousFingerprint,
  ]);
}

function decodeStoredEvent(
  event: StoredEvent,
  authorityCommitment: string,
): LifecycleEventCodecResult {
  if (
    event.streamType !== "session"
    || event.sessionId === null
  ) invalid();
  assertPositiveInt64(event.globalPosition);
  assertPositiveInt64(event.streamVersion);
  try {
    return decodeLifecycleEvent({
      eventSchemaVersion: event.eventSchemaVersion,
      eventId: event.eventId,
      projectId: event.projectId,
      vaultId: event.vaultId,
      storeId: event.storeId,
      workspaceId: event.workspaceId,
      streamId: event.streamId,
      streamVersion: event.streamVersion.toString(),
      globalPosition: event.globalPosition.toString(),
      sessionId: event.sessionId,
      parentSessionId: event.parentSessionId,
      eventType: event.eventType,
      correlationId: event.correlationId,
      causationId: event.causationId,
      commandId: event.commandId,
      idempotencyKey: event.idempotencyKey,
      occurredAt: event.occurredAt,
      authorityCommitment,
      payload: event.payload,
    });
  } catch {
    return invalid();
  }
}

function eventAuthority(
  event: StoredEvent,
  previous: ChildEventFoldProjection | null,
): string {
  const payload = record(event.payload);
  const candidate = typeof payload.authorityCommitment === "string"
    ? payload.authorityCommitment
    : previous?.authorityCommitment;
  if (candidate === undefined) return invalid();
  assertHash(candidate);
  return candidate;
}

function childStates(
  ...states: readonly ChildSessionState[]
): ReadonlySet<ChildSessionState> {
  return new Set(states);
}

const ALLOWED_CHILD_STATES: Readonly<Record<
  string,
  ReadonlySet<ChildSessionState>
>> = Object.freeze({
  SessionCheckpointRecorded: childStates("active", "completion-proposed", "suspended"),
  EvidenceCoverageRecorded: childStates("active", "completion-proposed", "suspended"),
  ChildAssignmentAmended: childStates("active", "completion-proposed", "suspended"),
  ChildWorkReported: childStates("active", "completion-proposed", "suspended"),
  ChildWorkDispositioned: childStates("active", "completion-proposed"),
  ChildCompletionProposed: childStates("active"),
  ChildSessionCompleted: childStates("active", "completion-proposed"),
  ChildSessionSuspended: childStates("active", "completion-proposed"),
  ChildWorkTransferCreated: childStates("suspended"),
  ChildWorkTransferClaimed: childStates("active"),
});

function exactReportWitness(
  witness: ChildEventFoldProjection | null,
  event: StoredEvent,
  reportId: string,
): ChildEventFoldProjection {
  if (
    witness === null
    || witness.projectId !== event.projectId
    || witness.childSessionId !== event.sessionId
    || witness.reportedReportId !== reportId
    || witness.reportedItemCount === null
    || witness.reportedItemSetFingerprint === null
    || witness.eventPosition >= event.globalPosition
    || witness.streamVersion >= event.streamVersion
    || witness.fingerprint !== childEventFoldFingerprint(
      withoutChildFingerprint(witness),
    )
  ) invalid();
  return witness;
}

function finishChild(
  row: Omit<ChildEventFoldProjection, "fingerprint">,
): ChildEventFoldProjection {
  return Object.freeze({
    ...row,
    fingerprint: childEventFoldFingerprint(row),
  });
}

export function foldChildEventProjection(
  previous: ChildEventFoldProjection | null,
  event: StoredEvent,
  reportWitness: ChildEventFoldProjection | null,
): ChildEventFoldProjection {
  const authorityCommitment = eventAuthority(event, previous);
  const decoded = decodeStoredEvent(event, authorityCommitment);
  if (
    decoded.parentSessionId === null
    || decoded.sessionId !== event.sessionId
    || decoded.streamId !== `session/${decoded.sessionId}`
  ) invalid();

  if (decoded.eventType === "SessionForked") {
    if (
      previous !== null
      || reportWitness !== null
      || event.streamVersion !== 1n
      || decoded.payload.parentSessionId !== decoded.parentSessionId
    ) invalid();
    return finishChild({
      projectId: decoded.projectId,
      childSessionId: decoded.sessionId,
      eventPosition: event.globalPosition,
      streamVersion: event.streamVersion,
      rootSessionId: decoded.parentSessionId,
      childState: "active",
      latestCheckpointId: null,
      latestCheckpointEventPosition: null,
      authorityCommitment,
      terminalEventType: null,
      terminalEventPosition: null,
      reportCount: 0,
      latestReportId: null,
      reportIndexFingerprint: reportIndexGenesisFingerprint(
        decoded.projectId,
        decoded.sessionId,
      ),
      completionReportId: null,
      reportedReportId: null,
      reportedItemCount: null,
      reportedItemSetFingerprint: null,
      previousFingerprint: null,
    });
  }

  if (
    previous === null
    || previous.projectId !== decoded.projectId
    || previous.childSessionId !== decoded.sessionId
    || previous.rootSessionId !== decoded.parentSessionId
    || event.streamVersion !== previous.streamVersion + 1n
    || event.globalPosition <= previous.eventPosition
    || previous.fingerprint !== childEventFoldFingerprint(
      withoutChildFingerprint(previous),
    )
  ) invalid();
  const allowed = ALLOWED_CHILD_STATES[decoded.eventType];
  if (allowed === undefined || !allowed.has(previous.childState)) invalid();

  let childState = previous.childState;
  let latestCheckpointId = previous.latestCheckpointId;
  let latestCheckpointEventPosition = previous.latestCheckpointEventPosition;
  let terminalEventType = previous.terminalEventType;
  let terminalEventPosition = previous.terminalEventPosition;
  let reportCount = previous.reportCount;
  let latestReportId = previous.latestReportId;
  let reportIndexFingerprint = previous.reportIndexFingerprint;
  let completionReportId = previous.completionReportId;
  let reportedReportId: string | null = null;
  let reportedItemCount: number | null = null;
  let reportedItemSetFingerprint: string | null = null;

  switch (decoded.eventType) {
    case "ChildWorkReported": {
      if (reportWitness !== null || reportCount >= CHILD_REPORT_LIMIT) invalid();
      const report = decoded.payload.report;
      if (
        report.reportId === latestReportId
        || report.childSessionId !== decoded.sessionId
        || report.parentSessionId !== decoded.parentSessionId
      ) invalid();
      reportedReportId = report.reportId;
      reportedItemCount = report.allReportItemIds.length;
      reportedItemSetFingerprint = reportItemSetFingerprint({
        projectId: decoded.projectId,
        childSessionId: decoded.sessionId,
        reportId: report.reportId,
        allReportItemIds: report.allReportItemIds,
      });
      reportCount += 1;
      latestReportId = report.reportId;
      const witnessFingerprint = reportWitnessFingerprint({
        projectId: decoded.projectId,
        childSessionId: decoded.sessionId,
        eventPosition: event.globalPosition,
        streamVersion: event.streamVersion,
        reportedReportId,
        reportedItemCount,
        reportedItemSetFingerprint,
      });
      reportIndexFingerprint = advanceReportIndexFingerprint({
        projectId: decoded.projectId,
        childSessionId: decoded.sessionId,
        reportCount,
        latestReportId,
        previousReportIndexFingerprint: previous.reportIndexFingerprint,
        reportWitnessFingerprint: witnessFingerprint,
      });
      break;
    }
    case "ChildCompletionProposed": {
      const witness = exactReportWitness(
        reportWitness,
        event,
        decoded.payload.reportId,
      );
      if (witness.reportedReportId === null) invalid();
      childState = "completion-proposed";
      completionReportId = witness.reportedReportId;
      break;
    }
    case "ChildWorkDispositioned": {
      const witness = exactReportWitness(
        reportWitness,
        event,
        decoded.payload.disposition.reportId,
      );
      const dispositionSet = reportItemSetFingerprint({
        projectId: decoded.projectId,
        childSessionId: decoded.sessionId,
        reportId: decoded.payload.disposition.reportId,
        allReportItemIds: decoded.payload.disposition.allReportItemIds,
      });
      if (
        dispositionSet !== witness.reportedItemSetFingerprint
        || decoded.payload.disposition.allReportItemIds.length
          !== witness.reportedItemCount
      ) invalid();
      if (
        previous.childState === "completion-proposed"
        && decoded.payload.disposition.kind !== "accepted"
        && decoded.payload.disposition.reportId === previous.completionReportId
      ) {
        childState = "active";
        completionReportId = null;
      }
      break;
    }
    case "ChildSessionCompleted": {
      exactReportWitness(reportWitness, event, decoded.payload.reportId);
      if (
        previous.childState === "completion-proposed"
        && previous.completionReportId !== decoded.payload.reportId
      ) invalid();
      childState = "completed";
      terminalEventType = "ChildSessionCompleted";
      terminalEventPosition = event.globalPosition;
      break;
    }
    case "ChildSessionSuspended":
      if (
        previous.latestCheckpointId === null
        || decoded.payload.checkpointId !== previous.latestCheckpointId
        || reportWitness !== null
      ) invalid();
      childState = "suspended";
      break;
    case "ChildWorkTransferCreated":
      if (
        previous.latestCheckpointId === null
        || decoded.payload.checkpointId !== previous.latestCheckpointId
        || reportWitness !== null
      ) invalid();
      childState = "transferred";
      terminalEventType = "ChildWorkTransferCreated";
      terminalEventPosition = event.globalPosition;
      break;
    case "SessionCheckpointRecorded":
      if (reportWitness !== null) invalid();
      latestCheckpointId = decoded.payload.checkpoint.checkpointId;
      latestCheckpointEventPosition = event.globalPosition;
      break;
    case "EvidenceCoverageRecorded":
    case "ChildAssignmentAmended":
    case "ChildWorkTransferClaimed":
      if (reportWitness !== null) invalid();
      break;
    default:
      return invalid();
  }

  return finishChild({
    projectId: previous.projectId,
    childSessionId: previous.childSessionId,
    eventPosition: event.globalPosition,
    streamVersion: event.streamVersion,
    rootSessionId: previous.rootSessionId,
    childState,
    latestCheckpointId,
    latestCheckpointEventPosition,
    authorityCommitment,
    terminalEventType,
    terminalEventPosition,
    reportCount,
    latestReportId,
    reportIndexFingerprint,
    completionReportId,
    reportedReportId,
    reportedItemCount,
    reportedItemSetFingerprint,
    previousFingerprint: previous.fingerprint,
  });
}

function finishWorkflow(
  row: Omit<WorkflowGenerationFoldProjection, "fingerprint">,
  triggerEventHash: string | null,
  previousFingerprintSchemaVersion: 1 | 2 | null,
): WorkflowGenerationFoldProjection {
  const fingerprint = row.fingerprintSchemaVersion === 1
    ? workflowGenerationFingerprint(row)
    : triggerEventHash === null
      ? invalid()
      : workflowFingerprintV2({
          ...row,
          triggerEventHash,
          previousFingerprintSchemaVersion,
        });
  return Object.freeze({
    ...row,
    fingerprint,
  });
}

function workflowIntentCommand(
  trigger: StoredEvent,
  intent: LifecycleIntentWitnessV1,
): Readonly<Record<string, unknown>> {
  const binding = intent.intent.binding;
  const authorization = intent.intent.authorization;
  const command = record(intent.intent.command);
  if (
    trigger.sessionId === null
    || trigger.parentSessionId !== null
    || trigger.streamType !== "session"
    || trigger.streamId !== `session/${trigger.sessionId}`
    || trigger.projectId !== binding.projectId
    || trigger.vaultId !== binding.vaultId
    || trigger.storeId !== binding.storeId
    || trigger.workspaceId !== binding.workspaceId
    || authorization.authorizationSessionId !== trigger.sessionId
    || authorization.targetSessionId !== trigger.sessionId
    || command.commandId !== trigger.commandId
  ) invalid();
  return command;
}

export function foldWorkflowGenerationProjection(
  previous: WorkflowGenerationFoldProjection | null,
  trigger: StoredEvent,
  intent: LifecycleIntentWitnessV1,
  compatibilityMode: "live-schema-3" | "schema-2-preflight",
): WorkflowGenerationFoldProjection {
  const payloadRecord = record(trigger.payload);
  const authorityCommitment = typeof payloadRecord.authorityCommitment === "string"
    ? payloadRecord.authorityCommitment
    : "0".repeat(64);
  const event = decodeStoredEvent(trigger, authorityCommitment);
  const command = workflowIntentCommand(trigger, intent);
  if (event.parentSessionId !== null) invalid();

  let workflowId: string;
  let workflowGeneration: number;
  let evidenceWindowState: "open" | "sealed";
  let replacementCheckpointVersion: 1 | 2 | null;
  let effectiveCheckpointVersion: 1 | 2;
  let effectiveDraftSourceEventPosition: bigint;
  let previousFingerprint = previous?.fingerprint ?? null;
  const previousFingerprintSchemaVersion = previous?.fingerprintSchemaVersion ?? null;
  const fingerprintSchemaVersion = event.eventSchemaVersion === 3 ? 2 : 1;
  let effectiveStateSourceEventPosition: bigint | null = null;
  let effectiveStateVersion: 1 | null = null;
  let effectiveStateHash: string | null = null;

  switch (event.eventType) {
    case "SessionEndRequested": {
      if (command.commandType !== "request-session-end") invalid();
      const request = record(command.request);
      if (request.sessionId !== event.sessionId) invalid();
      if (event.eventSchemaVersion !== 3 && (
        request.childEndPolicy !== event.payload.childEndPolicy
        || request.requestedQualityThreshold !== event.payload.qualityThreshold
        || request.requireFullEvidence !== event.payload.requireFullEvidence
        || request.requireMaterialization !== event.payload.requireMaterialization
      )) invalid();
      const version = checkpointVersion(request.finalCheckpoint);
      if (event.eventSchemaVersion === 3) {
        if (
          canonicalJson(request) !== canonicalJson(event.payload.effectiveState.request)
          || request.requestVersion !== event.payload.effectiveState.request.requestVersion
        ) invalid();
        effectiveStateSourceEventPosition = trigger.globalPosition;
        effectiveStateVersion = event.payload.effectiveState.effectiveStateVersion;
        effectiveStateHash = event.payload.effectiveState.effectiveStateHash;
      } else if (
        (event.eventSchemaVersion === 1 && request.requestVersion !== 1)
        || (event.eventSchemaVersion === 2 && request.requestVersion !== 2)
      ) invalid();
      workflowId = event.payload.workflowId;
      workflowGeneration = event.payload.workflowGeneration;
      if (
        previous === null
          ? workflowGeneration !== 1
          : (
              workflowId !== previous.workflowId
              || event.sessionId !== previous.sessionId
              || workflowGeneration !== previous.workflowGeneration + 1
            )
      ) invalid();
      replacementCheckpointVersion = version;
      effectiveCheckpointVersion = version;
      effectiveDraftSourceEventPosition = trigger.globalPosition;
      evidenceWindowState = version === 2 ? "open" : "sealed";
      break;
    }
    case "SessionEndAmended": {
      if (previous === null || command.commandType !== "amend-session-end") {
        return invalid();
      }
      const amendment = record(command.amendment);
      if (
        command.sessionId !== event.sessionId
        || command.workflowId !== event.payload.workflowId
        || event.payload.workflowId !== previous.workflowId
        || event.sessionId !== previous.sessionId
        || event.payload.previousWorkflowGeneration !== previous.workflowGeneration
        || event.payload.workflowGeneration !== previous.workflowGeneration + 1
      ) invalid();
      workflowId = event.payload.workflowId;
      workflowGeneration = event.payload.workflowGeneration;
      const draft = amendment.finalCheckpoint;
      replacementCheckpointVersion = draft === null
        ? null
        : checkpointVersion(draft);
      if (event.eventSchemaVersion === 1) {
        if (
          amendment.amendmentVersion !== 1
          || ("amendmentVersion" in event.payload)
        ) invalid();
        evidenceWindowState = previous.evidenceWindowState;
      } else {
        if (
          (event.eventSchemaVersion === 2 && (
            amendment.amendmentVersion !== 2
            || amendment.evidenceWindowAction !== event.payload.evidenceWindowAction
            || event.payload.finalCheckpointVersion !== replacementCheckpointVersion
          ))
          || (event.eventSchemaVersion === 3 && (
            amendment.amendmentVersion !== 2
            || amendment.evidenceWindowAction !== event.payload.evidenceWindowAction
            || event.payload.effectiveState.request.sessionId !== event.sessionId
            || event.payload.effectiveState.request.requestVersion
              !== event.payload.effectiveState.effectiveFinalCheckpoint.checkpointVersion
            || (amendment.childEndPolicy !== null
              && amendment.childEndPolicy !== event.payload.effectiveState.request.childEndPolicy)
            || (amendment.finalCheckpoint !== null
              && canonicalJson(amendment.finalCheckpoint)
                !== canonicalJson(event.payload.effectiveState.request.finalCheckpoint))
            || (amendment.validationProfileIds !== null
              && canonicalJson(amendment.validationProfileIds)
                !== canonicalJson(event.payload.effectiveState.request.validationProfileIds))
            || (amendment.requestedQualityThreshold !== null
              && amendment.requestedQualityThreshold
                !== event.payload.effectiveState.request.requestedQualityThreshold)
            || (amendment.requireFullEvidence !== null
              && amendment.requireFullEvidence
                !== event.payload.effectiveState.request.requireFullEvidence)
            || (amendment.requireMaterialization !== null
              && amendment.requireMaterialization
                !== event.payload.effectiveState.request.requireMaterialization)
          ))
        ) invalid();
        if (
          event.payload.evidenceWindowAction === "open"
          && (
            previous.evidenceWindowState !== "sealed"
            || replacementCheckpointVersion !== 2
          )
        ) invalid();
        if (
          event.payload.evidenceWindowAction === "seal"
          && previous.evidenceWindowState !== "open"
        ) invalid();
        evidenceWindowState = event.payload.evidenceWindowAction === "open"
          ? "open"
          : event.payload.evidenceWindowAction === "seal"
            ? "sealed"
            : previous.evidenceWindowState;
      }
      if (event.eventSchemaVersion === 3) {
        effectiveStateSourceEventPosition = trigger.globalPosition;
        effectiveStateVersion = event.payload.effectiveState.effectiveStateVersion;
        effectiveStateHash = event.payload.effectiveState.effectiveStateHash;
      } else {
        effectiveStateSourceEventPosition = previous.effectiveStateSourceEventPosition;
        effectiveStateVersion = previous.effectiveStateVersion;
        effectiveStateHash = previous.effectiveStateHash;
      }
      effectiveCheckpointVersion = replacementCheckpointVersion
        ?? previous.effectiveCheckpointVersion;
      effectiveDraftSourceEventPosition = replacementCheckpointVersion === null
        ? previous.effectiveDraftSourceEventPosition
        : trigger.globalPosition;
      break;
    }
    case "SessionEndCancelled": {
      if (
        previous === null
        || command.commandType !== "cancel-session-end"
        || command.sessionId !== event.sessionId
        || command.workflowId !== event.payload.workflowId
        || command.preTransitionCheckpointId
          !== event.payload.preTransitionCheckpointId
        || event.payload.workflowId !== previous.workflowId
        || event.sessionId !== previous.sessionId
      ) invalid();
      workflowId = event.payload.workflowId;
      workflowGeneration = event.payload.workflowGeneration;
      const sameGeneration = workflowGeneration === previous.workflowGeneration;
      if (
        compatibilityMode === "live-schema-3"
          ? workflowGeneration !== previous.workflowGeneration + 1
          : (
              !sameGeneration
              && workflowGeneration !== previous.workflowGeneration + 1
            )
      ) invalid();
      if (sameGeneration) previousFingerprint = previous.previousFingerprint;
      replacementCheckpointVersion = null;
      effectiveCheckpointVersion = previous.effectiveCheckpointVersion;
      effectiveDraftSourceEventPosition =
        previous.effectiveDraftSourceEventPosition;
      evidenceWindowState = "sealed";
      effectiveStateSourceEventPosition = previous.effectiveStateSourceEventPosition;
      effectiveStateVersion = previous.effectiveStateVersion;
      effectiveStateHash = previous.effectiveStateHash;
      break;
    }
    case "SessionAbandoned": {
      if (
        previous === null
        || command.commandType !== "abandon-session"
        || command.sessionId !== event.sessionId
        || command.preTransitionCheckpointId
          !== event.payload.preTransitionCheckpointId
        || command.reasonCode !== event.payload.reasonCode
        || event.payload.workflowId === null
        || event.payload.workflowGeneration === null
        || event.payload.workflowId !== previous.workflowId
        || event.sessionId !== previous.sessionId
      ) invalid();
      workflowId = event.payload.workflowId;
      workflowGeneration = event.payload.workflowGeneration;
      const sameGeneration = workflowGeneration === previous.workflowGeneration;
      if (
        compatibilityMode === "live-schema-3"
          ? workflowGeneration !== previous.workflowGeneration + 1
          : (
              !sameGeneration
              && workflowGeneration !== previous.workflowGeneration + 1
            )
      ) invalid();
      if (sameGeneration) previousFingerprint = previous.previousFingerprint;
      replacementCheckpointVersion = null;
      effectiveCheckpointVersion = previous.effectiveCheckpointVersion;
      effectiveDraftSourceEventPosition =
        previous.effectiveDraftSourceEventPosition;
      evidenceWindowState = "sealed";
      effectiveStateSourceEventPosition = previous.effectiveStateSourceEventPosition;
      effectiveStateVersion = previous.effectiveStateVersion;
      effectiveStateHash = previous.effectiveStateHash;
      break;
    }
    default:
      return invalid();
  }

  if (
    previous !== null
    && (
      previous.projectId !== event.projectId
      || trigger.globalPosition <= previous.triggerEventPosition
      || (previous.fingerprintSchemaVersion === 1
        ? previous.fingerprint !== workflowGenerationFingerprint(withoutWorkflowFingerprint(previous))
        : previous.fingerprintSchemaVersion !== 2)
    )
  ) invalid();
  if (
    evidenceWindowState === "open"
    && effectiveCheckpointVersion !== 2
  ) invalid();
  if (
    replacementCheckpointVersion !== null
    && (
      replacementCheckpointVersion !== effectiveCheckpointVersion
      || effectiveDraftSourceEventPosition !== trigger.globalPosition
    )
  ) invalid();

  return finishWorkflow({
    projectId: event.projectId,
    workflowId,
    workflowGeneration,
    sessionId: event.sessionId,
    triggerEventPosition: trigger.globalPosition,
    rootCommandId: trigger.commandId,
    evidenceWindowState,
    replacementCheckpointVersion,
    effectiveCheckpointVersion,
    effectiveDraftSourceEventPosition,
    fingerprintSchemaVersion,
    effectiveStateSourceEventPosition,
    effectiveStateVersion,
    effectiveStateHash,
    previousFingerprint,
  }, fingerprintSchemaVersion === 2 ? trigger.eventHash : null, previousFingerprintSchemaVersion);
}
