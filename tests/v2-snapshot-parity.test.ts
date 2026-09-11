import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ShadowMigrationError } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { decodeExpectedDifferenceRuleV1, expectedDifferenceRuleChecksum, type ExpectedDifferenceRuleV1 } from "../src/orchestrator/parity/v2-expected-difference.js";
import { compareV1V2Snapshots, parityRowIdentityHash, serializeSnapshotParityReport, snapshotParityReportChecksum, type SnapshotParityReportV1 } from "../src/orchestrator/parity/v2-snapshot-parity.js";
import { createSnapshotParityFixture } from "./support/v2-shadow-migration-fixture.js";
import { InternalRetrievalService } from "../src/orchestrator/retrieval/service.js";
import { V2SqliteRetrievalCandidateRepository } from "../src/orchestrator/retrieval/v2-candidates.js";
import { V2ProjectionBuildCoordinator } from "../src/orchestrator/projections/coordinator.js";
import type { V2ProjectionReaderLease } from "../src/orchestrator/projections/v2-reader-lease.js";

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
});

test("persists a blocking metadata report without advancing the ledger", async t => {
  const f = await createSnapshotParityFixture(t, { artifactMetadata: true });
  await assert.rejects(compareV1V2Snapshots(f.input), (error: unknown) => error instanceof ShadowMigrationError && error.code === "PARITY_BLOCKING_DIVERGENCE");
  assert.equal(f.storedReport()!.blockingDivergenceCount, 3);
  assert.equal((f.storedReport()!.report.findings as { classification: string }[]).filter(finding => finding.classification === "PARITY_BLOCKING_DIVERGENCE").length, 3);
  assert.equal(f.phases().at(-1), "projection-verified");
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
