import { createHash } from "node:crypto";
import type { StoredEvent } from "../contracts/event.js";
import { outboxHash, payloadHash } from "../crypto/event-hash.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import {
  decodeLifecycleEvent,
  decodeLegacyLifecycleEvent,
  decodeLifecycleEventPayload,
  LIFECYCLE_EVENT_TYPES,
  type EvidenceCoverageRecordedV2,
  type LifecycleEvent,
  type LifecycleEventCodecResult,
  type LifecycleEvidenceFrameRecordedV1,
} from "../lifecycle/contracts/events.js";
import {
  COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND,
  decodeLifecycleMaterializationPayloadV1,
  type LifecycleRenderClosureV1,
  type LifecycleRenderEventV1,
  type LifecycleRenderTriggerV1,
  type LifecycleMaterializationPayloadV1,
} from "../lifecycle/materialization-queue.port.js";
import {
  advanceEvidenceCoverageIntervals,
} from "../lifecycle/evidence-coverage-accumulator.js";
import {
  CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES,
  CHECKPOINT_MAX_MISSING_INTERVALS,
  CHECKPOINT_MAX_CANONICAL_BYTES,
  type Checkpoint,
  type CheckpointEvidenceCoverageV2,
  type CheckpointV2,
} from "../lifecycle/contracts/checkpoint.js";
import {
  decodeFinalEndingScopeBindingsV1,
  FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES,
  type FinalEndingScopeBindingV1,
} from "../lifecycle/contracts/session-end.js";
import { LifecycleError } from "../lifecycle/errors.js";
import {
  decodeLifecycleIntentWitness,
  lifecycleIntentHashFromWitnessSource,
} from "../lifecycle/lifecycle-intent-witness.js";
import {
  foldChildEventProjection,
  foldWorkflowGenerationProjection,
  childEventFoldFingerprint,
  classifyChildProjectionEvent,
  classifyWorkflowProjectionEvent,
  reportItemSetFingerprint,
  workflowGenerationFingerprint,
  workflowFingerprintV2,
  type ChildEventFoldProjection,
  type WorkflowGenerationFoldProjection,
} from "../lifecycle/lifecycle-projection-folds.js";
import {
  evolveSession,
  foldSession,
  assertAuthorityMirror,
  type SessionAggregateState,
} from "../lifecycle/session-aggregate.js";
import {
  authorityCommitment,
  type CommittedAuthorityV1,
} from "../lifecycle/authority/authority-commitment.js";
import type { ProjectContext } from "../identity/contracts.js";
import type { CapabilityKeyProvider } from "../lifecycle/authority/capability-key-provider.js";
import { ChildTransferRepository } from "../storage/child-transfer.repository.js";
import { EvidenceCoverageRepository } from "../storage/evidence-coverage.repository.js";
import {
  SqliteLifecycleProjectionRepository,
  openChildEventFoldCursor,
  openWorkflowGenerationFoldCursor,
  type ChildEventFoldCursor,
  type WorkflowGenerationFoldCursor,
} from "../storage/lifecycle-projection.repository.js";
import { SessionAuthorityRepository } from "../storage/session-authority.repository.js";
import { SqliteLifecycleRenderClosureReader } from "../materialization/sqlite-lifecycle-render-closure.reader.js";
import { projectCompatibilityLogV2 } from "../materialization/compatibility-log.projection.js";
import { renderCompatibilityLogV2 } from "../materialization/compatibility-log.renderer.js";
import { deriveCompatibilityLogTarget } from "../materialization/vault-artifact-path.js";
import {
  decodePersistedValidationPlansV1,
  hydrateSessionEndEffectiveStateV1,
} from "../storage/session-end.repository.js";
import type {
  CarryForwardEndingScopeProjectionRecord,
  ChildTransferTicketRecord,
  CurrentChildEndingScopeProjectionRecord,
  SessionAuthorityRecord,
} from "../storage/lifecycle-storage.types.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import {
  HistoricalEvidenceKeyUnavailableError,
  type AsyncIntegrityExtension,
  type HistoricalEvidenceIntegrityProviderPort,
  type IntegrityIssueCode,
  type IntegrityIssueSink,
} from "./integrity.types.js";

const AUTHORIZATION_COLUMNS = [
  "authorization_proof_version",
  "authorization_proof_nonce",
  "authorization_proof_digest",
  "authorization_approval_id",
  "authorization_approval_digest",
  "authorization_session_id",
  "target_session_id",
  "presenting_actor_role",
  "presenting_client_instance_id",
  "target_actor_role",
  "target_client_instance_id",
  "internal_workflow_id",
  "internal_workflow_generation",
  "internal_planned_work_id",
  "internal_claim_owner_id",
  "internal_claim_token",
] as const;

const PROTECTED_COMMAND_TYPES = new Set([
  "root-resume",
  "root-recovery",
  "root-suspend",
  "fork-child",
  "amend-child-assignment",
  "record-checkpoint",
  "record-evidence-batch",
  "record-child-report",
  "disposition-child-report",
  "propose-child-completion",
  "complete-child-session",
  "suspend-child-session",
  "create-child-transfer",
  "claim-child-transfer",
  "request-session-end",
  "amend-session-end",
  "cancel-session-end",
  "abandon-session",
]);
const INTERNAL_COMMAND_TYPES = new Set([
  "internal-validation-result",
  "internal-workflow-phase",
]);
const ACTOR_ROLES = new Set(["primary", "maintenance", "untrusted"]);
const LOWER_HASH = /^[0-9a-f]{64}$/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;
const LIFECYCLE_EVENT_TYPE_SET = new Set<string>(LIFECYCLE_EVENT_TYPES);
const LIFECYCLE_OUTBOX_TRIGGER_TYPES = new Set([
  "SessionCheckpointRecorded",
  "SessionEndAmended",
  "SessionEndVerificationFailed",
  "SessionEndVerificationInvalidated",
  "SessionEndCancelled",
  "SessionAbandoned",
  "SessionEnded",
]);
const LIFECYCLE_OUTBOX_PAYLOAD_KEYS = [
  "artifactKind",
  "artifactPath",
  "materializationRevision",
  "nextFingerprint",
  "origin",
  "payloadVersion",
  "sessionId",
  "targetKey",
  "triggeringEventType",
  "triggeringPayloadHash",
] as const;
const LIFECYCLE_OUTBOX_FINGERPRINT_KEYS = [
  "algorithm", "domain", "keyId", "schemaVersion", "value",
] as const;
const LIFECYCLE_OUTBOX_ORIGIN_KEYS = [
  "kind", "workflowGeneration", "workflowId",
] as const;

export const LIFECYCLE_EVENT_CURSOR_SQL = `
  SELECT /* lifecycle-full:event */ *
  FROM events INDEXED BY events_project_position
  WHERE project_id = $projectId
  ORDER BY global_position
`;

export const QUALIFIED_TRANSITION_CURSOR_SQL = `
  SELECT /* lifecycle-full:coverage-transition */ *
  FROM session_evidence_coverage_transitions
    INDEXED BY session_evidence_coverage_transitions_full_replay
  WHERE project_id = $projectId
  ORDER BY batch_event_position, session_id, adapter_session_id
`;

export const QUALIFIED_ORDINAL_CURSOR_SQL = `
  SELECT /* lifecycle-full:immutable-ordinal */ *
  FROM session_evidence_fingerprints
    INDEXED BY session_evidence_fingerprints_full_replay
  WHERE project_id = $projectId
  ORDER BY recorded_event_position, session_id, adapter_session_id, ordinal
`;

interface QualifiedQuickResult {
  readonly qualifiedSchema: boolean;
  readonly statuses: ReadonlyMap<string, "available">;
}

interface DetachedReplayCursor<T> {
  readonly visits: number;
  peek(): T | null;
  advance(): T;
  close(): void;
}

export interface LifecycleFullReplayWorkCounters {
  evidenceTransitionAdapterLookups: number;
  evidenceEntryCanonicalizations: number;
  checkpointEvidenceCaptures: number;
  checkpointEvidenceEntryMaterializations: number;
  endingBindingEvidenceRevisionLookups: number;
}

interface QualifiedTransitionReplayRow {
  readonly projectId: string;
  readonly sessionId: string;
  readonly adapterSessionId: string;
  readonly batchId: string;
  readonly batchEventPosition: bigint;
  readonly batchFirstOrdinal: bigint;
  readonly batchLastOrdinal: bigint;
  readonly coverageFirstOrdinal: bigint;
  readonly coverageLastOrdinal: bigint;
  readonly highestContiguousOrdinal: bigint | null;
  readonly missingIntervals: readonly {
    readonly firstOrdinal: bigint;
    readonly lastOrdinal: bigint;
  }[];
  readonly missingIntervalsJson: string;
  readonly frameFingerprintAlgorithm: "hmac-sha256";
  readonly frameFingerprintSchemaVersion: 1;
  readonly frameFingerprintKeyId: string;
  readonly frameFingerprintDomain: "pm-evidence-frame-v1";
  readonly previousCoverageFingerprintValue: string | null;
  readonly coverageFingerprintAlgorithm: "hmac-sha256";
  readonly coverageFingerprintSchemaVersion: 1;
  readonly coverageFingerprintKeyId: string;
  readonly coverageFingerprintDomain: "pm-evidence-coverage-v1";
  readonly coverageFingerprintValue: string;
  readonly newFrameCount: number;
  readonly captureMode: "coverage-only";
  readonly contentRetained: false;
  readonly createdAt: string;
}

interface ImmutableOrdinalIdentity {
  readonly sessionId: string;
  readonly adapterSessionId: string;
  readonly ordinal: bigint;
  readonly frameId: string;
  readonly sourceKind: string;
  readonly observedAt: string;
  readonly fingerprintAlgorithm: "hmac-sha256";
  readonly fingerprintSchemaVersion: 1;
  readonly fingerprintKeyId: string;
  readonly fingerprintDomain: "pm-evidence-frame-v1";
  readonly fingerprintValue: string;
  readonly batchId: string;
  readonly recordedEventPosition: bigint;
  readonly createdAt: string;
}

interface EvidenceReplayState {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly coverageLastOrdinal: bigint;
  readonly missingIntervalsJson: string;
  readonly missingIntervals: readonly {
    readonly firstOrdinal: bigint;
    readonly lastOrdinal: bigint;
  }[];
  readonly coverageFingerprint: string;
  readonly checkpointEntry: CheckpointEvidenceCoverageV2["adapterSessions"][number];
  readonly canonicalEntryBytes: number;
}

interface EvidenceReplayRevisionSummary {
  readonly revisionEventPosition: bigint | null;
  readonly adapterCount: number;
}

interface EvidenceReplaySessionState extends EvidenceReplayRevisionSummary {
  readonly adapters: Map<string, EvidenceReplayState>;
  adapterCount: number;
  totalIntervalCount: number;
  canonicalEntryBytesTotal: number;
  canonicalCoverageBytes: number;
  revisionEventPosition: bigint | null;
}

interface IndexedReplayIntent {
  readonly witness: ReturnType<typeof decodeLifecycleIntentWitness>;
  readonly commandHash: string | null;
  readonly workspaceHeadCommit: string | null;
}

interface HistoricalCheckpointCapture {
  readonly aggregate: SessionAggregateState;
  readonly childSummaries: Checkpoint["childSummaries"];
  readonly evidenceCoverage: CheckpointEvidenceCoverageV2;
  readonly evidenceRevisionEventPosition: bigint | null;
  readonly evidenceAdapterCount: number;
}

interface CheckpointEvidenceRevision {
  readonly sessionId: string;
  readonly checkpointVersion: 1 | 2;
  readonly revisionEventPosition: bigint | null;
  readonly adapterCount: number;
}

interface HistoricalCheckpointRequest {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly baseEventPosition: bigint;
  readonly checkpointEventPosition: bigint;
  readonly childSummaries: Checkpoint["childSummaries"];
}

interface HistoricalCheckpointPlan {
  readonly byBase: ReadonlyMap<bigint, readonly HistoricalCheckpointRequest[]>;
  readonly childIdsByPosition: ReadonlyMap<bigint, ReadonlySet<string>>;
}

interface ReplayPreIndexes {
  readonly transferTickets: readonly Readonly<SqliteRow>[];
  readonly transferTicketById: ReadonlyMap<string, Readonly<SqliteRow>>;
  readonly transferTicketByBinding: ReadonlyMap<string, Readonly<SqliteRow>>;
  readonly ticketsByCreatePosition: ReadonlyMap<bigint, readonly Readonly<SqliteRow>[]>;
  readonly ticketsByClaimPosition: ReadonlyMap<bigint, readonly Readonly<SqliteRow>[]>;
  readonly validations: readonly Readonly<SqliteRow>[];
  readonly validationById: ReadonlyMap<string, Readonly<SqliteRow>>;
  readonly validationsByEventPosition: ReadonlyMap<bigint, readonly Readonly<SqliteRow>[]>;
}

interface ReplayEndpointIndexes {
  readonly workflows: readonly Readonly<SqliteRow>[];
  readonly evidence: readonly Readonly<SqliteRow>[];
  readonly authorities: ReadonlyMap<string, Readonly<SqliteRow>>;
}

type ReplayWorkflowPhase =
  | "requested"
  | "cancelled"
  | "abandoned"
  | "final-checkpoint-recorded"
  | "validating"
  | "verification-passed"
  | "verification-failed"
  | "completion-appended";

interface WorkflowReplayState {
  readonly workflowId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly triggerEventPosition: bigint;
  readonly rootCommandId: string;
  readonly expectedAuthorityCommitment: string;
  readonly priorRootState: "active" | "suspended";
  readonly materializationRequired: boolean;
  readonly evidenceWindowState: "open" | "sealed";
  readonly phase: ReplayWorkflowPhase;
  readonly frozenCheckpointId: string | null;
  readonly frozenCheckpointEventPosition: bigint | null;
  readonly frozenGeneration: number | null;
  readonly endingBindingsJson: string | null;
  readonly validationResultIds: ReadonlySet<string>;
  readonly qualityScore: number | null;
  readonly safeFailureCode: string | null;
  readonly verificationEventPosition: bigint | null;
  readonly completionEventPosition: bigint | null;
}

interface TransferSuspensionWitness {
  readonly checkpointId: string;
  readonly streamVersion: bigint;
  readonly blockers: readonly string[];
  readonly followUps: readonly string[];
}
const LATEST_EVIDENCE_PAYLOAD_KEYS = [
  "adapterSessionId",
  "batchFirstOrdinal",
  "batchId",
  "batchLastOrdinal",
  "captureMode",
  "contentRetained",
  "coverageFingerprint",
  "coverageFingerprintAlgorithm",
  "coverageFingerprintDomain",
  "coverageFingerprintKeyId",
  "coverageFingerprintSchemaVersion",
  "coverageFirstOrdinal",
  "coverageLastOrdinal",
  "frameFingerprintAlgorithm",
  "frameFingerprintDomain",
  "frameFingerprintKeyId",
  "frameFingerprintSchemaVersion",
  "frames",
  "highestContiguousOrdinal",
  "missingIntervals",
] as const;
const LATEST_EVIDENCE_PAYLOAD_KEY_SEQUENCE = LATEST_EVIDENCE_PAYLOAD_KEYS.join("\u001f");

function issue(sink: IntegrityIssueSink, code: IntegrityIssueCode): void {
  sink.add(code);
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function positive(value: unknown): boolean {
  return (typeof value === "bigint" && value > 0n)
    || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function integer(value: unknown): number | null {
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function int64(value: unknown, allowZero = false): bigint | null {
  const converted = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : null;
  if (
    converted === null
    || converted < (allowZero ? 0n : 1n)
    || converted > SQLITE_INT64_MAX
  ) return null;
  return converted;
}

function signedCoverageInt64(value: unknown): bigint | null {
  const converted = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : null;
  if (converted === null || converted < -1n || converted > SQLITE_INT64_MAX) {
    return null;
  }
  return converted;
}

function canonicalCoverageIntervals(
  value: unknown,
): readonly { readonly firstOrdinal: bigint; readonly lastOrdinal: bigint }[] | null {
  if (typeof value !== "string") return null;
  if (value === "[]") return [];
  if (!value.startsWith("[[") || !value.endsWith("]]")) return null;
  const entries = value.slice(2, -2).split("],[");
  const intervals: Array<{ firstOrdinal: bigint; lastOrdinal: bigint }> = [];
  for (const entry of entries) {
    const fields = entry.split(",");
    if (
      fields.length !== 2
      || !UNSIGNED_DECIMAL.test(fields[0]!)
      || !UNSIGNED_DECIMAL.test(fields[1]!)
    ) return null;
    intervals.push({
      firstOrdinal: BigInt(fields[0]!),
      lastOrdinal: BigInt(fields[1]!),
    });
  }
  return intervals;
}

function decimal(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value.toString()
    : null;
}

function sameInteger(left: unknown, right: unknown): boolean {
  return integer(left) !== null && integer(left) === integer(right);
}

function positiveDecimalString(value: unknown): boolean {
  return typeof value === "string"
    && UNSIGNED_DECIMAL.test(value)
    && BigInt(value) > 0n
    && BigInt(value) <= SQLITE_INT64_MAX;
}

function allNull(row: SqliteRow, columns: readonly string[]): boolean {
  return columns.every((column) => row[column] === null);
}

function allPresent(row: SqliteRow, columns: readonly string[]): boolean {
  return columns.every((column) => present(row[column]));
}

function canonicalJsonText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return canonicalJson(JSON.parse(value) as never) === value;
  } catch {
    return false;
  }
}

function parsedCanonicalJson(value: unknown): unknown {
  if (!canonicalJsonText(value)) throw new Error("NON_CANONICAL_JSON");
  return JSON.parse(value as string) as unknown;
}

function completeTuple(row: SqliteRow, columns: readonly string[]): boolean {
  return allNull(row, columns) || allPresent(row, columns);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecordKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort(binaryCompare);
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function deeplyFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deeplyFreeze(item, seen);
  } else {
    for (const item of Object.values(value)) deeplyFreeze(item, seen);
  }
  return Object.freeze(value);
}

function openDetachedReplayCursor<T>(
  connection: SqliteConnection,
  projectId: string,
  sql: string,
  hydrate: (row: SqliteRow) => T,
): DetachedReplayCursor<T> {
  if (projectId.length === 0) throw new LifecycleError("INTEGRITY_FAILURE");
  let iterator: IterableIterator<SqliteRow>;
  try {
    iterator = connection.prepare(sql).iterate({ $projectId: projectId });
  } catch {
    throw new LifecycleError("INTEGRITY_FAILURE");
  }
  let lookahead: T | null = null;
  let visits = 0;
  let closed = false;
  const closeIterator = (): void => {
    const close = iterator.return;
    if (typeof close === "function") close.call(iterator);
  };
  const prime = (): void => {
    let next: IteratorResult<SqliteRow>;
    try {
      next = iterator.next();
    } catch {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (next.done === true) {
      lookahead = null;
      return;
    }
    try {
      lookahead = hydrate({ ...next.value });
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "INTEGRITY_FAILURE") {
        throw error;
      }
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  };
  try {
    prime();
  } catch (error) {
    try {
      closeIterator();
    } catch {
      // Opening failure has precedence over iterator close failure.
    }
    throw error;
  }
  return {
    get visits() { return visits; },
    peek() { return lookahead; },
    advance() {
      if (lookahead === null || closed) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const current = lookahead;
      prime();
      visits += 1;
      return current;
    },
    close() {
      if (closed) return;
      closed = true;
      lookahead = null;
      try {
        closeIterator();
      } catch {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    },
  };
}

function canonicalHash(checkpoint: Checkpoint): string {
  return createHash("sha256")
    .update(`project-memory/checkpoint/v${checkpoint.checkpointVersion}\n`, "utf8")
    .update(canonicalJson(checkpoint), "utf8")
    .digest("hex");
}

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const ENDING_SCOPE_LIMIT_PLUS_ONE = 606;
const EMPTY_QUALIFIED_COVERAGE: CheckpointEvidenceCoverageV2 = Object.freeze({
  coverageVersion: 2,
  captureMode: "coverage-only",
  contentRetained: false,
  adapterSessions: Object.freeze([]),
});
const EMPTY_QUALIFIED_COVERAGE_CANONICAL_BYTES = Buffer.byteLength(
  canonicalJson(EMPTY_QUALIFIED_COVERAGE),
  "utf8",
);

function binaryCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function currentBinding(
  root: SessionAuthorityRecord,
  projection: CurrentChildEndingScopeProjectionRecord,
): FinalEndingScopeBindingV1 {
  if (
    projection.projectId !== root.projectId
    || projection.rootSessionId !== root.sessionId
    || projection.lastEventPosition < 1n
    || projection.lastEventPosition > SQLITE_INT64_MAX
    || projection.streamVersion < 1n
    || projection.streamVersion > SQLITE_INT64_MAX
    || (projection.checkpointId === null)
      !== (projection.checkpointEventPosition === null)
    || (
      projection.checkpointEventPosition !== null
      && (
        projection.checkpointEventPosition < 1n
        || projection.checkpointEventPosition > projection.lastEventPosition
      )
    )
  ) throw new LifecycleError("INTEGRITY_FAILURE");
  return Object.freeze({
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: projection.childSessionId as FinalEndingScopeBindingV1["childSessionId"],
    childState: projection.childState,
    lastEventPosition: projection.lastEventPosition.toString(),
    streamVersion: projection.streamVersion.toString(),
    checkpointId: projection.checkpointId as FinalEndingScopeBindingV1["checkpointId"],
    checkpointEventPosition: projection.checkpointEventPosition?.toString() ?? null,
    transferTicketId: null,
    transferTicketEventPosition: null,
  });
}

function carryBinding(
  root: SessionAuthorityRecord,
  projection: CarryForwardEndingScopeProjectionRecord,
): FinalEndingScopeBindingV1 {
  if (
    projection.projectId !== root.projectId
    || projection.rootSessionId !== root.sessionId
    || projection.childState !== "transferred"
    || projection.lastEventPosition !== projection.transferTicketEventPosition
    || projection.lastEventPosition < 1n
    || projection.lastEventPosition > SQLITE_INT64_MAX
    || projection.streamVersion < 1n
    || projection.streamVersion > SQLITE_INT64_MAX
    || projection.checkpointEventPosition < 1n
    || projection.checkpointEventPosition > projection.lastEventPosition
  ) throw new LifecycleError("INTEGRITY_FAILURE");
  return Object.freeze({
    bindingVersion: 1,
    bindingKind: "carry-forward-ticket",
    childSessionId: projection.childSessionId as FinalEndingScopeBindingV1["childSessionId"],
    childState: "transferred",
    lastEventPosition: projection.lastEventPosition.toString(),
    streamVersion: projection.streamVersion.toString(),
    checkpointId: projection.checkpointId as FinalEndingScopeBindingV1["checkpointId"],
    checkpointEventPosition: projection.checkpointEventPosition.toString(),
    transferTicketId:
      projection.transferTicketId as FinalEndingScopeBindingV1["transferTicketId"],
    transferTicketEventPosition: projection.transferTicketEventPosition.toString(),
  });
}

interface CheckpointRequirementFold {
  readonly reason: string;
  readonly eventPosition: string;
}

type CheckpointRequirementTransition =
  | {
      readonly kind: "clear";
      readonly eventPosition: string;
      readonly baseEventPosition: string;
    }
  | {
      readonly kind: "require";
      readonly eventPosition: string;
      readonly reason: string;
    };

interface RevocationFold {
  readonly reason: string;
  readonly eventPosition: string;
  readonly revokedAt: string;
}

export class LifecycleIntegrityService implements AsyncIntegrityExtension {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly provider?: HistoricalEvidenceIntegrityProviderPort,
    private readonly replayWorkCounters?: LifecycleFullReplayWorkCounters,
  ) {}

  private incrementReplayWork(
    counter: keyof LifecycleFullReplayWorkCounters,
    amount = 1,
  ): void {
    if (this.replayWorkCounters !== undefined) {
      this.replayWorkCounters[counter] += amount;
    }
  }

  quickCheck(context: ProjectContext, sink: IntegrityIssueSink): void {
    if (!this.hasLifecycleSchema()) return;
    this.assertSynchronousEvidenceAuthenticationAvailable(context);
    this.runQuickCheck(context, sink);
  }

  fullCheck(context: ProjectContext, sink: IntegrityIssueSink): void {
    if (!this.hasLifecycleSchema()) return;
    this.assertSynchronousEvidenceAuthenticationAvailable(context);
    this.runFullCheck(context, sink);
  }

  async quickCheckAsync(
    context: ProjectContext,
    sink: IntegrityIssueSink,
  ): Promise<void> {
    if (!this.hasLifecycleSchema()) return;
    const qualifiedSchema = this.hasQualifiedLifecycleSchema();
    this.runQuickCheck(context, sink, qualifiedSchema);
    await this.checkQualifiedQuick(
      context,
      sink,
      !qualifiedSchema,
      qualifiedSchema,
      true,
    );
  }

  async fullCheckAsync(
    context: ProjectContext,
    sink: IntegrityIssueSink,
  ): Promise<void> {
    if (!this.hasLifecycleSchema()) return;
    const qualifiedSchema = this.hasQualifiedLifecycleSchema();
    this.runQuickCheck(context, sink, qualifiedSchema);
    const qualified = await this.checkQualifiedQuick(
      context,
      sink,
      false,
      qualifiedSchema,
    );
    if (qualified.qualifiedSchema) {
      await this.checkQualifiedFullReplay(context, sink, qualified.statuses);
      this.runFullOnly(context, sink, false);
    } else {
      this.runFullOnly(context, sink, true);
    }
    await this.checkLifecycleOutboxFullReplay(context, sink);
  }

  private runQuickCheck(
    context: ProjectContext,
    sink: IntegrityIssueSink,
    qualifiedEndpointOnly = false,
  ): void {
    this.checkAuthorization(context, sink);
    this.checkAuthorityLinkage(context, sink, false);
    this.checkLeases(context, sink);
    this.checkWorkflowShape(context, sink, qualifiedEndpointOnly);
    this.checkOutboxShape(context, sink, false);
  }

  private runFullCheck(context: ProjectContext, sink: IntegrityIssueSink): void {
    this.runQuickCheck(context, sink);
    this.runFullOnly(context, sink, true);
  }

  private runFullOnly(
    context: ProjectContext,
    sink: IntegrityIssueSink,
    includeLegacyEvidence: boolean,
  ): void {
    const historyAlreadyReplayed = !includeLegacyEvidence;
    this.checkAuthorityLinkage(context, sink, true, historyAlreadyReplayed);
    if (includeLegacyEvidence) this.checkEvidence(context, sink);
    this.checkApprovalsAndTransfers(context, sink, historyAlreadyReplayed);
    this.checkValidation(context, sink);
    this.checkWorkflowClaims(context, sink, historyAlreadyReplayed);
    this.checkSchema4LifetimeFull(context, sink);
    this.checkOutboxShape(context, sink, true);
  }

  private async checkLifecycleOutboxFullReplay(
    context: ProjectContext,
    sink: IntegrityIssueSink,
  ): Promise<void> {
    if (!this.hasSchema4LifecycleSchema(context)) return;
    const rows = this.connection.prepare(`
      SELECT outbox.*
      FROM outbox
      WHERE outbox.project_id = $projectId
        AND outbox.kind = 'materialize-lifecycle-log'
        AND outbox.session_id IS NOT NULL
        AND outbox.artifact_kind = '${COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND}'
      ORDER BY outbox.session_id, outbox.materialization_revision
    `).all({ $projectId: context.binding.projectId });
    const reader = new SqliteLifecycleRenderClosureReader(this.connection);
    for (const row of rows) {
      let rendered: Buffer | null = null;
      try {
        this.assertSchema4LifecycleOutboxDescriptor(context, row, true);
        const rawPayload = parsedCanonicalJson(row.payload_json);
        const payload = decodeLifecycleMaterializationPayloadV1(rawPayload);
        const revision = int64(row.event_position);
        const sessionId = row.session_id;
        if (
          revision === null
          || revision >= SQLITE_INT64_MAX
          || typeof sessionId !== "string"
        ) throw new LifecycleError("INTEGRITY_FAILURE");

        const expanded = reader.readStrictLifecycleClosure(
          context.binding.projectId,
          sessionId as never,
          revision + 1n,
        );
        const triggerEvent = expanded.root.find((event) => (
          BigInt(event.globalPosition) === revision
        ));
        if (triggerEvent === undefined) throw new LifecycleError("INTEGRITY_FAILURE");
        const before = (event: LifecycleRenderEventV1): boolean => (
          BigInt(event.globalPosition) < revision
        );
        const closure: LifecycleRenderClosureV1 = Object.freeze({
          root: Object.freeze(expanded.root.filter(before)),
          directChildren: Object.freeze(expanded.directChildren.map((child) => Object.freeze({
            childSessionId: child.childSessionId,
            events: Object.freeze(child.events.filter(before)),
          }))),
          foreignClaims: Object.freeze(expanded.foreignClaims
            .filter((pair) => before(pair.fork) && before(pair.claim))),
        });
        const trigger: LifecycleRenderTriggerV1 = Object.freeze({
          ...triggerEvent,
          materializationOrigin: payload.origin,
        });
        const started = closure.root[0];
        if (started === undefined) throw new LifecycleError("INTEGRITY_FAILURE");
        const target = deriveCompatibilityLogTarget(
          started.occurredAt,
          sessionId as never,
          revision,
        );
        if (
          target.targetKey !== payload.targetKey
          || target.artifactPath !== payload.artifactPath
          || target.materializationRevision !== payload.materializationRevision
          || target.targetKey !== row.target_key
          || target.artifactPath !== row.artifact_path
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        const projection = projectCompatibilityLogV2({ closure, trigger, target });
        if (
          projection.materialization.triggeringEventType !== payload.triggeringEventType
          || projection.materialization.triggeringEventPosition !== revision.toString()
          || projection.materialization.triggeringPayloadHash !== payload.triggeringPayloadHash
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        rendered = renderCompatibilityLogV2(projection);

        if (this.provider === undefined) {
          throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
        }
        const keyId = payload.nextFingerprint.keyId;
        let status: "available" | "revoked" | "unavailable";
        try {
          status = await this.provider.status(keyId);
        } catch (error) {
          if (error instanceof HistoricalEvidenceKeyUnavailableError) {
            throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
          }
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
        if (status === "revoked" || status === "unavailable") {
          throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
        }
        if (status !== "available") throw new LifecycleError("INTEGRITY_FAILURE");
        let recomputed: string;
        try {
          recomputed = await this.provider.fingerprint(keyId, rendered);
        } catch (error) {
          if (error instanceof HistoricalEvidenceKeyUnavailableError) {
            throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
          }
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
        if (
          !LOWER_HASH.test(recomputed)
          || recomputed !== payload.nextFingerprint.value
          || recomputed !== row.next_fingerprint
        ) throw new LifecycleError("INTEGRITY_FAILURE");
      } catch (error) {
        if (
          error instanceof LifecycleError
          && error.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
        ) throw error;
        issue(sink, "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH");
      } finally {
        rendered?.fill(0);
      }
    }
  }

  private async checkQualifiedQuick(
    context: ProjectContext,
    sink: IntegrityIssueSink,
    includeBoundedHistory = true,
    qualifiedSchema = this.hasQualifiedLifecycleSchema(),
    verifyFrozenMarkerBindings = false,
  ): Promise<QualifiedQuickResult> {
    const statuses = new Map<string, "available">();
    const readonlyAvailableStatuses: ReadonlyMap<string, "available"> = statuses;
    if (!qualifiedSchema) {
      return { qualifiedSchema: false, statuses: readonlyAvailableStatuses };
    }

    const projectId = context.binding.projectId;
    const currentRows = this.connection.prepare(`
      SELECT DISTINCT session_id
      FROM session_evidence_coverage
      WHERE project_id = $projectId
      ORDER BY CAST(session_id AS BLOB)
    `).all({ $projectId: projectId });
    const sessionIds = currentRows.map((row) => {
      if (typeof row.session_id !== "string") {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      return row.session_id;
    });
    const counts = this.connection.prepare(`
      SELECT
        (SELECT count(*) FROM session_evidence_coverage
         WHERE project_id = $projectId) AS aggregate_count,
        (SELECT count(*) FROM session_evidence_coverage_transition_heads
         WHERE project_id = $projectId) AS head_count
    `).get({ $projectId: projectId });
    if (
      counts === undefined
      || decimal(counts.aggregate_count) === null
      || decimal(counts.aggregate_count) !== decimal(counts.head_count)
    ) {
      issue(sink, "SESSION_EVIDENCE_COVERAGE_MISMATCH");
      return { qualifiedSchema: true, statuses: readonlyAvailableStatuses };
    }

    const profileIds = new Set<string>();
    const collector: Pick<
      CapabilityKeyProvider,
      "currentKey" | "status" | "fingerprint"
    > = {
      currentKey(): never {
        throw new LifecycleError("INTEGRITY_FAILURE");
      },
      status(_scope, _purpose, keyId) {
        profileIds.add(keyId);
        return "available";
      },
      fingerprint(): never {
        throw new LifecycleError("INTEGRITY_FAILURE");
      },
    };
    try {
      new EvidenceCoverageRepository(collector).assertQuickHealthy(
        this.connection,
        sessionIds as never,
      );
      this.checkLatestEvidenceEventProjection(context);
    } catch {
      issue(sink, "SESSION_EVIDENCE_COVERAGE_MISMATCH");
      return { qualifiedSchema: true, statuses: readonlyAvailableStatuses };
    }

    for (const keyId of [...profileIds].sort(binaryCompare)) {
      if (this.provider === undefined) {
        throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
      }
      let status: "available" | "revoked" | "unavailable";
      try {
        status = await this.provider.status(keyId);
      } catch (error) {
        if (error instanceof HistoricalEvidenceKeyUnavailableError) {
          throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
        }
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      if (status === "revoked" || status === "unavailable") {
        throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
      }
      if (status !== "available") throw new LifecycleError("INTEGRITY_FAILURE");
      statuses.set(keyId, "available");
    }
    const cached: Pick<
      CapabilityKeyProvider,
      "currentKey" | "status" | "fingerprint"
    > = {
      currentKey(): never {
        throw new LifecycleError("INTEGRITY_FAILURE");
      },
      status(_scope, _purpose, keyId) {
        const status = statuses.get(keyId);
        if (status === undefined) throw new LifecycleError("INTEGRITY_FAILURE");
        return status;
      },
      fingerprint(): never {
        throw new LifecycleError("INTEGRITY_FAILURE");
      },
    };
    const coverage = new EvidenceCoverageRepository(cached);
    if (verifyFrozenMarkerBindings) {
      try {
        this.checkFrozenWorkflowIntegrity(context);
      } catch {
        issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
        return { qualifiedSchema: true, statuses: readonlyAvailableStatuses };
      }
    }
    if (includeBoundedHistory) {
      try {
        this.checkCurrentCheckpointIndexes(context);
      } catch {
        issue(sink, "SESSION_AUTHORITY_FOLD_MISMATCH");
        return { qualifiedSchema: true, statuses: readonlyAvailableStatuses };
      }
    }
    try {
      this.checkProspectiveCapacity(context, coverage, sessionIds);
    } catch {
      issue(sink, "SESSION_EVIDENCE_COVERAGE_MISMATCH");
    }
    return { qualifiedSchema: true, statuses: readonlyAvailableStatuses };
  }

  private async checkQualifiedFullReplay(
    context: ProjectContext,
    sink: IntegrityIssueSink,
    availableStatuses: ReadonlyMap<string, "available">,
  ): Promise<void> {
    const replayStatuses = new Map<string, "available">(availableStatuses);
    const opened: Array<{ close(): void }> = [];
    let failure: unknown;
    try {
      const events = this.openLifecycleEventCursor(context.binding.projectId);
      opened.push(events);
      const children = openChildEventFoldCursor(
        this.connection,
        context.binding.projectId,
      );
      opened.push(children);
      const workflows = openWorkflowGenerationFoldCursor(
        this.connection,
        context.binding.projectId,
      );
      opened.push(workflows);
      const transitions = this.openQualifiedTransitionCursor(
        context.binding.projectId,
      );
      opened.push(transitions);
      const ordinals = this.openQualifiedOrdinalCursor(
        context.binding.projectId,
      );
      opened.push(ordinals);
      const intents = this.indexWorkflowIntents(context);
      const checkpointPlan = this.indexHistoricalCheckpointBases(context);
      const preIndexes = this.indexReplayPreIndexes(context);
      const endpoints = this.indexReplayEndpoints(context);
      await this.replayProjectionCorrespondence(
        context,
        events,
        children,
        workflows,
        transitions,
        ordinals,
        intents,
        checkpointPlan,
        preIndexes,
        endpoints,
        replayStatuses,
        sink,
      );
    } catch (error) {
      failure = error;
    } finally {
      for (const cursor of opened.reverse()) {
        try {
          cursor.close();
        } catch {
          if (failure === undefined) {
            failure = new LifecycleError("INTEGRITY_FAILURE");
          }
        }
      }
    }
    if (failure !== undefined) throw failure;
  }

  private openLifecycleEventCursor(
    projectId: string,
  ): DetachedReplayCursor<StoredEvent> {
    return openDetachedReplayCursor(
      this.connection,
      projectId,
      LIFECYCLE_EVENT_CURSOR_SQL,
      (row) => this.hydrateReplayEvent(row),
    );
  }

  private openQualifiedTransitionCursor(
    projectId: string,
  ): DetachedReplayCursor<QualifiedTransitionReplayRow> {
    return openDetachedReplayCursor(
      this.connection,
      projectId,
      QUALIFIED_TRANSITION_CURSOR_SQL,
      (row) => this.hydrateQualifiedTransition(row),
    );
  }

  private openQualifiedOrdinalCursor(
    projectId: string,
  ): DetachedReplayCursor<ImmutableOrdinalIdentity> {
    return openDetachedReplayCursor(
      this.connection,
      projectId,
      QUALIFIED_ORDINAL_CURSOR_SQL,
      (row) => this.hydrateImmutableOrdinal(row),
    );
  }

  private async replayProjectionCorrespondence(
    context: ProjectContext,
    events: DetachedReplayCursor<StoredEvent>,
    children: ChildEventFoldCursor,
    workflows: WorkflowGenerationFoldCursor,
    transitions: DetachedReplayCursor<QualifiedTransitionReplayRow>,
    ordinals: DetachedReplayCursor<ImmutableOrdinalIdentity>,
    intents: ReadonlyMap<string, IndexedReplayIntent>,
    checkpointPlan: HistoricalCheckpointPlan,
    preIndexes: ReplayPreIndexes,
    endpoints: ReplayEndpointIndexes,
    replayStatuses: Map<string, "available">,
    sink: IntegrityIssueSink,
  ): Promise<void> {
    const aggregates = new Map<string, SessionAggregateState>();
    const authorityPositions = new Map<string, bigint>();
    const checkpointRequirements = new Map<string, CheckpointRequirementFold>();
    const revocations = new Map<string, RevocationFold>();
    const terminalAts = new Map<string, string>();
    const childHeads = new Map<string, ChildEventFoldProjection>();
    const reportWitnesses = new Map<
      string,
      Map<string, ChildEventFoldProjection>
    >();
    const workflowHeads = new Map<string, WorkflowGenerationFoldProjection>();
    const pendingWorkflows = new Map<string, WorkflowGenerationFoldProjection>();
    const immutableOrdinals = new Map<string, ImmutableOrdinalIdentity>();
    const evidenceStates = new Map<string, EvidenceReplaySessionState>();
    const historicalSnapshots = new Map<string, HistoricalCheckpointCapture>();
    const reconstructedCheckpoints = new Map<string, Checkpoint>();
    const checkpointEvidenceRevisions = new Map<string, CheckpointEvidenceRevision>();
    const capturedChildren = new Map<string, ChildEventFoldProjection>();
    const liveChildrenByRoot = new Map<string, Set<string>>();
    const activeTicketsByRoot = new Map<string, Set<string>>();
    const consumedTicketCreates = new Set<string>();
    const consumedTicketClaims = new Set<string>();
    const deferredV2TransferSessions = new Set<string>();
    const deferredV2TransferStreamVersions = new Map<string, bigint>();
    const transferSuspensions = new Map<string, TransferSuspensionWitness>();
    const workflowStates = new Map<string, WorkflowReplayState>();
    const consumedValidations = new Set<string>();

    while (events.peek() !== null) {
      const event = events.advance();
      const currentOrdinals = this.drainCurrentOrdinalGroup(
        ordinals,
        event,
        immutableOrdinals,
      );
      const transition = transitions.peek();
      if (
        transition !== null
        && transition.batchEventPosition < event.globalPosition
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const lifecycleScoped = event.streamType === "session"
        && event.sessionId !== null
        && LIFECYCLE_EVENT_TYPE_SET.has(event.eventType);
      if (!lifecycleScoped) {
        if (
          currentOrdinals.length !== 0
          || transition?.batchEventPosition === event.globalPosition
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        this.assertNoChildProjectionAtOrBefore(children, event.globalPosition);
        this.assertNoWorkflowProjectionAtOrBefore(workflows, event.globalPosition);
        this.captureHistoricalEvidenceBases(
          event.globalPosition,
          checkpointPlan.byBase,
          aggregates,
          evidenceStates,
          historicalSnapshots,
          capturedChildren,
          liveChildrenByRoot,
          activeTicketsByRoot,
          deferredV2TransferSessions,
          preIndexes,
          childHeads,
        );
        continue;
      }
      if (!this.eventMatchesContext(context, event)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const decoded = this.foldReplayAuthority(event, aggregates);
      const deferredV2Transfer = decoded.eventType === "ChildWorkTransferCreated"
        && decoded.eventSchemaVersion === 2;
      if (deferredV2Transfer) {
        deferredV2TransferSessions.add(event.sessionId!);
        deferredV2TransferStreamVersions.set(event.sessionId!, event.streamVersion);
      }
      if (
        event.sessionId !== null
        && Object.prototype.hasOwnProperty.call(decoded.payload, "authorityCommitment")
      ) authorityPositions.set(event.sessionId, event.globalPosition);
      this.evolveReplayCheckpointRequirement(
        event,
        decoded,
        checkpointRequirements,
      );
      if (!deferredV2Transfer) {
        const aggregateAtEvent = aggregates.get(event.sessionId!);
        if (
          aggregateAtEvent?.terminalEventPosition === event.globalPosition
        ) terminalAts.set(event.sessionId!, event.occurredAt);
        this.evolveReplayRevocation(event, decoded, revocations);
      }
      if (
        decoded.eventType === "EvidenceCoverageRecorded"
        && decoded.eventSchemaVersion === 2
      ) {
        if (
          transition === null
          || transition.batchEventPosition !== event.globalPosition
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        await this.replayEvidenceTransition(
          context,
          event,
          decoded.payload,
          transition,
          currentOrdinals,
          immutableOrdinals,
          evidenceStates,
          replayStatuses,
          sink,
        );
        transitions.advance();
      } else if (
        decoded.eventType === "EvidenceCoverageRecorded"
        && decoded.eventSchemaVersion === 1
      ) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      } else if (
        currentOrdinals.length !== 0
        || transition?.batchEventPosition === event.globalPosition
      ) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      if (decoded.eventType === "SessionCheckpointRecorded") {
        const reconstructed = this.assertHistoricalCheckpoint(
          context,
          event,
          decoded,
          intents,
          historicalSnapshots,
          endpoints,
        );
        if (reconstructedCheckpoints.has(reconstructed.checkpointId)) {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
        reconstructedCheckpoints.set(reconstructed.checkpointId, reconstructed);
        const capture = historicalSnapshots.get(this.historicalSnapshotKey(
          reconstructed.sessionId,
          BigInt(reconstructed.baseEventPosition),
        ));
        if (capture === undefined || checkpointEvidenceRevisions.has(reconstructed.checkpointId)) {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
        checkpointEvidenceRevisions.set(reconstructed.checkpointId, deeplyFreeze({
          sessionId: reconstructed.sessionId,
          checkpointVersion: reconstructed.checkpointVersion,
          revisionEventPosition: capture.evidenceRevisionEventPosition,
          adapterCount: capture.evidenceAdapterCount,
        }));
        this.applyFinalCheckpointWorkflowState(
          event,
          decoded,
          intents.get(event.commandId),
          reconstructed,
          reconstructedCheckpoints,
          checkpointEvidenceRevisions,
          preIndexes,
          evidenceStates,
          workflowStates,
        );
      }
      const classification = classifyChildProjectionEvent(event);
      if (deferredV2Transfer) {
        const opaqueProjection = children.peek();
        if (
          opaqueProjection === null
          || opaqueProjection.projectId !== context.binding.projectId
          || opaqueProjection.eventPosition !== event.globalPosition
          || opaqueProjection.childSessionId !== event.sessionId
          || opaqueProjection.rootSessionId !== event.parentSessionId
          || opaqueProjection.streamVersion !== event.streamVersion
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        children.advance();
        if (event.parentSessionId !== null) {
          liveChildrenByRoot.get(event.parentSessionId)?.delete(event.sessionId!);
        }
      } else if (classification === "child-only" || classification === "dual-scope-child") {
        if (event.sessionId === null) throw new LifecycleError("INTEGRITY_FAILURE");
        const previous = childHeads.get(event.sessionId) ?? null;
        const reportId = this.replayReportId(decoded);
        const witness = reportId === null
          ? null
          : reportWitnesses.get(event.sessionId)?.get(reportId) ?? null;
        let expected: ChildEventFoldProjection;
        try {
          expected = foldChildEventProjection(previous, event, witness);
        } catch {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
        const actual = children.peek();
        if (
          actual === null
          || actual.eventPosition !== event.globalPosition
          || actual.childSessionId !== expected.childSessionId
          || actual.streamVersion !== expected.streamVersion
          || !this.sameChildProjection(actual, expected)
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        children.advance();
        childHeads.set(event.sessionId, expected);
        let liveChildren = liveChildrenByRoot.get(expected.rootSessionId);
        if (liveChildren === undefined) {
          liveChildren = new Set<string>();
          liveChildrenByRoot.set(expected.rootSessionId, liveChildren);
        }
        if (
          expected.childState === "completed"
          || expected.childState === "transferred"
        ) liveChildren.delete(expected.childSessionId);
        else liveChildren.add(expected.childSessionId);
        if (
          checkpointPlan.childIdsByPosition.get(event.globalPosition)
            ?.has(expected.childSessionId) === true
        ) {
          const captureKey = this.childCaptureKey(
            expected.childSessionId,
            event.globalPosition,
          );
          if (capturedChildren.has(captureKey)) {
            throw new LifecycleError("INTEGRITY_FAILURE");
          }
          capturedChildren.set(captureKey, deeplyFreeze({ ...expected }));
        }
        if (decoded.eventType === "ChildWorkReported") {
          const reportId = expected.reportedReportId;
          if (reportId === null) throw new LifecycleError("INTEGRITY_FAILURE");
          let byId = reportWitnesses.get(event.sessionId);
          if (byId === undefined) {
            byId = new Map<string, ChildEventFoldProjection>();
            reportWitnesses.set(event.sessionId, byId);
          }
          if (byId.has(reportId)) throw new LifecycleError("INTEGRITY_FAILURE");
          byId.set(reportId, expected);
        }
      }
      this.assertNoChildProjectionAtOrBefore(children, event.globalPosition);

      this.consumeTransferTicketGroups(
        event,
        decoded,
        preIndexes,
        aggregates,
        reconstructedCheckpoints,
        transferSuspensions,
        activeTicketsByRoot,
        consumedTicketCreates,
        consumedTicketClaims,
      );

      const workflow = classifyWorkflowProjectionEvent(event);
      if (workflow.kind === "identified") {
        const indexedIntent = intents.get(event.commandId);
        if (indexedIntent === undefined) throw new LifecycleError("INTEGRITY_FAILURE");
        const witness = indexedIntent.witness;
        this.assertWorkflowIntentEventContext(context, event, witness);
        const pending = pendingWorkflows.get(workflow.workflowId);
        const semanticTerminal = event.eventType === "SessionEndCancelled"
          || event.eventType === "SessionAbandoned";
        if (
          pending !== undefined
          && (
            !semanticTerminal
            || pending.workflowGeneration !== workflow.workflowGeneration
          )
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        const previous = pending
          ?? workflowHeads.get(workflow.workflowId)
          ?? null;
        let expected: WorkflowGenerationFoldProjection;
        try {
          expected = foldWorkflowGenerationProjection(
            previous,
            event,
            witness,
            pending === undefined ? "live-schema-3" : "schema-2-preflight",
          );
        } catch {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
        const actual = workflows.peek();
        const exactCurrent = actual !== null
          && actual.triggerEventPosition === event.globalPosition
          && actual.workflowId === workflow.workflowId
          && actual.workflowGeneration === workflow.workflowGeneration;
        if (exactCurrent) {
          if (!this.sameWorkflowProjection(actual, expected)) {
            throw new LifecycleError("INTEGRITY_FAILURE");
          }
          workflows.advance();
          workflowHeads.set(workflow.workflowId, expected);
          pendingWorkflows.delete(workflow.workflowId);
        } else if (
          pending === undefined
          && (event.eventType === "SessionEndRequested"
            || event.eventType === "SessionEndAmended")
          && (actual === null || actual.triggerEventPosition > event.globalPosition)
        ) {
          pendingWorkflows.set(workflow.workflowId, expected);
        } else {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
        workflowStates.set(workflow.workflowId, this.evolveWorkflowGenerationState(
          event,
          decoded,
          indexedIntent,
          expected,
          aggregates.get(event.sessionId!),
          workflowStates.get(workflow.workflowId),
        ));
      }
      this.assertNoWorkflowProjectionAtOrBefore(workflows, event.globalPosition);
      this.evolveWorkflowSemanticState(
        event,
        decoded,
        intents.get(event.commandId),
        preIndexes,
        workflowStates,
        consumedValidations,
      );
      this.captureHistoricalEvidenceBases(
        event.globalPosition,
        checkpointPlan.byBase,
        aggregates,
        evidenceStates,
        historicalSnapshots,
        capturedChildren,
        liveChildrenByRoot,
        activeTicketsByRoot,
        deferredV2TransferSessions,
        preIndexes,
        childHeads,
      );
    }
    if (children.peek() !== null) throw new LifecycleError("INTEGRITY_FAILURE");
    if (pendingWorkflows.size !== 0) throw new LifecycleError("INTEGRITY_FAILURE");
    if (workflows.peek() !== null) throw new LifecycleError("INTEGRITY_FAILURE");
    if (transitions.peek() !== null) throw new LifecycleError("INTEGRITY_FAILURE");
    if (ordinals.peek() !== null) throw new LifecycleError("INTEGRITY_FAILURE");
    if (
      consumedTicketCreates.size !== preIndexes.transferTickets.length
      || preIndexes.transferTickets.some((ticket) => (
        ticket.claimed_event_position !== null
        && !consumedTicketClaims.has(String(ticket.transfer_ticket_id))
      ))
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    if (consumedValidations.size !== preIndexes.validations.length) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    this.assertReplayEndpointCorrespondence(
      context,
      preIndexes,
      endpoints,
      aggregates,
      authorityPositions,
      checkpointRequirements,
      revocations,
      terminalAts,
      childHeads,
      deferredV2TransferSessions,
      deferredV2TransferStreamVersions,
      workflowHeads,
      workflowStates,
      reconstructedCheckpoints,
      evidenceStates,
    );
  }

  private hydrateQualifiedTransition(
    row: SqliteRow,
  ): QualifiedTransitionReplayRow {
    const batchEventPosition = int64(row.batch_event_position);
    const batchFirstOrdinal = int64(row.batch_first_ordinal, true);
    const batchLastOrdinal = int64(row.batch_last_ordinal, true);
    const coverageFirstOrdinal = int64(row.coverage_first_ordinal, true);
    const coverageLastOrdinal = int64(row.coverage_last_ordinal, true);
    const highestRaw = signedCoverageInt64(row.highest_contiguous_ordinal);
    const newFrameCount = integer(row.new_frame_count);
    const contentRetained = integer(row.content_retained);
    const decodedIntervals = canonicalCoverageIntervals(row.missing_intervals_json);
    if (
      batchEventPosition === null
      || batchFirstOrdinal === null
      || batchLastOrdinal === null
      || batchLastOrdinal < batchFirstOrdinal
      || coverageFirstOrdinal !== 0n
      || coverageLastOrdinal === null
      || highestRaw === null
      || highestRaw < -1n
      || highestRaw > coverageLastOrdinal
      || newFrameCount === null
      || newFrameCount < 0
      || contentRetained !== 0
      || !nonEmpty(row.project_id)
      || !nonEmpty(row.session_id)
      || !nonEmpty(row.adapter_session_id)
      || !nonEmpty(row.batch_id)
      || row.frame_fingerprint_algorithm !== "hmac-sha256"
      || integer(row.frame_fingerprint_schema_version) !== 1
      || !nonEmpty(row.frame_fingerprint_key_id)
      || row.frame_fingerprint_domain !== "pm-evidence-frame-v1"
      || (
        row.previous_coverage_fingerprint_value !== null
        && (
          typeof row.previous_coverage_fingerprint_value !== "string"
          || !LOWER_HASH.test(row.previous_coverage_fingerprint_value)
        )
      )
      || row.coverage_fingerprint_algorithm !== "hmac-sha256"
      || integer(row.coverage_fingerprint_schema_version) !== 1
      || row.coverage_fingerprint_key_id !== row.frame_fingerprint_key_id
      || row.coverage_fingerprint_domain !== "pm-evidence-coverage-v1"
      || typeof row.coverage_fingerprint_value !== "string"
      || !LOWER_HASH.test(row.coverage_fingerprint_value)
      || row.capture_mode !== "coverage-only"
      || !nonEmpty(row.created_at)
      || typeof row.missing_intervals_json !== "string"
      || decodedIntervals === null
      || decodedIntervals.length > 200
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const intervals: Array<{ firstOrdinal: bigint; lastOrdinal: bigint }> = [];
    let priorLast = -2n;
    for (const value of decodedIntervals) {
      const firstOrdinal = value.firstOrdinal;
      const lastOrdinal = value.lastOrdinal;
      if (
        firstOrdinal > SQLITE_INT64_MAX
        || lastOrdinal > SQLITE_INT64_MAX
        || lastOrdinal < firstOrdinal
        || lastOrdinal > coverageLastOrdinal
        || firstOrdinal <= priorLast + 1n
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      intervals.push(deeplyFreeze({ firstOrdinal, lastOrdinal }));
      priorLast = lastOrdinal;
    }
    return deeplyFreeze({
      projectId: row.project_id as string,
      sessionId: row.session_id as string,
      adapterSessionId: row.adapter_session_id as string,
      batchId: row.batch_id as string,
      batchEventPosition,
      batchFirstOrdinal,
      batchLastOrdinal,
      coverageFirstOrdinal,
      coverageLastOrdinal,
      highestContiguousOrdinal: highestRaw === -1n ? null : highestRaw,
      missingIntervals: intervals,
      missingIntervalsJson: row.missing_intervals_json,
      frameFingerprintAlgorithm: "hmac-sha256" as const,
      frameFingerprintSchemaVersion: 1 as const,
      frameFingerprintKeyId: row.frame_fingerprint_key_id as string,
      frameFingerprintDomain: "pm-evidence-frame-v1" as const,
      previousCoverageFingerprintValue:
        row.previous_coverage_fingerprint_value as string | null,
      coverageFingerprintAlgorithm: "hmac-sha256" as const,
      coverageFingerprintSchemaVersion: 1 as const,
      coverageFingerprintKeyId: row.coverage_fingerprint_key_id as string,
      coverageFingerprintDomain: "pm-evidence-coverage-v1" as const,
      coverageFingerprintValue: row.coverage_fingerprint_value,
      newFrameCount,
      captureMode: "coverage-only" as const,
      contentRetained: false as const,
      createdAt: row.created_at as string,
    });
  }

  private hydrateImmutableOrdinal(row: SqliteRow): ImmutableOrdinalIdentity {
    const ordinal = int64(row.ordinal, true);
    const recordedEventPosition = int64(row.recorded_event_position);
    const sourceKinds = new Set([
      "model-turn",
      "tool-request",
      "tool-result",
      "adapter-event",
      "external-observation",
    ]);
    if (
      ordinal === null
      || recordedEventPosition === null
      || !nonEmpty(row.project_id)
      || !nonEmpty(row.session_id)
      || !nonEmpty(row.adapter_session_id)
      || !nonEmpty(row.frame_id)
      || typeof row.source_kind !== "string"
      || !sourceKinds.has(row.source_kind)
      || !nonEmpty(row.observed_at)
      || row.fingerprint_algorithm !== "hmac-sha256"
      || integer(row.fingerprint_schema_version) !== 1
      || !nonEmpty(row.fingerprint_key_id)
      || row.fingerprint_domain !== "pm-evidence-frame-v1"
      || typeof row.fingerprint_value !== "string"
      || !LOWER_HASH.test(row.fingerprint_value)
      || !nonEmpty(row.batch_id)
      || !nonEmpty(row.created_at)
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    return deeplyFreeze({
      sessionId: row.session_id as string,
      adapterSessionId: row.adapter_session_id as string,
      ordinal,
      frameId: row.frame_id as string,
      sourceKind: row.source_kind,
      observedAt: row.observed_at as string,
      fingerprintAlgorithm: "hmac-sha256" as const,
      fingerprintSchemaVersion: 1 as const,
      fingerprintKeyId: row.fingerprint_key_id as string,
      fingerprintDomain: "pm-evidence-frame-v1" as const,
      fingerprintValue: row.fingerprint_value,
      batchId: row.batch_id as string,
      recordedEventPosition,
      createdAt: row.created_at as string,
    });
  }

  private immutableOrdinalKey(
    sessionId: string,
    adapterSessionId: string,
    ordinal: bigint,
  ): string {
    return canonicalJson([sessionId, adapterSessionId, ordinal.toString()]);
  }

  private drainCurrentOrdinalGroup(
    cursor: DetachedReplayCursor<ImmutableOrdinalIdentity>,
    event: StoredEvent,
    identities: Map<string, ImmutableOrdinalIdentity>,
  ): readonly ImmutableOrdinalIdentity[] {
    const lookahead = cursor.peek();
    if (
      lookahead !== null
      && lookahead.recordedEventPosition < event.globalPosition
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const current: ImmutableOrdinalIdentity[] = [];
    while (cursor.peek()?.recordedEventPosition === event.globalPosition) {
      const identity = cursor.advance();
      const key = this.immutableOrdinalKey(
        identity.sessionId,
        identity.adapterSessionId,
        identity.ordinal,
      );
      if (identities.has(key)) throw new LifecycleError("INTEGRITY_FAILURE");
      identities.set(key, identity);
      current.push(identity);
    }
    return deeplyFreeze(current);
  }

  private sameReplayIntervals(
    stored: readonly { readonly firstOrdinal: bigint; readonly lastOrdinal: bigint }[],
    expected: readonly { readonly firstOrdinal: string; readonly lastOrdinal: string }[],
  ): boolean {
    return stored.length === expected.length && stored.every((interval, index) => (
      interval.firstOrdinal.toString() === expected[index]?.firstOrdinal
      && interval.lastOrdinal.toString() === expected[index]?.lastOrdinal
    ));
  }

  private async requireReplayStatus(
    keyId: string,
    statuses: Map<string, "available">,
  ): Promise<void> {
    if (statuses.has(keyId)) return;
    if (this.provider === undefined) {
      throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
    }
    let status: "available" | "revoked" | "unavailable";
    try {
      status = await this.provider.status(keyId);
    } catch (error) {
      if (error instanceof HistoricalEvidenceKeyUnavailableError) {
        throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
      }
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (status === "revoked" || status === "unavailable") {
      throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
    }
    if (status !== "available") throw new LifecycleError("INTEGRITY_FAILURE");
    statuses.set(keyId, "available");
  }

  private async replayEvidenceTransition(
    context: ProjectContext,
    event: StoredEvent,
    payload: EvidenceCoverageRecordedV2,
    transition: QualifiedTransitionReplayRow,
    currentOrdinals: readonly ImmutableOrdinalIdentity[],
    identities: ReadonlyMap<string, ImmutableOrdinalIdentity>,
    states: Map<string, EvidenceReplaySessionState>,
    statuses: Map<string, "available">,
    sink: IntegrityIssueSink,
  ): Promise<void> {
    if (
      event.sessionId === null
      || transition.projectId !== context.binding.projectId
      || transition.projectId !== event.projectId
      || transition.sessionId !== event.sessionId
      || transition.adapterSessionId !== payload.adapterSessionId
      || transition.batchId !== payload.batchId
      || transition.batchEventPosition !== event.globalPosition
      || transition.createdAt !== event.occurredAt
      || transition.frameFingerprintAlgorithm !== payload.frameFingerprintAlgorithm
      || transition.frameFingerprintSchemaVersion !== payload.frameFingerprintSchemaVersion
      || transition.frameFingerprintKeyId !== payload.frameFingerprintKeyId
      || transition.frameFingerprintDomain !== payload.frameFingerprintDomain
      || transition.coverageFingerprintAlgorithm !== payload.coverageFingerprintAlgorithm
      || transition.coverageFingerprintSchemaVersion !== payload.coverageFingerprintSchemaVersion
      || transition.coverageFingerprintKeyId !== payload.coverageFingerprintKeyId
      || transition.coverageFingerprintDomain !== payload.coverageFingerprintDomain
      || transition.coverageFingerprintValue !== payload.coverageFingerprint
      || transition.captureMode !== payload.captureMode
      || transition.contentRetained !== payload.contentRetained
      || transition.batchFirstOrdinal.toString() !== payload.batchFirstOrdinal
      || transition.batchLastOrdinal.toString() !== payload.batchLastOrdinal
      || transition.coverageFirstOrdinal.toString() !== payload.coverageFirstOrdinal
      || transition.coverageLastOrdinal.toString() !== payload.coverageLastOrdinal
      || (transition.highestContiguousOrdinal?.toString() ?? null)
        !== payload.highestContiguousOrdinal
      || !this.sameReplayIntervals(transition.missingIntervals, payload.missingIntervals)
    ) throw new LifecycleError("INTEGRITY_FAILURE");

    let sessionState = states.get(event.sessionId);
    if (sessionState === undefined) {
      sessionState = {
        adapters: new Map<string, EvidenceReplayState>(),
        adapterCount: 0,
        totalIntervalCount: 0,
        canonicalEntryBytesTotal: 0,
        canonicalCoverageBytes: EMPTY_QUALIFIED_COVERAGE_CANONICAL_BYTES,
        revisionEventPosition: null,
      };
      states.set(event.sessionId, sessionState);
    }
    this.incrementReplayWork("evidenceTransitionAdapterLookups");
    const previous = sessionState.adapters.get(payload.adapterSessionId);
    if (
      transition.previousCoverageFingerprintValue
        !== (previous?.coverageFingerprint ?? null)
      || (previous !== undefined && (
        previous.checkpointEntry.frameFingerprintAlgorithm
          !== payload.frameFingerprintAlgorithm
        || previous.checkpointEntry.frameFingerprintSchemaVersion
          !== payload.frameFingerprintSchemaVersion
        || previous.checkpointEntry.frameFingerprintKeyId
          !== payload.frameFingerprintKeyId
        || previous.checkpointEntry.frameFingerprintDomain
          !== payload.frameFingerprintDomain
        || previous.checkpointEntry.coverageFingerprintAlgorithm
          !== payload.coverageFingerprintAlgorithm
        || previous.checkpointEntry.coverageFingerprintSchemaVersion
          !== payload.coverageFingerprintSchemaVersion
        || previous.checkpointEntry.coverageFingerprintKeyId
          !== payload.coverageFingerprintKeyId
        || previous.checkpointEntry.coverageFingerprintDomain
          !== payload.coverageFingerprintDomain
      ))
    ) throw new LifecycleError("INTEGRITY_FAILURE");

    const frameOrdinals: bigint[] = [];
    const newFrames: LifecycleEvidenceFrameRecordedV1[] = [];
    const currentKeys = new Set(currentOrdinals.map((identity) =>
      this.immutableOrdinalKey(
        identity.sessionId,
        identity.adapterSessionId,
        identity.ordinal,
      )));
    const expectedCurrentKeys = new Set<string>();
    for (const frame of payload.frames) {
      if (!UNSIGNED_DECIMAL.test(frame.ordinal)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const ordinal = BigInt(frame.ordinal);
      if (ordinal > SQLITE_INT64_MAX) throw new LifecycleError("INTEGRITY_FAILURE");
      frameOrdinals.push(ordinal);
      const key = this.immutableOrdinalKey(
        event.sessionId,
        payload.adapterSessionId,
        ordinal,
      );
      const identity = identities.get(key);
      if (
        identity === undefined
        || identity.recordedEventPosition > event.globalPosition
        || identity.frameId !== frame.frameId
        || identity.sourceKind !== frame.sourceKind
        || identity.observedAt !== frame.observedAt
        || identity.fingerprintAlgorithm !== payload.frameFingerprintAlgorithm
        || identity.fingerprintSchemaVersion !== payload.frameFingerprintSchemaVersion
        || identity.fingerprintKeyId !== payload.frameFingerprintKeyId
        || identity.fingerprintDomain !== payload.frameFingerprintDomain
        || identity.fingerprintValue !== frame.contentFingerprint
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      if (identity.recordedEventPosition === event.globalPosition) {
        if (
          identity.sessionId !== event.sessionId
          || identity.adapterSessionId !== payload.adapterSessionId
          || identity.batchId !== payload.batchId
          || identity.createdAt !== event.occurredAt
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        expectedCurrentKeys.add(key);
        newFrames.push(deeplyFreeze({ ...frame }));
      }
    }
    if (
      currentKeys.size !== expectedCurrentKeys.size
      || [...currentKeys].some((key) => !expectedCurrentKeys.has(key))
      || transition.newFrameCount !== newFrames.length
      || frameOrdinals.length === 0
      || transition.batchFirstOrdinal !== frameOrdinals[0]
      || transition.batchLastOrdinal !== frameOrdinals.at(-1)
    ) throw new LifecycleError("INTEGRITY_FAILURE");

    let advanced: ReturnType<typeof advanceEvidenceCoverageIntervals>;
    try {
      advanced = advanceEvidenceCoverageIntervals({
        priorCoverageLastOrdinal: previous?.coverageLastOrdinal ?? null,
        priorMissingIntervals: previous?.missingIntervals ?? [],
        newOrdinals: newFrames.map((frame) => BigInt(frame.ordinal)),
      });
    } catch {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (
      payload.coverageFirstOrdinal !== "0"
      || payload.coverageLastOrdinal !== advanced.coverageLastOrdinal
      || payload.highestContiguousOrdinal !== advanced.highestContiguousOrdinal
      || canonicalJson(payload.missingIntervals)
        !== canonicalJson(advanced.missingIntervals)
    ) throw new LifecycleError("INTEGRITY_FAILURE");

    const checkpointEntry = deeplyFreeze({
      adapterSessionId: payload.adapterSessionId,
      coverageFirstOrdinal: payload.coverageFirstOrdinal,
      coverageLastOrdinal: payload.coverageLastOrdinal,
      highestContiguousOrdinal: payload.highestContiguousOrdinal,
      missingIntervals: payload.missingIntervals,
      frameFingerprintAlgorithm: payload.frameFingerprintAlgorithm,
      frameFingerprintSchemaVersion: payload.frameFingerprintSchemaVersion,
      frameFingerprintKeyId: payload.frameFingerprintKeyId,
      frameFingerprintDomain: payload.frameFingerprintDomain,
      coverageFingerprintAlgorithm: payload.coverageFingerprintAlgorithm,
      coverageFingerprintSchemaVersion: payload.coverageFingerprintSchemaVersion,
      coverageFingerprintKeyId: payload.coverageFingerprintKeyId,
      coverageFingerprintDomain: payload.coverageFingerprintDomain,
      coverageFingerprint: payload.coverageFingerprint,
      latestBatchId: payload.batchId,
      latestBatchEventPosition: event.globalPosition.toString(),
    });
    this.incrementReplayWork("evidenceEntryCanonicalizations");
    const canonicalEntryBytes = Buffer.byteLength(canonicalJson(checkpointEntry), "utf8");
    const candidateState: EvidenceReplayState = deeplyFreeze({
      sessionId: event.sessionId,
      createdAt: previous?.createdAt ?? event.occurredAt,
      updatedAt: event.occurredAt,
      coverageLastOrdinal: BigInt(advanced.coverageLastOrdinal),
      missingIntervalsJson: transition.missingIntervalsJson,
      missingIntervals: transition.missingIntervals,
      coverageFingerprint: payload.coverageFingerprint,
      checkpointEntry,
      canonicalEntryBytes,
    });
    const candidateAdapterCount = sessionState.adapterCount + (previous === undefined ? 1 : 0);
    const candidateTotalIntervalCount = sessionState.totalIntervalCount
      - (previous?.missingIntervals.length ?? 0)
      + checkpointEntry.missingIntervals.length;
    const candidateEntryBytesTotal = sessionState.canonicalEntryBytesTotal
      - (previous?.canonicalEntryBytes ?? 0)
      + canonicalEntryBytes;
    const candidateCoverageBytes = EMPTY_QUALIFIED_COVERAGE_CANONICAL_BYTES
      + candidateEntryBytesTotal
      + Math.max(0, candidateAdapterCount - 1);
    if (
      candidateAdapterCount > 200
      || checkpointEntry.missingIntervals.length > CHECKPOINT_MAX_MISSING_INTERVALS
      || candidateTotalIntervalCount > CHECKPOINT_MAX_MISSING_INTERVALS
      || candidateCoverageBytes > CHECKPOINT_EVIDENCE_COVERAGE_MAX_CANONICAL_BYTES
    ) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }

    await this.requireReplayStatus(payload.coverageFingerprintKeyId, statuses);
    if (newFrames.length === 0) {
      if (
        previous === undefined
        || payload.coverageFingerprint !== previous.coverageFingerprint
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    } else {
      if (this.provider === undefined) {
        throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
      }
      const accumulator = deeplyFreeze({
        coverageAccumulatorVersion: 1,
        projectId: context.binding.projectId,
        storeId: context.binding.storeId,
        sessionId: event.sessionId,
        adapterSessionId: payload.adapterSessionId,
        previousCoverageFingerprint: previous?.coverageFingerprint ?? null,
        captureMode: "coverage-only" as const,
        contentRetained: false as const,
        frameFingerprintProfile: deeplyFreeze({
          algorithm: "hmac-sha256" as const,
          schemaVersion: 1 as const,
          keyId: payload.frameFingerprintKeyId,
          domain: "pm-evidence-frame-v1" as const,
        }),
        coverageFingerprintProfile: deeplyFreeze({
          algorithm: "hmac-sha256" as const,
          schemaVersion: 1 as const,
          keyId: payload.coverageFingerprintKeyId,
          domain: "pm-evidence-coverage-v1" as const,
        }),
        coverageFirstOrdinal: "0" as const,
        coverageLastOrdinal: advanced.coverageLastOrdinal,
        highestContiguousOrdinal: advanced.highestContiguousOrdinal,
        missingIntervals: advanced.missingIntervals,
        newFrames: deeplyFreeze(newFrames),
      });
      const bytes = Buffer.from(canonicalJson(accumulator), "utf8");
      let recomputed: string;
      try {
        try {
          recomputed = await this.provider.fingerprint(
            payload.coverageFingerprintKeyId,
            bytes,
          );
        } catch (error) {
          if (error instanceof HistoricalEvidenceKeyUnavailableError) {
            throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
          }
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
      } finally {
        bytes.fill(0);
      }
      if (!LOWER_HASH.test(recomputed)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      if (recomputed !== payload.coverageFingerprint) {
        issue(sink, "SESSION_EVIDENCE_COVERAGE_MISMATCH");
      }
    }
    sessionState.adapters.set(payload.adapterSessionId, candidateState);
    sessionState.adapterCount = candidateAdapterCount;
    sessionState.totalIntervalCount = candidateTotalIntervalCount;
    sessionState.canonicalEntryBytesTotal = candidateEntryBytesTotal;
    sessionState.canonicalCoverageBytes = candidateCoverageBytes;
    sessionState.revisionEventPosition = event.globalPosition;
  }

  private indexHistoricalCheckpointBases(
    context: ProjectContext,
  ): HistoricalCheckpointPlan {
    const rows = this.connection.prepare(`
      SELECT /* lifecycle-full:pre-index */ event.*
      FROM events AS event INDEXED BY events_project_position
      WHERE event.project_id = $projectId
        AND event.stream_type = 'session'
        AND event.session_id IS NOT NULL
        AND event.event_type = 'SessionCheckpointRecorded'
      ORDER BY event.global_position
    `).all({ $projectId: context.binding.projectId });
    const byBase = new Map<bigint, HistoricalCheckpointRequest[]>();
    const childIdsByPosition = new Map<bigint, Set<string>>();
    for (const row of rows) {
      const stored = this.hydrateReplayEvent({ ...row });
      let payload: unknown;
      try {
        payload = parsedCanonicalJson(stored.payloadJson);
      } catch {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const payloadRecord = record(payload) ? payload : null;
      const checkpoint = payloadRecord !== null && record(payloadRecord.checkpoint)
        ? payloadRecord.checkpoint
        : null;
      if (
        checkpoint === null
        || stored.sessionId === null
        || payloadRecord === null
        || !positiveDecimalString(payloadRecord.baseEventPosition)
        || !positiveDecimalString(payloadRecord.checkpointEventPosition)
        || !nonEmpty(checkpoint.checkpointId)
        || checkpoint.sessionId !== stored.sessionId
        || checkpoint.parentSessionId !== stored.parentSessionId
        || checkpoint.baseEventPosition !== payloadRecord.baseEventPosition
        || checkpoint.checkpointEventPosition !== payloadRecord.checkpointEventPosition
        || BigInt(payloadRecord.checkpointEventPosition as string) !== stored.globalPosition
        || stored.globalPosition !== BigInt(payloadRecord.baseEventPosition as string) + 1n
        || !Array.isArray(checkpoint.childSummaries)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const base = BigInt(String(payloadRecord.baseEventPosition));
      const seenChildren = new Set<string>();
      for (const candidate of checkpoint.childSummaries) {
        if (
          !record(candidate)
          || !nonEmpty(candidate.childSessionId)
          || seenChildren.has(candidate.childSessionId as string)
          || !positiveDecimalString(candidate.lastEventPosition)
          || !positiveDecimalString(candidate.streamVersion)
          || typeof candidate.state !== "string"
          || (
            candidate.latestCheckpointId !== null
            && !nonEmpty(candidate.latestCheckpointId)
          )
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        seenChildren.add(candidate.childSessionId as string);
        const position = BigInt(candidate.lastEventPosition as string);
        let childIds = childIdsByPosition.get(position);
        if (childIds === undefined) {
          childIds = new Set<string>();
          childIdsByPosition.set(position, childIds);
        }
        childIds.add(candidate.childSessionId as string);
      }
      let requests = byBase.get(base);
      if (requests === undefined) {
        requests = [];
        byBase.set(base, requests);
      }
      requests.push(deeplyFreeze({
        checkpointId: checkpoint.checkpointId as string,
        sessionId: stored.sessionId,
        baseEventPosition: base,
        checkpointEventPosition: stored.globalPosition,
        childSummaries: deeplyFreeze(checkpoint.childSummaries) as unknown as Checkpoint["childSummaries"],
      }));
    }
    return deeplyFreeze({ byBase, childIdsByPosition });
  }

  private historicalSnapshotKey(sessionId: string, base: bigint): string {
    return canonicalJson([sessionId, base.toString()]);
  }

  private childCaptureKey(childSessionId: string, position: bigint): string {
    return canonicalJson([childSessionId, position.toString()]);
  }

  private consumeTransferTicketGroups(
    stored: StoredEvent,
    event: LifecycleEventCodecResult,
    indexes: ReplayPreIndexes,
    aggregates: ReadonlyMap<string, SessionAggregateState>,
    checkpoints: ReadonlyMap<string, Checkpoint>,
    suspensions: Map<string, TransferSuspensionWitness>,
    activeByRoot: Map<string, Set<string>>,
    consumedCreates: Set<string>,
    consumedClaims: Set<string>,
  ): void {
    if (event.eventType === "ChildSessionSuspended") {
      if (stored.sessionId === null || suspensions.has(stored.sessionId)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      suspensions.set(stored.sessionId, deeplyFreeze({
        checkpointId: event.payload.checkpointId,
        streamVersion: stored.streamVersion,
        blockers: deeplyFreeze([...event.payload.blockers]),
        followUps: deeplyFreeze([...event.payload.followUps]),
      }));
    }
    const creates = indexes.ticketsByCreatePosition.get(stored.globalPosition) ?? [];
    const claims = indexes.ticketsByClaimPosition.get(stored.globalPosition) ?? [];
    if (event.eventType === "ChildWorkTransferCreated") {
      if (creates.length !== 1 || stored.sessionId === null) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const ticket = creates[0]!;
      const ticketId = event.payload.transferTicketId;
      if (
        ticket.transfer_ticket_id !== ticketId
        || ticket.source_child_session_id !== stored.sessionId
        || ticket.source_parent_session_id !== stored.parentSessionId
        || ticket.checkpoint_id !== event.payload.checkpointId
        || ticket.created_at !== stored.occurredAt
        || consumedCreates.has(ticketId)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      if (event.eventSchemaVersion === 1) {
        const aggregate = aggregates.get(stored.sessionId);
        const suspension = suspensions.get(stored.sessionId);
        const checkpoint = checkpoints.get(event.payload.checkpointId);
        if (
          aggregate === undefined
          || aggregate.kind !== "child"
          || suspension === undefined
          || checkpoint === undefined
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        const expectedAssignment = canonicalJson({
          assignmentId: aggregate.assignment.assignmentId,
          summary: aggregate.assignment.summary,
          scope: aggregate.assignment.scope,
          assignmentRevision: aggregate.assignmentRevision,
        });
        const expectedAnnotations = canonicalJson([{
          childTransferAnnotationsVersion: 1,
          blockers: [...suspension.blockers],
          followUps: [...suspension.followUps],
        }]);
        const expectedLegacyFollowUps = suspension.blockers.length === 0
          ? canonicalJson([...suspension.followUps])
          : null;
        if (
          aggregate.state !== "transferred"
          || aggregate.suspensionCheckpointId !== event.payload.checkpointId
          || aggregate.terminalEventPosition !== stored.globalPosition
          || suspension.checkpointId !== event.payload.checkpointId
          || suspension.streamVersion + 1n !== stored.streamVersion
          || ticket.source_assignment_json !== expectedAssignment
          || ticket.source_scope_json !== canonicalJson({
            scope: aggregate.assignment.scope,
          })
          || (
            ticket.follow_ups_json !== expectedAnnotations
            && ticket.follow_ups_json !== expectedLegacyFollowUps
          )
          || ticket.source_state_json !== canonicalJson(checkpoint.sourceState)
          || ticket.lineage_json !== canonicalJson({
            previousParentSessionId: stored.parentSessionId,
            previousChildSessionId: stored.sessionId,
            correlationId: aggregate.correlationId,
            transferEventPosition: stored.globalPosition.toString(),
          })
        ) throw new LifecycleError("INTEGRITY_FAILURE");
      }
      let active = activeByRoot.get(ticket.source_parent_session_id as string);
      if (active === undefined) {
        active = new Set<string>();
        activeByRoot.set(ticket.source_parent_session_id as string, active);
      }
      active.add(ticketId);
      consumedCreates.add(ticketId);
      suspensions.delete(stored.sessionId);
    } else if (creates.length !== 0) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (event.eventType === "ChildWorkTransferClaimed") {
      if (claims.length !== 1 || stored.sessionId === null) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const ticket = claims[0]!;
      const ticketId = event.payload.transferTicketId;
      const active = activeByRoot.get(ticket.source_parent_session_id as string);
      if (
        ticket.transfer_ticket_id !== ticketId
        || ticket.source_child_session_id !== event.payload.previousChildSessionId
        || decimal(ticket.created_event_position)
          !== event.payload.previousTransferEventPosition
        || ticket.claimed_by_root_session_id !== stored.parentSessionId
        || ticket.claimed_child_session_id !== stored.sessionId
        || ticket.claimed_at !== stored.occurredAt
        || active?.delete(ticketId) !== true
        || consumedClaims.has(ticketId)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      consumedClaims.add(ticketId);
    } else if (claims.length !== 0) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  private captureHistoricalEvidenceBases(
    position: bigint,
    requested: ReadonlyMap<bigint, readonly HistoricalCheckpointRequest[]>,
    aggregates: ReadonlyMap<string, SessionAggregateState>,
    states: ReadonlyMap<string, EvidenceReplaySessionState>,
    snapshots: Map<string, HistoricalCheckpointCapture>,
    capturedChildren: ReadonlyMap<string, ChildEventFoldProjection>,
    liveChildrenByRoot: ReadonlyMap<string, ReadonlySet<string>>,
    activeTicketsByRoot: ReadonlyMap<string, ReadonlySet<string>>,
    deferredV2TransferSessions: ReadonlySet<string>,
    preIndexes: ReplayPreIndexes,
    childHeads: ReadonlyMap<string, ChildEventFoldProjection>,
  ): void {
    const requests = requested.get(position);
    if (requests === undefined) return;
    for (const request of requests) {
      this.incrementReplayWork("checkpointEvidenceCaptures");
      const sessionId = request.sessionId;
      const aggregate = aggregates.get(sessionId);
      if (aggregate === undefined) throw new LifecycleError("INTEGRITY_FAILURE");
      const evidenceState = states.get(sessionId);
      const adapterSessions = [...(evidenceState?.adapters.values() ?? [])]
        .map((state) => state.checkpointEntry)
        .sort((left, right) => binaryCompare(
          left.adapterSessionId,
          right.adapterSessionId,
        ));
      this.incrementReplayWork(
        "checkpointEvidenceEntryMaterializations",
        adapterSessions.length,
      );
      const evidenceCoverage: CheckpointEvidenceCoverageV2 = deeplyFreeze({
        coverageVersion: 2,
        captureMode: "coverage-only",
        contentRetained: false,
        adapterSessions: deeplyFreeze(adapterSessions),
      });
      const materializedCoverageBytes = Buffer.byteLength(
        canonicalJson(evidenceCoverage),
        "utf8",
      );
      if (
        adapterSessions.length !== (evidenceState?.adapterCount ?? 0)
        || adapterSessions.reduce(
          (total, entry) => total + entry.missingIntervals.length,
          0,
        ) !== (evidenceState?.totalIntervalCount ?? 0)
        || materializedCoverageBytes
          !== (evidenceState?.canonicalCoverageBytes
            ?? EMPTY_QUALIFIED_COVERAGE_CANONICAL_BYTES)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const key = this.historicalSnapshotKey(sessionId, position);
      if (snapshots.has(key)) throw new LifecycleError("INTEGRITY_FAILURE");
      const childSummaries = this.captureCheckpointChildSummaries(
        request,
        capturedChildren,
        liveChildrenByRoot,
        activeTicketsByRoot,
        deferredV2TransferSessions,
        preIndexes,
        childHeads,
      );
      snapshots.set(key, deeplyFreeze({
        aggregate: deeplyFreeze({ ...aggregate }) as SessionAggregateState,
        childSummaries,
        evidenceCoverage,
        evidenceRevisionEventPosition: evidenceState?.revisionEventPosition ?? null,
        evidenceAdapterCount: evidenceState?.adapterCount ?? 0,
      }));
    }
  }

  private captureCheckpointChildSummaries(
    request: HistoricalCheckpointRequest,
    capturedChildren: ReadonlyMap<string, ChildEventFoldProjection>,
    liveChildrenByRoot: ReadonlyMap<string, ReadonlySet<string>>,
    activeTicketsByRoot: ReadonlyMap<string, ReadonlySet<string>>,
    deferredV2TransferSessions: ReadonlySet<string>,
    preIndexes: ReplayPreIndexes,
    childHeads: ReadonlyMap<string, ChildEventFoldProjection>,
  ): Checkpoint["childSummaries"] {
    const liveCount = liveChildrenByRoot.get(request.sessionId)?.size ?? 0;
    const activeTicketCount = activeTicketsByRoot.get(request.sessionId)?.size ?? 0;
    if (request.childSummaries.length !== liveCount + activeTicketCount) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const summaries = request.childSummaries.map((summary) => {
      const lastEventPosition = BigInt(summary.lastEventPosition);
      if (deferredV2TransferSessions.has(summary.childSessionId)) {
        const bindingKey = canonicalJson([
          request.sessionId,
          summary.childSessionId,
          summary.latestCheckpointId,
          summary.lastEventPosition,
        ]);
        const ticket = preIndexes.transferTicketByBinding.get(bindingKey);
        const ticketId = ticket?.transfer_ticket_id;
        const created = ticket === undefined ? null : int64(ticket.created_event_position);
        const claimed = ticket === undefined ? null : int64(ticket.claimed_event_position);
        if (
          ticket === undefined
          || !nonEmpty(ticketId)
          || created === null
          || created > request.baseEventPosition
          || (claimed !== null && claimed <= request.baseEventPosition)
          || activeTicketsByRoot.get(request.sessionId)?.has(ticketId as string) !== true
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        return deeplyFreeze({
          childSessionId: summary.childSessionId,
          state: summary.state,
          lastEventPosition: summary.lastEventPosition,
          streamVersion: summary.streamVersion,
          latestCheckpointId: summary.latestCheckpointId,
        });
      }
      const captured = capturedChildren.get(this.childCaptureKey(
        summary.childSessionId,
        lastEventPosition,
      ));
      const headAtBase = childHeads.get(summary.childSessionId);
      if (
        captured === undefined
        || headAtBase === undefined
        || captured.rootSessionId !== request.sessionId
        || headAtBase.eventPosition !== captured.eventPosition
        || captured.childState !== summary.state
        || captured.streamVersion.toString() !== summary.streamVersion
        || captured.latestCheckpointId !== summary.latestCheckpointId
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      if (summary.state === "transferred") {
        if (summary.latestCheckpointId === null) {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
        const bindingKey = canonicalJson([
          request.sessionId,
          summary.childSessionId,
          summary.latestCheckpointId,
          summary.lastEventPosition,
        ]);
        const ticket = preIndexes.transferTicketByBinding.get(bindingKey);
        const ticketId = ticket?.transfer_ticket_id;
        const created = ticket === undefined ? null : int64(ticket.created_event_position);
        const claimed = ticket === undefined ? null : int64(ticket.claimed_event_position);
        if (
          ticket === undefined
          || !nonEmpty(ticketId)
          || created === null
          || created > request.baseEventPosition
          || (claimed !== null && claimed <= request.baseEventPosition)
          || activeTicketsByRoot.get(request.sessionId)?.has(ticketId as string) !== true
        ) throw new LifecycleError("INTEGRITY_FAILURE");
      } else if (
        liveChildrenByRoot.get(request.sessionId)?.has(summary.childSessionId) !== true
      ) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      return deeplyFreeze({
        childSessionId: captured.childSessionId,
        state: captured.childState,
        lastEventPosition: captured.eventPosition.toString(),
        streamVersion: captured.streamVersion.toString(),
        latestCheckpointId: captured.latestCheckpointId,
      });
    }).sort((left, right) => binaryCompare(left.childSessionId, right.childSessionId));
    return deeplyFreeze(summaries) as unknown as Checkpoint["childSummaries"];
  }

  private assertHistoricalCheckpoint(
    context: ProjectContext,
    stored: StoredEvent,
    event: Extract<LifecycleEventCodecResult, { readonly eventType: "SessionCheckpointRecorded" }>,
    intents: ReadonlyMap<string, IndexedReplayIntent>,
    snapshots: ReadonlyMap<string, HistoricalCheckpointCapture>,
    endpoints: ReplayEndpointIndexes,
  ): Checkpoint {
    const checkpoint = event.payload.checkpoint;
    if (
      checkpoint.sessionId !== event.sessionId
      || checkpoint.parentSessionId !== event.parentSessionId
      || checkpoint.baseEventPosition !== event.payload.baseEventPosition
      || checkpoint.checkpointEventPosition !== event.payload.checkpointEventPosition
      || checkpoint.checkpointEventPosition !== event.globalPosition
      || stored.globalPosition !== BigInt(checkpoint.baseEventPosition) + 1n
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const base = BigInt(checkpoint.baseEventPosition);
    const baseSnapshot = snapshots.get(this.historicalSnapshotKey(event.sessionId, base));
    const snapshot = baseSnapshot;
    const indexedIntent = intents.get(stored.commandId);
    const command = indexedIntent?.witness.intent.command;
    const authorization = indexedIntent?.witness.intent.authorization;
    const manual = record(command) && command.commandType === "record-checkpoint";
    const internalAction = record(command)
      && command.commandType === "internal-workflow-phase"
      && record(command.action)
      && command.action.action === "record-final-checkpoint-and-queue-ending"
      ? command.action
      : null;
    const draftSource = manual && record(command.draft)
      ? command.draft
      : internalAction !== null && record(internalAction.finalCheckpoint)
        ? internalAction.finalCheckpoint
        : null;
    if (
      snapshot === undefined
      || indexedIntent === undefined
      || indexedIntent.commandHash === null
      || !record(command)
      || draftSource === null
      || (
        manual
          ? command.sessionId !== event.sessionId
            || command.expectedStreamVersion !== snapshot.aggregate.streamVersion.toString()
            || (
              command.expectedBaseEventPosition !== null
              && command.expectedBaseEventPosition !== checkpoint.baseEventPosition
            )
          : internalAction === null
            || authorization?.authorizationKind !== "internal-workflow"
            || authorization.authorizationSessionId !== event.sessionId
            || authorization.targetSessionId !== event.sessionId
            || authorization.internalWorkflowId !== command.workflowId
            || authorization.internalWorkflowGeneration !== command.workflowGeneration
            || authorization.internalPlannedWorkId !== command.plannedWorkId
            || command.sourcePhase !== "children-resolved"
            || !nonEmpty(internalAction.materializationTarget)
            || canonicalJson(internalAction.finalCheckpoint)
              !== canonicalJson(checkpoint)
      )
      || stored.streamVersion !== snapshot.aggregate.streamVersion + 1n
      || snapshot.aggregate.parentSessionId !== event.parentSessionId
      || snapshot.aggregate.workspaceId !== context.binding.workspaceId
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const sourceState = checkpoint.sourceState;
    if (
      sourceState.sourceStateScopeVersion !== 1
      || sourceState.workspaceId !== stored.workspaceId
      || sourceState.branchRef !== stored.branchRef
      || sourceState.headCommit !== indexedIntent.workspaceHeadCommit
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const evidenceCoverage = checkpoint.checkpointVersion === 2
      ? snapshot.evidenceCoverage
      : snapshot.evidenceCoverage.adapterSessions.length === 0
        ? deeplyFreeze({
            captureMode: "coverage-only" as const,
            contentRetained: false as const,
            highestContiguousOrdinal: null,
            missingIntervals: deeplyFreeze([]),
          })
        : (() => { throw new LifecycleError("INTEGRITY_FAILURE"); })();
    const expected = deeplyFreeze({
      ...draftSource,
      checkpointId: checkpoint.checkpointId,
      sessionId: event.sessionId,
      parentSessionId: event.parentSessionId,
      baseEventPosition: event.payload.baseEventPosition,
      checkpointEventPosition: event.payload.checkpointEventPosition,
      createdAt: stored.occurredAt,
      creatorAgentId: stored.agentId,
      creatorClientInstanceId: stored.clientInstanceId,
      sourceState: deeplyFreeze({ ...sourceState }),
      childSummaries: snapshot.childSummaries,
      evidenceCoverage,
    }) as Checkpoint;
    if (canonicalJson(expected) !== canonicalJson(checkpoint)) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const endpoint = endpoints.authorities.get(event.sessionId);
    if (
      endpoint !== undefined
      && int64(endpoint.latest_checkpoint_event_position) === stored.globalPosition
      && (
        endpoint.latest_checkpoint_id !== expected.checkpointId
        || endpoint.latest_checkpoint_fingerprint !== canonicalHash(expected)
      )
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    return expected;
  }

  private indexWorkflowIntents(
    context: ProjectContext,
  ): ReadonlyMap<string, IndexedReplayIntent> {
    const rows = this.connection.prepare(`
      SELECT /* lifecycle-full:pre-index */ event.*,
             dedup.command_hash AS dedup_command_hash,
             dedup.workspace_head_commit AS dedup_workspace_head_commit,
             EXISTS (
               SELECT 1 FROM events AS transfer
               WHERE transfer.project_id = event.project_id
                 AND transfer.command_id = event.command_id
                 AND transfer.event_type = 'ChildWorkTransferCreated'
                 AND transfer.event_schema_version = 2
             ) AS has_deferred_v2_transfer
      FROM events AS event INDEXED BY events_project_position
      LEFT JOIN command_dedup AS dedup
        ON dedup.project_id = event.project_id
        AND dedup.command_id = event.command_id
      WHERE event.project_id = $projectId
        AND event.command_event_index = 0
        AND event.lifecycle_intent_json IS NOT NULL
      ORDER BY event.global_position
    `).all({ $projectId: context.binding.projectId });
    const intents = new Map<string, IndexedReplayIntent>();
    for (const row of rows) {
      const event = this.hydrateReplayEvent({ ...row });
      if (
        event.commandEventIndex !== 0
        || typeof event.lifecycleIntentJson !== "string"
        || intents.has(event.commandId)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const hasDeferredV2Transfer = integer(row.has_deferred_v2_transfer);
      if (hasDeferredV2Transfer !== 0 && hasDeferredV2Transfer !== 1) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      if (hasDeferredV2Transfer === 1) continue;
      let witness: ReturnType<typeof decodeLifecycleIntentWitness>;
      try {
        witness = decodeLifecycleIntentWitness(event.lifecycleIntentJson);
        this.assertWorkflowIntentEventContext(context, event, witness);
      } catch {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const storedCommandHash = row.dedup_command_hash;
      const workspaceHeadCommit = row.dedup_workspace_head_commit;
      if (
        storedCommandHash !== null
        && (typeof storedCommandHash !== "string" || !LOWER_HASH.test(storedCommandHash))
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      if (
        workspaceHeadCommit !== null
        && (
          typeof workspaceHeadCommit !== "string"
          || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(workspaceHeadCommit)
        )
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      if (
        storedCommandHash !== null
        && storedCommandHash !== lifecycleIntentHashFromWitnessSource(
          event.lifecycleIntentJson,
        )
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      intents.set(event.commandId, deeplyFreeze({
        witness,
        commandHash: storedCommandHash as string | null,
        workspaceHeadCommit: workspaceHeadCommit as string | null,
      }));
    }
    return intents;
  }

  private indexReplayPreIndexes(context: ProjectContext): ReplayPreIndexes {
    const transferTickets = this.connection.prepare(`
      SELECT /* lifecycle-full:pre-index */ *
      FROM child_transfer_tickets
      WHERE project_id = $projectId
      ORDER BY created_event_position, transfer_ticket_id
    `).all({ $projectId: context.binding.projectId })
      .map((row) => deeplyFreeze({ ...row }));
    const transferTicketById = new Map<string, Readonly<SqliteRow>>();
    const transferTicketByBinding = new Map<string, Readonly<SqliteRow>>();
    const ticketsByCreatePosition = new Map<bigint, Readonly<SqliteRow>[]>();
    const ticketsByClaimPosition = new Map<bigint, Readonly<SqliteRow>[]>();
    const appendAt = (
      target: Map<bigint, Readonly<SqliteRow>[]>,
      position: bigint,
      row: Readonly<SqliteRow>,
    ): void => {
      const rows = target.get(position) ?? [];
      rows.push(row);
      target.set(position, rows);
    };
    for (const ticket of transferTickets) {
      const ticketId = ticket.transfer_ticket_id;
      const created = int64(ticket.created_event_position);
      const claimed = int64(ticket.claimed_event_position);
      const claimTuple = [
        ticket.claimed_by_root_session_id,
        ticket.claimed_child_session_id,
        ticket.claimed_event_position,
        ticket.claimed_at,
      ];
      const claimAbsent = claimTuple.every((value) => value === null);
      const claimPresent = claimTuple.every(present);
      if (
        !nonEmpty(ticketId)
        || transferTicketById.has(ticketId as string)
        || !nonEmpty(ticket.source_parent_session_id)
        || !nonEmpty(ticket.source_child_session_id)
        || !nonEmpty(ticket.checkpoint_id)
        || created === null
        || (!claimAbsent && !claimPresent)
        || (claimPresent && (
          claimed === null
          || !nonEmpty(ticket.claimed_by_root_session_id)
          || !nonEmpty(ticket.claimed_child_session_id)
          || !nonEmpty(ticket.claimed_at)
        ))
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const bindingKey = canonicalJson([
        ticket.source_parent_session_id,
        ticket.source_child_session_id,
        ticket.checkpoint_id,
        created.toString(),
      ]);
      if (transferTicketByBinding.has(bindingKey)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      transferTicketById.set(ticketId as string, ticket);
      transferTicketByBinding.set(bindingKey, ticket);
      appendAt(ticketsByCreatePosition, created, ticket);
      if (claimed !== null) appendAt(ticketsByClaimPosition, claimed, ticket);
    }
    const validations = this.connection.prepare(`
      SELECT /* lifecycle-full:pre-index */ *
      FROM lifecycle_validation_results
      WHERE project_id = $projectId
      ORDER BY recorded_event_position, result_id
    `).all({ $projectId: context.binding.projectId })
      .map((row) => deeplyFreeze({ ...row }));
    const validationById = new Map<string, Readonly<SqliteRow>>();
    const validationsByEventPosition = new Map<bigint, Readonly<SqliteRow>[]>();
    for (const validation of validations) {
      const resultId = validation.result_id;
      const position = int64(validation.recorded_event_position);
      if (
        !nonEmpty(resultId)
        || position === null
        || validationById.has(resultId as string)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      validationById.set(resultId as string, validation);
      const atPosition = validationsByEventPosition.get(position) ?? [];
      atPosition.push(validation);
      validationsByEventPosition.set(position, atPosition);
    }
    return deeplyFreeze({
      transferTickets,
      transferTicketById,
      transferTicketByBinding,
      ticketsByCreatePosition,
      ticketsByClaimPosition,
      validations,
      validationById,
      validationsByEventPosition,
    });
  }

  private indexReplayEndpoints(context: ProjectContext): ReplayEndpointIndexes {
    const workflows = this.connection.prepare(`
      SELECT /* lifecycle-full:endpoint */ *
      FROM workflow_instances
      WHERE project_id = $projectId
        AND session_id IS NOT NULL
      ORDER BY CAST(workflow_id AS BLOB)
    `).all({ $projectId: context.binding.projectId })
      .map((row) => deeplyFreeze({ ...row }));
    const authorityRows = this.connection.prepare(`
      SELECT /* lifecycle-full:endpoint */ authority.*,
             stream.current_version AS endpoint_stream_version
      FROM session_authority AS authority
      JOIN streams AS stream
        ON stream.project_id = authority.project_id
        AND stream.stream_id = authority.stream_id
      WHERE authority.project_id = $projectId
      ORDER BY CAST(authority.session_id AS BLOB)
    `).all({ $projectId: context.binding.projectId });
    const authorities = new Map<string, Readonly<SqliteRow>>();
    for (const row of authorityRows) {
      if (!nonEmpty(row.session_id) || authorities.has(row.session_id as string)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      authorities.set(row.session_id as string, deeplyFreeze({ ...row }));
    }
    const evidence = this.connection.prepare(`
      SELECT /* lifecycle-full:endpoint */ aggregate.*,
             head.batch_event_position AS head_batch_event_position,
             transition.batch_id AS endpoint_batch_id,
             transition.batch_event_position AS endpoint_batch_event_position,
             transition.coverage_fingerprint_value AS endpoint_coverage_fingerprint
      FROM session_evidence_coverage AS aggregate
      LEFT JOIN session_evidence_coverage_transition_heads AS head
        ON head.project_id = aggregate.project_id
        AND head.session_id = aggregate.session_id
        AND head.adapter_session_id = aggregate.adapter_session_id
      LEFT JOIN session_evidence_coverage_transitions AS transition
        ON transition.project_id = head.project_id
        AND transition.session_id = head.session_id
        AND transition.adapter_session_id = head.adapter_session_id
        AND transition.batch_event_position = head.batch_event_position
      WHERE aggregate.project_id = $projectId
      ORDER BY CAST(aggregate.session_id AS BLOB),
               CAST(aggregate.adapter_session_id AS BLOB)
    `).all({ $projectId: context.binding.projectId })
      .map((row) => deeplyFreeze({ ...row }));
    return deeplyFreeze({ workflows, evidence, authorities });
  }

  private evolveWorkflowGenerationState(
    stored: StoredEvent,
    event: LifecycleEventCodecResult,
    indexedIntent: IndexedReplayIntent,
    head: WorkflowGenerationFoldProjection,
    aggregate: SessionAggregateState | undefined,
    previous: WorkflowReplayState | undefined,
  ): WorkflowReplayState {
    const command = indexedIntent.witness.intent.command;
    if (
      !record(command)
      || stored.sessionId === null
      || aggregate === undefined
      || aggregate.sessionId !== stored.sessionId
    ) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (event.eventType === "SessionEndRequested") {
      const request = record(command.request) ? command.request : null;
      const eventRequest = event.eventSchemaVersion === 3
        ? event.payload.effectiveState.request
        : event.payload;
      const materializationRequired = event.eventSchemaVersion === 3
        ? event.payload.effectiveState.effectivePolicy.requireMaterialization
        : eventRequest.requireMaterialization;
      if (
        command.commandType !== "request-session-end"
        || request === null
        || request.sessionId !== stored.sessionId
        || request.requireMaterialization !== eventRequest.requireMaterialization
        || (
          previous !== undefined
          && (
            previous.phase !== "cancelled"
            || event.payload.workflowGeneration !== previous.generation + 1
          )
        )
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      return deeplyFreeze({
        workflowId: head.workflowId,
        sessionId: head.sessionId,
        generation: head.workflowGeneration,
        triggerEventPosition: head.triggerEventPosition,
        rootCommandId: head.rootCommandId,
        expectedAuthorityCommitment: aggregate.authorityCommitment,
        priorRootState: event.payload.previousState,
        materializationRequired,
        evidenceWindowState: head.evidenceWindowState,
        phase: "requested" as const,
        frozenCheckpointId: null,
        frozenCheckpointEventPosition: null,
        frozenGeneration: null,
        endingBindingsJson: null,
        validationResultIds: new Set<string>(),
        qualityScore: null,
        safeFailureCode: null,
        verificationEventPosition: null,
        completionEventPosition: null,
      });
    }
    if (previous === undefined || previous.workflowId !== head.workflowId) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (event.eventType === "SessionEndAmended") {
      const amendment = record(command.amendment) ? command.amendment : null;
      if (
        command.commandType !== "amend-session-end"
        || amendment === null
        || command.workflowId !== previous.workflowId
        || event.payload.previousWorkflowGeneration !== previous.generation
        || event.payload.workflowGeneration !== head.workflowGeneration
        || (
          amendment.requireMaterialization !== null
          && typeof amendment.requireMaterialization !== "boolean"
        )
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const markerPreserving = event.eventSchemaVersion === 3
        && (event.payload.evidenceWindowAction === "unchanged"
          || event.payload.evidenceWindowAction === "seal");
      const materializationRequired = event.eventSchemaVersion === 3
        ? event.payload.effectiveState.effectivePolicy.requireMaterialization
        : amendment.requireMaterialization === null
          ? previous.materializationRequired
          : amendment.requireMaterialization as boolean;
      return deeplyFreeze({
        ...previous,
        generation: head.workflowGeneration,
        triggerEventPosition: head.triggerEventPosition,
        rootCommandId: head.rootCommandId,
        expectedAuthorityCommitment: aggregate.authorityCommitment,
        materializationRequired,
        evidenceWindowState: head.evidenceWindowState,
        phase: markerPreserving ? previous.phase : "requested" as const,
        frozenCheckpointId: markerPreserving ? previous.frozenCheckpointId : null,
        frozenCheckpointEventPosition: markerPreserving
          ? previous.frozenCheckpointEventPosition
          : null,
        frozenGeneration: markerPreserving ? previous.frozenGeneration : null,
        endingBindingsJson: markerPreserving ? previous.endingBindingsJson : null,
        validationResultIds: markerPreserving
          ? previous.validationResultIds
          : new Set<string>(),
        qualityScore: markerPreserving ? previous.qualityScore : null,
        safeFailureCode: markerPreserving ? previous.safeFailureCode : null,
        verificationEventPosition: markerPreserving
          ? previous.verificationEventPosition
          : null,
        completionEventPosition: markerPreserving ? previous.completionEventPosition : null,
      });
    }
    if (event.eventType === "SessionEndCancelled") {
      if (
        command.commandType !== "cancel-session-end"
        || command.workflowId !== previous.workflowId
        || command.preTransitionCheckpointId !== event.payload.preTransitionCheckpointId
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      return deeplyFreeze({
        ...previous,
        generation: head.workflowGeneration,
        triggerEventPosition: head.triggerEventPosition,
        rootCommandId: head.rootCommandId,
        expectedAuthorityCommitment: aggregate.authorityCommitment,
        evidenceWindowState: "sealed" as const,
        phase: "cancelled" as const,
        frozenCheckpointId: null,
        frozenCheckpointEventPosition: null,
        frozenGeneration: null,
        endingBindingsJson: null,
        validationResultIds: new Set<string>(),
        qualityScore: null,
        safeFailureCode: null,
        verificationEventPosition: null,
        completionEventPosition: null,
      });
    }
    if (event.eventType === "SessionAbandoned") {
      if (
        command.commandType !== "abandon-session"
        || command.preTransitionCheckpointId !== event.payload.preTransitionCheckpointId
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      return deeplyFreeze({
        ...previous,
        generation: head.workflowGeneration,
        triggerEventPosition: head.triggerEventPosition,
        rootCommandId: head.rootCommandId,
        expectedAuthorityCommitment: aggregate.authorityCommitment,
        evidenceWindowState: "sealed" as const,
        phase: "abandoned" as const,
      });
    }
    throw new LifecycleError("INTEGRITY_FAILURE");
  }

  private applyFinalCheckpointWorkflowState(
    stored: StoredEvent,
    event: Extract<LifecycleEventCodecResult, { readonly eventType: "SessionCheckpointRecorded" }>,
    indexedIntent: IndexedReplayIntent | undefined,
    checkpoint: Checkpoint,
    checkpoints: ReadonlyMap<string, Checkpoint>,
    checkpointEvidenceRevisions: ReadonlyMap<string, CheckpointEvidenceRevision>,
    preIndexes: ReplayPreIndexes,
    evidenceStates: ReadonlyMap<string, EvidenceReplaySessionState>,
    states: Map<string, WorkflowReplayState>,
  ): void {
    const command = indexedIntent?.witness.intent.command;
    if (!record(command) || command.commandType === "record-checkpoint") return;
    const action = record(command.action) ? command.action : null;
    if (
      event.eventSchemaVersion !== 3
      || event.payload.finalCheckpointBindingVersion !== 1
      || stored.commandEventIndex !== 0
      || command.commandType !== "internal-workflow-phase"
      || action === null
      || action.action !== "record-final-checkpoint-and-queue-ending"
      || command.sourcePhase !== "children-resolved"
      || event.payload.workflowId !== command.workflowId
      || event.payload.workflowGeneration !== command.workflowGeneration
      || canonicalJson(action.finalCheckpoint) !== canonicalJson(event.payload.checkpoint)
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const previous = states.get(command.workflowId as string);
    if (
      previous === undefined
      || previous.sessionId !== stored.sessionId
      || previous.generation !== command.workflowGeneration
      || previous.phase !== "requested"
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const bindings = this.replayEndingBindings(
      checkpoint,
      checkpoints,
      checkpointEvidenceRevisions,
      preIndexes,
      evidenceStates,
    );
    states.set(previous.workflowId, deeplyFreeze({
      ...previous,
      evidenceWindowState: "sealed" as const,
      phase: "final-checkpoint-recorded" as const,
      frozenCheckpointId: checkpoint.checkpointId,
      frozenCheckpointEventPosition: stored.globalPosition,
      frozenGeneration: previous.generation,
      endingBindingsJson: canonicalJson(bindings),
      validationResultIds: new Set<string>(),
      qualityScore: null,
      safeFailureCode: null,
      verificationEventPosition: null,
      completionEventPosition: null,
    }));
  }

  private replayEndingBindings(
    checkpoint: Checkpoint,
    checkpoints: ReadonlyMap<string, Checkpoint>,
    checkpointEvidenceRevisions: ReadonlyMap<string, CheckpointEvidenceRevision>,
    preIndexes: ReplayPreIndexes,
    evidenceStates: ReadonlyMap<string, EvidenceReplayRevisionSummary>,
  ): readonly FinalEndingScopeBindingV1[] {
    const base = BigInt(checkpoint.baseEventPosition);
    const bindings = checkpoint.childSummaries.map((summary) => {
      const checkpointEventPosition = summary.latestCheckpointId === null
        ? null
        : checkpoints.get(summary.latestCheckpointId)?.checkpointEventPosition ?? null;
      const childCheckpoint = summary.latestCheckpointId === null
        ? null
        : checkpoints.get(summary.latestCheckpointId) ?? null;
      const checkpointEvidenceRevision = summary.latestCheckpointId === null
        ? null
        : checkpointEvidenceRevisions.get(summary.latestCheckpointId) ?? null;
      const currentEvidenceState = evidenceStates.get(summary.childSessionId);
      const currentEvidenceRevision = currentEvidenceState?.revisionEventPosition ?? null;
      const currentEvidenceAdapterCount = currentEvidenceState?.adapterCount ?? 0;
      this.incrementReplayWork("endingBindingEvidenceRevisionLookups");
      if (
        childCheckpoint === null
          ? checkpointEvidenceRevision !== null
            || currentEvidenceRevision !== null
            || currentEvidenceAdapterCount !== 0
          : checkpointEvidenceRevision === null
            || checkpointEvidenceRevision.sessionId !== summary.childSessionId
            || checkpointEvidenceRevision.checkpointVersion !== childCheckpoint.checkpointVersion
            || (childCheckpoint.checkpointVersion === 1
              ? checkpointEvidenceRevision.revisionEventPosition !== null
                || checkpointEvidenceRevision.adapterCount !== 0
                || currentEvidenceRevision !== null
                || currentEvidenceAdapterCount !== 0
              : checkpointEvidenceRevision.revisionEventPosition !== currentEvidenceRevision
                || checkpointEvidenceRevision.adapterCount !== currentEvidenceAdapterCount)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      if (summary.state === "transferred") {
        if (summary.latestCheckpointId === null || checkpointEventPosition === null) {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
        const ticket = preIndexes.transferTicketByBinding.get(canonicalJson([
          checkpoint.sessionId,
          summary.childSessionId,
          summary.latestCheckpointId,
          summary.lastEventPosition,
        ]));
        const created = ticket === undefined ? null : int64(ticket.created_event_position);
        const claimed = ticket === undefined ? null : int64(ticket.claimed_event_position);
        if (
          ticket === undefined
          || !nonEmpty(ticket.transfer_ticket_id)
          || created === null
          || created > base
          || (claimed !== null && claimed <= base)
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        return {
          bindingVersion: 1,
          bindingKind: "carry-forward-ticket" as const,
          childSessionId: summary.childSessionId,
          childState: summary.state,
          lastEventPosition: summary.lastEventPosition,
          streamVersion: summary.streamVersion,
          checkpointId: summary.latestCheckpointId,
          checkpointEventPosition,
          transferTicketId: ticket.transfer_ticket_id,
          transferTicketEventPosition: created.toString(),
        };
      }
      return {
        bindingVersion: 1,
        bindingKind: "current-child" as const,
        childSessionId: summary.childSessionId,
        childState: summary.state,
        lastEventPosition: summary.lastEventPosition,
        streamVersion: summary.streamVersion,
        checkpointId: summary.latestCheckpointId,
        checkpointEventPosition,
        transferTicketId: null,
        transferTicketEventPosition: null,
      };
    }).sort((left, right) => binaryCompare(left.childSessionId, right.childSessionId));
    return decodeFinalEndingScopeBindingsV1(bindings);
  }

  private evolveWorkflowSemanticState(
    stored: StoredEvent,
    event: LifecycleEventCodecResult,
    indexedIntent: IndexedReplayIntent | undefined,
    preIndexes: ReplayPreIndexes,
    states: Map<string, WorkflowReplayState>,
    consumedValidations: Set<string>,
  ): void {
    if (event.eventType === "SessionValidationResultRecorded") {
      const command = indexedIntent?.witness.intent.command;
      const result = event.payload.validationResult;
      const rows = preIndexes.validationsByEventPosition.get(stored.globalPosition) ?? [];
      const state = states.get(event.payload.workflowId);
      if (
        !record(command)
        || command.commandType !== "internal-validation-result"
        || command.workflowId !== event.payload.workflowId
        || command.workflowGeneration !== event.payload.workflowGeneration
        || command.plannedWorkId !== event.payload.plannedWorkId
        || canonicalJson(command.result) !== canonicalJson(result)
        || state === undefined
        || state.sessionId !== stored.sessionId
        || state.generation !== event.payload.workflowGeneration
        || state.frozenCheckpointId === null
        || state.phase !== "final-checkpoint-recorded"
        && state.phase !== "validating"
        || rows.length !== 1
        || rows[0]!.result_id !== result.resultId
        || consumedValidations.has(result.resultId)
        || !this.validationRowMatchesEvent(rows[0]!, stored, event)
        || rows[0]!.final_checkpoint_id !== state.frozenCheckpointId
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const validationResultIds = new Set(state.validationResultIds);
      validationResultIds.add(result.resultId);
      consumedValidations.add(result.resultId);
      states.set(state.workflowId, deeplyFreeze({
        ...state,
        phase: "validating" as const,
        validationResultIds,
      }));
      return;
    }
    if (
      event.eventType !== "SessionEndVerificationPassed"
      && event.eventType !== "SessionEndVerificationFailed"
      && event.eventType !== "SessionEndVerificationInvalidated"
      && event.eventType !== "SessionEnded"
    ) return;
    const command = indexedIntent?.witness.intent.command;
    const action = record(command) && record(command.action) ? command.action : null;
    const workflowId = event.payload.workflowId;
    const generation = event.payload.workflowGeneration;
    const state = states.get(workflowId);
    if (
      !record(command)
      || command.commandType !== "internal-workflow-phase"
      || action === null
      || command.workflowId !== workflowId
      || command.workflowGeneration !== generation
      || state === undefined
      || state.sessionId !== stored.sessionId
      || state.generation !== generation
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    if (event.eventType === "SessionEndVerificationPassed") {
      if (
        command.sourcePhase !== "validating"
        || action.action !== "record-verification-passed"
        || canonicalJson(action.validationResultIds)
          !== canonicalJson(event.payload.validationResultIds)
        || action.qualityScore !== event.payload.qualityScore
        || state.phase !== "validating"
        || event.payload.validationResultIds.length !== state.validationResultIds.size
        || event.payload.validationResultIds.some((id) => !state.validationResultIds.has(id))
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      states.set(workflowId, deeplyFreeze({
        ...state,
        phase: "verification-passed" as const,
        qualityScore: event.payload.qualityScore,
        safeFailureCode: null,
        verificationEventPosition: stored.globalPosition,
      }));
      return;
    }
    if (event.eventType === "SessionEndVerificationFailed") {
      if (
        command.sourcePhase !== "validating"
        || action.action !== "record-verification-failed"
        || canonicalJson(action.validationResultIds)
          !== canonicalJson(event.payload.validationResultIds)
        || action.safeFailureCode !== event.payload.safeFailureCode
        || state.phase !== "validating"
        || event.payload.validationResultIds.length !== state.validationResultIds.size
        || event.payload.validationResultIds.some((id) => !state.validationResultIds.has(id))
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      states.set(workflowId, deeplyFreeze({
        ...state,
        phase: "verification-failed" as const,
        qualityScore: null,
        safeFailureCode: event.payload.safeFailureCode,
        verificationEventPosition: null,
      }));
      return;
    }
    if (event.eventType === "SessionEndVerificationInvalidated") {
      if (
        command.sourcePhase !== "verification-passed"
        || action.action !== "invalidate-verification"
        || action.safeFailureCode !== event.payload.safeFailureCode
        || state.phase !== "verification-passed"
        || state.verificationEventPosition?.toString()
          !== event.payload.previousVerificationEventPosition
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      states.set(workflowId, deeplyFreeze({
        ...state,
        phase: "verification-failed" as const,
        qualityScore: null,
        safeFailureCode: event.payload.safeFailureCode,
        verificationEventPosition: null,
      }));
      return;
    }
    if (
      command.sourcePhase !== "verification-passed"
      || action.action !== "append-terminal-completion"
      || action.verificationEventPosition !== event.payload.verificationEventPosition
      || state.phase !== "verification-passed"
      || state.verificationEventPosition?.toString()
        !== event.payload.verificationEventPosition
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    states.set(workflowId, deeplyFreeze({
      ...state,
      phase: "completion-appended" as const,
      completionEventPosition: stored.globalPosition,
    }));
  }

  private validationRowMatchesEvent(
    row: Readonly<SqliteRow>,
    stored: StoredEvent,
    event: Extract<LifecycleEventCodecResult, { readonly eventType: "SessionValidationResultRecorded" }>,
  ): boolean {
    const result = event.payload.validationResult;
    const start = result.sourceStateAtStart;
    const completion = result.sourceStateAtCompletion;
    const output = result.outputFingerprint;
    return row.project_id === stored.projectId
      && row.vault_id === stored.vaultId
      && row.store_id === stored.storeId
      && row.workspace_id === stored.workspaceId
      && row.session_id === stored.sessionId
      && row.result_id === result.resultId
      && sameInteger(row.validation_result_version, result.validationResultVersion)
      && row.workflow_id === event.payload.workflowId
      && sameInteger(row.workflow_generation, event.payload.workflowGeneration)
      && row.profile_id === result.profileId
      && sameInteger(row.profile_version, result.profileVersion)
      && row.profile_configuration_hash === result.profileConfigurationHash
      && row.run_id === result.runId
      && row.runner_id === result.runnerId
      && row.final_checkpoint_id === result.finalCheckpointId
      && row.final_checkpoint_fingerprint === result.finalCheckpointFingerprint
      && sameInteger(row.validation_start_scope_version, start.sourceStateScopeVersion)
      && row.validation_start_project_id === result.projectId
      && row.validation_start_workspace_id === start.workspaceId
      && row.validation_start_branch_ref === start.branchRef
      && row.validation_start_head_commit === start.headCommit
      && row.validation_start_dirty_fingerprint === start.dirtyWorktreeFingerprint
      && sameInteger(
        row.validation_completion_scope_version,
        completion.sourceStateScopeVersion,
      )
      && row.validation_completion_project_id === result.projectId
      && row.validation_completion_workspace_id === completion.workspaceId
      && row.validation_completion_branch_ref === completion.branchRef
      && row.validation_completion_head_commit === completion.headCommit
      && row.validation_completion_dirty_fingerprint
        === completion.dirtyWorktreeFingerprint
      && row.started_at === result.startedAt
      && row.completed_at === result.completedAt
      && row.status === result.status
      && row.exit_classification === result.exitClassification
      && row.redacted_summary === result.summary
      && row.output_fingerprint_algorithm === "hmac-sha256"
      && sameInteger(
        row.output_fingerprint_schema_version,
        output.fingerprintSchemaVersion,
      )
      && row.output_fingerprint_key_id === output.fingerprintKeyId
      && row.output_fingerprint_domain === output.fingerprintDomain
      && row.output_fingerprint_value === output.fingerprint
      && row.artifact_references_json === canonicalJson(result.artifactReferences)
      && integer(row.fresh) === (result.fresh ? 1 : 0)
      && int64(row.recorded_event_position) === stored.globalPosition
      && row.created_at === stored.recordedAt;
  }

  private authorityRowCommitment(row: Readonly<SqliteRow>): string {
    const text = (key: string): string => {
      const value = row[key];
      if (typeof value !== "string") throw new LifecycleError("INTEGRITY_FAILURE");
      return value;
    };
    const nullableText = (key: string): string | null => {
      const value = row[key];
      if (value === null) return null;
      if (typeof value !== "string") throw new LifecycleError("INTEGRITY_FAILURE");
      return value;
    };
    const nullableVersion = (key: string): number | null => {
      const value = row[key];
      if (value === null) return null;
      const decoded = integer(value);
      if (decoded === null || decoded < 1) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      return decoded;
    };
    const nullablePosition = (key: string): string | null => {
      const value = row[key];
      if (value === null) return null;
      const decoded = int64(value);
      if (decoded === null) throw new LifecycleError("INTEGRITY_FAILURE");
      return decoded.toString();
    };
    const kind = row.session_kind;
    const direct = integer(row.direct_access_enabled);
    if ((kind !== "root" && kind !== "child") || (direct !== 0 && direct !== 1)) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const committed: CommittedAuthorityV1 = {
      authorityVersion: 1,
      projectId: text("project_id"),
      sessionId: text("session_id"),
      sessionKind: kind,
      parentSessionId: nullableText("parent_session_id"),
      workspaceId: text("workspace_id"),
      clientNamespace: text("client_namespace"),
      ownerGeneration: nullablePosition("owner_generation"),
      childCapabilityGeneration: nullablePosition("child_capability_generation"),
      directAccessEnabled: direct === 1,
      continuityFingerprintAlgorithm: nullableText("continuity_fingerprint_algorithm"),
      continuityFingerprintSchemaVersion: nullableVersion("continuity_fingerprint_schema_version"),
      continuityFingerprintKeyId: nullableText("continuity_fingerprint_key_id"),
      continuityFingerprintDomain: nullableText("continuity_fingerprint_domain"),
      continuityFingerprint: nullableText("continuity_fingerprint"),
      rootHandleCapabilityVersion: nullableVersion("root_handle_capability_version"),
      rootHandleKeyId: nullableText("root_handle_key_id"),
      rootHandleIssueNonce: nullableText("root_handle_issue_nonce"),
      rootHandleIssuedAt: nullableText("root_handle_issued_at"),
      rootHandlePolicyCode: nullableText("root_handle_policy_code"),
      rootHandleExpiryKind: nullableText("root_handle_expiry_kind") as CommittedAuthorityV1["rootHandleExpiryKind"],
      rootHandleExpiresAt: nullableText("root_handle_expires_at"),
      rootHandleActorRole: nullableText("root_handle_actor_role") as CommittedAuthorityV1["rootHandleActorRole"],
      rootHandleClientInstanceId: nullableText("root_handle_client_instance_id"),
      rootHandleVerifier: nullableText("root_handle_verifier"),
      resumeTokenCapabilityVersion: nullableVersion("resume_token_capability_version"),
      resumeTokenKeyId: nullableText("resume_token_key_id"),
      resumeTokenIssueNonce: nullableText("resume_token_issue_nonce"),
      resumeTokenIssuedAt: nullableText("resume_token_issued_at"),
      resumeTokenPolicyCode: nullableText("resume_token_policy_code"),
      resumeTokenExpiryKind: nullableText("resume_token_expiry_kind") as CommittedAuthorityV1["resumeTokenExpiryKind"],
      resumeTokenExpiresAt: nullableText("resume_token_expires_at"),
      resumeTokenActorRole: nullableText("resume_token_actor_role") as CommittedAuthorityV1["resumeTokenActorRole"],
      resumeTokenVerifier: nullableText("resume_token_verifier"),
      childHandleCapabilityVersion: nullableVersion("child_handle_capability_version"),
      childHandleKeyId: nullableText("child_handle_key_id"),
      childHandleIssueNonce: nullableText("child_handle_issue_nonce"),
      childHandleIssuedAt: nullableText("child_handle_issued_at"),
      childHandlePolicyCode: nullableText("child_handle_policy_code"),
      childHandleExpiryKind: nullableText("child_handle_expiry_kind") as CommittedAuthorityV1["childHandleExpiryKind"],
      childHandleExpiresAt: nullableText("child_handle_expires_at"),
      childHandleActorRole: nullableText("child_handle_actor_role") as CommittedAuthorityV1["childHandleActorRole"],
      childHandleClientInstanceId: nullableText("child_handle_client_instance_id"),
      childHandleVerifier: nullableText("child_handle_verifier"),
      revocationReasonCode: nullableText("revocation_reason_code"),
      revocationEventPosition: nullablePosition("revocation_event_position"),
      revokedAt: nullableText("revoked_at"),
      terminalEventPosition: nullablePosition("terminal_event_position"),
      terminalEventType: nullableText("terminal_event_type"),
      terminalAt: nullableText("terminal_at"),
    };
    return authorityCommitment(committed);
  }

  private workflowEndpointPhaseAllowed(
    state: WorkflowReplayState,
    endpointPhase: unknown,
  ): boolean {
    if (typeof endpointPhase !== "string") return false;
    switch (state.phase) {
      case "requested":
        return endpointPhase === "requested" || endpointPhase === "children-resolved";
      case "final-checkpoint-recorded":
        return endpointPhase === "final-checkpoint-recorded"
          || endpointPhase === "ending-materialization-queued"
          || endpointPhase === "validating";
      case "completion-appended":
        return endpointPhase === "completion-appended"
          || endpointPhase === "completed"
          || (
            state.materializationRequired
            && endpointPhase === "completed-materialization-confirmed"
          );
      default:
        return endpointPhase === state.phase;
    }
  }

  private workflowEndpointStatus(
    row: Readonly<SqliteRow>,
  ): Readonly<Record<string, unknown>> | null {
    if (row.result_json === null) return null;
    let result: unknown;
    try {
      result = parsedCanonicalJson(row.result_json);
    } catch {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (!record(result)) throw new LifecycleError("INTEGRITY_FAILURE");
    const statusFields = [
      "evidenceWindow",
      "finalCheckpointEventPosition",
      "finalCheckpointId",
      "materializationRequired",
      "phase",
      "priorRootState",
      "qualityScore",
      "resultVersion",
      "safeFailureCode",
      "sessionId",
      "triggeringEventPosition",
      "validationPlansReady",
      "workflowGeneration",
      "workflowId",
    ];
    let status: Readonly<Record<string, unknown>> = result;
    if (Object.prototype.hasOwnProperty.call(result, "status")) {
      const outerFields = [
        "action",
        "previousPhase",
        "progressed",
        "resultVersion",
        "status",
      ];
      const phaseActions = new Set([
        "mark-children-resolved",
        "record-final-checkpoint-and-queue-ending",
        "confirm-ending-materialization",
        "begin-validation",
        "record-verification-failed",
        "record-verification-passed",
        "invalidate-verification",
        "append-terminal-completion",
        "confirm-completed-materialization",
        "complete-without-materialization",
        "complete-after-materialization",
      ]);
      const transitions = new Set([
        "requested\u0000children-resolved\u0000mark-children-resolved",
        "children-resolved\u0000final-checkpoint-recorded\u0000record-final-checkpoint-and-queue-ending",
        "final-checkpoint-recorded\u0000ending-materialization-queued\u0000confirm-ending-materialization",
        "ending-materialization-queued\u0000validating\u0000begin-validation",
        "validating\u0000verification-failed\u0000record-verification-failed",
        "validating\u0000verification-passed\u0000record-verification-passed",
        "verification-passed\u0000verification-failed\u0000invalidate-verification",
        "verification-passed\u0000completion-appended\u0000append-terminal-completion",
        "completion-appended\u0000completed-materialization-confirmed\u0000confirm-completed-materialization",
        "completion-appended\u0000completed\u0000complete-without-materialization",
        "completed-materialization-confirmed\u0000completed\u0000complete-after-materialization",
      ]);
      const idempotentDestinations = new Map<string, string>([
        ["mark-children-resolved", "children-resolved"],
        ["record-final-checkpoint-and-queue-ending", "final-checkpoint-recorded"],
        ["confirm-ending-materialization", "ending-materialization-queued"],
        ["begin-validation", "validating"],
        ["record-verification-failed", "verification-failed"],
        ["record-verification-passed", "verification-passed"],
        ["invalidate-verification", "verification-failed"],
        ["append-terminal-completion", "completion-appended"],
        ["confirm-completed-materialization", "completed-materialization-confirmed"],
        ["complete-without-materialization", "completed"],
        ["complete-after-materialization", "completed"],
      ]);
      if (
        canonicalJson(Object.keys(result).sort()) !== canonicalJson(outerFields)
        || result.resultVersion !== 2
        || typeof result.action !== "string"
        || !phaseActions.has(result.action)
        || typeof result.previousPhase !== "string"
        || typeof result.progressed !== "boolean"
        || !record(result.status)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      status = result.status;
      const transition = `${result.previousPhase}\u0000${String(status.phase)}\u0000${result.action}`;
      if (
        result.progressed
          ? !transitions.has(transition)
          : result.previousPhase !== status.phase
            || idempotentDestinations.get(result.action) !== status.phase
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (canonicalJson(Object.keys(status).sort()) !== canonicalJson(statusFields)) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    return status;
  }

  private workflowEndpointMatchesReplay(
    row: Readonly<SqliteRow>,
    state: WorkflowReplayState,
  ): boolean {
    if (
      row.project_id === undefined
      || row.workflow_type !== "session-end"
      || row.workflow_id !== state.workflowId
      || row.session_id !== state.sessionId
      || integer(row.generation) !== state.generation
      || row.root_command_id !== state.rootCommandId
      || int64(row.triggering_event_position) !== state.triggerEventPosition
      || row.expected_authority_commitment !== state.expectedAuthorityCommitment
      || !this.workflowEndpointPhaseAllowed(state, row.phase)
      || row.evidence_window_state !== state.evidenceWindowState
      || int64(row.evidence_frozen_checkpoint_event_position)
        !== state.frozenCheckpointEventPosition
      || integer(row.evidence_frozen_generation) !== state.frozenGeneration
      || row.final_ending_scope_bindings_json !== state.endingBindingsJson
    ) return false;
    const status = this.workflowEndpointStatus(row);
    if (status === null) {
      return state.frozenCheckpointId === null
        && (row.phase === "requested" || row.phase === "cancelled" || row.phase === "abandoned");
    }
    const window = record(status.evidenceWindow) ? status.evidenceWindow : null;
    if (window === null) return false;
    const plansReady = row.validation_attempt_plan_generation !== null
      && row.validation_attempt_plans_json !== null;
    return status.resultVersion === 2
      && status.sessionId === state.sessionId
      && status.workflowId === state.workflowId
      && integer(status.workflowGeneration) === state.generation
      && status.phase === row.phase
      && status.priorRootState === state.priorRootState
      && status.triggeringEventPosition === state.triggerEventPosition.toString()
      && status.finalCheckpointId === state.frozenCheckpointId
      && status.finalCheckpointEventPosition
        === (state.frozenCheckpointEventPosition?.toString() ?? null)
      && window.evidenceWindowState === state.evidenceWindowState
      && window.evidenceFrozenCheckpointEventPosition
        === (state.frozenCheckpointEventPosition?.toString() ?? null)
      && (
        window.evidenceFrozenGeneration === null
          ? state.frozenGeneration === null
          : integer(window.evidenceFrozenGeneration) === state.frozenGeneration
      )
      && status.validationPlansReady === plansReady
      && status.qualityScore === state.qualityScore
      && status.safeFailureCode === state.safeFailureCode
      && status.materializationRequired === state.materializationRequired;
  }

  private assertReplayEndpointCorrespondence(
    context: ProjectContext,
    preIndexes: ReplayPreIndexes,
    endpoints: ReplayEndpointIndexes,
    aggregates: ReadonlyMap<string, SessionAggregateState>,
    authorityPositions: ReadonlyMap<string, bigint>,
    checkpointRequirements: ReadonlyMap<string, CheckpointRequirementFold>,
    revocations: ReadonlyMap<string, RevocationFold>,
    terminalAts: ReadonlyMap<string, string>,
    childHeads: ReadonlyMap<string, ChildEventFoldProjection>,
    deferredV2TransferSessions: ReadonlySet<string>,
    deferredV2TransferStreamVersions: ReadonlyMap<string, bigint>,
    workflowHeads: ReadonlyMap<string, WorkflowGenerationFoldProjection>,
    workflowStates: ReadonlyMap<string, WorkflowReplayState>,
    checkpoints: ReadonlyMap<string, Checkpoint>,
    evidenceStates: ReadonlyMap<string, EvidenceReplaySessionState>,
  ): void {
    if (endpoints.authorities.size !== aggregates.size) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    for (const [sessionId, aggregate] of aggregates) {
      const row = endpoints.authorities.get(sessionId);
      if (row === undefined) throw new LifecycleError("INTEGRITY_FAILURE");
      const authorityPosition = authorityPositions.get(sessionId);
      const deferredV2Transfer = deferredV2TransferSessions.has(sessionId);
      const deferredStreamVersion = deferredV2TransferStreamVersions.get(sessionId);
      if (
        row.project_id !== context.binding.projectId
        || row.workspace_id !== aggregate.workspaceId
        || row.stream_id !== `session/${sessionId}`
        || row.session_kind !== aggregate.kind
        || row.parent_session_id !== aggregate.parentSessionId
        || authorityPosition === undefined
        || int64(row.authority_event_position) !== authorityPosition
        || row.authority_commitment !== this.authorityRowCommitment(row)
        || (deferredV2Transfer && (
          deferredStreamVersion === undefined
          || int64(row.endpoint_stream_version) !== deferredStreamVersion
        ))
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      if (deferredV2Transfer) continue;
      const checkpointRequirement = checkpointRequirements.get(sessionId);
      const revocation = revocations.get(sessionId);
      if (
        int64(row.endpoint_stream_version) !== aggregate.streamVersion
        || row.terminal_event_type !== aggregate.terminalEventType
        || row.checkpoint_required_reason !== (checkpointRequirement?.reason ?? null)
        || decimal(row.checkpoint_required_event_position)
          !== (checkpointRequirement?.eventPosition ?? null)
        || row.revocation_reason_code !== (revocation?.reason ?? null)
        || decimal(row.revocation_event_position)
          !== (revocation?.eventPosition ?? null)
        || row.revoked_at !== (revocation?.revokedAt ?? null)
        || row.terminal_at !== (terminalAts.get(sessionId) ?? null)
        || integer(row.direct_access_enabled) !== (
          aggregate.kind === "child" && aggregate.directAccessEnabled ? 1 : 0
        )
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      try {
        assertAuthorityMirror(aggregate, {
          sessionKind: row.session_kind as "root" | "child",
          parentSessionId: row.parent_session_id as SessionAggregateState["parentSessionId"],
          semanticState: row.semantic_state as SessionAggregateState["state"],
          ownerGeneration: int64(row.owner_generation),
          childCapabilityGeneration: int64(row.child_capability_generation),
          authorityCommitment: String(row.authority_commitment),
          latestCheckpointEventPosition: int64(row.latest_checkpoint_event_position),
          terminalEventPosition: int64(row.terminal_event_position),
        });
      } catch {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      if (aggregate.latestCheckpointId !== null) {
        const checkpoint = checkpoints.get(aggregate.latestCheckpointId);
        if (
          checkpoint === undefined
          || row.latest_checkpoint_id !== aggregate.latestCheckpointId
          || int64(row.latest_checkpoint_event_position)
            !== aggregate.latestCheckpointEventPosition
          || row.latest_checkpoint_fingerprint !== canonicalHash(checkpoint)
        ) throw new LifecycleError("INTEGRITY_FAILURE");
      } else if (
        row.latest_checkpoint_id !== null
        || row.latest_checkpoint_event_position !== null
        || row.latest_checkpoint_fingerprint !== null
      ) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }

    if (
      endpoints.workflows.length !== workflowHeads.size
      || workflowStates.size !== workflowHeads.size
    ) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    for (const row of endpoints.workflows) {
      if (!nonEmpty(row.workflow_id)) throw new LifecycleError("INTEGRITY_FAILURE");
      const head = workflowHeads.get(row.workflow_id as string);
      const state = workflowStates.get(row.workflow_id as string);
      if (
        head === undefined
        || state === undefined
        || integer(row.generation) !== head.workflowGeneration
        || row.session_id !== head.sessionId
        || row.root_command_id !== head.rootCommandId
        || int64(row.triggering_event_position) !== head.triggerEventPosition
        || !this.workflowEndpointMatchesReplay(row, state)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    }

    let replayEvidenceCount = 0;
    for (const sessionStates of evidenceStates.values()) {
      replayEvidenceCount += sessionStates.adapterCount;
    }
    if (endpoints.evidence.length !== replayEvidenceCount) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    for (const row of endpoints.evidence) {
      if (!nonEmpty(row.session_id) || !nonEmpty(row.adapter_session_id)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const state = evidenceStates.get(row.session_id as string)
        ?.adapters.get(row.adapter_session_id as string);
      const entry = state?.checkpointEntry;
      if (
        state === undefined
        || entry === undefined
        || row.project_id !== context.binding.projectId
        || row.session_id !== state.sessionId
        || row.capture_mode !== "coverage-only"
        || int64(row.first_ordinal, true) !== 0n
        || int64(row.last_ordinal, true) !== state.coverageLastOrdinal
        || decimal(row.highest_contiguous_ordinal)
          !== (entry.highestContiguousOrdinal ?? "-1")
        || row.missing_intervals_json !== state.missingIntervalsJson
        || row.fingerprint_algorithm !== entry.frameFingerprintAlgorithm
        || integer(row.fingerprint_schema_version)
          !== entry.frameFingerprintSchemaVersion
        || row.fingerprint_key_id !== entry.frameFingerprintKeyId
        || row.fingerprint_domain !== entry.frameFingerprintDomain
        || row.coverage_fingerprint_algorithm
          !== entry.coverageFingerprintAlgorithm
        || integer(row.coverage_fingerprint_schema_version)
          !== entry.coverageFingerprintSchemaVersion
        || row.coverage_fingerprint_key_id !== entry.coverageFingerprintKeyId
        || row.coverage_fingerprint_domain !== entry.coverageFingerprintDomain
        || row.coverage_fingerprint_value !== entry.coverageFingerprint
        || row.latest_batch_id !== entry.latestBatchId
        || decimal(row.latest_batch_event_position)
          !== entry.latestBatchEventPosition
        || row.created_at !== state.createdAt
        || row.updated_at !== state.updatedAt
        || decimal(row.head_batch_event_position)
          !== entry.latestBatchEventPosition
        || row.endpoint_batch_id !== entry.latestBatchId
        || decimal(row.endpoint_batch_event_position)
          !== entry.latestBatchEventPosition
        || row.endpoint_coverage_fingerprint !== entry.coverageFingerprint
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    }

    for (const row of preIndexes.validations) {
      if (!nonEmpty(row.final_checkpoint_id) || !nonEmpty(row.final_checkpoint_fingerprint)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const checkpoint = checkpoints.get(row.final_checkpoint_id as string);
      if (
        checkpoint === undefined
        || row.final_checkpoint_fingerprint !== canonicalHash(checkpoint)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    }

    for (const ticket of preIndexes.transferTickets) {
      if (
        ticket.project_id !== context.binding.projectId
        || !nonEmpty(ticket.transfer_ticket_id)
        || !nonEmpty(ticket.source_parent_session_id)
        || !nonEmpty(ticket.source_child_session_id)
        || !nonEmpty(ticket.checkpoint_id)
        || int64(ticket.created_event_position) === null
        || !canonicalJsonText(ticket.source_assignment_json)
        || !canonicalJsonText(ticket.source_scope_json)
        || !canonicalJsonText(ticket.follow_ups_json)
        || !canonicalJsonText(ticket.source_state_json)
        || !canonicalJsonText(ticket.lineage_json)
        || !childHeads.has(ticket.source_child_session_id as string)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  private assertNoChildProjectionAtOrBefore(
    cursor: ChildEventFoldCursor,
    eventPosition: bigint,
  ): void {
    const lookahead = cursor.peek();
    if (lookahead !== null && lookahead.eventPosition <= eventPosition) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  private assertNoWorkflowProjectionAtOrBefore(
    cursor: WorkflowGenerationFoldCursor,
    eventPosition: bigint,
  ): void {
    const lookahead = cursor.peek();
    if (lookahead !== null && lookahead.triggerEventPosition <= eventPosition) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  private evolveReplayCheckpointRequirement(
    stored: StoredEvent,
    event: LifecycleEventCodecResult,
    requirements: Map<string, CheckpointRequirementFold>,
  ): void {
    if (stored.sessionId === null) throw new LifecycleError("INTEGRITY_FAILURE");
    if (event.eventType === "SessionCheckpointRecorded") {
      const current = requirements.get(stored.sessionId);
      if (
        current !== undefined
        && BigInt(event.payload.baseEventPosition) >= BigInt(current.eventPosition)
      ) requirements.delete(stored.sessionId);
      return;
    }
    let targetSessionId = stored.sessionId;
    let reason: string | null = null;
    switch (event.eventType) {
      case "SessionOwnerTransferred":
        reason = "ownership-transfer";
        break;
      case "SessionOwnershipRecovered":
        reason = "ownership-recovery";
        break;
      case "SessionSuspendRequested":
      case "SessionSuspended":
        reason = "suspension";
        break;
      case "ChildWorkTransferClaimed":
        reason = "carry-forward-claim";
        break;
      case "SessionEndAmended":
        reason = "end-amendment";
        break;
      case "SessionEndCancelled":
        reason = "end-cancellation";
        break;
      case "ChildWorkDispositioned":
        if (
          event.payload.disposition.kind === "accepted"
          || event.payload.disposition.kind === "partially-accepted"
        ) {
          if (stored.parentSessionId === null) {
            throw new LifecycleError("INTEGRITY_FAILURE");
          }
          targetSessionId = stored.parentSessionId;
          reason = "accepted-child-report";
        }
        break;
      default:
        break;
    }
    if (reason !== null) {
      requirements.set(targetSessionId, deeplyFreeze({
        reason,
        eventPosition: stored.globalPosition.toString(),
      }));
    }
  }

  private evolveReplayRevocation(
    stored: StoredEvent,
    event: LifecycleEventCodecResult,
    revocations: Map<string, RevocationFold>,
  ): void {
    if (stored.sessionId === null) throw new LifecycleError("INTEGRITY_FAILURE");
    let reason: string | null = null;
    if (event.eventType === "SessionAbandoned") {
      reason = event.payload.reasonCode;
    } else if (event.eventType === "ChildSessionCompleted") {
      reason = "child-completed";
    } else if (event.eventType === "ChildSessionSuspended") {
      reason = "child-suspended";
    } else if (event.eventType === "ChildWorkTransferCreated") {
      reason = "child-transferred";
    }
    if (reason !== null) {
      revocations.set(stored.sessionId, deeplyFreeze({
        reason,
        eventPosition: stored.globalPosition.toString(),
        revokedAt: stored.occurredAt,
      }));
    }
  }

  private foldReplayAuthority(
    event: StoredEvent,
    aggregates: Map<string, SessionAggregateState>,
  ): LifecycleEventCodecResult {
    if (event.sessionId === null || !record(event.payload)) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const previous = aggregates.get(event.sessionId);
    const carriesCommitment = Object.prototype.hasOwnProperty.call(
      event.payload,
      "authorityCommitment",
    );
    const commitment = carriesCommitment
      ? event.payload.authorityCommitment
      : previous?.authorityCommitment;
    if (typeof commitment !== "string" || !LOWER_HASH.test(commitment)) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const decoded = this.decodeStoredLifecycleEvent(event, commitment);
    if (
      decoded.eventType === "ChildWorkTransferCreated"
      && decoded.eventSchemaVersion === 2
    ) return decoded;
    let aggregate: SessionAggregateState;
    try {
      aggregate = previous === undefined
        ? foldSession([decoded])
        : evolveSession(previous, decoded);
    } catch {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (
      aggregate.authorityCommitment !== commitment
      || aggregate.eventPosition !== event.globalPosition
      || aggregate.streamVersion !== event.streamVersion
      || aggregate.sessionId !== event.sessionId
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    aggregates.set(event.sessionId, aggregate);
    return decoded;
  }

  private replayReportId(event: LifecycleEventCodecResult): string | null {
    switch (event.eventType) {
      case "ChildWorkDispositioned":
        return event.payload.disposition.reportId;
      case "ChildCompletionProposed":
      case "ChildSessionCompleted":
        return event.payload.reportId;
      default:
        return null;
    }
  }

  private hydrateReplayEvent(row: SqliteRow): StoredEvent {
    const position = int64(row.global_position);
    const streamVersion = int64(row.stream_version);
    const eventSchemaVersion = integer(row.event_schema_version);
    const commandEventIndex = integer(row.command_event_index);
    const payload = parsedCanonicalJson(row.payload_json);
    const sourceRefs = parsedCanonicalJson(row.source_refs_json);
    const evidenceRefs = parsedCanonicalJson(row.evidence_refs_json);
    const evidenceDigests = parsedCanonicalJson(row.evidence_digests_json);
    const nullableString = (key: string): string | null => {
      const value = row[key];
      if (value === null) return null;
      if (typeof value !== "string") throw new LifecycleError("INTEGRITY_FAILURE");
      return value;
    };
    if (
      position === null
      || streamVersion === null
      || eventSchemaVersion === null
      || commandEventIndex === null
      || commandEventIndex < 0
      || !record(payload)
      || !nonEmpty(row.event_id)
      || !nonEmpty(row.project_id)
      || !nonEmpty(row.vault_id)
      || !nonEmpty(row.store_id)
      || !nonEmpty(row.workspace_id)
      || !nonEmpty(row.stream_id)
      || !nonEmpty(row.stream_type)
      || !nonEmpty(row.event_type)
      || !ACTOR_ROLES.has(String(row.actor_role))
      || !nonEmpty(row.agent_id)
      || !nonEmpty(row.client_instance_id)
      || !nonEmpty(row.correlation_id)
      || !nonEmpty(row.command_id)
      || !nonEmpty(row.idempotency_key)
      || !nonEmpty(row.occurred_at)
      || !nonEmpty(row.recorded_at)
      || (row.visibility_scope !== "project"
        && row.visibility_scope !== "session"
        && row.visibility_scope !== "private")
      || (row.confidence !== "low"
        && row.confidence !== "medium"
        && row.confidence !== "high")
      || (row.verification_status !== "unverified"
        && row.verification_status !== "partially-verified"
        && row.verification_status !== "verified")
      || !Array.isArray(sourceRefs)
      || sourceRefs.some((value) => typeof value !== "string")
      || !Array.isArray(evidenceRefs)
      || !Array.isArray(evidenceDigests)
      || typeof row.payload_json !== "string"
      || typeof row.payload_hash !== "string"
      || !LOWER_HASH.test(row.payload_hash)
      || payloadHash(payload) !== row.payload_hash
      || typeof row.previous_global_hash !== "string"
      || !LOWER_HASH.test(row.previous_global_hash)
      || typeof row.event_hash !== "string"
      || !LOWER_HASH.test(row.event_hash)
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const event = {
      globalPosition: position,
      eventId: row.event_id,
      projectId: row.project_id,
      vaultId: row.vault_id,
      storeId: row.store_id,
      workspaceId: row.workspace_id,
      branchScopeId: nullableString("branch_scope_id"),
      branchRef: nullableString("branch_ref"),
      streamId: row.stream_id,
      streamType: row.stream_type,
      streamVersion,
      eventType: row.event_type,
      eventSchemaVersion,
      sessionId: nullableString("session_id"),
      parentSessionId: nullableString("parent_session_id"),
      actorRole: row.actor_role,
      agentId: row.agent_id,
      clientInstanceId: row.client_instance_id,
      correlationId: row.correlation_id,
      causationId: nullableString("causation_id"),
      commandId: row.command_id,
      idempotencyKey: row.idempotency_key,
      commandEventIndex,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      visibilityScope: row.visibility_scope,
      confidence: row.confidence,
      verificationStatus: row.verification_status,
      sourceRefs: deeplyFreeze(sourceRefs),
      evidenceRefs: deeplyFreeze(evidenceRefs),
      evidenceDigests: deeplyFreeze(evidenceDigests),
      payload: deeplyFreeze(payload),
      payloadJson: row.payload_json,
      payloadHash: row.payload_hash,
      previousGlobalHash: row.previous_global_hash,
      eventHash: row.event_hash,
      lifecycleIntentJson: nullableString("lifecycle_intent_json"),
    } as unknown as StoredEvent;
    return deeplyFreeze(event);
  }

  private checkLatestEvidenceEventProjection(context: ProjectContext): void {
    const rows = this.connection.prepare(`
      SELECT transition.*,
        event.global_position AS event_global_position,
        event.project_id AS event_project_id,
        event.stream_id AS event_stream_id,
        event.stream_type AS event_stream_type,
        event.session_id AS event_session_id,
        event.parent_session_id AS event_parent_session_id,
        event.event_type AS event_type,
        event.event_schema_version AS event_schema_version,
        authority.parent_session_id AS authority_parent_session_id,
        event.payload_json AS payload_json,
        json_valid(event.payload_json) AS payload_valid,
        json(event.payload_json) = event.payload_json AS payload_canonical,
        (SELECT count(*) FROM json_each(event.payload_json)) AS payload_key_count,
        (SELECT group_concat(key, char(31)) FROM json_each(event.payload_json))
          AS payload_key_sequence,
        json_type(event.payload_json, '$.adapterSessionId') AS payload_adapter_session_id_type,
        json_type(event.payload_json, '$.batchId') AS payload_batch_id_type,
        json_type(event.payload_json, '$.batchFirstOrdinal') AS payload_batch_first_ordinal_type,
        json_type(event.payload_json, '$.batchLastOrdinal') AS payload_batch_last_ordinal_type,
        json_type(event.payload_json, '$.coverageFirstOrdinal') AS payload_coverage_first_ordinal_type,
        json_type(event.payload_json, '$.coverageLastOrdinal') AS payload_coverage_last_ordinal_type,
        json_type(event.payload_json, '$.highestContiguousOrdinal') AS payload_highest_contiguous_ordinal_type,
        json_type(event.payload_json, '$.missingIntervals') AS payload_missing_intervals_type,
        json_type(event.payload_json, '$.frameFingerprintAlgorithm') AS payload_frame_algorithm_type,
        json_type(event.payload_json, '$.frameFingerprintSchemaVersion') AS payload_frame_version_type,
        json_type(event.payload_json, '$.frameFingerprintKeyId') AS payload_frame_key_type,
        json_type(event.payload_json, '$.frameFingerprintDomain') AS payload_frame_domain_type,
        json_type(event.payload_json, '$.coverageFingerprintAlgorithm') AS payload_coverage_algorithm_type,
        json_type(event.payload_json, '$.coverageFingerprintSchemaVersion') AS payload_coverage_version_type,
        json_type(event.payload_json, '$.coverageFingerprintKeyId') AS payload_coverage_key_type,
        json_type(event.payload_json, '$.coverageFingerprintDomain') AS payload_coverage_domain_type,
        json_type(event.payload_json, '$.coverageFingerprint') AS payload_coverage_fingerprint_type,
        json_type(event.payload_json, '$.captureMode') AS payload_capture_mode_type,
        json_type(event.payload_json, '$.contentRetained') AS payload_content_retained_type,
        json_type(event.payload_json, '$.frames') AS payload_frames_type,
        json_extract(event.payload_json, '$.adapterSessionId') AS payload_adapter_session_id,
        json_extract(event.payload_json, '$.batchId') AS payload_batch_id,
        json_extract(event.payload_json, '$.batchFirstOrdinal') AS payload_batch_first_ordinal,
        json_extract(event.payload_json, '$.batchLastOrdinal') AS payload_batch_last_ordinal,
        json_extract(event.payload_json, '$.coverageFirstOrdinal') AS payload_coverage_first_ordinal,
        json_extract(event.payload_json, '$.coverageLastOrdinal') AS payload_coverage_last_ordinal,
        json_extract(event.payload_json, '$.highestContiguousOrdinal') AS payload_highest_contiguous_ordinal,
        json_extract(event.payload_json, '$.missingIntervals') AS payload_missing_intervals,
        json_extract(event.payload_json, '$.frameFingerprintAlgorithm') AS payload_frame_algorithm,
        json_extract(event.payload_json, '$.frameFingerprintSchemaVersion') AS payload_frame_version,
        json_extract(event.payload_json, '$.frameFingerprintKeyId') AS payload_frame_key,
        json_extract(event.payload_json, '$.frameFingerprintDomain') AS payload_frame_domain,
        json_extract(event.payload_json, '$.coverageFingerprintAlgorithm') AS payload_coverage_algorithm,
        json_extract(event.payload_json, '$.coverageFingerprintSchemaVersion') AS payload_coverage_version,
        json_extract(event.payload_json, '$.coverageFingerprintKeyId') AS payload_coverage_key,
        json_extract(event.payload_json, '$.coverageFingerprintDomain') AS payload_coverage_domain,
        json_extract(event.payload_json, '$.coverageFingerprint') AS payload_coverage_fingerprint,
        json_extract(event.payload_json, '$.captureMode') AS payload_capture_mode,
        json_extract(event.payload_json, '$.contentRetained') AS payload_content_retained,
        json_array_length(event.payload_json, '$.frames') AS payload_frame_count,
        event.payload_json -> '$.frames' AS payload_frames_json
      FROM session_evidence_coverage_transition_heads AS head
      JOIN session_evidence_coverage_transitions AS transition
        ON transition.project_id = head.project_id
        AND transition.session_id = head.session_id
        AND transition.adapter_session_id = head.adapter_session_id
        AND transition.batch_event_position = head.batch_event_position
      LEFT JOIN events AS event
        ON event.global_position = transition.batch_event_position
      LEFT JOIN session_authority AS authority
        ON authority.project_id = transition.project_id
        AND authority.session_id = transition.session_id
      WHERE head.project_id = $projectId
      ORDER BY CAST(head.session_id AS BLOB), CAST(head.adapter_session_id AS BLOB)
    `).all({ $projectId: context.binding.projectId });
    const intervalRows = this.connection.prepare(`
      SELECT interval.key AS interval_index,
             json_type(interval.value, '$[0]') AS first_type,
             json_extract(interval.value, '$[0]') AS first_ordinal,
             json_type(interval.value, '$[1]') AS last_type,
             json_extract(interval.value, '$[1]') AS last_ordinal,
             json_array_length(interval.value) AS interval_length
      FROM json_each($intervals) AS interval
      ORDER BY CAST(interval.key AS INTEGER)
      LIMIT 201
    `);
    for (const row of rows) {
      const last = decimal(row.coverage_last_ordinal);
      const highest = decimal(row.highest_contiguous_ordinal);
      if (last === null || highest === null) throw new LifecycleError("INTEGRITY_FAILURE");
      const storedIntervals = intervalRows.all({
        $intervals: String(row.missing_intervals_json),
      });
      if (storedIntervals.length > 200) throw new LifecycleError("INTEGRITY_FAILURE");
      let priorLast = -1n;
      const publicIntervals = storedIntervals.map((interval, index) => {
        const first = int64(interval.first_ordinal, true);
        const intervalLast = int64(interval.last_ordinal, true);
        if (
          decimal(interval.interval_index) !== String(index)
          || interval.first_type !== "integer"
          || interval.last_type !== "integer"
          || integer(interval.interval_length) !== 2
          || first === null
          || intervalLast === null
          || first > intervalLast
          || first <= priorLast
          || intervalLast > BigInt(last)
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        priorLast = intervalLast;
        return {
          firstOrdinal: first.toString(),
          lastOrdinal: intervalLast.toString(),
        };
      });
      const expectedHighest = highest === "-1" ? null : highest;
      const expectedHighestType = expectedHighest === null ? "null" : "text";
      const topLevelValues: Readonly<Record<string, unknown>> = {
        adapterSessionId: row.payload_adapter_session_id,
        batchFirstOrdinal: row.payload_batch_first_ordinal,
        batchId: row.payload_batch_id,
        batchLastOrdinal: row.payload_batch_last_ordinal,
        captureMode: row.payload_capture_mode,
        contentRetained: false,
        coverageFingerprint: row.payload_coverage_fingerprint,
        coverageFingerprintAlgorithm: row.payload_coverage_algorithm,
        coverageFingerprintDomain: row.payload_coverage_domain,
        coverageFingerprintKeyId: row.payload_coverage_key,
        coverageFingerprintSchemaVersion: integer(row.payload_coverage_version),
        coverageFirstOrdinal: row.payload_coverage_first_ordinal,
        coverageLastOrdinal: row.payload_coverage_last_ordinal,
        frameFingerprintAlgorithm: row.payload_frame_algorithm,
        frameFingerprintDomain: row.payload_frame_domain,
        frameFingerprintKeyId: row.payload_frame_key,
        frameFingerprintSchemaVersion: integer(row.payload_frame_version),
        highestContiguousOrdinal: expectedHighest,
        missingIntervals: publicIntervals,
      };
      const framesJson = row.payload_frames_json;
      if (typeof framesJson !== "string") throw new LifecycleError("INTEGRITY_FAILURE");
      const reconstructedPayload = `{${LATEST_EVIDENCE_PAYLOAD_KEYS.map((key) => (
        `${canonicalJson(key)}:${
          key === "frames"
            ? framesJson
            : canonicalJson(topLevelValues[key] as never)
        }`
      )).join(",")}}`;
      if (
        !LOWER_UUID.test(String(row.adapter_session_id))
        || !LOWER_UUID.test(String(row.batch_id))
        || decimal(row.event_global_position) !== decimal(row.batch_event_position)
        || row.event_project_id !== row.project_id
        || row.event_stream_id !== `session/${String(row.session_id)}`
        || row.event_stream_type !== "session"
        || row.event_session_id !== row.session_id
        || row.event_parent_session_id !== row.authority_parent_session_id
        || row.event_type !== "EvidenceCoverageRecorded"
        || integer(row.event_schema_version) !== 2
        || integer(row.payload_valid) !== 1
        || integer(row.payload_canonical) !== 1
        || reconstructedPayload !== row.payload_json
        || integer(row.payload_key_count) !== 20
        || row.payload_key_sequence !== LATEST_EVIDENCE_PAYLOAD_KEY_SEQUENCE
        || row.payload_adapter_session_id_type !== "text"
        || row.payload_batch_id_type !== "text"
        || row.payload_batch_first_ordinal_type !== "text"
        || row.payload_batch_last_ordinal_type !== "text"
        || row.payload_coverage_first_ordinal_type !== "text"
        || row.payload_coverage_last_ordinal_type !== "text"
        || row.payload_highest_contiguous_ordinal_type !== expectedHighestType
        || row.payload_missing_intervals_type !== "array"
        || row.payload_frame_algorithm_type !== "text"
        || row.payload_frame_version_type !== "integer"
        || row.payload_frame_key_type !== "text"
        || row.payload_frame_domain_type !== "text"
        || row.payload_coverage_algorithm_type !== "text"
        || row.payload_coverage_version_type !== "integer"
        || row.payload_coverage_key_type !== "text"
        || row.payload_coverage_domain_type !== "text"
        || row.payload_coverage_fingerprint_type !== "text"
        || row.payload_capture_mode_type !== "text"
        || row.payload_content_retained_type !== "false"
        || row.payload_frames_type !== "array"
        || row.payload_adapter_session_id !== row.adapter_session_id
        || row.payload_batch_id !== row.batch_id
        || row.payload_batch_first_ordinal !== decimal(row.batch_first_ordinal)
        || row.payload_batch_last_ordinal !== decimal(row.batch_last_ordinal)
        || row.payload_coverage_first_ordinal !== decimal(row.coverage_first_ordinal)
        || row.payload_coverage_last_ordinal !== last
        || row.payload_highest_contiguous_ordinal !== expectedHighest
        || row.payload_missing_intervals !== canonicalJson(publicIntervals)
        || row.payload_frame_algorithm !== row.frame_fingerprint_algorithm
        || !sameInteger(row.payload_frame_version, row.frame_fingerprint_schema_version)
        || row.payload_frame_key !== row.frame_fingerprint_key_id
        || row.payload_frame_domain !== row.frame_fingerprint_domain
        || row.payload_coverage_algorithm !== row.coverage_fingerprint_algorithm
        || !sameInteger(row.payload_coverage_version, row.coverage_fingerprint_schema_version)
        || row.payload_coverage_key !== row.coverage_fingerprint_key_id
        || row.payload_coverage_domain !== row.coverage_fingerprint_domain
        || row.payload_coverage_fingerprint !== row.coverage_fingerprint_value
        || row.payload_capture_mode !== row.capture_mode
        || integer(row.payload_content_retained) !== 0
        || integer(row.payload_frame_count) === null
        || integer(row.new_frame_count) === null
        || integer(row.new_frame_count)! > integer(row.payload_frame_count)!
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  private checkCurrentCheckpointIndexes(
    context: ProjectContext,
  ): void {
    const rows = this.connection.prepare(`
      SELECT session_id, latest_checkpoint_id,
             latest_checkpoint_event_position, latest_checkpoint_fingerprint
      FROM session_authority
      WHERE project_id = $projectId
        AND latest_checkpoint_id IS NOT NULL
      ORDER BY CAST(session_id AS BLOB)
    `).all({ $projectId: context.binding.projectId });
    const authority = new SessionAuthorityRepository();
    for (const row of rows) {
      if (
        typeof row.session_id !== "string"
        || typeof row.latest_checkpoint_id !== "string"
        || typeof row.latest_checkpoint_fingerprint !== "string"
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const position = int64(row.latest_checkpoint_event_position);
      if (position === null) throw new LifecycleError("INTEGRITY_FAILURE");
      const checkpoint = authority.requireCheckpointAtEventPosition(this.connection, {
        projectId: context.binding.projectId,
        sessionId: row.session_id as never,
        checkpointId: row.latest_checkpoint_id as never,
        checkpointEventPosition: position,
      });
      if (canonicalHash(checkpoint) !== row.latest_checkpoint_fingerprint) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }
  }

  private checkFrozenWorkflowIntegrity(
    context: ProjectContext,
  ): void {
    const rows = this.connection.prepare(`
      SELECT workflow_id, session_id, generation, phase, result_json,
             expected_authority_commitment,
             evidence_frozen_checkpoint_event_position,
             evidence_frozen_generation, evidence_window_state,
             final_ending_scope_bindings_json
      FROM workflow_instances
      WHERE project_id = $projectId
        AND session_id IS NOT NULL
        AND evidence_frozen_checkpoint_event_position IS NOT NULL
      ORDER BY CAST(session_id AS BLOB), generation
    `).all({ $projectId: context.binding.projectId });
    const authority = new SessionAuthorityRepository();
    for (const row of rows) {
      if (
        typeof row.session_id !== "string"
        || typeof row.workflow_id !== "string"
        || !LOWER_UUID.test(row.workflow_id)
        || typeof row.expected_authority_commitment !== "string"
        || !LOWER_HASH.test(row.expected_authority_commitment)
        || typeof row.result_json !== "string"
        || typeof row.final_ending_scope_bindings_json !== "string"
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const frozenPosition = int64(row.evidence_frozen_checkpoint_event_position);
      const generation = integer(row.generation);
      const frozenGeneration = integer(row.evidence_frozen_generation);
      if (
        frozenPosition === null
        || generation === null
        || frozenGeneration === null
        || frozenGeneration < 1
        || frozenGeneration > generation
        || row.evidence_window_state !== "sealed"
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const result = parsedCanonicalJson(row.result_json);
      if (!record(result)) throw new LifecycleError("INTEGRITY_FAILURE");
      const status = record(result.status) ? result.status : result;
      if (
        status.phase !== row.phase
        || status.sessionId !== row.session_id
        || status.workflowId !== row.workflow_id
        || integer(status.workflowGeneration) !== generation
        || status.finalCheckpointEventPosition !== frozenPosition.toString()
        || typeof status.finalCheckpointId !== "string"
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const parsedBindings = parsedCanonicalJson(row.final_ending_scope_bindings_json);
      const bindings = decodeFinalEndingScopeBindingsV1(parsedBindings);
      if (canonicalJson(bindings) !== row.final_ending_scope_bindings_json) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const rootCheckpoint = authority.requireCheckpointAtEventPosition(this.connection, {
        projectId: context.binding.projectId,
        sessionId: row.session_id as never,
        checkpointId: status.finalCheckpointId as never,
        checkpointEventPosition: frozenPosition,
      });
      const marker = this.storedEventAt(frozenPosition);
      const decodedMarker = this.decodeStoredLifecycleEvent(
        marker,
        row.expected_authority_commitment,
      );
      if (decodedMarker.eventSchemaVersion !== 3) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const witness = this.commandIntentEventZero(context, marker);
      const command = witness.intent.command;
      if (
        !this.eventMatchesContext(context, marker)
        || marker.streamId !== `session/${row.session_id}`
        || marker.streamType !== "session"
        || marker.sessionId !== row.session_id
        || marker.parentSessionId !== null
        || marker.commandEventIndex !== 0
        || decodedMarker.eventType !== "SessionCheckpointRecorded"
        || decodedMarker.payload.finalCheckpointBindingVersion !== 1
        || decodedMarker.payload.workflowId !== row.workflow_id
        || decodedMarker.payload.workflowGeneration !== frozenGeneration
        || canonicalJson(decodedMarker.payload.checkpoint) !== canonicalJson(rootCheckpoint)
        || !record(command)
        || command.commandType !== "internal-workflow-phase"
        || command.workflowId !== row.workflow_id
        || command.workflowGeneration !== frozenGeneration
        || command.sourcePhase !== "children-resolved"
        || !record(command.action)
        || command.action.action !== "record-final-checkpoint-and-queue-ending"
        || canonicalJson(command.action.finalCheckpoint)
          !== canonicalJson(decodedMarker.payload.checkpoint)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      if (rootCheckpoint.parentSessionId !== null) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const expectedSummaries = bindings.map((binding) => ({
        childSessionId: binding.childSessionId,
        state: binding.childState,
        lastEventPosition: binding.lastEventPosition,
        streamVersion: binding.streamVersion,
        latestCheckpointId: binding.checkpointId,
      }));
      if (canonicalJson(expectedSummaries) !== canonicalJson(rootCheckpoint.childSummaries)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      if (rootCheckpoint.checkpointVersion === 2) {
        this.assertCheckpointEvidenceAtRecordedTransitions(context, rootCheckpoint);
      } else {
        if (
          rootCheckpoint.evidenceCoverage.highestContiguousOrdinal !== null
          || rootCheckpoint.evidenceCoverage.missingIntervals.length !== 0
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        this.assertEventTimeCleanScope(
          context,
          rootCheckpoint.sessionId,
          BigInt(rootCheckpoint.baseEventPosition),
        );
      }
      for (const binding of bindings) {
        this.checkFrozenBinding(
          context,
          row.session_id,
          binding,
          authority,
        );
      }
    }
  }

  private checkFrozenBinding(
    context: ProjectContext,
    rootSessionId: string,
    binding: FinalEndingScopeBindingV1,
    authority: SessionAuthorityRepository,
  ): void {
    const repository = new SqliteLifecycleProjectionRepository(this.connection);
    const eventPosition = BigInt(binding.lastEventPosition);
    const target = repository.findChildAtEvent(
      context.binding.projectId,
      binding.childSessionId,
      eventPosition,
    );
    if (target === null) throw new LifecycleError("INTEGRITY_FAILURE");
    const predecessor = target.streamVersion === 1n
      ? null
      : repository.findChildByStreamVersion(
          context.binding.projectId,
          binding.childSessionId,
          target.streamVersion - 1n,
        );
    if (
      (target.streamVersion === 1n) !== (predecessor === null)
      || (predecessor !== null && (
        predecessor.fingerprint !== target.previousFingerprint
        || predecessor.eventPosition >= target.eventPosition
      ))
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const targetEvent = this.storedEventAt(eventPosition);
    const reportWitness = this.reportWitnessForTarget(
      context,
      repository,
      target,
      targetEvent,
    );
    const expected = foldChildEventProjection(
      predecessor,
      targetEvent,
      reportWitness,
    );
    if (!this.sameChildProjection(target, expected)) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const projection = target;
    if (
      projection.childSessionId !== binding.childSessionId
      || projection.rootSessionId !== rootSessionId
      || projection.childState !== binding.childState
      || projection.eventPosition !== eventPosition
      || projection.streamVersion !== BigInt(binding.streamVersion)
      || projection.latestCheckpointId !== binding.checkpointId
      || projection.latestCheckpointEventPosition
        !== (
          binding.checkpointEventPosition === null
            ? null
            : BigInt(binding.checkpointEventPosition)
        )
      || (
        binding.bindingKind === "carry-forward-ticket"
        && (
          projection.childState !== "transferred"
          || projection.terminalEventPosition !== projection.eventPosition
          || projection.terminalEventType !== "ChildWorkTransferCreated"
        )
      )
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    if (
      !this.eventMatchesContext(context, targetEvent)
      || targetEvent.streamId !== `session/${binding.childSessionId}`
      || targetEvent.streamType !== "session"
      || targetEvent.streamVersion.toString() !== binding.streamVersion
      || targetEvent.sessionId !== binding.childSessionId
      || targetEvent.parentSessionId !== rootSessionId
    ) throw new LifecycleError("INTEGRITY_FAILURE");

    if (binding.bindingKind === "carry-forward-ticket") {
      const ticket = new ChildTransferRepository().get(
        this.connection,
        context.binding.projectId,
        binding.transferTicketId!,
      );
      const created = this.connection.prepare(`
        SELECT event.global_position AS event_global_position,
               event.project_id AS event_project_id,
               event.stream_id AS event_stream_id,
               event.stream_type AS event_stream_type,
               event.stream_version AS event_stream_version,
               event.session_id AS event_session_id,
               event.parent_session_id AS event_parent_session_id,
               event.event_type AS event_type,
               event.event_schema_version AS event_schema_version,
               event.occurred_at AS event_occurred_at,
               json_extract(event.payload_json, '$.transferTicketId') AS payload_ticket_id,
               json_extract(event.payload_json, '$.checkpointId') AS payload_checkpoint_id,
               json_extract(event.payload_json, '$.authorityCommitment')
                 AS payload_authority_commitment
        FROM events AS event
        WHERE event.global_position = $eventPosition
      `).get({
        $eventPosition: BigInt(binding.transferTicketEventPosition!),
      });
      if (
        ticket === null
        || created === undefined
        || ticket.projectId !== context.binding.projectId
        || ticket.transferTicketId !== binding.transferTicketId
        || ticket.sourceParentSessionId !== rootSessionId
        || ticket.sourceChildSessionId !== binding.childSessionId
        || ticket.checkpointId !== binding.checkpointId
        || ticket.createdEventPosition.toString() !== binding.transferTicketEventPosition
        || new Date(Number(ticket.createdAtMs)).toISOString() !== created.event_occurred_at
        || decimal(created.event_global_position) !== binding.transferTicketEventPosition
        || created.event_project_id !== context.binding.projectId
        || created.event_stream_id !== `session/${binding.childSessionId}`
        || created.event_stream_type !== "session"
        || created.event_session_id !== binding.childSessionId
        || created.event_parent_session_id !== ticket.sourceParentSessionId
        || decimal(created.event_stream_version) !== binding.streamVersion
        || created.event_type !== "ChildWorkTransferCreated"
        || integer(created.event_schema_version) !== 1
        || created.payload_ticket_id !== binding.transferTicketId
        || created.payload_checkpoint_id !== binding.checkpointId
        || created.payload_authority_commitment !== projection.authorityCommitment
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      if (ticket.claimedEventPosition !== null) {
        this.assertTransferClaimProvenance(context, ticket);
      }
    }

    if (binding.checkpointId === null || binding.checkpointEventPosition === null) {
      this.assertEventTimeCleanScope(
        context,
        binding.childSessionId,
        BigInt(binding.lastEventPosition),
      );
      return;
    }
    const checkpoint = authority.requireCheckpointAtEventPosition(this.connection, {
      projectId: context.binding.projectId,
      sessionId: binding.childSessionId,
      checkpointId: binding.checkpointId,
      checkpointEventPosition: BigInt(binding.checkpointEventPosition),
    });
    if (checkpoint.checkpointVersion === 2) {
      this.assertCheckpointEvidenceAtRecordedTransitions(context, checkpoint);
      return;
    }
    if (
      checkpoint.evidenceCoverage.highestContiguousOrdinal !== null
      || checkpoint.evidenceCoverage.missingIntervals.length !== 0
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    this.assertEventTimeCleanScope(
      context,
      checkpoint.sessionId,
      BigInt(checkpoint.baseEventPosition),
    );
  }

  private storedEventAt(globalPosition: bigint): StoredEvent {
    const rows = this.connection.prepare(`
      SELECT global_position, event_id, project_id, vault_id, store_id,
             workspace_id, branch_scope_id, branch_ref,
             stream_id, stream_type, stream_version,
             event_type, event_schema_version, session_id, parent_session_id,
             actor_role, agent_id, client_instance_id, correlation_id,
             causation_id, command_id, idempotency_key, command_event_index,
             occurred_at, recorded_at, visibility_scope, confidence,
             verification_status, source_refs_json, evidence_refs_json,
             evidence_digests_json, payload_json, payload_hash,
             previous_global_hash, event_hash, lifecycle_intent_json
      FROM events
      WHERE global_position = $globalPosition
      LIMIT 2
    `).all({ $globalPosition: globalPosition });
    if (rows.length !== 1) throw new LifecycleError("INTEGRITY_FAILURE");
    const row = rows[0]!;
    const position = int64(row.global_position);
    const streamVersion = int64(row.stream_version);
    const eventSchemaVersion = integer(row.event_schema_version);
    const commandEventIndex = integer(row.command_event_index);
    const payload = parsedCanonicalJson(row.payload_json);
    const sourceRefs = parsedCanonicalJson(row.source_refs_json);
    const evidenceRefs = parsedCanonicalJson(row.evidence_refs_json);
    const evidenceDigests = parsedCanonicalJson(row.evidence_digests_json);
    if (
      position === null
      || position !== globalPosition
      || streamVersion === null
      || eventSchemaVersion === null
      || commandEventIndex === null
      || commandEventIndex < 0
      || !record(payload)
      || !nonEmpty(row.event_id)
      || !nonEmpty(row.project_id)
      || !nonEmpty(row.vault_id)
      || !nonEmpty(row.store_id)
      || !nonEmpty(row.workspace_id)
      || !nonEmpty(row.stream_id)
      || !nonEmpty(row.stream_type)
      || !nonEmpty(row.event_type)
      || !ACTOR_ROLES.has(String(row.actor_role))
      || !nonEmpty(row.agent_id)
      || !nonEmpty(row.client_instance_id)
      || !nonEmpty(row.correlation_id)
      || !nonEmpty(row.command_id)
      || !nonEmpty(row.idempotency_key)
      || !nonEmpty(row.occurred_at)
      || !nonEmpty(row.recorded_at)
      || (
        row.visibility_scope !== "project"
        && row.visibility_scope !== "session"
        && row.visibility_scope !== "private"
      )
      || (
        row.confidence !== "low"
        && row.confidence !== "medium"
        && row.confidence !== "high"
      )
      || (
        row.verification_status !== "unverified"
        && row.verification_status !== "partially-verified"
        && row.verification_status !== "verified"
      )
      || !Array.isArray(sourceRefs)
      || sourceRefs.some((value) => typeof value !== "string")
      || !Array.isArray(evidenceRefs)
      || !Array.isArray(evidenceDigests)
      || typeof row.payload_json !== "string"
      || typeof row.payload_hash !== "string"
      || !LOWER_HASH.test(row.payload_hash)
      || typeof row.previous_global_hash !== "string"
      || !LOWER_HASH.test(row.previous_global_hash)
      || typeof row.event_hash !== "string"
      || !LOWER_HASH.test(row.event_hash)
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    return Object.freeze({
      globalPosition: position,
      eventId: row.event_id,
      projectId: row.project_id,
      vaultId: row.vault_id,
      storeId: row.store_id,
      workspaceId: row.workspace_id,
      branchScopeId: typeof row.branch_scope_id === "string"
        ? row.branch_scope_id
        : null,
      branchRef: typeof row.branch_ref === "string" ? row.branch_ref : null,
      streamId: row.stream_id,
      streamType: row.stream_type,
      streamVersion,
      eventType: row.event_type,
      eventSchemaVersion,
      sessionId: typeof row.session_id === "string" ? row.session_id : null,
      parentSessionId: typeof row.parent_session_id === "string"
        ? row.parent_session_id
        : null,
      actorRole: row.actor_role,
      agentId: row.agent_id,
      clientInstanceId: row.client_instance_id,
      correlationId: row.correlation_id,
      causationId: typeof row.causation_id === "string" ? row.causation_id : null,
      commandId: row.command_id,
      idempotencyKey: row.idempotency_key,
      commandEventIndex,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      visibilityScope: row.visibility_scope,
      confidence: row.confidence,
      verificationStatus: row.verification_status,
      sourceRefs: Object.freeze(sourceRefs),
      evidenceRefs: Object.freeze(evidenceRefs),
      evidenceDigests: Object.freeze(evidenceDigests),
      payload,
      payloadJson: row.payload_json,
      payloadHash: row.payload_hash,
      previousGlobalHash: row.previous_global_hash,
      eventHash: row.event_hash,
      lifecycleIntentJson: typeof row.lifecycle_intent_json === "string"
        ? row.lifecycle_intent_json
        : null,
    } as unknown as StoredEvent);
  }

  private decodeStoredLifecycleEvent(
    event: StoredEvent,
    authorityCommitment: string,
  ): LifecycleEventCodecResult {
    try {
      return decodeLifecycleEvent({
        eventSchemaVersion: event.eventSchemaVersion,
        eventId: event.eventId,
        projectId: event.projectId,
        vaultId: event.vaultId,
        storeId: event.storeId,
        workspaceId: event.workspaceId,
        streamId: event.streamId,
        streamVersion: event.streamVersion.toString(),
        globalPosition: event.globalPosition.toString(),
        sessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
        eventType: event.eventType,
        correlationId: event.correlationId,
        causationId: event.causationId,
        commandId: event.commandId,
        idempotencyKey: event.idempotencyKey,
        occurredAt: event.occurredAt,
        authorityCommitment,
        payload: event.payload,
      });
    } catch {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  private eventMatchesContext(
    context: ProjectContext,
    event: StoredEvent,
  ): boolean {
    return this.eventIdentityMatchesContext(context, event);
  }

  private eventIdentityMatchesContext(
    context: ProjectContext,
    identity: {
      readonly projectId: unknown;
      readonly vaultId: unknown;
      readonly storeId: unknown;
      readonly workspaceId: unknown;
      readonly branchScopeId: unknown;
      readonly branchRef: unknown;
    },
  ): boolean {
    const workspace = context.workspace ?? context.binding.workspace;
    const branchRef = workspace?.kind === "git"
      ? workspace.branchRef
      : null;
    return identity.projectId === context.binding.projectId
      && identity.vaultId === context.binding.vaultId
      && identity.storeId === context.binding.storeId
      && identity.workspaceId === context.binding.workspaceId
      && identity.branchScopeId === (context.branchScopeId ?? null)
      && identity.branchRef === branchRef;
  }

  private reportWitnessForTarget(
    context: ProjectContext,
    repository: SqliteLifecycleProjectionRepository,
    target: ChildEventFoldProjection,
    targetEvent: StoredEvent,
  ): ChildEventFoldProjection | null {
    const payload = targetEvent.payload;
    if (!record(payload)) throw new LifecycleError("INTEGRITY_FAILURE");
    const reportId = targetEvent.eventType === "ChildWorkDispositioned"
      ? record(payload.disposition) && typeof payload.disposition.reportId === "string"
        ? payload.disposition.reportId
        : null
      : targetEvent.eventType === "ChildCompletionProposed"
        || targetEvent.eventType === "ChildSessionCompleted"
        ? typeof payload.reportId === "string" ? payload.reportId : null
        : null;
    if (reportId === null) return null;
    const witness = repository.findReportWitness(
      context.binding.projectId,
      target.childSessionId,
      reportId,
    );
    if (
      witness === null
      || witness.eventPosition >= target.eventPosition
      || witness.streamVersion >= target.streamVersion
      || witness.reportedReportId !== reportId
      || witness.reportedItemCount === null
      || witness.reportedItemSetFingerprint === null
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const source = this.storedEventAt(witness.eventPosition);
    const event = this.decodeStoredLifecycleEvent(source, witness.authorityCommitment);
    if (
      event.eventType !== "ChildWorkReported"
      || !this.eventMatchesContext(context, source)
      || source.streamId !== `session/${target.childSessionId}`
      || source.streamType !== "session"
      || event.sessionId !== target.childSessionId
      || event.parentSessionId !== target.rootSessionId
      || event.globalPosition !== witness.eventPosition.toString()
      || event.streamVersion !== witness.streamVersion.toString()
      || event.payload.report.reportId !== reportId
      || event.payload.report.allReportItemIds.length !== witness.reportedItemCount
      || reportItemSetFingerprint({
        projectId: context.binding.projectId,
        childSessionId: target.childSessionId,
        reportId,
        allReportItemIds: event.payload.report.allReportItemIds,
      }) !== witness.reportedItemSetFingerprint
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    return witness;
  }

  private sameChildProjection(
    left: ChildEventFoldProjection,
    right: ChildEventFoldProjection,
  ): boolean {
    return left.projectId === right.projectId
      && left.childSessionId === right.childSessionId
      && left.eventPosition === right.eventPosition
      && left.streamVersion === right.streamVersion
      && left.rootSessionId === right.rootSessionId
      && left.childState === right.childState
      && left.latestCheckpointId === right.latestCheckpointId
      && left.latestCheckpointEventPosition === right.latestCheckpointEventPosition
      && left.authorityCommitment === right.authorityCommitment
      && left.terminalEventType === right.terminalEventType
      && left.terminalEventPosition === right.terminalEventPosition
      && left.reportCount === right.reportCount
      && left.latestReportId === right.latestReportId
      && left.reportIndexFingerprint === right.reportIndexFingerprint
      && left.completionReportId === right.completionReportId
      && left.reportedReportId === right.reportedReportId
      && left.reportedItemCount === right.reportedItemCount
      && left.reportedItemSetFingerprint === right.reportedItemSetFingerprint
      && left.previousFingerprint === right.previousFingerprint
      && left.fingerprint === right.fingerprint;
  }

  private childProjectionFingerprintMatches(row: Readonly<SqliteRow>): boolean {
    const eventPosition = int64(row.event_position);
    const streamVersion = int64(row.stream_version);
    const latestCheckpointEventPosition = row.latest_checkpoint_event_position === null
      ? null
      : int64(row.latest_checkpoint_event_position);
    const terminalEventPosition = row.terminal_event_position === null
      ? null
      : int64(row.terminal_event_position);
    const reportCount = integer(row.report_count);
    const reportedItemCount = row.reported_item_count === null
      ? null
      : integer(row.reported_item_count);
    const childState = row.child_state;
    const terminalEventType = row.terminal_event_type;
    if (
      eventPosition === null
      || streamVersion === null
      || (row.latest_checkpoint_event_position !== null
        && latestCheckpointEventPosition === null)
      || (row.terminal_event_position !== null && terminalEventPosition === null)
      || reportCount === null
      || (row.reported_item_count !== null && reportedItemCount === null)
      || !nonEmpty(row.project_id)
      || !nonEmpty(row.child_session_id)
      || !nonEmpty(row.root_session_id)
      || !nonEmpty(row.authority_commitment)
      || !nonEmpty(row.report_index_fingerprint)
      || !nonEmpty(row.fingerprint)
      || (childState !== "active"
        && childState !== "completion-proposed"
        && childState !== "completed"
        && childState !== "suspended"
        && childState !== "transferred")
      || (terminalEventType !== null
        && terminalEventType !== "ChildSessionCompleted"
        && terminalEventType !== "ChildWorkTransferCreated")
    ) return false;
    try {
      return childEventFoldFingerprint({
        projectId: row.project_id as string,
        childSessionId: row.child_session_id as string,
        eventPosition,
        streamVersion,
        rootSessionId: row.root_session_id as string,
        childState,
        latestCheckpointId: row.latest_checkpoint_id as string | null,
        latestCheckpointEventPosition,
        authorityCommitment: row.authority_commitment as string,
        terminalEventType,
        terminalEventPosition,
        reportCount,
        latestReportId: row.latest_report_id as string | null,
        reportIndexFingerprint: row.report_index_fingerprint as string,
        completionReportId: row.completion_report_id as string | null,
        reportedReportId: row.reported_report_id as string | null,
        reportedItemCount,
        reportedItemSetFingerprint:
          row.reported_item_set_fingerprint as string | null,
        previousFingerprint: row.previous_fingerprint as string | null,
      }) === row.fingerprint;
    } catch {
      return false;
    }
  }

  private assertTransferClaimProvenance(
    context: ProjectContext,
    ticket: ChildTransferTicketRecord,
  ): void {
    if (
      ticket.claimedByRootSessionId === null
      || ticket.claimedChildSessionId === null
      || ticket.claimedEventPosition === null
      || ticket.claimedAtMs === null
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const row = this.connection.prepare(`
      SELECT
        fork.global_position AS fork_global_position,
        fork.event_id AS fork_event_id,
        fork.project_id AS fork_project_id,
        fork.vault_id AS fork_vault_id,
        fork.store_id AS fork_store_id,
        fork.workspace_id AS fork_workspace_id,
        fork.branch_scope_id AS fork_branch_scope_id,
        fork.branch_ref AS fork_branch_ref,
        fork.stream_id AS fork_stream_id,
        fork.stream_type AS fork_stream_type,
        fork.stream_version AS fork_stream_version,
        fork.event_type AS fork_event_type,
        fork.event_schema_version AS fork_event_schema_version,
        fork.session_id AS fork_session_id,
        fork.parent_session_id AS fork_parent_session_id,
        fork.correlation_id AS fork_correlation_id,
        fork.causation_id AS fork_causation_id,
        fork.command_id AS fork_command_id,
        fork.idempotency_key AS fork_idempotency_key,
        fork.occurred_at AS fork_occurred_at,
        fork.payload_json AS fork_payload_json,
        claimed.global_position AS claimed_global_position,
        claimed.event_id AS claimed_event_id,
        claimed.project_id AS claimed_project_id,
        claimed.vault_id AS claimed_vault_id,
        claimed.store_id AS claimed_store_id,
        claimed.workspace_id AS claimed_workspace_id,
        claimed.branch_scope_id AS claimed_branch_scope_id,
        claimed.branch_ref AS claimed_branch_ref,
        claimed.stream_id AS claimed_stream_id,
        claimed.stream_type AS claimed_stream_type,
        claimed.stream_version AS claimed_stream_version,
        claimed.event_type AS claimed_event_type,
        claimed.event_schema_version AS claimed_event_schema_version,
        claimed.session_id AS claimed_session_id,
        claimed.parent_session_id AS claimed_parent_session_id,
        claimed.correlation_id AS claimed_correlation_id,
        claimed.causation_id AS claimed_causation_id,
        claimed.command_id AS claimed_command_id,
        claimed.idempotency_key AS claimed_idempotency_key,
        claimed.occurred_at AS claimed_occurred_at,
        claimed.payload_json AS claimed_payload_json
      FROM events AS claimed
      LEFT JOIN events AS fork INDEXED BY events_stream_range
        ON fork.project_id = claimed.project_id
        AND fork.stream_id = claimed.stream_id
        AND fork.stream_version = 1
      WHERE claimed.global_position = $claimedEventPosition
      LIMIT 1
    `).get({ $claimedEventPosition: ticket.claimedEventPosition });
    if (row === undefined) throw new LifecycleError("INTEGRITY_FAILURE");
    const decode = (
      prefix: "fork" | "claimed",
      authorityCommitment: string,
    ): LifecycleEvent => {
      const payload = parsedCanonicalJson(row[`${prefix}_payload_json`]);
      const eventSchemaVersion = integer(row[`${prefix}_event_schema_version`]);
      const streamVersion = decimal(row[`${prefix}_stream_version`]);
      const globalPosition = decimal(row[`${prefix}_global_position`]);
      if (
        !record(payload)
        || eventSchemaVersion === null
        || streamVersion === null
        || globalPosition === null
        || row[`${prefix}_stream_type`] !== "session"
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      return decodeLegacyLifecycleEvent({
        eventSchemaVersion,
        eventId: row[`${prefix}_event_id`],
        projectId: row[`${prefix}_project_id`],
        vaultId: row[`${prefix}_vault_id`],
        storeId: row[`${prefix}_store_id`],
        workspaceId: row[`${prefix}_workspace_id`],
        streamId: row[`${prefix}_stream_id`],
        streamVersion,
        globalPosition,
        sessionId: row[`${prefix}_session_id`],
        parentSessionId: row[`${prefix}_parent_session_id`],
        eventType: row[`${prefix}_event_type`],
        correlationId: row[`${prefix}_correlation_id`],
        causationId: row[`${prefix}_causation_id`],
        commandId: row[`${prefix}_command_id`],
        idempotencyKey: row[`${prefix}_idempotency_key`],
        occurredAt: row[`${prefix}_occurred_at`],
        authorityCommitment,
        payload,
      });
    };
    const forkPayload = parsedCanonicalJson(row.fork_payload_json);
    if (!record(forkPayload) || typeof forkPayload.authorityCommitment !== "string") {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const fork = decode("fork", forkPayload.authorityCommitment);
    const claimed = decode("claimed", fork.authorityCommitment);
    const projection = evolveSession(foldSession([fork]), claimed);
    if (
      fork.eventType !== "SessionForked"
      || fork.eventSchemaVersion !== 1
      || !this.eventIdentityMatchesContext(context, {
        projectId: row.fork_project_id,
        vaultId: row.fork_vault_id,
        storeId: row.fork_store_id,
        workspaceId: row.fork_workspace_id,
        branchScopeId: row.fork_branch_scope_id,
        branchRef: row.fork_branch_ref,
      })
      || fork.sessionId !== ticket.claimedChildSessionId
      || fork.parentSessionId !== ticket.claimedByRootSessionId
      || fork.streamVersion !== "1"
      || fork.payload.sourceTransferTicketId !== ticket.transferTicketId
      || claimed.eventType !== "ChildWorkTransferClaimed"
      || claimed.eventSchemaVersion !== 1
      || !this.eventIdentityMatchesContext(context, {
        projectId: row.claimed_project_id,
        vaultId: row.claimed_vault_id,
        storeId: row.claimed_store_id,
        workspaceId: row.claimed_workspace_id,
        branchScopeId: row.claimed_branch_scope_id,
        branchRef: row.claimed_branch_ref,
      })
      || claimed.sessionId !== ticket.claimedChildSessionId
      || claimed.parentSessionId !== ticket.claimedByRootSessionId
      || claimed.streamVersion !== "2"
      || claimed.globalPosition !== ticket.claimedEventPosition.toString()
      || claimed.occurredAt !== new Date(Number(ticket.claimedAtMs)).toISOString()
      || claimed.payload.transferTicketId !== ticket.transferTicketId
      || claimed.payload.previousChildSessionId !== ticket.sourceChildSessionId
      || claimed.payload.previousTransferEventPosition
        !== ticket.createdEventPosition.toString()
      || projection.kind !== "child"
      || projection.claimedTransferTicketId !== ticket.transferTicketId
    ) throw new LifecycleError("INTEGRITY_FAILURE");
  }

  private assertCheckpointEvidenceAtRecordedTransitions(
    context: ProjectContext,
    checkpoint: CheckpointV2,
  ): void {
    let previousAdapter: string | null = null;
    let totalIntervals = 0;
    const select = this.connection.prepare(`
      SELECT *
      FROM session_evidence_coverage_transitions
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND adapter_session_id = $adapterSessionId
        AND batch_event_position = $batchEventPosition
      LIMIT 2
    `);
    for (const entry of checkpoint.evidenceCoverage.adapterSessions) {
      const position = BigInt(entry.latestBatchEventPosition);
      if (
        previousAdapter !== null
        && binaryCompare(previousAdapter, entry.adapterSessionId) >= 0
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      previousAdapter = entry.adapterSessionId;
      totalIntervals += entry.missingIntervals.length;
      if (
        checkpoint.evidenceCoverage.adapterSessions.length > 200
        || totalIntervals > 200
        || position > BigInt(checkpoint.baseEventPosition)
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      const rows = select.all({
        $projectId: context.binding.projectId,
        $sessionId: checkpoint.sessionId,
        $adapterSessionId: entry.adapterSessionId,
        $batchEventPosition: position,
      });
      if (rows.length !== 1) throw new LifecycleError("INTEGRITY_FAILURE");
      const transition = this.hydrateQualifiedTransition({ ...rows[0]! });
      const event = this.storedEventAt(position);
      const decoded = this.decodeStoredLifecycleEvent(event, "0".repeat(64));
      if (
        event.eventType !== "EvidenceCoverageRecorded"
        || event.eventSchemaVersion !== 2
        || event.sessionId !== checkpoint.sessionId
        || decoded.eventType !== "EvidenceCoverageRecorded"
        || decoded.eventSchemaVersion !== 2
        || transition.projectId !== context.binding.projectId
        || transition.sessionId !== checkpoint.sessionId
        || transition.adapterSessionId !== entry.adapterSessionId
        || transition.batchId !== entry.latestBatchId
        || transition.batchEventPosition !== position
        || transition.coverageFirstOrdinal.toString() !== entry.coverageFirstOrdinal
        || transition.coverageLastOrdinal.toString() !== entry.coverageLastOrdinal
        || (transition.highestContiguousOrdinal?.toString() ?? null)
          !== entry.highestContiguousOrdinal
        || !this.sameReplayIntervals(transition.missingIntervals, entry.missingIntervals)
        || transition.frameFingerprintAlgorithm !== entry.frameFingerprintAlgorithm
        || transition.frameFingerprintSchemaVersion !== entry.frameFingerprintSchemaVersion
        || transition.frameFingerprintKeyId !== entry.frameFingerprintKeyId
        || transition.frameFingerprintDomain !== entry.frameFingerprintDomain
        || transition.coverageFingerprintAlgorithm !== entry.coverageFingerprintAlgorithm
        || transition.coverageFingerprintSchemaVersion !== entry.coverageFingerprintSchemaVersion
        || transition.coverageFingerprintKeyId !== entry.coverageFingerprintKeyId
        || transition.coverageFingerprintDomain !== entry.coverageFingerprintDomain
        || transition.coverageFingerprintValue !== entry.coverageFingerprint
        || transition.captureMode !== checkpoint.evidenceCoverage.captureMode
        || transition.contentRetained !== checkpoint.evidenceCoverage.contentRetained
        || decoded.payload.adapterSessionId !== transition.adapterSessionId
        || decoded.payload.batchId !== transition.batchId
        || decoded.payload.batchFirstOrdinal !== transition.batchFirstOrdinal.toString()
        || decoded.payload.batchLastOrdinal !== transition.batchLastOrdinal.toString()
        || decoded.payload.coverageFirstOrdinal !== transition.coverageFirstOrdinal.toString()
        || decoded.payload.coverageLastOrdinal !== transition.coverageLastOrdinal.toString()
        || decoded.payload.highestContiguousOrdinal
          !== (transition.highestContiguousOrdinal?.toString() ?? null)
        || !this.sameReplayIntervals(transition.missingIntervals, decoded.payload.missingIntervals)
        || decoded.payload.coverageFingerprint !== transition.coverageFingerprintValue
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  private assertEventTimeCleanScope(
    context: ProjectContext,
    sessionId: string,
    basePosition: bigint,
  ): void {
    const artifact = this.connection.prepare(`
      SELECT 1 AS present
      FROM events INDEXED BY events_session_evidence_artifacts
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND global_position <= $basePosition
        AND stream_type = 'session'
        AND session_id IS NOT NULL
        AND (
          event_type = 'EvidenceCoverageRecorded'
          OR (
            event_type = 'SessionCheckpointRecorded'
            AND (
              json_extract(
                payload_json,
                '$.checkpoint.evidenceCoverage.highestContiguousOrdinal'
              ) IS NOT NULL
              OR coalesce(json_array_length(
                payload_json,
                '$.checkpoint.evidenceCoverage.missingIntervals'
              ), 0) > 0
              OR coalesce(json_array_length(
                payload_json,
                '$.checkpoint.evidenceCoverage.adapterSessions'
              ), 0) > 0
            )
          )
        )
      LIMIT 1
    `).get({
      $projectId: context.binding.projectId,
      $sessionId: sessionId,
      $basePosition: basePosition,
    });
    if (artifact !== undefined) throw new LifecycleError("INTEGRITY_FAILURE");
  }

  private checkProspectiveCapacity(
    context: ProjectContext,
    coverage: EvidenceCoverageRepository,
    currentEvidenceSessionIds: readonly string[],
  ): void {
    const authority = new SessionAuthorityRepository();
    const transfers = new ChildTransferRepository();
    const roots = this.connection.prepare(`
      SELECT session_id
      FROM session_authority
      WHERE project_id = $projectId
        AND session_kind = 'root'
        AND terminal_event_position IS NULL
      ORDER BY CAST(session_id AS BLOB)
    `).all({ $projectId: context.binding.projectId });
    const evidenceSessions = new Set(currentEvidenceSessionIds);
    for (const row of roots) {
      if (typeof row.session_id !== "string") throw new LifecycleError("INTEGRITY_FAILURE");
      const root = authority.get(
        this.connection,
        context.binding.projectId,
        row.session_id,
      );
      if (root === null || root.sessionKind !== "root") {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      const children = authority.listNonterminalChildEndingScopeProjectionsBounded(
        this.connection,
        root.projectId,
        root.sessionId,
        ENDING_SCOPE_LIMIT_PLUS_ONE,
      );
      const tickets = transfers.listUnclaimedEndingScopeProjectionsBySourceRoot(
        this.connection,
        root.projectId,
        root.sessionId,
        ENDING_SCOPE_LIMIT_PLUS_ONE,
      );
      if (
        children.length >= ENDING_SCOPE_LIMIT_PLUS_ONE
        || tickets.length >= ENDING_SCOPE_LIMIT_PLUS_ONE
      ) throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
      const rawBindings = [
        ...children.map((projection) => currentBinding(root, projection)),
        ...tickets.map((projection) => carryBinding(root, projection)),
      ].sort((left, right) => binaryCompare(left.childSessionId, right.childSessionId));
      const bindings = decodeFinalEndingScopeBindingsV1(rawBindings);
      const relevantSessionIds = new Set<string>([root.sessionId]);
      for (const sessionId of currentEvidenceSessionIds) {
        const facts = authority.get(
          this.connection,
          context.binding.projectId,
          sessionId,
        );
        if (facts === null) throw new LifecycleError("INTEGRITY_FAILURE");
        const rootSessionId = facts.sessionKind === "root"
          ? facts.sessionId
          : facts.parentSessionId;
        if (rootSessionId === root.sessionId) relevantSessionIds.add(sessionId);
      }
      for (const sessionId of relevantSessionIds) {
        const snapshot = evidenceSessions.has(sessionId)
          ? coverage.snapshotV2(
              this.connection,
              sessionId as never,
              SQLITE_INT64_MAX,
            )
          : EMPTY_QUALIFIED_COVERAGE;
        const checkpointBytes = coverage.minimumCheckpointUpperBound(
          this.connection,
          { evidenceCoverage: snapshot, endingScopeBindings: bindings },
        );
        const endingScopeBytes = coverage.minimumFinalEndingScopeBindingsUpperBound(
          this.connection,
          { endingScopeBindings: bindings },
        );
        if (
          !Number.isSafeInteger(checkpointBytes)
          || checkpointBytes < 0
          || !Number.isSafeInteger(endingScopeBytes)
          || endingScopeBytes < 0
          || checkpointBytes > CHECKPOINT_MAX_CANONICAL_BYTES
          || endingScopeBytes > FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES
        ) throw new LifecycleError("CHECKPOINT_CAPACITY_EXCEEDED");
      }
    }
  }

  private hasLifecycleSchema(): boolean {
    return this.connection.prepare(`
      SELECT 1 AS present
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'session_authority'
      LIMIT 1
    `).get() !== undefined;
  }

  private hasQualifiedLifecycleSchema(): boolean {
    return this.connection.prepare(`
      SELECT 1 AS present
      FROM sqlite_schema
      WHERE type = 'table'
        AND name = 'session_evidence_coverage_transitions'
      LIMIT 1
    `).get() !== undefined;
  }

  private assertSynchronousEvidenceAuthenticationAvailable(
    context: ProjectContext,
  ): void {
    const hasQualifiedCoverageTable = this.connection.prepare(`
      SELECT 1 AS present
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'session_evidence_coverage_transitions'
      LIMIT 1
    `).get() !== undefined;
    if (!hasQualifiedCoverageTable) return;

    const hasQualifiedCoverage = this.connection.prepare(`
      SELECT 1 AS present
      FROM session_evidence_coverage_transitions
      WHERE project_id = $projectId
      LIMIT 1
    `).get({ $projectId: context.binding.projectId }) !== undefined;
    if (hasQualifiedCoverage) {
      throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
    }
  }

  private checkAuthorization(context: ProjectContext, sink: IntegrityIssueSink): void {
    const rows = this.connection.prepare(`
      SELECT command_type, lifecycle_authorization_kind, authorization_proof_version,
             authorization_proof_nonce, authorization_proof_digest,
             authorization_approval_id, authorization_approval_digest,
             authorization_session_id, target_session_id, presenting_actor_role,
             presenting_client_instance_id, target_actor_role,
             target_client_instance_id, internal_workflow_id,
             internal_workflow_generation, internal_planned_work_id,
             internal_claim_owner_id, internal_claim_token
      FROM command_dedup
      WHERE project_id = $projectId
    `).all({ $projectId: context.binding.projectId });
    for (const row of rows) {
      const kind = row.lifecycle_authorization_kind;
      if (kind === null) {
        if (!allNull(row, AUTHORIZATION_COLUMNS)) {
          issue(sink, "COMMAND_AUTHORIZATION_METADATA_MISMATCH");
          return;
        }
        continue;
      }
      const proofColumns = [
        "authorization_proof_version",
        "authorization_proof_nonce",
        "authorization_proof_digest",
      ] as const;
      const approvalColumns = [
        "authorization_approval_id",
        "authorization_approval_digest",
      ] as const;
      const internalColumns = [
        "internal_workflow_id",
        "internal_workflow_generation",
        "internal_planned_work_id",
        "internal_claim_owner_id",
        "internal_claim_token",
      ] as const;
      const proof = allPresent(row, proofColumns);
      const approval = allPresent(row, approvalColumns);
      const audiencesValid = ACTOR_ROLES.has(String(row.presenting_actor_role))
        && ACTOR_ROLES.has(String(row.target_actor_role))
        && nonEmpty(row.presenting_client_instance_id)
        && nonEmpty(row.target_client_instance_id);
      const proofValid = completeTuple(row, proofColumns)
        && (!proof || (
          integer(row.authorization_proof_version) === 1
          && typeof row.authorization_proof_nonce === "string"
          && LOWER_UUID.test(row.authorization_proof_nonce)
          && typeof row.authorization_proof_digest === "string"
          && LOWER_HASH.test(row.authorization_proof_digest)
        ));
      const approvalValid = completeTuple(row, approvalColumns)
        && (!approval || (
          typeof row.authorization_approval_id === "string"
          && LOWER_UUID.test(row.authorization_approval_id)
          && typeof row.authorization_approval_digest === "string"
          && LOWER_HASH.test(row.authorization_approval_digest)
        ));
      if (!audiencesValid || !proofValid || !approvalValid) {
        issue(sink, "COMMAND_AUTHORIZATION_METADATA_MISMATCH");
        return;
      }
      if (kind === "initial-authority") {
        if (
          row.command_type !== "root-start"
          || !nonEmpty(row.target_session_id)
          || present(row.authorization_session_id)
          || proof
          || approval
          || !allNull(row, internalColumns)
        ) {
          issue(sink, "COMMAND_AUTHORIZATION_METADATA_MISMATCH");
          return;
        }
      } else if (kind === "protected") {
        if (
          !PROTECTED_COMMAND_TYPES.has(String(row.command_type))
          || !nonEmpty(row.authorization_session_id)
          || !nonEmpty(row.target_session_id)
          || (!proof && !approval)
          || ((proof && approval) !== (row.command_type === "abandon-session"))
          || !allNull(row, internalColumns)
        ) {
          issue(sink, "COMMAND_AUTHORIZATION_METADATA_MISMATCH");
          return;
        }
      } else if (kind === "internal-workflow") {
        if (
          !INTERNAL_COMMAND_TYPES.has(String(row.command_type))
          || !nonEmpty(row.authorization_session_id)
          || !nonEmpty(row.target_session_id)
          || !nonEmpty(row.internal_workflow_id)
          || !positive(row.internal_workflow_generation)
          || typeof row.internal_planned_work_id !== "string"
          || !LOWER_HASH.test(row.internal_planned_work_id)
          || !nonEmpty(row.internal_claim_owner_id)
          || !positive(row.internal_claim_token)
          || proof
          || approval
        ) {
          issue(sink, "COMMAND_AUTHORIZATION_METADATA_MISMATCH");
          return;
        }
      } else {
        issue(sink, "COMMAND_AUTHORIZATION_METADATA_MISMATCH");
        return;
      }
    }
  }

  private checkAuthorityLinkage(
    context: ProjectContext,
    sink: IntegrityIssueSink,
    full: boolean,
    historyAlreadyReplayed = false,
  ): void {
    const deferredV2Projection = full
      && !historyAlreadyReplayed
      && this.hasQualifiedLifecycleSchema()
      ? this.connection.prepare(`
          SELECT *
          FROM lifecycle_child_event_folds
            INDEXED BY lifecycle_child_event_folds_full_replay
          WHERE project_id = $projectId AND event_position = $eventPosition
          LIMIT 2
        `)
      : null;
    const rows = this.connection.prepare(`
      SELECT authority.*, event.project_id AS event_project_id,
             event.stream_id AS event_stream_id, event.session_id AS event_session_id,
             event.parent_session_id AS event_parent_session_id,
             event.payload_json AS event_payload_json,
             event.event_type AS authority_event_type,
             stream.current_version AS endpoint_stream_version
      FROM session_authority AS authority
      LEFT JOIN events AS event
        ON event.global_position = authority.authority_event_position
      LEFT JOIN streams AS stream
        ON stream.project_id = authority.project_id
        AND stream.stream_id = authority.stream_id
      WHERE authority.project_id = $projectId
      ORDER BY authority.session_id
    `).all({ $projectId: context.binding.projectId });
    if (full) {
      const lifecycleStreams = this.connection.prepare(`
        SELECT stream_id
        FROM streams
        WHERE project_id = $projectId AND stream_id GLOB 'session/*'
        UNION
        SELECT stream_id
        FROM events
        WHERE project_id = $projectId AND stream_id GLOB 'session/*'
        ORDER BY stream_id
      `).all({ $projectId: context.binding.projectId });
      const authorityStreams = new Set(rows.map((row) => row.stream_id));
      if (
        lifecycleStreams.length !== authorityStreams.size
        || lifecycleStreams.some((stream) => (
          typeof stream.stream_id !== "string" || !authorityStreams.has(stream.stream_id)
        ))
      ) {
        issue(sink, "SESSION_AUTHORITY_FOLD_MISMATCH");
        return;
      }
    }
    for (const row of rows) {
      const root = row.session_kind === "root";
      const child = row.session_kind === "child";
      const terminalTuple = [row.terminal_event_position, row.terminal_event_type, row.terminal_at];
      const revocationTuple = [row.revocation_reason_code, row.revocation_event_position, row.revoked_at];
      const checkpointTuple = [
        row.latest_checkpoint_id,
        row.latest_checkpoint_event_position,
        row.latest_checkpoint_fingerprint,
      ];
      let authorityPayload: unknown;
      try {
        authorityPayload = parsedCanonicalJson(row.event_payload_json);
      } catch {
        authorityPayload = null;
      }
      if (
        (!root && !child)
        || (root ? row.parent_session_id !== null : !nonEmpty(row.parent_session_id))
        || row.workspace_id !== context.binding.workspaceId
        || row.stream_id !== `session/${String(row.session_id)}`
        || row.event_project_id !== row.project_id
        || row.event_stream_id !== row.stream_id
        || row.event_session_id !== row.session_id
        || (child && row.event_parent_session_id !== row.parent_session_id)
        || (terminalTuple.some(present) && !terminalTuple.every(present))
        || (revocationTuple.some(present) && !revocationTuple.every(present))
        || (checkpointTuple.some(present) && !checkpointTuple.every(present))
        || !record(authorityPayload)
        || authorityPayload.authorityCommitment !== row.authority_commitment
        || row.authority_commitment !== this.authorityRowCommitment(row)
      ) {
        issue(sink, "SESSION_AUTHORITY_FOLD_MISMATCH");
        return;
      }
      if (full && !historyAlreadyReplayed) {
        try {
          const events = this.lifecycleEvents(row);
          const deferredV2Transfers = events.filter((event) => (
            event.eventType === "ChildWorkTransferCreated"
            && event.eventSchemaVersion === 2
          ));
          if (deferredV2Transfers.length === 0) {
            const aggregate = foldSession(events);
            if (!this.authorityMatchesFold(row, aggregate, events)) {
              issue(sink, "SESSION_AUTHORITY_FOLD_MISMATCH");
              return;
            }
          } else {
            if (deferredV2Projection === null) {
              throw new LifecycleError("INTEGRITY_FAILURE");
            }
            for (const event of deferredV2Transfers) {
              const projections = deferredV2Projection.all({
                $projectId: context.binding.projectId,
                $eventPosition: event.globalPosition,
              });
              if (
                projections.length !== 1
                || projections[0]!.project_id !== context.binding.projectId
                || projections[0]!.child_session_id !== event.sessionId
                || projections[0]!.root_session_id !== event.parentSessionId
                || int64(projections[0]!.event_position) !== BigInt(event.globalPosition)
                || int64(projections[0]!.stream_version) !== BigInt(event.streamVersion)
                || decimal(row.authority_event_position) !== event.globalPosition
                || int64(row.endpoint_stream_version) !== BigInt(event.streamVersion)
                || !this.childProjectionFingerprintMatches(projections[0]!)
              ) throw new LifecycleError("INTEGRITY_FAILURE");
            }
          }
        } catch {
          issue(sink, "SESSION_AUTHORITY_FOLD_MISMATCH");
          return;
        }
      }
    }
  }

  private lifecycleEvents(authority: SqliteRow): readonly LifecycleEventCodecResult[] {
    const rows = this.connection.prepare(`
      SELECT global_position, event_id, project_id, vault_id, store_id,
             workspace_id, stream_id, stream_type, stream_version,
             event_type, event_schema_version, session_id, parent_session_id,
             correlation_id, causation_id, command_id, idempotency_key,
             occurred_at, payload_json
      FROM events
      WHERE project_id = $projectId AND stream_id = $streamId
      ORDER BY stream_version
    `).all({
      $projectId: authority.project_id,
      $streamId: authority.stream_id,
    });
    const events: LifecycleEventCodecResult[] = [];
    let authorityCommitment: string | null = null;
    for (const row of rows) {
      const payload = parsedCanonicalJson(row.payload_json);
      if (!record(payload)) throw new Error("INVALID_LIFECYCLE_PAYLOAD");
      if (typeof payload.authorityCommitment === "string") {
        authorityCommitment = payload.authorityCommitment;
      }
      const eventSchemaVersion = integer(row.event_schema_version);
      const streamVersion = decimal(row.stream_version);
      const globalPosition = decimal(row.global_position);
      if (
        eventSchemaVersion === null
        || streamVersion === null
        || globalPosition === null
        || authorityCommitment === null
        || row.stream_type !== "session"
      ) throw new Error("INVALID_LIFECYCLE_EVENT_ENVELOPE");
      events.push(decodeLifecycleEvent({
        eventSchemaVersion,
        eventId: row.event_id,
        projectId: row.project_id,
        vaultId: row.vault_id,
        storeId: row.store_id,
        workspaceId: row.workspace_id,
        streamId: row.stream_id,
        streamVersion,
        globalPosition,
        sessionId: row.session_id,
        parentSessionId: row.parent_session_id,
        eventType: row.event_type,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        commandId: row.command_id,
        idempotencyKey: row.idempotency_key,
        occurredAt: row.occurred_at,
        authorityCommitment,
        payload,
      }));
    }
    return events;
  }

  private authorityMatchesFold(
    row: SqliteRow,
    aggregate: SessionAggregateState,
    events: readonly LifecycleEventCodecResult[],
  ): boolean {
    const latestAuthorityEvent = [...events].reverse().find((event) => (
      "authorityCommitment" in event.payload
      && typeof event.payload.authorityCommitment === "string"
    ));
    const expectedOwnerGeneration = aggregate.kind === "root" ? aggregate.ownerGeneration : null;
    const expectedChildGeneration = aggregate.kind === "child"
      ? aggregate.childCapabilityGeneration
      : null;
    const expectedDirectAccess = aggregate.kind === "child" && aggregate.directAccessEnabled ? 1 : 0;
    const authorityPosition = latestAuthorityEvent?.globalPosition ?? null;
    const terminalPosition = aggregate.terminalEventPosition?.toString() ?? null;
    const latestCheckpointEvent = [...events].reverse().find((event) => (
      event.eventType === "SessionCheckpointRecorded"
    ));
    const expectedCheckpointFingerprint = aggregate.latestCheckpointId === null
      ? null
      : latestCheckpointEvent === undefined
        ? null
        : canonicalHash(latestCheckpointEvent.payload.checkpoint);
    const checkpointRequirement = this.checkpointRequirement(row, events);
    const revocation = this.revocation(events);
    const terminalEvent = aggregate.terminalEventPosition === null
      ? undefined
      : events.find((event) => event.globalPosition === aggregate.terminalEventPosition?.toString());
    if (
      row.session_kind !== aggregate.kind
      || row.parent_session_id !== aggregate.parentSessionId
      || row.semantic_state !== aggregate.state
      || integer(row.owner_generation) !== expectedOwnerGeneration
      || integer(row.child_capability_generation) !== expectedChildGeneration
      || integer(row.direct_access_enabled) !== expectedDirectAccess
      || row.authority_commitment !== aggregate.authorityCommitment
      || decimal(row.authority_event_position) !== authorityPosition
      || row.latest_checkpoint_id !== aggregate.latestCheckpointId
      || decimal(row.latest_checkpoint_event_position)
        !== (aggregate.latestCheckpointEventPosition?.toString() ?? null)
      || row.latest_checkpoint_fingerprint !== expectedCheckpointFingerprint
      || row.checkpoint_required_reason !== (checkpointRequirement?.reason ?? null)
      || decimal(row.checkpoint_required_event_position)
        !== (checkpointRequirement?.eventPosition ?? null)
      || row.revocation_reason_code !== (revocation?.reason ?? null)
      || decimal(row.revocation_event_position) !== (revocation?.eventPosition ?? null)
      || row.revoked_at !== (revocation?.revokedAt ?? null)
      || decimal(row.terminal_event_position) !== terminalPosition
      || row.terminal_event_type !== aggregate.terminalEventType
      || row.terminal_at !== (terminalEvent?.occurredAt ?? null)
    ) return false;
    return true;
  }

  private checkpointRequirement(
    authority: SqliteRow,
    events: readonly LifecycleEventCodecResult[],
  ): CheckpointRequirementFold | null {
    const transitions: CheckpointRequirementTransition[] = [];
    const requireCheckpoint = (reason: string, eventPosition: string): void => {
      transitions.push({ kind: "require", reason, eventPosition });
    };
    for (const event of events) {
      switch (event.eventType) {
        case "SessionCheckpointRecorded":
          transitions.push({
            kind: "clear",
            eventPosition: event.globalPosition,
            baseEventPosition: event.payload.baseEventPosition,
          });
          break;
        case "SessionOwnerTransferred":
          requireCheckpoint("ownership-transfer", event.globalPosition);
          break;
        case "SessionOwnershipRecovered":
          requireCheckpoint("ownership-recovery", event.globalPosition);
          break;
        case "SessionSuspendRequested":
        case "SessionSuspended":
          requireCheckpoint("suspension", event.globalPosition);
          break;
        case "ChildWorkTransferClaimed":
          requireCheckpoint("carry-forward-claim", event.globalPosition);
          break;
        case "SessionEndAmended":
          requireCheckpoint("end-amendment", event.globalPosition);
          break;
        case "SessionEndCancelled":
          requireCheckpoint("end-cancellation", event.globalPosition);
          break;
        default:
          break;
      }
    }
    if (authority.session_kind === "root") {
      const children = this.connection.prepare(`
        SELECT *
        FROM session_authority
        WHERE project_id = $projectId
          AND session_kind = 'child'
          AND parent_session_id = $parentSessionId
        ORDER BY session_id
      `).all({
        $projectId: authority.project_id,
        $parentSessionId: authority.session_id,
      });
      for (const child of children) {
        for (const event of this.lifecycleEvents(child)) {
          if (event.eventType === "ChildWorkDispositioned"
            && (event.payload.disposition.kind === "accepted"
              || event.payload.disposition.kind === "partially-accepted")) {
            requireCheckpoint("accepted-child-report", event.globalPosition);
          }
        }
      }
    }
    transitions.sort((left, right) => (
      BigInt(left.eventPosition) < BigInt(right.eventPosition) ? -1
        : BigInt(left.eventPosition) > BigInt(right.eventPosition) ? 1 : 0
    ));
    let requirement: CheckpointRequirementFold | null = null;
    for (const transition of transitions) {
      if (transition.kind === "require") {
        requirement = {
          reason: transition.reason,
          eventPosition: transition.eventPosition,
        };
      } else if (requirement !== null
        && BigInt(transition.baseEventPosition) >= BigInt(requirement.eventPosition)) {
        requirement = null;
      }
    }
    return requirement;
  }

  private revocation(events: readonly LifecycleEventCodecResult[]): RevocationFold | null {
    let revocation: RevocationFold | null = null;
    for (const event of events) {
      if (event.eventType === "SessionAbandoned") {
        revocation = {
          reason: event.payload.reasonCode,
          eventPosition: event.globalPosition,
          revokedAt: event.occurredAt,
        };
      } else if (event.eventType === "ChildSessionCompleted") {
        revocation = {
          reason: "child-completed",
          eventPosition: event.globalPosition,
          revokedAt: event.occurredAt,
        };
      } else if (event.eventType === "ChildSessionSuspended") {
        revocation = {
          reason: "child-suspended",
          eventPosition: event.globalPosition,
          revokedAt: event.occurredAt,
        };
      } else if (event.eventType === "ChildWorkTransferCreated") {
        revocation = {
          reason: "child-transferred",
          eventPosition: event.globalPosition,
          revokedAt: event.occurredAt,
        };
      }
    }
    return revocation;
  }

  private checkLeases(context: ProjectContext, sink: IntegrityIssueSink): void {
    const rows = this.connection.prepare(`
      SELECT authority.session_id, authority.owner_generation,
             authority.session_kind, authority.terminal_event_position,
             sum(CASE WHEN lease.session_id IS NOT NULL AND lease.released_at IS NULL
                      THEN 1 ELSE 0 END) AS active_count,
             max(CASE WHEN lease.released_at IS NULL THEN lease.owner_generation END) AS active_generation,
             max(lease.owner_generation) AS maximum_generation
      FROM session_authority AS authority
      LEFT JOIN session_leases AS lease
        ON lease.project_id = authority.project_id
       AND lease.session_id = authority.session_id
      WHERE authority.project_id = $projectId
      GROUP BY authority.session_id, authority.owner_generation,
               authority.session_kind, authority.terminal_event_position
    `).all({ $projectId: context.binding.projectId });
    for (const row of rows) {
      const count = Number(row.active_count);
      const owner = row.owner_generation;
      if (
        !Number.isSafeInteger(count)
        || count < 0
        || count > 1
        || (count === 1 && (
          row.session_kind !== "root"
          || row.terminal_event_position !== null
          || owner === null
          || !sameInteger(row.active_generation, owner)
        ))
        || (row.maximum_generation !== null && owner !== null
          && integer(row.maximum_generation)! > integer(owner)!)
      ) {
        issue(sink, "SESSION_LEASE_INVARIANT_MISMATCH");
        return;
      }
    }
  }

  private checkWorkflowShape(
    context: ProjectContext,
    sink: IntegrityIssueSink,
    qualifiedEndpointOnly = false,
  ): void {
    const schema4 = this.hasSchema4LifecycleSchema(context);
    const rows = this.connection.prepare(`
      SELECT * FROM workflow_instances
      WHERE project_id = $projectId
    `).all({ $projectId: context.binding.projectId });
    for (const row of rows) {
      if (!Object.prototype.hasOwnProperty.call(row, "evidence_window_state")) {
        try {
          this.assertLegacyWorkflowShape(context, row);
        } catch {
          issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
          return;
        }
        continue;
      }
      const evidenceColumns = [
        "evidence_frozen_checkpoint_event_position",
        "evidence_frozen_generation",
        "evidence_window_state",
        "final_ending_scope_bindings_json",
      ] as const;
      const plan = [
        row.validation_attempt_plan_generation,
        row.validation_attempt_plans_json,
      ];
      let planDecodes = true;
      try {
        if (schema4 && row.validation_attempt_plans_json !== null) {
          decodePersistedValidationPlansV1(
            parsedCanonicalJson(row.validation_attempt_plans_json),
          );
        }
      } catch {
        planDecodes = false;
      }
      if (
        (plan.some(present) && !plan.every(present))
        || (plan.every(present)
          && !sameInteger(row.validation_attempt_plan_generation, row.generation))
        || (present(row.validation_attempt_plans_json)
          && !canonicalJsonText(row.validation_attempt_plans_json))
        || !planDecodes
      ) {
        issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
        return;
      }
      if (row.session_id === null) {
        if (!allNull(row, evidenceColumns)) {
          issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
          return;
        }
        continue;
      }
      const claim = [row.coordinator_owner_id, row.coordinator_claim_token, row.coordinator_claim_expires_at];
      const failure = [row.coordinator_failure_class, row.coordinator_error_code];
      const frozen = [
        row.evidence_frozen_checkpoint_event_position,
        row.evidence_frozen_generation,
        row.final_ending_scope_bindings_json,
      ];
      const attemptCount = integer(row.coordinator_attempt_count);
      const claimToken = integer(row.coordinator_claim_token);
      const generation = integer(row.generation);
      const frozenGeneration = integer(row.evidence_frozen_generation);
      const finalPhases = new Set([
        "final-checkpoint-recorded",
        "ending-materialization-queued",
        "validating",
        "verification-passed",
        "verification-failed",
        "completion-appended",
        "completed-materialization-confirmed",
        "completed",
      ]);
      let resultStatus: Record<string, unknown> | null = null;
      try {
        if (row.result_json !== null) {
          const result = parsedCanonicalJson(row.result_json);
          if (!record(result)) throw new Error("INVALID_WORKFLOW_RESULT");
          resultStatus = record(result.status) ? result.status : result;
        }
      } catch {
        resultStatus = null;
      }
      const frozenPresent = frozen.every(present);
      const frozenAbsent = frozen.every((value) => !present(value));
      const statusKeys = resultStatus === null
        ? []
        : Object.keys(resultStatus).sort();
      const expectedStatusKeys = [
        "evidenceWindow",
        "finalCheckpointEventPosition",
        "finalCheckpointId",
        "materializationRequired",
        "phase",
        "priorRootState",
        "qualityScore",
        "resultVersion",
        "safeFailureCode",
        "sessionId",
        "triggeringEventPosition",
        "validationPlansReady",
        "workflowGeneration",
        "workflowId",
      ];
      const resultMatches = row.result_json === null
        ? true
        : resultStatus !== null
          && canonicalJson(statusKeys) === canonicalJson(expectedStatusKeys)
          && resultStatus.resultVersion === 2
          && resultStatus.sessionId === row.session_id
          && resultStatus.workflowId === row.workflow_id
          && sameInteger(resultStatus.workflowGeneration, row.generation)
          && resultStatus.phase === row.phase
          && (
            resultStatus.priorRootState === "active"
            || resultStatus.priorRootState === "suspended"
          )
          && resultStatus.triggeringEventPosition === decimal(row.triggering_event_position)
          && (
            (resultStatus.finalCheckpointId === null
              && resultStatus.finalCheckpointEventPosition === null)
            || (
              typeof resultStatus.finalCheckpointId === "string"
              && LOWER_UUID.test(resultStatus.finalCheckpointId)
              && positiveDecimalString(resultStatus.finalCheckpointEventPosition)
            )
          )
          && (
            frozenPresent
              ? resultStatus.finalCheckpointEventPosition
                === decimal(row.evidence_frozen_checkpoint_event_position)
              : resultStatus.finalCheckpointId === null
                && resultStatus.finalCheckpointEventPosition === null
          )
          && record(resultStatus.evidenceWindow)
          && Object.keys(resultStatus.evidenceWindow).length === 3
          && resultStatus.evidenceWindow.evidenceWindowState === row.evidence_window_state
          && resultStatus.evidenceWindow.evidenceFrozenCheckpointEventPosition
            === decimal(row.evidence_frozen_checkpoint_event_position)
          && (
            resultStatus.evidenceWindow.evidenceFrozenGeneration === null
              ? row.evidence_frozen_generation === null
              : sameInteger(
                  resultStatus.evidenceWindow.evidenceFrozenGeneration,
                  row.evidence_frozen_generation,
                )
          );
      let openHistoryValid = true;
      if (row.evidence_window_state === "open" && !qualifiedEndpointOnly) {
        try {
          this.assertOpenWorkflowProjection(context, row);
        } catch {
          openHistoryValid = false;
        }
      }
      let schema4EndpointValid = true;
      let effectiveMaterializationRequired: boolean | null = null;
      try {
        if (schema4) {
          if (!this.schema4LifetimeWithinCap(
            context.binding.projectId,
            row.session_id,
          )) throw new LifecycleError("INTEGRITY_FAILURE");
          effectiveMaterializationRequired = this.assertSchema4WorkflowEndpoint(
            context,
            row,
          );
        }
      } catch {
        schema4EndpointValid = false;
      }
      if (
        row.workflow_type !== "session-end"
        || !positive(row.triggering_event_position)
        || !nonEmpty(row.expected_authority_commitment)
        || attemptCount === null
        || attemptCount < 0
        || (claim.some(present) && !claim.every(present))
        || (claim.every(present) && (
          !nonEmpty(row.coordinator_owner_id)
          || claimToken === null
          || claimToken < 1
          || claimToken > attemptCount
          || !nonEmpty(row.coordinator_claim_expires_at)
        ))
        || (failure.some(present) && !failure.every(present))
        || (row.coordinator_failure_class === null && row.coordinator_next_attempt_at !== null)
        || (row.coordinator_failure_class === "retryable" && !nonEmpty(row.coordinator_next_attempt_at))
        || (row.coordinator_failure_class === "permanent" && row.coordinator_next_attempt_at !== null)
        || (row.coordinator_failure_class !== null
          && row.coordinator_failure_class !== "retryable"
          && row.coordinator_failure_class !== "permanent")
        || (present(row.validation_attempt_plan_generation)
          && !sameInteger(row.validation_attempt_plan_generation, row.generation))
        || (row.evidence_window_state !== "open" && row.evidence_window_state !== "sealed")
        || (!frozenPresent && !frozenAbsent)
        || (
          frozenPresent
          && (
            frozenGeneration === null
            || generation === null
            || frozenGeneration < 1
            || frozenGeneration > generation
            || row.evidence_window_state !== "sealed"
            || !canonicalJsonText(row.final_ending_scope_bindings_json)
          )
        )
        || (
          row.evidence_window_state === "open"
          && (
            !frozenAbsent
            || (row.phase !== "requested" && row.phase !== "children-resolved")
            || !openHistoryValid
          )
        )
        || (
          frozenPresent
          && !finalPhases.has(String(row.phase))
          && row.phase !== "abandoned"
        )
        || (finalPhases.has(String(row.phase)) && !frozenPresent)
        || (row.phase === "cancelled" && (
          row.evidence_window_state !== "sealed" || !frozenAbsent
        ))
        || !resultMatches
        || !schema4EndpointValid
        || (resultStatus !== null
          && effectiveMaterializationRequired !== null
          && resultStatus.materializationRequired !== effectiveMaterializationRequired)
      ) {
        issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
        return;
      }
    }
  }

  private hasSchema4LifecycleSchema(context: ProjectContext): boolean {
    const row = this.connection.prepare(`
      SELECT schema_version
      FROM project_meta
      WHERE singleton = 1 AND project_id = $projectId
    `).get({ $projectId: context.binding.projectId });
    return (integer(row?.schema_version) ?? 0) >= 4;
  }

  private schema4LifetimeWithinCap(
    projectId: string,
    rootSessionId: unknown,
  ): boolean {
    if (!nonEmpty(rootSessionId)) return false;
    const childCount = this.connection.prepare(`
      SELECT /* lifecycle-quick:lifetime-child */ count(*) AS bounded_count
      FROM (
        SELECT 1
        FROM session_authority INDEXED BY session_authority_parent_terminal
        WHERE project_id = $projectId
          AND parent_session_id = $rootSessionId
        LIMIT 1001
      )
    `).get({
      $projectId: projectId,
      $rootSessionId: rootSessionId as string,
    });
    const ticketCount = this.connection.prepare(`
      SELECT /* lifecycle-quick:lifetime-ticket */ count(*) AS bounded_count
      FROM (
        SELECT 1
        FROM child_transfer_tickets
          INDEXED BY child_transfer_tickets_source_child_v4
        WHERE project_id = $projectId
          AND source_parent_session_id = $rootSessionId
        LIMIT 1001
      )
    `).get({
      $projectId: projectId,
      $rootSessionId: rootSessionId as string,
    });
    const directChildren = integer(childCount?.bounded_count);
    const sourceTickets = integer(ticketCount?.bounded_count);
    return directChildren !== null
      && directChildren >= 0
      && directChildren <= 1_000
      && sourceTickets !== null
      && sourceTickets >= 0
      && sourceTickets <= 1_000;
  }

  private checkSchema4LifetimeFull(
    context: ProjectContext,
    sink: IntegrityIssueSink,
  ): void {
    if (!this.hasSchema4LifecycleSchema(context)) return;
    const overChildHistory = this.connection.prepare(`
      SELECT /* lifecycle-full:lifetime-child */ 1 AS invalid
      FROM session_authority
      WHERE project_id = $projectId AND session_kind = 'child'
      GROUP BY parent_session_id
      HAVING count(*) > 1000
      LIMIT 1
    `).get({ $projectId: context.binding.projectId });
    const overTicketHistory = this.connection.prepare(`
      SELECT /* lifecycle-full:lifetime-ticket */ 1 AS invalid
      FROM child_transfer_tickets
      WHERE project_id = $projectId
      GROUP BY source_parent_session_id
      HAVING count(*) > 1000
      LIMIT 1
    `).get({ $projectId: context.binding.projectId });
    if (overChildHistory !== undefined || overTicketHistory !== undefined) {
      issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
    }
  }

  private assertSchema4WorkflowEndpoint(
    context: ProjectContext,
    workflow: Readonly<SqliteRow>,
  ): boolean | null {
    const generation = integer(workflow.generation);
    if (
      generation === null
      || generation < 1
      || !nonEmpty(workflow.workflow_id)
      || !nonEmpty(workflow.session_id)
      || !nonEmpty(workflow.root_command_id)
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const projection = this.schema4WorkflowProjection(
      context.binding.projectId,
      workflow.workflow_id as string,
      generation,
    );
    const rootTrigger = this.connection.prepare(`
      SELECT /* lifecycle-quick:workflow-root-trigger */ event_schema_version
      FROM events
      WHERE project_id = $projectId
        AND command_id = $commandId
        AND command_event_index = 0
      LIMIT 2
    `).get({
      $projectId: context.binding.projectId,
      $commandId: workflow.root_command_id,
    });
    if (projection === null) throw new LifecycleError("INTEGRITY_FAILURE");
    if (
      projection.projectId !== context.binding.projectId
      || projection.workflowId !== workflow.workflow_id
      || projection.workflowGeneration !== generation
      || projection.sessionId !== workflow.session_id
      || projection.triggerEventPosition !== int64(workflow.triggering_event_position)
      || projection.rootCommandId !== workflow.root_command_id
      || projection.evidenceWindowState !== workflow.evidence_window_state
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const predecessor = generation === 1 ? null : this.schema4WorkflowProjection(
      context.binding.projectId,
      projection.workflowId,
      generation - 1,
    );
    if (projection.fingerprintSchemaVersion !== 2) {
      if (integer(rootTrigger?.event_schema_version) === 3) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      this.assertSchema4V1ProjectionEndpoint(context, projection, predecessor);
      return null;
    }
    const predecessorBase = generation <= 2 ? null : this.schema4WorkflowProjection(
      context.binding.projectId,
      projection.workflowId,
      generation - 2,
    );
    if (predecessor?.fingerprintSchemaVersion === 2) {
      this.assertSchema4ProjectionEndpoint(
        context,
        predecessor,
        predecessorBase,
      );
    } else if (predecessor !== null) {
      this.assertSchema4V1ProjectionEndpoint(
        context,
        predecessor,
        predecessorBase,
      );
    }
    return this.assertSchema4ProjectionEndpoint(context, projection, predecessor);
  }

  private assertSchema4V1ProjectionEndpoint(
    context: ProjectContext,
    projection: WorkflowGenerationFoldProjection,
    predecessor: WorkflowGenerationFoldProjection | null,
  ): void {
    const trigger = this.storedEventAt(projection.triggerEventPosition);
    const intent = this.commandIntentEventZero(context, trigger);
    let expected: WorkflowGenerationFoldProjection;
    try {
      let collapsed: WorkflowGenerationFoldProjection | null = null;
      if (
        projection.effectiveDraftSourceEventPosition
          < projection.triggerEventPosition
      ) {
        const source = this.storedEventAt(
          projection.effectiveDraftSourceEventPosition,
        );
        const classified = classifyWorkflowProjectionEvent(source);
        if (
          classified.kind === "identified"
          && classified.workflowId === projection.workflowId
          && classified.workflowGeneration === projection.workflowGeneration
        ) {
          collapsed = foldWorkflowGenerationProjection(
            predecessor,
            source,
            this.commandIntentEventZero(context, source),
            "live-schema-3",
          );
        }
      }
      expected = foldWorkflowGenerationProjection(
        collapsed ?? predecessor,
        trigger,
        intent,
        collapsed === null ? "live-schema-3" : "schema-2-preflight",
      );
    } catch {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (
      projection.fingerprintSchemaVersion !== 1
      || projection.projectId !== context.binding.projectId
      || (projection.workflowGeneration === 1) !== (predecessor === null)
      || (predecessor !== null && (
        predecessor.workflowGeneration !== projection.workflowGeneration - 1
        || predecessor.fingerprint !== projection.previousFingerprint
        || predecessor.triggerEventPosition >= projection.triggerEventPosition
      ))
      || trigger.eventSchemaVersion === 3
      || !this.sameWorkflowProjection(projection, expected)
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    this.assertEffectiveWorkflowSource(context, projection);
  }

  private assertSchema4ProjectionEndpoint(
    context: ProjectContext,
    projection: WorkflowGenerationFoldProjection,
    predecessor: WorkflowGenerationFoldProjection | null,
  ): boolean | null {
    const trigger = this.storedEventAt(projection.triggerEventPosition);
    const intent = this.commandIntentEventZero(context, trigger);
    let expected: WorkflowGenerationFoldProjection;
    try {
      expected = foldWorkflowGenerationProjection(
        predecessor,
        trigger,
        intent,
        "live-schema-3",
      );
    } catch {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (
      projection.projectId !== context.binding.projectId
      || (projection.workflowGeneration === 1) !== (predecessor === null)
      || (predecessor !== null && (
        predecessor.workflowGeneration !== projection.workflowGeneration - 1
        || predecessor.fingerprint !== projection.previousFingerprint
        || predecessor.triggerEventPosition >= projection.triggerEventPosition
      ))
      || trigger.eventSchemaVersion !== 3
      || !this.sameWorkflowProjection(projection, expected)
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    this.assertSchema4ProjectionFingerprint(projection, predecessor);
    if (projection.effectiveStateSourceEventPosition === null) {
      this.assertEffectiveWorkflowSource(context, projection);
      return null;
    }
    const hydrated = hydrateSessionEndEffectiveStateV1(this.connection, {
      projectId: context.binding.projectId,
      workflowId: projection.workflowId,
      workflowGeneration: projection.workflowGeneration,
      sessionId: projection.sessionId,
      eventPosition: projection.effectiveStateSourceEventPosition!,
    });
    return hydrated.effectiveState.effectivePolicy.requireMaterialization;
  }

  private assertSchema4ProjectionFingerprint(
    projection: WorkflowGenerationFoldProjection,
    predecessor: WorkflowGenerationFoldProjection | null,
  ): void {
    const trigger = this.storedEventAt(projection.triggerEventPosition);
    if (
      projection.fingerprintSchemaVersion !== 2
      || (projection.workflowGeneration === 1) !== (predecessor === null)
      || (predecessor !== null
        && projection.previousFingerprint !== predecessor.fingerprint)
      || workflowFingerprintV2({
        ...projection,
        triggerEventHash: trigger.eventHash,
        previousFingerprintSchemaVersion:
          predecessor?.fingerprintSchemaVersion ?? null,
      }) !== projection.fingerprint
    ) throw new LifecycleError("INTEGRITY_FAILURE");
  }

  private schema4WorkflowProjection(
    projectId: string,
    workflowId: string,
    workflowGeneration: number,
  ): WorkflowGenerationFoldProjection | null {
    if (!Number.isSafeInteger(workflowGeneration) || workflowGeneration < 1) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const rows = this.connection.prepare(`
      SELECT /* lifecycle-quick:workflow-endpoint */
             project_id, workflow_id, workflow_generation, session_id,
             trigger_event_position, root_command_id, evidence_window_state,
             replacement_checkpoint_version, effective_checkpoint_version,
             effective_draft_source_event_position, fingerprint_schema_version,
             effective_state_source_event_position, effective_state_version,
             effective_state_hash, previous_fingerprint, fingerprint
      FROM lifecycle_workflow_generation_folds
      WHERE project_id = $projectId
        AND workflow_id = $workflowId
        AND workflow_generation = $workflowGeneration
      LIMIT 2
    `).all({
      $projectId: projectId,
      $workflowId: workflowId,
      $workflowGeneration: workflowGeneration,
    });
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new LifecycleError("INTEGRITY_FAILURE");
    const row = rows[0]!;
    const generation = integer(row.workflow_generation);
    const triggerEventPosition = int64(row.trigger_event_position);
    const replacementCheckpointVersion = row.replacement_checkpoint_version === null
      ? null
      : integer(row.replacement_checkpoint_version);
    const effectiveCheckpointVersion = integer(row.effective_checkpoint_version);
    const effectiveDraftSourceEventPosition = int64(
      row.effective_draft_source_event_position,
    );
    const fingerprintSchemaVersion = integer(row.fingerprint_schema_version);
    const effectiveStateSourceEventPosition = row.effective_state_source_event_position === null
      ? null
      : int64(row.effective_state_source_event_position);
    const effectiveStateVersion = row.effective_state_version === null
      ? null
      : integer(row.effective_state_version);
    const previousFingerprint = row.previous_fingerprint;
    const effectiveStateTupleAbsent = effectiveStateSourceEventPosition === null
      && effectiveStateVersion === null
      && row.effective_state_hash === null;
    const effectiveStateTuplePresent = effectiveStateSourceEventPosition !== null
      && triggerEventPosition !== null
      && effectiveStateSourceEventPosition <= triggerEventPosition
      && effectiveStateVersion === 1
      && typeof row.effective_state_hash === "string"
      && LOWER_HASH.test(row.effective_state_hash);
    if (
      generation === null
      || generation !== workflowGeneration
      || triggerEventPosition === null
      || !nonEmpty(row.project_id)
      || row.project_id !== projectId
      || !nonEmpty(row.workflow_id)
      || row.workflow_id !== workflowId
      || !nonEmpty(row.session_id)
      || !nonEmpty(row.root_command_id)
      || (row.evidence_window_state !== "open" && row.evidence_window_state !== "sealed")
      || (replacementCheckpointVersion !== null
        && replacementCheckpointVersion !== 1
        && replacementCheckpointVersion !== 2)
      || (effectiveCheckpointVersion !== 1 && effectiveCheckpointVersion !== 2)
      || effectiveDraftSourceEventPosition === null
      || effectiveDraftSourceEventPosition > triggerEventPosition
      || (fingerprintSchemaVersion !== 1 && fingerprintSchemaVersion !== 2)
      || (generation === 1) !== (previousFingerprint === null)
      || (previousFingerprint !== null
        && (typeof previousFingerprint !== "string" || !LOWER_HASH.test(previousFingerprint)))
      || typeof row.fingerprint !== "string"
      || !LOWER_HASH.test(row.fingerprint)
      || (fingerprintSchemaVersion === 1 && (
        effectiveStateSourceEventPosition !== null
        || effectiveStateVersion !== null
        || row.effective_state_hash !== null
      ))
      || (fingerprintSchemaVersion === 2
        && !effectiveStateTupleAbsent
        && !effectiveStateTuplePresent)
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const projection: WorkflowGenerationFoldProjection = Object.freeze({
      projectId,
      workflowId,
      workflowGeneration: generation,
      sessionId: row.session_id as string,
      triggerEventPosition,
      rootCommandId: row.root_command_id as string,
      evidenceWindowState: row.evidence_window_state as "open" | "sealed",
      replacementCheckpointVersion: replacementCheckpointVersion as 1 | 2 | null,
      effectiveCheckpointVersion: effectiveCheckpointVersion as 1 | 2,
      effectiveDraftSourceEventPosition,
      fingerprintSchemaVersion: fingerprintSchemaVersion as 1 | 2,
      effectiveStateSourceEventPosition,
      effectiveStateVersion: effectiveStateVersion as 1 | null,
      effectiveStateHash: row.effective_state_hash as string | null,
      previousFingerprint: previousFingerprint as string | null,
      fingerprint: row.fingerprint,
    });
    if (projection.fingerprintSchemaVersion === 1) {
      const { fingerprint, ...withoutFingerprint } = projection;
      if (workflowGenerationFingerprint(withoutFingerprint) !== fingerprint) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    }
    return projection;
  }

  private assertLegacyWorkflowShape(
    context: ProjectContext,
    row: Readonly<SqliteRow>,
  ): void {
    if (row.session_id === null) return;
    const generation = integer(row.generation);
    const triggerPosition = int64(row.triggering_event_position);
    const attemptCount = integer(row.coordinator_attempt_count);
    const claimToken = integer(row.coordinator_claim_token);
    const claim = [
      row.coordinator_owner_id,
      row.coordinator_claim_token,
      row.coordinator_claim_expires_at,
    ];
    const failure = [row.coordinator_failure_class, row.coordinator_error_code];
    const plan = [
      row.validation_attempt_plan_generation,
      row.validation_attempt_plans_json,
    ];
    if (
      row.workflow_type !== "session-end"
      || !nonEmpty(row.workflow_id)
      || !nonEmpty(row.session_id)
      || generation === null
      || generation < 1
      || triggerPosition === null
      || !nonEmpty(row.root_command_id)
      || !nonEmpty(row.expected_authority_commitment)
      || attemptCount === null
      || attemptCount < 0
      || (claim.some(present) && !claim.every(present))
      || (claim.every(present) && (
        !nonEmpty(row.coordinator_owner_id)
        || claimToken === null
        || claimToken < 1
        || claimToken > attemptCount
        || !nonEmpty(row.coordinator_claim_expires_at)
      ))
      || (failure.some(present) && !failure.every(present))
      || (row.coordinator_failure_class === null
        && row.coordinator_next_attempt_at !== null)
      || (row.coordinator_failure_class === "retryable"
        && !nonEmpty(row.coordinator_next_attempt_at))
      || (row.coordinator_failure_class === "permanent"
        && row.coordinator_next_attempt_at !== null)
      || (row.coordinator_failure_class !== null
        && row.coordinator_failure_class !== "retryable"
        && row.coordinator_failure_class !== "permanent")
      || (plan.some(present) && !plan.every(present))
      || (present(row.validation_attempt_plans_json)
        && !canonicalJsonText(row.validation_attempt_plans_json))
      || (present(row.validation_attempt_plan_generation)
        && !sameInteger(row.validation_attempt_plan_generation, row.generation))
      || (row.result_json !== null && !canonicalJsonText(row.result_json))
    ) throw new LifecycleError("INTEGRITY_FAILURE");

    const trigger = this.storedEventAt(triggerPosition);
    if (
      trigger.projectId !== context.binding.projectId
      || trigger.streamId !== `session/${String(row.session_id)}`
      || trigger.streamType !== "session"
      || trigger.sessionId !== row.session_id
      || trigger.parentSessionId !== null
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const positions = this.connection.prepare(`
      SELECT global_position /* legacy-workflow-projection */
      FROM events
      WHERE project_id = $projectId
        AND stream_id = $streamId
        AND stream_version <= $maxStreamVersion
      ORDER BY stream_version
    `).all({
      $projectId: context.binding.projectId,
      $streamId: trigger.streamId,
      $maxStreamVersion: trigger.streamVersion,
    });
    let projection: WorkflowGenerationFoldProjection | null = null;
    for (const positionRow of positions) {
      const position = int64(positionRow.global_position);
      if (position === null) throw new LifecycleError("INTEGRITY_FAILURE");
      const event = this.storedEventAt(position);
      const classified = classifyWorkflowProjectionEvent(event);
      if (
        classified.kind !== "identified"
        || classified.workflowId !== row.workflow_id
      ) continue;
      const witness = this.commandIntentEventZero(context, event);
      projection = foldWorkflowGenerationProjection(
        projection,
        event,
        witness,
        "schema-2-preflight",
      );
    }
    if (
      projection === null
      || projection.projectId !== context.binding.projectId
      || projection.workflowId !== row.workflow_id
      || projection.workflowGeneration !== generation
      || projection.sessionId !== row.session_id
      || projection.triggerEventPosition !== triggerPosition
      || projection.rootCommandId !== row.root_command_id
      || this.authorityCommitmentAt(
        context.binding.projectId,
        trigger.streamId,
        triggerPosition,
      ) !== row.expected_authority_commitment
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    this.assertEffectiveWorkflowSource(context, projection);
  }

  private assertOpenWorkflowProjection(
    context: ProjectContext,
    workflow: SqliteRow,
  ): void {
    const generation = integer(workflow.generation);
    if (
      generation === null
      || generation < 1
      || typeof workflow.workflow_id !== "string"
      || typeof workflow.session_id !== "string"
      || typeof workflow.root_command_id !== "string"
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const repository = new SqliteLifecycleProjectionRepository(this.connection);
    const target = repository.findWorkflowGeneration(
      context.binding.projectId,
      workflow.workflow_id,
      generation,
    );
    if (target === null) throw new LifecycleError("INTEGRITY_FAILURE");
    const predecessor = repository.findWorkflowPredecessor(
      context.binding.projectId,
      workflow.workflow_id,
      generation,
    );
    if (
      (generation === 1) !== (predecessor === null)
      || (predecessor !== null && (
        predecessor.workflowGeneration !== generation - 1
        || predecessor.fingerprint !== target.previousFingerprint
        || predecessor.triggerEventPosition >= target.triggerEventPosition
      ))
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const trigger = this.storedEventAt(target.triggerEventPosition);
    if (
      trigger.streamId !== `session/${target.sessionId}`
      || trigger.streamType !== "session"
      || trigger.sessionId !== target.sessionId
      || trigger.parentSessionId !== null
      || trigger.commandEventIndex !== 0
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const intent = this.commandIntentEventZero(context, trigger);
    const expected = foldWorkflowGenerationProjection(
      predecessor,
      trigger,
      intent,
      "live-schema-3",
    );
    if (
      !this.sameWorkflowProjection(target, expected)
      || target.projectId !== context.binding.projectId
      || target.workflowId !== workflow.workflow_id
      || target.workflowGeneration !== generation
      || target.sessionId !== workflow.session_id
      || target.triggerEventPosition !== int64(workflow.triggering_event_position)
      || target.rootCommandId !== workflow.root_command_id
      || target.evidenceWindowState !== "open"
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    this.assertEffectiveWorkflowSource(context, target);
  }

  private commandIntentEventZero(
    context: ProjectContext,
    event: StoredEvent,
  ): ReturnType<typeof decodeLifecycleIntentWitness> {
    const rows = this.connection.prepare(`
      SELECT global_position, lifecycle_intent_json
      FROM events
      WHERE project_id = $projectId
        AND command_id = $commandId
        AND command_event_index = 0
      LIMIT 2
    `).all({
      $projectId: context.binding.projectId,
      $commandId: event.commandId,
    });
    if (
      rows.length !== 1
      || int64(rows[0]!.global_position) !== event.globalPosition
      || typeof rows[0]!.lifecycle_intent_json !== "string"
    ) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    try {
      const witness = decodeLifecycleIntentWitness(rows[0]!.lifecycle_intent_json);
      this.assertWorkflowIntentEventContext(context, event, witness);
      return witness;
    } catch {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  private assertWorkflowIntentEventContext(
    context: ProjectContext,
    event: StoredEvent,
    witness: ReturnType<typeof decodeLifecycleIntentWitness>,
  ): void {
    const command = witness.intent.command;
    const binding = witness.intent.binding;
    const authorization = witness.intent.authorization;
    if (
      !record(command)
      || !this.eventMatchesContext(context, event)
      || command.commandId !== event.commandId
      || command.idempotencyKey !== event.idempotencyKey
      || command.agentId !== event.agentId
      || command.expectedProjectId !== event.projectId
      || command.expectedVaultId !== event.vaultId
      || command.expectedWorkspaceId !== event.workspaceId
      || command.expectedBranchRef !== event.branchRef
      || binding.projectId !== context.binding.projectId
      || binding.vaultId !== context.binding.vaultId
      || binding.storeId !== context.binding.storeId
      || binding.workspaceId !== context.binding.workspaceId
      || binding.clientNamespace !== context.binding.clientNamespace
      || authorization.presentingActorRole !== event.actorRole
      || authorization.presentingClientInstanceId !== event.clientInstanceId
    ) throw new LifecycleError("INTEGRITY_FAILURE");
  }

  private assertEffectiveWorkflowSource(
    context: ProjectContext,
    target: WorkflowGenerationFoldProjection,
  ): void {
    if (target.effectiveDraftSourceEventPosition > target.triggerEventPosition) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const source = this.storedEventAt(target.effectiveDraftSourceEventPosition);
    const event = this.decodeStoredLifecycleEvent(source, "0".repeat(64));
    if (
      source.streamId !== `session/${target.sessionId}`
      || source.streamType !== "session"
      || source.sessionId !== target.sessionId
      || source.parentSessionId !== null
      || source.commandEventIndex !== 0
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const witness = this.commandIntentEventZero(context, source);
    const command = witness.intent.command;
    if (
      !record(command)
      || event.sessionId !== target.sessionId
      || event.parentSessionId !== null
      || witness.intent.authorization.authorizationSessionId !== target.sessionId
      || witness.intent.authorization.targetSessionId !== target.sessionId
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    let sourceVersion: 1 | 2;
    if (event.eventType === "SessionEndRequested") {
      const request = record(command.request) ? command.request : null;
      const draft = request !== null && record(request.finalCheckpoint)
        ? request.finalCheckpoint
        : null;
      if (event.eventSchemaVersion === 3) {
        if (
          command.commandType !== "request-session-end"
          || request === null
          || draft === null
          || request.sessionId !== target.sessionId
          || event.payload.workflowId !== target.workflowId
          || event.payload.workflowGeneration > target.workflowGeneration
          || canonicalJson(request) !== canonicalJson(event.payload.effectiveState.request)
          || canonicalJson(draft)
            !== canonicalJson(event.payload.effectiveState.effectiveFinalCheckpoint)
          || (draft.checkpointVersion !== 1 && draft.checkpointVersion !== 2)
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        sourceVersion = draft.checkpointVersion;
      } else {
        if (
          command.commandType !== "request-session-end"
          || request === null
          || draft === null
          || request.sessionId !== target.sessionId
          || event.payload.workflowId !== target.workflowId
          || event.payload.workflowGeneration > target.workflowGeneration
          || request.childEndPolicy !== event.payload.childEndPolicy
          || request.requestedQualityThreshold !== event.payload.qualityThreshold
          || request.requireFullEvidence !== event.payload.requireFullEvidence
          || request.requireMaterialization !== event.payload.requireMaterialization
          || (
            event.eventSchemaVersion === 1
              ? request.requestVersion !== 1
              : request.requestVersion !== 2
          )
          || (draft.checkpointVersion !== 1 && draft.checkpointVersion !== 2)
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        sourceVersion = draft.checkpointVersion;
      }
    } else if (event.eventType === "SessionEndAmended") {
      const amendment = record(command.amendment) ? command.amendment : null;
      const draft = amendment !== null && record(amendment.finalCheckpoint)
        ? amendment.finalCheckpoint
        : null;
      if (event.eventSchemaVersion === 3) {
        if (
          command.commandType !== "amend-session-end"
          || amendment === null
          || draft === null
          || command.sessionId !== target.sessionId
          || command.workflowId !== target.workflowId
          || event.payload.workflowId !== target.workflowId
          || event.payload.workflowGeneration > target.workflowGeneration
          || event.payload.previousWorkflowGeneration
            !== event.payload.workflowGeneration - 1
          || amendment.evidenceWindowAction !== event.payload.evidenceWindowAction
          || canonicalJson(draft)
            !== canonicalJson(event.payload.effectiveState.effectiveFinalCheckpoint)
          || (draft.checkpointVersion !== 1 && draft.checkpointVersion !== 2)
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        sourceVersion = draft.checkpointVersion;
      } else {
        if (
          command.commandType !== "amend-session-end"
          || amendment === null
          || draft === null
          || command.sessionId !== target.sessionId
          || command.workflowId !== target.workflowId
          || event.payload.workflowId !== target.workflowId
          || event.payload.workflowGeneration > target.workflowGeneration
          || event.payload.previousWorkflowGeneration
            !== event.payload.workflowGeneration - 1
          || (
            event.eventSchemaVersion === 1
              ? amendment.amendmentVersion !== 1
              : (
                amendment.amendmentVersion !== 2
                || amendment.evidenceWindowAction !== event.payload.evidenceWindowAction
                || event.payload.finalCheckpointVersion !== draft.checkpointVersion
              )
          )
          || (draft.checkpointVersion !== 1 && draft.checkpointVersion !== 2)
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        sourceVersion = draft.checkpointVersion;
      }
    } else {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (sourceVersion !== target.effectiveCheckpointVersion) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
  }

  private sameWorkflowProjection(
    left: WorkflowGenerationFoldProjection,
    right: WorkflowGenerationFoldProjection,
  ): boolean {
    return left.projectId === right.projectId
      && left.workflowId === right.workflowId
      && left.workflowGeneration === right.workflowGeneration
      && left.sessionId === right.sessionId
      && left.triggerEventPosition === right.triggerEventPosition
      && left.rootCommandId === right.rootCommandId
      && left.evidenceWindowState === right.evidenceWindowState
      && left.replacementCheckpointVersion === right.replacementCheckpointVersion
      && left.effectiveCheckpointVersion === right.effectiveCheckpointVersion
      && left.effectiveDraftSourceEventPosition
        === right.effectiveDraftSourceEventPosition
      && left.fingerprintSchemaVersion === right.fingerprintSchemaVersion
      && left.effectiveStateSourceEventPosition
        === right.effectiveStateSourceEventPosition
      && left.effectiveStateVersion === right.effectiveStateVersion
      && left.effectiveStateHash === right.effectiveStateHash
      && left.previousFingerprint === right.previousFingerprint
      && left.fingerprint === right.fingerprint;
  }

  private checkEvidence(context: ProjectContext, sink: IntegrityIssueSink): void {
    const coverage = this.connection.prepare(`
      SELECT coverage.*, event.event_type AS latest_event_type,
             event.session_id AS latest_event_session_id,
             event.payload_json AS latest_event_payload_json
      FROM session_evidence_coverage AS coverage
      LEFT JOIN events AS event
        ON event.global_position = coverage.latest_batch_event_position
      WHERE coverage.project_id = $projectId
    `).all({ $projectId: context.binding.projectId });
    for (const row of coverage) {
      const first = integer(row.first_ordinal);
      const last = integer(row.last_ordinal);
      const highest = integer(row.highest_contiguous_ordinal);
      const fingerprints = this.connection.prepare(`
        SELECT ordinal, batch_id, recorded_event_position,
               fingerprint_algorithm, fingerprint_schema_version,
               fingerprint_key_id, fingerprint_domain
        FROM session_evidence_fingerprints
        WHERE project_id = $projectId
          AND session_id = $sessionId
          AND adapter_session_id = $adapterSessionId
        ORDER BY ordinal
      `).all({
        $projectId: row.project_id,
        $sessionId: row.session_id,
        $adapterSessionId: row.adapter_session_id,
      });
      let storedIntervals: unknown;
      let latestPayload: unknown;
      try {
        storedIntervals = parsedCanonicalJson(row.missing_intervals_json);
        latestPayload = parsedCanonicalJson(row.latest_event_payload_json);
      } catch {
        storedIntervals = null;
        latestPayload = null;
      }
      if (first === null || last === null || highest === null || first < 0 || last < first) {
        issue(sink, "SESSION_EVIDENCE_COVERAGE_MISMATCH");
        return;
      }
      const ordinals = new Set<number>();
      let fingerprintRowsValid = true;
      for (const fingerprint of fingerprints) {
        const ordinal = integer(fingerprint.ordinal);
        if (
          ordinal === null
          || ordinal < first
          || ordinal > last
          || ordinals.has(ordinal)
          || fingerprint.fingerprint_algorithm !== row.fingerprint_algorithm
          || !sameInteger(fingerprint.fingerprint_schema_version, row.fingerprint_schema_version)
          || fingerprint.fingerprint_key_id !== row.fingerprint_key_id
          || fingerprint.fingerprint_domain !== row.fingerprint_domain
        ) {
          fingerprintRowsValid = false;
          break;
        }
        ordinals.add(ordinal);
      }
      const expectedIntervals: number[][] = [];
      let missingStart: number | null = null;
      let expectedHighest = first - 1;
      let contiguous = true;
      for (let ordinal = first; ordinal <= last; ordinal += 1) {
        if (ordinals.has(ordinal)) {
          if (missingStart !== null) {
            expectedIntervals.push([missingStart, ordinal - 1]);
            missingStart = null;
          }
          if (contiguous) expectedHighest = ordinal;
        } else {
          if (missingStart === null) missingStart = ordinal;
          contiguous = false;
        }
      }
      if (missingStart !== null) expectedIntervals.push([missingStart, last]);
      const latestBatchRows = fingerprints.filter((fingerprint) => (
        fingerprint.batch_id === row.latest_batch_id
        && sameInteger(fingerprint.recorded_event_position, row.latest_batch_event_position)
      ));
      if (
        !fingerprintRowsValid
        || !Array.isArray(storedIntervals)
        || canonicalJson(storedIntervals as never) !== canonicalJson(expectedIntervals as never)
        || highest !== expectedHighest
        || row.latest_event_type !== "EvidenceCoverageRecorded"
        || row.latest_event_session_id !== row.session_id
        || !record(latestPayload)
        || latestPayload.adapterSessionId !== row.adapter_session_id
        || latestPayload.batchId !== row.latest_batch_id
        || latestBatchRows.length === 0
      ) {
        issue(sink, "SESSION_EVIDENCE_COVERAGE_MISMATCH");
        return;
      }
    }
  }

  private checkApprovalsAndTransfers(
    context: ProjectContext,
    sink: IntegrityIssueSink,
    historyAlreadyReplayed = false,
  ): void {
    const approvals = this.connection.prepare(`
      SELECT approval.*, command.authorization_approval_id,
             command.authorization_approval_digest,
             command.command_type, command.target_actor_role AS command_target_actor_role,
             command.target_client_instance_id AS command_target_client_instance_id,
             event.command_id AS event_command_id,
             event.session_id AS event_session_id, event.event_type AS event_type,
             event.payload_json AS event_payload_json
      FROM lifecycle_approval_consumptions AS approval
      LEFT JOIN command_dedup AS command
        ON command.project_id = approval.project_id AND command.command_id = approval.command_id
      LEFT JOIN events AS event ON event.global_position = approval.consumed_event_position
      WHERE approval.project_id = $projectId
    `).all({ $projectId: context.binding.projectId });
    if (approvals.some((row) => {
      let payload: unknown;
      try { payload = parsedCanonicalJson(row.event_payload_json); } catch { payload = null; }
      const expectedEventType = row.action === "recover-root-authority"
        ? "SessionOwnershipRecovered"
        : row.action === "abandon-root" ? "SessionAbandoned" : null;
      const expectedCommandType = row.action === "recover-root-authority"
        ? "root-recovery"
        : row.action === "abandon-root" ? "abandon-session" : null;
      return row.authorization_approval_id !== row.approval_id
        || !nonEmpty(row.authorization_approval_digest)
        || row.command_type !== expectedCommandType
        || row.command_target_actor_role !== row.target_actor_role
        || row.command_target_client_instance_id !== row.target_client_instance_id
        || row.event_command_id !== row.command_id
        || row.event_session_id !== row.session_id
        || row.event_type !== expectedEventType
        || !record(payload)
        || payload.approvalId !== row.approval_id;
    })) {
      issue(sink, "LIFECYCLE_APPROVAL_CONSUMPTION_MISMATCH");
    }
    const transfers = this.connection.prepare(`
      SELECT ticket.*,
             created.project_id AS created_event_project_id,
             created.event_type AS created_event_type,
             created.event_schema_version AS created_event_schema_version,
             created.session_id AS created_event_session_id,
             created.parent_session_id AS created_event_parent_session_id,
             created.occurred_at AS created_event_occurred_at,
             created.payload_json AS created_event_payload_json,
             claimed.project_id AS claimed_event_project_id,
             claimed.event_type AS claimed_event_type,
             claimed.session_id AS claimed_event_session_id,
             claimed.parent_session_id AS claimed_event_parent_session_id,
             claimed.occurred_at AS claimed_event_occurred_at,
             claimed.payload_json AS claimed_event_payload_json
      FROM child_transfer_tickets AS ticket
      LEFT JOIN events AS created ON created.global_position = ticket.created_event_position
      LEFT JOIN events AS claimed ON claimed.global_position = ticket.claimed_event_position
      WHERE ticket.project_id = $projectId
    `).all({ $projectId: context.binding.projectId });
    if (transfers.some((row) => {
      const claimed = [
        row.claimed_by_root_session_id,
        row.claimed_child_session_id,
        row.claimed_event_position,
        row.claimed_at,
      ];
      let createdPayload: unknown;
      let claimedPayload: unknown;
      const createdEventSchemaVersion = integer(row.created_event_schema_version);
      try { createdPayload = parsedCanonicalJson(row.created_event_payload_json); } catch { createdPayload = null; }
      try {
        claimedPayload = present(row.claimed_event_position)
          ? parsedCanonicalJson(row.claimed_event_payload_json)
          : null;
      } catch { claimedPayload = null; }
      return (claimed.some(present) && !claimed.every(present))
        || row.created_event_project_id !== row.project_id
        || row.created_event_type !== "ChildWorkTransferCreated"
        || (createdEventSchemaVersion !== 1 && createdEventSchemaVersion !== 2)
        || row.created_event_session_id !== row.source_child_session_id
        || row.created_event_parent_session_id !== row.source_parent_session_id
        || row.created_event_occurred_at !== row.created_at
        || !record(createdPayload)
        || createdPayload.transferTicketId !== row.transfer_ticket_id
        || createdPayload.checkpointId !== row.checkpoint_id
        || (claimed.every(present) && (
          row.claimed_event_project_id !== row.project_id
          || row.claimed_event_type !== "ChildWorkTransferClaimed"
          || row.claimed_event_session_id !== row.claimed_child_session_id
          || row.claimed_event_parent_session_id !== row.claimed_by_root_session_id
          || row.claimed_event_occurred_at !== row.claimed_at
          || !record(claimedPayload)
          || claimedPayload.transferTicketId !== row.transfer_ticket_id
          || claimedPayload.previousChildSessionId !== row.source_child_session_id
          || claimedPayload.previousTransferEventPosition !== decimal(row.created_event_position)
        ))
        || !canonicalJsonText(row.source_assignment_json)
        || !canonicalJsonText(row.source_scope_json)
        || !canonicalJsonText(row.follow_ups_json)
        || !canonicalJsonText(row.source_state_json)
        || !canonicalJsonText(row.lineage_json)
        || (
          !historyAlreadyReplayed
          && createdEventSchemaVersion === 1
          && !this.transferMatchesSourceTruth(row)
        );
    })) {
      issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
    }
    if (historyAlreadyReplayed) return;
    const createdEvents = this.connection.prepare(`
      SELECT created.global_position, created.session_id, created.parent_session_id,
             created.payload_json,
             ticket.transfer_ticket_id, ticket.source_child_session_id,
             ticket.source_parent_session_id, ticket.checkpoint_id,
             (SELECT COUNT(*) FROM child_transfer_tickets AS candidate
              WHERE candidate.project_id = created.project_id
                AND candidate.created_event_position = created.global_position) AS ticket_count
      FROM events AS created
      LEFT JOIN child_transfer_tickets AS ticket
        ON ticket.project_id = created.project_id
       AND ticket.created_event_position = created.global_position
      WHERE created.project_id = $projectId
        AND created.event_type = 'ChildWorkTransferCreated'
    `).all({ $projectId: context.binding.projectId });
    if (createdEvents.some((row) => {
      let payload: unknown;
      try { payload = parsedCanonicalJson(row.payload_json); } catch { payload = null; }
      return !sameInteger(row.ticket_count, 1)
        || !record(payload)
        || payload.transferTicketId !== row.transfer_ticket_id
        || payload.checkpointId !== row.checkpoint_id
        || row.session_id !== row.source_child_session_id
        || row.parent_session_id !== row.source_parent_session_id;
    })) {
      issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
    }
    const claimedEvents = this.connection.prepare(`
      SELECT claimed.global_position, claimed.session_id, claimed.parent_session_id,
             claimed.payload_json,
             ticket.transfer_ticket_id, ticket.source_child_session_id,
             ticket.claimed_child_session_id, ticket.claimed_by_root_session_id,
             ticket.created_event_position,
             (SELECT COUNT(*) FROM child_transfer_tickets AS candidate
              WHERE candidate.project_id = claimed.project_id
                AND candidate.claimed_event_position = claimed.global_position) AS ticket_count
      FROM events AS claimed
      LEFT JOIN child_transfer_tickets AS ticket
        ON ticket.project_id = claimed.project_id
       AND ticket.claimed_event_position = claimed.global_position
      WHERE claimed.project_id = $projectId
        AND claimed.event_type = 'ChildWorkTransferClaimed'
    `).all({ $projectId: context.binding.projectId });
    if (claimedEvents.some((row) => {
      let payload: unknown;
      try { payload = parsedCanonicalJson(row.payload_json); } catch { payload = null; }
      return !sameInteger(row.ticket_count, 1)
        || !record(payload)
        || payload.transferTicketId !== row.transfer_ticket_id
        || payload.previousChildSessionId !== row.source_child_session_id
        || payload.previousTransferEventPosition !== decimal(row.created_event_position)
        || row.session_id !== row.claimed_child_session_id
        || row.parent_session_id !== row.claimed_by_root_session_id;
    })) {
      issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
    }
  }

  private transferMatchesSourceTruth(ticket: SqliteRow): boolean {
    try {
      if (!nonEmpty(ticket.project_id)
        || !nonEmpty(ticket.source_child_session_id)
        || !nonEmpty(ticket.source_parent_session_id)
        || !nonEmpty(ticket.transfer_ticket_id)
        || !nonEmpty(ticket.checkpoint_id)) return false;
      const createdEventPosition = decimal(ticket.created_event_position);
      if (createdEventPosition === null) return false;
      const source = this.connection.prepare(`
        SELECT *
        FROM session_authority
        WHERE project_id = $projectId AND session_id = $sessionId
      `).get({
        $projectId: ticket.project_id as string,
        $sessionId: ticket.source_child_session_id as string,
      });
      if (source === undefined
        || source.session_kind !== "child"
        || source.parent_session_id !== ticket.source_parent_session_id
        || source.semantic_state !== "transferred"
        || decimal(source.terminal_event_position) !== createdEventPosition) return false;
      const events = this.lifecycleEvents(source);
      const aggregate = foldSession(events);
      if (aggregate.kind !== "child"
        || aggregate.state !== "transferred"
        || aggregate.parentSessionId !== ticket.source_parent_session_id
        || aggregate.sessionId !== ticket.source_child_session_id
        || aggregate.terminalEventPosition?.toString() !== createdEventPosition
        || aggregate.latestCheckpointId !== ticket.checkpoint_id
        || aggregate.suspensionCheckpointId !== ticket.checkpoint_id) return false;
      const transferIndex = events.findIndex((event) => (
        event.eventType === "ChildWorkTransferCreated"
        && event.globalPosition === createdEventPosition
        && event.payload.transferTicketId === ticket.transfer_ticket_id
      ));
      const transferEvent = events[transferIndex];
      const suspensionEvent = events[transferIndex - 1];
      const checkpointEvent = [...events].reverse().find((event) => (
        event.eventType === "SessionCheckpointRecorded"
      ));
      if (transferEvent === undefined || transferEvent.eventType !== "ChildWorkTransferCreated"
        || suspensionEvent === undefined || suspensionEvent.eventType !== "ChildSessionSuspended"
        || checkpointEvent === undefined || checkpointEvent.eventType !== "SessionCheckpointRecorded"
        || transferEvent.payload.checkpointId !== ticket.checkpoint_id
        || suspensionEvent.payload.checkpointId !== ticket.checkpoint_id
        || checkpointEvent.payload.checkpoint.checkpointId !== ticket.checkpoint_id
        || transferEvent.occurredAt !== ticket.created_at) return false;
      const expectedAssignment = canonicalJson({
        assignmentId: aggregate.assignment.assignmentId,
        summary: aggregate.assignment.summary,
        scope: aggregate.assignment.scope,
        assignmentRevision: aggregate.assignmentRevision,
      });
      const expectedScope = canonicalJson({ scope: aggregate.assignment.scope });
      const expectedSourceState = canonicalJson(checkpointEvent.payload.checkpoint.sourceState);
      const expectedLineage = canonicalJson({
        previousParentSessionId: source.parent_session_id,
        previousChildSessionId: source.session_id,
        correlationId: aggregate.correlationId,
        transferEventPosition: createdEventPosition,
      });
      const expectedAnnotations = canonicalJson([{
        childTransferAnnotationsVersion: 1,
        blockers: [...suspensionEvent.payload.blockers],
        followUps: [...suspensionEvent.payload.followUps],
      }]);
      const expectedLegacyFollowUps = suspensionEvent.payload.blockers.length === 0
        ? canonicalJson([...suspensionEvent.payload.followUps])
        : null;
      return ticket.source_assignment_json === expectedAssignment
        && ticket.source_scope_json === expectedScope
        && ticket.source_state_json === expectedSourceState
        && ticket.lineage_json === expectedLineage
        && (ticket.follow_ups_json === expectedAnnotations
          || ticket.follow_ups_json === expectedLegacyFollowUps);
    } catch {
      return false;
    }
  }

  private checkValidation(context: ProjectContext, sink: IntegrityIssueSink): void {
    const rows = this.connection.prepare(`
      SELECT result.*, event.project_id AS event_project_id,
             event.vault_id AS event_vault_id, event.store_id AS event_store_id,
             event.workspace_id AS event_workspace_id,
             event.session_id AS event_session_id,
             event.event_type AS event_type, event.payload_json AS event_payload_json
      FROM lifecycle_validation_results AS result
      LEFT JOIN events AS event ON event.global_position = result.recorded_event_position
      WHERE result.project_id = $projectId
    `).all({ $projectId: context.binding.projectId });
    if (rows.some((row) => {
      let payload: unknown;
      let artifactReferences: unknown;
      try {
        payload = parsedCanonicalJson(row.event_payload_json);
        artifactReferences = parsedCanonicalJson(row.artifact_references_json);
      } catch {
        payload = null;
        artifactReferences = null;
      }
      if (!record(payload) || !record(payload.validationResult)) return true;
      const result = payload.validationResult;
      const start = result.sourceStateAtStart;
      const completion = result.sourceStateAtCompletion;
      const output = result.outputFingerprint;
      return row.vault_id !== context.binding.vaultId
        || row.store_id !== context.binding.storeId
        || row.workspace_id !== context.binding.workspaceId
        || row.event_project_id !== row.project_id
        || row.event_vault_id !== row.vault_id
        || row.event_store_id !== row.store_id
        || row.event_workspace_id !== row.workspace_id
        || row.event_session_id !== row.session_id
        || row.event_type !== "SessionValidationResultRecorded"
        || payload.workflowId !== row.workflow_id
        || !sameInteger(payload.workflowGeneration, row.workflow_generation)
        || result.resultId !== row.result_id
        || !sameInteger(result.validationResultVersion, row.validation_result_version)
        || result.projectId !== row.project_id
        || result.vaultId !== row.vault_id
        || result.storeId !== row.store_id
        || result.workspaceId !== row.workspace_id
        || result.sessionId !== row.session_id
        || result.workflowId !== row.workflow_id
        || !sameInteger(result.workflowGeneration, row.workflow_generation)
        || result.profileId !== row.profile_id
        || !sameInteger(result.profileVersion, row.profile_version)
        || result.profileConfigurationHash !== row.profile_configuration_hash
        || result.runId !== row.run_id
        || result.runnerId !== row.runner_id
        || result.finalCheckpointId !== row.final_checkpoint_id
        || result.finalCheckpointFingerprint !== row.final_checkpoint_fingerprint
        || !record(start)
        || !sameInteger(start.sourceStateScopeVersion, row.validation_start_scope_version)
        || row.validation_start_project_id !== row.project_id
        || start.workspaceId !== row.validation_start_workspace_id
        || start.branchRef !== row.validation_start_branch_ref
        || start.headCommit !== row.validation_start_head_commit
        || start.dirtyWorktreeFingerprint !== row.validation_start_dirty_fingerprint
        || !record(completion)
        || !sameInteger(completion.sourceStateScopeVersion, row.validation_completion_scope_version)
        || row.validation_completion_project_id !== row.project_id
        || completion.workspaceId !== row.validation_completion_workspace_id
        || completion.branchRef !== row.validation_completion_branch_ref
        || completion.headCommit !== row.validation_completion_head_commit
        || completion.dirtyWorktreeFingerprint !== row.validation_completion_dirty_fingerprint
        || result.startedAt !== row.started_at
        || result.completedAt !== row.completed_at
        || result.status !== row.status
        || result.exitClassification !== row.exit_classification
        || result.summary !== row.redacted_summary
        || !record(output)
        || !sameInteger(output.fingerprintSchemaVersion, row.output_fingerprint_schema_version)
        || output.fingerprintKeyId !== row.output_fingerprint_key_id
        || output.fingerprintDomain !== row.output_fingerprint_domain
        || output.fingerprint !== row.output_fingerprint_value
        || canonicalJson(result.artifactReferences as never) !== canonicalJson(artifactReferences as never)
        || (result.fresh === true ? 1 : result.fresh === false ? 0 : -1) !== integer(row.fresh);
    })) {
      issue(sink, "LIFECYCLE_VALIDATION_RESULT_MISMATCH");
    }
  }

  private checkWorkflowClaims(
    context: ProjectContext,
    sink: IntegrityIssueSink,
    historyAlreadyReplayed = false,
  ): void {
    const rows = this.connection.prepare(`
        SELECT workflow.*, authority.authority_commitment,
               authority.session_kind, authority.stream_id AS authority_stream_id,
               event.session_id AS event_session_id,
               event.stream_id AS event_stream_id, event.command_id AS event_command_id,
               event.event_type AS event_type, event.payload_json AS event_payload_json
        FROM workflow_instances AS workflow
        LEFT JOIN session_authority AS authority
          ON authority.project_id = workflow.project_id
         AND authority.session_id = workflow.session_id
        LEFT JOIN events AS event
          ON event.global_position = workflow.triggering_event_position
        WHERE workflow.project_id = $projectId AND workflow.session_id IS NOT NULL
    `).all({ $projectId: context.binding.projectId });
    if (rows.some((row) => {
        let payload: unknown;
        let classification: ReturnType<typeof classifyWorkflowProjectionEvent> | null;
        try {
          payload = parsedCanonicalJson(row.event_payload_json);
          classification = classifyWorkflowProjectionEvent({
            eventType: row.event_type as StoredEvent["eventType"],
            payload: payload as StoredEvent["payload"],
          });
        } catch {
          payload = null;
          classification = null;
        }
        const commitment = historyAlreadyReplayed
          ? row.expected_authority_commitment
          : this.authorityCommitmentAt(
              row.project_id,
              row.event_stream_id,
              row.triggering_event_position,
            );
        return row.session_kind !== "root"
          || row.event_session_id !== row.session_id
          || row.event_stream_id !== row.authority_stream_id
          || row.event_command_id !== row.root_command_id
          || !record(payload)
          || classification?.kind !== "identified"
          || classification.workflowId !== row.workflow_id
          || !sameInteger(classification.workflowGeneration, row.generation)
          || commitment !== row.expected_authority_commitment
          || (present(row.validation_attempt_plan_generation)
            && !sameInteger(row.validation_attempt_plan_generation, row.generation));
    })) {
      issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
      return;
    }

    const internalCommands = this.connection.prepare(`
      SELECT command.authorization_session_id, command.target_session_id,
             command.internal_workflow_id, command.internal_workflow_generation,
             command.internal_planned_work_id, command.internal_claim_owner_id,
             command.internal_claim_token, workflow.session_id,
             workflow.generation AS current_generation,
             workflow.coordinator_attempt_count
      FROM command_dedup AS command
      LEFT JOIN workflow_instances AS workflow
        ON workflow.project_id = command.project_id
       AND workflow.workflow_id = command.internal_workflow_id
      WHERE command.project_id = $projectId
        AND command.lifecycle_authorization_kind = 'internal-workflow'
    `).all({ $projectId: context.binding.projectId });
    if (internalCommands.some((row) => (
      row.session_id === null
      || row.authorization_session_id !== row.session_id
      || row.target_session_id !== row.session_id
      || !nonEmpty(row.internal_planned_work_id)
      || !positive(row.internal_claim_token)
      || !nonEmpty(row.internal_claim_owner_id)
      || integer(row.internal_workflow_generation) === null
      || integer(row.current_generation) === null
      || integer(row.internal_workflow_generation)! > integer(row.current_generation)!
      || (
        sameInteger(row.internal_workflow_generation, row.current_generation)
        && integer(row.internal_claim_token)! > integer(row.coordinator_attempt_count)!
      )
    ))) {
      issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
    }
  }

  private authorityCommitmentAt(
    projectId: unknown,
    streamId: unknown,
    position: unknown,
  ): string | null {
    if (!nonEmpty(projectId) || !nonEmpty(streamId) || integer(position) === null) return null;
    const rows = this.connection.prepare(`
      SELECT payload_json
      FROM events
      WHERE project_id = $projectId AND stream_id = $streamId
        AND global_position <= $position
      ORDER BY stream_version
    `).all({
      $projectId: projectId as string,
      $streamId: streamId as string,
      $position: integer(position)!,
    });
    let commitment: string | null = null;
    try {
      for (const row of rows) {
        const payload = parsedCanonicalJson(row.payload_json);
        if (record(payload) && typeof payload.authorityCommitment === "string") {
          commitment = payload.authorityCommitment;
        }
      }
    } catch {
      return null;
    }
    return commitment;
  }

  private checkOutboxShape(
    context: ProjectContext,
    sink: IntegrityIssueSink,
    full: boolean,
  ): void {
    const schema4 = this.hasSchema4LifecycleSchema(context);
    if (schema4) {
      const reservedWithoutSession = this.connection.prepare(`
        SELECT /* lifecycle-${full ? "full" : "quick"}:outbox-null-session */ 1 AS invalid
        FROM outbox INDEXED BY outbox_delivery_order
        WHERE project_id = $projectId
          AND kind = 'materialize-lifecycle-log'
          AND session_id IS NULL
        LIMIT 1
      `).get({ $projectId: context.binding.projectId });
      if (reservedWithoutSession !== undefined) {
        issue(sink, "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH");
        return;
      }
    }
    const rows = this.connection.prepare(full
      ? `
        SELECT outbox.*, event.session_id AS event_session_id,
               workflow.generation AS current_workflow_generation
        FROM outbox
        LEFT JOIN events AS event ON event.global_position = outbox.event_position
        LEFT JOIN workflow_instances AS workflow
          ON workflow.project_id = outbox.project_id
         AND workflow.workflow_id = outbox.workflow_id
        WHERE outbox.project_id = $projectId AND outbox.session_id IS NOT NULL
        ORDER BY outbox.session_id, outbox.artifact_kind, outbox.materialization_revision
      `
      : `
        SELECT /* lifecycle-quick:outbox-current */
               outbox.*, event.session_id AS event_session_id,
               workflow.generation AS current_workflow_generation
        FROM outbox INDEXED BY outbox_lifecycle_latest_artifact
        LEFT JOIN events AS event ON event.global_position = outbox.event_position
        LEFT JOIN workflow_instances AS workflow
          ON workflow.project_id = outbox.project_id
         AND workflow.workflow_id = outbox.workflow_id
        WHERE outbox.project_id = $projectId
          AND outbox.session_id IS NOT NULL
          AND outbox.artifact_kind = '${COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND}'
        LIMIT 1
      `).all({ $projectId: context.binding.projectId });
    const previous = new Map<string, {
      revision: bigint;
      fingerprint: unknown;
      artifactPath: unknown;
    }>();
    for (const row of rows) {
      const materialization = [
        row.artifact_kind,
        row.artifact_path,
        row.materialization_revision,
        row.next_fingerprint,
        row.fingerprint_algorithm,
        row.fingerprint_schema_version,
        row.fingerprint_key_id,
        row.fingerprint_domain,
      ];
      const claim = [row.claim_owner, row.claim_token, row.claim_expires_at];
      const failure = [row.failure_class, row.safe_error_code];
      const originValid = row.origin_kind === "terminal-event"
        ? row.workflow_id === null && row.workflow_generation === null
        : row.origin_kind === "workflow"
          && nonEmpty(row.workflow_id)
          && positive(row.workflow_generation);
      const statusValid = row.status === "pending"
        ? integer(row.attempt_count) !== null
          && integer(row.attempt_count)! === 0
          && allNull(row, ["claim_owner", "claim_token", "claim_expires_at"])
          && (
            allNull(row, ["failure_class", "safe_error_code", "next_attempt_at"])
            || (
              row.failure_class === "retryable"
              && nonEmpty(row.safe_error_code)
              && nonEmpty(row.next_attempt_at)
            )
          )
        : row.status === "claimed"
          ? allPresent(row, ["claim_owner", "claim_token", "claim_expires_at"])
            && positive(row.claim_token)
            && integer(row.attempt_count) !== null
            && integer(row.attempt_count)! >= integer(row.claim_token)!
            && allNull(row, ["failure_class", "safe_error_code", "next_attempt_at"])
          : row.status === "completed"
            ? present(row.claim_owner)
              && positive(row.claim_token)
              && integer(row.attempt_count) !== null
              && integer(row.attempt_count)! >= integer(row.claim_token)!
              && row.claim_expires_at === null
              && allNull(row, ["failure_class", "safe_error_code", "next_attempt_at"])
            : row.status === "failed"
              ? integer(row.attempt_count) !== null
                && integer(row.attempt_count)! > 0
                && allNull(row, ["claim_owner", "claim_token", "claim_expires_at"])
                && (row.failure_class === "retryable" || row.failure_class === "permanent")
                && nonEmpty(row.safe_error_code)
                && ((row.failure_class === "retryable") === nonEmpty(row.next_attempt_at))
              : false;
      let schema4DescriptorValid = true;
      if (schema4 && row.kind === "materialize-lifecycle-log") {
        try {
          this.assertSchema4LifecycleOutboxDescriptor(context, row, full);
        } catch {
          schema4DescriptorValid = false;
        }
      }
      if (
        !materialization.every(present)
        || !originValid
        || !statusValid
        || !schema4DescriptorValid
        || row.event_session_id !== row.session_id
        || !positive(row.attempt_count) && row.status !== "pending"
        || (claim.some(present) && !nonEmpty(row.claim_owner))
        || (failure.some(present) && !nonEmpty(row.safe_error_code))
      ) {
        issue(sink, "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH");
        return;
      }
      if (!full) {
        if (
          schema4
          && row.kind === "materialize-lifecycle-log"
          && !this.quickOutboxPredecessorValid(row)
        ) {
          issue(sink, "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH");
          return;
        }
        continue;
      }
      const key = `${String(row.session_id)}\u0000${String(row.artifact_kind)}`;
      const revision = int64(row.materialization_revision);
      if (
        revision === null
        || revision < 1
        || int64(row.event_position) !== revision
        || (row.origin_kind === "workflow" && (
          row.current_workflow_generation === null
          || integer(row.workflow_generation)! > integer(row.current_workflow_generation)!
        ))
      ) {
        issue(sink, "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH");
        return;
      }
      const prior = previous.get(key);
      if (
        (prior === undefined && row.expected_prior_fingerprint !== null)
        || (prior !== undefined && (
          revision !== prior.revision + 1n
          || row.expected_prior_fingerprint !== prior.fingerprint
          || row.artifact_path !== prior.artifactPath
        ))
      ) {
        issue(sink, "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH");
        return;
      }
      previous.set(key, {
        revision,
        fingerprint: row.next_fingerprint,
        artifactPath: row.artifact_path,
      });
    }
  }

  private quickOutboxPredecessorValid(row: Readonly<SqliteRow>): boolean {
    const revision = int64(row.materialization_revision);
    if (
      revision === null
      || revision < 1n
      || typeof row.project_id !== "string"
      || typeof row.session_id !== "string"
      || typeof row.artifact_kind !== "string"
    ) return false;
    const predecessors = revision === 1n
      ? []
      : this.connection.prepare(`
        SELECT /* lifecycle-quick:outbox-predecessor */ next_fingerprint, artifact_path
        FROM outbox INDEXED BY outbox_lifecycle_latest_artifact
        WHERE project_id = $projectId
          AND session_id = $sessionId
          AND artifact_kind = $artifactKind
          AND materialization_revision = $revision
        LIMIT 2
      `).all({
        $projectId: row.project_id,
        $sessionId: row.session_id,
        $artifactKind: row.artifact_kind,
        $revision: revision - 1n,
      });
    if (predecessors.length > 1) return false;
    const predecessor = predecessors[0];
    return predecessor === undefined
      ? row.expected_prior_fingerprint === null
      : row.expected_prior_fingerprint === predecessor.next_fingerprint
        && row.artifact_path === predecessor.artifact_path;
  }

  private assertSchema4LifecycleOutboxDescriptor(
    context: ProjectContext,
    row: Readonly<SqliteRow>,
    full: boolean,
  ): void {
    const rawPayload = parsedCanonicalJson(row.payload_json);
    if (!record(rawPayload) || !exactRecordKeys(rawPayload, LIFECYCLE_OUTBOX_PAYLOAD_KEYS)) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    let payload: LifecycleMaterializationPayloadV1;
    try {
      payload = decodeLifecycleMaterializationPayloadV1(rawPayload);
      if (canonicalJson(payload) !== row.payload_json) throw new LifecycleError("INTEGRITY_FAILURE");
    } catch {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    const nextFingerprint = payload.nextFingerprint;
    const origin = payload.origin;
    const eventPosition = int64(row.event_position);
    const revision = int64(row.materialization_revision);
    const workflowGeneration = row.workflow_generation === null
      ? null
      : integer(row.workflow_generation);
    if (
      !record(nextFingerprint)
      || !exactRecordKeys(nextFingerprint, LIFECYCLE_OUTBOX_FINGERPRINT_KEYS)
      || !record(origin)
      || !exactRecordKeys(origin, LIFECYCLE_OUTBOX_ORIGIN_KEYS)
      || row.project_id !== context.binding.projectId
      || !nonEmpty(row.session_id)
      || !nonEmpty(row.target_key)
      || !nonEmpty(row.artifact_path)
      || eventPosition === null
      || revision === null
      || eventPosition !== revision
      || payload.payloadVersion !== 1
      || payload.targetKey !== row.target_key
      || payload.sessionId !== row.session_id
      || payload.artifactKind !== COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND
      || payload.artifactKind !== row.artifact_kind
      || payload.artifactPath !== row.artifact_path
      || payload.materializationRevision !== revision?.toString()
      || row.target_key !== `lifecycle-log/${row.session_id as string}/${revision?.toString()}`
      || typeof payload.triggeringPayloadHash !== "string"
      || !LOWER_HASH.test(payload.triggeringPayloadHash)
      || typeof payload.triggeringEventType !== "string"
      || !LIFECYCLE_OUTBOX_TRIGGER_TYPES.has(payload.triggeringEventType)
      || nextFingerprint.algorithm !== "hmac-sha256"
      || nextFingerprint.algorithm !== row.fingerprint_algorithm
      || nextFingerprint.schemaVersion !== 1
      || nextFingerprint.schemaVersion !== integer(row.fingerprint_schema_version)
      || !nonEmpty(nextFingerprint.keyId)
      || (nextFingerprint.keyId as string).length > 128
      || nextFingerprint.keyId !== row.fingerprint_key_id
      || nextFingerprint.domain !== "pm-materialization-fingerprint-v1"
      || nextFingerprint.domain !== row.fingerprint_domain
      || typeof nextFingerprint.value !== "string"
      || !LOWER_HASH.test(nextFingerprint.value)
      || nextFingerprint.value !== row.next_fingerprint
      || origin.kind !== row.origin_kind
      || origin.workflowId !== row.workflow_id
      || (origin.workflowGeneration === null
        ? workflowGeneration !== null
        : integer(origin.workflowGeneration) !== workflowGeneration)
      || typeof row.content_hash !== "string"
      || !LOWER_HASH.test(row.content_hash)
      || row.content_hash !== outboxHash(payload)
    ) throw new LifecycleError("INTEGRITY_FAILURE");

    const triggers = this.connection.prepare(`
      SELECT global_position, event_type, event_schema_version, payload_json,
             payload_hash, command_event_index, session_id,
             parent_session_id, stream_type, stream_id
      FROM events
      WHERE project_id = $projectId AND global_position = $eventPosition
      LIMIT 2
    `).all({
      $projectId: context.binding.projectId,
      $eventPosition: eventPosition,
    });
    if (triggers.length !== 1) throw new LifecycleError("INTEGRITY_FAILURE");
    const trigger = triggers[0]!;
    const triggerSchemaVersion = integer(trigger.event_schema_version);
    const expectedTriggerSchemaVersion = payload.triggeringEventType === "SessionCheckpointRecorded"
      || payload.triggeringEventType === "SessionEndAmended"
      || payload.triggeringEventType === "SessionEndCancelled"
      ? 3
      : 1;
    if (
      int64(trigger.global_position) !== eventPosition
      || trigger.session_id !== row.session_id
      || trigger.parent_session_id !== null
      || trigger.stream_type !== "session"
      || trigger.stream_id !== `session/${row.session_id as string}`
      || integer(trigger.command_event_index) !== 0
      || trigger.event_type !== payload.triggeringEventType
      || triggerSchemaVersion !== expectedTriggerSchemaVersion
      || trigger.payload_hash !== payload.triggeringPayloadHash
    ) throw new LifecycleError("INTEGRITY_FAILURE");
    const triggerPayload = parsedCanonicalJson(trigger.payload_json);
    if (!record(triggerPayload)) throw new LifecycleError("INTEGRITY_FAILURE");
    if (payloadHash(triggerPayload) !== trigger.payload_hash) {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    let decodedTriggerPayload: Record<string, unknown>;
    try {
      const decoded = decodeLifecycleEventPayload(
        payload.triggeringEventType,
        expectedTriggerSchemaVersion,
        triggerPayload,
      );
      if (!record(decoded)) throw new LifecycleError("INTEGRITY_FAILURE");
      decodedTriggerPayload = decoded;
      if (canonicalJson(decodedTriggerPayload) !== trigger.payload_json) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
    } catch {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    if (row.origin_kind === "terminal-event") {
      if (
        row.workflow_id !== null
        || workflowGeneration !== null
        || trigger.event_type !== "SessionAbandoned"
        || decodedTriggerPayload.workflowId !== null
        || decodedTriggerPayload.workflowGeneration !== null
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    } else if (row.origin_kind === "workflow") {
      if (
        typeof row.workflow_id !== "string"
        || !LOWER_UUID.test(row.workflow_id)
        || workflowGeneration === null
        || workflowGeneration < 1
      ) throw new LifecycleError("INTEGRITY_FAILURE");
      if (trigger.event_type === "SessionCheckpointRecorded") {
        const workflows = this.connection.prepare(`
          SELECT 1 AS present
          FROM workflow_instances
          WHERE project_id = $projectId
            AND workflow_id = $workflowId
            AND session_id = $sessionId
            AND generation = $workflowGeneration
          LIMIT 2
        `).all({
          $projectId: context.binding.projectId,
          $workflowId: row.workflow_id,
          $sessionId: row.session_id as string,
          $workflowGeneration: workflowGeneration,
        });
        if (workflows.length !== 1) throw new LifecycleError("INTEGRITY_FAILURE");
      }
      if (
        decodedTriggerPayload.workflowId !== row.workflow_id
        || integer(decodedTriggerPayload.workflowGeneration) !== workflowGeneration
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    } else {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }

    const starts = this.connection.prepare(`
      SELECT /* lifecycle-${full ? "full" : "quick"}:outbox-start */ occurred_at
      FROM events
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND stream_id = $streamId
        AND stream_version = 1
        AND event_type = 'SessionStarted'
        AND event_schema_version = 1
      LIMIT 2
    `).all({
      $projectId: context.binding.projectId,
      $sessionId: row.session_id as string,
      $streamId: `session/${row.session_id as string}`,
    });
    if (
      starts.length !== 1
      || typeof starts[0]!.occurred_at !== "string"
      || row.artifact_path !== `05_Agent_Session_Logs/${
        (starts[0]!.occurred_at as string).slice(0, 10)
      }-session-${row.session_id as string}.md`
    ) throw new LifecycleError("INTEGRITY_FAILURE");
  }
}
