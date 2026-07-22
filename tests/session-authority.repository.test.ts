import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  assertAuthorityMirror,
  foldSession,
  type SessionAuthorityMirror,
} from "../src/orchestrator/lifecycle/session-aggregate.js";
import {
  authorityCommitment,
  type CommittedAuthorityV1,
} from "../src/orchestrator/lifecycle/authority/authority-commitment.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { SessionAuthorityRepository } from "../src/orchestrator/storage/session-authority.repository.js";
import type {
  ChildAuthorityInsert,
  RootAuthorityInsert,
  SessionAuthorityMutation,
  SessionAuthorityRecord,
} from "../src/orchestrator/storage/lifecycle-storage.types.js";
import type {
  SqliteConnection,
  SqliteParams,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";
import type { LifecycleEventV1 } from "../src/orchestrator/lifecycle/contracts/events.js";
import type { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import {
  CHILD_SESSION_ID,
  CHECKPOINT_ID,
  PROJECT_ID,
  ROOT_SESSION_ID,
  STORE_ID,
  VAULT_ID,
  WORKSPACE_ID,
  lifecycleEvent,
} from "./support/lifecycle-fixtures.js";

const NOW = "2026-07-17T00:00:00.000Z";
const LIFECYCLE_SCHEMA_MIGRATIONS = PROJECT_STORE_MIGRATIONS.slice(0, 2);
const LATER = "2026-07-17T00:00:01.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const ROOT_ISSUANCE_ID = "11111111-1111-4111-8111-111111111110";
const RESUME_ISSUANCE_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ISSUANCE_ID = "11111111-1111-4111-8111-111111111112";

type StatementKind = "run" | "get" | "all" | "iterate";
type Handler = (
  sql: string,
  kind: StatementKind,
  params: SqliteParams | undefined,
) => SqliteRunResult | SqliteRow | SqliteRow[] | undefined;

class RecordingConnection implements SqliteConnection {
  readonly prepared: string[] = [];
  readonly execCalls: string[] = [];
  readonly calls: Array<{
    readonly sql: string;
    readonly kind: StatementKind;
    readonly params: SqliteParams | undefined;
  }> = [];
  closeCalls = 0;

  constructor(private readonly handler: Handler) {}

  exec(sql: string): void {
    this.execCalls.push(sql);
    if (/\b(?:BEGIN|COMMIT|ROLLBACK)\b/iu.test(sql)) {
      throw new Error("NESTED_TRANSACTION_ATTEMPT");
    }
  }

  prepare(sql: string): SqliteStatement {
    this.prepared.push(sql);
    const invoke = (
      kind: StatementKind,
      params?: SqliteParams,
    ): SqliteRunResult | SqliteRow | SqliteRow[] | undefined => {
      this.calls.push({ sql, kind, params });
      return this.handler(sql, kind, params);
    };
    return {
      run: (params?: SqliteParams) => invoke("run", params) as SqliteRunResult,
      get: (params?: SqliteParams) => invoke("get", params) as SqliteRow | undefined,
      all: (params?: SqliteParams) => invoke("all", params) as SqliteRow[],
      iterate: (params?: SqliteParams) =>
        (invoke("iterate", params) as SqliteRow[])[Symbol.iterator](),
    };
  }

  close(): void {
    this.closeCalls += 1;
  }
}

class NativeStatement implements SqliteStatement {
  constructor(private readonly statement: import("node:sqlite").StatementSync) {
    statement.setReadBigInts(true);
  }

  run(params?: SqliteParams): SqliteRunResult {
    const result = params === undefined ? this.statement.run() : this.statement.run(params);
    return {
      changes: result.changes as bigint,
      lastInsertRowid: result.lastInsertRowid as bigint,
    };
  }

  get(params?: SqliteParams): SqliteRow | undefined {
    return (params === undefined ? this.statement.get() : this.statement.get(params)) as
      | SqliteRow
      | undefined;
  }

  all(params?: SqliteParams): SqliteRow[] {
    return (params === undefined ? this.statement.all() : this.statement.all(params)) as SqliteRow[];
  }

  iterate(params?: SqliteParams): IterableIterator<SqliteRow> {
    return (params === undefined ? this.statement.iterate() : this.statement.iterate(params)) as
      IterableIterator<SqliteRow>;
  }
}

class NativeConnection implements SqliteConnection {
  readonly database = new DatabaseSync(":memory:", {
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    enableForeignKeyConstraints: false,
    enableDoubleQuotedStringLiterals: false,
  });

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new NativeStatement(this.database.prepare(sql));
  }

  close(): void {
    this.database.close();
  }
}

function migratedNativeConnection(): NativeConnection {
  const connection = new NativeConnection();
  new MigrationRunner().apply(
    connection,
    LIFECYCLE_SCHEMA_MIGRATIONS,
    NOW,
    { kind: "bootstrap-empty", beforeMigration: () => undefined },
  );
  return connection;
}

function expectCode(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => (error as LifecycleError).code === code);
}

function committed(record: SessionAuthorityRecord): CommittedAuthorityV1 {
  return {
    authorityVersion: 1,
    projectId: record.projectId,
    sessionId: record.sessionId,
    sessionKind: record.sessionKind,
    parentSessionId: record.parentSessionId,
    workspaceId: record.workspaceId,
    clientNamespace: record.clientNamespace,
    ownerGeneration: record.ownerGeneration?.toString() ?? null,
    childCapabilityGeneration: record.childCapabilityGeneration?.toString() ?? null,
    directAccessEnabled: record.directAccessEnabled,
    continuityFingerprintAlgorithm: record.continuityFingerprintAlgorithm,
    continuityFingerprintSchemaVersion: record.continuityFingerprintSchemaVersion,
    continuityFingerprintKeyId: record.continuityFingerprintKeyId,
    continuityFingerprintDomain: record.continuityFingerprintDomain,
    continuityFingerprint: record.continuityFingerprint,
    rootHandleCapabilityVersion: record.rootHandleCapabilityVersion,
    rootHandleKeyId: record.rootHandleKeyId,
    rootHandleIssueNonce: record.rootHandleIssueNonce,
    rootHandleIssuedAt: record.rootHandleIssuedAt,
    rootHandlePolicyCode: record.rootHandlePolicyCode,
    rootHandleExpiryKind: record.rootHandleExpiryKind,
    rootHandleExpiresAt: record.rootHandleExpiresAt,
    rootHandleActorRole: record.rootHandleActorRole,
    rootHandleClientInstanceId: record.rootHandleClientInstanceId,
    rootHandleVerifier: record.rootHandleVerifier,
    resumeTokenCapabilityVersion: record.resumeTokenCapabilityVersion,
    resumeTokenKeyId: record.resumeTokenKeyId,
    resumeTokenIssueNonce: record.resumeTokenIssueNonce,
    resumeTokenIssuedAt: record.resumeTokenIssuedAt,
    resumeTokenPolicyCode: record.resumeTokenPolicyCode,
    resumeTokenExpiryKind: record.resumeTokenExpiryKind,
    resumeTokenExpiresAt: record.resumeTokenExpiresAt,
    resumeTokenActorRole: record.resumeTokenActorRole,
    resumeTokenVerifier: record.resumeTokenVerifier,
    childHandleCapabilityVersion: record.childHandleCapabilityVersion,
    childHandleKeyId: record.childHandleKeyId,
    childHandleIssueNonce: record.childHandleIssueNonce,
    childHandleIssuedAt: record.childHandleIssuedAt,
    childHandlePolicyCode: record.childHandlePolicyCode,
    childHandleExpiryKind: record.childHandleExpiryKind,
    childHandleExpiresAt: record.childHandleExpiresAt,
    childHandleActorRole: record.childHandleActorRole,
    childHandleClientInstanceId: record.childHandleClientInstanceId,
    childHandleVerifier: record.childHandleVerifier,
    revocationReasonCode: record.revocationReasonCode,
    revocationEventPosition: record.revocationEventPosition?.toString() ?? null,
    revokedAt: record.revokedAt,
    terminalEventPosition: record.terminalEventPosition?.toString() ?? null,
    terminalEventType: record.terminalEventType,
    terminalAt: record.terminalAt,
  };
}

function withCommitment<T extends SessionAuthorityRecord>(record: T): T {
  const next = { ...record } as T;
  return Object.freeze({
    ...next,
    authorityCommitment: authorityCommitment(committed(next)),
  }) as T;
}

function rootAuthority(
  overrides: Partial<RootAuthorityInsert> = {},
): RootAuthorityInsert {
  const record: RootAuthorityInsert = {
    projectId: PROJECT_ID,
    sessionId: ROOT_SESSION_ID,
    streamId: `session/${ROOT_SESSION_ID}`,
    sessionKind: "root",
    parentSessionId: null,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    semanticState: "active",
    ownerGeneration: 1n,
    childCapabilityGeneration: null,
    directAccessEnabled: false,
    continuityFingerprintAlgorithm: "hmac-sha256",
    continuityFingerprintSchemaVersion: 1,
    continuityFingerprintKeyId: "continuity-key-1",
    continuityFingerprintDomain: "pm-continuity-v1",
    continuityFingerprint: HASH_A,
    rootHandleCapabilityVersion: 1,
    rootHandleKeyId: "capability-key-1",
    rootHandleIssueNonce: HASH_A,
    rootHandleIssuedAt: NOW,
    rootHandlePolicyCode: "root-default-v1",
    rootHandleExpiryKind: "until-revoked",
    rootHandleExpiresAt: null,
    rootHandleActorRole: "primary",
    rootHandleClientInstanceId: "primary-1",
    rootHandleVerifier: HASH_A,
    rootHandleIssuanceId: ROOT_ISSUANCE_ID,
    resumeTokenCapabilityVersion: 1,
    resumeTokenKeyId: "capability-key-1",
    resumeTokenIssueNonce: HASH_B,
    resumeTokenIssuedAt: NOW,
    resumeTokenPolicyCode: "resume-default-v1",
    resumeTokenExpiryKind: "until-revoked",
    resumeTokenExpiresAt: null,
    resumeTokenActorRole: "primary",
    resumeTokenVerifier: HASH_B,
    resumeTokenIssuanceId: RESUME_ISSUANCE_ID,
    childHandleCapabilityVersion: null,
    childHandleKeyId: null,
    childHandleIssueNonce: null,
    childHandleIssuedAt: null,
    childHandlePolicyCode: null,
    childHandleExpiryKind: null,
    childHandleExpiresAt: null,
    childHandleActorRole: null,
    childHandleClientInstanceId: null,
    childHandleVerifier: null,
    childHandleIssuanceId: null,
    authorityCommitment: HASH_C,
    authorityEventPosition: 1n,
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    latestCheckpointFingerprint: null,
    checkpointRequiredReason: null,
    checkpointRequiredEventPosition: null,
    revocationReasonCode: null,
    revocationEventPosition: null,
    revokedAt: null,
    terminalEventPosition: null,
    terminalEventType: null,
    terminalAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  return withCommitment(record);
}

function childAuthority(
  overrides: Partial<ChildAuthorityInsert> = {},
): ChildAuthorityInsert {
  const record: ChildAuthorityInsert = {
    projectId: PROJECT_ID,
    sessionId: CHILD_SESSION_ID,
    streamId: `session/${CHILD_SESSION_ID}`,
    sessionKind: "child",
    parentSessionId: ROOT_SESSION_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    semanticState: "active",
    ownerGeneration: null,
    childCapabilityGeneration: 1n,
    directAccessEnabled: true,
    continuityFingerprintAlgorithm: null,
    continuityFingerprintSchemaVersion: null,
    continuityFingerprintKeyId: null,
    continuityFingerprintDomain: null,
    continuityFingerprint: null,
    rootHandleCapabilityVersion: null,
    rootHandleKeyId: null,
    rootHandleIssueNonce: null,
    rootHandleIssuedAt: null,
    rootHandlePolicyCode: null,
    rootHandleExpiryKind: null,
    rootHandleExpiresAt: null,
    rootHandleActorRole: null,
    rootHandleClientInstanceId: null,
    rootHandleVerifier: null,
    rootHandleIssuanceId: null,
    resumeTokenCapabilityVersion: null,
    resumeTokenKeyId: null,
    resumeTokenIssueNonce: null,
    resumeTokenIssuedAt: null,
    resumeTokenPolicyCode: null,
    resumeTokenExpiryKind: null,
    resumeTokenExpiresAt: null,
    resumeTokenActorRole: null,
    resumeTokenVerifier: null,
    resumeTokenIssuanceId: null,
    childHandleCapabilityVersion: 1,
    childHandleKeyId: "capability-key-1",
    childHandleIssueNonce: HASH_A,
    childHandleIssuedAt: NOW,
    childHandlePolicyCode: "child-default-v1",
    childHandleExpiryKind: "absolute",
    childHandleExpiresAt: "2026-07-17T01:00:00.000Z",
    childHandleActorRole: "untrusted",
    childHandleClientInstanceId: "child-1",
    childHandleVerifier: HASH_A,
    childHandleIssuanceId: CHILD_ISSUANCE_ID,
    authorityCommitment: HASH_C,
    authorityEventPosition: 2n,
    latestCheckpointId: null,
    latestCheckpointEventPosition: null,
    latestCheckpointFingerprint: null,
    checkpointRequiredReason: null,
    checkpointRequiredEventPosition: null,
    revocationReasonCode: null,
    revocationEventPosition: null,
    revokedAt: null,
    terminalEventPosition: null,
    terminalEventType: null,
    terminalAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  return withCommitment(record);
}

function authorityRow(record: SessionAuthorityRecord): SqliteRow {
  return {
    project_id: record.projectId,
    session_id: record.sessionId,
    stream_id: record.streamId,
    session_kind: record.sessionKind,
    parent_session_id: record.parentSessionId,
    workspace_id: record.workspaceId,
    client_namespace: record.clientNamespace,
    semantic_state: record.semanticState,
    owner_generation: record.ownerGeneration,
    child_capability_generation: record.childCapabilityGeneration,
    direct_access_enabled: record.directAccessEnabled ? 1n : 0n,
    continuity_fingerprint_algorithm: record.continuityFingerprintAlgorithm,
    continuity_fingerprint_schema_version: record.continuityFingerprintSchemaVersion === null
      ? null
      : BigInt(record.continuityFingerprintSchemaVersion),
    continuity_fingerprint_key_id: record.continuityFingerprintKeyId,
    continuity_fingerprint_domain: record.continuityFingerprintDomain,
    continuity_fingerprint: record.continuityFingerprint,
    root_handle_capability_version: record.rootHandleCapabilityVersion === null
      ? null
      : BigInt(record.rootHandleCapabilityVersion),
    root_handle_key_id: record.rootHandleKeyId,
    root_handle_issue_nonce: record.rootHandleIssueNonce,
    root_handle_issued_at: record.rootHandleIssuedAt,
    root_handle_policy_code: record.rootHandlePolicyCode,
    root_handle_expiry_kind: record.rootHandleExpiryKind,
    root_handle_expires_at: record.rootHandleExpiresAt,
    root_handle_actor_role: record.rootHandleActorRole,
    root_handle_client_instance_id: record.rootHandleClientInstanceId,
    root_handle_verifier: record.rootHandleVerifier,
    root_handle_issuance_id: record.rootHandleIssuanceId,
    resume_token_capability_version: record.resumeTokenCapabilityVersion === null
      ? null
      : BigInt(record.resumeTokenCapabilityVersion),
    resume_token_key_id: record.resumeTokenKeyId,
    resume_token_issue_nonce: record.resumeTokenIssueNonce,
    resume_token_issued_at: record.resumeTokenIssuedAt,
    resume_token_policy_code: record.resumeTokenPolicyCode,
    resume_token_expiry_kind: record.resumeTokenExpiryKind,
    resume_token_expires_at: record.resumeTokenExpiresAt,
    resume_token_actor_role: record.resumeTokenActorRole,
    resume_token_verifier: record.resumeTokenVerifier,
    resume_token_issuance_id: record.resumeTokenIssuanceId,
    child_handle_capability_version: record.childHandleCapabilityVersion === null
      ? null
      : BigInt(record.childHandleCapabilityVersion),
    child_handle_key_id: record.childHandleKeyId,
    child_handle_issue_nonce: record.childHandleIssueNonce,
    child_handle_issued_at: record.childHandleIssuedAt,
    child_handle_policy_code: record.childHandlePolicyCode,
    child_handle_expiry_kind: record.childHandleExpiryKind,
    child_handle_expires_at: record.childHandleExpiresAt,
    child_handle_actor_role: record.childHandleActorRole,
    child_handle_client_instance_id: record.childHandleClientInstanceId,
    child_handle_verifier: record.childHandleVerifier,
    child_handle_issuance_id: record.childHandleIssuanceId,
    authority_commitment: record.authorityCommitment,
    authority_event_position: record.authorityEventPosition,
    latest_checkpoint_id: record.latestCheckpointId,
    latest_checkpoint_event_position: record.latestCheckpointEventPosition,
    latest_checkpoint_fingerprint: record.latestCheckpointFingerprint,
    checkpoint_required_reason: record.checkpointRequiredReason,
    checkpoint_required_event_position: record.checkpointRequiredEventPosition,
    revocation_reason_code: record.revocationReasonCode,
    revocation_event_position: record.revocationEventPosition,
    revoked_at: record.revokedAt,
    terminal_event_position: record.terminalEventPosition,
    terminal_event_type: record.terminalEventType,
    terminal_at: record.terminalAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function mutation(record: SessionAuthorityRecord): SessionAuthorityMutation {
  const {
    projectId: _projectId,
    sessionId: _sessionId,
    streamId: _streamId,
    sessionKind: _sessionKind,
    parentSessionId: _parentSessionId,
    workspaceId: _workspaceId,
    clientNamespace: _clientNamespace,
    createdAt: _createdAt,
    ...next
  } = record;
  return next;
}

function eventRow(event: LifecycleEventV1): SqliteRow {
  return {
    global_position: BigInt(event.globalPosition),
    event_id: event.eventId,
    project_id: event.projectId,
    vault_id: event.vaultId,
    store_id: event.storeId,
    workspace_id: event.workspaceId,
    stream_id: event.streamId,
    stream_type: "session",
    stream_version: BigInt(event.streamVersion),
    event_type: event.eventType,
    event_schema_version: BigInt(event.eventSchemaVersion),
    session_id: event.sessionId,
    parent_session_id: event.parentSessionId,
    correlation_id: event.correlationId,
    causation_id: event.causationId,
    command_id: event.commandId,
    idempotency_key: event.idempotencyKey,
    occurred_at: event.occurredAt,
    payload_json: canonicalJson(event.payload),
  };
}

describe("SessionAuthorityRepository strict rows", () => {
  it("decodes every explicit field, preserves int64 bigint boundaries, and recomputes commitments", () => {
    const expected = rootAuthority({ ownerGeneration: 9_223_372_036_854_775_807n });
    const connection = new RecordingConnection((_sql, kind) => {
      if (kind === "get") return authorityRow(expected);
      throw new Error("unexpected statement method");
    });
    const actual = new SessionAuthorityRepository().get(connection, PROJECT_ID, ROOT_SESSION_ID);
    assert.equal(actual?.ownerGeneration, 9_223_372_036_854_775_807n);
    assert.equal(actual?.authorityEventPosition, 1n);
    assert.equal(actual?.authorityCommitment, expected.authorityCommitment);
    assert.deepEqual(connection.execCalls, []);
    assert.equal(connection.closeCalls, 0);
  });

  it("fails closed on malformed fields, incoherent null groups, unknown state, and row extras", () => {
    const valid = authorityRow(rootAuthority());
    const malformed: SqliteRow[] = [
      { ...valid, stream_id: "session/not-canonical" },
      { ...valid, parent_session_id: CHILD_SESSION_ID },
      { ...valid, semantic_state: "completion-proposed" },
      { ...valid, owner_generation: 0n },
      { ...valid, direct_access_enabled: 1n },
      { ...valid, latest_checkpoint_id: "22222222-2222-4222-8222-222222222222" },
      { ...valid, checkpoint_required_reason: "ownership-transfer" },
      { ...valid, terminal_event_position: 5n, terminal_event_type: "SessionEnded" },
      { ...valid, root_handle_issued_at: "2026-07-17T00:00:00Z" },
      { ...valid, root_handle_issue_nonce: HASH_A.toUpperCase() },
      { ...valid, authority_commitment: HASH_B },
      { ...valid, unexpected_column: "canary" },
    ];
    for (const row of malformed) {
      const connection = new RecordingConnection((_sql, kind) => {
        if (kind === "get") return row;
        throw new Error("unexpected statement method");
      });
      expectCode(
        "INTEGRITY_FAILURE",
        () => new SessionAuthorityRepository().get(connection, PROJECT_ID, ROOT_SESSION_ID),
      );
    }
  });
});

describe("SessionAuthorityRepository inserts, CAS, and queries", () => {
  it("uses explicit complete inserts for roots and children without owning a transaction", () => {
    const runs: string[] = [];
    const connection = new RecordingConnection((sql, kind) => {
      if (kind === "run") {
        runs.push(sql);
        return { changes: 1n, lastInsertRowid: 1n };
      }
      throw new Error("unexpected statement method");
    });
    const repository = new SessionAuthorityRepository();
    repository.insertRoot(connection, rootAuthority());
    repository.insertChild(connection, childAuthority());
    assert.equal(runs.length, 2);
    for (const sql of runs) {
      assert.match(sql, /INSERT INTO session_authority/iu);
      assert.match(sql, /root_handle_issuance_id/iu);
      assert.match(sql, /resume_token_issuance_id/iu);
      assert.match(sql, /child_handle_issuance_id/iu);
      assert.doesNotMatch(sql, /SELECT \*/iu);
    }
    assert.deepEqual(connection.execCalls, []);
    assert.equal(connection.closeCalls, 0);
  });

  it("fences CAS on state, commitment, and both generations so a stale child cannot revoke a rotation", () => {
    const current = childAuthority();
    const next = childAuthority({
      childCapabilityGeneration: 2n,
      childHandleIssueNonce: HASH_B,
      childHandleVerifier: HASH_B,
      authorityEventPosition: 3n,
      updatedAt: LATER,
    });
    const outcomes = [1n, 0n];
    const connection = new RecordingConnection((sql, kind) => {
      if (kind === "get") return authorityRow(current);
      if (kind === "run" && /UPDATE session_authority/iu.test(sql)) {
        return { changes: outcomes.shift() ?? 0n, lastInsertRowid: 0n };
      }
      throw new Error("unexpected statement method");
    });
    const repository = new SessionAuthorityRepository();
    const input = {
      projectId: PROJECT_ID,
      sessionId: CHILD_SESSION_ID,
      expectedState: "active" as const,
      expectedOwnerGeneration: null,
      expectedChildCapabilityGeneration: 1n,
      expectedAuthorityCommitment: current.authorityCommitment,
      next: mutation(next),
    };
    assert.equal(repository.compareAndSwap(connection, input), true);
    assert.equal(repository.compareAndSwap(connection, input), false);
    const sql = connection.prepared.find((statement) => /UPDATE session_authority/iu.test(statement)) ?? "";
    assert.match(sql, /semantic_state\s*=\s*\$expectedState/iu);
    assert.match(sql, /authority_commitment\s*=\s*\$expectedCommitment/iu);
    assert.match(sql, /owner_generation\s+IS\s+\$expectedOwnerGeneration/iu);
    assert.match(sql, /child_capability_generation\s+IS\s+\$expectedChildCapabilityGeneration/iu);
    assert.doesNotMatch(sql, /parent_session_id\s*=/iu);
  });

  it("rejects CAS candidates whose commitment does not match mutated authority fields before updating", () => {
    const current = childAuthority();
    const rotated = childAuthority({
      childCapabilityGeneration: 2n,
      childHandleIssueNonce: HASH_B,
      childHandleVerifier: HASH_B,
      authorityEventPosition: 3n,
      updatedAt: LATER,
    });
    const forgedNext: SessionAuthorityMutation = {
      ...mutation(rotated),
      authorityCommitment: current.authorityCommitment,
    };
    let updateCalls = 0;
    const connection = new RecordingConnection((_sql, kind) => {
      if (kind === "get") return authorityRow(current);
      if (kind === "run") {
        updateCalls += 1;
        return { changes: 1n, lastInsertRowid: 0n };
      }
      throw new Error("unexpected statement method");
    });

    expectCode("INTEGRITY_FAILURE", () => new SessionAuthorityRepository().compareAndSwap(connection, {
      projectId: PROJECT_ID,
      sessionId: CHILD_SESSION_ID,
      expectedState: current.semanticState,
      expectedOwnerGeneration: current.ownerGeneration,
      expectedChildCapabilityGeneration: current.childCapabilityGeneration,
      expectedAuthorityCommitment: current.authorityCommitment,
      next: forgedNext,
    }));
    assert.equal(updateCalls, 0);
  });

  it("rejects impossible multi-row CAS results instead of treating them as a win", () => {
    const current = rootAuthority();
    const connection = new RecordingConnection((_sql, kind) => {
      if (kind === "get") return authorityRow(current);
      if (kind === "run") return { changes: 2n, lastInsertRowid: 0n };
      throw new Error("unexpected statement method");
    });
    expectCode("INTEGRITY_FAILURE", () => new SessionAuthorityRepository().compareAndSwap(connection, {
      projectId: PROJECT_ID,
      sessionId: ROOT_SESSION_ID,
      expectedState: "active",
      expectedOwnerGeneration: 1n,
      expectedChildCapabilityGeneration: null,
      expectedAuthorityCommitment: current.authorityCommitment,
      next: mutation(current),
    }));
  });

  it("shortlists only exact approved safe-resume fields and orders by session identity", () => {
    const root = rootAuthority();
    const connection = new RecordingConnection((_sql, kind) => {
      if (kind === "all") return [authorityRow(root)];
      throw new Error("unexpected statement method");
    });
    const repository = new SessionAuthorityRepository();
    const candidates = repository.listSafeResumeCandidates(connection, {
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "tests",
      sessionId: ROOT_SESSION_ID,
      continuityFingerprint: HASH_A,
      afterSessionId: "00000000-0000-4000-8000-000000000001",
      semanticStates: ["active", "suspended"],
    });
    assert.equal(candidates.length, 1);
    const sql = connection.prepared[0] ?? "";
    assert.match(sql, /session_kind\s*=\s*'root'/iu);
    assert.match(sql, /terminal_event_position\s+IS\s+NULL/iu);
    assert.match(sql, /workspace_id\s*=\s*\$workspaceId/iu);
    assert.match(sql, /client_namespace\s*=\s*\$clientNamespace/iu);
    assert.match(sql, /session_id\s+IS\s+\$sessionId/iu);
    assert.match(sql, /continuity_fingerprint\s+IS\s+\$continuityFingerprint/iu);
    assert.match(sql, /session_id\s*>\s*\$afterSessionId/iu);
    assert.match(sql, /ORDER BY session_id/iu);
    assert.match(sql, /LIMIT\s+\$limit/iu);
    assert.equal(connection.calls[0]?.params?.$limit, 17n);
    assert.equal(
      connection.calls[0]?.params?.$afterSessionId,
      "00000000-0000-4000-8000-000000000001",
    );
    assert.doesNotMatch(sql, /task|similarity|agent/iu);
    assert.doesNotMatch(sql, /ORDER BY[^]*(?:updated_at|created_at)/iu);
  });

  it("finds every nonterminal continuity owner including ending roots", () => {
    const ending = rootAuthority({ semanticState: "ending" });
    const connection = new RecordingConnection((_sql, kind) => {
      if (kind === "all") return [authorityRow(ending)];
      throw new Error("unexpected statement method");
    });
    const owners = new SessionAuthorityRepository().listNonterminalRootContinuityOwners(
      connection,
      {
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        clientNamespace: "tests",
        continuityFingerprint: HASH_A,
      },
    );
    assert.equal(owners[0]?.semanticState, "ending");
    const sql = connection.prepared[0] ?? "";
    assert.match(sql, /session_kind\s*=\s*'root'/iu);
    assert.match(sql, /terminal_event_position\s+IS\s+NULL/iu);
    assert.match(sql, /continuity_fingerprint\s*=\s*\$continuityFingerprint/iu);
    assert.doesNotMatch(sql, /semantic_state\s+IN/iu);
  });

  it("lists only nonterminal direct children in deterministic session order", () => {
    const child = childAuthority();
    const connection = new RecordingConnection((_sql, kind) => {
      if (kind === "all") return [authorityRow(child)];
      throw new Error("unexpected statement method");
    });
    const children = new SessionAuthorityRepository().listNonterminalChildren(
      connection,
      PROJECT_ID,
      ROOT_SESSION_ID,
    );
    assert.equal(children[0]?.parentSessionId, ROOT_SESSION_ID);
    const sql = connection.prepared[0] ?? "";
    assert.match(sql, /parent_session_id\s*=\s*\$rootSessionId/iu);
    assert.match(sql, /session_kind\s*=\s*'child'/iu);
    assert.match(sql, /terminal_event_position\s+IS\s+NULL/iu);
    assert.match(sql, /ORDER BY session_id/iu);
  });
});

describe("SessionAuthorityRepository fold and checkpoint guards", () => {
  it("loads only the indexed latest checkpoint and verifies its domain fingerprint", () => {
    const base = rootAuthority();
    const started = lifecycleEvent(1, "SessionStarted", {}, {
      authorityCommitment: base.authorityCommitment,
    }) as LifecycleEventV1;
    const checkpoint = lifecycleEvent(2, "SessionCheckpointRecorded", {}, {
      authorityCommitment: base.authorityCommitment,
      sessionId: ROOT_SESSION_ID,
      parentSessionId: null,
    }) as Extract<LifecycleEventV1, { readonly eventType: "SessionCheckpointRecorded" }>;
    const checkpointFingerprint = createHash("sha256")
      .update("project-memory/checkpoint/v1\n", "utf8")
      .update(canonicalJson(checkpoint.payload.checkpoint), "utf8")
      .digest("hex");
    const authority = rootAuthority({
      latestCheckpointId: CHECKPOINT_ID,
      latestCheckpointEventPosition: 2n,
      latestCheckpointFingerprint: checkpointFingerprint,
    });
    const rows = [eventRow(started), eventRow(checkpoint)];
    const healthy = new RecordingConnection((sql, kind) => {
      if (kind === "all" && /FROM events/iu.test(sql)) return rows;
      throw new Error("unexpected statement method");
    });
    assert.deepEqual(
      new SessionAuthorityRepository().latestCheckpoint(healthy, authority),
      checkpoint.payload.checkpoint,
    );

    const forgedMirror = { ...authority, latestCheckpointFingerprint: "f".repeat(64) };
    expectCode(
      "INTEGRITY_FAILURE",
      () => new SessionAuthorityRepository().latestCheckpoint(healthy, forgedMirror),
    );

    const tamperedCheckpoint = {
      ...checkpoint,
      payload: {
        ...checkpoint.payload,
        checkpoint: {
          ...checkpoint.payload.checkpoint,
          taskSummary: "tampered checkpoint payload",
        },
      },
    } as LifecycleEventV1;
    const tampered = new RecordingConnection((sql, kind) => {
      if (kind === "all" && /FROM events/iu.test(sql)) {
        return [eventRow(started), eventRow(tamperedCheckpoint)];
      }
      throw new Error("unexpected statement method");
    });
    expectCode(
      "INTEGRITY_FAILURE",
      () => new SessionAuthorityRepository().latestCheckpoint(tampered, authority),
    );
  });

  it("loads the deterministic stream, folds it, and compares the bigint authority mirror", () => {
    const provisional = rootAuthority({ authorityEventPosition: 1n });
    const event = lifecycleEvent(1, "SessionStarted", {
      ownerGeneration: 1,
      authorityCommitment: provisional.authorityCommitment,
    }, {
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      sessionId: ROOT_SESSION_ID,
      parentSessionId: null,
      streamId: `session/${ROOT_SESSION_ID}`,
      authorityCommitment: provisional.authorityCommitment,
    }) as LifecycleEventV1;
    const aggregate = foldSession([event]);
    const authority = rootAuthority({
      authorityCommitment: aggregate.authorityCommitment,
      authorityEventPosition: BigInt(aggregate.eventPosition),
    });
    const connection = new RecordingConnection((sql, kind) => {
      if (kind === "all" && /FROM events/iu.test(sql)) return [eventRow(event)];
      throw new Error("unexpected statement method");
    });
    const folded = new SessionAuthorityRepository().requireFoldMatch(connection, authority);
    assert.equal(folded.ownerGeneration, 1);
    assert.deepEqual(connection.execCalls, []);

    const mirror: SessionAuthorityMirror = {
      sessionKind: "root",
      parentSessionId: null,
      semanticState: "active",
      ownerGeneration: 1n,
      childCapabilityGeneration: null,
      authorityCommitment: aggregate.authorityCommitment,
      latestCheckpointEventPosition: null,
      terminalEventPosition: null,
    };
    assert.doesNotThrow(() => assertAuthorityMirror(aggregate, mirror));
  });

  it("fails integrity when a folded lifecycle event is not from the session stream type", () => {
    const provisional = rootAuthority({ authorityEventPosition: 1n });
    const event = lifecycleEvent(1, "SessionStarted", {
      ownerGeneration: 1,
      authorityCommitment: provisional.authorityCommitment,
    }, {
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      sessionId: ROOT_SESSION_ID,
      parentSessionId: null,
      streamId: `session/${ROOT_SESSION_ID}`,
      authorityCommitment: provisional.authorityCommitment,
    }) as LifecycleEventV1;
    const aggregate = foldSession([event]);
    const authority = rootAuthority({
      authorityCommitment: aggregate.authorityCommitment,
      authorityEventPosition: BigInt(aggregate.eventPosition),
    });
    const connection = new RecordingConnection((sql, kind) => {
      if (kind === "all" && /FROM events/iu.test(sql)) return [{
        ...eventRow(event),
        stream_type: "task",
      }];
      throw new Error("unexpected statement method");
    });

    expectCode(
      "INTEGRITY_FAILURE",
      () => new SessionAuthorityRepository().requireFoldMatch(connection, authority),
    );
  });

  it("fails integrity when the mirror semantic state differs from its authoritative fold", () => {
    const authority = rootAuthority({ semanticState: "suspended" });
    const event = lifecycleEvent(1, "SessionStarted", {
      ownerGeneration: 1,
      authorityCommitment: authority.authorityCommitment,
    }, {
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      sessionId: ROOT_SESSION_ID,
      parentSessionId: null,
      streamId: `session/${ROOT_SESSION_ID}`,
      authorityCommitment: authority.authorityCommitment,
    }) as LifecycleEventV1;
    const connection = new RecordingConnection((sql, kind) => {
      if (kind === "all" && /FROM events/iu.test(sql)) return [eventRow(event)];
      throw new Error("unexpected statement method");
    });
    expectCode(
      "INTEGRITY_FAILURE",
      () => new SessionAuthorityRepository().requireFoldMatch(connection, authority),
    );
  });

  it("marks requirements monotonically and clears only from a covering checkpoint base", () => {
    const outcomes = [1n, 1n, 0n];
    const connection = new RecordingConnection((_sql, kind) => {
      if (kind === "get") return { created_at: NOW } as SqliteRow;
      if (kind === "run") {
        return { changes: outcomes.shift() ?? 0n, lastInsertRowid: 0n };
      }
      throw new Error("unexpected statement method");
    });
    const repository = new SessionAuthorityRepository();
    repository.markCheckpointRequired(connection, {
      projectId: PROJECT_ID,
      sessionId: ROOT_SESSION_ID,
      reason: "ownership-transfer",
      eventPosition: 21n,
      updatedAt: LATER,
    });
    assert.equal(repository.clearCheckpointRequired(connection, {
      projectId: PROJECT_ID,
      sessionId: ROOT_SESSION_ID,
      checkpointBaseEventPosition: 21n,
      updatedAt: LATER,
    }), true);
    assert.equal(repository.clearCheckpointRequired(connection, {
      projectId: PROJECT_ID,
      sessionId: ROOT_SESSION_ID,
      checkpointBaseEventPosition: 20n,
      updatedAt: LATER,
    }), false);

    const markSql = connection.prepared.find((sql) => (
      /UPDATE session_authority/iu.test(sql)
      && /checkpoint_required_reason\s*=\s*\$reason/iu.test(sql)
    )) ?? "";
    assert.match(markSql, /checkpoint_required_event_position\s+IS\s+NULL/iu);
    assert.match(markSql, /checkpoint_required_event_position\s*</iu);
    const clearSql = connection.prepared.find((sql) => (
      /UPDATE session_authority/iu.test(sql)
      && /checkpoint_required_reason\s*=\s*NULL/iu.test(sql)
    )) ?? "";
    assert.match(clearSql, /checkpoint_required_event_position\s*<=\s*\$checkpointBaseEventPosition/iu);
    assert.deepEqual(connection.execCalls, []);
    assert.equal(connection.closeCalls, 0);
  });

  it("rejects an impossible checkpoint-required timestamp without corrupting SQLite round-trip reads", () => {
    const connection = migratedNativeConnection();
    const repository = new SessionAuthorityRepository();
    const authority = rootAuthority();
    try {
      repository.insertRoot(connection, authority);
      let failure: unknown;
      try {
        repository.markCheckpointRequired(connection, {
          projectId: PROJECT_ID,
          sessionId: ROOT_SESSION_ID,
          reason: "ownership-transfer",
          eventPosition: 2n,
          updatedAt: "2026-02-30T00:00:00.000Z",
        });
      } catch (error) {
        failure = error;
      }

      assert.deepEqual(repository.get(connection, PROJECT_ID, ROOT_SESSION_ID), authority);
      assert.equal((failure as LifecycleError | undefined)?.code, "LIFECYCLE_INPUT_INVALID");
    } finally {
      connection.close();
    }
  });

  it("rejects a checkpoint clear timestamp earlier than createdAt without corrupting SQLite round-trip reads", () => {
    const connection = migratedNativeConnection();
    const repository = new SessionAuthorityRepository();
    const authority = rootAuthority({
      authorityEventPosition: 2n,
      checkpointRequiredReason: "ownership-transfer",
      checkpointRequiredEventPosition: 2n,
    });
    try {
      repository.insertRoot(connection, authority);
      let failure: unknown;
      try {
        repository.clearCheckpointRequired(connection, {
          projectId: PROJECT_ID,
          sessionId: ROOT_SESSION_ID,
          checkpointBaseEventPosition: 2n,
          updatedAt: "2026-07-16T23:59:59.999Z",
        });
      } catch (error) {
        failure = error;
      }

      assert.deepEqual(repository.get(connection, PROJECT_ID, ROOT_SESSION_ID), authority);
      assert.equal((failure as LifecycleError | undefined)?.code, "LIFECYCLE_INPUT_INVALID");
    } finally {
      connection.close();
    }
  });
});
