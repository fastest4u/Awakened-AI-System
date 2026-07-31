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
} from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import {
  referenceCheckpointFingerprint,
  referenceMinimumCheckpointUpperBound,
  referenceMinimumFinalEndingScopeBindingsUpperBound,
} from "./support/qualified-checkpoint-reference.js";
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
    idempotency_key: `quick-integrity/${input.globalPosition}`,
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
    },
  } as ProjectContext;
  return { connection, context };
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
    if (/FROM\s+lifecycle_workflow_generation_folds/i.test(sql)) {
      workflowProjectionReads += 1;
      if (/ORDER\s+BY|OFFSET|WITH\s+RECURSIVE/i.test(sql)) {
        lifecycleHistoryScans += 1;
      }
    }
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

function addCurrentCheckpoint(fixture: Fixture): Record<string, unknown> {
  const evidenceCoverage = {
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
      frameFingerprintKeyId: "key-a",
      frameFingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprintAlgorithm: "hmac-sha256",
      coverageFingerprintSchemaVersion: 1,
      coverageFingerprintKeyId: "key-a",
      coverageFingerprintDomain: "pm-evidence-coverage-v1",
      coverageFingerprint: H64,
      latestBatchId: BATCH_ID,
      latestBatchEventPosition: "2",
    }],
  };
  const checkpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: CHECKPOINT_ID as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 2,
      checkpointEventPosition: 3,
    }),
    evidenceCoverage,
  };
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
    UPDATE streams SET current_version = 3
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = 3,
        latest_checkpoint_fingerprint = $fingerprint
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: CHECKPOINT_ID,
    $fingerprint: checkpointFingerprint(checkpoint, 2),
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
  return checkpoint as Record<string, unknown>;
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

function openWorkflowFixture(version: 1 | 2): Fixture {
  const fixture = createFixture();
  const workflowId = uuid(89_001 + version);
  const commandId = uuid(30_002);
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: version,
    sessionId: ROOT_ID,
    payload: {
      workflowId,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
      ...(version === 2 ? { requestVersion: 2 } : {}),
    },
    lifecycleIntent: requestWitness(version, commandId),
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 2
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  addWorkflow(fixture, {
    workflow_id: workflowId,
    generation: 1,
    phase: "requested",
    root_command_id: commandId,
    triggering_event_position: 2,
    expected_authority_commitment: H64,
    evidence_window_state: "open",
  });
  insertWorkflowProjection(fixture.connection, workflowProjection({
    projectId: PROJECT_ID,
    workflowId,
    workflowGeneration: 1,
    sessionId: ROOT_ID,
    triggerEventPosition: 2n,
    rootCommandId: commandId,
    evidenceWindowState: version === 2 ? "open" : "sealed",
    replacementCheckpointVersion: version,
    effectiveCheckpointVersion: version,
    effectiveDraftSourceEventPosition: 2n,
    previousFingerprint: null,
  }));
  return fixture;
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

function frozenRootV1Fixture(dirty: boolean): Fixture {
  const fixture = createFixture();
  if (dirty) {
    seedCoverage(fixture, { position: 2n, streamVersion: 2n });
  }
  const checkpointPosition = dirty ? 3n : 2n;
  const basePosition = dirty ? 2n : 1n;
  const checkpoint = checkpointFixture({
    checkpointId: uuid(dirty ? 89_011 : 89_010) as never,
    sessionId: ROOT_ID as never,
    baseEventPosition: basePosition,
    checkpointEventPosition: checkpointPosition,
  });
  rawEvent(fixture.connection, {
    globalPosition: checkpointPosition,
    streamId: `session/${ROOT_ID}`,
    streamVersion: dirty ? 3n : 2n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    payload: {
      checkpoint,
      baseEventPosition: basePosition.toString(),
      checkpointEventPosition: checkpointPosition.toString(),
    },
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = $version
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $version: dirty ? 3n : 2n,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  dropTrigger(fixture.connection, "workflow_instances_evidence_v3_insert_guard");
  addWorkflow(fixture, {
    phase: "final-checkpoint-recorded",
    result_json: canonicalJson(workflowStatus(
      "final-checkpoint-recorded",
      checkpoint.checkpointId,
      checkpointPosition.toString(),
    )),
    evidence_frozen_checkpoint_event_position: checkpointPosition,
    evidence_frozen_generation: 1,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: "[]",
  });
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

function frozenTicketFixture(): {
  readonly fixture: Fixture;
  readonly binding: Record<string, unknown>;
  readonly rootCheckpoint: Record<string, unknown>;
} {
  const fixture = createFixture();
  const checkpointId = uuid(88_010);
  const ticketId = uuid(88_011);
  const childCheckpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: checkpointId as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      baseEventPosition: 2,
      checkpointEventPosition: 3,
    }),
  };
  const childFingerprint = checkpointFingerprint(childCheckpoint, 2);
  const transferred = childAuthority(CHILD_ID, 5n, {
    semantic_state: "transferred",
    child_capability_generation: null,
    direct_access_enabled: 0,
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
    latest_checkpoint_id: checkpointId,
    latest_checkpoint_event_position: 3,
    latest_checkpoint_fingerprint: childFingerprint,
    terminal_event_position: 5,
    terminal_event_type: "ChildWorkTransferCreated",
    terminal_at: NOW,
  });
  rawInsert(fixture.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${CHILD_ID}`,
    stream_type: "session",
    current_version: 4,
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
    payload: forkPayload(H64),
  });
  rawEvent(fixture.connection, {
    globalPosition: 3n,
    streamId: `session/${CHILD_ID}`,
    streamVersion: 2n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: {
      checkpoint: childCheckpoint,
      baseEventPosition: "2",
      checkpointEventPosition: "3",
    },
  });
  rawEvent(fixture.connection, {
    globalPosition: 4n,
    streamId: `session/${CHILD_ID}`,
    streamVersion: 3n,
    eventType: "ChildSessionSuspended",
    eventSchemaVersion: 1,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: {
      checkpointId,
      blockers: [],
      followUps: [],
      authorityCommitment: H64_B,
    },
  });
  rawEvent(fixture.connection, {
    globalPosition: 5n,
    streamId: `session/${CHILD_ID}`,
    streamVersion: 4n,
    eventType: "ChildWorkTransferCreated",
    eventSchemaVersion: 1,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: {
      transferTicketId: ticketId,
      checkpointId,
      authorityCommitment: transferred.authority_commitment,
    },
  });
  rawInsert(fixture.connection, "session_authority", transferred);
  rawInsert(fixture.connection, "child_transfer_tickets", {
    project_id: PROJECT_ID,
    transfer_ticket_id: ticketId,
    source_parent_session_id: ROOT_ID,
    source_child_session_id: CHILD_ID,
    source_assignment_json: "{}",
    source_scope_json: "{}",
    checkpoint_id: checkpointId,
    follow_ups_json: "[]",
    source_state_json: "{}",
    lineage_json: "{}",
    created_event_position: 5,
    created_at: NOW,
    claimed_by_root_session_id: null,
    claimed_child_session_id: null,
    claimed_event_position: null,
    claimed_at: null,
  });
  const binding = {
    bindingVersion: 1,
    bindingKind: "carry-forward-ticket",
    childSessionId: CHILD_ID,
    childState: "transferred",
    lastEventPosition: "5",
    streamVersion: "4",
    checkpointId,
    checkpointEventPosition: "3",
    transferTicketId: ticketId,
    transferTicketEventPosition: "5",
  };
  const rootCheckpointId = uuid(88_012);
  const rootCheckpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: rootCheckpointId as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 1,
      checkpointEventPosition: 6,
    }),
    childSummaries: [{
      childSessionId: CHILD_ID,
      state: "transferred",
      lastEventPosition: "5",
      streamVersion: "4",
      latestCheckpointId: checkpointId,
    }],
  };
  rawEvent(fixture.connection, {
    globalPosition: 6n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: {
      checkpoint: rootCheckpoint,
      baseEventPosition: "1",
      checkpointEventPosition: "6",
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
      rootCheckpointId,
      "6",
    )),
    evidence_frozen_checkpoint_event_position: 6,
    evidence_frozen_generation: 1,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: canonicalJson([binding]),
  });
  const forkProjection = genesisChildProjection(CHILD_ID, 2n, H64);
  const checkpointProjection = carriedChildProjection(forkProjection, {
    eventPosition: 3n,
    streamVersion: 2n,
    latestCheckpointId: checkpointId,
    latestCheckpointEventPosition: 3n,
  });
  const suspendedProjection = carriedChildProjection(checkpointProjection, {
    eventPosition: 4n,
    streamVersion: 3n,
    childState: "suspended",
    authorityCommitment: H64_B,
  });
  const transferProjection = carriedChildProjection(suspendedProjection, {
    eventPosition: 5n,
    streamVersion: 4n,
    childState: "transferred",
    authorityCommitment: String(transferred.authority_commitment),
    terminalEventType: "ChildWorkTransferCreated",
    terminalEventPosition: 5n,
  });
  for (const projection of [
    forkProjection,
    checkpointProjection,
    suspendedProjection,
    transferProjection,
  ]) insertChildProjection(fixture.connection, projection);
  return {
    fixture,
    binding,
    rootCheckpoint: rootCheckpoint as Record<string, unknown>,
  };
}

function claimFrozenTicket(
  frozen: ReturnType<typeof frozenTicketFixture>,
): {
  readonly claimedChildSessionId: string;
  readonly claimEventPosition: bigint;
} {
  const claimedChildSessionId = uuid(88_020);
  const forkEventPosition = 7n;
  const claimEventPosition = 8n;
  const ticketId = String(frozen.binding.transferTicketId);
  const claimed = childAuthority(claimedChildSessionId, forkEventPosition, {
    child_capability_generation: null,
    direct_access_enabled: 0,
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
    checkpoint_required_reason: "carry-forward-claim",
    checkpoint_required_event_position: claimEventPosition,
  });
  rawInsert(frozen.fixture.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${claimedChildSessionId}`,
    stream_type: "session",
    current_version: 2,
    created_at: NOW,
    updated_at: NOW,
  });
  rawEvent(frozen.fixture.connection, {
    globalPosition: forkEventPosition,
    streamId: `session/${claimedChildSessionId}`,
    streamVersion: 1n,
    eventType: "SessionForked",
    eventSchemaVersion: 1,
    sessionId: claimedChildSessionId,
    parentSessionId: ROOT_ID,
    payload: {
      ...forkPayload(String(claimed.authority_commitment)),
      directAccessEnabled: false,
      sourceTransferTicketId: ticketId,
    },
  });
  rawEvent(frozen.fixture.connection, {
    globalPosition: claimEventPosition,
    streamId: `session/${claimedChildSessionId}`,
    streamVersion: 2n,
    eventType: "ChildWorkTransferClaimed",
    eventSchemaVersion: 1,
    sessionId: claimedChildSessionId,
    parentSessionId: ROOT_ID,
    payload: {
      transferTicketId: ticketId,
      previousChildSessionId: CHILD_ID,
      previousTransferEventPosition: frozen.binding.transferTicketEventPosition,
    },
  });
  rawInsert(frozen.fixture.connection, "session_authority", claimed);
  frozen.fixture.connection.prepare(`
    UPDATE child_transfer_tickets
    SET claimed_by_root_session_id = $claimedByRootSessionId,
        claimed_child_session_id = $claimedChildSessionId,
        claimed_event_position = $claimedEventPosition,
        claimed_at = $claimedAt
    WHERE project_id = $projectId
      AND transfer_ticket_id = $transferTicketId
  `).run({
    $claimedByRootSessionId: ROOT_ID,
    $claimedChildSessionId: claimedChildSessionId,
    $claimedEventPosition: claimEventPosition,
    $claimedAt: NOW,
    $projectId: PROJECT_ID,
    $transferTicketId: ticketId,
  });
  return { claimedChildSessionId, claimEventPosition };
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
  return { fixture, reportAEventPosition: 3n };
}

afterEach(() => {
  for (const connection of connections.splice(0)) {
    try { connection.close(); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("bounded quick integrity rejects aggregate transition and checkpoint tampering without ordinal reads", async () => {
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
      expected: "SESSION_AUTHORITY_FOLD_MISMATCH",
      mutate(fixture) {
        seedCoverage(fixture);
        addCurrentCheckpoint(fixture);
        dropTrigger(fixture.connection, "session_authority_update_guard");
        fixture.connection.exec(
          `UPDATE session_authority SET latest_checkpoint_fingerprint = '${H64_B}'`,
        );
      },
    },
    {
      expected: "SESSION_AUTHORITY_FOLD_MISMATCH",
      mutate(fixture) {
        seedCoverage(fixture);
        addCurrentCheckpoint(fixture);
        dropTrigger(fixture.connection, "session_authority_update_guard");
        fixture.connection.prepare(`
          UPDATE session_authority SET latest_checkpoint_id = $checkpointId
        `).run({ $checkpointId: uuid(88_099) });
      },
    },
    {
      expected: "SESSION_AUTHORITY_FOLD_MISMATCH",
      mutate(fixture) {
        seedCoverage(fixture);
        addCurrentCheckpoint(fixture);
        dropTrigger(fixture.connection, "events_no_update");
        const row = fixture.connection.prepare(
          "SELECT payload_json FROM events WHERE global_position = 3",
        ).get()!;
        const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
        const checkpoint = payload.checkpoint as Record<string, unknown>;
        checkpoint.taskSummary = "tampered";
        fixture.connection.prepare(
          "UPDATE events SET payload_json = $payload WHERE global_position = 3",
        ).run({ $payload: canonicalJson(payload) });
      },
    },
    {
      expected: "SESSION_AUTHORITY_FOLD_MISMATCH",
      mutate(fixture) {
        seedCoverage(fixture);
        addCurrentCheckpoint(fixture);
        dropTrigger(fixture.connection, "events_no_update");
        fixture.connection.exec(
          "UPDATE events SET event_schema_version = 1 WHERE global_position = 3",
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

it("bounded quick integrity resolves frozen version 2 checkpoints at the recorded event-time baseline", async () => {
  const fixture = createFixture();
  const childStream = `session/${CHILD_ID}`;
  rawInsert(fixture.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: childStream,
    stream_type: "session",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  const childRow = childAuthority(CHILD_ID, 2n);
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: childStream,
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
    position: 3n,
    streamVersion: 2n,
  });
  const childCheckpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: CHECKPOINT_ID as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      baseEventPosition: 3,
      checkpointEventPosition: 4,
    }),
    evidenceCoverage: {
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
        frameFingerprintKeyId: "key-a",
        frameFingerprintDomain: "pm-evidence-frame-v1",
        coverageFingerprintAlgorithm: "hmac-sha256",
        coverageFingerprintSchemaVersion: 1,
        coverageFingerprintKeyId: "key-a",
        coverageFingerprintDomain: "pm-evidence-coverage-v1",
        coverageFingerprint: H64,
        latestBatchId: BATCH_ID,
        latestBatchEventPosition: "3",
      }],
    },
  };
  rawEvent(fixture.connection, {
    globalPosition: 4n,
    streamId: childStream,
    streamVersion: 3n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: {
      checkpoint: childCheckpoint,
      baseEventPosition: "3",
      checkpointEventPosition: "4",
    },
  });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = 4,
        latest_checkpoint_fingerprint = $fingerprint
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: CHECKPOINT_ID,
    $fingerprint: checkpointFingerprint(childCheckpoint, 2),
    $projectId: PROJECT_ID,
    $sessionId: CHILD_ID,
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 3
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $projectId: PROJECT_ID, $streamId: childStream });
  const childGenesisProjection = genesisChildProjection(
    CHILD_ID,
    2n,
    String(childRow.authority_commitment),
  );
  const childCoverageProjection = carriedChildProjection(childGenesisProjection, {
    eventPosition: 3n,
    streamVersion: 2n,
  });
  const childCheckpointProjection = carriedChildProjection(childCoverageProjection, {
    eventPosition: 4n,
    streamVersion: 3n,
    latestCheckpointId: CHECKPOINT_ID,
    latestCheckpointEventPosition: 4n,
  });
  for (const projection of [
    childGenesisProjection,
    childCoverageProjection,
    childCheckpointProjection,
  ]) insertChildProjection(fixture.connection, projection);
  const binding = {
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: CHILD_ID,
    childState: "active",
    lastEventPosition: "4",
    streamVersion: "3",
    checkpointId: CHECKPOINT_ID,
    checkpointEventPosition: "4",
    transferTicketId: null,
    transferTicketEventPosition: null,
  };
  const rootCheckpointId = uuid(88_002);
  const rootCheckpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: rootCheckpointId as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 1,
      checkpointEventPosition: 5,
    }),
    childSummaries: [{
      childSessionId: CHILD_ID,
      state: "active",
      lastEventPosition: "4",
      streamVersion: "3",
      latestCheckpointId: CHECKPOINT_ID,
    }],
  };
  rawEvent(fixture.connection, {
    globalPosition: 5n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    payload: {
      checkpoint: rootCheckpoint,
      baseEventPosition: "1",
      checkpointEventPosition: "5",
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
      rootCheckpointId,
      "5",
    )),
    evidence_frozen_checkpoint_event_position: 5,
    evidence_frozen_generation: 1,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: canonicalJson([binding]),
  });

  dropTrigger(fixture.connection, "session_evidence_coverage_no_delete");
  dropTrigger(fixture.connection, "session_evidence_fingerprints_no_delete");
  dropTrigger(fixture.connection, "session_evidence_coverage_transitions_no_update");
  fixture.connection.exec("PRAGMA foreign_keys = OFF");
  fixture.connection.prepare(
    "DELETE FROM session_evidence_fingerprints WHERE project_id = $projectId AND session_id = $sessionId",
  ).run({ $projectId: PROJECT_ID, $sessionId: CHILD_ID });
  fixture.connection.prepare(
    "DELETE FROM session_evidence_coverage WHERE project_id = $projectId AND session_id = $sessionId",
  ).run({ $projectId: PROJECT_ID, $sessionId: CHILD_ID });
  seedCoverage(fixture, {
    sessionId: CHILD_ID,
    adapterSessionId: ADAPTER_ID,
    batchId: uuid(77_002),
    position: 6n,
    streamVersion: 4n,
    fingerprint: H64_B,
    previousFingerprint: H64,
  });
  assert.deepEqual((await quickIssues(fixture)).issues, []);
  fixture.connection.prepare(`
    UPDATE session_evidence_coverage_transitions
    SET coverage_fingerprint_value = $tampered
    WHERE project_id = $projectId AND session_id = $sessionId
      AND batch_event_position = 3
  `).run({
    $tampered: "c".repeat(64),
    $projectId: PROJECT_ID,
    $sessionId: CHILD_ID,
  });

  const result = await quickIssues(fixture);
  assert.ok(
    result.issues.includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
    JSON.stringify(result.issues),
  );

  const direct = frozenTicketFixture();
  assert.deepEqual((await quickIssues(direct.fixture)).issues, []);
  dropTrigger(direct.fixture.connection, "workflow_instances_evidence_v3_update_guard");
  dropTrigger(direct.fixture.connection, "workflow_instances_lifecycle_update_guard");
  dropTrigger(direct.fixture.connection, "events_no_update");
  const forgedBinding = {
    ...direct.binding,
    lastEventPosition: "7",
    transferTicketEventPosition: "7",
  };
  const forgedRootCheckpoint = {
    ...direct.rootCheckpoint,
    childSummaries: [{
      childSessionId: CHILD_ID,
      state: "transferred",
      lastEventPosition: "7",
      streamVersion: "3",
      latestCheckpointId: direct.binding.checkpointId,
    }],
  };
  direct.fixture.connection.prepare(`
    UPDATE workflow_instances
    SET final_ending_scope_bindings_json = $bindings
    WHERE project_id = $projectId
  `).run({
    $bindings: canonicalJson([forgedBinding]),
    $projectId: PROJECT_ID,
  });
  direct.fixture.connection.prepare(`
    UPDATE events SET payload_json = $payload WHERE global_position = 6
  `).run({
    $payload: canonicalJson({
      checkpoint: forgedRootCheckpoint,
      baseEventPosition: "1",
      checkpointEventPosition: "5",
    }),
  });
  assert.ok(
    (await quickIssues(direct.fixture)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
  );

  const ticket = frozenTicketFixture();
  assert.deepEqual((await quickIssues(ticket.fixture)).issues, []);
  dropTrigger(ticket.fixture.connection, "child_transfer_tickets_update_guard");
  ticket.fixture.connection.prepare(`
    UPDATE child_transfer_tickets SET checkpoint_id = $checkpointId
    WHERE project_id = $projectId
  `).run({
    $checkpointId: uuid(88_099),
    $projectId: PROJECT_ID,
  });
  assert.ok(
    (await quickIssues(ticket.fixture)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
  );
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

it("bounded quick integrity accepts clean frozen version 1 checkpoints and rejects dirty event-time scope", async () => {
  assert.deepEqual((await quickIssues(frozenRootV1Fixture(false))).issues, []);
  assert.ok(
    (await quickIssues(frozenRootV1Fixture(true))).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
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

it("bounded quick integrity folds frozen current-child state at the recorded position", async () => {
  const frozen = frozenCurrentChildFixture("checkpoint");
  assert.deepEqual((await quickIssues(frozen.fixture)).issues, []);
  dropTrigger(frozen.fixture.connection, "workflow_instances_evidence_v3_update_guard");
  dropTrigger(frozen.fixture.connection, "workflow_instances_lifecycle_update_guard");
  dropTrigger(frozen.fixture.connection, "events_no_update");
  const forgedBinding = {
    ...frozen.binding,
    childState: "suspended",
  };
  const forgedRoot = {
    ...frozen.rootCheckpoint,
    childSummaries: [{
      childSessionId: CHILD_ID,
      state: "suspended",
      lastEventPosition: frozen.binding.lastEventPosition,
      streamVersion: frozen.binding.streamVersion,
      latestCheckpointId: frozen.binding.checkpointId,
    }],
  };
  frozen.fixture.connection.prepare(`
    UPDATE workflow_instances SET final_ending_scope_bindings_json = $bindings
    WHERE project_id = $projectId
  `).run({
    $bindings: canonicalJson([forgedBinding]),
    $projectId: PROJECT_ID,
  });
  frozen.fixture.connection.prepare(`
    UPDATE events SET payload_json = $payload WHERE global_position = $position
  `).run({
    $payload: canonicalJson({
      checkpoint: forgedRoot,
      baseEventPosition: "1",
      checkpointEventPosition: frozen.rootCheckpointPosition.toString(),
    }),
    $position: frozen.rootCheckpointPosition,
  });
  assert.ok(
    (await quickIssues(frozen.fixture)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
  );
});

it("bounded quick integrity requires clean event-time scope for null child checkpoints", async () => {
  assert.deepEqual(
    (await quickIssues(frozenCurrentChildFixture("clean-null").fixture)).issues,
    [],
  );
  assert.ok(
    (await quickIssues(frozenCurrentChildFixture("covered-null").fixture)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
  );
});

it("bounded quick integrity requires an effective version 2 draft while evidence is open", async () => {
  assert.deepEqual((await quickIssues(openWorkflowFixture(2))).issues, []);
  assert.ok(
    (await quickIssues(openWorkflowFixture(1))).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
  );
  assert.deepEqual((await quickIssues(openAmendmentFixture(null))).issues, []);
  assert.ok(
    (await quickIssues(openAmendmentFixture(1))).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
  );
});

it("bounded quick integrity strict-decodes frozen transfer provenance", async () => {
  const frozen = frozenTicketFixture();
  assert.deepEqual((await quickIssues(frozen.fixture)).issues, []);
  dropTrigger(frozen.fixture.connection, "events_no_update");
  const row = frozen.fixture.connection.prepare(
    "SELECT payload_json FROM events WHERE global_position = 5",
  ).get()!;
  const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
  payload.unexpectedTicketAlias = frozen.binding.transferTicketId;
  frozen.fixture.connection.prepare(
    "UPDATE events SET payload_json = $payload WHERE global_position = 5",
  ).run({ $payload: canonicalJson(payload) });
  assert.ok(
    (await quickIssues(frozen.fixture)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
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

it("bounded quick integrity strict-decodes every frozen transfer ticket JSON field", async () => {
  const corruptions = [
    ["source_assignment_json", "{\"value\":\"\\u0030\"}"],
    ["source_scope_json", "{\"value\":\"\\u0030\"}"],
    ["follow_ups_json", "[\"\\u0030\"]"],
    ["source_state_json", "{\"value\":\"\\u0030\"}"],
    ["lineage_json", "{\"value\":\"\\u0030\"}"],
  ] as const;
  for (const [column, value] of corruptions) {
    const frozen = frozenTicketFixture();
    dropTrigger(frozen.fixture.connection, "child_transfer_tickets_update_guard");
    frozen.fixture.connection.prepare(`
      UPDATE child_transfer_tickets SET ${column} = $value
      WHERE project_id = $projectId AND transfer_ticket_id = $transferTicketId
    `).run({
      $value: value,
      $projectId: PROJECT_ID,
      $transferTicketId: frozen.binding.transferTicketId as string,
    });
    assert.ok(
      (await quickIssues(frozen.fixture)).issues
        .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
      column,
    );
  }
});

it("bounded quick integrity binds a legal later ticket claim to its strict direct event", async () => {
  const legal = frozenTicketFixture();
  claimFrozenTicket(legal);
  assert.deepEqual((await quickIssues(legal.fixture)).issues, []);

  const tampered = frozenTicketFixture();
  const claim = claimFrozenTicket(tampered);
  dropTrigger(tampered.fixture.connection, "events_no_update");
  const claimRow = tampered.fixture.connection.prepare(
    "SELECT payload_json FROM events WHERE global_position = $position",
  ).get({ $position: claim.claimEventPosition })!;
  const claimPayload = JSON.parse(String(claimRow.payload_json)) as Record<string, unknown>;
  claimPayload.previousChildSessionId = uuid(88_021);
  tampered.fixture.connection.prepare(`
    UPDATE events SET payload_json = $payload
    WHERE global_position = $position
  `).run({
    $payload: canonicalJson(claimPayload),
    $position: claim.claimEventPosition,
  });
  assert.ok(
    (await quickIssues(tampered.fixture)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
  );
});

it("bounded quick integrity reads only target projection dependencies", async () => {
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
  assert.equal(result.reads.childProjectionTargetReads(), 1);
  assert.equal(result.reads.childProjectionPredecessorReads(), 1);
  assert.equal(result.reads.reportWitnessReads(), 0);

  const mutations: readonly {
    readonly label: string;
    readonly set: string;
  }[] = [
    { label: "project", set: `project_id = '${uuid(94_001)}'` },
    { label: "child", set: `child_session_id = '${uuid(94_002)}'` },
    { label: "event position", set: "event_position = 4" },
    { label: "stream version", set: "stream_version = 3" },
    { label: "root", set: `root_session_id = '${uuid(94_003)}'` },
    { label: "state", set: "child_state = 'completion-proposed'" },
    { label: "checkpoint id", set: `latest_checkpoint_id = '${uuid(94_004)}'` },
    { label: "checkpoint source", set: "latest_checkpoint_event_position = 2" },
    { label: "authority", set: `authority_commitment = '${H64_B}'` },
    { label: "previous hash", set: `previous_fingerprint = '${H64_B}'` },
    { label: "current hash", set: `fingerprint = '${H64_B}'` },
  ];
  for (const mutation of mutations) {
    const tampered = frozenCurrentChildFixture("checkpoint");
    dropTrigger(tampered.fixture.connection, "lifecycle_child_event_folds_no_update");
    tampered.fixture.connection.exec(`
      UPDATE lifecycle_child_event_folds
      SET ${mutation.set}
      WHERE project_id = '${PROJECT_ID}'
        AND child_session_id = '${CHILD_ID}'
        AND event_position = 3
    `);
    assert.ok(
      (await quickIssues(tampered.fixture)).issues
        .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
      mutation.label,
    );
  }

  for (const mutation of [
    {
      label: "terminal type and state linkage",
      set: "child_state = 'completed', terminal_event_type = 'ChildSessionCompleted'",
    },
    { label: "terminal source", set: "terminal_event_position = 4" },
  ] as const) {
    const tampered = frozenTicketFixture();
    dropTrigger(tampered.fixture.connection, "lifecycle_child_event_folds_no_update");
    tampered.fixture.connection.exec(`
      UPDATE lifecycle_child_event_folds
      SET ${mutation.set}
      WHERE project_id = '${PROJECT_ID}'
        AND child_session_id = '${CHILD_ID}'
        AND event_position = 5
    `);
    assert.ok(
      (await quickIssues(tampered.fixture)).issues
        .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
      mutation.label,
    );
  }

  for (const mutation of [
    { label: "target vault", column: "vault_id", value: uuid(94_010) },
    { label: "target store", column: "store_id", value: uuid(94_011) },
    { label: "target workspace", column: "workspace_id", value: uuid(94_012) },
    { label: "target branch", column: "branch_ref", value: "refs/heads/tampered" },
  ] as const) {
    const tampered = frozenCurrentChildFixture("clean-null");
    dropTrigger(tampered.fixture.connection, "events_no_update");
    tampered.fixture.connection.prepare(`
      UPDATE events SET ${mutation.column} = $value WHERE global_position = 2
    `).run({ $value: mutation.value });
    assert.ok(
      (await quickIssues(tampered.fixture)).issues
        .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
      mutation.label,
    );
  }
});

it("bounded quick integrity accepts legal open-window unchanged null carry", async () => {
  const legal = openAmendmentFixture(null);
  const result = await quickIssues(legal);
  assert.deepEqual(result.issues, []);
  assert.equal(result.reads.workflowProjectionReads(), 2);

  const workflowMutations = [
    { label: "project", set: `project_id = '${uuid(95_001)}'` },
    { label: "workflow", set: `workflow_id = '${uuid(95_002)}'` },
    { label: "generation", set: "workflow_generation = 3" },
    { label: "session", set: `session_id = '${uuid(95_003)}'` },
    {
      label: "trigger",
      set: "trigger_event_position = 1, effective_draft_source_event_position = 1",
    },
    { label: "root command", set: `root_command_id = '${uuid(95_004)}'` },
    { label: "window", set: "evidence_window_state = 'sealed'" },
    {
      label: "replacement",
      set: "evidence_window_state = 'sealed', replacement_checkpoint_version = 1, effective_checkpoint_version = 1, effective_draft_source_event_position = 3",
    },
    {
      label: "effective version",
      set: "evidence_window_state = 'sealed', effective_checkpoint_version = 1",
    },
    { label: "effective source", set: "effective_draft_source_event_position = 3" },
    { label: "previous hash", set: `previous_fingerprint = '${H64_B}'` },
    { label: "current hash", set: `fingerprint = '${H64_B}'` },
  ] as const;
  for (const mutation of workflowMutations) {
    const tampered = openAmendmentFixture(null);
    dropTrigger(tampered.connection, "lifecycle_workflow_generation_folds_no_update");
    tampered.connection.exec(`
      UPDATE lifecycle_workflow_generation_folds
      SET ${mutation.set}
      WHERE project_id = '${PROJECT_ID}' AND workflow_generation = 2
    `);
    assert.ok(
      (await quickIssues(tampered)).issues
        .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
      mutation.label,
    );
  }

  const triggerTampered = openAmendmentFixture(null);
  dropTrigger(triggerTampered.connection, "events_no_update");
  const triggerRow = triggerTampered.connection.prepare(
    "SELECT payload_json FROM events WHERE global_position = 3",
  ).get()!;
  const triggerPayload = JSON.parse(String(triggerRow.payload_json)) as Record<string, unknown>;
  triggerPayload.previousWorkflowGeneration = 2;
  triggerPayload.workflowGeneration = 3;
  triggerTampered.connection.prepare(
    "UPDATE events SET payload_json = $payload WHERE global_position = 3",
  ).run({ $payload: canonicalJson(triggerPayload) });
  assert.ok(
    (await quickIssues(triggerTampered)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
    "trigger event",
  );

  const sourceTampered = openAmendmentFixture(null);
  dropTrigger(sourceTampered.connection, "events_no_update");
  const sourceRow = sourceTampered.connection.prepare(
    "SELECT payload_json FROM events WHERE global_position = 2",
  ).get()!;
  const sourcePayload = JSON.parse(String(sourceRow.payload_json)) as Record<string, unknown>;
  sourcePayload.requireMaterialization = true;
  sourceTampered.connection.prepare(
    "UPDATE events SET payload_json = $payload WHERE global_position = 2",
  ).run({ $payload: canonicalJson(sourcePayload) });
  assert.ok(
    (await quickIssues(sourceTampered)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
    "effective source event",
  );

  const sourceContextTampered = openAmendmentFixture(null);
  dropTrigger(sourceContextTampered.connection, "events_no_update");
  sourceContextTampered.connection.prepare(`
    UPDATE events SET workspace_id = $workspaceId WHERE global_position = 2
  `).run({ $workspaceId: uuid(95_010) });
  assert.ok(
    (await quickIssues(sourceContextTampered)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
    "effective source context",
  );

  const intentTampered = openAmendmentFixture(null);
  dropTrigger(intentTampered.connection, "events_no_update");
  intentTampered.connection.prepare(`
    UPDATE events SET lifecycle_intent_json = $intent
    WHERE global_position = 3 AND command_event_index = 0
  `).run({ $intent: requestWitness(2, uuid(30_003)) });
  assert.ok(
    (await quickIssues(intentTampered)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
    "command event zero intent",
  );

  const tampered = openAmendmentFixture(null);
  const generationOneFingerprint = String(tampered.connection.prepare(`
    SELECT fingerprint
    FROM lifecycle_workflow_generation_folds
    WHERE project_id = $projectId AND workflow_generation = 1
  `).get({ $projectId: PROJECT_ID })!.fingerprint);
  const bad = workflowProjection({
    projectId: PROJECT_ID,
    workflowId: uuid(89_005),
    workflowGeneration: 2,
    sessionId: ROOT_ID,
    triggerEventPosition: 3n,
    rootCommandId: uuid(30_003),
    evidenceWindowState: "open",
    replacementCheckpointVersion: null,
    effectiveCheckpointVersion: 2,
    effectiveDraftSourceEventPosition: 3n,
    previousFingerprint: generationOneFingerprint,
  });
  dropTrigger(tampered.connection, "lifecycle_workflow_generation_folds_no_update");
  tampered.connection.prepare(`
    UPDATE lifecycle_workflow_generation_folds
    SET effective_draft_source_event_position = $source,
        fingerprint = $fingerprint
    WHERE project_id = $projectId AND workflow_generation = 2
  `).run({
    $source: 3n,
    $fingerprint: bad.fingerprint,
    $projectId: PROJECT_ID,
  });
  assert.ok(
    (await quickIssues(tampered)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
  );
});

it("bounded quick integrity verifies a consumer bound to a non-latest report witness", async () => {
  const legal = nonLatestReportFixture();
  const result = await quickIssues(legal.fixture);
  assert.deepEqual(result.issues, []);
  assert.equal(result.reads.childProjectionTargetReads(), 1);
  assert.equal(result.reads.childProjectionPredecessorReads(), 1);
  assert.equal(result.reads.reportWitnessReads(), 1);
  const consumer = legal.fixture.connection.prepare(`
    SELECT latest_report_id, completion_report_id
    FROM lifecycle_child_event_folds
    WHERE project_id = $projectId AND child_session_id = $childSessionId
      AND event_position = 6
  `).get({ $projectId: PROJECT_ID, $childSessionId: CHILD_ID })!;
  assert.notEqual(consumer.latest_report_id, consumer.completion_report_id);

  for (const mutation of [
    { label: "report count carry", set: "report_count = 2" },
    { label: "latest report carry", set: `latest_report_id = '${uuid(91_000)}'` },
    { label: "report index carry", set: `report_index_fingerprint = '${H64_B}'` },
    { label: "completion report", set: `completion_report_id = '${uuid(91_001)}'` },
  ] as const) {
    const changed = nonLatestReportFixture();
    dropTrigger(changed.fixture.connection, "lifecycle_child_event_folds_no_update");
    changed.fixture.connection.exec(`
      UPDATE lifecycle_child_event_folds
      SET ${mutation.set}
      WHERE project_id = '${PROJECT_ID}'
        AND child_session_id = '${CHILD_ID}'
        AND event_position = 6
    `);
    assert.ok(
      (await quickIssues(changed.fixture)).issues
        .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
      mutation.label,
    );
  }

  for (const mutation of [
    { label: "witness report id", set: `reported_report_id = '${uuid(91_099)}'` },
    { label: "witness item count", set: "reported_item_count = 3" },
    { label: "witness item set", set: `reported_item_set_fingerprint = '${H64_B}'` },
    { label: "witness event ordering", set: "event_position = 7" },
    { label: "witness stream ordering", set: "stream_version = 6" },
    { label: "witness fingerprint", set: `fingerprint = '${H64_B}'` },
  ] as const) {
    const changed = nonLatestReportFixture();
    dropTrigger(changed.fixture.connection, "lifecycle_child_event_folds_no_update");
    changed.fixture.connection.exec(`
      UPDATE lifecycle_child_event_folds
      SET ${mutation.set}
      WHERE project_id = '${PROJECT_ID}'
        AND child_session_id = '${CHILD_ID}'
        AND reported_report_id = '${uuid(91_000)}'
    `);
    assert.ok(
      (await quickIssues(changed.fixture)).issues
        .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
      mutation.label,
    );
  }

  const tampered = nonLatestReportFixture();
  dropTrigger(tampered.fixture.connection, "events_no_update");
  const row = tampered.fixture.connection.prepare(
    "SELECT payload_json FROM events WHERE global_position = $position",
  ).get({ $position: tampered.reportAEventPosition })!;
  const payload = JSON.parse(String(row.payload_json)) as {
    report: { findings: { itemId: string }[] };
  };
  payload.report.findings[0]!.itemId = uuid(92_099);
  tampered.fixture.connection.prepare(`
    UPDATE events SET payload_json = $payload
    WHERE global_position = $position
  `).run({
    $payload: canonicalJson(payload),
    $position: tampered.reportAEventPosition,
  });
  assert.ok(
    (await quickIssues(tampered.fixture)).issues
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
  );
});
