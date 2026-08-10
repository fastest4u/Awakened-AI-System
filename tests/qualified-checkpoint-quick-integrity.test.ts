import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, it } from "node:test";

import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import { LifecycleIntegrityService } from "../src/orchestrator/integrity/lifecycle-integrity.service.js";
import type {
  HistoricalEvidenceIntegrityProviderPort,
  IntegrityIssueCode,
} from "../src/orchestrator/integrity/integrity.types.js";
import {
  CHECKPOINT_MAX_CANONICAL_BYTES,
} from "../src/orchestrator/lifecycle/contracts/checkpoint.js";
import {
  authorityCommitment,
  type CommittedAuthorityV1,
} from "../src/orchestrator/lifecycle/authority/authority-commitment.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteStatement,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import {
  childReportFixture,
  checkpointFixture,
  qualifiedCheckpointFixture,
} from "./support/lifecycle-fixtures.js";
import {
  buildLifecycleIntentWitness,
  decodeLifecycleIntentWitness,
} from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { decodeSessionEndEffectiveStateV1 } from "../src/orchestrator/lifecycle/session-end-effective-state.js";
import {
  referenceCheckpointFingerprint,
  referenceMinimumCheckpointUpperBound,
  referenceMinimumFinalEndingScopeBindingsUpperBound,
} from "./support/qualified-checkpoint-reference.js";
import { sessionEndEffectiveStateFixture } from "./support/session-end-effective-state-reference.js";
import {
  referenceAdvanceReportIndexFingerprint,
  referenceChildEventFoldFingerprint,
  referenceReportIndexGenesisFingerprint,
  referenceReportItemSetFingerprint,
  referenceReportWitnessFingerprint,
  referenceWorkflowGenerationFingerprint,
  type ReferenceChildEventFold,
  type ReferenceWorkflowGenerationFold,
} from "./support/lifecycle-projection-reference.js";

const NOW = "2026-07-30T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const ROOT_ID = "44444444-4444-4444-8444-444444444444";
const CHILD_ID = "55555555-5555-4555-8555-555555555555";
const ADAPTER_ID = "66666666-6666-4666-8666-666666666666";
const BATCH_ID = "77777777-7777-4777-8777-777777777777";
const CHECKPOINT_ID = "88888888-8888-4888-8888-888888888888";
const WORKSPACE_ID = "1".repeat(64);
const H64 = "a".repeat(64);
const H64_B = "b".repeat(64);
const roots: string[] = [];
const connections: SqliteConnection[] = [];
const driver = new NodeSqliteDriver({ DatabaseSync });

interface ProviderRecorder {
  readonly provider: HistoricalEvidenceIntegrityProviderPort;
  readonly calls: string[];
  readonly fingerprintCalls: number;
  readonly maximumInFlight: number;
}

interface Fixture {
  readonly connection: SqliteConnection;
  readonly context: ProjectContext;
}

function uuid(index: number): string {
  return `${index.toString(16).padStart(8, "0").slice(-8)}-0000-4000-8000-${
    index.toString(16).padStart(12, "0").slice(-12)
  }`;
}

function rawInsert(
  connection: SqliteConnection,
  table: string,
  values: Readonly<Record<string, SqliteValue>>,
): void {
  const columns = Object.keys(values);
  const params = Object.fromEntries(
    columns.map((column) => [`$${column}`, values[column]!]),
  ) as SqliteParams;
  connection.prepare(`
    INSERT INTO ${table}(${columns.join(", ")})
    VALUES (${columns.map((column) => `$${column}`).join(", ")})
  `).run(params);
}

type PersistedChildProjection = ReferenceChildEventFold & {
  readonly fingerprint: string;
};

type PersistedWorkflowProjection = ReferenceWorkflowGenerationFold & {
  readonly fingerprint: string;
};

function childProjection(
  row: ReferenceChildEventFold,
): PersistedChildProjection {
  return Object.freeze({
    ...row,
    fingerprint: referenceChildEventFoldFingerprint(row),
  });
}

function workflowProjection(
  row: ReferenceWorkflowGenerationFold,
): PersistedWorkflowProjection {
  return Object.freeze({
    ...row,
    fingerprint: referenceWorkflowGenerationFingerprint(row),
  });
}

function insertChildProjection(
  connection: SqliteConnection,
  row: PersistedChildProjection,
): void {
  rawInsert(connection, "lifecycle_child_event_folds", {
    project_id: row.projectId,
    child_session_id: row.childSessionId,
    event_position: row.eventPosition,
    stream_version: row.streamVersion,
    root_session_id: row.rootSessionId,
    child_state: row.childState,
    latest_checkpoint_id: row.latestCheckpointId,
    latest_checkpoint_event_position: row.latestCheckpointEventPosition,
    authority_commitment: row.authorityCommitment,
    terminal_event_type: row.terminalEventType,
    terminal_event_position: row.terminalEventPosition,
    report_count: row.reportCount,
    latest_report_id: row.latestReportId,
    report_index_fingerprint: row.reportIndexFingerprint,
    completion_report_id: row.completionReportId,
    reported_report_id: row.reportedReportId,
    reported_item_count: row.reportedItemCount,
    reported_item_set_fingerprint: row.reportedItemSetFingerprint,
    previous_fingerprint: row.previousFingerprint,
    fingerprint: row.fingerprint,
  });
}

function insertWorkflowProjection(
  connection: SqliteConnection,
  row: PersistedWorkflowProjection,
): void {
  rawInsert(connection, "lifecycle_workflow_generation_folds", {
    project_id: row.projectId,
    workflow_id: row.workflowId,
    workflow_generation: row.workflowGeneration,
    session_id: row.sessionId,
    trigger_event_position: row.triggerEventPosition,
    root_command_id: row.rootCommandId,
    evidence_window_state: row.evidenceWindowState,
    replacement_checkpoint_version: row.replacementCheckpointVersion,
    effective_checkpoint_version: row.effectiveCheckpointVersion,
    effective_draft_source_event_position: row.effectiveDraftSourceEventPosition,
    previous_fingerprint: row.previousFingerprint,
    fingerprint: row.fingerprint,
  });
}

function genesisChildProjection(
  childSessionId: string,
  eventPosition: bigint,
  authority: string,
): PersistedChildProjection {
  return childProjection({
    projectId: PROJECT_ID,
    childSessionId,
    eventPosition,
    streamVersion: 1n,
    rootSessionId: ROOT_ID,
    childState: "active",
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    authorityCommitment: authority,
    terminalEventType: null,
    terminalEventPosition: null,
    reportCount: 0,
    latestReportId: null,
    reportIndexFingerprint: referenceReportIndexGenesisFingerprint(
      PROJECT_ID,
      childSessionId,
    ),
    completionReportId: null,
    reportedReportId: null,
    reportedItemCount: null,
    reportedItemSetFingerprint: null,
    previousFingerprint: null,
  });
}

function carriedChildProjection(
  previous: PersistedChildProjection,
  input: {
    readonly eventPosition: bigint;
    readonly streamVersion: bigint;
    readonly childState?: PersistedChildProjection["childState"];
    readonly latestCheckpointId?: string | null;
    readonly latestCheckpointEventPosition?: bigint | null;
    readonly authorityCommitment?: string;
    readonly terminalEventType?: PersistedChildProjection["terminalEventType"];
    readonly terminalEventPosition?: bigint | null;
    readonly completionReportId?: string | null;
  },
): PersistedChildProjection {
  return childProjection({
    projectId: previous.projectId,
    childSessionId: previous.childSessionId,
    eventPosition: input.eventPosition,
    streamVersion: input.streamVersion,
    rootSessionId: previous.rootSessionId,
    childState: input.childState ?? previous.childState,
    latestCheckpointId: input.latestCheckpointId === undefined
      ? previous.latestCheckpointId
      : input.latestCheckpointId,
    latestCheckpointEventPosition:
      input.latestCheckpointEventPosition === undefined
        ? previous.latestCheckpointEventPosition
        : input.latestCheckpointEventPosition,
    authorityCommitment: input.authorityCommitment ?? previous.authorityCommitment,
    terminalEventType: input.terminalEventType === undefined
      ? previous.terminalEventType
      : input.terminalEventType,
    terminalEventPosition: input.terminalEventPosition === undefined
      ? previous.terminalEventPosition
      : input.terminalEventPosition,
    reportCount: previous.reportCount,
    latestReportId: previous.latestReportId,
    reportIndexFingerprint: previous.reportIndexFingerprint,
    completionReportId: input.completionReportId === undefined
      ? previous.completionReportId
      : input.completionReportId,
    reportedReportId: null,
    reportedItemCount: null,
    reportedItemSetFingerprint: null,
    previousFingerprint: previous.fingerprint,
  });
}

function reportedChildProjection(
  previous: PersistedChildProjection,
  input: {
    readonly eventPosition: bigint;
    readonly streamVersion: bigint;
    readonly reportId: string;
    readonly allReportItemIds: readonly string[];
  },
): PersistedChildProjection {
  const reportedItemSetFingerprint = referenceReportItemSetFingerprint({
    projectId: previous.projectId,
    childSessionId: previous.childSessionId,
    reportId: input.reportId,
    allReportItemIds: input.allReportItemIds,
  });
  const witnessInput: ReferenceChildEventFold = {
    projectId: previous.projectId,
    childSessionId: previous.childSessionId,
    eventPosition: input.eventPosition,
    streamVersion: input.streamVersion,
    rootSessionId: previous.rootSessionId,
    childState: previous.childState,
    latestCheckpointId: previous.latestCheckpointId,
    latestCheckpointEventPosition: previous.latestCheckpointEventPosition,
    authorityCommitment: previous.authorityCommitment,
    terminalEventType: previous.terminalEventType,
    terminalEventPosition: previous.terminalEventPosition,
    reportCount: previous.reportCount + 1,
    latestReportId: input.reportId,
    reportIndexFingerprint: "",
    completionReportId: previous.completionReportId,
    reportedReportId: input.reportId,
    reportedItemCount: input.allReportItemIds.length,
    reportedItemSetFingerprint,
    previousFingerprint: previous.fingerprint,
  };
  return childProjection({
    ...witnessInput,
    reportIndexFingerprint: referenceAdvanceReportIndexFingerprint({
      projectId: previous.projectId,
      childSessionId: previous.childSessionId,
      reportCount: witnessInput.reportCount,
      latestReportId: input.reportId,
      previousReportIndexFingerprint: previous.reportIndexFingerprint,
      reportWitnessFingerprint: referenceReportWitnessFingerprint(witnessInput),
    }),
  });
}

function rawEvent(
  connection: SqliteConnection,
  input: {
    readonly globalPosition: bigint;
    readonly streamId: string;
    readonly streamVersion: bigint;
    readonly eventType: string;
    readonly eventSchemaVersion: number;
    readonly sessionId: string;
    readonly parentSessionId?: string | null;
    readonly payload: unknown;
    readonly lifecycleIntent?: string | null;
    readonly idempotencyKey?: string;
  },
): void {
  const offset = Number(input.globalPosition % 100_000n);
  rawInsert(connection, "events", {
    global_position: input.globalPosition,
    event_id: uuid(10_000 + offset),
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: WORKSPACE_ID,
    branch_scope_id: null,
    branch_ref: null,
    stream_id: input.streamId,
    stream_type: "session",
    stream_version: input.streamVersion,
    event_type: input.eventType,
    event_schema_version: input.eventSchemaVersion,
    session_id: input.sessionId,
    parent_session_id: input.parentSessionId ?? null,
    actor_role: "primary",
    agent_id: "agent-quick-integrity",
    client_instance_id: "client-quick-integrity",
    correlation_id: input.sessionId,
    causation_id: null,
    command_id: uuid(30_000 + offset),
    idempotency_key: input.idempotencyKey ?? `quick-integrity/${input.globalPosition}`,
    command_event_index: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: canonicalJson(input.payload),
    payload_hash: H64,
    previous_global_hash: H64_B,
    event_hash: H64,
    lifecycle_intent_json: input.lifecycleIntent ?? null,
  });
}

function forkPayload(authority: string): Record<string, unknown> {
  return {
    parentSessionId: ROOT_ID,
    assignment: {
      assignmentId: uuid(55_001),
      summary: "Quick-integrity child",
      scope: "tests/qualified-checkpoint-quick-integrity.test.ts",
    },
    rootOwnerGeneration: 1,
    directAccessEnabled: true,
    authorityCommitment: authority,
    sourceTransferTicketId: null,
  };
}

function rootAuthority(
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  const row: Record<string, SqliteValue> = {
    project_id: PROJECT_ID,
    session_id: ROOT_ID,
    stream_id: `session/${ROOT_ID}`,
    session_kind: "root",
    parent_session_id: null,
    workspace_id: WORKSPACE_ID,
    client_namespace: "tests",
    semantic_state: "active",
    owner_generation: 1,
    child_capability_generation: null,
    direct_access_enabled: 0,
    continuity_fingerprint_algorithm: "hmac-sha256",
    continuity_fingerprint_schema_version: 1,
    continuity_fingerprint_key_id: "continuity-key",
    continuity_fingerprint_domain: "pm-continuity-v1",
    continuity_fingerprint: H64,
    root_handle_capability_version: 1,
    root_handle_key_id: "root-key",
    root_handle_issue_nonce: H64,
    root_handle_issued_at: NOW,
    root_handle_policy_code: "root-default-v1",
    root_handle_expiry_kind: "until-revoked",
    root_handle_expires_at: null,
    root_handle_actor_role: "primary",
    root_handle_client_instance_id: "client-quick-integrity",
    root_handle_verifier: H64,
    root_handle_issuance_id: uuid(40_001),
    resume_token_capability_version: 1,
    resume_token_key_id: "resume-key",
    resume_token_issue_nonce: H64_B,
    resume_token_issued_at: NOW,
    resume_token_policy_code: "resume-default-v1",
    resume_token_expiry_kind: "until-revoked",
    resume_token_expires_at: null,
    resume_token_actor_role: "primary",
    resume_token_verifier: H64_B,
    resume_token_issuance_id: uuid(40_002),
    child_handle_capability_version: null,
    child_handle_key_id: null,
    child_handle_issue_nonce: null,
    child_handle_issued_at: null,
    child_handle_policy_code: null,
    child_handle_expiry_kind: null,
    child_handle_expires_at: null,
    child_handle_actor_role: null,
    child_handle_client_instance_id: null,
    child_handle_verifier: null,
    child_handle_issuance_id: null,
    authority_commitment: H64,
    authority_event_position: 1,
    latest_checkpoint_id: null,
    latest_checkpoint_event_position: null,
    latest_checkpoint_fingerprint: null,
    checkpoint_required_reason: null,
    checkpoint_required_event_position: null,
    revocation_reason_code: null,
    revocation_event_position: null,
    revoked_at: null,
    terminal_event_position: null,
    terminal_event_type: null,
    terminal_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  row.authority_commitment = commitmentForRow(row);
  return row;
}

function commitmentForRow(row: Readonly<Record<string, SqliteValue>>): string {
  const text = (name: string): string | null => row[name] as string | null;
  const number = (name: string): number | null => {
    const value = row[name];
    return value === null ? null : Number(value);
  };
  const decimal = (name: string): string | null => {
    const value = row[name];
    return value === null ? null : String(value);
  };
  return authorityCommitment({
    authorityVersion: 1,
    projectId: String(row.project_id),
    sessionId: String(row.session_id),
    sessionKind: row.session_kind as CommittedAuthorityV1["sessionKind"],
    parentSessionId: text("parent_session_id"),
    workspaceId: String(row.workspace_id),
    clientNamespace: String(row.client_namespace),
    ownerGeneration: decimal("owner_generation"),
    childCapabilityGeneration: decimal("child_capability_generation"),
    directAccessEnabled: row.direct_access_enabled === 1,
    continuityFingerprintAlgorithm: text("continuity_fingerprint_algorithm"),
    continuityFingerprintSchemaVersion: number("continuity_fingerprint_schema_version"),
    continuityFingerprintKeyId: text("continuity_fingerprint_key_id"),
    continuityFingerprintDomain: text("continuity_fingerprint_domain"),
    continuityFingerprint: text("continuity_fingerprint"),
    rootHandleCapabilityVersion: number("root_handle_capability_version"),
    rootHandleKeyId: text("root_handle_key_id"),
    rootHandleIssueNonce: text("root_handle_issue_nonce"),
    rootHandleIssuedAt: text("root_handle_issued_at"),
    rootHandlePolicyCode: text("root_handle_policy_code"),
    rootHandleExpiryKind: text("root_handle_expiry_kind") as CommittedAuthorityV1["rootHandleExpiryKind"],
    rootHandleExpiresAt: text("root_handle_expires_at"),
    rootHandleActorRole: text("root_handle_actor_role") as CommittedAuthorityV1["rootHandleActorRole"],
    rootHandleClientInstanceId: text("root_handle_client_instance_id"),
    rootHandleVerifier: text("root_handle_verifier"),
    resumeTokenCapabilityVersion: number("resume_token_capability_version"),
    resumeTokenKeyId: text("resume_token_key_id"),
    resumeTokenIssueNonce: text("resume_token_issue_nonce"),
    resumeTokenIssuedAt: text("resume_token_issued_at"),
    resumeTokenPolicyCode: text("resume_token_policy_code"),
    resumeTokenExpiryKind: text("resume_token_expiry_kind") as CommittedAuthorityV1["resumeTokenExpiryKind"],
    resumeTokenExpiresAt: text("resume_token_expires_at"),
    resumeTokenActorRole: text("resume_token_actor_role") as CommittedAuthorityV1["resumeTokenActorRole"],
    resumeTokenVerifier: text("resume_token_verifier"),
    childHandleCapabilityVersion: number("child_handle_capability_version"),
    childHandleKeyId: text("child_handle_key_id"),
    childHandleIssueNonce: text("child_handle_issue_nonce"),
    childHandleIssuedAt: text("child_handle_issued_at"),
    childHandlePolicyCode: text("child_handle_policy_code"),
    childHandleExpiryKind: text("child_handle_expiry_kind") as CommittedAuthorityV1["childHandleExpiryKind"],
    childHandleExpiresAt: text("child_handle_expires_at"),
    childHandleActorRole: text("child_handle_actor_role") as CommittedAuthorityV1["childHandleActorRole"],
    childHandleClientInstanceId: text("child_handle_client_instance_id"),
    childHandleVerifier: text("child_handle_verifier"),
    revocationReasonCode: text("revocation_reason_code"),
    revocationEventPosition: decimal("revocation_event_position"),
    revokedAt: text("revoked_at"),
    terminalEventPosition: decimal("terminal_event_position"),
    terminalEventType: text("terminal_event_type"),
    terminalAt: text("terminal_at"),
  });
}

function childAuthority(
  sessionId: string,
  authorityPosition: bigint,
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  const row = rootAuthority();
  for (const column of [
    "continuity_fingerprint_algorithm",
    "continuity_fingerprint_schema_version",
    "continuity_fingerprint_key_id",
    "continuity_fingerprint_domain",
    "continuity_fingerprint",
    "root_handle_capability_version",
    "root_handle_key_id",
    "root_handle_issue_nonce",
    "root_handle_issued_at",
    "root_handle_policy_code",
    "root_handle_expiry_kind",
    "root_handle_expires_at",
    "root_handle_actor_role",
    "root_handle_client_instance_id",
    "root_handle_verifier",
    "root_handle_issuance_id",
    "resume_token_capability_version",
    "resume_token_key_id",
    "resume_token_issue_nonce",
    "resume_token_issued_at",
    "resume_token_policy_code",
    "resume_token_expiry_kind",
    "resume_token_expires_at",
    "resume_token_actor_role",
    "resume_token_verifier",
    "resume_token_issuance_id",
  ]) row[column] = null;
  const child: Record<string, SqliteValue> = {
    ...row,
    session_id: sessionId,
    stream_id: `session/${sessionId}`,
    session_kind: "child",
    parent_session_id: ROOT_ID,
    owner_generation: null,
    child_capability_generation: 1,
    direct_access_enabled: 1,
    child_handle_capability_version: 1,
    child_handle_key_id: "child-key",
    child_handle_issue_nonce: H64,
    child_handle_issued_at: NOW,
    child_handle_policy_code: "child-default-v1",
    child_handle_expiry_kind: "absolute",
    child_handle_expires_at: "2026-08-30T00:00:00.000Z",
    child_handle_actor_role: "untrusted",
    child_handle_client_instance_id: "child-client",
    child_handle_verifier: H64,
    child_handle_issuance_id: uuid(50_000 + Number(authorityPosition % 10_000n)),
    authority_event_position: authorityPosition,
    ...overrides,
  };
  child.authority_commitment = commitmentForRow(child);
  return child;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "qualified-quick-integrity-"));
  roots.push(root);
  const connection = driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: 1_000,
  });
  connections.push(connection);
  applyCurrentProjectStoreSchema(connection, {
    projectId: PROJECT_ID as never,
    vaultId: VAULT_ID as never,
    storeId: STORE_ID as never,
  }, NOW);
  connection.prepare(`
    INSERT INTO streams(
      project_id, stream_id, stream_type, current_version, created_at, updated_at
    ) VALUES ($projectId, $streamId, 'session', 1, $now, $now)
  `).run({
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
    $now: NOW,
  });
  const rootRow = rootAuthority();
  rawEvent(connection, {
    globalPosition: 1n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 1n,
    eventType: "SessionStarted",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    payload: { authorityCommitment: rootRow.authority_commitment },
  });
  rawInsert(connection, "session_authority", rootRow);
  const context = {
    binding: {
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "tests",
      actorRole: "primary",
      clientInstanceId: "client-quick-integrity",
    },
  } as ProjectContext;
  return { connection, context };
}

function seedSchema4LifetimeHistory(
  fixture: Fixture,
  input: {
    readonly directChildren: number;
    readonly sourceTickets: number;
    readonly bypassChildCap?: boolean;
    readonly bypassTicketCap?: boolean;
  },
): void {
  fixture.connection.exec("PRAGMA foreign_keys = OFF");
  fixture.connection.exec("DROP TRIGGER session_authority_insert_guard");
  fixture.connection.exec("DROP TRIGGER child_transfer_tickets_insert_guard");
  if (input.bypassChildCap === true) {
    fixture.connection.exec("DROP TRIGGER session_authority_child_history_v4_insert_guard");
  }
  if (input.bypassTicketCap === true) {
    fixture.connection.exec("DROP TRIGGER child_transfer_tickets_history_v4_insert_guard");
  }
  fixture.connection.exec("BEGIN");
  try {
    for (let index = 1; index <= input.directChildren; index += 1) {
      const sessionId = uuid(200_000 + index);
      const position = BigInt(10_000 + index);
      const authority = childAuthority(sessionId, position, {
        semantic_state: "completed",
        terminal_event_position: position,
        terminal_event_type: "ChildSessionCompleted",
        terminal_at: NOW,
      });
      rawEvent(fixture.connection, {
        globalPosition: position,
        streamId: `session/${sessionId}`,
        streamVersion: 1n,
        eventType: "SessionForked",
        eventSchemaVersion: 1,
        sessionId,
        parentSessionId: ROOT_ID,
        payload: {
          ...forkPayload(String(authority.authority_commitment)),
          assignment: {
            assignmentId: uuid(500_000 + index),
            summary: `Lifetime child ${index}`,
            scope: "tests/qualified-checkpoint-quick-integrity.test.ts",
          },
        },
      });
      rawInsert(fixture.connection, "session_authority", authority);
    }
    for (let index = 1; index <= input.sourceTickets; index += 1) {
      rawInsert(fixture.connection, "child_transfer_tickets", {
        project_id: PROJECT_ID,
        transfer_ticket_id: uuid(300_000 + index),
        source_parent_session_id: ROOT_ID,
        source_child_session_id: uuid(200_000 + index),
        source_assignment_json: "{}",
        source_scope_json: "{}",
        checkpoint_id: uuid(400_000 + index),
        follow_ups_json: "[]",
        source_state_json: "{}",
        lineage_json: "{}",
        created_event_position: 10_000 + index,
        created_at: NOW,
        claimed_by_root_session_id: ROOT_ID,
        claimed_child_session_id: uuid(600_000 + index),
        claimed_event_position: 20_000 + index,
        claimed_at: NOW,
      });
    }
    fixture.connection.exec("COMMIT");
  } catch (error) {
    fixture.connection.exec("ROLLBACK");
    throw error;
  } finally {
    fixture.connection.exec("PRAGMA foreign_keys = ON");
  }
}

function addSchema4TerminalLifecycleOutbox(fixture: Fixture): string {
  const abandoned = rootAuthority({
    semantic_state: "abandoned",
    authority_event_position: 2,
    revocation_reason_code: "direct-abandon",
    revocation_event_position: 2,
    revoked_at: NOW,
    terminal_event_position: 2,
    terminal_event_type: "SessionAbandoned",
    terminal_at: NOW,
  });
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionAbandoned",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    payload: {
      workflowId: null,
      workflowGeneration: null,
      approvalId: uuid(700_001),
      preTransitionCheckpointId: uuid(700_002),
      reasonCode: "direct-abandon",
      authorityCommitment: abandoned.authority_commitment,
    },
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 2, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET semantic_state = 'abandoned',
        authority_commitment = $authorityCommitment,
        authority_event_position = 2,
        revocation_reason_code = 'direct-abandon',
        revocation_event_position = 2,
        revoked_at = $now,
        terminal_event_position = 2,
        terminal_event_type = 'SessionAbandoned',
        terminal_at = $now,
        updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $authorityCommitment: abandoned.authority_commitment,
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
  const targetKey = `lifecycle-log/${ROOT_ID}/2`;
  const artifactPath = `05_Agent_Session_Logs/2026-07-30-session-${ROOT_ID}.md`;
  rawInsert(fixture.connection, "outbox", {
    project_id: PROJECT_ID,
    target_key: targetKey,
    event_position: 2,
    kind: "materialize-lifecycle-log",
    payload_json: canonicalJson({
      payloadVersion: 1,
      targetKey,
      sessionId: ROOT_ID,
      artifactKind: "compatibility-session-log",
      artifactPath,
      materializationRevision: "2",
      triggeringPayloadHash: H64,
      nextFingerprint: {
        algorithm: "hmac-sha256",
        schemaVersion: 1,
        keyId: "materialization-key",
        domain: "pm-materialization-fingerprint-v1",
        value: H64_B,
      },
      origin: {
        kind: "terminal-event",
        workflowId: null,
        workflowGeneration: null,
      },
      triggeringEventType: "SessionAbandoned",
    }),
    content_hash: H64,
    status: "pending",
    attempt_count: 0,
    claim_owner: null,
    claim_token: null,
    claim_expires_at: null,
    created_at: NOW,
    updated_at: NOW,
    session_id: ROOT_ID,
    origin_kind: "terminal-event",
    workflow_id: null,
    workflow_generation: null,
    artifact_kind: "compatibility-session-log",
    artifact_path: artifactPath,
    materialization_revision: 2,
    expected_prior_fingerprint: null,
    next_fingerprint: H64_B,
    fingerprint_algorithm: "hmac-sha256",
    fingerprint_schema_version: 1,
    fingerprint_key_id: "materialization-key",
    fingerprint_domain: "pm-materialization-fingerprint-v1",
    failure_class: null,
    safe_error_code: null,
    next_attempt_at: null,
  });
  return targetKey;
}

function dropSchema4OutboxMutationGuards(connection: SqliteConnection): void {
  for (const trigger of [
    "outbox_lifecycle_descriptor_v4_update_guard",
    "outbox_lifecycle_update_guard",
    "outbox_lifecycle_planned_immutable",
  ]) connection.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
}

function addGenericOutbox(fixture: Fixture): string {
  const targetKey = "generic/root-started";
  rawInsert(fixture.connection, "outbox", {
    project_id: PROJECT_ID,
    target_key: targetKey,
    event_position: 1,
    kind: "generic",
    payload_json: "{}",
    content_hash: H64,
    status: "pending",
    attempt_count: 0,
    claim_owner: null,
    claim_token: null,
    claim_expires_at: null,
    created_at: NOW,
    updated_at: NOW,
    session_id: null,
    origin_kind: null,
    workflow_id: null,
    workflow_generation: null,
    artifact_kind: null,
    artifact_path: null,
    materialization_revision: null,
    expected_prior_fingerprint: null,
    next_fingerprint: null,
    fingerprint_algorithm: null,
    fingerprint_schema_version: null,
    fingerprint_key_id: null,
    fingerprint_domain: null,
    failure_class: null,
    safe_error_code: null,
    next_attempt_at: null,
  });
  return targetKey;
}

function directOutboxShapeIssues(
  fixture: Fixture,
  full: boolean,
): readonly IntegrityIssueCode[] {
  const issues: IntegrityIssueCode[] = [];
  const service = new LifecycleIntegrityService(fixture.connection);
  const target = service as unknown as {
    checkOutboxShape(
      context: ProjectContext,
      sink: { add(code: IntegrityIssueCode): void },
      full: boolean,
    ): void;
  };
  target.checkOutboxShape(fixture.context, {
    add(code) { issues.push(code); },
  }, full);
  return issues;
}

function directWorkflowShapeIssues(
  fixture: Fixture,
  qualifiedEndpointOnly: boolean,
): readonly IntegrityIssueCode[] {
  const issues: IntegrityIssueCode[] = [];
  const service = new LifecycleIntegrityService(fixture.connection);
  const target = service as unknown as {
    checkWorkflowShape(
      context: ProjectContext,
      sink: { add(code: IntegrityIssueCode): void },
      qualifiedEndpointOnly: boolean,
    ): void;
  };
  target.checkWorkflowShape(fixture.context, {
    add(code) { issues.push(code); },
  }, qualifiedEndpointOnly);
  return issues;
}

function updateSchema4OutboxColumn(
  fixture: Fixture,
  targetKey: string,
  column: string,
  value: SqliteValue,
): void {
  fixture.connection.prepare(`
    UPDATE outbox SET ${column} = $value
    WHERE project_id = $projectId AND target_key = $targetKey
  `).run({ $value: value, $projectId: PROJECT_ID, $targetKey: targetKey });
}

function updateSchema4OutboxPayload(
  fixture: Fixture,
  targetKey: string,
  mutate: (payload: Record<string, unknown>) => void,
  canonical = true,
): void {
  const row = fixture.connection.prepare(`
    SELECT payload_json FROM outbox
    WHERE project_id = $projectId AND target_key = $targetKey
  `).get({ $projectId: PROJECT_ID, $targetKey: targetKey });
  assert.equal(typeof row?.payload_json, "string");
  const payload = JSON.parse(String(row!.payload_json)) as Record<string, unknown>;
  mutate(payload);
  const encoded = canonical
    ? canonicalJson(payload)
    : JSON.stringify(Object.fromEntries(Object.entries(payload).reverse()));
  updateSchema4OutboxColumn(fixture, targetKey, "payload_json", encoded);
}

function createSchema2Fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "qualified-quick-integrity-v2-"));
  roots.push(root);
  const connection = driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: 1_000,
  });
  connections.push(connection);
  const runner = new MigrationRunner();
  runner.apply(connection, [PROJECT_STORE_MIGRATIONS[0]!], NOW, {
    kind: "bootstrap-empty",
    beforeMigration() {},
  });
  connection.prepare(`
    INSERT INTO project_meta(
      singleton, project_id, vault_id, store_id, schema_version, created_at
    ) VALUES (1, $projectId, $vaultId, $storeId, 1, $createdAt)
  `).run({
    $projectId: PROJECT_ID,
    $vaultId: VAULT_ID,
    $storeId: STORE_ID,
    $createdAt: NOW,
  });
  connection.exec(`
    INSERT INTO maintenance_state(
      singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
    ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
  `);
  runner.apply(connection, PROJECT_STORE_MIGRATIONS.slice(0, 2), NOW, {
    kind: "explicit-upgrade",
    expectedAppliedVersion: 1,
    beforeMigration() {},
  });
  rawInsert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${ROOT_ID}`,
    stream_type: "session",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  const rootRow = rootAuthority();
  rawEvent(connection, {
    globalPosition: 1n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 1n,
    eventType: "SessionStarted",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    payload: { authorityCommitment: rootRow.authority_commitment },
  });
  rawInsert(connection, "session_authority", rootRow);
  return {
    connection,
    context: {
      binding: {
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
        workspaceId: WORKSPACE_ID,
        clientNamespace: "tests",
        actorRole: "primary",
        clientInstanceId: "client-quick-integrity",
      },
    } as ProjectContext,
  };
}

function seedSchema2OpenWorkflow(fixture: Fixture): string {
  const workflowId = uuid(89_090);
  const commandId = uuid(30_002);
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: {
      workflowId,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
      requestVersion: 2,
    },
    lifecycleIntent: requestWitness(2, commandId),
    idempotencyKey: "quick-integrity/end-request/2",
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 2, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  rawInsert(fixture.connection, "workflow_instances", {
    project_id: PROJECT_ID,
    workflow_id: workflowId,
    workflow_type: "session-end",
    generation: 1,
    state: "active",
    phase: "requested",
    root_command_id: commandId,
    result_json: null,
    error_code: null,
    created_at: NOW,
    updated_at: NOW,
    session_id: ROOT_ID,
    triggering_event_position: 2,
    expected_authority_commitment: rootAuthority().authority_commitment,
    coordinator_owner_id: null,
    coordinator_claim_token: null,
    coordinator_claim_expires_at: null,
    coordinator_attempt_count: 0,
    coordinator_failure_class: null,
    coordinator_error_code: null,
    coordinator_next_attempt_at: null,
    validation_attempt_plan_generation: null,
    validation_attempt_plans_json: null,
  });
  return workflowId;
}

function evidencePayload(
  adapterSessionId: string,
  batchId: string,
  keyId: string,
  fingerprint: string,
): Record<string, unknown> {
  return {
    adapterSessionId,
    batchId,
    batchFirstOrdinal: "0",
    batchLastOrdinal: "0",
    coverageFirstOrdinal: "0",
    coverageLastOrdinal: "0",
    highestContiguousOrdinal: "0",
    missingIntervals: [],
    frameFingerprintAlgorithm: "hmac-sha256",
    frameFingerprintSchemaVersion: 1,
    frameFingerprintKeyId: keyId,
    frameFingerprintDomain: "pm-evidence-frame-v1",
    coverageFingerprintAlgorithm: "hmac-sha256",
    coverageFingerprintSchemaVersion: 1,
    coverageFingerprintKeyId: keyId,
    coverageFingerprintDomain: "pm-evidence-coverage-v1",
    coverageFingerprint: fingerprint,
    captureMode: "coverage-only",
    contentRetained: false,
    frames: [{
      frameId: uuid(60_000 + Number(BigInt(`0x${adapterSessionId.slice(0, 8)}`) % 1_000n)),
      ordinal: "0",
      sourceKind: "model-turn",
      observedAt: NOW,
      contentFingerprint: H64_B,
    }],
  };
}

function seedCoverage(
  fixture: Fixture,
  input: {
    readonly sessionId?: string;
    readonly adapterSessionId?: string;
    readonly batchId?: string;
    readonly keyId?: string;
    readonly fingerprint?: string;
    readonly position?: bigint;
    readonly streamVersion?: bigint;
    readonly previousFingerprint?: string | null;
  } = {},
): void {
  const sessionId = input.sessionId ?? ROOT_ID;
  const adapterSessionId = input.adapterSessionId ?? ADAPTER_ID;
  const batchId = input.batchId ?? BATCH_ID;
  const keyId = input.keyId ?? "key-a";
  const fingerprint = input.fingerprint ?? H64;
  const position = input.position ?? 2n;
  const streamVersion = input.streamVersion ?? 2n;
  const payload = evidencePayload(adapterSessionId, batchId, keyId, fingerprint);
  fixture.connection.prepare(`
    UPDATE streams SET current_version = $version, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $version: streamVersion,
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${sessionId}`,
  });
  rawEvent(fixture.connection, {
    globalPosition: position,
    streamId: `session/${sessionId}`,
    streamVersion,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    sessionId,
    parentSessionId: sessionId === ROOT_ID ? null : ROOT_ID,
    payload,
  });
  fixture.connection.exec("BEGIN IMMEDIATE");
  try {
    rawInsert(fixture.connection, "session_evidence_coverage_transitions", {
    project_id: PROJECT_ID,
    session_id: sessionId,
    adapter_session_id: adapterSessionId,
    batch_id: batchId,
    batch_event_position: position,
    batch_first_ordinal: 0,
    batch_last_ordinal: 0,
    coverage_first_ordinal: 0,
    coverage_last_ordinal: 0,
    highest_contiguous_ordinal: 0,
    missing_intervals_json: "[]",
    frame_fingerprint_algorithm: "hmac-sha256",
    frame_fingerprint_schema_version: 1,
    frame_fingerprint_key_id: keyId,
    frame_fingerprint_domain: "pm-evidence-frame-v1",
    previous_coverage_fingerprint_value: input.previousFingerprint ?? null,
    coverage_fingerprint_algorithm: "hmac-sha256",
    coverage_fingerprint_schema_version: 1,
    coverage_fingerprint_key_id: keyId,
    coverage_fingerprint_domain: "pm-evidence-coverage-v1",
    coverage_fingerprint_value: fingerprint,
    new_frame_count: 1,
    capture_mode: "coverage-only",
    content_retained: 0,
    created_at: NOW,
    });
    rawInsert(fixture.connection, "session_evidence_coverage", {
    project_id: PROJECT_ID,
    session_id: sessionId,
    adapter_session_id: adapterSessionId,
    capture_mode: "coverage-only",
    first_ordinal: 0,
    last_ordinal: 0,
    highest_contiguous_ordinal: 0,
    missing_intervals_json: "[]",
    fingerprint_algorithm: "hmac-sha256",
    fingerprint_schema_version: 1,
    fingerprint_key_id: keyId,
    fingerprint_domain: "pm-evidence-frame-v1",
    latest_batch_id: batchId,
    latest_batch_event_position: position,
    created_at: NOW,
    updated_at: NOW,
    coverage_fingerprint_algorithm: "hmac-sha256",
    coverage_fingerprint_schema_version: 1,
    coverage_fingerprint_key_id: keyId,
    coverage_fingerprint_domain: "pm-evidence-coverage-v1",
    coverage_fingerprint_value: fingerprint,
    });
    const frame = (payload.frames as readonly Record<string, unknown>[])[0]!;
    rawInsert(fixture.connection, "session_evidence_fingerprints", {
    project_id: PROJECT_ID,
    session_id: sessionId,
    adapter_session_id: adapterSessionId,
    ordinal: 0,
    frame_id: String(frame.frameId),
    source_kind: "model-turn",
    observed_at: NOW,
    fingerprint_algorithm: "hmac-sha256",
    fingerprint_schema_version: 1,
    fingerprint_key_id: keyId,
    fingerprint_domain: "pm-evidence-frame-v1",
    fingerprint_value: H64_B,
    batch_id: batchId,
    recorded_event_position: position,
      created_at: NOW,
    });
    fixture.connection.exec("COMMIT");
  } catch (error) {
    fixture.connection.exec("ROLLBACK");
    throw error;
  }
}

function providerRecorder(
  statuses: Readonly<Record<string, "available" | "revoked" | "unavailable">> = {},
): ProviderRecorder {
  const calls: string[] = [];
  let fingerprintCalls = 0;
  let inFlight = 0;
  let maximumInFlight = 0;
  return {
    provider: {
      async status(keyId) {
        calls.push(keyId);
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return statuses[keyId] ?? "available";
      },
      async fingerprint() {
        fingerprintCalls += 1;
        return H64;
      },
    },
    calls,
    get fingerprintCalls() { return fingerprintCalls; },
    get maximumInFlight() { return maximumInFlight; },
  };
}

function observedConnection(connection: SqliteConnection): {
  readonly connection: SqliteConnection;
  readonly ordinalReads: () => number;
  readonly frameElementReads: () => number;
  readonly fullStreamFolds: () => number;
  readonly lifecycleHistoryScans: () => number;
  readonly childProjectionTargetReads: () => number;
  readonly childProjectionPredecessorReads: () => number;
  readonly reportWitnessReads: () => number;
  readonly workflowProjectionReads: () => number;
  readonly unboundedLifetimeReads: () => number;
  readonly unboundedOutboxReads: () => number;
  readonly unboundedTransitionReads: () => number;
  readonly incompleteArtifactProbes: () => number;
  readonly writes: () => number;
} {
  let ordinalReads = 0;
  let frameElementReads = 0;
  let fullStreamFolds = 0;
  let lifecycleHistoryScans = 0;
  let childProjectionTargetReads = 0;
  let childProjectionPredecessorReads = 0;
  let reportWitnessReads = 0;
  let workflowProjectionReads = 0;
  let unboundedLifetimeReads = 0;
  let unboundedOutboxReads = 0;
  let unboundedTransitionReads = 0;
  let incompleteArtifactProbes = 0;
  let writes = 0;
  const inspect = (sql: string): void => {
    if (/session_evidence_fingerprints/i.test(sql)) ordinalReads += 1;
    if (/json_(?:each|tree)\s*\([^)]*frames/i.test(sql)) frameElementReads += 1;
    if (
      /FROM\s+events/i.test(sql)
      && /WHERE\s+project_id\s*=\s*\$projectId\s+AND\s+stream_id\s*=\s*\$streamId/i.test(sql)
      && /ORDER\s+BY\s+stream_version/i.test(sql)
      && !/stream_version\s*<=\s*\$maxStreamVersion/i.test(sql)
      && !(
        /stream_version\s*<=\s*\$triggeringStreamVersion/i.test(sql)
        && /LIMIT\s+\$generation/i.test(sql)
      )
    ) fullStreamFolds += 1;
    if (
      /FROM\s+events/i.test(sql)
      && /ORDER\s+BY\s+stream_version/i.test(sql)
      && (
        /stream_version\s*<=\s*\$maxStreamVersion/i.test(sql)
        || /stream_version\s*<=\s*\$triggeringStreamVersion/i.test(sql)
      )
    ) lifecycleHistoryScans += 1;
    if (/FROM\s+lifecycle_child_event_folds/i.test(sql)) {
      if (/reported_report_id\s*=\s*\$reportId/i.test(sql)) {
        reportWitnessReads += 1;
      } else if (/event_position\s*=\s*\$eventPosition/i.test(sql)) {
        childProjectionTargetReads += 1;
      } else if (/stream_version\s*=\s*\$streamVersion/i.test(sql)) {
        childProjectionPredecessorReads += 1;
      }
      if (/ORDER\s+BY|OFFSET|WITH\s+RECURSIVE/i.test(sql)) {
        lifecycleHistoryScans += 1;
      }
    }
    if (
      /FROM\s+lifecycle_workflow_generation_folds/i.test(sql)
      || /legacy-workflow-projection/i.test(sql)
    ) {
      workflowProjectionReads += 1;
      if (/ORDER\s+BY|OFFSET|WITH\s+RECURSIVE/i.test(sql)) {
        lifecycleHistoryScans += 1;
      }
    }
    const childLifetimeProbe = /FROM\s+session_authority/i.test(sql)
      && (
        /lifecycle-quick:lifetime-child/i.test(sql)
        || /bounded_count/i.test(sql)
        || /HAVING\s+count\(\*\)\s*>\s*1000/i.test(sql)
      );
    const ticketLifetimeProbe = /FROM\s+child_transfer_tickets/i.test(sql)
      && (
        /lifecycle-quick:lifetime-ticket/i.test(sql)
        || /bounded_count/i.test(sql)
        || /HAVING\s+count\(\*\)\s*>\s*1000/i.test(sql)
      );
    if (childLifetimeProbe && !(
      /INDEXED\s+BY\s+session_authority_parent_terminal/i.test(sql)
      && /parent_session_id\s*=\s*\$rootSessionId/i.test(sql)
      && /LIMIT\s+1001/i.test(sql)
      && !/GROUP\s+BY|HAVING/i.test(sql)
    )) unboundedLifetimeReads += 1;
    if (ticketLifetimeProbe && !(
      /INDEXED\s+BY\s+child_transfer_tickets_source_child_v4/i.test(sql)
      && /source_parent_session_id\s*=\s*\$rootSessionId/i.test(sql)
      && /LIMIT\s+1001/i.test(sql)
      && !/GROUP\s+BY|HAVING/i.test(sql)
    )) unboundedLifetimeReads += 1;
    const quickOutboxProbe = /lifecycle-quick:outbox-/i.test(sql);
    if (quickOutboxProbe) {
      const nullSessionProbe = /lifecycle-quick:outbox-null-session/i.test(sql);
      const expectedIndex = nullSessionProbe
        ? /INDEXED\s+BY\s+outbox_delivery_order/i
        : /INDEXED\s+BY\s+outbox_lifecycle_latest_artifact/i;
      if (
        !expectedIndex.test(sql)
        || !/project_id\s*=\s*\$projectId/i.test(sql)
        || !/LIMIT\s+1/i.test(sql)
        || /ORDER\s+BY|GROUP\s+BY|HAVING/i.test(sql)
      ) unboundedOutboxReads += 1;
    }
    if (
      /SELECT\s+outbox\.\*/i.test(sql)
      && /FROM\s+outbox/i.test(sql)
      && /ORDER\s+BY\s+outbox\.session_id/i.test(sql)
    ) unboundedOutboxReads += 1;
    if (
      /SELECT\s+event_type,\s*payload_json,\s*payload_hash,\s*command_event_index,\s*session_id,\s*stream_type,\s*stream_id/i.test(sql)
      && /FROM\s+events/i.test(sql)
      && /global_position\s*=\s*\$eventPosition/i.test(sql)
    ) unboundedOutboxReads += 1;
    if (
      /SELECT\s+occurred_at\s+FROM\s+events/i.test(sql)
      && /event_type\s*=\s*'SessionStarted'/i.test(sql)
      && /\$sessionId/i.test(sql)
    ) unboundedOutboxReads += 1;
    if (
      /FROM\s+session_evidence_coverage_transitions/i.test(sql)
      && /batch_event_position\s*<=\s*\$(?:base|binding)Position/i.test(sql)
      && (
        !/adapter_session_id\s*=\s*\$adapterSessionId/i.test(sql)
        || !/INDEXED\s+BY\s+session_evidence_coverage_transitions_snapshot/i.test(sql)
      )
    ) unboundedTransitionReads += 1;
    if (
      /FROM\s+events(?:\s+AS\s+\w+)?\s+(?:INDEXED\s+BY\s+events_session_evidence_artifacts\s+)?/i.test(sql)
      && /global_position\s*<=\s*\$(?:base|binding)Position/i.test(sql)
      && /EvidenceCoverageRecorded/i.test(sql)
      && (
        !/INDEXED\s+BY\s+events_session_evidence_artifacts/i.test(sql)
        ||
        !/SessionCheckpointRecorded/i.test(sql)
        || !/highestContiguousOrdinal/i.test(sql)
        || !/missingIntervals/i.test(sql)
        || !/adapterSessions/i.test(sql)
      )
    ) incompleteArtifactProbes += 1;
    if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) writes += 1;
  };
  const wrapped: SqliteConnection = {
    exec(sql) {
      inspect(sql);
      if (writes > 0) throw new Error("QUICK_INTEGRITY_WRITE");
      connection.exec(sql);
    },
    prepare(sql) {
      inspect(sql);
      if (writes > 0) throw new Error("QUICK_INTEGRITY_WRITE");
      return connection.prepare(sql) as SqliteStatement;
    },
    close() {
      connection.close();
    },
  };
  return {
    connection: wrapped,
    ordinalReads: () => ordinalReads,
    frameElementReads: () => frameElementReads,
    fullStreamFolds: () => fullStreamFolds,
    lifecycleHistoryScans: () => lifecycleHistoryScans,
    childProjectionTargetReads: () => childProjectionTargetReads,
    childProjectionPredecessorReads: () => childProjectionPredecessorReads,
    reportWitnessReads: () => reportWitnessReads,
    workflowProjectionReads: () => workflowProjectionReads,
    unboundedLifetimeReads: () => unboundedLifetimeReads,
    unboundedOutboxReads: () => unboundedOutboxReads,
    unboundedTransitionReads: () => unboundedTransitionReads,
    incompleteArtifactProbes: () => incompleteArtifactProbes,
    writes: () => writes,
  };
}

async function quickIssues(
  fixture: Fixture,
  recorder = providerRecorder(),
): Promise<{
  readonly issues: readonly IntegrityIssueCode[];
  readonly recorder: ProviderRecorder;
  readonly reads: ReturnType<typeof observedConnection>;
}> {
  const reads = observedConnection(fixture.connection);
  const issues: IntegrityIssueCode[] = [];
  await new LifecycleIntegrityService(reads.connection, recorder.provider)
    .quickCheckAsync(fixture.context, { add(code) { issues.push(code); } });
  assert.equal(reads.ordinalReads(), 0);
  assert.equal(reads.frameElementReads(), 0);
  assert.equal(reads.fullStreamFolds(), 0);
  assert.equal(reads.lifecycleHistoryScans(), 0);
  assert.equal(reads.unboundedLifetimeReads(), 0);
  assert.equal(reads.unboundedOutboxReads(), 0);
  assert.equal(reads.unboundedTransitionReads(), 0);
  assert.equal(reads.incompleteArtifactProbes(), 0);
  assert.equal(reads.writes(), 0);
  assert.equal(recorder.fingerprintCalls, 0);
  return { issues, recorder, reads };
}

function dropTrigger(connection: SqliteConnection, name: string): void {
  connection.exec(`DROP TRIGGER ${name}`);
}

function checkpointFingerprint(checkpoint: unknown, version: 1 | 2): string {
  return createHash("sha256")
    .update(`project-memory/checkpoint/v${version}\n`, "utf8")
    .update(canonicalJson(checkpoint), "utf8")
    .digest("hex");
}
function workflowStatus(
  phase: string,
  finalCheckpointId: string | null,
  finalCheckpointPosition: string | null,
): Record<string, unknown> {
  return {
    resultVersion: 2,
    sessionId: ROOT_ID,
    workflowId: `session-end/${ROOT_ID}`,
    workflowGeneration: 1,
    phase,
    priorRootState: "active",
    triggeringEventPosition: "1",
    finalCheckpointId,
    finalCheckpointEventPosition: finalCheckpointPosition,
    evidenceWindow: {
      evidenceWindowState: "sealed",
      evidenceFrozenCheckpointEventPosition: finalCheckpointPosition,
      evidenceFrozenGeneration: finalCheckpointPosition === null ? null : 1,
    },
    validationPlansReady: false,
    qualityScore: null,
    safeFailureCode: null,
    materializationRequired: false,
  };
}

function addWorkflow(
  fixture: Fixture,
  overrides: Readonly<Record<string, SqliteValue>> = {},
): void {
  rawInsert(fixture.connection, "workflow_instances", {
    project_id: PROJECT_ID,
    workflow_id: `session-end/${ROOT_ID}`,
    workflow_type: "session-end",
    generation: 1,
    state: "active",
    phase: "requested",
    root_command_id: "root-command",
    result_json: null,
    error_code: null,
    created_at: NOW,
    updated_at: NOW,
    session_id: ROOT_ID,
    triggering_event_position: 1,
    expected_authority_commitment: H64,
    coordinator_owner_id: null,
    coordinator_claim_token: null,
    coordinator_claim_expires_at: null,
    coordinator_attempt_count: 0,
    coordinator_failure_class: null,
    coordinator_error_code: null,
    coordinator_next_attempt_at: null,
    validation_attempt_plan_generation: null,
    validation_attempt_plans_json: null,
    evidence_frozen_checkpoint_event_position: null,
    evidence_frozen_generation: null,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: null,
    ...overrides,
  });
}

function addMigratedLegacyWorkflowProjection(fixture: Fixture): void {
  dropTrigger(
    fixture.connection,
    "lifecycle_workflow_generation_folds_v4_legacy_insert_guard",
  );
  insertWorkflowProjection(fixture.connection, workflowProjection({
    projectId: PROJECT_ID,
    workflowId: `session-end/${ROOT_ID}`,
    workflowGeneration: 1,
    sessionId: ROOT_ID,
    triggerEventPosition: 1n,
    rootCommandId: "root-command",
    evidenceWindowState: "sealed",
    replacementCheckpointVersion: null,
    effectiveCheckpointVersion: 2,
    effectiveDraftSourceEventPosition: 1n,
    previousFingerprint: null,
  }));
}

function checkpointDraft(version: 1 | 2): Record<string, unknown> {
  const source = version === 1 ? checkpointFixture() : qualifiedCheckpointFixture();
  return {
    checkpointVersion: version,
    taskSummary: source.taskSummary,
    completedItems: source.completedItems,
    inProgressItems: source.inProgressItems,
    blockers: source.blockers,
    nextActions: source.nextActions,
    decisions: source.decisions,
    assumptions: source.assumptions,
    unresolvedConflicts: source.unresolvedConflicts,
    filesTouched: source.filesTouched,
    artifactReferences: source.artifactReferences,
    sourceReferences: source.sourceReferences,
    commandResults: source.commandResults,
    testResults: source.testResults,
    materialClaims: source.materialClaims,
  };
}

function requestWitness(
  version: 1 | 2,
  commandId: string,
): string {
  const command = {
    commandType: "request-session-end",
    commandId,
    idempotencyKey: `quick-integrity/end-request/${version}`,
    agentId: "agent-quick-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    request: {
      requestVersion: version,
      sessionId: ROOT_ID,
      childEndPolicy: "require-completed",
      finalCheckpoint: checkpointDraft(version),
      validationProfileIds: [],
      requestedQualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
    },
  };
  return buildLifecycleIntentWitness(command as never, {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-quick-integrity",
    targetActorRole: "primary",
    targetClientInstanceId: "client-quick-integrity",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function schema4RequestWitness(
  commandId: string,
  request: ReturnType<typeof sessionEndEffectiveStateFixture>["request"],
  idempotencyKey = "quick-integrity/end-request/3",
): string {
  return buildLifecycleIntentWitness({
    commandType: "request-session-end",
    commandId,
    idempotencyKey,
    agentId: "agent-quick-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    request,
  } as never, {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-quick-integrity",
    targetActorRole: "primary",
    targetClientInstanceId: "client-quick-integrity",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function schema4CancelWitness(
  workflowId: string,
  commandId: string,
  checkpointId: string,
  expectedStreamVersion = "3",
): string {
  return buildLifecycleIntentWitness({
    commandType: "cancel-session-end",
    commandId,
    idempotencyKey: "quick-integrity/end-cancel/3",
    agentId: "agent-quick-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    workflowId,
    expectedStreamVersion,
    preTransitionCheckpointId: checkpointId,
  } as never, {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-quick-integrity",
    targetActorRole: "primary",
    targetClientInstanceId: "client-quick-integrity",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function addSchema4WorkflowRequest(fixture: Fixture): {
  readonly workflowId: string;
  readonly commandId: string;
  readonly eventPosition: bigint;
  readonly effectiveState: ReturnType<typeof sessionEndEffectiveStateFixture>;
  readonly fingerprint: string;
} {
  const eventPosition = 2n;
  const workflowId = uuid(89_091);
  const commandId = uuid(30_002);
  const effectiveState = sessionEndEffectiveStateFixture({ requestVersion: 2 });
  rawEvent(fixture.connection, {
    globalPosition: eventPosition,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 3,
    sessionId: ROOT_ID,
    payload: {
      workflowId,
      workflowGeneration: 1,
      previousState: "active",
      effectiveState,
    },
    lifecycleIntent: schema4RequestWitness(commandId, effectiveState.request),
    idempotencyKey: "quick-integrity/end-request/3",
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 2, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  fixture.connection.prepare(`
    UPDATE session_authority SET semantic_state = 'ending', updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $sessionId: ROOT_ID });
  rawInsert(fixture.connection, "workflow_instances", {
    project_id: PROJECT_ID,
    workflow_id: workflowId,
    workflow_type: "session-end",
    generation: 1,
    state: "active",
    phase: "requested",
    root_command_id: commandId,
    result_json: null,
    error_code: null,
    created_at: NOW,
    updated_at: NOW,
    session_id: ROOT_ID,
    triggering_event_position: eventPosition,
    expected_authority_commitment: rootAuthority().authority_commitment,
    coordinator_owner_id: null,
    coordinator_claim_token: null,
    coordinator_claim_expires_at: null,
    coordinator_attempt_count: 0,
    coordinator_failure_class: null,
    coordinator_error_code: null,
    coordinator_next_attempt_at: null,
    validation_attempt_plan_generation: null,
    validation_attempt_plans_json: null,
    evidence_frozen_checkpoint_event_position: null,
    evidence_frozen_generation: null,
    evidence_window_state: "open",
    final_ending_scope_bindings_json: null,
  });
  const fingerprint = createHash("sha256")
    .update("project-memory/lifecycle/workflow-generation/v2\n", "utf8")
    .update(canonicalJson([
      PROJECT_ID,
      workflowId,
      "1",
      ROOT_ID,
      "2",
      H64,
      commandId,
      "open",
      2,
      2,
      "2",
      "2",
      1,
      effectiveState.effectiveStateHash,
      null,
      null,
    ]), "utf8")
    .digest("hex");
  rawInsert(fixture.connection, "lifecycle_workflow_generation_folds", {
    project_id: PROJECT_ID,
    workflow_id: workflowId,
    workflow_generation: 1,
    session_id: ROOT_ID,
    trigger_event_position: eventPosition,
    root_command_id: commandId,
    evidence_window_state: "open",
    replacement_checkpoint_version: 2,
    effective_checkpoint_version: 2,
    effective_draft_source_event_position: eventPosition,
    fingerprint_schema_version: 2,
    effective_state_source_event_position: eventPosition,
    effective_state_version: 1,
    effective_state_hash: effectiveState.effectiveStateHash,
    previous_fingerprint: null,
    fingerprint,
  });
  return { workflowId, commandId, eventPosition, effectiveState, fingerprint };
}

function addSchema4CancellationAfterLegacyProjection(fixture: Fixture): string {
  const workflowId = uuid(89_094);
  const requestCommandId = uuid(30_006);
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: {
      workflowId,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
      requestVersion: 2,
    },
    lifecycleIntent: requestWitness(2, requestCommandId),
    idempotencyKey: "quick-integrity/end-request/2",
  });
  addWorkflow(fixture, {
    workflow_id: workflowId,
    root_command_id: requestCommandId,
    triggering_event_position: 2,
    expected_authority_commitment: rootAuthority().authority_commitment,
    evidence_window_state: "open",
  });
  const generationOne = workflowProjection({
    projectId: PROJECT_ID,
    workflowId,
    workflowGeneration: 1,
    sessionId: ROOT_ID,
    triggerEventPosition: 2n,
    rootCommandId: requestCommandId,
    evidenceWindowState: "open",
    replacementCheckpointVersion: 2,
    effectiveCheckpointVersion: 2,
    effectiveDraftSourceEventPosition: 2n,
    previousFingerprint: null,
  });
  insertWorkflowProjection(fixture.connection, generationOne);

  const checkpointId = uuid(89_095);
  const checkpoint = qualifiedCheckpointFixture({
    checkpointId: checkpointId as never,
    sessionId: ROOT_ID as never,
    baseEventPosition: 2n,
    checkpointEventPosition: 3n,
  });
  rawEvent(fixture.connection, {
    globalPosition: 3n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 3n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: { checkpoint, baseEventPosition: "2", checkpointEventPosition: "3" },
  });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET semantic_state = 'ending',
        latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = 3,
        latest_checkpoint_fingerprint = $fingerprint,
        updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: checkpointId,
    $fingerprint: checkpointFingerprint(checkpoint, 2),
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });

  const cancelCommandId = uuid(30_005);
  rawEvent(fixture.connection, {
    globalPosition: 4n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 4n,
    eventType: "SessionEndCancelled",
    eventSchemaVersion: 3,
    sessionId: ROOT_ID,
    payload: {
      cancellationVersion: 1,
      workflowId,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      restoredState: "active",
      preTransitionCheckpointId: checkpointId,
    },
    lifecycleIntent: schema4CancelWitness(workflowId, cancelCommandId, checkpointId),
    idempotencyKey: "quick-integrity/end-cancel/3",
  });
  const cancelFingerprint = createHash("sha256")
    .update("project-memory/lifecycle/workflow-generation/v2\n", "utf8")
    .update(canonicalJson([
      PROJECT_ID,
      workflowId,
      "2",
      ROOT_ID,
      "4",
      H64,
      cancelCommandId,
      "sealed",
      null,
      2,
      "2",
      null,
      null,
      null,
      1,
      generationOne.fingerprint,
    ]), "utf8")
    .digest("hex");
  rawInsert(fixture.connection, "lifecycle_workflow_generation_folds", {
    project_id: PROJECT_ID,
    workflow_id: workflowId,
    workflow_generation: 2,
    session_id: ROOT_ID,
    trigger_event_position: 4,
    root_command_id: cancelCommandId,
    evidence_window_state: "sealed",
    replacement_checkpoint_version: null,
    effective_checkpoint_version: 2,
    effective_draft_source_event_position: 2,
    fingerprint_schema_version: 2,
    effective_state_source_event_position: null,
    effective_state_version: null,
    effective_state_hash: null,
    previous_fingerprint: generationOne.fingerprint,
    fingerprint: cancelFingerprint,
  });
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET generation = 2, phase = 'cancelled', root_command_id = $commandId,
        triggering_event_position = 4, evidence_window_state = 'sealed',
        result_json = $result, updated_at = $now
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $commandId: cancelCommandId,
    $result: canonicalJson({
      resultVersion: 2,
      sessionId: ROOT_ID,
      workflowId,
      workflowGeneration: 2,
      phase: "cancelled",
      priorRootState: "active",
      triggeringEventPosition: "4",
      finalCheckpointId: null,
      finalCheckpointEventPosition: null,
      evidenceWindow: {
        evidenceWindowState: "sealed",
        evidenceFrozenCheckpointEventPosition: null,
        evidenceFrozenGeneration: null,
      },
      validationPlansReady: false,
      qualityScore: null,
      safeFailureCode: null,
      materializationRequired: false,
    }),
    $now: NOW,
    $projectId: PROJECT_ID,
    $workflowId: workflowId,
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 4, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  return workflowId;
}

function schema4CancellationAfterLegacyPredecessorFixture(): Fixture {
  const fixture = openAmendmentFixture(null);
  const workflowId = uuid(89_005);
  const predecessorRow = fixture.connection.prepare(`
    SELECT fingerprint
    FROM lifecycle_workflow_generation_folds
    WHERE project_id = $projectId AND workflow_id = $workflowId
      AND workflow_generation = 2
  `).get({ $projectId: PROJECT_ID, $workflowId: workflowId });
  assert.equal(typeof predecessorRow?.fingerprint, "string");
  const predecessorFingerprint = String(predecessorRow!.fingerprint);
  const checkpointId = uuid(89_095);
  const checkpoint = qualifiedCheckpointFixture({
    checkpointId: checkpointId as never,
    sessionId: ROOT_ID as never,
    baseEventPosition: 3n,
    checkpointEventPosition: 4n,
  });
  rawEvent(fixture.connection, {
    globalPosition: 4n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 4n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: { checkpoint, baseEventPosition: "3", checkpointEventPosition: "4" },
  });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET semantic_state = 'ending',
        latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = 4,
        latest_checkpoint_fingerprint = $fingerprint,
        updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: checkpointId,
    $fingerprint: checkpointFingerprint(checkpoint, 2),
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
  const cancelCommandId = uuid(30_005);
  rawEvent(fixture.connection, {
    globalPosition: 5n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 5n,
    eventType: "SessionEndCancelled",
    eventSchemaVersion: 3,
    sessionId: ROOT_ID,
    payload: {
      cancellationVersion: 1,
      workflowId,
      previousWorkflowGeneration: 2,
      workflowGeneration: 3,
      restoredState: "active",
      preTransitionCheckpointId: checkpointId,
    },
    lifecycleIntent: schema4CancelWitness(
      workflowId,
      cancelCommandId,
      checkpointId,
      "4",
    ),
    idempotencyKey: "quick-integrity/end-cancel/3",
  });
  const cancelFingerprint = createHash("sha256")
    .update("project-memory/lifecycle/workflow-generation/v2\n", "utf8")
    .update(canonicalJson([
      PROJECT_ID,
      workflowId,
      "3",
      ROOT_ID,
      "5",
      H64,
      cancelCommandId,
      "sealed",
      null,
      2,
      "2",
      null,
      null,
      null,
      1,
      predecessorFingerprint,
    ]), "utf8")
    .digest("hex");
  rawInsert(fixture.connection, "lifecycle_workflow_generation_folds", {
    project_id: PROJECT_ID,
    workflow_id: workflowId,
    workflow_generation: 3,
    session_id: ROOT_ID,
    trigger_event_position: 5,
    root_command_id: cancelCommandId,
    evidence_window_state: "sealed",
    replacement_checkpoint_version: null,
    effective_checkpoint_version: 2,
    effective_draft_source_event_position: 2,
    fingerprint_schema_version: 2,
    effective_state_source_event_position: null,
    effective_state_version: null,
    effective_state_hash: null,
    previous_fingerprint: predecessorFingerprint,
    fingerprint: cancelFingerprint,
  });
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET generation = 3, phase = 'cancelled', root_command_id = $commandId,
        triggering_event_position = 5, evidence_window_state = 'sealed',
        result_json = $result, updated_at = $now
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $commandId: cancelCommandId,
    $result: canonicalJson({
      resultVersion: 2,
      sessionId: ROOT_ID,
      workflowId,
      workflowGeneration: 3,
      phase: "cancelled",
      priorRootState: "active",
      triggeringEventPosition: "5",
      finalCheckpointId: null,
      finalCheckpointEventPosition: null,
      evidenceWindow: {
        evidenceWindowState: "sealed",
        evidenceFrozenCheckpointEventPosition: null,
        evidenceFrozenGeneration: null,
      },
      validationPlansReady: false,
      qualityScore: null,
      safeFailureCode: null,
      materializationRequired: false,
    }),
    $now: NOW,
    $projectId: PROJECT_ID,
    $workflowId: workflowId,
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 5, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  fixture.connection.prepare(`
    UPDATE session_authority SET semantic_state = 'active', updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $sessionId: ROOT_ID });
  return fixture;
}

function schema4AmendmentWitness(
  workflowId: string,
  commandId: string,
): string {
  return buildLifecycleIntentWitness({
    commandType: "amend-session-end",
    commandId,
    idempotencyKey: "quick-integrity/end-amendment/3",
    agentId: "agent-quick-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    workflowId,
    expectedStreamVersion: "3",
    amendment: {
      amendmentVersion: 2,
      childEndPolicy: null,
      finalCheckpoint: null,
      validationProfileIds: null,
      requestedQualityThreshold: null,
      requireFullEvidence: null,
      requireMaterialization: null,
      evidenceWindowAction: "unchanged",
    },
  } as never, {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-quick-integrity",
    targetActorRole: "primary",
    targetClientInstanceId: "client-quick-integrity",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function addSchema4WorkflowAmendment(fixture: Fixture): {
  readonly workflowId: string;
  readonly predecessorFingerprint: string;
  readonly fingerprint: string;
} {
  const request = addSchema4WorkflowRequest(fixture);
  const checkpointId = uuid(89_092);
  const checkpoint = qualifiedCheckpointFixture({
    checkpointId: checkpointId as never,
    sessionId: ROOT_ID as never,
    baseEventPosition: 2n,
    checkpointEventPosition: 3n,
  });
  rawEvent(fixture.connection, {
    globalPosition: 3n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 3n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: {
      checkpoint,
      baseEventPosition: "2",
      checkpointEventPosition: "3",
    },
  });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = 3,
        latest_checkpoint_fingerprint = $fingerprint,
        updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: checkpointId,
    $fingerprint: checkpointFingerprint(checkpoint, 2),
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
  const commandId = uuid(30_004);
  rawEvent(fixture.connection, {
    globalPosition: 4n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 4n,
    eventType: "SessionEndAmended",
    eventSchemaVersion: 3,
    sessionId: ROOT_ID,
    payload: {
      workflowId: request.workflowId,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      preTransitionCheckpointId: checkpointId,
      evidenceWindowAction: "unchanged",
      effectiveState: request.effectiveState,
    },
    lifecycleIntent: schema4AmendmentWitness(request.workflowId, commandId),
    idempotencyKey: "quick-integrity/end-amendment/3",
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 4, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET generation = 2, root_command_id = $commandId,
        triggering_event_position = 4, result_json = $result, updated_at = $now
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $commandId: commandId,
    $result: canonicalJson({
      resultVersion: 2,
      sessionId: ROOT_ID,
      workflowId: request.workflowId,
      workflowGeneration: 2,
      phase: "requested",
      priorRootState: "active",
      triggeringEventPosition: "4",
      finalCheckpointId: null,
      finalCheckpointEventPosition: null,
      evidenceWindow: {
        evidenceWindowState: "open",
        evidenceFrozenCheckpointEventPosition: null,
        evidenceFrozenGeneration: null,
      },
      validationPlansReady: false,
      qualityScore: null,
      safeFailureCode: null,
      materializationRequired: false,
    }),
    $now: NOW,
    $projectId: PROJECT_ID,
    $workflowId: request.workflowId,
  });
  const fingerprint = createHash("sha256")
    .update("project-memory/lifecycle/workflow-generation/v2\n", "utf8")
    .update(canonicalJson([
      PROJECT_ID,
      request.workflowId,
      "2",
      ROOT_ID,
      "4",
      H64,
      commandId,
      "open",
      null,
      2,
      "2",
      "4",
      1,
      request.effectiveState.effectiveStateHash,
      2,
      request.fingerprint,
    ]), "utf8")
    .digest("hex");
  rawInsert(fixture.connection, "lifecycle_workflow_generation_folds", {
    project_id: PROJECT_ID,
    workflow_id: request.workflowId,
    workflow_generation: 2,
    session_id: ROOT_ID,
    trigger_event_position: 4,
    root_command_id: commandId,
    evidence_window_state: "open",
    replacement_checkpoint_version: null,
    effective_checkpoint_version: 2,
    effective_draft_source_event_position: 2,
    fingerprint_schema_version: 2,
    effective_state_source_event_position: 4,
    effective_state_version: 1,
    effective_state_hash: request.effectiveState.effectiveStateHash,
    previous_fingerprint: request.fingerprint,
    fingerprint,
  });
  return {
    workflowId: request.workflowId,
    predecessorFingerprint: request.fingerprint,
    fingerprint,
  };
}

function addSchema4WorkflowRestart(fixture: Fixture): {
  readonly workflowId: string;
  readonly baseFingerprint: string;
  readonly predecessorFingerprint: string;
} {
  const request = addSchema4WorkflowRequest(fixture);
  const checkpointId = uuid(89_093);
  const checkpoint = qualifiedCheckpointFixture({
    checkpointId: checkpointId as never,
    sessionId: ROOT_ID as never,
    baseEventPosition: 2n,
    checkpointEventPosition: 3n,
  });
  rawEvent(fixture.connection, {
    globalPosition: 3n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 3n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: { checkpoint, baseEventPosition: "2", checkpointEventPosition: "3" },
  });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = 3,
        latest_checkpoint_fingerprint = $fingerprint,
        updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: checkpointId,
    $fingerprint: checkpointFingerprint(checkpoint, 2),
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });

  const cancelCommandId = uuid(30_004);
  rawEvent(fixture.connection, {
    globalPosition: 4n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 4n,
    eventType: "SessionEndCancelled",
    eventSchemaVersion: 3,
    sessionId: ROOT_ID,
    payload: {
      cancellationVersion: 1,
      workflowId: request.workflowId,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      restoredState: "active",
      preTransitionCheckpointId: checkpointId,
    },
    lifecycleIntent: schema4CancelWitness(
      request.workflowId,
      cancelCommandId,
      checkpointId,
    ),
    idempotencyKey: "quick-integrity/end-cancel/3",
  });
  const cancelFingerprint = createHash("sha256")
    .update("project-memory/lifecycle/workflow-generation/v2\n", "utf8")
    .update(canonicalJson([
      PROJECT_ID,
      request.workflowId,
      "2",
      ROOT_ID,
      "4",
      H64,
      cancelCommandId,
      "sealed",
      null,
      2,
      "2",
      "2",
      1,
      request.effectiveState.effectiveStateHash,
      2,
      request.fingerprint,
    ]), "utf8")
    .digest("hex");
  rawInsert(fixture.connection, "lifecycle_workflow_generation_folds", {
    project_id: PROJECT_ID,
    workflow_id: request.workflowId,
    workflow_generation: 2,
    session_id: ROOT_ID,
    trigger_event_position: 4,
    root_command_id: cancelCommandId,
    evidence_window_state: "sealed",
    replacement_checkpoint_version: null,
    effective_checkpoint_version: 2,
    effective_draft_source_event_position: 2,
    fingerprint_schema_version: 2,
    effective_state_source_event_position: 2,
    effective_state_version: 1,
    effective_state_hash: request.effectiveState.effectiveStateHash,
    previous_fingerprint: request.fingerprint,
    fingerprint: cancelFingerprint,
  });
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET generation = 2, phase = 'cancelled', root_command_id = $commandId,
        triggering_event_position = 4, evidence_window_state = 'sealed',
        result_json = $result, updated_at = $now
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $commandId: cancelCommandId,
    $result: canonicalJson({
      resultVersion: 2,
      sessionId: ROOT_ID,
      workflowId: request.workflowId,
      workflowGeneration: 2,
      phase: "cancelled",
      priorRootState: "active",
      triggeringEventPosition: "4",
      finalCheckpointId: null,
      finalCheckpointEventPosition: null,
      evidenceWindow: {
        evidenceWindowState: "sealed",
        evidenceFrozenCheckpointEventPosition: null,
        evidenceFrozenGeneration: null,
      },
      validationPlansReady: false,
      qualityScore: null,
      safeFailureCode: null,
      materializationRequired: false,
    }),
    $now: NOW,
    $projectId: PROJECT_ID,
    $workflowId: request.workflowId,
  });
  fixture.connection.prepare(`
    UPDATE session_authority SET semantic_state = 'active', updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $sessionId: ROOT_ID });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 4, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });

  const restartCommandId = uuid(30_005);
  const restartIdempotencyKey = "quick-integrity/end-request/restart";
  rawEvent(fixture.connection, {
    globalPosition: 5n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 5n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 3,
    sessionId: ROOT_ID,
    payload: {
      workflowId: request.workflowId,
      workflowGeneration: 3,
      previousState: "active",
      effectiveState: request.effectiveState,
    },
    lifecycleIntent: schema4RequestWitness(
      restartCommandId,
      request.effectiveState.request,
      restartIdempotencyKey,
    ),
    idempotencyKey: restartIdempotencyKey,
  });
  const restartFingerprint = createHash("sha256")
    .update("project-memory/lifecycle/workflow-generation/v2\n", "utf8")
    .update(canonicalJson([
      PROJECT_ID,
      request.workflowId,
      "3",
      ROOT_ID,
      "5",
      H64,
      restartCommandId,
      "open",
      2,
      2,
      "5",
      "5",
      1,
      request.effectiveState.effectiveStateHash,
      2,
      cancelFingerprint,
    ]), "utf8")
    .digest("hex");
  rawInsert(fixture.connection, "lifecycle_workflow_generation_folds", {
    project_id: PROJECT_ID,
    workflow_id: request.workflowId,
    workflow_generation: 3,
    session_id: ROOT_ID,
    trigger_event_position: 5,
    root_command_id: restartCommandId,
    evidence_window_state: "open",
    replacement_checkpoint_version: 2,
    effective_checkpoint_version: 2,
    effective_draft_source_event_position: 5,
    fingerprint_schema_version: 2,
    effective_state_source_event_position: 5,
    effective_state_version: 1,
    effective_state_hash: request.effectiveState.effectiveStateHash,
    previous_fingerprint: cancelFingerprint,
    fingerprint: restartFingerprint,
  });
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET generation = 3, phase = 'requested', root_command_id = $commandId,
        triggering_event_position = 5, evidence_window_state = 'open',
        result_json = NULL, updated_at = $now
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $commandId: restartCommandId,
    $now: NOW,
    $projectId: PROJECT_ID,
    $workflowId: request.workflowId,
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 5, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  fixture.connection.prepare(`
    UPDATE session_authority SET semantic_state = 'ending', updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $sessionId: ROOT_ID });
  return {
    workflowId: request.workflowId,
    baseFingerprint: request.fingerprint,
    predecessorFingerprint: cancelFingerprint,
  };
}

function amendmentWitness(
  workflowId: string,
  commandId: string,
  finalCheckpointVersion: 1 | null,
): string {
  const command = {
    commandType: "amend-session-end",
    commandId,
    idempotencyKey: `quick-integrity/end-amendment/${
      finalCheckpointVersion ?? "unchanged"
    }`,
    agentId: "agent-quick-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    workflowId,
    expectedStreamVersion: "2",
    amendment: {
      amendmentVersion: 1,
      childEndPolicy: null,
      finalCheckpoint: finalCheckpointVersion === null
        ? null
        : checkpointDraft(finalCheckpointVersion),
      validationProfileIds: null,
      requestedQualityThreshold: null,
      requireFullEvidence: null,
      requireMaterialization: true,
    },
  };
  return buildLifecycleIntentWitness(command as never, {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-quick-integrity",
    targetActorRole: "primary",
    targetClientInstanceId: "client-quick-integrity",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function amendmentWitnessV2(
  workflowId: string,
  commandId: string,
  overrides: {
    readonly command?: Readonly<Record<string, unknown>>;
    readonly origin?: Readonly<Record<string, unknown>>;
  } = {},
): string {
  const command = {
    commandType: "amend-session-end",
    commandId,
    idempotencyKey: "quick-integrity/end-amendment/v2-unchanged",
    agentId: "agent-quick-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    workflowId,
    expectedStreamVersion: "2",
    amendment: {
      amendmentVersion: 2,
      childEndPolicy: null,
      finalCheckpoint: null,
      validationProfileIds: null,
      requestedQualityThreshold: null,
      requireFullEvidence: null,
      requireMaterialization: true,
      evidenceWindowAction: "unchanged",
    },
    ...overrides.command,
  };
  const origin = {
    authorizationKind: "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-quick-integrity",
    targetActorRole: "primary",
    targetClientInstanceId: "client-quick-integrity",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
    ...overrides.origin,
  };
  return buildLifecycleIntentWitness(command as never, origin as never).source;
}
function openAmendmentFixture(finalCheckpointVersion: 1 | null): Fixture {
  const fixture = createFixture();
  const workflowId = uuid(89_005);
  const requestCommandId = uuid(30_002);
  const amendmentCommandId = uuid(30_003);
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: {
      workflowId,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
      requestVersion: 2,
    },
    lifecycleIntent: requestWitness(2, requestCommandId),
    idempotencyKey: "quick-integrity/end-request/2",
  });
  rawEvent(fixture.connection, {
    globalPosition: 3n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 3n,
    eventType: "SessionEndAmended",
    eventSchemaVersion: finalCheckpointVersion === null ? 2 : 1,
    sessionId: ROOT_ID,
    payload: {
      workflowId,
      previousWorkflowGeneration: 1,
      workflowGeneration: 2,
      preTransitionCheckpointId: uuid(89_006),
      ...(finalCheckpointVersion === null
        ? {
            amendmentVersion: 2,
            finalCheckpointVersion: null,
            evidenceWindowAction: "unchanged",
          }
        : {}),
    },
    lifecycleIntent: finalCheckpointVersion === null
      ? amendmentWitnessV2(workflowId, amendmentCommandId)
      : amendmentWitness(workflowId, amendmentCommandId, finalCheckpointVersion),
    idempotencyKey: `quick-integrity/end-amendment/${
      finalCheckpointVersion === null ? "v2-unchanged" : finalCheckpointVersion
    }`,
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 3
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  addWorkflow(fixture, {
    workflow_id: workflowId,
    generation: 2,
    phase: "requested",
    root_command_id: amendmentCommandId,
    triggering_event_position: 3,
    expected_authority_commitment: H64,
    evidence_window_state: "open",
  });
  const generationOne = workflowProjection({
    projectId: PROJECT_ID,
    workflowId,
    workflowGeneration: 1,
    sessionId: ROOT_ID,
    triggerEventPosition: 2n,
    rootCommandId: requestCommandId,
    evidenceWindowState: "open",
    replacementCheckpointVersion: 2,
    effectiveCheckpointVersion: 2,
    effectiveDraftSourceEventPosition: 2n,
    previousFingerprint: null,
  });
  insertWorkflowProjection(fixture.connection, generationOne);
  if (finalCheckpointVersion === null) {
    insertWorkflowProjection(fixture.connection, workflowProjection({
      projectId: PROJECT_ID,
      workflowId,
      workflowGeneration: 2,
      sessionId: ROOT_ID,
      triggerEventPosition: 3n,
      rootCommandId: amendmentCommandId,
      evidenceWindowState: "open",
      replacementCheckpointVersion: null,
      effectiveCheckpointVersion: 2,
      effectiveDraftSourceEventPosition: 2n,
      previousFingerprint: generationOne.fingerprint,
    }));
  }
  return fixture;
}
function frozenInt64RootFixture(): Fixture {
  const fixture = createFixture();
  const frozenPosition = 9_223_372_036_854_775_807n;
  const checkpoint = qualifiedCheckpointFixture({
    checkpointId: uuid(89_020) as never,
    sessionId: ROOT_ID as never,
    baseEventPosition: 1n,
    checkpointEventPosition: frozenPosition,
  });
  rawEvent(fixture.connection, {
    globalPosition: frozenPosition,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: {
      checkpoint,
      baseEventPosition: "1",
      checkpointEventPosition: frozenPosition.toString(),
    },
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 2
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  dropTrigger(fixture.connection, "workflow_instances_evidence_v3_insert_guard");
  addWorkflow(fixture, {
    phase: "final-checkpoint-recorded",
    result_json: canonicalJson(workflowStatus(
      "final-checkpoint-recorded",
      checkpoint.checkpointId,
      frozenPosition.toString(),
    )),
    evidence_frozen_checkpoint_event_position: frozenPosition,
    evidence_frozen_generation: 1,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: "[]",
  });
  addMigratedLegacyWorkflowProjection(fixture);
  return fixture;
}

function seedGappedCoverage(
  fixture: Fixture,
  lastOrdinal: bigint,
): void {
  const missingEnd = lastOrdinal - 1n;
  const storageIntervals = `[[0,${missingEnd}]]`;
  const payload = {
    ...evidencePayload(ADAPTER_ID, BATCH_ID, "key-a", H64),
    batchFirstOrdinal: lastOrdinal.toString(),
    batchLastOrdinal: lastOrdinal.toString(),
    coverageLastOrdinal: lastOrdinal.toString(),
    highestContiguousOrdinal: null,
    missingIntervals: [{
      firstOrdinal: "0",
      lastOrdinal: missingEnd.toString(),
    }],
    frames: [{
      frameId: uuid(60_099),
      ordinal: lastOrdinal.toString(),
      sourceKind: "model-turn",
      observedAt: NOW,
      contentFingerprint: H64_B,
    }],
  };
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 2
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload,
  });
  fixture.connection.exec("BEGIN IMMEDIATE");
  try {
    rawInsert(fixture.connection, "session_evidence_coverage_transitions", {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      adapter_session_id: ADAPTER_ID,
      batch_id: BATCH_ID,
      batch_event_position: 2n,
      batch_first_ordinal: lastOrdinal,
      batch_last_ordinal: lastOrdinal,
      coverage_first_ordinal: 0n,
      coverage_last_ordinal: lastOrdinal,
      highest_contiguous_ordinal: -1n,
      missing_intervals_json: storageIntervals,
      frame_fingerprint_algorithm: "hmac-sha256",
      frame_fingerprint_schema_version: 1,
      frame_fingerprint_key_id: "key-a",
      frame_fingerprint_domain: "pm-evidence-frame-v1",
      previous_coverage_fingerprint_value: null,
      coverage_fingerprint_algorithm: "hmac-sha256",
      coverage_fingerprint_schema_version: 1,
      coverage_fingerprint_key_id: "key-a",
      coverage_fingerprint_domain: "pm-evidence-coverage-v1",
      coverage_fingerprint_value: H64,
      new_frame_count: 1,
      capture_mode: "coverage-only",
      content_retained: 0,
      created_at: NOW,
    });
    rawInsert(fixture.connection, "session_evidence_coverage", {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      adapter_session_id: ADAPTER_ID,
      capture_mode: "coverage-only",
      first_ordinal: 0n,
      last_ordinal: lastOrdinal,
      highest_contiguous_ordinal: -1n,
      missing_intervals_json: storageIntervals,
      fingerprint_algorithm: "hmac-sha256",
      fingerprint_schema_version: 1,
      fingerprint_key_id: "key-a",
      fingerprint_domain: "pm-evidence-frame-v1",
      latest_batch_id: BATCH_ID,
      latest_batch_event_position: 2n,
      created_at: NOW,
      updated_at: NOW,
      coverage_fingerprint_algorithm: "hmac-sha256",
      coverage_fingerprint_schema_version: 1,
      coverage_fingerprint_key_id: "key-a",
      coverage_fingerprint_domain: "pm-evidence-coverage-v1",
      coverage_fingerprint_value: H64,
    });
    rawInsert(fixture.connection, "session_evidence_fingerprints", {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      adapter_session_id: ADAPTER_ID,
      ordinal: lastOrdinal,
      frame_id: uuid(60_099),
      source_kind: "model-turn",
      observed_at: NOW,
      fingerprint_algorithm: "hmac-sha256",
      fingerprint_schema_version: 1,
      fingerprint_key_id: "key-a",
      fingerprint_domain: "pm-evidence-frame-v1",
      fingerprint_value: H64_B,
      batch_id: BATCH_ID,
      recorded_event_position: 2n,
      created_at: NOW,
    });
    fixture.connection.exec("COMMIT");
  } catch (error) {
    fixture.connection.exec("ROLLBACK");
    throw error;
  }
}

function frozenCurrentChildFixture(
  mode: "checkpoint" | "clean-null" | "covered-null",
): {
  readonly fixture: Fixture;
  readonly binding: Record<string, unknown>;
  readonly rootCheckpoint: Record<string, unknown>;
  readonly rootCheckpointPosition: bigint;
} {
  const fixture = createFixture();
  const childCheckpointId = uuid(89_030);
  const hasCheckpoint = mode === "checkpoint";
  const hasCoverage = mode === "covered-null";
  const childCheckpointPosition = 3n;
  const childLastPosition = hasCheckpoint || hasCoverage ? 3n : 2n;
  const childStreamVersion = hasCheckpoint || hasCoverage ? 2n : 1n;
  const rootCheckpointPosition = childLastPosition + 1n;
  const childCheckpoint = qualifiedCheckpointFixture({
    checkpointId: childCheckpointId as never,
    sessionId: CHILD_ID as never,
    parentSessionId: ROOT_ID as never,
    baseEventPosition: 2n,
    checkpointEventPosition: childCheckpointPosition,
  });
  const childRow = childAuthority(CHILD_ID, 2n);
  rawInsert(fixture.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${CHILD_ID}`,
    stream_type: "session",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${CHILD_ID}`,
    streamVersion: 1n,
    eventType: "SessionForked",
    eventSchemaVersion: 1,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: forkPayload(String(childRow.authority_commitment)),
  });
  rawInsert(fixture.connection, "session_authority", childRow);
  if (hasCheckpoint) {
    rawEvent(fixture.connection, {
      globalPosition: childCheckpointPosition,
      streamId: `session/${CHILD_ID}`,
      streamVersion: 2n,
      eventType: "SessionCheckpointRecorded",
      eventSchemaVersion: 2,
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      payload: {
        checkpoint: childCheckpoint,
        baseEventPosition: "2",
        checkpointEventPosition: childCheckpointPosition.toString(),
      },
    });
    fixture.connection.prepare(`
      UPDATE streams SET current_version = 2
      WHERE project_id = $projectId AND stream_id = $streamId
    `).run({ $projectId: PROJECT_ID, $streamId: `session/${CHILD_ID}` });
    fixture.connection.prepare(`
      UPDATE session_authority
      SET latest_checkpoint_id = $checkpointId,
          latest_checkpoint_event_position = $checkpointPosition,
          latest_checkpoint_fingerprint = $fingerprint
      WHERE project_id = $projectId AND session_id = $sessionId
    `).run({
      $checkpointId: childCheckpointId,
      $checkpointPosition: childCheckpointPosition,
      $fingerprint: checkpointFingerprint(childCheckpoint, 2),
      $projectId: PROJECT_ID,
      $sessionId: CHILD_ID,
    });
  } else if (hasCoverage) {
    seedCoverage(fixture, {
      sessionId: CHILD_ID,
      position: 3n,
      streamVersion: 2n,
    });
  }
  const binding = {
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: CHILD_ID,
    childState: "active",
    lastEventPosition: childLastPosition.toString(),
    streamVersion: childStreamVersion.toString(),
    checkpointId: hasCheckpoint ? childCheckpointId : null,
    checkpointEventPosition: hasCheckpoint ? childCheckpointPosition.toString() : null,
    transferTicketId: null,
    transferTicketEventPosition: null,
  };
  const rootCheckpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: uuid(89_031) as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 1n,
      checkpointEventPosition: rootCheckpointPosition,
    }),
    childSummaries: [{
      childSessionId: CHILD_ID,
      state: "active",
      lastEventPosition: childLastPosition.toString(),
      streamVersion: childStreamVersion.toString(),
      latestCheckpointId: hasCheckpoint ? childCheckpointId : null,
    }],
  };
  rawEvent(fixture.connection, {
    globalPosition: rootCheckpointPosition,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: {
      checkpoint: rootCheckpoint,
      baseEventPosition: "1",
      checkpointEventPosition: rootCheckpointPosition.toString(),
    },
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 2
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  dropTrigger(fixture.connection, "workflow_instances_evidence_v3_insert_guard");
  addWorkflow(fixture, {
    phase: "final-checkpoint-recorded",
    result_json: canonicalJson(workflowStatus(
      "final-checkpoint-recorded",
      String(rootCheckpoint.checkpointId),
      rootCheckpointPosition.toString(),
    )),
    evidence_frozen_checkpoint_event_position: rootCheckpointPosition,
    evidence_frozen_generation: 1,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: canonicalJson([binding]),
  });
  addMigratedLegacyWorkflowProjection(fixture);
  const genesisProjection = genesisChildProjection(
    CHILD_ID,
    2n,
    String(childRow.authority_commitment),
  );
  insertChildProjection(fixture.connection, genesisProjection);
  if (hasCheckpoint || hasCoverage) {
    insertChildProjection(fixture.connection, carriedChildProjection(
      genesisProjection,
      {
        eventPosition: 3n,
        streamVersion: 2n,
        ...(hasCheckpoint
          ? {
              latestCheckpointId: childCheckpointId,
              latestCheckpointEventPosition: 3n,
            }
          : {}),
      },
    ));
  }
  return {
    fixture,
    binding,
    rootCheckpoint: rootCheckpoint as Record<string, unknown>,
    rootCheckpointPosition,
  };
}
function addCapacityChildren(fixture: Fixture, count: number): readonly {
  bindingKind: "current-child";
  childSessionId: string;
}[] {
  const bindings: { bindingKind: "current-child"; childSessionId: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const childSessionId = uuid(100_000 + index);
    const position = 1_000n + BigInt(index);
    rawInsert(fixture.connection, "streams", {
      project_id: PROJECT_ID,
      stream_id: `session/${childSessionId}`,
      stream_type: "session",
      current_version: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    const childRow = childAuthority(childSessionId, position);
    rawEvent(fixture.connection, {
      globalPosition: position,
      streamId: `session/${childSessionId}`,
      streamVersion: 1n,
      eventType: "SessionForked",
      eventSchemaVersion: 1,
      sessionId: childSessionId,
      parentSessionId: ROOT_ID,
      payload: forkPayload(String(childRow.authority_commitment)),
    });
    rawInsert(fixture.connection, "session_authority", childRow);
    bindings.push({ bindingKind: "current-child", childSessionId });
  }
  return bindings;
}

function nonLatestReportFixture(): {
  readonly fixture: Fixture;
  readonly reportAEventPosition: bigint;
} {
  const fixture = createFixture();
  const childRow = childAuthority(CHILD_ID, 2n, {
    semantic_state: "completion-proposed",
  });
  rawInsert(fixture.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${CHILD_ID}`,
    stream_type: "session",
    current_version: 5,
    created_at: NOW,
    updated_at: NOW,
  });
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${CHILD_ID}`,
    streamVersion: 1n,
    eventType: "SessionForked",
    eventSchemaVersion: 1,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: forkPayload(String(childRow.authority_commitment)),
  });
  const reports = [0, 1, 2].map((index) => childReportFixture({
    reportId: uuid(91_000 + index) as never,
    childSessionId: CHILD_ID as never,
    parentSessionId: ROOT_ID as never,
    assignmentId: uuid(55_001),
    itemIds: [
      uuid(92_000 + index * 2),
      uuid(92_001 + index * 2),
    ] as never,
  }));
  for (let index = 0; index < reports.length; index += 1) {
    const { allReportItemIds: _derived, ...report } = reports[index]!;
    rawEvent(fixture.connection, {
      globalPosition: 3n + BigInt(index),
      streamId: `session/${CHILD_ID}`,
      streamVersion: 2n + BigInt(index),
      eventType: "ChildWorkReported",
      eventSchemaVersion: 1,
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      payload: {
        report,
        childAuthorAgentId: "agent-child",
        primaryRecorderAgentId: "agent-primary",
      },
    });
  }
  rawEvent(fixture.connection, {
    globalPosition: 6n,
    streamId: `session/${CHILD_ID}`,
    streamVersion: 5n,
    eventType: "ChildCompletionProposed",
    eventSchemaVersion: 1,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: { reportId: reports[0]!.reportId },
  });
  rawInsert(fixture.connection, "session_authority", childRow);

  let projection = genesisChildProjection(
    CHILD_ID,
    2n,
    String(childRow.authority_commitment),
  );
  insertChildProjection(fixture.connection, projection);
  for (let index = 0; index < reports.length; index += 1) {
    projection = reportedChildProjection(projection, {
      eventPosition: 3n + BigInt(index),
      streamVersion: 2n + BigInt(index),
      reportId: reports[index]!.reportId,
      allReportItemIds: reports[index]!.allReportItemIds,
    });
    insertChildProjection(fixture.connection, projection);
  }
  projection = carriedChildProjection(projection, {
    eventPosition: 6n,
    streamVersion: 5n,
    childState: "completion-proposed",
    completionReportId: reports[0]!.reportId,
  });
  insertChildProjection(fixture.connection, projection);

  const rootCheckpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: uuid(93_001) as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 1n,
      checkpointEventPosition: 7n,
    }),
    childSummaries: [{
      childSessionId: CHILD_ID,
      state: "completion-proposed",
      lastEventPosition: "6",
      streamVersion: "5",
      latestCheckpointId: null,
    }],
  };
  rawEvent(fixture.connection, {
    globalPosition: 7n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: {
      checkpoint: rootCheckpoint,
      baseEventPosition: "1",
      checkpointEventPosition: "7",
    },
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 2
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  const binding = {
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: CHILD_ID,
    childState: "completion-proposed",
    lastEventPosition: "6",
    streamVersion: "5",
    checkpointId: null,
    checkpointEventPosition: null,
    transferTicketId: null,
    transferTicketEventPosition: null,
  };
  dropTrigger(fixture.connection, "workflow_instances_evidence_v3_insert_guard");
  addWorkflow(fixture, {
    phase: "final-checkpoint-recorded",
    result_json: canonicalJson(workflowStatus(
      "final-checkpoint-recorded",
      String(rootCheckpoint.checkpointId),
      "7",
    )),
    evidence_frozen_checkpoint_event_position: 7,
    evidence_frozen_generation: 1,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: canonicalJson([binding]),
  });
  addMigratedLegacyWorkflowProjection(fixture);
  return { fixture, reportAEventPosition: 3n };
}

afterEach(() => {
  for (const connection of connections.splice(0)) {
    try { connection.close(); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("bounded quick integrity rejects current aggregate and transition tampering without historical reads", async () => {
  const cases: readonly {
    readonly expected: IntegrityIssueCode;
    readonly mutate: (fixture: Fixture) => void;
  }[] = [
    {
      expected: "SESSION_EVIDENCE_COVERAGE_MISMATCH",
      mutate(fixture) {
        seedCoverage(fixture);
        dropTrigger(fixture.connection, "session_evidence_coverage_v3_update_guard");
        fixture.connection.exec(
          `UPDATE session_evidence_coverage SET coverage_fingerprint_value = '${H64_B}'`,
        );
      },
    },
    {
      expected: "SESSION_EVIDENCE_COVERAGE_MISMATCH",
      mutate(fixture) {
        seedCoverage(fixture);
        dropTrigger(fixture.connection, "session_evidence_coverage_v3_update_guard");
        fixture.connection.exec(
          "UPDATE session_evidence_coverage SET fingerprint_key_id = 'wrong-key'",
        );
      },
    },
    {
      expected: "SESSION_EVIDENCE_COVERAGE_MISMATCH",
      mutate(fixture) {
        seedCoverage(fixture);
        fixture.connection.exec(
          "DELETE FROM session_evidence_coverage_transition_heads",
        );
      },
    },
    {
      expected: "SESSION_EVIDENCE_COVERAGE_MISMATCH",
      mutate(fixture) {
        seedCoverage(fixture);
        dropTrigger(fixture.connection, "session_evidence_coverage_transitions_no_update");
        fixture.connection.exec(
          "UPDATE session_evidence_coverage_transitions SET missing_intervals_json = '[[0,0]]'",
        );
      },
    },
    {
      expected: "SESSION_EVIDENCE_COVERAGE_MISMATCH",
      mutate(fixture) {
        seedCoverage(fixture);
        dropTrigger(fixture.connection, "events_no_update");
        const payload = evidencePayload(ADAPTER_ID, BATCH_ID, "key-a", H64);
        payload.batchId = uuid(99_001);
        fixture.connection.prepare(`
          UPDATE events SET payload_json = $payload WHERE global_position = 2
        `).run({ $payload: canonicalJson(payload) });
      },
    },
    {
      expected: "SESSION_EVIDENCE_COVERAGE_MISMATCH",
      mutate(fixture) {
        seedCoverage(fixture);
        dropTrigger(fixture.connection, "events_no_update");
        fixture.connection.exec(
          "UPDATE events SET event_type = 'GenericSessionNote' WHERE global_position = 2",
        );
      },
    },
    {
      expected: "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
      mutate(fixture) {
        dropTrigger(fixture.connection, "workflow_instances_evidence_v3_insert_guard");
        addWorkflow(fixture, {
          phase: "final-checkpoint-recorded",
          evidence_window_state: "open",
        });
      },
    },
  ];
  for (const item of cases) {
    const fixture = createFixture();
    item.mutate(fixture);
    const result = await quickIssues(fixture);
    assert.ok(result.issues.includes(item.expected), item.expected);
  }
});

it("bounded quick integrity rejects one-byte prospective capacity overflow", async () => {
  const run = async (position: 9n | 10n): Promise<readonly IntegrityIssueCode[]> => {
    const fixture = createFixture();
    const bindings = addCapacityChildren(fixture, 580);
    seedCoverage(fixture, {
      position,
      keyId: "k".repeat(23),
    });
    const snapshot = {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [{
        adapterSessionId: ADAPTER_ID,
        coverageFirstOrdinal: "0",
        coverageLastOrdinal: "0",
        highestContiguousOrdinal: "0",
        missingIntervals: [],
        frameFingerprintAlgorithm: "hmac-sha256",
        frameFingerprintSchemaVersion: 1,
        frameFingerprintKeyId: "k".repeat(23),
        frameFingerprintDomain: "pm-evidence-frame-v1",
        coverageFingerprintAlgorithm: "hmac-sha256",
        coverageFingerprintSchemaVersion: 1,
        coverageFingerprintKeyId: "k".repeat(23),
        coverageFingerprintDomain: "pm-evidence-coverage-v1",
        coverageFingerprint: H64,
        latestBatchId: BATCH_ID,
        latestBatchEventPosition: position.toString(),
      }],
    };
    assert.equal(
      referenceMinimumCheckpointUpperBound(snapshot, bindings),
      position === 9n
        ? CHECKPOINT_MAX_CANONICAL_BYTES
        : CHECKPOINT_MAX_CANONICAL_BYTES + 1,
    );
    assert.ok(
      referenceMinimumFinalEndingScopeBindingsUpperBound(bindings)
      <= CHECKPOINT_MAX_CANONICAL_BYTES,
    );
    return (await quickIssues(fixture)).issues;
  };

  assert.equal((await run(9n)).includes("SESSION_EVIDENCE_COVERAGE_MISMATCH"), false);
  assert.equal((await run(10n)).includes("SESSION_EVIDENCE_COVERAGE_MISMATCH"), true);
});

it("bounded quick integrity checks status once per distinct current profile", async () => {
  const fixture = createFixture();
  seedCoverage(fixture, {
    adapterSessionId: ADAPTER_ID,
    batchId: BATCH_ID,
    keyId: "key-a",
    position: 2n,
    streamVersion: 2n,
  });
  seedCoverage(fixture, {
    adapterSessionId: uuid(66_002),
    batchId: uuid(77_002),
    keyId: "key-a",
    position: 3n,
    streamVersion: 3n,
  });
  seedCoverage(fixture, {
    adapterSessionId: uuid(66_003),
    batchId: uuid(77_003),
    keyId: "key-b",
    position: 4n,
    streamVersion: 4n,
  });
  const childRow = childAuthority(CHILD_ID, 5n);
  rawInsert(fixture.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${CHILD_ID}`,
    stream_type: "session",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  rawEvent(fixture.connection, {
    globalPosition: 5n,
    streamId: `session/${CHILD_ID}`,
    streamVersion: 1n,
    eventType: "SessionForked",
    eventSchemaVersion: 1,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: forkPayload(String(childRow.authority_commitment)),
  });
  rawInsert(fixture.connection, "session_authority", childRow);
  seedCoverage(fixture, {
    sessionId: CHILD_ID,
    adapterSessionId: uuid(66_004),
    batchId: uuid(77_004),
    keyId: "key-a",
    position: 6n,
    streamVersion: 2n,
  });
  const recorder = providerRecorder();
  const result = await quickIssues(fixture, recorder);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(recorder.calls, ["key-a", "key-b"]);
  assert.equal(recorder.maximumInFlight, 1);
  assert.equal(recorder.fingerprintCalls, 0);

  const unavailable = providerRecorder({ "key-b": "revoked" });
  await assert.rejects(
    () => quickIssues(fixture, unavailable),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
    ),
  );
  assert.deepEqual(unavailable.calls, ["key-a", "key-b"]);
  assert.equal(unavailable.maximumInFlight, 1);
  assert.equal(unavailable.fingerprintCalls, 0);
  assert.equal(
    referenceCheckpointFingerprint(2, qualifiedCheckpointFixture()).length,
    64,
  );
});
it("bounded quick integrity preserves signed-int64 positions and interval endpoints", async () => {
  assert.deepEqual((await quickIssues(frozenInt64RootFixture())).issues, []);

  const wide = createFixture();
  seedGappedCoverage(wide, 9_007_199_254_740_993n);
  assert.deepEqual((await quickIssues(wide)).issues, []);
});

it("bounded quick integrity requires exact canonical latest coverage payload keys", async () => {
  const reordered = createFixture();
  seedCoverage(reordered);
  dropTrigger(reordered.connection, "events_no_update");
  const reorderedRow = reordered.connection.prepare(
    "SELECT payload_json FROM events WHERE global_position = 2",
  ).get()!;
  const parsed = JSON.parse(String(reorderedRow.payload_json)) as Record<string, unknown>;
  const reversed = Object.fromEntries(Object.entries(parsed).reverse());
  reordered.connection.prepare(
    "UPDATE events SET payload_json = $payload WHERE global_position = 2",
  ).run({ $payload: JSON.stringify(reversed) });
  assert.ok(
    (await quickIssues(reordered)).issues
      .includes("SESSION_EVIDENCE_COVERAGE_MISMATCH"),
  );

  const substituted = createFixture();
  seedGappedCoverage(substituted, 1n);
  dropTrigger(substituted.connection, "events_no_update");
  const substitutedRow = substituted.connection.prepare(
    "SELECT payload_json FROM events WHERE global_position = 2",
  ).get()!;
  const substitutedPayload = JSON.parse(
    String(substitutedRow.payload_json),
  ) as Record<string, unknown>;
  delete substitutedPayload.highestContiguousOrdinal;
  substitutedPayload.highestContiguousOrdinalAlias = null;
  substituted.connection.prepare(
    "UPDATE events SET payload_json = $payload WHERE global_position = 2",
  ).run({ $payload: canonicalJson(substitutedPayload) });
  assert.ok(
    (await quickIssues(substituted)).issues
      .includes("SESSION_EVIDENCE_COVERAGE_MISMATCH"),
  );
});
it("bounded quick integrity rejects noncanonical top-level scalar escapes while keeping frames opaque", async () => {
  const adapterSessionId = uuid(60_606);
  const escapedTopLevel = createFixture();
  seedCoverage(escapedTopLevel, { adapterSessionId });
  dropTrigger(escapedTopLevel.connection, "events_no_update");
  const topLevelRow = escapedTopLevel.connection.prepare(
    "SELECT payload_json FROM events WHERE global_position = 2",
  ).get()!;
  const topLevelPayload = String(topLevelRow.payload_json).replace(
    `"adapterSessionId":"${adapterSessionId}"`,
    `"adapterSessionId":"\\u0030${adapterSessionId.slice(1)}"`,
  );
  assert.notEqual(topLevelPayload, topLevelRow.payload_json);
  escapedTopLevel.connection.prepare(
    "UPDATE events SET payload_json = $payload WHERE global_position = 2",
  ).run({ $payload: topLevelPayload });
  assert.equal(
    escapedTopLevel.connection.prepare(
      "SELECT json(payload_json) = payload_json AS minified FROM events WHERE global_position = 2",
    ).get()?.minified,
    1n,
  );
  assert.ok(
    (await quickIssues(escapedTopLevel)).issues
      .includes("SESSION_EVIDENCE_COVERAGE_MISMATCH"),
  );

  const escapedFrame = createFixture();
  seedCoverage(escapedFrame);
  dropTrigger(escapedFrame.connection, "events_no_update");
  const frameRow = escapedFrame.connection.prepare(
    "SELECT payload_json FROM events WHERE global_position = 2",
  ).get()!;
  const framePayload = JSON.parse(String(frameRow.payload_json)) as {
    readonly frames: readonly { readonly frameId: string }[];
  };
  const frameId = framePayload.frames[0]!.frameId;
  const opaqueFramePayload = String(frameRow.payload_json).replace(
    `"frameId":"${frameId}"`,
    `"frameId":"\\u0030${frameId.slice(1)}"`,
  );
  assert.notEqual(opaqueFramePayload, frameRow.payload_json);
  escapedFrame.connection.prepare(
    "UPDATE events SET payload_json = $payload WHERE global_position = 2",
  ).run({ $payload: opaqueFramePayload });
  assert.deepEqual((await quickIssues(escapedFrame)).issues, []);
});
it("bounded quick integrity performs only a current workflow endpoint read", async () => {
  const frozen = frozenCurrentChildFixture("checkpoint");
  seedCoverage(frozen.fixture, {
    sessionId: CHILD_ID,
    adapterSessionId: uuid(66_090),
    batchId: uuid(77_090),
    position: 5n,
    streamVersion: 3n,
  });
  const result = await quickIssues(frozen.fixture);
  assert.deepEqual(result.issues, []);
  assert.equal(result.reads.childProjectionTargetReads(), 0);
  assert.equal(result.reads.childProjectionPredecessorReads(), 0);
  assert.equal(result.reads.reportWitnessReads(), 0);
  assert.equal(result.reads.workflowProjectionReads(), 1);
});

it("bounded quick integrity accepts clean open-window endpoints with fixed reads", async () => {
  const legal = openAmendmentFixture(null);
  const result = await quickIssues(legal);
  assert.deepEqual(result.issues, []);
  assert.equal(result.reads.childProjectionTargetReads(), 0);
  assert.equal(result.reads.childProjectionPredecessorReads(), 0);
  assert.equal(result.reads.reportWitnessReads(), 0);
  assert.equal(result.reads.workflowProjectionReads(), 1);

  const maintenanceInspection = openAmendmentFixture(null);
  const maintenanceContext = {
    ...maintenanceInspection.context,
    binding: {
      ...maintenanceInspection.context.binding,
      actorRole: "maintenance",
      clientInstanceId: "client-integrity-inspector",
    },
  } as ProjectContext;
  const maintenance = await quickIssues({
    connection: maintenanceInspection.connection,
    context: maintenanceContext,
  });
  assert.deepEqual(maintenance.issues, []);
  assert.equal(maintenance.reads.childProjectionTargetReads(), 0);
  assert.equal(maintenance.reads.childProjectionPredecessorReads(), 0);
  assert.equal(maintenance.reads.reportWitnessReads(), 0);
  assert.equal(maintenance.reads.workflowProjectionReads(), 1);
});

it("bounded quick integrity does not read historical report witnesses for clean endpoints", async () => {
  const legal = nonLatestReportFixture();
  const result = await quickIssues(legal.fixture);
  assert.deepEqual(result.issues, []);
  assert.equal(result.reads.childProjectionTargetReads(), 0);
  assert.equal(result.reads.childProjectionPredecessorReads(), 0);
  assert.equal(result.reads.reportWitnessReads(), 0);
  assert.equal(result.reads.workflowProjectionReads(), 1);
});

it("schema 2 quick integrity retains the legacy historical workflow mode", async () => {
  const fixture = createSchema2Fixture();
  seedSchema2OpenWorkflow(fixture);
  const reads = observedConnection(fixture.connection);
  const service = new LifecycleIntegrityService(reads.connection);
  const issues: IntegrityIssueCode[] = [];

  await service.quickCheckAsync(fixture.context, {
    add(code) { issues.push(code); },
  });

  assert.deepEqual(issues, []);
  assert.ok(reads.workflowProjectionReads() > 0);
  assert.ok(reads.lifecycleHistoryScans() > 0);
  assert.equal(reads.writes(), 0);

  const corrupted = createSchema2Fixture();
  seedSchema2OpenWorkflow(corrupted);
  corrupted.connection.exec("DROP TRIGGER events_no_update");
  corrupted.connection.prepare(`
    UPDATE events
    SET lifecycle_intent_json = $intent
    WHERE global_position = 2
  `).run({ $intent: requestWitness(2, uuid(30_003)) });
  const corruptedReads = observedConnection(corrupted.connection);
  const corruptedIssues: IntegrityIssueCode[] = [];
  await new LifecycleIntegrityService(corruptedReads.connection)
    .quickCheckAsync(corrupted.context, {
      add(code) { corruptedIssues.push(code); },
    });
  assert.deepEqual(corruptedIssues, ["LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"]);
  assert.ok(corruptedReads.workflowProjectionReads() > 0);
  assert.ok(corruptedReads.lifecycleHistoryScans() > 0);
  assert.equal(corruptedReads.writes(), 0);
});

it("quick full integrity detects snapshot fold workflow disagreement", async () => {
  const control = createFixture();
  addSchema4WorkflowRequest(control);
  assert.deepEqual((await quickIssues(control)).issues, []);

  const corrupted = createFixture();
  const { commandId, effectiveState, eventPosition } = addSchema4WorkflowRequest(corrupted);
  const divergentRequest = {
    ...effectiveState.request,
    requestedQualityThreshold: effectiveState.request.requestedQualityThreshold - 1,
  };
  const divergentWitness = schema4RequestWitness(commandId, divergentRequest);
  assert.doesNotThrow(() => decodeSessionEndEffectiveStateV1(effectiveState));
  assert.doesNotThrow(() => decodeLifecycleIntentWitness(divergentWitness));
  assert.notDeepEqual(divergentRequest, effectiveState.request);
  corrupted.connection.exec("DROP TRIGGER events_no_update");
  corrupted.connection.prepare(`
    UPDATE events SET lifecycle_intent_json = $intent
    WHERE global_position = $eventPosition
  `).run({
    $intent: divergentWitness,
    $eventPosition: eventPosition,
  });

  assert.ok(
    (await quickIssues(corrupted)).issues.includes(
      "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
    ),
  );
});

it("schema 4 quick integrity strictly validates six-key workflow plans", async () => {
  const plan = {
    profileId: "alpha",
    profileVersion: 1,
    runId: uuid(91_001),
    resultId: uuid(91_002),
    commandId: uuid(91_003),
    idempotencyKey: "validation/alpha",
  } as const;
  const secondPlan = {
    profileId: "beta",
    profileVersion: 1,
    runId: uuid(91_004),
    resultId: uuid(91_005),
    commandId: uuid(91_006),
    idempotencyKey: "validation/beta",
  } as const;
  const seed = (
    fixture: Fixture,
    plans: readonly Readonly<Record<string, unknown>>[] = [plan],
  ): string => {
    const { workflowId } = addSchema4WorkflowRequest(fixture);
    fixture.connection.prepare(`
      UPDATE workflow_instances
      SET validation_attempt_plan_generation = 1,
          validation_attempt_plans_json = $plans
      WHERE project_id = $projectId AND workflow_id = $workflowId
    `).run({
      $plans: canonicalJson(plans),
      $projectId: PROJECT_ID,
      $workflowId: workflowId,
    });
    return workflowId;
  };

  const control = createFixture();
  seed(control);
  assert.deepEqual((await quickIssues(control)).issues, []);

  const identityHostiles = [
    {
      label: "profile identity",
      plans: [plan, { ...secondPlan, profileId: "alpha" }],
    },
    {
      label: "run identity",
      plans: [plan, { ...secondPlan, runId: plan.runId }],
    },
    {
      label: "result identity",
      plans: [plan, { ...secondPlan, resultId: plan.resultId }],
    },
    {
      label: "command identity",
      plans: [plan, { ...secondPlan, commandId: plan.commandId }],
    },
    {
      label: "idempotency identity",
      plans: [plan, { ...secondPlan, idempotencyKey: plan.idempotencyKey }],
    },
  ] as const;
  const hostiles: readonly {
    readonly label: string;
    readonly plans: readonly Readonly<Record<string, unknown>>[];
  }[] = [
    {
      label: "exact six-key shape",
      plans: [{ ...plan, profileConfigurationHash: H64 }],
    },
    {
      label: "binary profile ordering",
      plans: [
        { ...plan, profileId: "zeta" },
        { ...secondPlan, profileId: "alpha" },
      ],
    },
    ...identityHostiles,
    { label: "nonempty cardinality", plans: [] },
    {
      label: "plan-count cap",
      plans: Array.from({ length: 65 }, (_, index) => ({
        profileId: `profile-${index.toString().padStart(2, "0")}`,
        profileVersion: 1,
        runId: uuid(92_000 + index),
        resultId: uuid(93_000 + index),
        commandId: uuid(94_000 + index),
        idempotencyKey: `validation/${index}`,
      })),
    },
    {
      label: "canonical-byte cap",
      plans: [{ ...plan, profileId: "x".repeat(262_145) }],
    },
  ];
  for (const hostile of hostiles) {
    const corrupted = createFixture();
    const workflowId = seed(corrupted);
    for (const trigger of [
      "workflow_instances_validation_plan_v4_update_guard",
      "workflow_instances_evidence_v3_update_guard",
      "workflow_instances_lifecycle_update_guard",
      "workflow_instances_validation_plan_immutable",
    ]) corrupted.connection.exec(`DROP TRIGGER ${trigger}`);
    corrupted.connection.prepare(`
      UPDATE workflow_instances SET validation_attempt_plans_json = $plans
      WHERE project_id = $projectId AND workflow_id = $workflowId
    `).run({
      $plans: canonicalJson(hostile.plans),
      $projectId: PROJECT_ID,
      $workflowId: workflowId,
    });
    assert.ok(
      (await quickIssues(corrupted)).issues.includes(
        "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
      ),
      hostile.label,
    );
  }
  assert.equal(hostiles.length, 10);
});

it("schema 4 integrity decodes every non-null plan on null-session workflows", async () => {
  const plan = {
    profileId: "alpha",
    profileVersion: 1,
    runId: uuid(95_001),
    resultId: uuid(95_002),
    commandId: uuid(95_003),
    idempotencyKey: "validation/generic-alpha",
  } as const;
  const seed = (fixture: Fixture): void => addWorkflow(fixture, {
    workflow_id: uuid(95_004),
    workflow_type: "generic",
    session_id: null,
    triggering_event_position: null,
    expected_authority_commitment: null,
    coordinator_attempt_count: null,
    evidence_window_state: null,
  });

  const control = createFixture();
  seed(control);
  assert.deepEqual((await quickIssues(control)).issues, []);
  assert.deepEqual(directWorkflowShapeIssues(control, false), []);

  const corrupted = createFixture();
  seed(corrupted);
  corrupted.connection.exec(
    "DROP TRIGGER workflow_instances_validation_plan_immutable",
  );
  corrupted.connection.exec(
    "DROP TRIGGER workflow_instances_validation_plan_v4_update_guard",
  );
  corrupted.connection.exec(
    "DROP TRIGGER workflow_instances_lifecycle_update_guard",
  );
  corrupted.connection.prepare(`
    UPDATE workflow_instances
    SET validation_attempt_plan_generation = 1,
        validation_attempt_plans_json = $plans
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $plans: canonicalJson([{ ...plan, extra: true }]),
    $projectId: PROJECT_ID,
    $workflowId: uuid(95_004),
  });
  assert.ok((await quickIssues(corrupted)).issues.includes(
    "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
  ));
  assert.ok(directWorkflowShapeIssues(corrupted, false).includes(
    "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
  ));
});

it("schema 4 quick integrity binds the workflow row to its exact trigger", async () => {
  const control = createFixture();
  addSchema4WorkflowRequest(control);
  assert.deepEqual((await quickIssues(control)).issues, []);

  const legacyControl = openAmendmentFixture(null);
  assert.deepEqual((await quickIssues(legacyControl)).issues, []);

  const corrupted = createFixture();
  const { workflowId } = addSchema4WorkflowRequest(corrupted);
  corrupted.connection.exec(
    "DROP TRIGGER workflow_instances_evidence_v3_update_guard",
  );
  corrupted.connection.exec(
    "DROP TRIGGER workflow_instances_lifecycle_update_guard",
  );
  corrupted.connection.prepare(`
    UPDATE workflow_instances SET triggering_event_position = 1
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({ $projectId: PROJECT_ID, $workflowId: workflowId });
  assert.ok(
    (await quickIssues(corrupted)).issues.includes(
      "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
    ),
  );

  const legacyPointer = openAmendmentFixture(null);
  legacyPointer.connection.exec(
    "DROP TRIGGER workflow_instances_evidence_v3_update_guard",
  );
  legacyPointer.connection.exec(
    "DROP TRIGGER workflow_instances_lifecycle_update_guard",
  );
  legacyPointer.connection.prepare(`
    UPDATE workflow_instances SET triggering_event_position = 1
    WHERE project_id = $projectId
  `).run({ $projectId: PROJECT_ID });
  assert.ok(
    (await quickIssues(legacyPointer)).issues.includes(
      "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
    ),
  );

  const legacyWindowMismatch = openAmendmentFixture(null);
  legacyWindowMismatch.connection.exec(
    "DROP TRIGGER workflow_instances_evidence_v3_update_guard",
  );
  legacyWindowMismatch.connection.exec(
    "DROP TRIGGER workflow_instances_lifecycle_update_guard",
  );
  legacyWindowMismatch.connection.prepare(`
    UPDATE workflow_instances SET evidence_window_state = 'sealed'
    WHERE project_id = $projectId
  `).run({ $projectId: PROJECT_ID });
  assert.ok(
    (await quickIssues(legacyWindowMismatch)).issues.includes(
      "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
    ),
  );

  const missingLegacyFold = openAmendmentFixture(null);
  missingLegacyFold.connection.exec(
    "DROP TRIGGER lifecycle_workflow_generation_folds_no_delete",
  );
  missingLegacyFold.connection.prepare(`
    DELETE FROM lifecycle_workflow_generation_folds
    WHERE project_id = $projectId AND workflow_generation = 2
  `).run({ $projectId: PROJECT_ID });
  assert.ok(
    (await quickIssues(missingLegacyFold)).issues.includes(
      "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
    ),
  );
});

it("schema 4 quick integrity binds workflow result materialization to effective policy", async () => {
  const control = createFixture();
  addSchema4WorkflowAmendment(control);
  assert.deepEqual((await quickIssues(control)).issues, []);

  const corrupted = createFixture();
  const { workflowId } = addSchema4WorkflowAmendment(corrupted);
  corrupted.connection.exec(
    "DROP TRIGGER workflow_instances_evidence_v3_update_guard",
  );
  corrupted.connection.exec(
    "DROP TRIGGER workflow_instances_lifecycle_update_guard",
  );
  const row = corrupted.connection.prepare(`
    SELECT result_json FROM workflow_instances
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).get({ $projectId: PROJECT_ID, $workflowId: workflowId });
  assert.equal(typeof row?.result_json, "string");
  const result = JSON.parse(String(row!.result_json)) as Record<string, unknown>;
  result.materializationRequired = true;
  corrupted.connection.prepare(`
    UPDATE workflow_instances SET result_json = $result
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $result: canonicalJson(result),
    $projectId: PROJECT_ID,
    $workflowId: workflowId,
  });

  assert.ok((await quickIssues(corrupted)).issues.includes(
    "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
  ));
});

it("schema 4 integrity admits V3 cancellation after a legacy workflow fingerprint", async () => {
  const control = schema4CancellationAfterLegacyPredecessorFixture();

  assert.deepEqual((await quickIssues(control)).issues, []);
  assert.deepEqual(directWorkflowShapeIssues(control, false), []);
});

it("schema 4 quick integrity recomputes the immediate V2 predecessor fingerprint", async () => {
  const control = createFixture();
  addSchema4WorkflowRestart(control);
  const controlResult = await quickIssues(control);
  assert.deepEqual(controlResult.issues, []);
  assert.ok(controlResult.reads.workflowProjectionReads() <= 9);

  const corrupted = createFixture();
  const { workflowId, baseFingerprint } = addSchema4WorkflowRestart(corrupted);
  const predecessorFingerprint = createHash("sha256")
    .update("project-memory/lifecycle/workflow-generation/v2\n", "utf8")
    .update(canonicalJson([
      PROJECT_ID,
      workflowId,
      "2",
      ROOT_ID,
      "4",
      H64,
      uuid(30_004),
      "sealed",
      null,
      2,
      "2",
      "2",
      1,
      H64_B,
      2,
      baseFingerprint,
    ]), "utf8")
    .digest("hex");
  const currentFingerprint = createHash("sha256")
    .update("project-memory/lifecycle/workflow-generation/v2\n", "utf8")
    .update(canonicalJson([
      PROJECT_ID,
      workflowId,
      "3",
      ROOT_ID,
      "5",
      H64,
      uuid(30_005),
      "open",
      2,
      2,
      "5",
      "5",
      1,
      sessionEndEffectiveStateFixture({ requestVersion: 2 }).effectiveStateHash,
      2,
      predecessorFingerprint,
    ]), "utf8")
    .digest("hex");
  corrupted.connection.exec(
    "DROP TRIGGER lifecycle_workflow_generation_folds_no_update",
  );
  corrupted.connection.prepare(`
    UPDATE lifecycle_workflow_generation_folds
    SET effective_state_hash = CASE workflow_generation
          WHEN 2 THEN $corruptedEffectiveStateHash ELSE effective_state_hash END,
        fingerprint = CASE workflow_generation
          WHEN 2 THEN $predecessorFingerprint
          WHEN 3 THEN $currentFingerprint ELSE fingerprint END,
        previous_fingerprint = CASE workflow_generation
          WHEN 3 THEN $predecessorFingerprint ELSE previous_fingerprint END
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $corruptedEffectiveStateHash: H64_B,
    $predecessorFingerprint: predecessorFingerprint,
    $currentFingerprint: currentFingerprint,
    $projectId: PROJECT_ID,
    $workflowId: workflowId,
  });
  const corruptedResult = await quickIssues(corrupted);
  assert.ok(
    corruptedResult.issues.includes(
      "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
    ),
  );
  assert.ok(corruptedResult.reads.workflowProjectionReads() <= 9);
});

it("schema 4 quick integrity enforces lifetime child and transfer history caps", async () => {
  const control = createFixture();
  addSchema4WorkflowRequest(control);
  seedSchema4LifetimeHistory(control, {
    directChildren: 1_000,
    sourceTickets: 1_000,
  });
  const observerMutationControl = observedConnection(control.connection);
  observerMutationControl.connection.prepare(`
    SELECT 1 FROM session_authority
    WHERE project_id = $projectId AND session_kind = 'child'
    GROUP BY parent_session_id HAVING count(*) > 1000 LIMIT 1
  `).get({ $projectId: PROJECT_ID });
  observerMutationControl.connection.prepare(`
    SELECT 1 FROM child_transfer_tickets
    WHERE project_id = $projectId
    GROUP BY source_parent_session_id HAVING count(*) > 1000 LIMIT 1
  `).get({ $projectId: PROJECT_ID });
  assert.equal(observerMutationControl.unboundedLifetimeReads(), 2);
  assert.deepEqual((await quickIssues(control)).issues, []);

  const childOverflow = createFixture();
  addSchema4WorkflowRequest(childOverflow);
  seedSchema4LifetimeHistory(childOverflow, {
    directChildren: 1_001,
    sourceTickets: 1_000,
    bypassChildCap: true,
  });
  assert.ok(
    (await quickIssues(childOverflow)).issues.includes(
      "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
    ),
  );

  const ticketOverflow = createFixture();
  addSchema4WorkflowRequest(ticketOverflow);
  seedSchema4LifetimeHistory(ticketOverflow, {
    directChildren: 1_000,
    sourceTickets: 1_001,
    bypassTicketCap: true,
  });
  assert.ok(
    (await quickIssues(ticketOverflow)).issues.includes(
      "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
    ),
  );
});

it("schema 4 full integrity owns lifecycle outbox overlay discovery while quick stays bounded", async () => {
  const control = createFixture();
  addSchema4TerminalLifecycleOutbox(control);
  assert.deepEqual((await quickIssues(control)).issues, []);
  const observerMutationControl = observedConnection(control.connection);
  observerMutationControl.connection.prepare(`
    SELECT outbox.*, event.session_id AS event_session_id
    FROM outbox
    LEFT JOIN events AS event ON event.global_position = outbox.event_position
    WHERE outbox.project_id = $projectId AND outbox.session_id IS NOT NULL
    ORDER BY outbox.session_id, outbox.artifact_kind,
             outbox.materialization_revision
  `).all({ $projectId: PROJECT_ID });
  observerMutationControl.connection.prepare(`
    SELECT event_type, payload_json, payload_hash, command_event_index,
           session_id, stream_type, stream_id
    FROM events
    WHERE project_id = $projectId AND global_position = $eventPosition
    LIMIT 2
  `).all({ $projectId: PROJECT_ID, $eventPosition: 2 });
  observerMutationControl.connection.prepare(`
    SELECT occurred_at
    FROM events
    WHERE project_id = $projectId AND session_id = $sessionId
      AND stream_id = $streamId AND stream_version = 1
      AND event_type = 'SessionStarted' AND event_schema_version = 1
    LIMIT 2
  `).all({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  assert.equal(observerMutationControl.unboundedOutboxReads(), 3);

  const corrupted = createFixture();
  const targetKey = addSchema4TerminalLifecycleOutbox(corrupted);
  corrupted.connection.exec(
    "DROP TRIGGER outbox_lifecycle_descriptor_v4_update_guard",
  );
  corrupted.connection.exec("DROP TRIGGER outbox_lifecycle_planned_immutable");
  const row = corrupted.connection.prepare(`
    SELECT payload_json FROM outbox
    WHERE project_id = $projectId AND target_key = $targetKey
  `).get({ $projectId: PROJECT_ID, $targetKey: targetKey });
  assert.equal(typeof row?.payload_json, "string");
  const payload = JSON.parse(String(row!.payload_json)) as Record<string, unknown>;
  corrupted.connection.prepare(`
    UPDATE outbox SET payload_json = $payload
    WHERE project_id = $projectId AND target_key = $targetKey
  `).run({
    $payload: canonicalJson({ ...payload, targetKey: "lifecycle-log/hostile/2" }),
    $projectId: PROJECT_ID,
    $targetKey: targetKey,
  });
  assert.deepEqual((await quickIssues(corrupted)).issues, []);
  assert.ok(directOutboxShapeIssues(corrupted, true).includes(
    "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH",
  ));
});

it("schema 4 full integrity rejects reserved lifecycle work with a null session", async () => {
  const control = createFixture();
  addGenericOutbox(control);
  assert.deepEqual((await quickIssues(control)).issues, []);
  assert.deepEqual(directOutboxShapeIssues(control, true), []);

  const corrupted = createFixture();
  const targetKey = addGenericOutbox(corrupted);
  dropSchema4OutboxMutationGuards(corrupted.connection);
  corrupted.connection.prepare(`
    UPDATE outbox SET kind = 'materialize-lifecycle-log'
    WHERE project_id = $projectId AND target_key = $targetKey
  `).run({ $projectId: PROJECT_ID, $targetKey: targetKey });
  assert.deepEqual((await quickIssues(corrupted)).issues, []);
  assert.ok(directOutboxShapeIssues(corrupted, true).includes(
    "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH",
  ));
});

it("schema 4 full integrity enforces outbox attempt and claim parity", async () => {
  const control = createFixture();
  addSchema4TerminalLifecycleOutbox(control);
  assert.deepEqual((await quickIssues(control)).issues, []);
  assert.deepEqual(directOutboxShapeIssues(control, true), []);

  const mutations = [
    {
      label: "pending attempt count",
      sql: `UPDATE outbox SET attempt_count = -1
            WHERE project_id = $projectId AND target_key = $targetKey`,
      ignoreChecks: true,
    },
    {
      label: "claimed token exceeds attempts",
      sql: `UPDATE outbox
            SET status = 'claimed', attempt_count = 1,
                claim_owner = 'outbox-worker', claim_token = 2,
                claim_expires_at = '2026-07-30T00:05:00.000Z'
            WHERE project_id = $projectId AND target_key = $targetKey`,
    },
    {
      label: "completed token exceeds attempts",
      sql: `UPDATE outbox
            SET status = 'completed', attempt_count = 1,
                claim_owner = 'outbox-worker', claim_token = 2,
                claim_expires_at = NULL
            WHERE project_id = $projectId AND target_key = $targetKey`,
    },
  ] as const;
  for (const mutation of mutations) {
    const corrupted = createFixture();
    const targetKey = addSchema4TerminalLifecycleOutbox(corrupted);
    dropSchema4OutboxMutationGuards(corrupted.connection);
    if ("ignoreChecks" in mutation && mutation.ignoreChecks === true) {
      corrupted.connection.exec("PRAGMA ignore_check_constraints = ON");
    }
    corrupted.connection.prepare(mutation.sql).run({
      $projectId: PROJECT_ID,
      $targetKey: targetKey,
    });
    if ("ignoreChecks" in mutation && mutation.ignoreChecks === true) {
      corrupted.connection.exec("PRAGMA ignore_check_constraints = OFF");
    }
    assert.deepEqual((await quickIssues(corrupted)).issues, [], mutation.label);
    assert.ok(
      directOutboxShapeIssues(corrupted, true).includes(
        "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH",
      ),
      `full ${mutation.label}`,
    );
  }
});

it("schema 4 full integrity independently binds every lifecycle outbox field", async () => {
  const control = createFixture();
  addSchema4TerminalLifecycleOutbox(control);
  assert.deepEqual((await quickIssues(control)).issues, []);
  assert.deepEqual(directOutboxShapeIssues(control, true), []);

  type Mutation = {
    readonly label: string;
    apply(fixture: Fixture, targetKey: string): void;
  };
  const payloadMutation = (
    label: string,
    mutate: (payload: Record<string, unknown>) => void,
    canonical = true,
  ): Mutation => ({
    label,
    apply(fixture, targetKey) {
      updateSchema4OutboxPayload(fixture, targetKey, mutate, canonical);
    },
  });
  const columnMutation = (
    label: string,
    column: string,
    value: SqliteValue,
  ): Mutation => ({
    label,
    apply(fixture, targetKey) {
      updateSchema4OutboxColumn(fixture, targetKey, column, value);
    },
  });
  const eventMutation = (
    label: string,
    column: string,
    value: SqliteValue,
  ): Mutation => ({
    label,
    apply(fixture) {
      fixture.connection.exec("DROP TRIGGER IF EXISTS events_no_update");
      fixture.connection.prepare(`
        UPDATE events SET ${column} = $value
        WHERE project_id = $projectId AND global_position = 2
      `).run({ $value: value, $projectId: PROJECT_ID });
    },
  });
  const fingerprint = (
    payload: Record<string, unknown>,
  ): Record<string, unknown> => payload.nextFingerprint as Record<string, unknown>;
  const origin = (
    payload: Record<string, unknown>,
  ): Record<string, unknown> => payload.origin as Record<string, unknown>;
  const mutations: readonly Mutation[] = [
    payloadMutation("top-level extra key", (payload) => { payload.extra = true; }),
    payloadMutation("top-level missing key", (payload) => {
      delete payload.triggeringEventType;
    }),
    payloadMutation("fingerprint extra key", (payload) => {
      fingerprint(payload).extra = true;
    }),
    payloadMutation("fingerprint missing key", (payload) => {
      delete fingerprint(payload).domain;
    }),
    payloadMutation("origin extra key", (payload) => { origin(payload).extra = true; }),
    payloadMutation("origin missing key", (payload) => {
      delete origin(payload).workflowGeneration;
    }),
    columnMutation("outer session", "session_id", CHILD_ID),
    payloadMutation("payload session", (payload) => { payload.sessionId = CHILD_ID; }),
    columnMutation("outer target", "target_key", `lifecycle-log/${ROOT_ID}/9`),
    payloadMutation("payload target", (payload) => {
      payload.targetKey = `lifecycle-log/${ROOT_ID}/9`;
    }),
    columnMutation("outer artifact kind", "artifact_kind", "foreign-artifact"),
    payloadMutation("payload artifact kind", (payload) => {
      payload.artifactKind = "foreign-artifact";
    }),
    columnMutation("outer artifact path", "artifact_path", "foreign/path.md"),
    payloadMutation("payload artifact path", (payload) => {
      payload.artifactPath = "foreign/path.md";
    }),
    columnMutation("outer revision", "materialization_revision", 3),
    payloadMutation("numeric payload revision", (payload) => {
      payload.materializationRevision = 2;
    }),
    payloadMutation("nondecimal payload revision", (payload) => {
      payload.materializationRevision = "02";
    }),
    columnMutation("outer fingerprint algorithm", "fingerprint_algorithm", "sha256"),
    payloadMutation("payload fingerprint algorithm", (payload) => {
      fingerprint(payload).algorithm = "sha256";
    }),
    columnMutation("outer fingerprint schema", "fingerprint_schema_version", 2),
    payloadMutation("payload fingerprint schema", (payload) => {
      fingerprint(payload).schemaVersion = 2;
    }),
    columnMutation("outer fingerprint key", "fingerprint_key_id", "foreign-key"),
    payloadMutation("payload fingerprint key", (payload) => {
      fingerprint(payload).keyId = "foreign-key";
    }),
    columnMutation("outer fingerprint domain", "fingerprint_domain", "foreign-domain"),
    payloadMutation("payload fingerprint domain", (payload) => {
      fingerprint(payload).domain = "foreign-domain";
    }),
    columnMutation("outer fingerprint value", "next_fingerprint", H64),
    payloadMutation("payload fingerprint value", (payload) => {
      fingerprint(payload).value = H64;
    }),
    payloadMutation("payload trigger type", (payload) => {
      payload.triggeringEventType = "SessionEnded";
    }),
    eventMutation("trigger event type", "event_type", "SessionEnded"),
    payloadMutation("payload trigger hash", (payload) => {
      payload.triggeringPayloadHash = H64_B;
    }),
    eventMutation("trigger payload hash", "payload_hash", H64_B),
    eventMutation("trigger command index", "command_event_index", 1),
    columnMutation("outer origin kind", "origin_kind", "workflow"),
    payloadMutation("payload origin kind", (payload) => {
      origin(payload).kind = "workflow";
    }),
    columnMutation("outer origin workflow", "workflow_id", uuid(700_003)),
    payloadMutation("payload origin workflow", (payload) => {
      origin(payload).workflowId = uuid(700_003);
    }),
    columnMutation("outer origin generation", "workflow_generation", 1),
    payloadMutation("payload origin generation", (payload) => {
      origin(payload).workflowGeneration = 1;
    }),
    payloadMutation("noncanonical payload JSON", () => undefined, false),
    columnMutation("invalid content hash shape", "content_hash", "A".repeat(64)),
  ];

  for (const mutation of mutations) {
    const corrupted = createFixture();
    const targetKey = addSchema4TerminalLifecycleOutbox(corrupted);
    dropSchema4OutboxMutationGuards(corrupted.connection);
    mutation.apply(corrupted, targetKey);
    assert.deepEqual((await quickIssues(corrupted)).issues, [], mutation.label);
    assert.ok(
      directOutboxShapeIssues(corrupted, true).includes(
        "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH",
      ),
      `full ${mutation.label}`,
    );
  }
  assert.equal(mutations.length, 40);
});
