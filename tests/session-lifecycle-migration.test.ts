import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";

const NOW = "2026-07-14T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const ROOT_ID = "44444444-4444-4444-8444-444444444444";
const CHILD_ID = "55555555-5555-4555-8555-555555555555";
const ADAPTER_ID = "66666666-6666-4666-8666-666666666666";
const H64 = "a".repeat(64);
const H64_B = "b".repeat(64);
const driver = new NodeSqliteDriver({ DatabaseSync });
const connections: SqliteConnection[] = [];
const roots: string[] = [];

function insert(
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

function currentConnection(): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "session-lifecycle-migration-"));
  roots.push(root);
  const connection = driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: 1_000,
  });
  connections.push(connection);
  new MigrationRunner().apply(
    connection,
    PROJECT_STORE_MIGRATIONS,
    NOW,
    { kind: "bootstrap-empty" },
  );
  insert(connection, "project_meta", {
    singleton: 1,
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    schema_version: 2,
    created_at: NOW,
  });
  insert(connection, "maintenance_state", {
    singleton: 1,
    epoch: 0,
    mode: "idle",
    owner_id: null,
    fencing_token: 0,
    lease_expires_at: null,
    requested_at: null,
  });
  return connection;
}

function seedSessionEvent(
  connection: SqliteConnection,
  sessionId: string,
  position: number,
  eventType: string,
): void {
  const streamId = `session/${sessionId}`;
  insert(connection, "streams", {
    project_id: PROJECT_ID,
    stream_id: streamId,
    stream_type: "session",
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  insert(connection, "events", {
    global_position: position,
    event_id: `${position.toString(16).padStart(8, "0")}-0000-4000-8000-${position.toString(16).padStart(12, "0")}`,
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: "workspace-1",
    branch_scope_id: null,
    branch_ref: null,
    stream_id: streamId,
    stream_type: "session",
    stream_version: 1,
    event_type: eventType,
    event_schema_version: 1,
    session_id: sessionId,
    parent_session_id: sessionId === ROOT_ID ? null : ROOT_ID,
    actor_role: "primary",
    agent_id: "agent-1",
    client_instance_id: "client-1",
    correlation_id: `correlation-${position}`,
    causation_id: null,
    command_id: `command-${position}`,
    idempotency_key: `idempotency-${position}`,
    command_event_index: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: "{}",
    payload_hash: H64,
    previous_global_hash: "0".repeat(64),
    event_hash: H64_B,
  });
}

function seedAdditionalSessionEvent(
  connection: SqliteConnection,
  sessionId: string,
  position: number,
  streamVersion: number,
  eventType: string,
): void {
  const streamId = `session/${sessionId}`;
  connection.prepare(`
    UPDATE streams SET current_version = $version, updated_at = $updatedAt
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $version: streamVersion,
    $updatedAt: NOW,
    $projectId: PROJECT_ID,
    $streamId: streamId,
  });
  insert(connection, "events", {
    global_position: position,
    event_id: `${position.toString(16).padStart(8, "0")}-0000-4000-8000-${position.toString(16).padStart(12, "0")}`,
    project_id: PROJECT_ID,
    vault_id: VAULT_ID,
    store_id: STORE_ID,
    workspace_id: "workspace-1",
    branch_scope_id: null,
    branch_ref: null,
    stream_id: streamId,
    stream_type: "session",
    stream_version: streamVersion,
    event_type: eventType,
    event_schema_version: 1,
    session_id: sessionId,
    parent_session_id: sessionId === ROOT_ID ? null : ROOT_ID,
    actor_role: "primary",
    agent_id: "agent-1",
    client_instance_id: "client-1",
    correlation_id: `correlation-${position}`,
    causation_id: null,
    command_id: `command-${position}`,
    idempotency_key: `idempotency-${position}`,
    command_event_index: 0,
    occurred_at: NOW,
    recorded_at: NOW,
    visibility_scope: "session",
    confidence: "high",
    verification_status: "verified",
    source_refs_json: "[]",
    evidence_refs_json: "[]",
    evidence_digests_json: "[]",
    payload_json: "{}",
    payload_hash: H64,
    previous_global_hash: H64_B,
    event_hash: H64,
  });
}

function rootAuthority(
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
    project_id: PROJECT_ID,
    session_id: ROOT_ID,
    stream_id: `session/${ROOT_ID}`,
    session_kind: "root",
    parent_session_id: null,
    workspace_id: "workspace-1",
    client_namespace: "tests",
    semantic_state: "active",
    owner_generation: 1,
    child_capability_generation: null,
    direct_access_enabled: 0,
    continuity_fingerprint_algorithm: "hmac-sha256",
    continuity_fingerprint_schema_version: 1,
    continuity_fingerprint_key_id: "continuity-key-1",
    continuity_fingerprint_domain: "pm-continuity-v1",
    continuity_fingerprint: H64,
    root_handle_capability_version: 1,
    root_handle_key_id: "capability-key-1",
    root_handle_issue_nonce: H64,
    root_handle_issued_at: NOW,
    root_handle_policy_code: "root-default-v1",
    root_handle_expiry_kind: "until-revoked",
    root_handle_expires_at: null,
    root_handle_actor_role: "primary",
    root_handle_client_instance_id: "client-root",
    root_handle_verifier: H64,
    root_handle_issuance_id: "77777777-7777-4777-8777-777777777777",
    resume_token_capability_version: 1,
    resume_token_key_id: "capability-key-1",
    resume_token_issue_nonce: H64_B,
    resume_token_issued_at: NOW,
    resume_token_policy_code: "resume-default-v1",
    resume_token_expiry_kind: "until-revoked",
    resume_token_expires_at: null,
    resume_token_actor_role: "primary",
    resume_token_verifier: H64_B,
    resume_token_issuance_id: "88888888-8888-4888-8888-888888888888",
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
}

function childAuthority(
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  const root = rootAuthority();
  const rootOnlyNulls = [
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
  ];
  for (const column of rootOnlyNulls) root[column] = null;
  return {
    ...root,
    session_id: CHILD_ID,
    stream_id: `session/${CHILD_ID}`,
    session_kind: "child",
    parent_session_id: ROOT_ID,
    owner_generation: null,
    child_capability_generation: 1,
    direct_access_enabled: 1,
    child_handle_capability_version: 1,
    child_handle_key_id: "capability-key-1",
    child_handle_issue_nonce: H64,
    child_handle_issued_at: NOW,
    child_handle_policy_code: "child-default-v1",
    child_handle_expiry_kind: "absolute",
    child_handle_expires_at: "2026-07-14T01:00:00.000Z",
    child_handle_actor_role: "untrusted",
    child_handle_client_instance_id: "client-child",
    child_handle_verifier: H64,
    child_handle_issuance_id: "99999999-9999-4999-8999-999999999999",
    authority_event_position: 2,
    ...overrides,
  };
}

function seedAuthorities(connection: SqliteConnection): void {
  seedSessionEvent(connection, ROOT_ID, 1, "SessionStarted");
  seedSessionEvent(connection, CHILD_ID, 2, "ChildSessionStarted");
  insert(connection, "session_authority", rootAuthority());
  insert(connection, "session_authority", childAuthority());
}

function legacyCommand(
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
    project_id: PROJECT_ID,
    idempotency_key: `legacy-${String(overrides.command_id ?? "command")}`,
    command_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    command_type: "record",
    command_hash: H64,
    workspace_head_commit: null,
    outbox_order_json: "[]",
    state: "committed",
    first_global_position: 1,
    last_global_position: 1,
    final_stream_version: 1,
    event_ids_json: "[]",
    response_json: "{}",
    response_hash: H64_B,
    committed_at: NOW,
    ...overrides,
  };
}

function lifecycleWorkflow(
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
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
    ...overrides,
  };
}

function lifecycleOutbox(
  overrides: Readonly<Record<string, SqliteValue>> = {},
): Record<string, SqliteValue> {
  return {
    project_id: PROJECT_ID,
    target_key: `lifecycle-log/${ROOT_ID}/1`,
    event_position: 1,
    kind: "materialize-lifecycle-log",
    payload_json: "{}",
    content_hash: H64,
    status: "pending",
    attempt_count: 0,
    claim_owner: null,
    claim_token: null,
    claim_expires_at: null,
    created_at: NOW,
    updated_at: NOW,
    session_id: ROOT_ID,
    origin_kind: "workflow",
    workflow_id: `session-end/${ROOT_ID}`,
    workflow_generation: 1,
    artifact_kind: "lifecycle-log",
    artifact_path: `05_Agent_Session_Logs/2026-07-14-session-${ROOT_ID}.md`,
    materialization_revision: 1,
    expected_prior_fingerprint: null,
    next_fingerprint: H64_B,
    fingerprint_algorithm: "hmac-sha256",
    fingerprint_schema_version: 1,
    fingerprint_key_id: "materialization-key-1",
    fingerprint_domain: "pm-materialization-v1",
    failure_class: null,
    safe_error_code: null,
    next_attempt_at: null,
    ...overrides,
  };
}

function validationPlan(index: number, profileId = `profile-${index}`): Record<string, unknown> {
  const hex = index.toString(16).padStart(12, "0");
  return {
    commandId: `10000000-0000-4000-8000-${hex}`,
    idempotencyKey: `validation/${index}`,
    profileId,
    profileVersion: 1,
    resultId: `20000000-0000-4000-8000-${hex}`,
    runId: `30000000-0000-4000-8000-${hex}`,
  };
}

function normalizedSql(sql: unknown): string {
  if (typeof sql !== "string") assert.fail("schema SQL must be available");
  return sql.replace(/\s+/g, " ").trim();
}

function foreignKeyInventory(
  connection: SqliteConnection,
  table: string,
): readonly { table: string; from: readonly string[]; to: readonly string[] }[] {
  const grouped = new Map<number, { table: string; from: string[]; to: string[] }>();
  for (const row of connection.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
    const id = Number(row.id);
    const item = grouped.get(id) ?? { table: String(row.table), from: [], to: [] };
    item.from[Number(row.seq)] = String(row.from);
    item.to[Number(row.seq)] = String(row.to);
    grouped.set(id, item);
  }
  return [...grouped.values()].sort((left, right) =>
    `${left.table}:${left.from.join(",")}`.localeCompare(`${right.table}:${right.from.join(",")}`));
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("0002-session-lifecycle structural contract", () => {
  it("creates every strict lifecycle table and exact ALTER inventory", () => {
    const connection = currentConnection();
    const tableRows = connection.prepare("PRAGMA table_list").all();
    assert.deepEqual(
      connection.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name NOT GLOB 'sqlite_*'
        ORDER BY name
      `).all().map((row) => row.name),
      [
        "branch_scopes",
        "child_transfer_tickets",
        "command_dedup",
        "events",
        "executor_leases",
        "lifecycle_approval_consumptions",
        "lifecycle_validation_results",
        "maintenance_acknowledgements",
        "maintenance_required_executors",
        "maintenance_state",
        "outbox",
        "project_meta",
        "schema_migrations",
        "session_authority",
        "session_evidence_coverage",
        "session_evidence_fingerprints",
        "session_leases",
        "streams",
        "workflow_instances",
      ],
    );
    for (const table of [
      "session_authority",
      "session_leases",
      "session_evidence_coverage",
      "session_evidence_fingerprints",
      "lifecycle_approval_consumptions",
      "child_transfer_tickets",
      "lifecycle_validation_results",
    ]) {
      assert.equal(
        tableRows.find((row) => row.name === table)?.strict,
        1n,
        `${table} must be STRICT`,
      );
    }

    const lifecycleColumns: Readonly<Record<string, readonly string[]>> = {
      session_authority: [
        "project_id", "session_id", "stream_id", "session_kind", "parent_session_id",
        "workspace_id", "client_namespace", "semantic_state", "owner_generation",
        "child_capability_generation", "direct_access_enabled",
        "continuity_fingerprint_algorithm", "continuity_fingerprint_schema_version",
        "continuity_fingerprint_key_id", "continuity_fingerprint_domain",
        "continuity_fingerprint", "root_handle_capability_version", "root_handle_key_id",
        "root_handle_issue_nonce", "root_handle_issued_at", "root_handle_policy_code",
        "root_handle_expiry_kind", "root_handle_expires_at", "root_handle_actor_role",
        "root_handle_client_instance_id", "root_handle_verifier", "root_handle_issuance_id",
        "resume_token_capability_version", "resume_token_key_id", "resume_token_issue_nonce",
        "resume_token_issued_at", "resume_token_policy_code", "resume_token_expiry_kind",
        "resume_token_expires_at", "resume_token_actor_role", "resume_token_verifier",
        "resume_token_issuance_id", "child_handle_capability_version", "child_handle_key_id",
        "child_handle_issue_nonce", "child_handle_issued_at", "child_handle_policy_code",
        "child_handle_expiry_kind", "child_handle_expires_at", "child_handle_actor_role",
        "child_handle_client_instance_id", "child_handle_verifier", "child_handle_issuance_id",
        "authority_commitment", "authority_event_position", "latest_checkpoint_id",
        "latest_checkpoint_event_position", "latest_checkpoint_fingerprint",
        "checkpoint_required_reason", "checkpoint_required_event_position",
        "revocation_reason_code", "revocation_event_position", "revoked_at",
        "terminal_event_position", "terminal_event_type", "terminal_at", "created_at", "updated_at",
      ],
      session_leases: [
        "project_id", "session_id", "owner_generation", "owner_client_instance_id",
        "acquired_at", "renewed_at", "last_observed_at_ms", "expires_at", "released_at",
      ],
      session_evidence_coverage: [
        "project_id", "session_id", "adapter_session_id", "capture_mode", "first_ordinal",
        "last_ordinal", "highest_contiguous_ordinal", "missing_intervals_json",
        "fingerprint_algorithm", "fingerprint_schema_version", "fingerprint_key_id",
        "fingerprint_domain", "latest_batch_id", "latest_batch_event_position",
        "created_at", "updated_at",
      ],
      session_evidence_fingerprints: [
        "project_id", "session_id", "adapter_session_id", "ordinal", "frame_id", "source_kind",
        "observed_at", "fingerprint_algorithm", "fingerprint_schema_version", "fingerprint_key_id",
        "fingerprint_domain", "fingerprint_value", "batch_id", "recorded_event_position", "created_at",
      ],
      lifecycle_approval_consumptions: [
        "project_id", "approval_id", "nonce_digest", "session_id", "action", "command_id",
        "target_actor_role", "target_client_instance_id", "consumed_event_position", "consumed_at",
      ],
      child_transfer_tickets: [
        "project_id", "transfer_ticket_id", "source_parent_session_id", "source_child_session_id",
        "source_assignment_json", "source_scope_json", "checkpoint_id", "follow_ups_json",
        "source_state_json", "lineage_json", "created_event_position", "created_at",
        "claimed_by_root_session_id", "claimed_child_session_id", "claimed_event_position", "claimed_at",
      ],
      lifecycle_validation_results: [
        "project_id", "vault_id", "store_id", "workspace_id", "session_id", "result_id",
        "validation_result_version", "workflow_id", "workflow_generation", "profile_id",
        "profile_version", "profile_configuration_hash", "run_id", "runner_id",
        "final_checkpoint_id", "final_checkpoint_fingerprint", "validation_start_scope_version",
        "validation_start_project_id", "validation_start_workspace_id", "validation_start_branch_ref",
        "validation_start_head_commit", "validation_start_dirty_fingerprint",
        "validation_completion_scope_version", "validation_completion_project_id",
        "validation_completion_workspace_id", "validation_completion_branch_ref",
        "validation_completion_head_commit", "validation_completion_dirty_fingerprint",
        "started_at", "completed_at", "status", "exit_classification", "redacted_summary",
        "output_fingerprint_algorithm", "output_fingerprint_schema_version",
        "output_fingerprint_key_id", "output_fingerprint_domain", "output_fingerprint_value",
        "artifact_references_json", "fresh", "recorded_event_position", "created_at",
      ],
    };
    for (const [table, columns] of Object.entries(lifecycleColumns)) {
      assert.deepEqual(
        connection.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
        columns,
        `${table} column inventory`,
      );
    }

    const alteredColumns = (table: string, originalCount: number): string[] =>
      connection.prepare(`PRAGMA table_info(${table})`).all()
        .slice(originalCount)
        .map((row) => String(row.name));
    assert.deepEqual(alteredColumns("command_dedup", 15), [
      "lifecycle_authorization_kind",
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
    ]);
    assert.deepEqual(alteredColumns("workflow_instances", 11), [
      "session_id",
      "triggering_event_position",
      "expected_authority_commitment",
      "coordinator_owner_id",
      "coordinator_claim_token",
      "coordinator_claim_expires_at",
      "coordinator_attempt_count",
      "coordinator_failure_class",
      "coordinator_error_code",
      "coordinator_next_attempt_at",
      "validation_attempt_plan_generation",
      "validation_attempt_plans_json",
    ]);
    assert.deepEqual(alteredColumns("outbox", 13), [
      "session_id",
      "origin_kind",
      "workflow_id",
      "workflow_generation",
      "artifact_kind",
      "artifact_path",
      "materialization_revision",
      "expected_prior_fingerprint",
      "next_fingerprint",
      "fingerprint_algorithm",
      "fingerprint_schema_version",
      "fingerprint_key_id",
      "fingerprint_domain",
      "failure_class",
      "safe_error_code",
      "next_attempt_at",
    ]);

    assert.deepEqual(
      connection.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name NOT GLOB 'sqlite_*'
        ORDER BY name
      `).all().map((row) => row.name),
      [
        "branch_scopes_active_ref",
        "branch_scopes_detached_head",
        "command_dedup_event_range",
        "events_project_hash_chain",
        "events_project_idempotency",
        "events_project_position",
        "events_stream_range",
        "outbox_delivery_order",
        "outbox_lifecycle_claim_recovery",
        "outbox_lifecycle_latest_artifact",
        "outbox_lifecycle_target_revision",
        "session_authority_nonterminal_root_continuity",
        "session_authority_parent_terminal",
        "session_authority_safe_resume",
        "session_leases_one_unreleased",
        "workflow_instances_lifecycle_recovery",
      ],
    );
    const expectedIndexSql: Readonly<Record<string, string>> = {
      session_authority_nonterminal_root_continuity:
        "CREATE UNIQUE INDEX session_authority_nonterminal_root_continuity ON session_authority(project_id, workspace_id, client_namespace, continuity_fingerprint) WHERE session_kind = 'root' AND terminal_event_position IS NULL",
      session_authority_parent_terminal:
        "CREATE INDEX session_authority_parent_terminal ON session_authority(project_id, parent_session_id, terminal_event_position, session_id)",
      session_authority_safe_resume:
        "CREATE INDEX session_authority_safe_resume ON session_authority(project_id, workspace_id, client_namespace, semantic_state, updated_at, session_id) WHERE session_kind = 'root' AND terminal_event_position IS NULL",
      session_leases_one_unreleased:
        "CREATE UNIQUE INDEX session_leases_one_unreleased ON session_leases(project_id, session_id) WHERE released_at IS NULL",
      workflow_instances_lifecycle_recovery:
        "CREATE INDEX workflow_instances_lifecycle_recovery ON workflow_instances(project_id, state, phase, triggering_event_position, workflow_id) WHERE session_id IS NOT NULL",
      outbox_lifecycle_target_revision:
        "CREATE UNIQUE INDEX outbox_lifecycle_target_revision ON outbox(project_id, session_id, artifact_kind, materialization_revision) WHERE session_id IS NOT NULL",
      outbox_lifecycle_claim_recovery:
        "CREATE INDEX outbox_lifecycle_claim_recovery ON outbox(project_id, status, next_attempt_at, event_position, workflow_id, target_key) WHERE session_id IS NOT NULL",
      outbox_lifecycle_latest_artifact:
        "CREATE INDEX outbox_lifecycle_latest_artifact ON outbox(project_id, session_id, artifact_kind, materialization_revision DESC) WHERE session_id IS NOT NULL",
    };
    for (const [name, expected] of Object.entries(expectedIndexSql)) {
      const row = connection.prepare(`
        SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = $name
      `).get({ $name: name });
      assert.equal(normalizedSql(row?.sql), expected, name);
    }

    assert.deepEqual(
      connection.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name
      `).all().map((row) => row.name),
      [
        "child_transfer_tickets_insert_guard",
        "child_transfer_tickets_update_guard",
        "command_dedup_lifecycle_insert_guard",
        "command_dedup_no_delete",
        "command_dedup_no_update",
        "events_identity_guard",
        "events_no_delete",
        "events_no_update",
        "lifecycle_approval_consumptions_no_delete",
        "lifecycle_approval_consumptions_no_update",
        "lifecycle_validation_results_insert_guard",
        "lifecycle_validation_results_no_delete",
        "lifecycle_validation_results_no_update",
        "outbox_lifecycle_insert_guard",
        "outbox_lifecycle_planned_immutable",
        "outbox_lifecycle_update_guard",
        "project_meta_identity_immutable",
        "project_meta_no_delete",
        "project_meta_schema_version_monotonic",
        "schema_migrations_no_delete",
        "schema_migrations_no_update",
        "session_authority_insert_guard",
        "session_authority_lease_update_guard",
        "session_authority_lineage_immutable",
        "session_authority_update_guard",
        "session_evidence_coverage_insert_guard",
        "session_evidence_coverage_update_guard",
        "session_evidence_fingerprints_no_delete",
        "session_evidence_fingerprints_no_update",
        "session_leases_insert_guard",
        "session_leases_lineage_immutable",
        "session_leases_release_immutable",
        "session_leases_update_guard",
        "workflow_instances_generation_guard",
        "workflow_instances_lifecycle_insert_guard",
        "workflow_instances_lifecycle_update_guard",
        "workflow_instances_validation_plan_immutable",
      ],
    );

    const expectedForeignKeys: Readonly<Record<
      string,
      readonly { table: string; from: readonly string[]; to: readonly string[] }[]
    >> = {
      session_authority: [
        { table: "events", from: ["authority_event_position"], to: ["global_position"] },
        { table: "events", from: ["checkpoint_required_event_position"], to: ["global_position"] },
        { table: "events", from: ["latest_checkpoint_event_position"], to: ["global_position"] },
        { table: "events", from: ["revocation_event_position"], to: ["global_position"] },
        { table: "events", from: ["terminal_event_position"], to: ["global_position"] },
        { table: "session_authority", from: ["project_id", "parent_session_id"], to: ["project_id", "session_id"] },
        { table: "streams", from: ["project_id", "stream_id"], to: ["project_id", "stream_id"] },
      ],
      session_leases: [
        { table: "session_authority", from: ["project_id", "session_id"], to: ["project_id", "session_id"] },
      ],
      session_evidence_coverage: [
        { table: "events", from: ["latest_batch_event_position"], to: ["global_position"] },
        { table: "session_authority", from: ["project_id", "session_id"], to: ["project_id", "session_id"] },
      ],
      session_evidence_fingerprints: [
        { table: "events", from: ["recorded_event_position"], to: ["global_position"] },
        { table: "session_evidence_coverage", from: ["project_id", "session_id", "adapter_session_id"], to: ["project_id", "session_id", "adapter_session_id"] },
      ],
      lifecycle_approval_consumptions: [
        { table: "events", from: ["consumed_event_position"], to: ["global_position"] },
        { table: "session_authority", from: ["project_id", "session_id"], to: ["project_id", "session_id"] },
      ],
      child_transfer_tickets: [
        { table: "events", from: ["claimed_event_position"], to: ["global_position"] },
        { table: "events", from: ["created_event_position"], to: ["global_position"] },
        { table: "session_authority", from: ["project_id", "claimed_by_root_session_id"], to: ["project_id", "session_id"] },
        { table: "session_authority", from: ["project_id", "claimed_child_session_id"], to: ["project_id", "session_id"] },
        { table: "session_authority", from: ["project_id", "source_child_session_id"], to: ["project_id", "session_id"] },
        { table: "session_authority", from: ["project_id", "source_parent_session_id"], to: ["project_id", "session_id"] },
      ],
      lifecycle_validation_results: [
        { table: "events", from: ["recorded_event_position"], to: ["global_position"] },
        { table: "session_authority", from: ["project_id", "session_id"], to: ["project_id", "session_id"] },
      ],
      command_dedup: [
        { table: "project_meta", from: ["project_id"], to: ["project_id"] },
      ],
      workflow_instances: [
        { table: "project_meta", from: ["project_id"], to: ["project_id"] },
      ],
      outbox: [
        { table: "events", from: ["event_position"], to: ["global_position"] },
        { table: "project_meta", from: ["project_id"], to: ["project_id"] },
      ],
    };
    for (const [table, expected] of Object.entries(expectedForeignKeys)) {
      assert.deepEqual(foreignKeyInventory(connection, table), expected, `${table} foreign keys`);
    }
    const validationSql = connection.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'lifecycle_validation_results'
    `).get()?.sql;
    assert.match(normalizedSql(validationSql), /FOREIGN KEY \(recorded_event_position\) REFERENCES events\(global_position\) DEFERRABLE INITIALLY DEFERRED/);
  });
});

describe("0002-session-lifecycle authority, lease, and evidence guards", () => {
  it("enforces complete root/child authority groups and immutable lineage", () => {
    const connection = currentConnection();
    seedSessionEvent(connection, ROOT_ID, 1, "SessionStarted");
    insert(connection, "session_authority", rootAuthority());

    seedSessionEvent(connection, CHILD_ID, 2, "ChildSessionStarted");
    assert.throws(
      () => insert(connection, "session_authority", childAuthority({
        child_handle_verifier: null,
      })),
      /SESSION_AUTHORITY_SHAPE_INVALID/,
    );
    assert.throws(
      () => insert(connection, "session_authority", childAuthority({
        parent_session_id: null,
      })),
      /SESSION_AUTHORITY_SHAPE_INVALID/,
    );
    assert.throws(
      () => connection.exec(`
        UPDATE session_authority SET workspace_id = 'other' WHERE session_id = '${ROOT_ID}'
      `),
      /SESSION_AUTHORITY_LINEAGE_IMMUTABLE/,
    );
    assert.throws(
      () => connection.exec(`
        UPDATE session_authority SET root_handle_issue_nonce = '${"A".repeat(64)}'
        WHERE session_id = '${ROOT_ID}'
      `),
      /SESSION_AUTHORITY_SHAPE_INVALID/,
    );
    assert.throws(
      () => connection.exec(`
        UPDATE session_authority SET root_handle_key_id = NULL
        WHERE session_id = '${ROOT_ID}'
      `),
      /SESSION_AUTHORITY_SHAPE_INVALID/,
    );
    assert.throws(
      () => connection.exec(`
        UPDATE session_authority SET latest_checkpoint_id = 'checkpoint-without-position'
        WHERE session_id = '${ROOT_ID}'
      `),
      /SESSION_AUTHORITY_SHAPE_INVALID/,
    );
    insert(connection, "session_authority", childAuthority());
    assert.throws(
      () => connection.exec(`
        UPDATE session_authority SET root_handle_key_id = 'forbidden-root-key'
        WHERE session_id = '${CHILD_ID}'
      `),
      /SESSION_AUTHORITY_SHAPE_INVALID/,
    );
    assert.throws(
      () => connection.exec(`
        UPDATE session_authority SET direct_access_enabled = 0
        WHERE session_id = '${CHILD_ID}'
      `),
      /SESSION_AUTHORITY_SHAPE_INVALID/,
    );
  });

  it("requires unreleased leases to match nonterminal root authority generation", () => {
    const connection = currentConnection();
    seedAuthorities(connection);
    const lease = {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      owner_generation: 1,
      owner_client_instance_id: "client-root",
      acquired_at: NOW,
      renewed_at: NOW,
      last_observed_at_ms: 1_783_987_200_000,
      expires_at: "2026-07-14T00:02:00.000Z",
      released_at: null,
    };
    insert(connection, "session_leases", lease);
    assert.throws(
      () => insert(connection, "session_leases", {
        ...lease,
        owner_generation: 2,
      }),
      /SESSION_LEASE_AUTHORITY_MISMATCH/,
    );
    assert.throws(
      () => insert(connection, "session_leases", {
        ...lease,
        session_id: CHILD_ID,
      }),
      /SESSION_LEASE_AUTHORITY_MISMATCH/,
    );
    assert.throws(
      () => connection.exec(`
        UPDATE session_authority SET owner_generation = 2 WHERE session_id = '${ROOT_ID}'
      `),
      /SESSION_AUTHORITY_LEASE_MISMATCH/,
    );
    connection.exec(`
      UPDATE session_leases SET released_at = '${NOW}'
      WHERE session_id = '${ROOT_ID}' AND owner_generation = 1
    `);
    connection.exec(`
      UPDATE session_authority SET owner_generation = 2 WHERE session_id = '${ROOT_ID}'
    `);
  });

  it("rejects 201 missing intervals and keeps evidence fingerprints immutable", () => {
    const connection = currentConnection();
    seedAuthorities(connection);
    const intervals = Array.from({ length: 201 }, (_, index) => [index * 2, index * 2]);
    assert.throws(
      () => insert(connection, "session_evidence_coverage", {
        project_id: PROJECT_ID,
        session_id: ROOT_ID,
        adapter_session_id: ADAPTER_ID,
        capture_mode: "coverage-only",
        first_ordinal: 0,
        last_ordinal: 400,
        highest_contiguous_ordinal: 0,
        missing_intervals_json: canonicalJson(intervals),
        fingerprint_algorithm: "hmac-sha256",
        fingerprint_schema_version: 1,
        fingerprint_key_id: "evidence-key-1",
        fingerprint_domain: "pm-evidence-frame-v1",
        latest_batch_id: "77777777-7777-4777-8777-777777777777",
        latest_batch_event_position: 1,
        created_at: NOW,
        updated_at: NOW,
      }),
      /EVIDENCE_COVERAGE_TOO_FRAGMENTED/,
    );
    insert(connection, "session_evidence_coverage", {
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
      fingerprint_key_id: "evidence-key-1",
      fingerprint_domain: "pm-evidence-frame-v1",
      latest_batch_id: "77777777-7777-4777-8777-777777777777",
      latest_batch_event_position: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    insert(connection, "session_evidence_fingerprints", {
      project_id: PROJECT_ID,
      session_id: ROOT_ID,
      adapter_session_id: ADAPTER_ID,
      ordinal: 0,
      frame_id: "88888888-8888-4888-8888-888888888888",
      source_kind: "model-turn",
      observed_at: NOW,
      fingerprint_algorithm: "hmac-sha256",
      fingerprint_schema_version: 1,
      fingerprint_key_id: "evidence-key-1",
      fingerprint_domain: "pm-evidence-frame-v1",
      fingerprint_value: H64,
      batch_id: "77777777-7777-4777-8777-777777777777",
      recorded_event_position: 1,
      created_at: NOW,
    });
    assert.throws(
      () => connection.exec(`
        UPDATE session_evidence_fingerprints SET fingerprint_value = '${H64_B}'
      `),
      /SESSION_EVIDENCE_FINGERPRINT_IMMUTABLE/,
    );
    assert.throws(
      () => connection.exec("DELETE FROM session_evidence_fingerprints"),
      /SESSION_EVIDENCE_FINGERPRINT_IMMUTABLE/,
    );
  });
});

describe("0002-session-lifecycle authorization, validation, workflow, and outbox guards", () => {
  it("keeps Version 1 authorization columns null and permits abandonment proof plus approval", () => {
    const connection = currentConnection();
    insert(connection, "command_dedup", legacyCommand());
    const row = connection.prepare(`
      SELECT * FROM command_dedup WHERE command_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    `).get()!;
    for (const column of [
      "lifecycle_authorization_kind",
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
    ]) assert.equal(row[column], null, column);

    insert(connection, "command_dedup", legacyCommand({
      idempotency_key: "abandon",
      command_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      command_type: "abandon-session",
      lifecycle_authorization_kind: "protected",
      authorization_proof_version: 1,
      authorization_proof_nonce: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      authorization_proof_digest: H64,
      authorization_approval_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      authorization_approval_digest: H64_B,
      authorization_session_id: ROOT_ID,
      target_session_id: ROOT_ID,
      presenting_actor_role: "primary",
      presenting_client_instance_id: "client-root",
      target_actor_role: "primary",
      target_client_instance_id: "client-root",
      internal_workflow_id: null,
      internal_workflow_generation: null,
      internal_planned_work_id: null,
      internal_claim_owner_id: null,
      internal_claim_token: null,
    }));
    assert.throws(
      () => insert(connection, "command_dedup", legacyCommand({
        idempotency_key: "invalid-protected",
        command_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        command_type: "checkpoint",
        lifecycle_authorization_kind: "protected",
        authorization_session_id: ROOT_ID,
        target_session_id: ROOT_ID,
        presenting_actor_role: "primary",
        presenting_client_instance_id: "client-root",
        target_actor_role: "primary",
        target_client_instance_id: "client-root",
      })),
      /COMMAND_AUTHORIZATION_INVALID/,
    );

    insert(connection, "command_dedup", legacyCommand({
      idempotency_key: "initial-authority",
      command_id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      command_type: "start-session",
      lifecycle_authorization_kind: "initial-authority",
      target_session_id: ROOT_ID,
      presenting_actor_role: "primary",
      presenting_client_instance_id: "client-root",
      target_actor_role: "primary",
      target_client_instance_id: "client-root",
    }));
    assert.throws(
      () => insert(connection, "command_dedup", legacyCommand({
        idempotency_key: "partial-proof",
        command_id: "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        command_type: "checkpoint",
        lifecycle_authorization_kind: "protected",
        authorization_proof_version: 1,
        authorization_session_id: ROOT_ID,
        target_session_id: ROOT_ID,
        presenting_actor_role: "primary",
        presenting_client_instance_id: "client-root",
        target_actor_role: "primary",
        target_client_instance_id: "client-root",
      })),
      /COMMAND_AUTHORIZATION_INVALID/,
    );
    assert.throws(
      () => insert(connection, "command_dedup", legacyCommand({
        idempotency_key: "both-witnesses-non-abandon",
        command_id: "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        command_type: "checkpoint",
        lifecycle_authorization_kind: "protected",
        authorization_proof_version: 1,
        authorization_proof_nonce: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        authorization_proof_digest: H64,
        authorization_approval_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        authorization_approval_digest: H64_B,
        authorization_session_id: ROOT_ID,
        target_session_id: ROOT_ID,
        presenting_actor_role: "primary",
        presenting_client_instance_id: "client-root",
        target_actor_role: "primary",
        target_client_instance_id: "client-root",
      })),
      /COMMAND_AUTHORIZATION_INVALID/,
    );
    insert(connection, "command_dedup", legacyCommand({
      idempotency_key: "internal-workflow",
      command_id: "44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      command_type: "record-validation-result",
      lifecycle_authorization_kind: "internal-workflow",
      authorization_session_id: ROOT_ID,
      target_session_id: ROOT_ID,
      presenting_actor_role: "maintenance",
      presenting_client_instance_id: "coordinator-1",
      target_actor_role: "primary",
      target_client_instance_id: "client-root",
      internal_workflow_id: `session-end/${ROOT_ID}`,
      internal_workflow_generation: 1,
      internal_planned_work_id: H64,
      internal_claim_owner_id: "coordinator-1",
      internal_claim_token: 1,
    }));
    assert.throws(
      () => insert(connection, "command_dedup", legacyCommand({
        idempotency_key: "internal-missing-claim",
        command_id: "55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        command_type: "record-validation-result",
        lifecycle_authorization_kind: "internal-workflow",
        authorization_session_id: ROOT_ID,
        target_session_id: ROOT_ID,
        presenting_actor_role: "maintenance",
        presenting_client_instance_id: "coordinator-1",
        target_actor_role: "primary",
        target_client_instance_id: "client-root",
        internal_workflow_id: `session-end/${ROOT_ID}`,
        internal_workflow_generation: 1,
        internal_planned_work_id: H64,
        internal_claim_owner_id: "coordinator-1",
      })),
      /COMMAND_AUTHORIZATION_INVALID/,
    );
  });

  it("makes approval consumptions and validation results immutable and event-linked", () => {
    const connection = currentConnection();
    seedAuthorities(connection);
    insert(connection, "lifecycle_approval_consumptions", {
      project_id: PROJECT_ID,
      approval_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      nonce_digest: H64,
      session_id: ROOT_ID,
      action: "recover-root-authority",
      command_id: "recovery-command",
      target_actor_role: "primary",
      target_client_instance_id: "client-root",
      consumed_event_position: 1,
      consumed_at: NOW,
    });
    assert.throws(
      () => connection.exec("DELETE FROM lifecycle_approval_consumptions"),
      /LIFECYCLE_APPROVAL_CONSUMPTION_IMMUTABLE/,
    );
    assert.throws(
      () => connection.exec(`
        UPDATE lifecycle_approval_consumptions SET command_id = 'different-command'
      `),
      /LIFECYCLE_APPROVAL_CONSUMPTION_IMMUTABLE/,
    );
    assert.throws(
      () => insert(connection, "lifecycle_approval_consumptions", {
        project_id: PROJECT_ID,
        approval_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        nonce_digest: H64,
        session_id: ROOT_ID,
        action: "abandon-root",
        command_id: "other-command",
        target_actor_role: "primary",
        target_client_instance_id: "client-root",
        consumed_event_position: 1,
        consumed_at: NOW,
      }),
      /UNIQUE constraint failed/,
    );

    const validation = {
      project_id: PROJECT_ID,
      vault_id: VAULT_ID,
      store_id: STORE_ID,
      session_id: ROOT_ID,
      result_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      validation_result_version: 1,
      workflow_id: `session-end/${ROOT_ID}`,
      workflow_generation: 1,
      workspace_id: "workspace-1",
      profile_id: "vault-gate",
      profile_version: 1,
      profile_configuration_hash: H64,
      run_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      runner_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      final_checkpoint_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      final_checkpoint_fingerprint: H64,
      validation_start_scope_version: 1,
      validation_start_project_id: PROJECT_ID,
      validation_start_workspace_id: "workspace-1",
      validation_start_branch_ref: null,
      validation_start_head_commit: null,
      validation_start_dirty_fingerprint: H64,
      validation_completion_scope_version: 1,
      validation_completion_project_id: PROJECT_ID,
      validation_completion_workspace_id: "workspace-1",
      validation_completion_branch_ref: null,
      validation_completion_head_commit: null,
      validation_completion_dirty_fingerprint: H64,
      started_at: NOW,
      completed_at: NOW,
      status: "pass",
      exit_classification: "passed",
      redacted_summary: "ok",
      output_fingerprint_algorithm: "hmac-sha256",
      output_fingerprint_schema_version: 1,
      output_fingerprint_key_id: "validation-key-1",
      output_fingerprint_domain: "pm-validation-output-v1",
      output_fingerprint_value: H64,
      artifact_references_json: "[]",
      fresh: 1,
      recorded_event_position: 1,
      created_at: NOW,
    };
    assert.throws(
      () => insert(connection, "lifecycle_validation_results", validation),
      /LIFECYCLE_VALIDATION_EVENT_MISMATCH/,
    );

    seedAdditionalSessionEvent(
      connection,
      ROOT_ID,
      3,
      2,
      "SessionValidationResultRecorded",
    );
    for (const mismatchedBinding of [
      { vault_id: "99999999-9999-4999-8999-999999999999" },
      { store_id: "99999999-9999-4999-8999-999999999999" },
      {
        workspace_id: "other-workspace",
        validation_start_workspace_id: "other-workspace",
        validation_completion_workspace_id: "other-workspace",
      },
    ]) {
      assert.throws(
        () => insert(connection, "lifecycle_validation_results", {
          ...validation,
          ...mismatchedBinding,
          recorded_event_position: 3,
        }),
        /LIFECYCLE_VALIDATION_EVENT_MISMATCH/,
      );
    }
    insert(connection, "lifecycle_validation_results", {
      ...validation,
      validation_start_project_id: PROJECT_ID,
      validation_completion_project_id: PROJECT_ID,
      recorded_event_position: 3,
    });
    assert.throws(
      () => connection.exec(`
        UPDATE lifecycle_validation_results SET redacted_summary = 'changed'
      `),
      /LIFECYCLE_VALIDATION_RESULT_IMMUTABLE/,
    );
    assert.throws(
      () => connection.exec("DELETE FROM lifecycle_validation_results"),
      /LIFECYCLE_VALIDATION_RESULT_IMMUTABLE/,
    );
  });

  it("enforces workflow claim, retry, generation, and write-once plan invariants", () => {
    const connection = currentConnection();
    seedAuthorities(connection);
    insert(connection, "workflow_instances", lifecycleWorkflow());
    assert.throws(
      () => connection.exec(`
        UPDATE workflow_instances SET coordinator_claim_token = 1
      `),
      /WORKFLOW_LIFECYCLE_INVALID/,
    );
    assert.throws(
      () => connection.exec(`
        UPDATE workflow_instances SET session_id = '${CHILD_ID}'
      `),
      /WORKFLOW_LIFECYCLE_INVALID/,
    );
    connection.exec(`
      UPDATE workflow_instances
      SET coordinator_owner_id = 'worker-1', coordinator_claim_token = 2,
          coordinator_claim_expires_at = '2026-07-14T00:02:00.000Z'
    `);
    assert.throws(
      () => connection.exec(`
        UPDATE workflow_instances
        SET coordinator_owner_id = 'worker-2', coordinator_claim_token = 2,
            coordinator_claim_expires_at = '2026-07-14T00:03:00.000Z'
      `),
      /WORKFLOW_LIFECYCLE_INVALID/,
    );
    connection.exec(`
      UPDATE workflow_instances
      SET coordinator_owner_id = 'worker-2', coordinator_claim_token = 3,
          coordinator_claim_expires_at = '2026-07-14T00:03:00.000Z'
    `);
    assert.throws(
      () => connection.exec(`
        UPDATE workflow_instances SET validation_attempt_plan_generation = 1
      `),
      /WORKFLOW_LIFECYCLE_INVALID/,
    );
    assert.throws(
      () => connection.exec(`
        UPDATE workflow_instances
        SET validation_attempt_plan_generation = 1,
            validation_attempt_plans_json = '[]'
      `),
      /WORKFLOW_LIFECYCLE_INVALID/,
    );
    assert.throws(
      () => connection.prepare(`
        UPDATE workflow_instances
        SET validation_attempt_plan_generation = 2,
            validation_attempt_plans_json = $plans
      `).run({ $plans: canonicalJson([validationPlan(1)]) }),
      /WORKFLOW_LIFECYCLE_INVALID/,
    );
    assert.throws(
      () => connection.prepare(`
        UPDATE workflow_instances
        SET validation_attempt_plan_generation = 1,
            validation_attempt_plans_json = $plans
      `).run({
        $plans: canonicalJson(Array.from({ length: 65 }, (_, index) => validationPlan(index + 1))),
      }),
      /WORKFLOW_LIFECYCLE_INVALID/,
    );
    assert.throws(
      () => connection.prepare(`
        UPDATE workflow_instances
        SET validation_attempt_plan_generation = 1,
            validation_attempt_plans_json = $plans
      `).run({
        $plans: canonicalJson([
          validationPlan(1, "vault-gate"),
          validationPlan(2, "vault-gate"),
        ]),
      }),
      /WORKFLOW_LIFECYCLE_INVALID/,
    );
    const plan = canonicalJson([validationPlan(1, "vault-gate")]);
    assert.throws(
      () => connection.prepare(`
        UPDATE workflow_instances
        SET validation_attempt_plan_generation = 1,
            validation_attempt_plans_json = $plans
      `).run({
        $plans: canonicalJson([{
          commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          idempotencyKey: "validation/one",
          profileId: "vault-gate",
          profileVersion: 0,
          resultId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        }]),
      }),
      /WORKFLOW_LIFECYCLE_INVALID/,
    );
    connection.prepare(`
      UPDATE workflow_instances
      SET validation_attempt_plan_generation = 1,
          validation_attempt_plans_json = $plans
    `).run({ $plans: plan });
    assert.throws(
      () => connection.prepare(`
        UPDATE workflow_instances SET validation_attempt_plans_json = $plans
      `).run({ $plans: plan.replace("vault-gate", "other") }),
      /WORKFLOW_VALIDATION_PLAN_IMMUTABLE/,
    );
    assert.throws(
      () => connection.exec("UPDATE workflow_instances SET generation = 2"),
      /WORKFLOW_GENERATION_INVALID/,
    );
    connection.exec(`
      UPDATE workflow_instances
      SET generation = 2,
          phase = 'requested',
          coordinator_owner_id = NULL,
          coordinator_claim_token = NULL,
          coordinator_claim_expires_at = NULL,
          coordinator_attempt_count = 0,
          coordinator_failure_class = NULL,
          coordinator_error_code = NULL,
          coordinator_next_attempt_at = NULL,
          validation_attempt_plan_generation = NULL,
          validation_attempt_plans_json = NULL,
          result_json = NULL,
          error_code = NULL,
          updated_at = '${NOW}'
    `);
    connection.exec("UPDATE workflow_instances SET phase = 'cancelled'");
    assert.throws(
      () => connection.exec("UPDATE workflow_instances SET phase = 'validating'"),
      /WORKFLOW_LIFECYCLE_INVALID/,
    );
    connection.exec(`
      UPDATE workflow_instances
      SET generation = 3, phase = 'requested',
          coordinator_owner_id = NULL, coordinator_claim_token = NULL,
          coordinator_claim_expires_at = NULL, coordinator_attempt_count = 0,
          coordinator_failure_class = NULL, coordinator_error_code = NULL,
          coordinator_next_attempt_at = NULL,
          validation_attempt_plan_generation = NULL,
          validation_attempt_plans_json = NULL,
          result_json = NULL, error_code = NULL,
          updated_at = '${NOW}'
    `);
  });

  it("keeps lifecycle outbox plans immutable while allowing fenced operational progress", () => {
    const connection = currentConnection();
    seedAuthorities(connection);
    insert(connection, "outbox", {
      project_id: PROJECT_ID,
      target_key: "legacy-target",
      event_position: 2,
      kind: "legacy-kind",
      payload_json: "{}",
      content_hash: H64,
      status: "pending",
      attempt_count: 0,
      claim_owner: null,
      claim_token: null,
      claim_expires_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.throws(
      () => connection.exec(`
        UPDATE outbox SET origin_kind = 'workflow' WHERE target_key = 'legacy-target'
      `),
      /OUTBOX_LIFECYCLE_INVALID/,
    );

    insert(connection, "outbox", lifecycleOutbox());
    connection.exec(`
      UPDATE outbox
      SET status = 'claimed', attempt_count = 1,
          claim_owner = 'worker-1', claim_token = 1,
          claim_expires_at = '2026-07-14T00:02:00.000Z', updated_at = '${NOW}'
      WHERE session_id = '${ROOT_ID}'
    `);
    assert.throws(
      () => connection.exec(`
        UPDATE outbox
        SET claim_owner = 'worker-2', claim_token = 1,
            claim_expires_at = '2026-07-14T00:03:00.000Z'
        WHERE session_id = '${ROOT_ID}'
      `),
      /OUTBOX_LIFECYCLE_INVALID/,
    );
    connection.exec(`
      UPDATE outbox
      SET claim_owner = 'worker-2', claim_token = 2,
          claim_expires_at = '2026-07-14T00:03:00.000Z', updated_at = '${NOW}'
      WHERE session_id = '${ROOT_ID}'
    `);
    connection.exec(`
      UPDATE outbox
      SET status = 'completed', claim_expires_at = NULL, updated_at = '${NOW}'
      WHERE session_id = '${ROOT_ID}'
    `);
    connection.exec(`
      UPDATE outbox SET updated_at = '2026-07-14T00:04:00.000Z'
      WHERE session_id = '${ROOT_ID}'
    `);
    for (const update of [
      "project_id = '99999999-9999-4999-8999-999999999999'",
      "target_key = 'other-target'",
      `session_id = '${CHILD_ID}'`,
      "origin_kind = 'terminal-event', workflow_id = NULL, workflow_generation = NULL",
      "workflow_id = 'session-end/other'",
      "workflow_generation = 2",
      "artifact_kind = 'other-artifact'",
      "artifact_path = '05_Agent_Session_Logs/other.md'",
      "event_position = 2, materialization_revision = 2",
      "kind = 'other-kind'",
      "payload_json = '{\"changed\":true}'",
      `content_hash = '${H64_B}'`,
      `expected_prior_fingerprint = '${H64}'`,
      `next_fingerprint = '${H64}'`,
      "fingerprint_algorithm = 'sha256'",
      "fingerprint_schema_version = 2",
      "fingerprint_key_id = 'other-key'",
      "fingerprint_domain = 'other-domain'",
      "created_at = '2026-07-14T00:05:00.000Z'",
    ]) {
      assert.throws(
        () => connection.exec(`
          UPDATE outbox SET ${update} WHERE session_id = '${ROOT_ID}'
        `),
        /OUTBOX_PLANNED_METADATA_IMMUTABLE/,
        update,
      );
    }
    assert.throws(
      () => connection.exec(`
        UPDATE outbox SET claim_owner = NULL, claim_token = NULL
        WHERE session_id = '${ROOT_ID}'
      `),
      /OUTBOX_LIFECYCLE_INVALID/,
    );
  });
});
