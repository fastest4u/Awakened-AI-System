import type { Confidence } from "../contracts/event.js";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../identity/contracts.js";

/**
 * Authenticated source authority for known projection events. The event store's
 * canonical bytes and established payload hash are authoritative; `payload` is
 * a redundant decoded cache and is intentionally never treated as source data.
 */
export const PROJECTION_SOURCE_AUTHORITY_V1 = Object.freeze({
  canonicalPayloadField: "payloadJson",
  payloadHashField: "payloadHash",
  inMemoryPayloadRole: "non-authoritative-cache",
} as const);

/**
 * Immutable storage identity carried by every projected event and generation.
 * A nullable session denotes project/workspace/branch scoped material.
 */
export interface ProjectBinding {
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly branchScopeId: BranchScopeId | null;
  readonly branchRef: string | null;
  readonly sessionId: string | null;
}

export type ProjectionItemStatus =
  | "candidate"
  | "provisional"
  | "verified"
  | "conflicted"
  | "superseded"
  | "retracted"
  | "expired"
  | "erased-evidence";

export type ProjectionFeedbackOutcome = "accepted" | "dismissed" | "corrected";

export type CheckpointWorkKind =
  | "completed"
  | "in-progress"
  | "blocker"
  | "next-action"
  | "decision"
  | "assumption"
  | "conflict";

export interface ProjectionEventSource {
  readonly sourceEventId: string;
  readonly sourceEventPosition: bigint;
  readonly sourceEventSchemaVersion: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly binding: ProjectBinding;
}

export interface CheckpointWorkItem {
  readonly kind: CheckpointWorkKind;
  readonly ordinal: number;
  readonly summary: string;
  readonly confidence: Confidence;
}

export interface CheckpointFileItem {
  readonly ordinal: number;
  readonly path: string;
  readonly action: "created" | "modified" | "deleted" | "observed" | "renamed";
  readonly contentHash: string | null;
  readonly branchRef: string | null;
  readonly confidence: Confidence;
}

export interface CheckpointArtifactItem {
  readonly ordinal: number;
  readonly artifactId: string;
  readonly path: string;
  readonly summary: string;
  readonly contentHash: string;
  readonly confidence: Confidence;
}

export interface CheckpointProjectionEvent extends ProjectionEventSource {
  readonly kind: "checkpoint";
  readonly checkpointId: string;
  readonly checkpointVersion: 1 | 2;
  readonly baseEventPosition: bigint;
  readonly taskSummary: string;
  readonly workItems: readonly CheckpointWorkItem[];
  readonly files: readonly CheckpointFileItem[];
  readonly artifacts: readonly CheckpointArtifactItem[];
}

export interface MemorySourceProjectionEvent extends ProjectionEventSource {
  readonly kind: "memory-source";
  readonly itemId: string;
  readonly normalizedKey: string;
  readonly status: ProjectionItemStatus;
  readonly confidence: Confidence;
  readonly verificationMethod: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly summary: string;
  readonly contentHash: string;
  /** Version 2 conflict-set identity; null for Version 1 source events. */
  readonly conflictGroupId: string | null;
  /** Version 2 supersession target; null when this item is not superseded. */
  readonly supersedingItemId: string | null;
}

export interface RetrievalFeedbackProjectionEvent extends ProjectionEventSource {
  readonly kind: "retrieval-feedback";
  readonly feedbackId: string;
  readonly itemId: string;
  readonly outcome: ProjectionFeedbackOutcome;
  readonly usefulness: number;
  readonly sourceItemEventPosition: bigint;
}

export type ProjectionEvent =
  | CheckpointProjectionEvent
  | MemorySourceProjectionEvent
  | RetrievalFeedbackProjectionEvent;

export type ProjectionEventDecodeResult =
  | Readonly<{ kind: "projected"; event: ProjectionEvent }>
  | Readonly<{ kind: "unprojected"; eventPosition: bigint; eventType: string }>;

export interface SessionCheckpointProjection {
  readonly projectId: ProjectId;
  readonly sessionId: string;
  readonly checkpointId: string;
  readonly checkpointVersion: 1 | 2;
  readonly baseEventPosition: bigint;
  readonly sourceEventPosition: bigint;
  readonly occurredAt: string;
  readonly taskSummary: string;
}

export interface CanonicalItemProjection {
  readonly projectId: ProjectId;
  readonly sessionId: string | null;
  readonly itemId: string;
  readonly normalizedKey: string;
  readonly status: ProjectionItemStatus;
  readonly confidence: Confidence;
  readonly verificationMethod: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly summary: string;
  readonly contentHash: string;
  readonly conflictGroupId: string | null;
  readonly supersedingItemId: string | null;
  readonly knownFromEventPosition: bigint;
  readonly sourceEventPosition: bigint;
}

export interface FollowUpProjection {
  readonly projectId: ProjectId;
  readonly sessionId: string;
  readonly followUpId: string;
  readonly status: "open" | "blocked";
  readonly summary: string;
  readonly confidence: Confidence;
  readonly sourceEventPosition: bigint;
}

export interface ArtifactProjection {
  readonly projectId: ProjectId;
  readonly sessionId: string;
  readonly artifactId: string;
  readonly path: string;
  readonly summary: string | null;
  readonly action: string;
  readonly contentHash: string | null;
  readonly branchRef: string | null;
  readonly confidence: Confidence;
  readonly sourceEventPosition: bigint;
}

export interface LexicalChunkProjection {
  readonly projectId: ProjectId;
  readonly chunkId: string;
  readonly itemId: string | null;
  readonly sessionId: string | null;
  readonly section: string;
  readonly normalizedKey: string;
  readonly text: string;
  readonly sourceEventPosition: bigint;
}

export interface RetrievalFeedbackProjection {
  readonly projectId: ProjectId;
  readonly feedbackId: string;
  readonly itemId: string;
  readonly outcome: ProjectionFeedbackOutcome;
  readonly usefulness: number;
  readonly sourceItemEventPosition: bigint;
  readonly sourceEventPosition: bigint;
}

export interface ProjectionFoldState {
  readonly schemaVersion: 1;
  readonly binding: ProjectBinding | null;
  readonly terminalEventPosition: bigint | null;
  readonly sessionCheckpoints: readonly SessionCheckpointProjection[];
  readonly canonicalItems: readonly CanonicalItemProjection[];
  readonly followUps: readonly FollowUpProjection[];
  readonly artifacts: readonly ArtifactProjection[];
  readonly lexicalChunks: readonly LexicalChunkProjection[];
  readonly retrievalFeedback: readonly RetrievalFeedbackProjection[];
}
