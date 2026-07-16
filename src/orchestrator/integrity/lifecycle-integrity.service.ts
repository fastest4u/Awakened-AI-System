import { createHash } from "node:crypto";
import { canonicalJson } from "../serialization/canonical-json.js";
import { decodeLifecycleEventV1, type LifecycleEventV1 } from "../lifecycle/contracts/events.js";
import { foldSession, type SessionAggregateState } from "../lifecycle/session-aggregate.js";
import type { ProjectContext } from "../identity/contracts.js";
import type { SqliteConnection, SqliteRow } from "../storage/sqlite-driver.js";
import type { IntegrityExtension, IntegrityIssueCode, IntegrityIssueSink } from "./integrity.types.js";

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

function canonicalHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value as never), "utf8")
    .digest("hex");
}

interface CheckpointRequirementFold {
  readonly reason: string;
  readonly eventPosition: string;
}

interface RevocationFold {
  readonly reason: string;
  readonly eventPosition: string;
  readonly revokedAt: string;
}

export class LifecycleIntegrityService implements IntegrityExtension {
  constructor(private readonly connection: SqliteConnection) {}

  quickCheck(context: ProjectContext, sink: IntegrityIssueSink): void {
    this.checkAuthorization(context, sink);
    this.checkAuthorityLinkage(context, sink, false);
    this.checkLeases(context, sink);
    this.checkWorkflowShape(context, sink);
    this.checkOutboxShape(context, sink, false);
  }

  fullCheck(context: ProjectContext, sink: IntegrityIssueSink): void {
    this.quickCheck(context, sink);
    this.checkAuthorityLinkage(context, sink, true);
    this.checkEvidence(context, sink);
    this.checkApprovalsAndTransfers(context, sink);
    this.checkValidation(context, sink);
    this.checkWorkflowClaims(context, sink);
    this.checkOutboxShape(context, sink, true);
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

  private lifecycleEvents(authority: SqliteRow): readonly LifecycleEventV1[] {
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
    const events: LifecycleEventV1[] = [];
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
      events.push(decodeLifecycleEventV1({
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
    events: readonly LifecycleEventV1[],
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
    const checkpointRequirement = this.checkpointRequirement(events);
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
    events: readonly LifecycleEventV1[],
  ): CheckpointRequirementFold | null {
    let requirement: CheckpointRequirementFold | null = null;
    for (const event of events) {
      switch (event.eventType) {
        case "SessionCheckpointRecorded":
          if (
            requirement !== null
            && BigInt(event.payload.baseEventPosition) >= BigInt(requirement.eventPosition)
          ) requirement = null;
          break;
        case "SessionOwnerTransferred":
          requirement = { reason: "ownership-transfer", eventPosition: event.globalPosition };
          break;
        case "SessionOwnershipRecovered":
          requirement = { reason: "ownership-recovery", eventPosition: event.globalPosition };
          break;
        case "SessionSuspendRequested":
        case "SessionSuspended":
          requirement = { reason: "suspension", eventPosition: event.globalPosition };
          break;
        case "ChildWorkTransferClaimed":
          requirement = { reason: "carry-forward-claim", eventPosition: event.globalPosition };
          break;
        case "SessionEndAmended":
          requirement = { reason: "end-amendment", eventPosition: event.globalPosition };
          break;
        case "SessionEndCancelled":
          requirement = { reason: "end-cancellation", eventPosition: event.globalPosition };
          break;
        default:
          break;
      }
    }
    return requirement;
  }

  private revocation(events: readonly LifecycleEventV1[]): RevocationFold | null {
    let revocation: RevocationFold | null = null;
    for (const event of events) {
      if (event.eventType === "SessionAbandoned") {
        revocation = {
          reason: event.payload.reasonCode,
          eventPosition: event.globalPosition,
          revokedAt: event.occurredAt,
        };
      } else if (
        event.eventType === "SessionSuspended"
        || event.eventType === "ChildSessionSuspended"
      ) {
        revocation = {
          reason: "suspension",
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
      WHERE project_id = $projectId AND session_id IS NOT NULL
    `).all({ $projectId: context.binding.projectId });
    for (const row of rows) {
      const claim = [row.coordinator_owner_id, row.coordinator_claim_token, row.coordinator_claim_expires_at];
      const plan = [row.validation_attempt_plan_generation, row.validation_attempt_plans_json];
      const failure = [row.coordinator_failure_class, row.coordinator_error_code];
      const attemptCount = integer(row.coordinator_attempt_count);
      const claimToken = integer(row.coordinator_claim_token);
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
             created.event_type AS created_event_type,
             created.session_id AS created_event_session_id,
             created.parent_session_id AS created_event_parent_session_id,
             created.payload_json AS created_event_payload_json,
             claimed.event_type AS claimed_event_type,
             claimed.session_id AS claimed_event_session_id,
             claimed.parent_session_id AS claimed_event_parent_session_id,
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
        || row.created_event_type !== "ChildWorkTransferCreated"
        || row.created_event_session_id !== row.source_child_session_id
        || row.created_event_parent_session_id !== row.source_parent_session_id
        || !record(createdPayload)
        || createdPayload.transferTicketId !== row.transfer_ticket_id
        || (claimed.every(present) && (
          row.claimed_event_type !== "ChildWorkTransferClaimed"
          || row.claimed_event_session_id !== row.claimed_child_session_id
          || row.claimed_event_parent_session_id !== row.claimed_by_root_session_id
          || !record(claimedPayload)
          || claimedPayload.transferTicketId !== row.transfer_ticket_id
          || claimedPayload.previousChildSessionId !== row.source_child_session_id
        ))
        || !canonicalJsonText(row.source_assignment_json)
        || !canonicalJsonText(row.source_scope_json)
        || !canonicalJsonText(row.follow_ups_json)
        || !canonicalJsonText(row.source_state_json)
        || !canonicalJsonText(row.lineage_json);
    })) {
      issue(sink, "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH");
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
