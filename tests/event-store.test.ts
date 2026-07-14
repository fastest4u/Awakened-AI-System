import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
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
import { commandHash, responseHash } from "../src/orchestrator/crypto/event-hash.js";
import type {
  BranchScopeId,
  GitWorkspaceSnapshot,
  NonGitWorkspaceSnapshot,
  ProjectBinding,
  ProjectContext,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import {
  EventStore,
  EventStoreError,
  GENESIS_GLOBAL_HASH,
  MAX_CANONICAL_COMMAND_BYTES,
  MAX_EVENTS_PER_COMMAND,
  SqliteEventStoreStatements,
} from "../src/orchestrator/storage/event-store.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { MigrationRunner } from "../src/orchestrator/storage/migration-runner.js";
import { eventCoreMigration } from "../src/orchestrator/storage/migrations/0001-event-core.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type {
  SqliteConnection,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const VAULT_ID = "22222222-2222-4222-8222-222222222222" as VaultId;
const STORE_ID = "33333333-3333-4333-8333-333333333333" as StoreId;
const WORKSPACE_ID = "workspace-primary" as WorkspaceId;
const NOW = "2026-07-13T01:00:00.000Z";
const roots: string[] = [];
const connections: SqliteConnection[] = [];
const driver = new NodeSqliteDriver({ DatabaseSync });

class RecordingConnection implements SqliteConnection {
  beginCount = 0;
  rollbackCount = 0;

  constructor(readonly inner: SqliteConnection) {}

  exec(sql: string): void {
    const normalized = sql.trim().replace(/\s+/g, " ").toUpperCase();
    if (normalized === "BEGIN IMMEDIATE") this.beginCount += 1;
    if (normalized === "ROLLBACK") this.rollbackCount += 1;
    this.inner.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return this.inner.prepare(sql);
  }

  close(): void {
    this.inner.close();
  }
}

class CommitFailureConnection implements SqliteConnection {
  commitAttempts = 0;
  rollbackAttempts = 0;

  constructor(
    readonly inner: SqliteConnection,
    readonly commitFailure: unknown,
    readonly rollbackFailure?: unknown,
    readonly commitBeforeThrow = false,
  ) {}

  exec(sql: string): void {
    const normalized = sql.trim().replace(/\s+/g, " ").toUpperCase();
    if (normalized === "COMMIT") {
      this.commitAttempts += 1;
      if (this.commitBeforeThrow) this.inner.exec(sql);
      throw this.commitFailure;
    }
    if (normalized === "ROLLBACK") {
      this.rollbackAttempts += 1;
      if (this.rollbackFailure !== undefined) throw this.rollbackFailure;
    }
    this.inner.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return this.inner.prepare(sql);
  }

  close(): void {
    // The fixture owns the underlying connection.
  }
}

interface Fixture {
  path: string;
  connection: RecordingConnection;
  context: ProjectContext;
  store: EventStore;
}

function uuid(index: number): string {
  const head = index.toString(16).padStart(8, "0").slice(-8);
  const tail = index.toString(16).padStart(12, "0").slice(-12);
  return `${head}-0000-4000-8000-${tail}`;
}

function uuidGenerator(start = 1): () => string {
  let next = start;
  return () => uuid(next++);
}

function gitWorkspace(
  overrides: Partial<GitWorkspaceSnapshot> = {},
): GitWorkspaceSnapshot {
  return {
    kind: "git",
    worktreeRoot: "C:\\project",
    gitDir: "C:\\project\\.git\\worktrees\\primary",
    gitCommonDir: "C:\\project\\.git",
    headCommit: "0123456789abcdef0123456789abcdef01234567",
    branchRef: "refs/heads/main",
    detached: false,
    workspaceId: WORKSPACE_ID,
    ...overrides,
  };
}

function binding(
  workspace: GitWorkspaceSnapshot | NonGitWorkspaceSnapshot,
  overrides: Partial<ProjectBinding> = {},
): ProjectBinding {
  return {
    projectBindingId: "binding-primary",
    generation: 1,
    contextFingerprint: "fingerprint-primary",
    source: "explicit-cli",
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
    workspaceId: workspace.workspaceId,
    clientNamespace: "tests",
    clientInstanceId: "client-primary",
    actorRole: "primary",
    projectRoot: "C:\\project",
    vaultRoot: "C:\\project\\memory",
    descriptorPath: "C:\\project\\memory\\.project-memory.json",
    storeRoute: {
      kind: "git-common",
      storeRoot: "C:\\project\\.git\\project-memory",
      eventsPath: "C:\\project\\.git\\project-memory\\events.sqlite",
      storeManifestPath: "C:\\project\\.git\\project-memory\\store.json",
      projectionManifestPath: "C:\\project\\.git\\project-memory\\projection.json",
    },
    workspace,
    establishedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function contextFor(
  workspace: GitWorkspaceSnapshot | NonGitWorkspaceSnapshot = gitWorkspace(),
  bindingOverrides: Partial<ProjectBinding> = {},
): ProjectContext {
  return {
    binding: binding(workspace, bindingOverrides),
    workspace,
    checkedAt: "2026-07-13T00:30:00.000Z",
  };
}

function pendingEvent(
  eventType: string,
  payload: JsonValue,
  overrides: Partial<PendingEvent> = {},
): PendingEvent {
  return {
    eventType,
    eventSchemaVersion: 1,
    occurredAt: "2026-07-13T00:59:00.000Z",
    visibilityScope: "project",
    confidence: "high",
    verificationStatus: "verified",
    payload,
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
    ...overrides,
  };
}

function appendCommand(
  context: ProjectContext,
  overrides: Partial<AppendCommand<JsonValue>> = {},
): AppendCommand<JsonValue> {
  return {
    context,
    commandId: "33333333-3333-4333-8333-333333333333",
    idempotencyKey: "client-a:command-1",
    commandType: "RecordPair",
    correlationId: "correlation-1",
    agentId: "agent-primary",
    expectedStreamVersion: 0n,
    streamId: "stream-1",
    streamType: "test",
    events: [
      pendingEvent("FirstRecorded", { ordinal: 1 }),
      pendingEvent("SecondRecorded", { ordinal: 2 }),
    ],
    outbox: [{
      targetKey: "test/stream-1/2",
      kind: "test-materialization",
      eventIndex: 1,
      payload: { streamId: "stream-1" },
    }],
    publicResponse: { accepted: true },
    ...overrides,
  };
}

function createFixture(options: {
  now?: () => string;
  randomId?: () => string;
  context?: ProjectContext;
  branchId?: () => BranchScopeId;
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "memory-event-store-"));
  roots.push(root);
  const path = join(root, "events.sqlite");
  const nativeConnection = driver.open(path, {
    mode: "create",
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  });
  const connection = new RecordingConnection(nativeConnection);
  connections.push(connection);
  new MigrationRunner().apply(connection, [eventCoreMigration], NOW);
  connection.exec("BEGIN IMMEDIATE");
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
  connection.exec("COMMIT");
  connection.beginCount = 0;
  connection.rollbackCount = 0;
  const context = options.context ?? contextFor();
  const branches = new BranchScopeRepository({
    randomId: options.branchId ?? (() => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as BranchScopeId),
  });
  const store = new EventStore(
    connection,
    new SqliteEventStoreStatements(connection),
    new MaintenanceFence(),
    branches,
    options.now ?? (() => NOW),
    options.randomId ?? uuidGenerator(),
  );
  return { path, connection, context, store };
}

function counts(connection: SqliteConnection): Record<string, bigint> {
  const row = connection.prepare(`
    SELECT
      (SELECT count(*) FROM streams) AS streams,
      (SELECT count(*) FROM branch_scopes) AS branchScopes,
      (SELECT count(*) FROM events) AS events,
      (SELECT count(*) FROM outbox) AS outbox,
      (SELECT count(*) FROM command_dedup) AS dedup
  `).get() as Record<string, bigint>;
  return { ...row };
}

function expectEventStoreError(
  action: () => unknown,
  code: string,
): EventStoreError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof EventStoreError, `expected EventStoreError(${code})`);
  const typed = caught as EventStoreError;
  assert.equal(typed.code, code);
  return typed;
}

function cloneContext(
  context: ProjectContext,
  workspace: GitWorkspaceSnapshot | NonGitWorkspaceSnapshot,
  bindingOverrides: Partial<ProjectBinding> = {},
): ProjectContext {
  return {
    ...context,
    workspace,
    binding: {
      ...context.binding,
      workspace,
      workspaceId: workspace.workspaceId,
      ...bindingOverrides,
    },
  };
}

afterEach(() => {
  for (const connection of connections.splice(0)) {
    try { connection.close(); } catch { /* cleanup continues */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("EventStore", () => {
  it("reports a non-BUSY COMMIT failure with the exact command recovery identity", () => {
    const fixture = createFixture();
    const connection = new CommitFailureConnection(
      fixture.connection,
      { errcode: 10, code: "ERR_SQLITE_ERROR" },
    );
    const store = new EventStore(
      connection,
      new SqliteEventStoreStatements(connection),
      new MaintenanceFence(),
      new BranchScopeRepository(),
      () => NOW,
      uuidGenerator(900),
    );
    const command = appendCommand(fixture.context);

    const error = expectEventStoreError(
      () => store.append(command),
      "COMMAND_OUTCOME_UNKNOWN",
    );

    assert.deepEqual(error.details, {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
    });
    assert.equal(connection.commitAttempts, 1);
    assert.equal(connection.rollbackAttempts, 1);
    assert.deepEqual(counts(fixture.connection), {
      streams: 0n,
      branchScopes: 0n,
      events: 0n,
      outbox: 0n,
      dedup: 0n,
    });
  });

  it("reports rollback failure after COMMIT as exact command outcome unknown", () => {
    const fixture = createFixture();
    const connection = new CommitFailureConnection(
      fixture.connection,
      { errcode: 5, code: "ERR_SQLITE_ERROR" },
      new Error("rollback failed"),
    );
    const store = new EventStore(
      connection,
      new SqliteEventStoreStatements(connection),
      new MaintenanceFence(),
      new BranchScopeRepository(),
      () => NOW,
      uuidGenerator(1_000),
    );
    const command = appendCommand(fixture.context);

    const error = expectEventStoreError(
      () => store.append(command),
      "COMMAND_OUTCOME_UNKNOWN",
    );

    assert.deepEqual(error.details, {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
    });
    assert.equal(connection.rollbackAttempts, 1);
    fixture.connection.exec("ROLLBACK");
    assert.deepEqual(counts(fixture.connection), {
      streams: 0n,
      branchScopes: 0n,
      events: 0n,
      outbox: 0n,
      dedup: 0n,
    });
  });

  it("replays one deduplicated effect when COMMIT succeeds before reporting failure", () => {
    const fixture = createFixture();
    const connection = new CommitFailureConnection(
      fixture.connection,
      { errcode: 10, code: "ERR_SQLITE_ERROR" },
      undefined,
      true,
    );
    const store = new EventStore(
      connection,
      new SqliteEventStoreStatements(connection),
      new MaintenanceFence(),
      new BranchScopeRepository(),
      () => NOW,
      uuidGenerator(1_050),
    );
    const command = appendCommand(fixture.context);

    const error = expectEventStoreError(
      () => store.append(command),
      "COMMAND_OUTCOME_UNKNOWN",
    );
    assert.deepEqual(error.details, {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
    });

    const replay = fixture.store.append(command);
    assert.equal(replay.deduplicated, true);
    assert.deepEqual(counts(fixture.connection), {
      streams: 1n,
      branchScopes: 1n,
      events: 2n,
      outbox: 1n,
      dedup: 1n,
    });
    assert.equal(
      fixture.connection.prepare(`
        SELECT count(*) AS count
        FROM command_dedup
        WHERE command_id = $commandId AND idempotency_key = $idempotencyKey
      `).get({
        $commandId: command.commandId,
        $idempotencyKey: command.idempotencyKey,
      })?.count,
      1n,
    );
  });

  it("preserves retryable SQLITE_BUSY when failed COMMIT is rolled back", () => {
    const fixture = createFixture();
    const connection = new CommitFailureConnection(
      fixture.connection,
      { errcode: 5, code: "ERR_SQLITE_ERROR" },
    );
    const store = new EventStore(
      connection,
      new SqliteEventStoreStatements(connection),
      new MaintenanceFence(),
      new BranchScopeRepository(),
      () => NOW,
      uuidGenerator(1_100),
    );

    const error = expectEventStoreError(
      () => store.append(appendCommand(fixture.context)),
      "SQLITE_BUSY",
    );

    assert.deepEqual(error.details, { retryable: true });
    assert.equal(connection.rollbackAttempts, 1);
    assert.deepEqual(counts(fixture.connection), {
      streams: 0n,
      branchScopes: 0n,
      events: 0n,
      outbox: 0n,
      dedup: 0n,
    });
  });

  it("atomically appends an ordered pair, chains hashes, stores outbox, and exactly replays", () => {
    const fixture = createFixture({
      now: (() => {
        const values = [NOW, "2026-07-13T01:01:00.000Z"];
        return () => values.shift() ?? "2026-07-13T01:02:00.000Z";
      })(),
    });
    const command = appendCommand(fixture.context);

    const first = fixture.store.append(command);
    assert.deepEqual(
      [first.firstGlobalPosition, first.lastGlobalPosition, first.finalStreamVersion],
      [1n, 2n, 2n],
    );
    assert.equal(first.deduplicated, false);
    const replay = fixture.store.append(command);
    assert.equal(replay.deduplicated, true);
    assert.deepEqual({ ...replay, deduplicated: false }, first);

    const rows = fixture.connection.prepare(`
      SELECT global_position, stream_version, command_event_index,
             previous_global_hash, event_hash, recorded_at
      FROM events ORDER BY global_position
    `).all();
    assert.deepEqual(rows.map((row) => row.command_event_index), [0n, 1n]);
    assert.deepEqual(rows.map((row) => row.stream_version), [1n, 2n]);
    assert.equal(rows[0]?.previous_global_hash, GENESIS_GLOBAL_HASH);
    assert.equal(rows[1]?.previous_global_hash, rows[0]?.event_hash);
    assert.deepEqual(rows.map((row) => row.recorded_at), [NOW, NOW]);
    assert.deepEqual({ ...fixture.connection.prepare(`
      SELECT target_key, event_position, kind, payload_json, status, attempt_count
      FROM outbox
    `).get() }, {
      target_key: "test/stream-1/2",
      event_position: 2n,
      kind: "test-materialization",
      payload_json: '{"streamId":"stream-1"}',
      status: "pending",
      attempt_count: 0n,
    });
    assert.deepEqual(counts(fixture.connection), {
      streams: 1n,
      branchScopes: 1n,
      events: 2n,
      outbox: 1n,
      dedup: 1n,
    });
  });

  it("persists compact command-time workspace and outbox-order witnesses", () => {
    const gitFixture = createFixture();
    const gitCommand = appendCommand(gitFixture.context, {
      outbox: [
        {
          targetKey: "test/second",
          kind: "second",
          eventIndex: 0,
          payload: { ordinal: 2 },
        },
        {
          targetKey: "test/first",
          kind: "first",
          eventIndex: 0,
          payload: { ordinal: 1 },
        },
      ],
    });
    gitFixture.store.append(gitCommand);
    assert.deepEqual({ ...gitFixture.connection.prepare(`
      SELECT workspace_head_commit, outbox_order_json FROM command_dedup
    `).get() }, {
      workspace_head_commit: gitWorkspace().headCommit,
      outbox_order_json: canonicalJson(["test/second", "test/first"]),
    });

    const localWorkspace: NonGitWorkspaceSnapshot = {
      kind: "non-git",
      workspaceRoot: "C:\\project",
      workspaceId: "workspace-local-witness" as WorkspaceId,
    };
    const localContext = contextFor(localWorkspace);
    const localFixture = createFixture({ context: localContext });
    localFixture.store.append(appendCommand(localContext, { outbox: [] }));
    assert.deepEqual({ ...localFixture.connection.prepare(`
      SELECT workspace_head_commit, outbox_order_json FROM command_dedup
    `).get() }, {
      workspace_head_commit: null,
      outbox_order_json: "[]",
    });
  });

  it("locks the complete semantic command hash while excluding generated and transport-only fields", () => {
    const fixture = createFixture();
    const command = appendCommand(fixture.context);
    fixture.store.append(command);

    const expectedMaterial: JsonValue = {
      commandId: command.commandId,
      commandType: command.commandType,
      projectId: PROJECT_ID,
      storeId: STORE_ID,
      workspaceId: WORKSPACE_ID,
      git: {
        headCommit: fixture.context.workspace.kind === "git"
          ? fixture.context.workspace.headCommit
          : "",
        branchRef: fixture.context.workspace.kind === "git"
          ? fixture.context.workspace.branchRef
          : null,
        detached: fixture.context.workspace.kind === "git"
          ? fixture.context.workspace.detached
          : false,
      },
      streamId: command.streamId,
      streamType: command.streamType,
      expectedStreamVersion: "0",
      correlationId: command.correlationId,
      agentId: command.agentId,
      events: command.events.map((item) => ({
        eventType: item.eventType,
        eventSchemaVersion: item.eventSchemaVersion,
        occurredAt: item.occurredAt,
        visibilityScope: item.visibilityScope,
        sessionId: item.sessionId ?? null,
        parentSessionId: item.parentSessionId ?? null,
        causationId: item.causationId ?? null,
        confidence: item.confidence,
        verificationStatus: item.verificationStatus,
        payload: item.payload,
        sourceRefs: item.sourceRefs,
        evidenceRefs: [],
        evidenceDigests: [],
      })),
      outbox: command.outbox.map((item) => ({
        targetKey: item.targetKey,
        kind: item.kind,
        eventIndex: item.eventIndex,
        payload: item.payload,
      })),
    };
    assert.equal(
      fixture.connection.prepare("SELECT command_hash FROM command_dedup").get()?.command_hash,
      commandHash(expectedMaterial),
    );
    const responseJson = fixture.connection.prepare(`
      SELECT response_json FROM command_dedup
    `).get()?.response_json;
    assert.equal(typeof responseJson, "string");
    const parsed = JSON.parse(responseJson as string) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), [
      "eventIds",
      "finalStreamVersion",
      "firstGlobalPosition",
      "lastGlobalPosition",
      "response",
    ]);
    assert.equal("recordedAt" in parsed, false);
    assert.equal("idempotencyKey" in parsed, false);
    assert.equal("branchScopeId" in parsed, false);
  });

  it("rejects every semantic mutation under a committed idempotency key without changing rows", () => {
    const fixture = createFixture();
    const original = appendCommand(fixture.context);
    fixture.store.append(original);
    const baseline = counts(fixture.connection);
    const detached = gitWorkspace({
      headCommit: "fedcba9876543210fedcba9876543210fedcba98",
      branchRef: null,
      detached: true,
    });
    const workspaceChanged = gitWorkspace({
      workspaceId: "workspace-changed" as WorkspaceId,
    });
    const mutations: AppendCommand<JsonValue>[] = [
      { ...original, commandId: "44444444-4444-4444-8444-444444444444" },
      { ...original, commandType: "ChangedType" },
      { ...original, expectedStreamVersion: 1n },
      { ...original, streamId: "stream-changed" },
      { ...original, streamType: "changed" },
      { ...original, correlationId: "correlation-changed" },
      { ...original, agentId: "agent-changed" },
      { ...original, context: cloneContext(original.context, detached) },
      { ...original, context: cloneContext(original.context, workspaceChanged) },
      { ...original, events: [
        pendingEvent("ChangedEvent", { ordinal: 1 }),
        original.events[1]!,
      ] },
      { ...original, events: [
        { ...original.events[0]!, eventSchemaVersion: 2 },
        original.events[1]!,
      ] },
      { ...original, events: [
        { ...original.events[0]!, occurredAt: "2026-07-13T00:58:00Z" },
        original.events[1]!,
      ] },
      { ...original, events: [
        { ...original.events[0]!, visibilityScope: "workspace" },
        original.events[1]!,
      ] },
      { ...original, events: [
        { ...original.events[0]!, sessionId: "session-a", parentSessionId: "session-parent" },
        original.events[1]!,
      ] },
      { ...original, events: [
        { ...original.events[0]!, causationId: "causation-a" },
        original.events[1]!,
      ] },
      { ...original, events: [
        { ...original.events[0]!, confidence: "medium" },
        original.events[1]!,
      ] },
      { ...original, events: [
        { ...original.events[0]!, verificationStatus: "provisional" },
        original.events[1]!,
      ] },
      { ...original, events: [
        { ...original.events[0]!, sourceRefs: ["source-a"] },
        original.events[1]!,
      ] },
      { ...original, events: [
        { ...original.events[0]!, payload: { ordinal: 99 } },
        original.events[1]!,
      ] },
      { ...original, outbox: [{ ...original.outbox[0]!, targetKey: "changed-target" }] },
      { ...original, outbox: [{ ...original.outbox[0]!, kind: "changed-kind" }] },
      { ...original, outbox: [{ ...original.outbox[0]!, eventIndex: 0 }] },
      { ...original, outbox: [{ ...original.outbox[0]!, payload: { changed: true } }] },
    ];

    for (const mutated of mutations) {
      expectEventStoreError(() => fixture.store.append(mutated), "IDEMPOTENCY_CONFLICT");
      assert.deepEqual(counts(fixture.connection), baseline);
    }
  });

  it("rejects reuse of a command ID under another idempotency key", () => {
    const fixture = createFixture();
    const original = appendCommand(fixture.context);
    fixture.store.append(original);
    const conflict = expectEventStoreError(
      () => fixture.store.append({
        ...original,
        idempotencyKey: "client-a:another-key",
      }),
      "IDEMPOTENCY_CONFLICT",
    );
    assert.deepEqual(conflict.details, {});
    assert.equal(counts(fixture.connection).events, 2n);
  });

  it("rejects immutable stream type changes before event insertion", () => {
    const fixture = createFixture();
    fixture.store.append(appendCommand(fixture.context, {
      events: [pendingEvent("Created", {})],
      outbox: [],
    }));
    const error = expectEventStoreError(
      () => fixture.store.append(appendCommand(fixture.context, {
        commandId: "44444444-4444-4444-8444-444444444444",
        idempotencyKey: "client-a:command-2",
        expectedStreamVersion: 1n,
        streamType: "another-type",
        events: [pendingEvent("Changed", {})],
        outbox: [],
      })),
      "STREAM_TYPE_MISMATCH",
    );
    assert.deepEqual(error.details, { expected: "test", actual: "another-type" });
    assert.equal(counts(fixture.connection).events, 1n);
  });

  it("reports expected and actual decimal versions and rolls back a new branch scope", () => {
    const changedWorkspace = gitWorkspace({
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      branchRef: "refs/heads/conflict",
    });
    const fixture = createFixture({ context: contextFor(changedWorkspace) });
    fixture.connection.prepare(`
      INSERT INTO streams(project_id, stream_id, stream_type, current_version, created_at, updated_at)
      VALUES ($projectId, $streamId, $streamType, 5, $now, $now)
    `).run({
      $projectId: PROJECT_ID,
      $streamId: "stream-1",
      $streamType: "test",
      $now: NOW,
    });
    const error = expectEventStoreError(
      () => fixture.store.append(appendCommand(fixture.context, {
        expectedStreamVersion: 4n,
        events: [pendingEvent("Conflict", {})],
        outbox: [],
      })),
      "EVENT_CONFLICT",
    );
    assert.deepEqual(error.details, { expected: "4", actual: "5" });
    assert.deepEqual(counts(fixture.connection), {
      streams: 1n,
      branchScopes: 0n,
      events: 0n,
      outbox: 0n,
      dedup: 0n,
    });
  });

  it("rolls back stream, branch scope, events, outbox, and dedup when a generated UUID collides", () => {
    const duplicate = "44444444-4444-4444-8444-444444444444";
    const fixture = createFixture({ randomId: () => duplicate });
    expectEventStoreError(
      () => fixture.store.append(appendCommand(fixture.context)),
      "STORE_UNAVAILABLE",
    );
    assert.deepEqual(counts(fixture.connection), {
      streams: 0n,
      branchScopes: 0n,
      events: 0n,
      outbox: 0n,
      dedup: 0n,
    });
  });

  it("rolls back a later stream and event when an outbox target collides", () => {
    const fixture = createFixture();
    const first = appendCommand(fixture.context, {
      events: [pendingEvent("First", {})],
      outbox: [{ targetKey: "shared-target", kind: "projection", eventIndex: 0, payload: {} }],
    });
    fixture.store.append(first);
    const baseline = counts(fixture.connection);
    expectEventStoreError(
      () => fixture.store.append(appendCommand(fixture.context, {
        commandId: "44444444-4444-4444-8444-444444444444",
        idempotencyKey: "client-a:command-2",
        streamId: "stream-2",
        events: [pendingEvent("Second", {})],
        outbox: [{ targetKey: "shared-target", kind: "projection", eventIndex: 0, payload: {} }],
      })),
      "STORE_UNAVAILABLE",
    );
    assert.deepEqual(counts(fixture.connection), baseline);
    assert.equal(
      fixture.connection.prepare("SELECT count(*) AS count FROM streams WHERE stream_id = 'stream-2'").get()?.count,
      0n,
    );
  });

  it("keeps events and command replay records immutable", () => {
    const fixture = createFixture();
    fixture.store.append(appendCommand(fixture.context));
    assert.throws(
      () => fixture.connection.exec("UPDATE events SET confidence = 'low'"),
      /EVENTS_IMMUTABLE/,
    );
    assert.throws(
      () => fixture.connection.exec("DELETE FROM events"),
      /EVENTS_IMMUTABLE/,
    );
    assert.throws(
      () => fixture.connection.exec("UPDATE command_dedup SET command_type = 'changed'"),
      /COMMAND_DEDUP_IMMUTABLE/,
    );
    assert.throws(
      () => fixture.connection.exec("DELETE FROM command_dedup"),
      /COMMAND_DEDUP_IMMUTABLE/,
    );
  });

  it("rejects the complete validation matrix before opening a transaction", () => {
    const fixture = createFixture();
    const base = appendCommand(fixture.context);
    const nonGitWorkspace: NonGitWorkspaceSnapshot = {
      kind: "non-git",
      workspaceRoot: "C:\\project",
      workspaceId: "workspace-non-git" as WorkspaceId,
    };
    const nonGitContext = contextFor(nonGitWorkspace);
    const cases: Array<{ code: string; command: AppendCommand<JsonValue> }> = [
      { code: "COMMAND_ID_INVALID", command: { ...base, commandId: "not-a-uuid" } },
      { code: "COMMAND_INVALID", command: { ...base, idempotencyKey: " " } },
      { code: "COMMAND_INVALID", command: { ...base, commandType: "" } },
      { code: "COMMAND_INVALID", command: { ...base, streamId: "" } },
      { code: "COMMAND_INVALID", command: { ...base, streamType: "" } },
      { code: "COMMAND_INVALID", command: { ...base, correlationId: "" } },
      { code: "COMMAND_INVALID", command: { ...base, agentId: "" } },
      { code: "EXPECTED_STREAM_VERSION_INVALID", command: { ...base, expectedStreamVersion: -1n } },
      { code: "EXPECTED_STREAM_VERSION_INVALID", command: {
        ...base,
        expectedStreamVersion: 9_223_372_036_854_775_807n,
      } },
      { code: "EVENT_BATCH_SIZE_INVALID", command: { ...base, events: [] } },
      { code: "EVENT_BATCH_SIZE_INVALID", command: {
        ...base,
        events: Array.from({ length: MAX_EVENTS_PER_COMMAND + 1 }, (_, index) => pendingEvent("Many", { index })),
      } },
      { code: "GLOBAL_SCOPE_DENIED", command: {
        ...base,
        events: [pendingEvent("Global", {}, { visibilityScope: "global" })],
        outbox: [],
      } },
      { code: "EVIDENCE_NOT_AVAILABLE_IN_SUBPROJECT_1", command: {
        ...base,
        events: [pendingEvent("Evidence", {}, { evidenceRefs: ["evidence-a"] })],
        outbox: [],
      } },
      { code: "EVIDENCE_NOT_AVAILABLE_IN_SUBPROJECT_1", command: {
        ...base,
        events: [pendingEvent("Evidence", {}, {
          evidenceDigests: [{ ciphertextHash: "a", keyedFingerprint: "b" }],
        })],
        outbox: [],
      } },
      ...["", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00+24:00", " 2026-01-01T00:00:00Z"].map(
        (occurredAt): { code: string; command: AppendCommand<JsonValue> } => ({
          code: "TIMESTAMP_INVALID",
          command: {
            ...base,
            events: [pendingEvent("BadTime", {}, { occurredAt })],
            outbox: [],
          },
        }),
      ),
      { code: "CANONICAL_VALUE_INVALID", command: {
        ...base,
        events: [pendingEvent("Noncanonical", { invalid: undefined } as unknown as JsonValue)],
        outbox: [],
      } },
      { code: "WORKSPACE_AMBIGUOUS", command: {
        ...base,
        context: nonGitContext,
        events: [pendingEvent("Branch", {}, { visibilityScope: "branch" })],
        outbox: [],
      } },
      { code: "SESSION_NOT_FOUND", command: {
        ...base,
        events: [pendingEvent("Session", {}, { visibilityScope: "session" })],
        outbox: [],
      } },
      { code: "OUTBOX_EVENT_INDEX_INVALID", command: {
        ...base,
        outbox: [{ ...base.outbox[0]!, eventIndex: 2 }],
      } },
      { code: "OUTBOX_TARGET_CONFLICT", command: {
        ...base,
        outbox: [base.outbox[0]!, { ...base.outbox[0]! }],
      } },
      { code: "OUTBOX_INVALID", command: {
        ...base,
        outbox: [{ ...base.outbox[0]!, targetKey: "" }],
      } },
      { code: "OUTBOX_INVALID", command: {
        ...base,
        outbox: [{ ...base.outbox[0]!, kind: "" }],
      } },
      { code: "OUTBOX_BATCH_SIZE_INVALID", command: {
        ...base,
        outbox: Array.from({ length: MAX_EVENTS_PER_COMMAND + 1 }, (_, index): PendingOutbox => ({
          targetKey: `target-${index}`,
          kind: "projection",
          eventIndex: 0,
          payload: { index },
        })),
      } },
      { code: "EVENT_INVALID", command: {
        ...base,
        events: [pendingEvent("", {})],
        outbox: [],
      } },
      { code: "EVENT_INVALID", command: {
        ...base,
        events: [pendingEvent("BadSchema", {}, { eventSchemaVersion: 0 })],
        outbox: [],
      } },
      { code: "EVENT_INVALID", command: {
        ...base,
        events: [pendingEvent("BadScope", {}, { visibilityScope: "future" as never })],
        outbox: [],
      } },
      { code: "EVENT_INVALID", command: {
        ...base,
        events: [pendingEvent("BadConfidence", {}, { confidence: "certain" as never })],
        outbox: [],
      } },
      { code: "EVENT_INVALID", command: {
        ...base,
        events: [pendingEvent("BadVerification", {}, { verificationStatus: "done" as never })],
        outbox: [],
      } },
      { code: "COMMAND_TOO_LARGE", command: {
        ...base,
        events: [pendingEvent("TooLarge", { text: "x".repeat(MAX_CANONICAL_COMMAND_BYTES) })],
        outbox: [],
      } },
    ];

    for (const item of cases) {
      const before = fixture.connection.beginCount;
      expectEventStoreError(() => fixture.store.append(item.command), item.code);
      assert.equal(fixture.connection.beginCount, before, item.code);
      assert.deepEqual(counts(fixture.connection), {
        streams: 0n,
        branchScopes: 0n,
        events: 0n,
        outbox: 0n,
        dedup: 0n,
      });
    }
  });

  for (const field of ["publicResponse", "idempotencyKey"] as const) {
    it(`rejects an oversized ${field} before opening a transaction`, () => {
      const fixture = createFixture();
      const base = appendCommand(fixture.context);
      const oversized = "x".repeat(MAX_CANONICAL_COMMAND_BYTES + 1);
      const command: AppendCommand<JsonValue> = field === "publicResponse"
        ? { ...base, publicResponse: { text: oversized } }
        : { ...base, idempotencyKey: oversized };

      expectEventStoreError(() => fixture.store.append(command), "COMMAND_TOO_LARGE");
      assert.equal(fixture.connection.beginCount, 0);
      assert.deepEqual(counts(fixture.connection), {
        streams: 0n,
        branchScopes: 0n,
        events: 0n,
        outbox: 0n,
        dedup: 0n,
      });
    });
  }

  it("validates generated recorded times, generated event IDs, and exact bound workspace identity before BEGIN", () => {
    const invalidTime = createFixture({ now: () => "2026-02-30T00:00:00Z" });
    expectEventStoreError(
      () => invalidTime.store.append(appendCommand(invalidTime.context)),
      "TIMESTAMP_INVALID",
    );
    assert.equal(invalidTime.connection.beginCount, 0);

    const invalidId = createFixture({ randomId: () => "generated-but-not-a-uuid" });
    expectEventStoreError(
      () => invalidId.store.append(appendCommand(invalidId.context)),
      "EVENT_ID_INVALID",
    );
    assert.equal(invalidId.connection.beginCount, 0);

    const fixture = createFixture();
    assert.equal(fixture.context.workspace.kind, "git");
    const mismatchedWorkspace = {
      ...fixture.context.workspace,
      headCommit: "ffffffffffffffffffffffffffffffffffffffff",
    } as GitWorkspaceSnapshot;
    const mismatchedContext: ProjectContext = {
      ...fixture.context,
      workspace: mismatchedWorkspace,
    };
    expectEventStoreError(
      () => fixture.store.append(appendCommand(mismatchedContext)),
      "PROJECT_CONTEXT_MISMATCH",
    );
    assert.equal(fixture.connection.beginCount, 0);
  });

  it("rejects incomplete Git and non-Git workspace snapshots even when both context copies omit the same field", () => {
    const fixture = createFixture();
    assert.equal(fixture.context.workspace.kind, "git");
    const gitFields = [
      "worktreeRoot",
      "gitDir",
      "gitCommonDir",
      "headCommit",
      "workspaceId",
    ] as const;
    for (const field of gitFields) {
      const contextWorkspace = { ...fixture.context.workspace } as Record<string, unknown>;
      const bindingWorkspace = { ...fixture.context.binding.workspace } as Record<string, unknown>;
      delete contextWorkspace[field];
      delete bindingWorkspace[field];
      const incomplete: ProjectContext = {
        ...fixture.context,
        workspace: contextWorkspace as unknown as GitWorkspaceSnapshot,
        binding: {
          ...fixture.context.binding,
          workspace: bindingWorkspace as unknown as GitWorkspaceSnapshot,
        },
      };
      const before = fixture.connection.beginCount;
      expectEventStoreError(
        () => fixture.store.append(appendCommand(incomplete)),
        "PROJECT_CONTEXT_MISMATCH",
      );
      assert.equal(fixture.connection.beginCount, before, field);
      assert.deepEqual(counts(fixture.connection), {
        streams: 0n,
        branchScopes: 0n,
        events: 0n,
        outbox: 0n,
        dedup: 0n,
      });
    }

    const nonGitWorkspace: NonGitWorkspaceSnapshot = {
      kind: "non-git",
      workspaceRoot: "C:\\project",
      workspaceId: "workspace-non-git" as WorkspaceId,
    };
    const validNonGit = contextFor(nonGitWorkspace);
    const missingRoot = { ...nonGitWorkspace } as Record<string, unknown>;
    delete missingRoot.workspaceRoot;
    const incompleteNonGit: ProjectContext = {
      ...validNonGit,
      workspace: missingRoot as unknown as NonGitWorkspaceSnapshot,
      binding: {
        ...validNonGit.binding,
        workspace: { ...missingRoot } as unknown as NonGitWorkspaceSnapshot,
      },
    };
    const before = fixture.connection.beginCount;
    expectEventStoreError(
      () => fixture.store.append(appendCommand(incompleteNonGit)),
      "PROJECT_CONTEXT_MISMATCH",
    );
    assert.equal(fixture.connection.beginCount, before);
    assert.deepEqual(counts(fixture.connection), {
      streams: 0n,
      branchScopes: 0n,
      events: 0n,
      outbox: 0n,
      dedup: 0n,
    });
  });

  it("rejects a new append during quiescing but permits read-only replay of committed dedup", () => {
    const fixture = createFixture();
    const original = appendCommand(fixture.context);
    const first = fixture.store.append(original);
    fixture.connection.exec("BEGIN IMMEDIATE");
    fixture.connection.exec(`
      UPDATE maintenance_state
      SET epoch = 1, mode = 'quiescing', owner_id = 'maintenance-a',
          fencing_token = 1, lease_expires_at = '2026-07-13T03:00:00Z',
          requested_at = '2026-07-13T01:00:00Z'
    `);
    fixture.connection.exec("COMMIT");

    const replay = fixture.store.append(original);
    assert.deepEqual({ ...replay, deduplicated: false }, first);
    assert.equal(replay.deduplicated, true);
    expectEventStoreError(
      () => fixture.store.append(appendCommand(fixture.context, {
        commandId: "44444444-4444-4444-8444-444444444444",
        idempotencyKey: "client-a:command-2",
        expectedStreamVersion: 2n,
        events: [pendingEvent("Third", {})],
        outbox: [],
      })),
      "MAINTENANCE_QUIESCING",
    );
    assert.equal(counts(fixture.connection).events, 2n);
  });

  it("preserves contiguous command indexes and stream versions at the 128-event boundary", () => {
    const fixture = createFixture();
    const events = Array.from(
      { length: MAX_EVENTS_PER_COMMAND },
      (_, index) => pendingEvent("BoundaryEvent", { index }),
    );
    const result = fixture.store.append(appendCommand(fixture.context, {
      events,
      outbox: [],
    }));
    assert.deepEqual(
      [result.firstGlobalPosition, result.lastGlobalPosition, result.finalStreamVersion],
      [1n, 128n, 128n],
    );
    const rows = fixture.connection.prepare(`
      SELECT global_position, stream_version, command_event_index
      FROM events ORDER BY global_position
    `).all();
    assert.deepEqual(
      rows.map((row) => row.global_position),
      Array.from({ length: 128 }, (_, index) => BigInt(index + 1)),
    );
    assert.deepEqual(
      rows.map((row) => row.stream_version),
      Array.from({ length: 128 }, (_, index) => BigInt(index + 1)),
    );
    assert.deepEqual(
      rows.map((row) => row.command_event_index),
      Array.from({ length: 128 }, (_, index) => BigInt(index)),
    );
  });

  it("turns every replay corruption shape into INTEGRITY_FAILURE", () => {
    for (const corrupt of [
      (fixture: Fixture): void => {
        fixture.connection.prepare(`
          UPDATE command_dedup SET response_json = $json
        `).run({ $json: '{"changed":true}' });
      },
      (fixture: Fixture): void => {
        const malformed = {
          eventIds: [7],
          firstGlobalPosition: "1",
          lastGlobalPosition: "2",
          finalStreamVersion: "2",
          response: { accepted: true },
        };
        fixture.connection.prepare(`
          UPDATE command_dedup SET response_json = $json, response_hash = $hash
        `).run({
          $json: canonicalJson(malformed),
          $hash: responseHash(malformed),
        });
      },
      (fixture: Fixture): void => {
        const malformed = {
          eventIds: [uuid(1), uuid(2)],
          firstGlobalPosition: "01",
          lastGlobalPosition: "2",
          finalStreamVersion: "2",
          response: { accepted: true },
        };
        fixture.connection.prepare(`
          UPDATE command_dedup SET response_json = $json, response_hash = $hash
        `).run({
          $json: canonicalJson(malformed),
          $hash: responseHash(malformed),
        });
      },
    ]) {
      const fixture = createFixture();
      const command = appendCommand(fixture.context);
      fixture.store.append(command);
      fixture.connection.exec("DROP TRIGGER command_dedup_no_update");
      corrupt(fixture);
      expectEventStoreError(() => fixture.store.append(command), "INTEGRITY_FAILURE");
    }
  });

  it("rejects coherently rehashed replay rows with duplicate event IDs or an impossible final stream version", () => {
    for (const malformed of [
      {
        eventIds: [uuid(1), uuid(1)],
        firstGlobalPosition: "1",
        lastGlobalPosition: "2",
        finalStreamVersion: "2",
        response: { accepted: true },
      },
      {
        eventIds: [uuid(1), uuid(2)],
        firstGlobalPosition: "1",
        lastGlobalPosition: "2",
        finalStreamVersion: "1",
        response: { accepted: true },
      },
    ]) {
      const fixture = createFixture();
      const command = appendCommand(fixture.context);
      fixture.store.append(command);
      fixture.connection.exec("DROP TRIGGER command_dedup_no_update");
      fixture.connection.prepare(`
        UPDATE command_dedup SET response_json = $json, response_hash = $hash
      `).run({
        $json: canonicalJson(malformed),
        $hash: responseHash(malformed),
      });
      expectEventStoreError(() => fixture.store.append(command), "INTEGRITY_FAILURE");
    }
  });

  it("classifies only numeric primary SQLITE_BUSY codes as retryable and never rolls back a transaction that did not begin", () => {
    const fixture = createFixture();

    class BeginFailureConnection implements SqliteConnection {
      rollbackCount = 0;

      constructor(
        readonly inner: SqliteConnection,
        readonly failure: unknown,
      ) {}

      exec(sql: string): void {
        const normalized = sql.trim().replace(/\s+/g, " ").toUpperCase();
        if (normalized === "BEGIN IMMEDIATE") throw this.failure;
        if (normalized === "ROLLBACK") this.rollbackCount += 1;
        this.inner.exec(sql);
      }

      prepare(sql: string): SqliteStatement { return this.inner.prepare(sql); }
      close(): void { /* fixture owns the real connection */ }
    }

    for (const [failure, code, retryable] of [
      [{ errcode: 5 }, "SQLITE_BUSY", true],
      [{ errcode: 0x105 }, "SQLITE_BUSY", true],
      [{ errcode: 6 }, "STORE_UNAVAILABLE", false],
      [{ code: "ERR_SQLITE_ERROR", message: "database is busy" }, "STORE_UNAVAILABLE", false],
      [new Error("database is busy"), "STORE_UNAVAILABLE", false],
    ] as const) {
      const failing = new BeginFailureConnection(fixture.connection, failure);
      const store = new EventStore(
        failing,
        new SqliteEventStoreStatements(failing),
        new MaintenanceFence(),
        new BranchScopeRepository(),
        () => NOW,
        uuidGenerator(500),
      );
      const error = expectEventStoreError(
        () => store.append(appendCommand(fixture.context)),
        code,
      );
      assert.equal(error.details.retryable, retryable);
      assert.equal(failing.rollbackCount, 0);
    }
  });

  it("reports real cross-connection lock contention as retryable SQLITE_BUSY", () => {
    const fixture = createFixture();
    const contender = driver.open(fixture.path, {
      mode: "existing",
      busyTimeoutMs: 0,
    });
    connections.push(contender);
    const store = new EventStore(
      contender,
      new SqliteEventStoreStatements(contender),
      new MaintenanceFence(),
      new BranchScopeRepository(),
      () => NOW,
      uuidGenerator(700),
    );
    fixture.connection.exec("BEGIN IMMEDIATE");
    try {
      const error = expectEventStoreError(
        () => store.append(appendCommand(fixture.context)),
        "SQLITE_BUSY",
      );
      assert.deepEqual(error.details, { retryable: true });
    } finally {
      fixture.connection.exec("ROLLBACK");
    }
    assert.deepEqual(counts(fixture.connection), {
      streams: 0n,
      branchScopes: 0n,
      events: 0n,
      outbox: 0n,
      dedup: 0n,
    });
  });

  it("rejects a mismatched store identity before BEGIN and normalizes identity-read busy errors", () => {
    const fixture = createFixture();
    const wrongIdentity: ProjectContext = {
      ...fixture.context,
      binding: {
        ...fixture.context.binding,
        storeId: "99999999-9999-4999-8999-999999999999" as StoreId,
      },
    };
    expectEventStoreError(
      () => fixture.store.append(appendCommand(wrongIdentity)),
      "PROJECT_IDENTITY_MISMATCH",
    );
    assert.equal(fixture.connection.beginCount, 0);

    class IdentityBusyConnection implements SqliteConnection {
      constructor(readonly inner: SqliteConnection) {}
      exec(sql: string): void { this.inner.exec(sql); }
      prepare(sql: string): SqliteStatement {
        const statement = this.inner.prepare(sql);
        if (!sql.includes("FROM project_meta")) return statement;
        return {
          run: (params) => statement.run(params),
          get: (params) => statement.get(params),
          all: () => { throw { errcode: 5 }; },
          iterate: (params) => statement.iterate(params),
        };
      }
      close(): void { /* fixture owns the real connection */ }
    }
    const busyConnection = new IdentityBusyConnection(fixture.connection);
    const busyStore = new EventStore(
      busyConnection,
      new SqliteEventStoreStatements(busyConnection),
      new MaintenanceFence(),
      new BranchScopeRepository(),
      () => NOW,
      uuidGenerator(900),
    );
    const busy = expectEventStoreError(
      () => busyStore.append(appendCommand(fixture.context)),
      "SQLITE_BUSY",
    );
    assert.deepEqual(busy.details, { retryable: true });
    assert.equal(fixture.connection.beginCount, 0);
  });
});
