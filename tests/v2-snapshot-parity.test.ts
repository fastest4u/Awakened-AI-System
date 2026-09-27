import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ShadowMigrationError } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { shadowMigrationPhaseMetadata } from "../src/orchestrator/migration/v2-shadow-migration-runtime.js";
import { V2ImportedProjectionEventReader } from "../src/orchestrator/migration/v2-imported-event-reader.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { decodeExpectedDifferenceRuleV1, expectedDifferenceRuleChecksum, type ExpectedDifferenceRuleV1 } from "../src/orchestrator/parity/v2-expected-difference.js";
import { authenticateSealedRetrievalSource, compareV1V2Snapshots, parityRowIdentityHash, reconcileV1V2Snapshots, serializeSnapshotParityReport, snapshotParityReportChecksum, type SnapshotParityReportV1 } from "../src/orchestrator/parity/v2-snapshot-parity.js";
import { createSnapshotParityFixture, createV2ShadowMigrationFixture } from "./support/v2-shadow-migration-fixture.js";
import type { SqliteConnection, SqliteDriver, SqliteStatement } from "../src/orchestrator/storage/sqlite-driver.js";
import { InternalRetrievalService } from "../src/orchestrator/retrieval/service.js";
import { V2SqliteRetrievalCandidateRepository } from "../src/orchestrator/retrieval/v2-candidates.js";
import { V2ProjectionBuildCoordinator } from "../src/orchestrator/projections/coordinator.js";
import type { V2ProjectionReaderLease } from "../src/orchestrator/projections/v2-reader-lease.js";
import { SqliteV2ShadowMigrationRepository, type StoredExpectedDifferenceRule, type V2ShadowMigrationTransaction } from "../src/orchestrator/storage/v2-shadow-migration.repository.js";
import { parseSealedRetrievalEvaluationBundle, type RetrievalEvaluationQueryV1, type SealedRetrievalEvaluationCorpusV2 } from "../src/orchestrator/retrieval/evaluation.js";

function approvedRule(): ExpectedDifferenceRuleV1 {
  const body = { schemaVersion: 1 as const, ruleId: "rule-1", policyVersion: 1,
    category: "semantic-value" as const, projection: "canonicalItems" as const,
    rowIdentityHash: "1".repeat(64), fieldPath: "summary",
    predicate: { operator: "exact-value-hashes" as const, v1ValueHash: "2".repeat(64), v2ValueHash: "3".repeat(64) },
    rationaleDigest: "4".repeat(64), approverFingerprint: "5".repeat(64), approvalReferenceDigest: "6".repeat(64),
    issuedAt: "2026-09-10T00:00:00.000Z", expiresAt: "2026-09-12T00:00:00.000Z",
    rolloutRevisionId: "11111111-1111-4111-8111-111111111111", migrationIdentity: "7".repeat(64) };
  return { ...body, ruleChecksum: createHash("sha256").update("project-memory/v2-expected-difference-rule/v1\n" + canonicalJson(body)).digest("hex") };
}

function independentlyReseal(rule: ExpectedDifferenceRuleV1): ExpectedDifferenceRuleV1 {
  const { ruleChecksum: _, ...body } = rule;
  return { ...body, ruleChecksum: createHash("sha256").update("project-memory/v2-expected-difference-rule/v1\n" + canonicalJson(body)).digest("hex") };
}

function resealCorpus(
  corpus: SealedRetrievalEvaluationCorpusV2,
  sources: SealedRetrievalEvaluationCorpusV2["sources"],
  queries: readonly RetrievalEvaluationQueryV1[],
): SealedRetrievalEvaluationCorpusV2 {
  const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const sourceArtifact = { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", sources };
  const judgments = { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", queries };
  const baseline = { ...corpus.baseline, judgmentsSha256: sha256(queries) };
  return parseSealedRetrievalEvaluationBundle({
    schemaVersion: 2,
    corpusVersion: "retrieval-evaluation-v2",
    files: {
      "source-events.json": sha256(sourceArtifact),
      "judgments.json": sha256(judgments),
      "v1-shadow-baseline.json": sha256(baseline),
    },
  }, sourceArtifact, judgments, baseline);
}

const invalidRule = (error: unknown) => error instanceof ShadowMigrationError && error.code === "PARITY_RULE_INVALID";

function reportBody(): Omit<SnapshotParityReportV1, "reportChecksum"> {
  return { schemaVersion: 1, rolloutRevisionId: "11111111-1111-4111-8111-111111111111", migrationIdentity: "a".repeat(64),
    packageChecksum: "b".repeat(64), comparedEventPosition: 9007199254740993n, comparedEventHash: "c".repeat(64),
    v1ManifestChecksum: "d".repeat(64), v2ManifestChecksum: "e".repeat(64), v1CoreChecksumsDigest: "f".repeat(64),
    v2CoreChecksumsDigest: "1".repeat(64), comparisonPolicyVersion: 1, equalCount: 1, expectedDifferenceCount: 0,
    blockingDivergenceCount: 0, findings: [], matchedRuleIds: [], sealedRetrieval: { corpusVersion: "retrieval-evaluation-v2",
      queryCount: 1, v1ThresholdsPassed: true, v2ThresholdsPassed: true, equalCount: 1, expectedDifferenceCount: 0,
      blockingDivergenceCount: 0, resultVectorChecksum: "2".repeat(64) } };
}

function replaceProductionParityReport(
  fixture: Awaited<ReturnType<typeof createSnapshotParityFixture>>,
  report: Omit<SnapshotParityReportV1, "reportChecksum">,
): void {
  const reportChecksum = snapshotParityReportChecksum(report);
  const storedJson = serializeSnapshotParityReport({ ...report, reportChecksum });
  const { reportChecksum: _checksum, ...storedBody } = storedJson;
  const phase4 = fixture.repository.transact(
    fixture.projectionBinding.projectId,
    fixture.sealedPackage.migrationIdentity,
    tx => tx.readTransitions()[4]!,
  );
  const { transitionHash: _transitionHash, ...phaseBody } = phase4;
  const rewrittenPhase = { ...phaseBody, evidenceDigest: reportChecksum };
  const transitionHash = createHash("sha256")
    .update("project-memory/v2-shadow-migration-transition/v1\n" + canonicalJson(rewrittenPhase))
    .digest("hex");
  const reportTrigger = fixture.connection.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='v2_shadow_parity_reports_no_update'",
  ).get()!;
  const phaseTrigger = fixture.connection.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='v2_shadow_migration_transitions_no_update'",
  ).get()!;
  fixture.connection.exec("DROP TRIGGER v2_shadow_parity_reports_no_update");
  fixture.connection.exec("DROP TRIGGER v2_shadow_migration_transitions_no_update");
  try {
    fixture.connection.prepare(`
      UPDATE v2_shadow_parity_reports
      SET report_id=$checksum, report_json=$report, report_checksum=$checksum
      WHERE project_id=$project AND migration_identity=$migration
    `).run({
      $checksum: reportChecksum,
      $report: canonicalJson(storedBody),
      $project: fixture.projectionBinding.projectId,
      $migration: fixture.sealedPackage.migrationIdentity,
    });
    fixture.connection.prepare(`
      UPDATE v2_shadow_migration_transitions
      SET evidence_digest=$evidence, transition_hash=$transition
      WHERE project_id=$project AND migration_identity=$migration AND ordinal=4
    `).run({
      $evidence: reportChecksum,
      $transition: transitionHash,
      $project: fixture.projectionBinding.projectId,
      $migration: fixture.sealedPackage.migrationIdentity,
    });
  } finally {
    fixture.connection.exec(String(reportTrigger.sql));
    fixture.connection.exec(String(phaseTrigger.sql));
  }
}

async function reconcileReadOnly(
  connection: SqliteConnection,
  input: Parameters<typeof reconcileV1V2Snapshots>[0],
): ReturnType<typeof reconcileV1V2Snapshots> {
  const retrieve = InternalRetrievalService.prototype.retrieve;
  let retrievals = 0;
  const changesBefore = connection.prepare("SELECT total_changes() AS count").get()!.count;
  InternalRetrievalService.prototype.retrieve = async function (...args) {
    retrievals += 1;
    return retrieve.apply(this, args);
  };
  try {
    return await reconcileV1V2Snapshots(input);
  } finally {
    InternalRetrievalService.prototype.retrieve = retrieve;
    assert.equal(retrievals, 0);
    assert.equal(connection.prepare("SELECT total_changes() AS count").get()!.count, changesBefore);
  }
}

function storedRule(
  fixture: Awaited<ReturnType<typeof createSnapshotParityFixture>>,
  rule: ExpectedDifferenceRuleV1,
): StoredExpectedDifferenceRule {
  const { schemaVersion: _, projection, rowIdentityHash, fieldPath, ...governance } = rule;
  return Object.freeze({
    projectId: fixture.projectionBinding.projectId,
    ...governance,
    projectionName: projection,
    selector: Object.freeze({ rowIdentityHash, fieldPath }),
  });
}

function appendProductionPhase4(
  fixture: Awaited<ReturnType<typeof createSnapshotParityFixture>>,
  override: Readonly<{ attemptId?: string; recordedAt?: string }> = {},
): void {
  fixture.repository.transact(
    fixture.projectionBinding.projectId,
    fixture.sealedPackage.migrationIdentity,
    tx => {
      const phases = tx.readTransitions();
      const metadata = shadowMigrationPhaseMetadata(
        fixture.sealedPackage.migrationIdentity,
        fixture.manifest.createdAt,
        4,
      );
      const transition = {
        projectId: fixture.projectionBinding.projectId,
        migrationIdentity: fixture.sealedPackage.migrationIdentity,
        ordinal: 4,
        attemptId: override.attemptId ?? metadata.attemptId,
        phase: "parity-complete" as const,
        priorTransitionHash: phases[3]!.transitionHash,
        evidenceDigest: createHash("sha256").update("partial-parity-evidence").digest("hex"),
        recordedAt: override.recordedAt ?? metadata.recordedAt,
      };
      tx.appendTransition({
        ...transition,
        transitionHash: createHash("sha256")
          .update("project-memory/v2-shadow-migration-transition/v1\n" + canonicalJson(transition))
          .digest("hex"),
      });
    },
  );
}

test("authenticates the complete sealed retrieval source without slicing its queries", async t => {
  const fixture = await createSnapshotParityFixture(t);
  const authenticated = authenticateSealedRetrievalSource(fixture.corpus, fixture.input.source);
  assert.equal(authenticated.queries.length, fixture.corpus.queries.length);
  assert.deepEqual(authenticated, fixture.corpus);

  const wrongSource = {
    ...fixture.input.source,
    projectionSnapshot: {
      ...fixture.input.source.projectionSnapshot,
      binding: { ...fixture.input.source.projectionSnapshot.binding, projectId: "00000000-0000-4000-8000-000000000001" },
    },
  } as typeof fixture.input.source;
  assert.throws(() => authenticateSealedRetrievalSource(fixture.corpus, wrongSource));
  assert.throws(() => authenticateSealedRetrievalSource(
    { ...fixture.corpus, queries: fixture.corpus.queries.slice(1) },
    fixture.input.source,
  ));
  const alteredEvent = {
    ...fixture.corpus.sources[0]!.events[0]!,
    eventHash: "0".repeat(64),
  };
  const eventRebound = resealCorpus(fixture.corpus, [{
    ...fixture.corpus.sources[0]!,
    events: [alteredEvent, ...fixture.corpus.sources[0]!.events.slice(1)],
  }], fixture.corpus.queries);
  assert.throws(() => authenticateSealedRetrievalSource(eventRebound, fixture.input.source));

  const queryRebound = resealCorpus(fixture.corpus, fixture.corpus.sources, [{
    ...fixture.corpus.queries[0]!,
    eligibleScope: {
      ...fixture.corpus.queries[0]!.eligibleScope,
      projectId: "00000000-0000-4000-8000-000000000001",
    },
  }, ...fixture.corpus.queries.slice(1)]);
  assert.throws(() => authenticateSealedRetrievalSource(queryRebound, fixture.input.source));
});

test("expires during owned corpus descriptor traversal before validating the remaining tail", async t => {
  const fixture = await createSnapshotParityFixture(t);
  let armed = false;
  let armedChecks = 0;
  let tailGetterCalls = 0;
  const source = {
    ...fixture.input.source,
    assertUnchanged() {
      fixture.input.source.assertUnchanged();
      armed = true;
    },
  } as typeof fixture.input.source;
  const deadline = {
    signal: new AbortController().signal,
    remainingMs() {
      if (armed && ++armedChecks > 15) throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
      return 1000;
    },
  };
  const invalidLateCorpus = { ...fixture.corpus };
  Object.defineProperty(invalidLateCorpus, "baseline", {
    configurable: true,
    enumerable: true,
    get() {
      tailGetterCalls += 1;
      return fixture.corpus.baseline;
    },
  });
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const visitedDescriptors: PropertyKey[] = [];
  Object.getOwnPropertyDescriptor = ((object: object, propertyKey: PropertyKey) => {
    if (object === invalidLateCorpus) visitedDescriptors.push(propertyKey);
    return getOwnPropertyDescriptor(object, propertyKey);
  }) as typeof Object.getOwnPropertyDescriptor;
  const retrieve = InternalRetrievalService.prototype.retrieve;
  let retrievals = 0;
  InternalRetrievalService.prototype.retrieve = async function (...args) {
    retrievals += 1;
    return retrieve.apply(this, args);
  };
  const changesBefore = fixture.connection.prepare("SELECT total_changes() AS count").get()!.count;

  let caught: unknown;
  try {
    authenticateSealedRetrievalSource(invalidLateCorpus as typeof fixture.corpus, source, deadline);
  } catch (error) {
    caught = error;
  } finally {
    InternalRetrievalService.prototype.retrieve = retrieve;
    Object.getOwnPropertyDescriptor = getOwnPropertyDescriptor;
  }
  assert.deepEqual(visitedDescriptors, ["bundle"]);
  assert(caught instanceof ShadowMigrationError);
  assert.equal(caught.code, "MIGRATION_RETRY_EXHAUSTED");
  assert.equal(armedChecks, 16);
  assert.equal(tailGetterCalls, 0);
  assert.equal(retrievals, 0);
  assert.equal(fixture.connection.prepare("SELECT total_changes() AS count").get()!.count, changesBefore);
});

test("expires during owned rule-array traversal before decoding the remaining tail", async t => {
  const fixture = await createSnapshotParityFixture(t, { artifactMetadata: true });
  let armed = false;
  let armedChecks = 0;
  let tailGetterCalls = 0;
  const source = {
    ...fixture.input.source,
    assertUnchanged() {
      fixture.input.source.assertUnchanged();
      armed = true;
    },
  } as typeof fixture.input.source;
  const deadline = {
    signal: new AbortController().signal,
    remainingMs() {
      if (armed && ++armedChecks > 3) throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
      return 1000;
    },
  };
  const valid = fixture.metadataRules[0]!;
  const invalidLateRules = [valid, valid];
  Object.defineProperty(invalidLateRules, "1", {
    configurable: true,
    enumerable: true,
    get() {
      tailGetterCalls += 1;
      return valid;
    },
  });
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const visitedDescriptors: PropertyKey[] = [];
  Object.getOwnPropertyDescriptor = ((object: object, propertyKey: PropertyKey) => {
    if (object === invalidLateRules) visitedDescriptors.push(propertyKey);
    return getOwnPropertyDescriptor(object, propertyKey);
  }) as typeof Object.getOwnPropertyDescriptor;
  const retrieve = InternalRetrievalService.prototype.retrieve;
  let retrievals = 0;
  InternalRetrievalService.prototype.retrieve = async function (...args) {
    retrievals += 1;
    return retrieve.apply(this, args);
  };
  const changesBefore = fixture.connection.prepare("SELECT total_changes() AS count").get()!.count;

  let caught: unknown;
  try {
    await compareV1V2Snapshots({
      ...fixture.input,
      source,
      rules: invalidLateRules,
      invocationDeadline: deadline,
    });
  } catch (error) {
    caught = error;
  } finally {
    InternalRetrievalService.prototype.retrieve = retrieve;
    Object.getOwnPropertyDescriptor = getOwnPropertyDescriptor;
  }
  assert.deepEqual(visitedDescriptors, ["0"]);
  assert(caught instanceof ShadowMigrationError);
  assert.equal(caught.code, "MIGRATION_RETRY_EXHAUSTED");
  assert.equal(armedChecks, 4);
  assert.equal(tailGetterCalls, 0);
  assert.equal(retrievals, 0);
  assert.equal(fixture.connection.prepare("SELECT total_changes() AS count").get()!.count, changesBefore);
  assert.equal(fixture.storedReport(), null);
  assert.equal(fixture.phases().at(-1), "projection-verified");
});

test("reconciles absent, report-only unknown, fresh adoption, and deterministic committed parity read-only", async t => {
  const fixture = await createSnapshotParityFixture(t);
  const retrieve = InternalRetrievalService.prototype.retrieve;
  let reconciliationRetrievals = 0;
  InternalRetrievalService.prototype.retrieve = async function (...args) {
    reconciliationRetrievals += 1;
    return retrieve.apply(this, args);
  };
  try {
    const changesBefore = fixture.connection.prepare("SELECT total_changes() AS count").get()!.count;
    assert.deepEqual(await reconcileV1V2Snapshots(fixture.input), { status: "absent" });
    assert.equal(reconciliationRetrievals, 0);
    assert.equal(fixture.connection.prepare("SELECT total_changes() AS count").get()!.count, changesBefore);
  } finally {
    InternalRetrievalService.prototype.retrieve = retrieve;
  }

  const transact = SqliteV2ShadowMigrationRepository.prototype.transact;
  let transactionCalls = 0;
  let proofRetrievals = 0;
  InternalRetrievalService.prototype.retrieve = async function (...args) {
    proofRetrievals += 1;
    return retrieve.apply(this, args);
  };
  SqliteV2ShadowMigrationRepository.prototype.transact = function (this: SqliteV2ShadowMigrationRepository, ...args) {
    transactionCalls += 1;
    if (transactionCalls === 3) throw new Error("parity-read-failure");
    return transact.apply(this, args);
  } as typeof SqliteV2ShadowMigrationRepository.prototype.transact;
  try {
    const changesBefore = fixture.connection.prepare("SELECT total_changes() AS count").get()!.count;
    assert.deepEqual(await reconcileV1V2Snapshots(fixture.input), {
      status: "unknown",
      safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN",
    });
    assert.equal(transactionCalls, 3);
    assert.equal(proofRetrievals, 0);
    assert.equal(fixture.connection.prepare("SELECT total_changes() AS count").get()!.count, changesBefore);
  } finally {
    SqliteV2ShadowMigrationRepository.prototype.transact = transact;
    InternalRetrievalService.prototype.retrieve = retrieve;
  }

  await assert.rejects(
    compareV1V2Snapshots({
      ...fixture.input,
      runStartedAt: "2026-09-10T12:00:00.000Z",
      faultInjector: { hit(boundary) { assert.equal(boundary, "after-report-before-phase4"); throw new Error("lost-report-response"); } },
    }),
    (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN",
  );
  assert.ok(fixture.storedReport());
  assert.equal(fixture.phases().at(-1), "projection-verified");
  assert.deepEqual(await reconcileReadOnly(fixture.connection, fixture.input), {
    status: "unknown",
    safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN",
  });

  const adopted = await compareV1V2Snapshots({ ...fixture.input, runStartedAt: "2026-09-10T13:00:00.000Z" });
  const committed = await reconcileReadOnly(fixture.connection, fixture.input);
  assert.equal(committed.status, "committed");
  if (committed.status !== "committed") throw new Error("unreachable");
  assert.deepEqual(committed.result, adopted);
  assert.equal(Object.isFrozen(committed.result), true);
  const phase4 = fixture.repository.transact(fixture.projectionBinding.projectId, fixture.sealedPackage.migrationIdentity,
    tx => tx.readTransitions()[4]!);
  const expected = shadowMigrationPhaseMetadata(fixture.sealedPackage.migrationIdentity, fixture.manifest.createdAt, 4);
  assert.equal(fixture.storedReport()!.recordedAt, expected.recordedAt);
  assert.equal(phase4.attemptId, expected.attemptId);
  assert.equal(phase4.recordedAt, expected.recordedAt);

  const trigger = fixture.connection.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='v2_shadow_migration_transitions_no_update'").get()!;
  fixture.connection.exec("DROP TRIGGER v2_shadow_migration_transitions_no_update");
  try {
    fixture.connection.prepare("UPDATE v2_shadow_migration_transitions SET attempt_id=$a WHERE ordinal=4")
      .run({ $a: "00000000-0000-4000-8000-000000000004" });
  } finally { fixture.connection.exec(String(trigger.sql)); }
  await assert.rejects(reconcileReadOnly(fixture.connection, fixture.input),
    (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
});

test("rejects checksum-valid committed reports whose authenticated claims contradict their columns or thresholds", async t => {
  const fixture = await createSnapshotParityFixture(t);
  const valid = await compareV1V2Snapshots(fixture.input);
  const { reportChecksum: _, ...validBody } = valid;
  const retrieve = InternalRetrievalService.prototype.retrieve;
  let reconciliationRetrievals = 0;
  InternalRetrievalService.prototype.retrieve = async function (...args) {
    reconciliationRetrievals += 1;
    return retrieve.apply(this, args);
  };
  try {
    const contradictions: readonly Omit<SnapshotParityReportV1, "reportChecksum">[] = [
      { ...validBody, v1CoreChecksumsDigest: "0".repeat(64) },
      {
        ...validBody,
        sealedRetrieval: { ...validBody.sealedRetrieval, v2ThresholdsPassed: false },
      },
    ];
    for (const contradiction of contradictions) {
      replaceProductionParityReport(fixture, contradiction);
      const changesBefore = fixture.connection.prepare("SELECT total_changes() AS count").get()!.count;
      await assert.rejects(
        reconcileV1V2Snapshots(fixture.input),
        (error: unknown) => error instanceof ShadowMigrationError
          && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE",
      );
      assert.equal(reconciliationRetrievals, 0);
      assert.equal(fixture.connection.prepare("SELECT total_changes() AS count").get()!.count, changesBefore);
    }
  } finally {
    InternalRetrievalService.prototype.retrieve = retrieve;
  }
});

test("covers the read-only reconciliation matrix for partial, contradictory, deterministic, and expired evidence", async t => {
  const partial = await createSnapshotParityFixture(t, { artifactMetadata: true });
  const storedRules = partial.metadataRules.map(rule => storedRule(partial, rule));
  partial.repository.transact(
    partial.projectionBinding.projectId,
    partial.sealedPackage.migrationIdentity,
    tx => tx.insertExpectedDifferenceRules(storedRules.slice(0, 1)),
  );
  assert.deepEqual(await reconcileReadOnly(partial.connection, {
    ...partial.input,
    rules: partial.metadataRules,
  }), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });

  partial.repository.transact(
    partial.projectionBinding.projectId,
    partial.sealedPackage.migrationIdentity,
    tx => tx.insertExpectedDifferenceRules(storedRules.slice(1)),
  );
  assert.deepEqual(await reconcileReadOnly(partial.connection, {
    ...partial.input,
    rules: partial.metadataRules,
  }), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });

  appendProductionPhase4(partial);
  assert.deepEqual(await reconcileReadOnly(partial.connection, {
    ...partial.input,
    rules: partial.metadataRules,
  }), { status: "unknown", safeErrorCode: "MIGRATION_OUTCOME_UNKNOWN" });

  const contradictoryRules = partial.metadataRules.map((rule, index) => index === 1
    ? independentlyReseal({ ...rule, rationaleDigest: "0".repeat(64) })
    : rule);
  await assert.rejects(
    reconcileReadOnly(partial.connection, { ...partial.input, rules: contradictoryRules }),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE",
  );

  let armed = false;
  let armedChecks = 0;
  const deadline = {
    signal: new AbortController().signal,
    remainingMs() {
      if (armed && ++armedChecks > 4) throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
      return 1000;
    },
  };
  const transact = SqliteV2ShadowMigrationRepository.prototype.transact;
  SqliteV2ShadowMigrationRepository.prototype.transact = function <T>(
    this: SqliteV2ShadowMigrationRepository,
    projectId: string,
    migrationIdentity: string,
    callback: (tx: V2ShadowMigrationTransaction) => T,
  ): T {
    return transact.call(this, projectId, migrationIdentity, tx => callback(Object.freeze({
      ...tx,
      readExpectedDifferenceRules() {
        const rules = tx.readExpectedDifferenceRules();
        armed = true;
        return rules;
      },
    }) as V2ShadowMigrationTransaction)) as T;
  };
  try {
    assert.deepEqual(await reconcileReadOnly(partial.connection, {
      ...partial.input,
      rules: contradictoryRules,
      invocationDeadline: deadline,
    }), { status: "unknown", safeErrorCode: "MIGRATION_RETRY_EXHAUSTED" });
    assert.equal(armedChecks, 5);
  } finally {
    SqliteV2ShadowMigrationRepository.prototype.transact = transact;
  }

  const deterministic = await createSnapshotParityFixture(t);
  appendProductionPhase4(deterministic, {
    attemptId: "00000000-0000-4000-8000-000000000099",
    recordedAt: "2026-09-10T00:00:00.001Z",
  });
  await assert.rejects(
    reconcileReadOnly(deterministic.connection, deterministic.input),
    (error: unknown) => error instanceof ShadowMigrationError
      && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE",
  );
});

test("shared expiry after retrieval and before evidence writes leaves parity evidence absent", async t => {
  const fixture = await createSnapshotParityFixture(t);
  const retrieve = InternalRetrievalService.prototype.retrieve;
  let retrievals = 0;
  let expired = false;
  const deadline = {
    signal: new AbortController().signal,
    remainingMs() {
      if (expired) throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
      return 1000;
    },
  };
  const nativeOpens: { path: string; busyTimeoutMs: number }[] = [];
  const driver: SqliteDriver = {
    open(path, options) {
      nativeOpens.push({ path, busyTimeoutMs: options.busyTimeoutMs });
      return fixture.input.driver.open(path, options);
    },
  };
  InternalRetrievalService.prototype.retrieve = async function (...args) {
    const result = await retrieve.apply(this, args);
    retrievals += 1;
    if (retrievals === fixture.corpus.queries.length * 4) expired = true;
    return result;
  };
  try {
    await assert.rejects(compareV1V2Snapshots({ ...fixture.input, driver, invocationDeadline: deadline }),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED");
  } finally {
    InternalRetrievalService.prototype.retrieve = retrieve;
  }
  assert.equal(retrievals, fixture.corpus.queries.length * 4);
  assert.ok(nativeOpens.some(item => item.path === fixture.input.eventStorePath && item.busyTimeoutMs === 1000));
  assert.equal(fixture.storedReport(), null);
  assert.equal(fixture.phases().at(-1), "projection-verified");
  const storedRules = fixture.repository.transact(fixture.projectionBinding.projectId, fixture.sealedPackage.migrationIdentity,
    tx => tx.readExpectedDifferenceRules());
  assert.deepEqual(storedRules, []);
});

test("classifies expiry at each evidence transaction boundary without late writes", async t => {
  const transact = SqliteV2ShadowMigrationRepository.prototype.transact;
  const deadlineState = () => {
    let expired = false;
    return {
      expire() { expired = true; },
      deadline: {
        signal: new AbortController().signal,
        remainingMs() {
          if (expired) throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
          return 1000;
        },
      },
    };
  };

  const entry = await createSnapshotParityFixture(t);
  const entryDeadline = deadlineState();
  let entryTransactions = 0;
  SqliteV2ShadowMigrationRepository.prototype.transact = function (this: SqliteV2ShadowMigrationRepository, ...args) {
    entryTransactions += 1;
    if (entryTransactions === 2) entryDeadline.expire();
    return transact.apply(this, args);
  } as typeof SqliteV2ShadowMigrationRepository.prototype.transact;
  try {
    await assert.rejects(
      compareV1V2Snapshots({ ...entry.input, invocationDeadline: entryDeadline.deadline }),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED",
    );
  } finally {
    SqliteV2ShadowMigrationRepository.prototype.transact = transact;
  }
  assert.equal(entry.storedReport(), null);
  assert.equal(entry.phases().at(-1), "projection-verified");

  const reportRead = await createSnapshotParityFixture(t);
  const reportDeadline = deadlineState();
  let reportTransactions = 0;
  SqliteV2ShadowMigrationRepository.prototype.transact = function <T>(
    this: SqliteV2ShadowMigrationRepository,
    projectId: string,
    migrationIdentity: string,
    callback: (tx: V2ShadowMigrationTransaction) => T,
  ): T {
    reportTransactions += 1;
    if (reportTransactions !== 3) return transact.call(this, projectId, migrationIdentity, callback) as T;
    return transact.call(this, projectId, migrationIdentity, tx => callback(Object.freeze({
      ...tx,
      readParityReport() {
        const report = tx.readParityReport();
        reportDeadline.expire();
        return report;
      },
    }) as V2ShadowMigrationTransaction)) as T;
  };
  try {
    await assert.rejects(
      compareV1V2Snapshots({ ...reportRead.input, invocationDeadline: reportDeadline.deadline }),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED",
    );
  } finally {
    SqliteV2ShadowMigrationRepository.prototype.transact = transact;
  }
  assert.equal(reportRead.storedReport(), null);
  assert.equal(reportRead.phases().at(-1), "projection-verified");

  const phaseRead = await createSnapshotParityFixture(t);
  const phaseDeadline = deadlineState();
  let phaseTransactions = 0;
  SqliteV2ShadowMigrationRepository.prototype.transact = function <T>(
    this: SqliteV2ShadowMigrationRepository,
    projectId: string,
    migrationIdentity: string,
    callback: (tx: V2ShadowMigrationTransaction) => T,
  ): T {
    phaseTransactions += 1;
    if (phaseTransactions !== 4) return transact.call(this, projectId, migrationIdentity, callback) as T;
    let reads = 0;
    return transact.call(this, projectId, migrationIdentity, tx => callback(Object.freeze({
      ...tx,
      readTransitions() {
        const phases = tx.readTransitions();
        reads += 1;
        if (reads === 2) phaseDeadline.expire();
        return phases;
      },
    }) as V2ShadowMigrationTransaction)) as T;
  };
  try {
    await assert.rejects(
      compareV1V2Snapshots({ ...phaseRead.input, invocationDeadline: phaseDeadline.deadline }),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_OUTCOME_UNKNOWN",
    );
  } finally {
    SqliteV2ShadowMigrationRepository.prototype.transact = transact;
  }
  assert.ok(phaseRead.storedReport());
  assert.equal(phaseRead.phases().at(-1), "projection-verified");

  const betweenRules = await createSnapshotParityFixture(t, { artifactMetadata: true });
  const ruleDeadline = deadlineState();
  let ruleTransactions = 0;
  SqliteV2ShadowMigrationRepository.prototype.transact = function <T>(
    this: SqliteV2ShadowMigrationRepository,
    projectId: string,
    migrationIdentity: string,
    callback: (tx: V2ShadowMigrationTransaction) => T,
  ): T {
    ruleTransactions += 1;
    if (ruleTransactions !== 2) return transact.call(this, projectId, migrationIdentity, callback) as T;
    let inserts = 0;
    return transact.call(this, projectId, migrationIdentity, tx => callback(Object.freeze({
      ...tx,
      insertExpectedDifferenceRules(rules: Parameters<V2ShadowMigrationTransaction["insertExpectedDifferenceRules"]>[0]) {
        tx.insertExpectedDifferenceRules(rules);
        inserts += 1;
        if (inserts === 1) ruleDeadline.expire();
      },
    }) as V2ShadowMigrationTransaction)) as T;
  };
  try {
    await assert.rejects(
      compareV1V2Snapshots({
        ...betweenRules.input,
        rules: betweenRules.metadataRules,
        invocationDeadline: ruleDeadline.deadline,
      }),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED",
    );
  } finally {
    SqliteV2ShadowMigrationRepository.prototype.transact = transact;
  }
  const storedRules = betweenRules.repository.transact(
    betweenRules.projectionBinding.projectId,
    betweenRules.sealedPackage.migrationIdentity,
    tx => tx.readExpectedDifferenceRules(),
  );
  assert.deepEqual(storedRules, []);
  assert.equal(betweenRules.storedReport(), null);
  assert.equal(betweenRules.phases().at(-1), "projection-verified");
});

test("closes an acquired imported snapshot when the shared deadline expires after acquisition", async t => {
  const fixture = await createSnapshotParityFixture(t);
  const open = V2ImportedProjectionEventReader.prototype.openCommittedSnapshot;
  let expired = false;
  let closes = 0;
  V2ImportedProjectionEventReader.prototype.openCommittedSnapshot = async function (...args) {
    const snapshot = await open.apply(this, args);
    expired = true;
    return Object.freeze({
      ...snapshot,
      events: () => snapshot.events(),
      close() { closes += 1; snapshot.close(); },
    });
  };
  t.after(() => { V2ImportedProjectionEventReader.prototype.openCommittedSnapshot = open; });
  const deadline = {
    signal: new AbortController().signal,
    remainingMs() {
      if (expired) throw new ShadowMigrationError("MIGRATION_RETRY_EXHAUSTED");
      return 1000;
    },
  };

  await assert.rejects(compareV1V2Snapshots({ ...fixture.input, invocationDeadline: deadline }),
    (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_RETRY_EXHAUSTED");
  assert.equal(closes, 1);
});

test("serializes large event positions as exact decimal and binds only the redacted body", () => {
  const body = reportBody();
  const expected = createHash("sha256").update(canonicalJson({ ...body, comparedEventPosition: "9007199254740993" })).digest("hex");
  assert.equal(snapshotParityReportChecksum(body), expected);
  const json = serializeSnapshotParityReport({ ...body, reportChecksum: expected });
  assert.equal(json.comparedEventPosition, "9007199254740993");
  assert.equal(json.reportChecksum, expected);
  assert.equal(JSON.stringify(json).includes("9007199254740993"), true);
  assert.equal(Object.isFrozen(json.sealedRetrieval), true);
  assert.equal(snapshotParityReportChecksum(reportBody()), expected);
});

test("report serializer rejects extra fields, caller accessors, and a mismatched checksum", () => {
  const body = reportBody();
  let reads = 0;
  Object.defineProperty(body, "packageChecksum", { enumerable: true, get() { reads++; return "b".repeat(64); } });
  assert.throws(() => snapshotParityReportChecksum(body));
  assert.equal(reads, 0);
  assert.throws(() => snapshotParityReportChecksum({ ...reportBody(), plaintext: "sensitive" } as ReturnType<typeof reportBody>));
  assert.throws(() => serializeSnapshotParityReport({ ...reportBody(), reportChecksum: "0".repeat(64) }));
  const classification = { toString() { reads++; return "PARITY_EQUAL"; } };
  assert.throws(() => snapshotParityReportChecksum({ ...reportBody(), findings: [{ schemaVersion: 1, classification,
    category: "representation", projection: "artifactsFiles", rowIdentityHash: "1".repeat(64), fieldPathHash: "2".repeat(64),
    v1ValueHash: "3".repeat(64), v2ValueHash: "4".repeat(64), ruleId: null }] } as unknown as ReturnType<typeof reportBody>));
  assert.equal(reads, 0);
});

test("caps report samples at128 while permitting larger full counts and rejecting inconsistent classes", () => {
  const finding = { schemaVersion: 1 as const, classification: "PARITY_EQUAL" as const, category: "representation", projection: "artifactsFiles" as const,
    rowIdentityHash: "1".repeat(64), fieldPathHash: "2".repeat(64), v1ValueHash: "3".repeat(64), v2ValueHash: "3".repeat(64), ruleId: null };
  const body = { ...reportBody(), equalCount: 1000, findings: Array.from({ length: 128 }, () => finding) };
  assert.equal(serializeSnapshotParityReport({ ...body, reportChecksum: snapshotParityReportChecksum(body) }).findings.length, 128);
  assert.throws(() => snapshotParityReportChecksum({ ...body, findings: [...body.findings, finding] }));
  assert.throws(() => snapshotParityReportChecksum({ ...body, equalCount: 0 }));
});

test("compares authenticated pinned generations and persists deterministic redacted evidence", async t => {
  const pin = V2ProjectionBuildCoordinator.prototype.leasePublishedForEvaluation;
  const leases: V2ProjectionReaderLease[] = [];
  let failAfterClose = false;
  V2ProjectionBuildCoordinator.prototype.leasePublishedForEvaluation = async function(...args) {
    const lease = await pin.apply(this, args); leases.push(lease);
    if (failAfterClose) {
      const close = lease.database.close.bind(lease.database);
      lease.database.close = () => { close(); throw new Error("sensitive-close-failure-sentinel"); };
    }
    return lease;
  };
  t.after(() => { V2ProjectionBuildCoordinator.prototype.leasePublishedForEvaluation = pin; });
  const f = await createSnapshotParityFixture(t);
  t.diagnostic(JSON.stringify({ chosenQueryIds: f.chosenQueryIds, sourceEventCount: f.manifest.eventCount, identityMapping: f.identityMapping,
    baselineMetrics: f.corpus.baseline.metrics }));
  assert.equal(f.manifest.eventCount, 504);
  const protectedBytes = readFileSync(f.liveEventStorePath);
  await assert.rejects(compareV1V2Snapshots({ ...f.input, eventStorePath: f.liveEventStorePath }));
  assert.deepEqual(readFileSync(f.liveEventStorePath), protectedBytes);
  // Keep the valid target pathname: this refusal must reach the actual main
  // connection identity, not the earlier protected-root or later schema guards.
  const other = await createV2ShadowMigrationFixture(t);
  const wrong = other.driver.open(other.liveEventStorePath, { mode: "existing", busyTimeoutMs: 5000, bindFileIdentity: true });
  try {
    const databaseState = (connection: SqliteConnection) => connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(({ name }) => [name, connection.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all()
        .map(row => JSON.stringify(row, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)).sort()]);
    const beforeTarget = databaseState(f.connection), beforeWrong = databaseState(wrong);
    const changesBefore = wrong.prepare("SELECT total_changes() AS count").get()!.count;
    await assert.rejects(compareV1V2Snapshots({ ...f.input, connection: wrong }),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
    await assert.rejects(reconcileReadOnly(wrong, { ...f.input, connection: wrong }),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
    assert.equal(wrong.prepare("SELECT total_changes() AS count").get()!.count, changesBefore);
    assert.deepEqual(databaseState(wrong), beforeWrong);
    assert.deepEqual(databaseState(f.connection), beforeTarget);
    const calls: string[] = [];
    const forwarded: SqliteConnection = {
      exec(sql) { calls.push(`exec:${sql}`); wrong.exec(sql); },
      close() { calls.push("close"); wrong.close(); },
      prepare(sql) {
        calls.push(`prepare:${sql}`);
        const statement = wrong.prepare(sql);
        return Object.fromEntries((["all", "get", "run", "iterate"] as const).map(method => [method,
          (...args: Parameters<SqliteStatement[typeof method]>) => { calls.push(`${method}:${sql}`); return statement[method](...args); },
        ])) as unknown as SqliteStatement;
      },
    };
    await assert.rejects(compareV1V2Snapshots({ ...f.input, connection: forwarded }),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
    assert.deepEqual(calls, []);
    await assert.rejects(reconcileReadOnly(wrong, { ...f.input, connection: forwarded }),
      (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
    assert.deepEqual(calls, []);
    assert.equal(wrong.prepare("SELECT total_changes() AS count").get()!.count, changesBefore);
    assert.deepEqual(databaseState(wrong), beforeWrong);
    assert.deepEqual(databaseState(f.connection), beforeTarget);
    assert.equal(f.storedReport(), null);
    assert.equal(f.phases().at(-1), "projection-verified");
  } finally { wrong.close(); }
  await assert.rejects(compareV1V2Snapshots({ ...f.input, sealedRetrieval: { corpus: { ...f.corpus, queries: f.corpus.queries.slice(1) } } }));
  assert.ok(f.storedReport() === null, "an unsealed corpus must fail before report writes");
  const validRule = f.metadataRules[0]!;
  for (const changed of [{ policyVersion: 2 }, { issuedAt: "2026-09-10T00:00:00.001Z" },
    { expiresAt: f.manifest.createdAt }, { issuedAt: "2026-09-02T00:00:00.000Z" },
    { rolloutRevisionId: "22222222-2222-4222-8222-222222222222" }, { migrationIdentity: "8".repeat(64) }]) {
    const rule = independentlyReseal({ ...validRule, ...changed });
    await assert.rejects(compareV1V2Snapshots({ ...f.input, rules: [rule] }), invalidRule);
    assert.equal(f.storedReport(), null);
  }
  const report = await compareV1V2Snapshots(f.input).catch(error => {
    const stored = f.storedReport();
    if (stored) t.diagnostic(JSON.stringify({ rowCounts: [stored.equalCount, stored.expectedDifferenceCount, stored.blockingDivergenceCount],
      retrieval: stored.report.sealedRetrieval, blocked: (stored.report.findings as { classification: string }[]).filter(finding => finding.classification === "PARITY_BLOCKING_DIVERGENCE") }));
    throw error;
  });
  assert.ok(report.equalCount > 0);
  assert.ok(report.equalCount > 128);
  assert.ok(report.findings.length <= 128);
  assert.equal(report.blockingDivergenceCount, 0);
  assert.equal(report.expectedDifferenceCount, 0);
  assert.equal(report.findings.find(finding => finding.projection === "canonicalItems")?.rowIdentityHash,
    parityRowIdentityHash("canonicalItems", { project_id: f.projectionBinding.projectId, item_id: "90000000-0000-4000-8000-000000000001" }));
  assert.equal(report.sealedRetrieval.queryCount, 10);
  assert.equal(report.sealedRetrieval.v1ThresholdsPassed, true);
  assert.equal(report.sealedRetrieval.v2ThresholdsPassed, true);
  assert.equal(report.sealedRetrieval.blockingDivergenceCount, 0);
  assert.equal(leases.length, 1);
  assert.throws(() => leases[0]!.database.prepare("SELECT 1"), "the original V2 lease closes after successful parity");
  const repeated = await compareV1V2Snapshots(f.input);
  assert.deepEqual(repeated, report);
  assert.equal(f.phases().at(-1), "parity-complete");
  const stored = f.storedReport()!;
  const { reportChecksum, ...body } = serializeSnapshotParityReport(report);
  assert.deepEqual(stored.report, body);
  assert.equal(stored.reportChecksum, reportChecksum);
  assert.equal(JSON.stringify(stored.report).includes("Synthetic source"), false);
  assert.equal(JSON.stringify(body).includes(f.corpus.queries[0]!.queryText), false);
  const tamper = () => f.connection.prepare("UPDATE v2_shadow_parity_reports SET equal_count=equal_count+1").run();
  assert.throws(tamper, /V2_SHADOW_IMMUTABLE/);
  // Simulate offline corruption only after proving the production write guard.
  const trigger = f.connection.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='v2_shadow_parity_reports_no_update'").get()!;
  f.connection.exec("DROP TRIGGER v2_shadow_parity_reports_no_update");
  try { tamper(); } finally { f.connection.exec(String(trigger.sql)); }
  failAfterClose = true;
  await assert.rejects(compareV1V2Snapshots(f.input), (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
  for (const lease of leases) assert.throws(() => lease.database.prepare("SELECT 1"));
});

test("governs each real absent-null artifact field while verifying complete checkpoint history", async t => {
  const f = await createSnapshotParityFixture(t, { artifactMetadata: true, checkpointHistory: true });
  assert.equal(f.manifest.eventCount, 505);
  assert.deepEqual(f.sourceEvents.slice(0, 4).map(event => [event.eventType, event.globalPosition, event.streamVersion]),
    [["SessionStarted", 1n, 1n], ["SessionCheckpointRecorded", 2n, 2n], ["SessionCheckpointRecorded", 3n, 3n], ["MemorySourceRecorded", 4n, 4n]]);
  assert.ok(f.corpus.queries.every(query => query.eligibleScope.knownAt === "505" && query.eligibleScope.requiredEventPosition === "505"));
  const duplicate = independentlyReseal({ ...f.metadataRules[0]!, ruleId: "duplicate-rule" });
  await assert.rejects(compareV1V2Snapshots({ ...f.input, rules: [...f.metadataRules, duplicate] }), invalidRule);
  assert.equal(f.storedReport(), null);
  const report = await compareV1V2Snapshots({ ...f.input, rules: f.metadataRules });
  assert.equal(report.expectedDifferenceCount, 3);
  assert.equal(report.blockingDivergenceCount, 0);
  assert.equal(report.sealedRetrieval.blockingDivergenceCount, 0);
  assert.equal(report.matchedRuleIds.length, 3);
  assert.equal(report.findings.filter(finding => finding.classification === "PARITY_EXPECTED_DIFFERENCE").length, 3);
  assert.ok(report.findings.length <= 128);
  assert.equal(JSON.stringify(serializeSnapshotParityReport(report)).includes(f.plaintextSentinel), false);
  const changesBeforeNoOp = f.connection.prepare("SELECT total_changes() AS count").get()!.count;
  assert.deepEqual(await compareV1V2Snapshots({ ...f.input, rules: f.metadataRules }), report);
  assert.equal(f.connection.prepare("SELECT total_changes() AS count").get()!.count, changesBeforeNoOp);
  const proof = await reconcileReadOnly(f.connection, { ...f.input, rules: f.metadataRules });
  assert.equal(proof.status, "committed");
  const changesBeforeInvalidResume = f.connection.prepare("SELECT total_changes() AS count").get()!.count;
  await assert.rejects(compareV1V2Snapshots({ ...f.input, rules: f.metadataRules, runStartedAt: f.metadataRules[0]!.expiresAt }), invalidRule);
  await assert.rejects(reconcileReadOnly(f.connection, {
    ...f.input,
    rules: f.metadataRules,
    runStartedAt: "2026-09-09T23:59:59.999Z",
  }), invalidRule);
  await assert.rejects(reconcileReadOnly(f.connection, {
    ...f.input,
    rules: f.metadataRules,
    runStartedAt: f.metadataRules[0]!.expiresAt,
  }), invalidRule);
  const tooOld = f.metadataRules.map(rule => independentlyReseal({
    ...rule,
    issuedAt: "2026-09-02T00:00:00.000Z",
    expiresAt: "2026-09-20T00:00:00.000Z",
  }));
  await assert.rejects(reconcileReadOnly(f.connection, { ...f.input, rules: tooOld }), invalidRule);
  assert.equal(f.connection.prepare("SELECT total_changes() AS count").get()!.count, changesBeforeInvalidResume);
});

test("persists a blocking metadata report without advancing the ledger", async t => {
  const f = await createSnapshotParityFixture(t, { artifactMetadata: true });
  await assert.rejects(compareV1V2Snapshots(f.input), (error: unknown) => error instanceof ShadowMigrationError && error.code === "PARITY_BLOCKING_DIVERGENCE");
  assert.equal(f.storedReport()!.blockingDivergenceCount, 3);
  assert.equal((f.storedReport()!.report.findings as { classification: string }[]).filter(finding => finding.classification === "PARITY_BLOCKING_DIVERGENCE").length, 3);
  assert.equal(f.phases().at(-1), "projection-verified");
  await assert.rejects(reconcileReadOnly(f.connection, f.input),
    (error: unknown) => error instanceof ShadowMigrationError && error.code === "MIGRATION_LEDGER_INTEGRITY_FAILURE");
});

for (const drift of ["result", "citation", "failure"] as const) {
  test(`sealed retrieval ${drift} drift remains blocking even with approved metadata rules`, async t => {
    const f = await createSnapshotParityFixture(t, { artifactMetadata: true });
    const collect = V2SqliteRetrievalCandidateRepository.prototype.collectEligible;
    const retrieve = InternalRetrievalService.prototype.retrieve;
    const pin = V2ProjectionBuildCoordinator.prototype.leasePublishedForEvaluation;
    const leases: V2ProjectionReaderLease[] = [];
    V2ProjectionBuildCoordinator.prototype.leasePublishedForEvaluation = async function (...args) {
      const lease = await pin.apply(this, args); leases.push(lease); return lease;
    };
    const v2Services = new WeakSet<InternalRetrievalService>();
    let current: InternalRetrievalService | undefined;
    let calls = 0;
    V2SqliteRetrievalCandidateRepository.prototype.collectEligible = function (lease, request) {
      assert.equal(lease.manifest.schemaVersion, 2);
      assert.ok(leases.includes(lease), "the adapter must receive the original verified lease unchanged");
      assert.equal(Object.hasOwn(lease, "databasePath"), false);
      if (current) v2Services.add(current);
      calls++;
      return collect.call(this, lease, request);
    };
    InternalRetrievalService.prototype.retrieve = async function (request) {
      current = this;
      const value = await retrieve.call(this, request);
      current = undefined;
      if (!v2Services.has(this)) return value;
      if (drift === "failure") throw new Error("sensitive retrieval failure sentinel");
      const items = [...value.items];
      if (items[0]) items[0] = { ...items[0], ...(drift === "citation" ? { anchor: "sensitive/citation-sentinel" } : { status: "superseded" as const }) };
      return { ...value, items };
    };
    try {
      await assert.rejects(compareV1V2Snapshots({ ...f.input, rules: f.metadataRules }),
        (error: unknown) => error instanceof ShadowMigrationError && error.code === "PARITY_BLOCKING_DIVERGENCE");
      const report = f.storedReport()!;
      assert.ok(calls >= f.corpus.queries.length);
      assert.equal(report.expectedDifferenceCount, f.metadataRules.length);
      assert.ok((report.report.sealedRetrieval as { blockingDivergenceCount: number }).blockingDivergenceCount > 0);
      assert.equal(f.phases().at(-1), "projection-verified");
      assert.equal(JSON.stringify(report.report).includes("sentinel"), false);
      assert.equal(leases.length, 1);
      assert.throws(() => leases[0]!.database.prepare("SELECT 1"), "the retained lease must close on blocking results");
    } finally {
      V2SqliteRetrievalCandidateRepository.prototype.collectEligible = collect;
      InternalRetrievalService.prototype.retrieve = retrieve;
      V2ProjectionBuildCoordinator.prototype.leasePublishedForEvaluation = pin;
    }
  });
}

test("sealed retrieval pure ordering drift blocks an unchanged authentic two-item result set", async t => {
  const f = await createSnapshotParityFixture(t, { rankingPair: true });
  const pair = f.rankingPair;
  assert.ok(pair);
  assert.equal(f.manifest.eventCount, 506);
  assert.equal(f.corpus.queries.length, 11);
  assert.deepEqual(pair.v1.items.map(item => item.id).sort(), [...pair.itemIds].sort());
  assert.deepEqual(pair.v2.items.map(item => item.id).sort(), [...pair.itemIds].sort());
  const identity = (items: typeof pair.v1.items) => items.map(item => [item.id, item.anchor, String(item.sourceEventPosition),
    item.projectId, item.workspaceId, item.sessionId, item.status]);
  assert.deepEqual(identity(pair.v1.items), identity(pair.v2.items));
  const collect = V2SqliteRetrievalCandidateRepository.prototype.collectEligible;
  const retrieve = InternalRetrievalService.prototype.retrieve;
  const v2Services = new WeakSet<InternalRetrievalService>();
  let current: InternalRetrievalService | undefined, swaps = 0;
  V2SqliteRetrievalCandidateRepository.prototype.collectEligible = function(lease, request) {
    if (current) v2Services.add(current);
    return collect.call(this, lease, request);
  };
  InternalRetrievalService.prototype.retrieve = async function(request) {
    current = this;
    let value;
    try { value = await retrieve.call(this, request); } finally { current = undefined; }
    if (!v2Services.has(this) || request.query !== pair.queryText) return value;
    assert.equal(value.items.length, 2);
    assert.notEqual(value.items[0]!.id, value.items[1]!.id);
    const items = [value.items[1]!, value.items[0]!];
    assert.deepEqual(identity(items).sort(), identity(value.items).sort());
    swaps++;
    return { ...value, items };
  };
  try {
    await assert.rejects(compareV1V2Snapshots(f.input), (error: unknown) => error instanceof ShadowMigrationError && error.code === "PARITY_BLOCKING_DIVERGENCE");
    assert.ok(swaps >= 2, "both absolute evaluation and ordered parity must execute the real pair query");
    const report = f.storedReport()!;
    const retrieval = report.report.sealedRetrieval as { v1ThresholdsPassed: boolean; v2ThresholdsPassed: boolean };
    assert.equal(retrieval.v1ThresholdsPassed, true);
    assert.equal(retrieval.v2ThresholdsPassed, true);
    assert.equal(report.blockingDivergenceCount, 0);
    const queryHash = createHash("sha256").update(pair.queryId).digest("hex");
    const fieldHash = createHash("sha256").update("project-memory/v2-parity-field/v1\nretrieval-result").digest("hex");
    const findings = report.report.findings as { classification: string; rowIdentityHash: string; fieldPathHash: string; v1ValueHash: string; v2ValueHash: string }[];
    assert.ok(findings.some(finding => finding.classification === "PARITY_BLOCKING_DIVERGENCE" && finding.rowIdentityHash === queryHash
      && finding.fieldPathHash === fieldHash && finding.v1ValueHash !== finding.v2ValueHash));
    assert.equal(f.phases().at(-1), "projection-verified");
  } finally {
    V2SqliteRetrievalCandidateRepository.prototype.collectEligible = collect;
    InternalRetrievalService.prototype.retrieve = retrieve;
  }
});

test("authenticates the entire governed envelope and freezes its predicate", () => {
  const input = approvedRule();
  const decoded = decodeExpectedDifferenceRuleV1(input);
  assert.deepEqual(decoded, input);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.predicate), true);
  const { ruleChecksum, ...body } = input;
  assert.equal(expectedDifferenceRuleChecksum(body), ruleChecksum);
  for (const [field, replacement] of Object.entries({ rationaleDigest: "8".repeat(64), approverFingerprint: "8".repeat(64),
    approvalReferenceDigest: "8".repeat(64), ruleId: "rule-2", policyVersion: 2,
    issuedAt: "2026-09-09T00:00:00.000Z", expiresAt: "2026-09-13T00:00:00.000Z",
    migrationIdentity: "8".repeat(64), rolloutRevisionId: "22222222-2222-4222-8222-222222222222" })) {
    assert.throws(() => decodeExpectedDifferenceRuleV1({ ...input, [field]: replacement }), invalidRule);
  }
});

test("never permits a rule to normalize authority or core checksum", () => {
  for (const category of ["identity", "authority", "scope", "event-chain-integrity", "privacy", "erasure",
    "duplicate-event", "lost-event", "ordering", "terminal-position", "terminal-hash", "core-checksum", "plaintext-leakage"]) {
    assert.throws(() => decodeExpectedDifferenceRuleV1(independentlyReseal({ ...approvedRule(), category } as ExpectedDifferenceRuleV1)), invalidRule);
  }
});

test("rejects wildcard, unknown, authority, executable and prototype selectors", () => {
  for (const fieldPath of ["*", "summary.*", "summary..text", "summary[0]", "__proto__", "constructor", "summary()",
    "source_event_id", "project_id", "session_id", "anchor", "unknown", "status", "valid_from"]) {
    assert.throws(() => decodeExpectedDifferenceRuleV1(independentlyReseal({ ...approvedRule(), fieldPath })), invalidRule);
  }
});

test("rejects accessors and extra keys without executing caller code", () => {
  let reads = 0;
  const input = approvedRule();
  Object.defineProperty(input, "rationaleDigest", { enumerable: true, get() { reads++; return "4".repeat(64); } });
  assert.throws(() => decodeExpectedDifferenceRuleV1(input), invalidRule);
  assert.equal(reads, 0);
  assert.throws(() => decodeExpectedDifferenceRuleV1({ ...approvedRule(), extra: null }), invalidRule);
  const { ruleChecksum: _, ...body } = approvedRule();
  assert.throws(() => expectedDifferenceRuleChecksum({ ...body, extra: null } as typeof body), invalidRule);
});
