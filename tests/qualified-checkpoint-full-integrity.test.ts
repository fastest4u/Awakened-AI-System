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
  referenceAdvanceReportIndexFingerprint,
  referenceReportIndexGenesisFingerprint,
  referenceReportItemSetFingerprint,
  referenceReportWitnessFingerprint,
  referenceWorkflowGenerationFingerprint,
} from "./support/lifecycle-projection-reference.js";
import {
  childDispositionFixture,
  childReportFixture,
  lifecycleEvent,
  qualifiedCheckpointFixture,
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
  readonly sessionId?: string;
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
    projectId: PROJECT_ID,
    storeId: STORE_ID,
    sessionId: input.sessionId ?? ROOT_ID,
    adapterSessionId: ADAPTER_ID,
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
  const canonicalPayload = canonicalJson(input.payload);
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
    fixture.connection.prepare(`
      UPDATE session_evidence_coverage
      SET last_ordinal = 1,
          highest_contiguous_ordinal = 1,
          fingerprint_key_id = 'key-b',
          coverage_fingerprint_key_id = 'key-b',
          coverage_fingerprint_value = $coverageFingerprint,
          latest_batch_id = $batchId,
          latest_batch_event_position = 3,
          updated_at = $now
      WHERE project_id = $projectId
        AND session_id = $sessionId
        AND adapter_session_id = $adapterSessionId
    `).run({
      $batchId: ROTATED_BATCH_ID,
      $coverageFingerprint: ROTATED_COVERAGE_FINGERPRINT,
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
  },
): void {
  const targetActorRole = input.targetActorRole ?? "primary";
  const targetClientInstanceId = input.targetClientInstanceId
    ?? "client-full-integrity";
  const command = {
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
  } as const;
  const intent = buildLifecycleIntentWitness(command as never, {
    authorizationKind: "protected",
    authorizationSessionId: input.sessionId,
    targetSessionId: input.sessionId,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    capabilityKind: input.parentSessionId === null
      ? "root-session-handle"
      : "child-session-handle",
    capabilityGeneration: "1",
    presentingActorRole: "primary",
    presentingClientInstanceId: "client-full-integrity",
    targetActorRole,
    targetClientInstanceId,
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  });
  rawEvent(fixture.connection, {
    globalPosition: input.checkpointEventPosition,
    streamId: `session/${input.sessionId}`,
    streamVersion: input.streamVersion,
    eventType: "SessionCheckpointRecorded",
    eventSchemaVersion: 2,
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
    checkpointVersion: 2,
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
    command_type: "record-checkpoint",
    command_hash: commandHash(command),
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
    lifecycle_authorization_kind: "protected",
    authorization_proof_version: 1,
    authorization_proof_nonce: uuid(97_000 + Number(input.checkpointEventPosition)),
    authorization_proof_digest: H64,
    authorization_approval_id: null,
    authorization_approval_digest: null,
    authorization_session_id: input.sessionId,
    target_session_id: input.sessionId,
    presenting_actor_role: "primary",
    presenting_client_instance_id: "client-full-integrity",
    target_actor_role: targetActorRole,
    target_client_instance_id: targetClientInstanceId,
    internal_workflow_id: null,
    internal_workflow_generation: null,
    internal_planned_work_id: null,
    internal_claim_owner_id: null,
    internal_claim_token: null,
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
    readonly trapDml?: boolean;
    readonly closeFailureKind?: ReplayKind;
    readonly reuseMutableRawRows?: boolean;
  } = {},
): {
  readonly connection: SqliteConnection;
  readonly counts: ReadonlyMap<ReplayKind, {
    readonly prepares: number;
    readonly iterates: number;
    readonly visits: number;
    readonly closes: number;
  }>;
  readonly closeOrder: readonly ReplayKind[];
} {
  const mutable = new Map<ReplayKind, {
    prepares: number;
    iterates: number;
    visits: number;
    closes: number;
  }>();
  const closeOrder: ReplayKind[] = [];
  const kind = (sql: string): ReplayKind | null => {
    const match = /lifecycle-full:(event|child-fold|workflow-fold|coverage-transition|immutable-ordinal|pre-index|endpoint)/
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
      exec(sql) {
        if (options.trapDml === true && /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql)) {
          throw new Error("TASK_12J_DML_TRAP");
        }
        connection.exec(sql);
      },
      prepare(sql) {
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
        if (replayKind === null) return connection.prepare(sql);
        entry(replayKind).prepares += 1;
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
            const iterator = statement.iterate(params);
            const reused: Record<string, SqliteValue> = {};
            return {
              next() {
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
): string {
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
      requestVersion: 2,
      sessionId,
      childEndPolicy: "require-completed",
      finalCheckpoint: checkpointDraft(),
      validationProfileIds: [],
      requestedQualityThreshold: 0,
      requireFullEvidence: false,
      requireMaterialization: false,
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
  rawEvent(fixture.connection, {
    globalPosition: 4n,
    streamId: `session/${ROOT_ID}`,
    streamVersion: 4n,
    eventType: "SessionEndRequested",
    eventSchemaVersion: 2,
    sessionId: ROOT_ID,
    parentSessionId: null,
    commandId,
    idempotencyKey: "full-integrity/end-request/2",
    lifecycleIntent: requestWitness(commandId),
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

function addFrozenCurrentChildWorkflow(fixture: Fixture): void {
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
  const checkpointCommand = {
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
    command_type: "record-checkpoint",
    command_hash: commandHash(checkpointCommand),
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
    lifecycle_authorization_kind: "protected",
    authorization_proof_version: 1,
    authorization_proof_nonce: uuid(99_021),
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
    triggering_event_position: 3,
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
    evidence_frozen_checkpoint_event_position: 4,
    evidence_frozen_generation: 1,
    evidence_window_state: "sealed",
    final_ending_scope_bindings_json: canonicalJson([binding]),
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
    coordinator_attempt_count: 0,
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

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("full integrity advances each qualified coverage row exactly once", async () => {
  const fixture = createFixture();
  addCoverage(fixture);
  const observed = observedReplayConnection(fixture.connection, {
    trapLegacy: true,
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
    ["endpoint", 1],
  ]);
  for (const [kind, visits] of expectedVisits) {
    assert.deepEqual(observed.counts.get(kind), {
      prepares: kind === "pre-index" || kind === "endpoint" ? 3 : 1,
      iterates: kind === "pre-index" || kind === "endpoint" ? 3 : 1,
      visits,
      closes: kind === "pre-index" || kind === "endpoint" ? 0 : 1,
    }, kind);
  }

  const deep = createFixture();
  addCoverage(deep);
  addZeroNewCoverage(deep);
  const observedDeep = observedReplayConnection(deep.connection, {
    trapLegacy: true,
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
});

it("full integrity reconstructs version 2 checkpoints and frozen snapshots at their historical bases", async () => {
  const frozen = createFixture();
  addFrozenCurrentChildWorkflow(frozen);
  assert.deepEqual(await fullIssues(frozen), []);

  const carried = createFixture();
  addFrozenCarryForwardWorkflow(carried);
  assert.deepEqual(await fullIssues(carried), []);

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
    assert.ok(
      (await fullIssues(changed)).includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
      mutation.column,
    );
  }

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
  assert.ok(
    (await fullIssues(transferAlias))
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
    "transfer event alias",
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
  assert.ok(
    (await fullIssues(claimPayloadMutation))
      .includes("LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH"),
    "claim previous-child provenance",
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
  addRotatedCoverage(unavailable);
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
  assert.deepEqual(calls, ["key-b", "key-a"]);
  assert.equal(persistentSnapshot(unavailable.connection), unavailableBefore);

  const invalidStatus = createFixture();
  addCoverage(invalidStatus);
  addRotatedCoverage(invalidStatus);
  const invalidObserved = observedReplayConnection(invalidStatus.connection);
  await assert.rejects(
    () => new LifecycleIntegrityService(invalidObserved.connection, {
      async status(keyId) {
        return (keyId === "key-a" ? "unknown" : "available") as never;
      },
      async fingerprint(keyId, bytes) { return testProviderFingerprint(keyId, bytes); },
    }).fullCheckAsync(invalidStatus.context, { add() {} }),
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

  const originalWins = createFixture();
  addCoverage(originalWins);
  addRotatedCoverage(originalWins);
  const closeFailure = observedReplayConnection(originalWins.connection, {
    closeFailureKind: "immutable-ordinal",
  });
  await assert.rejects(
    () => new LifecycleIntegrityService(closeFailure.connection, {
      async status(keyId) {
        return keyId === "key-a" ? "unavailable" : "available";
      },
      async fingerprint(keyId, bytes) { return testProviderFingerprint(keyId, bytes); },
    }).fullCheckAsync(originalWins.context, { add() {} }),
    (error: unknown) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE"
    ),
  );

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
  const fingerprintObserved = observedReplayConnection(rejectedFingerprint.connection);
  await assert.rejects(
    () => new LifecycleIntegrityService(fingerprintObserved.connection, {
      async status() { return "available"; },
      async fingerprint() { throw new Error("provider-fingerprint-rejected"); },
    }).fullCheckAsync(rejectedFingerprint.context, { add() {} }),
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
  await assert.rejects(
    () => new LifecycleIntegrityService(malformedObserved.connection, provider)
      .fullCheckAsync(malformedLookahead.context, { add() {} }),
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
  assert.equal(persistentSnapshot(malformedLookahead.connection), malformedBefore);
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
});

it("full integrity collapses schema 2 same-generation cancel and abandon once", async () => {
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
