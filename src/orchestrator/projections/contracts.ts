import type { Confidence } from "../contracts/event.js";
import type { StoredEvent } from "../contracts/event.js";
import type { GovernedNotePrior } from "../governed-notes/pair-validation.js";
import type { GovernedNoteKind } from "../governed-notes/contracts.js";
import { types } from "node:util";
import { assertMarkdownNoteBodyV1, governedNoteBodyHash } from "../governed-notes/body-content.js";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../identity/contracts.js";

const PROJECTION_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROJECTION_SHA256 = /^[0-9a-f]{64}$/u;

/**
 * Production project-store identities are UUIDv4 values; sealed evaluator
 * fixtures retain their legacy content-addressed identities during migration.
 */
export function isProjectionProjectStoreIdentity(value: unknown): value is string {
  return typeof value === "string" && (PROJECTION_UUID_V4.test(value) || PROJECTION_SHA256.test(value));
}

/** Workspace identity remains content-addressed for every projection source. */
export function isProjectionWorkspaceIdentity(value: unknown): value is string {
  return typeof value === "string" && PROJECTION_SHA256.test(value);
}

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

export type FollowUpStatus =
  | "open"
  | "blocked"
  | "completed"
  | "carried-forward"
  | "abandoned";

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
  readonly sourceStreamVersion: bigint;
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
  readonly sourceEventSchemaVersion: 1 | 2;
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

export interface GovernedCanonicalItem {
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
  readonly anchor: string | null;
}

export interface GovernedFollowUp {
  readonly followUpId: string;
  readonly status: FollowUpStatus;
  readonly summary: string;
  readonly confidence: Confidence;
  readonly anchor: string | null;
}

export interface GovernedArtifact {
  readonly artifactId: string;
  readonly path: string;
  readonly summary: string | null;
  readonly action: "created" | "modified" | "deleted" | "observed" | "renamed" | "referenced";
  readonly contentHash: string | null;
  readonly branchRef: string | null;
  readonly confidence: Confidence;
  readonly symbol: string | null;
  readonly commitHash: string | null;
  readonly heading: string | null;
  readonly anchor: string | null;
}

export interface GovernedEntity {
  readonly entityId: string;
  readonly normalizedName: string;
  readonly entityType: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly anchor: string | null;
}

export interface GovernedEntityAlias {
  readonly aliasId: string;
  readonly entityId: string;
  readonly normalizedAlias: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly anchor: string | null;
}

export interface GovernedEntityEdge {
  readonly edgeId: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly edgeType: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly anchor: string | null;
}

export interface GovernedMemorySourceProjectionEvent extends ProjectionEventSource {
  readonly kind: "governed-memory-source";
  readonly sourceEventSchemaVersion: 3;
  readonly item: GovernedCanonicalItem;
  readonly followUps: readonly GovernedFollowUp[];
  readonly artifacts: readonly GovernedArtifact[];
  readonly entities: readonly GovernedEntity[];
  readonly aliases: readonly GovernedEntityAlias[];
  readonly edges: readonly GovernedEntityEdge[];
}

export type SessionLifecycleEventType =
  | "SessionStarted"
  | "SessionOwnerTransferred"
  | "SessionOwnershipRecovered"
  | "SessionSuspendRequested"
  | "SessionSuspended"
  | "SessionResumed"
  | "EvidenceCoverageRecorded"
  | "SessionForked"
  | "ChildAssignmentAmended"
  | "ChildWorkReported"
  | "ChildWorkDispositioned"
  | "ChildCompletionProposed"
  | "ChildSessionCompleted"
  | "ChildSessionSuspended"
  | "ChildWorkTransferCreated"
  | "ChildWorkTransferClaimed"
  | "SessionEndRequested"
  | "SessionEndAmended"
  | "SessionValidationResultRecorded"
  | "SessionEndVerificationPassed"
  | "SessionEndVerificationFailed"
  | "SessionEndVerificationInvalidated"
  | "SessionEndCancelled"
  | "SessionAbandoned"
  | "SessionEnded";

export interface SessionLifecycleProjectionEvent extends ProjectionEventSource {
  readonly kind: "session-lifecycle";
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly eventType: SessionLifecycleEventType;
  readonly ownerGeneration: number | null;
  readonly previousOwnerGeneration: number | null;
}

export interface RetrievalFeedbackProjectionEvent extends ProjectionEventSource {
  readonly kind: "retrieval-feedback";
  readonly feedbackId: string;
  readonly itemId: string;
  readonly outcome: ProjectionFeedbackOutcome;
  readonly usefulness: number;
  readonly sourceItemEventPosition: bigint;
}

export interface GovernedLifecycleProjectionEventV1 extends ProjectionEventSource {
  readonly kind: "governed-lifecycle-transition";
  readonly transitionKind: "promote" | "supersede" | "retract" | "expire" | "erase-evidence";
  readonly recordId: string;
  readonly targetStatus: ProjectionItemStatus;
  readonly verificationMethod?: string;
  readonly verificationAnchor?: string | null;
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly supersededByEventId?: string | null;
  readonly supersedingRecordId?: string | null;
  readonly retractedByEventId?: string | null;
  readonly conflictKey?: string | null;
  readonly conflictGroupId?: string | null;
  readonly conflictingRecordIds?: readonly string[];
  readonly resolutionState?: "open" | "resolved";
  readonly resolutionEventId?: string | null;
  readonly reason: string;
  readonly erasedEvidenceIds?: readonly string[];
  readonly erasedRecordIds?: readonly string[];
}

export interface CanonicalConflictProjectionRowV1 {
  readonly projectId: string;
  readonly conflictKey: string;
  readonly conflictGroupId: string;
  readonly recordIds: readonly string[];
  readonly resolutionState: "open" | "resolved";
  readonly resolutionEventId: string | null;
  readonly updatedEventPosition: string;
}

export type ProjectionEvent =
  | CheckpointProjectionEvent
  | MemorySourceProjectionEvent
  | GovernedMemorySourceProjectionEvent
  | GovernedLifecycleProjectionEventV1
  | SessionLifecycleProjectionEvent
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
  readonly sourceEventId: string;
  readonly anchor: string | null;
}

export interface SessionTreeProjection {
  readonly projectId: ProjectId;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId: string | null;
  readonly lifecycleState: "open" | "closed";
  readonly ownerGeneration: number;
  readonly openedEventPosition: bigint;
  readonly closedEventPosition: bigint | null;
  readonly latestCheckpointId: string | null;
  readonly latestCheckpointEventPosition: bigint | null;
  readonly sourceEventId: string;
  readonly sourceEventPosition: bigint;
  readonly latestStreamVersion: bigint;
  readonly anchor: string | null;
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
  readonly sourceEventId: string;
  readonly sourceEventPosition: bigint;
  readonly anchor: string | null;
}

export interface FollowUpProjection {
  readonly projectId: ProjectId;
  readonly sessionId: string;
  readonly followUpId: string;
  readonly status: FollowUpStatus;
  readonly summary: string;
  readonly confidence: Confidence;
  readonly sourceEventId: string;
  readonly sourceEventPosition: bigint;
  readonly anchor: string | null;
}

export interface ProvenancedArtifactProjection {
  readonly symbol: string | null;
  readonly commitHash: string | null;
  readonly heading: string | null;
  readonly sourceEventId: string;
  readonly anchor: string | null;
}

export interface ArtifactProjection extends ProvenancedArtifactProjection {
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

export interface EntityNodeProjection {
  readonly projectId: ProjectId;
  readonly entityId: string;
  readonly normalizedName: string;
  readonly entityType: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly sourceEventId: string;
  readonly sourceEventPosition: bigint;
  readonly anchor: string | null;
}

export interface EntityAliasProjection {
  readonly projectId: ProjectId;
  readonly aliasId: string;
  readonly entityId: string;
  readonly normalizedAlias: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly sourceEventId: string;
  readonly sourceEventPosition: bigint;
  readonly anchor: string | null;
}

export interface EntityEdgeProjection {
  readonly projectId: ProjectId;
  readonly edgeId: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly edgeType: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly sourceEventId: string;
  readonly sourceEventPosition: bigint;
  readonly anchor: string | null;
}

export interface LexicalChunkProjection {
  readonly projectId: ProjectId;
  readonly chunkId: string;
  readonly itemId: string | null;
  readonly sessionId: string | null;
  readonly section: string;
  readonly normalizedKey: string;
  readonly text: string;
  readonly sourceEventId: string;
  readonly sourceEventPosition: bigint;
  readonly anchor: string | null;
}

export interface RetrievalFeedbackProjection {
  readonly projectId: ProjectId;
  readonly feedbackId: string;
  readonly itemId: string;
  readonly outcome: ProjectionFeedbackOutcome;
  readonly usefulness: number;
  readonly sourceItemEventPosition: bigint;
  readonly sourceEventId: string;
  readonly sourceEventPosition: bigint;
  readonly anchor: string | null;
}

export interface ProjectionFoldState {
  readonly schemaVersion: 2;
  readonly binding: ProjectBinding | null;
  readonly terminalEventPosition: bigint | null;
  readonly sessionTree: readonly SessionTreeProjection[];
  readonly sessionCheckpoints: readonly SessionCheckpointProjection[];
  readonly canonicalItems: readonly CanonicalItemProjection[];
  readonly followUps: readonly FollowUpProjection[];
  readonly artifacts: readonly ArtifactProjection[];
  readonly entityNodes: readonly EntityNodeProjection[];
  readonly entityAliases: readonly EntityAliasProjection[];
  readonly entityEdges: readonly EntityEdgeProjection[];
  readonly lexicalChunks: readonly LexicalChunkProjection[];
  readonly retrievalFeedback: readonly RetrievalFeedbackProjection[];
}

export type ProjectionSourceDisposition = Readonly<{
  event: StoredEvent;
  governedNotePrior: GovernedNotePrior | null;
}>;

export type GovernedMemorySourceProjectionEventV3 = Readonly<
  Omit<GovernedMemorySourceProjectionEvent, "sourceEventSchemaVersion"> & {
    sourceEventSchemaVersion: 4;
  }
>;
export type ProjectionEventV3 = ProjectionEvent | GovernedMemorySourceProjectionEventV3;
export type GovernedNoteProjectionRowV1 = Readonly<{
  projectId: string;
  itemId: string;
  recordKind: GovernedNoteKind;
  format: "markdown" | null;
  body: string | null;
  bodyContentHash: string | null;
  sourceEventPosition: string;
}>;
export type ProjectionFoldStateV3 = Readonly<Omit<ProjectionFoldState, "schemaVersion"> & {
  schemaVersion: 3;
  governedNotes: readonly GovernedNoteProjectionRowV1[];
}>;

const GOVERNED_ROW_KEYS = ["projectId", "itemId", "recordKind", "format", "body", "bodyContentHash", "sourceEventPosition"] as const;
const GOVERNED_ITEM_KEYS = ["projectId", "itemId", "normalizedKey", "verificationMethod", "sourceEventPosition"] as const;
const GOVERNED_POSITION_MAX = 9_223_372_036_854_775_807n;
const GOVERNED_KINDS = ["session-log", "insight", "mistake", "adr"] as const;
function governedProjectionIntegrity(): never { throw new Error("INTEGRITY_FAILURE"); }

function ownedFields(value: unknown, keys: readonly string[], exact: boolean): Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value)) return governedProjectionIntegrity();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return governedProjectionIntegrity();
  if (exact && Reflect.ownKeys(value).length !== keys.length) return governedProjectionIntegrity();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return governedProjectionIntegrity();
    result[key] = descriptor.value;
  }
  return result;
}
function ownedRows(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > 100_000 || Reflect.ownKeys(value).length !== value.length + 1) return governedProjectionIntegrity();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return governedProjectionIntegrity();
    return descriptor.value as unknown;
  });
}

export const GOVERNED_NOTE_V1_MARKERS: ReadonlySet<string> = new Set([
  "governed-note-unverified-v1",
  "governed-note-user-confirmed-v1",
  "governed-note-test-verified-v1",
  "governed-note-source-anchored-v1",
  "governed-note-accepted-adr-v1",
  "governed-note-cross-session-v1",
]);

export const GOVERNED_NOTE_V2_MARKERS: ReadonlySet<string> = new Set([
  "governed-note-unverified-v2",
  "governed-note-user-confirmed-v2",
  "governed-note-test-verified-v2",
  "governed-note-source-anchored-v2",
  "governed-note-accepted-adr-v2",
  "governed-note-cross-session-v2",
]);

export const GOVERNED_NOTE_ERASED_MARKER = "governed-note-erased-v1" as const;

/** Pure image-side validation: no event-store lookup or writer dependency. */
export function validateGovernedNoteProjectionRows(
  canonicalItems: readonly Pick<CanonicalItemProjection, "projectId" | "itemId" | "normalizedKey" | "verificationMethod" | "sourceEventPosition">[],
  input: readonly GovernedNoteProjectionRowV1[],
  terminalEventPosition: bigint | null,
): readonly GovernedNoteProjectionRowV1[] {
  try {
    if (terminalEventPosition !== null && (typeof terminalEventPosition !== "bigint" || terminalEventPosition < 0n || terminalEventPosition > GOVERNED_POSITION_MAX)) return governedProjectionIntegrity();
    const items = new Map<string, Record<string, unknown>>();
    for (const value of ownedRows(canonicalItems)) {
      const item = ownedFields(value, GOVERNED_ITEM_KEYS, false);
      if (!isProjectionProjectStoreIdentity(item.projectId) || typeof item.itemId !== "string"
        || typeof item.normalizedKey !== "string" || typeof item.verificationMethod !== "string"
        || typeof item.sourceEventPosition !== "bigint" || item.sourceEventPosition < 1n
        || item.sourceEventPosition > GOVERNED_POSITION_MAX || terminalEventPosition === null
        || item.sourceEventPosition > terminalEventPosition) return governedProjectionIntegrity();
      const key = `${item.projectId}\0${item.itemId}`;
      if (items.has(key)) return governedProjectionIntegrity();
      items.set(key, item);
      const reserved = item.normalizedKey.startsWith("governed-note/");
      const marker = item.verificationMethod;
      const isKnownGovernedMarker = GOVERNED_NOTE_V1_MARKERS.has(marker)
        || GOVERNED_NOTE_V2_MARKERS.has(marker)
        || marker === GOVERNED_NOTE_ERASED_MARKER;
      if (reserved !== isKnownGovernedMarker
        || (marker.startsWith("governed-note-") && !reserved)) return governedProjectionIntegrity();
    }
    const seen = new Set<string>();
    const result = ownedRows(input).map(value => {
      const row = ownedFields(value, GOVERNED_ROW_KEYS, true);
      if (!isProjectionProjectStoreIdentity(row.projectId) || typeof row.itemId !== "string" || !PROJECTION_UUID_V4.test(row.itemId)
        || !GOVERNED_KINDS.includes(row.recordKind as GovernedNoteKind)
        || typeof row.sourceEventPosition !== "string" || !/^[1-9][0-9]{0,18}$/u.test(row.sourceEventPosition)) return governedProjectionIntegrity();
      const key = `${row.projectId}\0${row.itemId}`, item = items.get(key);
      if (seen.has(key) || item === undefined || row.sourceEventPosition !== String(item.sourceEventPosition)
        || item.normalizedKey !== `governed-note/${String(row.recordKind)}/${row.itemId}`) return governedProjectionIntegrity();
      seen.add(key);
      if (GOVERNED_NOTE_V1_MARKERS.has(String(item.verificationMethod))) {
        if (row.format !== null || row.body !== null || row.bodyContentHash !== null) return governedProjectionIntegrity();
      } else if (GOVERNED_NOTE_V2_MARKERS.has(String(item.verificationMethod))) {
        if (row.format !== "markdown" || typeof row.bodyContentHash !== "string" || !PROJECTION_SHA256.test(row.bodyContentHash)) return governedProjectionIntegrity();
        assertMarkdownNoteBodyV1(row.body);
        if (governedNoteBodyHash({ format: "markdown", body: row.body }) !== row.bodyContentHash) return governedProjectionIntegrity();
      } else return governedProjectionIntegrity();
      return Object.freeze(row) as GovernedNoteProjectionRowV1;
    });
    for (const [key, item] of items) {
      if (String(item.normalizedKey).startsWith("governed-note/") && item.verificationMethod !== GOVERNED_NOTE_ERASED_MARKER && !seen.has(key)) {
        return governedProjectionIntegrity();
      }
    }
    const binary = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    return Object.freeze(result.sort((left, right) => binary(left.projectId, right.projectId) || binary(left.itemId, right.itemId)));
  } catch { return governedProjectionIntegrity(); }
}
