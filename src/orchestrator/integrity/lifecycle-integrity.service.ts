import { createHash } from "node:crypto";
import type { StoredEvent } from "../contracts/event.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import {
  decodeLifecycleEvent,
  type LifecycleEvent,
} from "../lifecycle/contracts/events.js";
import {
  CHECKPOINT_MAX_CANONICAL_BYTES,
  type Checkpoint,
  type CheckpointEvidenceCoverageV2,
} from "../lifecycle/contracts/checkpoint.js";
import {
  decodeFinalEndingScopeBindingsV1,
  FINAL_ENDING_SCOPE_BINDINGS_MAX_CANONICAL_BYTES,
  type FinalEndingScopeBindingV1,
} from "../lifecycle/contracts/session-end.js";
import { LifecycleError } from "../lifecycle/errors.js";
import { decodeLifecycleIntentWitness } from "../lifecycle/lifecycle-intent-witness.js";
import {
  foldChildEventProjection,
  foldWorkflowGenerationProjection,
  reportItemSetFingerprint,
  type ChildEventFoldProjection,
  type WorkflowGenerationFoldProjection,
} from "../lifecycle/lifecycle-projection-folds.js";
import {
  evolveSession,
  foldSession,
  type SessionAggregateState,
} from "../lifecycle/session-aggregate.js";
import type { ProjectContext } from "../identity/contracts.js";
import type { CapabilityKeyProvider } from "../lifecycle/authority/capability-key-provider.js";
import { ChildTransferRepository } from "../storage/child-transfer.repository.js";
import { EvidenceCoverageRepository } from "../storage/evidence-coverage.repository.js";
import { SqliteLifecycleProjectionRepository } from "../storage/lifecycle-projection.repository.js";
import { SessionAuthorityRepository } from "../storage/session-authority.repository.js";
import type {
  CarryForwardEndingScopeProjectionRecord,
  ChildTransferTicketRecord,
  CurrentChildEndingScopeProjectionRecord,
  SessionAuthorityRecord,
} from "../storage/lifecycle-storage.types.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import type {
  AsyncIntegrityExtension,
  HistoricalEvidenceIntegrityProviderPort,
  IntegrityIssueCode,
  IntegrityIssueSink,
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
  ) {}

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
    this.runQuickCheck(context, sink);
    await this.checkQualifiedQuick(context, sink);
  }

  async fullCheckAsync(
    context: ProjectContext,
    sink: IntegrityIssueSink,
  ): Promise<void> {
    if (!this.hasLifecycleSchema()) return;
    this.runQuickCheck(context, sink);
    await this.checkQualifiedQuick(context, sink);
    this.runFullOnly(context, sink);
  }

  private runQuickCheck(context: ProjectContext, sink: IntegrityIssueSink): void {
    this.checkAuthorization(context, sink);
    this.checkAuthorityLinkage(context, sink, false);
    this.checkLeases(context, sink);
    this.checkWorkflowShape(context, sink);
    this.checkOutboxShape(context, sink, false);
  }

  private runFullCheck(context: ProjectContext, sink: IntegrityIssueSink): void {
    this.runQuickCheck(context, sink);
    this.runFullOnly(context, sink);
  }

  private runFullOnly(context: ProjectContext, sink: IntegrityIssueSink): void {
    this.checkAuthorityLinkage(context, sink, true);
    this.checkEvidence(context, sink);
    this.checkApprovalsAndTransfers(context, sink);
    this.checkValidation(context, sink);
    this.checkWorkflowClaims(context, sink);
    this.checkOutboxShape(context, sink, true);
  }

  private async checkQualifiedQuick(
    context: ProjectContext,
    sink: IntegrityIssueSink,
  ): Promise<void> {
    const qualifiedSchema = this.connection.prepare(`
      SELECT 1 AS present
      FROM sqlite_schema
      WHERE type = 'table'
        AND name = 'session_evidence_coverage_transitions'
      LIMIT 1
    `).get() !== undefined;
    if (!qualifiedSchema) return;

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
      return;
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
      return;
    }

    const statuses = new Map<string, "available">();
    for (const keyId of [...profileIds].sort(binaryCompare)) {
      if (this.provider === undefined) {
        throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
      }
      const status = await this.provider.status(keyId);
      if (status !== "available") {
        throw new LifecycleError("EVIDENCE_HISTORICAL_KEY_UNAVAILABLE");
      }
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

    try {
      this.checkCurrentCheckpointIndexes(context);
    } catch {
      issue(sink, "SESSION_AUTHORITY_FOLD_MISMATCH");
      return;
    }
    try {
      this.checkFrozenWorkflowIntegrity(context, coverage);
    } catch {
      issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
      return;
    }
    try {
      this.checkProspectiveCapacity(context, coverage, sessionIds);
    } catch {
      issue(sink, "SESSION_EVIDENCE_COVERAGE_MISMATCH");
    }
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
        || !sameInteger(row.payload_frame_count, row.new_frame_count)
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
    coverage: EvidenceCoverageRepository,
  ): void {
    const rows = this.connection.prepare(`
      SELECT session_id, generation, phase, result_json,
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
        const rootHistorical = coverage.snapshotFromTransitionsV2(
          this.connection,
          rootCheckpoint.sessionId,
          BigInt(rootCheckpoint.baseEventPosition),
        );
        if (canonicalJson(rootHistorical) !== canonicalJson(rootCheckpoint.evidenceCoverage)) {
          throw new LifecycleError("INTEGRITY_FAILURE");
        }
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
          coverage,
        );
      }
    }
  }

  private checkFrozenBinding(
    context: ProjectContext,
    rootSessionId: string,
    binding: FinalEndingScopeBindingV1,
    authority: SessionAuthorityRepository,
    coverage: EvidenceCoverageRepository,
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
      const historical = coverage.snapshotFromTransitionsV2(
        this.connection,
        checkpoint.sessionId,
        BigInt(checkpoint.baseEventPosition),
      );
      if (canonicalJson(historical) !== canonicalJson(checkpoint.evidenceCoverage)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
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
  ): LifecycleEvent {
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
      return decodeLifecycleEvent({
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

  private assertEventTimeCleanScope(
    context: ProjectContext,
    sessionId: string,
    basePosition: bigint,
  ): void {
    const adapters = this.connection.prepare(`
      SELECT adapter_session_id
      FROM session_evidence_coverage
      WHERE project_id = $projectId
        AND session_id = $sessionId
      ORDER BY CAST(adapter_session_id AS BLOB)
      LIMIT 201
    `).all({
      $projectId: context.binding.projectId,
      $sessionId: sessionId,
    });
    if (adapters.length > 200) throw new LifecycleError("INTEGRITY_FAILURE");
    const transitionAtOrBefore = this.connection.prepare(`
      SELECT 1 AS present
      FROM session_evidence_coverage_transitions
        INDEXED BY session_evidence_coverage_transitions_snapshot
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND adapter_session_id = $adapterSessionId
        AND batch_event_position <= $basePosition
      LIMIT 1
    `);
    for (const adapter of adapters) {
      if (
        typeof adapter.adapter_session_id !== "string"
        || transitionAtOrBefore.get({
          $projectId: context.binding.projectId,
          $sessionId: sessionId,
          $adapterSessionId: adapter.adapter_session_id,
          $basePosition: basePosition,
        }) !== undefined
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    }
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
  ): void {
    const rows = this.connection.prepare(`
      SELECT authority.*, event.project_id AS event_project_id,
             event.stream_id AS event_stream_id, event.session_id AS event_session_id,
             event.parent_session_id AS event_parent_session_id,
             event.payload_json AS event_payload_json,
             event.event_type AS authority_event_type
      FROM session_authority AS authority
      LEFT JOIN events AS event
        ON event.global_position = authority.authority_event_position
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
      ) {
        issue(sink, "SESSION_AUTHORITY_FOLD_MISMATCH");
        return;
      }
      if (full) {
        try {
          const events = this.lifecycleEvents(row);
          const aggregate = foldSession(events);
          if (!this.authorityMatchesFold(row, aggregate, events)) {
            issue(sink, "SESSION_AUTHORITY_FOLD_MISMATCH");
            return;
          }
        } catch {
          issue(sink, "SESSION_AUTHORITY_FOLD_MISMATCH");
          return;
        }
      }
    }
  }

  private lifecycleEvents(authority: SqliteRow): readonly LifecycleEvent[] {
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
    const events: LifecycleEvent[] = [];
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
    events: readonly LifecycleEvent[],
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
    events: readonly LifecycleEvent[],
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

  private revocation(events: readonly LifecycleEvent[]): RevocationFold | null {
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

  private checkWorkflowShape(context: ProjectContext, sink: IntegrityIssueSink): void {
    const rows = this.connection.prepare(`
      SELECT * FROM workflow_instances
      WHERE project_id = $projectId
    `).all({ $projectId: context.binding.projectId });
    for (const row of rows) {
      const evidenceColumns = [
        "evidence_frozen_checkpoint_event_position",
        "evidence_frozen_generation",
        "evidence_window_state",
        "final_ending_scope_bindings_json",
      ] as const;
      if (row.session_id === null) {
        if (!allNull(row, evidenceColumns)) {
          issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
          return;
        }
        continue;
      }
      const claim = [row.coordinator_owner_id, row.coordinator_claim_token, row.coordinator_claim_expires_at];
      const plan = [row.validation_attempt_plan_generation, row.validation_attempt_plans_json];
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
      if (row.evidence_window_state === "open") {
        try {
          this.assertOpenWorkflowProjection(context, row);
        } catch {
          openHistoryValid = false;
        }
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
        || (plan.some(present) && !plan.every(present))
        || (present(row.validation_attempt_plans_json) && !canonicalJsonText(row.validation_attempt_plans_json))
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
      ) {
        issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
        return;
      }
    }
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
    } else if (event.eventType === "SessionEndAmended") {
      const amendment = record(command.amendment) ? command.amendment : null;
      const draft = amendment !== null && record(amendment.finalCheckpoint)
        ? amendment.finalCheckpoint
        : null;
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

  private checkApprovalsAndTransfers(context: ProjectContext, sink: IntegrityIssueSink): void {
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
      try { createdPayload = parsedCanonicalJson(row.created_event_payload_json); } catch { createdPayload = null; }
      try {
        claimedPayload = present(row.claimed_event_position)
          ? parsedCanonicalJson(row.claimed_event_payload_json)
          : null;
      } catch { claimedPayload = null; }
      return (claimed.some(present) && !claimed.every(present))
        || row.created_event_project_id !== row.project_id
        || row.created_event_type !== "ChildWorkTransferCreated"
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
        || !this.transferMatchesSourceTruth(row);
    })) {
      issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
    }
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

  private checkWorkflowClaims(context: ProjectContext, sink: IntegrityIssueSink): void {
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
      try { payload = parsedCanonicalJson(row.event_payload_json); } catch { payload = null; }
      const commitment = this.authorityCommitmentAt(
        row.project_id,
        row.event_stream_id,
        row.triggering_event_position,
      );
      return row.session_kind !== "root"
        || row.event_session_id !== row.session_id
        || row.event_stream_id !== row.authority_stream_id
        || row.event_command_id !== row.root_command_id
        || (row.event_type !== "SessionEndRequested" && row.event_type !== "SessionEndAmended")
        || !record(payload)
        || payload.workflowId !== row.workflow_id
        || !sameInteger(payload.workflowGeneration, row.generation)
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
    const rows = this.connection.prepare(`
      SELECT outbox.*, event.session_id AS event_session_id,
             workflow.generation AS current_workflow_generation
      FROM outbox
      LEFT JOIN events AS event ON event.global_position = outbox.event_position
      LEFT JOIN workflow_instances AS workflow
        ON workflow.project_id = outbox.project_id
       AND workflow.workflow_id = outbox.workflow_id
      WHERE outbox.project_id = $projectId AND outbox.session_id IS NOT NULL
      ORDER BY outbox.session_id, outbox.artifact_kind, outbox.materialization_revision
    `).all({ $projectId: context.binding.projectId });
    const previous = new Map<string, {
      revision: number;
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
        ? allNull(row, ["claim_owner", "claim_token", "claim_expires_at"])
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
            && allNull(row, ["failure_class", "safe_error_code", "next_attempt_at"])
          : row.status === "completed"
            ? present(row.claim_owner)
              && positive(row.claim_token)
              && row.claim_expires_at === null
              && allNull(row, ["failure_class", "safe_error_code", "next_attempt_at"])
            : row.status === "failed"
              ? allNull(row, ["claim_owner", "claim_token", "claim_expires_at"])
                && (row.failure_class === "retryable" || row.failure_class === "permanent")
                && nonEmpty(row.safe_error_code)
                && ((row.failure_class === "retryable") === nonEmpty(row.next_attempt_at))
              : false;
      if (
        !materialization.every(present)
        || !originValid
        || !statusValid
        || row.event_session_id !== row.session_id
        || !positive(row.attempt_count) && row.status !== "pending"
        || (claim.some(present) && !nonEmpty(row.claim_owner))
        || (failure.some(present) && !nonEmpty(row.safe_error_code))
      ) {
        issue(sink, "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH");
        return;
      }
      if (!full) continue;
      const key = `${String(row.session_id)}\u0000${String(row.artifact_kind)}`;
      const revision = integer(row.materialization_revision);
      if (
        revision === null
        || revision < 1
        || !sameInteger(row.materialization_revision, row.event_position)
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
        prior !== undefined && (
          revision <= prior.revision
          || row.expected_prior_fingerprint !== prior.fingerprint
          || row.artifact_path !== prior.artifactPath
        )
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
}
