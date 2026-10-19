import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { EventIntegrityService } from "../src/orchestrator/integrity/event-integrity.service.js";
import { OperationalKeyCustodyProvider } from "../src/orchestrator/keys/operational-key-custody.js";
import {
  openEvidenceItem,
  sealEvidenceItem,
  type EvidenceItemBindingV1,
} from "../src/orchestrator/privacy/evidence-envelope.js";
import { RetainedEvidenceError } from "../src/orchestrator/privacy/evidence-contracts.js";
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import { V2ProjectionBuildCoordinator } from "../src/orchestrator/projections/coordinator.js";
import {
  GOVERNED_NOTE_ERASED_MARKER,
  GOVERNED_NOTE_V1_MARKERS,
  GOVERNED_NOTE_V2_MARKERS,
  validateGovernedNoteProjectionRows,
  type ProjectBinding,
} from "../src/orchestrator/projections/contracts.js";
import { SqliteProjectionEventReader } from "../src/orchestrator/projections/event-reader.js";
import { ProjectionFoldAccumulatorV3 } from "../src/orchestrator/projections/folds.js";
import { ProjectionIntegrityService } from "../src/orchestrator/projections/integrity.js";
import {
  collectEligibleFromProjectionDatabase,
  getCanonicalFromProjectionDatabase,
  getGovernedNoteFromProjectionDatabase,
} from "../src/orchestrator/retrieval/database-core.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import {
  GovernedLifecycleError,
  GovernedLifecycleService,
} from "../src/orchestrator/governance/governance.service.js";
import { makeGovernedNoteDomainFixture } from "./support/governed-note-domain-fixture.js";

function toProjectionBinding(fixture: Awaited<ReturnType<typeof makeGovernedNoteDomainFixture>>): ProjectBinding {
  const b = fixture.rootContext.binding;
  return Object.freeze({
    projectId: b.projectId,
    vaultId: b.vaultId,
    storeId: b.storeId,
    workspaceId: b.workspaceId,
    branchScopeId: fixture.rootContext.branchScopeId ?? null,
    branchRef: fixture.rootContext.workspace.kind === "git" ? fixture.rootContext.workspace.branchRef : null,
    sessionId: null,
  });
}

function buildCoordinator(
  fixture: Awaited<ReturnType<typeof makeGovernedNoteDomainFixture>>,
  projectionDirectory: string,
): {
  readonly coordinator: V2ProjectionBuildCoordinator;
  readonly integrity: ProjectionIntegrityService;
  readonly driver: NodeSqliteDriver;
  readonly binding: ProjectBinding;
} {
  const b = fixture.rootContext.binding;
  mkdirSync(dirname(b.descriptorPath), { recursive: true });
  writeFileSync(
    b.descriptorPath,
    JSON.stringify({
      schemaVersion: 1,
      projectId: b.projectId,
      vaultId: b.vaultId,
      createdAt: "2026-10-19T12:00:00.000Z",
    }),
    "utf8",
  );
  mkdirSync(dirname(b.storeRoute.storeManifestPath), { recursive: true });
  writeFileSync(
    b.storeRoute.storeManifestPath,
    JSON.stringify({
      schemaVersion: 1,
      storeId: b.storeId,
      projectId: b.projectId,
      vaultId: b.vaultId,
      createdAt: "2026-10-19T12:00:00.000Z",
      lastIntegrity: { status: "never" },
    }),
    "utf8",
  );
  mkdirSync(projectionDirectory, { recursive: true });
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const binding = toProjectionBinding(fixture);
  const eventReader = new SqliteProjectionEventReader({
    driver,
    eventStorePath: fixture.retained.path,
  });
  const builder = new ImmutableProjectionBuilder({
    driver,
    projectionDirectory,
    now: () => "2026-10-19T12:00:00.000Z",
  });
  const integrity = new ProjectionIntegrityService({
    driver,
    projectionDirectory,
    eventStorePath: fixture.retained.path,
  });
  const coordinator = new V2ProjectionBuildCoordinator({
    eventReader,
    builder,
    schema3: { eventReader, builder },
    projectionDirectory,
    now: () => Date.now(),
  });
  return { coordinator, integrity, driver, binding };
}

test("governed_lifecycle_promotion_and_verification_policy_enforcement", async () => {
  const fixture = await makeGovernedNoteDomainFixture();
  try {
    const sessionId = fixture.retained.rootAuthority.sessionId;
    assert.equal(GOVERNED_NOTE_V1_MARKERS.has("governed-note-test-verified-v1"), true);
    assert.equal(GOVERNED_NOTE_V2_MARKERS.has("governed-note-test-verified-v2"), true);
    assert.equal(GOVERNED_NOTE_ERASED_MARKER, "governed-note-erased-v1");

    const normalInsightCmd = fixture.commandV2({
      recordKind: "insight",
      summary: "Prefer deterministic sorting in pure projection helpers",
      content: { format: "markdown", body: "# Sorting Insight\n\nDeterministic sorting prevents flaky diffs.\n" },
    });
    const normalInsight = fixture.service().createV2(
      fixture.prepareCreateV2(normalInsightCmd),
      fixture.rootContext,
    ).response;

    const securityInsightCmd = fixture.commandV2({
      recordKind: "insight",
      summary: "[security] Enforce constant-time HMAC comparison on auth tokens",
      content: { format: "markdown", body: "# Security Insight\n\nUse timingSafeEqual for all auth checks.\n" },
    });
    const securityInsight = fixture.service().createV2(
      fixture.prepareCreateV2(securityInsightCmd),
      fixture.rootContext,
    ).response;

    const adrCmd = fixture.commandV2({
      recordKind: "adr",
      summary: "ADR: Keep Projection Schema 3 immutable and sidecar-free",
      content: { format: "markdown", body: "# ADR\n\nUse rollback journal mode and verify SHA-256.\n" },
    });
    const adrNote = fixture.service().createV2(
      fixture.prepareCreateV2(adrCmd),
      fixture.rootContext,
    ).response;

    const governance = new GovernedLifecycleService({
      connection: fixture.connection,
      context: fixture.rootContext,
    });

    // 1. Promote candidate insight -> provisional -> verified with test-verified
    const provisionalReceipt = governance.promote({
      commandId: "20000000-0000-4000-8000-000000000001",
      idempotencyKey: "promote-insight-provisional",
      sessionId,
      recordId: normalInsight.recordId,
      targetStatus: "provisional",
      verificationMethod: "cross-session-observation",
      verificationAnchor: "session-obs-1",
      occurredAt: "2026-10-19T12:01:00.000Z",
    });
    assert.equal(provisionalReceipt.targetStatus, "provisional");
    assert.equal(provisionalReceipt.verificationMethod, "governed-note-cross-session-v2");
    assert.equal(provisionalReceipt.replayed, false);

    // Idempotent replay of exact same promote command returns replayed: true
    const replayedProvisional = governance.promote({
      commandId: "20000000-0000-4000-8000-000000000001",
      idempotencyKey: "promote-insight-provisional",
      sessionId,
      recordId: normalInsight.recordId,
      targetStatus: "provisional",
      verificationMethod: "cross-session-observation",
      verificationAnchor: "session-obs-1",
      occurredAt: "2026-10-19T12:01:00.000Z",
    });
    assert.equal(replayedProvisional.replayed, true);
    assert.equal(replayedProvisional.eventId, provisionalReceipt.eventId);

    // Promote provisional -> verified with test-verified
    const verifiedInsightReceipt = governance.promote({
      commandId: "20000000-0000-4000-8000-000000000002",
      idempotencyKey: "promote-insight-verified",
      sessionId,
      recordId: normalInsight.recordId,
      targetStatus: "verified",
      verificationMethod: "test-verified",
      verificationAnchor: "tests/v2-governed-lifecycle-mutations.test.ts",
      occurredAt: "2026-10-19T12:02:00.000Z",
    });
    assert.equal(verifiedInsightReceipt.targetStatus, "verified");
    assert.equal(verifiedInsightReceipt.verificationMethod, "governed-note-test-verified-v2");

    // 2. High-risk records (ADR and security-tagged insight) reject cross-session-observation for verified
    assert.throws(
      () =>
        governance.promote({
          commandId: "20000000-0000-4000-8000-000000000003",
          idempotencyKey: "promote-adr-cross-session-denied",
          sessionId,
          recordId: adrNote.recordId,
          targetStatus: "verified",
          verificationMethod: "cross-session-observation",
          verificationAnchor: "repeated-3-times",
          occurredAt: "2026-10-19T12:03:00.000Z",
        }),
      (error: unknown) =>
        error instanceof GovernedLifecycleError && error.code === "GOVERNED_VERIFICATION_POLICY_DENIED",
    );

    assert.throws(
      () =>
        governance.promote({
          commandId: "20000000-0000-4000-8000-000000000004",
          idempotencyKey: "promote-sec-cross-session-denied",
          sessionId,
          recordId: securityInsight.recordId,
          targetStatus: "verified",
          verificationMethod: "cross-session-observation",
          verificationAnchor: "repeated-2-times",
          occurredAt: "2026-10-19T12:03:30.000Z",
        }),
      (error: unknown) =>
        error instanceof GovernedLifecycleError && error.code === "GOVERNED_VERIFICATION_POLICY_DENIED",
    );

    // 3. High-risk ADR succeeds when promoted with accepted-adr
    const verifiedAdrReceipt = governance.promote({
      commandId: "20000000-0000-4000-8000-000000000005",
      idempotencyKey: "promote-adr-accepted",
      sessionId,
      recordId: adrNote.recordId,
      targetStatus: "verified",
      verificationMethod: "accepted-adr",
      verificationAnchor: "docs/superpowers/specs/2026-10-19-v2-production-completion-design.md",
      occurredAt: "2026-10-19T12:04:00.000Z",
    });
    assert.equal(verifiedAdrReceipt.targetStatus, "verified");
    assert.equal(verifiedAdrReceipt.verificationMethod, "governed-note-accepted-adr-v2");

    // 4. Publish Projection Schema 3 and verify folded canonical_items & governed_notes
    const projectionDir = join(fixture.retained.root, "projections-promote");
    const { coordinator, integrity, binding } = buildCoordinator(fixture, projectionDir);
    const published = await coordinator.ensurePublishedV3(binding, verifiedAdrReceipt.globalPosition, 5_000);
    assert.equal(published.manifest.schemaVersion, 3);
    const verifyReport = await integrity.verify(binding, published.manifest);
    assert.equal(verifyReport.status, "passed");

    const eventIntegrity = new EventIntegrityService(fixture.connection).fullCheck(fixture.rootContext);
    assert.deepEqual(eventIntegrity.issues, []);
    assert.equal(eventIntegrity.ok, true);
  } finally {
    await fixture.cleanup();
  }
});

test("governed_lifecycle_supersession_and_conflict_declaration_and_resolution", async () => {
  const fixture = await makeGovernedNoteDomainFixture();
  try {
    const sessionId = fixture.retained.rootAuthority.sessionId;
    const firstAdr = fixture.service().createV2(
      fixture.prepareCreateV2(
        fixture.commandV2({
          recordKind: "adr",
          summary: "ADR v1: Retain 15 minute access token TTL",
          content: { format: "markdown", body: "# ADR v1\n\nTTL is 15 minutes.\n" },
        }),
      ),
      fixture.rootContext,
    ).response;

    const secondAdr = fixture.service().createV2(
      fixture.prepareCreateV2(
        fixture.commandV2({
          recordKind: "adr",
          summary: "ADR v2: Shorten access token TTL to 5 minutes",
          content: { format: "markdown", body: "# ADR v2\n\nTTL is 5 minutes.\n" },
        }),
      ),
      fixture.rootContext,
    ).response;

    const governance = new GovernedLifecycleService({
      connection: fixture.connection,
      context: fixture.rootContext,
    });

    // Declare conflict between firstAdr and secondAdr
    const conflictReceipt = governance.supersede({
      commandId: "31000000-0000-4000-8000-000000000001",
      idempotencyKey: "declare-conflict-ttl",
      sessionId,
      recordId: firstAdr.recordId,
      replacementRecordId: secondAdr.recordId,
      reason: "Conflicting TTL guidance pending architecture review",
      conflictKey: "conflict/access-token-ttl",
      declareConflict: true,
      occurredAt: "2026-10-19T12:10:00.000Z",
    });
    assert.equal(conflictReceipt.targetStatus, "conflicted");
    assert.equal(conflictReceipt.conflictKey, "conflict/access-token-ttl");
    assert.equal(conflictReceipt.resolutionState, "open");
    assert.ok(conflictReceipt.conflictGroupId !== null);

    const openConflict = governance.getConflict("conflict/access-token-ttl");
    assert.ok(openConflict !== null);
    assert.equal(openConflict.resolutionState, "open");
    assert.deepEqual(openConflict.recordIds, [firstAdr.recordId, secondAdr.recordId].sort());

    // Now supersede firstAdr with secondAdr, resolving the conflict
    const supersedeReceipt = governance.supersede({
      commandId: "31000000-0000-4000-8000-000000000002",
      idempotencyKey: "supersede-adr-v1-by-v2",
      sessionId,
      recordId: firstAdr.recordId,
      replacementRecordId: secondAdr.recordId,
      reason: "ADR v2 approved; supersedes ADR v1",
      conflictKey: "conflict/access-token-ttl",
      declareConflict: false,
      resolutionState: "resolved",
      occurredAt: "2026-10-19T12:15:00.000Z",
    });
    assert.equal(supersedeReceipt.targetStatus, "superseded");
    assert.equal(supersedeReceipt.supersededByEventId, supersedeReceipt.eventId);
    assert.equal(supersedeReceipt.supersedingRecordId, secondAdr.recordId);
    assert.equal(supersedeReceipt.resolutionState, "resolved");

    const resolvedConflict = governance.getConflict("conflict/access-token-ttl");
    assert.ok(resolvedConflict !== null);
    assert.equal(resolvedConflict.resolutionState, "resolved");
    assert.equal(resolvedConflict.resolutionEventId, supersedeReceipt.eventId);

    const binding = toProjectionBinding(fixture);
    const reader = new SqliteProjectionEventReader({
      driver: new NodeSqliteDriver({ DatabaseSync }),
      eventStorePath: fixture.retained.path,
    });
    const snapshot = await reader.openCommittedSnapshotV3(binding);
    const accumulator = new ProjectionFoldAccumulatorV3();
    for (const disposition of snapshot.dispositions()) {
      accumulator.append(disposition);
    }
    snapshot.close();

    const state = accumulator.finish();
    const foldedFirst = state.canonicalItems.find((item) => item.itemId === firstAdr.recordId)!;
    assert.equal(foldedFirst.status, "superseded");
    assert.equal(foldedFirst.supersedingItemId, secondAdr.recordId);
    assert.equal(foldedFirst.sourceEventId, supersedeReceipt.eventId);
    assert.equal(foldedFirst.validTo, "2026-10-19T12:15:00.000Z");

    const conflicts = accumulator.canonicalConflicts();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.conflictKey, "conflict/access-token-ttl");
    assert.equal(conflicts[0]!.resolutionState, "resolved");
    assert.equal(conflicts[0]!.resolutionEventId, supersedeReceipt.eventId);
  } finally {
    await fixture.cleanup();
  }
});

test("governed_lifecycle_retraction_and_expiry_exclude_from_default_search", async () => {
  const fixture = await makeGovernedNoteDomainFixture();
  try {
    const sessionId = fixture.retained.rootAuthority.sessionId;
    const mistakeNote = fixture.service().createV2(
      fixture.prepareCreateV2(
        fixture.commandV2({
          recordKind: "mistake",
          summary: "UniqueRetractableToken mistaken diagnosis on retry queue",
          content: { format: "markdown", body: "# Mistake\n\nUniqueRetractableToken details.\n" },
        }),
      ),
      fixture.rootContext,
    ).response;

    const expiringNote = fixture.service().createV2(
      fixture.prepareCreateV2(
        fixture.commandV2({
          recordKind: "insight",
          summary: "UniqueExpiringToken temporary freeze window workaround",
          content: { format: "markdown", body: "# Workaround\n\nUniqueExpiringToken details.\n" },
        }),
      ),
      fixture.rootContext,
    ).response;

    const activeNote = fixture.service().createV2(
      fixture.prepareCreateV2(
        fixture.commandV2({
          recordKind: "insight",
          summary: "UniqueActiveToken durable production rule",
          content: { format: "markdown", body: "# Active Rule\n\nUniqueActiveToken details.\n" },
        }),
      ),
      fixture.rootContext,
    ).response;

    const governance = new GovernedLifecycleService({
      connection: fixture.connection,
      context: fixture.rootContext,
    });

    const retractReceipt = governance.retract({
      commandId: "41000000-0000-4000-8000-000000000001",
      idempotencyKey: "retract-mistake-1",
      sessionId,
      recordId: mistakeNote.recordId,
      reason: "Root cause was actually network DNS timeout",
      occurredAt: "2026-10-19T12:20:00.000Z",
    });
    assert.equal(retractReceipt.targetStatus, "retracted");
    assert.equal(retractReceipt.retractedByEventId, retractReceipt.eventId);

    const expireReceipt = governance.expire({
      commandId: "41000000-0000-4000-8000-000000000002",
      idempotencyKey: "expire-insight-1",
      sessionId,
      recordId: expiringNote.recordId,
      validTo: "2026-10-19T12:25:00.000Z",
      reason: "Freeze window ended",
      occurredAt: "2026-10-19T12:25:00.000Z",
    });
    assert.equal(expireReceipt.targetStatus, "expired");
    assert.equal(expireReceipt.validTo, "2026-10-19T12:25:00.000Z");

    const projectionDir = join(fixture.retained.root, "projections-retract-expire");
    const { coordinator, integrity, binding } = buildCoordinator(fixture, projectionDir);
    const published = await coordinator.ensurePublishedV3(binding, expireReceipt.globalPosition, 5_000);
    const verifyReport = await integrity.verify(binding, published.manifest);
    assert.equal(verifyReport.status, "passed");

    const db = new DatabaseSync(join(projectionDir, published.manifest.databaseFile), { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT item_id, status, valid_to FROM canonical_items ORDER BY item_id")
        .all() as Array<{ item_id: string; status: string; valid_to: string | null }>;
      const byId = new Map(rows.map((r) => [r.item_id, r]));
      assert.equal(byId.get(mistakeNote.recordId)?.status, "retracted");
      assert.equal(byId.get(expiringNote.recordId)?.status, "expired");
      assert.equal(byId.get(expiringNote.recordId)?.valid_to, "2026-10-19T12:25:00.000Z");
      assert.equal(byId.get(activeNote.recordId)?.status, "candidate");

      // Default retrieval excludes retracted and expired items while returning active items
      const retractedSearch = collectEligibleFromProjectionDatabase(db, published.manifest, {
        binding,
        query: "UniqueRetractableToken",
        visibility: "session",
        sessionId,
        limit: 5,
        tokenBudget: 500,
        consistency: { requiredEventPosition: 0n, deadlineMs: 1_000 },
      });
      assert.equal(retractedSearch.eligibleItemCount, 0);

      const expiredSearch = collectEligibleFromProjectionDatabase(db, published.manifest, {
        binding,
        query: "UniqueExpiringToken",
        visibility: "session",
        sessionId,
        limit: 5,
        tokenBudget: 500,
        consistency: { requiredEventPosition: 0n, deadlineMs: 1_000 },
      });
      assert.equal(expiredSearch.eligibleItemCount, 0);

      const activeSearch = collectEligibleFromProjectionDatabase(db, published.manifest, {
        binding,
        query: "UniqueActiveToken",
        visibility: "session",
        sessionId,
        limit: 5,
        tokenBudget: 500,
        consistency: { requiredEventPosition: 0n, deadlineMs: 1_000 },
      });
      assert.equal(activeSearch.eligibleItemCount, 1);
    } finally {
      db.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("governed_lifecycle_forget_evidence_scrubs_projections_and_shreds_custody_envelope", async () => {
  const fixture = await makeGovernedNoteDomainFixture();
  let custody: OperationalKeyCustodyProvider | undefined;
  try {
    const sessionId = fixture.retained.rootAuthority.sessionId;
    const retainedProv = fixture.sources.root.find((s) => s.kind === "retained-evidence")!;
    const retainedEvidenceId = retainedProv.identity;
    const retainedEventId = retainedProv.sourceEventId;

    const storeRoot = join(fixture.retained.root, "custody-store");
    mkdirSync(storeRoot, { recursive: true });
    custody = new OperationalKeyCustodyProvider({
      storeRoot,
      projectId: fixture.rootContext.binding.projectId,
      storeId: fixture.rootContext.binding.storeId,
      masterSeed: Buffer.alloc(32, 0x42),
    });

    // Seal a retained evidence item with OperationalKeyCustodyProvider
    const evidenceBinding: EvidenceItemBindingV1 = {
      formatVersion: 1,
      projectId: fixture.rootContext.binding.projectId,
      vaultId: fixture.rootContext.binding.vaultId,
      storeId: fixture.rootContext.binding.storeId,
      evidenceId: retainedEvidenceId,
      eventId: retainedEventId,
      targetSessionId: sessionId,
      conversationId: "10000000-0000-4000-8000-000000000098",
      frameId: "10000000-0000-4000-8000-000000000099",
      mediaType: "text/plain; charset=utf-8",
      policyId: "policy-v1",
      policyVersion: "1",
    };
    const sealed = sealEvidenceItem(
      evidenceBinding,
      {
        frameId: evidenceBinding.frameId,
        ordinal: "0",
        role: "user",
        category: "user-message",
        occurredAt: "2026-10-19T11:55:00.000Z",
        mediaType: "text/plain; charset=utf-8",
        content: "Sensitive user transcript before privacy erasure",
        previousFrameId: null,
        toolCorrelationId: null,
        artifactHashes: [],
        manifest: [],
      },
      custody.evidence,
    );

    // Create a V2 full-body governed note citing retainedEvidenceId
    const noteCmd = fixture.commandV2({
      recordKind: "insight",
      summary: "SensitiveDerivedSummaryToken derived from retained evidence",
      content: {
        format: "markdown",
        body: "# Secret Derived Insight\n\nSensitiveDerivedBodyToken must be scrubbed on erasure.\n",
      },
    });
    const createdNote = fixture.service().createV2(
      fixture.prepareCreateV2(noteCmd),
      fixture.rootContext,
    ).response;

    const projectionDir = join(fixture.retained.root, "projections-erase");
    const { coordinator, integrity, binding } = buildCoordinator(fixture, projectionDir);

    // Publish before erasure and confirm the full note body is present
    const beforeManifest = (
      await coordinator.ensurePublishedV3(binding, BigInt(createdNote.terminalPosition), 5_000)
    ).manifest;
    const beforeDb = new DatabaseSync(join(projectionDir, beforeManifest.databaseFile), { readOnly: true });
    try {
      const sideRowsBefore = beforeDb
        .prepare("SELECT item_id, body FROM governed_notes WHERE item_id = $id")
        .all({ $id: createdNote.recordId }) as Array<{ item_id: string; body: string | null }>;
      assert.equal(sideRowsBefore.length, 1);
      assert.match(sideRowsBefore[0]!.body ?? "", /SensitiveDerivedBodyToken/);
    } finally {
      beforeDb.close();
    }

    // Execute forgetEvidence
    const governance = new GovernedLifecycleService({
      connection: fixture.connection,
      context: fixture.rootContext,
      custody,
    });
    const eraseReceipt = governance.forgetEvidence({
      commandId: "51000000-0000-4000-8000-000000000001",
      idempotencyKey: "forget-evidence-1",
      sessionId,
      evidenceIds: [retainedEvidenceId],
      reason: "User requested privacy erasure of transcript and derived note",
      occurredAt: "2026-10-19T12:30:00.000Z",
    });

    assert.equal(eraseReceipt.targetStatus, "erased-evidence");
    assert.deepEqual(eraseReceipt.erasedEvidenceIds, [retainedEvidenceId]);
    assert.ok(eraseReceipt.erasedRecordIds.includes(createdNote.recordId));
    assert.equal(eraseReceipt.erasureFences.length, 1);
    assert.equal(custody.isEvidenceErased(retainedEvidenceId), true);

    const activeCustody = custody;
    // 1. Unwrapping the erased evidence key envelope fails with RETAINED_EVIDENCE_KEY_UNAVAILABLE,
    // and openEvidenceItem fails closed
    assert.throws(
      () =>
        activeCustody.evidence.unwrap(
          {
            projectId: fixture.rootContext.binding.projectId,
            storeId: fixture.rootContext.binding.storeId,
          },
          sealed.wrappedKey,
          Buffer.from(canonicalJson(evidenceBinding), "utf8"),
        ),
      (error: unknown) =>
        error instanceof RetainedEvidenceError && error.code === "RETAINED_EVIDENCE_KEY_UNAVAILABLE",
    );
    assert.throws(
      () => openEvidenceItem(evidenceBinding, sealed, activeCustody.evidence),
      (error: unknown) => error instanceof RetainedEvidenceError,
    );

    // 2. Publish Projection Schema 3 after erasure
    const afterPublished = await coordinator.ensurePublishedV3(binding, eraseReceipt.globalPosition, 5_000);
    assert.equal(afterPublished.manifest.schemaVersion, 3);
    const verifyReport = await integrity.verify(binding, afterPublished.manifest);
    assert.equal(verifyReport.status, "passed");

    // 3. EventIntegrityService fullCheck passes
    const eventReport = new EventIntegrityService(fixture.connection).fullCheck(fixture.rootContext);
    assert.equal(eventReport.ok, true);

    // 4. Verify governed_notes side row and lexical_chunks are scrubbed, canonical_items is tombstoned
    const afterDb = new DatabaseSync(join(projectionDir, afterPublished.manifest.databaseFile), { readOnly: true });
    try {
      const sideRowsAfter = afterDb
        .prepare("SELECT item_id FROM governed_notes WHERE item_id = $id")
        .all({ $id: createdNote.recordId });
      assert.equal(sideRowsAfter.length, 0, "governed_notes row must be scrubbed upon erasure");

      const lexicalRowsAfter = afterDb
        .prepare("SELECT chunk_id FROM lexical_chunks WHERE item_id = $id")
        .all({ $id: createdNote.recordId });
      assert.equal(lexicalRowsAfter.length, 0, "lexical_chunks row must be scrubbed upon erasure");

      const canonicalRow = afterDb
        .prepare("SELECT status, summary, verification_method FROM canonical_items WHERE item_id = $id")
        .get({ $id: createdNote.recordId }) as { status: string; summary: string; verification_method: string } | undefined;
      assert.ok(canonicalRow !== undefined);
      assert.equal(canonicalRow.status, "erased-evidence");
      assert.equal(canonicalRow.summary, "[ERASED]");
      assert.equal(canonicalRow.verification_method, GOVERNED_NOTE_ERASED_MARKER);

      // 5. Querying canonical lookup, full note lookup, and search-projected-content returns null / empty
      const canonicalLookup = getCanonicalFromProjectionDatabase(afterDb, afterPublished.manifest, {
        binding,
        visibility: "session",
        sessionId,
        id: createdNote.recordId,
      });
      assert.equal(canonicalLookup.item, null);

      const fullNoteLookup = getGovernedNoteFromProjectionDatabase(
        afterDb,
        afterPublished.manifest,
        binding.projectId,
        createdNote.recordId,
      );
      assert.equal(fullNoteLookup, null);

      const searchAfterErase = collectEligibleFromProjectionDatabase(afterDb, afterPublished.manifest, {
        binding,
        query: "SensitiveDerivedSummaryToken",
        visibility: "session",
        sessionId,
        limit: 5,
        tokenBudget: 500,
        consistency: { requiredEventPosition: 0n, deadlineMs: 1_000 },
      });
      assert.equal(searchAfterErase.eligibleItemCount, 0);

      // 6. validateGovernedNoteProjectionRows rejects if an erased item still has a side row
      assert.throws(() =>
        validateGovernedNoteProjectionRows(
          [
            {
              projectId: binding.projectId,
              itemId: createdNote.recordId,
              normalizedKey: `governed-note/insight/${createdNote.recordId}`,
              verificationMethod: GOVERNED_NOTE_ERASED_MARKER,
              sourceEventPosition: eraseReceipt.globalPosition,
            },
          ],
          [
            {
              projectId: binding.projectId,
              itemId: createdNote.recordId,
              recordKind: "insight",
              format: null,
              body: null,
              bodyContentHash: null,
              sourceEventPosition: eraseReceipt.globalPosition.toString(),
            },
          ],
          eraseReceipt.globalPosition,
        ),
      );
    } finally {
      afterDb.close();
    }
  } finally {
    custody?.close();
    await fixture.cleanup();
  }
});
