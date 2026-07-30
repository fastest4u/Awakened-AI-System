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
  qualifiedCheckpointFixture,
} from "./support/lifecycle-fixtures.js";
import {
  referenceCheckpointFingerprint,
  referenceMinimumCheckpointUpperBound,
  referenceMinimumFinalEndingScopeBindingsUpperBound,
} from "./support/qualified-checkpoint-reference.js";

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
    correlation_id: uuid(20_000 + offset),
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
    lifecycle_intent_json: null,
  });
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
  readonly writes: () => number;
} {
  let ordinalReads = 0;
  let frameElementReads = 0;
  let fullStreamFolds = 0;
  let writes = 0;
  const inspect = (sql: string): void => {
    if (/session_evidence_fingerprints/i.test(sql)) ordinalReads += 1;
    if (/json_(?:each|tree)\s*\([^)]*frames/i.test(sql)) frameElementReads += 1;
    if (
      /FROM\s+events/i.test(sql)
      && /WHERE\s+project_id\s*=\s*\$projectId\s+AND\s+stream_id\s*=\s*\$streamId/i.test(sql)
      && /ORDER\s+BY\s+stream_version/i.test(sql)
    ) fullStreamFolds += 1;
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
  const transferred = childAuthority(CHILD_ID, 4n, {
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
    terminal_event_position: 4,
    terminal_event_type: "ChildWorkTransferCreated",
    terminal_at: NOW,
  });
  rawInsert(fixture.connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: `session/${CHILD_ID}`,
    stream_type: "session",
    current_version: 3,
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
    payload: { authorityCommitment: H64 },
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
    created_event_position: 4,
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
    lastEventPosition: "4",
    streamVersion: "3",
    checkpointId,
    checkpointEventPosition: "3",
    transferTicketId: ticketId,
    transferTicketEventPosition: "4",
  };
  const rootCheckpointId = uuid(88_012);
  const rootCheckpoint = {
    ...qualifiedCheckpointFixture({
      checkpointId: rootCheckpointId as never,
      sessionId: ROOT_ID as never,
      baseEventPosition: 1,
      checkpointEventPosition: 5,
    }),
    childSummaries: [{
      childSessionId: CHILD_ID,
      state: "transferred",
      lastEventPosition: "4",
      streamVersion: "3",
      latestCheckpointId: checkpointId,
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
  return {
    fixture,
    binding,
    rootCheckpoint: rootCheckpoint as Record<string, unknown>,
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
      payload: { authorityCommitment: childRow.authority_commitment },
    });
    rawInsert(fixture.connection, "session_authority", childRow);
    bindings.push({ bindingKind: "current-child", childSessionId });
  }
  return bindings;
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
    payload: { authorityCommitment: childRow.authority_commitment },
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
    UPDATE events SET payload_json = $payload WHERE global_position = 5
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
    payload: { authorityCommitment: childRow.authority_commitment },
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
