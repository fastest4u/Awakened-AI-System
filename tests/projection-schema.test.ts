import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import { projectionCoreChecksum } from "../src/orchestrator/projections/checksum.js";
import { createProjectionSchema } from "../src/orchestrator/projections/schema.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("independent projection schema", () => {
  it("creates the typed core tables, bounded-query indexes, and one metadata row", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-schema-"));
    roots.push(root);
    const connection = new NodeSqliteDriver({ DatabaseSync }).open(
      join(root, "projections-1-2.sqlite"),
      { mode: "create", busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS },
    );
    try {
      createProjectionSchema(connection);

      assert.equal(
        connection.prepare("SELECT count(*) AS n FROM projection_metadata").get()?.n,
        1n,
      );
      assert.equal(
        connection.prepare("SELECT schema_version FROM projection_metadata WHERE singleton = 1").get()?.schema_version,
        1n,
      );
      assert.deepEqual(
        connection.prepare("PRAGMA table_info(projection_metadata)").all().map((row) => row.name),
        [
          "singleton",
          "schema_version",
          "project_id",
          "vault_id",
          "store_id",
          "workspace_id",
          "branch_scope_id",
          "branch_ref",
          "session_id",
          "generation",
          "terminal_event_position",
          "terminal_event_hash",
          "created_at",
        ],
      );
      const objects = connection.prepare(`
        SELECT name, type, sql FROM sqlite_schema
        WHERE name NOT GLOB 'sqlite_*'
        ORDER BY name
      `).all();
      const names = new Set(objects.map((row) => row.name));
      for (const table of [
        "projection_metadata",
        "session_tree",
        "canonical_items",
        "tasks_followups",
        "artifacts_files",
        "entity_graph",
        "lexical_chunks",
        "retrieval_feedback",
        "lexical_chunks_fts",
      ]) assert.equal(names.has(table), true, `missing ${table}`);
      for (const table of [
        "projection_metadata",
        "session_tree",
        "canonical_items",
        "tasks_followups",
        "artifacts_files",
        "entity_graph",
        "lexical_chunks",
        "retrieval_feedback",
      ]) {
        const definition = objects.find((row) => row.name === table)?.sql;
        assert.match(String(definition), /\bSTRICT\b/u);
      }
      assert.deepEqual(
        connection.prepare("PRAGMA database_list").all().map((row) => row.name),
        ["main"],
      );
    } finally {
      connection.close();
    }
  });

  it("computes domain-separated canonical checksums without depending on object key order", () => {
    const first = projectionCoreChecksum(
      "canonicalItems",
      1,
      "1".repeat(64),
      17n,
      [{ itemId: "item-1", sourceEventPosition: "17", summary: "Decision" }],
    );
    const reordered = projectionCoreChecksum(
      "canonicalItems",
      1,
      "1".repeat(64),
      17n,
      [{ summary: "Decision", sourceEventPosition: "17", itemId: "item-1" }],
    );
    const otherOrder = projectionCoreChecksum(
      "canonicalItems",
      1,
      "1".repeat(64),
      17n,
      [
        { itemId: "item-2", sourceEventPosition: "16", summary: "Earlier" },
        { itemId: "item-1", sourceEventPosition: "17", summary: "Decision" },
      ],
    );

    assert.match(first, /^[0-9a-f]{64}$/u);
    assert.equal(reordered, first);
    assert.notEqual(otherOrder, first);
    assert.throws(
      () => projectionCoreChecksum("invented" as never, 1, "1".repeat(64), 17n, []),
      /PROJECTION_CHECKSUM_INVALID/u,
    );
  });
});
