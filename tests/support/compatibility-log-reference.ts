import { createHash } from "node:crypto";

type ReferenceMaterialConfidence = "high" | "medium" | "low" | "guess";
type ReferenceReportCategory =
  | "findings"
  | "proposedDecisions"
  | "filesObservedOrChanged"
  | "verificationPerformed"
  | "openFollowUps"
  | "blockers";

interface ReferenceIdentity {
  readonly documentVersion: 2;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly branchScopeId: string | null;
  readonly branchRef: string | null;
  readonly sessionId: string;
  readonly startedAt: string;
}

interface ReferenceSource {
  readonly streamId: string;
  readonly streamType: "session";
  readonly startEventPosition: string;
  readonly throughEventPosition: string;
}

interface ReferenceLifecycle {
  readonly rootState: "active" | "suspended" | "ending" | "abandoned" | "ended";
  readonly workflowId: string | null;
  readonly workflowGeneration: number | null;
  readonly childEndPolicy: "require-completed" | "suspend-and-carry-forward" | null;
  readonly evidenceWindowState: "open" | "sealed" | null;
}

interface ReferenceAcceptedChildItem {
  readonly childSessionId: string;
  readonly reportId: string;
  readonly category: ReferenceReportCategory;
  readonly itemIndex: number;
  readonly itemId: string;
  readonly summary: string;
  readonly evidenceReferences: readonly string[];
  readonly confidence: ReferenceMaterialConfidence;
}

type ReferenceUnresolvedFollowUp =
  | {
      readonly kind: "deferred-child-item" | "rejected-child-item";
      readonly sourceChildSessionId: string;
      readonly reportId: string;
      readonly category: ReferenceReportCategory;
      readonly itemIndex: number;
      readonly itemId: string;
      readonly summary: string;
      readonly evidenceReferences: readonly string[];
      readonly confidence: ReferenceMaterialConfidence;
    }
  | {
      readonly kind: "carry-forward-ticket";
      readonly sourceChildSessionId: string;
      readonly transferTicketId: string;
      readonly checkpointId: string;
      readonly blockers: readonly string[];
      readonly followUps: readonly string[];
    };

interface ReferenceSourceState {
  readonly sourceStateScopeVersion: 1;
  readonly workspaceId: string;
  readonly branchRef: string | null;
  readonly headCommit: string;
  readonly dirtyWorktreeFingerprint: string;
}

interface ReferenceMissingInterval {
  readonly firstOrdinal: string;
  readonly lastOrdinal: string;
}

interface ReferenceCheckpoint {
  readonly checkpointVersion: 1 | 2;
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly parentSessionId: null;
  readonly baseEventPosition: string;
  readonly checkpointEventPosition: string;
  readonly createdAt: string;
  readonly creatorAgentId: string;
  readonly creatorClientInstanceId: string;
  readonly taskSummary: string;
  readonly completedItems: readonly Readonly<{ readonly confidence: ReferenceMaterialConfidence; readonly summary: string }>[];
  readonly inProgressItems: readonly unknown[];
  readonly nextActions: readonly unknown[];
  readonly blockers: readonly unknown[];
  readonly decisions: readonly unknown[];
  readonly assumptions: readonly unknown[];
  readonly filesTouched: readonly unknown[];
  readonly verificationPerformed: readonly unknown[];
  readonly testResults: readonly unknown[];
  readonly materialClaims: readonly unknown[];
  readonly sourceReferences: readonly unknown[];
  readonly artifactReferences: readonly unknown[];
  readonly unresolvedConflicts: readonly unknown[];
  readonly commandResults: readonly unknown[];
  readonly childSummaries: readonly unknown[];
  readonly sourceState: ReferenceSourceState;
  readonly evidenceCoverage:
    | {
        readonly captureMode: "coverage-only";
        readonly contentRetained: false;
        readonly highestContiguousOrdinal: string | null;
        readonly missingIntervals: readonly ReferenceMissingInterval[];
      }
    | {
        readonly coverageVersion: 2;
        readonly captureMode: "coverage-only";
        readonly contentRetained: false;
        readonly adapterSessions: readonly Readonly<{
          readonly adapterSessionId: string;
          readonly coverageFirstOrdinal: "0";
          readonly coverageLastOrdinal: string;
          readonly highestContiguousOrdinal: string | null;
          readonly missingIntervals: readonly ReferenceMissingInterval[];
          readonly latestBatchId: string;
          readonly latestBatchEventPosition: string;
        }>[];
      };
}

interface ReferenceFinalCheckpoint {
  readonly checkpointFingerprint: string;
  readonly checkpoint: ReferenceCheckpoint;
}

interface ReferenceValidationOutputFingerprint {
  readonly fingerprint: string;
  readonly fingerprintDomain: string;
  readonly fingerprintKeyId: string;
  readonly fingerprintSchemaVersion: number;
}

interface ReferenceValidationResult {
  readonly validationResultVersion: 1;
  readonly resultId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly workflowId: string;
  readonly workflowGeneration: number;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileConfigurationHash: string;
  readonly runnerId: string;
  readonly status: "passed" | "failed";
  readonly exitClassification: "passed" | "failed";
  readonly fresh: boolean;
  readonly summary: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly finalCheckpointId: string;
  readonly finalCheckpointFingerprint: string;
  readonly sourceStateAtStart: ReferenceSourceState;
  readonly sourceStateAtCompletion: ReferenceSourceState;
  readonly outputFingerprint: ReferenceValidationOutputFingerprint;
  readonly artifactReferences: readonly string[];
}

interface ReferenceValidation {
  readonly verificationStatus: "not-run" | "passed" | "failed" | "invalidated";
  readonly validationResultIds: readonly string[];
  readonly qualityScore: number | null;
  readonly safeFailureCode: string | null;
  readonly results: readonly ReferenceValidationResult[];
}

interface ReferenceMaterialization {
  readonly artifactKind: "compatibility-session-log";
  readonly artifactPath: string;
  readonly targetKey: string;
  readonly materializationRevision: string;
  readonly triggeringEventType:
    | "SessionEndAmended"
    | "SessionEndVerificationFailed"
    | "SessionEndCancelled"
    | "SessionEndVerificationInvalidated"
    | "SessionAbandoned"
    | "SessionEnded";
  readonly triggeringEventSchemaVersion: number;
  readonly triggeringEventPosition: string;
  readonly triggeringPayloadHash: string;
}

export interface ReferenceProjection {
  readonly identity: ReferenceIdentity;
  readonly source: ReferenceSource;
  readonly lifecycle: ReferenceLifecycle;
  readonly acceptedChildren: readonly ReferenceAcceptedChildItem[];
  readonly unresolvedFollowUps: readonly ReferenceUnresolvedFollowUp[];
  readonly finalCheckpoint: ReferenceFinalCheckpoint | null;
  readonly validation: ReferenceValidation | null;
  readonly materialization: ReferenceMaterialization;
}

export interface CompatibilityLogReferenceCase {
  readonly fixtureName:
    | "ending-v2.md"
    | "failed-v2.md"
    | "cancelled-v2.md"
    | "invalidated-v2.md"
    | "abandoned-v2.md"
    | "completed-v2.md";
  readonly projection: ReferenceProjection;
  readonly literalUtf8: string;
  readonly byteLength: number;
  readonly sha256: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("REFERENCE_JSON_INVALID");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) throw new TypeError("REFERENCE_JSON_INVALID");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(record[key])}`
  )).join(",")}}`;
}

export function renderCompatibilityLogReference(
  projection: ReferenceProjection,
): string {
  const lifecycle = projection.lifecycle;
  return [
    "# Compatibility Session Log v2",
    "",
    "## Identity",
    canonical(projection.identity),
    "",
    "## Source",
    canonical(projection.source),
    "",
    "## Lifecycle",
    canonical(lifecycle),
    ...(lifecycle.rootState === "ending" ? ["> SESSION ENDING"] : []),
    "",
    "## Accepted Children",
    canonical(projection.acceptedChildren),
    "",
    "## Unresolved Follow-ups",
    canonical(projection.unresolvedFollowUps),
    "",
    "## Final Checkpoint",
    canonical(projection.finalCheckpoint),
    "",
    "## Validation",
    canonical(projection.validation),
    "",
    "## Materialization",
    canonical(projection.materialization),
    "",
  ].join("\n");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const endingProjection = deepFreeze({
  identity: { branchRef: "refs/heads/main", branchScopeId: null, documentVersion: 2, projectId: "11111111-1111-4111-8111-111111111111", sessionId: "44444444-4444-4444-8444-444444444444", startedAt: "2026-08-09T00:00:00.000Z", storeId: "33333333-3333-4333-8333-333333333333", vaultId: "22222222-2222-4222-8222-222222222222", workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  source: { startEventPosition: "1", streamId: "session/44444444-4444-4444-8444-444444444444", streamType: "session", throughEventPosition: "7" },
  lifecycle: { childEndPolicy: "suspend-and-carry-forward", evidenceWindowState: "open", rootState: "ending", workflowGeneration: 2, workflowId: "b6c2d359-82a6-567e-86c7-bf9e780cf20b" },
  acceptedChildren: [],
  unresolvedFollowUps: [{ blockers: ["รอ \"API\""], checkpointId: "55555555-5555-4555-8555-555555555555", followUps: ["ทดสอบ\nซ้ำ"], kind: "carry-forward-ticket", sourceChildSessionId: "66666666-6666-4666-8666-666666666666", transferTicketId: "77777777-7777-4777-8777-777777777777" }],
  finalCheckpoint: null,
  validation: { qualityScore: null, results: [], safeFailureCode: null, validationResultIds: [], verificationStatus: "not-run" },
  materialization: { artifactKind: "compatibility-session-log", artifactPath: "05_Agent_Session_Logs/2026-08-09-session-44444444-4444-4444-8444-444444444444.md", materializationRevision: "7", targetKey: "lifecycle-log/44444444-4444-4444-8444-444444444444/7", triggeringEventPosition: "7", triggeringEventSchemaVersion: 3, triggeringEventType: "SessionEndAmended", triggeringPayloadHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
} satisfies ReferenceProjection);

const failedProjection = deepFreeze({
  identity: { branchRef: "refs/heads/main", branchScopeId: null, documentVersion: 2, projectId: "11111111-1111-4111-8111-111111111111", sessionId: "44444444-4444-4444-8444-444444444444", startedAt: "2026-08-09T00:00:00.000Z", storeId: "33333333-3333-4333-8333-333333333333", vaultId: "22222222-2222-4222-8222-222222222222", workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  source: { startEventPosition: "1", streamId: "session/44444444-4444-4444-8444-444444444444", streamType: "session", throughEventPosition: "21" },
  lifecycle: { childEndPolicy: "require-completed", evidenceWindowState: "sealed", rootState: "ending", workflowGeneration: 1, workflowId: "b6c2d359-82a6-567e-86c7-bf9e780cf20b" },
  acceptedChildren: [{ category: "findings", childSessionId: "66666666-6666-4666-8666-666666666666", confidence: "high", evidenceReferences: ["artifact://accepted"], itemId: "10101010-1010-4010-8010-101010101010", itemIndex: 0, reportId: "99999999-9999-4999-8999-999999999999", summary: "Accepted child finding" }],
  unresolvedFollowUps: [{ category: "blockers", confidence: "medium", evidenceReferences: ["artifact://rejected"], itemId: "20202020-2020-4020-8020-202020202020", itemIndex: 1, kind: "rejected-child-item", reportId: "99999999-9999-4999-8999-999999999999", sourceChildSessionId: "66666666-6666-4666-8666-666666666666", summary: "Rejected blocker" }],
  finalCheckpoint: { checkpoint: { artifactReferences: [], assumptions: [], baseEventPosition: "16", blockers: [], childSummaries: [], checkpointEventPosition: "17", checkpointId: "55555555-5555-4555-8555-555555555555", checkpointVersion: 1, commandResults: [], completedItems: [{ confidence: "high", summary: "Children resolved" }], createdAt: "2026-08-09T00:17:00.000Z", creatorAgentId: "agent-primary", creatorClientInstanceId: "client-primary", decisions: [], evidenceCoverage: { captureMode: "coverage-only", contentRetained: false, highestContiguousOrdinal: "4", missingIntervals: [] }, filesTouched: [], inProgressItems: [], materialClaims: [], nextActions: [], parentSessionId: null, sessionId: "44444444-4444-4444-8444-444444444444", sourceReferences: [], sourceState: { branchRef: "refs/heads/main", dirtyWorktreeFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceStateScopeVersion: 1, workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, taskSummary: "Final checkpoint v1", testResults: [], unresolvedConflicts: [], verificationPerformed: [] }, checkpointFingerprint: "f0299b2cd2a07329988301c16fd34e7c395e5976f91e5b9a93bdd519189b4571" },
  validation: { qualityScore: null, results: [{ artifactReferences: ["artifact://validation/fail"], completedAt: "2026-08-09T00:19:00.000Z", exitClassification: "failed", finalCheckpointFingerprint: "f0299b2cd2a07329988301c16fd34e7c395e5976f91e5b9a93bdd519189b4571", finalCheckpointId: "55555555-5555-4555-8555-555555555555", fresh: true, outputFingerprint: { fingerprint: "abababababababababababababababababababababababababababababababab", fingerprintDomain: "pm-validation-output-v1", fingerprintKeyId: "validation-key", fingerprintSchemaVersion: 1 }, profileConfigurationHash: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", profileId: "safety", profileVersion: 1, projectId: "11111111-1111-4111-8111-111111111111", resultId: "30303030-3030-4030-8030-303030303030", runId: "40404040-4040-4040-8040-404040404040", runnerId: "validator-a", sessionId: "44444444-4444-4444-8444-444444444444", sourceStateAtCompletion: { branchRef: "refs/heads/main", dirtyWorktreeFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceStateScopeVersion: 1, workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, sourceStateAtStart: { branchRef: "refs/heads/main", dirtyWorktreeFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceStateScopeVersion: 1, workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, startedAt: "2026-08-09T00:18:00.000Z", status: "failed", storeId: "33333333-3333-4333-8333-333333333333", summary: "Validation failed safely", validationResultVersion: 1, vaultId: "22222222-2222-4222-8222-222222222222", workflowGeneration: 1, workflowId: "b6c2d359-82a6-567e-86c7-bf9e780cf20b", workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }], safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT", validationResultIds: ["30303030-3030-4030-8030-303030303030"], verificationStatus: "failed" },
  materialization: { artifactKind: "compatibility-session-log", artifactPath: "05_Agent_Session_Logs/2026-08-09-session-44444444-4444-4444-8444-444444444444.md", materializationRevision: "21", targetKey: "lifecycle-log/44444444-4444-4444-8444-444444444444/21", triggeringEventPosition: "21", triggeringEventSchemaVersion: 1, triggeringEventType: "SessionEndVerificationFailed", triggeringPayloadHash: "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1" },
} satisfies ReferenceProjection);

const cancelledProjection = deepFreeze({
  identity: { branchRef: "refs/heads/main", branchScopeId: null, documentVersion: 2, projectId: "11111111-1111-4111-8111-111111111111", sessionId: "44444444-4444-4444-8444-444444444444", startedAt: "2026-08-09T00:00:00.000Z", storeId: "33333333-3333-4333-8333-333333333333", vaultId: "22222222-2222-4222-8222-222222222222", workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  source: { startEventPosition: "1", streamId: "session/44444444-4444-4444-8444-444444444444", streamType: "session", throughEventPosition: "24" },
  lifecycle: { childEndPolicy: null, evidenceWindowState: null, rootState: "active", workflowGeneration: 2, workflowId: "b6c2d359-82a6-567e-86c7-bf9e780cf20b" },
  acceptedChildren: [{ category: "verificationPerformed", childSessionId: "66666666-6666-4666-8666-666666666666", confidence: "high", evidenceReferences: ["test://live"], itemId: "50505050-5050-4050-8050-505050505050", itemIndex: 0, reportId: "60606060-6060-4060-8060-606060606060", summary: "Live cancellation check" }],
  unresolvedFollowUps: [{ blockers: ["await owner"], checkpointId: "55555555-5555-4555-8555-555555555555", followUps: ["resume child"], kind: "carry-forward-ticket", sourceChildSessionId: "88888888-8888-4888-8888-888888888888", transferTicketId: "77777777-7777-4777-8777-777777777777" }],
  finalCheckpoint: null,
  validation: { qualityScore: null, results: [], safeFailureCode: null, validationResultIds: [], verificationStatus: "not-run" },
  materialization: { artifactKind: "compatibility-session-log", artifactPath: "05_Agent_Session_Logs/2026-08-09-session-44444444-4444-4444-8444-444444444444.md", materializationRevision: "24", targetKey: "lifecycle-log/44444444-4444-4444-8444-444444444444/24", triggeringEventPosition: "24", triggeringEventSchemaVersion: 3, triggeringEventType: "SessionEndCancelled", triggeringPayloadHash: "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2" },
} satisfies ReferenceProjection);

const invalidatedProjection = deepFreeze({
  identity: { branchRef: "refs/heads/main", branchScopeId: null, documentVersion: 2, projectId: "11111111-1111-4111-8111-111111111111", sessionId: "44444444-4444-4444-8444-444444444444", startedAt: "2026-08-09T00:00:00.000Z", storeId: "33333333-3333-4333-8333-333333333333", vaultId: "22222222-2222-4222-8222-222222222222", workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  source: { startEventPosition: "1", streamId: "session/44444444-4444-4444-8444-444444444444", streamType: "session", throughEventPosition: "31" },
  lifecycle: { childEndPolicy: "suspend-and-carry-forward", evidenceWindowState: "sealed", rootState: "ending", workflowGeneration: 3, workflowId: "b6c2d359-82a6-567e-86c7-bf9e780cf20b" },
  acceptedChildren: [{ category: "proposedDecisions", childSessionId: "66666666-6666-4666-8666-666666666666", confidence: "high", evidenceReferences: ["decision://frozen"], itemId: "70707070-7070-4070-8070-707070707070", itemIndex: 0, reportId: "80808080-8080-4080-8080-808080808080", summary: "Frozen accepted decision" }],
  unresolvedFollowUps: [{ blockers: ["frozen blocker"], checkpointId: "55555555-5555-4555-8555-555555555555", followUps: ["frozen follow-up"], kind: "carry-forward-ticket", sourceChildSessionId: "88888888-8888-4888-8888-888888888888", transferTicketId: "77777777-7777-4777-8777-777777777777" }],
  finalCheckpoint: { checkpoint: { artifactReferences: [], assumptions: [], baseEventPosition: "26", blockers: [], childSummaries: [], checkpointEventPosition: "27", checkpointId: "55555555-5555-4555-8555-555555555555", checkpointVersion: 2, commandResults: [], completedItems: [{ confidence: "high", summary: "Qualified final checkpoint" }], createdAt: "2026-08-09T00:27:00.000Z", creatorAgentId: "agent-primary", creatorClientInstanceId: "client-primary", decisions: [], evidenceCoverage: { adapterSessions: [{ adapterSessionId: "91919191-9191-4191-8191-919191919191", coverageFirstOrdinal: "0", coverageLastOrdinal: "9", highestContiguousOrdinal: "7", latestBatchEventPosition: "25", latestBatchId: "92929292-9292-4292-8292-929292929292", missingIntervals: [{ firstOrdinal: "8", lastOrdinal: "9" }] }], captureMode: "coverage-only", contentRetained: false, coverageVersion: 2 }, filesTouched: [], inProgressItems: [], materialClaims: [], nextActions: [], parentSessionId: null, sessionId: "44444444-4444-4444-8444-444444444444", sourceReferences: [], sourceState: { branchRef: "refs/heads/main", dirtyWorktreeFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceStateScopeVersion: 1, workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, taskSummary: "Final checkpoint v2", testResults: [], unresolvedConflicts: [], verificationPerformed: [] }, checkpointFingerprint: "80af5603ea38e04b6a1255e6f2f44d1d405da52ba30de2b0475e7e89997bb8c4" },
  validation: { qualityScore: null, results: [{ artifactReferences: ["artifact://validation/pass"], completedAt: "2026-08-09T00:29:00.000Z", exitClassification: "passed", finalCheckpointFingerprint: "80af5603ea38e04b6a1255e6f2f44d1d405da52ba30de2b0475e7e89997bb8c4", finalCheckpointId: "55555555-5555-4555-8555-555555555555", fresh: true, outputFingerprint: { fingerprint: "abababababababababababababababababababababababababababababababab", fingerprintDomain: "pm-validation-output-v1", fingerprintKeyId: "validation-key", fingerprintSchemaVersion: 1 }, profileConfigurationHash: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", profileId: "quality", profileVersion: 2, projectId: "11111111-1111-4111-8111-111111111111", resultId: "93939393-9393-4393-8393-939393939393", runId: "94949494-9494-4494-8494-949494949494", runnerId: "validator-b", sessionId: "44444444-4444-4444-8444-444444444444", sourceStateAtCompletion: { branchRef: "refs/heads/main", dirtyWorktreeFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceStateScopeVersion: 1, workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, sourceStateAtStart: { branchRef: "refs/heads/main", dirtyWorktreeFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceStateScopeVersion: 1, workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, startedAt: "2026-08-09T00:28:00.000Z", status: "passed", storeId: "33333333-3333-4333-8333-333333333333", summary: "Validation passed", validationResultVersion: 1, vaultId: "22222222-2222-4222-8222-222222222222", workflowGeneration: 3, workflowId: "b6c2d359-82a6-567e-86c7-bf9e780cf20b", workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }], safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT", validationResultIds: ["93939393-9393-4393-8393-939393939393"], verificationStatus: "invalidated" },
  materialization: { artifactKind: "compatibility-session-log", artifactPath: "05_Agent_Session_Logs/2026-08-09-session-44444444-4444-4444-8444-444444444444.md", materializationRevision: "31", targetKey: "lifecycle-log/44444444-4444-4444-8444-444444444444/31", triggeringEventPosition: "31", triggeringEventSchemaVersion: 1, triggeringEventType: "SessionEndVerificationInvalidated", triggeringPayloadHash: "d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3" },
} satisfies ReferenceProjection);

const abandonedProjection = deepFreeze({
  identity: { branchRef: "refs/heads/main", branchScopeId: null, documentVersion: 2, projectId: "11111111-1111-4111-8111-111111111111", sessionId: "44444444-4444-4444-8444-444444444444", startedAt: "2026-08-09T00:00:00.000Z", storeId: "33333333-3333-4333-8333-333333333333", vaultId: "22222222-2222-4222-8222-222222222222", workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  source: { startEventPosition: "1", streamId: "session/44444444-4444-4444-8444-444444444444", streamType: "session", throughEventPosition: "34" },
  lifecycle: { childEndPolicy: null, evidenceWindowState: null, rootState: "abandoned", workflowGeneration: null, workflowId: null },
  acceptedChildren: [],
  unresolvedFollowUps: [{ category: "openFollowUps", confidence: "guess", evidenceReferences: [], itemId: "95959595-9595-4595-8595-959595959595", itemIndex: 0, kind: "deferred-child-item", reportId: "96969696-9696-4696-8696-969696969696", sourceChildSessionId: "66666666-6666-4666-8666-666666666666", summary: "Live unresolved follow-up" }, { blockers: ["live blocker"], checkpointId: "57575757-5757-4757-8757-575757575757", followUps: ["live ticket follow-up"], kind: "carry-forward-ticket", sourceChildSessionId: "88888888-8888-4888-8888-888888888888", transferTicketId: "78787878-7878-4787-8787-787878787878" }],
  finalCheckpoint: null,
  validation: null,
  materialization: { artifactKind: "compatibility-session-log", artifactPath: "05_Agent_Session_Logs/2026-08-09-session-44444444-4444-4444-8444-444444444444.md", materializationRevision: "34", targetKey: "lifecycle-log/44444444-4444-4444-8444-444444444444/34", triggeringEventPosition: "34", triggeringEventSchemaVersion: 1, triggeringEventType: "SessionAbandoned", triggeringPayloadHash: "a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4" },
} satisfies ReferenceProjection);

const completedProjection = deepFreeze({
  identity: { branchRef: "refs/heads/main", branchScopeId: null, documentVersion: 2, projectId: "11111111-1111-4111-8111-111111111111", sessionId: "44444444-4444-4444-8444-444444444444", startedAt: "2026-08-09T00:00:00.000Z", storeId: "33333333-3333-4333-8333-333333333333", vaultId: "22222222-2222-4222-8222-222222222222", workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  source: { startEventPosition: "1", streamId: "session/44444444-4444-4444-8444-444444444444", streamType: "session", throughEventPosition: "33" },
  lifecycle: { childEndPolicy: "suspend-and-carry-forward", evidenceWindowState: "sealed", rootState: "ended", workflowGeneration: 3, workflowId: "b6c2d359-82a6-567e-86c7-bf9e780cf20b" },
  acceptedChildren: [{ category: "proposedDecisions", childSessionId: "66666666-6666-4666-8666-666666666666", confidence: "high", evidenceReferences: ["decision://frozen"], itemId: "70707070-7070-4070-8070-707070707070", itemIndex: 0, reportId: "80808080-8080-4080-8080-808080808080", summary: "Frozen accepted decision" }],
  unresolvedFollowUps: [{ blockers: ["frozen blocker"], checkpointId: "55555555-5555-4555-8555-555555555555", followUps: ["frozen follow-up"], kind: "carry-forward-ticket", sourceChildSessionId: "88888888-8888-4888-8888-888888888888", transferTicketId: "77777777-7777-4777-8777-777777777777" }],
  finalCheckpoint: { checkpoint: { artifactReferences: [], assumptions: [], baseEventPosition: "26", blockers: [], childSummaries: [], checkpointEventPosition: "27", checkpointId: "55555555-5555-4555-8555-555555555555", checkpointVersion: 2, commandResults: [], completedItems: [{ confidence: "high", summary: "Qualified final checkpoint" }], createdAt: "2026-08-09T00:27:00.000Z", creatorAgentId: "agent-primary", creatorClientInstanceId: "client-primary", decisions: [], evidenceCoverage: { adapterSessions: [{ adapterSessionId: "91919191-9191-4191-8191-919191919191", coverageFirstOrdinal: "0", coverageLastOrdinal: "9", highestContiguousOrdinal: "7", latestBatchEventPosition: "25", latestBatchId: "92929292-9292-4292-8292-929292929292", missingIntervals: [{ firstOrdinal: "8", lastOrdinal: "9" }] }], captureMode: "coverage-only", contentRetained: false, coverageVersion: 2 }, filesTouched: [], inProgressItems: [], materialClaims: [], nextActions: [], parentSessionId: null, sessionId: "44444444-4444-4444-8444-444444444444", sourceReferences: [], sourceState: { branchRef: "refs/heads/main", dirtyWorktreeFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceStateScopeVersion: 1, workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, taskSummary: "Final checkpoint v2", testResults: [], unresolvedConflicts: [], verificationPerformed: [] }, checkpointFingerprint: "80af5603ea38e04b6a1255e6f2f44d1d405da52ba30de2b0475e7e89997bb8c4" },
  validation: { qualityScore: 9800, results: [{ artifactReferences: ["artifact://validation/pass"], completedAt: "2026-08-09T00:29:00.000Z", exitClassification: "passed", finalCheckpointFingerprint: "80af5603ea38e04b6a1255e6f2f44d1d405da52ba30de2b0475e7e89997bb8c4", finalCheckpointId: "55555555-5555-4555-8555-555555555555", fresh: true, outputFingerprint: { fingerprint: "abababababababababababababababababababababababababababababababab", fingerprintDomain: "pm-validation-output-v1", fingerprintKeyId: "validation-key", fingerprintSchemaVersion: 1 }, profileConfigurationHash: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", profileId: "quality", profileVersion: 2, projectId: "11111111-1111-4111-8111-111111111111", resultId: "93939393-9393-4393-8393-939393939393", runId: "94949494-9494-4494-8494-949494949494", runnerId: "validator-b", sessionId: "44444444-4444-4444-8444-444444444444", sourceStateAtCompletion: { branchRef: "refs/heads/main", dirtyWorktreeFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceStateScopeVersion: 1, workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, sourceStateAtStart: { branchRef: "refs/heads/main", dirtyWorktreeFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourceStateScopeVersion: 1, workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, startedAt: "2026-08-09T00:28:00.000Z", status: "passed", storeId: "33333333-3333-4333-8333-333333333333", summary: "Validation passed", validationResultVersion: 1, vaultId: "22222222-2222-4222-8222-222222222222", workflowGeneration: 3, workflowId: "b6c2d359-82a6-567e-86c7-bf9e780cf20b", workspaceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }], safeFailureCode: null, validationResultIds: ["93939393-9393-4393-8393-939393939393"], verificationStatus: "passed" },
  materialization: { artifactKind: "compatibility-session-log", artifactPath: "05_Agent_Session_Logs/2026-08-09-session-44444444-4444-4444-8444-444444444444.md", materializationRevision: "33", targetKey: "lifecycle-log/44444444-4444-4444-8444-444444444444/33", triggeringEventPosition: "33", triggeringEventSchemaVersion: 1, triggeringEventType: "SessionEnded", triggeringPayloadHash: "b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5" },
} satisfies ReferenceProjection);

const CASES = [
  { fixtureName: "ending-v2.md", projection: endingProjection, byteLength: 1729, sha256: "9c8c7650657a0f9f2c7a8828dedfad89bbff44f25d87cac1e51b1d2a539e72ce" },
  { fixtureName: "failed-v2.md", projection: failedProjection, byteLength: 5247, sha256: "f82170e31f84e303cbd2384d82bd68b16fdd3a8c5e567a3e19f523b648427672" },
  { fixtureName: "cancelled-v2.md", projection: cancelledProjection, byteLength: 1973, sha256: "807d392a26913123179190de75535aa510680d518b24c93cae60a7a63f1c3357" },
  { fixtureName: "invalidated-v2.md", projection: invalidatedProjection, byteLength: 5499, sha256: "4acfd832761200882cb076bf2e188e6aa5e83049aa821ba275e13285bf46823a" },
  { fixtureName: "abandoned-v2.md", projection: abandonedProjection, byteLength: 1861, sha256: "dce1805efa93da3e0e3b0f8458bfe12c1f959203300fed8ce973843e0cdbf29c" },
  { fixtureName: "completed-v2.md", projection: completedProjection, byteLength: 5428, sha256: "00f05d442d0949eb714314fdf4858a6ebb4e267d8ab561628ef479b2440122c5" },
] as const;

export function compatibilityLogReferenceCases(): readonly CompatibilityLogReferenceCase[] {
  return Object.freeze(CASES.map((item) => Object.freeze({
    fixtureName: item.fixtureName,
    projection: item.projection,
    literalUtf8: renderCompatibilityLogReference(item.projection),
    byteLength: item.byteLength,
    sha256: item.sha256,
  })));
}

export function referenceSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
