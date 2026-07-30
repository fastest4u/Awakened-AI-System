import { createHash } from "node:crypto";
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
import { foldSession, type SessionAggregateState } from "../lifecycle/session-aggregate.js";
import type { ProjectContext } from "../identity/contracts.js";
import type { CapabilityKeyProvider } from "../lifecycle/authority/capability-key-provider.js";
import { ChildTransferRepository } from "../storage/child-transfer.repository.js";
import { EvidenceCoverageRepository } from "../storage/evidence-coverage.repository.js";
import { SessionAuthorityRepository } from "../storage/session-authority.repository.js";
import type {
  CarryForwardEndingScopeProjectionRecord,
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
        json_valid(event.payload_json) AS payload_valid,
        json(event.payload_json) = event.payload_json AS payload_canonical,
        (SELECT count(*) FROM json_each(event.payload_json)) AS payload_key_count,
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
        json_array_length(event.payload_json, '$.frames') AS payload_frame_count
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
    for (const row of rows) {
      const last = decimal(row.coverage_last_ordinal);
      const highest = decimal(row.highest_contiguous_ordinal);
      if (last === null || highest === null) throw new LifecycleError("INTEGRITY_FAILURE");
      let intervals: unknown;
      try {
        intervals = JSON.parse(String(row.missing_intervals_json));
      } catch {
        throw new LifecycleError("INTEGRITY_FAILURE");
      }
      if (!Array.isArray(intervals)) throw new LifecycleError("INTEGRITY_FAILURE");
      const publicIntervals = intervals.map((interval) => {
        if (
          !Array.isArray(interval)
          || interval.length !== 2
          || integer(interval[0]) === null
          || integer(interval[1]) === null
        ) throw new LifecycleError("INTEGRITY_FAILURE");
        return {
          firstOrdinal: String(interval[0]),
          lastOrdinal: String(interval[1]),
        };
      });
      const expectedHighest = highest === "-1" ? null : highest;
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
        || integer(row.payload_key_count) !== 20
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
      const position = integer(row.latest_checkpoint_event_position);
      if (position === null || position < 1) throw new LifecycleError("INTEGRITY_FAILURE");
      const checkpoint = authority.requireCheckpointAtEventPosition(this.connection, {
        projectId: context.binding.projectId,
        sessionId: row.session_id as never,
        checkpointId: row.latest_checkpoint_id as never,
        checkpointEventPosition: BigInt(position),
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
      const frozenPosition = integer(row.evidence_frozen_checkpoint_event_position);
      const generation = integer(row.generation);
      const frozenGeneration = integer(row.evidence_frozen_generation);
      if (
        frozenPosition === null
        || frozenPosition < 1
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
        || status.finalCheckpointEventPosition !== String(frozenPosition)
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
        checkpointEventPosition: BigInt(frozenPosition),
      });
      if (
        rootCheckpoint.checkpointVersion !== 2
        || rootCheckpoint.parentSessionId !== null
      ) throw new LifecycleError("INTEGRITY_FAILURE");
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
      const rootHistorical = coverage.snapshotFromTransitionsV2(
        this.connection,
        rootCheckpoint.sessionId,
        BigInt(rootCheckpoint.baseEventPosition),
      );
      if (canonicalJson(rootHistorical) !== canonicalJson(rootCheckpoint.evidenceCoverage)) {
        throw new LifecycleError("INTEGRITY_FAILURE");
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
    const lastEvent = this.connection.prepare(`
      SELECT project_id, stream_id, stream_type, stream_version,
             session_id, parent_session_id
      FROM events
      WHERE global_position = $position
    `).get({ $position: BigInt(binding.lastEventPosition) });
    if (
      lastEvent === undefined
      || lastEvent.project_id !== context.binding.projectId
      || lastEvent.stream_id !== `session/${binding.childSessionId}`
      || lastEvent.stream_type !== "session"
      || decimal(lastEvent.stream_version) !== binding.streamVersion
      || lastEvent.session_id !== binding.childSessionId
      || lastEvent.parent_session_id !== rootSessionId
    ) throw new LifecycleError("INTEGRITY_FAILURE");

    if (binding.bindingKind === "carry-forward-ticket") {
      const ticket = this.connection.prepare(`
        SELECT ticket.project_id, ticket.transfer_ticket_id,
               ticket.source_parent_session_id, ticket.source_child_session_id,
               ticket.checkpoint_id, ticket.created_event_position,
               event.project_id AS event_project_id,
               event.stream_id AS event_stream_id,
               event.stream_type AS event_stream_type,
               event.stream_version AS event_stream_version,
               event.session_id AS event_session_id,
               event.parent_session_id AS event_parent_session_id,
               event.event_type AS event_type,
               event.event_schema_version AS event_schema_version,
               json_extract(event.payload_json, '$.transferTicketId') AS payload_ticket_id,
               json_extract(event.payload_json, '$.checkpointId') AS payload_checkpoint_id
        FROM child_transfer_tickets AS ticket
        LEFT JOIN events AS event
          ON event.global_position = $eventPosition
        WHERE ticket.project_id = $projectId
          AND ticket.transfer_ticket_id = $ticketId
      `).get({
        $eventPosition: BigInt(binding.transferTicketEventPosition!),
        $projectId: context.binding.projectId,
        $ticketId: binding.transferTicketId,
      });
      if (
        ticket === undefined
        || ticket.project_id !== context.binding.projectId
        || ticket.source_parent_session_id !== rootSessionId
        || ticket.source_child_session_id !== binding.childSessionId
        || ticket.checkpoint_id !== binding.checkpointId
        || decimal(ticket.created_event_position) !== binding.transferTicketEventPosition
        || ticket.event_project_id !== context.binding.projectId
        || ticket.event_stream_id !== `session/${binding.childSessionId}`
        || ticket.event_stream_type !== "session"
        || ticket.event_session_id !== binding.childSessionId
        || ticket.event_parent_session_id !== ticket.source_parent_session_id
        || ticket.event_type !== "ChildWorkTransferCreated"
        || integer(ticket.event_schema_version) !== 1
        || ticket.payload_ticket_id !== binding.transferTicketId
        || ticket.payload_checkpoint_id !== binding.checkpointId
      ) throw new LifecycleError("INTEGRITY_FAILURE");
    }

    if (binding.checkpointId === null || binding.checkpointEventPosition === null) return;
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
    const nonClean = this.connection.prepare(`
      SELECT 1 AS present
      FROM session_evidence_coverage_transitions
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND batch_event_position <= $basePosition
      UNION ALL
      SELECT 1 AS present
      FROM events
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND global_position <= $basePosition
        AND event_type = 'EvidenceCoverageRecorded'
      LIMIT 1
    `).get({
      $projectId: context.binding.projectId,
      $sessionId: checkpoint.sessionId,
      $basePosition: BigInt(checkpoint.baseEventPosition),
    });
    if (nonClean !== undefined) throw new LifecycleError("INTEGRITY_FAILURE");
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
          && (!frozenAbsent || (row.phase !== "requested" && row.phase !== "children-resolved"))
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
