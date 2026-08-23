import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import { payloadHash } from "../src/orchestrator/crypto/event-hash.js";
import type {
  BranchScopeId,
  ProjectId,
  StoreId,
  VaultId,
  WorkspaceId,
} from "../src/orchestrator/identity/contracts.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import { SqliteProjectionEventReader } from "../src/orchestrator/projections/event-reader.js";
import { PROJECT_MEMORY_APPLICATION_ID } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type {
  SqliteConnection,
  SqliteDriver,
  SqliteOpenOptions,
} from "../src/orchestrator/storage/sqlite-driver.js";

const PROJECT_ID = "1".repeat(64) as ProjectId;
const VAULT_ID = "2".repeat(64) as VaultId;
const STORE_ID = "3".repeat(64) as StoreId;
const WORKSPACE_ID = "4".repeat(64) as WorkspaceId;
const BRANCH_SCOPE_ID = "00000000-0000-4000-8000-000000000041" as BranchScopeId;
const BRANCH_REF = "refs/heads/projection-builder";
const SESSION_ID = "00000000-0000-4000-8000-000000000042";
const ITEM_ID = "00000000-0000-4000-8000-000000000043";
const NOW = "2026-08-23T02:00:00.000Z";

const BINDING: ProjectBinding = Object.freeze({
  projectId: PROJECT_ID,
  vaultId: VAULT_ID,
  storeId: STORE_ID,
  workspaceId: WORKSPACE_ID,
  branchScopeId: BRANCH_SCOPE_ID,
  branchRef: BRANCH_REF,
  sessionId: null,
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createSource(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA application_id = ${PROJECT_MEMORY_APPLICATION_ID};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE project_meta(
      singleton INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      store_id TEXT NOT NULL
    ) STRICT;
    INSERT INTO project_meta VALUES (
      1, '${PROJECT_ID}', '${VAULT_ID}', '${STORE_ID}'
    );
    CREATE TABLE events(
      global_position INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      branch_scope_id TEXT,
      branch_ref TEXT,
      stream_id TEXT NOT NULL,
      stream_type TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_schema_version INTEGER NOT NULL,
      session_id TEXT,
      parent_session_id TEXT,
      actor_role TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      client_instance_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      causation_id TEXT,
      command_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      command_event_index INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      visibility_scope TEXT NOT NULL,
      confidence TEXT NOT NULL,
      verification_status TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      evidence_digests_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      previous_global_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      lifecycle_intent_json TEXT
    ) STRICT;
  `);
  return database;
}

function memoryPayload(): JsonValue {
  return {
    sourceVersion: 1,
    binding: { ...BINDING, sessionId: SESSION_ID },
    itemId: ITEM_ID,
    normalizedKey: "decision:immutable-projections",
    status: "verified",
    confidence: "high",
    verificationMethod: "committed-event",
    validFrom: NOW,
    validTo: null,
    summary: "Published projection generations are immutable.",
    contentHash: "a".repeat(64),
  };
}

function insertEvent(
  database: DatabaseSync,
  position: number,
  eventType = "IgnoredEvent",
  payload: JsonValue = {},
): void {
  const eventId = `00000000-0000-4000-8000-${String(position).padStart(12, "0")}`;
  const commandId = `00000000-0000-4000-9000-${String(position).padStart(12, "0")}`;
  const payloadJson = canonicalJson(payload);
  database.prepare(`
    INSERT INTO events VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, 'session', ?, ?, 1, ?, NULL,
      'primary', 'builder-test', 'builder-client', ?, NULL, ?, ?, 0,
      ?, ?, 'session', 'high', 'verified', '[]', '[]', '[]', ?, ?, ?, ?, NULL
    )
  `).run(
    position,
    eventId,
    PROJECT_ID,
    VAULT_ID,
    STORE_ID,
    WORKSPACE_ID,
    BRANCH_SCOPE_ID,
    BRANCH_REF,
    `session/${SESSION_ID}`,
    position,
    eventType,
    SESSION_ID,
    `00000000-0000-4000-a000-${String(position).padStart(12, "0")}`,
    commandId,
    `builder/${position}`,
    NOW,
    NOW,
    payloadJson,
    payloadHash(payload),
    position === 1 ? "0".repeat(64) : String(position - 1).repeat(64).slice(0, 64),
    String(position).repeat(64).slice(0, 64),
  );
}

class RecordingDriver implements SqliteDriver {
  readonly opens: Array<{ path: string; options: SqliteOpenOptions }> = [];
  readonly #delegate = new NodeSqliteDriver({ DatabaseSync });

  open(path: string, options: SqliteOpenOptions): SqliteConnection {
    this.opens.push({ path, options: { ...options } });
    return this.#delegate.open(path, options);
  }
}

describe("projection generation builder", () => {
  it("reads one committed source snapshot and builds an independent immutable generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "projection-builder-"));
    roots.push(root);
    const sourcePath = join(root, "events.sqlite");
    const projectionDirectory = join(root, "projections");
    const source = createSource(sourcePath);
    for (let position = 1; position < 8; position += 1) insertEvent(source, position);
    insertEvent(source, 8, "MemorySourceRecorded", memoryPayload());

    source.exec("BEGIN IMMEDIATE");
    insertEvent(source, 9);

    const driver = new RecordingDriver();
    const reader = new SqliteProjectionEventReader({
      driver,
      eventStorePath: sourcePath,
    });
    const snapshot = await reader.openCommittedSnapshot(BINDING);
    assert.equal(snapshot.terminalEventPosition, 8n);
    assert.equal(snapshot.events.length, 8);

    const builder = new ImmutableProjectionBuilder({
      driver,
      projectionDirectory,
      now: () => NOW,
    });
    const generation = await builder.build(snapshot, 1);
    snapshot.close();

    assert.equal(generation.manifest.terminalEventPosition, "8");
    assert.equal(generation.manifest.sessionId, null);
    assert.deepEqual(
      {
        projectId: generation.manifest.projectId,
        vaultId: generation.manifest.vaultId,
        storeId: generation.manifest.storeId,
        workspaceId: generation.manifest.workspaceId,
        branchScopeId: generation.manifest.branchScopeId,
        branchRef: generation.manifest.branchRef,
      },
      {
        projectId: PROJECT_ID,
        vaultId: VAULT_ID,
        storeId: STORE_ID,
        workspaceId: WORKSPACE_ID,
        branchScopeId: BRANCH_SCOPE_ID,
        branchRef: BRANCH_REF,
      },
    );
    assert.equal(existsSync(generation.databasePath), true);
    assert.match(generation.manifest.databaseSha256, /^[0-9a-f]{64}$/u);

    source.exec("ROLLBACK");
    assert.equal(source.prepare("SELECT count(*) AS n FROM events").get()?.n, 8);
    source.close();

    const projected = new DatabaseSync(generation.databasePath, { readOnly: true });
    assert.deepEqual(
      projected.prepare("PRAGMA database_list").all().map((row) => row.name),
      ["main"],
    );
    assert.deepEqual(
      { ...projected.prepare(`
        SELECT terminal_event_position, terminal_event_hash, session_id
        FROM projection_metadata WHERE singleton = 1
      `).get() },
      {
        terminal_event_position: 8,
        terminal_event_hash: "8".repeat(64),
        session_id: null,
      },
    );
    assert.deepEqual(
      { ...projected.prepare(`
        SELECT item_id, normalized_key, summary, source_event_position
        FROM canonical_items
      `).get() },
      {
        item_id: ITEM_ID,
        normalized_key: "decision:immutable-projections",
        summary: "Published projection generations are immutable.",
        source_event_position: 8,
      },
    );
    projected.close();

    assert.deepEqual(
      driver.opens.map((entry) => [entry.path, entry.options.mode]),
      [
        [sourcePath, "read-only-existing"],
        [join(projectionDirectory, ".projections-1-1.sqlite.tmp"), "create"],
      ],
    );
  });
});
