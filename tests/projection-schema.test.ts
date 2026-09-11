import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import {
  PROJECTION_NAMES,
  projectionCoreChecksum,
} from "../src/orchestrator/projections/checksum.js";
import {
  createProjectionSchema,
  PROJECTION_SCHEMA_VERSION,
  PROJECTION_SCHEMA_SQL_V1,
  PROJECTION_SCHEMA_SQL_V2,
} from "../src/orchestrator/projections/schema.js";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../src/orchestrator/runtime/runtime-capabilities.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";

const roots: string[] = [];

describe("projection metadata production identity domain", () => {
  for (const [version, sql] of [[1, PROJECTION_SCHEMA_SQL_V1], [2, PROJECTION_SCHEMA_SQL_V2]] as const) {
    it(`schema ${version} accepts UUIDv4 and legacy hashes and rejects malformed identities`, () => {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec(sql);
        const update = database.prepare("UPDATE projection_metadata SET project_id=$id,vault_id=$id,store_id=$id,workspace_id=$workspace,generation=1,terminal_event_position=0,terminal_event_hash=$hash,created_at='2026-09-10T00:00:00.000Z' WHERE singleton=1");
        const valid = "11111111-1111-4111-8111-111111111111";
        for (const id of [valid, "a".repeat(64)]) assert.doesNotThrow(() => update.run({ $id: id, $workspace: "b".repeat(64), $hash: "0".repeat(64) }));
        for (const id of ["11111111-1111-1111-8111-111111111111", "11111111-1111-4111-7111-111111111111", "G".repeat(64), valid.toUpperCase().replace("1111", "ABCD"), "1".repeat(36), valid + "x", valid + "\0suffix", "a".repeat(64) + "\0suffix", valid.slice(0, 8) + "\0" + valid.slice(9)]) {
          assert.throws(() => update.run({ $id: id, $workspace: "b".repeat(64), $hash: "0".repeat(64) }));
        }
        assert.throws(() => update.run({ $id: valid, $workspace: valid, $hash: "0".repeat(64) }));
      } finally { database.close(); }
    });
  }
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("independent projection schema", () => {
  it("creates the typed core tables, bounded-query indexes, and one metadata row", () => {
    const root = mkdtempSync(join(tmpdir(), "projection-schema-"));
    roots.push(root);
    const connection = new NodeSqliteDriver({ DatabaseSync }).open(
      join(root, "projections-2-2.sqlite"),
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
        2n,
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
        "session_checkpoints",
        "canonical_items",
        "tasks_followups",
        "artifacts_files",
        "entity_nodes",
        "entity_aliases",
        "entity_edges",
        "lexical_chunks",
        "retrieval_feedback",
        "lexical_chunks_fts",
      ]) assert.equal(names.has(table), true, `missing ${table}`);
      for (const table of [
        "projection_metadata",
        "session_tree",
        "session_checkpoints",
        "canonical_items",
        "tasks_followups",
        "artifacts_files",
        "entity_nodes",
        "entity_aliases",
        "entity_edges",
        "lexical_chunks",
        "retrieval_feedback",
      ]) {
        const definition = objects.find((row) => row.name === table)?.sql;
        assert.match(String(definition), /\bSTRICT\b/u);
      }
      assert.equal(
        connection.prepare("PRAGMA table_info(canonical_items)").all()
          .some((row) => row.name === "session_id" && row.notnull === 0n),
        true,
      );
      assert.equal(PROJECTION_SCHEMA_VERSION, 2);
      assert.deepEqual(PROJECTION_NAMES, [
        "sessionTree",
        "sessionCheckpoints",
        "canonicalItems",
        "tasksFollowups",
        "artifactsFiles",
        "entityGraph",
        "lexicalChunks",
        "retrievalFeedback",
      ]);
      assert.deepEqual(
        connection.prepare("PRAGMA table_info(session_tree)").all().map((row) => row.name),
        [
          "project_id", "session_id", "root_session_id", "parent_session_id",
          "lifecycle_state", "owner_generation", "opened_event_position",
          "closed_event_position", "latest_checkpoint_id", "latest_checkpoint_event_position",
          "source_event_id", "source_event_position", "anchor",
        ],
      );
      assert.deepEqual(
        connection.prepare("PRAGMA table_info(session_checkpoints)").all().map((row) => row.name),
        [
          "project_id", "session_id", "checkpoint_id", "checkpoint_version",
          "base_event_position", "source_event_id", "source_event_position",
          "occurred_at", "task_summary", "anchor",
        ],
      );
      assert.deepEqual(
        connection.prepare("PRAGMA table_info(artifacts_files)").all().map((row) => row.name),
        [
          "project_id", "session_id", "artifact_id", "path", "summary", "action",
          "content_hash", "branch_ref", "confidence", "symbol", "commit_hash", "heading",
          "source_event_id", "source_event_position", "anchor",
        ],
      );
      assert.deepEqual(
        connection.prepare("PRAGMA table_info(entity_aliases)").all().map((row) => row.name),
        [
          "project_id", "alias_id", "entity_id", "normalized_alias", "valid_from", "valid_to",
          "source_event_id", "source_event_position", "anchor",
        ],
      );
      assert.throws(
        () => connection.prepare(`
          INSERT INTO tasks_followups(
            project_id, session_id, follow_up_id, status, summary, confidence,
            source_event_id, source_event_position, anchor
          ) VALUES ($projectId, $sessionId, $followUpId, 'invented', 'x', 'high', $sourceEventId, 1, NULL)
        `).run({
          $projectId: "1".repeat(64),
          $sessionId: "00000000-0000-4000-8000-000000000001",
          $followUpId: "00000000-0000-4000-8000-000000000002",
          $sourceEventId: "00000000-0000-4000-8000-000000000003",
        }),
        /constraint/iu,
      );
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
      2,
      "1".repeat(64),
      17n,
      [{ itemId: "item-1", sourceEventPosition: "17", summary: "Decision" }],
    );
    const reordered = projectionCoreChecksum(
      "canonicalItems",
      2,
      "1".repeat(64),
      17n,
      [{ summary: "Decision", sourceEventPosition: "17", itemId: "item-1" }],
    );
    const otherOrder = projectionCoreChecksum(
      "canonicalItems",
      2,
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
      () => projectionCoreChecksum("invented" as never, 2, "1".repeat(64), 17n, []),
      /PROJECTION_CHECKSUM_INVALID/u,
    );
    const graph = projectionCoreChecksum(
      "entityGraph",
      2,
      "1".repeat(64),
      17n,
      [
        { relation: "node", entity_id: "a", source_event_id: "event-a" },
        { relation: "alias", alias_id: "b", source_event_id: "event-b" },
        { relation: "edge", edge_id: "c", source_event_id: "event-c" },
      ],
    );
    assert.notEqual(graph, projectionCoreChecksum(
      "entityGraph",
      2,
      "1".repeat(64),
      17n,
      [
        { relation: "alias", alias_id: "b", source_event_id: "event-b" },
        { relation: "node", entity_id: "a", source_event_id: "event-a" },
        { relation: "edge", edge_id: "c", source_event_id: "event-c" },
      ],
    ));
  });
});
