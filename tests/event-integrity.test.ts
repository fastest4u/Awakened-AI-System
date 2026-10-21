import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type {
  AppendCommand,
  JsonValue,
  PendingEvent,
  PendingOutbox,
} from "../src/orchestrator/contracts/event.js";
import type {
  GitWorkspaceSnapshot,
  NonGitWorkspaceSnapshot,
  ProjectBinding,
  ProjectContext,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import { ProjectDescriptorRepository } from "../src/orchestrator/identity/project-descriptor.repository.js";
import { ProjectStoreRouter } from "../src/orchestrator/identity/project-store.router.js";
import { StoreManifestRepository } from "../src/orchestrator/identity/store-manifest.repository.js";
import {
  eventHash,
  outboxHash,
  payloadHash,
  responseHash,
} from "../src/orchestrator/crypto/event-hash.js";
import {
  EventIntegrityService,
  MAX_INTEGRITY_RANGE_EVENTS,
  MAX_QUICK_TAIL_EVENTS,
} from "../src/orchestrator/integrity/event-integrity.service.js";
import { LifecycleIntegrityService } from "../src/orchestrator/integrity/lifecycle-integrity.service.js";
import {
  INTEGRITY_ISSUE_CODES,
  IntegrityInputError,
  type AsyncIntegrityExtension,
  type IntegrityExtension,
  type IntegrityIssueCode,
} from "../src/orchestrator/integrity/integrity.types.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/orchestrator/runtime/runtime-capabilities.js";
import {
  buildLifecycleIntentWitness,
  lifecycleIntentHashFromWitnessSource,
  type TrustedLifecycleIntentAssertionsV1,
} from "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import type {
  InternalWorkflowPhaseCommand,
  RootResumeCommandV2,
  RootStartCommandV2,
} from "../src/orchestrator/lifecycle/contracts/commands.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import {
  EventStore,
  GENESIS_GLOBAL_HASH,
  SqliteEventStoreStatements,
} from "../src/orchestrator/storage/event-store.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import type { Migration } from "../src/orchestrator/storage/migration.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import type {
  SqliteConnection,
  SqliteRow,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";

const NOW = "2026-07-13T02:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const VAULT_ID = "22222222-2222-4222-8222-222222222222" as VaultId;
const STORE_ID = "33333333-3333-4333-8333-333333333333" as StoreId;
const WORKSPACE_ID = "a".repeat(64) as WorkspaceId;
const COMMAND_A = "44444444-4444-4444-8444-444444444444";
const COMMAND_B = "55555555-5555-4555-8555-555555555555";
const COMMAND_C = "66666666-6666-4666-8666-666666666666";
const roots: string[] = [];
const connections: SqliteConnection[] = [];
const driver = new NodeSqliteDriver({ DatabaseSync });

interface Fixture {
  root: string;
  path: string;
  connection: SqliteConnection;
  context: ProjectContext;
  integrity: EventIntegrityService;
  manifestRepository: StoreManifestRepository;
  store: EventStore;
}

function uuid(index: number): string {
  const head = index.toString(16).padStart(8, "0").slice(-8);
  const tail = index.toString(16).padStart(12, "0").slice(-12);
  return `${head}-0000-4000-8000-${tail}`;
}

function pendingEvent(eventType: string, ordinal: number): PendingEvent {
  return {
    eventType,
    eventSchemaVersion: 1,
    occurredAt: "2026-07-13T01:59:00.000Z",
    visibilityScope: "project",
    confidence: "high",
    verificationStatus: "verified",
    payload: { ordinal },
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
  };
}

function appendCommand(
  context: ProjectContext,
  commandId: string,
  idempotencyKey: string,
  streamId: string,
  streamType: string,
  firstOrdinal: number,
): AppendCommand<JsonValue> {
  return {
    context,
    commandId,
    idempotencyKey,
    commandType: "RecordIntegrityPair",
    correlationId: `correlation-${streamId}`,
    agentId: "agent-primary",
    expectedStreamVersion: 0n,
    streamId,
    streamType,
    events: [
      pendingEvent(`${streamType}.FirstRecorded`, firstOrdinal),
      pendingEvent(`${streamType}.SecondRecorded`, firstOrdinal + 1),
    ],
    outbox: [],
    publicResponse: { accepted: true, streamId },
  };
}

function createFixture(options: {
  append?: boolean;
  migrations?: readonly Migration[];
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "memory-event-integrity-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const vaultRoot = join(projectRoot, "memory");
  mkdirSync(vaultRoot, { recursive: true });
  const generatedIds = [PROJECT_ID, VAULT_ID];
  const descriptorRepository = new ProjectDescriptorRepository({
    now: () => NOW,
    randomId: () => generatedIds.shift()!,
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
  connections.push(connection);
  const migrations = options.migrations ?? [eventCoreMigration];
  if (migrations.length === PROJECT_STORE_MIGRATIONS.length) {
    applyCurrentProjectStoreSchema(connection, {
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
    }, NOW);
  } else {
    new MigrationRunner().apply(
      connection,
      migrations,
      NOW,
      { kind: "bootstrap-empty", beforeMigration: () => undefined },
    );
    connection.exec("BEGIN IMMEDIATE");
    connection.prepare(`
      INSERT INTO project_meta(
        singleton, project_id, vault_id, store_id, schema_version, created_at
      ) VALUES (1, $projectId, $vaultId, $storeId, $schemaVersion, $createdAt)
    `).run({
      $projectId: PROJECT_ID,
      $vaultId: VAULT_ID,
      $storeId: STORE_ID,
      $schemaVersion: migrations.at(-1)?.version ?? 0,
      $createdAt: NOW,
    });
    connection.exec(`
      INSERT INTO maintenance_state(
        singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
      ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
    `);
    connection.exec("COMMIT");
  }

  const binding: ProjectBinding = {
    projectBindingId: "binding-integrity",
    generation: 1,
    contextFingerprint: "f".repeat(64),
    source: "explicit-cli",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "tests",
    clientInstanceId: "client-integrity",
    actorRole: "primary",
    projectRoot,
    vaultRoot,
    descriptorPath: join(vaultRoot, ".memory-mcp", "project-identity.json"),
    storeRoute: route,
    workspace,
    establishedAt: NOW,
  };
  const context: ProjectContext = { binding, workspace, checkedAt: NOW };
  let nextEventId = 100;
  const eventStore = new EventStore(
    connection,
    new SqliteEventStoreStatements(connection),
    new MaintenanceFence(),
    new BranchScopeRepository(),
    () => NOW,
    () => uuid(nextEventId++),
  );
  if (options.append !== false) {
    eventStore.append(appendCommand(
      context,
      COMMAND_A,
      "integrity:command-a",
      "stream-a",
      "alpha",
      1,
    ));
    eventStore.append(appendCommand(
      context,
      COMMAND_B,
      "integrity:command-b",
      "stream-b",
      "beta",
      3,
    ));
  }
  return {
    root,
    path: route.eventsPath,
    connection,
    context,
    integrity: new EventIntegrityService(connection, migrations),
    manifestRepository,
    store: eventStore,
  };
}

function gitContext(
  fixture: Fixture,
  overrides: Partial<GitWorkspaceSnapshot> = {},
): ProjectContext {
  const workspace: GitWorkspaceSnapshot = {
    kind: "git",
    worktreeRoot: join(fixture.root, "project"),
    gitDir: join(fixture.root, "project", ".git", "worktrees", "integrity"),
    gitCommonDir: join(fixture.root, "project", ".git"),
    headCommit: "0123456789abcdef0123456789abcdef01234567",
    branchRef: "refs/heads/main",
    detached: false,
    workspaceId: "workspace-integrity-git" as WorkspaceId,
    ...overrides,
  };
  return {
    binding: {
      ...fixture.context.binding,
      workspaceId: workspace.workspaceId,
      workspace,
    },
    workspace,
    checkedAt: NOW,
  };
}

function twoOutboxItems(eventIndex = 0): PendingOutbox[] {
  return [
    {
      targetKey: "integrity/outbox/second",
      kind: "materialize-second",
      eventIndex,
      payload: { ordinal: 2 },
    },
    {
      targetKey: "integrity/outbox/first",
      kind: "materialize-first",
      eventIndex,
      payload: { ordinal: 1 },
    },
  ];
}

function issueCodes(report: { issues: readonly { code: string }[] }): string[] {
  return report.issues.map((issue) => issue.code);
}

function uniqueIssueCodes(report: { issues: readonly { code: string }[] }): string[] {
  return [...new Set(issueCodes(report))];
}

function assertIssueCodes(
  report: { ok: boolean; issues: readonly { code: string }[] },
  expected: readonly IntegrityIssueCode[],
): void {
  assert.equal(report.ok, false);
  assert.deepEqual(uniqueIssueCodes(report).sort(), [...expected].sort());
}

function triggerSql(connection: SqliteConnection, name: string): string {
  const sql = connection.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = $name
  `).get({ $name: name })?.sql;
  assert.equal(typeof sql, "string");
  return sql as string;
}

function mutateProtected(
  fixture: Fixture,
  triggerName: string,
  mutate: () => void,
  restoreTrigger = true,
): void {
  const originalTrigger = triggerSql(fixture.connection, triggerName);
  fixture.connection.exec("BEGIN IMMEDIATE");
  try {
    fixture.connection.exec(`DROP TRIGGER ${triggerName}`);
    mutate();
    if (restoreTrigger) fixture.connection.exec(originalTrigger);
    fixture.connection.exec("COMMIT");
  } catch (error) {
    try { fixture.connection.exec("ROLLBACK"); } catch { /* preserve mutation failure */ }
    throw error;
  }
}

function eventRow(connection: SqliteConnection, globalPosition: bigint): SqliteRow {
  const row = connection.prepare(`
    SELECT * FROM events WHERE global_position = $globalPosition
  `).get({ $globalPosition: globalPosition });
  assert.notEqual(row, undefined);
  return row!;
}

function stringField(row: SqliteRow, name: string): string {
  const value = row[name];
  assert.equal(typeof value, "string", name);
  return value as string;
}

function nullableStringField(row: SqliteRow, name: string): string | null {
  const value = row[name];
  assert.ok(value === null || typeof value === "string", name);
  return value as string | null;
}

function bigintField(row: SqliteRow, name: string): bigint {
  const value = row[name];
  assert.equal(typeof value, "bigint", name);
  return value as bigint;
}

function numberField(row: SqliteRow, name: string): number {
  const value = bigintField(row, name);
  assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(value);
}

function parsedField(row: SqliteRow, name: string): JsonValue {
  return JSON.parse(stringField(row, name)) as JsonValue;
}

function recomputedEventHash(
  source: SqliteRow,
  overrides: Partial<Record<string, string | bigint | null>> = {},
): string {
  const row: SqliteRow = { ...source };
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) row[name] = value;
  }
  const lifecycleIntentJson = row.lifecycle_intent_json;
  assert.ok(
    lifecycleIntentJson === undefined
      || lifecycleIntentJson === null
      || typeof lifecycleIntentJson === "string",
    "lifecycle_intent_json",
  );
  const lifecycleIntent = typeof lifecycleIntentJson === "string"
    ? JSON.parse(lifecycleIntentJson) as JsonValue
    : undefined;
  return eventHash({
    globalPosition: bigintField(row, "global_position").toString(),
    eventId: stringField(row, "event_id"),
    projectId: stringField(row, "project_id"),
    vaultId: stringField(row, "vault_id"),
    storeId: stringField(row, "store_id"),
    workspaceId: stringField(row, "workspace_id"),
    branchScopeId: nullableStringField(row, "branch_scope_id"),
    branchRef: nullableStringField(row, "branch_ref"),
    streamId: stringField(row, "stream_id"),
    streamType: stringField(row, "stream_type"),
    streamVersion: bigintField(row, "stream_version").toString(),
    eventType: stringField(row, "event_type"),
    eventSchemaVersion: numberField(row, "event_schema_version"),
    sessionId: nullableStringField(row, "session_id"),
    parentSessionId: nullableStringField(row, "parent_session_id"),
    actorRole: stringField(row, "actor_role"),
    agentId: stringField(row, "agent_id"),
    clientInstanceId: stringField(row, "client_instance_id"),
    correlationId: stringField(row, "correlation_id"),
    causationId: nullableStringField(row, "causation_id"),
    commandId: stringField(row, "command_id"),
    idempotencyKey: stringField(row, "idempotency_key"),
    commandEventIndex: numberField(row, "command_event_index"),
    occurredAt: stringField(row, "occurred_at"),
    recordedAt: stringField(row, "recorded_at"),
    visibilityScope: stringField(row, "visibility_scope"),
    confidence: stringField(row, "confidence"),
    verificationStatus: stringField(row, "verification_status"),
    sourceRefs: parsedField(row, "source_refs_json"),
    evidenceRefs: parsedField(row, "evidence_refs_json"),
    evidenceDigests: parsedField(row, "evidence_digests_json"),
    payloadHash: stringField(row, "payload_hash"),
    previousGlobalHash: stringField(row, "previous_global_hash"),
    ...(lifecycleIntent === undefined ? {} : { lifecycleIntent }),
  });
}

function rehashCompleteEventChain(connection: SqliteConnection): void {
  let previousGlobalHash = GENESIS_GLOBAL_HASH;
  const rows = connection.prepare(`
    SELECT * FROM events ORDER BY global_position
  `).all();
  for (const row of rows) {
    const nextEventHash = recomputedEventHash(row, {
      previous_global_hash: previousGlobalHash,
    });
    connection.prepare(`
      UPDATE events
      SET previous_global_hash = $previousGlobalHash,
          event_hash = $eventHash
      WHERE global_position = $globalPosition
    `).run({
      $previousGlobalHash: previousGlobalHash,
      $eventHash: nextEventHash,
      $globalPosition: bigintField(row, "global_position"),
    });
    previousGlobalHash = nextEventHash;
  }
}

const INTENT_SESSION_ID = "77777777-7777-4777-8777-777777777777";
const INITIAL_INTENT_ASSERTIONS: TrustedLifecycleIntentAssertionsV1 = {
  authorizationKind: "initial-authority",
  authorizationSessionId: null,
  targetSessionId: INTENT_SESSION_ID,
  projectId: PROJECT_ID,
  vaultId: VAULT_ID,
  storeId: STORE_ID,
  workspaceId: WORKSPACE_ID,
  clientNamespace: "tests",
  capabilityKind: null,
  capabilityGeneration: null,
  presentingActorRole: "primary",
  presentingClientInstanceId: "client-integrity",
  targetActorRole: "primary",
  targetClientInstanceId: "client-integrity",
  internalWorkflowId: null,
  internalWorkflowGeneration: null,
  internalPlannedWorkId: null,
};

function lifecycleIntent(command: RootStartCommandV2): {
  commandHash: string;
  witnessJson: string;
} {
  const built = buildLifecycleIntentWitness(command, INITIAL_INTENT_ASSERTIONS);
  return { commandHash: built.intentHash, witnessJson: built.source };
}

function lifecycleIntentWitness(command: RootStartCommandV2): string {
  return lifecycleIntent(command).witnessJson;
}

function lifecycleIntentHash(command: RootStartCommandV2): string {
  return lifecycleIntent(command).commandHash;
}

function withMutableV2Witnesses(fixture: Fixture, mutate: () => void): void {
  const eventsTrigger = triggerSql(fixture.connection, "events_no_update");
  const commandsTrigger = triggerSql(fixture.connection, "command_dedup_no_update");
  fixture.connection.exec("PRAGMA foreign_keys = OFF");
  fixture.connection.exec("BEGIN IMMEDIATE");
  try {
    fixture.connection.exec("DROP TRIGGER events_no_update");
    fixture.connection.exec("DROP TRIGGER command_dedup_no_update");
    mutate();
    fixture.connection.exec(eventsTrigger);
    fixture.connection.exec(commandsTrigger);
    fixture.connection.exec("COMMIT");
  } catch (error) {
    try { fixture.connection.exec("ROLLBACK"); } catch { /* preserve mutation failure */ }
    throw error;
  } finally {
    fixture.connection.exec("PRAGMA foreign_keys = ON");
  }
}

function installV2LifecycleIntent(
  fixture: Fixture,
  command: RootStartCommandV2,
): { commandHash: string; witnessJson: string } {
  const sessionId = INTENT_SESSION_ID;
  const streamId = `session/${sessionId}`;
  const { witnessJson, commandHash: nextCommandHash } = lifecycleIntent(command);
  const startedPayload = {
    sessionKind: "root",
    ownerGeneration: 1,
    continuityKey: command.continuityKey,
    clientNamespace: fixture.context.binding.clientNamespace,
    creatingAgentId: command.agentId,
    creatingClientInstanceId: INITIAL_INTENT_ASSERTIONS.targetClientInstanceId,
    authorityCommitment: "b".repeat(64),
  };
  const startedPayloadJson = canonicalJson(startedPayload);
  const storedResponse = JSON.parse(stringField(fixture.connection.prepare(`
    SELECT response_json FROM command_dedup WHERE command_id = $commandId
  `).get({ $commandId: COMMAND_A })!, "response_json")) as Record<string, JsonValue>;
  const nextResponse = {
    ...storedResponse,
    response: { accepted: true, sessionId },
  };
  const nextResponseJson = canonicalJson(nextResponse);
  withMutableV2Witnesses(fixture, () => {
    fixture.connection.prepare(`
      UPDATE events
      SET stream_id = $streamId,
          stream_type = 'session',
          event_type = CASE command_event_index
            WHEN 0 THEN 'SessionStarted'
            ELSE 'SessionCheckpointRecorded'
          END,
          session_id = $sessionId,
          parent_session_id = NULL,
          payload_json = CASE command_event_index
            WHEN 0 THEN $startedPayloadJson
            ELSE payload_json
          END,
          payload_hash = CASE command_event_index
            WHEN 0 THEN $startedPayloadHash
            ELSE payload_hash
          END,
          lifecycle_intent_json = CASE command_event_index
            WHEN 0 THEN $witnessJson
            ELSE NULL
          END
      WHERE command_id = $commandId
    `).run({
      $streamId: streamId,
      $sessionId: sessionId,
      $startedPayloadJson: startedPayloadJson,
      $startedPayloadHash: payloadHash(startedPayload),
      $witnessJson: witnessJson,
      $commandId: COMMAND_A,
    });
    fixture.connection.prepare(`
      UPDATE streams
      SET stream_id = $streamId, stream_type = 'session'
      WHERE stream_id = 'stream-a'
    `).run({ $streamId: streamId });
    fixture.connection.prepare(`
      UPDATE command_dedup
      SET command_type = 'root-start',
          command_hash = $commandHash,
          lifecycle_authorization_kind = 'initial-authority',
          target_session_id = $sessionId,
          presenting_actor_role = 'primary',
          presenting_client_instance_id = 'client-integrity',
          target_actor_role = 'primary',
          target_client_instance_id = 'client-integrity',
          response_json = $responseJson,
          response_hash = $responseHash
      WHERE command_id = $commandId
    `).run({
      $commandHash: nextCommandHash,
      $sessionId: sessionId,
      $responseJson: nextResponseJson,
      $responseHash: responseHash(nextResponse),
      $commandId: COMMAND_A,
    });
    rehashCompleteEventChain(fixture.connection);
  });
  return { commandHash: nextCommandHash, witnessJson };
}

function installProtectedV2Resume(
  fixture: Fixture,
): { commandHash: string; witnessJson: string } {
  const sessionId = INTENT_SESSION_ID;
  const streamId = `session/${sessionId}`;
  const command = {
    commandType: "root-resume",
    commandId: COMMAND_A,
    idempotencyKey: "integrity:command-a",
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    sessionId,
    continuityKey: "protected-resume-continuity",
    resumePolicy: "exact",
    expectedOwnerGeneration: "7",
  } as RootResumeCommandV2;
  const built = buildLifecycleIntentWitness(command, {
    ...INITIAL_INTENT_ASSERTIONS,
    authorizationKind: "protected",
    authorizationSessionId: sessionId,
    capabilityKind: "root-resume-token",
    capabilityGeneration: "7",
  });
  withMutableV2Witnesses(fixture, () => {
    fixture.connection.prepare(`
      UPDATE events
      SET stream_id = $streamId,
          stream_type = 'session',
          event_type = CASE command_event_index
            WHEN 0 THEN 'SessionResumed'
            ELSE 'SessionCheckpointRecorded'
          END,
          session_id = $sessionId,
          parent_session_id = NULL,
          lifecycle_intent_json = CASE command_event_index
            WHEN 0 THEN $witnessJson
            ELSE NULL
          END
      WHERE command_id = $commandId
    `).run({
      $streamId: streamId,
      $sessionId: sessionId,
      $witnessJson: built.source,
      $commandId: COMMAND_A,
    });
    fixture.connection.prepare(`
      UPDATE streams
      SET stream_id = $streamId, stream_type = 'session'
      WHERE stream_id = 'stream-a'
    `).run({ $streamId: streamId });
    fixture.connection.prepare(`
      INSERT INTO session_authority(
        project_id, session_id, stream_id, session_kind, parent_session_id,
        workspace_id, client_namespace, semantic_state, owner_generation,
        child_capability_generation, direct_access_enabled,
        continuity_fingerprint_algorithm, continuity_fingerprint_schema_version,
        continuity_fingerprint_key_id, continuity_fingerprint_domain,
        continuity_fingerprint,
        root_handle_capability_version, root_handle_key_id,
        root_handle_issue_nonce, root_handle_issued_at, root_handle_policy_code,
        root_handle_expiry_kind, root_handle_expires_at, root_handle_actor_role,
        root_handle_client_instance_id, root_handle_verifier, root_handle_issuance_id,
        resume_token_capability_version, resume_token_key_id,
        resume_token_issue_nonce, resume_token_issued_at, resume_token_policy_code,
        resume_token_expiry_kind, resume_token_expires_at, resume_token_actor_role,
        resume_token_verifier, resume_token_issuance_id,
        authority_commitment, authority_event_position, created_at, updated_at
      )
      SELECT project_id, $sessionId, $streamId, 'root', NULL,
             workspace_id, $clientNamespace, 'active', 7, NULL, 0,
             'hmac-sha256', 1, 'continuity-key', 'continuity-domain', $fingerprint,
             1, 'root-key', $rootNonce, $now, 'root-policy',
             'until-revoked', NULL, 'primary', 'client-integrity',
             $rootVerifier, 'root-issuance',
             1, 'resume-key', $resumeNonce, $now, 'resume-policy',
             'until-revoked', NULL, 'primary', $resumeVerifier, 'resume-issuance',
             $commitment, global_position, $now, $now
      FROM events
      WHERE command_id = $commandId AND command_event_index = 0
    `).run({
      $sessionId: sessionId,
      $streamId: streamId,
      $clientNamespace: fixture.context.binding.clientNamespace,
      $fingerprint: "a".repeat(64),
      $rootNonce: "b".repeat(64),
      $rootVerifier: "c".repeat(64),
      $resumeNonce: "d".repeat(64),
      $resumeVerifier: "e".repeat(64),
      $commitment: "f".repeat(64),
      $now: NOW,
      $commandId: COMMAND_A,
    });
    fixture.connection.prepare(`
      UPDATE command_dedup
      SET command_type = 'root-resume',
          command_hash = $commandHash,
          lifecycle_authorization_kind = 'protected',
          authorization_proof_version = 1,
          authorization_proof_nonce = '88888888-8888-4888-8888-888888888888',
          authorization_proof_digest = $proofDigest,
          authorization_session_id = $sessionId,
          target_session_id = $sessionId,
          presenting_actor_role = 'primary',
          presenting_client_instance_id = 'client-integrity',
          target_actor_role = 'primary',
          target_client_instance_id = 'client-integrity'
      WHERE command_id = $commandId
    `).run({
      $commandHash: built.intentHash,
      $proofDigest: "d".repeat(64),
      $sessionId: sessionId,
      $commandId: COMMAND_A,
    });
    rehashCompleteEventChain(fixture.connection);
  });
  return { commandHash: built.intentHash, witnessJson: built.source };
}

function installInternalV2Phase(
  fixture: Fixture,
): { commandHash: string; witnessJson: string } {
  installProtectedV2Resume(fixture);
  const workflowId = "88888888-8888-4888-8888-888888888888";
  const plannedWorkId = "9".repeat(64);
  const command: InternalWorkflowPhaseCommand = {
    commandType: "internal-workflow-phase",
    commandId: COMMAND_A,
    idempotencyKey: "integrity:command-a",
    agentId: "agent-primary",
    expectedProjectId: PROJECT_ID as InternalWorkflowPhaseCommand["expectedProjectId"],
    expectedVaultId: VAULT_ID as InternalWorkflowPhaseCommand["expectedVaultId"],
    expectedWorkspaceId: WORKSPACE_ID as InternalWorkflowPhaseCommand["expectedWorkspaceId"],
    expectedBranchRef: null,
    workflowId: workflowId as InternalWorkflowPhaseCommand["workflowId"],
    workflowGeneration: 3,
    plannedWorkId,
    sourcePhase: "validate",
    claim: {
      workflowId: workflowId as InternalWorkflowPhaseCommand["workflowId"],
      workflowGeneration: 3,
      claimOwnerId: "99999999-9999-4999-8999-999999999999",
      claimToken: "7",
      claimExpiresAt: "2026-07-14T00:10:00.000Z",
    },
    action: {
      action: "invalidate-verification",
      safeFailureCode: "SESSION_SOURCE_STATE_CONFLICT",
    },
  };
  const built = buildLifecycleIntentWitness(command, {
    ...INITIAL_INTENT_ASSERTIONS,
    authorizationKind: "internal-workflow",
    authorizationSessionId: INTENT_SESSION_ID,
    capabilityKind: null,
    capabilityGeneration: null,
    internalWorkflowId: workflowId,
    internalWorkflowGeneration: 3,
    internalPlannedWorkId: plannedWorkId,
  });
  withMutableV2Witnesses(fixture, () => {
    fixture.connection.prepare(`
      UPDATE events
      SET lifecycle_intent_json = CASE command_event_index
        WHEN 0 THEN $witnessJson ELSE NULL END
      WHERE command_id = $commandId
    `).run({ $witnessJson: built.source, $commandId: COMMAND_A });
    fixture.connection.prepare(`
      UPDATE command_dedup
      SET command_type = 'internal-workflow-phase',
          command_hash = $commandHash,
          lifecycle_authorization_kind = 'internal-workflow',
          authorization_proof_version = NULL,
          authorization_proof_nonce = NULL,
          authorization_proof_digest = NULL,
          authorization_session_id = $sessionId,
          target_session_id = $sessionId,
          internal_workflow_id = $workflowId,
          internal_workflow_generation = 3,
          internal_planned_work_id = $plannedWorkId,
          internal_claim_owner_id = $claimOwnerId,
          internal_claim_token = 7
      WHERE command_id = $commandId
    `).run({
      $commandHash: built.intentHash,
      $sessionId: INTENT_SESSION_ID,
      $workflowId: workflowId,
      $plannedWorkId: plannedWorkId,
      $claimOwnerId: command.claim.claimOwnerId,
      $commandId: COMMAND_A,
    });
    rehashCompleteEventChain(fixture.connection);
  });
  return { commandHash: built.intentHash, witnessJson: built.source };
}

function replaceWitnessNamespace(source: string, clientNamespace: string): {
  commandHash: string;
  witnessJson: string;
} {
  const witness = JSON.parse(source) as {
    intent: { binding: { clientNamespace: string } };
    persistedAssertions: { clientNamespace: string };
  };
  witness.intent.binding.clientNamespace = clientNamespace;
  witness.persistedAssertions.clientNamespace = clientNamespace;
  const witnessJson = canonicalJson(witness as unknown as JsonValue);
  return {
    commandHash: lifecycleIntentHashFromWitnessSource(witnessJson),
    witnessJson,
  };
}

function replaceWitnessCapability(
  source: string,
  capabilityKind: "root-resume-token" | null,
  capabilityGeneration: string | null,
): { commandHash: string; witnessJson: string } {
  const witness = JSON.parse(source) as {
    intent: { authorization: {
      capabilityKind: "root-resume-token" | null;
      capabilityGeneration: string | null;
    } };
    persistedAssertions: {
      capabilityKind: "root-resume-token" | null;
      capabilityGeneration: string | null;
    };
  };
  witness.intent.authorization.capabilityKind = capabilityKind;
  witness.intent.authorization.capabilityGeneration = capabilityGeneration;
  witness.persistedAssertions.capabilityKind = capabilityKind;
  witness.persistedAssertions.capabilityGeneration = capabilityGeneration;
  const witnessJson = canonicalJson(witness as unknown as JsonValue);
  return {
    commandHash: lifecycleIntentHashFromWitnessSource(witnessJson),
    witnessJson,
  };
}

class ObservingConnection implements SqliteConnection {
  readonly executed: string[] = [];

  constructor(
    private readonly inner: SqliteConnection,
    private readonly afterFirstRead?: () => void,
    private readonly throwOnPrepare?: RegExp,
    private readonly throwOnExec?: RegExp,
  ) {}

  exec(sql: string): void {
    const normalized = sql.trim().replace(/\s+/g, " ").toUpperCase();
    this.executed.push(normalized);
    if (this.throwOnExec?.test(normalized)) throw new Error("INJECTED_EXEC_FAILURE");
    this.inner.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    if (this.throwOnPrepare?.test(sql)) throw new Error("INJECTED_READ_FAILURE");
    const statement = this.inner.prepare(sql);
    let observed = false;
    const afterRead = (): void => {
      if (observed || this.afterFirstRead === undefined) return;
      observed = true;
      this.afterFirstRead();
    };
    return {
      run: (params) => statement.run(params),
      get: (params) => {
        const result = statement.get(params);
        afterRead();
        return result;
      },
      all: (params) => {
        const result = statement.all(params);
        afterRead();
        return result;
      },
      iterate: (params) => statement.iterate(params),
    };
  }

  close(): void {
    this.inner.close();
  }
}

afterEach(() => {
  for (const connection of connections.splice(0)) {
    try { connection.close(); } catch { /* cleanup continues */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("EventIntegrityService valid checks", () => {
  it("exports the stable issue-code contract", () => {
    const expected: readonly IntegrityIssueCode[] = [
      "PROJECT_ID_MISMATCH",
      "VAULT_ID_MISMATCH",
      "STORE_ID_MISMATCH",
      "STORE_APPLICATION_ID_MISMATCH",
      "SQLITE_QUICK_CHECK_FAILED",
      "SQLITE_INTEGRITY_CHECK_FAILED",
      "SQLITE_FOREIGN_KEY_CHECK_FAILED",
      "MIGRATION_CHECKSUM_MISMATCH",
      "PROJECT_SCHEMA_VERSION_MISMATCH",
      "SCHEMA_FINGERPRINT_MISMATCH",
      "STREAM_HEAD_VERSION_MISMATCH",
      "STREAM_TYPE_MISMATCH",
      "COMMAND_RANGE_FOREIGN_EVENT",
      "COMMAND_RANGE_MISSING_EVENT",
      "COMMAND_EVENT_INDEX_MISMATCH",
      "COMMAND_HASH_MISMATCH",
      "COMMAND_METADATA_MISMATCH",
      "COMMAND_RESPONSE_HASH_MISMATCH",
      "GLOBAL_POSITION_NONCONTIGUOUS",
      "STREAM_VERSION_NONCONTIGUOUS",
      "EVENT_PAYLOAD_HASH_MISMATCH",
      "EVENT_PREVIOUS_HASH_MISMATCH",
      "EVENT_HASH_MISMATCH",
      "EVENT_TIMESTAMP_INVALID",
      "ORPHAN_COMMAND",
      "ORPHAN_EVENT",
      "RANGE_INVALID",
      "RANGE_OUT_OF_BOUNDS",
      "TAIL_LIMIT_INVALID",
      "COMMAND_AUTHORIZATION_METADATA_MISMATCH",
      "SESSION_AUTHORITY_FOLD_MISMATCH",
      "SESSION_LEASE_INVARIANT_MISMATCH",
      "SESSION_EVIDENCE_COVERAGE_MISMATCH",
      "LIFECYCLE_APPROVAL_CONSUMPTION_MISMATCH",
      "LIFECYCLE_WORKFLOW_INVARIANT_MISMATCH",
      "LIFECYCLE_VALIDATION_RESULT_MISMATCH",
      "LIFECYCLE_OUTBOX_INVARIANT_MISMATCH",
    ];
    assert.deepEqual(INTEGRITY_ISSUE_CODES, expected);
  });

  it("verifies a valid two-stream four-event store in quick, full, and range modes", () => {
    const fixture = createFixture();

    const quick = fixture.integrity.quickCheck(fixture.context, 256);
    assert.equal(quick.ok, true);
    assert.equal(quick.mode, "quick");
    assert.deepEqual(
      [quick.firstGlobalPosition, quick.lastGlobalPosition, quick.eventsVerified],
      ["1", "4", 4],
    );
    assert.deepEqual([quick.streamsVerified, quick.commandsVerified], [2, 2]);
    assert.equal(quick.issues.length, 0);
    assert.equal(quick.projectId, PROJECT_ID);
    assert.equal(quick.storeId, STORE_ID);
    assert.match(quick.schemaFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(quick.schemaFingerprint, expectedSchemaFingerprint([eventCoreMigration]));
    assert.equal(fixture.integrity.quickCheck(fixture.context).ok, true);

    const full = fixture.integrity.fullCheck(fixture.context);
    assert.equal(full.ok, true);
    assert.equal(full.mode, "full");
    assert.deepEqual(
      [full.firstGlobalPosition, full.lastGlobalPosition, full.eventsVerified],
      ["1", "4", 4],
    );
    assert.deepEqual([full.streamsVerified, full.commandsVerified], [2, 2]);
    assert.equal(full.terminalEventHash, quick.terminalEventHash);

    const range = fixture.integrity.verifyRange(fixture.context, 2n, 3n);
    assert.equal(range.ok, true);
    assert.equal(range.mode, "range");
    assert.deepEqual(
      [range.firstGlobalPosition, range.lastGlobalPosition, range.eventsVerified],
      ["2", "3", 2],
    );
    assert.deepEqual([range.streamsVerified, range.commandsVerified], [2, 2]);
    assert.equal(range.terminalEventHash, eventRow(fixture.connection, 3n).event_hash);
  });

  it("uses zero bounds and the genesis hash for an empty valid store", () => {
    const fixture = createFixture({ append: false });
    const report = fixture.integrity.fullCheck(fixture.context);
    assert.equal(report.ok, true);
    assert.deepEqual(
      [report.firstGlobalPosition, report.lastGlobalPosition, report.eventsVerified],
      ["0", "0", 0],
    );
    assert.equal(report.terminalEventHash, "0".repeat(64));
  });

  it("rejects unbounded tail and range inputs conservatively", () => {
    const fixture = createFixture();
    for (const tail of [0, -1, 1.5, Number.NaN, MAX_QUICK_TAIL_EVENTS + 1]) {
      assert.throws(
        () => fixture.integrity.quickCheck(fixture.context, tail),
        (error: unknown) => error instanceof IntegrityInputError
          && (error as IntegrityInputError).code === "TAIL_LIMIT_INVALID",
      );
    }
    for (const [first, last, code] of [
      [0n, 1n, "RANGE_INVALID"],
      [3n, 2n, "RANGE_INVALID"],
      [1n, BigInt(MAX_INTEGRITY_RANGE_EVENTS + 1), "RANGE_INVALID"],
      [9_223_372_036_854_775_808n, 9_223_372_036_854_775_808n, "RANGE_INVALID"],
      [4n, 5n, "RANGE_OUT_OF_BOUNDS"],
    ] as const) {
      assert.throws(
        () => fixture.integrity.verifyRange(fixture.context, first, last),
        (error: unknown) => error instanceof IntegrityInputError
          && (error as IntegrityInputError).code === code,
      );
    }
  });

  it("keeps manifest recording separate from the authoritative report", () => {
    const fixture = createFixture();
    const report = fixture.integrity.fullCheck(fixture.context);
    assert.equal(report.ok, true);
    assert.equal(
      fixture.manifestRepository.inspect(fixture.context.binding.storeRoute, {
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
      }).status,
      "valid",
    );
    assert.throws(() => fixture.manifestRepository.recordIntegrity(
      fixture.context.binding.storeRoute,
      { projectId: PROJECT_ID, vaultId: VAULT_ID, storeId: uuid(999) as StoreId },
      report,
    ), /STORE_MANIFEST_IDENTITY_MISMATCH/);
    assert.equal(report.ok, true);
    assert.equal(report.issues.length, 0);
  });
});

describe("EventIntegrityService identity and SQLite checks", () => {
  it("detects descriptor, manifest, and project_meta identity drift independently", () => {
    const descriptorFixture = createFixture();
    const descriptor = JSON.parse(
      readFileSync(descriptorFixture.context.binding.descriptorPath, "utf8"),
    ) as Record<string, unknown>;
    descriptor.projectId = uuid(700);
    writeFileSync(
      descriptorFixture.context.binding.descriptorPath,
      `${JSON.stringify(descriptor, null, 2)}\n`,
      "utf8",
    );
    assertIssueCodes(
      descriptorFixture.integrity.quickCheck(descriptorFixture.context, 256),
      ["PROJECT_ID_MISMATCH"],
    );

    const manifestFixture = createFixture();
    const manifestPath = manifestFixture.context.binding.storeRoute.storeManifestPath;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.vaultId = uuid(701);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    assertIssueCodes(
      manifestFixture.integrity.quickCheck(manifestFixture.context, 256),
      ["VAULT_ID_MISMATCH"],
    );

    const metaFixture = createFixture();
    mutateProtected(metaFixture, "project_meta_no_update", () => {
      metaFixture.connection.prepare(`
        UPDATE project_meta SET store_id = $storeId WHERE singleton = 1
      `).run({ $storeId: uuid(702) });
    });
    assertIssueCodes(
      metaFixture.integrity.quickCheck(metaFixture.context, 256),
      ["STORE_ID_MISMATCH"],
    );
  });

  it("detects application-id, quick-check, and foreign-key failures", () => {
    const applicationFixture = createFixture();
    applicationFixture.connection.exec("PRAGMA application_id = 1234");
    assertIssueCodes(
      applicationFixture.integrity.quickCheck(applicationFixture.context, 256),
      ["STORE_APPLICATION_ID_MISMATCH"],
    );

    const quickFixture = createFixture();
    quickFixture.connection.exec("PRAGMA ignore_check_constraints = ON");
    quickFixture.connection.exec("UPDATE maintenance_state SET epoch = -1 WHERE singleton = 1");
    quickFixture.connection.exec("PRAGMA ignore_check_constraints = OFF");
    assertIssueCodes(
      quickFixture.integrity.quickCheck(quickFixture.context, 256),
      ["SQLITE_QUICK_CHECK_FAILED"],
    );
    assertIssueCodes(
      quickFixture.integrity.fullCheck(quickFixture.context),
      ["SQLITE_INTEGRITY_CHECK_FAILED", "SQLITE_QUICK_CHECK_FAILED"],
    );

    const foreignKeyFixture = createFixture();
    foreignKeyFixture.connection.exec("PRAGMA foreign_keys = OFF");
    foreignKeyFixture.connection.prepare(`
      INSERT INTO executor_leases(
        project_id, executor_id, binding_generation, context_fingerprint,
        opened_at, last_seen_at, lease_expires_at, closed_at
      ) VALUES (
        $projectId, 'orphan-executor', 1, 'fingerprint',
        $now, $now, $now, NULL
      )
    `).run({ $projectId: uuid(703), $now: NOW });
    foreignKeyFixture.connection.exec("PRAGMA foreign_keys = ON");
    assertIssueCodes(
      foreignKeyFixture.integrity.quickCheck(foreignKeyFixture.context, 256),
      ["SQLITE_FOREIGN_KEY_CHECK_FAILED"],
    );
  });
});

describe("EventIntegrityService schema, stream, and command checks", () => {
  it("detects a changed migration checksum without relying on schema drift", () => {
    const fixture = createFixture();
    mutateProtected(fixture, "schema_migrations_no_update", () => {
      fixture.connection.prepare(`
        UPDATE schema_migrations SET checksum = $checksum WHERE version = 1
      `).run({ $checksum: "e".repeat(64) });
    });

    assertIssueCodes(
      fixture.integrity.quickCheck(fixture.context, 256),
      ["MIGRATION_CHECKSUM_MISMATCH"],
    );
  });

  it("detects a missing immutable trigger through the shared schema fingerprint", () => {
    const fixture = createFixture();
    fixture.connection.exec("DROP TRIGGER events_no_update");

    assertIssueCodes(
      fixture.integrity.quickCheck(fixture.context, 256),
      ["SCHEMA_FINGERPRINT_MISMATCH"],
    );
  });

  it("rejects a changed project schema version even when migration history is intact", () => {
    const fixture = createFixture();
    mutateProtected(fixture, "project_meta_no_update", () => {
      fixture.connection.exec("UPDATE project_meta SET schema_version = 2");
    });

    const quick = fixture.integrity.quickCheck(fixture.context);
    const full = fixture.integrity.fullCheck(fixture.context);
    assert.equal(quick.ok, false);
    assert.equal(full.ok, false);
    assert.ok(issueCodes(quick).includes("PROJECT_SCHEMA_VERSION_MISMATCH"));
    assert.ok(issueCodes(full).includes("PROJECT_SCHEMA_VERSION_MISMATCH"));
  });

  it("detects stream-head and stream-type drift", () => {
    const headFixture = createFixture();
    headFixture.connection.exec(`
      UPDATE streams SET current_version = 99 WHERE stream_id = 'stream-a'
    `);
    assertIssueCodes(
      headFixture.integrity.quickCheck(headFixture.context, 256),
      ["STREAM_HEAD_VERSION_MISMATCH"],
    );

    const typeFixture = createFixture();
    typeFixture.connection.exec("PRAGMA foreign_keys = OFF");
    typeFixture.connection.exec(`
      UPDATE streams SET stream_type = 'wrong' WHERE stream_id = 'stream-a'
    `);
    typeFixture.connection.exec("PRAGMA foreign_keys = ON");
    assertIssueCodes(
      typeFixture.integrity.quickCheck(typeFixture.context, 256),
      ["SQLITE_FOREIGN_KEY_CHECK_FAILED", "STREAM_TYPE_MISMATCH"],
    );
  });

  it("detects command ranges that contain another command or omit their own event", () => {
    const foreignFixture = createFixture();
    mutateProtected(foreignFixture, "command_dedup_no_update", () => {
      foreignFixture.connection.prepare(`
        UPDATE command_dedup SET last_global_position = 3 WHERE command_id = $commandId
      `).run({ $commandId: COMMAND_A });
    });
    assertIssueCodes(
      foreignFixture.integrity.quickCheck(foreignFixture.context, 256),
      ["COMMAND_RANGE_FOREIGN_EVENT"],
    );

    const missingFixture = createFixture();
    mutateProtected(missingFixture, "command_dedup_no_update", () => {
      missingFixture.connection.prepare(`
        UPDATE command_dedup SET last_global_position = 1 WHERE command_id = $commandId
      `).run({ $commandId: COMMAND_A });
    });
    assertIssueCodes(
      missingFixture.integrity.quickCheck(missingFixture.context, 256),
      ["COMMAND_RANGE_MISSING_EVENT"],
    );
  });

  it("detects response-hash and zero-based command-index corruption", () => {
    const responseFixture = createFixture();
    mutateProtected(responseFixture, "command_dedup_no_update", () => {
      responseFixture.connection.prepare(`
        UPDATE command_dedup
        SET response_json = json_set(response_json, '$.response.accepted', 0)
        WHERE command_id = $commandId
      `).run({ $commandId: COMMAND_A });
    });
    assertIssueCodes(
      responseFixture.integrity.quickCheck(responseFixture.context, 256),
      ["COMMAND_RESPONSE_HASH_MISMATCH"],
    );

    const indexFixture = createFixture();
    mutateProtected(indexFixture, "events_no_update", () => {
      indexFixture.connection.exec(`
        UPDATE events SET command_event_index = 2 WHERE global_position = 2
      `);
    });
    assertIssueCodes(
      indexFixture.integrity.quickCheck(indexFixture.context, 256),
      ["COMMAND_EVENT_INDEX_MISMATCH", "EVENT_HASH_MISMATCH"],
    );
  });

  it("rejects a substituted valid-format command hash", () => {
    const fixture = createFixture();
    mutateProtected(fixture, "command_dedup_no_update", () => {
      fixture.connection.prepare(`
        UPDATE command_dedup SET command_hash = $commandHash WHERE command_id = $commandId
      `).run({ $commandHash: "f".repeat(64), $commandId: COMMAND_A });
    });

    const report = fixture.integrity.fullCheck(fixture.context);
    assert.equal(report.ok, false);
    assert.ok(issueCodes(report).includes("COMMAND_HASH_MISMATCH"));
  });

  it("binds command type into the recomputed command hash", () => {
    const fixture = createFixture();
    mutateProtected(fixture, "command_dedup_no_update", () => {
      fixture.connection.prepare(`
        UPDATE command_dedup SET command_type = 'SubstitutedType' WHERE command_id = $commandId
      `).run({ $commandId: COMMAND_A });
    });

    const report = fixture.integrity.fullCheck(fixture.context);
    assert.equal(report.ok, false);
    assert.ok(issueCodes(report).includes("COMMAND_HASH_MISMATCH"));
  });

  it("requires every indexed event to retain its command idempotency key", () => {
    const fixture = createFixture();
    mutateProtected(fixture, "events_no_update", () => {
      fixture.connection.prepare(`
        UPDATE events
        SET idempotency_key = 'integrity:substituted-key'
        WHERE command_id = $commandId
      `).run({ $commandId: COMMAND_A });
      rehashCompleteEventChain(fixture.connection);
    });

    const report = fixture.integrity.fullCheck(fixture.context);
    assert.equal(report.ok, false);
    assert.ok(issueCodes(report).includes("COMMAND_METADATA_MISMATCH"));
  });

  it("requires command state to remain committed", () => {
    const fixture = createFixture();
    fixture.connection.exec("PRAGMA ignore_check_constraints = ON");
    try {
      mutateProtected(fixture, "command_dedup_no_update", () => {
        fixture.connection.prepare(`
          UPDATE command_dedup SET state = 'substituted' WHERE command_id = $commandId
        `).run({ $commandId: COMMAND_A });
      });
    } finally {
      fixture.connection.exec("PRAGMA ignore_check_constraints = OFF");
    }

    const report = fixture.integrity.fullCheck(fixture.context);
    assert.equal(report.ok, false);
    assert.ok(issueCodes(report).includes("COMMAND_METADATA_MISMATCH"));
  });

  it("binds committed time to the command events' recorded time", () => {
    const fixture = createFixture();
    mutateProtected(fixture, "command_dedup_no_update", () => {
      fixture.connection.prepare(`
        UPDATE command_dedup
        SET committed_at = '2026-07-13T02:00:01.000Z'
        WHERE command_id = $commandId
      `).run({ $commandId: COMMAND_A });
    });

    const report = fixture.integrity.fullCheck(fixture.context);
    assert.equal(report.ok, false);
    assert.ok(issueCodes(report).includes("COMMAND_METADATA_MISMATCH"));
  });

  it("rejects semantically equivalent but noncanonical payload and response JSON", () => {
    const payloadFixture = createFixture();
    mutateProtected(payloadFixture, "events_no_update", () => {
      payloadFixture.connection.exec(`
        UPDATE events SET payload_json = '{ "ordinal": 1 }' WHERE global_position = 1
      `);
    });
    assertIssueCodes(
      payloadFixture.integrity.quickCheck(payloadFixture.context, 256),
      ["EVENT_PAYLOAD_HASH_MISMATCH"],
    );

    const responseFixture = createFixture();
    const row = responseFixture.connection.prepare(`
      SELECT response_json FROM command_dedup WHERE command_id = $commandId
    `).get({ $commandId: COMMAND_A });
    assert.equal(typeof row?.response_json, "string");
    const response = JSON.parse(row!.response_json as string) as Record<string, unknown>;
    mutateProtected(responseFixture, "command_dedup_no_update", () => {
      responseFixture.connection.prepare(`
        UPDATE command_dedup SET response_json = $responseJson WHERE command_id = $commandId
      `).run({
        $responseJson: JSON.stringify(response, null, 2),
        $commandId: COMMAND_A,
      });
    });
    assertIssueCodes(
      responseFixture.integrity.quickCheck(responseFixture.context, 256),
      ["COMMAND_RESPONSE_HASH_MISMATCH"],
    );
  });

  it("detects event-id index drift from a committed command", () => {
    const fixture = createFixture();
    mutateProtected(fixture, "command_dedup_no_update", () => {
      fixture.connection.prepare(`
        UPDATE command_dedup SET event_ids_json = $eventIds WHERE command_id = $commandId
      `).run({
        $eventIds: canonicalJson([uuid(999), uuid(998)]),
        $commandId: COMMAND_A,
      });
    });

    assertIssueCodes(
      fixture.integrity.quickCheck(fixture.context, 256),
      ["COMMAND_RANGE_MISSING_EVENT"],
    );
  });

  it("rejects a coherently rehashed response whose indexed range metadata is false", () => {
    const fixture = createFixture();
    const row = fixture.connection.prepare(`
      SELECT response_json FROM command_dedup WHERE command_id = $commandId
    `).get({ $commandId: COMMAND_A });
    assert.equal(typeof row?.response_json, "string");
    const response = JSON.parse(row!.response_json as string) as Record<string, unknown>;
    response.firstGlobalPosition = "2";
    mutateProtected(fixture, "command_dedup_no_update", () => {
      fixture.connection.prepare(`
        UPDATE command_dedup
        SET response_json = $responseJson, response_hash = $responseHash
        WHERE command_id = $commandId
      `).run({
        $responseJson: canonicalJson(response),
        $responseHash: responseHash(response),
        $commandId: COMMAND_A,
      });
    });

    assertIssueCodes(
      fixture.integrity.quickCheck(fixture.context, 256),
      ["COMMAND_RANGE_MISSING_EVENT"],
    );
  });

  it("rejects coherently corrupted command and response versions against actual events", () => {
    const fixture = createFixture();
    const row = fixture.connection.prepare(`
      SELECT response_json FROM command_dedup WHERE command_id = $commandId
    `).get({ $commandId: COMMAND_A });
    assert.equal(typeof row?.response_json, "string");
    const response = JSON.parse(row!.response_json as string) as Record<string, unknown>;
    response.finalStreamVersion = "99";
    mutateProtected(fixture, "command_dedup_no_update", () => {
      fixture.connection.prepare(`
        UPDATE command_dedup
        SET final_stream_version = 99,
            response_json = $responseJson,
            response_hash = $responseHash
        WHERE command_id = $commandId
      `).run({
        $responseJson: canonicalJson(response),
        $responseHash: responseHash(response),
        $commandId: COMMAND_A,
      });
    });

    assertIssueCodes(
      fixture.integrity.quickCheck(fixture.context, 256),
      ["COMMAND_RANGE_MISSING_EVENT"],
    );
  });
});

describe("EventIntegrityService immutable command witnesses", () => {
  const matrix = [
    {
      name: "local command with no outbox",
      context: (fixture: Fixture): ProjectContext => fixture.context,
      outbox: (): PendingOutbox[] => [],
    },
    {
      name: "local command with one outbox item",
      context: (fixture: Fixture): ProjectContext => fixture.context,
      outbox: (): PendingOutbox[] => [twoOutboxItems()[0]!],
    },
    {
      name: "detached Git command with one outbox item",
      context: (fixture: Fixture): ProjectContext => gitContext(fixture, {
        branchRef: null,
        detached: true,
      }),
      outbox: (): PendingOutbox[] => [twoOutboxItems()[0]!],
    },
    {
      name: "detached Git command with no outbox",
      context: (fixture: Fixture): ProjectContext => gitContext(fixture, {
        branchRef: null,
        detached: true,
      }),
      outbox: (): PendingOutbox[] => [],
    },
    {
      name: "detached Git command with two ordered outbox items for one event",
      context: (fixture: Fixture): ProjectContext => gitContext(fixture, {
        branchRef: null,
        detached: true,
      }),
      outbox: (): PendingOutbox[] => twoOutboxItems(),
    },
    {
      name: "attached Git command with one outbox item",
      context: (fixture: Fixture): ProjectContext => gitContext(fixture),
      outbox: (): PendingOutbox[] => [twoOutboxItems()[0]!],
    },
    {
      name: "attached Git command with no outbox",
      context: (fixture: Fixture): ProjectContext => gitContext(fixture),
      outbox: (): PendingOutbox[] => [],
    },
    {
      name: "attached Git command with two ordered outbox items for one event",
      context: (fixture: Fixture): ProjectContext => gitContext(fixture),
      outbox: (): PendingOutbox[] => twoOutboxItems(),
    },
    {
      name: "local command with two ordered outbox items for one event",
      context: (fixture: Fixture): ProjectContext => fixture.context,
      outbox: (): PendingOutbox[] => twoOutboxItems(),
    },
  ] as const;

  for (const entry of matrix) {
    it(`recomputes the command hash for ${entry.name}`, () => {
      const fixture = createFixture({ append: false });
      const context = entry.context(fixture);
      fixture.store.append({
        ...appendCommand(context, COMMAND_A, "integrity:witness", "stream-witness", "witness", 1),
        outbox: entry.outbox(),
      });
      assert.equal(fixture.integrity.fullCheck(context).ok, true, entry.name);

      mutateProtected(fixture, "command_dedup_no_update", () => {
        fixture.connection.prepare(`
          UPDATE command_dedup SET command_hash = $commandHash WHERE command_id = $commandId
        `).run({ $commandHash: "e".repeat(64), $commandId: COMMAND_A });
      });

      const report = fixture.integrity.fullCheck(context);
      assert.equal(report.ok, false, entry.name);
      assert.ok(issueCodes(report).includes("COMMAND_HASH_MISMATCH"), entry.name);
    });
  }

  it("retains the exact command-time head when one attached branch scope advances", () => {
    const fixture = createFixture({ append: false });
    const firstHead = "0123456789abcdef0123456789abcdef01234567";
    const secondHead = "89abcdef0123456789abcdef0123456789abcdef";
    const firstContext = gitContext(fixture, { headCommit: firstHead });
    const secondContext = gitContext(fixture, { headCommit: secondHead });
    fixture.store.append(appendCommand(
      firstContext,
      COMMAND_A,
      "integrity:head-a",
      "stream-head-a",
      "head-a",
      1,
    ));
    fixture.store.append(appendCommand(
      secondContext,
      COMMAND_B,
      "integrity:head-b",
      "stream-head-b",
      "head-b",
      3,
    ));

    assert.equal(
      fixture.connection.prepare("SELECT count(*) AS count FROM branch_scopes").get()?.count,
      1n,
    );
    assert.deepEqual(
      fixture.connection.prepare(`
        SELECT workspace_head_commit FROM command_dedup ORDER BY first_global_position
      `).all().map((row) => row.workspace_head_commit),
      [firstHead, secondHead],
    );
    assert.equal(fixture.integrity.fullCheck(secondContext).ok, true);

    mutateProtected(fixture, "command_dedup_no_update", () => {
      fixture.connection.prepare(`
        UPDATE command_dedup SET command_hash = $commandHash WHERE command_id = $commandId
      `).run({ $commandHash: "e".repeat(64), $commandId: COMMAND_B });
    });
    const report = fixture.integrity.fullCheck(secondContext);
    assert.equal(report.ok, false);
    assert.ok(issueCodes(report).includes("COMMAND_HASH_MISMATCH"));
  });

  it("binds a detached command head to its branch scope creation head", () => {
    const fixture = createFixture({ append: false });
    const context = gitContext(fixture, { branchRef: null, detached: true });
    fixture.store.append(appendCommand(
      context,
      COMMAND_A,
      "integrity:detached-head",
      "stream-detached-head",
      "detached-head",
      1,
    ));
    assert.equal(fixture.integrity.fullCheck(context).ok, true);

    fixture.connection.prepare(`
      UPDATE branch_scopes SET created_head = $head
    `).run({ $head: "89abcdef0123456789abcdef0123456789abcdef" });

    const report = fixture.integrity.fullCheck(context);
    assert.equal(report.ok, false);
    assert.ok(issueCodes(report).includes("COMMAND_METADATA_MISMATCH"));
  });

  it("event integrity recomputes lifecycle outbox content hash", () => {
    const fixture = createFixture({ append: false });
    fixture.store.append({
      ...appendCommand(
        fixture.context,
        COMMAND_A,
        "integrity:outbox-content-hash",
        "stream-outbox-content-hash",
        "outbox-content-hash",
        1,
      ),
      outbox: twoOutboxItems(),
    });
    const row = fixture.connection.prepare(`
      SELECT payload_json, content_hash
      FROM outbox
      WHERE target_key = 'integrity/outbox/first'
    `).get() as { payload_json: string; content_hash: string };
    assert.equal(row.content_hash, outboxHash(JSON.parse(row.payload_json) as JsonValue));
    assert.equal(fixture.integrity.fullCheck(fixture.context).ok, true);
  });

  const outboxCorruptions: ReadonlyArray<{
    name: string;
    expectedCode: "COMMAND_HASH_MISMATCH" | "COMMAND_METADATA_MISMATCH";
    mutate: (fixture: Fixture) => void;
  }> = [
    {
      name: "reordered witness",
      expectedCode: "COMMAND_HASH_MISMATCH",
      mutate: (fixture) => mutateProtected(fixture, "command_dedup_no_update", () => {
        fixture.connection.prepare(`
          UPDATE command_dedup SET outbox_order_json = $order WHERE command_id = $commandId
        `).run({
          $order: canonicalJson(["integrity/outbox/first", "integrity/outbox/second"]),
          $commandId: COMMAND_A,
        });
      }),
    },
    ...[
      ["duplicate witness target", ["integrity/outbox/second", "integrity/outbox/second"]],
      ["missing witness target", ["integrity/outbox/second"]],
      ["extra witness target", [
        "integrity/outbox/second",
        "integrity/outbox/first",
        "integrity/outbox/extra",
      ]],
    ].map(([name, order]) => ({
      name: name as string,
      expectedCode: "COMMAND_METADATA_MISMATCH" as const,
      mutate: (fixture: Fixture): void => mutateProtected(
        fixture,
        "command_dedup_no_update",
        () => {
          fixture.connection.prepare(`
            UPDATE command_dedup SET outbox_order_json = $order WHERE command_id = $commandId
          `).run({ $order: canonicalJson(order), $commandId: COMMAND_A });
        },
      ),
    })),
    {
      name: "noncanonical witness JSON",
      expectedCode: "COMMAND_METADATA_MISMATCH",
      mutate: (fixture) => mutateProtected(fixture, "command_dedup_no_update", () => {
        fixture.connection.prepare(`
          UPDATE command_dedup SET outbox_order_json = $order WHERE command_id = $commandId
        `).run({
          $order: '[ "integrity/outbox/second", "integrity/outbox/first" ]',
          $commandId: COMMAND_A,
        });
      }),
    },
    {
      name: "deleted outbox row",
      expectedCode: "COMMAND_METADATA_MISMATCH",
      mutate: (fixture) => {
        fixture.connection.prepare("DELETE FROM outbox WHERE target_key = $targetKey").run({
          $targetKey: "integrity/outbox/first",
        });
      },
    },
    {
      name: "extra command-owned outbox row",
      expectedCode: "COMMAND_METADATA_MISMATCH",
      mutate: (fixture) => {
        const payload = { ordinal: 3 };
        fixture.connection.prepare(`
          INSERT INTO outbox(
            project_id, target_key, event_position, kind, payload_json, content_hash,
            status, attempt_count, claim_owner, claim_token, claim_expires_at,
            created_at, updated_at
          ) VALUES (
            $projectId, 'integrity/outbox/extra', 1, 'materialize-extra',
            $payloadJson, $contentHash, 'pending', 0, NULL, NULL, NULL, $now, $now
          )
        `).run({
          $projectId: PROJECT_ID,
          $payloadJson: canonicalJson(payload),
          $contentHash: outboxHash(payload),
          $now: NOW,
        });
      },
    },
    {
      name: "moved outbox event position",
      expectedCode: "COMMAND_HASH_MISMATCH",
      mutate: (fixture) => {
        fixture.connection.prepare(`
          UPDATE outbox SET event_position = 2 WHERE target_key = $targetKey
        `).run({ $targetKey: "integrity/outbox/first" });
      },
    },
    {
      name: "changed outbox kind",
      expectedCode: "COMMAND_HASH_MISMATCH",
      mutate: (fixture) => {
        fixture.connection.prepare(`
          UPDATE outbox SET kind = 'substituted-kind' WHERE target_key = $targetKey
        `).run({ $targetKey: "integrity/outbox/first" });
      },
    },
    {
      name: "changed outbox payload",
      expectedCode: "COMMAND_METADATA_MISMATCH",
      mutate: (fixture) => {
        fixture.connection.prepare(`
          UPDATE outbox SET payload_json = '{"ordinal":999}' WHERE target_key = $targetKey
        `).run({ $targetKey: "integrity/outbox/first" });
      },
    },
    {
      name: "coherently changed outbox payload and content hash",
      expectedCode: "COMMAND_HASH_MISMATCH",
      mutate: (fixture) => {
        const payload = { ordinal: 999 };
        fixture.connection.prepare(`
          UPDATE outbox
          SET payload_json = $payloadJson, content_hash = $contentHash
          WHERE target_key = $targetKey
        `).run({
          $payloadJson: canonicalJson(payload),
          $contentHash: outboxHash(payload),
          $targetKey: "integrity/outbox/first",
        });
      },
    },
    {
      name: "noncanonical outbox payload JSON",
      expectedCode: "COMMAND_METADATA_MISMATCH",
      mutate: (fixture) => {
        fixture.connection.prepare(`
          UPDATE outbox SET payload_json = '{ "ordinal": 1 }' WHERE target_key = $targetKey
        `).run({ $targetKey: "integrity/outbox/first" });
      },
    },
    {
      name: "changed outbox content hash",
      expectedCode: "COMMAND_METADATA_MISMATCH",
      mutate: (fixture) => {
        fixture.connection.prepare(`
          UPDATE outbox SET content_hash = $hash WHERE target_key = $targetKey
        `).run({ $hash: "f".repeat(64), $targetKey: "integrity/outbox/first" });
      },
    },
  ];

  for (const corruption of outboxCorruptions) {
    it(`rejects ${corruption.name}`, () => {
      const fixture = createFixture({ append: false });
      fixture.store.append({
        ...appendCommand(
          fixture.context,
          COMMAND_A,
          "integrity:outbox-witness",
          "stream-outbox-witness",
          "outbox-witness",
          1,
        ),
        outbox: twoOutboxItems(),
      });
      assert.equal(fixture.integrity.fullCheck(fixture.context).ok, true);

      corruption.mutate(fixture);

      const report = fixture.integrity.fullCheck(fixture.context);
      assert.equal(report.ok, false, corruption.name);
      assert.ok(issueCodes(report).includes(corruption.expectedCode), corruption.name);
    });
  }

  it("rejects local and Git workspace-witness tuple contradictions", () => {
    const localFixture = createFixture({ append: false });
    localFixture.store.append(appendCommand(
      localFixture.context,
      COMMAND_A,
      "integrity:local-tuple",
      "stream-local-tuple",
      "local-tuple",
      1,
    ));
    mutateProtected(localFixture, "command_dedup_no_update", () => {
      localFixture.connection.prepare(`
        UPDATE command_dedup SET workspace_head_commit = $head WHERE command_id = $commandId
      `).run({
        $head: "0123456789abcdef0123456789abcdef01234567",
        $commandId: COMMAND_A,
      });
    });
    const localReport = localFixture.integrity.fullCheck(localFixture.context);
    assert.equal(localReport.ok, false);
    assert.ok(issueCodes(localReport).includes("COMMAND_METADATA_MISMATCH"));

    const gitFixture = createFixture({ append: false });
    const context = gitContext(gitFixture);
    gitFixture.store.append(appendCommand(
      context,
      COMMAND_A,
      "integrity:git-tuple",
      "stream-git-tuple",
      "git-tuple",
      1,
    ));
    mutateProtected(gitFixture, "command_dedup_no_update", () => {
      gitFixture.connection.prepare(`
        UPDATE command_dedup SET workspace_head_commit = NULL WHERE command_id = $commandId
      `).run({ $commandId: COMMAND_A });
    });
    const gitReport = gitFixture.integrity.fullCheck(context);
    assert.equal(gitReport.ok, false);
    assert.ok(issueCodes(gitReport).includes("COMMAND_METADATA_MISMATCH"));
  });
});

describe("EventIntegrityService Version 2 lifecycle intent witnesses", () => {
  const materialA: RootStartCommandV2 = {
    commandType: "root-start",
    commandId: COMMAND_A,
    idempotencyKey: "integrity:command-a",
    agentId: "agent-primary",
    continuityKey: "continuity-a",
    expectedProjectId: PROJECT_ID,
    expectedVaultId: VAULT_ID,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedBranchRef: null,
    resumePolicy: "new",
  };
  const materialB: RootStartCommandV2 = {
    ...materialA,
    continuityKey: "continuity-b",
  };

  it("keeps Version 1 event hashes byte-identical and never queries a Version 2 column", () => {
    const fixture = createFixture();
    assert.equal(
      fixture.connection.prepare("PRAGMA table_info(events)").all()
        .some((row) => row.name === "lifecycle_intent_json"),
      false,
    );
    const observing = new ObservingConnection(
      fixture.connection,
      undefined,
      /lifecycle_intent_json/i,
    );
    assert.equal(
      new EventIntegrityService(observing, [eventCoreMigration]).fullCheck(fixture.context).ok,
      true,
    );
    for (const row of fixture.connection.prepare("SELECT * FROM events ORDER BY global_position").all()) {
      assert.equal(stringField(row, "event_hash"), recomputedEventHash(row));
    }
  });

  it("accepts exactly one event-hash-bound canonical witness for a Version 2 command", () => {
    const fixture = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    assert.ok(
      fixture.connection.prepare("SELECT lifecycle_intent_json FROM events").all()
        .every((row) => row.lifecycle_intent_json === null),
    );
    const installed = installV2LifecycleIntent(fixture, materialA);
    assert.equal(
      fixture.connection.prepare(`
        SELECT lifecycle_intent_json FROM events
        WHERE command_id = $commandId AND command_event_index = 0
      `).get({ $commandId: COMMAND_A })?.lifecycle_intent_json,
      installed.witnessJson,
    );
    const decoded = JSON.parse(installed.witnessJson) as {
      intent: {
        binding: {
          projectId: string;
          vaultId: string;
          storeId: string;
          workspaceId: string;
          clientNamespace: string;
        };
        authorization: {
          targetSessionId: string | null;
          capabilityKind: string | null;
          capabilityGeneration: string | null;
        };
      };
      persistedAssertions: { targetSessionId: string };
    };
    assert.deepEqual(decoded.intent.binding, {
      projectId: PROJECT_ID,
      vaultId: VAULT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "tests",
    });
    assert.deepEqual(decoded.intent.authorization, {
      authorizationKind: "initial-authority",
      authorizationSessionId: null,
      targetSessionId: null,
      capabilityKind: null,
      capabilityGeneration: null,
      presentingActorRole: "primary",
      presentingClientInstanceId: "client-integrity",
      targetActorRole: "primary",
      targetClientInstanceId: "client-integrity",
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
    });
    assert.equal(decoded.persistedAssertions.targetSessionId, INTENT_SESSION_ID);
    assert.equal(fixture.integrity.fullCheck(fixture.context).ok, true);
  });

  it("reconstructs a protected resume intent with capability kind and generation", () => {
    const fixture = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    const installed = installProtectedV2Resume(fixture);
    const decoded = JSON.parse(installed.witnessJson) as {
      intent: {
        authorization: {
          capabilityKind: string | null;
          capabilityGeneration: string | null;
        };
      };
    };
    assert.deepEqual(decoded.intent.authorization, {
      authorizationKind: "protected",
      authorizationSessionId: INTENT_SESSION_ID,
      targetSessionId: INTENT_SESSION_ID,
      capabilityKind: "root-resume-token",
      capabilityGeneration: "7",
      presentingActorRole: "primary",
      presentingClientInstanceId: "client-integrity",
      targetActorRole: "primary",
      targetClientInstanceId: "client-integrity",
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
    });
    assert.equal(fixture.integrity.fullCheck(fixture.context).ok, true);
  });

  it("independently binds protected and internal intent namespaces to session authority", () => {
    for (const [name, install] of [
      ["protected", installProtectedV2Resume],
      ["internal", installInternalV2Phase],
    ] as const) {
      const fixture = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
      const installed = install(fixture);
      assert.equal(fixture.integrity.fullCheck(fixture.context).ok, true, `${name}: baseline`);
      const replacement = replaceWitnessNamespace(
        installed.witnessJson,
        "coherently-rehashed-other-namespace",
      );
      withMutableV2Witnesses(fixture, () => {
        fixture.connection.prepare(`
          UPDATE events SET lifecycle_intent_json = $witness
          WHERE command_id = $commandId AND command_event_index = 0
        `).run({ $witness: replacement.witnessJson, $commandId: COMMAND_A });
        fixture.connection.prepare(`
          UPDATE command_dedup SET command_hash = $commandHash
          WHERE command_id = $commandId
        `).run({ $commandHash: replacement.commandHash, $commandId: COMMAND_A });
        rehashCompleteEventChain(fixture.connection);
      });

      const report = fixture.integrity.fullCheck(fixture.context);
      assert.equal(report.ok, false, name);
      assert.ok(issueCodes(report).includes("COMMAND_METADATA_MISMATCH"), name);
    }
  });

  it("requires persisted proof presence exactly when the intent has a capability pair", () => {
    const proofWithoutCapability = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    const installed = installProtectedV2Resume(proofWithoutCapability);
    const withoutCapability = replaceWitnessCapability(installed.witnessJson, null, null);
    withMutableV2Witnesses(proofWithoutCapability, () => {
      proofWithoutCapability.connection.prepare(`
        UPDATE events SET lifecycle_intent_json = $witness
        WHERE command_id = $commandId AND command_event_index = 0
      `).run({ $witness: withoutCapability.witnessJson, $commandId: COMMAND_A });
      proofWithoutCapability.connection.prepare(`
        UPDATE command_dedup SET command_hash = $commandHash
        WHERE command_id = $commandId
      `).run({ $commandHash: withoutCapability.commandHash, $commandId: COMMAND_A });
      rehashCompleteEventChain(proofWithoutCapability.connection);
    });
    assert.ok(issueCodes(proofWithoutCapability.integrity.fullCheck(
      proofWithoutCapability.context,
    )).includes("COMMAND_METADATA_MISMATCH"));

    const capabilityWithoutProof = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    installProtectedV2Resume(capabilityWithoutProof);
    withMutableV2Witnesses(capabilityWithoutProof, () => {
      capabilityWithoutProof.connection.prepare(`
        UPDATE command_dedup
        SET authorization_proof_version = NULL,
            authorization_proof_nonce = NULL,
            authorization_proof_digest = NULL
        WHERE command_id = $commandId
      `).run({ $commandId: COMMAND_A });
    });
    assert.ok(issueCodes(capabilityWithoutProof.integrity.fullCheck(
      capabilityWithoutProof.context,
    )).includes("COMMAND_METADATA_MISMATCH"));
  });

  it("hashes distinct caller intent differently when event outcomes are otherwise identical", () => {
    const left = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    const right = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    const leftInstalled = installV2LifecycleIntent(left, materialA);
    const rightInstalled = installV2LifecycleIntent(right, materialB);
    assert.notEqual(leftInstalled.commandHash, rightInstalled.commandHash);
    assert.equal(left.integrity.fullCheck(left.context).ok, true);
    assert.equal(right.integrity.fullCheck(right.context).ok, true);
  });

  it("detects independent witness, command-hash, and event-hash tampering", () => {
    const witnessFixture = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    installV2LifecycleIntent(witnessFixture, materialA);
    withMutableV2Witnesses(witnessFixture, () => {
      witnessFixture.connection.prepare(`
        UPDATE events SET lifecycle_intent_json = $witness
        WHERE command_id = $commandId AND command_event_index = 0
      `).run({
        $witness: lifecycleIntentWitness(materialB),
        $commandId: COMMAND_A,
      });
    });
    const witnessCodes = issueCodes(witnessFixture.integrity.fullCheck(witnessFixture.context));
    assert.ok(witnessCodes.includes("EVENT_HASH_MISMATCH"));
    assert.ok(witnessCodes.includes("COMMAND_HASH_MISMATCH"));

    const commandFixture = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    installV2LifecycleIntent(commandFixture, materialA);
    mutateProtected(commandFixture, "command_dedup_no_update", () => {
      commandFixture.connection.prepare(`
        UPDATE command_dedup SET command_hash = $hash WHERE command_id = $commandId
      `).run({ $hash: "f".repeat(64), $commandId: COMMAND_A });
    });
    assert.ok(issueCodes(commandFixture.integrity.fullCheck(commandFixture.context))
      .includes("COMMAND_HASH_MISMATCH"));

    const eventFixture = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    installV2LifecycleIntent(eventFixture, materialA);
    mutateProtected(eventFixture, "events_no_update", () => {
      eventFixture.connection.prepare(`
        UPDATE events SET event_hash = $hash
        WHERE command_id = $commandId AND command_event_index = 0
      `).run({ $hash: "e".repeat(64), $commandId: COMMAND_A });
    });
    assert.ok(issueCodes(eventFixture.integrity.fullCheck(eventFixture.context))
      .includes("EVENT_HASH_MISMATCH"));
  });

  it("rejects duplicate, misplaced, noncanonical, and unknown-version witnesses", () => {
    for (const [name, mutate] of [
      ["duplicate", (fixture: Fixture): void => {
        fixture.connection.prepare(`
          UPDATE events SET lifecycle_intent_json = $witness
          WHERE command_id = $commandId AND command_event_index = 1
        `).run({
          $witness: lifecycleIntentWitness(materialA),
          $commandId: COMMAND_A,
        });
      }],
      ["misplaced", (fixture: Fixture): void => {
        fixture.connection.prepare(`
          UPDATE events
          SET lifecycle_intent_json = CASE command_event_index
            WHEN 0 THEN NULL ELSE $witness END
          WHERE command_id = $commandId
        `).run({
          $witness: lifecycleIntentWitness(materialA),
          $commandId: COMMAND_A,
        });
      }],
      ["noncanonical", (fixture: Fixture): void => {
        fixture.connection.prepare(`
          UPDATE events SET lifecycle_intent_json = $witness
          WHERE command_id = $commandId AND command_event_index = 0
        `).run({
          $witness: JSON.stringify(JSON.parse(lifecycleIntentWitness(materialA)), null, 2),
          $commandId: COMMAND_A,
        });
      }],
      ["unknown-version", (fixture: Fixture): void => {
        fixture.connection.prepare(`
          UPDATE events SET lifecycle_intent_json = $witness
          WHERE command_id = $commandId AND command_event_index = 0
        `).run({
          $witness: canonicalJson({
            ...JSON.parse(lifecycleIntentWitness(materialA)) as Record<string, JsonValue>,
            lifecycleIntentWitnessVersion: 2,
          }),
          $commandId: COMMAND_A,
        });
      }],
    ] as const) {
      const fixture = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
      installV2LifecycleIntent(fixture, materialA);
      withMutableV2Witnesses(fixture, () => mutate(fixture));
      const report = fixture.integrity.fullCheck(fixture.context);
      assert.equal(report.ok, false, name);
      assert.ok(
        issueCodes(report).includes("COMMAND_HASH_MISMATCH")
          || issueCodes(report).includes("COMMAND_METADATA_MISMATCH"),
        name,
      );
    }
  });

  it("rejects secret-bearing material without reflecting the canary", async () => {
    const modulePath = "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
    const witnessModule = await import(modulePath) as {
      decodeLifecycleIntentWitness(source: string): unknown;
    };
    const canary = "pmcap1.secret-capability-canary";
    let error: unknown;
    try {
      const witness = JSON.parse(lifecycleIntentWitness(materialA)) as {
        intent: { command: Record<string, JsonValue> };
      };
      witness.intent.command.continuityKey = canary;
      witnessModule.decodeLifecycleIntentWitness(canonicalJson(witness));
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.doesNotMatch(String(error), new RegExp(canary));
  });

  it("does not expose a raw JSON writer escape hatch for unknown or secret fields", async () => {
    const modulePath = "../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
    const witnessModule = await import(modulePath) as {
      buildLifecycleIntentWitness(
        command: unknown,
        assertions: TrustedLifecycleIntentAssertionsV1,
      ): unknown;
    };
    for (const material of [
      { ...materialA, inventedSemanticInput: "caller-selected" },
      { ...materialA, secret: "ordinary-secret-value" },
    ] as const) {
      assert.throws(
        () => witnessModule.buildLifecycleIntentWitness(material, INITIAL_INTENT_ASSERTIONS),
        /LIFECYCLE_INTENT_WITNESS_INVALID/,
      );
    }
  });

  it("rejects a coherent caller-selected replacement of witness and command hash", () => {
    const fixture = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    installV2LifecycleIntent(fixture, materialA);
    withMutableV2Witnesses(fixture, () => {
      fixture.connection.prepare(`
        UPDATE events SET lifecycle_intent_json = $witness
        WHERE command_id = $commandId AND command_event_index = 0
      `).run({
        $witness: lifecycleIntentWitness(materialB),
        $commandId: COMMAND_A,
      });
      fixture.connection.prepare(`
        UPDATE command_dedup SET command_hash = $commandHash
        WHERE command_id = $commandId
      `).run({
        $commandHash: lifecycleIntentHash(materialB),
        $commandId: COMMAND_A,
      });
      rehashCompleteEventChain(fixture.connection);
    });

    const report = fixture.integrity.fullCheck(fixture.context);
    assert.equal(report.ok, false);
    assert.ok(issueCodes(report).includes("COMMAND_METADATA_MISMATCH"));
  });

  it("rejects coherently rehashed stable binding drift from the stored event", () => {
    for (const [name, assertions] of [
      ["store", {
        ...INITIAL_INTENT_ASSERTIONS,
        storeId: "99999999-9999-4999-8999-999999999999",
      }],
      ["client-namespace", {
        ...INITIAL_INTENT_ASSERTIONS,
        clientNamespace: "other-client-namespace",
      }],
    ] as const) {
      const fixture = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
      installV2LifecycleIntent(fixture, materialA);
      const replacement = buildLifecycleIntentWitness(materialA, assertions);
      withMutableV2Witnesses(fixture, () => {
        fixture.connection.prepare(`
          UPDATE events SET lifecycle_intent_json = $witness
          WHERE command_id = $commandId AND command_event_index = 0
        `).run({
          $witness: replacement.source,
          $commandId: COMMAND_A,
        });
        fixture.connection.prepare(`
          UPDATE command_dedup SET command_hash = $commandHash
          WHERE command_id = $commandId
        `).run({
          $commandHash: replacement.intentHash,
          $commandId: COMMAND_A,
        });
        rehashCompleteEventChain(fixture.connection);
      });

      const report = fixture.integrity.fullCheck(fixture.context);
      assert.equal(report.ok, false, name);
      assert.ok(issueCodes(report).includes("COMMAND_METADATA_MISMATCH"), name);
    }
  });

  it("rejects drift between the event-bound witness and persisted generated target", () => {
    const fixture = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    installV2LifecycleIntent(fixture, materialA);
    mutateProtected(fixture, "command_dedup_no_update", () => {
      fixture.connection.prepare(`
        UPDATE command_dedup SET target_session_id = $targetSessionId
        WHERE command_id = $commandId
      `).run({
        $targetSessionId: "88888888-8888-4888-8888-888888888888",
        $commandId: COMMAND_A,
      });
    });

    const report = fixture.integrity.fullCheck(fixture.context);
    assert.equal(report.ok, false);
    assert.ok(issueCodes(report).includes("COMMAND_METADATA_MISMATCH"));
  });
});

describe("EventIntegrityService event-chain and orphan checks", () => {
  it("detects noncontiguous global and per-stream versions", () => {
    const globalFixture = createFixture();
    mutateProtected(globalFixture, "events_no_update", () => {
      globalFixture.connection.exec(`
        UPDATE events SET global_position = 5 WHERE global_position = 4
      `);
    });
    assertIssueCodes(
      globalFixture.integrity.fullCheck(globalFixture.context),
      [
        "COMMAND_METADATA_MISMATCH",
        "COMMAND_RANGE_MISSING_EVENT",
        "EVENT_HASH_MISMATCH",
        "GLOBAL_POSITION_NONCONTIGUOUS",
      ],
    );

    const streamFixture = createFixture();
    mutateProtected(streamFixture, "events_no_update", () => {
      streamFixture.connection.exec(`
        UPDATE events SET stream_version = 3 WHERE global_position = 2
      `);
    });
    assertIssueCodes(
      streamFixture.integrity.fullCheck(streamFixture.context),
      [
        "COMMAND_METADATA_MISMATCH",
        "COMMAND_RANGE_MISSING_EVENT",
        "EVENT_HASH_MISMATCH",
        "STREAM_HEAD_VERSION_MISMATCH",
        "STREAM_VERSION_NONCONTIGUOUS",
      ],
    );
  });

  it("detects payload JSON, predecessor, event hash, and timestamp corruption", () => {
    const payloadFixture = createFixture();
    mutateProtected(payloadFixture, "events_no_update", () => {
      payloadFixture.connection.exec(`
        UPDATE events SET payload_json = '{"ordinal":999}' WHERE global_position = 4
      `);
    });
    assertIssueCodes(
      payloadFixture.integrity.fullCheck(payloadFixture.context),
      ["COMMAND_METADATA_MISMATCH", "EVENT_PAYLOAD_HASH_MISMATCH"],
    );

    const previousFixture = createFixture();
    mutateProtected(previousFixture, "events_no_update", () => {
      previousFixture.connection.prepare(`
        UPDATE events SET previous_global_hash = $hash WHERE global_position = 4
      `).run({ $hash: "d".repeat(64) });
    });
    assertIssueCodes(
      previousFixture.integrity.fullCheck(previousFixture.context),
      [
        "COMMAND_METADATA_MISMATCH",
        "EVENT_HASH_MISMATCH",
        "EVENT_PREVIOUS_HASH_MISMATCH",
      ],
    );

    const hashFixture = createFixture();
    mutateProtected(hashFixture, "events_no_update", () => {
      hashFixture.connection.prepare(`
        UPDATE events SET event_hash = $hash WHERE global_position = 4
      `).run({ $hash: "c".repeat(64) });
    });
    assertIssueCodes(
      hashFixture.integrity.fullCheck(hashFixture.context),
      ["COMMAND_METADATA_MISMATCH", "EVENT_HASH_MISMATCH"],
    );

    const timestampFixture = createFixture();
    const source = eventRow(timestampFixture.connection, 4n);
    const invalidTimestamp = "not-rfc3339";
    const updatedHash = recomputedEventHash(source, { occurred_at: invalidTimestamp });
    mutateProtected(timestampFixture, "events_no_update", () => {
      timestampFixture.connection.prepare(`
        UPDATE events
        SET occurred_at = $occurredAt, event_hash = $eventHash
        WHERE global_position = 4
      `).run({ $occurredAt: invalidTimestamp, $eventHash: updatedHash });
    });
    assertIssueCodes(
      timestampFixture.integrity.fullCheck(timestampFixture.context),
      ["COMMAND_HASH_MISMATCH", "EVENT_TIMESTAMP_INVALID"],
    );

    const recordedFixture = createFixture();
    const recordedSource = eventRow(recordedFixture.connection, 4n);
    const invalidRecordedAt = "2026-99-99T25:00:00Z";
    const recordedHash = recomputedEventHash(recordedSource, {
      recorded_at: invalidRecordedAt,
    });
    mutateProtected(recordedFixture, "events_no_update", () => {
      recordedFixture.connection.prepare(`
        UPDATE events
        SET recorded_at = $recordedAt, event_hash = $eventHash
        WHERE global_position = 4
      `).run({ $recordedAt: invalidRecordedAt, $eventHash: recordedHash });
    });
    assertIssueCodes(
      recordedFixture.integrity.fullCheck(recordedFixture.context),
      ["COMMAND_METADATA_MISMATCH", "EVENT_TIMESTAMP_INVALID"],
    );
  });

  it("detects orphan events and orphan command records in both directions", () => {
    const eventFixture = createFixture();
    mutateProtected(eventFixture, "command_dedup_no_delete", () => {
      eventFixture.connection.prepare(`
        DELETE FROM command_dedup WHERE command_id = $commandId
      `).run({ $commandId: COMMAND_A });
    });
    assertIssueCodes(
      eventFixture.integrity.quickCheck(eventFixture.context, 256),
      ["ORPHAN_EVENT"],
    );

    const commandFixture = createFixture();
    const syntheticResponse = {
      eventIds: [uuid(800)],
      firstGlobalPosition: "99",
      lastGlobalPosition: "99",
      finalStreamVersion: "1",
      response: { accepted: true },
    };
    commandFixture.connection.prepare(`
      INSERT INTO command_dedup(
        project_id, idempotency_key, command_id, command_type, command_hash,
        workspace_head_commit, outbox_order_json, state, first_global_position,
        last_global_position, final_stream_version, event_ids_json, response_json,
        response_hash, committed_at
      ) VALUES (
        $projectId, 'integrity:orphan-command', $commandId, 'Synthetic', $commandHash,
        NULL, '[]', 'committed', 99, 99, 1,
        $eventIdsJson, $responseJson, $responseHash, $committedAt
      )
    `).run({
      $projectId: PROJECT_ID,
      $commandId: uuid(801),
      $commandHash: "a".repeat(64),
      $eventIdsJson: canonicalJson(syntheticResponse.eventIds),
      $responseJson: canonicalJson(syntheticResponse),
      $responseHash: responseHash(syntheticResponse),
      $committedAt: NOW,
    });
    assertIssueCodes(
      commandFixture.integrity.quickCheck(commandFixture.context, 256),
      ["COMMAND_RANGE_MISSING_EVENT", "ORPHAN_COMMAND"],
    );
  });

  it("detects both schema and chain damage after an immutable trigger is dropped", () => {
    const fixture = createFixture();
    mutateProtected(fixture, "events_no_update", () => {
      fixture.connection.prepare(`
        UPDATE events SET payload_hash = $hash WHERE global_position = 4
      `).run({ $hash: "b".repeat(64) });
    }, false);

    assertIssueCodes(
      fixture.integrity.quickCheck(fixture.context, 256),
      [
        "EVENT_HASH_MISMATCH",
        "EVENT_PAYLOAD_HASH_MISMATCH",
        "SCHEMA_FINGERPRINT_MISMATCH",
      ],
    );
  });
});

describe("EventIntegrityService bounds and transaction semantics", () => {
  it("does not rescan the full event index for every command during a quick check", () => {
    const fixture = createFixture({ append: false });
    const commandCount = 64;
    for (let index = 0; index < commandCount; index += 1) {
      const streamId = `stream-linear-${index}`;
      fixture.store.append({
        ...appendCommand(
          fixture.context,
          uuid(1_000 + index),
          `integrity:linear-${index}`,
          streamId,
          "linear",
          index + 1,
        ),
        events: [pendingEvent("Linear.Recorded", index + 1)],
      });
    }

    const originalFilter = Array.prototype.filter;
    let fullEventIndexVisits = 0;
    Object.defineProperty(Array.prototype, "filter", {
      configurable: true,
      writable: true,
      value(
        this: unknown[],
        predicate: (value: unknown, index: number, array: unknown[]) => unknown,
        thisArg?: unknown,
      ): unknown[] {
        const first = this[0];
        if (
          this.length === commandCount
          && typeof first === "object"
          && first !== null
          && "globalPosition" in first
          && "commandEventIndex" in first
        ) {
          fullEventIndexVisits += this.length;
        }
        return originalFilter.call(this, predicate, thisArg);
      },
    });
    const report = (() => {
      try {
        return fixture.integrity.quickCheck(fixture.context, 1);
      } finally {
        Object.defineProperty(Array.prototype, "filter", {
          configurable: true,
          writable: true,
          value: originalFilter,
        });
      }
    })();

    assert.equal(report.ok, true);
    assert.deepEqual(
      [report.eventsVerified, report.streamsVerified, report.commandsVerified],
      [1, commandCount, commandCount],
    );
    assert.ok(
      fullEventIndexVisits <= commandCount,
      `quick check revisited ${fullEventIndexVisits} indexed events for ${commandCount} commands`,
    );
  });

  it("limits quick verification to the requested tail while full check still finds older damage", () => {
    const fixture = createFixture();
    mutateProtected(fixture, "events_no_update", () => {
      fixture.connection.exec(`
        UPDATE events SET payload_json = '{"ordinal":999}' WHERE global_position = 1
      `);
    });

    const quick = fixture.integrity.quickCheck(fixture.context, 2);
    assert.equal(quick.ok, true);
    assert.deepEqual(
      [quick.firstGlobalPosition, quick.lastGlobalPosition, quick.eventsVerified],
      ["3", "4", 2],
    );
    assertIssueCodes(
      fixture.integrity.fullCheck(fixture.context),
      ["COMMAND_METADATA_MISMATCH", "EVENT_PAYLOAD_HASH_MISMATCH"],
    );
  });

  it("uses the trusted predecessor and ignores corruption outside a verified range", () => {
    const outsideFixture = createFixture();
    mutateProtected(outsideFixture, "events_no_update", () => {
      outsideFixture.connection.prepare(`
        UPDATE events SET event_hash = $hash WHERE global_position = 4
      `).run({ $hash: "a".repeat(64) });
    });
    const outside = outsideFixture.integrity.verifyRange(outsideFixture.context, 2n, 3n);
    assert.equal(outside.ok, true);

    const predecessorFixture = createFixture();
    mutateProtected(predecessorFixture, "events_no_update", () => {
      predecessorFixture.connection.prepare(`
        UPDATE events SET event_hash = $hash WHERE global_position = 1
      `).run({ $hash: "a".repeat(64) });
    });
    assertIssueCodes(
      predecessorFixture.integrity.verifyRange(predecessorFixture.context, 2n, 3n),
      ["EVENT_PREVIOUS_HASH_MISMATCH"],
    );

    const missingFixture = createFixture();
    mutateProtected(missingFixture, "events_no_update", () => {
      missingFixture.connection.exec(`
        UPDATE events SET global_position = 5 WHERE global_position = 4
      `);
    });
    assertIssueCodes(
      missingFixture.integrity.verifyRange(missingFixture.context, 4n, 4n),
      ["GLOBAL_POSITION_NONCONTIGUOUS"],
    );
  });

  it("commits integrity findings but rolls back unexpected read failures", () => {
    const findingFixture = createFixture();
    mutateProtected(findingFixture, "events_no_update", () => {
      findingFixture.connection.exec(`
        UPDATE events SET payload_json = '{"ordinal":999}' WHERE global_position = 4
      `);
    });
    const observing = new ObservingConnection(findingFixture.connection);
    const failedReport = new EventIntegrityService(observing, [eventCoreMigration])
      .fullCheck(findingFixture.context);
    assert.equal(failedReport.ok, false);
    assert.equal(observing.executed[0], "BEGIN DEFERRED");
    assert.equal(observing.executed.at(-1), "COMMIT");
    assert.equal(observing.executed.includes("ROLLBACK"), false);

    const exceptionFixture = createFixture();
    const throwing = new ObservingConnection(
      exceptionFixture.connection,
      undefined,
      /PRAGMA\s+quick_check/i,
    );
    assert.throws(
      () => new EventIntegrityService(throwing, [eventCoreMigration])
        .quickCheck(exceptionFixture.context, 256),
      /INJECTED_READ_FAILURE/,
    );
    assert.deepEqual(throwing.executed, ["BEGIN DEFERRED", "ROLLBACK"]);

    const witnessFixture = createFixture();
    const witnessReadFailure = new ObservingConnection(
      witnessFixture.connection,
      undefined,
      /FROM\s+outbox/i,
    );
    assert.throws(
      () => new EventIntegrityService(witnessReadFailure, [eventCoreMigration])
        .fullCheck(witnessFixture.context),
      /INJECTED_READ_FAILURE/,
    );
    assert.equal(witnessReadFailure.executed[0], "BEGIN DEFERRED");
    assert.equal(witnessReadFailure.executed.at(-1), "ROLLBACK");
  });

  it("async integrity holds one deferred transaction and invokes each extension once", async () => {
    const fixture = createFixture();
    const observing = new ObservingConnection(fixture.connection);
    const calls = {
      legacyQuick: 0,
      legacyFull: 0,
      asyncSyncQuick: 0,
      asyncSyncFull: 0,
      asyncQuick: 0,
      asyncFull: 0,
    };
    const assertTransactionRemainsOpen = async (): Promise<void> => {
      assert.equal(observing.executed.at(-1), "BEGIN DEFERRED");
      await Promise.resolve();
      assert.equal(observing.executed.at(-1), "BEGIN DEFERRED");
    };
    const legacyExtension: IntegrityExtension = {
      quickCheck(): void {
        calls.legacyQuick += 1;
        assert.equal(observing.executed.at(-1), "BEGIN DEFERRED");
      },
      fullCheck(): void {
        calls.legacyFull += 1;
        assert.equal(observing.executed.at(-1), "BEGIN DEFERRED");
      },
    };
    const asyncExtension: AsyncIntegrityExtension = {
      quickCheck(): void {
        calls.asyncSyncQuick += 1;
      },
      fullCheck(): void {
        calls.asyncSyncFull += 1;
      },
      async quickCheckAsync(): Promise<void> {
        calls.asyncQuick += 1;
        await assertTransactionRemainsOpen();
      },
      async fullCheckAsync(): Promise<void> {
        calls.asyncFull += 1;
        await assertTransactionRemainsOpen();
      },
    };
    const integrity = new EventIntegrityService(
      observing,
      [eventCoreMigration],
      [legacyExtension, asyncExtension],
    );

    assert.equal((await integrity.quickCheckAsync(fixture.context, 256)).ok, true);
    assert.equal((await integrity.fullCheckAsync(fixture.context)).ok, true);
    assert.deepEqual(observing.executed, [
      "BEGIN DEFERRED",
      "COMMIT",
      "BEGIN DEFERRED",
      "COMMIT",
    ]);
    assert.deepEqual(calls, {
      legacyQuick: 1,
      legacyFull: 1,
      asyncSyncQuick: 0,
      asyncSyncFull: 0,
      asyncQuick: 1,
      asyncFull: 1,
    });

    const rejectionFixture = createFixture();
    const rollbackFailure = new ObservingConnection(
      rejectionFixture.connection,
      undefined,
      undefined,
      /^ROLLBACK$/,
    );
    const sentinel = Object.freeze({ reason: "async-extension-rejected" });
    const rejectingExtension: AsyncIntegrityExtension = {
      quickCheck(): void {
        assert.fail("sync quick extension must not run when async is available");
      },
      fullCheck(): void {},
      async quickCheckAsync(): Promise<void> {
        await Promise.resolve();
        throw sentinel;
      },
      async fullCheckAsync(): Promise<void> {},
    };

    await assert.rejects(
      () => new EventIntegrityService(
        rollbackFailure,
        [eventCoreMigration],
        [rejectingExtension],
      ).quickCheckAsync(rejectionFixture.context, 256),
      (error: unknown) => {
        assert.equal(error, sentinel);
        return true;
      },
    );
    assert.deepEqual(rollbackFailure.executed, ["BEGIN DEFERRED", "ROLLBACK"]);
  });

  it("synchronous integrity fails closed when qualified coverage requires authentication", () => {
    const versionOne = createFixture();
    const versionOneIntegrity = new EventIntegrityService(
      versionOne.connection,
      [eventCoreMigration],
      [new LifecycleIntegrityService(versionOne.connection)],
    );
    assert.equal(versionOneIntegrity.quickCheck(versionOne.context, 256).ok, true);
    assert.equal(versionOneIntegrity.fullCheck(versionOne.context).ok, true);

    const versionTwo = createFixture({
      migrations: PROJECT_STORE_MIGRATIONS.slice(0, 2),
    });
    const versionTwoIntegrity = new EventIntegrityService(
      versionTwo.connection,
      PROJECT_STORE_MIGRATIONS.slice(0, 2),
      [new LifecycleIntegrityService(versionTwo.connection)],
    );
    assert.equal(versionTwoIntegrity.quickCheck(versionTwo.context, 256).ok, true);
    assert.equal(versionTwoIntegrity.fullCheck(versionTwo.context).ok, true);

    const qualified = createFixture({ migrations: PROJECT_STORE_MIGRATIONS });
    const qualifiedIntegrity = new EventIntegrityService(
      qualified.connection,
      PROJECT_STORE_MIGRATIONS,
      [new LifecycleIntegrityService(qualified.connection)],
    );
    assert.equal(qualifiedIntegrity.quickCheck(qualified.context, 256).ok, true);
    assert.equal(qualifiedIntegrity.fullCheck(qualified.context).ok, true);

    qualified.connection.exec("PRAGMA foreign_keys = OFF");
    qualified.connection.exec(
      "DROP TRIGGER session_evidence_coverage_transitions_insert_guard",
    );
    qualified.connection.prepare(`
      INSERT INTO session_evidence_coverage_transitions(
        project_id, session_id, adapter_session_id, batch_id,
        batch_event_position, batch_first_ordinal, batch_last_ordinal,
        coverage_first_ordinal, coverage_last_ordinal,
        highest_contiguous_ordinal, missing_intervals_json,
        frame_fingerprint_algorithm, frame_fingerprint_schema_version,
        frame_fingerprint_key_id, frame_fingerprint_domain,
        previous_coverage_fingerprint_value,
        coverage_fingerprint_algorithm, coverage_fingerprint_schema_version,
        coverage_fingerprint_key_id, coverage_fingerprint_domain,
        coverage_fingerprint_value, new_frame_count, capture_mode,
        content_retained, created_at
      ) VALUES (
        $projectId, $sessionId, $adapterSessionId, $batchId,
        1, 0, 0, 0, 0, 0, '[]',
        'hmac-sha256', 1, 'historical-key', 'pm-evidence-frame-v1',
        NULL, 'hmac-sha256', 1, 'historical-key',
        'pm-evidence-coverage-v1', $fingerprint, 1,
        'coverage-only', 0, $createdAt
      )
    `).run({
      $projectId: qualified.context.binding.projectId,
      $sessionId: "77777777-7777-4777-8777-777777777777",
      $adapterSessionId: "88888888-8888-4888-8888-888888888888",
      $batchId: "99999999-9999-4999-8999-999999999999",
      $fingerprint: "a".repeat(64),
      $createdAt: NOW,
    });
    qualified.connection.exec("PRAGMA foreign_keys = ON");

    const isHistoricalKeyFailure = (error: unknown): boolean => {
      assert.equal(
        (error as { readonly code?: unknown }).code,
        "EVIDENCE_HISTORICAL_KEY_UNAVAILABLE",
      );
      return true;
    };
    assert.throws(
      () => qualifiedIntegrity.quickCheck(qualified.context, 256),
      isHistoricalKeyFailure,
    );
    assert.throws(
      () => qualifiedIntegrity.fullCheck(qualified.context),
      isHistoricalKeyFailure,
    );
  });

  it("keeps one WAL snapshot when another connection appends after the first read", () => {
    const fixture = createFixture();
    const writer = driver.open(fixture.path, {
      mode: "existing",
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    });
    connections.push(writer);
    let nextEventId = 900;
    const writerStore = new EventStore(
      writer,
      new SqliteEventStoreStatements(writer),
      new MaintenanceFence(),
      new BranchScopeRepository(),
      () => NOW,
      () => uuid(nextEventId++),
    );
    let appended = false;
    const observing = new ObservingConnection(fixture.connection, () => {
      if (appended) return;
      appended = true;
      writerStore.append(appendCommand(
        fixture.context,
        COMMAND_C,
        "integrity:command-c",
        "stream-c",
        "gamma",
        5,
      ));
    });

    const snapshot = new EventIntegrityService(observing, [eventCoreMigration])
      .quickCheck(fixture.context, 256);
    assert.equal(appended, true);
    assert.deepEqual(
      [snapshot.lastGlobalPosition, snapshot.eventsVerified, snapshot.streamsVerified],
      ["4", 4, 2],
    );
    const after = fixture.integrity.quickCheck(fixture.context, 256);
    assert.deepEqual(
      [after.lastGlobalPosition, after.eventsVerified, after.streamsVerified],
      ["6", 6, 3],
    );
  });
});
