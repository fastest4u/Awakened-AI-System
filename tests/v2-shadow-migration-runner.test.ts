import assert from "node:assert/strict";
import { readFileSync, readdirSync, appendFileSync, existsSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { DefaultProjectionBuildCoordinator } from "../src/orchestrator/projections/coordinator.js";
import { SqliteProjectionEventReader } from "../src/orchestrator/projections/event-reader.js";
import type { SqliteDriver } from "../src/orchestrator/storage/sqlite-driver.js";
import { randomUUID } from "node:crypto";
import { EventStore, EventStoreError, MAX_EVENTS_PER_COMMAND, SqliteEventStoreStatements } from "../src/orchestrator/storage/event-store.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { deterministicMigrationUuid } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { parseSealedRetrievalEvaluationBundle, type SealedRetrievalEvaluationCorpusV2 } from "../src/orchestrator/retrieval/evaluation.js";
import { V2ShadowCompatibilityMaterializer } from "../src/orchestrator/materialization/v2-shadow-compatibility.materializer.js";
import type { ShadowMigrationInvocationDeadline } from "../src/orchestrator/migration/v2-shadow-migration-runtime.js";
import { RolloutControlPlane } from "../src/orchestrator/rollout/rollout-control-plane.js";
import { SqliteRolloutControlPlaneRepository } from "../src/orchestrator/storage/rollout-control-plane.repository.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { InternalRetrievalService } from "../src/orchestrator/retrieval/service.js";

import { createRunnerV1CallerControl, createShadowMigrationRunnerFixture, createSnapshotParityFixture, createV2ShadowMigrationFixture, digest } from "./support/v2-shadow-migration-fixture.js";
import { LifecycleV2DisabledAdapter } from "../src/orchestrator/compatibility/lifecycle-v2-disabled.adapter.js";
import { verifyV1SourceCopy } from "../src/orchestrator/migration/v1-source-copy.js";
import { sealV2MigrationPackage } from "../src/orchestrator/migration/v2-migration-package.js";
import { createShadowMigrationInvocationDeadline } from "../src/orchestrator/migration/v2-shadow-migration-runtime.js";
import { ShadowMigrationError } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { V2ShadowMigrationRunner, V2ShadowMigrationPreflightFailure, readV2ShadowMigrationPreflightEvidence, SHADOW_MIGRATION_FAULT_BOUNDARIES } from "../src/orchestrator/migration/v2-shadow-migration-runner.js";
import { SqliteV2ShadowMigrationRepository } from "../src/orchestrator/storage/v2-shadow-migration.repository.js";
import { V2ShadowProjectionPublisher } from "../src/orchestrator/migration/v2-shadow-projection.js";
import { compareV1V2Snapshots } from "../src/orchestrator/parity/v2-snapshot-parity.js";
import { V2ShadowImporter } from "../src/orchestrator/migration/v2-shadow-importer.js";
import { expectedDifferenceRuleChecksum } from "../src/orchestrator/parity/v2-expected-difference.js";

function independentlySealedCorpus(corpus: SealedRetrievalEvaluationCorpusV2, queries = corpus.queries,
  sources = corpus.sources): SealedRetrievalEvaluationCorpusV2 {
  const jsonHash = (value: unknown) => digest(JSON.stringify(value));
  const source = { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", sources };
  const judgments = { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", queries };
  const baseline = { ...corpus.baseline, judgmentsSha256: jsonHash(queries) };
  return parseSealedRetrievalEvaluationBundle({ schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", files: {
    "source-events.json": jsonHash(source), "judgments.json": jsonHash(judgments), "v1-shadow-baseline.json": jsonHash(baseline),
  } }, source, judgments, baseline);
}

test("Task11F exported fault boundaries are the exact frozen internal contract", () => {
  assert.equal(Object.isFrozen(SHADOW_MIGRATION_FAULT_BOUNDARIES), true);
  assert.deepEqual(SHADOW_MIGRATION_FAULT_BOUNDARIES, ["after-source-verified", "after-package-published", "after-run-created", "after-import-commit",
    "after-projection-publish", "after-parity-report", "after-compatibility-replace", "after-compatibility-ack"]);
});

test("Task11F early external pin refusal retains genuine redacted source attempt", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  let failure: unknown;
  try { await new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt }).run({ ...f.runnerInput,
    sealedRetrieval: { corpus: f.corpus, expectedBundle: { ...f.corpus.bundle, files: { ...f.corpus.bundle.files, "judgments.json": "0".repeat(64) } } } }); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof V2ShadowMigrationPreflightFailure);
  const evidence = readV2ShadowMigrationPreflightEvidence(failure)!;
  assert.ok(evidence);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.attempts), true);
  assert.deepEqual(evidence.attempts.map(attempt => attempt.operation), ["source-verify"]);
  assert.equal(evidence.migrationIdentity, null);
  assert.equal(evidence.sourceManifestChecksum, f.manifest.manifestChecksum);
  for (const path of [f.runnerInput.packageRoot, f.runnerInput.v1ProjectionRoot, f.runnerInput.v2ProjectionRoot, f.runnerInput.compatibilityRoot]) {
    assert.deepEqual(readdirSync(path), []);
  }
  const copied = Object.assign(Object.create(Object.getPrototypeOf(failure)), failure);
  let traps = 0;
  const proxy = new Proxy(failure, { get() { traps++; throw new Error("private getter"); }, getPrototypeOf() { traps++; throw new Error("private prototype"); } });
  const getter = Object.defineProperty({}, "evidence", { get() { traps++; throw new Error("private payload"); } });
  for (const lookalike of [copied, new V2ShadowMigrationPreflightFailure("MIGRATION_SOURCE_INVALID", evidence), new Error(), proxy, getter,
    Object.create(V2ShadowMigrationPreflightFailure.prototype), { ...failure }, null]) assert.equal(readV2ShadowMigrationPreflightEvidence(lookalike), null);
  assert.equal(traps, 0);
  assert.equal(JSON.stringify(evidence).includes(f.root), false);
  assert.equal(Reflect.set(evidence.attempts[0]!, "safeErrorCode", "private secret"), false);
});

test("Task11F early future rule refusal precedes preparation", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  const original = f.metadataRules[0]!;
  const { ruleChecksum: _, ...body } = { ...original, issuedAt: "2026-09-10T00:00:01.000Z", expiresAt: "2026-09-11T00:00:00.000Z" };
  const rule = { ...body, ruleChecksum: expectedDifferenceRuleChecksum(body) };
  await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt }).run({ ...f.runnerInput, expectedDifferenceRules: [rule] }),
    error => error instanceof ShadowMigrationError && error.code === "PARITY_RULE_INVALID");
  assert.deepEqual(readdirSync(f.runnerInput.packageRoot), [], "entry-time original-rule refusal precedes package preparation");
  assert.deepEqual(readdirSync(f.runnerInput.v1ProjectionRoot), []);
  for (const dates of [
    { issuedAt: "2026-09-09T00:00:00.000Z", expiresAt: f.manifest.createdAt },
    { issuedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-11T00:00:00.000Z" },
  ]) {
    const { ruleChecksum: _, ...dated } = { ...original, ...dates };
    await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt }).run({ ...f.runnerInput,
      expectedDifferenceRules: [{ ...dated, ruleChecksum: expectedDifferenceRuleChecksum(dated) }] }),
      error => error instanceof ShadowMigrationError && error.code === "PARITY_RULE_INVALID");
    assert.deepEqual(readdirSync(f.runnerInput.packageRoot), []);
  }
});

test("Task11F full corpus malformed altered and independently wrong-source inputs refuse before preparation", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  const changed = { ...f.corpus, queries: f.corpus.queries.map((query, index) => index ? query : { ...query, query: "tampered-query" }) };
  const wrongSource = independentlySealedCorpus(f.corpus, f.corpus.queries,
    f.corpus.sources.map(source => ({ ...source, events: source.events.slice(1) })));
  for (const [corpus, code] of [[{ ...f.corpus, bundle: { ...f.corpus.bundle, schemaVersion: 1 } }, "MIGRATION_SOURCE_INVALID"],
    [changed, "MIGRATION_SOURCE_INVALID"], [wrongSource, "MIGRATION_LEDGER_INTEGRITY_FAILURE"]] as const) {
    await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt }).run({ ...f.runnerInput,
      sealedRetrieval: { corpus: corpus as SealedRetrievalEvaluationCorpusV2, expectedBundle: corpus.bundle as SealedRetrievalEvaluationCorpusV2["bundle"] } }),
      error => error instanceof ShadowMigrationError && error.code === code);
    assert.deepEqual(readdirSync(f.runnerInput.packageRoot), []); assert.deepEqual(readdirSync(f.runnerInput.v1ProjectionRoot), []);
  }
});

test("Task11F contradictory existing run binding is terminal before preparation", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  const connection = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 5000 });
  try {
    const existing = f.repository.transact(f.runnerInput.projectId, f.sealedPackage.migrationIdentity, tx => tx.readRun())!;
    new SqliteV2ShadowMigrationRepository(connection).transact(f.runnerInput.projectId, f.sealedPackage.migrationIdentity,
      tx => tx.insertRun({ ...existing, sourceManifestChecksum: "0".repeat(64) }));
    await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt }).run(f.runnerInput),
      error => error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
    assert.deepEqual(readdirSync(f.runnerInput.packageRoot), []);
    assert.deepEqual(readdirSync(f.runnerInput.v1ProjectionRoot), []);
  } finally { connection.close(); }
});

test("Task11F target revision off-state and immutable-source authorities refuse before preparation", async t => {
  const reference = await createSnapshotParityFixture(t);
  for (const variant of ["live-target", "wrong-build", "missing-revision", "non-off", "source-mutated"] as const) {
    const f = await createShadowMigrationRunnerFixture(t, { reference });
    let input = f.runnerInput;
    if (variant === "live-target") input = { ...input, targetContext: { ...input.targetContext,
      binding: { ...input.targetContext.binding, storeRoute: { ...input.targetContext.binding.storeRoute, eventsPath: f.liveEventStorePath } } } };
    if (variant === "wrong-build") input = { ...input, buildIdentityHash: "0".repeat(64) };
    if (variant === "missing-revision") input = { ...input, rolloutRevisionId: randomUUID() };
    if (variant === "non-off") {
      const connection = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 5000 });
      try { new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection)).transition({
        projectId: input.projectId, revisionId: input.rolloutRevisionId, expectedMode: "off", expectedGeneration: 0n, nextMode: "shadow",
        approval: { approvalId: randomUUID(), nonceDigest: digest("disposable approval"), actorFingerprint: digest("fixture actor"),
          evidenceDigest: digest("fixture evidence"), reasonCode: "operator-approved", recordedAt: f.manifest.createdAt },
      }); } finally { connection.close(); }
    }
    await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, faultInjector: { hit(point) {
      if (variant === "source-mutated" && point === "after-source-verified") appendFileSync(f.sourceDatabasePath, "source-change");
    } } }).run(input), error => error instanceof ShadowMigrationError && error.code === (variant === "source-mutated"
      ? "MIGRATION_SOURCE_MUTATED" : variant === "missing-revision" ? "MIGRATION_SOURCE_INVALID" : "MIGRATION_IDENTITY_CONFLICT"), variant);
    assert.deepEqual(readdirSync(input.packageRoot), [], variant); assert.deepEqual(readdirSync(input.v1ProjectionRoot), [], variant);
  }
});

test("Task11F projection callback rechecks current off-state before component phase3", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  let changed = false;
  await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, faultInjector: {
    async hit(point) {
      if (point !== "after-projection-publish") return;
      await nextTurn();
      const connection = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 5000 });
      try { new RolloutControlPlane(new SqliteRolloutControlPlaneRepository(connection)).transition({
        projectId: f.runnerInput.projectId, revisionId: f.runnerInput.rolloutRevisionId, expectedMode: "off", expectedGeneration: 0n, nextMode: "shadow",
        approval: { approvalId: randomUUID(), nonceDigest: digest("disposable awaited approval"), actorFingerprint: digest("fixture actor"),
          evidenceDigest: digest("fixture evidence"), reasonCode: "operator-approved", recordedAt: f.manifest.createdAt },
      }); changed = true; } finally { connection.close(); }
    },
  } }).run(f.runnerInput), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_IDENTITY_CONFLICT");
  assert.equal(changed, true);
  const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 3n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_parity_reports").get()!.n, 0n);
  } finally { connection.close(); }
});

test("Task11F synchronous projection callback awaits real busy retry before phase3", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  const locker = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 0 });
  let held = false, hookHits = 0, sleeps = 0, publishCalls = 0;
  const publish = V2ShadowProjectionPublisher.prototype.publishV2;
  t.mock.method(V2ShadowProjectionPublisher.prototype, "publishV2", function(this: V2ShadowProjectionPublisher,
    input: Parameters<typeof publish>[0]) { publishCalls++; return publish.call(this, input); });
  try {
    const result = await new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt,
      sleep: async (milliseconds, signal) => {
        sleeps++; assert.equal(milliseconds, 500); assert.equal(signal.aborted, false); assert.equal(held, true);
        await nextTurn();
        assert.equal(locker.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 3n,
          "a held writer must still block the component-owned phase3 commit");
        locker.exec("ROLLBACK"); held = false;
      },
      faultInjector: { hit(point) {
        if (point !== "after-projection-publish") return;
        hookHits++; locker.exec("BEGIN IMMEDIATE"); held = true;
      } },
    }).run(f.runnerInput);
    assert.equal(result.status, "compatibility-complete");
    assert.equal(hookHits, 1); assert.equal(sleeps, 1);
    assert.equal(publishCalls, 1, "a completed projection action must not be replayed during checked-read retry");
    assert.equal(locker.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 6n);
  } finally { if (held) locker.exec("ROLLBACK"); locker.close(); }
});

test("Task11F blocking parity prevents compatibility and valid original rules expire at later no-op", async t => {
  const reference = await createSnapshotParityFixture(t, { artifactMetadata: true });
  const blocking = await createShadowMigrationRunnerFixture(t, { reference });
  await assert.rejects(new V2ShadowMigrationRunner({ driver: blocking.driver, utcNow: () => blocking.manifest.createdAt }).run(blocking.runnerInput),
    error => error instanceof ShadowMigrationError && error.code === "PARITY_BLOCKING_DIVERGENCE");
  const connection = blocking.driver.open(blocking.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 4n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_parity_reports").get()!.n, 1n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_claims").get()!.n, 0n);
  } finally { connection.close(); }
  const approved = await createShadowMigrationRunnerFixture(t, { reference });
  const input = { ...approved.runnerInput, expectedDifferenceRules: approved.metadataRules };
  let now = approved.manifest.createdAt;
  const runner = new V2ShadowMigrationRunner({ driver: approved.driver, utcNow: () => now });
  const result = await runner.run(input);
  assert.equal(result.parity.blockingDivergenceCount, 0);
  assert.ok(result.parity.expectedDifferenceCount > 0);
  now = approved.metadataRules[0]!.expiresAt;
  await assert.rejects(runner.run(input), error => error instanceof ShadowMigrationError && error.code === "PARITY_RULE_INVALID");
  const expiresDuringParity = await createShadowMigrationRunnerFixture(t, { reference });
  let currentUtc = expiresDuringParity.manifest.createdAt;
  await assert.rejects(new V2ShadowMigrationRunner({ driver: expiresDuringParity.driver, utcNow: () => currentUtc,
    faultInjector: { hit(point) { if (point === "after-parity-report") currentUtc = expiresDuringParity.metadataRules[0]!.expiresAt; } },
  }).run({ ...expiresDuringParity.runnerInput, expectedDifferenceRules: expiresDuringParity.metadataRules }),
    error => error instanceof ShadowMigrationError && error.code === "PARITY_RULE_INVALID");
  const expiredTarget = expiresDuringParity.driver.open(expiresDuringParity.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    assert.equal(expiredTarget.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 4n,
      "current authorization is required before committing phase4, not only at final return");
    assert.equal(expiredTarget.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_claims").get()!.n, 0n);
  } finally { expiredTarget.close(); }
});

test("Task11F fix1 persistent writer expiry keeps read-only exhaustion separate from possible outcome", async t => {
  const reference = await createSnapshotParityFixture(t);
  for (const boundary of ["source", "run"] as const) await t.test(boundary, async () => {
    const f = await createShadowMigrationRunnerFixture(t, { reference });
    const locker = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 0 });
    let held = false, now = 0, sourceCalls = 0, runCalls = 0, failure: unknown;
    const delays: number[] = [];
    try {
      try { await new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, monotonicNow: () => now,
        sleep: async (milliseconds, signal) => {
          assert.equal(held, true); assert.equal(signal.aborted, false); delays.push(milliseconds); now = f.policy.deadlineMs;
        }, faultInjector: { hit(point) {
          if (point === "after-source-verified") sourceCalls++;
          if (point === "after-run-created") runCalls++;
          if (point === (boundary === "source" ? "after-source-verified" : "after-run-created")) {
            locker.exec("BEGIN IMMEDIATE"); held = true;
          }
        } },
      }).run(f.runnerInput); } catch (error) { failure = error; }
      assert.ok(failure instanceof ShadowMigrationError && failure.code === (boundary === "source"
        ? "MIGRATION_RETRY_EXHAUSTED" : "MIGRATION_OUTCOME_UNKNOWN"));
      assert.equal(held, true, "the competing writer was never released to make late evidence writable");
      assert.deepEqual(delays, [500]); assert.equal(sourceCalls, 1); assert.equal(runCalls, boundary === "run" ? 1 : 0);
      const evidence = readV2ShadowMigrationPreflightEvidence(failure);
      if (boundary === "source") {
        assert.ok(evidence); assert.equal(evidence.attempts.length, 1);
        assert.equal(evidence.attempts[0]!.operation, "source-verify");
        assert.equal(evidence.attempts[0]!.safeErrorCode, "SQLITE_BUSY");
        assert.equal(evidence.attempts[0]!.recordedAt, f.manifest.createdAt);
      } else assert.equal(evidence, null);
      assert.equal(locker.prepare("SELECT count(*) AS n FROM v2_shadow_migration_runs").get()!.n, boundary === "run" ? 1n : 0n);
      for (const table of ["events", "v2_shadow_migration_transitions", "v2_shadow_migration_attempts", "v2_shadow_imported_records"])
        assert.equal(locker.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0n, table);
    } finally { if (held) locker.exec("ROLLBACK"); locker.close(); }
  });
});

test("Task11F fix1 real WAL writer retries checked reads without replaying completed actions", async t => {
  const reference = await createSnapshotParityFixture(t);
  for (const boundary of ["source", "prior", "run"] as const) {
    await t.test(boundary, async () => {
    const f = await createShadowMigrationRunnerFixture(t, { reference });
    const locker = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 0 });
    let held = false, acquired = false, sourceCalls = 0, runCalls = 0, reachedImport = false, now = 0;
    const delays: number[] = [];
    const acquire = () => { if (!acquired) { locker.exec("BEGIN IMMEDIATE"); held = true; acquired = true; } };
    const original = SqliteV2ShadowMigrationRepository.prototype.transact;
    const observer = t.mock.method(SqliteV2ShadowMigrationRepository.prototype, "transact", function<T>(this: SqliteV2ShadowMigrationRepository,
      project: string, identity: string, callback: Parameters<typeof original<T>>[2]): T {
      if (boundary === "prior") acquire();
      return original.call(this, project, identity, callback) as T;
    });
    try {
      await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, monotonicNow: () => now,
        sleep: async (milliseconds, signal) => {
          assert.equal(signal.aborted, false); delays.push(milliseconds);
          assert.equal(held, true, "the real writer remains held until policy backoff");
          locker.exec("ROLLBACK"); held = false;
        }, faultInjector: { hit(point) {
          if (point === "after-source-verified") { sourceCalls++; if (boundary === "source") acquire(); }
          if (point === "after-run-created") { runCalls++; if (boundary === "run") acquire(); }
        } }, importFaultInjector: { hit(point) {
          if (point === "before-begin") { reachedImport = true; now = f.policy.deadlineMs; }
        } },
      }).run(f.runnerInput), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED", boundary);
      assert.equal(reachedImport, true, "the read retry must reacquire and finish the checked handoff");
      assert.deepEqual(delays, [500], boundary); assert.equal(sourceCalls, 1, boundary); assert.equal(runCalls, 1, boundary);
      const rows = locker.prepare("SELECT operation, operation_attempt_index, outcome_category, safe_error_code, recorded_at FROM v2_shadow_migration_attempts ORDER BY attempt_ordinal").all();
      assert.equal(rows.length, 1, "one immutable observation is flushed once, not duplicated after reacquisition");
      assert.deepEqual({ ...rows[0] }, { operation: boundary === "run" ? "run-create" : "source-verify", operation_attempt_index: 0n,
        outcome_category: "retryable-failure", safe_error_code: "SQLITE_BUSY", recorded_at: f.manifest.createdAt });
      assert.equal(locker.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 2n);
      assert.equal(locker.prepare("SELECT count(*) AS n FROM events").get()!.n, 0n);
    } finally { observer.mock.restore(); if (held) locker.exec("ROLLBACK"); locker.close(); }
    });
  }
});

test("Task11F fix1 first pin rechecks a real writer candidate after run creation", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  const connection = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 5000, bindFileIdentity: true });
  let imports = 0, inserted = false, failure: unknown;
  const original = V2ShadowImporter.prototype.import;
  t.mock.method(V2ShadowImporter.prototype, "import", function (this: V2ShadowImporter, input: Parameters<typeof original>[0]) {
    imports++; return original.call(this, input);
  });
  try {
    try { await new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, faultInjector: { hit(point) {
      if (point !== "after-run-created") return;
      new EventStore(connection, new SqliteEventStoreStatements(connection), new MaintenanceFence(), new BranchScopeRepository(),
        () => f.manifest.createdAt, () => randomUUID()).append({
        context: f.runnerInput.targetContext, commandId: randomUUID(), idempotencyKey: `foreign:${randomUUID()}`,
        commandType: "ImportV2ShadowBatch", correlationId: randomUUID(), agentId: "v2-shadow-importer", expectedStreamVersion: 0n,
        streamId: `v2-shadow-import/${f.sealedPackage.migrationIdentity}`, streamType: "migration", outbox: [], publicResponse: { fixture: true },
        events: [{ eventType: "V1ProjectionSourceImported", eventSchemaVersion: 1, occurredAt: f.manifest.createdAt,
          visibilityScope: "project", confidence: "high", verificationStatus: "verified", payload: { migrationIdentity: "b".repeat(64), contradiction: true },
          sourceRefs: [], evidenceRefs: [], evidenceDigests: [] }] });
      inserted = true;
    } } }).run(f.runnerInput); } catch (error) { failure = error; }
    assert.equal(inserted, true);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 0n,
      "a candidate inserted after the early check must prevent ordinal0 itself");
    assert.equal(imports, 0, "no component may run after the atomic refusal");
    assert.ok(failure instanceof ShadowMigrationError && failure.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
    assert.equal(connection.prepare("SELECT count(*) AS n FROM events").get()!.n, 1n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n, 0n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n, 0n);
  } finally { connection.close(); }
});

test("Task11F first pin rejects every owned candidate without filtering contradictory envelopes", async t => {
  const reference = await createSnapshotParityFixture(t);
  for (const variant of ["empty", "wrapper", "contradictory", "idempotency", "payload", "event-id", "dedup-only", "unrelated"] as const) {
    const f = await createShadowMigrationRunnerFixture(t, { reference });
    const identity = f.sealedPackage.migrationIdentity;
    const connection = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 5000, bindFileIdentity: true });
    try {
      if (variant !== "empty") {
        const record = [...f.sealedPackage.records()][0]!;
        const { payload: _, ...sourceEvent } = JSON.parse(Buffer.concat([...record.readChunks()].map(chunk => Buffer.from(chunk))).toString("utf8"));
        const wrapper = { schemaVersion: 1, migrationIdentity: identity, sourceOrdinal: 0, sourceRecordHash: record.descriptor.contentSha256, sourceEvent };
        new EventStore(connection, new SqliteEventStoreStatements(connection), new MaintenanceFence(), new BranchScopeRepository(),
          () => f.manifest.createdAt, () => variant === "event-id" ? deterministicMigrationUuid("event", identity, 0) : randomUUID()).append({
          context: f.runnerInput.targetContext, commandId: randomUUID(),
          idempotencyKey: ["idempotency", "dedup-only"].includes(variant) ? `v2-shadow-import:${identity}:0` : `foreign:${randomUUID()}`,
          commandType: "ImportV2ShadowBatch", correlationId: randomUUID(), agentId: "v2-shadow-importer", expectedStreamVersion: 0n,
          streamId: ["wrapper", "contradictory"].includes(variant) ? `v2-shadow-import/${identity}` : `v2-shadow-import/${"b".repeat(64)}`,
          streamType: "migration", outbox: [], publicResponse: { fixture: true },
          events: [{ eventType: "V1ProjectionSourceImported", eventSchemaVersion: 1, occurredAt: f.manifest.createdAt,
            visibilityScope: "project", confidence: "high", verificationStatus: "verified",
            payload: variant === "wrapper" ? wrapper : { migrationIdentity: variant === "payload" ? identity : "b".repeat(64), contradiction: true },
            sourceRefs: [], evidenceRefs: [], evidenceDigests: [] }] });
        if (variant === "dedup-only") {
          // Deliberately corrupt only this disposable writer-created fixture, leaving genuine command evidence orphaned.
          connection.exec("DROP TRIGGER events_no_delete"); connection.exec("DELETE FROM events");
        }
      }
      const before = connection.prepare("SELECT count(*) AS n FROM events").get()!.n;
      let prepared = 0;
      await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, faultInjector: { hit(point) {
        if (point === "after-package-published") { prepared++; throw new ShadowMigrationError("MIGRATION_SOURCE_INVALID"); }
      } } }).run(f.runnerInput), error => error instanceof ShadowMigrationError
        && error.code === (["empty", "unrelated"].includes(variant) ? "MIGRATION_SOURCE_INVALID" : "MIGRATION_LEDGER_INTEGRITY_FAILURE"), variant);
      assert.equal(prepared, ["empty", "unrelated"].includes(variant) ? 1 : 0, variant);
      assert.equal(connection.prepare("SELECT count(*) AS n FROM events").get()!.n, before);
      for (const table of ["v2_shadow_migration_runs", "v2_shadow_migration_transitions", "v2_shadow_migration_attempts"]) {
        assert.equal(connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0n, variant);
      }
      assert.deepEqual(readdirSync(f.runnerInput.v1ProjectionRoot), []);
      if (!prepared) assert.deepEqual(readdirSync(f.runnerInput.packageRoot), []);
    } finally { connection.close(); }
  }
});

test("Task11F unknown import consumes one proof and missing projection phase remains unknown", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  const original = V2ShadowImporter.prototype.reconcile;
  let proofs = 0;
  t.mock.method(V2ShadowImporter.prototype, "reconcile", function(this: V2ShadowImporter, input: Parameters<typeof original>[0]) {
    proofs++; return original.call(this, input);
  });
  const runner = new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, faultInjector: {
    hit(boundary) {
      if (boundary === "after-import-commit") {
        const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
        try {
          assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n, BigInt(f.manifest.eventCount));
          assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 2n);
        } finally { connection.close(); }
      }
      if (boundary === "after-import-commit" || boundary === "after-projection-publish") throw new Error("private lost response");
    },
  } });
  await assert.rejects(runner.run(f.runnerInput), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
  assert.equal(proofs, 1, "the same unknown import cycle cannot invoke its proof twice");
  const connection = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 5000, bindFileIdentity: true });
  try {
    const repository = new SqliteV2ShadowMigrationRepository(connection);
    const snapshot = repository.transact(f.runnerInput.projectId, f.sealedPackage.migrationIdentity, tx => ({ phases: tx.readTransitions(), attempts: tx.readAttemptEvidence(), report: tx.readParityReport() }));
    assert.deepEqual(snapshot.phases.map(phase => phase.phase), ["snapshot-verified", "package-sealed", "import-committed"]);
    assert.equal(snapshot.report, null);
    assert.deepEqual(snapshot.attempts.map(attempt => [attempt.operation, attempt.outcomeCategory]), [["import", "unknown-outcome"], ["projection", "unknown-outcome"]]);
  } finally { connection.close(); }
});

test("Task11F complete-import pending handoff expires without proof phase2 or downstream work", async t => {
  const f = await createShadowMigrationRunnerFixture(t, { legacyArtifacts: true });
  let now = 0, entered!: () => void, release!: () => void, settled = false, proofCalls = 0;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const proof = V2ShadowImporter.prototype.reconcile;
  t.mock.method(V2ShadowImporter.prototype, "reconcile", function(this: V2ShadowImporter, input: Parameters<typeof proof>[0]) {
    proofCalls++; return proof.call(this, input);
  });
  const boundaries: string[] = [];
  const invocation = new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, monotonicNow: () => now,
    faultInjector: { hit(point) { boundaries.push(point); if (point === "after-import-commit") { entered(); return held; } } },
  }).run(f.runnerInput).then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
  try {
    await reached; await nextTurn(); assert.equal(settled, false);
    const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
    try {
      assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n, BigInt(f.manifest.eventCount + f.manifest.legacyArtifacts.length));
      assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n, BigInt(f.manifest.legacyArtifacts.length));
      assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 2n);
      now = f.policy.deadlineMs; release(); const result = await invocation;
      assert.ok("error" in result && result.error instanceof ShadowMigrationError);
      assert.equal(result.error.code, "MIGRATION_OUTCOME_UNKNOWN");
      assert.equal(proofCalls, 0); assert.equal(boundaries.at(-1), "after-import-commit");
      assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 2n);
      assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_attempts").get()!.n, 0n);
      assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_parity_reports").get()!.n, 0n);
    } finally { connection.close(); }
  } finally { release(); await invocation; }
});

test("Task11F runner run-created pending handoff expires as unknown before phase0", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  let now = 0, release!: () => void, reached!: () => void, settled = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const running = new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, monotonicNow: () => now,
    faultInjector: { hit(point) { if (point === "after-run-created") { reached(); return held; } } },
  }).run(f.runnerInput).finally(() => { settled = true; });
  const outcome = running.then(value => ({ value }), error => ({ error }));
  await entered; await nextTurn(); assert.equal(settled, false);
  const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_runs").get()!.n, 1n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 0n);
    now = f.policy.deadlineMs; release();
    const result = await outcome;
    assert.ok("error" in result && result.error instanceof ShadowMigrationError);
    assert.equal(result.error.code, "MIGRATION_OUTCOME_UNKNOWN");
    for (const table of ["events", "v2_shadow_migration_transitions", "v2_shadow_migration_attempts"]) {
      assert.equal(connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0n);
    }
  } finally { release(); connection.close(); await outcome; }
});

test("Task11F real primary busy retries through importer wrapping but native locked stays terminal", async t => {
  const reference = await createSnapshotParityFixture(t);
  for (const variant of ["busy", "locked"] as const) {
    const f = await createShadowMigrationRunnerFixture(t, { reference });
    const locker = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 0 });
    const contender = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 0 });
    let nativeError: unknown;
    if (variant === "busy") {
      locker.exec("BEGIN IMMEDIATE");
      try { contender.exec("BEGIN IMMEDIATE"); } catch (error) { nativeError = error; }
      finally { locker.exec("ROLLBACK"); }
      assert.equal((nativeError as { errcode: number }).errcode & 0xff, 5);
    } else {
      const database = new DatabaseSync(":memory:");
      database.exec("CREATE TABLE occupied(n INTEGER); INSERT INTO occupied VALUES (1),(2)");
      const cursor = database.prepare("SELECT * FROM occupied").iterate(); cursor.next();
      try { database.exec("DROP TABLE occupied"); } catch (error) { nativeError = error; }
      finally { cursor.return?.(); database.close(); }
      assert.equal((nativeError as { errcode: number }).errcode & 0xff, 6);
    }
    locker.close(); contender.close();
    let injected = false;
    const delays: number[] = [];
    await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt,
      sleep: async milliseconds => { delays.push(milliseconds); }, importFaultInjector: { hit(point) {
        if (!injected && point === "before-begin") { injected = true; throw nativeError; }
      } }, faultInjector: { hit(point) { if (point === "after-projection-publish") throw new Error("stop after verified import"); } },
    }).run(f.runnerInput), error => error instanceof ShadowMigrationError
      && error.code === (variant === "busy" ? "MIGRATION_OUTCOME_UNKNOWN" : "MIGRATION_IDENTITY_CONFLICT"));
    assert.deepEqual(delays, variant === "busy" ? [500] : []);
    const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
    try {
      const attempts = connection.prepare("SELECT operation,outcome_category,safe_error_code FROM v2_shadow_migration_attempts ORDER BY attempt_ordinal").all();
      assert.equal(attempts[0]!.operation, "import");
      assert.equal(attempts[0]!.outcome_category, variant === "busy" ? "retryable-failure" : "terminal-failure");
      assert.equal(attempts[0]!.safe_error_code, variant === "busy" ? "SQLITE_BUSY" : "MIGRATION_IDENTITY_CONFLICT");
      assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, variant === "busy" ? 3n : 2n);
    } finally { connection.close(); }
  }
});

test("Task11F external mutation invalidates the one committed import proof before phase2", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  const connection = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 5000 });
  const reconcile = V2ShadowImporter.prototype.reconcile;
  let proofs = 0, proved = false, changed = false;
  t.mock.method(V2ShadowImporter.prototype, "reconcile", function(this: V2ShadowImporter, input: Parameters<typeof reconcile>[0]) {
    proofs++; const result = reconcile.call(this, input); proved = result.status === "committed";
      if (proved && !changed) {
        changed = true;
        // Corrupt only the disposable target after a real committed proof, through a distinct real connection.
        for (const row of connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='v2_shadow_imported_records'").all()) {
          connection.exec(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`);
        }
        connection.prepare("UPDATE v2_shadow_imported_records SET source_record_hash=$h WHERE source_ordinal=0").run({ $h: "0".repeat(64) });
      }
    return result;
  });
  try {
    await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt,
      faultInjector: { hit(point) { if (point === "after-import-commit") throw new Error("lost completed import response"); } } }).run(f.runnerInput),
    error => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
    assert.equal(changed, true); assert.equal(proofs, 1);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 2n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_parity_reports").get()!.n, 0n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_attempts").get()!.n, 0n);
  } finally { connection.close(); }
});

test("Task11F sleep rejection at the capped remainder retains exhausted original budget", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  let now = 0, sleeps = 0;
  let failure: unknown;
  try { await new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, monotonicNow: () => now,
    faultInjector: { hit(point) { if (point === "after-source-verified") {
      now = f.policy.deadlineMs - 250; throw Object.assign(new Error("transient before budget exhaustion"), { code: "EBUSY" });
    } } }, sleep: async (milliseconds, signal) => {
      sleeps++; assert.equal(milliseconds, 250); assert.equal(signal.aborted, false); now = f.policy.deadlineMs;
      throw Object.assign(new Error("sleep aborted"), { name: "AbortError" });
    },
  }).run(f.runnerInput); } catch (error) { failure = error; }
  assert.ok(failure instanceof ShadowMigrationError); assert.equal(failure.code, "MIGRATION_RETRY_EXHAUSTED");
  assert.equal(sleeps, 1); assert.equal(readV2ShadowMigrationPreflightEvidence(failure)!.attempts.length, 1);
  assert.deepEqual(readdirSync(f.runnerInput.packageRoot), []);
});

test("Task11F proof invalidation read errors and original expiry prevent phase2 and later evidence", async t => {
  const reference = await createSnapshotParityFixture(t);
  for (const variant of ["before-proof-read", "after-proof-read", "expiry-after-proof", "missing-counter", "malformed-counter"] as const) {
    const f = await createShadowMigrationRunnerFixture(t, { reference });
    let armed = false, proved = false, now = 0, calls = 0, readsAfterExpiry = 0;
    class CounterFailure extends DatabaseSync {
      override prepare(sql: string): StatementSync {
        if (sql === "PRAGMA main.data_version") {
          if (now === f.policy.deadlineMs) readsAfterExpiry++;
          if (armed && (variant === "before-proof-read" || variant === "after-proof-read" && proved)) throw new Error("unreadable invalidation counter");
          if (armed && (variant === "missing-counter" || variant === "malformed-counter")) {
            const statement = super.prepare(sql);
            statement.get = (): ReturnType<StatementSync["get"]> => variant === "missing-counter" ? {} : { data_version: "not-an-integer" };
            return statement;
          }
        }
        return super.prepare(sql);
      }
    }
    const reconcile = V2ShadowImporter.prototype.reconcile;
    const mock = t.mock.method(V2ShadowImporter.prototype, "reconcile", function(this: V2ShadowImporter, input: Parameters<typeof reconcile>[0]) {
      calls++; const result = reconcile.call(this, input); proved = true;
      if (variant === "expiry-after-proof") now = f.policy.deadlineMs;
      return result;
    });
    try {
      await assert.rejects(new V2ShadowMigrationRunner({ driver: new NodeSqliteDriver({ DatabaseSync: CounterFailure }), monotonicNow: () => now,
        utcNow: () => f.manifest.createdAt, faultInjector: { hit(point) {
          if (point === "after-import-commit") { armed = true; throw new Error("lost import handoff"); }
          if (point === "after-projection-publish") throw new Error("must not reach phase3");
        } } }).run(f.runnerInput), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
      assert.equal(calls, ["before-proof-read", "missing-counter", "malformed-counter"].includes(variant) ? 0 : 1, variant);
      assert.equal(readsAfterExpiry, 0);
      const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
      try {
        assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 2n, variant);
        assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_attempts").get()!.n, 0n, variant);
      } finally { connection.close(); }
    } finally { mock.mock.restore(); }
  }
});

test("Task11F unknown import attempt transaction expiry retains original unknown and rolls back evidence", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  let now = 0, proofs = 0, expired = false;
  const reconcile = V2ShadowImporter.prototype.reconcile;
  t.mock.method(V2ShadowImporter.prototype, "reconcile", function(this: V2ShadowImporter, input: Parameters<typeof reconcile>[0]) {
    proofs++; return reconcile.call(this, input);
  });
  class AttemptExpiry extends DatabaseSync {
    override prepare(sql: string): StatementSync {
      const statement = super.prepare(sql);
      if (/^INSERT INTO v2_shadow_migration_attempts\b/i.test(sql)) { expired = true; now = f.policy.deadlineMs; }
      return statement;
    }
  }
  await assert.rejects(new V2ShadowMigrationRunner({ driver: new NodeSqliteDriver({ DatabaseSync: AttemptExpiry }),
    utcNow: () => f.manifest.createdAt, monotonicNow: () => now,
    faultInjector: { hit(point) { if (point === "after-import-commit") throw new Error("lost import response"); } },
  }).run(f.runnerInput), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
  assert.equal(expired, true); assert.equal(proofs, 1);
  const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_attempts").get()!.n, 0n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 2n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_parity_reports").get()!.n, 0n);
  } finally { connection.close(); }
});

test("Task11F component absent import proof permits one deterministic retry without duplicate events", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  let interrupted = false;
  const proofs: string[] = [], delays: number[] = [];
  const reconcile = V2ShadowImporter.prototype.reconcile;
  t.mock.method(V2ShadowImporter.prototype, "reconcile", function(this: V2ShadowImporter, input: Parameters<typeof reconcile>[0]) {
    const result = reconcile.call(this, input); proofs.push(result.status); return result;
  });
  await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt,
    sleep: async milliseconds => { delays.push(milliseconds); }, importFaultInjector: { hit(point) {
      if (!interrupted && point === "before-begin") { interrupted = true; throw new EventStoreError("COMMAND_OUTCOME_UNKNOWN"); }
    } }, faultInjector: { hit(point) { if (point === "after-projection-publish") throw new Error("stop at missing phase3"); } },
  }).run(f.runnerInput), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
  assert.deepEqual(proofs, ["absent", "committed"]);
  assert.deepEqual(delays, [500]);
  const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    assert.equal(connection.prepare("SELECT count(*) AS n FROM events").get()!.n, BigInt(f.manifest.eventCount));
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n, BigInt(f.manifest.eventCount));
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 3n);
  } finally { connection.close(); }
});

test("Task11F V1 image without manifest is unknown until a later normal authenticated adoption", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  const connection = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 5000, bindFileIdentity: true });
  const options = { driver: f.driver, connection, eventStorePath: f.eventStorePath, liveEventStorePath: f.liveEventStorePath,
    liveVaultRoot: f.liveVaultRoot, v1ProjectionDirectory: f.runnerInput.v1ProjectionRoot, v2ProjectionDirectory: f.runnerInput.v2ProjectionRoot, policy: f.policy };
  const input = { source: f.source, sealedPackage: f.sealedPackage };
  let entered = false;
  try {
    const publisher = new V2ShadowProjectionPublisher({ ...options, faultInjector: { hit(point) {
      if (point === "before-v1-manifest") { entered = true; throw new Error("image committed manifest absent"); }
    } } });
    await assert.rejects(publisher.prepareV1Baseline(input), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
    assert.equal(entered, true);
    const before = readdirSync(f.runnerInput.v1ProjectionRoot);
    assert.ok(before.some(name => name.endsWith(".sqlite")));
    assert.equal((await publisher.reconcileV1Baseline(input)).status, "unknown");
    assert.deepEqual(readdirSync(f.runnerInput.v1ProjectionRoot), before, "read-only proof does not publish the missing manifest");
    const adopted = await new V2ShadowProjectionPublisher(options).prepareV1Baseline(input);
    assert.equal(adopted.baselineChecksum, f.input.preparedV1.baselineChecksum);
  } finally { connection.close(); }
});

test("Task11F boundary restarts adopt durable components without duplicate wrappers outboxes or artifacts", async t => {
  const f = await createShadowMigrationRunnerFixture(t, { legacyArtifacts: true });
  const v1 = new LifecycleV2DisabledAdapter(createRunnerV1CallerControl(f.liveVaultRoot));
  const callerResult = v1.invoke("lifecycleStatus", { includeHistory: true });
  const retainedCallerJson = JSON.stringify(callerResult);
  assert.ok(callerResult.activeSession);
  const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  const repository = new SqliteV2ShadowMigrationRepository(connection);
  const identity = f.sealedPackage.migrationIdentity;
  const phaseCount = () => repository.readVerifiedTransitions(f.runnerInput.projectId, identity).length;
  const protectedPaths = [f.manifestPath, f.sourceDatabasePath, f.liveEventStorePath];
  const before = protectedPaths.map(path => digest(readFileSync(path)));
  const readV1 = async () => {
    const snapshot = await new SqliteProjectionEventReader({ driver: f.driver, eventStorePath: f.liveEventStorePath }).openCommittedSnapshot(f.projectionBinding);
    try { return { binding: snapshot.binding, eventCount: snapshot.eventCount, terminalEventPosition: snapshot.terminalEventPosition,
      terminalEventHash: snapshot.terminalEventHash, events: [...snapshot.events()] }; }
    finally { snapshot.close(); }
  };
  const beforeV1 = await readV1();
  let sourceInterrupted = false, partialImport = false;
  try {
    await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, sleep: async () => {},
      faultInjector: { hit(point) {
        if (point === "after-source-verified" && !sourceInterrupted) { sourceInterrupted = true; throw Object.assign(new Error("transient"), { code: "EINTR" }); }
        if (point === "after-package-published" || point === "after-run-created") throw new Error("committed response lost");
      } }, importFaultInjector: { hit(point) { if (point === "after-commit-before-response") { partialImport = true; throw new Error("native commit precedes receipts"); } } },
    }).run(f.runnerInput), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
    assert.equal(sourceInterrupted, true); assert.equal(partialImport, true); assert.equal(phaseCount(), 2);
    assert.deepEqual(v1.invoke("lifecycleStatus", { includeHistory: true }), callerResult, "real V1 workflow result survives runner failure");
    assert.equal(connection.prepare("SELECT count(*) AS n FROM events").get()!.n,
      BigInt(Math.min(f.policy.maxBatchEvents, MAX_EVENTS_PER_COMMAND)), "only the first actual native batch committed before response loss");
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_imported_records").get()!.n, 0n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_compatibility_outbox").get()!.n, 0n);
    const attempts = connection.prepare("SELECT operation,attempt_ordinal FROM v2_shadow_migration_attempts ORDER BY attempt_ordinal").all();
    assert.deepEqual(attempts.map(row => row.operation), ["source-verify", "package-seal", "run-create", "import"]);
    assert.deepEqual(attempts.map(row => row.attempt_ordinal), [0n, 1n, 2n, 3n]);
    const changedCorpus = independentlySealedCorpus(f.corpus, f.corpus.queries.map((query, index) => index ? query : { ...query, queryText: `${query.queryText} changed-pin` }));
    let changedPreparation = 0;
    await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, faultInjector: { hit(point) {
      if (point === "after-package-published") changedPreparation++;
    } } }).run({ ...f.runnerInput, sealedRetrieval: { corpus: changedCorpus, expectedBundle: changedCorpus.bundle } }),
      error => error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
    assert.equal(changedPreparation, 0); assert.equal(phaseCount(), 2);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_attempts").get()!.n, 4n);
    for (const [boundary, expectedPhases] of [["after-projection-publish", 3], ["after-parity-report", 4],
      ["after-compatibility-replace", 5], ["after-compatibility-ack", 5]] as const) {
      let hits = 0;
      await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, faultInjector: { hit(point) {
        if (point === boundary) { hits++; throw new Error("real durable boundary interruption"); }
      } } }).run(f.runnerInput), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
      assert.equal(hits, 1, boundary); assert.equal(phaseCount(), expectedPhases, boundary);
    }
    const result = await new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt }).run(f.runnerInput);
    assert.equal(result.status, "compatibility-complete"); assert.equal(phaseCount(), 6);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM events").get()!.n, BigInt(f.manifest.eventCount + f.manifest.legacyArtifacts.length));
    for (const table of ["v2_shadow_compatibility_outbox", "v2_shadow_compatibility_acknowledgements"]) {
      assert.equal(connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, BigInt(f.manifest.legacyArtifacts.length));
    }
    assert.equal(result.compatibility.acknowledgedCount, f.manifest.legacyArtifacts.length);
    assert.deepEqual(v1.invoke("lifecycleStatus", { includeHistory: true }), callerResult, "real V1 workflow result survives runner restarts");
    assert.equal(JSON.stringify(callerResult), retainedCallerJson, "already-returned V1 success is not replaced or mutated");
    assert.deepEqual(await readV1(), beforeV1, "actual authenticated live V1 reader result remains unchanged");
    assert.deepEqual(protectedPaths.map(path => digest(readFileSync(path))), before);
  } finally { connection.close(); }
});

test("Task11F clean runner commits all six phases and completed invocation attempts no semantic writes", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  const deadlines: ShadowMigrationInvocationDeadline[] = [];
  const import_ = V2ShadowImporter.prototype.import, proof = V2ShadowImporter.prototype.reconcile;
  let actualImport: ReturnType<typeof import_> | undefined;
  t.mock.method(V2ShadowImporter.prototype, "import", function(this: V2ShadowImporter, input: Parameters<typeof import_>[0]) {
    deadlines.push(input.invocationDeadline!); return actualImport = import_.call(this, input);
  });
  t.mock.method(V2ShadowImporter.prototype, "reconcile", function(this: V2ShadowImporter, input: Parameters<typeof proof>[0]) {
    deadlines.push(input.invocationDeadline!); return proof.call(this, input);
  });
  const materialize = V2ShadowCompatibilityMaterializer.prototype.materializePending;
  t.mock.method(V2ShadowCompatibilityMaterializer.prototype, "materializePending", function(this: V2ShadowCompatibilityMaterializer, input: Parameters<typeof materialize>[0]) {
    deadlines.push(input.invocationDeadline!); return materialize.call(this, input);
  });
  const corpusBefore = JSON.stringify(f.corpus);
  let forbidWrites = false, attemptedWrites = 0;
  const observedWrites: { path: string; sql: string }[] = [];
  class ObservedDatabase extends DatabaseSync {
    readonly #path: string;
    constructor(...args: ConstructorParameters<typeof DatabaseSync>) { super(...args); this.#path = String(args[0]); }
    override prepare(sql: string): StatementSync {
      const statement = super.prepare(sql);
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
        const path = this.#path;
        for (const method of ["run", "get", "all", "iterate"] as const) {
          const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
          statement[method] = ((...args: unknown[]) => {
            if (forbidWrites) { observedWrites.push({ path, sql }); attemptedWrites++; throw new Error("unexpected semantic write"); }
            return original(...args);
          }) as never;
        }
      }
      return statement;
    }
  }
  let utc = f.manifest.createdAt, monotonic = 0;
  const runner = new V2ShadowMigrationRunner({ driver: new NodeSqliteDriver({ DatabaseSync: ObservedDatabase }), utcNow: () => utc, monotonicNow: () => monotonic });
  const result = await runner.run(f.runnerInput);
  assert.equal(result.import, actualImport, "the genuine importer object is retained for later same-module observation");
  assert.ok(deadlines.length >= 3 && deadlines.every(deadline => deadline === deadlines[0]));
  assert.equal(deadlines[0]!.signal.aborted, true);
  assert.equal(result.status, "compatibility-complete");
  assert.equal(result.deduplicated, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.parity.sealedRetrieval.queryCount, f.corpus.queries.length);
  assert.deepEqual([result.compatibility.acknowledgedCount, result.compatibility.highestAcknowledgedSourceOrdinal,
    result.compatibility.acknowledgedImportedPosition, result.compatibility.materializationRevision], [0, null, null, null]);
  const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    const repository = new SqliteV2ShadowMigrationRepository(connection);
    const phases = repository.readVerifiedTransitions(f.runnerInput.projectId, result.migrationIdentity);
    assert.deepEqual(phases.map(p => p.phase), ["snapshot-verified", "package-sealed", "import-committed", "projection-verified", "parity-complete", "compatibility-complete"]);
    const counts = () => ["events", "v2_shadow_migration_transitions", "v2_shadow_migration_attempts", "v2_shadow_imported_records",
      "v2_shadow_compatibility_outbox", "v2_shadow_parity_reports"].map(table => connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    const before = counts();
    forbidWrites = true;
    utc = "2026-09-10T01:00:00.000Z"; monotonic = 123456;
    deadlines.length = 0;
    const repeated = await runner.run(f.runnerInput).catch(error => assert.fail(`no-op refusal ${String(error)}; native observations ${JSON.stringify(observedWrites)}`));
    assert.equal(repeated.deduplicated, true);
    assert.deepEqual(counts(), before);
    assert.equal(attemptedWrites, 0);
    assert.equal(repeated.import.importedEventsChecksum, result.import.importedEventsChecksum);
    assert.deepEqual(repository.readVerifiedTransitions(f.runnerInput.projectId, result.migrationIdentity), phases);
    assert.equal(JSON.stringify(f.corpus), corpusBefore);
    const corrupt = f.driver.open(f.eventStorePath, { mode: "existing", busyTimeoutMs: 5000 });
    try {
      for (const row of corrupt.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='v2_shadow_migration_transitions'").all()) {
        corrupt.exec(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`);
      }
      let predecessor = phases[2]!.transitionHash;
      for (const ordinal of [3, 4, 5]) {
        const { transitionHash: _, ...body } = { ...phases[ordinal]!, priorTransitionHash: predecessor,
          ...(ordinal === 3 ? { attemptId: randomUUID() } : {}) };
        predecessor = digest("project-memory/v2-shadow-migration-transition/v1\n" + canonicalJson(body));
        corrupt.prepare("UPDATE v2_shadow_migration_transitions SET attempt_id=$a,prior_transition_hash=$p,transition_hash=$h WHERE ordinal=$o")
          .run({ $a: body.attemptId, $p: body.priorTransitionHash, $h: predecessor, $o: ordinal });
      }
    } finally { corrupt.close(); }
    await assert.rejects(runner.run(f.runnerInput), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
    assert.equal(attemptedWrites, 0, "checksum-valid forged component-owned phase3 metadata is terminal without repair");
  } finally { connection.close(); }
});

test("Task11F unsafe external identifiers cannot enter a genuine carrier", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  const sentinel = "C:\\private\\unsafe-revision-payload";
  let failure: unknown;
  try { await new V2ShadowMigrationRunner({ driver: f.driver }).run({ ...f.runnerInput, rolloutRevisionId: sentinel }); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof ShadowMigrationError);
  assert.equal(readV2ShadowMigrationPreflightEvidence(failure), null, "unvalidated arbitrary identifiers cannot acquire evidence authority");
  assert.equal(JSON.stringify(failure).includes(sentinel), false);
  assert.deepEqual(readdirSync(f.runnerInput.packageRoot), []);
  let clockReads = 0, opens = 0;
  await assert.rejects(new V2ShadowMigrationRunner({ driver: { open() { opens++; throw new Error("must not open after traversal expiry"); } },
    monotonicNow: () => ++clockReads < 100 ? 0 : f.policy.deadlineMs }).run(f.runnerInput),
    error => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED");
  assert.equal(opens, 0); assert.equal(clockReads, 100, "full input traversal is charged to the one original deadline");
});

test("Task11F actual import precommit and postcommit expiry preserve distinct durable outcomes", async t => {
  const reference = await createSnapshotParityFixture(t);
  for (const point of ["before-begin", "after-commit-before-response"] as const) {
    const f = await createShadowMigrationRunnerFixture(t, { reference });
    let now = 0, hit = false;
    await assert.rejects(new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, monotonicNow: () => now,
      importFaultInjector: { hit(boundary) { if (boundary === point) { hit = true; now = f.policy.deadlineMs; } } },
    }).run(f.runnerInput), error => error instanceof ShadowMigrationError && error.code === (point === "before-begin"
      ? "MIGRATION_RETRY_EXHAUSTED" : "MIGRATION_OUTCOME_UNKNOWN"));
    assert.equal(hit, true);
    const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
    try {
      assert.equal(connection.prepare("SELECT count(*) AS n FROM events").get()!.n,
        point === "before-begin" ? 0n : BigInt(Math.min(f.policy.maxBatchEvents, MAX_EVENTS_PER_COMMAND)));
      for (const table of ["v2_shadow_imported_records", "v2_shadow_compatibility_outbox", "v2_shadow_migration_attempts", "v2_shadow_parity_reports"]) {
        assert.equal(connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0n);
      }
      assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 2n);
    } finally { connection.close(); }
  }
});

test("Task11F real retrieval expiry closes owned connections and writes no parity report", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  let now = 0, armed = false, queries = 0;
  const retrieve = InternalRetrievalService.prototype.retrieve;
  t.mock.method(InternalRetrievalService.prototype, "retrieve", async function(this: InternalRetrievalService, ...args: Parameters<typeof retrieve>) {
    const result = await retrieve.apply(this, args);
    if (armed) { queries++; now = f.policy.deadlineMs; }
    return result;
  });
  const owned = new Set<object>();
  class TrackedDatabase extends DatabaseSync {
    constructor(...args: ConstructorParameters<typeof DatabaseSync>) { super(...args); owned.add(this); }
    override close(): void { try { super.close(); } finally { owned.delete(this); } }
  }
  const driver = new NodeSqliteDriver({ DatabaseSync: TrackedDatabase });
  await assert.rejects(new V2ShadowMigrationRunner({ driver, utcNow: () => f.manifest.createdAt, monotonicNow: () => now,
    faultInjector: { hit(point) { if (point === "after-projection-publish") armed = true; } },
  }).run(f.runnerInput), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED");
  assert.equal(queries, 1); assert.equal(owned.size, 0);
  const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_transitions").get()!.n, 4n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_parity_reports").get()!.n, 0n);
  } finally { connection.close(); }
});

test("Task11F runner phase lost native commit response retains unknown and later invocation adopts", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  let phaseWrite = false, injected = false, failedRollback = 0, proofAttempts = 0, laterWrites = 0;
  const transaction = SqliteV2ShadowMigrationRepository.prototype.transact;
  t.mock.method(SqliteV2ShadowMigrationRepository.prototype, "transact", function<T>(this: SqliteV2ShadowMigrationRepository,
    ...args: Parameters<typeof transaction<T>>) { if (injected) proofAttempts++; return transaction.call(this, ...args); });
  class CommitLoss extends DatabaseSync {
    override prepare(sql: string): StatementSync {
      if (injected && /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) laterWrites++;
      if (/^INSERT INTO v2_shadow_migration_transitions\b/i.test(sql)) phaseWrite = true;
      return super.prepare(sql);
    }
    override exec(sql: string): void {
      try { super.exec(sql); } catch (error) { if (injected && sql === "ROLLBACK") failedRollback++; throw error; }
      if (sql === "COMMIT" && phaseWrite && !injected) { injected = true; throw new Error("native committed response lost"); }
    }
  }
  await assert.rejects(new V2ShadowMigrationRunner({ driver: new NodeSqliteDriver({ DatabaseSync: CommitLoss }), utcNow: () => f.manifest.createdAt }).run(f.runnerInput),
    error => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN");
  assert.equal(injected, true);
  assert.equal(failedRollback, 1, "actual ROLLBACK fails after the successful native COMMIT");
  assert.equal(proofAttempts, 1, "one checked proof attempt on the now-unusable repository");
  assert.equal(laterWrites, 0, "no semantic or attempt repair after unknown proof");
  const connection = f.driver.open(f.eventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    const phases = new SqliteV2ShadowMigrationRepository(connection).readVerifiedTransitions(f.runnerInput.projectId, f.sealedPackage.migrationIdentity);
    assert.deepEqual(phases.map(phase => phase.ordinal), [0]);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM events").get()!.n, 0n);
  } finally { connection.close(); }
  const resumed = await new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt }).run(f.runnerInput);
  assert.equal(resumed.status, "compatibility-complete");
});

test("Task11F read-only source transient retries retain sealed bounds and one abort signal", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  for (const code of ["EBUSY", "EAGAIN", "EINTR", "WORKER_INTERRUPTED"]) {
    let hits = 0, now = 0;
    const sleeps: number[] = [], signals: AbortSignal[] = [];
    let failure: unknown;
    try { await new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt, monotonicNow: () => now,
      sleep: async (milliseconds, signal) => { sleeps.push(milliseconds); signals.push(signal); assert.equal(signal.aborted, false); now += milliseconds; },
      faultInjector: { hit(boundary) { if (boundary === "after-source-verified") { hits++; throw Object.assign(new Error("private transient"), { code }); } } },
    }).run(f.runnerInput); } catch (error) { failure = error; }
    assert.ok(failure instanceof ShadowMigrationError);
    assert.equal(failure.code, "MIGRATION_RETRY_EXHAUSTED", code);
    assert.equal(hits, f.policy.maxRetries + 1, code);
    assert.deepEqual(sleeps, [500, 1000, 2000], code);
    assert.ok(signals.every(signal => signal === signals[0]));
    assert.equal(signals[0]!.aborted, true, "the single invocation timer is disposed on failure");
    const attempts = readV2ShadowMigrationPreflightEvidence(failure)!.attempts;
    assert.deepEqual(attempts.map(attempt => attempt.operationAttemptIndex), [0, 1, 2, 3]);
    assert.deepEqual(attempts.map(attempt => attempt.outcomeCategory), ["retryable-failure", "retryable-failure", "retryable-failure", "retry-exhausted"]);
    assert.deepEqual(readdirSync(f.runnerInput.packageRoot), []);
  }
});

test("Task11F source close expiry retains pre-mutation classification and closes real scratch", async t => {
  const f = await createShadowMigrationRunnerFixture(t);
  let now = 0, closed = 0, sourcePath = "";
  const driver: SqliteDriver = { open(path, options) {
    const connection = f.driver.open(path, options);
    if (path === f.eventStorePath) return connection;
    sourcePath = path;
    return { prepare: sql => connection.prepare(sql), exec: sql => connection.exec(sql), close() { connection.close(); closed++; now = f.policy.deadlineMs; } };
  } };
  await assert.rejects(new V2ShadowMigrationRunner({ driver, monotonicNow: () => now, utcNow: () => f.manifest.createdAt }).run(f.runnerInput),
    error => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED");
  assert.equal(closed, 1);
  assert.notEqual(sourcePath, f.eventStorePath);
  assert.equal(existsSync(sourcePath), false);
  assert.deepEqual(readdirSync(f.runnerInput.packageRoot), []);
});

test("Task11F parity awaited callback rechecks retained projection image authority", async t => {
  const f = await createSnapshotParityFixture(t);
  const phases = f.phases();
  await assert.rejects(compareV1V2Snapshots({ ...f.input, faultInjector: { async hit() {
    await nextTurn();
    appendFileSync(f.input.projections.v1.generation.databasePath, "changed-during-await");
  } } }), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
  assert.deepEqual(f.phases(), phases);
  assert.notEqual(f.storedReport(), null);
  f.source.assertUnchanged(); f.sealedPackage.assertUnchanged();
});

test("Task11F actual pending V1 lease settles after expiry and closes without report or phase work", async t => {
  const f = await createSnapshotParityFixture(t);
  let now = 0, entered!: () => void, release!: () => void, closed = 0, settled = false;
  const deadline = createShadowMigrationInvocationDeadline(f.policy.deadlineMs, () => now);
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = DefaultProjectionBuildCoordinator.prototype.leasePublished;
  t.mock.method(DefaultProjectionBuildCoordinator.prototype, "leasePublished", async function(this: DefaultProjectionBuildCoordinator, ...args: Parameters<typeof original>) {
    const lease = await original.apply(this, args);
    entered(); await held;
    return Object.freeze({ ...lease, close() { closed++; lease.close(); } });
  });
  const phases = f.phases();
  const pending = compareV1V2Snapshots({ ...f.input, invocationDeadline: deadline }).then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
  try {
    await reached; now = f.policy.deadlineMs; await nextTurn();
    assert.equal(settled, false, "cooperative timeout does not cancel an outstanding native lease");
    assert.equal(closed, 0); assert.equal(f.storedReport(), null); assert.deepEqual(f.phases(), phases);
    release(); const result = await pending;
    assert.ok("error" in result && result.error instanceof ShadowMigrationError);
    assert.equal(result.error.code, "MIGRATION_RETRY_EXHAUSTED");
    assert.equal(closed, 1); assert.equal(f.storedReport(), null); assert.deepEqual(f.phases(), phases);
  } finally { release(); await pending; deadline.dispose(); }
});

for (const component of ["projection", "parity"] as const) for (const outcome of ["reject", "expire"] as const) {
  test(`Task11F ${component} durable boundary awaits ${outcome}`, async t => {
    const f = await createSnapshotParityFixture(t);
    let now = 0, entered!: () => void, release!: () => void, reject!: (error: Error) => void;
    const deadline = createShadowMigrationInvocationDeadline(300000, () => now);
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>((resolve, rejected) => { release = resolve; reject = rejected; });
    void held.catch(() => {});
    const before = f.phases();
    const hook = () => { entered(); return held; };
    let settled = false;
    const invocation = component === "parity"
      ? compareV1V2Snapshots({ ...f.input, invocationDeadline: deadline, faultInjector: { hit: hook } })
      : new V2ShadowProjectionPublisher({ ...f.input, faultInjector: { hit: boundary => boundary === "before-v2-integrity" ? hook() : undefined } })
        .publishV2({ ...f.input, invocationDeadline: deadline });
    const observed = invocation.then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
    try {
      await reached; await nextTurn();
      assert.equal(settled, false, "component cannot return before its durable callback settles");
      assert.deepEqual(f.phases(), before, "no subsequent phase while callback is pending");
      if (component === "parity") assert.notEqual(f.storedReport(), null);
      if (outcome === "expire") { now = 300000; release(); } else reject(new Error("redacted-boundary-loss"));
      const result = await observed;
      assert.ok("error" in result && result.error instanceof ShadowMigrationError);
      assert.equal(result.error.code, "MIGRATION_OUTCOME_UNKNOWN");
      assert.deepEqual(f.phases(), before);
      f.source.assertUnchanged(); f.sealedPackage.assertUnchanged();
    } finally { release(); await observed; deadline.dispose(); }
  });
}

for (const outcome of ["reject", "expire"] as const) {
  test(`Task11F package rename awaits ${outcome} before response`, async t => {
    const f = await createV2ShadowMigrationFixture(t);
    const protectedPaths = [f.sourceDatabasePath, f.manifestPath, f.liveEventStorePath];
    const before = protectedPaths.map(path => digest(readFileSync(path)));
    let now = 0;
    const deadline = createShadowMigrationInvocationDeadline(300000, () => now);
    const source = await verifyV1SourceCopy({ ...f.verificationInput, invocationDeadline: deadline });
    let entered!: () => void, release!: () => void, reject!: (error: Error) => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>((resolve, rejectPromise) => { release = resolve; reject = rejectPromise; });
    // Catch locally as well: the pre-fix producer ignores this promise.
    void held.catch(() => {});
    let settled = false;
    const pending = sealV2MigrationPackage({ ...f.packageInput, source, packageRoot: f.packageRootA, invocationDeadline: deadline,
      onPhase: point => { if (point === "after-final-rename-before-response") { entered(); return held; } } });
    const observed = pending.then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
    try {
      await reached;
      await nextTurn();
      assert.equal(readdirSync(f.packageRootA).filter(name => /^[0-9a-f]{64}$/u.test(name)).length, 1);
      assert.equal(settled, false, "published package must not return while its boundary callback is pending");
      if (outcome === "expire") { now = 300000; release(); } else reject(new Error("private-path-payload-must-not-escape"));
      const result = await observed;
      assert.ok("error" in result && result.error instanceof ShadowMigrationError);
      assert.equal(result.error.code, "MIGRATION_OUTCOME_UNKNOWN");
      assert.deepEqual(protectedPaths.map(path => digest(readFileSync(path))), before);
    } finally {
      release();
      const result = await observed;
      if ("result" in result) result.result.close();
      source.close(); deadline.dispose();
    }
  });
}

test("Task11F adopted package rejected await preserves a typed primary failure through expired cleanup", async t => {
  const f = await createV2ShadowMigrationFixture(t);
  let now = 0;
  const deadline = createShadowMigrationInvocationDeadline(f.policy.deadlineMs, () => now);
  const source = await verifyV1SourceCopy({ ...f.verificationInput, invocationDeadline: deadline });
  const input = { ...f.packageInput, source, packageRoot: f.packageRootA, invocationDeadline: deadline };
  (await sealV2MigrationPackage(input)).close();
  try {
    await assert.rejects(sealV2MigrationPackage({ ...input, onPhase: async point => {
      if (point === "existing-target-final-open") { await nextTurn(); now = f.policy.deadlineMs; throw new ShadowMigrationError("MIGRATION_SOURCE_MUTATED"); }
    } }), error => error instanceof ShadowMigrationError && error.code === "MIGRATION_SOURCE_MUTATED");
  } finally { source.close(); deadline.dispose(); }
});
