import { Buffer } from "node:buffer";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../identity/contracts.js";
import type {
  CheckpointEvidenceCoverageV1,
  CheckpointV1,
  CheckpointV2,
  MissingOrdinalIntervalV1,
} from "../lifecycle/contracts/checkpoint.js";
import type {
  AdapterSessionId,
  CheckpointId,
  ChildEndPolicy,
  EvidenceBatchId,
  MaterialConfidence,
  ReportId,
  ReportItemId,
  SessionId,
  TransferTicketId,
  ValidationResultId,
  WorkflowId,
} from "../lifecycle/contracts/identifiers.js";
import type { ValidationResultV1 } from "../lifecycle/contracts/session-end.js";
import { LifecycleError } from "../lifecycle/errors.js";
import type { LifecycleMaterializationTriggerType } from "../lifecycle/materialization-queue.port.js";
import { canonicalJson } from "../serialization/canonical-json.js";

export interface CompatibilityLogIdentityV2 {
  readonly documentVersion: 2;
  readonly projectId: ProjectId;
  readonly vaultId: VaultId;
  readonly storeId: StoreId;
  readonly workspaceId: WorkspaceId;
  readonly branchScopeId: BranchScopeId | null;
  readonly branchRef: string | null;
  readonly sessionId: SessionId;
  readonly startedAt: string;
}

export interface CompatibilityLogSourceV2 {
  readonly streamId: `session/${SessionId}`;
  readonly streamType: "session";
  readonly startEventPosition: string;
  readonly throughEventPosition: string;
}

export interface CompatibilityLogLifecycleV2 {
  readonly rootState: "active" | "suspended" | "ending" | "abandoned" | "ended";
  readonly workflowId: WorkflowId | null;
  readonly workflowGeneration: number | null;
  readonly childEndPolicy: ChildEndPolicy | null;
  readonly evidenceWindowState: "open" | "sealed" | null;
}

export type CompatibilityLogReportCategoryV2 =
  | "findings"
  | "proposedDecisions"
  | "filesObservedOrChanged"
  | "verificationPerformed"
  | "openFollowUps"
  | "blockers";

export interface CompatibilityLogAcceptedChildItemV2 {
  readonly childSessionId: SessionId;
  readonly reportId: ReportId;
  readonly category: CompatibilityLogReportCategoryV2;
  readonly itemIndex: number;
  readonly itemId: ReportItemId;
  readonly summary: string;
  readonly evidenceReferences: readonly string[];
  readonly confidence: MaterialConfidence;
}

export type CompatibilityLogUnresolvedFollowUpV2 =
  | {
      readonly kind: "deferred-child-item" | "rejected-child-item";
      readonly sourceChildSessionId: SessionId;
      readonly reportId: ReportId;
      readonly category: CompatibilityLogReportCategoryV2;
      readonly itemIndex: number;
      readonly itemId: ReportItemId;
      readonly summary: string;
      readonly evidenceReferences: readonly string[];
      readonly confidence: MaterialConfidence;
    }
  | {
      readonly kind: "carry-forward-ticket";
      readonly sourceChildSessionId: SessionId;
      readonly transferTicketId: TransferTicketId;
      readonly checkpointId: CheckpointId;
      readonly blockers: readonly string[];
      readonly followUps: readonly string[];
    };

export interface CompatibilityLogQualifiedEvidenceCoverageV2 {
  readonly coverageVersion: 2;
  readonly captureMode: "coverage-only";
  readonly contentRetained: false;
  readonly adapterSessions: readonly {
    readonly adapterSessionId: AdapterSessionId;
    readonly coverageFirstOrdinal: "0";
    readonly coverageLastOrdinal: string;
    readonly highestContiguousOrdinal: string | null;
    readonly missingIntervals: readonly MissingOrdinalIntervalV1[];
    readonly latestBatchId: EvidenceBatchId;
    readonly latestBatchEventPosition: string;
  }[];
}

export type CompatibilityLogFinalCheckpointV2 =
  | {
      readonly checkpointFingerprint: string;
      readonly checkpoint: Omit<CheckpointV1, "evidenceCoverage"> & {
        readonly evidenceCoverage: CheckpointEvidenceCoverageV1;
      };
    }
  | {
      readonly checkpointFingerprint: string;
      readonly checkpoint: Omit<CheckpointV2, "evidenceCoverage"> & {
        readonly evidenceCoverage: CompatibilityLogQualifiedEvidenceCoverageV2;
      };
    };

export interface CompatibilityLogValidationV2 {
  readonly verificationStatus: "not-run" | "passed" | "failed" | "invalidated";
  readonly validationResultIds: readonly ValidationResultId[];
  readonly qualityScore: number | null;
  readonly safeFailureCode: string | null;
  readonly results: readonly ValidationResultV1[];
}

export interface CompatibilityLogMaterializationV2 {
  readonly artifactKind: "compatibility-session-log";
  readonly artifactPath: string;
  readonly targetKey: string;
  readonly materializationRevision: string;
  readonly triggeringEventType: LifecycleMaterializationTriggerType;
  readonly triggeringEventSchemaVersion: number;
  readonly triggeringEventPosition: string;
  readonly triggeringPayloadHash: string;
}

export interface CompatibilityLogProjectionV2 {
  readonly identity: CompatibilityLogIdentityV2;
  readonly source: CompatibilityLogSourceV2;
  readonly lifecycle: CompatibilityLogLifecycleV2;
  readonly acceptedChildren: readonly CompatibilityLogAcceptedChildItemV2[];
  readonly unresolvedFollowUps: readonly CompatibilityLogUnresolvedFollowUpV2[];
  readonly finalCheckpoint: CompatibilityLogFinalCheckpointV2 | null;
  readonly validation: CompatibilityLogValidationV2 | null;
  readonly materialization: CompatibilityLogMaterializationV2;
}

const PROJECTION_KEYS = [
  "identity",
  "source",
  "lifecycle",
  "acceptedChildren",
  "unresolvedFollowUps",
  "finalCheckpoint",
  "validation",
  "materialization",
] as const;
const IDENTITY_KEYS = [
  "documentVersion", "projectId", "vaultId", "storeId", "workspaceId",
  "branchScopeId", "branchRef", "sessionId", "startedAt",
] as const;
const SOURCE_KEYS = ["streamId", "streamType", "startEventPosition", "throughEventPosition"] as const;
const LIFECYCLE_KEYS = [
  "rootState", "workflowId", "workflowGeneration", "childEndPolicy", "evidenceWindowState",
] as const;
const ACCEPTED_KEYS = [
  "childSessionId", "reportId", "category", "itemIndex", "itemId", "summary",
  "evidenceReferences", "confidence",
] as const;
const CHILD_UNRESOLVED_KEYS = [
  "kind", "sourceChildSessionId", "reportId", "category", "itemIndex", "itemId",
  "summary", "evidenceReferences", "confidence",
] as const;
const TICKET_KEYS = [
  "kind", "sourceChildSessionId", "transferTicketId", "checkpointId", "blockers", "followUps",
] as const;
const VALIDATION_KEYS = [
  "verificationStatus", "validationResultIds", "qualityScore", "safeFailureCode", "results",
] as const;
const VALIDATION_RESULT_KEYS = [
  "validationResultVersion", "resultId", "runId", "projectId", "vaultId", "storeId",
  "workspaceId", "sessionId", "workflowId", "workflowGeneration", "profileId",
  "profileVersion", "profileConfigurationHash", "runnerId", "status", "exitClassification",
  "fresh", "summary", "startedAt", "completedAt", "finalCheckpointId",
  "finalCheckpointFingerprint", "sourceStateAtStart", "sourceStateAtCompletion",
  "outputFingerprint", "artifactReferences",
] as const;
const SOURCE_STATE_KEYS = [
  "sourceStateScopeVersion", "workspaceId", "branchRef", "headCommit",
  "dirtyWorktreeFingerprint",
] as const;
const OUTPUT_FINGERPRINT_KEYS = [
  "fingerprint", "fingerprintDomain", "fingerprintKeyId", "fingerprintSchemaVersion",
] as const;
const MATERIALIZATION_KEYS = [
  "artifactKind", "artifactPath", "targetKey", "materializationRevision",
  "triggeringEventType", "triggeringEventSchemaVersion", "triggeringEventPosition",
  "triggeringPayloadHash",
] as const;

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function hasExactEnumerableDataKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const actual = (keys as string[]).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) return false;
  return actual.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function assertProjectionShape(projection: CompatibilityLogProjectionV2): void {
  const validationResultsAreExact = projection.validation === null
    || (
      Array.isArray(projection.validation.results)
      && projection.validation.results.every((result) => (
        hasExactEnumerableDataKeys(result, VALIDATION_RESULT_KEYS)
        && hasExactEnumerableDataKeys(result.sourceStateAtStart, SOURCE_STATE_KEYS)
        && hasExactEnumerableDataKeys(result.sourceStateAtCompletion, SOURCE_STATE_KEYS)
        && hasExactEnumerableDataKeys(result.outputFingerprint, OUTPUT_FINGERPRINT_KEYS)
        && Array.isArray(result.artifactReferences)
      ))
    );
  if (
    !hasExactEnumerableDataKeys(projection, PROJECTION_KEYS)
    || !hasExactEnumerableDataKeys(projection.identity, IDENTITY_KEYS)
    || !hasExactEnumerableDataKeys(projection.source, SOURCE_KEYS)
    || !hasExactEnumerableDataKeys(projection.lifecycle, LIFECYCLE_KEYS)
    || !Array.isArray(projection.acceptedChildren)
    || !projection.acceptedChildren.every((item) => hasExactEnumerableDataKeys(item, ACCEPTED_KEYS))
    || !Array.isArray(projection.unresolvedFollowUps)
    || !projection.unresolvedFollowUps.every((item) => hasExactEnumerableDataKeys(
      item,
      item.kind === "carry-forward-ticket" ? TICKET_KEYS : CHILD_UNRESOLVED_KEYS,
    ))
    || (projection.finalCheckpoint !== null
      && !hasExactEnumerableDataKeys(projection.finalCheckpoint, ["checkpointFingerprint", "checkpoint"]))
    || (projection.validation !== null
      && !hasExactEnumerableDataKeys(projection.validation, VALIDATION_KEYS))
    || !validationResultsAreExact
    || !hasExactEnumerableDataKeys(projection.materialization, MATERIALIZATION_KEYS)
    || projection.identity.documentVersion !== 2
    || projection.source.streamType !== "session"
    || projection.materialization.artifactKind !== "compatibility-session-log"
    || !["active", "suspended", "ending", "abandoned", "ended"].includes(projection.lifecycle.rootState)
  ) return integrity();
}

/** Renders the frozen Version 2 grammar. Buffer ownership transfers to the caller. */
export function renderCompatibilityLogV2(projection: CompatibilityLogProjectionV2): Buffer {
  try {
    assertProjectionShape(projection);
    const values = [
      canonicalJson(projection.identity),
      canonicalJson(projection.source),
      canonicalJson(projection.lifecycle),
      canonicalJson(projection.acceptedChildren),
      canonicalJson(projection.unresolvedFollowUps),
      canonicalJson(projection.finalCheckpoint),
      canonicalJson(projection.validation),
      canonicalJson(projection.materialization),
    ];
    const ending = projection.lifecycle.rootState === "ending"
      ? ["> SESSION ENDING"]
      : [];
    const document = [
      "# Compatibility Session Log v2",
      "",
      "## Identity",
      values[0]!,
      "",
      "## Source",
      values[1]!,
      "",
      "## Lifecycle",
      values[2]!,
      ...ending,
      "",
      "## Accepted Children",
      values[3]!,
      "",
      "## Unresolved Follow-ups",
      values[4]!,
      "",
      "## Final Checkpoint",
      values[5]!,
      "",
      "## Validation",
      values[6]!,
      "",
      "## Materialization",
      values[7]!,
      "",
    ].join("\n");
    return Buffer.from(document, "utf8");
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}
