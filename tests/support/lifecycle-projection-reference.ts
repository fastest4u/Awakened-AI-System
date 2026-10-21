import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/orchestrator/serialization/canonical-json.js";

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

export interface ReferenceChildEventFold {
  readonly projectId: string;
  readonly childSessionId: string;
  readonly eventPosition: bigint;
  readonly streamVersion: bigint;
  readonly rootSessionId: string;
  readonly childState:
    | "active"
    | "completion-proposed"
    | "completed"
    | "suspended"
    | "transferred";
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
}

export interface ReferenceWorkflowGenerationFold {
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
  readonly previousFingerprint: string | null;
}

function fingerprint(domain: string, tuple: readonly unknown[]): string {
  return createHash("sha256")
    .update(Buffer.from(domain, "utf8"))
    .update(Buffer.from(canonicalJson(tuple), "utf8"))
    .digest("hex");
}

export function referenceReportItemSetFingerprint(input: {
  readonly projectId: string;
  readonly childSessionId: string;
  readonly reportId: string;
  readonly allReportItemIds: readonly string[];
}): string {
  if (new Set(input.allReportItemIds).size !== input.allReportItemIds.length) {
    throw new TypeError("report item identifiers must be a set");
  }
  const sorted = [...input.allReportItemIds].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  return fingerprint(REPORT_ITEM_SET_DOMAIN, [
    input.projectId,
    input.childSessionId,
    input.reportId,
    sorted,
  ]);
}

export function referenceReportWitnessFingerprint(row: Pick<
  ReferenceChildEventFold,
  | "projectId"
  | "childSessionId"
  | "eventPosition"
  | "streamVersion"
  | "reportedReportId"
  | "reportedItemCount"
  | "reportedItemSetFingerprint"
>): string {
  return fingerprint(REPORT_WITNESS_DOMAIN, [
    row.projectId,
    row.childSessionId,
    row.eventPosition.toString(),
    row.streamVersion.toString(),
    row.reportedReportId,
    row.reportedItemCount,
    row.reportedItemSetFingerprint,
  ]);
}

export function referenceReportIndexGenesisFingerprint(
  projectId: string,
  childSessionId: string,
): string {
  return fingerprint(REPORT_INDEX_DOMAIN, [
    projectId,
    childSessionId,
    0,
    null,
    null,
    null,
  ]);
}

export function referenceAdvanceReportIndexFingerprint(input: {
  readonly projectId: string;
  readonly childSessionId: string;
  readonly reportCount: number;
  readonly latestReportId: string;
  readonly previousReportIndexFingerprint: string;
  readonly reportWitnessFingerprint: string;
}): string {
  return fingerprint(REPORT_INDEX_DOMAIN, [
    input.projectId,
    input.childSessionId,
    input.reportCount,
    input.latestReportId,
    input.previousReportIndexFingerprint,
    input.reportWitnessFingerprint,
  ]);
}

export function referenceChildEventFoldFingerprint(
  row: ReferenceChildEventFold,
): string {
  return fingerprint(CHILD_EVENT_FOLD_DOMAIN, [
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

export function referenceWorkflowGenerationFingerprint(
  row: ReferenceWorkflowGenerationFold,
): string {
  return fingerprint(WORKFLOW_GENERATION_DOMAIN, [
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
