import { strict as assert } from "node:assert";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { parseCliArgs } from "../src/cli/parse-args.js";
import {
  createOrchestratorAdminDependencies,
  runCliCommand,
} from "../src/cli/run-command.js";
import type {
  NonGitWorkspaceSnapshot,
  ProjectBinding,
  ProjectContext,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import { ProjectDescriptorRepository } from "../src/orchestrator/identity/project-descriptor.repository.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";
import { ProjectStoreRouter } from "../src/orchestrator/identity/project-store.router.js";
import { payloadHash } from "../src/orchestrator/crypto/event-hash.js";
import {
  StoreManifestRepository,
  type PreparedStoreIntegrityManifest,
} from "../src/orchestrator/identity/store-manifest.repository.js";
import { EventIntegrityService } from "../src/orchestrator/integrity/event-integrity.service.js";
import { LifecycleIntegrityService } from "../src/orchestrator/integrity/lifecycle-integrity.service.js";
import { lifecycleIntentHashFromWitnessSource } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import type {
  IntegrityIssueCode,
  IntegrityReport,
} from "../src/orchestrator/integrity/integrity.types.js";
import { ProjectStoreUpgradeProbe } from "../src/orchestrator/runtime/project-store-upgrade-probe.js";
import { ProjectStoreUpgradeExecutor } from "../src/orchestrator/runtime/project-store-upgrade-executor.js";
import {
  DEFAULT_EXECUTOR_LEASE_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_PENDING,
  ProjectStoreExecutorRegistry,
} from "../src/orchestrator/runtime/project-store-executor.js";
import { inspectProjectStoreIdentity, runIntegrityChild } from "../src/orchestrator/runtime/project-store-worker-backend.js";
import { WorkerProjectStoreIdentityProbe } from "../src/orchestrator/runtime/project-store-identity-probe.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/orchestrator/runtime/runtime-capabilities.js";
import {
  ProjectStoreUpgradeService,
  type ProjectStoreUpgradeFaultBoundary,
} from "../src/orchestrator/storage/project-store-upgrade.service.js";
import {
  MaintenanceFence,
  MaintenanceFenceError,
  type MaintenanceLease,
} from "../src/orchestrator/storage/maintenance-fence.js";
import {
  MigrationRunner,
  type MigrationApplyMode,
} from "../src/orchestrator/storage/migration-runner.js";
import type { Migration } from "../src/orchestrator/storage/migration.js";
import { DefaultProjectStoreBootstrapService } from "../src/orchestrator/storage/project-store-bootstrap.service.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { inspectStoreSchema } from "../src/orchestrator/storage/schema-compatibility.js";
import { SqliteQualifiedCheckpointMigrationPreflight } from "../src/orchestrator/storage/qualified-checkpoint-migration-preflight.js";
import type {
  SqliteConnection,
  SqliteDriver,
  SqliteOpenOptions,
  SqliteValue,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import type { RootStartCommandV2 } from "../src/orchestrator/lifecycle/contracts/commands.js";
import { buildLifecycleIntentWitness } from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import type { LifecycleEventV1 } from "../src/orchestrator/lifecycle/contracts/events.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import type { SessionId } from "../src/orchestrator/lifecycle/contracts/identifiers.js";
import {
  authorityCommitment,
  type CommittedAuthorityV1,
} from "../src/orchestrator/lifecycle/authority/authority-commitment.js";
import {
  checkpointFixture,
  lifecycleEvent,
} from "./support/lifecycle-fixtures.js";

const NOW = "2026-07-14T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const VAULT_ID = "22222222-2222-4222-8222-222222222222" as VaultId;
const STORE_ID = "33333333-3333-4333-8333-333333333333" as StoreId;
const WORKSPACE_ID = "upgrade-workspace" as WorkspaceId;
const FOLD_SESSION_ID = "66666666-6666-4666-8666-666666666666" as SessionId;
const FOLD_CORRELATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roots: string[] = [];
const connections: SqliteConnection[] = [];
const driver = new NodeSqliteDriver({ DatabaseSync });
const UPGRADE_CHILD_PATH = fileURLToPath(
  new URL("./fixtures/project-store-upgrade-child.js", import.meta.url),
);

interface UpgradePlan {
  projectId: string;
  storeId: string;
  appliedVersion: number;
  targetVersion: number;
  pending: readonly { version: number; name: string; checksum: string }[];
  status: "current" | "upgrade-required";
}

interface UpgradeResult {
  plan: UpgradePlan;
  appliedVersions: readonly number[];
  resumedPostCommit: boolean;
  integrity: { ok: boolean; issues: readonly { code: string }[] };
}

interface Fixture {
  root: string;
  path: string;
  context: ProjectContext;
  manifestRepository: StoreManifestRepository;
}

function transaction<T>(connection: SqliteConnection, operation: () => T): T {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    try { connection.exec("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  }
}

function createV1Store(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "project-store-upgrade-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const vaultRoot = join(projectRoot, "memory");
  mkdirSync(vaultRoot, { recursive: true });
  const identifiers = [PROJECT_ID, VAULT_ID];
  const descriptorRepository = new ProjectDescriptorRepository({
    now: () => NOW,
    randomId: () => identifiers.shift()!,
  });
  const descriptor = descriptorRepository.createExplicit(projectRoot, vaultRoot);
  const workspace: NonGitWorkspaceSnapshot = {
    kind: "non-git",
    workspaceRoot: projectRoot,
    workspaceId: WORKSPACE_ID,
  };
  const route = new ProjectStoreRouter().route(descriptor, vaultRoot, workspace);
  mkdirSync(route.storeRoot, { recursive: true });
  const manifestRepository = new StoreManifestRepository({ now: () => NOW });
  manifestRepository.createExplicit(route, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  });
  const connection = driver.open(route.eventsPath, {
    mode: "create",
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  });
  new MigrationRunner().apply(
    connection,
    [eventCoreMigration],
    NOW,
    { kind: "bootstrap-empty", beforeMigration: () => undefined },
  );
  transaction(connection, () => {
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
  });
  connection.close();
  const bindingMaterial: Omit<ProjectBinding, "contextFingerprint"> = {
    projectBindingId: "upgrade-binding",
    generation: 1,
    source: "explicit-cli",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "upgrade-tests",
    clientInstanceId: "upgrade-client",
    actorRole: "maintenance",
    projectRoot,
    vaultRoot,
    descriptorPath: join(vaultRoot, ".memory-mcp", "project-identity.json"),
    storeRoute: route,
    workspace,
    establishedAt: NOW,
  };
  const binding: ProjectBinding = {
    ...bindingMaterial,
    contextFingerprint: computeProjectContextFingerprint(bindingMaterial),
  };
  return {
    root,
    path: route.eventsPath,
    context: { binding, workspace, checkedAt: NOW },
    manifestRepository,
  };
}

function openExisting(fixture: Fixture): SqliteConnection {
  const connection = driver.open(fixture.path, {
    mode: "existing",
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  });
  connections.push(connection);
  return connection;
}

class RecordingRenewalFence extends MaintenanceFence {
  readonly renewals: Array<{
    readonly input: MaintenanceLease;
    readonly output: MaintenanceLease;
  }> = [];
  readonly readinessLeases: MaintenanceLease[] = [];

  constructor(private readonly afterReady: () => void) {
    super();
  }

  override renewOwner(
    connection: SqliteConnection,
    lease: MaintenanceLease,
    now: string,
    trustedTtlMs: number,
  ): MaintenanceLease {
    const renewed = super.renewOwner(connection, lease, now, trustedTtlMs);
    this.renewals.push({ input: { ...lease }, output: { ...renewed } });
    return renewed;
  }

  override assertReady(
    connection: SqliteConnection,
    lease: MaintenanceLease,
    now: string,
  ): void {
    super.assertReady(connection, lease, now);
    this.readinessLeases.push({ ...lease });
    this.afterReady();
  }
}

class RecordingTargetFaultMigrationRunner extends MigrationRunner {
  activeMigrationVersion: number | undefined;

  override apply(
    connection: SqliteConnection,
    registry: readonly Migration[],
    appliedAt: string,
    mode: MigrationApplyMode,
  ): number[] {
    if (mode.kind !== "explicit-upgrade") {
      return super.apply(connection, registry, appliedAt, mode);
    }
    const delegate = mode.faultInjector;
    return super.apply(connection, registry, appliedAt, {
      ...mode,
      faultInjector: {
        hit: (boundary, migration): void => {
          this.activeMigrationVersion = migration.version;
          try {
            delegate?.hit(boundary, migration);
          } finally {
            this.activeMigrationVersion = undefined;
          }
        },
      },
    });
  }
}

function construct<T>(constructor: unknown, ...args: unknown[]): T {
  return Reflect.construct(
    constructor as new (...args: unknown[]) => T,
    args,
  );
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ManualLeaseScheduler {
  readonly #scheduled = new Map<object, () => void>();

  setTimeout = (callback: () => void, _milliseconds: number): object => {
    const handle = {};
    this.#scheduled.set(handle, callback);
    return handle;
  };

  clearTimeout = (handle: object): void => {
    this.#scheduled.delete(handle);
  };

  runNext(): void {
    const next = this.#scheduled.entries().next().value as
      | readonly [object, () => void]
      | undefined;
    assert.notEqual(next, undefined, "expected one scheduled lease heartbeat");
    this.#scheduled.delete(next![0]);
    next![1]();
  }
}

function currentFullIntegrity(fixture: Fixture): IntegrityReport {
  const connection = driver.open(fixture.path, {
    mode: "read-only-existing",
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  });
  try {
    return new EventIntegrityService(
      connection,
      PROJECT_STORE_MIGRATIONS,
      [new LifecycleIntegrityService(connection)],
    ).fullCheck(fixture.context);
  } finally {
    connection.close();
  }
}

function syntheticPreparedManifest(
  preparationId = "55555555-5555-4555-8555-555555555555",
): PreparedStoreIntegrityManifest {
  return {
    version: 1,
    preparationId,
    temporaryBasename: `.store-manifest.json.upgrade.${preparationId}.tmp`,
    contentSha256: "a".repeat(64),
  };
}

function lifecycleIssueCodes(
  connection: SqliteConnection,
  context: ProjectContext,
  mode: "quick" | "full" = "quick",
): readonly IntegrityIssueCode[] {
  const codes: IntegrityIssueCode[] = [];
  const integrity = new LifecycleIntegrityService(connection);
  integrity[mode === "quick" ? "quickCheck" : "fullCheck"](context, {
    add(code): void { codes.push(code); },
  });
  return codes;
}

function authorityCommitmentForStoredRow(
  row: Readonly<Record<string, SqliteValue>>,
): string {
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

function refreshStoredAuthorityCommitment(
  connection: SqliteConnection,
  sessionId: string,
): string {
  const row = connection.prepare(`
    SELECT * FROM session_authority
    WHERE project_id = $projectId AND session_id = $sessionId
  `).get({ $projectId: PROJECT_ID, $sessionId: sessionId });
  assert.notEqual(row, undefined);
  const commitment = authorityCommitmentForStoredRow(row!);
  connection.prepare(`
    UPDATE session_authority SET authority_commitment = $commitment
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $commitment: commitment,
    $projectId: PROJECT_ID,
    $sessionId: sessionId,
  });
  return commitment;
}

function rootStartIntent(values: {
  commandId: string;
  idempotencyKey: string;
  targetSessionId: string;
  workspaceId: string;
  continuityKey: string;
}): ReturnType<typeof buildLifecycleIntentWitness> {
  return buildLifecycleIntentWitness({
    commandType: "root-start",
    commandId: values.commandId,
    idempotencyKey: values.idempotencyKey,
    agentId: "fold-agent",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: values.workspaceId,
    expectedBranchRef: null,
    continuityKey: values.continuityKey,
    resumePolicy: "new",
  } as RootStartCommandV2, {
    authorizationKind: "initial-authority",
    authorizationSessionId: null,
    targetSessionId: values.targetSessionId,
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: values.workspaceId,
    clientNamespace: "upgrade-tests",
    capabilityKind: null,
    capabilityGeneration: null,
    presentingActorRole: "primary",
    presentingClientInstanceId: "presenting-client",
    targetActorRole: "primary",
    targetClientInstanceId: "target-client",
    internalWorkflowId: null,
    internalWorkflowGeneration: null,
    internalPlannedWorkId: null,
  });
}

function insertLifecycleAuthorizationCommand(
  connection: SqliteConnection,
  values: {
    commandId: string;
    idempotencyKey: string;
    commandType: "root-start" | "abandon-session" | "internal-workflow-phase";
    kind: "initial-authority" | "protected" | "internal-workflow";
    witnessAlreadyPresent?: boolean;
    witnessJson?: string;
    commandHash?: string;
  },
): void {
  const protectedCommand = values.kind === "protected";
  const internalCommand = values.kind === "internal-workflow";
  if (values.witnessAlreadyPresent !== true) {
    const position = Number(connection.prepare(`
      SELECT coalesce(max(global_position), 0) + 1 AS position FROM events
    `).get()?.position);
    const sessionId = `${position.toString(16).padStart(8, "0")}-0000-4000-8000-${position.toString(16).padStart(12, "0")}`;
    const streamId = `session/${sessionId}`;
    const witness = values.witnessJson ?? rootStartIntent({
      commandId: sessionId,
      idempotencyKey: `upgrade-fixture-${position}`,
      targetSessionId: sessionId,
      workspaceId: "e".repeat(64),
      continuityKey: `upgrade-fixture-${position}`,
    }).source;
    connection.prepare(`
      INSERT INTO streams(
        project_id, stream_id, stream_type, current_version, created_at, updated_at
      ) VALUES ($projectId, $streamId, 'session', 1, $now, $now)
    `).run({ $projectId: PROJECT_ID, $streamId: streamId, $now: NOW });
    connection.prepare(`
      INSERT INTO events(
        global_position, event_id, project_id, vault_id, store_id, workspace_id,
        branch_scope_id, branch_ref, stream_id, stream_type, stream_version,
        event_type, event_schema_version, session_id, parent_session_id,
        actor_role, agent_id, client_instance_id, correlation_id, causation_id,
        command_id, idempotency_key, command_event_index, occurred_at, recorded_at,
        visibility_scope, confidence, verification_status, source_refs_json,
        evidence_refs_json, evidence_digests_json, payload_json, payload_hash,
        previous_global_hash, event_hash, lifecycle_intent_json
      ) VALUES (
        $position, $eventId, $projectId, $vaultId, $storeId, $workspaceId,
        NULL, NULL, $streamId, 'session', 1, 'SessionStarted', 1, $sessionId,
        NULL, 'primary', 'upgrade-agent', 'upgrade-client', $correlationId, NULL,
        $commandId, $idempotencyKey, 0, $now, $now, 'session', 'high',
        'verified', '[]', '[]', '[]', '{}', $hash, $genesis, $hash,
        $lifecycleIntentJson
      )
    `).run({
      $position: position,
      $eventId: `${position.toString(16).padStart(8, "0")}-0000-4000-8000-${position.toString(16).padStart(12, "0")}`,
      $projectId: PROJECT_ID,
      $vaultId: VAULT_ID,
      $storeId: STORE_ID,
      $workspaceId: WORKSPACE_ID,
      $streamId: streamId,
      $sessionId: sessionId,
      $correlationId: `upgrade-intent-${position}`,
      $commandId: values.commandId,
      $idempotencyKey: values.idempotencyKey,
      $now: NOW,
      $hash: "a".repeat(64),
      $genesis: "0".repeat(64),
      $lifecycleIntentJson: witness,
    });
  }
  connection.prepare(`
    INSERT INTO command_dedup(
      project_id, idempotency_key, command_id, command_type, command_hash,
      workspace_head_commit, outbox_order_json, state, first_global_position,
      last_global_position, final_stream_version, event_ids_json, response_json,
      response_hash, committed_at, lifecycle_authorization_kind,
      authorization_proof_version, authorization_proof_nonce,
      authorization_proof_digest, authorization_approval_id,
      authorization_approval_digest, authorization_session_id, target_session_id,
      presenting_actor_role, presenting_client_instance_id, target_actor_role,
      target_client_instance_id, internal_workflow_id,
      internal_workflow_generation, internal_planned_work_id,
      internal_claim_owner_id, internal_claim_token
    ) VALUES (
      $projectId, $idempotencyKey, $commandId, $commandType, $hash,
      NULL, '[]', 'committed', 1, 1, 1, '[]', '{}', $hash, $now, $kind,
      $proofVersion, $proofNonce, $proofDigest, $approvalId, $approvalDigest,
      $authorizationSessionId, $targetSessionId, 'primary', 'presenting-client',
      'primary', 'target-client', $workflowId, $workflowGeneration,
      $plannedWorkId, $claimOwnerId, $claimToken
    )
  `).run({
    $projectId: PROJECT_ID,
    $idempotencyKey: values.idempotencyKey,
    $commandId: values.commandId,
    $commandType: values.commandType,
    $hash: values.commandHash ?? "a".repeat(64),
    $now: NOW,
    $kind: values.kind,
    $proofVersion: protectedCommand ? 1 : null,
    $proofNonce: protectedCommand ? "44444444-4444-4444-8444-444444444444" : null,
    $proofDigest: protectedCommand ? "b".repeat(64) : null,
    $approvalId: protectedCommand ? "55555555-5555-4555-8555-555555555555" : null,
    $approvalDigest: protectedCommand ? "c".repeat(64) : null,
    $authorizationSessionId: values.kind === "initial-authority"
      ? null
      : "66666666-6666-4666-8666-666666666666",
    $targetSessionId: "66666666-6666-4666-8666-666666666666",
    $workflowId: internalCommand ? "session-end/test-root" : null,
    $workflowGeneration: internalCommand ? 1 : null,
    $plannedWorkId: internalCommand ? "d".repeat(64) : null,
    $claimOwnerId: internalCommand ? "coordinator-owner" : null,
    $claimToken: internalCommand ? 1 : null,
  });
}

function seedFoldableRootAuthority(
  connection: SqliteConnection,
  context: ProjectContext,
): ProjectContext {
  const sessionId = FOLD_SESSION_ID;
  const commandId = "99999999-9999-4999-8999-999999999999";
  const workspaceId = "e".repeat(64) as WorkspaceId;
  const continuityFingerprint = "a".repeat(64);
  const intent = rootStartIntent({
    commandId,
    idempotencyKey: "upgrade-test/root-start",
    targetSessionId: sessionId,
    workspaceId,
    continuityKey: "fold-continuity",
  });
  const foldContext: ProjectContext = {
    ...context,
    binding: { ...context.binding, workspaceId },
    workspace: { ...context.workspace, workspaceId },
  };
  const authorityCommitmentValue = authorityCommitment({
    authorityVersion: 1,
    projectId: PROJECT_ID,
    sessionId,
    sessionKind: "root",
    parentSessionId: null,
    workspaceId,
    clientNamespace: foldContext.binding.clientNamespace,
    ownerGeneration: "1",
    childCapabilityGeneration: null,
    directAccessEnabled: false,
    continuityFingerprintAlgorithm: "hmac-sha256",
    continuityFingerprintSchemaVersion: 1,
    continuityFingerprintKeyId: "continuity-key-1",
    continuityFingerprintDomain: "pm-continuity-v1",
    continuityFingerprint,
    rootHandleCapabilityVersion: 1,
    rootHandleKeyId: "capability-key-1",
    rootHandleIssueNonce: "c".repeat(64),
    rootHandleIssuedAt: NOW,
    rootHandlePolicyCode: "root-default-v1",
    rootHandleExpiryKind: "until-revoked",
    rootHandleExpiresAt: null,
    rootHandleActorRole: "primary",
    rootHandleClientInstanceId: "fold-client",
    rootHandleVerifier: "d".repeat(64),
    resumeTokenCapabilityVersion: 1,
    resumeTokenKeyId: "capability-key-1",
    resumeTokenIssueNonce: "d".repeat(64),
    resumeTokenIssuedAt: NOW,
    resumeTokenPolicyCode: "resume-default-v1",
    resumeTokenExpiryKind: "until-revoked",
    resumeTokenExpiresAt: null,
    resumeTokenActorRole: "primary",
    resumeTokenVerifier: "d".repeat(64),
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
    revocationReasonCode: null,
    revocationEventPosition: null,
    revokedAt: null,
    terminalEventPosition: null,
    terminalEventType: null,
    terminalAt: null,
  });
  connection.prepare(`
    INSERT INTO streams(
      project_id, stream_id, stream_type, current_version, created_at, updated_at
    ) VALUES ($projectId, $streamId, 'session', 1, $now, $now)
  `).run({
    $projectId: PROJECT_ID,
    $streamId: `session/${sessionId}`,
    $now: NOW,
  });
  const payload = {
    sessionKind: "root",
    ownerGeneration: 1,
    continuityKey: "fold-continuity",
    clientNamespace: foldContext.binding.clientNamespace,
    creatingAgentId: "fold-agent",
    creatingClientInstanceId: "fold-client",
    authorityCommitment: authorityCommitmentValue,
  };
  connection.prepare(`
    INSERT INTO events(
      global_position, event_id, project_id, vault_id, store_id, workspace_id,
      branch_scope_id, branch_ref, stream_id, stream_type, stream_version,
      event_type, event_schema_version, session_id, parent_session_id,
      actor_role, agent_id, client_instance_id, correlation_id, causation_id,
      command_id, idempotency_key, command_event_index, occurred_at, recorded_at,
      visibility_scope, confidence, verification_status, source_refs_json,
      evidence_refs_json, evidence_digests_json, payload_json, payload_hash,
      previous_global_hash, event_hash, lifecycle_intent_json
    ) VALUES (
      1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $projectId, $vaultId,
      $storeId, $workspaceId, NULL, NULL, $streamId, 'session', 1,
      'SessionStarted', 1, $sessionId, NULL, 'primary', 'fold-agent',
      'presenting-client', $correlationId, NULL,
      $commandId, 'upgrade-test/root-start', 0, $now, $now, 'session', 'high',
      'verified', '[]', '[]', '[]', $payloadJson, $payloadHash, $genesis, $hash,
      $lifecycleIntentJson
    )
  `).run({
    $projectId: PROJECT_ID,
    $vaultId: VAULT_ID,
    $storeId: STORE_ID,
    $workspaceId: workspaceId,
    $streamId: `session/${sessionId}`,
    $sessionId: sessionId,
    $commandId: commandId,
    $correlationId: FOLD_CORRELATION_ID,
    $now: NOW,
    $payloadJson: canonicalJson(payload),
    $payloadHash: payloadHash(payload),
    $lifecycleIntentJson: intent.source,
    $hash: "b".repeat(64),
    $genesis: "0".repeat(64),
  });
  insertLifecycleAuthorizationCommand(connection, {
    commandId,
    idempotencyKey: "upgrade-test/root-start",
    commandType: "root-start",
    kind: "initial-authority",
    witnessAlreadyPresent: true,
    witnessJson: intent.source,
    commandHash: lifecycleIntentHashFromWitnessSource(intent.source),
  });
  connection.prepare(`
    INSERT INTO session_authority(
      project_id, session_id, stream_id, session_kind, parent_session_id,
      workspace_id, client_namespace, semantic_state, owner_generation,
      child_capability_generation, direct_access_enabled,
      continuity_fingerprint_algorithm, continuity_fingerprint_schema_version,
      continuity_fingerprint_key_id, continuity_fingerprint_domain,
      continuity_fingerprint, root_handle_capability_version, root_handle_key_id,
      root_handle_issue_nonce, root_handle_issued_at, root_handle_policy_code,
      root_handle_expiry_kind, root_handle_expires_at, root_handle_actor_role,
      root_handle_client_instance_id, root_handle_verifier, root_handle_issuance_id,
      resume_token_capability_version, resume_token_key_id, resume_token_issue_nonce,
      resume_token_issued_at, resume_token_policy_code, resume_token_expiry_kind,
      resume_token_expires_at, resume_token_actor_role, resume_token_verifier,
      resume_token_issuance_id, child_handle_capability_version,
      child_handle_key_id, child_handle_issue_nonce, child_handle_issued_at,
      child_handle_policy_code, child_handle_expiry_kind, child_handle_expires_at,
      child_handle_actor_role, child_handle_client_instance_id,
      child_handle_verifier, child_handle_issuance_id, authority_commitment,
      authority_event_position, latest_checkpoint_id,
      latest_checkpoint_event_position, latest_checkpoint_fingerprint,
      checkpoint_required_reason, checkpoint_required_event_position,
      revocation_reason_code, revocation_event_position, revoked_at,
      terminal_event_position, terminal_event_type, terminal_at, created_at, updated_at
    ) VALUES (
      $projectId, $sessionId, $streamId, 'root', NULL, $workspaceId,
      $clientNamespace, 'active', 1, NULL, 0, 'hmac-sha256', 1,
      'continuity-key-1', 'pm-continuity-v1', $continuityFingerprint, 1,
      'capability-key-1', $nonce, $now, 'root-default-v1', 'until-revoked',
      NULL, 'primary', 'fold-client', $hash, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      1, 'capability-key-1', $hash, $now, 'resume-default-v1', 'until-revoked',
      NULL, 'primary', $hash, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      $authorityCommitment, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, $now, $now
    )
  `).run({
    $projectId: PROJECT_ID,
    $sessionId: sessionId,
    $streamId: `session/${sessionId}`,
    $workspaceId: workspaceId,
    $clientNamespace: foldContext.binding.clientNamespace,
    $continuityFingerprint: continuityFingerprint,
    $authorityCommitment: authorityCommitmentValue,
    $nonce: "c".repeat(64),
    $hash: "d".repeat(64),
    $now: NOW,
  });
  return foldContext;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value as never), "utf8")
    .digest("hex");
}

function appendLifecycleEvent(
  connection: SqliteConnection,
  event: LifecycleEventV1,
): void {
  connection.prepare(`
    INSERT INTO events(
      global_position, event_id, project_id, vault_id, store_id, workspace_id,
      branch_scope_id, branch_ref, stream_id, stream_type, stream_version,
      event_type, event_schema_version, session_id, parent_session_id,
      actor_role, agent_id, client_instance_id, correlation_id, causation_id,
      command_id, idempotency_key, command_event_index, occurred_at, recorded_at,
      visibility_scope, confidence, verification_status, source_refs_json,
      evidence_refs_json, evidence_digests_json, payload_json, payload_hash,
      previous_global_hash, event_hash, lifecycle_intent_json
    ) VALUES (
      $globalPosition, $eventId, $projectId, $vaultId, $storeId, $workspaceId,
      NULL, NULL, $streamId, 'session', $streamVersion, $eventType, 1,
      $sessionId, $parentSessionId, 'primary', 'fold-agent', 'fold-client',
      $correlationId, $causationId, $commandId, $idempotencyKey, 0,
      $occurredAt, $occurredAt, 'session', 'high', 'verified', '[]', '[]', '[]',
      $payloadJson, $payloadHash, $previousGlobalHash, $eventHash, NULL
    )
  `).run({
    $globalPosition: BigInt(event.globalPosition),
    $eventId: event.eventId,
    $projectId: event.projectId,
    $vaultId: event.vaultId,
    $storeId: event.storeId,
    $workspaceId: event.workspaceId,
    $streamId: event.streamId,
    $streamVersion: BigInt(event.streamVersion),
    $eventType: event.eventType,
    $sessionId: event.sessionId,
    $parentSessionId: event.parentSessionId,
    $correlationId: event.correlationId,
    $causationId: event.causationId,
    $commandId: event.commandId,
    $idempotencyKey: event.idempotencyKey,
    $occurredAt: event.occurredAt,
    $payloadJson: canonicalJson(event.payload),
    $payloadHash: payloadHash(event.payload),
    $previousGlobalHash: "0".repeat(64),
    $eventHash: event.globalPosition.padStart(64, "0"),
  });
  connection.prepare(`
    UPDATE streams
    SET current_version = $streamVersion, updated_at = $occurredAt
    WHERE project_id = $projectId AND stream_id = $streamId
  `).run({
    $streamVersion: BigInt(event.streamVersion),
    $occurredAt: event.occurredAt,
    $projectId: event.projectId,
    $streamId: event.streamId,
  });
}

function seedCheckpointedRootAuthority(
  connection: SqliteConnection,
  context: ProjectContext,
): {
  context: ProjectContext;
  checkpointId: string;
  fingerprint: string;
} {
  const foldContext = seedFoldableRootAuthority(connection, context);
  const checkpoint = Object.freeze({
    ...checkpointFixture({
      sessionId: FOLD_SESSION_ID,
      parentSessionId: null,
      baseEventPosition: 1,
      checkpointEventPosition: 2,
    }),
    sourceState: Object.freeze({
      ...checkpointFixture().sourceState,
      workspaceId: foldContext.binding.workspaceId,
    }),
  });
  const checkpointEvent = lifecycleEvent(2, "SessionCheckpointRecorded", {
    checkpoint,
    baseEventPosition: "1",
    checkpointEventPosition: "2",
  }, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: foldContext.binding.workspaceId,
    sessionId: FOLD_SESSION_ID,
    parentSessionId: null,
    streamId: `session/${FOLD_SESSION_ID}`,
    correlationId: FOLD_CORRELATION_ID,
    authorityCommitment: "a".repeat(64),
  }) as LifecycleEventV1;
  appendLifecycleEvent(connection, checkpointEvent);
  const fingerprint = createHash("sha256")
    .update("project-memory/checkpoint/v1\n", "utf8")
    .update(canonicalJson(checkpoint), "utf8")
    .digest("hex");
  connection.prepare(`
    UPDATE session_authority
    SET latest_checkpoint_id = $checkpointId,
        latest_checkpoint_event_position = 2,
        latest_checkpoint_fingerprint = $fingerprint,
        updated_at = $updatedAt
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $checkpointId: checkpoint.checkpointId,
    $fingerprint: fingerprint,
    $updatedAt: checkpointEvent.occurredAt,
    $projectId: PROJECT_ID,
    $sessionId: FOLD_SESSION_ID,
  });
  refreshStoredAuthorityCommitment(connection, FOLD_SESSION_ID);
  return { context: foldContext, checkpointId: checkpoint.checkpointId, fingerprint };
}

function seedSuspensionMarker(
  connection: SqliteConnection,
  context: ProjectContext,
): ProjectContext {
  const seeded = seedCheckpointedRootAuthority(connection, context);
  const requested = lifecycleEvent(3, "SessionSuspendRequested", {
    checkpointId: seeded.checkpointId as never,
  }, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: seeded.context.binding.workspaceId,
    sessionId: FOLD_SESSION_ID,
    parentSessionId: null,
    streamId: `session/${FOLD_SESSION_ID}`,
    correlationId: FOLD_CORRELATION_ID,
    authorityCommitment: "a".repeat(64),
  }) as LifecycleEventV1;
  appendLifecycleEvent(connection, requested);
  connection.prepare(`
    UPDATE session_authority
    SET checkpoint_required_reason = 'suspension',
        checkpoint_required_event_position = 3,
        updated_at = $updatedAt
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $updatedAt: requested.occurredAt,
    $projectId: PROJECT_ID,
    $sessionId: FOLD_SESSION_ID,
  });
  refreshStoredAuthorityCommitment(connection, FOLD_SESSION_ID);
  return seeded.context;
}

function seedAbandonedRootAuthority(
  connection: SqliteConnection,
  context: ProjectContext,
): { context: ProjectContext; occurredAt: string } {
  const foldContext = seedFoldableRootAuthority(connection, context);
  const occurrenceProbe = lifecycleEvent(2, "SessionAbandoned", {
    reasonCode: "approved-abandonment",
    authorityCommitment: "0".repeat(64),
  }, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: foldContext.binding.workspaceId,
    sessionId: FOLD_SESSION_ID,
    parentSessionId: null,
    streamId: `session/${FOLD_SESSION_ID}`,
    correlationId: FOLD_CORRELATION_ID,
    authorityCommitment: "0".repeat(64),
  }) as LifecycleEventV1;
  const authorityRow = connection.prepare(`
    SELECT * FROM session_authority
    WHERE project_id = $projectId AND session_id = $sessionId
  `).get({ $projectId: PROJECT_ID, $sessionId: FOLD_SESSION_ID });
  assert.notEqual(authorityRow, undefined);
  const abandonedCommitment = authorityCommitmentForStoredRow({
    ...authorityRow!,
    revocation_reason_code: "approved-abandonment",
    revocation_event_position: 2,
    revoked_at: occurrenceProbe.occurredAt,
    terminal_event_position: 2,
    terminal_event_type: "SessionAbandoned",
    terminal_at: occurrenceProbe.occurredAt,
  });
  const abandoned = lifecycleEvent(2, "SessionAbandoned", {
    reasonCode: "approved-abandonment",
    authorityCommitment: abandonedCommitment,
  }, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: foldContext.binding.workspaceId,
    sessionId: FOLD_SESSION_ID,
    parentSessionId: null,
    streamId: `session/${FOLD_SESSION_ID}`,
    correlationId: FOLD_CORRELATION_ID,
    authorityCommitment: abandonedCommitment,
  }) as LifecycleEventV1;
  appendLifecycleEvent(connection, abandoned);
  connection.prepare(`
    UPDATE session_authority
    SET semantic_state = 'abandoned',
        authority_commitment = $authorityCommitment,
        authority_event_position = 2,
        revocation_reason_code = 'approved-abandonment',
        revocation_event_position = 2,
        revoked_at = $occurredAt,
        terminal_event_position = 2,
        terminal_event_type = 'SessionAbandoned',
        terminal_at = $occurredAt,
        updated_at = $occurredAt
    WHERE project_id = $projectId AND session_id = $sessionId
  `).run({
    $authorityCommitment: abandoned.authorityCommitment,
    $occurredAt: abandoned.occurredAt,
    $projectId: PROJECT_ID,
    $sessionId: FOLD_SESSION_ID,
  });
  return { context: foldContext, occurredAt: abandoned.occurredAt };
}

afterEach(() => {
  for (const connection of connections.splice(0)) {
    try { connection.close(); } catch { /* cleanup continues */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function optionalModule(path: string): Promise<Record<string, unknown> | null> {
  try {
    return await import(path) as Record<string, unknown>;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as Error & { code?: unknown }).code === "ERR_MODULE_NOT_FOUND"
    ) {
      return null;
    }
    throw error;
  }
}

type UpgradeChildMessage =
  | { type: "ready" }
  | { type: "result"; code: number; stdout: string; stderr: string }
  | { type: "failure"; message: string };

function waitForUpgradeChild(
  child: ChildProcess,
  expected: UpgradeChildMessage["type"],
  stderr: string[],
): Promise<UpgradeChildMessage> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectMessage(new Error(`UPGRADE_CHILD_TIMEOUT:${expected}:${stderr.join("")}`));
    }, 30_000);
    const onMessage = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      const type = Reflect.get(value, "type");
      if (type === "failure") {
        cleanup();
        rejectMessage(new Error(String(Reflect.get(value, "message"))));
      } else if (type === expected) {
        cleanup();
        resolveMessage(value as UpgradeChildMessage);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectMessage(new Error(
        `UPGRADE_CHILD_EXIT:${String(code ?? signal)}:${stderr.join("")}`,
      ));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

describe("explicit project-store upgrade", () => {
  it("exposes dedicated inspection, fenced apply, and executor APIs", async () => {
    const [service, probe, executor] = await Promise.all([
      optionalModule("../src/orchestrator/storage/project-store-upgrade.service.js"),
      optionalModule("../src/orchestrator/runtime/project-store-upgrade-probe.js"),
      optionalModule("../src/orchestrator/runtime/project-store-upgrade-executor.js"),
    ]);

    assert.equal(typeof service?.ProjectStoreUpgradeService, "function");
    assert.equal(typeof probe?.ProjectStoreUpgradeProbe, "function");
    assert.equal(typeof executor?.ProjectStoreUpgradeExecutor, "function");
  });

  it("recognizes orchestrator-upgrade as an explicit dry-run command", () => {
    const parsed = parseCliArgs([
      "orchestrator-upgrade",
      "--project-root", "C:\\project",
      "--vault", "C:\\project\\memory",
    ]);

    assert.equal(String(parsed.command), "orchestrator-upgrade");
    assert.equal(parsed.dryRun, true);
  });

  it("inspects an exact Version 1 prefix read-only and closes its handle", async () => {
    const fixture = createV1Store();
    const before = readFileSync(fixture.path);
    const probe = construct<{
      inspect(context: ProjectContext): UpgradePlan | Promise<UpgradePlan>;
    }>(ProjectStoreUpgradeProbe, { sqliteDriver: driver });

    const plan = await probe.inspect(fixture.context);

    assert.equal(plan.status, "upgrade-required");
    assert.equal(plan.appliedVersion, 1);
    assert.equal(plan.targetVersion, 5);
    assert.deepEqual(plan.pending.map(({ version }) => version), [2, 3, 4, 5]);
    assert.deepEqual(readFileSync(fixture.path), before);
    const renamed = `${fixture.path}.renamed`;
    renameSync(fixture.path, renamed);
    renameSync(renamed, fixture.path);
  });

  it("applies one explicit semantic upgrade and publishes full integrity", async () => {
    const fixture = createV1Store();
    const service = construct<{
      inspect(context: ProjectContext): UpgradePlan | Promise<UpgradePlan>;
      apply(context: ProjectContext): Promise<UpgradeResult>;
    }>(ProjectStoreUpgradeService, {
      sqliteDriver: driver,
      now: () => NOW,
      randomId: () => "upgrade-owner-a",
      trustedTtlMs: 60_000,
      manifestRepository: fixture.manifestRepository,
    });

    const dryRun = await service.inspect(fixture.context);
    const result = await service.apply(fixture.context);

    assert.equal(dryRun.status, "upgrade-required");
    assert.deepEqual(result.appliedVersions, [2, 3, 4, 5]);
    assert.equal(result.resumedPostCommit, false);
    assert.equal(result.integrity.ok, true);
    const connection = openExisting(fixture);
    assert.equal(inspectStoreSchema(connection, PROJECT_STORE_MIGRATIONS).status, "current");
    assert.deepEqual(
      connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
        .map((row) => Number(row.version)),
      [1, 2, 3, 4, 5],
    );
  });

  it("uses both concrete defaults and calls an explicit two-argument preflight override once", async () => {
    const zeroArgumentFixture = createV1Store();
    const zeroArgumentResult = await new ProjectStoreUpgradeService().apply(
      zeroArgumentFixture.context,
    );
    assert.deepEqual(zeroArgumentResult.appliedVersions, [2, 3, 4, 5]);

    const oneArgumentFixture = createV1Store();
    const oneArgumentResult = await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: oneArgumentFixture.manifestRepository,
    }).apply(oneArgumentFixture.context);
    assert.deepEqual(oneArgumentResult.appliedVersions, [2, 3, 4, 5]);

    const overrideFixture = createV1Store();
    const concrete = new SqliteQualifiedCheckpointMigrationPreflight();
    let calls = 0;
    const overrideResult = await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: overrideFixture.manifestRepository,
    }, {
      assertEligibleAndStage(connection, projectContext): void {
        calls += 1;
        concrete.assertEligibleAndStage(connection, projectContext);
      },
    }).apply(overrideFixture.context);
    assert.deepEqual(overrideResult.appliedVersions, [2, 3, 4, 5]);
    assert.equal(calls, 1);
  });

  it("keeps migration-4 preflight read-only and outside migration-3 staging", async () => {
    const fixture = createV1Store();
    const qualified = new SqliteQualifiedCheckpointMigrationPreflight();
    let version4Calls = 0;
    const service = construct<ProjectStoreUpgradeService>(ProjectStoreUpgradeService, {
      sqliteDriver: driver,
      manifestRepository: fixture.manifestRepository,
      sessionEndPreflight: {
        assertEligible(connection: SqliteConnection): void {
          version4Calls += 1;
          assert.equal(
            connection.prepare(`
              SELECT count(*) AS count
              FROM sqlite_temp_schema
              WHERE name GLOB 'qualified_checkpoint_v3*'
            `).get()?.count,
            0n,
          );
          assert.equal(
            connection.prepare("SELECT max(version) AS version FROM schema_migrations")
              .get()?.version,
            3n,
          );
        },
      },
    }, qualified);

    const result = await service.apply(fixture.context);

    assert.deepEqual(result.appliedVersions, [2, 3, 4, 5]);
    assert.equal(version4Calls, 1);
  });

  it("routes every target fault boundary through migration 4", async () => {
    const fixture = createV1Store();
    const migrationRunner = new RecordingTargetFaultMigrationRunner();
    const observed: Array<{
      readonly boundary: ProjectStoreUpgradeFaultBoundary;
      readonly migrationVersion: number | undefined;
    }> = [];
    const targetBoundaries = [
      "after-target-ddl-before-migration-row",
      "after-migration-row-before-project-version",
      "after-project-version-before-commit",
    ] as const satisfies readonly ProjectStoreUpgradeFaultBoundary[];
    const service = new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      migrationRunner,
      manifestRepository: fixture.manifestRepository,
      faultInjector: {
        hit(boundary): void {
          if (
            boundary === "after-target-ddl-before-migration-row"
            || boundary === "after-migration-row-before-project-version"
            || boundary === "after-project-version-before-commit"
          ) {
            observed.push({
              boundary,
              migrationVersion: migrationRunner.activeMigrationVersion,
            });
          }
        },
      },
    });

    const result = await service.apply(fixture.context);

    assert.deepEqual(result.appliedVersions, [2, 3, 4, 5]);
    assert.deepEqual(
      observed,
      targetBoundaries.map((boundary) => ({ boundary, migrationVersion: 4 })),
    );
  });

  it("keeps the nonregistered owner open through manifest publication and fence release", async () => {
    const fixture = createV1Store();
    const observations: string[] = [];
    let owner: SqliteConnection | null = null;
    let ownerClosed = false;
    const recordingDriver: SqliteDriver = {
      open(path: string, options: SqliteOpenOptions): SqliteConnection {
        const connection = driver.open(path, options);
        if (options.mode !== "existing") return connection;
        const wrapped: SqliteConnection = {
          exec(sql): void { connection.exec(sql); },
          prepare(sql) { return connection.prepare(sql); },
          close(): void {
            const mode = String(connection.prepare(`
              SELECT mode FROM maintenance_state WHERE singleton = 1
            `).get()?.mode);
            observations.push(`close:${mode}`);
            ownerClosed = true;
            connection.close();
          },
        };
        owner = wrapped;
        return wrapped;
      },
    };
    const service = new ProjectStoreUpgradeService({
      sqliteDriver: recordingDriver,
      manifestRepository: fixture.manifestRepository,
      manifestPreparer: {
        async prepare(): Promise<PreparedStoreIntegrityManifest> {
          return syntheticPreparedManifest();
        },
        discard(): void { /* synthetic artifact */ },
      },
      manifestPublisher: {
        publish(): void {
          assert.equal(ownerClosed, false);
          assert.ok(owner !== null);
          assert.equal(
            owner.prepare(`SELECT mode FROM maintenance_state WHERE singleton = 1`).get()?.mode,
            "quiescing",
          );
          observations.push("manifest");
        },
      },
    });

    const result = await service.apply(fixture.context);

    assert.deepEqual(result.appliedVersions, [2, 3, 4, 5]);
    assert.deepEqual(observations, ["manifest", "close:idle"]);
    const verification = openExisting(fixture);
    assert.equal(
      verification.prepare("SELECT count(*) AS count FROM maintenance_required_executors")
        .get()?.count,
      0n,
    );
  });

  it("commits fence acquisition before quiesce and accepts owner-side closure confirmation", async () => {
    const fixture = createV1Store();
    const fence = new MaintenanceFence();
    const executorId = "commit-before-quiesce-executor";
    const setup = openExisting(fixture);
    transaction(setup, () => fence.registerExecutor(
      setup,
      PROJECT_ID,
      executorId,
      fixture.context.binding.generation,
      fixture.context.binding.contextFingerprint,
      "2026-07-14T00:05:00.000Z",
      NOW,
    ));

    let service!: ProjectStoreUpgradeService;
    let observedCommittedFence = false;
    service = new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      maintenanceFence: fence,
      manifestRepository: fixture.manifestRepository,
      now: () => NOW,
      randomId: () => "commit-before-quiesce-owner",
      executorRegistry: {
        async quiesceStore(_context, lease) {
          const observer = openExisting(fixture);
          const state = observer.prepare(`
            SELECT mode, owner_id FROM maintenance_state WHERE singleton = 1
          `).get();
          assert.equal(state?.mode, "quiescing");
          assert.equal(state?.owner_id, lease.ownerId);
          assert.equal(observer.prepare(`
            SELECT count(*) AS count FROM maintenance_required_executors
            WHERE epoch = $epoch AND executor_id = $executorId
          `).get({ $epoch: lease.epoch, $executorId: executorId })?.count, 1n);
          observedCommittedFence = true;

          transaction(observer, () => fence.acknowledge(
            observer,
            lease,
            executorId,
            NOW,
          ));
          await service.confirmMaintenanceClosure({
            projectId: PROJECT_ID,
            executorId,
            lease,
            connectionClosed: true,
          });
        },
      },
    });

    const result = await service.apply(fixture.context);

    assert.equal(observedCommittedFence, true);
    assert.deepEqual(result.appliedVersions, [2, 3, 4, 5]);
    assert.equal(setup.prepare(`
      SELECT closed_at FROM executor_leases
      WHERE project_id = $projectId AND executor_id = $executorId
    `).get({ $projectId: PROJECT_ID, $executorId: executorId })?.closed_at, NOW);
  });

  it("keeps takeover excluded across post-commit integrity and manifest publication", async () => {
    const fixture = createV1Store();
    const fence = new MaintenanceFence();
    const observations: string[] = [];
    const assertTakeoverExcluded = (boundary: string): void => {
      const contender = boundary === "manifest-publication"
        ? driver.open(fixture.path, { mode: "existing", busyTimeoutMs: 0 })
        : openExisting(fixture);
      if (boundary === "manifest-publication") connections.push(contender);
      assert.throws(
        () => transaction(contender, () => fence.acquire(
          contender,
          `contender-${boundary}`,
          "2026-07-14T00:10:00.000Z",
          NOW,
        )),
        (error: unknown) => error instanceof Error
          && (("code" in error
            && (error as Error & { code: unknown }).code === "MAINTENANCE_ALREADY_ACTIVE")
            || (boundary === "manifest-publication" && error.message === "database is locked")),
      );
      observations.push(boundary);
    };
    const service = new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      maintenanceFence: fence,
      now: () => NOW,
      randomId: () => "post-commit-owner",
      trustedTtlMs: 60_000,
      manifestRepository: fixture.manifestRepository,
      faultInjector: {
        hit(boundary) {
          if (
            boundary === "after-commit-before-full-integrity"
            || boundary === "after-full-integrity-before-manifest-record"
          ) assertTakeoverExcluded(boundary);
        },
      },
      manifestPreparer: {
        async prepare(): Promise<PreparedStoreIntegrityManifest> {
          return syntheticPreparedManifest();
        },
        discard(): void { /* synthetic artifact */ },
      },
      manifestPublisher: {
        publish() {
          assertTakeoverExcluded("manifest-publication");
        },
      },
    });

    const result = await service.apply(fixture.context);

    assert.deepEqual(result.appliedVersions, [2, 3, 4, 5]);
    assert.deepEqual(observations, [
      "after-commit-before-full-integrity",
      "after-full-integrity-before-manifest-record",
      "manifest-publication",
    ]);
    const afterRelease = openExisting(fixture);
    assert.doesNotThrow(() => transaction(afterRelease, () => fence.acquire(
      afterRelease,
      "post-release-owner",
      "2026-07-14T00:10:00.000Z",
      NOW,
    )));
  });

  it("keeps the lease live while post-commit integrity spans its original TTL", async () => {
    const fixture = createV1Store();
    const fence = new MaintenanceFence();
    const scheduler = new ManualLeaseScheduler();
    const integrityStarted = deferred<void>();
    const releaseIntegrity = deferred<void>();
    let clockMs = Date.parse(NOW);
    let report!: IntegrityReport;
    const service = construct<ProjectStoreUpgradeService>(ProjectStoreUpgradeService, {
      sqliteDriver: driver,
      maintenanceFence: fence,
      now: () => new Date(clockMs).toISOString(),
      randomId: () => "heartbeat-integrity-owner",
      trustedTtlMs: 1_000,
      leaseHeartbeatMs: 250,
      leaseScheduler: scheduler,
      postCommitIntegrityRunner: {
        run(): Promise<IntegrityReport> {
          report = currentFullIntegrity(fixture);
          integrityStarted.resolve(undefined);
          return releaseIntegrity.promise.then(() => report);
        },
      },
      manifestPreparer: {
        async prepare(): Promise<PreparedStoreIntegrityManifest> {
          return syntheticPreparedManifest();
        },
        discard(): void { /* synthetic artifact */ },
      },
      manifestPublisher: { publish() { /* publication is not held in this case */ } },
    });

    const applying = service.apply(fixture.context);
    await Promise.race([
      integrityStarted.promise,
      applying.then(() => { throw new Error("POSTCOMMIT_INTEGRITY_RUNNER_NOT_USED"); }),
    ]);
    const phaseStartExpiry = Date.parse(String(openExisting(fixture).prepare(`
      SELECT lease_expires_at FROM maintenance_state WHERE singleton = 1
    `).get()?.lease_expires_at));
    while (clockMs <= phaseStartExpiry + 250) {
      clockMs += 250;
      scheduler.runNext();
    }

    const contender = openExisting(fixture);
    assert.throws(
      () => transaction(contender, () => fence.acquire(
        contender,
        "heartbeat-integrity-contender",
        new Date(clockMs + 1_000).toISOString(),
        new Date(clockMs).toISOString(),
      )),
      (error: unknown) => error instanceof Error
        && "code" in error
        && (error as Error & { code: unknown }).code === "MAINTENANCE_ALREADY_ACTIVE",
    );

    releaseIntegrity.resolve(undefined);
    const result = await applying;
    assert.equal(result.integrity.ok, true);
    assert.equal(
      openExisting(fixture).prepare(`
        SELECT mode FROM maintenance_state WHERE singleton = 1
      `).get()?.mode,
      "idle",
    );
  });

  it("keeps the lease live while asynchronous manifest publication spans its original TTL", async () => {
    const fixture = createV1Store();
    const fence = new MaintenanceFence();
    const scheduler = new ManualLeaseScheduler();
    const manifestStarted = deferred<void>();
    const releaseManifest = deferred<void>();
    let clockMs = Date.parse(NOW);
    let publications = 0;
    const service = construct<ProjectStoreUpgradeService>(ProjectStoreUpgradeService, {
      sqliteDriver: driver,
      maintenanceFence: fence,
      now: () => new Date(clockMs).toISOString(),
      randomId: () => "heartbeat-manifest-owner",
      trustedTtlMs: 1_000,
      leaseHeartbeatMs: 250,
      leaseScheduler: scheduler,
      postCommitIntegrityRunner: {
        async run(): Promise<IntegrityReport> {
          return currentFullIntegrity(fixture);
        },
      },
      manifestPreparer: {
        prepare(): Promise<PreparedStoreIntegrityManifest> {
          manifestStarted.resolve(undefined);
          return releaseManifest.promise.then(() => syntheticPreparedManifest());
        },
        discard(): void { /* synthetic artifact */ },
      },
      manifestPublisher: {
        publish(): void { publications += 1; },
      },
    });

    const applying = service.apply(fixture.context);
    await Promise.race([
      manifestStarted.promise,
      applying.then(() => { throw new Error("ASYNC_MANIFEST_RECORDER_NOT_AWAITED"); }),
    ]);
    const phaseStartExpiry = Date.parse(String(openExisting(fixture).prepare(`
      SELECT lease_expires_at FROM maintenance_state WHERE singleton = 1
    `).get()?.lease_expires_at));
    while (clockMs <= phaseStartExpiry + 250) {
      clockMs += 250;
      scheduler.runNext();
    }

    const contender = openExisting(fixture);
    assert.throws(
      () => transaction(contender, () => fence.acquire(
        contender,
        "heartbeat-manifest-contender",
        new Date(clockMs + 1_000).toISOString(),
        new Date(clockMs).toISOString(),
      )),
      (error: unknown) => error instanceof Error
        && "code" in error
        && (error as Error & { code: unknown }).code === "MAINTENANCE_ALREADY_ACTIVE",
    );

    releaseManifest.resolve(undefined);
    const result = await applying;
    assert.equal(result.integrity.ok, true);
    assert.equal(publications, 1);
    assert.equal(
      openExisting(fixture).prepare(`
        SELECT mode FROM maintenance_state WHERE singleton = 1
      `).get()?.mode,
      "idle",
    );
  });

  it("aborts a guarded phase on renewal loss without publishing or releasing", async () => {
    const fixture = createV1Store();
    let loseRenewal = false;
    const fence = new class extends MaintenanceFence {
      override renewOwner(
        connection: SqliteConnection,
        lease: MaintenanceLease,
        now: string,
        trustedTtlMs: number,
      ): MaintenanceLease {
        if (loseRenewal) throw new MaintenanceFenceError("MAINTENANCE_LEASE_STALE");
        return super.renewOwner(connection, lease, now, trustedTtlMs);
      }
    }();
    const scheduler = new ManualLeaseScheduler();
    const integrityStarted = deferred<void>();
    const releaseIntegrity = deferred<void>();
    let phaseSignal!: AbortSignal;
    let manifestCalls = 0;
    const service = construct<ProjectStoreUpgradeService>(ProjectStoreUpgradeService, {
      sqliteDriver: driver,
      maintenanceFence: fence,
      now: () => NOW,
      randomId: () => "lost-heartbeat-owner",
      trustedTtlMs: 1_000,
      leaseHeartbeatMs: 250,
      leaseScheduler: scheduler,
      postCommitIntegrityRunner: {
        run(_context: ProjectContext, signal: AbortSignal): Promise<IntegrityReport> {
          phaseSignal = signal;
          integrityStarted.resolve(undefined);
          return releaseIntegrity.promise.then(() => currentFullIntegrity(fixture));
        },
      },
      manifestPreparer: {
        async prepare(): Promise<PreparedStoreIntegrityManifest> {
          manifestCalls += 1;
          return syntheticPreparedManifest();
        },
        discard(): void { /* synthetic artifact */ },
      },
      manifestPublisher: {
        publish(): void { manifestCalls += 1; },
      },
    });

    const applying = service.apply(fixture.context);
    await Promise.race([
      integrityStarted.promise,
      applying.then(() => { throw new Error("POSTCOMMIT_INTEGRITY_RUNNER_NOT_USED"); }),
    ]);
    loseRenewal = true;
    scheduler.runNext();
    assert.equal(phaseSignal.aborted, true);
    releaseIntegrity.resolve(undefined);

    await assert.rejects(
      applying,
      (error: unknown) => error instanceof Error
        && "code" in error
        && (error as Error & { code: unknown }).code === "MAINTENANCE_LEASE_STALE",
    );
    assert.equal(manifestCalls, 0);
    assert.equal(
      openExisting(fixture).prepare(`
        SELECT mode FROM maintenance_state WHERE singleton = 1
      `).get()?.mode,
      "quiescing",
    );

    assert.equal(manifestCalls, 0);
    assert.equal(
      openExisting(fixture).prepare(`
        SELECT mode FROM maintenance_state WHERE singleton = 1
      `).get()?.mode,
      "quiescing",
    );
  });

  it("never publishes a late prepared manifest after a contender takes the lease", async () => {
    const fixture = createV1Store();
    const fence = new MaintenanceFence();
    const scheduler = new ManualLeaseScheduler();
    const preparationStarted = deferred<void>();
    const releasePreparation = deferred<void>();
    const phaseFinished = deferred<void>();
    const originalManifest = readFileSync(
      fixture.context.binding.storeRoute.storeManifestPath,
      "utf8",
    );
    const lateManifest = `${JSON.stringify({
      ...JSON.parse(originalManifest) as Record<string, unknown>,
      lastIntegrity: {
        status: "passed",
        checkedAt: NOW,
        schemaFingerprint: "late-publication",
        terminalEventHash: "late-publication",
      },
    }, null, 2)}\n`;
    let clockMs = Date.parse(NOW);
    let phaseSignal!: AbortSignal;
    let publisherCalls = 0;
    const prepared = syntheticPreparedManifest();
    const service = construct<ProjectStoreUpgradeService>(ProjectStoreUpgradeService, {
      sqliteDriver: driver,
      maintenanceFence: fence,
      now: () => new Date(clockMs).toISOString(),
      randomId: () => "late-publication-owner",
      trustedTtlMs: 1_000,
      leaseHeartbeatMs: 250,
      leaseScheduler: scheduler,
      postCommitIntegrityRunner: {
        async run(): Promise<IntegrityReport> {
          return currentFullIntegrity(fixture);
        },
      },
      manifestPreparer: {
        prepare(
          _context: ProjectContext,
          _report: IntegrityReport,
          signal: AbortSignal,
        ): Promise<typeof prepared> {
          phaseSignal = signal;
          preparationStarted.resolve(undefined);
          return releasePreparation.promise.then(() => {
            phaseFinished.resolve(undefined);
            return prepared;
          });
        },
        discard(): void { /* the prepared artifact is synthetic */ },
      },
      manifestPublisher: {
        publish(): void {
          publisherCalls += 1;
          writeFileSync(
            fixture.context.binding.storeRoute.storeManifestPath,
            lateManifest,
            "utf8",
          );
        },
      },
    });

    const applying = service.apply(fixture.context);
    await Promise.race([
      preparationStarted.promise,
      applying.then(() => { throw new Error("MANIFEST_PREPARATION_NOT_USED"); }),
    ]);
    const ownerState = openExisting(fixture).prepare(`
      SELECT lease_expires_at FROM maintenance_state WHERE singleton = 1
    `).get();
    clockMs = Date.parse(String(ownerState?.lease_expires_at)) + 1;
    const contender = openExisting(fixture);
    transaction(contender, () => fence.acquire(
      contender,
      "late-publication-contender",
      new Date(clockMs + 1_000).toISOString(),
      new Date(clockMs).toISOString(),
    ));
    scheduler.runNext();
    releasePreparation.resolve(undefined);

    await assert.rejects(
      applying,
      (error: unknown) => error instanceof Error
        && "code" in error
        && (error as Error & { code: unknown }).code === "MAINTENANCE_LEASE_STALE",
    );
    await phaseFinished.promise;
    assert.equal(phaseSignal.aborted, true);
    assert.equal(publisherCalls, 0);
    assert.equal(
      readFileSync(fixture.context.binding.storeRoute.storeManifestPath, "utf8"),
      originalManifest,
    );
    assert.equal(
      openExisting(fixture).prepare(`
        SELECT mode, owner_id FROM maintenance_state WHERE singleton = 1
      `).get()?.owner_id,
      "late-publication-contender",
    );
  });

  it("publishes a prepared manifest only inside the exact owner transaction", async () => {
    const fixture = createV1Store();
    const fence = new MaintenanceFence();
    let ownerTransactionOpen = false;
    let publisherCalls = 0;
    let contenderBlocked = false;
    const recordingDriver: SqliteDriver = {
      open(path: string, options: SqliteOpenOptions): SqliteConnection {
        const connection = driver.open(path, options);
        if (options.mode !== "existing") return connection;
        return {
          exec(sql): void {
            const statement = sql.trim().toUpperCase();
            if (statement === "BEGIN IMMEDIATE") ownerTransactionOpen = true;
            try {
              connection.exec(sql);
            } finally {
              if (statement === "COMMIT" || statement === "ROLLBACK") {
                ownerTransactionOpen = false;
              }
            }
          },
          prepare(sql) { return connection.prepare(sql); },
          close() { connection.close(); },
        };
      },
    };
    const resultFor = (report: IntegrityReport) => ({
      ok: report.ok,
      schemaFingerprint: report.schemaFingerprint,
      terminalEventHash: report.terminalEventHash,
    });
    const identity = {
      projectId: fixture.context.binding.projectId,
      vaultId: fixture.context.binding.vaultId,
      storeId: fixture.context.binding.storeId,
    };
    const repository = fixture.manifestRepository as unknown as {
      prepareIntegrity(
        route: ProjectContext["binding"]["storeRoute"],
        expected: typeof identity,
        result: ReturnType<typeof resultFor>,
        preparationId: string,
      ): unknown;
      publishPreparedIntegrity(
        route: ProjectContext["binding"]["storeRoute"],
        expected: typeof identity,
        result: ReturnType<typeof resultFor>,
        prepared: unknown,
      ): unknown;
      discardPreparedIntegrity(
        route: ProjectContext["binding"]["storeRoute"],
        prepared: unknown,
      ): void;
    };
    const service = construct<ProjectStoreUpgradeService>(ProjectStoreUpgradeService, {
      sqliteDriver: recordingDriver,
      maintenanceFence: fence,
      manifestRepository: fixture.manifestRepository,
      now: () => NOW,
      randomId: () => "transactional-manifest-owner",
      trustedTtlMs: 60_000,
      postCommitIntegrityRunner: {
        async run(): Promise<IntegrityReport> {
          return currentFullIntegrity(fixture);
        },
      },
      manifestPreparer: {
        async prepare(_context: ProjectContext, report: IntegrityReport): Promise<unknown> {
          return repository.prepareIntegrity(
            fixture.context.binding.storeRoute,
            identity,
            resultFor(report),
            "77777777-7777-4777-8777-777777777777",
          );
        },
        discard(_context: ProjectContext, prepared: unknown): void {
          repository.discardPreparedIntegrity(
            fixture.context.binding.storeRoute,
            prepared,
          );
        },
      },
      manifestPublisher: {
        publish(_context: ProjectContext, report: IntegrityReport, prepared: unknown): void {
          publisherCalls += 1;
          assert.equal(ownerTransactionOpen, true);
          const contender = driver.open(fixture.path, {
            mode: "existing",
            busyTimeoutMs: 0,
          });
          connections.push(contender);
          assert.throws(() => transaction(contender, () => fence.acquire(
            contender,
            "transactional-manifest-contender",
            "2026-07-14T00:10:00.000Z",
            NOW,
          )));
          contenderBlocked = true;
          repository.publishPreparedIntegrity(
            fixture.context.binding.storeRoute,
            identity,
            resultFor(report),
            prepared,
          );
        },
      },
    });

    const result = await service.apply(fixture.context);

    assert.equal(result.integrity.ok, true);
    assert.equal(publisherCalls, 1);
    assert.equal(contenderBlocked, true);
    assert.equal(ownerTransactionOpen, false);
    assert.equal(
      fixture.manifestRepository.inspect(fixture.context.binding.storeRoute, identity).status,
      "valid",
    );
  });

  it("renews the same owner monotonically and requires physical closure readiness", () => {
    const fixture = createV1Store();
    const connection = openExisting(fixture);
    const fence = new MaintenanceFence() as unknown as MaintenanceFence & {
      renewOwner(
        connection: SqliteConnection,
        lease: { epoch: bigint; fencingToken: bigint; ownerId: string; leaseExpiresAt: string },
        now: string,
        trustedTtlMs: number,
      ): { epoch: bigint; fencingToken: bigint; ownerId: string; leaseExpiresAt: string };
      assertReady(
        connection: SqliteConnection,
        lease: { epoch: bigint; fencingToken: bigint; ownerId: string; leaseExpiresAt: string },
        now: string,
      ): void;
    };
    const lease = transaction(connection, () => fence.acquire(
      connection,
      "upgrade-owner",
      "2026-07-14T00:01:00.000Z",
      NOW,
    ));

    const renewed = transaction(connection, () => fence.renewOwner(
      connection,
      lease,
      "2026-07-14T00:00:30.000Z",
      60_000,
    ));

    assert.equal(renewed.epoch, lease.epoch);
    assert.equal(renewed.fencingToken, lease.fencingToken);
    assert.equal(renewed.ownerId, lease.ownerId);
    assert.equal(renewed.leaseExpiresAt, "2026-07-14T00:02:00.000Z");
    transaction(connection, () => fence.assertReady(
      connection,
      renewed,
      "2026-07-14T00:01:59.999Z",
    ));
    assert.throws(
      () => transaction(connection, () => fence.assertReady(
        connection,
        renewed,
        "2026-07-14T00:02:00.000Z",
      )),
      (error: unknown) => error instanceof Error
        && "code" in error
        && (error as Error & { code: unknown }).code === "MAINTENANCE_LEASE_STALE",
    );
  });

  it("renews and threads the returned lease through every mutable migration boundary", async () => {
    const fixture = createV1Store();
    let clockMs = new Date(NOW).getTime();
    const fence = new RecordingRenewalFence(() => {
      clockMs += 700;
    });
    const service = new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      maintenanceFence: fence,
      manifestRepository: fixture.manifestRepository,
      now: () => new Date(clockMs).toISOString(),
      randomId: () => "boundary-renewal-owner",
      trustedTtlMs: 1_000,
    });

    const result = await service.apply(fixture.context);

    assert.deepEqual(result.appliedVersions, [2, 3, 4, 5]);
    assert.ok(fence.renewals.length >= 9);
    assert.equal(fence.readinessLeases.length, fence.renewals.length);
    for (let index = 0; index < fence.renewals.length; index += 1) {
      const renewal = fence.renewals[index]!;
      assert.deepEqual(fence.readinessLeases[index], renewal.output);
      if (index > 0) {
        assert.deepEqual(renewal.input, fence.renewals[index - 1]!.output);
      }
      assert.equal(renewal.output.epoch, renewal.input.epoch);
      assert.equal(renewal.output.fencingToken, renewal.input.fencingToken);
      assert.equal(renewal.output.ownerId, renewal.input.ownerId);
      assert.ok(
        new Date(renewal.output.leaseExpiresAt).getTime()
          > new Date(renewal.input.leaseExpiresAt).getTime(),
      );
    }
  });

  it("dispatches integrity extensions inside quick and full reports", () => {
    const fixture = createV1Store();
    const connection = openExisting(fixture);
    const calls: string[] = [];
    const integrity = construct<{
      quickCheck(context: ProjectContext): { issues: readonly { code: string }[] };
      fullCheck(context: ProjectContext): { issues: readonly { code: string }[] };
    }>(EventIntegrityService,
      connection,
      [eventCoreMigration],
      [{
        quickCheck(_context: ProjectContext, sink: { add(code: string): void }) {
          calls.push("quick");
          sink.add("SESSION_LEASE_INVARIANT_MISMATCH");
        },
        fullCheck(_context: ProjectContext, sink: { add(code: string): void }) {
          calls.push("full");
          sink.add("SESSION_AUTHORITY_FOLD_MISMATCH");
        },
      }],
    );

    const quick = integrity.quickCheck(fixture.context);
    const full = integrity.fullCheck(fixture.context);

    assert.deepEqual(calls, ["quick", "full"]);
    assert.equal(quick.issues.some(({ code }) => code === "SESSION_LEASE_INVARIANT_MISMATCH"), true);
    assert.equal(full.issues.some(({ code }) => code === "SESSION_AUTHORITY_FOLD_MISMATCH"), true);
  });

  it("accepts abandonment's dual witness and rejects corrupt protected or internal metadata", async () => {
    const fixture = createV1Store();
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: fixture.manifestRepository,
    }).apply(fixture.context);
    const connection = openExisting(fixture);
    insertLifecycleAuthorizationCommand(connection, {
      commandId: "77777777-7777-4777-8777-777777777777",
      idempotencyKey: "upgrade-test/abandon",
      commandType: "abandon-session",
      kind: "protected",
    });
    insertLifecycleAuthorizationCommand(connection, {
      commandId: "88888888-8888-4888-8888-888888888888",
      idempotencyKey: "upgrade-test/internal",
      commandType: "internal-workflow-phase",
      kind: "internal-workflow",
    });

    assert.equal(
      lifecycleIssueCodes(connection, fixture.context)
        .includes("COMMAND_AUTHORIZATION_METADATA_MISMATCH"),
      false,
    );

    connection.exec("DROP TRIGGER command_dedup_no_update");
    connection.prepare(`
      UPDATE command_dedup SET authorization_proof_version = 2
      WHERE command_id = '77777777-7777-4777-8777-777777777777'
    `).run();
    assert.equal(
      lifecycleIssueCodes(connection, fixture.context)
        .includes("COMMAND_AUTHORIZATION_METADATA_MISMATCH"),
      true,
    );

    connection.prepare(`
      UPDATE command_dedup SET authorization_proof_version = 1
      WHERE command_id = '77777777-7777-4777-8777-777777777777'
    `).run();
    connection.prepare(`
      UPDATE command_dedup SET internal_planned_work_id = 'not-a-hash'
      WHERE command_id = '88888888-8888-4888-8888-888888888888'
    `).run();
    assert.equal(
      lifecycleIssueCodes(connection, fixture.context)
        .includes("COMMAND_AUTHORIZATION_METADATA_MISMATCH"),
      true,
    );
  });

  it("folds lifecycle events and detects a semantic authority mirror corruption", async () => {
    const fixture = createV1Store();
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: fixture.manifestRepository,
    }).apply(fixture.context);
    const connection = openExisting(fixture);
    const foldContext = seedFoldableRootAuthority(connection, fixture.context);

    assert.equal(
      lifecycleIssueCodes(connection, foldContext, "full")
        .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
      false,
    );

    connection.prepare(`
      UPDATE session_authority SET semantic_state = 'suspended'
      WHERE project_id = $projectId
    `).run({ $projectId: PROJECT_ID });
    refreshStoredAuthorityCommitment(connection, FOLD_SESSION_ID);
    assert.equal(
      lifecycleIssueCodes(connection, foldContext, "full")
        .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
      true,
    );
  });

  it("folds every lifecycle stream and rejects an orphan without an authority mirror", async () => {
    const fixture = createV1Store();
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: fixture.manifestRepository,
    }).apply(fixture.context);
    const connection = openExisting(fixture);
    const foldContext = seedFoldableRootAuthority(connection, fixture.context);
    assert.equal(
      lifecycleIssueCodes(connection, foldContext, "full")
        .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
      false,
    );

    connection.prepare(`
      DELETE FROM session_authority
      WHERE project_id = $projectId AND session_id = $sessionId
    `).run({ $projectId: PROJECT_ID, $sessionId: FOLD_SESSION_ID });

    assert.equal(
      lifecycleIssueCodes(connection, foldContext, "full")
        .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
      true,
    );
  });

  it("reconstructs the complete canonical checkpoint fingerprint", async () => {
    const fixture = createV1Store();
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: fixture.manifestRepository,
    }).apply(fixture.context);
    const connection = openExisting(fixture);
    const seeded = seedCheckpointedRootAuthority(connection, fixture.context);
    assert.equal(
      lifecycleIssueCodes(connection, seeded.context, "full")
        .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
      false,
    );

    connection.prepare(`
      UPDATE session_authority SET latest_checkpoint_fingerprint = $fingerprint
      WHERE project_id = $projectId AND session_id = $sessionId
    `).run({
      $fingerprint: seeded.fingerprint === "f".repeat(64)
        ? "e".repeat(64)
        : "f".repeat(64),
      $projectId: PROJECT_ID,
      $sessionId: FOLD_SESSION_ID,
    });
    refreshStoredAuthorityCommitment(connection, FOLD_SESSION_ID);

    assert.equal(
      lifecycleIssueCodes(connection, seeded.context, "full")
        .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
      true,
    );
  });

  it("reconstructs the fixed checkpoint-required reason", async () => {
    const fixture = createV1Store();
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: fixture.manifestRepository,
    }).apply(fixture.context);
    const connection = openExisting(fixture);
    const foldContext = seedSuspensionMarker(connection, fixture.context);
    assert.equal(
      lifecycleIssueCodes(connection, foldContext, "full")
        .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
      false,
    );

    connection.prepare(`
      UPDATE session_authority SET checkpoint_required_reason = 'ownership-recovery'
      WHERE project_id = $projectId AND session_id = $sessionId
    `).run({ $projectId: PROJECT_ID, $sessionId: FOLD_SESSION_ID });
    refreshStoredAuthorityCommitment(connection, FOLD_SESSION_ID);

    assert.equal(
      lifecycleIssueCodes(connection, foldContext, "full")
        .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
      true,
    );
  });

  it("reconstructs revocation reason and time from the authoritative event", async () => {
    for (const corruption of ["reason", "time"] as const) {
      const fixture = createV1Store();
      await new ProjectStoreUpgradeService({
        sqliteDriver: driver,
        manifestRepository: fixture.manifestRepository,
      }).apply(fixture.context);
      const connection = openExisting(fixture);
      const seeded = seedAbandonedRootAuthority(connection, fixture.context);
      assert.equal(
        lifecycleIssueCodes(connection, seeded.context, "full")
          .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
        false,
        `${corruption}: baseline`,
      );

      connection.prepare(corruption === "reason" ? `
        UPDATE session_authority SET revocation_reason_code = 'suspension'
        WHERE project_id = $projectId AND session_id = $sessionId
      ` : `
        UPDATE session_authority SET revoked_at = '2026-07-14T00:01:00.000Z'
        WHERE project_id = $projectId AND session_id = $sessionId
      `).run({ $projectId: PROJECT_ID, $sessionId: FOLD_SESSION_ID });
      refreshStoredAuthorityCommitment(connection, FOLD_SESSION_ID);

      assert.equal(
        lifecycleIssueCodes(connection, seeded.context, "full")
          .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
        true,
        corruption,
      );
    }
  });

  it("reconstructs terminal_at from the terminal event", async () => {
    const fixture = createV1Store();
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: fixture.manifestRepository,
    }).apply(fixture.context);
    const connection = openExisting(fixture);
    const seeded = seedAbandonedRootAuthority(connection, fixture.context);
    assert.equal(
      lifecycleIssueCodes(connection, seeded.context, "full")
        .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
      false,
    );

    connection.prepare(`
      UPDATE session_authority SET terminal_at = '2026-07-14T00:01:00.000Z'
      WHERE project_id = $projectId AND session_id = $sessionId
    `).run({ $projectId: PROJECT_ID, $sessionId: FOLD_SESSION_ID });
    refreshStoredAuthorityCommitment(connection, FOLD_SESSION_ID);

    assert.equal(
      lifecycleIssueCodes(connection, seeded.context, "full")
        .includes("SESSION_AUTHORITY_FOLD_MISMATCH"),
      true,
    );
  });

  it("runs lifecycle invariants through the ordinary integrity worker", async () => {
    const fixture = createV1Store();
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: fixture.manifestRepository,
    }).apply(fixture.context);
    const connection = openExisting(fixture);
    const foldContext = seedFoldableRootAuthority(connection, fixture.context);
    connection.prepare(`
      UPDATE session_authority SET semantic_state = 'suspended'
      WHERE project_id = $projectId
    `).run({ $projectId: PROJECT_ID });
    refreshStoredAuthorityCommitment(connection, FOLD_SESSION_ID);

    await assert.rejects(
      runIntegrityChild(foldContext, {
        id: "ordinary-current-lifecycle-integrity",
        type: "fullIntegrity",
        binding: {
          projectId: foldContext.binding.projectId,
          vaultId: foldContext.binding.vaultId,
          storeId: foldContext.binding.storeId,
          bindingGeneration: foldContext.binding.generation,
          contextFingerprint: foldContext.binding.contextFingerprint,
        },
      }),
      (error: unknown) => error instanceof LifecycleError
        && error.code === "INTEGRITY_FAILURE",
    );
  });

  it("keeps ordinary identity and integrity paths fenced to the current schema with zero writes", async () => {
    const fixture = createV1Store();
    const before = readFileSync(fixture.path);
    const expected = {
      projectId: fixture.context.binding.projectId,
      vaultId: fixture.context.binding.vaultId,
      storeId: fixture.context.binding.storeId,
    };
    const code = (wanted: string) => (error: unknown): boolean => (
      error instanceof Error
      && "code" in error
      && (error as Error & { code: unknown }).code === wanted
    );

    await assert.rejects(
      inspectProjectStoreIdentity(fixture.context.binding.storeRoute, expected, expected.storeId),
      code("SCHEMA_UPGRADE_REQUIRED"),
    );
    await assert.rejects(
      runIntegrityChild(fixture.context, {
        id: "ordinary-integrity",
        type: "fullIntegrity",
        binding: {
          projectId: expected.projectId,
          vaultId: expected.vaultId,
          storeId: expected.storeId,
          bindingGeneration: fixture.context.binding.generation,
          contextFingerprint: fixture.context.binding.contextFingerprint,
        },
      }),
      code("SCHEMA_UPGRADE_REQUIRED"),
    );
    const workerProbe = new WorkerProjectStoreIdentityProbe({
      workerUrl: new URL("../src/workers/project-store.worker.js", import.meta.url),
      requestTimeoutMs: 10_000,
    });
    await assert.rejects(
      workerProbe.verify(fixture.context.binding.storeRoute, expected),
      code("SCHEMA_UPGRADE_REQUIRED"),
    );
    await assert.rejects(
      new DefaultProjectStoreBootstrapService().initialize({
        projectRoot: fixture.context.binding.projectRoot,
        vaultRoot: fixture.context.binding.vaultRoot,
      }),
      code("SCHEMA_UPGRADE_REQUIRED"),
    );
    assert.deepEqual(readFileSync(fixture.path), before);
  });

  it("keeps too-new and exact-prefix drift as hard typed compatibility failures", async () => {
    const tooNew = createV1Store();
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: tooNew.manifestRepository,
    }).apply(tooNew.context);
    const current = openExisting(tooNew);
    assert.throws(
      () => inspectStoreSchema(current, [eventCoreMigration]),
      (error: unknown) => error instanceof Error
        && "code" in error
        && (error as Error & { code: unknown }).code === "SCHEMA_TOO_NEW",
    );

    for (const drift of [
      {
        code: "MIGRATION_CHECKSUM_MISMATCH",
        mutate(connection: SqliteConnection) {
          connection.exec("DROP TRIGGER schema_migrations_no_update");
          connection.exec("UPDATE schema_migrations SET name = 'drifted' WHERE version = 1");
        },
      },
      {
        code: "MIGRATION_CHECKSUM_MISMATCH",
        mutate(connection: SqliteConnection) {
          connection.exec("DROP TRIGGER schema_migrations_no_update");
          connection.exec(`UPDATE schema_migrations SET checksum = '${"e".repeat(64)}' WHERE version = 1`);
        },
      },
      {
        code: "SCHEMA_FINGERPRINT_MISMATCH",
        mutate(connection: SqliteConnection) {
          connection.exec("CREATE TABLE unapproved_partial_ddl(value TEXT) STRICT");
        },
      },
    ] as const) {
      const fixture = createV1Store();
      const connection = openExisting(fixture);
      drift.mutate(connection);
      connection.close();
      connections.splice(connections.indexOf(connection), 1);
      const probe = new ProjectStoreUpgradeProbe({ sqliteDriver: driver });
      await assert.rejects(
        probe.inspect(fixture.context),
        (error: unknown) => error instanceof Error
          && "code" in error
          && (error as Error & { code: unknown }).code === drift.code,
      );
    }
  });

  it("serializes two IPC-barrier upgrade owners and preserves one semantic upgrade", async () => {
    const fixture = createV1Store();
    const args = [fixture.context.binding.projectRoot, fixture.context.binding.vaultRoot];
    const children = [0, 1].map(() => fork(UPGRADE_CHILD_PATH, args, {
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }));
    const stderr = children.map(() => [] as string[]);
    children.forEach((child, index) => {
      child.stderr?.on("data", (chunk: Buffer | string) => stderr[index]!.push(String(chunk)));
    });
    let messages: UpgradeChildMessage[];
    try {
      await Promise.all(children.map((child, index) => (
        waitForUpgradeChild(child, "ready", stderr[index]!)
      )));
      const results = children.map((child, index) => (
        waitForUpgradeChild(child, "result", stderr[index]!)
      ));
      children.forEach((child) => child.send("go"));
      messages = await Promise.all(results);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    }
    const [left, right] = messages.map((message, index) => {
      assert.equal(message.type, "result");
      assert.equal(message.code, 0, message.stderr || stderr[index]!.join(""));
      const output = JSON.parse(message.stdout) as { result: UpgradeResult };
      return output.result;
    });

    assert.deepEqual(
      [left.appliedVersions, right.appliedVersions]
        .map((versions) => [...versions])
        .sort((a, b) => b.length - a.length),
      [[2, 3, 4, 5], []],
    );
    const connection = openExisting(fixture);
    assert.deepEqual(
      connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
        .map((row) => Number(row.version)),
      [1, 2, 3, 4, 5],
    );
  });

  for (const boundary of [
    "after-fence-before-prefix-integrity",
    "after-target-ddl-before-migration-row",
    "after-migration-row-before-project-version",
    "after-project-version-before-commit",
    "after-commit-before-full-integrity",
    "after-full-integrity-before-manifest-record",
    "after-manifest-record-before-fence-release",
  ] as const satisfies readonly ProjectStoreUpgradeFaultBoundary[]) {
    it(`recovers safely from ${boundary}`, async () => {
      const fixture = createV1Store();
      let clock = NOW;
      const injected = new Error(`INJECTED:${boundary}`);
      const failing = new ProjectStoreUpgradeService({
        sqliteDriver: driver,
        now: () => clock,
        randomId: () => `owner-${boundary}`,
        trustedTtlMs: 60_000,
        manifestRepository: fixture.manifestRepository,
        faultInjector: {
          hit(observed) {
            if (observed === boundary) throw injected;
          },
        },
      });

      await assert.rejects(failing.apply(fixture.context), (error) => error === injected);
      const afterFault = openExisting(fixture);
      const inspection = inspectStoreSchema(afterFault, PROJECT_STORE_MIGRATIONS);
      const preCommit = boundary === "after-fence-before-prefix-integrity"
        || boundary === "after-target-ddl-before-migration-row"
        || boundary === "after-migration-row-before-project-version"
        || boundary === "after-project-version-before-commit";
      assert.equal(inspection.appliedVersion, preCommit ? 1 : 5);
      afterFault.close();
      connections.splice(connections.indexOf(afterFault), 1);

      clock = "2026-07-14T01:00:00.000Z";
      const recovered = await new ProjectStoreUpgradeService({
        sqliteDriver: driver,
        now: () => clock,
        randomId: () => `recovery-${boundary}`,
        trustedTtlMs: 60_000,
        manifestRepository: fixture.manifestRepository,
      }).apply(fixture.context);

      assert.deepEqual(recovered.appliedVersions, preCommit ? [2, 3, 4, 5] : []);
      assert.equal(recovered.resumedPostCommit, !preCommit);
      assert.equal(recovered.integrity.ok, true);
      const renamed = `${fixture.path}.closed`;
      renameSync(fixture.path, renamed);
      renameSync(renamed, fixture.path);
    });
  }

  for (const boundary of [
    "after-fence-before-prefix-integrity",
    "after-target-ddl-before-migration-row",
    "after-migration-row-before-project-version",
    "after-project-version-before-commit",
    "after-commit-before-full-integrity",
    "after-full-integrity-before-manifest-record",
    "after-manifest-record-before-fence-release",
  ] as const satisfies readonly ProjectStoreUpgradeFaultBoundary[]) {
    it(`stops a lease-expired owner at the boundary after ${boundary}`, async () => {
      const fixture = createV1Store();
      let clock = NOW;
      const failing = new ProjectStoreUpgradeService({
        sqliteDriver: driver,
        now: () => clock,
        randomId: () => `expiry-${boundary}`,
        trustedTtlMs: 60_000,
        manifestRepository: fixture.manifestRepository,
        faultInjector: {
          hit(observed) {
            if (observed === boundary) clock = "2026-07-15T00:00:00.000Z";
          },
        },
      });

      await assert.rejects(
        failing.apply(fixture.context),
        (error: unknown) => error instanceof Error
          && "code" in error
          && (error as Error & { code: unknown }).code === "MAINTENANCE_LEASE_STALE",
      );
      const afterExpiry = openExisting(fixture);
      const inspection = inspectStoreSchema(afterExpiry, PROJECT_STORE_MIGRATIONS);
      const preCommit = boundary === "after-fence-before-prefix-integrity"
        || boundary === "after-target-ddl-before-migration-row"
        || boundary === "after-migration-row-before-project-version"
        || boundary === "after-project-version-before-commit";
      assert.equal(inspection.appliedVersion, preCommit ? 1 : 5);
      afterExpiry.close();
      connections.splice(connections.indexOf(afterExpiry), 1);

      clock = "2026-07-14T01:00:00.000Z";
      const recovered = await new ProjectStoreUpgradeService({
        sqliteDriver: driver,
        now: () => clock,
        randomId: () => `expiry-recovery-${boundary}`,
        trustedTtlMs: 60_000,
        manifestRepository: fixture.manifestRepository,
      }).apply(fixture.context);
      assert.deepEqual(recovered.appliedVersions, preCommit ? [2, 3, 4, 5] : []);
      assert.equal(recovered.integrity.ok, true);
    });
  }

  it("leaves a committed store resumable when manifest publication fails", async () => {
    const fixture = createV1Store();
    let clock = NOW;
    const publicationFailure = new Error("MANIFEST_PUBLICATION_FAILED");
    const failing = new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      now: () => clock,
      randomId: () => "manifest-owner",
      trustedTtlMs: 60_000,
      manifestPreparer: {
        async prepare(): Promise<PreparedStoreIntegrityManifest> {
          return syntheticPreparedManifest();
        },
        discard(): void { /* synthetic artifact */ },
      },
      manifestPublisher: {
        publish() { throw publicationFailure; },
      },
    });

    await assert.rejects(failing.apply(fixture.context), (error) => error === publicationFailure);
    const committed = openExisting(fixture);
    assert.equal(inspectStoreSchema(committed, PROJECT_STORE_MIGRATIONS).status, "current");
    committed.close();
    connections.splice(connections.indexOf(committed), 1);

    clock = "2026-07-14T01:00:00.000Z";
    const recovered = await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      now: () => clock,
      randomId: () => "manifest-recovery",
      trustedTtlMs: 60_000,
      manifestRepository: fixture.manifestRepository,
    }).apply(fixture.context);
    assert.deepEqual(recovered.appliedVersions, []);
    assert.equal(recovered.resumedPostCommit, true);
  });

  it("drains a registered executor and confirms physical closure through the live owner", async () => {
    const fixture = createV1Store();
    const { contextFingerprint: _ignored, ...bindingMaterial } = fixture.context.binding;
    const workerContext: ProjectContext = {
      ...fixture.context,
      binding: {
        ...fixture.context.binding,
        contextFingerprint: computeProjectContextFingerprint(bindingMaterial),
      },
    };
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      now: () => NOW,
      randomId: () => "initial-upgrader",
      trustedTtlMs: 60_000,
      manifestRepository: fixture.manifestRepository,
    }).apply(workerContext);

    let service!: ProjectStoreUpgradeService;
    const liveNow = () => new Date().toISOString();
    const registry = new ProjectStoreExecutorRegistry({
      confirmMaintenanceClosure: (confirmation) => service.confirmMaintenanceClosure(confirmation),
    });
    service = new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      executorRegistry: registry as unknown as {
        quiesceStore(context: ProjectContext, lease: {
          epoch: bigint;
          fencingToken: bigint;
          ownerId: string;
          leaseExpiresAt: string;
        }): Promise<void>;
      },
      now: liveNow,
      randomId: () => "drain-owner",
      trustedTtlMs: 60_000,
      manifestRepository: fixture.manifestRepository,
    });
    const executor = await registry.acquire({
      workerUrl: new URL("../src/workers/project-store.worker.js", import.meta.url),
      context: workerContext,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 10_000,
      closeTimeoutMs: 10_000,
      executorLeaseMs: DEFAULT_EXECUTOR_LEASE_MS,
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    });
    const opened = await executor.open();

    const result = await service.apply(workerContext);

    assert.deepEqual(result.appliedVersions, []);
    assert.equal(result.resumedPostCommit, true);
    const connection = openExisting(fixture);
    const required = connection.prepare(`
      SELECT executor_id FROM maintenance_required_executors
      ORDER BY epoch DESC, executor_id
    `).all();
    assert.deepEqual(required.map((row) => row.executor_id), [opened.executorId]);
    const executorRow = connection.prepare(`
      SELECT closed_at FROM executor_leases WHERE executor_id = $executorId
    `).get({ $executorId: opened.executorId });
    assert.equal(typeof executorRow?.closed_at, "string");
    await executor.close();
  });

  it("runs inspection and apply through the dedicated upgrade worker role", async () => {
    const fixture = createV1Store();
    const { contextFingerprint: _ignored, ...bindingMaterial } = fixture.context.binding;
    const workerContext: ProjectContext = {
      ...fixture.context,
      binding: {
        ...fixture.context.binding,
        contextFingerprint: computeProjectContextFingerprint(bindingMaterial),
      },
    };
    const executor = construct<{
      inspect(): Promise<UpgradePlan>;
      apply(): Promise<UpgradeResult>;
      close(): Promise<void>;
    }>(ProjectStoreUpgradeExecutor, {
      workerUrl: new URL("../src/workers/project-store.worker.js", import.meta.url),
      context: workerContext,
      requestTimeoutMs: 30_000,
    });

    try {
      const plan = await executor.inspect();
      const result = await executor.apply();
      assert.equal(plan.status, "upgrade-required");
    assert.deepEqual(result.appliedVersions, [2, 3, 4, 5]);
      assert.equal(result.integrity.ok, true);
    } finally {
      await executor.close();
    }
    const renamed = `${fixture.path}.worker-closed`;
    renameSync(fixture.path, renamed);
    renameSync(renamed, fixture.path);
  });

  it("routes CLI dry-run to inspection only and --apply to the upgrade worker", async () => {
    const fixture = createV1Store();
    const workerUrl = new URL("../src/workers/project-store.worker.js", import.meta.url);
    const dependencies = createOrchestratorAdminDependencies(workerUrl);
    const run = async (argv: string[]) => {
      let stdout = "";
      let stderr = "";
      const code = await runCliCommand(parseCliArgs(argv), {
        stdout(text) { stdout += text; },
        stderr(text) { stderr += text; },
      }, dependencies);
      return { code, stdout, stderr };
    };
    const rootsArgs = [
      "--project-root", fixture.context.binding.projectRoot,
      "--vault", fixture.context.binding.vaultRoot,
    ];
    const before = readFileSync(fixture.path);

    const status = await run(["orchestrator-status", ...rootsArgs]);

    assert.equal(status.code, 1);
    assert.equal(status.stdout, "");
    assert.equal(JSON.parse(status.stderr).code, "SCHEMA_UPGRADE_REQUIRED");
    assert.deepEqual(readFileSync(fixture.path), before);

    const inspected = await run(["orchestrator-upgrade", ...rootsArgs]);

    assert.equal(inspected.code, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).action, "upgrade-inspection");
    assert.deepEqual(readFileSync(fixture.path), before);

    const applied = await run(["orchestrator-upgrade", ...rootsArgs, "--apply"]);
    assert.equal(applied.code, 0, applied.stderr);
    const output = JSON.parse(applied.stdout) as { action: string; result: UpgradeResult };
    assert.equal(output.action, "upgraded");
    assert.deepEqual(output.result.appliedVersions, [2, 3, 4, 5]);
    const renamed = `${fixture.path}.cli-closed`;
    renameSync(fixture.path, renamed);
    renameSync(renamed, fixture.path);
  });

  it("bridges active-executor closure confirmations to the worker owner out of band", async () => {
    const fixture = createV1Store();
    const { contextFingerprint: _ignored, ...bindingMaterial } = fixture.context.binding;
    const workerContext: ProjectContext = {
      ...fixture.context,
      binding: {
        ...fixture.context.binding,
        contextFingerprint: computeProjectContextFingerprint(bindingMaterial),
      },
    };
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: fixture.manifestRepository,
    }).apply(workerContext);

    let upgradeExecutor!: ProjectStoreUpgradeExecutor;
    const registry = new ProjectStoreExecutorRegistry({
      confirmMaintenanceClosure: (confirmation) => (
        upgradeExecutor.confirmMaintenanceClosure(confirmation)
      ),
    });
    const active = await registry.acquire({
      workerUrl: new URL("../src/workers/project-store.worker.js", import.meta.url),
      context: workerContext,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 10_000,
      closeTimeoutMs: 10_000,
      executorLeaseMs: DEFAULT_EXECUTOR_LEASE_MS,
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    });
    const opened = await active.open();
    upgradeExecutor = new ProjectStoreUpgradeExecutor({
      workerUrl: new URL("../src/workers/project-store.worker.js", import.meta.url),
      context: workerContext,
      requestTimeoutMs: 30_000,
    }, { executorRegistry: registry });

    try {
      const result = await upgradeExecutor.apply();
      assert.deepEqual(result.appliedVersions, []);
      const connection = openExisting(fixture);
      assert.equal(
        typeof connection.prepare(`
          SELECT closed_at FROM executor_leases WHERE executor_id = $executorId
        `).get({ $executorId: opened.executorId })?.closed_at,
        "string",
      );
    } finally {
      await active.close();
      await upgradeExecutor.close();
    }
  });

  it("shares the production executor registry with the active upgrade confirmation bridge", async () => {
    const fixture = createV1Store();
    const { contextFingerprint: _ignored, ...bindingMaterial } = fixture.context.binding;
    const workerContext: ProjectContext = {
      ...fixture.context,
      binding: {
        ...fixture.context.binding,
        contextFingerprint: computeProjectContextFingerprint(bindingMaterial),
      },
    };
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: fixture.manifestRepository,
    }).apply(workerContext);

    const dependencies = createOrchestratorAdminDependencies(
      new URL("../src/workers/project-store.worker.js", import.meta.url),
    );
    const active = dependencies.executorFactory(workerContext);
    const opened = await active.open() as { executorId: string };
    const upgrade = dependencies.upgradeExecutorFactory!(workerContext);

    try {
      const result = await upgrade.apply();
      assert.deepEqual(result.appliedVersions, []);
      const connection = openExisting(fixture);
      assert.equal(
        typeof connection.prepare(`
          SELECT closed_at FROM executor_leases WHERE executor_id = $executorId
        `).get({ $executorId: opened.executorId })?.closed_at,
        "string",
      );
    } finally {
      await active.close();
      await upgrade.close();
    }
  });

  it("coalesces concurrent registry quiesce calls for the exact same lease", async () => {
    const fixture = createV1Store();
    const { contextFingerprint: _ignored, ...bindingMaterial } = fixture.context.binding;
    const workerContext: ProjectContext = {
      ...fixture.context,
      binding: {
        ...fixture.context.binding,
        contextFingerprint: computeProjectContextFingerprint(bindingMaterial),
      },
    };
    await new ProjectStoreUpgradeService({
      sqliteDriver: driver,
      manifestRepository: fixture.manifestRepository,
    }).apply(workerContext);
    const owner = openExisting(fixture);
    const fence = new MaintenanceFence();
    let confirmations = 0;
    const registry = new ProjectStoreExecutorRegistry({
      confirmMaintenanceClosure(confirmation) {
        confirmations += 1;
        transaction(owner, () => fence.confirmExecutorClosed(
          owner,
          confirmation.lease,
          confirmation.projectId,
          confirmation.executorId,
          new Date().toISOString(),
        ));
      },
    });
    const active = await registry.acquire({
      workerUrl: new URL("../src/workers/project-store.worker.js", import.meta.url),
      context: workerContext,
      maxPending: DEFAULT_MAX_PENDING,
      requestTimeoutMs: 10_000,
      closeTimeoutMs: 10_000,
      executorLeaseMs: DEFAULT_EXECUTOR_LEASE_MS,
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    });
    await active.open();
    const acquiredAt = new Date().toISOString();
    const lease = transaction(owner, () => fence.acquire(
      owner,
      "coalesced-owner",
      new Date(Date.parse(acquiredAt) + 60_000).toISOString(),
      acquiredAt,
    ));

    await Promise.all([
      registry.quiesceStore(workerContext, lease),
      registry.quiesceStore(workerContext, lease),
    ]);

    assert.equal(confirmations, 1);
    transaction(owner, () => fence.assertReady(owner, lease, new Date().toISOString()));
    await active.close();
  });
});
