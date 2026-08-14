import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";

const NOW = "2026-08-14T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_ID = "33333333-3333-4333-8333-333333333333";
const LEGACY_EFFECTIVE_STATE_SOURCE_TABLE =
  "lifecycle_legacy_effective_state_sources";
const driver = new NodeSqliteDriver({ DatabaseSync });
const connections: SqliteConnection[] = [];
const roots: string[] = [];

function schema4Connection(): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "legacy-effective-state-source-"));
  roots.push(root);
  const connection = driver.open(join(root, "events.sqlite"), {
    mode: "create",
    busyTimeoutMs: 1_000,
  });
  connections.push(connection);
  applyCurrentProjectStoreSchema(connection, {
    projectId: PROJECT_ID,
    vaultId: VAULT_ID,
    storeId: STORE_ID,
  }, NOW);
  return connection;
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("legacy effective-state source sidecar", () => {
  it("exposes the exact sidecar table at schema 4", () => {
    const connection = schema4Connection();

    assert.deepEqual(
      connection.prepare(`
        SELECT type, name, tbl_name
        FROM sqlite_schema
        WHERE type = 'table' AND name = $name
      `).get({ $name: LEGACY_EFFECTIVE_STATE_SOURCE_TABLE }),
      {
        type: "table",
        name: LEGACY_EFFECTIVE_STATE_SOURCE_TABLE,
        tbl_name: LEGACY_EFFECTIVE_STATE_SOURCE_TABLE,
      },
    );
  });
});
