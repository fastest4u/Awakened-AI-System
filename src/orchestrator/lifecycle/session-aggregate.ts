import type {
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../identity/contracts.js";
import type {
  LifecycleAssignmentV1,
  LifecycleEvent as LegacyLifecycleEvent,
  LifecycleEventType,
  LifecycleEventV3,
} from "./contracts/events.js";
import type { SessionEndEffectiveStateV1 } from "./session-end-effective-state.js";

type LifecycleEvent = LegacyLifecycleEvent | LifecycleEventV3;
import type {
  CheckpointId,
  ChildSessionState,
  ReportId,
  ReportItemId,
  RootSessionState,
  SessionId,
  TransferTicketId,
  WorkflowId,
} from "./contracts/identifiers.js";
import { LifecycleError } from "./errors.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;
const LOWER_HASH = /^[0-9a-f]{64}$/;
const CANONICAL_REPORT_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHILD_REPORT_LIMIT_V1 = 200;
const VERSION_2_EVENT_TYPES = new Set<LifecycleEventType>([
  "EvidenceCoverageRecorded",
  "SessionCheckpointRecorded",
  "SessionEndRequested",
  "SessionEndAmended",
  "ChildWorkTransferCreated",
]);
const VERSION_3_EVENT_TYPES = new Set<LifecycleEventType>([
  "SessionEndRequested",
  "SessionEndAmended",
  "SessionEndCancelled",
  "SessionCheckpointRecorded",
]);

function rootStates(...states: RootSessionState[]): readonly RootSessionState[] {
  return Object.freeze(states);
}

function childStates(...states: ChildSessionState[]): readonly ChildSessionState[] {
  return Object.freeze(states);
}

type SessionTransitionTable<State extends string> = Readonly<
  Record<LifecycleEventType, readonly State[]>
>;

const ROOT_TRANSITIONS = Object.freeze({
  SessionStarted: rootStates(),
  SessionOwnerTransferred: rootStates("active", "suspended"),
  SessionOwnershipRecovered: rootStates("active", "suspended", "ending"),
  SessionSuspendRequested: rootStates("active"),
  SessionSuspended: rootStates("active"),
  SessionResumed: rootStates("suspended"),
  SessionCheckpointRecorded: rootStates("active", "suspended", "ending"),
  EvidenceCoverageRecorded: rootStates("active", "suspended", "ending"),
  SessionForked: rootStates(),
  ChildAssignmentAmended: rootStates(),
  ChildWorkReported: rootStates(),
  ChildWorkDispositioned: rootStates(),
  ChildCompletionProposed: rootStates(),
  ChildSessionCompleted: rootStates(),
  ChildSessionSuspended: rootStates(),
  ChildWorkTransferCreated: rootStates(),
  ChildWorkTransferClaimed: rootStates(),
  SessionEndRequested: rootStates("active", "suspended"),
  SessionEndAmended: rootStates("ending"),
  SessionValidationResultRecorded: rootStates("ending"),
  SessionEndVerificationPassed: rootStates("ending"),
  SessionEndVerificationFailed: rootStates("ending"),
  SessionEndVerificationInvalidated: rootStates("ending"),
  SessionEndCancelled: rootStates("ending"),
  SessionAbandoned: rootStates("active", "suspended", "ending"),
  SessionEnded: rootStates("ending"),
}) satisfies SessionTransitionTable<RootSessionState>;

const CHILD_TRANSITIONS = Object.freeze({
  SessionStarted: childStates(),
  SessionOwnerTransferred: childStates(),
  SessionOwnershipRecovered: childStates(),
  SessionSuspendRequested: childStates(),
  SessionSuspended: childStates(),
  SessionResumed: childStates(),
  SessionCheckpointRecorded: childStates("active", "completion-proposed", "suspended"),
  EvidenceCoverageRecorded: childStates("active", "completion-proposed", "suspended"),
  SessionForked: childStates(),
  ChildAssignmentAmended: childStates("active", "completion-proposed", "suspended"),
  ChildWorkReported: childStates("active", "completion-proposed", "suspended"),
  ChildWorkDispositioned: childStates("active", "completion-proposed"),
  ChildCompletionProposed: childStates("active"),
  ChildSessionCompleted: childStates("active", "completion-proposed"),
  ChildSessionSuspended: childStates("active", "completion-proposed"),
  ChildWorkTransferCreated: childStates("suspended"),
  ChildWorkTransferClaimed: childStates("active"),
  SessionEndRequested: childStates(),
  SessionEndAmended: childStates(),
  SessionValidationResultRecorded: childStates(),
  SessionEndVerificationPassed: childStates(),
  SessionEndVerificationFailed: childStates(),
  SessionEndVerificationInvalidated: childStates(),
  SessionEndCancelled: childStates(),
  SessionAbandoned: childStates(),
  SessionEnded: childStates(),
}) satisfies SessionTransitionTable<ChildSessionState>;

const AUTHORITY_MUTATING_EVENTS = new Set<LifecycleEventType>([
  "SessionStarted",
  "SessionOwnerTransferred",
  "SessionOwnershipRecovered",
  "SessionSuspended",
  "SessionForked",
  "ChildSessionCompleted",
  "ChildSessionSuspended",
  "ChildWorkTransferCreated",
  "SessionAbandoned",
  "SessionEnded",
]);

export type TerminalLifecycleEventType =
  | "SessionAbandoned"
  | "SessionEnded"
  | "ChildSessionCompleted"
  | "ChildWorkTransferCreated";

export type EndVerificationState = "none" | "pending" | "passed" | "locked";

interface AggregateBase {
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly streamId: string;
  readonly streamVersion: bigint;
  readonly eventPosition: bigint;
  readonly sessionId: SessionId;
  readonly parentSessionId: SessionId | null;
  readonly correlationId: string;
  readonly authorityCommitment: string;
  readonly latestCheckpointId: CheckpointId | null;
  readonly latestCheckpointBaseEventPosition: bigint | null;
  readonly latestCheckpointEventPosition: bigint | null;
  readonly terminalEventPosition: bigint | null;
  readonly terminalEventType: TerminalLifecycleEventType | null;
}

export interface RootAggregateState extends AggregateBase {
  readonly kind: "root";
  readonly state: RootSessionState;
  readonly ownerGeneration: number;
  readonly childCapabilityGeneration: null;
  readonly suspendRequestedCheckpointId: CheckpointId | null;
  readonly endWorkflowId: WorkflowId | null;
  readonly endWorkflowGeneration: number | null;
  readonly endPreviousState: "active" | "suspended" | null;
  readonly endEffectiveState: SessionEndEffectiveStateV1 | null;
  readonly endEffectiveStateHash: string | null;
  readonly endVerificationState: EndVerificationState;
  readonly verificationPassedEventPosition: bigint | null;
}

export interface ChildAggregateState extends AggregateBase {
  readonly kind: "child";
  readonly state: ChildSessionState;
  readonly ownerGeneration: null;
  readonly childCapabilityGeneration: number | null;
  readonly childCapabilityRevoked: boolean;
  readonly directAccessEnabled: boolean;
  readonly rootOwnerGeneration: number;
  readonly assignment: LifecycleAssignmentV1;
  readonly assignmentRevision: number;
  readonly sourceTransferTicketId: TransferTicketId | null;
  readonly claimedTransferTicketId: TransferTicketId | null;
  readonly suspensionCheckpointId: CheckpointId | null;
  readonly latestReportId: ReportId | null;
  readonly reportCount: number;
  readonly reportIndexHead: ChildReportIndexNode | null;
  readonly completionReportId: ReportId | null;
}

export interface ChildReportIndexNode {
  readonly reportId: ReportId;
  readonly itemSignature: string;
  readonly previous: ChildReportIndexNode | null;
}

export type SessionAggregateState = RootAggregateState | ChildAggregateState;

export interface SessionAuthorityMirror {
  readonly sessionKind: "root" | "child";
  readonly parentSessionId: SessionId | null;
  readonly semanticState: RootSessionState | ChildSessionState;
  readonly ownerGeneration: bigint | null;
  readonly childCapabilityGeneration: bigint | null;
  readonly authorityCommitment: string;
  readonly latestCheckpointEventPosition: bigint | null;
  readonly terminalEventPosition: bigint | null;
}

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function stateConflict(): never {
  throw new LifecycleError("SESSION_STATE_CONFLICT");
}

function decimalPosition(value: unknown, allowZero: boolean): bigint {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL.test(value)) integrity();
  if (value.length > 19 || (value.length === 19 && value > SQLITE_INT64_MAX.toString())) integrity();
  const parsed = BigInt(value);
  if (parsed > SQLITE_INT64_MAX || (!allowZero && parsed === 0n)) integrity();
  return parsed;
}

function commitment(value: unknown): string {
  if (typeof value !== "string" || !LOWER_HASH.test(value)) integrity();
  return value;
}

function deterministicStreamId(sessionId: SessionId): string {
  return `session/${sessionId}`;
}

function payloadCommitment(event: LifecycleEvent): string | null {
  if (!("authorityCommitment" in event.payload)) return null;
  return commitment(event.payload.authorityCommitment);
}

function assertEnvelope(event: LifecycleEvent): { readonly streamVersion: bigint; readonly eventPosition: bigint } {
  if (
    event.eventSchemaVersion !== 1
    && event.eventSchemaVersion !== 2
    && event.eventSchemaVersion !== 3
  ) integrity();
  if (event.eventSchemaVersion === 2 && !VERSION_2_EVENT_TYPES.has(event.eventType)) integrity();
  if (event.eventSchemaVersion === 3 && !VERSION_3_EVENT_TYPES.has(event.eventType)) integrity();
  const streamVersion = decimalPosition(event.streamVersion, false);
  const eventPosition = decimalPosition(event.globalPosition, false);
  if (event.streamId !== deterministicStreamId(event.sessionId)) integrity();
  commitment(event.authorityCommitment);
  return Object.freeze({ streamVersion, eventPosition });
}

function assertInitialCommitment(event: LifecycleEvent): void {
  const embedded = payloadCommitment(event);
  if (embedded === null || embedded !== event.authorityCommitment) integrity();
}

function assertContinuationCommitment(state: SessionAggregateState, event: LifecycleEvent): void {
  const embedded = payloadCommitment(event);
  if (AUTHORITY_MUTATING_EVENTS.has(event.eventType)) {
    if (
      embedded === null
      || embedded !== event.authorityCommitment
      || event.authorityCommitment === state.authorityCommitment
    ) integrity();
    return;
  }
  if (embedded !== null || event.authorityCommitment !== state.authorityCommitment) integrity();
}

function freezeAssignment(assignment: LifecycleAssignmentV1): LifecycleAssignmentV1 {
  return Object.freeze({
    assignmentId: assignment.assignmentId,
    summary: assignment.summary,
    scope: assignment.scope,
  });
}

function initializeSession(event: LifecycleEvent): SessionAggregateState {
  const { streamVersion, eventPosition } = assertEnvelope(event);
  if (streamVersion !== 1n) integrity();
  assertInitialCommitment(event);

  const common = {
    projectId: event.projectId,
    vaultId: event.vaultId,
    storeId: event.storeId,
    workspaceId: event.workspaceId,
    streamId: event.streamId,
    streamVersion,
    eventPosition,
    sessionId: event.sessionId,
    parentSessionId: event.parentSessionId,
    correlationId: event.correlationId,
    authorityCommitment: event.authorityCommitment,
    latestCheckpointId: null,
    latestCheckpointBaseEventPosition: null,
    latestCheckpointEventPosition: null,
    terminalEventPosition: null,
    terminalEventType: null,
  } as const;

  if (event.eventType === "SessionStarted") {
    if (
      event.parentSessionId !== null
      || event.payload.sessionKind !== "root"
      || event.payload.ownerGeneration !== 1
    ) integrity();
    return Object.freeze({
      ...common,
      kind: "root",
      state: "active",
      ownerGeneration: 1,
      childCapabilityGeneration: null,
      suspendRequestedCheckpointId: null,
      endWorkflowId: null,
      endWorkflowGeneration: null,
      endPreviousState: null,
      endEffectiveState: null,
      endEffectiveStateHash: null,
      endVerificationState: "none",
      verificationPassedEventPosition: null,
    });
  }

  if (event.eventType === "SessionForked") {
    if (
      event.parentSessionId === null
      || event.parentSessionId === event.sessionId
      || event.payload.parentSessionId !== event.parentSessionId
      || event.payload.rootOwnerGeneration < 1
    ) integrity();
    return Object.freeze({
      ...common,
      kind: "child",
      state: "active",
      ownerGeneration: null,
      childCapabilityGeneration: event.payload.directAccessEnabled ? 1 : null,
      childCapabilityRevoked: false,
      directAccessEnabled: event.payload.directAccessEnabled,
      rootOwnerGeneration: event.payload.rootOwnerGeneration,
      assignment: freezeAssignment(event.payload.assignment),
      assignmentRevision: 1,
      sourceTransferTicketId: event.payload.sourceTransferTicketId,
      claimedTransferTicketId: null,
      suspensionCheckpointId: null,
      latestReportId: null,
      reportCount: 0,
      reportIndexHead: null,
      completionReportId: null,
    });
  }

  integrity();
}

function assertContinuationEnvelope(
  state: SessionAggregateState,
  event: LifecycleEvent,
): { readonly streamVersion: bigint; readonly eventPosition: bigint } {
  const positions = assertEnvelope(event);
  if (
    event.projectId !== state.projectId
    || event.vaultId !== state.vaultId
    || event.storeId !== state.storeId
    || event.workspaceId !== state.workspaceId
    || event.streamId !== state.streamId
    || event.sessionId !== state.sessionId
    || event.parentSessionId !== state.parentSessionId
    || event.correlationId !== state.correlationId
    || positions.streamVersion !== state.streamVersion + 1n
    || positions.eventPosition <= state.eventPosition
  ) integrity();
  return positions;
}

function isAllowedRootTransition(state: RootAggregateState, eventType: LifecycleEventType): boolean {
  return ROOT_TRANSITIONS[eventType].includes(state.state);
}

function isAllowedChildTransition(state: ChildAggregateState, eventType: LifecycleEventType): boolean {
  return CHILD_TRANSITIONS[eventType].includes(state.state);
}

function withRootEvent(
  state: RootAggregateState,
  event: LifecycleEvent,
  streamVersion: bigint,
  eventPosition: bigint,
  changes: Partial<RootAggregateState>,
): RootAggregateState {
  return Object.freeze({
    ...state,
    ...changes,
    streamVersion,
    eventPosition,
    authorityCommitment: event.authorityCommitment,
  });
}

function withChildEvent(
  state: ChildAggregateState,
  event: LifecycleEvent,
  streamVersion: bigint,
  eventPosition: bigint,
  changes: Partial<ChildAggregateState>,
): ChildAggregateState {
  return Object.freeze({
    ...state,
    ...changes,
    streamVersion,
    eventPosition,
    authorityCommitment: event.authorityCommitment,
  });
}

function checkpointChanges(
  state: SessionAggregateState,
  event: Extract<LifecycleEvent, { readonly eventType: "SessionCheckpointRecorded" }>,
  eventPosition: bigint,
): Pick<
  SessionAggregateState,
  "latestCheckpointId" | "latestCheckpointBaseEventPosition" | "latestCheckpointEventPosition"
> {
  const baseEventPosition = decimalPosition(event.payload.baseEventPosition, true);
  const checkpointEventPosition = decimalPosition(event.payload.checkpointEventPosition, false);
  const checkpoint = event.payload.checkpoint;
  if (
    checkpointEventPosition !== eventPosition
    || baseEventPosition < state.eventPosition
    || baseEventPosition >= checkpointEventPosition
    || checkpoint.sessionId !== state.sessionId
    || checkpoint.parentSessionId !== state.parentSessionId
    || checkpoint.baseEventPosition !== event.payload.baseEventPosition
    || checkpoint.checkpointEventPosition !== event.payload.checkpointEventPosition
    || checkpoint.sourceState.workspaceId !== state.workspaceId
    || (
      state.latestCheckpointBaseEventPosition !== null
      && baseEventPosition <= state.latestCheckpointBaseEventPosition
    )
    || (
      state.latestCheckpointEventPosition !== null
      && checkpointEventPosition <= state.latestCheckpointEventPosition
    )
  ) integrity();
  return Object.freeze({
    latestCheckpointId: checkpoint.checkpointId,
    latestCheckpointBaseEventPosition: baseEventPosition,
    latestCheckpointEventPosition: checkpointEventPosition,
  });
}

function assertWorkflow(
  state: RootAggregateState,
  workflowId: WorkflowId,
  workflowGeneration: number,
): void {
  if (
    state.endWorkflowId === null
    || state.endWorkflowGeneration === null
    || workflowId !== state.endWorkflowId
    || workflowGeneration !== state.endWorkflowGeneration
  ) integrity();
}

function assertTerminalWorkflow(
  state: RootAggregateState,
  workflowId: WorkflowId,
  workflowGeneration: number,
): void {
  const currentGeneration = state.endWorkflowGeneration;
  if (
    state.endWorkflowId === null
    || currentGeneration === null
    || workflowId !== state.endWorkflowId
    || !Number.isSafeInteger(currentGeneration)
    || currentGeneration < 1
    || !Number.isSafeInteger(workflowGeneration)
    || workflowGeneration < 1
    || (
      workflowGeneration !== currentGeneration
      && (
        currentGeneration === Number.MAX_SAFE_INTEGER
        || workflowGeneration !== currentGeneration + 1
      )
    )
  ) integrity();
}

function reportItemSignature(
  itemIds: readonly ReportItemId[],
): string {
  const sortedItemIds = [...itemIds].sort();
  for (let index = 0; index < sortedItemIds.length; index += 1) {
    const itemId = sortedItemIds[index];
    if (
      itemId === undefined
      || !CANONICAL_REPORT_ITEM_ID.test(itemId)
      || (index > 0 && itemId === sortedItemIds[index - 1])
    ) integrity();
  }
  return sortedItemIds.join("");
}

function reportItemSignatureFor(
  state: ChildAggregateState,
  reportId: ReportId,
): string | null {
  let node = state.reportIndexHead;
  while (node !== null) {
    if (node.reportId === reportId) return node.itemSignature;
    node = node.previous;
  }
  return null;
}

function evolveRoot(
  state: RootAggregateState,
  event: LifecycleEvent,
  streamVersion: bigint,
  eventPosition: bigint,
): RootAggregateState {
  if (!isAllowedRootTransition(state, event.eventType)) stateConflict();
  switch (event.eventType) {
    case "SessionOwnerTransferred":
      if (
        event.payload.previousOwnerGeneration !== state.ownerGeneration
        || event.payload.ownerGeneration !== state.ownerGeneration + 1
      ) integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        ownerGeneration: event.payload.ownerGeneration,
      });
    case "SessionOwnershipRecovered":
      if (
        event.payload.previousOwnerGeneration !== state.ownerGeneration
        || event.payload.ownerGeneration !== state.ownerGeneration + 1
      ) integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        ownerGeneration: event.payload.ownerGeneration,
      });
    case "SessionSuspendRequested":
      if (
        state.latestCheckpointId === null
        || event.payload.checkpointId !== state.latestCheckpointId
        || state.suspendRequestedCheckpointId !== null
      ) integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        suspendRequestedCheckpointId: event.payload.checkpointId,
      });
    case "SessionSuspended":
      if (
        state.suspendRequestedCheckpointId === null
        || state.suspendRequestedCheckpointId !== state.latestCheckpointId
      ) integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        state: "suspended",
        suspendRequestedCheckpointId: null,
      });
    case "SessionResumed":
      if (event.payload.ownerGeneration !== state.ownerGeneration) integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        state: "active",
        suspendRequestedCheckpointId: null,
      });
    case "SessionCheckpointRecorded":
      if (event.eventSchemaVersion === 3) {
        assertWorkflow(
          state,
          event.payload.workflowId,
          event.payload.workflowGeneration,
        );
      }
      return withRootEvent(
        state,
        event,
        streamVersion,
        eventPosition,
        {
          ...checkpointChanges(state, event, eventPosition),
          suspendRequestedCheckpointId: null,
        },
      );
    case "EvidenceCoverageRecorded":
      return withRootEvent(state, event, streamVersion, eventPosition, {});
    case "SessionEndRequested": {
      if (event.payload.previousState !== state.state) integrity();
      if (state.endWorkflowId === null) {
        if (event.payload.workflowGeneration !== 1) integrity();
      } else if (
        state.endWorkflowGeneration === null
        || event.payload.workflowId !== state.endWorkflowId
        || event.payload.workflowGeneration !== state.endWorkflowGeneration + 1
      ) integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        state: "ending",
        suspendRequestedCheckpointId: null,
        endWorkflowId: event.payload.workflowId,
        endWorkflowGeneration: event.payload.workflowGeneration,
        endPreviousState: event.payload.previousState,
        ...(event.eventSchemaVersion === 3
          ? {
              endEffectiveState: event.payload.effectiveState,
              endEffectiveStateHash: event.payload.effectiveState.effectiveStateHash,
            }
          : {
              endEffectiveState: null,
              endEffectiveStateHash: null,
            }),
        endVerificationState: "pending",
        verificationPassedEventPosition: null,
      });
    }
    case "SessionEndAmended":
      assertWorkflow(state, event.payload.workflowId, event.payload.previousWorkflowGeneration);
      if (event.payload.workflowGeneration !== event.payload.previousWorkflowGeneration + 1) integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        endWorkflowGeneration: event.payload.workflowGeneration,
        ...(event.eventSchemaVersion === 3
          ? {
              endEffectiveState: event.payload.effectiveState,
              endEffectiveStateHash: event.payload.effectiveState.effectiveStateHash,
            }
          : {}),
        endVerificationState: "pending",
        verificationPassedEventPosition: null,
      });
    case "SessionValidationResultRecorded":
      assertWorkflow(state, event.payload.workflowId, event.payload.workflowGeneration);
      if (
        event.payload.validationResult.projectId !== state.projectId
        || event.payload.validationResult.vaultId !== state.vaultId
        || event.payload.validationResult.storeId !== state.storeId
        || event.payload.validationResult.workspaceId !== state.workspaceId
        || event.payload.validationResult.sessionId !== state.sessionId
        || event.payload.validationResult.workflowId !== state.endWorkflowId
        || event.payload.validationResult.workflowGeneration !== state.endWorkflowGeneration
      ) integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {});
    case "SessionEndVerificationPassed":
      assertWorkflow(state, event.payload.workflowId, event.payload.workflowGeneration);
      if (state.endVerificationState !== "pending") integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        endVerificationState: "passed",
        verificationPassedEventPosition: eventPosition,
      });
    case "SessionEndVerificationFailed":
      assertWorkflow(state, event.payload.workflowId, event.payload.workflowGeneration);
      if (state.endVerificationState !== "pending") integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        endVerificationState: "locked",
        verificationPassedEventPosition: null,
      });
    case "SessionEndVerificationInvalidated": {
      assertWorkflow(state, event.payload.workflowId, event.payload.workflowGeneration);
      const previousVerificationPosition = decimalPosition(
        event.payload.previousVerificationEventPosition,
        false,
      );
      if (
        state.endVerificationState !== "passed"
        || state.verificationPassedEventPosition === null
        || previousVerificationPosition !== state.verificationPassedEventPosition
        || previousVerificationPosition >= eventPosition
      ) integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        endVerificationState: "locked",
        verificationPassedEventPosition: null,
      });
    }
    case "SessionEndCancelled":
      if (event.eventSchemaVersion === 3) {
        assertWorkflow(state, event.payload.workflowId, event.payload.previousWorkflowGeneration);
        if (event.payload.workflowGeneration !== event.payload.previousWorkflowGeneration + 1) integrity();
      } else {
        assertTerminalWorkflow(state, event.payload.workflowId, event.payload.workflowGeneration);
      }
      if (state.endPreviousState === null || event.payload.restoredState !== state.endPreviousState) integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        state: event.payload.restoredState,
        suspendRequestedCheckpointId: null,
        endWorkflowGeneration: event.payload.workflowGeneration,
        endVerificationState: "none",
        verificationPassedEventPosition: null,
      });
    case "SessionAbandoned":
      if (state.state === "ending") {
        if (event.payload.workflowId === null || event.payload.workflowGeneration === null) integrity();
        assertTerminalWorkflow(state, event.payload.workflowId, event.payload.workflowGeneration);
      } else if (event.payload.workflowId !== null || event.payload.workflowGeneration !== null) {
        integrity();
      }
      return withRootEvent(state, event, streamVersion, eventPosition, {
        state: "abandoned",
        suspendRequestedCheckpointId: null,
        ...(state.state === "ending"
          ? { endWorkflowGeneration: event.payload.workflowGeneration }
          : {}),
        endVerificationState: "none",
        verificationPassedEventPosition: null,
        terminalEventPosition: eventPosition,
        terminalEventType: "SessionAbandoned",
      });
    case "SessionEnded": {
      assertWorkflow(state, event.payload.workflowId, event.payload.workflowGeneration);
      const verificationEventPosition = decimalPosition(event.payload.verificationEventPosition, false);
      if (
        state.endVerificationState !== "passed"
        || state.verificationPassedEventPosition === null
        || verificationEventPosition !== state.verificationPassedEventPosition
        || verificationEventPosition >= eventPosition
      ) integrity();
      return withRootEvent(state, event, streamVersion, eventPosition, {
        state: "ended",
        verificationPassedEventPosition: verificationEventPosition,
        terminalEventPosition: eventPosition,
        terminalEventType: "SessionEnded",
      });
    }
    default:
      stateConflict();
  }
}

function evolveChild(
  state: ChildAggregateState,
  event: LifecycleEvent,
  streamVersion: bigint,
  eventPosition: bigint,
): ChildAggregateState {
  if (!isAllowedChildTransition(state, event.eventType)) stateConflict();
  switch (event.eventType) {
    case "SessionCheckpointRecorded": {
      const changes = checkpointChanges(state, event, eventPosition);
      return withChildEvent(state, event, streamVersion, eventPosition, {
        ...changes,
      });
    }
    case "EvidenceCoverageRecorded":
      return withChildEvent(state, event, streamVersion, eventPosition, {});
    case "ChildAssignmentAmended":
      if (
        event.payload.previousAssignmentRevision !== state.assignmentRevision
        || event.payload.assignmentRevision !== state.assignmentRevision + 1
        || event.payload.assignment.assignmentId !== state.assignment.assignmentId
      ) integrity();
      return withChildEvent(state, event, streamVersion, eventPosition, {
        assignment: freezeAssignment(event.payload.assignment),
        assignmentRevision: event.payload.assignmentRevision,
      });
    case "ChildWorkReported":
      if (
        event.payload.report.childSessionId !== state.sessionId
        || event.payload.report.parentSessionId !== state.parentSessionId
        || event.payload.report.assignmentId !== state.assignment.assignmentId
        || state.reportCount >= CHILD_REPORT_LIMIT_V1
        || reportItemSignatureFor(state, event.payload.report.reportId) !== null
      ) integrity();
      {
        const nextIndexHead: ChildReportIndexNode = Object.freeze({
          reportId: event.payload.report.reportId,
          itemSignature: reportItemSignature(event.payload.report.allReportItemIds),
          previous: state.reportIndexHead,
        });
        return withChildEvent(state, event, streamVersion, eventPosition, {
          latestReportId: event.payload.report.reportId,
          reportCount: state.reportCount + 1,
          reportIndexHead: nextIndexHead,
        });
      }
    case "ChildWorkDispositioned": {
      const referencedSignature = reportItemSignatureFor(state, event.payload.disposition.reportId);
      if (
        referencedSignature === null
        || referencedSignature !== reportItemSignature(event.payload.disposition.allReportItemIds)
      ) integrity();
      const completionDispositionRequestsMoreWork = state.state === "completion-proposed"
        && event.payload.disposition.kind !== "accepted"
        && state.completionReportId === event.payload.disposition.reportId;
      return withChildEvent(state, event, streamVersion, eventPosition, completionDispositionRequestsMoreWork
        ? { state: "active", completionReportId: null }
        : {});
    }
    case "ChildCompletionProposed":
      if (reportItemSignatureFor(state, event.payload.reportId) === null) integrity();
      return withChildEvent(state, event, streamVersion, eventPosition, {
        state: "completion-proposed",
        completionReportId: event.payload.reportId,
      });
    case "ChildSessionCompleted":
      if (
        reportItemSignatureFor(state, event.payload.reportId) === null
        || (
          state.state === "completion-proposed"
          && state.completionReportId !== event.payload.reportId
        )
      ) integrity();
      return withChildEvent(state, event, streamVersion, eventPosition, {
        state: "completed",
        childCapabilityRevoked: true,
        terminalEventPosition: eventPosition,
        terminalEventType: "ChildSessionCompleted",
      });
    case "ChildSessionSuspended":
      if (
        state.latestCheckpointId === null
        || event.payload.checkpointId !== state.latestCheckpointId
      ) integrity();
      return withChildEvent(state, event, streamVersion, eventPosition, {
        state: "suspended",
        childCapabilityRevoked: true,
        suspensionCheckpointId: event.payload.checkpointId,
      });
    case "ChildWorkTransferCreated":
      if (
        event.eventSchemaVersion !== 1
        || state.suspensionCheckpointId === null
        || state.latestCheckpointId === null
        || event.payload.checkpointId !== state.suspensionCheckpointId
      ) integrity();
      return withChildEvent(state, event, streamVersion, eventPosition, {
        state: "transferred",
        childCapabilityRevoked: true,
        terminalEventPosition: eventPosition,
        terminalEventType: "ChildWorkTransferCreated",
      });
    case "ChildWorkTransferClaimed": {
      const previousTransferPosition = decimalPosition(event.payload.previousTransferEventPosition, false);
      if (
        state.streamVersion !== 1n
        || state.sourceTransferTicketId === null
        || state.claimedTransferTicketId !== null
        || event.payload.transferTicketId !== state.sourceTransferTicketId
        || event.payload.previousChildSessionId === state.sessionId
        || event.payload.previousChildSessionId === state.parentSessionId
        || previousTransferPosition >= state.eventPosition
      ) integrity();
      return withChildEvent(state, event, streamVersion, eventPosition, {
        claimedTransferTicketId: event.payload.transferTicketId,
      });
    }
    default:
      stateConflict();
  }
}

export function evolveSession(state: RootAggregateState, event: LifecycleEvent): RootAggregateState;
export function evolveSession(state: ChildAggregateState, event: LifecycleEvent): ChildAggregateState;
export function evolveSession(state: SessionAggregateState, event: LifecycleEvent): SessionAggregateState;
export function evolveSession(
  state: SessionAggregateState,
  event: LifecycleEvent,
): SessionAggregateState {
  const { streamVersion, eventPosition } = assertContinuationEnvelope(state, event);
  if (isTerminalSession(state)) stateConflict();
  if (state.terminalEventPosition !== null || state.terminalEventType !== null) integrity();
  if (state.kind === "root") {
    if (!isAllowedRootTransition(state, event.eventType)) stateConflict();
  } else if (!isAllowedChildTransition(state, event.eventType)) {
    stateConflict();
  }
  assertContinuationCommitment(state, event);
  return state.kind === "root"
    ? evolveRoot(state, event, streamVersion, eventPosition)
    : evolveChild(state, event, streamVersion, eventPosition);
}

export function foldSession(events: readonly LifecycleEvent[]): SessionAggregateState {
  const first = events[0];
  if (first === undefined) integrity();
  let aggregate = initializeSession(first);
  for (let index = 1; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) integrity();
    aggregate = evolveSession(aggregate, event);
  }
  return aggregate;
}

export function isTerminalSession(state: SessionAggregateState): boolean {
  return state.kind === "root"
    ? state.state === "ended" || state.state === "abandoned"
    : state.state === "completed" || state.state === "transferred";
}

export function assertAuthorityMirror(
  aggregate: SessionAggregateState,
  authority: SessionAuthorityMirror,
): void {
  const expectedOwnerGeneration = aggregate.kind === "root"
    ? BigInt(aggregate.ownerGeneration)
    : null;
  const expectedChildGeneration = aggregate.kind === "child"
    ? aggregate.childCapabilityGeneration === null
      ? null
      : BigInt(aggregate.childCapabilityGeneration)
    : null;
  if (
    authority.sessionKind !== aggregate.kind
    || authority.parentSessionId !== aggregate.parentSessionId
    || authority.semanticState !== aggregate.state
    || authority.ownerGeneration !== expectedOwnerGeneration
    || authority.childCapabilityGeneration !== expectedChildGeneration
    || authority.authorityCommitment !== aggregate.authorityCommitment
    || authority.latestCheckpointEventPosition !== aggregate.latestCheckpointEventPosition
    || authority.terminalEventPosition !== aggregate.terminalEventPosition
  ) integrity();
}
