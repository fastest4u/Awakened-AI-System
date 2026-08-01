import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, it } from "node:test";

import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type {
  HistoricalEvidenceIntegrityProviderPort,
  IntegrityIssueCode,
} from "../src/orchestrator/integrity/integrity.types.js";
import { LifecycleIntegrityService } from "../src/orchestrator/integrity/lifecycle-integrity.service.js";
import {
  authorityCommitment,
  type CommittedAuthorityV1,
} from "../src/orchestrator/lifecycle/authority/authority-commitment.js";
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
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
  referenceChildEventFoldFingerprint,
  referenceReportIndexGenesisFingerprint,
  referenceWorkflowGenerationFingerprint,
} from "./support/lifecycle-projection-reference.js";
import { qualifiedCheckpointFixture } from "./support/lifecycle-fixtures.js";

const NOW = "2026-07-31T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const ROOT_ID = "44444444-4444-4444-8444-444444444444";
const CHILD_ID = "55555555-5555-4555-8555-555555555555";
const ADAPTER_ID = "66666666-6666-4666-8666-666666666666";
const BATCH_ID = "77777777-7777-4777-8777-777777777777";
const SECOND_BATCH_ID = "88888888-8888-4888-8888-888888888888";
const EVIDENCE_FRAME_ID = "0000ea61-0000-4000-8000-00000000ea61";
const CHECKPOINT_ID = "99999999-9999-4999-8999-999999999999";
const ROTATED_BATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROTATED_FRAME_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE_ID = "1".repeat(64);
const H64 = "a".repeat(64);
const H64_B = "b".repeat(64);
const roots: string[] = [];
const connections: SqliteConnection[] = [];
const driver = new NodeSqliteDriver({ DatabaseSync });

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

function rootAuthority(): Record<string, SqliteValue> {
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
    root_handle_client_instance_id: "client-full-integrity",
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
  };
  row.authority_commitment = commitmentForRow(row);
  return row;
}

function childAuthority(
  sessionId: string,
  authorityPosition: bigint,
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
    child_handle_expires_at: "2026-08-31T00:00:00.000Z",
    child_handle_actor_role: "untrusted",
    child_handle_client_instance_id: "child-client",
    child_handle_verifier: H64,
    child_handle_issuance_id: uuid(50_000 + Number(authorityPosition)),
    authority_event_position: authorityPosition,
  };
  child.authority_commitment = commitmentForRow(child);
  return child;
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
    readonly parentSessionId: string | null;
    readonly payload: unknown;
    readonly commandId?: string;
    readonly idempotencyKey?: string;
    readonly lifecycleIntent?: string | null;
  },
): void {
  const offset = Number(input.globalPosition);
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
    parent_session_id: input.parentSessionId,
    actor_role: "primary",
    agent_id: "agent-full-integrity",
    client_instance_id: "client-full-integrity",
    correlation_id: input.sessionId,
    causation_id: null,
    command_id: input.commandId ?? uuid(30_000 + offset),
    idempotency_key: input.idempotencyKey ?? `full-integrity/${input.globalPosition}`,
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

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "qualified-full-integrity-"));
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
    parentSessionId: null,
    payload: {
      sessionKind: "root",
      ownerGeneration: 1,
      continuityKey: "continuity-key",
      clientNamespace: "tests",
      creatingAgentId: "agent-full-integrity",
      creatingClientInstanceId: "client-full-integrity",
      authorityCommitment: rootRow.authority_commitment,
    },
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
        clientInstanceId: "client-full-integrity",
      },
    } as ProjectContext,
  };
}

function addChildFork(
  fixture: Fixture,
  input: { readonly projection?: boolean } = {},
): void {
  const child = childAuthority(CHILD_ID, 2n);
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
    payload: {
      parentSessionId: ROOT_ID,
      assignment: {
        assignmentId: uuid(55_001),
        summary: "Task 12J child replay",
        scope: "tests/qualified-checkpoint-full-integrity.test.ts",
      },
      rootOwnerGeneration: 1,
      directAccessEnabled: true,
      authorityCommitment: child.authority_commitment,
      sourceTransferTicketId: null,
    },
  });
  rawInsert(fixture.connection, "session_authority", child);
  if (input.projection === false) return;
  const projection = {
    projectId: PROJECT_ID,
    childSessionId: CHILD_ID,
    eventPosition: 2n,
    streamVersion: 1n,
    rootSessionId: ROOT_ID,
    childState: "active" as const,
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    authorityCommitment: String(child.authority_commitment),
    terminalEventType: null,
    terminalEventPosition: null,
    reportCount: 0,
    latestReportId: null,
    reportIndexFingerprint: referenceReportIndexGenesisFingerprint(
      PROJECT_ID,
      CHILD_ID,
    ),
    completionReportId: null,
    reportedReportId: null,
    reportedItemCount: null,
    reportedItemSetFingerprint: null,
    previousFingerprint: null,
  };
  rawInsert(fixture.connection, "lifecycle_child_event_folds", {
    project_id: projection.projectId,
    child_session_id: projection.childSessionId,
    event_position: projection.eventPosition,
    stream_version: projection.streamVersion,
    root_session_id: projection.rootSessionId,
    child_state: projection.childState,
    latest_checkpoint_id: projection.latestCheckpointId,
    latest_checkpoint_event_position: projection.latestCheckpointEventPosition,
    authority_commitment: projection.authorityCommitment,
    terminal_event_type: projection.terminalEventType,
    terminal_event_position: projection.terminalEventPosition,
    report_count: projection.reportCount,
    latest_report_id: projection.latestReportId,
    report_index_fingerprint: projection.reportIndexFingerprint,
    completion_report_id: projection.completionReportId,
    reported_report_id: projection.reportedReportId,
    reported_item_count: projection.reportedItemCount,
    reported_item_set_fingerprint: projection.reportedItemSetFingerprint,
    previous_fingerprint: projection.previousFingerprint,
    fingerprint: referenceChildEventFoldFingerprint(projection),
  });
}

function addCoverage(fixture: Fixture): void {
  const frameId = EVIDENCE_FRAME_ID;
  const payload = {
    adapterSessionId: ADAPTER_ID,
    batchId: BATCH_ID,
    batchFirstOrdinal: "0",
    batchLastOrdinal: "0",
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
    captureMode: "coverage-only",
    contentRetained: false,
    frames: [{
      frameId,
      ordinal: "0",
      sourceKind: "model-turn",
      observedAt: NOW,
      contentFingerprint: H64_B,
    }],
  };
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 2, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    payload,
  });
  fixture.connection.exec("BEGIN IMMEDIATE");
  try {
    rawInsert(fixture.connection, "session_evidence_coverage_transitions", {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      adapter_session_id: ADAPTER_ID,
      batch_id: BATCH_ID,
      batch_event_position: 2,
      batch_first_ordinal: 0,
      batch_last_ordinal: 0,
      coverage_first_ordinal: 0,
      coverage_last_ordinal: 0,
      highest_contiguous_ordinal: 0,
      missing_intervals_json: "[]",
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
      first_ordinal: 0,
      last_ordinal: 0,
      highest_contiguous_ordinal: 0,
      missing_intervals_json: "[]",
      fingerprint_algorithm: "hmac-sha256",
      fingerprint_schema_version: 1,
      fingerprint_key_id: "key-a",
      fingerprint_domain: "pm-evidence-frame-v1",
      latest_batch_id: BATCH_ID,
      latest_batch_event_position: 2,
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
      ordinal: 0,
      frame_id: frameId,
      source_kind: "model-turn",
      observed_at: NOW,
      fingerprint_algorithm: "hmac-sha256",
      fingerprint_schema_version: 1,
      fingerprint_key_id: "key-a",
      fingerprint_domain: "pm-evidence-frame-v1",
      fingerprint_value: H64_B,
      batch_id: BATCH_ID,
      recorded_event_position: 2,
      created_at: NOW,
    });
    fixture.connection.exec("COMMIT");
  } catch (error) {
    fixture.connection.exec("ROLLBACK");
    throw error;
  }
}

function addZeroNewCoverage(
  fixture: Fixture,
  input: { readonly position?: bigint; readonly streamVersion?: bigint } = {},
): void {
  const position = input.position ?? 3n;
  const streamVersion = input.streamVersion ?? 3n;
  const payload = {
    adapterSessionId: ADAPTER_ID,
    batchId: SECOND_BATCH_ID,
    batchFirstOrdinal: "0",
    batchLastOrdinal: "0",
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
    captureMode: "coverage-only",
    contentRetained: false,
    frames: [{
      frameId: EVIDENCE_FRAME_ID,
      ordinal: "0",
      sourceKind: "model-turn",
      observedAt: NOW,
      contentFingerprint: H64_B,
    }],
  };
  fixture.connection.prepare(`
    UPDATE streams SET current_version = $streamVersion, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
    $streamVersion: streamVersion,
  });
  rawEvent(fixture.connection, {
    globalPosition: position,
    streamId: `session/${ROOT_ID}`,
    streamVersion,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    payload,
  });
  fixture.connection.exec("BEGIN IMMEDIATE");
  try {
    rawInsert(fixture.connection, "session_evidence_coverage_transitions", {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      adapter_session_id: ADAPTER_ID,
      batch_id: SECOND_BATCH_ID,
      batch_event_position: position,
      batch_first_ordinal: 0,
      batch_last_ordinal: 0,
      coverage_first_ordinal: 0,
      coverage_last_ordinal: 0,
      highest_contiguous_ordinal: 0,
      missing_intervals_json: "[]",
      frame_fingerprint_algorithm: "hmac-sha256",
      frame_fingerprint_schema_version: 1,
      frame_fingerprint_key_id: "key-a",
      frame_fingerprint_domain: "pm-evidence-frame-v1",
      previous_coverage_fingerprint_value: H64,
      coverage_fingerprint_algorithm: "hmac-sha256",
      coverage_fingerprint_schema_version: 1,
      coverage_fingerprint_key_id: "key-a",
      coverage_fingerprint_domain: "pm-evidence-coverage-v1",
      coverage_fingerprint_value: H64,
      new_frame_count: 0,
      capture_mode: "coverage-only",
      content_retained: 0,
      created_at: NOW,
    });
    fixture.connection.prepare(`
      UPDATE session_evidence_coverage
      SET latest_batch_id = $batchId,
          latest_batch_event_position = $position,
          updated_at = $now
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND adapter_session_id = $adapterSessionId
    `).run({
      $batchId: SECOND_BATCH_ID,
      $now: NOW,
      $position: position,
      $projectId: PROJECT_ID,
      $sessionId: ROOT_ID,
      $adapterSessionId: ADAPTER_ID,
    });
    fixture.connection.exec("COMMIT");
  } catch (error) {
    fixture.connection.exec("ROLLBACK");
    throw error;
  }
}

function addRotatedCoverage(fixture: Fixture): void {
  const payload = {
    adapterSessionId: ADAPTER_ID,
    batchId: ROTATED_BATCH_ID,
    batchFirstOrdinal: "1",
    batchLastOrdinal: "1",
    coverageFirstOrdinal: "0",
    coverageLastOrdinal: "1",
    highestContiguousOrdinal: "1",
    missingIntervals: [],
    frameFingerprintAlgorithm: "hmac-sha256",
    frameFingerprintSchemaVersion: 1,
    frameFingerprintKeyId: "key-b",
    frameFingerprintDomain: "pm-evidence-frame-v1",
    coverageFingerprintAlgorithm: "hmac-sha256",
    coverageFingerprintSchemaVersion: 1,
    coverageFingerprintKeyId: "key-b",
    coverageFingerprintDomain: "pm-evidence-coverage-v1",
    coverageFingerprint: H64,
    captureMode: "coverage-only",
    contentRetained: false,
    frames: [{
      frameId: ROTATED_FRAME_ID,
      ordinal: "1",
      sourceKind: "tool-result",
      observedAt: NOW,
      contentFingerprint: H64_B,
    }],
  };
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 3, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  rawEvent(fixture.connection, {
    globalPosition: 3n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 3n,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    payload,
  });
  fixture.connection.exec("DROP TRIGGER session_evidence_coverage_update_guard");
  fixture.connection.exec("DROP TRIGGER session_evidence_coverage_v3_update_guard");
  fixture.connection.exec("BEGIN IMMEDIATE");
  try {
    rawInsert(fixture.connection, "session_evidence_coverage_transitions", {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      adapter_session_id: ADAPTER_ID,
      batch_id: ROTATED_BATCH_ID,
      batch_event_position: 3,
      batch_first_ordinal: 1,
      batch_last_ordinal: 1,
      coverage_first_ordinal: 0,
      coverage_last_ordinal: 1,
      highest_contiguous_ordinal: 1,
      missing_intervals_json: "[]",
      frame_fingerprint_algorithm: "hmac-sha256",
      frame_fingerprint_schema_version: 1,
      frame_fingerprint_key_id: "key-b",
      frame_fingerprint_domain: "pm-evidence-frame-v1",
      previous_coverage_fingerprint_value: H64,
      coverage_fingerprint_algorithm: "hmac-sha256",
      coverage_fingerprint_schema_version: 1,
      coverage_fingerprint_key_id: "key-b",
      coverage_fingerprint_domain: "pm-evidence-coverage-v1",
      coverage_fingerprint_value: H64,
      new_frame_count: 1,
      capture_mode: "coverage-only",
      content_retained: 0,
      created_at: NOW,
    });
    fixture.connection.prepare(`
      UPDATE session_evidence_coverage
      SET last_ordinal = 1,
          highest_contiguous_ordinal = 1,
          fingerprint_key_id = 'key-b',
          coverage_fingerprint_key_id = 'key-b',
          latest_batch_id = $batchId,
          latest_batch_event_position = 3,
          updated_at = $now
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND adapter_session_id = $adapterSessionId
    `).run({
      $batchId: ROTATED_BATCH_ID,
      $now: NOW,
      $projectId: PROJECT_ID,
      $sessionId: ROOT_ID,
      $adapterSessionId: ADAPTER_ID,
    });
    rawInsert(fixture.connection, "session_evidence_fingerprints", {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      adapter_session_id: ADAPTER_ID,
      ordinal: 1,
      frame_id: ROTATED_FRAME_ID,
      source_kind: "tool-result",
      observed_at: NOW,
      fingerprint_algorithm: "hmac-sha256",
      fingerprint_schema_version: 1,
      fingerprint_key_id: "key-b",
      fingerprint_domain: "pm-evidence-frame-v1",
      fingerprint_value: H64_B,
      batch_id: ROTATED_BATCH_ID,
      recorded_event_position: 3,
      created_at: NOW,
    });
    fixture.connection.exec("COMMIT");
  } catch (error) {
    fixture.connection.exec("ROLLBACK");
    throw error;
  }
}

function persistentSnapshot(connection: SqliteConnection): string {
  const tables = connection.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => String(row.name));
  return JSON.stringify(tables.map((table) => ({
    table,
    rows: connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  })), (_key, value: unknown) => (
    typeof value === "bigint" ? value.toString() : value
  ));
}

function checkpointFingerprint(checkpoint: unknown): string {
  return createHash("sha256")
    .update("project-memory/checkpoint/v2\n", "utf8")
    .update(canonicalJson(checkpoint), "utf8")
    .digest("hex");
}

function addHistoricalCheckpoint(
  fixture: Fixture,
  input: { readonly tamperHistoricalDigest: boolean },
): void {
  const checkpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: CHECKPOINT_ID as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 2,
      checkpointEventPosition: 3,
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
        coverageFingerprint: input.tamperHistoricalDigest ? H64_B : H64,
        latestBatchId: BATCH_ID,
        latestBatchEventPosition: "2",
      }],
    },
  };
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 3, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  rawEvent(fixture.connection, {
    globalPosition: 3n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 3n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
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
    $checkpointId: CHECKPOINT_ID,
    $fingerprint: checkpointFingerprint(checkpoint),
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
}

type ReplayKind =
  | "event"
  | "child-fold"
  | "workflow-fold"
  | "coverage-transition"
  | "immutable-ordinal";

function observedReplayConnection(connection: SqliteConnection): {
  readonly connection: SqliteConnection;
  readonly counts: ReadonlyMap<ReplayKind, {
    readonly prepares: number;
    readonly iterates: number;
    readonly visits: number;
    readonly closes: number;
  }>;
} {
  const mutable = new Map<ReplayKind, {
    prepares: number;
    iterates: number;
    visits: number;
    closes: number;
  }>();
  const kind = (sql: string): ReplayKind | null => {
    const match = /lifecycle-full:(event|child-fold|workflow-fold|coverage-transition|immutable-ordinal)/
      .exec(sql);
    return (match?.[1] as ReplayKind | undefined) ?? null;
  };
  const entry = (value: ReplayKind) => {
    let result = mutable.get(value);
    if (result === undefined) {
      result = { prepares: 0, iterates: 0, visits: 0, closes: 0 };
      mutable.set(value, result);
    }
    return result;
  };
  return {
    connection: {
      exec(sql) { connection.exec(sql); },
      prepare(sql) {
        const replayKind = kind(sql);
        if (replayKind === null) return connection.prepare(sql);
        entry(replayKind).prepares += 1;
        const statement = connection.prepare(sql);
        return {
          run(params) { return statement.run(params); },
          get(params) { return statement.get(params); },
          all(params) { return statement.all(params); },
          iterate(params) {
            entry(replayKind).iterates += 1;
            const iterator = statement.iterate(params);
            return {
              next() {
                const next = iterator.next();
                if (!next.done) entry(replayKind).visits += 1;
                return next;
              },
              return() {
                entry(replayKind).closes += 1;
                return iterator.return?.() ?? { done: true, value: undefined };
              },
              [Symbol.iterator]() { return this; },
            } as IterableIterator<Record<string, SqliteValue>>;
          },
        } satisfies SqliteStatement;
      },
      close() { connection.close(); },
    },
    counts: mutable,
  };
}

function checkpointDraft(): Record<string, unknown> {
  const source = qualifiedCheckpointFixture();
  return {
    checkpointVersion: 2,
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

function requestWitness(commandId: string): string {
  return buildLifecycleIntentWitness({
    commandType: "request-session-end",
    commandId,
    idempotencyKey: "full-integrity/end-request/2",
    agentId: "agent-full-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    request: {
      requestVersion: 2,
      sessionId: ROOT_ID,
      childEndPolicy: "require-completed",
      finalCheckpoint: checkpointDraft(),
      validationProfileIds: [],
      requestedQualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
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
    presentingClientInstanceId: "client-full-integrity",
    targetActorRole: "primary",
    targetClientInstanceId: "client-full-integrity",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function cancelWitness(
  workflowId: string,
  commandId: string,
  checkpointId: string,
): string {
  return buildLifecycleIntentWitness({
    commandType: "cancel-session-end",
    commandId,
    idempotencyKey: "full-integrity/end-cancel/1",
    agentId: "agent-full-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    workflowId,
    expectedStreamVersion: "2",
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
    presentingClientInstanceId: "client-full-integrity",
    targetActorRole: "primary",
    targetClientInstanceId: "client-full-integrity",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  }).source;
}

function insertWorkflowProjection(
  fixture: Fixture,
  projection: {
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
  },
): void {
  rawInsert(fixture.connection, "lifecycle_workflow_generation_folds", {
    project_id: projection.projectId,
    workflow_id: projection.workflowId,
    workflow_generation: projection.workflowGeneration,
    session_id: projection.sessionId,
    trigger_event_position: projection.triggerEventPosition,
    root_command_id: projection.rootCommandId,
    evidence_window_state: projection.evidenceWindowState,
    replacement_checkpoint_version: projection.replacementCheckpointVersion,
    effective_checkpoint_version: projection.effectiveCheckpointVersion,
    effective_draft_source_event_position: projection.effectiveDraftSourceEventPosition,
    previous_fingerprint: projection.previousFingerprint,
    fingerprint: referenceWorkflowGenerationFingerprint(projection),
  });
}

function addWorkflowRequest(
  fixture: Fixture,
  input: { readonly projection?: boolean } = {},
): { readonly workflowId: string; readonly commandId: string } {
  const workflowId = uuid(89_001);
  const commandId = uuid(30_002);
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId,
    idempotencyKey: "full-integrity/end-request/2",
    lifecycleIntent: requestWitness(commandId),
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
    evidence_frozen_checkpoint_event_position: null,
    evidence_frozen_generation: null,
    evidence_window_state: "open",
    final_ending_scope_bindings_json: null,
  });
  if (input.projection !== false) {
    insertWorkflowProjection(fixture, {
      projectId: PROJECT_ID,
      workflowId,
      workflowGeneration: 1,
      sessionId: ROOT_ID,
      triggerEventPosition: 2n,
      rootCommandId: commandId,
      evidenceWindowState: "open",
      replacementCheckpointVersion: 2,
      effectiveCheckpointVersion: 2,
      effectiveDraftSourceEventPosition: 2n,
      previousFingerprint: null,
    });
  }
  return { workflowId, commandId };
}

function addSchema2CollapsedCancel(fixture: Fixture): void {
  const { workflowId } = addWorkflowRequest(fixture, { projection: false });
  const commandId = uuid(30_003);
  const checkpointId = uuid(88_003);
  rawEvent(fixture.connection, {
    globalPosition: 3n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 3n,
    eventType: "SessionEndCancelled",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId,
    idempotencyKey: "full-integrity/end-cancel/1",
    lifecycleIntent: cancelWitness(workflowId, commandId, checkpointId),
    payload: {
      workflowId,
      workflowGeneration: 1,
      restoredState: "active",
      preTransitionCheckpointId: checkpointId,
    },
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 3, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET semantic_state = 'active',
        checkpoint_required_reason = 'end-cancellation',
        checkpoint_required_event_position = 3,
        updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $sessionId: ROOT_ID });
  fixture.connection.exec(
    "DROP TRIGGER lifecycle_workflow_generation_folds_insert_guard",
  );
  insertWorkflowProjection(fixture, {
    projectId: PROJECT_ID,
    workflowId,
    workflowGeneration: 1,
    sessionId: ROOT_ID,
    triggerEventPosition: 3n,
    rootCommandId: commandId,
    evidenceWindowState: "sealed",
    replacementCheckpointVersion: null,
    effectiveCheckpointVersion: 2,
    effectiveDraftSourceEventPosition: 2n,
    previousFingerprint: null,
  });
}

const provider: HistoricalEvidenceIntegrityProviderPort = {
  async status() { return "available"; },
  async fingerprint() { return H64; },
};

async function fullIssues(fixture: Fixture): Promise<readonly IntegrityIssueCode[]> {
  const issues: IntegrityIssueCode[] = [];
  await new LifecycleIntegrityService(fixture.connection, provider)
    .fullCheckAsync(fixture.context, { add(code) { issues.push(code); } });
  return issues;
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("full integrity advances each qualified coverage row exactly once", async () => {
  const fixture = createFixture();
  addCoverage(fixture);
  const observed = observedReplayConnection(fixture.connection);
  const issues: IntegrityIssueCode[] = [];
  await new LifecycleIntegrityService(observed.connection, provider)
    .fullCheckAsync(fixture.context, { add(code) { issues.push(code); } });
  assert.deepEqual(issues, []);
  const expectedVisits = new Map<ReplayKind, number>([
    ["event", 2],
    ["child-fold", 0],
    ["workflow-fold", 0],
    ["coverage-transition", 1],
    ["immutable-ordinal", 1],
  ]);
  for (const [kind, visits] of expectedVisits) {
    assert.deepEqual(observed.counts.get(kind), {
      prepares: 1,
      iterates: 1,
      visits,
      closes: 1,
    }, kind);
  }
});

it("full integrity fingerprints each non-zero transition exactly once", async () => {
  const fixture = createFixture();
  addCoverage(fixture);
  addZeroNewCoverage(fixture);
  const statusCalls: string[] = [];
  const fingerprintBytes: Uint8Array[] = [];
  const recordingProvider: HistoricalEvidenceIntegrityProviderPort = {
    async status(keyId) {
      statusCalls.push(keyId);
      return "available";
    },
    async fingerprint(_keyId, bytes) {
      fingerprintBytes.push(Uint8Array.from(bytes));
      return H64;
    },
  };
  const issues: IntegrityIssueCode[] = [];
  await new LifecycleIntegrityService(fixture.connection, recordingProvider)
    .fullCheckAsync(fixture.context, { add(code) { issues.push(code); } });
  assert.deepEqual(issues, []);
  assert.deepEqual(statusCalls, ["key-a"]);
  assert.equal(fingerprintBytes.length, 1);
  assert.match(Buffer.from(fingerprintBytes[0]!).toString("utf8"), /"newFrames":\[/);
});

it("full integrity reconstructs version 2 checkpoints and frozen snapshots at their historical bases", async () => {
  const historical = createFixture();
  addCoverage(historical);
  addHistoricalCheckpoint(historical, { tamperHistoricalDigest: false });
  addZeroNewCoverage(historical, { position: 4n, streamVersion: 4n });
  assert.deepEqual(await fullIssues(historical), []);

  const mutableEndpoint = createFixture();
  addCoverage(mutableEndpoint);
  addHistoricalCheckpoint(mutableEndpoint, { tamperHistoricalDigest: true });
  addZeroNewCoverage(mutableEndpoint, { position: 4n, streamVersion: 4n });
  await assert.rejects(
    () => fullIssues(mutableEndpoint),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
  );
});

it("full integrity reports unavailable historical keys and never repairs state", async () => {
  const unavailable = createFixture();
  addCoverage(unavailable);
  addRotatedCoverage(unavailable);
  const unavailableBefore = persistentSnapshot(unavailable.connection);
  const calls: string[] = [];
  const unavailableProvider: HistoricalEvidenceIntegrityProviderPort = {
    async status(keyId) {
      calls.push(keyId);
      return keyId === "key-a" ? "unavailable" : "available";
    },
    async fingerprint() { return H64; },
  };
  await assert.rejects(
    () => new LifecycleIntegrityService(unavailable.connection, unavailableProvider)
      .fullCheckAsync(unavailable.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
    ),
  );
  assert.deepEqual(calls, ["key-b", "key-a"]);
  assert.equal(persistentSnapshot(unavailable.connection), unavailableBefore);

  const mismatch = createFixture();
  addCoverage(mismatch);
  const mismatchBefore = persistentSnapshot(mismatch.connection);
  const mismatchIssues: IntegrityIssueCode[] = [];
  await new LifecycleIntegrityService(mismatch.connection, {
    async status() { return "available"; },
    async fingerprint() { return H64_B; },
  }).fullCheckAsync(mismatch.context, {
    add(code) { mismatchIssues.push(code); },
  });
  assert.deepEqual(mismatchIssues, ["SESSION_EVIDENCE_COVERAGE_MISMATCH"]);
  assert.equal(persistentSnapshot(mismatch.connection), mismatchBefore);

  const rejectedStatus = createFixture();
  addCoverage(rejectedStatus);
  const rejectedBefore = persistentSnapshot(rejectedStatus.connection);
  await assert.rejects(
    () => new LifecycleIntegrityService(rejectedStatus.connection, {
      async status() { throw new Error("provider-status-rejected"); },
      async fingerprint() { return H64; },
    }).fullCheckAsync(rejectedStatus.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
  );
  assert.equal(persistentSnapshot(rejectedStatus.connection), rejectedBefore);
});

it("full integrity merge cursors reject missing and orphan child projection rows", async () => {
  const legal = createFixture();
  addChildFork(legal);
  assert.deepEqual(await fullIssues(legal), []);

  const missing = createFixture();
  addChildFork(missing, { projection: false });
  await assert.rejects(
    () => fullIssues(missing),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
  );

  const orphan = createFixture();
  orphan.connection.exec("DROP TRIGGER lifecycle_child_event_folds_insert_guard");
  const orphanProjection = {
    projectId: PROJECT_ID,
    childSessionId: uuid(55_999),
    eventPosition: 1n,
    streamVersion: 1n,
    rootSessionId: ROOT_ID,
    childState: "active" as const,
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    authorityCommitment: H64,
    terminalEventType: null,
    terminalEventPosition: null,
    reportCount: 0,
    latestReportId: null,
    reportIndexFingerprint: referenceReportIndexGenesisFingerprint(
      PROJECT_ID,
      uuid(55_999),
    ),
    completionReportId: null,
    reportedReportId: null,
    reportedItemCount: null,
    reportedItemSetFingerprint: null,
    previousFingerprint: null,
  };
  rawInsert(orphan.connection, "lifecycle_child_event_folds", {
    project_id: orphanProjection.projectId,
    child_session_id: orphanProjection.childSessionId,
    event_position: orphanProjection.eventPosition,
    stream_version: orphanProjection.streamVersion,
    root_session_id: orphanProjection.rootSessionId,
    child_state: orphanProjection.childState,
    latest_checkpoint_id: null,
    latest_checkpoint_event_position: null,
    authority_commitment: orphanProjection.authorityCommitment,
    terminal_event_type: null,
    terminal_event_position: null,
    report_count: 0,
    latest_report_id: null,
    report_index_fingerprint: orphanProjection.reportIndexFingerprint,
    completion_report_id: null,
    reported_report_id: null,
    reported_item_count: null,
    reported_item_set_fingerprint: null,
    previous_fingerprint: null,
    fingerprint: referenceChildEventFoldFingerprint(orphanProjection),
  });
  await assert.rejects(
    () => fullIssues(orphan),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
  );
});

it("full integrity merge cursors reject missing and orphan workflow projection rows", async () => {
  const legal = createFixture();
  addWorkflowRequest(legal);
  await assert.doesNotReject(() => fullIssues(legal));

  const missing = createFixture();
  addWorkflowRequest(missing, { projection: false });
  await assert.rejects(
    () => fullIssues(missing),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
  );

  const orphan = createFixture();
  orphan.connection.exec("DROP TRIGGER lifecycle_workflow_generation_folds_insert_guard");
  insertWorkflowProjection(orphan, {
    projectId: PROJECT_ID,
    workflowId: uuid(89_999),
    workflowGeneration: 1,
    sessionId: ROOT_ID,
    triggerEventPosition: 1n,
    rootCommandId: uuid(39_999),
    evidenceWindowState: "open",
    replacementCheckpointVersion: 2,
    effectiveCheckpointVersion: 2,
    effectiveDraftSourceEventPosition: 1n,
    previousFingerprint: null,
  });
  await assert.rejects(
    () => fullIssues(orphan),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
  );
});

it("full integrity collapses schema 2 same-generation cancel and abandon once", async () => {
  const collapsed = createFixture();
  addSchema2CollapsedCancel(collapsed);
  await assert.doesNotReject(() => fullIssues(collapsed));
});
