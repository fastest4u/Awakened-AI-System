import type {
  BranchScopeId,
  ProjectContext,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../identity/contracts.js";
import type { TrustedActorRole } from "../identity/project-binding.request.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type VisibilityScope = "session" | "workspace" | "branch" | "project" | "global";
export type Confidence = "high" | "medium" | "low" | "guess";
export type VerificationStatus = "unverified" | "provisional" | "verified" | "conflicted";

export interface EvidenceDigest {
  ciphertextHash: string;
  keyedFingerprint: string;
}

export interface PendingEvent {
  eventType: string;
  eventSchemaVersion: number;
  occurredAt: string;
  visibilityScope: VisibilityScope;
  sessionId?: string;
  parentSessionId?: string;
  causationId?: string;
  confidence: Confidence;
  verificationStatus: VerificationStatus;
  payload: JsonValue;
  sourceRefs: string[];
  evidenceRefs: string[];
  evidenceDigests: EvidenceDigest[];
}

export interface PendingOutbox {
  targetKey: string;
  kind: string;
  eventIndex: number;
  payload: JsonValue;
}

export interface AppendCommand<TResponse extends JsonValue> {
  context: ProjectContext;
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  correlationId: string;
  agentId: string;
  expectedStreamVersion: bigint;
  streamId: string;
  streamType: string;
  events: PendingEvent[];
  outbox: PendingOutbox[];
  publicResponse: TResponse;
}

export interface AppendResult<TResponse extends JsonValue> {
  deduplicated: boolean;
  firstGlobalPosition: bigint;
  lastGlobalPosition: bigint;
  finalStreamVersion: bigint;
  eventIds: string[];
  response: TResponse;
  responseHash: string;
}

export interface StoredEvent {
  globalPosition: bigint;
  eventId: string;
  projectId: ProjectId;
  vaultId: VaultId;
  storeId: StoreId;
  workspaceId: WorkspaceId;
  branchScopeId: BranchScopeId | null;
  branchRef: string | null;
  streamId: string;
  streamType: string;
  streamVersion: bigint;
  eventType: string;
  eventSchemaVersion: number;
  sessionId: string | null;
  parentSessionId: string | null;
  actorRole: TrustedActorRole;
  agentId: string;
  clientInstanceId: string;
  correlationId: string;
  causationId: string | null;
  commandId: string;
  idempotencyKey: string;
  commandEventIndex: number;
  occurredAt: string;
  recordedAt: string;
  visibilityScope: Exclude<VisibilityScope, "global">;
  confidence: Confidence;
  verificationStatus: VerificationStatus;
  sourceRefs: string[];
  evidenceRefs: [];
  evidenceDigests: [];
  payload: JsonValue;
  payloadJson: string;
  payloadHash: string;
  previousGlobalHash: string;
  eventHash: string;
}
