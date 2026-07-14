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
  responseHash,
} from "../src/orchestrator/crypto/event-hash.js";
import {
  EventIntegrityService,
  MAX_INTEGRITY_RANGE_EVENTS,
  MAX_QUICK_TAIL_EVENTS,
} from "../src/orchestrator/integrity/event-integrity.service.js";
import {
  INTEGRITY_ISSUE_CODES,
  IntegrityInputError,
  type IntegrityIssueCode,
} from "../src/orchestrator/integrity/integrity.types.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/orchestrator/runtime/runtime-capabilities.js";
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
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import type {
  SqliteConnection,
  SqliteRow,
  SqliteStatement,
} from "../src/orchestrator/storage/sqlite-driver.js";

const NOW = "2026-07-13T02:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as ProjectId;
const VAULT_ID = "22222222-2222-4222-8222-222222222222" as VaultId;
const STORE_ID = "33333333-3333-4333-8333-333333333333" as StoreId;
const WORKSPACE_ID = "workspace-integrity" as WorkspaceId;
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

function createFixture(options: { append?: boolean } = {}): Fixture {
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
    integrity: new EventIntegrityService(connection),
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

class ObservingConnection implements SqliteConnection {
  readonly executed: string[] = [];

  constructor(
    private readonly inner: SqliteConnection,
    private readonly afterFirstRead?: () => void,
    private readonly throwOnPrepare?: RegExp,
  ) {}

  exec(sql: string): void {
    this.executed.push(sql.trim().replace(/\s+/g, " ").toUpperCase());
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

    const report = fixture.integrity.fullCheck(fixture.context);
    assert.equal(report.ok, false);
    assert.ok(issueCodes(report).includes("PROJECT_SCHEMA_VERSION_MISMATCH"));
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
    const failedReport = new EventIntegrityService(observing).fullCheck(findingFixture.context);
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
      () => new EventIntegrityService(throwing).quickCheck(exceptionFixture.context, 256),
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
      () => new EventIntegrityService(witnessReadFailure).fullCheck(witnessFixture.context),
      /INJECTED_READ_FAILURE/,
    );
    assert.equal(witnessReadFailure.executed[0], "BEGIN DEFERRED");
    assert.equal(witnessReadFailure.executed.at(-1), "ROLLBACK");
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

    const snapshot = new EventIntegrityService(observing).quickCheck(fixture.context, 256);
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
