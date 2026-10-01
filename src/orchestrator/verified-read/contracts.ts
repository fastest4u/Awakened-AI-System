import type { FreshStartRelease } from "../fresh-start/contracts.js";
import type { ProjectBinding } from "../projections/contracts.js";
import type { ProjectionDirectoryIdentity } from "../projections/stable-directory.js";

export type VerifiedReadRequest = Readonly<{
  operation: "verify-published-view";
  consistency: "session-strong" | "project-strong";
  minimumEventPosition: string;
  budgetMs: number;
}>;
export type TrustedReadSession = Readonly<{ sessionId: string; minimumEventPosition: string }>;
export type VerifiedReadBinding = Readonly<{
  projectionBinding: ProjectBinding;
  expectedRelease: FreshStartRelease;
  controlGeneration: string;
  session: TrustedReadSession | null;
  eventsFile: Readonly<{ path: string; device: string; inode: string }>;
  projectionDirectory: ProjectionDirectoryIdentity;
  executorStateDirectory: ProjectionDirectoryIdentity;
  deploymentDirectory: ProjectionDirectoryIdentity;
  compositionEpoch: string;
}>;
export type ReadMessageIds = Readonly<{ requestId: string; attemptId: string; laneEpoch: string }>;
export type ReadLaunchIntent = Readonly<{
  schemaVersion: 1; bindingFingerprint: string; buildHash: string; supervisorId: string;
  ids: ReadMessageIds; lockToken: string;
}>;
export type ReadOwnershipRecord = ReadLaunchIntent & Readonly<{
  state: "launch-intent" | "child-observed" | "complete" | "incomplete"; pid: number | null;
}>;
export type ReadBootstrap = Readonly<{
  version: 1; ids: ReadMessageIds; binding: VerifiedReadBinding;
  request: VerifiedReadRequest; lockToken: string; remainingMs: number;
}>;
export type VerifiedReadReceipt = Readonly<{
  operation: VerifiedReadRequest["operation"];
  consistency: VerifiedReadRequest["consistency"];
  scope: ProjectBinding;
  releaseId: string;
  controlGeneration: string;
  requiredEventPosition: string;
  projectionGeneration: number;
  projectionEventPosition: string;
  projectionEventHash: string;
  imageSha256: string;
  verification: "image-scope-position-and-active-admission";
}>;
export type ReadFence = Readonly<{
  controlGeneration: string; releaseId: string; capturedPosition: string;
  capturedHash: string; requiredPosition: string;
}>;
export type ReadCleanupState = "pending" | "complete" | "incomplete";
export type ReadPhase = "admission" | "projection-wait" | "capture" | "validate" | "revalidate";
export type VerifiedReadFailureCode =
  | "FRESH_START_INPUT_INVALID" | "FRESH_START_CONTEXT_REQUIRED" | "FRESH_START_NOT_INITIALIZED"
  | "FRESH_START_IDENTITY_MISMATCH" | "FRESH_START_PATH_INVALID" | "FRESH_START_PATH_CHANGED"
  | "FRESH_START_BUILD_MISMATCH" | "FRESH_START_SCHEMA_MISMATCH" | "FRESH_START_RELEASE_MISMATCH"
  | "FRESH_START_ADMISSION_DENIED" | "FRESH_START_CONTENT_UNVERIFIED" | "FRESH_START_ADMISSION_STALE"
  | "PROJECTION_LAG" | "INTEGRITY_FAILURE" | "PROJECTION_SCOPE_MISMATCH"
  | "PROJECTION_PATH_INVALID" | "MATERIALIZATION_CONFLICT"
  | "WORKER_TIMEOUT" | "WORKER_CLOSED" | "STORE_QUEUE_FULL" | "WORKER_PROTOCOL_ERROR" | "WORKER_UNAVAILABLE";
export type ReadFailurePositions = Readonly<{ required: string; observed: string | null }>;
export type VerifiedReadFailure = Readonly<{
  code: VerifiedReadFailureCode; cleanup: ReadCleanupState; positions: ReadFailurePositions | null;
}>;
/** Stage emission is once per phase; lane owners enforce ordering and the message count. */
export type ReadReply = Readonly<{ version: 1; ids: ReadMessageIds }> & (
  | Readonly<{ kind: "stage"; phase: ReadPhase; observedProjectionPosition: string | null }>
  | Readonly<{ kind: "success"; receipt: VerifiedReadReceipt; fence: ReadFence;
      closed: Readonly<{ image: true; reader: true; lock: true }> }>
  | Readonly<{ kind: "failure"; failure: VerifiedReadFailure }>
);
export type ReadTerminalReply = Extract<ReadReply, { kind: "success" | "failure" }>;
export type ReadCancel = Readonly<{ version: 1; ids: ReadMessageIds; kind: "cancel" }>;
export type CleanupBootstrap = Readonly<{
  version: 1; ids: ReadMessageIds; directory: ProjectionDirectoryIdentity;
  lockToken: string; expectedBuildHash: string; remainingMs: number;
}>;
export type CleanupReply = Readonly<{
  version: 1; ids: ReadMessageIds; kind: "cleanup";
  outcome: "released" | "absent" | "poisoned" | "failed"; cleanup: "complete" | "incomplete";
}>;
export type VerifiedReadDiagnostic = Readonly<{
  attemptId: string | null;
  phase: "idle" | "queue" | "startup" | ReadPhase | "cleanup" | "closed";
  code: string | null; cleanup: ReadCleanupState; pendingCount: number;
  positions: ReadFailurePositions | null;
}>;
