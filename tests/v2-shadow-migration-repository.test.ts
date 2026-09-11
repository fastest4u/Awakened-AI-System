import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { ShadowMigrationError, type ShadowMigrationPhase } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { v2ShadowMigration } from "../src/orchestrator/storage/migrations/0007-v2-shadow-migration.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import {
  SqliteV2ShadowMigrationRepository,
  type CompatibilityAcknowledgement,
  type CompatibilityClaim,
  type CompatibilityOutboxRecord,
  type ImportedRecordReceipt,
  type StoredExpectedDifferenceRule,
  type StoredParityReport,
  type V2ShadowMigrationRun,
  type V2ShadowMigrationTransition,
} from "../src/orchestrator/storage/v2-shadow-migration.repository.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const VAULT_ID = "33333333-3333-4333-8333-333333333333";
const STORE_ID = "44444444-4444-4444-8444-444444444444";
const REVISION_ID = "55555555-5555-4555-8555-555555555555";
const MIGRATION_IDENTITY = "a".repeat(64);
const NOW = "2026-09-11T00:00:00.000Z";
const GENESIS = "0".repeat(64);
const driver = new NodeSqliteDriver({ DatabaseSync });
const roots: string[] = [];
const connections: SqliteConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const hash = (value: unknown): string => createHash("sha256").update(canonicalJson(decimalJson(value)), "utf8").digest("hex");
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function decimalJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(decimalJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decimalJson(entry)]));
}

function transitionHash(input: Omit<V2ShadowMigrationTransition, "transitionHash">): string {
  return createHash("sha256").update(
    `project-memory/v2-shadow-migration-transition/v1\n${canonicalJson(input)}`,
    "utf8",
  ).digest("hex");
}

function fixture(): { connection: SqliteConnection; repository: SqliteV2ShadowMigrationRepository } {
  const root = mkdtempSync(join(tmpdir(), "v2-shadow-ledger-"));
  roots.push(root);
  const connection = driver.open(join(root, "events.sqlite"), { mode: "create", busyTimeoutMs: 1000 });
  connections.push(connection);
  applyCurrentProjectStoreSchema(connection, { projectId: PROJECT_ID, vaultId: VAULT_ID, storeId: STORE_ID }, NOW);
  connection.exec(v2ShadowMigration.sql);
  connection.prepare(`INSERT INTO rollout_revisions(
    project_id, revision_id, parent_revision_id, build_identity_hash, migration_identity_hash,
    configuration_checksum, v1_baseline_checksum, cohort_algorithm_version, cohort_salt,
    cohort_basis_points, created_at
  ) VALUES ($projectId, $revisionId, NULL, $hash, $hash, $hash, $hash, 1, $hash, 0, $now)`).run({
    $projectId: PROJECT_ID, $revisionId: REVISION_ID, $hash: "b".repeat(64), $now: NOW,
  });
  return { connection, repository: new SqliteV2ShadowMigrationRepository(connection) };
}

function run(): V2ShadowMigrationRun {
  return Object.freeze({ projectId: PROJECT_ID, migrationIdentity: MIGRATION_IDENTITY, rolloutRevisionId: REVISION_ID,
    packageChecksum: "c".repeat(64), sourceManifestChecksum: "d".repeat(64), sourceTerminalPosition: 2n,
    sourceTerminalHash: "e".repeat(64), configurationChecksum: "f".repeat(64), policyChecksum: "1".repeat(64),
    buildIdentityHash: "2".repeat(64), createdAt: NOW });
}

function transition(ordinal: number, phase: ShadowMigrationPhase, priorTransitionHash: string): V2ShadowMigrationTransition {
  const input = { projectId: PROJECT_ID, migrationIdentity: MIGRATION_IDENTITY, ordinal,
    attemptId: `00000000-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`,
    phase, priorTransitionHash, evidenceDigest: digest(`evidence-${ordinal}`),
    recordedAt: `2026-09-11T00:00:0${ordinal}.000Z` };
  return Object.freeze({ ...input, transitionHash: transitionHash(input) });
}

function receipt(): ImportedRecordReceipt {
  return Object.freeze({ projectId: PROJECT_ID, migrationIdentity: MIGRATION_IDENTITY, sourceOrdinal: 0,
    sourceKind: "source-event", sourceRecordHash: "3".repeat(64), importedEventId: "00000000-0000-4000-8000-000000000010",
    importedGlobalPosition: 10n, importedEventHash: "4".repeat(64), recordedAt: NOW });
}

function rule(): StoredExpectedDifferenceRule {
  const selector = Object.freeze({ rowIdentityHash: "5".repeat(64), fieldPath: "summary" });
  const predicate = Object.freeze({ operator: "exact-value-hashes" as const, v1ValueHash: "6".repeat(64), v2ValueHash: "7".repeat(64) });
  return Object.freeze({ projectId: PROJECT_ID, migrationIdentity: MIGRATION_IDENTITY, ruleId: "rule-1", policyVersion: 1,
    category: "semantic-value", projectionName: "canonicalItems", selector, predicate, rationaleDigest: "8".repeat(64),
    approverFingerprint: "9".repeat(64), approvalReferenceDigest: "a".repeat(64), issuedAt: NOW,
    expiresAt: "2026-09-12T00:00:00.000Z", rolloutRevisionId: REVISION_ID,
    ruleChecksum: hash({ selector, predicate }) });
}

function report(): StoredParityReport {
  const value = Object.freeze({ schemaVersion: 1, findings: [] });
  return Object.freeze({ projectId: PROJECT_ID, migrationIdentity: MIGRATION_IDENTITY, reportId: "report-1", packageChecksum: "c".repeat(64),
    comparedEventPosition: 2n, comparedEventHash: "e".repeat(64), v1ManifestChecksum: "d".repeat(64),
    v2ManifestChecksum: "b".repeat(64), v1CoreChecksumsDigest: "c".repeat(64), v2CoreChecksumsDigest: "d".repeat(64),
    retrievalVectorChecksum: "e".repeat(64), equalCount: 1, expectedDifferenceCount: 0, blockingDivergenceCount: 0,
    report: value, reportChecksum: hash(value), recordedAt: NOW });
}

function outbox(): CompatibilityOutboxRecord {
  return Object.freeze({ projectId: PROJECT_ID, migrationIdentity: MIGRATION_IDENTITY,
    outboxId: "00000000-0000-4000-8000-000000000020", sourceOrdinal: 0,
    importedEventId: receipt().importedEventId, importedGlobalPosition: 10n, importedEventHash: "4".repeat(64),
    triggeringPayloadHash: "b".repeat(64), relativePath: "legacy/one.md", byteLength: 3,
    contentSha256: "c".repeat(64), materializationRevision: 1n, recordedAt: NOW });
}

function claim(): CompatibilityClaim {
  return Object.freeze({ projectId: PROJECT_ID, migrationIdentity: MIGRATION_IDENTITY, outboxId: outbox().outboxId,
    claimId: "00000000-0000-4000-8000-000000000021", claimOwnerFingerprint: "d".repeat(64), claimedAt: NOW });
}

function acknowledgement(): CompatibilityAcknowledgement {
  const input = { projectId: PROJECT_ID, migrationIdentity: MIGRATION_IDENTITY, outboxId: outbox().outboxId,
    acknowledgementId: "00000000-0000-4000-8000-000000000022", claimId: claim().claimId,
    acknowledgedImportedPosition: 10n, materializationRevision: 1n, targetContentSha256: "c".repeat(64), acknowledgedAt: NOW };
  return Object.freeze({ ...input, acknowledgementChecksum: hash(input) });
}

function committedFixture(): ReturnType<typeof fixture> {
  const value = fixture();
  value.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => {
    tx.insertRun(run());
    tx.appendTransition(transition(0, "snapshot-verified", GENESIS));
    tx.appendAttemptEvidence({ projectId: PROJECT_ID, migrationIdentity: MIGRATION_IDENTITY, attemptOrdinal: 0,
      attemptId: "00000000-0000-4000-8000-000000000030", phase: "snapshot-verified", operation: "verify",
      operationAttemptIndex: 0, outcomeCategory: "retryable-failure", safeErrorCode: "SQLITE_BUSY", priorCommittedPhase: null,
      evidenceDigest: "f".repeat(64), recordedAt: NOW });
    tx.insertImportedRecords([receipt()]); tx.insertExpectedDifferenceRules([rule()]); tx.insertParityReport(report());
    tx.enqueueCompatibility([outbox()]); tx.claimCompatibility(claim()); tx.acknowledgeCompatibility(acknowledgement());
  });
  return value;
}

const EVIDENCE_TABLES = [
  "v2_shadow_migration_runs",
  "v2_shadow_migration_transitions",
  "v2_shadow_migration_attempts",
  "v2_shadow_imported_records",
  "v2_shadow_expected_difference_rules",
  "v2_shadow_parity_reports",
  "v2_shadow_compatibility_outbox",
  "v2_shadow_compatibility_claims",
  "v2_shadow_compatibility_acknowledgements",
] as const;
type EvidenceTable = typeof EVIDENCE_TABLES[number];
type DeclaredType = "TEXT" | "INTEGER";
type ColumnSpec = readonly [name: string, type: DeclaredType, notNull: 0 | 1, primaryKeyOrdinal: number];

const TABLE_COLUMNS: Readonly<Record<EvidenceTable, readonly ColumnSpec[]>> = {
  v2_shadow_migration_runs: [
    ["project_id", "TEXT", 1, 1], ["migration_identity", "TEXT", 1, 2], ["rollout_revision_id", "TEXT", 1, 0],
    ["package_checksum", "TEXT", 1, 0], ["source_manifest_checksum", "TEXT", 1, 0], ["source_terminal_position", "INTEGER", 1, 0],
    ["source_terminal_hash", "TEXT", 1, 0], ["configuration_checksum", "TEXT", 1, 0], ["policy_checksum", "TEXT", 1, 0],
    ["build_identity_hash", "TEXT", 1, 0], ["created_at", "TEXT", 1, 0],
  ],
  v2_shadow_migration_transitions: [
    ["project_id", "TEXT", 1, 1], ["migration_identity", "TEXT", 1, 2], ["ordinal", "INTEGER", 1, 3],
    ["attempt_id", "TEXT", 1, 0], ["phase", "TEXT", 1, 0], ["prior_transition_hash", "TEXT", 1, 0],
    ["transition_hash", "TEXT", 1, 0], ["evidence_digest", "TEXT", 1, 0], ["recorded_at", "TEXT", 1, 0],
  ],
  v2_shadow_migration_attempts: [
    ["project_id", "TEXT", 1, 1], ["migration_identity", "TEXT", 1, 2], ["attempt_ordinal", "INTEGER", 1, 3],
    ["attempt_id", "TEXT", 1, 0], ["phase", "TEXT", 1, 0], ["operation", "TEXT", 1, 0],
    ["operation_attempt_index", "INTEGER", 1, 0], ["outcome_category", "TEXT", 1, 0], ["safe_error_code", "TEXT", 1, 0],
    ["prior_committed_phase", "TEXT", 0, 0], ["evidence_digest", "TEXT", 1, 0], ["recorded_at", "TEXT", 1, 0],
  ],
  v2_shadow_imported_records: [
    ["project_id", "TEXT", 1, 1], ["migration_identity", "TEXT", 1, 2], ["source_ordinal", "INTEGER", 1, 3],
    ["source_kind", "TEXT", 1, 0], ["source_record_hash", "TEXT", 1, 0], ["imported_event_id", "TEXT", 1, 0],
    ["imported_global_position", "INTEGER", 1, 0], ["imported_event_hash", "TEXT", 1, 0], ["recorded_at", "TEXT", 1, 0],
  ],
  v2_shadow_expected_difference_rules: [
    ["project_id", "TEXT", 1, 1], ["migration_identity", "TEXT", 1, 2], ["rule_id", "TEXT", 1, 3],
    ["policy_version", "INTEGER", 1, 0], ["category", "TEXT", 1, 0], ["projection_name", "TEXT", 1, 0],
    ["selector_json", "TEXT", 1, 0], ["predicate_json", "TEXT", 1, 0], ["rationale_digest", "TEXT", 1, 0],
    ["approver_fingerprint", "TEXT", 1, 0], ["approval_reference_digest", "TEXT", 1, 0], ["issued_at", "TEXT", 1, 0],
    ["expires_at", "TEXT", 1, 0], ["rollout_revision_id", "TEXT", 1, 0], ["rule_checksum", "TEXT", 1, 0],
  ],
  v2_shadow_parity_reports: [
    ["project_id", "TEXT", 1, 1], ["migration_identity", "TEXT", 1, 2], ["report_id", "TEXT", 1, 3],
    ["package_checksum", "TEXT", 1, 0], ["compared_event_position", "INTEGER", 1, 0], ["compared_event_hash", "TEXT", 1, 0],
    ["v1_manifest_checksum", "TEXT", 1, 0], ["v2_manifest_checksum", "TEXT", 1, 0], ["v1_core_checksums_digest", "TEXT", 1, 0],
    ["v2_core_checksums_digest", "TEXT", 1, 0], ["retrieval_vector_checksum", "TEXT", 1, 0], ["equal_count", "INTEGER", 1, 0],
    ["expected_difference_count", "INTEGER", 1, 0], ["blocking_divergence_count", "INTEGER", 1, 0], ["report_json", "TEXT", 1, 0],
    ["report_checksum", "TEXT", 1, 0], ["recorded_at", "TEXT", 1, 0],
  ],
  v2_shadow_compatibility_outbox: [
    ["project_id", "TEXT", 1, 1], ["migration_identity", "TEXT", 1, 2], ["outbox_id", "TEXT", 1, 3],
    ["source_ordinal", "INTEGER", 1, 0], ["imported_event_id", "TEXT", 1, 0], ["imported_global_position", "INTEGER", 1, 0],
    ["imported_event_hash", "TEXT", 1, 0], ["triggering_payload_hash", "TEXT", 1, 0], ["relative_path", "TEXT", 1, 0],
    ["byte_length", "INTEGER", 1, 0], ["content_sha256", "TEXT", 1, 0], ["materialization_revision", "INTEGER", 1, 0],
    ["recorded_at", "TEXT", 1, 0],
  ],
  v2_shadow_compatibility_claims: [
    ["project_id", "TEXT", 1, 1], ["migration_identity", "TEXT", 1, 2], ["outbox_id", "TEXT", 1, 3],
    ["claim_id", "TEXT", 1, 0], ["claim_owner_fingerprint", "TEXT", 1, 0], ["claimed_at", "TEXT", 1, 0],
  ],
  v2_shadow_compatibility_acknowledgements: [
    ["project_id", "TEXT", 1, 1], ["migration_identity", "TEXT", 1, 2], ["outbox_id", "TEXT", 1, 3],
    ["acknowledgement_id", "TEXT", 1, 0], ["claim_id", "TEXT", 1, 0], ["acknowledged_imported_position", "INTEGER", 1, 0],
    ["materialization_revision", "INTEGER", 1, 0], ["target_content_sha256", "TEXT", 1, 0], ["acknowledgement_checksum", "TEXT", 1, 0],
    ["acknowledged_at", "TEXT", 1, 0],
  ],
};

const TABLE_INDEXES: Readonly<Record<EvidenceTable, readonly string[]>> = {
  v2_shadow_migration_runs: ["pk:project_id,migration_identity"],
  v2_shadow_migration_transitions: [
    "pk:project_id,migration_identity,ordinal", "u:project_id,migration_identity,phase", "u:project_id,migration_identity,transition_hash",
  ],
  v2_shadow_migration_attempts: ["pk:project_id,migration_identity,attempt_ordinal", "u:project_id,migration_identity,attempt_id"],
  v2_shadow_imported_records: [
    "pk:project_id,migration_identity,source_ordinal", "u:project_id,imported_event_id", "u:project_id,imported_global_position",
  ],
  v2_shadow_expected_difference_rules: ["pk:project_id,migration_identity,rule_id", "u:project_id,migration_identity,rule_checksum"],
  v2_shadow_parity_reports: ["pk:project_id,migration_identity,report_id", "u:project_id,migration_identity,report_checksum"],
  v2_shadow_compatibility_outbox: ["pk:project_id,migration_identity,outbox_id", "u:project_id,migration_identity,source_ordinal"],
  v2_shadow_compatibility_claims: ["pk:project_id,migration_identity,outbox_id", "u:project_id,migration_identity,claim_id"],
  v2_shadow_compatibility_acknowledgements: ["pk:project_id,migration_identity,outbox_id", "u:project_id,migration_identity,acknowledgement_id"],
};

const TABLE_FOREIGN_KEYS: Readonly<Record<EvidenceTable, readonly (readonly string[])[]>> = {
  v2_shadow_migration_runs: [["project_id->rollout_revisions.project_id|NO ACTION|NO ACTION|NONE", "rollout_revision_id->rollout_revisions.revision_id|NO ACTION|NO ACTION|NONE"]],
  v2_shadow_migration_transitions: [["project_id->v2_shadow_migration_runs.project_id|NO ACTION|NO ACTION|NONE", "migration_identity->v2_shadow_migration_runs.migration_identity|NO ACTION|NO ACTION|NONE"]],
  v2_shadow_migration_attempts: [["project_id->v2_shadow_migration_runs.project_id|NO ACTION|NO ACTION|NONE", "migration_identity->v2_shadow_migration_runs.migration_identity|NO ACTION|NO ACTION|NONE"]],
  v2_shadow_imported_records: [["project_id->v2_shadow_migration_runs.project_id|NO ACTION|NO ACTION|NONE", "migration_identity->v2_shadow_migration_runs.migration_identity|NO ACTION|NO ACTION|NONE"]],
  v2_shadow_expected_difference_rules: [
    ["project_id->rollout_revisions.project_id|NO ACTION|NO ACTION|NONE", "rollout_revision_id->rollout_revisions.revision_id|NO ACTION|NO ACTION|NONE"],
    ["project_id->v2_shadow_migration_runs.project_id|NO ACTION|NO ACTION|NONE", "migration_identity->v2_shadow_migration_runs.migration_identity|NO ACTION|NO ACTION|NONE"],
  ],
  v2_shadow_parity_reports: [["project_id->v2_shadow_migration_runs.project_id|NO ACTION|NO ACTION|NONE", "migration_identity->v2_shadow_migration_runs.migration_identity|NO ACTION|NO ACTION|NONE"]],
  v2_shadow_compatibility_outbox: [
    ["project_id->v2_shadow_imported_records.project_id|NO ACTION|NO ACTION|NONE", "migration_identity->v2_shadow_imported_records.migration_identity|NO ACTION|NO ACTION|NONE", "source_ordinal->v2_shadow_imported_records.source_ordinal|NO ACTION|NO ACTION|NONE"],
  ],
  v2_shadow_compatibility_claims: [
    ["project_id->v2_shadow_compatibility_outbox.project_id|NO ACTION|NO ACTION|NONE", "migration_identity->v2_shadow_compatibility_outbox.migration_identity|NO ACTION|NO ACTION|NONE", "outbox_id->v2_shadow_compatibility_outbox.outbox_id|NO ACTION|NO ACTION|NONE"],
  ],
  v2_shadow_compatibility_acknowledgements: [
    ["project_id->v2_shadow_compatibility_claims.project_id|NO ACTION|NO ACTION|NONE", "migration_identity->v2_shadow_compatibility_claims.migration_identity|NO ACTION|NO ACTION|NONE", "outbox_id->v2_shadow_compatibility_claims.outbox_id|NO ACTION|NO ACTION|NONE"],
  ],
};

const MALFORMED_HASH_VALUES = [
  "A".repeat(64),
  `${"a".repeat(64)}\0`,
  `${"a".repeat(32)}\0${"a".repeat(32)}`,
  "a".repeat(63),
  "a".repeat(65),
] as const;
const HASH_COLUMN = /(?:_hash|_checksum|_digest|_fingerprint|_sha256)$/;

function hashColumns(table: EvidenceTable): readonly string[] {
  return TABLE_COLUMNS[table].map(([name]) => name).filter((name) => HASH_COLUMN.test(name) || (table === "v2_shadow_migration_runs" && name === "migration_identity"));
}

function assertErrorMessage(action: () => unknown, pattern: RegExp, label: string): void {
  assert.throws(action, (error: unknown) => error instanceof Error && pattern.test(error.message), label);
}

function triggerNamesFor(table: EvidenceTable): readonly string[] {
  const names = [`${table}_no_replace`, `${table}_no_update`, `${table}_no_delete`];
  if (table === "v2_shadow_migration_transitions" || table === "v2_shadow_migration_attempts") names.push(`${table}_sequence`);
  return names.sort();
}

describe("V2 shadow migration SQLite evidence repository", () => {
  it("creates the exact strict schema, index, foreign-key and immutable-trigger boundary", () => {
    const value = fixture();
    const tables = value.connection.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name GLOB 'v2_shadow_*' ORDER BY name").all();
    assert.deepEqual(tables.map((row) => String(row.name)).sort(), [...EVIDENCE_TABLES].sort());
    for (const table of EVIDENCE_TABLES) {
      const info = value.connection.prepare(`PRAGMA table_info(${table})`).all();
      assert.deepEqual(
        info.map((row) => [String(row.name), String(row.type), Number(row.notnull), Number(row.pk)]),
        TABLE_COLUMNS[table],
        `${table} exact ordered columns/types`,
      );
      const sql = String(value.connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = $name").get({ $name: table })?.sql);
      assert.match(sql, /STRICT, WITHOUT ROWID/);
      const indexes = value.connection.prepare(`PRAGMA index_list(${table})`).all();
      const observedIndexes = indexes.map((index) => {
        const columns = value.connection.prepare(`PRAGMA index_info(${String(index.name)})`).all()
          .sort((left, right) => Number(left.seqno) - Number(right.seqno))
          .map((column) => String(column.name)).join(",");
        return `${String(index.origin)}:${columns}`;
      }).sort();
      assert.deepEqual(observedIndexes, [...TABLE_INDEXES[table]].sort(), `${table} exact PK/UNIQUE index columns`);
      const foreignKeyGroups = new Map<string, Array<{ seq: number; definition: string }>>();
      for (const foreignKey of value.connection.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
        const id = String(foreignKey.id);
        const definitions = foreignKeyGroups.get(id) ?? [];
        definitions.push({
          seq: Number(foreignKey.seq),
          definition: `${String(foreignKey.from)}->${String(foreignKey.table)}.${String(foreignKey.to)}|${String(foreignKey.on_update)}|${String(foreignKey.on_delete)}|${String(foreignKey.match)}`,
        });
        foreignKeyGroups.set(id, definitions);
      }
      const foreignKeys = [...foreignKeyGroups.values()]
        .map((definitions) => definitions.sort((left, right) => left.seq - right.seq).map(({ definition }) => definition).join(","))
        .sort();
      const expectedForeignKeys = TABLE_FOREIGN_KEYS[table].map((definitions) => definitions.join(",")).sort();
      assert.deepEqual(foreignKeys, expectedForeignKeys, `${table} exact foreign-key definitions`);
      const triggers = value.connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = $table ORDER BY name").all({ $table: table }).map((row) => String(row.name)).sort();
      assert.deepEqual(triggers, [...triggerNamesFor(table)], `${table} exact trigger set`);
    }
  });

  it("accepts only the exact hash-chained phase sequence and returns frozen verified data", () => {
    const value = fixture();
    value.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => {
      tx.insertRun(run()); tx.appendTransition(transition(0, "snapshot-verified", GENESIS));
      assert.throws(() => tx.appendTransition(transition(2, "import-committed", "f".repeat(64))), ledgerFailure);
      tx.appendTransition(transition(1, "package-sealed", transition(0, "snapshot-verified", GENESIS).transitionHash));
    });
    const transitions = value.repository.readVerifiedTransitions(PROJECT_ID, MIGRATION_IDENTITY);
    assert.deepEqual(transitions.map((row) => row.phase), ["snapshot-verified", "package-sealed"]);
    assert.equal(Object.isFrozen(transitions), true); assert.equal(Object.isFrozen(transitions[0]!), true);
  });

  it("fails closed when a committed transition hash is tampered", () => {
    const value = committedFixture();
    value.connection.exec("DROP TRIGGER v2_shadow_migration_transitions_no_update");
    value.connection.prepare("UPDATE v2_shadow_migration_transitions SET transition_hash = $hash").run({ $hash: "0".repeat(64) });
    assert.throws(() => value.repository.readVerifiedTransitions(PROJECT_ID, MIGRATION_IDENTITY), ledgerFailure);
  });

  it("rejects cross-project runs, duplicate immutable identities, and conflicting imported receipts", () => {
    const value = committedFixture();
    assert.throws(() => value.repository.transact(OTHER_PROJECT_ID, MIGRATION_IDENTITY, (tx) => tx.insertRun(run())), ledgerFailure);
    assert.throws(() => value.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => tx.insertRun({ ...run(), packageChecksum: "0".repeat(64) })), ledgerFailure);
    assert.throws(() => value.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => tx.insertImportedRecords([
      { ...receipt(), sourceRecordHash: "0".repeat(64) },
    ])), ledgerFailure);
  });

  it("makes every semantic evidence table append-only", () => {
    const value = committedFixture();
    for (const table of EVIDENCE_TABLES) {
      assertErrorMessage(() => value.connection.exec(`UPDATE ${table} SET project_id = project_id`), /V2_SHADOW_IMMUTABLE/, `${table} permits UPDATE`);
      assertErrorMessage(() => value.connection.exec(`DELETE FROM ${table}`), /V2_SHADOW_IMMUTABLE/, `${table} permits DELETE`);
    }
  });

  it("rejects nested or asynchronous callbacks, rolls back callbacks, and poisons after rollback failure", () => {
    const value = fixture();
    assert.throws(() => value.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => {
      assert.throws(() => value.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, () => undefined), ledgerFailure);
      tx.insertRun(run()); throw new Error("rollback");
    }), /rollback/);
    assert.equal(value.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => tx.readRun()), null);
    assert.throws(() => value.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, () => Promise.resolve()), ledgerFailure);
  });

  it("rejects rooted compatibility paths and requires independently contiguous attempts", () => {
    const value = fixture();
    value.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => {
      tx.insertRun(run()); tx.insertImportedRecords([receipt()]);
      assert.throws(() => tx.appendAttemptEvidence({ ...attempt(7), attemptOrdinal: 7 }), ledgerFailure);
      tx.appendAttemptEvidence(attempt(0));
      assert.throws(() => tx.appendAttemptEvidence(attempt(2)), ledgerFailure);
    });
    for (const relativePath of ["/unix-root", "C:/windows-root", "\\\\server\\share"]) {
      assert.throws(() => value.connection.prepare(`INSERT INTO v2_shadow_compatibility_outbox(
        project_id,migration_identity,outbox_id,source_ordinal,imported_event_id,imported_global_position,imported_event_hash,triggering_payload_hash,relative_path,byte_length,content_sha256,materialization_revision,recorded_at
      ) VALUES ($p,$m,$id,0,$event,10,$hash,$hash,$path,1,$hash,1,$at)`).run({
        $p: PROJECT_ID, $m: MIGRATION_IDENTITY, $id: "00000000-0000-4000-8000-000000000040", $event: receipt().importedEventId,
        $hash: "b".repeat(64), $path: relativePath, $at: NOW,
      }));
    }
  });

  it("idempotently replays exact evidence, preserves busy errors, and deep-freezes JSON", () => {
    const value = committedFixture();
    value.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => {
      tx.insertRun(run()); tx.appendTransition(transition(0, "snapshot-verified", GENESIS)); tx.appendAttemptEvidence(attempt(0));
      tx.insertImportedRecords([receipt()]); tx.insertExpectedDifferenceRules([rule()]); tx.insertParityReport(report());
      tx.enqueueCompatibility([outbox()]); tx.claimCompatibility(claim()); tx.acknowledgeCompatibility(acknowledgement());
      const stored = tx.readParityReport()!; assert.equal(Object.isFrozen(stored.report.findings), true);
    });
    const busy = new Error("SQLITE_BUSY: database is locked");
    const repository = new SqliteV2ShadowMigrationRepository({ exec: value.connection.exec.bind(value.connection), prepare: () => { throw busy; }, close: value.connection.close.bind(value.connection) });
    assert.throws(() => repository.readVerifiedTransitions(PROJECT_ID, MIGRATION_IDENTITY), (error: unknown) => error === busy);
  });

  it("preserves callback failures, quarantines rollback-failed connections, and rejects custom thenables", () => {
    const value = fixture();
    const callbackFailure = new Error("callback failure");
    const wrapped: SqliteConnection = { exec(sql) { if (sql === "ROLLBACK") throw new Error("rollback failure"); value.connection.exec(sql); }, prepare: value.connection.prepare.bind(value.connection), close: value.connection.close.bind(value.connection) };
    const poisoned = new SqliteV2ShadowMigrationRepository(wrapped);
    assert.throws(() => poisoned.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => { tx.insertRun(run()); throw callbackFailure; }), (error: unknown) => error === callbackFailure);
    assert.throws(() => poisoned.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => tx.readRun()), ledgerFailure);
    const clean = fixture();
    assert.throws(() => clean.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => { tx.insertRun(run()); return Object.freeze({ then() {} }); }), ledgerFailure);
    assert.equal(clean.repository.transact(PROJECT_ID, MIGRATION_IDENTITY, (tx) => tx.readRun()), null);
  });

  it("exposes exact strict metadata, keys, foreign keys, and all immutable insert guards", () => {
    const value = fixture();
    const expected: Readonly<Record<string, readonly string[]>> = {
      v2_shadow_migration_runs:["project_id","migration_identity","rollout_revision_id","package_checksum","source_manifest_checksum","source_terminal_position","source_terminal_hash","configuration_checksum","policy_checksum","build_identity_hash","created_at"],
      v2_shadow_migration_transitions:["project_id","migration_identity","ordinal","attempt_id","phase","prior_transition_hash","transition_hash","evidence_digest","recorded_at"],
      v2_shadow_migration_attempts:["project_id","migration_identity","attempt_ordinal","attempt_id","phase","operation","operation_attempt_index","outcome_category","safe_error_code","prior_committed_phase","evidence_digest","recorded_at"],
      v2_shadow_imported_records:["project_id","migration_identity","source_ordinal","source_kind","source_record_hash","imported_event_id","imported_global_position","imported_event_hash","recorded_at"],
      v2_shadow_expected_difference_rules:["project_id","migration_identity","rule_id","policy_version","category","projection_name","selector_json","predicate_json","rationale_digest","approver_fingerprint","approval_reference_digest","issued_at","expires_at","rollout_revision_id","rule_checksum"],
      v2_shadow_parity_reports:["project_id","migration_identity","report_id","package_checksum","compared_event_position","compared_event_hash","v1_manifest_checksum","v2_manifest_checksum","v1_core_checksums_digest","v2_core_checksums_digest","retrieval_vector_checksum","equal_count","expected_difference_count","blocking_divergence_count","report_json","report_checksum","recorded_at"],
      v2_shadow_compatibility_outbox:["project_id","migration_identity","outbox_id","source_ordinal","imported_event_id","imported_global_position","imported_event_hash","triggering_payload_hash","relative_path","byte_length","content_sha256","materialization_revision","recorded_at"],
      v2_shadow_compatibility_claims:["project_id","migration_identity","outbox_id","claim_id","claim_owner_fingerprint","claimed_at"],
      v2_shadow_compatibility_acknowledgements:["project_id","migration_identity","outbox_id","acknowledgement_id","claim_id","acknowledged_imported_position","materialization_revision","target_content_sha256","acknowledgement_checksum","acknowledged_at"],
    };
    for (const [table, columns] of Object.entries(expected)) {
      const info=value.connection.prepare(`PRAGMA table_info(${table})`).all(); assert.deepEqual(info.map((row)=>row.name),columns);
      assert.ok(info.every((row)=>row.type === "TEXT" || row.type === "INTEGER"));
      const sql=String(value.connection.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=$name").get({$name:table})?.sql);
      assert.match(sql,/STRICT, WITHOUT ROWID/); assert.ok(value.connection.prepare(`PRAGMA index_list(${table})`).all().some((row)=>row.unique===1n));
      for(const suffix of ["no_replace","no_update","no_delete"]) assert.ok(value.connection.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=$name").get({$name:`${table}_${suffix}`}));
    }
  });

  it("enforces raw hash, foreign-key, unique, and replace boundaries for every evidence table", () => {
    const value = committedFixture();
    for (const table of EVIDENCE_TABLES) {
      assertErrorMessage(
        () => value.connection.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`),
        /V2_SHADOW_IMMUTABLE/,
        `${table} permits INSERT OR REPLACE`,
      );
    }
    assertErrorMessage(
      () => value.connection.prepare(`INSERT INTO v2_shadow_migration_runs SELECT $project,migration_identity,rollout_revision_id,package_checksum,source_manifest_checksum,source_terminal_position,source_terminal_hash,configuration_checksum,policy_checksum,build_identity_hash,created_at FROM v2_shadow_migration_runs`).run({ $project: OTHER_PROJECT_ID }),
      /FOREIGN KEY constraint failed/,
      "runs permits a cross-project revision",
    );
    assertErrorMessage(
      () => value.connection.prepare(`INSERT INTO v2_shadow_imported_records SELECT project_id,migration_identity,1,source_kind,source_record_hash,imported_event_id,imported_global_position,imported_event_hash,recorded_at FROM v2_shadow_imported_records`).run(),
      /V2_SHADOW_IMMUTABLE/,
      "imported records permit a non-primary replacement",
    );
    const uniqueValue = committedFixture();
    uniqueValue.connection.exec("DROP TRIGGER v2_shadow_imported_records_no_replace");
    assertErrorMessage(
      () => uniqueValue.connection.prepare(`INSERT INTO v2_shadow_imported_records SELECT project_id,migration_identity,1,source_kind,source_record_hash,imported_event_id,imported_global_position,imported_event_hash,recorded_at FROM v2_shadow_imported_records`).run(),
      /UNIQUE constraint failed/,
      "imported records retain non-primary unique indexes",
    );
  });

  it("parameterizes every hash guard with independent CHECK failures", () => {
    const value = committedFixture();
    value.connection.exec("PRAGMA foreign_keys = OFF");
    for (const table of EVIDENCE_TABLES) {
      const columns = TABLE_COLUMNS[table].map(([name]) => name);
      const sql = String(value.connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = $name").get({ $name: table })?.sql)
        .replace(/\s+/g, " ");
      value.connection.exec(`DROP TRIGGER ${table}_no_update`);
      for (const column of hashColumns(table)) {
        assert.ok(sql.includes(`length(${column}) = 64 AND length(CAST(${column} AS BLOB)) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`), `${table}.${column} lacks byte-exact lowercase guard`);
        for (const bad of MALFORMED_HASH_VALUES) {
          assertErrorMessage(
            () => value.connection.prepare(`UPDATE ${table} SET ${column} = $bad`).run({ $bad: bad }),
            /CHECK constraint failed/,
            `${table}.${column} accepts malformed hash ${JSON.stringify(bad)}`,
          );
        }
      }
    }
  });

  it("rejects raw cross-project and wrong-migration-identity relationships for every child", () => {
    const value = committedFixture();
    for (const table of EVIDENCE_TABLES) {
      const columns = TABLE_COLUMNS[table].map(([name]) => name);
      const projectVariant = columns.map((column) => column === "project_id" ? "$otherProject" : column).join(",");
      assertErrorMessage(
        () => value.connection.prepare(`INSERT INTO ${table} (${columns.join(",")}) SELECT ${projectVariant} FROM ${table}`).run({ $otherProject: OTHER_PROJECT_ID }),
        /FOREIGN KEY constraint failed/,
        `${table} accepts a cross-project child row`,
      );
      assert.equal(Number(value.connection.prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id = $project`).get({ $project: OTHER_PROJECT_ID })?.count), 0);
      if (table !== "v2_shadow_migration_runs") {
        const migrationVariant = columns.map((column) => {
          if (column === "migration_identity") return "$otherMigration";
          if (table === "v2_shadow_imported_records" && column === "imported_event_id") return "$otherEvent";
          if (table === "v2_shadow_imported_records" && column === "imported_global_position") return "$otherPosition";
          return column;
        }).join(",");
        assertErrorMessage(
          () => value.connection.prepare(`INSERT INTO ${table} (${columns.join(",")}) SELECT ${migrationVariant} FROM ${table}`).run(
            table === "v2_shadow_imported_records"
              ? { $otherMigration: "b".repeat(64), $otherEvent: "00000000-0000-4000-8000-000000000011", $otherPosition: 11n }
              : { $otherMigration: "b".repeat(64) },
          ),
          /FOREIGN KEY constraint failed/,
          `${table} accepts an unparented migration identity`,
        );
        assert.equal(Number(value.connection.prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id = $project AND migration_identity = $migration`).get({ $project: PROJECT_ID, $migration: "b".repeat(64) })?.count), 0);
      }
    }
  });
});

function attempt(attemptOrdinal: number) {
  return { projectId: PROJECT_ID, migrationIdentity: MIGRATION_IDENTITY, attemptOrdinal,
    attemptId: `00000000-0000-4000-8000-${String(30 + attemptOrdinal).padStart(12, "0")}`, phase: "snapshot-verified" as const,
    operation: "verify", operationAttemptIndex: 0, outcomeCategory: "retryable-failure" as const,
    safeErrorCode: "SQLITE_BUSY", priorCommittedPhase: null, evidenceDigest: "f".repeat(64), recordedAt: NOW };
}

function ledgerFailure(error: unknown): boolean {
  return error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE";
}
