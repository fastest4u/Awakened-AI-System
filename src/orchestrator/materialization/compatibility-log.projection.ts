import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { payloadHash } from "../crypto/event-hash.js";
import type { Checkpoint, CheckpointChildSummaryV1 } from "../lifecycle/contracts/checkpoint.js";
import type { ChildDispositionV1, ChildReportV1 } from "../lifecycle/contracts/child.js";
import {
  decodeLifecycleEventPayload,
  type LifecycleEventCodecResult,
} from "../lifecycle/contracts/events.js";
import type {
  ChildEndPolicy,
  SessionId,
  ValidationResultId,
  WorkflowId,
} from "../lifecycle/contracts/identifiers.js";
import { decodeSessionEndEffectiveStateV1 } from "../lifecycle/session-end-effective-state.js";
import { LifecycleError } from "../lifecycle/errors.js";
import type {
  LifecycleRenderClosureV1,
  LifecycleRenderEventV1,
  LifecycleRenderTriggerV1,
} from "../lifecycle/materialization-queue.port.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type {
  CompatibilityLogAcceptedChildItemV2,
  CompatibilityLogFinalCheckpointV2,
  CompatibilityLogProjectionV2,
  CompatibilityLogReportCategoryV2,
  CompatibilityLogUnresolvedFollowUpV2,
  CompatibilityLogValidationV2,
} from "./compatibility-log.renderer.js";
import {
  deriveCompatibilityLogTarget,
  type CompatibilityLogTargetV1,
} from "./vault-artifact-path.js";

export interface CompatibilityLogProjectionInputV2 {
  readonly closure: LifecycleRenderClosureV1;
  readonly trigger: LifecycleRenderTriggerV1;
  readonly target: CompatibilityLogTargetV1;
}

type DecodedPayload = LifecycleEventCodecResult["payload"];

interface DecodedRenderEvent {
  readonly event: LifecycleRenderEventV1;
  readonly payload: DecodedPayload;
  readonly position: bigint;
  readonly streamVersion: bigint;
}

type ChildState = "active" | "completion-proposed" | "completed" | "suspended" | "transferred";

interface ReportFold {
  readonly report: ChildReportV1;
  readonly reportPosition: bigint;
  readonly dispositions: readonly Readonly<{
    disposition: ChildDispositionV1;
    position: bigint;
  }>[];
}

interface TicketFold {
  readonly sourceChildSessionId: SessionId;
  readonly transferTicketId: string;
  readonly checkpointId: string;
  readonly blockers: readonly string[];
  readonly followUps: readonly string[];
  readonly transferEventPosition: bigint;
}

interface ChildFold {
  readonly childSessionId: SessionId;
  readonly state: ChildState;
  readonly head: DecodedRenderEvent;
  readonly latestCheckpointId: string | null;
  readonly reports: readonly ReportFold[];
  readonly ticket: TicketFold | null;
}

interface ChildHistory {
  readonly childSessionId: SessionId;
  readonly events: readonly DecodedRenderEvent[];
  readonly full: ChildFold;
}

interface ClaimFold {
  readonly transferTicketId: string;
  readonly claimPosition: bigint;
}

interface ChildProjection {
  readonly acceptedChildren: readonly CompatibilityLogAcceptedChildItemV2[];
  readonly unresolvedFollowUps: readonly CompatibilityLogUnresolvedFollowUpV2[];
}

interface FrozenEndingEpoch extends ChildProjection {
  readonly finalCheckpoint: CompatibilityLogFinalCheckpointV2;
  readonly checkpointId: string;
  readonly checkpointFingerprint: string;
  readonly markerPosition: bigint;
  readonly markerWorkflowId: WorkflowId;
  readonly markerWorkflowGeneration: number;
}

type Verdict = "not-run" | "passed" | "failed" | "invalidated";

interface ValidationFold {
  readonly results: Map<string, any>;
  readonly plannedWorkIds: Set<string>;
  readonly runIds: Set<string>;
  readonly profileKeys: Set<string>;
  verdict: Verdict;
  qualityScore: number | null;
  safeFailureCode: string | null;
  passPosition: bigint | null;
}

interface WorkflowFold {
  id: WorkflowId;
  generation: number;
  childEndPolicy: ChildEndPolicy;
  evidenceWindowState: "open" | "sealed";
  validationProfileKeys: ReadonlySet<string>;
}

const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const REPORT_CATEGORIES = Object.freeze([
  "findings",
  "proposedDecisions",
  "filesObservedOrChanged",
  "verificationPerformed",
  "openFollowUps",
  "blockers",
] as const satisfies readonly CompatibilityLogReportCategoryV2[]);
const ROOT_EVENT_TYPES = new Set([
  "SessionStarted",
  "SessionOwnerTransferred",
  "SessionOwnershipRecovered",
  "SessionSuspendRequested",
  "SessionSuspended",
  "SessionResumed",
  "SessionCheckpointRecorded",
  "EvidenceCoverageRecorded",
  "SessionEndRequested",
  "SessionEndAmended",
  "SessionValidationResultRecorded",
  "SessionEndVerificationPassed",
  "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated",
  "SessionEndCancelled",
  "SessionAbandoned",
  "SessionEnded",
]);
const MATERIALIZATION_TRIGGER_TYPES = new Set([
  "SessionCheckpointRecorded",
  "SessionEndAmended",
  "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated",
  "SessionEndCancelled",
  "SessionAbandoned",
  "SessionEnded",
]);
const CHILD_EVENT_TYPES = new Set([
  "SessionForked",
  "SessionCheckpointRecorded",
  "EvidenceCoverageRecorded",
  "ChildAssignmentAmended",
  "ChildWorkReported",
  "ChildWorkDispositioned",
  "ChildCompletionProposed",
  "ChildSessionCompleted",
  "ChildSessionSuspended",
  "ChildWorkTransferCreated",
]);

function integrity(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return integrity();
    deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function binaryCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareAccepted(
  left: CompatibilityLogAcceptedChildItemV2,
  right: CompatibilityLogAcceptedChildItemV2,
): number {
  return binaryCompare(left.childSessionId, right.childSessionId)
    || binaryCompare(left.reportId, right.reportId)
    || binaryCompare(left.category, right.category)
    || left.itemIndex - right.itemIndex
    || binaryCompare(left.itemId, right.itemId);
}

function unresolvedTuple(value: CompatibilityLogUnresolvedFollowUpV2): readonly [string, string, string, string, number, string] {
  return value.kind === "carry-forward-ticket"
    ? [value.kind, value.sourceChildSessionId, value.transferTicketId, "", -1, ""]
    : [value.kind, value.sourceChildSessionId, value.reportId, value.category, value.itemIndex, value.itemId];
}

function compareUnresolved(
  left: CompatibilityLogUnresolvedFollowUpV2,
  right: CompatibilityLogUnresolvedFollowUpV2,
): number {
  const a = unresolvedTuple(left);
  const b = unresolvedTuple(right);
  return binaryCompare(a[0], b[0])
    || binaryCompare(a[1], b[1])
    || binaryCompare(a[2], b[2])
    || binaryCompare(a[3], b[3])
    || a[4] - b[4]
    || binaryCompare(a[5], b[5]);
}

function positiveDecimal(value: string): bigint {
  if (!POSITIVE_DECIMAL.test(value)) return integrity();
  return BigInt(value);
}

function decodeRenderEvent(event: LifecycleRenderEventV1): DecodedRenderEvent {
  const position = positiveDecimal(event.globalPosition);
  const streamVersion = positiveDecimal(event.streamVersion);
  if (!Number.isSafeInteger(event.eventSchemaVersion) || event.eventSchemaVersion < 1) return integrity();
  let payload: DecodedPayload;
  try {
    payload = decodeLifecycleEventPayload(event.eventType, event.eventSchemaVersion, event.payload);
  } catch {
    return integrity();
  }
  return Object.freeze({ event, payload, position, streamVersion });
}

function sameSourceContext(left: LifecycleRenderEventV1, right: LifecycleRenderEventV1): boolean {
  return left.projectId === right.projectId
    && left.vaultId === right.vaultId
    && left.storeId === right.storeId
    && left.workspaceId === right.workspaceId
    && left.branchScopeId === right.branchScopeId
    && left.branchRef === right.branchRef;
}

function sameStoreContext(left: LifecycleRenderEventV1, right: LifecycleRenderEventV1): boolean {
  return left.projectId === right.projectId
    && left.vaultId === right.vaultId
    && left.storeId === right.storeId;
}

function itemSetEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((item) => right.includes(item));
}

function foldChildPrefix(history: ChildHistory | { childSessionId: SessionId; events: readonly DecodedRenderEvent[] }, count: number): ChildFold {
  if (count < 1 || count > history.events.length) return integrity();
  const selected = history.events.slice(0, count);
  const first = selected[0]!;
  if (first.event.eventType !== "SessionForked" || first.streamVersion !== 1n) return integrity();
  let state: ChildState = "active";
  let completionReportId: string | null = null;
  let latestCheckpointId: string | null = null;
  let suspension: Readonly<{ checkpointId: string; blockers: readonly string[]; followUps: readonly string[] }> | null = null;
  let ticket: TicketFold | null = null;
  const reports = new Map<string, { report: ChildReportV1; reportPosition: bigint; dispositions: { disposition: ChildDispositionV1; position: bigint }[] }>();

  for (let index = 0; index < selected.length; index += 1) {
    const current = selected[index]!;
    if (current.streamVersion !== BigInt(index + 1) || !CHILD_EVENT_TYPES.has(current.event.eventType)) return integrity();
    if (index > 0 && (state === "completed" || state === "transferred")) return integrity();
    const payload = current.payload as any;
    switch (current.event.eventType) {
      case "SessionForked":
        if (index !== 0 || payload.parentSessionId !== current.event.parentSessionId) return integrity();
        break;
      case "SessionCheckpointRecorded": {
        const checkpoint = payload.checkpoint as Checkpoint;
        if (
          current.event.eventSchemaVersion === 3
          ||
          checkpoint.sessionId !== history.childSessionId
          || checkpoint.parentSessionId !== current.event.parentSessionId
          || checkpoint.checkpointEventPosition !== current.event.globalPosition
          || checkpoint.sourceState.workspaceId !== current.event.workspaceId
          || positiveDecimal(checkpoint.baseEventPosition) >= current.position
        ) return integrity();
        latestCheckpointId = checkpoint.checkpointId;
        break;
      }
      case "ChildWorkReported": {
        if (state !== "active" && state !== "completion-proposed") return integrity();
        const report = payload.report as ChildReportV1;
        if (
          report.childSessionId !== history.childSessionId
          || report.parentSessionId !== current.event.parentSessionId
          || reports.has(report.reportId)
        ) return integrity();
        reports.set(report.reportId, { report, reportPosition: current.position, dispositions: [] });
        break;
      }
      case "ChildWorkDispositioned": {
        if (state !== "active" && state !== "completion-proposed") return integrity();
        const disposition = payload.disposition as ChildDispositionV1;
        const report = reports.get(disposition.reportId);
        if (report === undefined || !itemSetEquals(report.report.allReportItemIds, disposition.allReportItemIds)) {
          return integrity();
        }
        if (report.dispositions.length === 0) {
          if (disposition.kind === "superseded") return integrity();
        } else if (report.dispositions.length === 1) {
          if (disposition.kind !== "superseded") return integrity();
          const target = disposition.supersededByReportId === null
            ? undefined
            : reports.get(disposition.supersededByReportId);
          if (
            target === undefined
            || target.reportPosition <= report.dispositions[0]!.position
            || target.reportPosition >= current.position
          ) return integrity();
        } else {
          return integrity();
        }
        report.dispositions.push({ disposition, position: current.position });
        if (
          state === "completion-proposed"
          && disposition.kind !== "accepted"
          && completionReportId === disposition.reportId
        ) {
          state = "active";
          completionReportId = null;
        }
        break;
      }
      case "ChildCompletionProposed":
        if (state !== "active" || !reports.has(payload.reportId)) return integrity();
        state = "completion-proposed";
        completionReportId = payload.reportId;
        break;
      case "ChildSessionCompleted":
        if (
          (state !== "active" && state !== "completion-proposed")
          || !reports.has(payload.reportId)
          || (state === "completion-proposed" && completionReportId !== payload.reportId)
        ) return integrity();
        state = "completed";
        completionReportId = null;
        break;
      case "ChildSessionSuspended":
        if (
          (state !== "active" && state !== "completion-proposed")
          || latestCheckpointId === null
          || payload.checkpointId !== latestCheckpointId
        ) return integrity();
        state = "suspended";
        completionReportId = null;
        suspension = Object.freeze({
          checkpointId: payload.checkpointId,
          blockers: payload.blockers,
          followUps: payload.followUps,
        });
        break;
      case "ChildWorkTransferCreated": {
        if (state !== "suspended" || suspension === null || ticket !== null) return integrity();
        const suspensionCheckpointId = current.event.eventSchemaVersion === 1
          ? payload.checkpointId
          : payload.suspensionCheckpointId;
        if (
          suspensionCheckpointId !== suspension.checkpointId
          || payload.checkpointId !== latestCheckpointId
        ) return integrity();
        state = "transferred";
        ticket = Object.freeze({
          sourceChildSessionId: history.childSessionId,
          transferTicketId: payload.transferTicketId,
          checkpointId: payload.checkpointId,
          blockers: suspension.blockers,
          followUps: suspension.followUps,
          transferEventPosition: current.position,
        });
        break;
      }
      case "EvidenceCoverageRecorded":
      case "ChildAssignmentAmended":
        break;
      default:
        return integrity();
    }
  }
  if ((ticket === null) !== (state !== "transferred")) return integrity();
  return Object.freeze({
    childSessionId: history.childSessionId,
    state,
    head: selected.at(-1)!,
    latestCheckpointId,
    reports: Object.freeze([...reports.values()].map((report) => Object.freeze({
      report: report.report,
      reportPosition: report.reportPosition,
      dispositions: Object.freeze(report.dispositions.map((item) => Object.freeze(item))),
    }))),
    ticket,
  });
}

function validateChildHistories(
  closure: LifecycleRenderClosureV1,
  root: LifecycleRenderEventV1,
  triggerPosition: bigint,
  occupiedPositions: Set<string>,
): readonly ChildHistory[] {
  const seenChildren = new Set<string>();
  const histories: ChildHistory[] = [];
  for (const group of closure.directChildren) {
    if (seenChildren.has(group.childSessionId) || group.events.length === 0) return integrity();
    seenChildren.add(group.childSessionId);
    const decoded = group.events.map(decodeRenderEvent);
    let previousPosition = 0n;
    for (let index = 0; index < decoded.length; index += 1) {
      const item = decoded[index]!;
      if (
        item.position >= triggerPosition
        || item.position <= previousPosition
        || item.streamVersion !== BigInt(index + 1)
        || item.event.sessionId !== group.childSessionId
        || item.event.parentSessionId !== root.sessionId
        || item.event.streamId !== `session/${group.childSessionId}`
        || !sameSourceContext(item.event, root)
        || item.event.materializationOrigin !== null
        || occupiedPositions.has(item.event.globalPosition)
      ) return integrity();
      previousPosition = item.position;
      occupiedPositions.add(item.event.globalPosition);
    }
    const seed = { childSessionId: group.childSessionId, events: Object.freeze(decoded) };
    histories.push(Object.freeze({ ...seed, full: foldChildPrefix(seed, decoded.length) }));
  }
  return Object.freeze(histories);
}

function validateClaims(
  closure: LifecycleRenderClosureV1,
  root: LifecycleRenderEventV1,
  triggerPosition: bigint,
  tickets: ReadonlyMap<string, TicketFold>,
  occupiedPositions: Set<string>,
): readonly ClaimFold[] {
  const claimed = new Set<string>();
  const claims: ClaimFold[] = [];
  for (const pair of closure.foreignClaims) {
    const fork = decodeRenderEvent(pair.fork);
    const claim = decodeRenderEvent(pair.claim);
    const forkPayload = fork.payload as any;
    const claimPayload = claim.payload as any;
    const ticket = tickets.get(claimPayload.transferTicketId);
    if (
      fork.event.eventType !== "SessionForked"
      || claim.event.eventType !== "ChildWorkTransferClaimed"
      || fork.streamVersion !== 1n
      || claim.streamVersion !== 2n
      || fork.event.streamId !== claim.event.streamId
      || fork.event.sessionId !== claim.event.sessionId
      || fork.event.parentSessionId !== claim.event.parentSessionId
      || fork.event.parentSessionId === null
      || fork.event.streamId !== `session/${fork.event.sessionId}`
      || !sameStoreContext(fork.event, root)
      || !sameStoreContext(claim.event, root)
      || !sameSourceContext(fork.event, claim.event)
      || fork.event.materializationOrigin !== null
      || claim.event.materializationOrigin !== null
      || claim.position !== fork.position + 1n
      || claim.position >= triggerPosition
      || ticket === undefined
      || ticket.transferEventPosition >= fork.position
      || forkPayload.parentSessionId !== fork.event.parentSessionId
      || forkPayload.sourceTransferTicketId !== claimPayload.transferTicketId
      || claimPayload.previousChildSessionId !== ticket.sourceChildSessionId
      || positiveDecimal(claimPayload.previousTransferEventPosition) !== ticket.transferEventPosition
      || claimed.has(claimPayload.transferTicketId)
      || occupiedPositions.has(fork.event.globalPosition)
      || occupiedPositions.has(claim.event.globalPosition)
    ) return integrity();
    claimed.add(claimPayload.transferTicketId);
    occupiedPositions.add(fork.event.globalPosition);
    occupiedPositions.add(claim.event.globalPosition);
    claims.push(Object.freeze({
      transferTicketId: claimPayload.transferTicketId,
      claimPosition: claim.position,
    }));
  }
  return Object.freeze(claims);
}

function selectedMarkerFolds(histories: readonly ChildHistory[], checkpoint: Checkpoint): readonly ChildFold[] {
  const base = positiveDecimal(checkpoint.baseEventPosition);
  const summaries = new Map<string, CheckpointChildSummaryV1>();
  for (const summary of checkpoint.childSummaries) {
    if (summaries.has(summary.childSessionId)) return integrity();
    summaries.set(summary.childSessionId, summary);
  }
  const selected: ChildFold[] = [];
  for (const history of histories) {
    const existedAtBase = history.events[0]!.position <= base;
    const summary = summaries.get(history.childSessionId);
    if (!existedAtBase) {
      if (summary !== undefined) return integrity();
      continue;
    }
    if (summary !== undefined) {
      if (summary.state !== "active" && summary.state !== "completion-proposed" && summary.state !== "suspended") {
        return integrity();
      }
      const headIndex = history.events.findIndex((event) => event.position.toString() === summary.lastEventPosition);
      if (headIndex < 0) return integrity();
      const head = history.events[headIndex]!;
      const laterAtBase = history.events.slice(headIndex + 1).some((event) => event.position <= base);
      const folded = foldChildPrefix(history, headIndex + 1);
      if (
        laterAtBase
        || head.position > base
        || head.streamVersion.toString() !== summary.streamVersion
        || folded.state !== summary.state
        || folded.latestCheckpointId !== summary.latestCheckpointId
      ) return integrity();
      selected.push(folded);
      summaries.delete(history.childSessionId);
      continue;
    }
    let terminalIndex = -1;
    for (let index = history.events.length - 1; index >= 0; index -= 1) {
      if (history.events[index]!.position < base) {
        terminalIndex = index;
        break;
      }
    }
    if (terminalIndex < 0) return integrity();
    const folded = foldChildPrefix(history, terminalIndex + 1);
    if (folded.state !== "completed" && folded.state !== "transferred") return integrity();
    selected.push(folded);
  }
  if (summaries.size !== 0) return integrity();
  return Object.freeze(selected);
}

function childItems(folds: readonly ChildFold[]): readonly CompatibilityLogAcceptedChildItemV2[] {
  const accepted: CompatibilityLogAcceptedChildItemV2[] = [];
  for (const child of folds) {
    for (const reportFold of child.reports) {
      const firstDisposition = reportFold.dispositions[0]?.disposition;
      const latestDisposition = reportFold.dispositions.at(-1)?.disposition;
      if (firstDisposition === undefined || latestDisposition?.kind === "superseded") continue;
      const acceptedIds = new Set(firstDisposition.acceptedItemIds);
      for (const category of REPORT_CATEGORIES) {
        const items = reportFold.report[category];
        for (const item of items) {
          const itemIndex = reportFold.report.allReportItemIds.indexOf(item.itemId);
          if (itemIndex < 0) return integrity();
          if (!acceptedIds.has(item.itemId)) continue;
          accepted.push(Object.freeze({
            childSessionId: child.childSessionId,
            reportId: reportFold.report.reportId,
            category,
            itemIndex,
            itemId: item.itemId,
            summary: item.summary,
            evidenceReferences: item.evidenceReferences,
            confidence: item.confidence,
          }));
        }
      }
    }
  }
  return Object.freeze(accepted.sort(compareAccepted));
}

function unresolvedChildItems(folds: readonly ChildFold[]): CompatibilityLogUnresolvedFollowUpV2[] {
  const unresolved: CompatibilityLogUnresolvedFollowUpV2[] = [];
  for (const child of folds) {
    for (const reportFold of child.reports) {
      const firstDisposition = reportFold.dispositions[0]?.disposition;
      const latestDisposition = reportFold.dispositions.at(-1)?.disposition;
      if (firstDisposition === undefined || latestDisposition?.kind === "superseded") continue;
      const rejected = new Set(firstDisposition.rejectedItemIds);
      const deferred = new Set(firstDisposition.deferredItemIds);
      for (const category of REPORT_CATEGORIES) {
        const items = reportFold.report[category];
        for (const item of items) {
          const itemIndex = reportFold.report.allReportItemIds.indexOf(item.itemId);
          if (itemIndex < 0) return integrity();
          const kind = rejected.has(item.itemId)
            ? "rejected-child-item" as const
            : deferred.has(item.itemId)
              ? "deferred-child-item" as const
              : null;
          if (kind === null) continue;
          unresolved.push(Object.freeze({
            kind,
            sourceChildSessionId: child.childSessionId,
            reportId: reportFold.report.reportId,
            category,
            itemIndex,
            itemId: item.itemId,
            summary: item.summary,
            evidenceReferences: item.evidenceReferences,
            confidence: item.confidence,
          }));
        }
      }
    }
  }
  return unresolved;
}

function projectChildScope(
  histories: readonly ChildHistory[],
  claims: readonly ClaimFold[],
  cutoff: bigint,
  checkpoint: Checkpoint | null,
): ChildProjection {
  const folds = checkpoint === null
    ? histories.flatMap((history) => {
        const count = history.events.filter((event) => event.position < cutoff).length;
        return count === 0 ? [] : [foldChildPrefix(history, count)];
      })
    : [...selectedMarkerFolds(histories, checkpoint)];
  const acceptedChildren = childItems(folds);
  const unresolvedFollowUps = unresolvedChildItems(folds);
  const claimedBeforeCutoff = new Set(claims
    .filter((claim) => claim.claimPosition < cutoff)
    .map((claim) => claim.transferTicketId));
  for (const child of folds) {
    if (child.ticket === null || claimedBeforeCutoff.has(child.ticket.transferTicketId)) continue;
    unresolvedFollowUps.push(Object.freeze({
      kind: "carry-forward-ticket",
      sourceChildSessionId: child.ticket.sourceChildSessionId,
      transferTicketId: child.ticket.transferTicketId as any,
      checkpointId: child.ticket.checkpointId as any,
      blockers: child.ticket.blockers,
      followUps: child.ticket.followUps,
    }));
  }
  return Object.freeze({
    acceptedChildren,
    unresolvedFollowUps: Object.freeze(unresolvedFollowUps.sort(compareUnresolved)),
  });
}

function finalCheckpoint(checkpoint: Checkpoint): CompatibilityLogFinalCheckpointV2 {
  const checkpointFingerprint = createHash("sha256")
    .update(`project-memory/checkpoint/v${checkpoint.checkpointVersion}\n`, "utf8")
    .update(canonicalJson(checkpoint), "utf8")
    .digest("hex");
  if (checkpoint.checkpointVersion === 1) {
    return deepFreeze({ checkpointFingerprint, checkpoint });
  }
  const { evidenceCoverage, ...rest } = checkpoint;
  const adapterSessions = [...evidenceCoverage.adapterSessions]
    .sort((left, right) => binaryCompare(left.adapterSessionId, right.adapterSessionId))
    .map((adapter) => Object.freeze({
      adapterSessionId: adapter.adapterSessionId,
      coverageFirstOrdinal: adapter.coverageFirstOrdinal,
      coverageLastOrdinal: adapter.coverageLastOrdinal,
      highestContiguousOrdinal: adapter.highestContiguousOrdinal,
      missingIntervals: adapter.missingIntervals,
      latestBatchId: adapter.latestBatchId,
      latestBatchEventPosition: adapter.latestBatchEventPosition,
    }));
  return deepFreeze({
    checkpointFingerprint,
    checkpoint: {
      ...rest,
      evidenceCoverage: {
        coverageVersion: 2,
        captureMode: "coverage-only",
        contentRetained: false,
        adapterSessions,
      },
    },
  }) as CompatibilityLogFinalCheckpointV2;
}

function resetValidation(): ValidationFold {
  return {
    results: new Map<string, any>(),
    plannedWorkIds: new Set<string>(),
    runIds: new Set<string>(),
    profileKeys: new Set<string>(),
    verdict: "not-run",
    qualityScore: null,
    safeFailureCode: null,
    passPosition: null,
  };
}

function validationProjection(state: ValidationFold): CompatibilityLogValidationV2 {
  const ids = [...state.results.keys()].sort(binaryCompare) as ValidationResultId[];
  return deepFreeze({
    verificationStatus: state.verdict,
    validationResultIds: ids,
    qualityScore: state.qualityScore,
    safeFailureCode: state.safeFailureCode,
    results: ids.map((id) => state.results.get(id)!),
  });
}

function exactSortedResultIds(value: readonly string[], results: ReadonlyMap<string, unknown>): boolean {
  const expected = [...results.keys()].sort(binaryCompare);
  return value.length === expected.length
    && new Set(value).size === value.length
    && value.every((id, index) => id === expected[index]);
}

function profileKeys(effective: ReturnType<typeof decodeSessionEndEffectiveStateV1>): ReadonlySet<string> {
  return new Set(effective.effectivePolicy.profiles.map((profile) =>
    canonicalJson([profile.profileId, profile.profileVersion])));
}

function setEquals(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function effectiveStateFor(event: DecodedRenderEvent): ReturnType<typeof decodeSessionEndEffectiveStateV1> {
  const payload = event.payload as any;
  const source = event.event.eventSchemaVersion === 3
    ? payload.effectiveState
    : event.event.legacyIntentSemantics?.effectiveState;
  if (source === undefined || source === null) return integrity();
  try {
    return decodeSessionEndEffectiveStateV1(source);
  } catch {
    return integrity();
  }
}

function amendmentAction(event: DecodedRenderEvent): "unchanged" | "open" | "seal" {
  const payload = event.payload as any;
  if (event.event.eventSchemaVersion >= 2) return payload.evidenceWindowAction;
  return event.event.legacyIntentSemantics?.evidenceWindowAction ?? "unchanged";
}

function assertResultBinding(
  result: any,
  root: LifecycleRenderEventV1,
  workflow: WorkflowFold,
  marker: FrozenEndingEpoch | null,
): void {
  if (
    marker === null
    || result.projectId !== root.projectId
    || result.vaultId !== root.vaultId
    || result.storeId !== root.storeId
    || result.workspaceId !== root.workspaceId
    || result.sessionId !== root.sessionId
    || result.workflowId !== workflow.id
    || result.workflowGeneration !== workflow.generation
    || result.finalCheckpointId !== marker.checkpointId
    || result.finalCheckpointFingerprint !== marker.checkpointFingerprint
  ) return integrity();
}

/** Pure event-history fold. No workflow, runner, projection, ticket, clock, or filesystem state is consulted. */
export function projectCompatibilityLogV2(input: CompatibilityLogProjectionInputV2): CompatibilityLogProjectionV2 {
  try {
    const trigger = decodeRenderEvent(input.trigger);
    const triggerPosition = trigger.position;
    if (input.trigger.materializationOrigin === null) return integrity();
    const rootDecoded = input.closure.root.map(decodeRenderEvent);
    const start = rootDecoded[0];
    if (
      start === undefined
      || start.event.eventType !== "SessionStarted"
      || start.streamVersion !== 1n
      || start.event.parentSessionId !== null
      || start.event.streamId !== `session/${start.event.sessionId}`
      || start.event.materializationOrigin !== null
      || trigger.event.sessionId !== start.event.sessionId
      || trigger.event.parentSessionId !== null
      || trigger.event.streamId !== start.event.streamId
      || !sameSourceContext(trigger.event, start.event)
      || trigger.streamVersion !== BigInt(rootDecoded.length + 1)
    ) return integrity();

    const occupiedPositions = new Set<string>();
    let previousRootPosition = 0n;
    for (let index = 0; index < rootDecoded.length; index += 1) {
      const event = rootDecoded[index]!;
      if (
        event.streamVersion !== BigInt(index + 1)
        || event.position <= previousRootPosition
        || event.position >= triggerPosition
        || event.event.sessionId !== start.event.sessionId
        || event.event.parentSessionId !== null
        || event.event.streamId !== start.event.streamId
        || !sameSourceContext(event.event, start.event)
        || event.event.materializationOrigin !== null
        || !ROOT_EVENT_TYPES.has(event.event.eventType)
        || occupiedPositions.has(event.event.globalPosition)
      ) return integrity();
      previousRootPosition = event.position;
      occupiedPositions.add(event.event.globalPosition);
    }
    if (
      occupiedPositions.has(input.trigger.globalPosition)
      || !ROOT_EVENT_TYPES.has(input.trigger.eventType)
      || !MATERIALIZATION_TRIGGER_TYPES.has(input.trigger.eventType)
    ) {
      return integrity();
    }
    occupiedPositions.add(input.trigger.globalPosition);

    const histories = validateChildHistories(input.closure, start.event, triggerPosition, occupiedPositions);
    const tickets = new Map<string, TicketFold>();
    for (const history of histories) {
      const ticket = history.full.ticket;
      if (ticket === null) continue;
      if (tickets.has(ticket.transferTicketId)) return integrity();
      tickets.set(ticket.transferTicketId, ticket);
    }
    const claims = validateClaims(input.closure, start.event, triggerPosition, tickets, occupiedPositions);

    const expectedTarget = deriveCompatibilityLogTarget(start.event.occurredAt, start.event.sessionId, triggerPosition);
    if (canonicalJson(expectedTarget) !== canonicalJson(input.target)) return integrity();

    let rootState: CompatibilityLogProjectionV2["lifecycle"]["rootState"] = "active";
    let workflow: WorkflowFold | null = null;
    let marker: FrozenEndingEpoch | null = null;
    let validation = resetValidation();
    let terminal = false;
    const timeline = [...rootDecoded, trigger];

    for (const current of timeline) {
      if (terminal) return integrity();
      const eventType = current.event.eventType;
      const eventPayload = current.payload as any;
      switch (eventType) {
        case "SessionStarted":
          if (current !== start) return integrity();
          break;
        case "SessionSuspended":
          if (workflow !== null) return integrity();
          rootState = "suspended";
          break;
        case "SessionResumed":
          if (workflow !== null) return integrity();
          rootState = "active";
          break;
        case "SessionEndRequested": {
          const effective = effectiveStateFor(current);
          if (
            effective.request.sessionId !== start.event.sessionId
            || (rootState !== "active" && rootState !== "suspended")
            || eventPayload.previousState !== rootState
            || (workflow === null
              ? eventPayload.workflowGeneration !== 1
              : eventPayload.workflowId !== workflow.id
                || eventPayload.workflowGeneration !== workflow.generation + 1)
          ) return integrity();
          if (current.event.eventSchemaVersion !== 3) {
            if (
              eventPayload.childEndPolicy !== effective.request.childEndPolicy
              || eventPayload.requireFullEvidence !== effective.effectivePolicy.requireFullEvidence
              || eventPayload.requireMaterialization !== effective.effectivePolicy.requireMaterialization
            ) return integrity();
          }
          workflow = {
            id: eventPayload.workflowId,
            generation: eventPayload.workflowGeneration,
            childEndPolicy: effective.request.childEndPolicy,
            evidenceWindowState: effective.request.requestVersion === 1 ? "sealed" : "open",
            validationProfileKeys: profileKeys(effective),
          };
          rootState = "ending";
          marker = null;
          validation = resetValidation();
          break;
        }
        case "SessionEndAmended": {
          if (
            workflow === null
            || workflow.id !== eventPayload.workflowId
            || workflow.generation !== eventPayload.previousWorkflowGeneration
            || eventPayload.workflowGeneration !== workflow.generation + 1
          ) return integrity();
          const effective = effectiveStateFor(current);
          const action = amendmentAction(current);
          const nextProfileKeys = profileKeys(effective);
          if (
            effective.request.sessionId !== start.event.sessionId
            || (current.event.eventSchemaVersion >= 2 && eventPayload.evidenceWindowAction !== action)
            || (action === "open" && workflow.evidenceWindowState !== "sealed")
            || (action === "seal" && workflow.evidenceWindowState !== "open")
            || (current.event.eventSchemaVersion === 3
              && action !== "open"
              && (validation.results.size !== 0 || validation.verdict !== "not-run")
              && !setEquals(workflow.validationProfileKeys, nextProfileKeys))
          ) return integrity();
          workflow = {
            id: workflow.id,
            generation: eventPayload.workflowGeneration,
            childEndPolicy: effective.request.childEndPolicy,
            evidenceWindowState: action === "open" ? "open" : action === "seal" ? "sealed" : workflow.evidenceWindowState,
            validationProfileKeys: nextProfileKeys,
          };
          if (action === "open") marker = null;
          if (current.event.eventSchemaVersion < 3 || action === "open") validation = resetValidation();
          rootState = "ending";
          break;
        }
        case "SessionEndCancelled":
          if (
            workflow === null
            || workflow.id !== eventPayload.workflowId
            || eventPayload.workflowGeneration !== workflow.generation + 1
            || (current.event.eventSchemaVersion === 3
              && eventPayload.previousWorkflowGeneration !== workflow.generation)
          ) return integrity();
          workflow = {
            id: workflow.id,
            generation: eventPayload.workflowGeneration,
            childEndPolicy: workflow.childEndPolicy,
            evidenceWindowState: workflow.evidenceWindowState,
            validationProfileKeys: workflow.validationProfileKeys,
          };
          rootState = eventPayload.restoredState;
          marker = null;
          validation = resetValidation();
          break;
        case "SessionCheckpointRecorded":
          {
            const checkpoint = eventPayload.checkpoint as Checkpoint;
            if (
              checkpoint.sessionId !== start.event.sessionId
              || checkpoint.parentSessionId !== null
              || checkpoint.checkpointEventPosition !== current.event.globalPosition
              || checkpoint.sourceState.workspaceId !== start.event.workspaceId
              || checkpoint.sourceState.branchRef !== start.event.branchRef
              || positiveDecimal(checkpoint.baseEventPosition) >= current.position
            ) return integrity();
          }
          if (current.event.eventSchemaVersion === 3) {
            const checkpoint = eventPayload.checkpoint as Checkpoint;
            if (
              workflow === null
              || rootState !== "ending"
              || workflow.evidenceWindowState !== "sealed"
              || workflow.id !== eventPayload.workflowId
              || workflow.generation !== eventPayload.workflowGeneration
              || positiveDecimal(eventPayload.checkpointEventPosition) !== current.position
              || positiveDecimal(eventPayload.baseEventPosition) >= current.position
              || checkpoint.sessionId !== start.event.sessionId
              || checkpoint.parentSessionId !== null
              || validation.results.size !== 0
              || validation.verdict !== "not-run"
            ) return integrity();
            const children = projectChildScope(histories, claims, current.position, checkpoint);
            const projectedCheckpoint = finalCheckpoint(checkpoint);
            marker = Object.freeze({
              ...children,
              finalCheckpoint: projectedCheckpoint,
              checkpointId: checkpoint.checkpointId,
              checkpointFingerprint: projectedCheckpoint.checkpointFingerprint,
              markerPosition: current.position,
              markerWorkflowId: eventPayload.workflowId,
              markerWorkflowGeneration: eventPayload.workflowGeneration,
            });
          }
          break;
        case "SessionValidationResultRecorded": {
          if (
            workflow === null
            || marker === null
            || validation.verdict !== "not-run"
            || eventPayload.workflowId !== workflow.id
            || eventPayload.workflowGeneration !== workflow.generation
          ) return integrity();
          const result = eventPayload.validationResult;
          assertResultBinding(result, start.event, workflow, marker);
          const profileKey = canonicalJson([result.profileId, result.profileVersion]);
          if (
            validation.results.has(result.resultId)
            || validation.plannedWorkIds.has(eventPayload.plannedWorkId)
            || validation.runIds.has(result.runId)
            || validation.profileKeys.has(profileKey)
            || !workflow.validationProfileKeys.has(profileKey)
          ) return integrity();
          validation.results.set(result.resultId, result);
          validation.plannedWorkIds.add(eventPayload.plannedWorkId);
          validation.runIds.add(result.runId);
          validation.profileKeys.add(profileKey);
          break;
        }
        case "SessionEndVerificationPassed":
        case "SessionEndVerificationFailed":
          if (
            workflow === null
            || marker === null
            || validation.verdict !== "not-run"
            || eventPayload.workflowId !== workflow.id
            || eventPayload.workflowGeneration !== workflow.generation
            || !exactSortedResultIds(eventPayload.validationResultIds, validation.results)
            || !setEquals(validation.profileKeys, workflow.validationProfileKeys)
          ) return integrity();
          if (eventType === "SessionEndVerificationPassed") {
            validation.verdict = "passed";
            validation.qualityScore = eventPayload.qualityScore;
            validation.safeFailureCode = null;
            validation.passPosition = current.position;
          } else {
            validation.verdict = "failed";
            validation.qualityScore = null;
            validation.safeFailureCode = eventPayload.safeFailureCode;
            validation.passPosition = null;
          }
          break;
        case "SessionEndVerificationInvalidated":
          if (
            workflow === null
            || marker === null
            || validation.verdict !== "passed"
            || validation.passPosition === null
            || eventPayload.workflowId !== workflow.id
            || eventPayload.workflowGeneration !== workflow.generation
            || positiveDecimal(eventPayload.previousVerificationEventPosition) !== validation.passPosition
          ) return integrity();
          validation.verdict = "invalidated";
          validation.qualityScore = null;
          validation.safeFailureCode = eventPayload.safeFailureCode;
          break;
        case "SessionAbandoned":
          rootState = "abandoned";
          terminal = true;
          if (eventPayload.workflowId === null) {
            workflow = null;
            marker = null;
          } else if (
            workflow === null
            || eventPayload.workflowId !== workflow.id
            || eventPayload.workflowGeneration !== workflow.generation
          ) return integrity();
          break;
        case "SessionEnded":
          if (
            workflow === null
            || marker === null
            || validation.verdict !== "passed"
            || validation.passPosition === null
            || eventPayload.workflowId !== workflow.id
            || eventPayload.workflowGeneration !== workflow.generation
            || positiveDecimal(eventPayload.verificationEventPosition) !== validation.passPosition
          ) return integrity();
          rootState = "ended";
          terminal = true;
          break;
        case "SessionOwnerTransferred":
        case "SessionOwnershipRecovered":
        case "SessionSuspendRequested":
        case "EvidenceCoverageRecorded":
          break;
        default:
          return integrity();
      }
    }

    const origin = input.trigger.materializationOrigin;
    const directTerminal = origin.kind === "terminal-event";
    if (
      directTerminal
        ? input.trigger.eventType !== "SessionAbandoned" || workflow !== null
        : workflow === null
          || origin.workflowId !== workflow.id
          || origin.workflowGeneration !== workflow.generation
    ) return integrity();

    const live = marker === null || directTerminal
      ? projectChildScope(histories, claims, triggerPosition, null)
      : null;
    const acceptedChildren = live?.acceptedChildren ?? marker!.acceptedChildren;
    const unresolvedFollowUps = live?.unresolvedFollowUps ?? marker!.unresolvedFollowUps;
    const projectedFinalCheckpoint = directTerminal ? null : marker?.finalCheckpoint ?? null;
    const projectedValidation = directTerminal ? null : validationProjection(validation);

    return deepFreeze({
      identity: {
        documentVersion: 2,
        projectId: start.event.projectId,
        vaultId: start.event.vaultId,
        storeId: start.event.storeId,
        workspaceId: start.event.workspaceId,
        branchScopeId: start.event.branchScopeId,
        branchRef: start.event.branchRef,
        sessionId: start.event.sessionId,
        startedAt: start.event.occurredAt,
      },
      source: {
        streamId: `session/${start.event.sessionId}`,
        streamType: "session",
        startEventPosition: start.event.globalPosition,
        throughEventPosition: input.trigger.globalPosition,
      },
      lifecycle: {
        rootState,
        workflowId: workflow?.id ?? null,
        workflowGeneration: workflow?.generation ?? null,
        childEndPolicy: rootState === "active" || rootState === "suspended" || directTerminal
          ? null
          : workflow?.childEndPolicy ?? null,
        evidenceWindowState: rootState === "active" || rootState === "suspended" || directTerminal
          ? null
          : workflow?.evidenceWindowState ?? null,
      },
      acceptedChildren,
      unresolvedFollowUps,
      finalCheckpoint: projectedFinalCheckpoint,
      validation: projectedValidation,
      materialization: {
        artifactKind: "compatibility-session-log",
        artifactPath: input.target.artifactPath,
        targetKey: input.target.targetKey,
        materializationRevision: input.target.materializationRevision,
        triggeringEventType: input.trigger.eventType as CompatibilityLogProjectionV2["materialization"]["triggeringEventType"],
        triggeringEventSchemaVersion: input.trigger.eventSchemaVersion,
        triggeringEventPosition: input.trigger.globalPosition,
        triggeringPayloadHash: payloadHash(input.trigger.payload),
      },
    }) as CompatibilityLogProjectionV2;
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") throw error;
    return integrity();
  }
}
