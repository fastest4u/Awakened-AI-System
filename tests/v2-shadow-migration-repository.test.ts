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

describe("V2 shadow migration SQLite evidence repository", () => {
  it("creates the exact strict schema, index, foreign-key and immutable-trigger boundary", () => {
    const value = fixture();
    const tables = value.connection.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name GLOB 'v2_shadow_*' ORDER BY name").all();
    assert.deepEqual(tables.map((row) => row.name), [
      "v2_shadow_compatibility_acknowledgements", "v2_shadow_compatibility_claims", "v2_shadow_compatibility_outbox",
      "v2_shadow_expected_difference_rules", "v2_shadow_imported_records", "v2_shadow_migration_attempts",
      "v2_shadow_migration_runs", "v2_shadow_migration_transitions", "v2_shadow_parity_reports",
    ]);
    for (const row of tables) assert.match(String(row.sql), /STRICT, WITHOUT ROWID/);
    const triggers = value.connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name GLOB 'v2_shadow_*' ORDER BY name").all().map((row) => String(row.name));
    for (const table of tables.map((row) => String(row.name))) {
      assert.ok(triggers.includes(`${table}_no_update`)); assert.ok(triggers.includes(`${table}_no_delete`));
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
    for (const table of ["v2_shadow_migration_runs", "v2_shadow_migration_transitions", "v2_shadow_migration_attempts",
      "v2_shadow_imported_records", "v2_shadow_expected_difference_rules", "v2_shadow_parity_reports",
      "v2_shadow_compatibility_outbox", "v2_shadow_compatibility_claims", "v2_shadow_compatibility_acknowledgements"]) {
      assert.throws(() => value.connection.exec(`UPDATE ${table} SET project_id = project_id`));
      assert.throws(() => value.connection.exec(`DELETE FROM ${table}`));
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
    const value=committedFixture(); const tables=["v2_shadow_migration_runs","v2_shadow_migration_transitions","v2_shadow_migration_attempts","v2_shadow_imported_records","v2_shadow_expected_difference_rules","v2_shadow_parity_reports","v2_shadow_compatibility_outbox","v2_shadow_compatibility_claims","v2_shadow_compatibility_acknowledgements"];
    for(const table of tables) assert.throws(()=>value.connection.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`));
    assert.throws(()=>value.connection.prepare(`INSERT INTO v2_shadow_migration_runs SELECT $project,migration_identity,rollout_revision_id,package_checksum,source_manifest_checksum,source_terminal_position,source_terminal_hash,configuration_checksum,policy_checksum,build_identity_hash,created_at FROM v2_shadow_migration_runs`).run({$project:OTHER_PROJECT_ID}));
    assert.throws(()=>value.connection.prepare(`INSERT INTO v2_shadow_imported_records SELECT project_id,migration_identity,1,source_kind,source_record_hash,imported_event_id,imported_global_position,imported_event_hash,recorded_at FROM v2_shadow_imported_records`).run());
    for(const bad of ["A".repeat(64), `${"a".repeat(64)}\0`, "a".repeat(63)]) assert.throws(()=>value.connection.prepare(`INSERT INTO v2_shadow_migration_runs SELECT project_id,$identity,rollout_revision_id,package_checksum,source_manifest_checksum,source_terminal_position,source_terminal_hash,configuration_checksum,policy_checksum,build_identity_hash,created_at FROM v2_shadow_migration_runs`).run({$identity:bad}));
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
