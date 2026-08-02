import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, it } from "node:test";

import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import {
  commandHash,
  internalPhasePlannedWorkId,
  internalValidationPlannedWorkId,
  payloadHash,
  responseHash,
} from "../src/orchestrator/crypto/event-hash.js";
import type {
  HistoricalEvidenceIntegrityProviderPort,
  IntegrityIssueCode,
} from "../src/orchestrator/integrity/integrity.types.js";
import { LifecycleIntegrityService } from "../src/orchestrator/integrity/lifecycle-integrity.service.js";
import {
  authorityCommitment,
  type CommittedAuthorityV1,
} from "../src/orchestrator/lifecycle/authority/authority-commitment.js";
import {
  buildLifecycleIntentWitness,
  decodeLifecycleIntentWitness,
} from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import {
  openChildEventFoldCursor,
  openWorkflowGenerationFoldCursor,
} from "../src/orchestrator/storage/lifecycle-projection.repository.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { SqliteQualifiedCheckpointMigrationPreflight } from "../src/orchestrator/storage/qualified-checkpoint-migration-preflight.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteStatement,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import {
  referenceChildEventFoldFingerprint,
  referenceAdvanceReportIndexFingerprint,
  referenceReportIndexGenesisFingerprint,
  referenceReportItemSetFingerprint,
  referenceReportWitnessFingerprint,
  referenceWorkflowGenerationFingerprint,
} from "./support/lifecycle-projection-reference.js";
import {
  checkpointFixture,
  childDispositionFixture,
  childReportFixture,
  lifecycleEvent,
  qualifiedCheckpointFixture,
  validationResultFixture,
} from "./support/lifecycle-fixtures.js";

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

interface TestChildProjection {
  readonly projectId: string;
  readonly childSessionId: string;
  readonly eventPosition: bigint;
  readonly streamVersion: bigint;
  readonly rootSessionId: string;
  readonly childState: "active" | "completion-proposed" | "completed" | "suspended" | "transferred";
  readonly latestCheckpointId: string | null;
  readonly latestCheckpointEventPosition: bigint | null;
  readonly authorityCommitment: string;
  readonly terminalEventType: "ChildSessionCompleted" | "ChildWorkTransferCreated" | null;
  readonly terminalEventPosition: bigint | null;
  readonly reportCount: number;
  readonly latestReportId: string | null;
  readonly reportIndexFingerprint: string;
  readonly completionReportId: string | null;
  readonly reportedReportId: string | null;
  readonly reportedItemCount: number | null;
  readonly reportedItemSetFingerprint: string | null;
  readonly previousFingerprint: string | null;
  readonly fingerprint: string;
}

function testChildProjection(
  input: Omit<TestChildProjection, "fingerprint">,
): TestChildProjection {
  return {
    ...input,
    fingerprint: referenceChildEventFoldFingerprint(input as never),
  };
}

function insertTestChildProjection(
  connection: SqliteConnection,
  projection: TestChildProjection,
): void {
  rawInsert(connection, "lifecycle_child_event_folds", {
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
    fingerprint: projection.fingerprint,
  });
}

function carryTestChildProjection(
  previous: TestChildProjection,
  overrides: Partial<Omit<TestChildProjection,
    "projectId" | "childSessionId" | "rootSessionId" | "fingerprint"
  >> & { readonly eventPosition: bigint; readonly streamVersion: bigint },
): TestChildProjection {
  return testChildProjection({
    ...previous,
    ...overrides,
    projectId: previous.projectId,
    childSessionId: previous.childSessionId,
    rootSessionId: previous.rootSessionId,
    reportedReportId: overrides.reportedReportId ?? null,
    reportedItemCount: overrides.reportedItemCount ?? null,
    reportedItemSetFingerprint: overrides.reportedItemSetFingerprint ?? null,
    previousFingerprint: previous.fingerprint,
  });
}

function reportTestChildProjection(
  previous: TestChildProjection,
  input: {
    readonly eventPosition: bigint;
    readonly streamVersion: bigint;
    readonly reportId: string;
    readonly allReportItemIds: readonly string[];
  },
): TestChildProjection {
  const itemSet = referenceReportItemSetFingerprint({
    projectId: previous.projectId,
    childSessionId: previous.childSessionId,
    reportId: input.reportId,
    allReportItemIds: input.allReportItemIds,
  });
  const witness = {
    ...previous,
    eventPosition: input.eventPosition,
    streamVersion: input.streamVersion,
    reportCount: previous.reportCount + 1,
    latestReportId: input.reportId,
    reportedReportId: input.reportId,
    reportedItemCount: input.allReportItemIds.length,
    reportedItemSetFingerprint: itemSet,
    previousFingerprint: previous.fingerprint,
  };
  return testChildProjection({
    ...witness,
    reportIndexFingerprint: referenceAdvanceReportIndexFingerprint({
      projectId: previous.projectId,
      childSessionId: previous.childSessionId,
      reportCount: witness.reportCount,
      latestReportId: input.reportId,
      previousReportIndexFingerprint: previous.reportIndexFingerprint,
      reportWitnessFingerprint: referenceReportWitnessFingerprint(witness),
    }),
  });
}

function testProviderFingerprint(keyId: string, bytes: Uint8Array): string {
  return createHash("sha256")
    .update(`task-12j-test-provider/${keyId}\n`, "utf8")
    .update(bytes)
    .digest("hex");
}

function expectedCoverageAccumulator(input: {
  readonly projectId?: string;
  readonly storeId?: string;
  readonly sessionId?: string;
  readonly adapterSessionId?: string;
  readonly keyId: string;
  readonly previousCoverageFingerprint: string | null;
  readonly coverageLastOrdinal: string;
  readonly highestContiguousOrdinal: string | null;
  readonly missingIntervals: readonly {
    readonly firstOrdinal: string;
    readonly lastOrdinal: string;
  }[];
  readonly newFrames: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    coverageAccumulatorVersion: 1,
    projectId: input.projectId ?? PROJECT_ID,
    storeId: input.storeId ?? STORE_ID,
    sessionId: input.sessionId ?? ROOT_ID,
    adapterSessionId: input.adapterSessionId ?? ADAPTER_ID,
    previousCoverageFingerprint: input.previousCoverageFingerprint,
    captureMode: "coverage-only",
    contentRetained: false,
    frameFingerprintProfile: {
      algorithm: "hmac-sha256",
      schemaVersion: 1,
      keyId: input.keyId,
      domain: "pm-evidence-frame-v1",
    },
    coverageFingerprintProfile: {
      algorithm: "hmac-sha256",
      schemaVersion: 1,
      keyId: input.keyId,
      domain: "pm-evidence-coverage-v1",
    },
    coverageFirstOrdinal: "0",
    coverageLastOrdinal: input.coverageLastOrdinal,
    highestContiguousOrdinal: input.highestContiguousOrdinal,
    missingIntervals: input.missingIntervals,
    newFrames: input.newFrames,
  };
}

const FIRST_FRAME = Object.freeze({
  frameId: EVIDENCE_FRAME_ID,
  ordinal: "0",
  sourceKind: "model-turn",
  observedAt: NOW,
  contentFingerprint: H64_B,
});
const FIRST_ACCUMULATOR_BYTES = Buffer.from(canonicalJson(expectedCoverageAccumulator({
  keyId: "key-a",
  previousCoverageFingerprint: null,
  coverageLastOrdinal: "0",
  highestContiguousOrdinal: "0",
  missingIntervals: [],
  newFrames: [FIRST_FRAME],
})), "utf8");
const FIRST_COVERAGE_FINGERPRINT = testProviderFingerprint(
  "key-a",
  FIRST_ACCUMULATOR_BYTES,
);
const ROTATED_FRAME = Object.freeze({
  frameId: ROTATED_FRAME_ID,
  ordinal: "1",
  sourceKind: "tool-result",
  observedAt: NOW,
  contentFingerprint: H64_B,
});
const ROTATED_COVERAGE_FINGERPRINT = testProviderFingerprint(
  "key-b",
  Buffer.from(canonicalJson(expectedCoverageAccumulator({
    keyId: "key-b",
    previousCoverageFingerprint: FIRST_COVERAGE_FINGERPRINT,
    coverageLastOrdinal: "1",
    highestContiguousOrdinal: "1",
    missingIntervals: [],
    newFrames: [ROTATED_FRAME],
  })), "utf8"),
);

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
    readonly streamType?: string;
    readonly streamVersion: bigint;
    readonly eventType: string;
    readonly eventSchemaVersion: number;
    readonly sessionId: string | null;
    readonly parentSessionId: string | null;
    readonly payload: unknown;
    readonly commandId?: string;
    readonly idempotencyKey?: string;
    readonly lifecycleIntent?: string | null;
    readonly projectId?: string;
    readonly vaultId?: string;
    readonly storeId?: string;
    readonly workspaceId?: string;
    readonly occurredAt?: string;
    readonly recordedAt?: string;
  },
): void {
  const offset = Number(input.globalPosition);
  const canonicalPayload = canonicalJson(input.payload);
  rawInsert(connection, "events", {
    global_position: input.globalPosition,
    event_id: uuid(10_000 + offset),
    project_id: input.projectId ?? PROJECT_ID,
    vault_id: input.vaultId ?? VAULT_ID,
    store_id: input.storeId ?? STORE_ID,
    workspace_id: input.workspaceId ?? WORKSPACE_ID,
    branch_scope_id: null,
    branch_ref: null,
    stream_id: input.streamId,
    stream_type: input.streamType ?? "session",
    stream_version: input.streamVersion,
    event_type: input.eventType,
    event_schema_version: input.eventSchemaVersion,
    session_id: input.sessionId,
    parent_session_id: input.parentSessionId,
    actor_role: "primary",
    agent_id: "agent-full-integrity",
    client_instance_id: "client-full-integrity",
    correlation_id: input.sessionId ?? `generic/${input.globalPosition}`,
    causation_id: null,
    command_id: input.commandId ?? uuid(30_000 + offset),
    idempotency_key: input.idempotencyKey ?? `full-integrity/${input.globalPosition}`,
    command_event_index: 0,
    occurred_at: input.occurredAt ?? NOW,
    recorded_at: input.recordedAt ?? input.occurredAt ?? NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: canonicalPayload,
    payload_hash: payloadHash(input.payload),
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

function createAuthenticatedIdentityFixture(input: {
  readonly projectId?: string;
  readonly storeId?: string;
  readonly sessionId?: string;
}): {
  readonly fixture: Fixture;
  readonly expectedBytes: Uint8Array;
} {
  const projectId = input.projectId ?? PROJECT_ID;
  const storeId = input.storeId ?? STORE_ID;
  const sessionId = input.sessionId ?? ROOT_ID;
  const root = mkdtempSync(join(tmpdir(), "qualified-auth-identity-"));
  roots.push(root);
  const connection = driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: 1_000,
  });
  connections.push(connection);
  applyCurrentProjectStoreSchema(connection, {
    projectId: projectId as never,
    vaultId: VAULT_ID as never,
    storeId: storeId as never,
  }, NOW);
  rawInsert(connection, "streams", {
    project_id: projectId,
    stream_id: `session/${sessionId}`,
    stream_type: "session",
    current_version: 2,
    created_at: NOW,
    updated_at: NOW,
  });
  const authority: Record<string, SqliteValue> = {
    ...rootAuthority(),
    project_id: projectId,
    session_id: sessionId,
    stream_id: `session/${sessionId}`,
  };
  authority.authority_commitment = commitmentForRow(authority);
  rawEvent(connection, {
    globalPosition: 1n,
    streamId: `session/${sessionId}`,
    streamVersion: 1n,
    eventType: "SessionStarted",
    eventSchemaVersion: 1,
    sessionId,
    parentSessionId: null,
    projectId,
    storeId,
    payload: {
      sessionKind: "root",
      ownerGeneration: 1,
      continuityKey: "continuity-key",
      clientNamespace: "tests",
      creatingAgentId: "agent-full-integrity",
      creatingClientInstanceId: "client-full-integrity",
      authorityCommitment: authority.authority_commitment,
    },
  });
  rawInsert(connection, "session_authority", authority);
  const accumulator = expectedCoverageAccumulator({
    projectId,
    storeId,
    sessionId,
    keyId: "key-a",
    previousCoverageFingerprint: null,
    coverageLastOrdinal: "0",
    highestContiguousOrdinal: "0",
    missingIntervals: [],
    newFrames: [FIRST_FRAME],
  });
  const expectedBytes = Buffer.from(canonicalJson(accumulator), "utf8");
  const staleCoverageFingerprint = FIRST_COVERAGE_FINGERPRINT;
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
    coverageFingerprint: staleCoverageFingerprint,
    captureMode: "coverage-only",
    contentRetained: false,
    frames: [FIRST_FRAME],
  };
  rawEvent(connection, {
    globalPosition: 2n,
    streamId: `session/${sessionId}`,
    streamVersion: 2n,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    sessionId,
    parentSessionId: null,
    projectId,
    storeId,
    payload,
  });
  connection.exec("BEGIN IMMEDIATE");
  try {
    rawInsert(connection, "session_evidence_coverage_transitions", {
      project_id: projectId,
      session_id: sessionId,
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
      coverage_fingerprint_value: staleCoverageFingerprint,
      new_frame_count: 1,
      capture_mode: "coverage-only",
      content_retained: 0,
      created_at: NOW,
    });
    rawInsert(connection, "session_evidence_coverage", {
      project_id: projectId,
      session_id: sessionId,
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
      coverage_fingerprint_value: staleCoverageFingerprint,
    });
    rawInsert(connection, "session_evidence_fingerprints", {
      project_id: projectId,
      session_id: sessionId,
      adapter_session_id: ADAPTER_ID,
      ordinal: 0,
      frame_id: EVIDENCE_FRAME_ID,
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
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
  return {
    fixture: {
      connection,
      context: {
        binding: {
          projectId,
          vaultId: VAULT_ID,
          storeId,
          workspaceId: WORKSPACE_ID,
          clientNamespace: "tests",
          actorRole: "primary",
          clientInstanceId: "client-full-integrity",
        },
      } as ProjectContext,
    },
    expectedBytes,
  };
}

function createSchema2Fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "qualified-full-integrity-v2-"));
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

function addUnboundTransferHistory(
  fixture: Fixture,
  input: {
    readonly childSessionId: string;
    readonly startPosition: bigint;
    readonly checkpointId: string;
    readonly ticketId: string;
    readonly assignmentId: string;
  },
): void {
  const checkpointPosition = input.startPosition + 1n;
  const suspensionPosition = input.startPosition + 2n;
  const transferPosition = input.startPosition + 3n;
  const draft = checkpointDraft();
  const checkpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: input.checkpointId as never,
      sessionId: input.childSessionId as never,
      parentSessionId: ROOT_ID as never,
      baseEventPosition: Number(input.startPosition),
      checkpointEventPosition: Number(checkpointPosition),
    }),
    ...draft,
    createdAt: NOW,
    creatorAgentId: "agent-full-integrity",
    creatorClientInstanceId: "client-full-integrity",
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: null,
      headCommit: null,
      dirtyWorktreeFingerprint: input.childSessionId.replaceAll("-", "").slice(0, 1)
        .repeat(64),
    },
    childSummaries: [],
    evidenceCoverage: {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [],
    },
  };
  const start = childAuthority(input.childSessionId, input.startPosition);
  const suspended: Record<string, SqliteValue> = {
    ...start,
    semantic_state: "suspended",
    authority_event_position: suspensionPosition,
    latest_checkpoint_id: input.checkpointId,
    latest_checkpoint_event_position: checkpointPosition,
    latest_checkpoint_fingerprint: checkpointFingerprint(checkpoint),
    revocation_reason_code: "child-suspended",
    revocation_event_position: suspensionPosition,
    revoked_at: NOW,
  };
  suspended.authority_commitment = commitmentForRow(suspended);
  const transferred: Record<string, SqliteValue> = {
    ...suspended,
    semantic_state: "transferred",
    authority_event_position: transferPosition,
    revocation_reason_code: "child-transferred",
    revocation_event_position: transferPosition,
    revoked_at: NOW,
    terminal_event_position: transferPosition,
    terminal_event_type: "ChildWorkTransferCreated",
    terminal_at: NOW,
  };
  transferred.authority_commitment = commitmentForRow(transferred);
  rawInsert(fixture.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${input.childSessionId}`,
    stream_type: "session",
    current_version: 4,
    created_at: NOW,
    updated_at: NOW,
  });
  const assignment = {
    assignmentId: input.assignmentId,
    summary: `Task 12J transfer ${input.childSessionId}`,
    scope: "tests/qualified-checkpoint-full-integrity.test.ts",
    assignmentRevision: 1,
  };
  rawEvent(fixture.connection, {
    globalPosition: input.startPosition,
    streamId: `session/${input.childSessionId}`,
    streamVersion: 1n,
    eventType: "SessionForked",
    eventSchemaVersion: 1,
    sessionId: input.childSessionId,
    parentSessionId: ROOT_ID,
    payload: {
      parentSessionId: ROOT_ID,
      assignment: {
        assignmentId: assignment.assignmentId,
        summary: assignment.summary,
        scope: assignment.scope,
      },
      rootOwnerGeneration: 1,
      directAccessEnabled: true,
      authorityCommitment: start.authority_commitment,
      sourceTransferTicketId: null,
    },
  });
  insertFullCheckpoint(fixture, {
    sessionId: input.childSessionId,
    parentSessionId: ROOT_ID,
    baseEventPosition: input.startPosition,
    checkpointEventPosition: checkpointPosition,
    streamVersion: 2n,
    checkpoint,
    draft,
    commandId: uuid(73_200 + Number(input.startPosition)),
    idempotencyKey: `full-integrity/multi-transfer/${input.startPosition}`,
    targetActorRole: "untrusted",
    targetClientInstanceId: "child-client",
  });
  rawEvent(fixture.connection, {
    globalPosition: suspensionPosition,
    streamId: `session/${input.childSessionId}`,
    streamVersion: 3n,
    eventType: "ChildSessionSuspended",
    eventSchemaVersion: 1,
    sessionId: input.childSessionId,
    parentSessionId: ROOT_ID,
    payload: {
      checkpointId: input.checkpointId,
      blockers: [],
      followUps: [],
      authorityCommitment: suspended.authority_commitment,
    },
  });
  rawEvent(fixture.connection, {
    globalPosition: transferPosition,
    streamId: `session/${input.childSessionId}`,
    streamVersion: 4n,
    eventType: "ChildWorkTransferCreated",
    eventSchemaVersion: 1,
    sessionId: input.childSessionId,
    parentSessionId: ROOT_ID,
    payload: {
      transferTicketId: input.ticketId,
      checkpointId: input.checkpointId,
      authorityCommitment: transferred.authority_commitment,
    },
  });
  rawInsert(fixture.connection, "session_authority", transferred);
  rawInsert(fixture.connection, "child_transfer_tickets", {
    project_id: PROJECT_ID,
    transfer_ticket_id: input.ticketId,
    source_parent_session_id: ROOT_ID,
    source_child_session_id: input.childSessionId,
    source_assignment_json: canonicalJson(assignment),
    source_scope_json: canonicalJson({ scope: assignment.scope }),
    checkpoint_id: input.checkpointId,
    follow_ups_json: canonicalJson([{
      childTransferAnnotationsVersion: 1,
      blockers: [],
      followUps: [],
    }]),
    source_state_json: canonicalJson(checkpoint.sourceState),
    lineage_json: canonicalJson({
      previousParentSessionId: ROOT_ID,
      previousChildSessionId: input.childSessionId,
      correlationId: input.childSessionId,
      transferEventPosition: transferPosition.toString(),
    }),
    created_event_position: transferPosition,
    created_at: NOW,
    claimed_by_root_session_id: null,
    claimed_child_session_id: null,
    claimed_event_position: null,
    claimed_at: null,
  });
  const forkProjection = testChildProjection({
    projectId: PROJECT_ID,
    childSessionId: input.childSessionId,
    eventPosition: input.startPosition,
    streamVersion: 1n,
    rootSessionId: ROOT_ID,
    childState: "active",
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    authorityCommitment: String(start.authority_commitment),
    terminalEventType: null,
    terminalEventPosition: null,
    reportCount: 0,
    latestReportId: null,
    reportIndexFingerprint: referenceReportIndexGenesisFingerprint(
      PROJECT_ID,
      input.childSessionId,
    ),
    completionReportId: null,
    reportedReportId: null,
    reportedItemCount: null,
    reportedItemSetFingerprint: null,
    previousFingerprint: null,
  });
  const checkpointProjection = carryTestChildProjection(forkProjection, {
    eventPosition: checkpointPosition,
    streamVersion: 2n,
    latestCheckpointId: input.checkpointId,
    latestCheckpointEventPosition: checkpointPosition,
  });
  const suspendedProjection = carryTestChildProjection(checkpointProjection, {
    eventPosition: suspensionPosition,
    streamVersion: 3n,
    childState: "suspended",
    authorityCommitment: String(suspended.authority_commitment),
  });
  const transferredProjection = carryTestChildProjection(suspendedProjection, {
    eventPosition: transferPosition,
    streamVersion: 4n,
    childState: "transferred",
    authorityCommitment: String(transferred.authority_commitment),
    terminalEventType: "ChildWorkTransferCreated",
    terminalEventPosition: transferPosition,
  });
  for (const projection of [
    forkProjection,
    checkpointProjection,
    suspendedProjection,
    transferredProjection,
  ]) insertTestChildProjection(fixture.connection, projection);
}

function addCoverage(
  fixture: Fixture,
  input: {
    readonly sessionId?: string;
    readonly parentSessionId?: string | null;
    readonly position?: bigint;
    readonly streamVersion?: bigint;
  } = {},
): void {
  const sessionId = input.sessionId ?? ROOT_ID;
  const parentSessionId = input.parentSessionId
    ?? (sessionId === ROOT_ID ? null : ROOT_ID);
  const position = input.position ?? 2n;
  const streamVersion = input.streamVersion ?? 2n;
  const frameId = EVIDENCE_FRAME_ID;
  const coverageFingerprint = testProviderFingerprint(
    "key-a",
    Buffer.from(canonicalJson(expectedCoverageAccumulator({
      sessionId,
      keyId: "key-a",
      previousCoverageFingerprint: null,
      coverageLastOrdinal: "0",
      highestContiguousOrdinal: "0",
      missingIntervals: [],
      newFrames: [FIRST_FRAME],
    })), "utf8"),
  );
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
    coverageFingerprint,
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
    UPDATE streams SET current_version = $streamVersion, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${sessionId}`,
    $streamVersion: streamVersion,
  });
  rawEvent(fixture.connection, {
    globalPosition: position,
    streamId: `session/${sessionId}`,
    streamVersion,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    sessionId,
    parentSessionId,
    payload,
  });
  fixture.connection.exec("BEGIN IMMEDIATE");
  try {
    rawInsert(fixture.connection, "session_evidence_coverage_transitions", {
      project_id: PROJECT_ID,
      session_id: sessionId,
      adapter_session_id: ADAPTER_ID,
      batch_id: BATCH_ID,
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
      previous_coverage_fingerprint_value: null,
      coverage_fingerprint_algorithm: "hmac-sha256",
      coverage_fingerprint_schema_version: 1,
      coverage_fingerprint_key_id: "key-a",
      coverage_fingerprint_domain: "pm-evidence-coverage-v1",
      coverage_fingerprint_value: coverageFingerprint,
      new_frame_count: 1,
      capture_mode: "coverage-only",
      content_retained: 0,
      created_at: NOW,
    });
    rawInsert(fixture.connection, "session_evidence_coverage", {
      project_id: PROJECT_ID,
      session_id: sessionId,
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
      latest_batch_event_position: position,
      created_at: NOW,
      updated_at: NOW,
      coverage_fingerprint_algorithm: "hmac-sha256",
      coverage_fingerprint_schema_version: 1,
      coverage_fingerprint_key_id: "key-a",
      coverage_fingerprint_domain: "pm-evidence-coverage-v1",
      coverage_fingerprint_value: coverageFingerprint,
    });
    rawInsert(fixture.connection, "session_evidence_fingerprints", {
      project_id: PROJECT_ID,
      session_id: sessionId,
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
      recorded_event_position: position,
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
    coverageFingerprint: FIRST_COVERAGE_FINGERPRINT,
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
      previous_coverage_fingerprint_value: FIRST_COVERAGE_FINGERPRINT,
      coverage_fingerprint_algorithm: "hmac-sha256",
      coverage_fingerprint_schema_version: 1,
      coverage_fingerprint_key_id: "key-a",
      coverage_fingerprint_domain: "pm-evidence-coverage-v1",
      coverage_fingerprint_value: FIRST_COVERAGE_FINGERPRINT,
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

function addLegacyCoverageAfterQualified(
  fixture: Fixture,
  input: { readonly position?: bigint; readonly streamVersion?: bigint } = {},
): void {
  const position = input.position ?? 3n;
  const streamVersion = input.streamVersion ?? 3n;
  fixture.connection.exec("DROP TRIGGER events_lifecycle_version_v3_guard");
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
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    payload: {
      adapterSessionId: ADAPTER_ID,
      batchId: SECOND_BATCH_ID,
      firstOrdinal: "1",
      lastOrdinal: "1",
      highestContiguousOrdinal: "1",
      missingIntervals: [],
      fingerprintSchemaVersion: 1,
      fingerprintKeyId: "key-a",
      fingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprint: H64,
      captureMode: "coverage-only",
      contentRetained: false,
      frames: [{
        frameId: uuid(71_003),
        ordinal: "1",
        sourceKind: "adapter-event",
        observedAt: NOW,
        contentFingerprint: H64_B,
      }],
    },
  });
}

interface QualifiedCoverageTestFrame {
  readonly frameId: string;
  readonly ordinal: bigint;
  readonly sourceKind:
    | "model-turn"
    | "tool-request"
    | "tool-result"
    | "adapter-event"
    | "external-observation";
  readonly observedAt: string;
  readonly contentFingerprint: string;
}

function storedMissingIntervalsJson(
  intervals: readonly {
    readonly firstOrdinal: string;
    readonly lastOrdinal: string;
  }[],
): string {
  return `[${intervals.map((interval) => (
    `[${interval.firstOrdinal},${interval.lastOrdinal}]`
  )).join(",")}]`;
}

function addQualifiedCoverageBatch(
  fixture: Fixture,
  input: {
    readonly position: bigint;
    readonly streamVersion: bigint;
    readonly batchId: string;
    readonly adapterSessionId?: string;
    readonly frames: readonly QualifiedCoverageTestFrame[];
    readonly keyId?: string;
    readonly occurredAt?: string;
    readonly expected: {
      readonly coverageLastOrdinal: string;
      readonly highestContiguousOrdinal: string | null;
      readonly missingIntervals: readonly {
        readonly firstOrdinal: string;
        readonly lastOrdinal: string;
      }[];
      readonly newOrdinals: readonly bigint[];
    };
  },
): {
  readonly coverageFingerprint: string;
  readonly highestContiguousOrdinal: string | null;
  readonly missingIntervals: readonly {
    readonly firstOrdinal: string;
    readonly lastOrdinal: string;
  }[];
  readonly newFrameCount: number;
} {
  assert.ok(input.frames.length > 0);
  const frames = [...input.frames].sort((left, right) => (
    left.ordinal < right.ordinal ? -1 : left.ordinal > right.ordinal ? 1 : 0
  ));
  assert.equal(
    new Set(frames.map((frame) => frame.ordinal.toString())).size,
    frames.length,
  );
  const occurredAt = input.occurredAt ?? NOW;
  const adapterSessionId = input.adapterSessionId ?? ADAPTER_ID;
  const previous = fixture.connection.prepare(`
    SELECT * FROM session_evidence_coverage
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND adapter_session_id = $adapterSessionId
  `).get({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
    $adapterSessionId: adapterSessionId,
  });
  const priorIdentities = new Map(fixture.connection.prepare(`
    SELECT * FROM session_evidence_fingerprints
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND adapter_session_id = $adapterSessionId
  `).all({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
    $adapterSessionId: adapterSessionId,
  }).map((row) => [BigInt(String(row.ordinal)).toString(), row] as const));
  const newFrames = frames.filter((frame) => {
    const prior = priorIdentities.get(frame.ordinal.toString());
    if (prior === undefined) return true;
    assert.equal(prior.frame_id, frame.frameId);
    assert.equal(prior.source_kind, frame.sourceKind);
    assert.equal(prior.observed_at, frame.observedAt);
    assert.equal(prior.fingerprint_value, frame.contentFingerprint);
    return false;
  });
  assert.deepEqual(
    newFrames.map((frame) => frame.ordinal),
    input.expected.newOrdinals,
    "the independent fixture oracle must identify every genuinely new ordinal",
  );
  const previousCoverageFingerprint = previous === undefined
    ? null
    : String(previous.coverage_fingerprint_value);
  const keyId = input.keyId
    ?? (previous === undefined ? "key-a" : String(previous.fingerprint_key_id));
  const publicNewFrames = newFrames.map((frame) => ({
    frameId: frame.frameId,
    ordinal: frame.ordinal.toString(),
    sourceKind: frame.sourceKind,
    observedAt: frame.observedAt,
    contentFingerprint: frame.contentFingerprint,
  }));
  const coverageFingerprint = newFrames.length === 0
    ? previousCoverageFingerprint
    : testProviderFingerprint(keyId, Buffer.from(canonicalJson(
        expectedCoverageAccumulator({
          adapterSessionId,
          keyId,
          previousCoverageFingerprint,
          coverageLastOrdinal: input.expected.coverageLastOrdinal,
          highestContiguousOrdinal: input.expected.highestContiguousOrdinal,
          missingIntervals: input.expected.missingIntervals,
          newFrames: publicNewFrames,
        }),
      ), "utf8"));
  assert.notEqual(coverageFingerprint, null);
  const payload = {
    adapterSessionId,
    batchId: input.batchId,
    batchFirstOrdinal: frames[0]!.ordinal.toString(),
    batchLastOrdinal: frames.at(-1)!.ordinal.toString(),
    coverageFirstOrdinal: "0",
    coverageLastOrdinal: input.expected.coverageLastOrdinal,
    highestContiguousOrdinal: input.expected.highestContiguousOrdinal,
    missingIntervals: input.expected.missingIntervals,
    frameFingerprintAlgorithm: "hmac-sha256",
    frameFingerprintSchemaVersion: 1,
    frameFingerprintKeyId: keyId,
    frameFingerprintDomain: "pm-evidence-frame-v1",
    coverageFingerprintAlgorithm: "hmac-sha256",
    coverageFingerprintSchemaVersion: 1,
    coverageFingerprintKeyId: keyId,
    coverageFingerprintDomain: "pm-evidence-coverage-v1",
    coverageFingerprint,
    captureMode: "coverage-only",
    contentRetained: false,
    frames: frames.map((frame) => ({
      frameId: frame.frameId,
      ordinal: frame.ordinal.toString(),
      sourceKind: frame.sourceKind,
      observedAt: frame.observedAt,
      contentFingerprint: frame.contentFingerprint,
    })),
  };
  fixture.connection.prepare(`
    UPDATE streams SET current_version = $streamVersion, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: occurredAt,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
    $streamVersion: input.streamVersion,
  });
  rawEvent(fixture.connection, {
    globalPosition: input.position,
    streamId: `session/${ROOT_ID}`,
    streamVersion: input.streamVersion,
    eventType: "EvidenceCoverageRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    payload,
  });
  const missingIntervalsJson = storedMissingIntervalsJson(input.expected.missingIntervals);
  fixture.connection.exec("BEGIN IMMEDIATE");
  try {
    rawInsert(fixture.connection, "session_evidence_coverage_transitions", {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      adapter_session_id: adapterSessionId,
      batch_id: input.batchId,
      batch_event_position: input.position,
      batch_first_ordinal: frames[0]!.ordinal,
      batch_last_ordinal: frames.at(-1)!.ordinal,
      coverage_first_ordinal: 0,
      coverage_last_ordinal: BigInt(input.expected.coverageLastOrdinal),
      highest_contiguous_ordinal: input.expected.highestContiguousOrdinal === null
        ? -1n
        : BigInt(input.expected.highestContiguousOrdinal),
      missing_intervals_json: missingIntervalsJson,
      frame_fingerprint_algorithm: "hmac-sha256",
      frame_fingerprint_schema_version: 1,
      frame_fingerprint_key_id: keyId,
      frame_fingerprint_domain: "pm-evidence-frame-v1",
      previous_coverage_fingerprint_value: previousCoverageFingerprint,
      coverage_fingerprint_algorithm: "hmac-sha256",
      coverage_fingerprint_schema_version: 1,
      coverage_fingerprint_key_id: keyId,
      coverage_fingerprint_domain: "pm-evidence-coverage-v1",
      coverage_fingerprint_value: coverageFingerprint!,
      new_frame_count: newFrames.length,
      capture_mode: "coverage-only",
      content_retained: 0,
      created_at: occurredAt,
    });
    if (previous === undefined) {
      rawInsert(fixture.connection, "session_evidence_coverage", {
        project_id: PROJECT_ID,
        session_id: ROOT_ID,
        adapter_session_id: adapterSessionId,
        capture_mode: "coverage-only",
        first_ordinal: 0,
        last_ordinal: BigInt(input.expected.coverageLastOrdinal),
        highest_contiguous_ordinal: input.expected.highestContiguousOrdinal === null
          ? -1n
          : BigInt(input.expected.highestContiguousOrdinal),
        missing_intervals_json: missingIntervalsJson,
        fingerprint_algorithm: "hmac-sha256",
        fingerprint_schema_version: 1,
        fingerprint_key_id: keyId,
        fingerprint_domain: "pm-evidence-frame-v1",
        latest_batch_id: input.batchId,
        latest_batch_event_position: input.position,
        created_at: occurredAt,
        updated_at: occurredAt,
        coverage_fingerprint_algorithm: "hmac-sha256",
        coverage_fingerprint_schema_version: 1,
        coverage_fingerprint_key_id: keyId,
        coverage_fingerprint_domain: "pm-evidence-coverage-v1",
        coverage_fingerprint_value: coverageFingerprint!,
      });
    } else {
      fixture.connection.prepare(`
        UPDATE session_evidence_coverage
        SET last_ordinal = $lastOrdinal,
            highest_contiguous_ordinal = $highestContiguousOrdinal,
            missing_intervals_json = $missingIntervalsJson,
            latest_batch_id = $batchId,
            latest_batch_event_position = $position,
            updated_at = $now,
            coverage_fingerprint_value = $coverageFingerprint
        WHERE project_id = $projectId
          AND session_id = $sessionId
          AND adapter_session_id = $adapterSessionId
      `).run({
        $lastOrdinal: BigInt(input.expected.coverageLastOrdinal),
        $highestContiguousOrdinal: input.expected.highestContiguousOrdinal === null
          ? -1n
          : BigInt(input.expected.highestContiguousOrdinal),
        $missingIntervalsJson: missingIntervalsJson,
        $batchId: input.batchId,
        $position: input.position,
        $now: occurredAt,
        $coverageFingerprint: coverageFingerprint!,
        $projectId: PROJECT_ID,
        $sessionId: ROOT_ID,
        $adapterSessionId: adapterSessionId,
      });
    }
    for (const frame of newFrames) {
      rawInsert(fixture.connection, "session_evidence_fingerprints", {
        project_id: PROJECT_ID,
        session_id: ROOT_ID,
        adapter_session_id: adapterSessionId,
        ordinal: frame.ordinal,
        frame_id: frame.frameId,
        source_kind: frame.sourceKind,
        observed_at: frame.observedAt,
        fingerprint_algorithm: "hmac-sha256",
        fingerprint_schema_version: 1,
        fingerprint_key_id: keyId,
        fingerprint_domain: "pm-evidence-frame-v1",
        fingerprint_value: frame.contentFingerprint,
        batch_id: input.batchId,
        recorded_event_position: input.position,
        created_at: occurredAt,
      });
    }
    fixture.connection.exec("COMMIT");
  } catch (error) {
    fixture.connection.exec("ROLLBACK");
    throw error;
  }
  return {
    coverageFingerprint: coverageFingerprint!,
    highestContiguousOrdinal: input.expected.highestContiguousOrdinal,
    missingIntervals: input.expected.missingIntervals,
    newFrameCount: newFrames.length,
  };
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
    coverageFingerprint: ROTATED_COVERAGE_FINGERPRINT,
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
      previous_coverage_fingerprint_value: FIRST_COVERAGE_FINGERPRINT,
      coverage_fingerprint_algorithm: "hmac-sha256",
      coverage_fingerprint_schema_version: 1,
      coverage_fingerprint_key_id: "key-b",
      coverage_fingerprint_domain: "pm-evidence-coverage-v1",
      coverage_fingerprint_value: ROTATED_COVERAGE_FINGERPRINT,
      new_frame_count: 1,
      capture_mode: "coverage-only",
      content_retained: 0,
      created_at: NOW,
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
    fixture.connection.prepare(`
      DELETE FROM session_evidence_coverage_transition_heads
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND adapter_session_id = $adapterSessionId
    `).run({
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

function removeCurrentCoverageEndpoint(
  fixture: Fixture,
  adapterSessionId = ADAPTER_ID,
): void {
  fixture.connection.exec("PRAGMA foreign_keys = OFF");
  fixture.connection.exec("DROP TRIGGER session_evidence_coverage_no_delete");
  fixture.connection.prepare(`
    DELETE FROM session_evidence_coverage_transition_heads
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND adapter_session_id = $adapterSessionId
  `).run({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
    $adapterSessionId: adapterSessionId,
  });
  fixture.connection.prepare(`
    DELETE FROM session_evidence_coverage
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND adapter_session_id = $adapterSessionId
  `).run({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
    $adapterSessionId: adapterSessionId,
  });
  fixture.connection.exec("PRAGMA foreign_keys = ON");
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
  input: {
    readonly tamperHistoricalDigest?: boolean;
    readonly mutateCheckpoint?: (
      checkpoint: Record<string, unknown>,
    ) => Record<string, unknown>;
    readonly mutateIntentDraft?: (
      draft: Record<string, unknown>,
    ) => Record<string, unknown>;
  } = {},
): void {
  const draft = checkpointDraft();
  const checkpointInput: Record<string, unknown> = {
    ...qualifiedCheckpointFixture({
      checkpointId: CHECKPOINT_ID as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 2,
      checkpointEventPosition: 3,
    }),
    ...draft,
    createdAt: NOW,
    creatorAgentId: "agent-full-integrity",
    creatorClientInstanceId: "client-full-integrity",
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: null,
      headCommit: null,
      dirtyWorktreeFingerprint: "2".repeat(64),
    },
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
        coverageFingerprint: input.tamperHistoricalDigest === true
          ? H64_B
          : FIRST_COVERAGE_FINGERPRINT,
        latestBatchId: BATCH_ID,
        latestBatchEventPosition: "2",
      }],
    },
  };
  const checkpoint = input.mutateCheckpoint?.(checkpointInput) ?? checkpointInput;
  const intentDraft = input.mutateIntentDraft?.({ ...draft }) ?? draft;
  const commandId = uuid(30_003);
  const idempotencyKey = "full-integrity/checkpoint/3";
  const intent = recordCheckpointWitness(commandId, idempotencyKey, intentDraft);
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
    commandId,
    idempotencyKey,
    lifecycleIntent: intent.source,
    payload: {
      checkpoint,
      baseEventPosition: "2",
      checkpointEventPosition: "3",
    },
  });
  const response = {
    checkpointVersion: 2,
    checkpointId: CHECKPOINT_ID,
    sessionId: ROOT_ID,
    baseEventPosition: "2",
    checkpointEventPosition: "3",
    finalStreamVersion: "3",
    checkpointRequiredCleared: false,
  };
  rawInsert(fixture.connection, "command_dedup", {
    project_id: PROJECT_ID,
    idempotency_key: idempotencyKey,
    command_id: commandId,
    command_type: "record-checkpoint",
    command_hash: commandHash(intent.command),
    workspace_head_commit: null,
    outbox_order_json: "[]",
    state: "committed",
    first_global_position: 3,
    last_global_position: 3,
    final_stream_version: 3,
    event_ids_json: canonicalJson([uuid(10_003)]),
    response_json: canonicalJson(response),
    response_hash: responseHash(response),
    committed_at: NOW,
    lifecycle_authorization_kind: "protected",
    authorization_proof_version: 1,
    authorization_proof_nonce: uuid(99_003),
    authorization_proof_digest: H64,
    authorization_approval_id: null,
    authorization_approval_digest: null,
    authorization_session_id: ROOT_ID,
    target_session_id: ROOT_ID,
    presenting_actor_role: "primary",
    presenting_client_instance_id: "client-full-integrity",
    target_actor_role: "primary",
    target_client_instance_id: "client-full-integrity",
    internal_workflow_id: null,
    internal_workflow_generation: null,
    internal_planned_work_id: null,
    internal_claim_owner_id: null,
    internal_claim_token: null,
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

function insertFullCheckpoint(
  fixture: Fixture,
  input: {
    readonly sessionId: string;
    readonly parentSessionId: string | null;
    readonly baseEventPosition: bigint;
    readonly checkpointEventPosition: bigint;
    readonly streamVersion: bigint;
    readonly checkpoint: Readonly<Record<string, unknown>>;
    readonly draft: Readonly<Record<string, unknown>>;
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly targetActorRole?: "primary" | "untrusted";
    readonly targetClientInstanceId?: string;
    readonly internalWorkflow?: {
      readonly workflowId: string;
      readonly workflowGeneration: number;
      readonly plannedWorkId: string;
      readonly claimOwnerId: string;
    };
  },
): void {
  const checkpointVersion = input.checkpoint.checkpointVersion === 1 ? 1 : 2;
  const targetActorRole = input.targetActorRole ?? "primary";
  const targetClientInstanceId = input.targetClientInstanceId
    ?? "client-full-integrity";
  const internal = input.internalWorkflow;
  const command = internal === undefined
    ? {
        commandType: "record-checkpoint",
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        agentId: "agent-full-integrity",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedBranchRef: null,
        sessionId: input.sessionId,
        expectedStreamVersion: (input.streamVersion - 1n).toString(),
        expectedBaseEventPosition: input.baseEventPosition.toString(),
        draft: input.draft,
      } as const
    : {
        commandType: "internal-workflow-phase",
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        agentId: "agent-full-integrity",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedBranchRef: null,
        workflowId: internal.workflowId,
        workflowGeneration: internal.workflowGeneration,
        plannedWorkId: internal.plannedWorkId,
        sourcePhase: "children-resolved",
        claim: {
          workflowId: internal.workflowId,
          workflowGeneration: internal.workflowGeneration,
          claimOwnerId: internal.claimOwnerId,
          claimToken: "1",
          claimExpiresAt: "2026-08-01T00:10:00.000Z",
        },
        action: {
          action: "record-final-checkpoint-and-queue-ending",
          finalCheckpoint: input.checkpoint,
          materializationTarget: "memory/session-end.md",
        },
      } as const;
  const intent = buildLifecycleIntentWitness(command as never, {
    authorizationKind: internal === undefined ? "protected" : "internal-workflow",
    authorizationSessionId: input.sessionId,
    targetSessionId: input.sessionId,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: internal === undefined
      ? input.parentSessionId === null
        ? "root-session-handle"
        : "child-session-handle"
      : null,
    capabilityGeneration: internal === undefined ? "1" : null,
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-full-integrity",
    targetActorRole,
    targetClientInstanceId,
    internalWorkflowId: internal?.workflowId ?? null,
    internalWorkflowGeneration: internal?.workflowGeneration ?? null,
    internalPlannedWorkId: internal?.plannedWorkId ?? null,
  });
  rawEvent(fixture.connection, {
    globalPosition: input.checkpointEventPosition,
    streamId: `session/${input.sessionId}`,
    streamVersion: input.streamVersion,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: checkpointVersion,
    sessionId: input.sessionId,
    parentSessionId: input.parentSessionId,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    lifecycleIntent: intent.source,
    payload: {
      checkpoint: input.checkpoint,
      baseEventPosition: input.baseEventPosition.toString(),
      checkpointEventPosition: input.checkpointEventPosition.toString(),
    },
  });
  const response = {
    checkpointVersion,
    checkpointId: input.checkpoint.checkpointId,
    sessionId: input.sessionId,
    baseEventPosition: input.baseEventPosition.toString(),
    checkpointEventPosition: input.checkpointEventPosition.toString(),
    finalStreamVersion: input.streamVersion.toString(),
    checkpointRequiredCleared: false,
  };
  rawInsert(fixture.connection, "command_dedup", {
    project_id: PROJECT_ID,
    idempotency_key: input.idempotencyKey,
    command_id: input.commandId,
    command_type: command.commandType,
    command_hash: commandHash(
      decodeLifecycleIntentWitness(intent.source).intent.command,
    ),
    workspace_head_commit: null,
    outbox_order_json: "[]",
    state: "committed",
    first_global_position: input.checkpointEventPosition,
    last_global_position: input.checkpointEventPosition,
    final_stream_version: input.streamVersion,
    event_ids_json: canonicalJson([uuid(10_000 + Number(input.checkpointEventPosition))]),
    response_json: canonicalJson(response),
    response_hash: responseHash(response),
    committed_at: NOW,
    lifecycle_authorization_kind: internal === undefined ? "protected" : "internal-workflow",
    authorization_proof_version: internal === undefined ? 1 : null,
    authorization_proof_nonce: internal === undefined
      ? uuid(97_000 + Number(input.checkpointEventPosition))
      : null,
    authorization_proof_digest: internal === undefined ? H64 : null,
    authorization_approval_id: null,
    authorization_approval_digest: null,
    authorization_session_id: input.sessionId,
    target_session_id: input.sessionId,
    presenting_actor_role: "primary",
    presenting_client_instance_id: "client-full-integrity",
    target_actor_role: targetActorRole,
    target_client_instance_id: targetClientInstanceId,
    internal_workflow_id: internal?.workflowId ?? null,
    internal_workflow_generation: internal?.workflowGeneration ?? null,
    internal_planned_work_id: internal?.plannedWorkId ?? null,
    internal_claim_owner_id: internal?.claimOwnerId ?? null,
    internal_claim_token: internal === undefined ? null : 1,
  });
}

function mutateHistoricalCheckpointWithoutHashBindings(
  fixture: Fixture,
  mutate: (checkpoint: Record<string, unknown>) => Record<string, unknown>,
): void {
  const row = fixture.connection.prepare(`
    SELECT payload_json FROM events WHERE global_position = 3
  `).get();
  assert.equal(typeof row?.payload_json, "string");
  const payload = JSON.parse(String(row!.payload_json)) as Record<string, unknown>;
  const checkpoint = mutate(payload.checkpoint as Record<string, unknown>);
  payload.checkpoint = checkpoint;
  fixture.connection.exec("DROP TRIGGER events_no_update");
  fixture.connection.prepare(`
    UPDATE events SET payload_json = $payload WHERE global_position = 3
  `).run({ $payload: canonicalJson(payload) });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET latest_checkpoint_fingerprint = $fingerprint
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $fingerprint: checkpointFingerprint(checkpoint),
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
}

type ReplayKind =
  | "event"
  | "child-fold"
  | "workflow-fold"
  | "coverage-transition"
  | "immutable-ordinal"
  | "pre-index"
  | "endpoint";

function observedReplayConnection(
  connection: SqliteConnection,
  options: {
    readonly trapLegacy?: boolean;
    readonly trapUnmarkedHistorical?: boolean;
    readonly trapDml?: boolean;
    readonly closeFailureKind?: ReplayKind;
    readonly reuseMutableRawRows?: boolean;
    readonly failure?: {
      readonly kind: ReplayKind;
      readonly stage: "prepare" | "iterate" | "next";
      readonly call: number;
    };
  } = {},
): {
  readonly connection: SqliteConnection;
  readonly counts: ReadonlyMap<ReplayKind, {
    readonly prepares: number;
    readonly iterates: number;
    readonly nexts: number;
    readonly visits: number;
    readonly closes: number;
  }>;
  readonly closeOrder: readonly ReplayKind[];
  readonly totalPrepares: () => number;
  readonly unmarkedHistoricalPrepares: () => number;
} {
  const mutable = new Map<ReplayKind, {
    prepares: number;
    iterates: number;
    nexts: number;
    visits: number;
    closes: number;
  }>();
  const closeOrder: ReplayKind[] = [];
  let totalPrepares = 0;
  let unmarkedHistoricalPrepares = 0;
  const kind = (sql: string): ReplayKind | null => {
    const match = /lifecycle-full:(event|child-fold|workflow-fold|coverage-transition|immutable-ordinal|pre-index|endpoint)/
      .exec(sql);
    return (match?.[1] as ReplayKind | undefined) ?? null;
  };
  const entry = (value: ReplayKind) => {
    let result = mutable.get(value);
    if (result === undefined) {
      result = { prepares: 0, iterates: 0, nexts: 0, visits: 0, closes: 0 };
      mutable.set(value, result);
    }
    return result;
  };
  return {
    connection: {
      exec(sql) {
        if (options.trapDml === true && /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql)) {
          throw new Error("TASK_12J_DML_TRAP");
        }
        connection.exec(sql);
      },
      prepare(sql) {
        totalPrepares += 1;
        if (options.trapDml === true && /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql)) {
          throw new Error("TASK_12J_DML_TRAP");
        }
        if (
          options.trapLegacy === true
          && (
            /batch_event_position\s*<=\s*\$baseEventPosition/iu.test(sql)
            || (/session_evidence_coverage_transition_heads/iu.test(sql) && /LIMIT\s+201/iu.test(sql))
            || (/session_evidence_fingerprints/iu.test(sql) && /BETWEEN/iu.test(sql))
          )
        ) throw new Error("TASK_12J_LEGACY_SWEEP_TRAP");
        const replayKind = kind(sql);
        const historicalPointRead = replayKind === null && (
          /evidence_frozen_checkpoint_event_position\s+IS\s+NOT\s+NULL/iu.test(sql)
          || (/FROM\s+lifecycle_workflow_generation_folds/iu.test(sql)
            && /workflow_id\s*=\s*\$workflowId/iu.test(sql))
          || (/FROM\s+lifecycle_child_event_folds/iu.test(sql)
            && /(event_position|stream_version|reported_report_id)\s*=\s*\$/iu.test(sql))
          || (/FROM\s+session_evidence_coverage_transitions/iu.test(sql)
            && /batch_event_position\s*=\s*\$batchEventPosition/iu.test(sql))
          || (/FROM\s+events/iu.test(sql)
            && /global_position\s*=\s*\$(?:globalPosition|eventPosition|claimedEventPosition)/iu.test(sql))
          || (/FROM\s+events/iu.test(sql)
            && /stream_id\s*=\s*\$streamId/iu.test(sql)
            && /ORDER\s+BY\s+stream_version/iu.test(sql))
          || (/FROM\s+events/iu.test(sql)
            && /command_id\s*=\s*\$commandId/iu.test(sql))
          || (/FROM\s+child_transfer_tickets/iu.test(sql)
            && /transfer_ticket_id\s*=\s*\$transferTicketId/iu.test(sql))
          || (/FROM\s+child_transfer_tickets\s+AS\s+candidate/iu.test(sql)
            && /candidate\.(?:created|claimed)_event_position\s*=\s*(?:created|claimed)\.global_position/iu.test(sql))
        );
        if (historicalPointRead) {
          unmarkedHistoricalPrepares += 1;
          if (options.trapUnmarkedHistorical === true) {
            throw new Error("TASK_12J_UNMARKED_HISTORICAL_READ_TRAP");
          }
        }
        if (replayKind === null) return connection.prepare(sql);
        entry(replayKind).prepares += 1;
        if (
          options.failure?.kind === replayKind
          && options.failure.stage === "prepare"
          && entry(replayKind).prepares === options.failure.call
        ) throw new Error(`TASK_12J_PREPARE_FAILURE:${replayKind}`);
        const statement = connection.prepare(sql);
        return {
          run(params) { return statement.run(params); },
          get(params) { return statement.get(params); },
          all(params) {
            if (replayKind === null) return statement.all(params);
            entry(replayKind).iterates += 1;
            const rows = statement.all(params);
            entry(replayKind).visits += rows.length;
            return rows;
          },
          iterate(params) {
            entry(replayKind).iterates += 1;
            if (
              options.failure?.kind === replayKind
              && options.failure.stage === "iterate"
              && entry(replayKind).iterates === options.failure.call
            ) throw new Error(`TASK_12J_ITERATE_FAILURE:${replayKind}`);
            const iterator = statement.iterate(params);
            const reused: Record<string, SqliteValue> = {};
            return {
              next() {
                entry(replayKind).nexts += 1;
                if (
                  options.failure?.kind === replayKind
                  && options.failure.stage === "next"
                  && entry(replayKind).nexts === options.failure.call
                ) throw new Error(`TASK_12J_NEXT_FAILURE:${replayKind}`);
                const next = iterator.next();
                if (!next.done) entry(replayKind).visits += 1;
                if (next.done || options.reuseMutableRawRows !== true) return next;
                for (const key of Object.keys(reused)) delete reused[key];
                Object.assign(reused, next.value);
                return { done: false, value: reused };
              },
              return() {
                entry(replayKind).closes += 1;
                closeOrder.push(replayKind);
                const result = iterator.return?.() ?? { done: true, value: undefined };
                if (options.closeFailureKind === replayKind) {
                  throw new Error(`TASK_12J_CLOSE_FAILURE:${replayKind}`);
                }
                return result;
              },
              [Symbol.iterator]() { return this; },
            } as IterableIterator<Record<string, SqliteValue>>;
          },
        } satisfies SqliteStatement;
      },
      close() { connection.close(); },
    },
    counts: mutable,
    closeOrder,
    totalPrepares: () => totalPrepares,
    unmarkedHistoricalPrepares: () => unmarkedHistoricalPrepares,
  };
}

function checkpointDraft(version: 1 | 2 = 2): Record<string, unknown> {
  const source = version === 1
    ? checkpointFixture()
    : qualifiedCheckpointFixture();
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

function recordCheckpointWitness(
  commandId: string,
  idempotencyKey: string,
  draft: Record<string, unknown>,
): {
  readonly source: string;
  readonly command: Readonly<Record<string, unknown>>;
} {
  const command = {
    commandType: "record-checkpoint",
    commandId,
    idempotencyKey,
    agentId: "agent-full-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    expectedStreamVersion: "2",
    expectedBaseEventPosition: "2",
    draft,
  } as const;
  const built = buildLifecycleIntentWitness(command as never, {
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
  });
  return {
    source: built.source,
    command: built.witness.intent.command as unknown as Readonly<Record<string, unknown>>,
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

function requestWitnessFor(
  sessionId: string,
  commandId: string,
  idempotencyKey: string,
  options: {
    readonly requestVersion?: 1 | 2;
    readonly requireMaterialization?: boolean;
  } = {},
): string {
  const requestVersion = options.requestVersion ?? 2;
  const requireMaterialization = options.requireMaterialization ?? false;
  return buildLifecycleIntentWitness({
    commandType: "request-session-end",
    commandId,
    idempotencyKey,
    agentId: "agent-full-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    request: {
      requestVersion,
      sessionId,
      childEndPolicy: "require-completed",
      finalCheckpoint: checkpointDraft(requestVersion),
      validationProfileIds: [],
      requestedQualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization,
    },
  } as never, {
    authorizationKind: "protected",
    authorizationSessionId: sessionId,
    targetSessionId: sessionId,
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

function amendmentWitnessFor(input: {
  readonly workflowId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly expectedStreamVersion: string;
  readonly finalCheckpoint: Record<string, unknown> | null;
  readonly evidenceWindowAction: "unchanged" | "open" | "seal";
}): string {
  return buildLifecycleIntentWitness({
    commandType: "amend-session-end",
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    agentId: "agent-full-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    workflowId: input.workflowId,
    expectedStreamVersion: input.expectedStreamVersion,
    amendment: {
      amendmentVersion: 2,
      childEndPolicy: null,
      finalCheckpoint: input.finalCheckpoint,
      validationProfileIds: null,
      requestedQualityThreshold: null,
      requireFullEvidence: null,
      requireMaterialization: null,
      evidenceWindowAction: input.evidenceWindowAction,
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

function requestWitnessWithOverrides(
  commandId: string,
  overrides: {
    readonly command?: Readonly<Record<string, unknown>>;
    readonly origin?: Readonly<Record<string, unknown>>;
  },
): string {
  const command = {
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
    ...overrides.command,
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
    presentingClientInstanceId: "client-full-integrity",
    targetActorRole: "primary",
    targetClientInstanceId: "client-full-integrity",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
    ...overrides.origin,
  } as never).source;
}

function cancelWitnessFor(
  sessionId: string,
  workflowId: string,
  commandId: string,
  checkpointId: string,
  idempotencyKey: string,
): string {
  return buildLifecycleIntentWitness({
    commandType: "cancel-session-end",
    commandId,
    idempotencyKey,
    agentId: "agent-full-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId,
    workflowId,
    expectedStreamVersion: "2",
    preTransitionCheckpointId: checkpointId,
  } as never, {
    authorizationKind: "protected",
    authorizationSessionId: sessionId,
    targetSessionId: sessionId,
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

function abandonWitness(
  commandId: string,
  checkpointId: string,
  expectedStreamVersion: string,
): string {
  return buildLifecycleIntentWitness({
    commandType: "abandon-session",
    commandId,
    idempotencyKey: `full-integrity/abandon/${commandId}`,
    agentId: "agent-full-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId: ROOT_ID,
    expectedStreamVersion,
    preTransitionCheckpointId: checkpointId,
    reasonCode: "explicit-user-approval",
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
  input: {
    readonly projection?: boolean;
    readonly position?: bigint;
    readonly requestVersion?: 1 | 2;
    readonly requireMaterialization?: boolean;
  } = {},
): { readonly workflowId: string; readonly commandId: string } {
  const requestVersion = input.requestVersion ?? 2;
  const position = input.position ?? 2n;
  const requireMaterialization = input.requireMaterialization ?? false;
  const evidenceWindowState = requestVersion === 2 ? "open" : "sealed";
  const workflowId = uuid(89_001);
  const commandId = uuid(30_000 + Number(position));
  const idempotencyKey = "full-integrity/end-request/2";
  rawEvent(fixture.connection, {
    globalPosition: position,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: requestVersion,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId,
    idempotencyKey,
    lifecycleIntent: requestWitnessFor(ROOT_ID, commandId, idempotencyKey, {
      requestVersion,
      requireMaterialization,
    }),
    payload: {
      workflowId,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization,
      ...(requestVersion === 2 ? { requestVersion: 2 } : {}),
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
    triggering_event_position: position,
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
    evidence_window_state: evidenceWindowState,
    final_ending_scope_bindings_json: null,
  });
  if (input.projection !== false) {
    insertWorkflowProjection(fixture, {
      projectId: PROJECT_ID,
      workflowId,
      workflowGeneration: 1,
      sessionId: ROOT_ID,
      triggerEventPosition: position,
      rootCommandId: commandId,
      evidenceWindowState,
      replacementCheckpointVersion: requestVersion,
      effectiveCheckpointVersion: requestVersion,
      effectiveDraftSourceEventPosition: position,
      previousFingerprint: null,
    });
  }
  return { workflowId, commandId };
}

function addWorkflowAmendmentMatrix(fixture: Fixture): void {
  const { workflowId } = addWorkflowRequest(fixture, { requestVersion: 1 });
  const initial = fixture.connection.prepare(`
    SELECT fingerprint
    FROM lifecycle_workflow_generation_folds
    WHERE project_id = $projectId AND workflow_id = $workflowId
      AND workflow_generation = 1
  `).get({ $projectId: PROJECT_ID, $workflowId: workflowId })!;
  let previousFingerprint = String(initial.fingerprint);
  const amendments = [
    {
      position: 3n,
      generation: 2,
      commandId: uuid(30_041),
      idempotencyKey: "full-integrity/amend/open-replacement",
      finalCheckpoint: checkpointDraft(2),
      evidenceWindowAction: "open" as const,
      evidenceWindowState: "open" as const,
      replacementCheckpointVersion: 2 as const,
      effectiveDraftSourceEventPosition: 3n,
    },
    {
      position: 4n,
      generation: 3,
      commandId: uuid(30_042),
      idempotencyKey: "full-integrity/amend/unchanged-carry",
      finalCheckpoint: null,
      evidenceWindowAction: "unchanged" as const,
      evidenceWindowState: "open" as const,
      replacementCheckpointVersion: null,
      effectiveDraftSourceEventPosition: 3n,
    },
    {
      position: 5n,
      generation: 4,
      commandId: uuid(30_043),
      idempotencyKey: "full-integrity/amend/seal-carry",
      finalCheckpoint: null,
      evidenceWindowAction: "seal" as const,
      evidenceWindowState: "sealed" as const,
      replacementCheckpointVersion: null,
      effectiveDraftSourceEventPosition: 3n,
    },
  ] as const;
  fixture.connection.exec("DROP TRIGGER workflow_instances_lifecycle_update_guard");
  fixture.connection.exec("DROP TRIGGER workflow_instances_evidence_v3_update_guard");
  for (const amendment of amendments) {
    const previousGeneration = amendment.generation - 1;
    const witness = amendmentWitnessFor({
      workflowId,
      commandId: amendment.commandId,
      idempotencyKey: amendment.idempotencyKey,
      expectedStreamVersion: (amendment.position - 1n).toString(),
      finalCheckpoint: amendment.finalCheckpoint,
      evidenceWindowAction: amendment.evidenceWindowAction,
    });
    rawEvent(fixture.connection, {
      globalPosition: amendment.position,
      streamId: `session/${ROOT_ID}`,
      streamVersion: amendment.position,
      eventType: "SessionEndAmended",
      eventSchemaVersion: 2,
      sessionId: ROOT_ID,
      parentSessionId: null,
      commandId: amendment.commandId,
      idempotencyKey: amendment.idempotencyKey,
      lifecycleIntent: witness,
      payload: {
        workflowId,
        previousWorkflowGeneration: previousGeneration,
        workflowGeneration: amendment.generation,
        preTransitionCheckpointId: CHECKPOINT_ID,
        amendmentVersion: 2,
        finalCheckpointVersion: amendment.finalCheckpoint === null ? null : 2,
        evidenceWindowAction: amendment.evidenceWindowAction,
      },
    });
    const projection = {
      projectId: PROJECT_ID,
      workflowId,
      workflowGeneration: amendment.generation,
      sessionId: ROOT_ID,
      triggerEventPosition: amendment.position,
      rootCommandId: amendment.commandId,
      evidenceWindowState: amendment.evidenceWindowState,
      replacementCheckpointVersion: amendment.replacementCheckpointVersion,
      effectiveCheckpointVersion: 2 as const,
      effectiveDraftSourceEventPosition:
        amendment.effectiveDraftSourceEventPosition,
      previousFingerprint,
    };
    insertWorkflowProjection(fixture, projection);
    previousFingerprint = referenceWorkflowGenerationFingerprint(projection);
    fixture.connection.prepare(`
      UPDATE workflow_instances
      SET generation = $generation, state = 'active', phase = 'requested',
          root_command_id = $commandId,
          triggering_event_position = $eventPosition,
          result_json = NULL, error_code = NULL,
          evidence_window_state = $evidenceWindowState,
          evidence_frozen_checkpoint_event_position = NULL,
          evidence_frozen_generation = NULL,
          final_ending_scope_bindings_json = NULL,
          updated_at = $now
      WHERE project_id = $projectId AND workflow_id = $workflowId
    `).run({
      $generation: amendment.generation,
      $commandId: amendment.commandId,
      $eventPosition: amendment.position,
      $evidenceWindowState: amendment.evidenceWindowState,
      $now: NOW,
      $projectId: PROJECT_ID,
      $workflowId: workflowId,
    });
  }
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 5, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET checkpoint_required_reason = 'end-amendment',
        checkpoint_required_event_position = 5, updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
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
  fixture.connection.exec("DROP TRIGGER workflow_instances_lifecycle_update_guard");
  fixture.connection.exec("DROP TRIGGER workflow_instances_evidence_v3_update_guard");
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET state = 'completed', phase = 'cancelled', root_command_id = $commandId,
        triggering_event_position = 3, evidence_window_state = 'sealed',
        evidence_frozen_checkpoint_event_position = NULL,
        evidence_frozen_generation = NULL,
        final_ending_scope_bindings_json = NULL,
        updated_at = $now
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $commandId: commandId,
    $now: NOW,
    $projectId: PROJECT_ID,
    $workflowId: workflowId,
  });
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

function addSchema2CollapsedAbandon(fixture: Fixture): void {
  const { workflowId } = addWorkflowRequest(fixture, { projection: false });
  const commandId = uuid(30_004);
  const checkpointId = uuid(88_004);
  const approvalId = uuid(87_004);
  const terminalAuthority: Record<string, SqliteValue> = {
    ...rootAuthority(),
    semantic_state: "abandoned",
    authority_event_position: 3,
    terminal_event_position: 3,
    terminal_event_type: "SessionAbandoned",
    terminal_at: NOW,
    revocation_reason_code: "explicit-user-approval",
    revocation_event_position: 3,
    revoked_at: NOW,
  };
  terminalAuthority.authority_commitment = commitmentForRow(terminalAuthority);
  rawEvent(fixture.connection, {
    globalPosition: 3n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 3n,
    eventType: "SessionAbandoned",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId,
    idempotencyKey: `full-integrity/abandon/${commandId}`,
    lifecycleIntent: abandonWitness(commandId, checkpointId, "2"),
    payload: {
      workflowId,
      workflowGeneration: 1,
      approvalId,
      preTransitionCheckpointId: checkpointId,
      reasonCode: "explicit-user-approval",
      authorityCommitment: terminalAuthority.authority_commitment,
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
    SET semantic_state = 'abandoned', authority_commitment = $commitment,
        authority_event_position = 3, terminal_event_position = 3,
        terminal_event_type = 'SessionAbandoned', terminal_at = $now,
        revocation_reason_code = 'explicit-user-approval',
        revocation_event_position = 3, revoked_at = $now,
        updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $commitment: terminalAuthority.authority_commitment,
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
  fixture.connection.exec("DROP TRIGGER workflow_instances_lifecycle_update_guard");
  fixture.connection.exec("DROP TRIGGER workflow_instances_evidence_v3_update_guard");
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET state = 'completed', phase = 'abandoned', root_command_id = $commandId,
        triggering_event_position = 3,
        expected_authority_commitment = $commitment,
        evidence_window_state = 'sealed',
        evidence_frozen_checkpoint_event_position = NULL,
        evidence_frozen_generation = NULL,
        final_ending_scope_bindings_json = NULL,
        updated_at = $now
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $commandId: commandId,
    $commitment: terminalAuthority.authority_commitment,
    $now: NOW,
    $projectId: PROJECT_ID,
    $workflowId: workflowId,
  });
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

function addNullIdentityAbandon(fixture: Fixture): void {
  const commandId = uuid(30_005);
  const checkpointId = uuid(88_005);
  const terminalAuthority: Record<string, SqliteValue> = {
    ...rootAuthority(),
    semantic_state: "abandoned",
    authority_event_position: 2,
    terminal_event_position: 2,
    terminal_event_type: "SessionAbandoned",
    terminal_at: NOW,
    revocation_reason_code: "explicit-user-approval",
    revocation_event_position: 2,
    revoked_at: NOW,
  };
  terminalAuthority.authority_commitment = commitmentForRow(terminalAuthority);
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionAbandoned",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId,
    idempotencyKey: `full-integrity/abandon/${commandId}`,
    lifecycleIntent: abandonWitness(commandId, checkpointId, "1"),
    payload: {
      workflowId: null,
      workflowGeneration: null,
      approvalId: uuid(87_005),
      preTransitionCheckpointId: checkpointId,
      reasonCode: "explicit-user-approval",
      authorityCommitment: terminalAuthority.authority_commitment,
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
    SET semantic_state = 'abandoned', authority_commitment = $commitment,
        authority_event_position = 2, terminal_event_position = 2,
        terminal_event_type = 'SessionAbandoned', terminal_at = $now,
        revocation_reason_code = 'explicit-user-approval',
        revocation_event_position = 2, revoked_at = $now, updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $commitment: terminalAuthority.authority_commitment,
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
}

function addLaterGenerationAfterCollapsedCancel(fixture: Fixture): void {
  addSchema2CollapsedCancel(fixture);
  const workflow = fixture.connection.prepare(`
    SELECT workflow_id FROM workflow_instances WHERE project_id = $projectId
  `).get({ $projectId: PROJECT_ID })!;
  const predecessor = fixture.connection.prepare(`
    SELECT fingerprint FROM lifecycle_workflow_generation_folds
    WHERE project_id = $projectId AND workflow_id = $workflowId
      AND workflow_generation = 1
  `).get({ $projectId: PROJECT_ID, $workflowId: workflow.workflow_id })!;
  const commandId = uuid(30_006);
  const idempotencyKey = "full-integrity/end-request/reopen";
  rawEvent(fixture.connection, {
    globalPosition: 4n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 4n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId,
    idempotencyKey,
    lifecycleIntent: requestWitnessFor(
      ROOT_ID,
      commandId,
      idempotencyKey,
    ),
    payload: {
      workflowId: workflow.workflow_id,
      workflowGeneration: 2,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
      requestVersion: 2,
    },
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 4, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  fixture.connection.prepare(`
    UPDATE session_authority SET semantic_state = 'ending', updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $sessionId: ROOT_ID });
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET generation = 2, state = 'active', phase = 'requested',
        root_command_id = $commandId, triggering_event_position = 4,
        evidence_window_state = 'open', updated_at = $now
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $commandId: commandId,
    $now: NOW,
    $projectId: PROJECT_ID,
    $workflowId: workflow.workflow_id,
  });
  insertWorkflowProjection(fixture, {
    projectId: PROJECT_ID,
    workflowId: String(workflow.workflow_id),
    workflowGeneration: 2,
    sessionId: ROOT_ID,
    triggerEventPosition: 4n,
    rootCommandId: commandId,
    evidenceWindowState: "open",
    replacementCheckpointVersion: 2,
    effectiveCheckpointVersion: 2,
    effectiveDraftSourceEventPosition: 4n,
    previousFingerprint: String(predecessor.fingerprint),
  });
}

function addInterleavedCollapsedWorkflows(fixture: Fixture): void {
  const secondRootId = uuid(54_002);
  const secondRoot: Record<string, SqliteValue> = {
    ...rootAuthority(),
    session_id: secondRootId,
    stream_id: `session/${secondRootId}`,
    authority_event_position: 2,
    continuity_fingerprint: "e".repeat(64),
    root_handle_issue_nonce: "c".repeat(64),
    root_handle_verifier: "c".repeat(64),
    root_handle_issuance_id: uuid(40_011),
    resume_token_issue_nonce: "d".repeat(64),
    resume_token_verifier: "d".repeat(64),
    resume_token_issuance_id: uuid(40_012),
  };
  secondRoot.authority_commitment = commitmentForRow(secondRoot);
  rawInsert(fixture.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${secondRootId}`,
    stream_type: "session",
    current_version: 3,
    created_at: NOW,
    updated_at: NOW,
  });
  rawEvent(fixture.connection, {
    globalPosition: 2n,
    streamId: `session/${secondRootId}`,
    streamVersion: 1n,
    eventType: "SessionStarted",
    eventSchemaVersion: 1,
    sessionId: secondRootId,
    parentSessionId: null,
    payload: {
      sessionKind: "root",
      ownerGeneration: 1,
      continuityKey: "continuity-key",
      clientNamespace: "tests",
      creatingAgentId: "agent-full-integrity",
      creatingClientInstanceId: "client-full-integrity",
      authorityCommitment: secondRoot.authority_commitment,
    },
  });
  rawInsert(fixture.connection, "session_authority", secondRoot);

  const workflows = [
    {
      sessionId: ROOT_ID,
      workflowId: uuid(89_010),
      requestCommandId: uuid(30_010),
      cancelCommandId: uuid(30_012),
      checkpointId: uuid(88_010),
      requestPosition: 3n,
      cancelPosition: 5n,
      authorityCommitment: String(rootAuthority().authority_commitment),
    },
    {
      sessionId: secondRootId,
      workflowId: uuid(89_011),
      requestCommandId: uuid(30_011),
      cancelCommandId: uuid(30_013),
      checkpointId: uuid(88_011),
      requestPosition: 4n,
      cancelPosition: 6n,
      authorityCommitment: String(secondRoot.authority_commitment),
    },
  ] as const;
  for (const item of workflows) {
    const requestKey = `full-integrity/interleaved/request/${item.workflowId}`;
    rawEvent(fixture.connection, {
      globalPosition: item.requestPosition,
      streamId: `session/${item.sessionId}`,
      streamVersion: 2n,
      eventType: "SessionEndRequested",
      eventSchemaVersion: 2,
      sessionId: item.sessionId,
      parentSessionId: null,
      commandId: item.requestCommandId,
      idempotencyKey: requestKey,
      lifecycleIntent: requestWitnessFor(
        item.sessionId,
        item.requestCommandId,
        requestKey,
      ),
      payload: {
        workflowId: item.workflowId,
        workflowGeneration: 1,
        previousState: "active",
        childEndPolicy: "require-completed",
        qualityThreshold: 0,
        requireFullEvidence: false,
        requireMaterialization: false,
        requestVersion: 2,
      },
    });
    rawInsert(fixture.connection, "workflow_instances", {
      project_id: PROJECT_ID,
      workflow_id: item.workflowId,
      workflow_type: "session-end",
      generation: 1,
      state: "active",
      phase: "requested",
      root_command_id: item.requestCommandId,
      result_json: null,
      error_code: null,
      created_at: NOW,
      updated_at: NOW,
      session_id: item.sessionId,
      triggering_event_position: item.requestPosition,
      expected_authority_commitment: item.authorityCommitment,
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
  }
  fixture.connection.exec("DROP TRIGGER workflow_instances_lifecycle_update_guard");
  fixture.connection.exec("DROP TRIGGER workflow_instances_evidence_v3_update_guard");
  fixture.connection.exec("DROP TRIGGER lifecycle_workflow_generation_folds_insert_guard");
  for (const item of workflows) {
    const cancelKey = `full-integrity/interleaved/cancel/${item.workflowId}`;
    rawEvent(fixture.connection, {
      globalPosition: item.cancelPosition,
      streamId: `session/${item.sessionId}`,
      streamVersion: 3n,
      eventType: "SessionEndCancelled",
      eventSchemaVersion: 1,
      sessionId: item.sessionId,
      parentSessionId: null,
      commandId: item.cancelCommandId,
      idempotencyKey: cancelKey,
      lifecycleIntent: cancelWitnessFor(
        item.sessionId,
        item.workflowId,
        item.cancelCommandId,
        item.checkpointId,
        cancelKey,
      ),
      payload: {
        workflowId: item.workflowId,
        workflowGeneration: 1,
        restoredState: "active",
        preTransitionCheckpointId: item.checkpointId,
      },
    });
    fixture.connection.prepare(`
      UPDATE workflow_instances
      SET state = 'completed', phase = 'cancelled',
          root_command_id = $commandId,
          triggering_event_position = $eventPosition,
          evidence_window_state = 'sealed', updated_at = $now
      WHERE project_id = $projectId AND workflow_id = $workflowId
    `).run({
      $commandId: item.cancelCommandId,
      $eventPosition: item.cancelPosition,
      $now: NOW,
      $projectId: PROJECT_ID,
      $workflowId: item.workflowId,
    });
    fixture.connection.prepare(`
      UPDATE session_authority
      SET semantic_state = 'active',
          checkpoint_required_reason = 'end-cancellation',
          checkpoint_required_event_position = $eventPosition,
          updated_at = $now
      WHERE project_id = $projectId AND session_id = $sessionId
    `).run({
      $eventPosition: item.cancelPosition,
      $now: NOW,
      $projectId: PROJECT_ID,
      $sessionId: item.sessionId,
    });
    insertWorkflowProjection(fixture, {
      projectId: PROJECT_ID,
      workflowId: item.workflowId,
      workflowGeneration: 1,
      sessionId: item.sessionId,
      triggerEventPosition: item.cancelPosition,
      rootCommandId: item.cancelCommandId,
      evidenceWindowState: "sealed",
      replacementCheckpointVersion: null,
      effectiveCheckpointVersion: 2,
      effectiveDraftSourceEventPosition: item.requestPosition,
      previousFingerprint: null,
    });
  }
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 3, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
}

function addFrozenCurrentChildWorkflow(
  fixture: Fixture,
  options: {
    readonly finalIntent?: "manual" | "internal-workflow";
    readonly requireMaterialization?: boolean;
  } = {},
): {
  readonly workflowId: string;
  readonly checkpointId: string;
  readonly checkpointFingerprint: string;
  readonly status: Readonly<Record<string, unknown>>;
} {
  const requireMaterialization = options.requireMaterialization ?? false;
  addChildFork(fixture);
  const workflowId = uuid(89_020);
  const requestCommandId = uuid(30_020);
  const requestKey = "full-integrity/frozen/request";
  rawEvent(fixture.connection, {
    globalPosition: 3n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: requestCommandId,
    idempotencyKey: requestKey,
    lifecycleIntent: requestWitnessFor(ROOT_ID, requestCommandId, requestKey, {
      requireMaterialization,
    }),
    payload: {
      workflowId,
      workflowGeneration: 1,
      previousState: "active",
      childEndPolicy: "require-completed",
      qualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization,
      requestVersion: 2,
    },
  });
  insertWorkflowProjection(fixture, {
    projectId: PROJECT_ID,
    workflowId,
    workflowGeneration: 1,
    sessionId: ROOT_ID,
    triggerEventPosition: 3n,
    rootCommandId: requestCommandId,
    evidenceWindowState: "open",
    replacementCheckpointVersion: 2,
    effectiveCheckpointVersion: 2,
    effectiveDraftSourceEventPosition: 3n,
    previousFingerprint: null,
  });

  const checkpointId = uuid(99_020);
  const draft = checkpointDraft();
  const checkpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: checkpointId as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 3,
      checkpointEventPosition: 4,
    }),
    ...draft,
    createdAt: NOW,
    creatorAgentId: "agent-full-integrity",
    creatorClientInstanceId: "client-full-integrity",
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: null,
      headCommit: null,
      dirtyWorktreeFingerprint: "2".repeat(64),
    },
    childSummaries: [{
      childSessionId: CHILD_ID,
      state: "active",
      lastEventPosition: "2",
      streamVersion: "1",
      latestCheckpointId: null,
    }],
    evidenceCoverage: {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [],
    },
  };
  const checkpointCommandId = uuid(30_021);
  const checkpointKey = "full-integrity/frozen/checkpoint";
  const internalWorkflow = options.finalIntent !== "manual";
  const plannedWorkId = "8".repeat(64);
  const claimOwnerId = uuid(89_021);
  const checkpointCommand = internalWorkflow
    ? {
        commandType: "internal-workflow-phase",
        commandId: checkpointCommandId,
        idempotencyKey: checkpointKey,
        agentId: "agent-full-integrity",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedBranchRef: null,
        workflowId,
        workflowGeneration: 1,
        plannedWorkId,
        sourcePhase: "children-resolved",
        claim: {
          workflowId,
          workflowGeneration: 1,
          claimOwnerId,
          claimToken: "1",
          claimExpiresAt: "2026-08-01T00:10:00.000Z",
        },
        action: {
          action: "record-final-checkpoint-and-queue-ending",
          finalCheckpoint: checkpoint,
          materializationTarget: "memory/session-end.md",
        },
      } as const
    : {
        commandType: "record-checkpoint",
        commandId: checkpointCommandId,
        idempotencyKey: checkpointKey,
        agentId: "agent-full-integrity",
        expectedProjectId: PROJECT_ID,
        expectedVaultId: VAULT_ID,
        expectedWorkspaceId: WORKSPACE_ID,
        expectedBranchRef: null,
        sessionId: ROOT_ID,
        expectedStreamVersion: "2",
        expectedBaseEventPosition: "3",
        draft,
      } as const;
  const checkpointIntent = buildLifecycleIntentWitness(checkpointCommand as never, {
    authorizationKind: internalWorkflow ? "internal-workflow" : "protected",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: internalWorkflow ? null : "root-session-handle",
    capabilityGeneration: internalWorkflow ? null : "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-full-integrity",
    targetActorRole: "primary",
    targetClientInstanceId: "client-full-integrity",
    internalWorkflowId: internalWorkflow ? workflowId : null,
    internalWorkflowGeneration: internalWorkflow ? 1 : null,
    internalPlannedWorkId: internalWorkflow ? plannedWorkId : null,
  });
  rawEvent(fixture.connection, {
    globalPosition: 4n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 3n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: checkpointCommandId,
    idempotencyKey: checkpointKey,
    lifecycleIntent: checkpointIntent.source,
    payload: {
      checkpoint,
      baseEventPosition: "3",
      checkpointEventPosition: "4",
    },
  });
  const response = {
    checkpointVersion: 2,
    checkpointId,
    sessionId: ROOT_ID,
    baseEventPosition: "3",
    checkpointEventPosition: "4",
    finalStreamVersion: "3",
    checkpointRequiredCleared: false,
  };
  rawInsert(fixture.connection, "command_dedup", {
    project_id: PROJECT_ID,
    idempotency_key: checkpointKey,
    command_id: checkpointCommandId,
    command_type: checkpointCommand.commandType,
    command_hash: commandHash(
      decodeLifecycleIntentWitness(checkpointIntent.source).intent.command,
    ),
    workspace_head_commit: null,
    outbox_order_json: "[]",
    state: "committed",
    first_global_position: 4,
    last_global_position: 4,
    final_stream_version: 3,
    event_ids_json: canonicalJson([uuid(10_004)]),
    response_json: canonicalJson(response),
    response_hash: responseHash(response),
    committed_at: NOW,
    lifecycle_authorization_kind: internalWorkflow ? "internal-workflow" : "protected",
    authorization_proof_version: internalWorkflow ? null : 1,
    authorization_proof_nonce: internalWorkflow ? null : uuid(99_021),
    authorization_proof_digest: internalWorkflow ? null : H64,
    authorization_approval_id: null,
    authorization_approval_digest: null,
    authorization_session_id: ROOT_ID,
    target_session_id: ROOT_ID,
    presenting_actor_role: "primary",
    presenting_client_instance_id: "client-full-integrity",
    target_actor_role: "primary",
    target_client_instance_id: "client-full-integrity",
    internal_workflow_id: internalWorkflow ? workflowId : null,
    internal_workflow_generation: internalWorkflow ? 1 : null,
    internal_planned_work_id: internalWorkflow ? plannedWorkId : null,
    internal_claim_owner_id: internalWorkflow ? claimOwnerId : null,
    internal_claim_token: internalWorkflow ? 1 : null,
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 3, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET semantic_state = 'ending', latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = 4,
        latest_checkpoint_fingerprint = $fingerprint, updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: checkpointId,
    $fingerprint: checkpointFingerprint(checkpoint),
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
  const binding = {
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: CHILD_ID,
    childState: "active",
    lastEventPosition: "2",
    streamVersion: "1",
    checkpointId: null,
    checkpointEventPosition: null,
    transferTicketId: null,
    transferTicketEventPosition: null,
  };
  const status = {
    resultVersion: 2,
    sessionId: ROOT_ID,
    workflowId,
    workflowGeneration: 1,
    phase: "final-checkpoint-recorded",
    priorRootState: "active",
    triggeringEventPosition: "3",
    finalCheckpointId: checkpointId,
    finalCheckpointEventPosition: "4",
    evidenceWindow: {
      evidenceWindowState: "sealed",
      evidenceFrozenCheckpointEventPosition: "4",
      evidenceFrozenGeneration: 1,
    },
    validationPlansReady: false,
    qualityScore: null,
    safeFailureCode: null,
    materializationRequired: requireMaterialization,
  };
  fixture.connection.exec("DROP TRIGGER workflow_instances_evidence_v3_insert_guard");
  rawInsert(fixture.connection, "workflow_instances", {
    project_id: PROJECT_ID,
    workflow_id: workflowId,
    workflow_type: "session-end",
    generation: 1,
    state: "active",
    phase: "final-checkpoint-recorded",
    root_command_id: requestCommandId,
    result_json: canonicalJson(status),
    error_code: null,
    created_at: NOW,
    updated_at: NOW,
    session_id: ROOT_ID,
    triggering_event_position: 3,
    expected_authority_commitment: rootAuthority().authority_commitment,
    coordinator_owner_id: null,
    coordinator_claim_token: null,
    coordinator_claim_expires_at: null,
    coordinator_attempt_count: internalWorkflow ? 1 : 0,
    coordinator_failure_class: null,
    coordinator_error_code: null,
    coordinator_next_attempt_at: null,
    validation_attempt_plan_generation: null,
    validation_attempt_plans_json: null,
    evidence_frozen_checkpoint_event_position: 4,
    evidence_frozen_generation: 1,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: canonicalJson([binding]),
  });
  return {
    workflowId,
    checkpointId,
    checkpointFingerprint: checkpointFingerprint(checkpoint),
    status,
  };
}

function addCoveredCurrentChildFinalCheckpoint(
  fixture: Fixture,
  childCheckpointVersion: 1 | 2 | null,
): void {
  addChildFork(fixture);
  const childAuthorityRow = childAuthority(CHILD_ID, 2n);
  const forkProjection = testChildProjection({
    projectId: PROJECT_ID,
    childSessionId: CHILD_ID,
    eventPosition: 2n,
    streamVersion: 1n,
    rootSessionId: ROOT_ID,
    childState: "active",
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    authorityCommitment: String(childAuthorityRow.authority_commitment),
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
  });
  let childCheckpointId: string | null = null;
  let childProjection = forkProjection;
  let childStreamVersion = 1n;
  let evidencePosition = 3n;
  if (childCheckpointVersion !== null) {
    childCheckpointId = uuid(78_000 + childCheckpointVersion);
    const childDraft = checkpointDraft(childCheckpointVersion);
    const base = childCheckpointVersion === 1
      ? checkpointFixture({
          checkpointId: childCheckpointId as never,
          sessionId: CHILD_ID as never,
          parentSessionId: ROOT_ID as never,
          baseEventPosition: 2,
          checkpointEventPosition: 3,
        })
      : qualifiedCheckpointFixture({
          checkpointId: childCheckpointId as never,
          sessionId: CHILD_ID as never,
          parentSessionId: ROOT_ID as never,
          baseEventPosition: 2,
          checkpointEventPosition: 3,
        });
    const childCheckpoint = {
      ...base,
      ...childDraft,
      createdAt: NOW,
      creatorAgentId: "agent-full-integrity",
      creatorClientInstanceId: "client-full-integrity",
      sourceState: {
        sourceStateScopeVersion: 1,
        workspaceId: WORKSPACE_ID,
        branchRef: null,
        headCommit: null,
        dirtyWorktreeFingerprint: "8".repeat(64),
      },
      childSummaries: [],
      evidenceCoverage: childCheckpointVersion === 1
        ? {
            captureMode: "coverage-only",
            contentRetained: false,
            highestContiguousOrdinal: null,
            missingIntervals: [],
          }
        : {
            coverageVersion: 2,
            captureMode: "coverage-only",
            contentRetained: false,
            adapterSessions: [],
          },
    };
    insertFullCheckpoint(fixture, {
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      baseEventPosition: 2n,
      checkpointEventPosition: 3n,
      streamVersion: 2n,
      checkpoint: childCheckpoint,
      draft: childDraft,
      commandId: uuid(78_010 + childCheckpointVersion),
      idempotencyKey: `full-integrity/covered-child/v${childCheckpointVersion}`,
      targetActorRole: "untrusted",
      targetClientInstanceId: "child-client",
    });
    fixture.connection.prepare(`
      UPDATE streams SET current_version = 2, updated_at = $now
      WHERE project_id = $projectId AND stream_id = $streamId
    `).run({
      $now: NOW,
      $projectId: PROJECT_ID,
      $streamId: `session/${CHILD_ID}`,
    });
    fixture.connection.prepare(`
      UPDATE session_authority
      SET latest_checkpoint_id = $checkpointId,
          latest_checkpoint_event_position = 3,
          latest_checkpoint_fingerprint = $fingerprint,
          updated_at = $now
      WHERE project_id = $projectId AND session_id = $sessionId
    `).run({
      $checkpointId: childCheckpointId,
      $fingerprint: checkpointFingerprint(childCheckpoint),
      $now: NOW,
      $projectId: PROJECT_ID,
      $sessionId: CHILD_ID,
    });
    childProjection = carryTestChildProjection(forkProjection, {
      eventPosition: 3n,
      streamVersion: 2n,
      latestCheckpointId: childCheckpointId,
      latestCheckpointEventPosition: 3n,
    });
    insertTestChildProjection(fixture.connection, childProjection);
    childStreamVersion = 2n;
    evidencePosition = 4n;
  }
  const evidenceStreamVersion = childStreamVersion + 1n;
  addCoverage(fixture, {
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    position: evidencePosition,
    streamVersion: evidenceStreamVersion,
  });
  childProjection = carryTestChildProjection(childProjection, {
    eventPosition: evidencePosition,
    streamVersion: evidenceStreamVersion,
  });
  insertTestChildProjection(fixture.connection, childProjection);

  const requestPosition = evidencePosition + 1n;
  const { workflowId } = addWorkflowRequest(fixture, { position: requestPosition });
  const finalPosition = requestPosition + 1n;
  const rootCheckpointId = uuid(78_100 + (childCheckpointVersion ?? 0));
  const rootDraft = checkpointDraft();
  const rootCheckpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: rootCheckpointId as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: Number(requestPosition),
      checkpointEventPosition: Number(finalPosition),
    }),
    ...rootDraft,
    createdAt: NOW,
    creatorAgentId: "agent-full-integrity",
    creatorClientInstanceId: "client-full-integrity",
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: null,
      headCommit: null,
      dirtyWorktreeFingerprint: "9".repeat(64),
    },
    childSummaries: [{
      childSessionId: CHILD_ID,
      state: "active",
      lastEventPosition: evidencePosition.toString(),
      streamVersion: evidenceStreamVersion.toString(),
      latestCheckpointId: childCheckpointId,
    }],
    evidenceCoverage: {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [],
    },
  };
  insertFullCheckpoint(fixture, {
    sessionId: ROOT_ID,
    parentSessionId: null,
    baseEventPosition: requestPosition,
    checkpointEventPosition: finalPosition,
    streamVersion: 3n,
    checkpoint: rootCheckpoint,
    draft: rootDraft,
    commandId: uuid(78_110 + (childCheckpointVersion ?? 0)),
    idempotencyKey: `full-integrity/covered-child/final-${childCheckpointVersion ?? "null"}`,
    internalWorkflow: {
      workflowId,
      workflowGeneration: 1,
      plannedWorkId: "a".repeat(64),
      claimOwnerId: uuid(78_120 + (childCheckpointVersion ?? 0)),
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
    SET latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = $checkpointPosition,
        latest_checkpoint_fingerprint = $fingerprint,
        updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: rootCheckpointId,
    $checkpointPosition: finalPosition,
    $fingerprint: checkpointFingerprint(rootCheckpoint),
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
  const binding = {
    bindingVersion: 1,
    bindingKind: "current-child",
    childSessionId: CHILD_ID,
    childState: "active",
    lastEventPosition: evidencePosition.toString(),
    streamVersion: evidenceStreamVersion.toString(),
    checkpointId: childCheckpointId,
    checkpointEventPosition: childCheckpointId === null ? null : "3",
    transferTicketId: null,
    transferTicketEventPosition: null,
  };
  const status = {
    resultVersion: 2,
    sessionId: ROOT_ID,
    workflowId,
    workflowGeneration: 1,
    phase: "final-checkpoint-recorded",
    priorRootState: "active",
    triggeringEventPosition: requestPosition.toString(),
    finalCheckpointId: rootCheckpointId,
    finalCheckpointEventPosition: finalPosition.toString(),
    evidenceWindow: {
      evidenceWindowState: "sealed",
      evidenceFrozenCheckpointEventPosition: finalPosition.toString(),
      evidenceFrozenGeneration: 1,
    },
    validationPlansReady: false,
    qualityScore: null,
    safeFailureCode: null,
    materializationRequired: false,
  };
  fixture.connection.exec("DROP TRIGGER workflow_instances_lifecycle_update_guard");
  fixture.connection.exec("DROP TRIGGER workflow_instances_evidence_v3_update_guard");
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET phase = 'final-checkpoint-recorded', result_json = $resultJson,
        updated_at = $now,
        evidence_frozen_checkpoint_event_position = $checkpointPosition,
        evidence_frozen_generation = 1,
        evidence_window_state = 'sealed',
        final_ending_scope_bindings_json = $bindingsJson
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $resultJson: canonicalJson(status),
    $now: NOW,
    $checkpointPosition: finalPosition,
    $bindingsJson: canonicalJson([binding]),
    $projectId: PROJECT_ID,
    $workflowId: workflowId,
  });
}

function addFrozenCarryForwardWorkflow(fixture: Fixture): {
  readonly ticketId: string;
} {
  const checkpointId = uuid(99_030);
  const ticketId = uuid(99_031);
  const childDraft = checkpointDraft();
  const childCheckpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: checkpointId as never,
      sessionId: CHILD_ID as never,
      parentSessionId: ROOT_ID as never,
      baseEventPosition: 2,
      checkpointEventPosition: 3,
    }),
    ...childDraft,
    createdAt: NOW,
    creatorAgentId: "agent-full-integrity",
    creatorClientInstanceId: "client-full-integrity",
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: null,
      headCommit: null,
      dirtyWorktreeFingerprint: "4".repeat(64),
    },
    childSummaries: [],
    evidenceCoverage: {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [],
    },
  };
  const childStart = childAuthority(CHILD_ID, 2n);
  const suspended: Record<string, SqliteValue> = {
    ...childStart,
    semantic_state: "suspended",
    authority_event_position: 4,
    latest_checkpoint_id: checkpointId,
    latest_checkpoint_event_position: 3,
    latest_checkpoint_fingerprint: checkpointFingerprint(childCheckpoint),
    revocation_reason_code: "child-suspended",
    revocation_event_position: 4,
    revoked_at: NOW,
  };
  suspended.authority_commitment = commitmentForRow(suspended);
  const transferred: Record<string, SqliteValue> = {
    ...suspended,
    semantic_state: "transferred",
    child_capability_generation: childStart.child_capability_generation,
    direct_access_enabled: childStart.direct_access_enabled,
    child_handle_capability_version: childStart.child_handle_capability_version,
    child_handle_key_id: childStart.child_handle_key_id,
    child_handle_issue_nonce: childStart.child_handle_issue_nonce,
    child_handle_issued_at: childStart.child_handle_issued_at,
    child_handle_policy_code: childStart.child_handle_policy_code,
    child_handle_expiry_kind: childStart.child_handle_expiry_kind,
    child_handle_expires_at: childStart.child_handle_expires_at,
    child_handle_actor_role: childStart.child_handle_actor_role,
    child_handle_client_instance_id: childStart.child_handle_client_instance_id,
    child_handle_verifier: childStart.child_handle_verifier,
    child_handle_issuance_id: childStart.child_handle_issuance_id,
    authority_event_position: 5,
    revocation_reason_code: "child-transferred",
    revocation_event_position: 5,
    revoked_at: NOW,
    terminal_event_position: 5,
    terminal_event_type: "ChildWorkTransferCreated",
    terminal_at: NOW,
  };
  transferred.authority_commitment = commitmentForRow(transferred);
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
    payload: {
      parentSessionId: ROOT_ID,
      assignment: {
        assignmentId: uuid(55_001),
        summary: "Task 12J child replay",
        scope: "tests/qualified-checkpoint-full-integrity.test.ts",
      },
      rootOwnerGeneration: 1,
      directAccessEnabled: true,
      authorityCommitment: childStart.authority_commitment,
      sourceTransferTicketId: null,
    },
  });
  insertFullCheckpoint(fixture, {
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    baseEventPosition: 2n,
    checkpointEventPosition: 3n,
    streamVersion: 2n,
    checkpoint: childCheckpoint,
    draft: childDraft,
    commandId: uuid(30_030),
    idempotencyKey: "full-integrity/carry/child-checkpoint",
    targetActorRole: "untrusted",
    targetClientInstanceId: "child-client",
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
      authorityCommitment: suspended.authority_commitment,
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
  const assignment = {
    assignmentId: uuid(55_001),
    summary: "Task 12J child replay",
    scope: "tests/qualified-checkpoint-full-integrity.test.ts",
    assignmentRevision: 1,
  };
  rawInsert(fixture.connection, "child_transfer_tickets", {
    project_id: PROJECT_ID,
    transfer_ticket_id: ticketId,
    source_parent_session_id: ROOT_ID,
    source_child_session_id: CHILD_ID,
    source_assignment_json: canonicalJson(assignment),
    source_scope_json: canonicalJson({ scope: assignment.scope }),
    checkpoint_id: checkpointId,
    follow_ups_json: canonicalJson([{
      childTransferAnnotationsVersion: 1,
      blockers: [],
      followUps: [],
    }]),
    source_state_json: canonicalJson(childCheckpoint.sourceState),
    lineage_json: canonicalJson({
      previousParentSessionId: ROOT_ID,
      previousChildSessionId: CHILD_ID,
      correlationId: CHILD_ID,
      transferEventPosition: "5",
    }),
    created_event_position: 5,
    created_at: NOW,
    claimed_by_root_session_id: null,
    claimed_child_session_id: null,
    claimed_event_position: null,
    claimed_at: null,
  });
  const forkProjection = testChildProjection({
    projectId: PROJECT_ID,
    childSessionId: CHILD_ID,
    eventPosition: 2n,
    streamVersion: 1n,
    rootSessionId: ROOT_ID,
    childState: "active",
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    authorityCommitment: String(childStart.authority_commitment),
    terminalEventType: null,
    terminalEventPosition: null,
    reportCount: 0,
    latestReportId: null,
    reportIndexFingerprint: referenceReportIndexGenesisFingerprint(PROJECT_ID, CHILD_ID),
    completionReportId: null,
    reportedReportId: null,
    reportedItemCount: null,
    reportedItemSetFingerprint: null,
    previousFingerprint: null,
  });
  const checkpointProjection = carryTestChildProjection(forkProjection, {
    eventPosition: 3n,
    streamVersion: 2n,
    latestCheckpointId: checkpointId,
    latestCheckpointEventPosition: 3n,
  });
  const suspendedProjection = carryTestChildProjection(checkpointProjection, {
    eventPosition: 4n,
    streamVersion: 3n,
    childState: "suspended",
    authorityCommitment: String(suspended.authority_commitment),
  });
  const transferredProjection = carryTestChildProjection(suspendedProjection, {
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
    transferredProjection,
  ]) insertTestChildProjection(fixture.connection, projection);

  const workflowId = uuid(89_030);
  const requestCommandId = uuid(30_031);
  const requestKey = "full-integrity/carry/request";
  rawEvent(fixture.connection, {
    globalPosition: 6n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 2n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: requestCommandId,
    idempotencyKey: requestKey,
    lifecycleIntent: requestWitnessFor(ROOT_ID, requestCommandId, requestKey),
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
  insertWorkflowProjection(fixture, {
    projectId: PROJECT_ID,
    workflowId,
    workflowGeneration: 1,
    sessionId: ROOT_ID,
    triggerEventPosition: 6n,
    rootCommandId: requestCommandId,
    evidenceWindowState: "open",
    replacementCheckpointVersion: 2,
    effectiveCheckpointVersion: 2,
    effectiveDraftSourceEventPosition: 6n,
    previousFingerprint: null,
  });
  const rootCheckpointId = uuid(99_032);
  const rootDraft = checkpointDraft();
  const rootCheckpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: rootCheckpointId as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 6,
      checkpointEventPosition: 7,
    }),
    ...rootDraft,
    createdAt: NOW,
    creatorAgentId: "agent-full-integrity",
    creatorClientInstanceId: "client-full-integrity",
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: null,
      headCommit: null,
      dirtyWorktreeFingerprint: "5".repeat(64),
    },
    childSummaries: [{
      childSessionId: CHILD_ID,
      state: "transferred",
      lastEventPosition: "5",
      streamVersion: "4",
      latestCheckpointId: checkpointId,
    }],
    evidenceCoverage: {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [],
    },
  };
  insertFullCheckpoint(fixture, {
    sessionId: ROOT_ID,
    parentSessionId: null,
    baseEventPosition: 6n,
    checkpointEventPosition: 7n,
    streamVersion: 3n,
    checkpoint: rootCheckpoint,
    draft: rootDraft,
    commandId: uuid(30_032),
    idempotencyKey: "full-integrity/carry/root-checkpoint",
    internalWorkflow: {
      workflowId,
      workflowGeneration: 1,
      plannedWorkId: "9".repeat(64),
      claimOwnerId: uuid(89_031),
    },
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 3, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET semantic_state = 'ending', latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = 7,
        latest_checkpoint_fingerprint = $fingerprint, updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: rootCheckpointId,
    $fingerprint: checkpointFingerprint(rootCheckpoint),
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
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
  const status = {
    resultVersion: 2,
    sessionId: ROOT_ID,
    workflowId,
    workflowGeneration: 1,
    phase: "final-checkpoint-recorded",
    priorRootState: "active",
    triggeringEventPosition: "6",
    finalCheckpointId: rootCheckpointId,
    finalCheckpointEventPosition: "7",
    evidenceWindow: {
      evidenceWindowState: "sealed",
      evidenceFrozenCheckpointEventPosition: "7",
      evidenceFrozenGeneration: 1,
    },
    validationPlansReady: false,
    qualityScore: null,
    safeFailureCode: null,
    materializationRequired: false,
  };
  fixture.connection.exec("DROP TRIGGER workflow_instances_evidence_v3_insert_guard");
  rawInsert(fixture.connection, "workflow_instances", {
    project_id: PROJECT_ID,
    workflow_id: workflowId,
    workflow_type: "session-end",
    generation: 1,
    state: "active",
    phase: "final-checkpoint-recorded",
    root_command_id: requestCommandId,
    result_json: canonicalJson(status),
    error_code: null,
    created_at: NOW,
    updated_at: NOW,
    session_id: ROOT_ID,
    triggering_event_position: 6,
    expected_authority_commitment: rootAuthority().authority_commitment,
    coordinator_owner_id: null,
    coordinator_claim_token: null,
    coordinator_claim_expires_at: null,
    coordinator_attempt_count: 1,
    coordinator_failure_class: null,
    coordinator_error_code: null,
    coordinator_next_attempt_at: null,
    validation_attempt_plan_generation: null,
    validation_attempt_plans_json: null,
    evidence_frozen_checkpoint_event_position: 7,
    evidence_frozen_generation: 1,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: canonicalJson([binding]),
  });
  return { ticketId };
}

function addReportResetCompletionMatrix(fixture: Fixture): void {
  const assignmentId = uuid(55_001);
  const reportAId = uuid(91_001);
  const reportCId = uuid(91_003);
  const reportA = childReportFixture({
    reportId: reportAId as never,
    childSessionId: CHILD_ID as never,
    parentSessionId: ROOT_ID as never,
    assignmentId,
  });
  const reportC = childReportFixture({
    reportId: reportCId as never,
    childSessionId: CHILD_ID as never,
    parentSessionId: ROOT_ID as never,
    assignmentId,
  });
  const { allReportItemIds: reportAItems, ...storedReportA } = reportA;
  const { allReportItemIds: reportCItems, ...storedReportC } = reportC;
  const start = childAuthority(CHILD_ID, 2n);
  const completed: Record<string, SqliteValue> = {
    ...start,
    semantic_state: "completed",
    authority_event_position: 9,
    revocation_reason_code: "child-completed",
    revocation_event_position: 9,
    revoked_at: NOW,
    terminal_event_position: 9,
    terminal_event_type: "ChildSessionCompleted",
    terminal_at: NOW,
  };
  completed.authority_commitment = commitmentForRow(completed);
  rawInsert(fixture.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${CHILD_ID}`,
    stream_type: "session",
    current_version: 8,
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
        assignmentId,
        summary: "Task 12J child replay",
        scope: "tests/qualified-checkpoint-full-integrity.test.ts",
      },
      rootOwnerGeneration: 1,
      directAccessEnabled: true,
      authorityCommitment: start.authority_commitment,
      sourceTransferTicketId: null,
    },
  });
  rawEvent(fixture.connection, {
    globalPosition: 3n,
    streamId: `session/${CHILD_ID}`,
    streamVersion: 2n,
    eventType: "ChildAssignmentAmended",
    eventSchemaVersion: 1,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: {
      previousAssignmentRevision: 1,
      assignmentRevision: 2,
      assignment: {
        assignmentId,
        summary: "Task 12J amended child replay",
        scope: "tests/qualified-checkpoint-full-integrity.test.ts",
      },
      reasonCode: "scope-clarified",
    },
  });
  for (const [position, streamVersion, report] of [
    [4n, 3n, storedReportA],
    [5n, 4n, storedReportC],
  ] as const) {
    rawEvent(fixture.connection, {
      globalPosition: position,
      streamId: `session/${CHILD_ID}`,
      streamVersion,
      eventType: "ChildWorkReported",
      eventSchemaVersion: 1,
      sessionId: CHILD_ID,
      parentSessionId: ROOT_ID,
      payload: {
        report,
        childAuthorAgentId: "agent-child",
        primaryRecorderAgentId: "agent-full-integrity",
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
    payload: { reportId: reportAId },
  });
  rawEvent(fixture.connection, {
    globalPosition: 7n,
    streamId: `session/${CHILD_ID}`,
    streamVersion: 6n,
    eventType: "ChildWorkDispositioned",
    eventSchemaVersion: 1,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: { disposition: childDispositionFixture("rejected", reportAId as never) },
  });
  rawEvent(fixture.connection, {
    globalPosition: 8n,
    streamId: `session/${CHILD_ID}`,
    streamVersion: 7n,
    eventType: "ChildCompletionProposed",
    eventSchemaVersion: 1,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: { reportId: reportAId },
  });
  rawEvent(fixture.connection, {
    globalPosition: 9n,
    streamId: `session/${CHILD_ID}`,
    streamVersion: 8n,
    eventType: "ChildSessionCompleted",
    eventSchemaVersion: 1,
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    payload: {
      reportId: reportAId,
      authorityCommitment: completed.authority_commitment,
    },
  });
  rawInsert(fixture.connection, "session_authority", completed);
  const fork = testChildProjection({
    projectId: PROJECT_ID,
    childSessionId: CHILD_ID,
    eventPosition: 2n,
    streamVersion: 1n,
    rootSessionId: ROOT_ID,
    childState: "active",
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    authorityCommitment: String(start.authority_commitment),
    terminalEventType: null,
    terminalEventPosition: null,
    reportCount: 0,
    latestReportId: null,
    reportIndexFingerprint: referenceReportIndexGenesisFingerprint(PROJECT_ID, CHILD_ID),
    completionReportId: null,
    reportedReportId: null,
    reportedItemCount: null,
    reportedItemSetFingerprint: null,
    previousFingerprint: null,
  });
  const amended = carryTestChildProjection(fork, {
    eventPosition: 3n,
    streamVersion: 2n,
  });
  const reportedA = reportTestChildProjection(amended, {
    eventPosition: 4n,
    streamVersion: 3n,
    reportId: reportAId,
    allReportItemIds: reportAItems,
  });
  const reportedC = reportTestChildProjection(reportedA, {
    eventPosition: 5n,
    streamVersion: 4n,
    reportId: reportCId,
    allReportItemIds: reportCItems,
  });
  const proposed = carryTestChildProjection(reportedC, {
    eventPosition: 6n,
    streamVersion: 5n,
    childState: "completion-proposed",
    completionReportId: reportAId,
  });
  const reset = carryTestChildProjection(proposed, {
    eventPosition: 7n,
    streamVersion: 6n,
    childState: "active",
    completionReportId: null,
  });
  const reproposed = carryTestChildProjection(reset, {
    eventPosition: 8n,
    streamVersion: 7n,
    childState: "completion-proposed",
    completionReportId: reportAId,
  });
  const terminal = carryTestChildProjection(reproposed, {
    eventPosition: 9n,
    streamVersion: 8n,
    childState: "completed",
    authorityCommitment: String(completed.authority_commitment),
    terminalEventType: "ChildSessionCompleted",
    terminalEventPosition: 9n,
  });
  for (const projection of [
    fork,
    amended,
    reportedA,
    reportedC,
    proposed,
    reset,
    reproposed,
    terminal,
  ]) insertTestChildProjection(fixture.connection, projection);
}

function addClaimAfterFrozenCarry(
  fixture: Fixture,
  ticketId: string,
): void {
  const claimedChildId = uuid(55_031);
  const claimed: Record<string, SqliteValue> = {
    ...childAuthority(claimedChildId, 8n),
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
    checkpoint_required_event_position: 9,
  };
  claimed.authority_commitment = commitmentForRow(claimed);
  rawInsert(fixture.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${claimedChildId}`,
    stream_type: "session",
    current_version: 2,
    created_at: NOW,
    updated_at: NOW,
  });
  rawEvent(fixture.connection, {
    globalPosition: 8n,
    streamId: `session/${claimedChildId}`,
    streamVersion: 1n,
    eventType: "SessionForked",
    eventSchemaVersion: 1,
    sessionId: claimedChildId,
    parentSessionId: ROOT_ID,
    payload: {
      parentSessionId: ROOT_ID,
      assignment: {
        assignmentId: uuid(55_001),
        summary: "Task 12J child replay",
        scope: "tests/qualified-checkpoint-full-integrity.test.ts",
      },
      rootOwnerGeneration: 1,
      directAccessEnabled: false,
      authorityCommitment: claimed.authority_commitment,
      sourceTransferTicketId: ticketId,
    },
  });
  rawEvent(fixture.connection, {
    globalPosition: 9n,
    streamId: `session/${claimedChildId}`,
    streamVersion: 2n,
    eventType: "ChildWorkTransferClaimed",
    eventSchemaVersion: 1,
    sessionId: claimedChildId,
    parentSessionId: ROOT_ID,
    payload: {
      transferTicketId: ticketId,
      previousChildSessionId: CHILD_ID,
      previousTransferEventPosition: "5",
    },
  });
  rawInsert(fixture.connection, "session_authority", claimed);
  fixture.connection.prepare(`
    UPDATE child_transfer_tickets
    SET claimed_by_root_session_id = $rootSessionId,
        claimed_child_session_id = $childSessionId,
        claimed_event_position = 9, claimed_at = $now
    WHERE project_id = $projectId AND transfer_ticket_id = $ticketId
  `).run({
    $rootSessionId: ROOT_ID,
    $childSessionId: claimedChildId,
    $now: NOW,
    $projectId: PROJECT_ID,
    $ticketId: ticketId,
  });
  const fork = testChildProjection({
    projectId: PROJECT_ID,
    childSessionId: claimedChildId,
    eventPosition: 8n,
    streamVersion: 1n,
    rootSessionId: ROOT_ID,
    childState: "active",
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    authorityCommitment: String(claimed.authority_commitment),
    terminalEventType: null,
    terminalEventPosition: null,
    reportCount: 0,
    latestReportId: null,
    reportIndexFingerprint: referenceReportIndexGenesisFingerprint(
      PROJECT_ID,
      claimedChildId,
    ),
    completionReportId: null,
    reportedReportId: null,
    reportedItemCount: null,
    reportedItemSetFingerprint: null,
    previousFingerprint: null,
  });
  const claimedProjection = carryTestChildProjection(fork, {
    eventPosition: 9n,
    streamVersion: 2n,
  });
  insertTestChildProjection(fixture.connection, fork);
  insertTestChildProjection(fixture.connection, claimedProjection);
}

function addCheckpointRewrittenToChildStateAfterDeclaredBase(
  fixture: Fixture,
): void {
  addChildFork(fixture);
  const checkpointId = uuid(99_041);
  const draft = checkpointDraft();
  const checkpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: checkpointId as never,
      sessionId: ROOT_ID as never,
      parentSessionId: null,
      baseEventPosition: 1,
      checkpointEventPosition: 3,
    }),
    ...draft,
    createdAt: NOW,
    creatorAgentId: "agent-full-integrity",
    creatorClientInstanceId: "client-full-integrity",
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: null,
      headCommit: null,
      dirtyWorktreeFingerprint: "7".repeat(64),
    },
    childSummaries: [{
      childSessionId: CHILD_ID,
      state: "active",
      lastEventPosition: "2",
      streamVersion: "1",
      latestCheckpointId: null,
    }],
    evidenceCoverage: {
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [],
    },
  };
  insertFullCheckpoint(fixture, {
    sessionId: ROOT_ID,
    parentSessionId: null,
    baseEventPosition: 1n,
    checkpointEventPosition: 3n,
    streamVersion: 2n,
    checkpoint,
    draft,
    commandId: uuid(30_041),
    idempotencyKey: "full-integrity/base-time-rewrite/root-checkpoint",
  });
  fixture.connection.prepare(`
    UPDATE streams SET current_version = 2, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({ $now: NOW, $projectId: PROJECT_ID, $streamId: `session/${ROOT_ID}` });
  fixture.connection.prepare(`
    UPDATE session_authority
    SET latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = 3,
        latest_checkpoint_fingerprint = $fingerprint,
        updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: checkpointId,
    $fingerprint: checkpointFingerprint(checkpoint),
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
}

type DurableWorkflowOutcome = "passed" | "failed" | "invalidated" | "ended";
type CompletionEndpointPhase =
  | "completion-appended"
  | "completed-materialization-confirmed"
  | "completed";

function internalWorkflowWitness(
  command: Readonly<Record<string, unknown>>,
): string {
  return buildLifecycleIntentWitness(command as never, {
    authorizationKind: "internal-workflow",
    authorizationSessionId: ROOT_ID,
    targetSessionId: ROOT_ID,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-full-integrity",
    targetActorRole: "primary",
    targetClientInstanceId: "client-full-integrity",
    internalWorkflowId: String(command.workflowId),
    internalWorkflowGeneration: Number(command.workflowGeneration),
    internalPlannedWorkId: String(command.plannedWorkId),
  }).source;
}

function addDurableWorkflowOutcome(
  fixture: Fixture,
  input: {
    readonly outcome: DurableWorkflowOutcome;
    readonly requireMaterialization?: boolean;
    readonly endpointPhase?: CompletionEndpointPhase;
  },
): void {
  const frozen = addFrozenCurrentChildWorkflow(fixture, {
    finalIntent: "internal-workflow",
    requireMaterialization: input.requireMaterialization,
  });
  const resultId = uuid(90_050);
  const resultCommandId = uuid(30_050);
  const resultIdempotencyKey = "full-integrity/workflow/validation-result";
  const validationPassed = input.outcome !== "failed";
  const sourceState = {
    sourceStateScopeVersion: 1 as const,
    workspaceId: WORKSPACE_ID,
    branchRef: null,
    headCommit: null,
    dirtyWorktreeFingerprint: "2".repeat(64),
  };
  const validationResult = {
    ...validationResultFixture({
      sessionId: ROOT_ID as never,
      workflowId: frozen.workflowId as never,
      workflowGeneration: 1,
      resultId: resultId as never,
    }),
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    runnerId: uuid(90_051),
    finalCheckpointId: frozen.checkpointId,
    finalCheckpointFingerprint: frozen.checkpointFingerprint,
    sourceStateAtStart: sourceState,
    sourceStateAtCompletion: sourceState,
    startedAt: NOW,
    completedAt: NOW,
    status: validationPassed ? "pass" as const : "fail" as const,
    exitClassification: validationPassed ? "passed" as const : "failed" as const,
    summary: validationPassed
      ? "Durable validation passed"
      : "Durable validation failed",
  };
  const validationPlannedWorkId = internalValidationPlannedWorkId({
    workflowId: frozen.workflowId,
    workflowGeneration: 1n,
    resultId,
    commandId: resultCommandId,
    idempotencyKey: resultIdempotencyKey,
  });
  const attemptPlan = {
    attemptPlanVersion: 1 as const,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: ROOT_ID,
    workflowId: frozen.workflowId,
    workflowGeneration: 1,
    plannedWorkId: validationPlannedWorkId,
    finalCheckpointId: frozen.checkpointId,
    finalCheckpointFingerprint: frozen.checkpointFingerprint,
    profileId: validationResult.profileId,
    profileVersion: validationResult.profileVersion,
    profileConfigurationHash: validationResult.profileConfigurationHash,
    runId: validationResult.runId,
    resultId,
    resultCommandId,
    resultIdempotencyKey,
  };
  const validationCommand = {
    commandType: "internal-validation-result",
    commandId: resultCommandId,
    idempotencyKey: resultIdempotencyKey,
    agentId: "agent-full-integrity",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    workflowId: frozen.workflowId,
    workflowGeneration: 1,
    plannedWorkId: validationPlannedWorkId,
    attemptPlan,
    claim: {
      workflowId: frozen.workflowId,
      workflowGeneration: 1,
      claimOwnerId: uuid(89_050),
      claimToken: "2",
      claimExpiresAt: "2026-08-01T00:10:00.000Z",
    },
    result: validationResult,
  } as const;
  rawEvent(fixture.connection, {
    globalPosition: 5n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 4n,
    eventType: "SessionValidationResultRecorded",
    eventSchemaVersion: 1,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId: resultCommandId,
    idempotencyKey: resultIdempotencyKey,
    lifecycleIntent: internalWorkflowWitness(validationCommand),
    payload: {
      workflowId: frozen.workflowId,
      workflowGeneration: 1,
      plannedWorkId: validationPlannedWorkId,
      validationResult,
    },
  });
  rawInsert(fixture.connection, "lifecycle_validation_results", {
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    session_id: ROOT_ID,
    result_id: validationResult.resultId,
    validation_result_version: validationResult.validationResultVersion,
    workflow_id: frozen.workflowId,
    workflow_generation: 1,
    workspace_id: WORKSPACE_ID,
    profile_id: validationResult.profileId,
    profile_version: validationResult.profileVersion,
    profile_configuration_hash: validationResult.profileConfigurationHash,
    run_id: validationResult.runId,
    runner_id: validationResult.runnerId,
    final_checkpoint_id: validationResult.finalCheckpointId,
    final_checkpoint_fingerprint: validationResult.finalCheckpointFingerprint,
    validation_start_scope_version:
      validationResult.sourceStateAtStart.sourceStateScopeVersion,
    validation_start_project_id: validationResult.projectId,
    validation_start_workspace_id: validationResult.sourceStateAtStart.workspaceId,
    validation_start_branch_ref: validationResult.sourceStateAtStart.branchRef,
    validation_start_head_commit: validationResult.sourceStateAtStart.headCommit,
    validation_start_dirty_fingerprint:
      validationResult.sourceStateAtStart.dirtyWorktreeFingerprint,
    validation_completion_scope_version:
      validationResult.sourceStateAtCompletion.sourceStateScopeVersion,
    validation_completion_project_id: validationResult.projectId,
    validation_completion_workspace_id:
      validationResult.sourceStateAtCompletion.workspaceId,
    validation_completion_branch_ref:
      validationResult.sourceStateAtCompletion.branchRef,
    validation_completion_head_commit:
      validationResult.sourceStateAtCompletion.headCommit,
    validation_completion_dirty_fingerprint:
      validationResult.sourceStateAtCompletion.dirtyWorktreeFingerprint,
    started_at: validationResult.startedAt,
    completed_at: validationResult.completedAt,
    status: validationResult.status,
    exit_classification: validationResult.exitClassification,
    redacted_summary: validationResult.summary,
    output_fingerprint_algorithm: "hmac-sha256",
    output_fingerprint_schema_version:
      validationResult.outputFingerprint.fingerprintSchemaVersion,
    output_fingerprint_key_id: validationResult.outputFingerprint.fingerprintKeyId,
    output_fingerprint_domain: validationResult.outputFingerprint.fingerprintDomain,
    output_fingerprint_value: validationResult.outputFingerprint.fingerprint,
    artifact_references_json: canonicalJson(validationResult.artifactReferences),
    fresh: validationResult.fresh ? 1 : 0,
    recorded_event_position: 5,
    created_at: NOW,
  });

  const appendPhase = (
    position: bigint,
    streamVersion: bigint,
    sourcePhase: string,
    action: Readonly<Record<string, unknown>>,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
    commandIndex: number,
  ): void => {
    const commandId = uuid(commandIndex);
    const idempotencyKey = `full-integrity/workflow/${String(action.action)}`;
    const plannedWorkId = internalPhasePlannedWorkId({
      workflowId: frozen.workflowId,
      workflowGeneration: 1n,
      sourcePhase,
      action: String(action.action),
      commandId,
      idempotencyKey,
    });
    const command = {
      commandType: "internal-workflow-phase",
      commandId,
      idempotencyKey,
      agentId: "agent-full-integrity",
      expectedProjectId: PROJECT_ID,
      expectedVaultId: VAULT_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      expectedBranchRef: null,
      workflowId: frozen.workflowId,
      workflowGeneration: 1,
      plannedWorkId,
      sourcePhase,
      claim: {
        workflowId: frozen.workflowId,
        workflowGeneration: 1,
        claimOwnerId: uuid(89_051),
        claimToken: "3",
        claimExpiresAt: "2026-08-01T00:10:00.000Z",
      },
      action,
    } as const;
    rawEvent(fixture.connection, {
      globalPosition: position,
      streamId: `session/${ROOT_ID}`,
      streamVersion,
      eventType,
      eventSchemaVersion: 1,
      sessionId: ROOT_ID,
      parentSessionId: null,
      commandId,
      idempotencyKey,
      lifecycleIntent: internalWorkflowWitness(command),
      payload,
    });
  };

  const validationResultIds = [resultId] as const;
  if (input.outcome === "failed") {
    const safeFailureCode = "SESSION_VALIDATION_RESULT_INVALID";
    appendPhase(6n, 5n, "validating", {
      action: "record-verification-failed",
      validationResultIds,
      safeFailureCode,
    }, "SessionEndVerificationFailed", {
      workflowId: frozen.workflowId,
      workflowGeneration: 1,
      validationResultIds,
      safeFailureCode,
    }, 30_052);
  } else {
    appendPhase(6n, 5n, "validating", {
      action: "record-verification-passed",
      validationResultIds,
      qualityScore: 100,
    }, "SessionEndVerificationPassed", {
      workflowId: frozen.workflowId,
      workflowGeneration: 1,
      validationResultIds,
      qualityScore: 100,
    }, 30_051);
  }

  if (input.outcome === "invalidated") {
    appendPhase(7n, 6n, "verification-passed", {
      action: "invalidate-verification",
      safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT",
    }, "SessionEndVerificationInvalidated", {
      workflowId: frozen.workflowId,
      workflowGeneration: 1,
      previousVerificationEventPosition: "6",
      safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT",
    }, 30_053);
  } else if (input.outcome === "ended") {
    const currentAuthority = fixture.connection.prepare(`
      SELECT * FROM session_authority
      WHERE project_id = $projectId AND session_id = $sessionId
    `).get({ $projectId: PROJECT_ID, $sessionId: ROOT_ID })!;
    const terminalAuthority: Record<string, SqliteValue> = {
      ...currentAuthority,
      semantic_state: "ended",
      authority_event_position: 7,
      terminal_event_position: 7,
      terminal_event_type: "SessionEnded",
      terminal_at: NOW,
    };
    const terminalCommitment = commitmentForRow(terminalAuthority);
    appendPhase(7n, 6n, "verification-passed", {
      action: "append-terminal-completion",
      verificationEventPosition: "6",
      materializationTarget: "memory/session-end.md",
    }, "SessionEnded", {
      workflowId: frozen.workflowId,
      workflowGeneration: 1,
      verificationEventPosition: "6",
      authorityCommitment: terminalCommitment,
    }, 30_054);
    fixture.connection.prepare(`
      UPDATE session_authority
      SET semantic_state = 'ended', authority_commitment = $commitment,
          authority_event_position = 7,
          terminal_event_position = 7,
          terminal_event_type = 'SessionEnded', terminal_at = $now,
          updated_at = $now
      WHERE project_id = $projectId AND session_id = $sessionId
    `).run({
      $commitment: terminalCommitment,
      $now: NOW,
      $projectId: PROJECT_ID,
      $sessionId: ROOT_ID,
    });
  }

  const endpointPhase = input.outcome === "passed"
    ? "verification-passed"
    : input.outcome === "ended"
      ? input.endpointPhase ?? "completion-appended"
      : "verification-failed";
  const status: Record<string, unknown> = {
    ...frozen.status,
    phase: endpointPhase,
    validationPlansReady: true,
    qualityScore:
      input.outcome === "passed" || input.outcome === "ended" ? 100 : null,
    safeFailureCode: input.outcome === "failed"
      ? "SESSION_VALIDATION_RESULT_INVALID"
      : input.outcome === "invalidated"
        ? "SESSION_SOURCE_STATE_CONFLICT"
        : null,
  };
  fixture.connection.exec("DROP TRIGGER workflow_instances_lifecycle_update_guard");
  fixture.connection.exec("DROP TRIGGER workflow_instances_evidence_v3_update_guard");
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET state = $state, phase = $phase, result_json = $result,
        validation_attempt_plan_generation = 1,
        validation_attempt_plans_json = $validationPlans,
        updated_at = $now
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $state: input.outcome === "ended" ? "completed" : "active",
    $phase: endpointPhase,
    $result: canonicalJson(status),
    $validationPlans: canonicalJson([{
      profileId: validationResult.profileId,
      profileVersion: validationResult.profileVersion,
      runId: validationResult.runId,
      resultId,
      commandId: resultCommandId,
      idempotencyKey: resultIdempotencyKey,
    }]),
    $now: NOW,
    $projectId: PROJECT_ID,
    $workflowId: frozen.workflowId,
  });
  const finalStreamVersion = input.outcome === "invalidated" || input.outcome === "ended"
    ? 6
    : 5;
  fixture.connection.prepare(`
    UPDATE streams SET current_version = $streamVersion, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $streamVersion: finalStreamVersion,
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
}

function setFrozenWorkflowEndpointPhase(
  fixture: Fixture,
  phase: "ending-materialization-queued" | "validating",
): void {
  const frozen = addFrozenCurrentChildWorkflow(fixture, {
    finalIntent: "internal-workflow",
  });
  const status = { ...frozen.status, phase };
  fixture.connection.exec("DROP TRIGGER workflow_instances_lifecycle_update_guard");
  fixture.connection.exec("DROP TRIGGER workflow_instances_evidence_v3_update_guard");
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET phase = $phase, result_json = $result, updated_at = $now
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $phase: phase,
    $result: canonicalJson(status),
    $now: NOW,
    $projectId: PROJECT_ID,
    $workflowId: frozen.workflowId,
  });
}

function forgeFrozenWorkflowPhaseWithoutWitness(
  fixture: Fixture,
  phase: "verification-passed" | "completion-appended",
): void {
  addFrozenCurrentChildWorkflow(fixture);
  const row = fixture.connection.prepare(`
    SELECT workflow_id, result_json FROM workflow_instances
    WHERE project_id = $projectId
  `).get({ $projectId: PROJECT_ID })!;
  const status = JSON.parse(String(row.result_json)) as Record<string, unknown>;
  status.phase = phase;
  status.qualityScore = phase === "verification-passed" ? 100 : null;
  fixture.connection.exec("DROP TRIGGER workflow_instances_lifecycle_update_guard");
  fixture.connection.exec("DROP TRIGGER workflow_instances_evidence_v3_update_guard");
  fixture.connection.prepare(`
    UPDATE workflow_instances
    SET phase = $phase, result_json = $result,
        state = $state, updated_at = $now
    WHERE project_id = $projectId AND workflow_id = $workflowId
  `).run({
    $phase: phase,
    $result: canonicalJson(status),
    $state: phase === "completion-appended" ? "completed" : "active",
    $now: NOW,
    $projectId: PROJECT_ID,
    $workflowId: row.workflow_id,
  });
}

async function countChildHeadInspections(
  action: () => Promise<void>,
): Promise<number> {
  const mapPrototype = Map.prototype as unknown as {
    values(this: Map<unknown, unknown>): IterableIterator<unknown>;
  };
  const originalValues = mapPrototype.values;
  let inspections = 0;
  mapPrototype.values = function values(this: Map<unknown, unknown>) {
    const iterator = originalValues.call(this);
    return {
      next() {
        const next = iterator.next();
        if (
          !next.done
          && typeof next.value === "object"
          && next.value !== null
          && "childSessionId" in next.value
          && "eventPosition" in next.value
          && "reportIndexFingerprint" in next.value
        ) inspections += 1;
        return next;
      },
      return(value?: unknown) {
        return iterator.return?.(value) ?? { done: true, value: undefined };
      },
      [Symbol.iterator]() { return this; },
    } as IterableIterator<unknown>;
  };
  try {
    await action();
    return inspections;
  } finally {
    mapPrototype.values = originalValues;
  }
}

const provider: HistoricalEvidenceIntegrityProviderPort = {
  async status() { return "available"; },
  async fingerprint(keyId, bytes) {
    return testProviderFingerprint(keyId, bytes);
  },
};

async function fullIssues(fixture: Fixture): Promise<readonly IntegrityIssueCode[]> {
  const issues: IntegrityIssueCode[] = [];
  await new LifecycleIntegrityService(fixture.connection, provider)
    .fullCheckAsync(fixture.context, { add(code) { issues.push(code); } });
  return issues;
}

type CapturedReplayVisitKind =
  | "event"
  | "coverage-transition"
  | "immutable-ordinal";

interface ReplayVisitCursor {
  readonly visits: number;
}

function captureReplayVisitCursors(
  service: LifecycleIntegrityService,
): Partial<Record<CapturedReplayVisitKind, ReplayVisitCursor>> {
  type CursorFactory = (projectId: string) => ReplayVisitCursor;
  const target = service as unknown as {
    openLifecycleEventCursor: CursorFactory;
    openQualifiedTransitionCursor: CursorFactory;
    openQualifiedOrdinalCursor: CursorFactory;
  };
  const captured: Partial<Record<CapturedReplayVisitKind, ReplayVisitCursor>> = {};
  const eventFactory = target.openLifecycleEventCursor.bind(service);
  const transitionFactory = target.openQualifiedTransitionCursor.bind(service);
  const ordinalFactory = target.openQualifiedOrdinalCursor.bind(service);
  target.openLifecycleEventCursor = (projectId) => {
    const cursor = eventFactory(projectId);
    captured.event = cursor;
    return cursor;
  };
  target.openQualifiedTransitionCursor = (projectId) => {
    const cursor = transitionFactory(projectId);
    captured["coverage-transition"] = cursor;
    return cursor;
  };
  target.openQualifiedOrdinalCursor = (projectId) => {
    const cursor = ordinalFactory(projectId);
    captured["immutable-ordinal"] = cursor;
    return cursor;
  };
  return captured;
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("full integrity advances each qualified coverage row exactly once", async () => {
  const cursorFixture = createFixture();
  const childCursor = openChildEventFoldCursor(cursorFixture.connection, PROJECT_ID);
  assert.equal(childCursor.visits, 0);
  assert.equal(childCursor.peek(), null);
  assert.equal(childCursor.visits, 0);
  assert.throws(() => childCursor.advance(), { code: "INTEGRITY_FAILURE" });
  childCursor.close();
  childCursor.close();
  const workflowCursor = openWorkflowGenerationFoldCursor(
    cursorFixture.connection,
    PROJECT_ID,
  );
  assert.equal(workflowCursor.visits, 0);
  assert.equal(workflowCursor.peek(), null);
  assert.throws(() => workflowCursor.advance(), { code: "INTEGRITY_FAILURE" });
  workflowCursor.close();
  const eventCursor = (
    new LifecycleIntegrityService(cursorFixture.connection, provider) as unknown as {
      openLifecycleEventCursor(projectId: string): {
        readonly visits: number;
        peek(): unknown | null;
        advance(): unknown;
        close(): void;
      };
    }
  ).openLifecycleEventCursor(PROJECT_ID);
  assert.equal(eventCursor.visits, 0);
  assert.notEqual(eventCursor.peek(), null);
  assert.equal(eventCursor.visits, 0);
  eventCursor.advance();
  assert.equal(eventCursor.visits, 1);
  assert.equal(eventCursor.peek(), null);
  assert.throws(() => eventCursor.advance(), { code: "INTEGRITY_FAILURE" });
  eventCursor.close();

  const directCoverage = createFixture();
  addCoverage(directCoverage);
  type DirectReplayCursor = {
    readonly visits: number;
    peek(): Readonly<Record<string, unknown>> | null;
    advance(): Readonly<Record<string, unknown>>;
    close(): void;
  };
  const directService = new LifecycleIntegrityService(
    directCoverage.connection,
    provider,
  ) as unknown as {
    openQualifiedTransitionCursor(projectId: string): DirectReplayCursor;
    openQualifiedOrdinalCursor(projectId: string): DirectReplayCursor;
  };
  for (const [label, cursor] of [
    ["coverage-transition", directService.openQualifiedTransitionCursor(PROJECT_ID)],
    ["immutable-ordinal", directService.openQualifiedOrdinalCursor(PROJECT_ID)],
  ] as const) {
    assert.equal(cursor.visits, 0, label);
    const firstPeek = cursor.peek();
    assert.notEqual(firstPeek, null, label);
    assert.equal(Object.isFrozen(firstPeek), true, label);
    assert.equal(cursor.peek(), firstPeek, label);
    assert.equal(cursor.visits, 0, label);
    assert.equal(cursor.advance(), firstPeek, label);
    assert.equal(cursor.visits, 1, label);
    assert.equal(cursor.peek(), null, label);
    assert.throws(() => cursor.advance(), { code: "INTEGRITY_FAILURE" });
    assert.equal(cursor.visits, 1, label);
    cursor.close();
    cursor.close();
  }

  const directChild = createFixture();
  addChildFork(directChild);
  const nonEmptyChildCursor = openChildEventFoldCursor(
    directChild.connection,
    PROJECT_ID,
  );
  const childPeek = nonEmptyChildCursor.peek();
  assert.notEqual(childPeek, null);
  assert.equal(Object.isFrozen(childPeek), true);
  assert.equal(nonEmptyChildCursor.visits, 0);
  assert.equal(nonEmptyChildCursor.advance(), childPeek);
  assert.equal(nonEmptyChildCursor.visits, 1);
  assert.equal(nonEmptyChildCursor.peek(), null);
  assert.throws(() => nonEmptyChildCursor.advance(), { code: "INTEGRITY_FAILURE" });
  nonEmptyChildCursor.close();
  nonEmptyChildCursor.close();

  const directWorkflow = createFixture();
  addWorkflowRequest(directWorkflow);
  const nonEmptyWorkflowCursor = openWorkflowGenerationFoldCursor(
    directWorkflow.connection,
    PROJECT_ID,
  );
  const workflowPeek = nonEmptyWorkflowCursor.peek();
  assert.notEqual(workflowPeek, null);
  assert.equal(Object.isFrozen(workflowPeek), true);
  assert.equal(nonEmptyWorkflowCursor.visits, 0);
  assert.equal(nonEmptyWorkflowCursor.advance(), workflowPeek);
  assert.equal(nonEmptyWorkflowCursor.visits, 1);
  assert.equal(nonEmptyWorkflowCursor.peek(), null);
  assert.throws(() => nonEmptyWorkflowCursor.advance(), { code: "INTEGRITY_FAILURE" });
  nonEmptyWorkflowCursor.close();
  nonEmptyWorkflowCursor.close();

  const fixture = createFixture();
  addCoverage(fixture);
  const observed = observedReplayConnection(fixture.connection, {
    trapLegacy: true,
    trapUnmarkedHistorical: true,
    trapDml: true,
  });
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
    ["pre-index", 0],
    ["endpoint", 2],
  ]);
  for (const [kind, visits] of expectedVisits) {
    assert.deepEqual(observed.counts.get(kind), {
      prepares: kind === "pre-index" ? 4 : kind === "endpoint" ? 3 : 1,
      iterates: kind === "pre-index" ? 4 : kind === "endpoint" ? 3 : 1,
      nexts: kind === "pre-index" || kind === "endpoint" ? 0 : visits + 1,
      visits,
      closes: kind === "pre-index" || kind === "endpoint" ? 0 : 1,
    }, kind);
  }

  const deep = createFixture();
  addCoverage(deep);
  addZeroNewCoverage(deep);
  const observedDeep = observedReplayConnection(deep.connection, {
    trapLegacy: true,
    trapUnmarkedHistorical: true,
    trapDml: true,
    reuseMutableRawRows: true,
  });
  assert.deepEqual(
    await new LifecycleIntegrityService(observedDeep.connection, provider)
      .fullCheckAsync(deep.context, { add() {} }),
    undefined,
  );
  for (const kind of ["pre-index", "endpoint"] as const) {
    assert.equal(
      observedDeep.counts.get(kind)?.prepares,
      observed.counts.get(kind)?.prepares,
      `${kind} prepare count must not deepen with history`,
    );
    assert.equal(
      observedDeep.counts.get(kind)?.iterates,
      observed.counts.get(kind)?.iterates,
      `${kind} query count must not deepen with history`,
    );
  }

  const legacyAfterQualified = createFixture();
  addCoverage(legacyAfterQualified);
  addLegacyCoverageAfterQualified(legacyAfterQualified);
  const legacyBefore = persistentSnapshot(legacyAfterQualified.connection);
  await assert.rejects(
    () => fullIssues(legacyAfterQualified),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "a schema-1 coverage event cannot follow qualified coverage",
  );
  assert.equal(persistentSnapshot(legacyAfterQualified.connection), legacyBefore);

  const legacyBeforeQualified = createFixture();
  addLegacyCoverageAfterQualified(legacyBeforeQualified, {
    position: 2n,
    streamVersion: 2n,
  });
  const legacyBeforeSnapshot = persistentSnapshot(legacyBeforeQualified.connection);
  await assert.rejects(
    () => fullIssues(legacyBeforeQualified),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "qualified replay rejects schema-1 coverage before any schema-2 transition",
  );
  assert.equal(
    persistentSnapshot(legacyBeforeQualified.connection),
    legacyBeforeSnapshot,
  );

  const genericWorkflow = createFixture();
  rawInsert(genericWorkflow.connection, "workflow_instances", {
    project_id: PROJECT_ID,
    workflow_id: uuid(73_200),
    workflow_type: "ordinary",
    generation: 1,
    state: "pending",
    phase: "queued",
    root_command_id: uuid(73_201),
    result_json: null,
    error_code: null,
    created_at: NOW,
    updated_at: NOW,
  });
  assert.deepEqual(
    await fullIssues(genericWorkflow),
    [],
    "schema-3 generic workflows remain outside lifecycle replay correspondence",
  );

  const genericNamedEvent = createFixture();
  rawInsert(genericNamedEvent.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: "generic/checkpoint-named-event",
    stream_type: "generic",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  rawEvent(genericNamedEvent.connection, {
    globalPosition: 2n,
    streamId: "generic/checkpoint-named-event",
    streamType: "generic",
    streamVersion: 1n,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 77,
    sessionId: null,
    parentSessionId: null,
    payload: { genericEventVersion: 1, value: "not a lifecycle checkpoint" },
  });
  assert.deepEqual(
    await fullIssues(genericNamedEvent),
    [],
    "generic event-core names remain outside scoped lifecycle replay",
  );

  const entityRich = createFixture();
  addFrozenCarryForwardWorkflow(entityRich);
  const observedEntityRich = observedReplayConnection(entityRich.connection, {
    trapLegacy: true,
    trapUnmarkedHistorical: true,
    trapDml: true,
  });
  const entityIssues: IntegrityIssueCode[] = [];
  await new LifecycleIntegrityService(observedEntityRich.connection, provider)
    .fullCheckAsync(entityRich.context, { add(code) { entityIssues.push(code); } });
  assert.deepEqual(entityIssues, []);
  assert.equal(observedEntityRich.unmarkedHistoricalPrepares(), 0);
  assert.equal(
    observedEntityRich.totalPrepares(),
    36,
    "ticket/workflow history must not add per-entity prepares",
  );
  for (const [kind, prepares] of [
    ["event", 1],
    ["child-fold", 1],
    ["workflow-fold", 1],
    ["coverage-transition", 1],
    ["immutable-ordinal", 1],
    ["pre-index", 4],
    ["endpoint", 3],
  ] as const) {
    assert.equal(observedEntityRich.counts.get(kind)?.prepares, prepares, kind);
    assert.equal(observedEntityRich.counts.get(kind)?.iterates, prepares, kind);
  }

  const additiveFixtures: readonly {
    readonly label: string;
    readonly fixture: Fixture;
  }[] = (() => {
    const baseline = createFixture();
    const adapter = createFixture();
    addCoverage(adapter);
    const reports = createFixture();
    addReportResetCompletionMatrix(reports);
    const checkpointTicketBinding = createFixture();
    addFrozenCarryForwardWorkflow(checkpointTicketBinding);
    const multiTicket = createFixture();
    addUnboundTransferHistory(multiTicket, {
      childSessionId: CHILD_ID,
      startPosition: 2n,
      checkpointId: uuid(73_300),
      ticketId: uuid(73_301),
      assignmentId: uuid(73_302),
    });
    addUnboundTransferHistory(multiTicket, {
      childSessionId: uuid(73_303),
      startPosition: 6n,
      checkpointId: uuid(73_304),
      ticketId: uuid(73_305),
      assignmentId: uuid(73_306),
    });
    const validation = createFixture();
    addDurableWorkflowOutcome(validation, { outcome: "passed" });
    const workflows = createFixture();
    addInterleavedCollapsedWorkflows(workflows);
    return [
      { label: "baseline", fixture: baseline },
      { label: "adapter", fixture: adapter },
      { label: "reports", fixture: reports },
      { label: "checkpoint-ticket-binding", fixture: checkpointTicketBinding },
      { label: "multi-ticket", fixture: multiTicket },
      { label: "validation", fixture: validation },
      { label: "workflows", fixture: workflows },
    ];
  })();
  const representedUnits = {
    sessions: 0,
    checkpoints: 0,
    tickets: 0,
    bindings: 0,
    adapters: 0,
    reports: 0,
    validations: 0,
    workflows: 0,
  };
  const scalarCount = (connection: SqliteConnection, sql: string): number => {
    const value = connection.prepare(sql).get()?.count;
    return Number(value);
  };
  for (const candidate of additiveFixtures) {
    const observed = observedReplayConnection(candidate.fixture.connection, {
      trapLegacy: true,
      trapUnmarkedHistorical: true,
      trapDml: true,
    });
    const issues: IntegrityIssueCode[] = [];
    await new LifecycleIntegrityService(observed.connection, provider)
      .fullCheckAsync(candidate.fixture.context, { add(code) { issues.push(code); } });
    assert.deepEqual(issues, [], candidate.label);
    const connection = candidate.fixture.connection;
    const expectedVisits = {
      event: scalarCount(connection, `
        SELECT count(*) AS count FROM events WHERE project_id = '${PROJECT_ID}'
      `),
      "child-fold": scalarCount(connection, `
        SELECT count(*) AS count FROM lifecycle_child_event_folds
        WHERE project_id = '${PROJECT_ID}'
      `),
      "workflow-fold": scalarCount(connection, `
        SELECT count(*) AS count FROM lifecycle_workflow_generation_folds
        WHERE project_id = '${PROJECT_ID}'
      `),
      "coverage-transition": scalarCount(connection, `
        SELECT count(*) AS count FROM session_evidence_coverage_transitions
        WHERE project_id = '${PROJECT_ID}'
      `),
      "immutable-ordinal": scalarCount(connection, `
        SELECT count(*) AS count FROM session_evidence_fingerprints
        WHERE project_id = '${PROJECT_ID}'
      `),
      "pre-index": (
        scalarCount(connection, `
          SELECT count(*) AS count FROM events
          WHERE project_id = '${PROJECT_ID}'
            AND event_type = 'SessionCheckpointRecorded'
        `)
        + scalarCount(connection, `
          SELECT count(*) AS count FROM events
          WHERE project_id = '${PROJECT_ID}'
            AND command_event_index = 0 AND lifecycle_intent_json IS NOT NULL
        `)
        + scalarCount(connection, `
          SELECT count(*) AS count FROM child_transfer_tickets
          WHERE project_id = '${PROJECT_ID}'
        `)
        + scalarCount(connection, `
          SELECT count(*) AS count FROM lifecycle_validation_results
          WHERE project_id = '${PROJECT_ID}'
        `)
      ),
      endpoint: (
        scalarCount(connection, `
          SELECT count(*) AS count FROM workflow_instances
          WHERE project_id = '${PROJECT_ID}'
        `)
        + scalarCount(connection, `
          SELECT count(*) AS count FROM session_authority
          WHERE project_id = '${PROJECT_ID}'
        `)
        + scalarCount(connection, `
          SELECT count(*) AS count FROM session_evidence_coverage
          WHERE project_id = '${PROJECT_ID}'
        `)
      ),
    } as const;
    for (const [kind, visits] of Object.entries(expectedVisits) as Array<
      [ReplayKind, number]
    >) {
      assert.equal(observed.counts.get(kind)?.visits, visits, `${candidate.label}:${kind}`);
      const fixedStatements = kind === "pre-index" ? 4 : kind === "endpoint" ? 3 : 1;
      assert.equal(
        observed.counts.get(kind)?.prepares,
        fixedStatements,
        `${candidate.label}:${kind}:prepare`,
      );
      assert.equal(
        observed.counts.get(kind)?.iterates,
        fixedStatements,
        `${candidate.label}:${kind}:iterate`,
      );
    }
    representedUnits.sessions = Math.max(
      representedUnits.sessions,
      scalarCount(connection, `SELECT count(*) AS count FROM session_authority`),
    );
    representedUnits.checkpoints = Math.max(
      representedUnits.checkpoints,
      scalarCount(connection, `
        SELECT count(*) AS count FROM events
        WHERE event_type = 'SessionCheckpointRecorded'
      `),
    );
    representedUnits.tickets = Math.max(
      representedUnits.tickets,
      scalarCount(connection, `SELECT count(*) AS count FROM child_transfer_tickets`),
    );
    representedUnits.adapters = Math.max(
      representedUnits.adapters,
      scalarCount(connection, `SELECT count(*) AS count FROM session_evidence_coverage`),
    );
    representedUnits.reports = Math.max(
      representedUnits.reports,
      scalarCount(connection, `
        SELECT count(*) AS count FROM events WHERE event_type = 'ChildWorkReported'
      `),
    );
    representedUnits.validations = Math.max(
      representedUnits.validations,
      scalarCount(connection, `SELECT count(*) AS count FROM lifecycle_validation_results`),
    );
    representedUnits.workflows = Math.max(
      representedUnits.workflows,
      scalarCount(connection, `SELECT count(*) AS count FROM workflow_instances`),
    );
    const bindingRows = connection.prepare(`
      SELECT final_ending_scope_bindings_json AS bindings
      FROM workflow_instances WHERE final_ending_scope_bindings_json IS NOT NULL
    `).all();
    representedUnits.bindings = Math.max(
      representedUnits.bindings,
      bindingRows.reduce((total, row) => (
        total + (JSON.parse(String(row.bindings)) as unknown[]).length
      ), 0),
    );
  }
  assert.ok(representedUnits.sessions > 1);
  for (const [unit, count] of Object.entries(representedUnits)) {
    assert.ok(count > 0, `${unit} must be represented by the additive corpus`);
  }
});

it("full integrity fingerprints each non-zero transition exactly once", async () => {
  const fixture = createFixture();
  addCoverage(fixture);
  addZeroNewCoverage(fixture);
  const statusCalls: string[] = [];
  const fingerprintKeys: string[] = [];
  const fingerprintBytes: Uint8Array[] = [];
  const providerBuffers: Uint8Array[] = [];
  const recordingProvider: HistoricalEvidenceIntegrityProviderPort = {
    async status(keyId) {
      statusCalls.push(keyId);
      return "available";
    },
    async fingerprint(keyId, bytes) {
      fingerprintKeys.push(keyId);
      providerBuffers.push(bytes);
      fingerprintBytes.push(Uint8Array.from(bytes));
      return testProviderFingerprint(keyId, bytes);
    },
  };
  const issues: IntegrityIssueCode[] = [];
  await new LifecycleIntegrityService(fixture.connection, recordingProvider)
    .fullCheckAsync(fixture.context, { add(code) { issues.push(code); } });
  assert.deepEqual(issues, []);
  assert.deepEqual(statusCalls, ["key-a"]);
  assert.deepEqual(fingerprintKeys, ["key-a"]);
  assert.equal(fingerprintBytes.length, 1);
  assert.deepEqual(fingerprintBytes[0], Uint8Array.from(FIRST_ACCUMULATOR_BYTES));
  assert.equal(
    providerBuffers[0]?.every((byte) => byte === 0),
    true,
    "production-owned provider buffer must be scrubbed after await",
  );

  const historical = createFixture();
  const matrixFrames = Array.from({ length: 8 }, (_unused, ordinal) => ({
    frameId: uuid(72_000 + ordinal),
    ordinal: BigInt(ordinal),
    sourceKind: ([
      "model-turn",
      "tool-request",
      "tool-result",
      "adapter-event",
      "external-observation",
    ] as const)[ordinal % 5]!,
    observedAt: NOW,
    contentFingerprint: ordinal % 2 === 0 ? H64 : H64_B,
  }));
  const firstAboveZero = addQualifiedCoverageBatch(historical, {
    position: 2n,
    streamVersion: 2n,
    batchId: uuid(72_100),
    frames: [matrixFrames[5]!],
    expected: {
      coverageLastOrdinal: "5",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
      newOrdinals: [5n],
    },
  });
  assert.equal(firstAboveZero.highestContiguousOrdinal, null);
  assert.deepEqual(firstAboveZero.missingIntervals, [{
    firstOrdinal: "0",
    lastOrdinal: "4",
  }]);
  const gapFill = addQualifiedCoverageBatch(historical, {
    position: 3n,
    streamVersion: 3n,
    batchId: uuid(72_101),
    frames: matrixFrames.slice(0, 3),
    expected: {
      coverageLastOrdinal: "5",
      highestContiguousOrdinal: "2",
      missingIntervals: [{ firstOrdinal: "3", lastOrdinal: "4" }],
      newOrdinals: [0n, 1n, 2n],
    },
  });
  assert.equal(gapFill.highestContiguousOrdinal, "2");
  assert.deepEqual(gapFill.missingIntervals, [{
    firstOrdinal: "3",
    lastOrdinal: "4",
  }]);
  const mixedOverlap = addQualifiedCoverageBatch(historical, {
    position: 4n,
    streamVersion: 4n,
    batchId: uuid(72_102),
    frames: matrixFrames.slice(2, 7),
    expected: {
      coverageLastOrdinal: "6",
      highestContiguousOrdinal: "6",
      missingIntervals: [],
      newOrdinals: [3n, 4n, 6n],
    },
  });
  assert.equal(mixedOverlap.newFrameCount, 3);
  assert.equal(mixedOverlap.highestContiguousOrdinal, "6");
  assert.deepEqual(mixedOverlap.missingIntervals, []);
  const deepOverlap = addQualifiedCoverageBatch(historical, {
    position: 5n,
    streamVersion: 5n,
    batchId: uuid(72_103),
    frames: matrixFrames,
    expected: {
      coverageLastOrdinal: "7",
      highestContiguousOrdinal: "7",
      missingIntervals: [],
      newOrdinals: [7n],
    },
  });
  assert.equal(deepOverlap.newFrameCount, 1);
  assert.equal(deepOverlap.highestContiguousOrdinal, "7");
  const historicalStatusCalls: string[] = [];
  const historicalFingerprintKeys: string[] = [];
  const historicalProviderBuffers: Uint8Array[] = [];
  const historicalIssues: IntegrityIssueCode[] = [];
  await new LifecycleIntegrityService(historical.connection, {
    async status(keyId) {
      historicalStatusCalls.push(keyId);
      return "available";
    },
    async fingerprint(keyId, bytes) {
      historicalFingerprintKeys.push(keyId);
      historicalProviderBuffers.push(bytes);
      return testProviderFingerprint(keyId, bytes);
    },
  }).fullCheckAsync(historical.context, {
    add(code) { historicalIssues.push(code); },
  });
  assert.deepEqual(historicalIssues, []);
  assert.deepEqual(historicalStatusCalls, ["key-a"]);
  assert.deepEqual(historicalFingerprintKeys, ["key-a", "key-a", "key-a", "key-a"]);
  assert.equal(
    historicalProviderBuffers.every((bytes) => bytes.every((byte) => byte === 0)),
    true,
  );

  const rotatedProfile = createFixture();
  addCoverage(rotatedProfile);
  addRotatedCoverage(rotatedProfile);
  const rotatedBefore = persistentSnapshot(rotatedProfile.connection);
  const rotatedStatusKeys: string[] = [];
  const rotatedFingerprintKeys: string[] = [];
  await assert.rejects(
    () => new LifecycleIntegrityService(rotatedProfile.connection, {
      async status(keyId) {
        rotatedStatusKeys.push(keyId);
        return "available";
      },
      async fingerprint(keyId, bytes) {
        rotatedFingerprintKeys.push(keyId);
        return testProviderFingerprint(keyId, bytes);
      },
    }).fullCheckAsync(rotatedProfile.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "one adapter cannot rotate its immutable fingerprint profile",
  );
  assert.deepEqual(
    rotatedStatusKeys,
    ["key-a"],
    "profile rotation must fail before consulting the replacement key",
  );
  assert.deepEqual(
    rotatedFingerprintKeys,
    ["key-a"],
    "profile rotation must fail before fingerprinting with the replacement key",
  );
  assert.equal(persistentSnapshot(rotatedProfile.connection), rotatedBefore);

  const intervalPeak = createFixture();
  let intervalPosition = 2n;
  for (let index = 0; index < 100; index += 1) {
    const adapterSessionId = uuid(74_000 + index);
    addQualifiedCoverageBatch(intervalPeak, {
      position: intervalPosition,
      streamVersion: intervalPosition,
      batchId: uuid(74_200 + (index * 2)),
      adapterSessionId,
      frames: [{
        frameId: uuid(74_500 + (index * 2)),
        ordinal: 4n,
        sourceKind: "adapter-event",
        observedAt: NOW,
        contentFingerprint: H64,
      }],
      expected: {
        coverageLastOrdinal: "4",
        highestContiguousOrdinal: null,
        missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "3" }],
        newOrdinals: [4n],
      },
    });
    intervalPosition += 1n;
    addQualifiedCoverageBatch(intervalPeak, {
      position: intervalPosition,
      streamVersion: intervalPosition,
      batchId: uuid(74_201 + (index * 2)),
      adapterSessionId,
      frames: [{
        frameId: uuid(74_501 + (index * 2)),
        ordinal: 2n,
        sourceKind: "adapter-event",
        observedAt: NOW,
        contentFingerprint: H64_B,
      }],
      expected: {
        coverageLastOrdinal: "4",
        highestContiguousOrdinal: null,
        missingIntervals: [
          { firstOrdinal: "0", lastOrdinal: "1" },
          { firstOrdinal: "3", lastOrdinal: "3" },
        ],
        newOrdinals: [2n],
      },
    });
    intervalPosition += 1n;
  }
  intervalPeak.connection.exec(
    "DROP TRIGGER session_evidence_coverage_v3_insert_guard",
  );
  const shrinkingAdapter = uuid(74_100);
  addQualifiedCoverageBatch(intervalPeak, {
    position: intervalPosition,
    streamVersion: intervalPosition,
    batchId: uuid(74_800),
    adapterSessionId: shrinkingAdapter,
    frames: [{
      frameId: uuid(74_801),
      ordinal: 1n,
      sourceKind: "adapter-event",
      observedAt: NOW,
      contentFingerprint: H64,
    }],
    expected: {
      coverageLastOrdinal: "1",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "0" }],
      newOrdinals: [1n],
    },
  });
  intervalPosition += 1n;
  addQualifiedCoverageBatch(intervalPeak, {
    position: intervalPosition,
    streamVersion: intervalPosition,
    batchId: uuid(74_802),
    adapterSessionId: shrinkingAdapter,
    frames: [{
      frameId: uuid(74_803),
      ordinal: 0n,
      sourceKind: "adapter-event",
      observedAt: NOW,
      contentFingerprint: H64_B,
    }],
    expected: {
      coverageLastOrdinal: "1",
      highestContiguousOrdinal: "1",
      missingIntervals: [],
      newOrdinals: [0n],
    },
  });
  assert.equal(
    intervalPeak.connection.prepare(`
      SELECT sum(json_array_length(missing_intervals_json)) AS interval_count
      FROM session_evidence_coverage
      WHERE project_id = $projectId AND session_id = $sessionId
    `).get({ $projectId: PROJECT_ID, $sessionId: ROOT_ID })?.interval_count,
    200n,
    "the current endpoint is back within the session interval bound",
  );
  const intervalFingerprintKeys: string[] = [];
  await assert.rejects(
    () => new LifecycleIntegrityService(intervalPeak.connection, {
      async status() { return "available"; },
      async fingerprint(keyId, bytes) {
        intervalFingerprintKeys.push(keyId);
        return testProviderFingerprint(keyId, bytes);
      },
    }).fullCheckAsync(intervalPeak.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "a historical session-wide interval overflow cannot be hidden by later gap fill",
  );
  assert.deepEqual(
    intervalFingerprintKeys,
    Array.from({ length: 200 }, () => "key-a"),
    "the overflowing transition must fail before provider fingerprint work",
  );

  const adapterPeak = createFixture();
  adapterPeak.connection.exec(
    "DROP TRIGGER session_evidence_coverage_v3_insert_guard",
  );
  const adapterPeakIds: string[] = [];
  for (let index = 0; index < 201; index += 1) {
    const adapterSessionId = uuid(75_000 + index);
    adapterPeakIds.push(adapterSessionId);
    addQualifiedCoverageBatch(adapterPeak, {
      position: BigInt(index + 2),
      streamVersion: BigInt(index + 2),
      batchId: uuid(75_300 + index),
      adapterSessionId,
      frames: [{
        frameId: uuid(75_600 + index),
        ordinal: 0n,
        sourceKind: "external-observation",
        observedAt: NOW,
        contentFingerprint: index % 2 === 0 ? H64 : H64_B,
      }],
      expected: {
        coverageLastOrdinal: "0",
        highestContiguousOrdinal: "0",
        missingIntervals: [],
        newOrdinals: [0n],
      },
    });
  }
  adapterPeak.connection.exec("PRAGMA foreign_keys = OFF");
  adapterPeak.connection.exec("DROP TRIGGER session_evidence_coverage_no_delete");
  const deleteCoverageHead = adapterPeak.connection.prepare(`
    DELETE FROM session_evidence_coverage_transition_heads
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND adapter_session_id = $adapterSessionId
  `);
  deleteCoverageHead.run({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
    $adapterSessionId: adapterPeakIds.at(-1)!,
  });
  adapterPeak.connection.prepare(`
    DELETE FROM session_evidence_coverage
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND adapter_session_id = $adapterSessionId
  `).run({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
    $adapterSessionId: adapterPeakIds.at(-1)!,
  });
  adapterPeak.connection.exec("PRAGMA foreign_keys = ON");
  deleteCoverageHead.run({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
    $adapterSessionId: adapterPeakIds[0]!,
  });
  assert.equal(
    adapterPeak.connection.prepare(`
      SELECT count(*) AS adapter_count
      FROM session_evidence_coverage
      WHERE project_id = $projectId AND session_id = $sessionId
    `).get({ $projectId: PROJECT_ID, $sessionId: ROOT_ID })?.adapter_count,
    200n,
    "the forged current endpoint is back within the lifetime adapter bound",
  );
  const adapterPeakFingerprintKeys: string[] = [];
  await assert.rejects(
    () => new LifecycleIntegrityService(adapterPeak.connection, {
      async status() { return "available"; },
      async fingerprint(keyId, bytes) {
        adapterPeakFingerprintKeys.push(keyId);
        return testProviderFingerprint(keyId, bytes);
      },
    }).fullCheckAsync(adapterPeak.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "a historical 201st adapter cannot be hidden by a smaller current endpoint",
  );
  assert.equal(
    adapterPeakFingerprintKeys.length,
    200,
    "the 201st adapter must fail before provider fingerprint work",
  );

  const bytePeak = createFixture();
  const maximumKey = "\u{1F600}".repeat(128);
  const byteEntries: Array<Record<string, unknown>> = [];
  const bytePeakAdapterIds: string[] = [];
  let bytePeakSnapshotBytes = 0;
  for (let index = 0; bytePeakSnapshotBytes <= 196_608; index += 1) {
    assert.ok(index < 200, "the canonical-byte cap must be reachable below 200 adapters");
    const adapterSessionId = uuid(76_000 + index);
    const batchId = uuid(76_300 + index);
    bytePeakAdapterIds.push(adapterSessionId);
    const recorded = addQualifiedCoverageBatch(bytePeak, {
      position: BigInt(index + 2),
      streamVersion: BigInt(index + 2),
      batchId,
      adapterSessionId,
      keyId: maximumKey,
      frames: [{
        frameId: uuid(76_600 + index),
        ordinal: 0n,
        sourceKind: "tool-result",
        observedAt: NOW,
        contentFingerprint: index % 2 === 0 ? H64 : H64_B,
      }],
      expected: {
        coverageLastOrdinal: "0",
        highestContiguousOrdinal: "0",
        missingIntervals: [],
        newOrdinals: [0n],
      },
    });
    byteEntries.push({
      adapterSessionId,
      coverageFirstOrdinal: "0",
      coverageLastOrdinal: "0",
      highestContiguousOrdinal: "0",
      missingIntervals: [],
      frameFingerprintAlgorithm: "hmac-sha256",
      frameFingerprintSchemaVersion: 1,
      frameFingerprintKeyId: maximumKey,
      frameFingerprintDomain: "pm-evidence-frame-v1",
      coverageFingerprintAlgorithm: "hmac-sha256",
      coverageFingerprintSchemaVersion: 1,
      coverageFingerprintKeyId: maximumKey,
      coverageFingerprintDomain: "pm-evidence-coverage-v1",
      coverageFingerprint: recorded.coverageFingerprint,
      latestBatchId: batchId,
      latestBatchEventPosition: String(index + 2),
    });
    bytePeakSnapshotBytes = Buffer.byteLength(canonicalJson({
      coverageVersion: 2,
      captureMode: "coverage-only",
      contentRetained: false,
      adapterSessions: [...byteEntries].sort((left, right) => Buffer.compare(
        Buffer.from(String(left.adapterSessionId), "utf8"),
        Buffer.from(String(right.adapterSessionId), "utf8"),
      )),
    }), "utf8");
  }
  const bytePeakCount = byteEntries.length;
  assert.ok(bytePeakSnapshotBytes > 196_608);
  const priorByteSnapshot = {
    coverageVersion: 2,
    captureMode: "coverage-only",
    contentRetained: false,
    adapterSessions: byteEntries.slice(0, -1).sort((left, right) => Buffer.compare(
      Buffer.from(String(left.adapterSessionId), "utf8"),
      Buffer.from(String(right.adapterSessionId), "utf8"),
    )),
  };
  assert.ok(Buffer.byteLength(canonicalJson(priorByteSnapshot), "utf8") <= 196_608);
  bytePeak.connection.exec("PRAGMA foreign_keys = OFF");
  bytePeak.connection.exec("DROP TRIGGER session_evidence_coverage_no_delete");
  const deleteByteHead = bytePeak.connection.prepare(`
    DELETE FROM session_evidence_coverage_transition_heads
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND adapter_session_id = $adapterSessionId
  `);
  deleteByteHead.run({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
    $adapterSessionId: bytePeakAdapterIds.at(-1)!,
  });
  bytePeak.connection.prepare(`
    DELETE FROM session_evidence_coverage
    WHERE project_id = $projectId
      AND session_id = $sessionId
      AND adapter_session_id = $adapterSessionId
  `).run({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
    $adapterSessionId: bytePeakAdapterIds.at(-1)!,
  });
  bytePeak.connection.exec("PRAGMA foreign_keys = ON");
  deleteByteHead.run({
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
    $adapterSessionId: bytePeakAdapterIds[0]!,
  });
  const bytePeakFingerprintKeys: string[] = [];
  await assert.rejects(
    () => new LifecycleIntegrityService(bytePeak.connection, {
      async status() { return "available"; },
      async fingerprint(keyId, bytes) {
        bytePeakFingerprintKeys.push(keyId);
        return testProviderFingerprint(keyId, bytes);
      },
    }).fullCheckAsync(bytePeak.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "a historical oversized canonical snapshot cannot be hidden by endpoint removal",
  );
  assert.equal(
    bytePeakFingerprintKeys.length,
    bytePeakCount - 1,
    "the oversized candidate snapshot must fail before provider fingerprint work",
  );

  const maximum = 9_223_372_036_854_775_807n;
  const nearMaximum = createFixture();
  const maximumFrame: QualifiedCoverageTestFrame = {
    frameId: uuid(72_200),
    ordinal: maximum,
    sourceKind: "external-observation",
    observedAt: NOW,
    contentFingerprint: H64_B,
  };
  const maximumFirst = addQualifiedCoverageBatch(nearMaximum, {
    position: 2n,
    streamVersion: 2n,
    batchId: uuid(72_201),
    frames: [maximumFrame],
    expected: {
      coverageLastOrdinal: maximum.toString(),
      highestContiguousOrdinal: null,
      missingIntervals: [{
        firstOrdinal: "0",
        lastOrdinal: (maximum - 1n).toString(),
      }],
      newOrdinals: [maximum],
    },
  });
  assert.equal(maximumFirst.highestContiguousOrdinal, null);
  assert.deepEqual(maximumFirst.missingIntervals, [{
    firstOrdinal: "0",
    lastOrdinal: (maximum - 1n).toString(),
  }]);
  const maximumFill = addQualifiedCoverageBatch(nearMaximum, {
    position: 3n,
    streamVersion: 3n,
    batchId: uuid(72_202),
    frames: [{
      frameId: uuid(72_203),
      ordinal: 0n,
      sourceKind: "model-turn",
      observedAt: NOW,
      contentFingerprint: H64,
    }],
    expected: {
      coverageLastOrdinal: maximum.toString(),
      highestContiguousOrdinal: "0",
      missingIntervals: [{
        firstOrdinal: "1",
        lastOrdinal: (maximum - 1n).toString(),
      }],
      newOrdinals: [0n],
    },
  });
  assert.equal(maximumFill.highestContiguousOrdinal, "0");
  assert.deepEqual(maximumFill.missingIntervals, [{
    firstOrdinal: "1",
    lastOrdinal: (maximum - 1n).toString(),
  }]);
  assert.deepEqual(await fullIssues(nearMaximum), []);

  const migrated = createSchema2Fixture();
  addChildFork(migrated, { projection: false });
  const migratedVersions = new MigrationRunner().apply(
    migrated.connection,
    PROJECT_STORE_MIGRATIONS,
    NOW,
    {
      kind: "explicit-upgrade",
      expectedAppliedVersion: 2,
      beforeMigration(connection, migration) {
        if (migration.version === 3) {
          new SqliteQualifiedCheckpointMigrationPreflight()
            .assertEligibleAndStage(connection, migrated.context);
        }
      },
    },
  );
  assert.deepEqual(migratedVersions, [3]);
  assert.equal(
    migrated.connection.prepare(`
      SELECT schema_version FROM project_meta WHERE singleton = 1
    `).get()?.schema_version,
    3n,
  );
  const liveEquivalent = createFixture();
  addChildFork(liveEquivalent);
  const drainChildRows = (fixture: Fixture) => {
    const cursor = openChildEventFoldCursor(fixture.connection, PROJECT_ID);
    const rows = [];
    try {
      while (cursor.peek() !== null) rows.push(cursor.advance());
    } finally {
      cursor.close();
    }
    return rows;
  };
  assert.deepEqual(
    drainChildRows(migrated),
    drainChildRows(liveEquivalent),
    "migration backfill and the live writer must produce the same complete child fold",
  );
  addCoverage(migrated, { position: 3n, streamVersion: 2n });
  addCoverage(liveEquivalent, { position: 3n, streamVersion: 2n });
  const replayTrace = async (fixture: Fixture) => {
    const statusKeys: string[] = [];
    const fingerprintKeys: string[] = [];
    const fingerprintBytes: string[] = [];
    const providerBuffers: Uint8Array[] = [];
    const issues: IntegrityIssueCode[] = [];
    await new LifecycleIntegrityService(fixture.connection, {
      async status(keyId) {
        statusKeys.push(keyId);
        return "available";
      },
      async fingerprint(keyId, bytes) {
        fingerprintKeys.push(keyId);
        fingerprintBytes.push(Buffer.from(bytes).toString("hex"));
        providerBuffers.push(bytes);
        return testProviderFingerprint(keyId, bytes);
      },
    }).fullCheckAsync(fixture.context, { add(code) { issues.push(code); } });
    return {
      issues,
      statusKeys,
      fingerprintKeys,
      fingerprintBytes,
      scrubbed: providerBuffers.map((bytes) => bytes.every((byte) => byte === 0)),
    };
  };
  const migratedTrace = await replayTrace(migrated);
  const liveTrace = await replayTrace(liveEquivalent);
  assert.deepEqual(migratedTrace, liveTrace);
  assert.deepEqual(migratedTrace, {
    issues: [],
    statusKeys: ["key-a"],
    fingerprintKeys: ["key-a"],
    fingerprintBytes: [Buffer.from(FIRST_ACCUMULATOR_BYTES).toString("hex")],
    scrubbed: [true],
  });

  const mutationFrame: QualifiedCoverageTestFrame = {
    frameId: uuid(72_300),
    ordinal: 5n,
    sourceKind: "tool-result",
    observedAt: NOW,
    contentFingerprint: H64_B,
  };
  const createMutationHistory = (): Fixture => {
    const changed = createFixture();
    addQualifiedCoverageBatch(changed, {
      position: 2n,
      streamVersion: 2n,
      batchId: uuid(72_301),
      frames: [mutationFrame],
      expected: {
        coverageLastOrdinal: "5",
        highestContiguousOrdinal: null,
        missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
        newOrdinals: [5n],
      },
    });
    addQualifiedCoverageBatch(changed, {
      position: 3n,
      streamVersion: 3n,
      batchId: uuid(72_302),
      frames: [mutationFrame],
      expected: {
        coverageLastOrdinal: "5",
        highestContiguousOrdinal: null,
        missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
        newOrdinals: [],
      },
    });
    return changed;
  };
  const mutateHistoricalEvent = (
    changed: Fixture,
    mutate: (payload: Record<string, unknown>) => void,
  ): void => {
    changed.connection.exec("DROP TRIGGER events_no_update");
    const row = changed.connection.prepare(`
      SELECT payload_json FROM events WHERE global_position = 2
    `).get()!;
    const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    mutate(payload);
    changed.connection.prepare(`
      UPDATE events SET payload_json = $payload, payload_hash = $payloadHash
      WHERE global_position = 2
    `).run({
      $payload: canonicalJson(payload),
      $payloadHash: payloadHash(payload),
    });
  };
  const authenticatedMutations: readonly {
    readonly label: string;
    readonly mutate: (changed: Fixture) => void;
  }[] = [
    {
      label: "transition identity",
      mutate(changed) {
        changed.connection.exec(
          "DROP TRIGGER session_evidence_coverage_transitions_no_update",
        );
        changed.connection.prepare(`
          UPDATE session_evidence_coverage_transitions SET batch_id = $batchId
          WHERE batch_event_position = 2
        `).run({ $batchId: uuid(72_399) });
      },
    },
    {
      label: "previous digest",
      mutate(changed) {
        changed.connection.exec(
          "DROP TRIGGER session_evidence_coverage_transitions_no_update",
        );
        changed.connection.prepare(`
          UPDATE session_evidence_coverage_transitions
          SET previous_coverage_fingerprint_value = $digest
          WHERE batch_event_position = 2
        `).run({ $digest: H64_B });
      },
    },
    {
      label: "fingerprint profiles",
      mutate(changed) {
        mutateHistoricalEvent(changed, (payload) => {
          payload.frameFingerprintKeyId = "key-b";
          payload.coverageFingerprintKeyId = "key-b";
        });
      },
    },
    {
      label: "fingerprint domains",
      mutate(changed) {
        mutateHistoricalEvent(changed, (payload) => {
          payload.frameFingerprintDomain = "pm-evidence-coverage-v1";
          payload.coverageFingerprintDomain = "pm-evidence-frame-v1";
        });
      },
    },
    {
      label: "interval tuple",
      mutate(changed) {
        mutateHistoricalEvent(changed, (payload) => {
          payload.missingIntervals = [{ firstOrdinal: "0", lastOrdinal: "3" }];
        });
      },
    },
    {
      label: "new frame count",
      mutate(changed) {
        changed.connection.exec(
          "DROP TRIGGER session_evidence_coverage_transitions_no_update",
        );
        changed.connection.prepare(`
          UPDATE session_evidence_coverage_transitions SET new_frame_count = 0
          WHERE batch_event_position = 2
        `).run();
      },
    },
    {
      label: "ordinal event order",
      mutate(changed) {
        changed.connection.exec("DROP TRIGGER session_evidence_fingerprints_no_update");
        changed.connection.prepare(`
          UPDATE session_evidence_fingerprints SET recorded_event_position = 3
          WHERE recorded_event_position = 2
        `).run();
      },
    },
    {
      label: "transition timestamp",
      mutate(changed) {
        changed.connection.exec(
          "DROP TRIGGER session_evidence_coverage_transitions_no_update",
        );
        changed.connection.prepare(`
          UPDATE session_evidence_coverage_transitions
          SET created_at = '2026-07-31T00:00:01.000Z'
          WHERE batch_event_position = 2
        `).run();
      },
    },
    {
      label: "out-of-range interval storage",
      mutate(changed) {
        changed.connection.exec(
          "DROP TRIGGER session_evidence_coverage_transitions_no_update",
        );
        changed.connection.prepare(`
          UPDATE session_evidence_coverage_transitions
          SET missing_intervals_json = '[[0,9223372036854775808]]'
          WHERE batch_event_position = 2
        `).run();
      },
    },
  ];
  const nonCanonicalStorage = createMutationHistory();
  nonCanonicalStorage.connection.exec(
    "DROP TRIGGER session_evidence_coverage_transitions_no_update",
  );
  assert.throws(
    () => nonCanonicalStorage.connection.prepare(`
      UPDATE session_evidence_coverage_transitions
      SET missing_intervals_json = '[[0, 4]]'
      WHERE batch_event_position = 2
    `).run(),
    /constraint failed/iu,
    "storage rejects non-canonical interval JSON before replay",
  );
  for (const mutation of authenticatedMutations) {
    const changed = createMutationHistory();
    mutation.mutate(changed);
    const before = persistentSnapshot(changed.connection);
    const observed = observedReplayConnection(changed.connection, { trapDml: true });
    await assert.rejects(
      () => new LifecycleIntegrityService(observed.connection, provider)
        .fullCheckAsync(changed.context, { add() {} }),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
      mutation.label,
    );
    assert.equal(persistentSnapshot(changed.connection), before, mutation.label);
  }

  const authenticatedByteMutations: readonly {
    readonly label: string;
    readonly expectedAdapterSessionId: string;
    readonly expectedKeyId: string;
    readonly expectedFrame: Readonly<Record<string, unknown>>;
    readonly mutate: (changed: Fixture) => void;
  }[] = [
    {
      label: "adapter identity bytes",
      expectedAdapterSessionId: uuid(72_401),
      expectedKeyId: "key-a",
      expectedFrame: FIRST_FRAME,
      mutate(changed) {
        const adapterSessionId = uuid(72_401);
        mutateHistoricalEvent(changed, (payload) => {
          payload.adapterSessionId = adapterSessionId;
        });
        changed.connection.exec(`
          DROP TRIGGER session_evidence_coverage_transitions_no_update;
          DROP TRIGGER session_evidence_fingerprints_no_update;
          DROP TRIGGER session_evidence_coverage_update_guard;
          DROP TRIGGER session_evidence_coverage_v3_update_guard;
          PRAGMA foreign_keys = OFF;
        `);
        for (const table of [
          "session_evidence_coverage_transitions",
          "session_evidence_fingerprints",
          "session_evidence_coverage",
          "session_evidence_coverage_transition_heads",
        ]) {
          changed.connection.prepare(`
            UPDATE ${table} SET adapter_session_id = $adapterSessionId
            WHERE project_id = $projectId
          `).run({
            $adapterSessionId: adapterSessionId,
            $projectId: PROJECT_ID,
          });
        }
        changed.connection.exec("PRAGMA foreign_keys = ON");
        assert.deepEqual(changed.connection.prepare("PRAGMA foreign_key_check").all(), []);
      },
    },
    {
      label: "recorded profile bytes",
      expectedAdapterSessionId: ADAPTER_ID,
      expectedKeyId: "key-auth-mutated",
      expectedFrame: FIRST_FRAME,
      mutate(changed) {
        const keyId = "key-auth-mutated";
        mutateHistoricalEvent(changed, (payload) => {
          payload.frameFingerprintKeyId = keyId;
          payload.coverageFingerprintKeyId = keyId;
        });
        changed.connection.exec(`
          DROP TRIGGER session_evidence_coverage_transitions_no_update;
          DROP TRIGGER session_evidence_fingerprints_no_update;
          DROP TRIGGER session_evidence_coverage_update_guard;
          DROP TRIGGER session_evidence_coverage_v3_update_guard;
        `);
        changed.connection.prepare(`
          UPDATE session_evidence_coverage_transitions
          SET frame_fingerprint_key_id = $keyId,
              coverage_fingerprint_key_id = $keyId
          WHERE project_id = $projectId
        `).run({ $keyId: keyId, $projectId: PROJECT_ID });
        changed.connection.prepare(`
          UPDATE session_evidence_fingerprints SET fingerprint_key_id = $keyId
          WHERE project_id = $projectId
        `).run({ $keyId: keyId, $projectId: PROJECT_ID });
        changed.connection.prepare(`
          UPDATE session_evidence_coverage
          SET fingerprint_key_id = $keyId,
              coverage_fingerprint_key_id = $keyId
          WHERE project_id = $projectId
        `).run({ $keyId: keyId, $projectId: PROJECT_ID });
      },
    },
    {
      label: "observed timestamp bytes",
      expectedAdapterSessionId: ADAPTER_ID,
      expectedKeyId: "key-a",
      expectedFrame: {
        ...FIRST_FRAME,
        observedAt: "2026-07-31T00:00:01.000Z",
      },
      mutate(changed) {
        const observedAt = "2026-07-31T00:00:01.000Z";
        mutateHistoricalEvent(changed, (payload) => {
          const frames = payload.frames as Array<Record<string, unknown>>;
          frames[0]!.observedAt = observedAt;
        });
        changed.connection.exec("DROP TRIGGER session_evidence_fingerprints_no_update");
        changed.connection.prepare(`
          UPDATE session_evidence_fingerprints SET observed_at = $observedAt
          WHERE project_id = $projectId
        `).run({ $observedAt: observedAt, $projectId: PROJECT_ID });
      },
    },
    {
      label: "content fingerprint bytes",
      expectedAdapterSessionId: ADAPTER_ID,
      expectedKeyId: "key-a",
      expectedFrame: {
        ...FIRST_FRAME,
        contentFingerprint: H64,
      },
      mutate(changed) {
        mutateHistoricalEvent(changed, (payload) => {
          const frames = payload.frames as Array<Record<string, unknown>>;
          frames[0]!.contentFingerprint = H64;
        });
        changed.connection.exec("DROP TRIGGER session_evidence_fingerprints_no_update");
        changed.connection.prepare(`
          UPDATE session_evidence_fingerprints SET fingerprint_value = $fingerprint
          WHERE project_id = $projectId
        `).run({ $fingerprint: H64, $projectId: PROJECT_ID });
      },
    },
  ];
  for (const mutation of authenticatedByteMutations) {
    const changed = createFixture();
    addCoverage(changed);
    mutation.mutate(changed);
    const before = persistentSnapshot(changed.connection);
    const statusKeys: string[] = [];
    const fingerprintKeys: string[] = [];
    const copiedBytes: string[] = [];
    const providerBuffers: Uint8Array[] = [];
    const issues: IntegrityIssueCode[] = [];
    const observed = observedReplayConnection(changed.connection, { trapDml: true });
    await new LifecycleIntegrityService(observed.connection, {
      async status(keyId) {
        statusKeys.push(keyId);
        return "available";
      },
      async fingerprint(keyId, bytes) {
        fingerprintKeys.push(keyId);
        copiedBytes.push(Buffer.from(bytes).toString("hex"));
        providerBuffers.push(bytes);
        return testProviderFingerprint(keyId, bytes);
      },
    }).fullCheckAsync(changed.context, { add(code) { issues.push(code); } });
    const expectedBytes = Buffer.from(canonicalJson(expectedCoverageAccumulator({
      adapterSessionId: mutation.expectedAdapterSessionId,
      keyId: mutation.expectedKeyId,
      previousCoverageFingerprint: null,
      coverageLastOrdinal: "0",
      highestContiguousOrdinal: "0",
      missingIntervals: [],
      newFrames: [mutation.expectedFrame],
    })), "utf8").toString("hex");
    assert.deepEqual(issues, ["SESSION_EVIDENCE_COVERAGE_MISMATCH"], mutation.label);
    assert.deepEqual(statusKeys, [mutation.expectedKeyId], mutation.label);
    assert.deepEqual(fingerprintKeys, [mutation.expectedKeyId], mutation.label);
    assert.deepEqual(copiedBytes, [expectedBytes], mutation.label);
    assert.equal(
      providerBuffers[0]?.every((byte) => byte === 0),
      true,
      mutation.label,
    );
    assert.equal(persistentSnapshot(changed.connection), before, mutation.label);
  }

  const assertSingleAuthenticatedMismatch = async (
    changed: Fixture,
    label: string,
    expectedKeyId: string,
    expectedBytes: Uint8Array,
  ): Promise<void> => {
    const before = persistentSnapshot(changed.connection);
    const statuses: string[] = [];
    const keys: string[] = [];
    const bytes: string[] = [];
    const buffers: Uint8Array[] = [];
    const issues: IntegrityIssueCode[] = [];
    const observed = observedReplayConnection(changed.connection, { trapDml: true });
    await new LifecycleIntegrityService(observed.connection, {
      async status(keyId) {
        statuses.push(keyId);
        return "available";
      },
      async fingerprint(keyId, value) {
        keys.push(keyId);
        bytes.push(Buffer.from(value).toString("hex"));
        buffers.push(value);
        return testProviderFingerprint(keyId, value);
      },
    }).fullCheckAsync(changed.context, { add(code) { issues.push(code); } });
    assert.deepEqual(issues, ["SESSION_EVIDENCE_COVERAGE_MISMATCH"], label);
    assert.deepEqual(statuses, [expectedKeyId], label);
    assert.deepEqual(keys, [expectedKeyId], label);
    assert.deepEqual(bytes, [Buffer.from(expectedBytes).toString("hex")], label);
    assert.equal(buffers[0]?.every((byte) => byte === 0), true, label);
    assert.equal(persistentSnapshot(changed.connection), before, label);
  };

  for (const identity of [
    { label: "project identity bytes", projectId: uuid(72_501) },
    { label: "store identity bytes", storeId: uuid(72_502) },
    { label: "session identity bytes", sessionId: uuid(72_503) },
  ] as const) {
    const created = createAuthenticatedIdentityFixture(identity);
    await assertSingleAuthenticatedMismatch(
      created.fixture,
      identity.label,
      "key-a",
      created.expectedBytes,
    );
  }

  const stampStaleCoverageDigest = (changed: Fixture, digest: string): void => {
    mutateHistoricalEvent(changed, (payload) => {
      payload.coverageFingerprint = digest;
    });
    changed.connection.exec(`
      DROP TRIGGER session_evidence_coverage_transitions_no_update;
      DROP TRIGGER session_evidence_coverage_update_guard;
      DROP TRIGGER session_evidence_coverage_v3_update_guard;
    `);
    changed.connection.prepare(`
      UPDATE session_evidence_coverage_transitions
      SET coverage_fingerprint_value = $digest
      WHERE project_id = $projectId
    `).run({ $digest: digest, $projectId: PROJECT_ID });
    changed.connection.prepare(`
      UPDATE session_evidence_coverage
      SET coverage_fingerprint_value = $digest
      WHERE project_id = $projectId
    `).run({ $digest: digest, $projectId: PROJECT_ID });
  };

  const intervalFixture = createFixture();
  const intervalFrame: QualifiedCoverageTestFrame = {
    frameId: uuid(72_510),
    ordinal: 5n,
    sourceKind: "adapter-event",
    observedAt: NOW,
    contentFingerprint: H64,
  };
  addQualifiedCoverageBatch(intervalFixture, {
    position: 2n,
    streamVersion: 2n,
    batchId: uuid(72_511),
    frames: [intervalFrame],
    expected: {
      coverageLastOrdinal: "5",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
      newOrdinals: [5n],
    },
  });
  stampStaleCoverageDigest(intervalFixture, FIRST_COVERAGE_FINGERPRINT);
  await assertSingleAuthenticatedMismatch(
    intervalFixture,
    "coverage interval bytes",
    "key-a",
    Buffer.from(canonicalJson(expectedCoverageAccumulator({
      keyId: "key-a",
      previousCoverageFingerprint: null,
      coverageLastOrdinal: "5",
      highestContiguousOrdinal: null,
      missingIntervals: [{ firstOrdinal: "0", lastOrdinal: "4" }],
      newFrames: [{ ...intervalFrame, ordinal: "5" }],
    })), "utf8"),
  );

  const countFixture = createFixture();
  const countFrames: readonly QualifiedCoverageTestFrame[] = [
    {
      frameId: uuid(72_520),
      ordinal: 0n,
      sourceKind: "model-turn",
      observedAt: NOW,
      contentFingerprint: H64,
    },
    {
      frameId: uuid(72_521),
      ordinal: 1n,
      sourceKind: "tool-request",
      observedAt: NOW,
      contentFingerprint: H64_B,
    },
  ];
  addQualifiedCoverageBatch(countFixture, {
    position: 2n,
    streamVersion: 2n,
    batchId: uuid(72_522),
    frames: countFrames,
    expected: {
      coverageLastOrdinal: "1",
      highestContiguousOrdinal: "1",
      missingIntervals: [],
      newOrdinals: [0n, 1n],
    },
  });
  stampStaleCoverageDigest(countFixture, FIRST_COVERAGE_FINGERPRINT);
  await assertSingleAuthenticatedMismatch(
    countFixture,
    "new-frame cardinality bytes",
    "key-a",
    Buffer.from(canonicalJson(expectedCoverageAccumulator({
      keyId: "key-a",
      previousCoverageFingerprint: null,
      coverageLastOrdinal: "1",
      highestContiguousOrdinal: "1",
      missingIntervals: [],
      newFrames: countFrames.map((frame) => ({
        ...frame,
        ordinal: frame.ordinal.toString(),
      })),
    })), "utf8"),
  );

  const orderFixture = createFixture();
  const baselineOrderFrames = countFrames.map((frame) => ({
    ...frame,
    ordinal: frame.ordinal.toString(),
  }));
  const swappedOrderFrames: readonly QualifiedCoverageTestFrame[] = [
    { ...countFrames[1]!, ordinal: 0n },
    { ...countFrames[0]!, ordinal: 1n },
  ];
  addQualifiedCoverageBatch(orderFixture, {
    position: 2n,
    streamVersion: 2n,
    batchId: uuid(72_523),
    frames: swappedOrderFrames,
    expected: {
      coverageLastOrdinal: "1",
      highestContiguousOrdinal: "1",
      missingIntervals: [],
      newOrdinals: [0n, 1n],
    },
  });
  const baselineOrderDigest = testProviderFingerprint("key-a", Buffer.from(
    canonicalJson(expectedCoverageAccumulator({
      keyId: "key-a",
      previousCoverageFingerprint: null,
      coverageLastOrdinal: "1",
      highestContiguousOrdinal: "1",
      missingIntervals: [],
      newFrames: baselineOrderFrames,
    })),
    "utf8",
  ));
  stampStaleCoverageDigest(orderFixture, baselineOrderDigest);
  await assertSingleAuthenticatedMismatch(
    orderFixture,
    "ascending frame-slot identity order bytes",
    "key-a",
    Buffer.from(canonicalJson(expectedCoverageAccumulator({
      keyId: "key-a",
      previousCoverageFingerprint: null,
      coverageLastOrdinal: "1",
      highestContiguousOrdinal: "1",
      missingIntervals: [],
      newFrames: swappedOrderFrames.map((frame) => ({
        ...frame,
        ordinal: frame.ordinal.toString(),
      })),
    })), "utf8"),
  );

  const previousDigestFixture = createFixture();
  const previousFrames: readonly QualifiedCoverageTestFrame[] = [
    {
      frameId: uuid(72_530),
      ordinal: 0n,
      sourceKind: "model-turn",
      observedAt: NOW,
      contentFingerprint: H64,
    },
    {
      frameId: uuid(72_531),
      ordinal: 1n,
      sourceKind: "tool-result",
      observedAt: NOW,
      contentFingerprint: H64_B,
    },
  ];
  const firstPrevious = addQualifiedCoverageBatch(previousDigestFixture, {
    position: 2n,
    streamVersion: 2n,
    batchId: uuid(72_532),
    frames: [previousFrames[0]!],
    expected: {
      coverageLastOrdinal: "0",
      highestContiguousOrdinal: "0",
      missingIntervals: [],
      newOrdinals: [0n],
    },
  });
  addQualifiedCoverageBatch(previousDigestFixture, {
    position: 3n,
    streamVersion: 3n,
    batchId: uuid(72_533),
    frames: [previousFrames[1]!],
    expected: {
      coverageLastOrdinal: "1",
      highestContiguousOrdinal: "1",
      missingIntervals: [],
      newOrdinals: [1n],
    },
  });
  const replacementPreviousDigest = "d".repeat(64);
  previousDigestFixture.connection.exec(`
    DROP TRIGGER events_no_update;
    DROP TRIGGER session_evidence_coverage_transitions_no_update;
  `);
  const firstEventRow = previousDigestFixture.connection.prepare(`
    SELECT payload_json FROM events WHERE global_position = 2
  `).get()!;
  const firstEventPayload = JSON.parse(
    String(firstEventRow.payload_json),
  ) as Record<string, unknown>;
  firstEventPayload.coverageFingerprint = replacementPreviousDigest;
  previousDigestFixture.connection.prepare(`
    UPDATE events SET payload_json = $payload, payload_hash = $payloadHash
    WHERE global_position = 2
  `).run({
    $payload: canonicalJson(firstEventPayload),
    $payloadHash: payloadHash(firstEventPayload),
  });
  previousDigestFixture.connection.prepare(`
    UPDATE session_evidence_coverage_transitions
    SET coverage_fingerprint_value = CASE batch_event_position
          WHEN 2 THEN $replacementPreviousDigest ELSE coverage_fingerprint_value END,
        previous_coverage_fingerprint_value = CASE batch_event_position
          WHEN 3 THEN $replacementPreviousDigest ELSE previous_coverage_fingerprint_value END
    WHERE project_id = $projectId
  `).run({
    $replacementPreviousDigest: replacementPreviousDigest,
    $projectId: PROJECT_ID,
  });
  const previousBefore = persistentSnapshot(previousDigestFixture.connection);
  const previousIssues: IntegrityIssueCode[] = [];
  const previousStatuses: string[] = [];
  const previousKeys: string[] = [];
  const previousBytes: string[] = [];
  const previousBuffers: Uint8Array[] = [];
  const expectedFirstBytes = Buffer.from(canonicalJson(expectedCoverageAccumulator({
    keyId: "key-a",
    previousCoverageFingerprint: null,
    coverageLastOrdinal: "0",
    highestContiguousOrdinal: "0",
    missingIntervals: [],
    newFrames: [{ ...previousFrames[0]!, ordinal: "0" }],
  })), "utf8");
  const expectedSecondBytes = Buffer.from(canonicalJson(expectedCoverageAccumulator({
    keyId: "key-a",
    previousCoverageFingerprint: replacementPreviousDigest,
    coverageLastOrdinal: "1",
    highestContiguousOrdinal: "1",
    missingIntervals: [],
    newFrames: [{ ...previousFrames[1]!, ordinal: "1" }],
  })), "utf8");
  await new LifecycleIntegrityService(previousDigestFixture.connection, {
    async status(keyId) {
      previousStatuses.push(keyId);
      return "available";
    },
    async fingerprint(keyId, value) {
      previousKeys.push(keyId);
      previousBytes.push(Buffer.from(value).toString("hex"));
      previousBuffers.push(value);
      return previousKeys.length === 1
        ? replacementPreviousDigest
        : testProviderFingerprint(keyId, value);
    },
  }).fullCheckAsync(previousDigestFixture.context, {
    add(code) { previousIssues.push(code); },
  });
  assert.notEqual(firstPrevious.coverageFingerprint, replacementPreviousDigest);
  assert.deepEqual(previousIssues, ["SESSION_EVIDENCE_COVERAGE_MISMATCH"]);
  assert.deepEqual(previousStatuses, ["key-a"]);
  assert.deepEqual(previousKeys, ["key-a", "key-a"]);
  assert.deepEqual(previousBytes, [
    expectedFirstBytes.toString("hex"),
    expectedSecondBytes.toString("hex"),
  ]);
  assert.equal(
    previousBuffers.every((bytes) => bytes.every((byte) => byte === 0)),
    true,
  );
  assert.equal(
    persistentSnapshot(previousDigestFixture.connection),
    previousBefore,
  );
});

it("full integrity reconstructs version 2 checkpoints and frozen snapshots at their historical bases", async () => {
  const frozen = createFixture();
  addFrozenCurrentChildWorkflow(frozen);
  assert.deepEqual(await fullIssues(frozen), []);

  const carried = createFixture();
  addFrozenCarryForwardWorkflow(carried);
  assert.deepEqual(await fullIssues(carried), []);

  for (const childCheckpointVersion of [null, 1, 2] as const) {
    const coveredChild = createFixture();
    addCoveredCurrentChildFinalCheckpoint(
      coveredChild,
      childCheckpointVersion,
    );
    const before = persistentSnapshot(coveredChild.connection);
    await assert.rejects(
      () => fullIssues(coveredChild),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
      `ending binding child checkpoint version ${childCheckpointVersion ?? "null"}`,
    );
    assert.equal(
      persistentSnapshot(coveredChild.connection),
      before,
      `ending binding child checkpoint version ${childCheckpointVersion ?? "null"}`,
    );
  }

  const coverageBearingV1 = createFixture();
  const v1CheckpointId = uuid(77_000);
  const v1Draft = checkpointDraft(1);
  const v1Checkpoint = {
    ...checkpointFixture({
      checkpointId: v1CheckpointId as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 1,
      checkpointEventPosition: 2,
    }),
    ...v1Draft,
    createdAt: NOW,
    creatorAgentId: "agent-full-integrity",
    creatorClientInstanceId: "client-full-integrity",
    sourceState: {
      sourceStateScopeVersion: 1,
      workspaceId: WORKSPACE_ID,
      branchRef: null,
      headCommit: null,
      dirtyWorktreeFingerprint: "7".repeat(64),
    },
    childSummaries: [],
    evidenceCoverage: {
      captureMode: "coverage-only",
      contentRetained: false,
      highestContiguousOrdinal: "0",
      missingIntervals: [],
    },
  };
  insertFullCheckpoint(coverageBearingV1, {
    sessionId: ROOT_ID,
    parentSessionId: null,
    baseEventPosition: 1n,
    checkpointEventPosition: 2n,
    streamVersion: 2n,
    checkpoint: v1Checkpoint,
    draft: v1Draft,
    commandId: uuid(77_001),
    idempotencyKey: "full-integrity/v1-coverage-bearing",
  });
  coverageBearingV1.connection.prepare(`
    UPDATE streams SET current_version = 2, updated_at = $now
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $now: NOW,
    $projectId: PROJECT_ID,
    $streamId: `session/${ROOT_ID}`,
  });
  coverageBearingV1.connection.prepare(`
    UPDATE session_authority
    SET latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = 2,
        latest_checkpoint_fingerprint = $fingerprint,
        updated_at = $now
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: v1CheckpointId,
    $fingerprint: checkpointFingerprint(v1Checkpoint),
    $now: NOW,
    $projectId: PROJECT_ID,
    $sessionId: ROOT_ID,
  });
  await assert.rejects(
    () => fullIssues(coverageBearingV1),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "schema-3 rejects coverage-bearing Version 1 checkpoints even before V2 evidence",
  );

  const rewrittenAfterBase = createFixture();
  addCheckpointRewrittenToChildStateAfterDeclaredBase(rewrittenAfterBase);
  await assert.rejects(
    () => fullIssues(rewrittenAfterBase),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "checkpoint child summaries must be captured at the declared base",
  );

  const claimedAfterFreeze = createFixture();
  const claimedAfterFreezeTicket = addFrozenCarryForwardWorkflow(claimedAfterFreeze);
  addClaimAfterFrozenCarry(claimedAfterFreeze, claimedAfterFreezeTicket.ticketId);
  assert.deepEqual(await fullIssues(claimedAfterFreeze), []);

  const ticketJsonMutations = [
    {
      column: "source_assignment_json",
      value: canonicalJson({
        assignmentId: uuid(55_001),
        summary: "mutated transfer assignment",
        scope: "tests/qualified-checkpoint-full-integrity.test.ts",
        assignmentRevision: 1,
      }),
    },
    {
      column: "source_scope_json",
      value: canonicalJson({ scope: "wrong/scope" }),
    },
    {
      column: "follow_ups_json",
      value: canonicalJson([{
        childTransferAnnotationsVersion: 1,
        blockers: ["mutated-blocker"],
        followUps: [],
      }]),
    },
    {
      column: "source_state_json",
      value: canonicalJson({
        sourceStateScopeVersion: 1,
        workspaceId: WORKSPACE_ID,
        branchRef: null,
        headCommit: null,
        dirtyWorktreeFingerprint: "6".repeat(64),
      }),
    },
    {
      column: "lineage_json",
      value: canonicalJson({
        previousParentSessionId: ROOT_ID,
        previousChildSessionId: uuid(55_099),
        correlationId: CHILD_ID,
        transferEventPosition: "5",
      }),
    },
  ] as const;
  for (const mutation of ticketJsonMutations) {
    const changed = createFixture();
    addFrozenCarryForwardWorkflow(changed);
    changed.connection.exec("DROP TRIGGER child_transfer_tickets_update_guard");
    changed.connection.prepare(`
      UPDATE child_transfer_tickets SET ${mutation.column} = $value
      WHERE project_id = $projectId
    `).run({ $value: mutation.value, $projectId: PROJECT_ID });
    const before = persistentSnapshot(changed.connection);
    await assert.rejects(
      () => fullIssues(changed),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
      mutation.column,
    );
    assert.equal(persistentSnapshot(changed.connection), before, mutation.column);
  }

  const partialClaimTuple = createFixture();
  addFrozenCarryForwardWorkflow(partialClaimTuple);
  partialClaimTuple.connection.exec("DROP TRIGGER child_transfer_tickets_update_guard");
  partialClaimTuple.connection.prepare(`
    UPDATE child_transfer_tickets
    SET claimed_by_root_session_id = $rootSessionId,
        claimed_child_session_id = $childSessionId,
        claimed_at = $now
    WHERE project_id = $projectId
  `).run({
    $rootSessionId: ROOT_ID,
    $childSessionId: CHILD_ID,
    $now: NOW,
    $projectId: PROJECT_ID,
  });
  const partialClaimBefore = persistentSnapshot(partialClaimTuple.connection);
  await assert.rejects(
    () => fullIssues(partialClaimTuple),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "partial claimed tuple",
  );
  assert.equal(
    persistentSnapshot(partialClaimTuple.connection),
    partialClaimBefore,
  );

  const terminalLink = createFixture();
  addFrozenCarryForwardWorkflow(terminalLink);
  terminalLink.connection.exec("DROP TRIGGER child_transfer_tickets_update_guard");
  terminalLink.connection.prepare(`
    UPDATE child_transfer_tickets SET created_event_position = 4
    WHERE project_id = $projectId
  `).run({ $projectId: PROJECT_ID });
  await assert.rejects(
    () => fullIssues(terminalLink),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "transfer ticket terminal linkage",
  );

  const transferAlias = createFixture();
  addFrozenCarryForwardWorkflow(transferAlias);
  transferAlias.connection.exec("DROP TRIGGER events_no_update");
  const transferRow = transferAlias.connection.prepare(`
    SELECT payload_json FROM events WHERE global_position = 5
  `).get()!;
  const transferPayload = JSON.parse(
    String(transferRow.payload_json),
  ) as Record<string, unknown>;
  transferPayload.transferTicketId = uuid(99_099);
  transferAlias.connection.prepare(`
    UPDATE events SET payload_json = $payload, payload_hash = $payloadHash
    WHERE global_position = 5
  `).run({
    $payload: canonicalJson(transferPayload),
    $payloadHash: payloadHash(transferPayload),
  });
  await assert.rejects(
    () => fullIssues(transferAlias),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "transfer event alias must be rejected by the advancing replay",
  );

  for (const target of ["fork", "claim"] as const) {
    for (const identity of ["branch", "vault"] as const) {
      const changed = createFixture();
      const { ticketId } = addFrozenCarryForwardWorkflow(changed);
      addClaimAfterFrozenCarry(changed, ticketId);
      changed.connection.exec("DROP TRIGGER events_no_update");
      const position = target === "fork" ? 8 : 9;
      if (identity === "branch") {
        const branchScopeId = uuid(target === "fork" ? 97_011 : 97_012);
        const branchRef = `refs/heads/foreign-${target}`;
        rawInsert(changed.connection, "branch_scopes", {
          project_id: PROJECT_ID,
          branch_scope_id: branchScopeId,
          current_ref: branchRef,
          created_head: H64,
          detached: 0,
          created_at: NOW,
          updated_at: NOW,
          retired_at: null,
        });
        changed.connection.prepare(`
          UPDATE events SET branch_scope_id = $branchScopeId, branch_ref = $branchRef
          WHERE global_position = $position
        `).run({ $branchScopeId: branchScopeId, $branchRef: branchRef, $position: position });
      } else {
        changed.connection.prepare(`
          UPDATE events SET vault_id = $vaultId WHERE global_position = $position
        `).run({ $vaultId: uuid(97_013), $position: position });
      }
      await assert.rejects(
        () => fullIssues(changed),
        (error: unknown) => (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "INTEGRITY_FAILURE"
        ),
        `${target} ${identity} provenance`,
      );
    }
  }

  const claimPayloadMutation = createFixture();
  const claimPayloadTicket = addFrozenCarryForwardWorkflow(claimPayloadMutation);
  addClaimAfterFrozenCarry(claimPayloadMutation, claimPayloadTicket.ticketId);
  claimPayloadMutation.connection.exec("DROP TRIGGER events_no_update");
  const claimRow = claimPayloadMutation.connection.prepare(`
    SELECT payload_json FROM events WHERE global_position = 9
  `).get()!;
  const claimPayload = JSON.parse(String(claimRow.payload_json)) as Record<string, unknown>;
  claimPayload.previousChildSessionId = uuid(55_098);
  claimPayloadMutation.connection.prepare(`
    UPDATE events SET payload_json = $payload, payload_hash = $payloadHash
    WHERE global_position = 9
  `).run({
    $payload: canonicalJson(claimPayload),
    $payloadHash: payloadHash(claimPayload),
  });
  await assert.rejects(
    () => fullIssues(claimPayloadMutation),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "claim previous-child provenance must be rejected by the advancing replay",
  );

  const historical = createFixture();
  addCoverage(historical);
  addHistoricalCheckpoint(historical);
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

  const strictMutations: readonly {
    readonly label: string;
    readonly mutateCheckpoint?: (
      checkpoint: Record<string, unknown>,
    ) => Record<string, unknown>;
    readonly mutateIntentDraft?: (
      draft: Record<string, unknown>,
    ) => Record<string, unknown>;
  }[] = [
    {
      label: "non-evidence body",
      mutateCheckpoint: (checkpoint) => ({
        ...checkpoint,
        taskSummary: "mutated but structurally valid checkpoint summary",
      }),
    },
    {
      label: "source state",
      mutateCheckpoint: (checkpoint) => ({
        ...checkpoint,
        sourceState: {
          ...(checkpoint.sourceState as Record<string, unknown>),
          workspaceId: "f".repeat(64),
        },
      }),
    },
    {
      label: "child summary",
      mutateCheckpoint: (checkpoint) => ({
        ...checkpoint,
        childSummaries: [{
          childSessionId: uuid(55_700),
          state: "active",
          lastEventPosition: "2",
          streamVersion: "1",
          latestCheckpointId: null,
        }],
      }),
    },
    {
      label: "creator",
      mutateCheckpoint: (checkpoint) => ({
        ...checkpoint,
        creatorAgentId: "another-valid-agent",
      }),
    },
    {
      label: "timestamp",
      mutateCheckpoint: (checkpoint) => ({
        ...checkpoint,
        createdAt: "2026-07-31T00:00:01.000Z",
      }),
    },
    {
      label: "intent disagreement",
      mutateIntentDraft: (draft) => ({
        ...draft,
        taskSummary: "intent draft disagrees with persisted checkpoint",
      }),
    },
  ];
  for (const mutation of strictMutations) {
    const fixture = createFixture();
    addCoverage(fixture);
    addHistoricalCheckpoint(fixture, mutation);
    addZeroNewCoverage(fixture, { position: 4n, streamVersion: 4n });
    await assert.rejects(
      () => fullIssues(fixture),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
      mutation.label,
    );
  }

  const opaqueLeaf = createFixture();
  addCoverage(opaqueLeaf);
  addHistoricalCheckpoint(opaqueLeaf);
  addZeroNewCoverage(opaqueLeaf, { position: 4n, streamVersion: 4n });
  mutateHistoricalCheckpointWithoutHashBindings(opaqueLeaf, (checkpoint) => ({
    ...checkpoint,
    sourceState: {
      ...(checkpoint.sourceState as Record<string, unknown>),
      dirtyWorktreeFingerprint: "3".repeat(64),
    },
  }));
  await assert.rejects(
    () => fullIssues(opaqueLeaf),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "opaque dirty fingerprint must remain bound by the immutable payload hash",
  );
});

it("full integrity reports unavailable historical keys and never repairs state", async () => {
  for (const history of ["open-workflow", "frozen-workflow"] as const) {
    const endpointOnly = createFixture();
    if (history === "open-workflow") {
      addWorkflowRequest(endpointOnly);
      addCoverage(endpointOnly, { position: 3n, streamVersion: 3n });
    } else {
      addFrozenCurrentChildWorkflow(endpointOnly, { finalIntent: "manual" });
      addCoverage(endpointOnly, { position: 5n, streamVersion: 4n });
    }
    const observedEndpointOnly = observedReplayConnection(endpointOnly.connection, {
      trapUnmarkedHistorical: true,
      trapDml: true,
    });
    const issues: IntegrityIssueCode[] = [];
    await new LifecycleIntegrityService(observedEndpointOnly.connection, {
      async status() { return "available"; },
      async fingerprint(keyId, bytes) {
        return testProviderFingerprint(keyId, bytes);
      },
    }).quickCheckAsync(endpointOnly.context, {
      add(code) { issues.push(code); },
    });
    assert.deepEqual(issues, [], `${history} qualified quick issues`);
    assert.equal(observedEndpointOnly.unmarkedHistoricalPrepares(), 0, history);
    assert.deepEqual([...observedEndpointOnly.counts.keys()], [], history);
  }

  for (const history of ["open-workflow", "frozen-workflow"] as const) {
    const endpointOnly = createFixture();
    if (history === "open-workflow") {
      addWorkflowRequest(endpointOnly);
      addCoverage(endpointOnly, { position: 3n, streamVersion: 3n });
    } else {
      addFrozenCurrentChildWorkflow(endpointOnly, { finalIntent: "manual" });
      addCoverage(endpointOnly, { position: 5n, streamVersion: 4n });
    }
    const observedEndpointOnly = observedReplayConnection(endpointOnly.connection, {
      trapUnmarkedHistorical: true,
      trapDml: true,
    });
    await assert.rejects(
      () => new LifecycleIntegrityService(observedEndpointOnly.connection, {
        async status() { return "unavailable"; },
        async fingerprint(keyId, bytes) {
          return testProviderFingerprint(keyId, bytes);
        },
      }).fullCheckAsync(endpointOnly.context, { add() {} }),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
      ),
      `${history} qualified full preflight must be endpoint-only`,
    );
    assert.equal(observedEndpointOnly.unmarkedHistoricalPrepares(), 0, history);
    assert.deepEqual([...observedEndpointOnly.counts.keys()], [], history);
  }

  const quickFailures: readonly {
    readonly label: string;
    readonly provider?: HistoricalEvidenceIntegrityProviderPort;
    readonly code: "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE" | "INTEGRITY_FAILURE";
  }[] = [
    {
      label: "missing provider",
      code: "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE",
    },
    {
      label: "revoked current key",
      provider: {
        async status() { return "revoked"; },
        async fingerprint(keyId, bytes) { return testProviderFingerprint(keyId, bytes); },
      },
      code: "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE",
    },
    {
      label: "unavailable current key",
      provider: {
        async status() { return "unavailable"; },
        async fingerprint(keyId, bytes) { return testProviderFingerprint(keyId, bytes); },
      },
      code: "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE",
    },
    {
      label: "invalid current status",
      provider: {
        async status() { return "unknown" as never; },
        async fingerprint(keyId, bytes) { return testProviderFingerprint(keyId, bytes); },
      },
      code: "INTEGRITY_FAILURE",
    },
  ];
  for (const quickFailure of quickFailures) {
    const failed = createFixture();
    addCoverage(failed);
    const before = persistentSnapshot(failed.connection);
    const observed = observedReplayConnection(failed.connection, { trapDml: true });
    await assert.rejects(
      () => new LifecycleIntegrityService(observed.connection, quickFailure.provider)
        .quickCheckAsync(failed.context, { add() {} }),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === quickFailure.code
      ),
      quickFailure.label,
    );
    assert.deepEqual([...observed.counts.keys()], [], quickFailure.label);
    assert.equal(persistentSnapshot(failed.connection), before, quickFailure.label);
  }

  const quickUnavailable = createFixture();
  addCoverage(quickUnavailable);
  const quickObserved = observedReplayConnection(quickUnavailable.connection);
  await assert.rejects(
    () => new LifecycleIntegrityService(quickObserved.connection, {
      async status() { return "unavailable"; },
      async fingerprint(keyId, bytes) { return testProviderFingerprint(keyId, bytes); },
    }).fullCheckAsync(quickUnavailable.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
    ),
  );
  assert.deepEqual([...quickObserved.counts.keys()], []);

  const unavailable = createFixture();
  addCoverage(unavailable);
  removeCurrentCoverageEndpoint(unavailable);
  const unavailableBefore = persistentSnapshot(unavailable.connection);
  const calls: string[] = [];
  const unavailableProvider: HistoricalEvidenceIntegrityProviderPort = {
    async status(keyId) {
      calls.push(keyId);
      return keyId === "key-a" ? "unavailable" : "available";
    },
    async fingerprint(keyId, bytes) { return testProviderFingerprint(keyId, bytes); },
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
  assert.deepEqual(calls, ["key-a"]);
  assert.equal(persistentSnapshot(unavailable.connection), unavailableBefore);

  const invalidStatus = createFixture();
  addCoverage(invalidStatus);
  removeCurrentCoverageEndpoint(invalidStatus);
  const invalidBefore = persistentSnapshot(invalidStatus.connection);
  const invalidObserved = observedReplayConnection(invalidStatus.connection, { trapDml: true });
  const invalidService = new LifecycleIntegrityService(invalidObserved.connection, {
    async status(keyId) {
      return (keyId === "key-a" ? "unknown" : "available") as never;
    },
    async fingerprint(keyId, bytes) { return testProviderFingerprint(keyId, bytes); },
  });
  const invalidCursors = captureReplayVisitCursors(invalidService);
  await assert.rejects(
    () => invalidService.fullCheckAsync(invalidStatus.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
  );
  assert.deepEqual(invalidObserved.closeOrder, [
    "immutable-ordinal",
    "coverage-transition",
    "workflow-fold",
    "child-fold",
    "event",
  ]);
  assert.equal(invalidCursors.event?.visits, 2);
  assert.equal(invalidCursors["coverage-transition"]?.visits, 0);
  assert.equal(invalidCursors["immutable-ordinal"]?.visits, 1);
  assert.equal(persistentSnapshot(invalidStatus.connection), invalidBefore);

  const originalWins = createFixture();
  addCoverage(originalWins);
  removeCurrentCoverageEndpoint(originalWins);
  const originalBefore = persistentSnapshot(originalWins.connection);
  const closeFailure = observedReplayConnection(originalWins.connection, {
    closeFailureKind: "immutable-ordinal",
    trapDml: true,
  });
  const originalService = new LifecycleIntegrityService(closeFailure.connection, {
    async status(keyId) {
      return keyId === "key-a" ? "unavailable" : "available";
    },
    async fingerprint(keyId, bytes) { return testProviderFingerprint(keyId, bytes); },
  });
  const originalCursors = captureReplayVisitCursors(originalService);
  await assert.rejects(
    () => originalService.fullCheckAsync(originalWins.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
    ),
  );
  assert.equal(originalCursors.event?.visits, 2);
  assert.equal(originalCursors["coverage-transition"]?.visits, 0);
  assert.equal(originalCursors["immutable-ordinal"]?.visits, 1);
  assert.equal(persistentSnapshot(originalWins.connection), originalBefore);

  const mismatch = createFixture();
  addCoverage(mismatch);
  const mismatchBefore = persistentSnapshot(mismatch.connection);
  const mismatchIssues: IntegrityIssueCode[] = [];
  const mismatchObserved = observedReplayConnection(mismatch.connection, { trapDml: true });
  const mismatchService = new LifecycleIntegrityService(mismatchObserved.connection, {
    async status() { return "available"; },
    async fingerprint() { return H64_B; },
  });
  const mismatchCursors = captureReplayVisitCursors(mismatchService);
  await mismatchService.fullCheckAsync(mismatch.context, {
    add(code) { mismatchIssues.push(code); },
  });
  assert.deepEqual(mismatchIssues, ["SESSION_EVIDENCE_COVERAGE_MISMATCH"]);
  assert.equal(mismatchCursors.event?.visits, 2);
  assert.equal(mismatchCursors["coverage-transition"]?.visits, 1);
  assert.equal(mismatchCursors["immutable-ordinal"]?.visits, 1);
  assert.equal(mismatchObserved.closeOrder.length, 5);
  assert.equal(persistentSnapshot(mismatch.connection), mismatchBefore);

  const rejectedStatus = createFixture();
  addCoverage(rejectedStatus);
  const rejectedBefore = persistentSnapshot(rejectedStatus.connection);
  await assert.rejects(
    () => new LifecycleIntegrityService(rejectedStatus.connection, {
      async status() { throw new Error("provider-status-rejected"); },
      async fingerprint(keyId, bytes) { return testProviderFingerprint(keyId, bytes); },
    }).fullCheckAsync(rejectedStatus.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
  );
  assert.equal(persistentSnapshot(rejectedStatus.connection), rejectedBefore);

  const rejectedFingerprint = createFixture();
  addCoverage(rejectedFingerprint);
  const rejectedFingerprintBefore = persistentSnapshot(rejectedFingerprint.connection);
  const fingerprintObserved = observedReplayConnection(rejectedFingerprint.connection, {
    trapDml: true,
  });
  const rejectedFingerprintBuffers: Uint8Array[] = [];
  const rejectedFingerprintService = new LifecycleIntegrityService(
    fingerprintObserved.connection,
    {
      async status() { return "available"; },
      async fingerprint(_keyId, bytes) {
        rejectedFingerprintBuffers.push(bytes);
        throw new Error("provider-fingerprint-rejected");
      },
    },
  );
  const rejectedFingerprintCursors = captureReplayVisitCursors(
    rejectedFingerprintService,
  );
  await assert.rejects(
    () => rejectedFingerprintService.fullCheckAsync(
      rejectedFingerprint.context,
      { add() {} },
    ),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
  );
  assert.deepEqual(fingerprintObserved.closeOrder, [
    "immutable-ordinal",
    "coverage-transition",
    "workflow-fold",
    "child-fold",
    "event",
  ]);
  assert.equal(rejectedFingerprintCursors.event?.visits, 2);
  assert.equal(rejectedFingerprintCursors["coverage-transition"]?.visits, 0);
  assert.equal(rejectedFingerprintCursors["immutable-ordinal"]?.visits, 1);
  assert.equal(
    rejectedFingerprintBuffers[0]?.every((byte) => byte === 0),
    true,
  );
  assert.equal(
    persistentSnapshot(rejectedFingerprint.connection),
    rejectedFingerprintBefore,
  );

  const malformedLookahead = createFixture();
  addCoverage(malformedLookahead);
  malformedLookahead.connection.exec("DROP TRIGGER events_no_update");
  malformedLookahead.connection.prepare(`
    UPDATE events SET payload_hash = $hash WHERE global_position = 2
  `).run({ $hash: H64_B });
  const malformedBefore = persistentSnapshot(malformedLookahead.connection);
  const malformedObserved = observedReplayConnection(malformedLookahead.connection, {
    trapDml: true,
    trapLegacy: true,
  });
  const malformedService = new LifecycleIntegrityService(
    malformedObserved.connection,
    provider,
  );
  const malformedCursors = captureReplayVisitCursors(malformedService);
  await assert.rejects(
    () => malformedService.fullCheckAsync(malformedLookahead.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
  );
  assert.deepEqual(malformedObserved.closeOrder, [
    "immutable-ordinal",
    "coverage-transition",
    "workflow-fold",
    "child-fold",
    "event",
  ]);
  assert.equal(malformedCursors.event?.visits, 0);
  assert.equal(malformedCursors["coverage-transition"]?.visits, 0);
  assert.equal(malformedCursors["immutable-ordinal"]?.visits, 0);
  assert.equal(persistentSnapshot(malformedLookahead.connection), malformedBefore);

  const closeOnly = createFixture();
  addCoverage(closeOnly);
  const closeOnlyBefore = persistentSnapshot(closeOnly.connection);
  const closeOnlyObserved = observedReplayConnection(closeOnly.connection, {
    closeFailureKind: "immutable-ordinal",
    trapDml: true,
    trapLegacy: true,
  });
  const closeOnlyService = new LifecycleIntegrityService(
    closeOnlyObserved.connection,
    provider,
  );
  const closeOnlyCursors = captureReplayVisitCursors(closeOnlyService);
  await assert.rejects(
    () => closeOnlyService.fullCheckAsync(closeOnly.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "a close failure with no earlier failure must surface integrity failure",
  );
  assert.deepEqual(closeOnlyObserved.closeOrder, [
    "immutable-ordinal",
    "coverage-transition",
    "workflow-fold",
    "child-fold",
    "event",
  ]);
  assert.equal(closeOnlyCursors.event?.visits, 2);
  assert.equal(closeOnlyCursors["coverage-transition"]?.visits, 1);
  assert.equal(closeOnlyCursors["immutable-ordinal"]?.visits, 1);
  assert.equal(persistentSnapshot(closeOnly.connection), closeOnlyBefore);

  const cursorOpeningOrder = [
    "event",
    "child-fold",
    "workflow-fold",
    "coverage-transition",
    "immutable-ordinal",
  ] as const;
  for (const targetKind of cursorOpeningOrder) {
    for (const stage of ["prepare", "iterate", "next"] as const) {
      const failed = createFixture();
      const before = persistentSnapshot(failed.connection);
      const observed = observedReplayConnection(failed.connection, {
        trapDml: true,
        failure: { kind: targetKind, stage, call: 1 },
      });
      await assert.rejects(
        () => new LifecycleIntegrityService(observed.connection, provider)
          .fullCheckAsync(failed.context, { add() {} }),
        (error: unknown) => (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "INTEGRITY_FAILURE"
        ),
        `${targetKind}:${stage}`,
      );
      const targetIndex = cursorOpeningOrder.indexOf(targetKind);
      for (let index = 0; index < cursorOpeningOrder.length; index += 1) {
        const kind = cursorOpeningOrder[index]!;
        const counts = observed.counts.get(kind) ?? {
          prepares: 0,
          iterates: 0,
          nexts: 0,
          visits: 0,
          closes: 0,
        };
        if (index < targetIndex) {
          assert.deepEqual(counts, {
            prepares: 1,
            iterates: 1,
            nexts: 1,
            visits: kind === "event" ? 1 : 0,
            closes: 1,
          }, `${targetKind}:${stage}:${kind}`);
        } else if (index === targetIndex) {
          assert.deepEqual(counts, {
            prepares: 1,
            iterates: stage === "prepare" ? 0 : 1,
            nexts: stage === "next" ? 1 : 0,
            visits: 0,
            closes: stage === "next" ? 1 : 0,
          }, `${targetKind}:${stage}:${kind}`);
        } else {
          assert.deepEqual(counts, {
            prepares: 0,
            iterates: 0,
            nexts: 0,
            visits: 0,
            closes: 0,
          }, `${targetKind}:${stage}:${kind}`);
        }
      }
      const earlier = cursorOpeningOrder.slice(0, targetIndex).reverse();
      assert.deepEqual(
        observed.closeOrder,
        stage === "next" ? [targetKind, ...earlier] : earlier,
        `${targetKind}:${stage}:close-order`,
      );
      assert.equal(persistentSnapshot(failed.connection), before);
    }
  }

  const replayLookaheadFailures = [
    {
      kind: "event" as const,
      expected: { event: 0, "coverage-transition": 0, "immutable-ordinal": 0 },
    },
    {
      kind: "immutable-ordinal" as const,
      expected: { event: 2, "coverage-transition": 0, "immutable-ordinal": 0 },
    },
    {
      kind: "coverage-transition" as const,
      expected: { event: 2, "coverage-transition": 0, "immutable-ordinal": 1 },
    },
  ];
  for (const failure of replayLookaheadFailures) {
    const failed = createFixture();
    addCoverage(failed);
    const before = persistentSnapshot(failed.connection);
    const observed = observedReplayConnection(failed.connection, {
      trapDml: true,
      failure: { kind: failure.kind, stage: "next", call: 2 },
    });
    const service = new LifecycleIntegrityService(observed.connection, provider);
    const cursors = captureReplayVisitCursors(service);
    await assert.rejects(
      () => service.fullCheckAsync(failed.context, { add() {} }),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
      `${failure.kind}:lookahead`,
    );
    for (const [kind, visits] of Object.entries(failure.expected) as Array<
      [CapturedReplayVisitKind, number]
    >) {
      assert.equal(cursors[kind]?.visits, visits, `${failure.kind}:${kind}`);
    }
    for (const kind of cursorOpeningOrder) {
      assert.equal(observed.counts.get(kind)?.prepares, 1, `${failure.kind}:${kind}:prepare`);
      assert.equal(observed.counts.get(kind)?.iterates, 1, `${failure.kind}:${kind}:iterate`);
      assert.equal(observed.counts.get(kind)?.closes, 1, `${failure.kind}:${kind}:return`);
    }
    assert.deepEqual(observed.closeOrder, [...cursorOpeningOrder].reverse());
    assert.equal(persistentSnapshot(failed.connection), before);
  }
});

it("full integrity merge cursors reject missing and orphan child projection rows", async () => {
  const legal = createFixture();
  addChildFork(legal);
  assert.deepEqual(await fullIssues(legal), []);

  const reportMatrix = createFixture();
  addReportResetCompletionMatrix(reportMatrix);
  assert.deepEqual(await fullIssues(reportMatrix), []);

  const claimedCarry = createFixture();
  const { ticketId } = addFrozenCarryForwardWorkflow(claimedCarry);
  addClaimAfterFrozenCarry(claimedCarry, ticketId);
  assert.deepEqual(await fullIssues(claimedCarry), []);

  const childEvidence = createFixture();
  addChildFork(childEvidence);
  addCoverage(childEvidence, {
    sessionId: CHILD_ID,
    parentSessionId: ROOT_ID,
    position: 3n,
    streamVersion: 2n,
  });
  const childStart = childAuthority(CHILD_ID, 2n);
  const childForkProjection = testChildProjection({
    projectId: PROJECT_ID,
    childSessionId: CHILD_ID,
    eventPosition: 2n,
    streamVersion: 1n,
    rootSessionId: ROOT_ID,
    childState: "active",
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    authorityCommitment: String(childStart.authority_commitment),
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
  });
  insertTestChildProjection(
    childEvidence.connection,
    carryTestChildProjection(childForkProjection, {
      eventPosition: 3n,
      streamVersion: 2n,
    }),
  );
  assert.deepEqual(await fullIssues(childEvidence), []);

  const rootEvidence = createFixture();
  addCoverage(rootEvidence);
  assert.deepEqual(await fullIssues(rootEvidence), []);

  const childOnlyEventTypes = [
    "SessionForked",
    "ChildAssignmentAmended",
    "ChildWorkReported",
    "ChildWorkDispositioned",
    "ChildCompletionProposed",
    "ChildSessionCompleted",
    "ChildSessionSuspended",
    "ChildWorkTransferCreated",
    "ChildWorkTransferClaimed",
  ] as const;
  for (const eventType of childOnlyEventTypes) {
    const rootShaped = createFixture();
    rootShaped.connection.prepare(`
      UPDATE streams SET current_version = 2, updated_at = $now
      WHERE project_id = $projectId AND stream_id = $streamId
    `).run({
      $now: NOW,
      $projectId: PROJECT_ID,
      $streamId: `session/${ROOT_ID}`,
    });
    rawEvent(rootShaped.connection, {
      globalPosition: 2n,
      streamId: `session/${ROOT_ID}`,
      streamVersion: 2n,
      eventType,
      eventSchemaVersion: 1,
      sessionId: ROOT_ID,
      parentSessionId: null,
      payload: lifecycleEvent(2, eventType).payload,
    });
    await assert.rejects(
      () => fullIssues(rootShaped),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
      `${eventType} must not be accepted on a root-shaped stream`,
    );
  }

  for (const correspondence of ["wrong", "out-of-order"] as const) {
    const changed = createFixture();
    addChildFork(changed, { projection: false });
    changed.connection.exec("DROP TRIGGER lifecycle_child_event_folds_insert_guard");
    changed.connection.exec("PRAGMA foreign_keys = OFF");
    const projectedChildId = CHILD_ID;
    const projectedPosition = correspondence === "wrong" ? 2n : 3n;
    const projected = {
      projectId: PROJECT_ID,
      childSessionId: projectedChildId,
      eventPosition: projectedPosition,
      streamVersion: correspondence === "wrong" ? 2n : 1n,
      rootSessionId: ROOT_ID,
      childState: "active" as const,
      latestCheckpointId: null,
      latestCheckpointEventPosition: null,
      authorityCommitment: String(childAuthority(CHILD_ID, 2n).authority_commitment),
      terminalEventType: null,
      terminalEventPosition: null,
      reportCount: 0,
      latestReportId: null,
      reportIndexFingerprint: referenceReportIndexGenesisFingerprint(
        PROJECT_ID,
        projectedChildId,
      ),
      completionReportId: null,
      reportedReportId: null,
      reportedItemCount: null,
      reportedItemSetFingerprint: null,
      previousFingerprint: null,
    };
    insertTestChildProjection(changed.connection, testChildProjection(projected));
    changed.connection.exec("PRAGMA foreign_keys = ON");
    await assert.rejects(
      () => fullIssues(changed),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
      `child ${correspondence} projection row`,
    );
  }

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

  const trailing = createFixture();
  trailing.connection.exec("DROP TRIGGER lifecycle_child_event_folds_insert_guard");
  trailing.connection.exec("PRAGMA foreign_keys = OFF");
  const trailingProjection = testChildProjection({
    ...orphanProjection,
    childSessionId: uuid(55_998),
    eventPosition: 2n,
    reportIndexFingerprint: referenceReportIndexGenesisFingerprint(
      PROJECT_ID,
      uuid(55_998),
    ),
  });
  insertTestChildProjection(trailing.connection, trailingProjection);
  trailing.connection.exec("PRAGMA foreign_keys = ON");
  await assert.rejects(
    () => fullIssues(trailing),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "a child projection row beyond project event EOF is a trailing orphan",
  );
});

it("full integrity merge cursors reject missing and orphan workflow projection rows", async () => {
  const amendmentMatrix = createFixture();
  addWorkflowAmendmentMatrix(amendmentMatrix);
  assert.deepEqual(await fullIssues(amendmentMatrix), []);

  for (const outcome of ["passed", "failed", "invalidated"] as const) {
    const fixture = createFixture();
    addDurableWorkflowOutcome(fixture, { outcome });
    assert.deepEqual(await fullIssues(fixture), [], outcome);
  }

  for (const phase of ["ending-materialization-queued", "validating"] as const) {
    const fixture = createFixture();
    setFrozenWorkflowEndpointPhase(fixture, phase);
    assert.deepEqual(await fullIssues(fixture), [], phase);
  }
  for (const closure of [
    { requireMaterialization: false, phase: "completion-appended" },
    { requireMaterialization: false, phase: "completed" },
    { requireMaterialization: true, phase: "completion-appended" },
    { requireMaterialization: true, phase: "completed-materialization-confirmed" },
    { requireMaterialization: true, phase: "completed" },
  ] as const) {
    const fixture = createFixture();
    addDurableWorkflowOutcome(fixture, {
      outcome: "ended",
      requireMaterialization: closure.requireMaterialization,
      endpointPhase: closure.phase,
    });
    assert.deepEqual(
      await fullIssues(fixture),
      [],
      `${closure.requireMaterialization}:${closure.phase}`,
    );
  }

  const durableFinal = createFixture();
  addFrozenCurrentChildWorkflow(durableFinal, { finalIntent: "internal-workflow" });
  assert.deepEqual(
    await fullIssues(durableFinal),
    [],
    "final workflow checkpoint must be replayed from its internal phase intent",
  );

  for (const phase of ["verification-passed", "completion-appended"] as const) {
    const forged = createFixture();
    forgeFrozenWorkflowPhaseWithoutWitness(forged, phase);
    await assert.rejects(
      () => fullIssues(forged),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
      `${phase} requires its durable validation/pass/completion witnesses`,
    );
  }

  for (const correspondence of ["wrong", "out-of-order"] as const) {
    const changed = createFixture();
    const requested = addWorkflowRequest(changed, { projection: false });
    changed.connection.exec(
      "DROP TRIGGER lifecycle_workflow_generation_folds_insert_guard",
    );
    changed.connection.exec("PRAGMA foreign_keys = OFF");
    insertWorkflowProjection(changed, {
      projectId: PROJECT_ID,
      workflowId: correspondence === "wrong" ? uuid(89_997) : requested.workflowId,
      workflowGeneration: 1,
      sessionId: ROOT_ID,
      triggerEventPosition: correspondence === "wrong" ? 2n : 3n,
      rootCommandId: requested.commandId,
      evidenceWindowState: "open",
      replacementCheckpointVersion: 2,
      effectiveCheckpointVersion: 2,
      effectiveDraftSourceEventPosition: correspondence === "wrong" ? 2n : 3n,
      previousFingerprint: null,
    });
    changed.connection.exec("PRAGMA foreign_keys = ON");
    await assert.rejects(
      () => fullIssues(changed),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
      `workflow ${correspondence} projection row`,
    );
  }

  const legal = createFixture();
  addWorkflowRequest(legal);
  assert.deepEqual(await fullIssues(legal), []);

  const intentMutations: readonly {
    readonly label: string;
    readonly command?: Readonly<Record<string, unknown>>;
    readonly origin?: Readonly<Record<string, unknown>>;
  }[] = [
    { label: "expected branch", command: { expectedBranchRef: "refs/heads/foreign" } },
    { label: "idempotency", command: { idempotencyKey: "full-integrity/foreign" } },
    { label: "agent", command: { agentId: "agent-foreign" } },
    {
      label: "project",
      command: { expectedProjectId: uuid(98_001) },
      origin: { projectId: uuid(98_001) },
    },
    {
      label: "vault",
      command: { expectedVaultId: uuid(98_002) },
      origin: { vaultId: uuid(98_002) },
    },
    {
      label: "store",
      origin: { storeId: uuid(98_003) },
    },
    {
      label: "workspace",
      command: { expectedWorkspaceId: H64_B },
      origin: { workspaceId: H64_B },
    },
    { label: "namespace", origin: { clientNamespace: "foreign-tests" } },
    { label: "presenting actor", origin: { presentingActorRole: "maintenance" } },
    {
      label: "presenting client",
      origin: { presentingClientInstanceId: "client-foreign" },
    },
  ];
  for (const mutation of intentMutations) {
    const changed = createFixture();
    const { commandId } = addWorkflowRequest(changed);
    const rebuilt = requestWitnessWithOverrides(commandId, mutation);
    assert.doesNotThrow(
      () => decodeLifecycleIntentWitness(rebuilt),
      mutation.label,
    );
    changed.connection.exec("DROP TRIGGER events_no_update");
    changed.connection.prepare(`
      UPDATE events SET lifecycle_intent_json = $intent
      WHERE global_position = 2 AND command_event_index = 0
    `).run({ $intent: rebuilt });
    await assert.rejects(
      () => fullIssues(changed),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "INTEGRITY_FAILURE"
      ),
      mutation.label,
    );
  }

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

  const trailing = createFixture();
  trailing.connection.exec(
    "DROP TRIGGER lifecycle_workflow_generation_folds_insert_guard",
  );
  trailing.connection.exec("PRAGMA foreign_keys = OFF");
  insertWorkflowProjection(trailing, {
    projectId: PROJECT_ID,
    workflowId: uuid(89_998),
    workflowGeneration: 1,
    sessionId: ROOT_ID,
    triggerEventPosition: 2n,
    rootCommandId: uuid(39_998),
    evidenceWindowState: "open",
    replacementCheckpointVersion: 2,
    effectiveCheckpointVersion: 2,
    effectiveDraftSourceEventPosition: 2n,
    previousFingerprint: null,
  });
  trailing.connection.exec("PRAGMA foreign_keys = ON");
  await assert.rejects(
    () => fullIssues(trailing),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "INTEGRITY_FAILURE"
    ),
    "a workflow projection row beyond project event EOF is a trailing orphan",
  );
});

it("full integrity collapses schema 2 same-generation cancel and abandon once", async () => {
  const inspectionFixture = createFixture();
  addFrozenCarryForwardWorkflow(inspectionFixture);
  const childHeadInspections = await countChildHeadInspections(async () => {
    assert.deepEqual(await fullIssues(inspectionFixture), []);
  });
  assert.equal(
    childHeadInspections,
    0,
    "checkpoint reconstruction must not scan any project-wide child-head iterator",
  );

  const collapsed = createFixture();
  addSchema2CollapsedCancel(collapsed);
  assert.deepEqual(await fullIssues(collapsed), []);

  const abandoned = createFixture();
  addSchema2CollapsedAbandon(abandoned);
  assert.deepEqual(await fullIssues(abandoned), []);

  const nullIdentity = createFixture();
  addNullIdentityAbandon(nullIdentity);
  assert.deepEqual(await fullIssues(nullIdentity), []);

  const successor = createFixture();
  addLaterGenerationAfterCollapsedCancel(successor);
  assert.deepEqual(await fullIssues(successor), []);

  const interleaved = createFixture();
  addInterleavedCollapsedWorkflows(interleaved);
  assert.deepEqual(await fullIssues(interleaved), []);
});
