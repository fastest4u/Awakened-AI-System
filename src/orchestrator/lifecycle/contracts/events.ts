import type { JsonValue } from "../../contracts/event.js";
import type {
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../../identity/contracts.js";
import type { SessionId } from "./identifiers.js";

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
export type LifecycleEventPayloadV1 = Readonly<Record<string, JsonValue>>;

export interface LifecycleEventBaseV1<T extends LifecycleEventType = LifecycleEventType> {
  readonly eventSchemaVersion: 1;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly streamId: string;
  readonly streamVersion: bigint;
  readonly globalPosition: bigint;
  readonly sessionId: SessionId;
  readonly parentSessionId: SessionId | null;
  readonly eventType: T;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly authorityCommitment: string;
  readonly payload: LifecycleEventPayloadV1;
}

export type LifecycleEventV1 = {
  readonly [T in LifecycleEventType]: LifecycleEventBaseV1<T>;
}[LifecycleEventType];
