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
export type DeepReadonlyJson<T extends JsonValue> =
  T extends JsonPrimitive ? T
    : T extends JsonValue[] ? readonly DeepReadonlyJson<T[number]>[]
      : T extends { [key: string]: JsonValue }
        ? { readonly [K in keyof T]: DeepReadonlyJson<T[K]> }
        : never;
export type ReadonlyJsonValue =
  | JsonPrimitive
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };
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
  /** Canonical nonsecret Version 2 witness stored on command event zero. */
  lifecycleIntentWitness?: string;
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

export interface StoredCommandResponse<TResponse extends JsonValue> {
  readonly eventIds: readonly string[];
  readonly firstGlobalPosition: string;
  readonly lastGlobalPosition: string;
  readonly finalStreamVersion: string;
  readonly response: DeepReadonlyJson<TResponse>;
}

export interface LifecyclePrincipal {
  actorRole: TrustedActorRole;
  clientInstanceId: string;
}

export type LifecycleCommandOrigin =
  | {
      kind: "initial-authority";
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    }
  | {
      kind: "protected";
      proof: null | { version: 1; nonce: string; digest: string };
      approval: null | { approvalId: string; digest: string };
      authorizationSessionId: string;
      targetSessionId: string;
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    }
  | {
      kind: "internal-workflow";
      workflowId: string;
      workflowGeneration: bigint;
      plannedWorkId: string;
      claimOwnerId: string;
      claimToken: bigint;
      authorizationSessionId: string;
      targetSessionId: string;
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    };

export type PersistedLifecycleAuthorizationRecord =
  | (Extract<LifecycleCommandOrigin, { kind: "initial-authority" }> & {
      authorizationSessionId: null;
      targetSessionId: string;
      proof: null;
      approval: null;
    })
  | Extract<LifecycleCommandOrigin, { kind: "protected" | "internal-workflow" }>;

export type LifecycleReplayExpectation =
  | Extract<LifecycleCommandOrigin, { kind: "initial-authority" | "protected" }>
  | {
      kind: "internal-workflow";
      workflowId: string;
      workflowGeneration: bigint;
      plannedWorkId: string;
      authorizationSessionId: string;
      targetSessionId: string;
      presenting: LifecyclePrincipal;
      target: LifecyclePrincipal;
    };

export interface StoredEvent {
  readonly globalPosition: bigint;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly branchScopeId: BranchScopeId | null;
  readonly branchRef: string | null;
  readonly streamId: string;
  readonly streamType: string;
  readonly streamVersion: bigint;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly sessionId: string | null;
  readonly parentSessionId: string | null;
  readonly actorRole: TrustedActorRole;
  readonly agentId: string;
  readonly clientInstanceId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly commandEventIndex: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly visibilityScope: Exclude<VisibilityScope, "global">;
  readonly confidence: Confidence;
  readonly verificationStatus: VerificationStatus;
  readonly sourceRefs: readonly string[];
  readonly evidenceRefs: readonly [];
  readonly evidenceDigests: readonly [];
  readonly payload: ReadonlyJsonValue;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly previousGlobalHash: string;
  readonly eventHash: string;
  /** Canonical source is persisted only by Version 2 command event zero. */
  readonly lifecycleIntentJson?: string | null;
}
