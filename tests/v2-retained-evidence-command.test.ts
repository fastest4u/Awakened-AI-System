import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { makeRetainedEvidenceFixture } from "./support/retained-evidence-fixture.js";
import { decodeRetainEvidenceBatch } from "../src/orchestrator/privacy/evidence-contracts.js";
import { RetainedEvidenceService } from "../src/orchestrator/privacy/retained-evidence.service.js";
import { RetainedEvidenceAuthorityVerifier } from "../src/orchestrator/privacy/retained-evidence-authority.js";
import { EventAppendTransaction, SqliteEventAppendStatements, isPrimarySqliteBusy } from "../src/orchestrator/storage/event-append-transaction.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { FRESH_NOW } from "./support/fresh-start-fixture.js";
import { createCapabilityProof, type SemanticCommandProofTargetV1 } from "../src/orchestrator/lifecycle/authority/capability-codec.js";
import { commandHash } from "../src/orchestrator/crypto/event-hash.js";
import type { RetainedEvidenceFixture } from "./support/retained-evidence-fixture.js";
import type { RetainEvidenceBatchCommandV1, RetainedEvidenceFrameV1 } from "../src/orchestrator/privacy/evidence-contracts.js";
import { decodeEncryptedEvidenceItem } from "../src/orchestrator/privacy/retained-evidence-codec.js";
import { openEvidenceItem } from "../src/orchestrator/privacy/evidence-envelope.js";
import type { VerifiedRetainedEvidenceAuthority } from "../src/orchestrator/privacy/retained-evidence-authority.js";
import { FRESH_IDENTITY } from "./support/fresh-start-fixture.js";
import { bindFreshStartAdmissionContext } from "../src/orchestrator/fresh-start/fresh-start-admission.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { DatabaseSync } from "node:sqlite";
import { RetainedEvidenceRepository } from "../src/orchestrator/privacy/retained-evidence.repository.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import { checkpointFixture } from "./support/lifecycle-fixtures.js";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";

function frame(overrides: Partial<RetainedEvidenceFrameV1> = {}): RetainedEvidenceFrameV1 {
  return { frameId: randomUUID(), ordinal: "0", role: "user", category: "user-message", occurredAt: FRESH_NOW,
    mediaType: "text/plain; charset=utf-8", content: "fixture_synthetic_secret", previousFrameId: null, toolCorrelationId: null, artifactHashes: [], ...overrides } as RetainedEvidenceFrameV1;
}
function batch(f: RetainedEvidenceFixture, overrides: Partial<RetainEvidenceBatchCommandV1> = {}): RetainEvidenceBatchCommandV1 {
  return { version: 1, commandType: "retain-evidence-batch", commandId: randomUUID(), idempotencyKey: randomUUID(),
    targetSessionId: f.rootAuthority.sessionId, conversationId: randomUUID(), frames: [frame()], ...overrides };
}
const snapshot = (f: RetainedEvidenceFixture) => JSON.stringify({ ...f.rows(), streams: f.connection.prepare("SELECT * FROM streams").all(),
  branches: f.connection.prepare("SELECT * FROM branch_scopes").all(), outbox: f.connection.prepare("SELECT * FROM outbox").all() }, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v);

test("authorized batch commits one complete bundle", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const first = frame(), second = frame({ ordinal: "1", previousFrameId: first.frameId, role: "assistant", category: "assistant-message", content: "Owned synthetic answer" });
  const input = decodeRetainEvidenceBatch({ version: 1, commandType: "retain-evidence-batch", commandId: randomUUID(), idempotencyKey: randomUUID(), targetSessionId: f.rootAuthority.sessionId, conversationId: randomUUID(), frames: [first, second] });
  const authority = new RetainedEvidenceAuthorityVerifier({ connection: f.connection, capabilities: f.lifecycle.capabilities });
  const events = new EventAppendTransaction(f.connection, new SqliteEventAppendStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository());
  const service = new RetainedEvidenceService({ connection: f.connection, events, repository: f.repository, authority, provider: f.provider, policy: () => f.policy, now: () => FRESH_NOW });
  const b = f.projectContext.binding;
  const scope = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId, clientNamespace: b.clientNamespace, authoritySessionId: f.rootAuthority.sessionId, targetSessionId: f.rootAuthority.sessionId, presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId, targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId, capabilityKind: "root-session-handle" as const, capabilityGeneration: "1" };
  const target: SemanticCommandProofTargetV1 = { ...scope, proofVersion: 1, target: "semantic-command", commandId: input.command.commandId, idempotencyKey: input.command.idempotencyKey, intentHash: commandHash({ ...scope, proofPurpose: "retain-evidence-batch/v1", originalCommand: input.canonicalOriginalBytes.toString("utf8") }), proofNonce: randomUUID() };
  const material = f.lifecycle.capabilities.reconstructForTarget(f.rootAuthority.descriptor, f.rootAuthority.target);
  const proof = createCapabilityProof(material.handle, target); material.handle.destroy(); if (material.kind === "root") material.resumeToken?.destroy();
  const result = service.retain({ context: f.projectContext, input, authorization: { kind: "protected", authoritySessionId: f.rootAuthority.sessionId as never, targetSessionId: f.rootAuthority.sessionId as never, proof, approval: null, childBindingGrant: null } });
  assert.equal(result.eventIds.length, 1);
  assert.equal(f.connection.prepare("SELECT count(*) AS n FROM retained_evidence_blobs").get()!.n, BigInt(input.command.frames.length));
  const rows = { retainedEvents: f.connection.prepare("SELECT count(*) AS n FROM events WHERE event_type='EvidenceBatchRetained'").get()!.n,
    blobs: f.connection.prepare("SELECT count(*) AS n FROM retained_evidence_blobs").get()!.n,
    authorizations: f.connection.prepare("SELECT count(*) AS n FROM retained_evidence_command_authorizations").get()!.n,
    dedup: f.connection.prepare("SELECT count(*) AS n FROM command_dedup WHERE command_type='retain-evidence-batch'").get()!.n,
    heads: f.connection.prepare("SELECT count(*) AS n FROM retained_evidence_stream_heads").get()!.n,
    canonicalItems: f.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canonical_items'").get()
      ? f.connection.prepare("SELECT count(*) AS n FROM canonical_items").get()!.n : 0n };
  assert.deepEqual(rows, { retainedEvents: 1n, blobs: 2n, authorizations: 1n, dedup: 1n, heads: 1n, canonicalItems: 0n });
  const prior = f.repository.findPrior(input.command.commandId, input.command.idempotencyKey)!;
  assert.deepEqual(prior.event.evidenceRefs, result.response.evidenceIds);
  assert.equal(result.response.commandId, input.command.commandId);
  assert.equal(result.response.idempotencyKey, input.command.idempotencyKey);
  assert.equal(result.response.targetSessionId, input.command.targetSessionId);
  assert.equal(result.response.conversationId, input.command.conversationId);
  const items = f.connection.prepare("SELECT encrypted_item_json FROM retained_evidence_blobs ORDER BY item_index").all().map(row => decodeEncryptedEvidenceItem(JSON.parse(row.encrypted_item_json as string)));
  assert.deepEqual(items.map(item => item.binding.frameId), [first.frameId, second.frameId]);
  assert.deepEqual(prior.event.evidenceRefs, items.map(item => item.binding.evidenceId));
  assert.deepEqual(prior.event.evidenceDigests, items.map(item => ({ ciphertextHash: item.ciphertextHash, keyedFingerprint: item.keyedFingerprint })));
  for (const item of items) {
    assert.equal(item.binding.eventId, result.eventIds[0]);
    assert.equal(openEvidenceItem(item.binding, item, f.provider).content?.toString().includes("fixture_synthetic_secret"), false);
  }
  assert.equal(f.connection.prepare("SELECT count(*) AS n FROM outbox WHERE event_position=$p").get({ $p: result.firstGlobalPosition })!.n, 0n);
  assert.equal(snapshot(f).includes("fixture_synthetic_secret"), false);
  assert.equal(JSON.stringify(result, (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v).includes("fixture_synthetic_secret"), false);
  assert.equal(input.canonicalOriginalBytes.every(byte => byte === 0), true);
});

test("generic retained command and event are reserved even with empty refs", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const events = new EventAppendTransaction(f.connection, new SqliteEventAppendStatements(f.connection), new MaintenanceFence(), new BranchScopeRepository());
  const command = { context: f.projectContext, commandId: randomUUID(), idempotencyKey: randomUUID(), commandType: "retain-evidence-batch", correlationId: randomUUID(), agentId: "synthetic", expectedStreamVersion: 0n, streamId: "synthetic", streamType: "synthetic", events: [{ eventType: "EvidenceBatchRetained", eventSchemaVersion: 1, occurredAt: FRESH_NOW, visibilityScope: "project" as const, confidence: "high" as const, verificationStatus: "unverified" as const, payload: {}, sourceRefs: [], evidenceRefs: [], evidenceDigests: [] }], outbox: [], publicResponse: {} };
  assert.throws(() => events.prepare(command, FRESH_NOW), { code: "COMMAND_INVALID" });
  assert.throws(() => events.prepare({ ...command, commandType: "generic" }, FRESH_NOW), { code: "COMMAND_INVALID" });
  assert.throws(() => events.prepare({ ...command, events: [{ ...command.events[0]!, eventType: "Generic" }] }, FRESH_NOW), { code: "COMMAND_INVALID" });
  assert.throws(() => events.prepare({ ...command, commandType: "generic", events: [{ ...command.events[0]!, eventType: "Generic", evidenceRefs: [randomUUID()] }] }, FRESH_NOW), { code: "EVIDENCE_NOT_AVAILABLE_IN_SUBPROJECT_1" });
});

test("root self, root direct-child and child self bind separate real fences", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  for (const [target, authorizer] of [[f.rootAuthority.sessionId, f.rootAuthority], [f.childAuthority.sessionId, f.rootAuthority], [f.childAuthority.sessionId, f.childAuthority]] as const) {
    const command = batch(f, { targetSessionId: target });
    const result = f.service().retain(f.invocation(command, authorizer));
    const prior = f.repository.findPrior(command.commandId, command.idempotencyKey)!;
    assert.deepEqual(prior.authorization, f.authoritySnapshot(target, authorizer.sessionId));
    assert.equal(prior.event.sessionId, target); assert.equal(prior.event.parentSessionId, target === f.rootAuthority.sessionId ? null : f.rootAuthority.sessionId);
    assert.equal(result.response.eventPosition, prior.event.globalPosition.toString());
    assert.equal(prior.event.streamType, "retained-evidence"); assert.equal(prior.event.streamId, `retained-evidence/${target}/${command.conversationId}`);
  }
});

test("sibling, child-to-root and foreign session proofs have no durable effect", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const sibling = await f.lifecycle.forkChild(f.rootAuthority.sessionId, f.rootAuthority.descriptor);
  for (const target of [sibling.sessionId, f.rootAuthority.sessionId, randomUUID()]) {
    const before = snapshot(f), invocation = f.invocation(batch(f, { targetSessionId: target }), f.childAuthority);
    assert.throws(() => f.service().retain(invocation), error => error instanceof Error && "code" in error && ["SESSION_OWNERSHIP_MISMATCH", "SESSION_NOT_FOUND"].includes(String(error.code)));
    assert.equal(snapshot(f), before);
  }
});

test("foreign project, vault, store, workspace, namespace, client and actor are refused", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  for (const field of ["projectId", "vaultId", "storeId", "workspaceId", "clientNamespace", "clientInstanceId", "actorRole"] as const) {
    const original = f.invocation(batch(f));
    const context = { ...f.projectContext, binding: { ...f.projectContext.binding, [field]: field === "actorRole" ? "untrusted" : field.endsWith("Id") ? randomUUID() : "foreign" } } as ProjectContext;
    const before = snapshot(f);
    assert.throws(() => f.service().retain({ ...original, context }), error => error instanceof Error && "code" in error && ["SESSION_OWNERSHIP_MISMATCH", "SESSION_CAPABILITY_INVALID"].includes(String(error.code)));
    assert.equal(snapshot(f), before);
  }
});

test("copied, forged, constructor and cross-connection authority and plan cannot prepare", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const request = f.invocation(batch(f)), verified = f.retainedAuthority.verify(request);
  const before = snapshot(f);
  assert.equal(Object.getPrototypeOf(verified), null); assert.equal("constructor" in verified, false);
  for (const fake of [{}, { ...verified }, Object.create(verified)]) assert.throws(() => f.events.planRetainedEvidenceIdentity(fake as VerifiedRetainedEvidenceAuthority, request.input.command));
  const plan = f.events.planRetainedEvidenceIdentity(verified, request.input.command);
  assert.equal(Object.getPrototypeOf(plan), null); assert.equal("constructor" in plan, false);
  for (const fake of [{ ...plan }, Object.create(plan)]) assert.throws(() => f.events.prepareRetainedEvidence(fake, {} as never, {} as never, []), { code: "COMMAND_INVALID" });
  const other = await makeRetainedEvidenceFixture(); t.after(other.cleanup);
  assert.throws(() => other.events.planRetainedEvidenceIdentity(verified, request.input.command));
  assert.throws(() => f.events.planRetainedEvidenceIdentity(verified, batch(f)));
  assert.equal(snapshot(f), before); request.input.canonicalOriginalBytes.fill(0);
});

test("private proof binds full 12000-deep original JSON and changed original refuses", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  let content: import("../src/orchestrator/contracts/event.js").JsonValue = "synthetic";
  for (let i = 0; i < 12_000; i++) content = [content];
  const command = batch(f, { frames: [frame({ mediaType: "application/json", content })] });
  const request = f.invocation(command);
  const changed = decodeRetainEvidenceBatch({ ...command, frames: [frame({ ...command.frames[0], mediaType: "application/json", content: [content] })] });
  assert.throws(() => f.service().retain({ ...request, input: changed }), { code: "SESSION_CAPABILITY_INVALID" });
  assert.equal(f.service().retain(request).eventIds.length, 1);
});

test("missing required policy or key leaves no durable effect", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  for (const policy of [() => { throw new Error("synthetic private policy failure"); }, () => ({ ...f.policy })]) {
    const before = snapshot(f); assert.throws(() => f.service({ policy }).retain(f.invocation(batch(f))), { code: "RETAINED_EVIDENCE_POLICY_UNAVAILABLE" }); assert.equal(snapshot(f), before);
  }
  for (const purpose of ["data-key-wrap", "original-input-commitment", "redacted-content-fingerprint"] as const) for (const state of ["unavailable", "revoked"] as const) {
    f.provider.setStatus(purpose, state); const before = snapshot(f);
    assert.throws(() => f.service().retain(f.invocation(batch(f))), { code: "RETAINED_EVIDENCE_KEY_UNAVAILABLE" }); assert.equal(snapshot(f), before); f.provider.setStatus(purpose, "available");
  }
});

test("actual compound-write boundaries roll back and possible committed response failure keeps identity", async t => {
  for (const boundary of ["before-begin", "after-event", "after-blobs", "after-head", "after-auth", "after-dedup", "before-commit", "after-commit-before-response"] as const) {
    let f: RetainedEvidenceFixture;
    const faults = { hit(at: string) {
      if (at !== boundary) return;
      const expected = boundary === "after-blobs" ? [1n, 0n, 0n] : boundary === "after-head" ? [1n, 1n, 0n] : boundary === "after-auth" ? [1n, 1n, 1n] : null;
      if (expected) assert.deepEqual(["retained_evidence_blobs", "retained_evidence_stream_heads", "retained_evidence_command_authorizations"].map(table => f.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n), expected);
      throw new Error("synthetic boundary failure");
    } };
    f = await makeRetainedEvidenceFixture({ faults }); t.after(f.cleanup);
    const command = batch(f), before = snapshot(f);
    if (boundary === "after-commit-before-response") {
      assert.throws(() => f.service().retain(f.invocation(command)), { code: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: command.commandId, idempotencyKey: command.idempotencyKey } });
      assert.ok(f.repository.findPrior(command.commandId, command.idempotencyKey));
    } else { assert.throws(() => f.service().retain(f.invocation(command)), { code: "RETAINED_EVIDENCE_UNAVAILABLE" }); assert.equal(snapshot(f), before); }
  }
});

test("fresh-start prepared and actual recovery/disabled transitions refuse mutation", async t => {
  for (const mode of ["prepared", "read-only-recovery", "disabled"] as const) {
    const target = await makeRetainedEvidenceFixture(); t.after(target.cleanup);
    target.admission.control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 1n, target: mode === "prepared" ? "disabled" : mode, reasonCode: "privacy-failure" });
    if (mode === "prepared") await target.admission.control.transition({ identity: FRESH_IDENTITY, expectedGeneration: 2n, expectedMode: "disabled",
      expectedReleaseId: target.admission.release.releaseId, nextMode: "prepared", nextRelease: target.admission.release, approvalEnvelope: new Uint8Array([1]) });
    const before = snapshot(target);
    assert.throws(() => target.service().retain(target.invocation(batch(target))), { code: "FRESH_START_ADMISSION_STALE" }); assert.equal(snapshot(target), before);
    // An actual new object admits the current generation; mode denial is independent of the old facade's stale generation.
    const connection = new NodeSqliteDriver({ DatabaseSync }).open(target.path, { mode: "existing", busyTimeoutMs: 1000 });
    try {
      bindFreshStartAdmissionContext(connection, { ...target.admission.trusted, generation: mode === "prepared" ? 3n : 2n });
      const authority = new RetainedEvidenceAuthorityVerifier({ connection, capabilities: target.lifecycle.capabilities });
      const events = new EventAppendTransaction(connection, new SqliteEventAppendStatements(connection), new MaintenanceFence(), new BranchScopeRepository());
      const service = target.service({ connection, events, authority, repository: new RetainedEvidenceRepository(connection) });
      assert.throws(() => service.retain(target.invocation(batch(target))), { code: "FRESH_START_ADMISSION_DENIED" }); assert.equal(snapshot(target), before);
    } finally { connection.close(); }
  }
});

test("fresh-start generation and maintenance fences change between preparation and BEGIN", async t => {
  for (const fence of ["release", "maintenance"] as const) {
    let f: RetainedEvidenceFixture;
    f = await makeRetainedEvidenceFixture({ faults: { hit(boundary) {
      if (boundary !== "before-begin") return;
      if (fence === "release") f.admission.control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 1n, target: "disabled", reasonCode: "privacy-failure" });
      else { f.connection.exec("BEGIN IMMEDIATE"); new MaintenanceFence().acquire(f.connection, "synthetic-owner", "2026-09-29T00:01:00.000Z", FRESH_NOW); f.connection.exec("COMMIT"); }
    } } }); t.after(f.cleanup);
    const before = snapshot(f);
    assert.throws(() => f.service().retain(f.invocation(batch(f))), { code: fence === "release" ? "FRESH_START_ADMISSION_STALE" : "MAINTENANCE_QUIESCING" }); assert.equal(snapshot(f), before);
  }
});

test("head gaps, predecessor, duplicate frame and tool correlation use committed history", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const conversationId = randomUUID(), correlation = randomUUID();
  const first = frame({ role: "tool", category: "tool-input", toolCorrelationId: correlation });
  const command = batch(f, { conversationId, frames: [first] });
  for (const bad of [batch(f, { frames: [frame({ ordinal: "1", previousFrameId: randomUUID() })] })]) {
    const before = snapshot(f); assert.throws(() => f.service().retain(f.invocation(bad)), { code: "RETAINED_EVIDENCE_ORDER_CONFLICT" }); assert.equal(snapshot(f), before);
  }
  f.service().retain(f.invocation(command));
  for (const bad of [batch(f, { conversationId, frames: [frame({ ordinal: "2", previousFrameId: first.frameId })] }), batch(f, { conversationId, frames: [frame({ ordinal: "1", previousFrameId: randomUUID() })] }), batch(f, { conversationId, frames: [first] }), batch(f, { conversationId, frames: [frame({ ordinal: "1", previousFrameId: first.frameId, role: "tool", category: "tool-output", toolCorrelationId: randomUUID() })] })]) {
    const before = snapshot(f); assert.throws(() => f.service().retain(f.invocation(bad)), error => error instanceof Error && "code" in error && ["RETAINED_EVIDENCE_FRAME_CONFLICT", "RETAINED_EVIDENCE_ORDER_CONFLICT"].includes(String(error.code))); assert.equal(snapshot(f), before);
  }
  const output = frame({ ordinal: "1", previousFrameId: first.frameId, role: "tool", category: "tool-output", toolCorrelationId: correlation });
  assert.equal(f.service().retain(f.invocation(batch(f, { conversationId, frames: [output] }))).finalStreamVersion, 2n);
  const a = frame({ role: "tool", category: "tool-input", toolCorrelationId: randomUUID() });
  const b = frame({ ordinal: "1", previousFrameId: a.frameId, role: "tool", category: "tool-output", toolCorrelationId: a.toolCorrelationId });
  assert.equal(f.service().retain(f.invocation(batch(f, { frames: [a, b] }))).response.evidenceIds.length, 2);
});

test("genuine completion-proposed child stays live; completed target and revoked proof refuse", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const child = f.childAuthority, target = child.sessionId;
  const preCompletion = f.invocation(batch(f, { targetSessionId: target }), child);
  const verifiedBefore = f.retainedAuthority.verify(preCompletion);
  const rootRequest = f.invocation(batch(f, { targetSessionId: target }));
  const base = () => ({ commandId: randomUUID(), idempotencyKey: `retained-lifecycle/${randomUUID()}`, agentId: "fixture-agent",
    expectedProjectId: FRESH_IDENTITY.projectId, expectedVaultId: FRESH_IDENTITY.vaultId,
    expectedWorkspaceId: f.projectContext.binding.workspaceId, expectedBranchRef: null });
  const version = () => String(f.connection.prepare("SELECT current_version FROM streams WHERE stream_id=$s").get({ $s: `session/${target}` })!.current_version);
  const report = await f.protectedLifecycle({ ...base(), commandType: "record-child-report", parentSessionId: f.rootAuthority.sessionId,
    childSessionId: target, childAuthorAgentId: "fixture-agent", expectedStreamVersion: version(), report: { reportVersion: 1,
      outcomeSummary: "Synthetic completed work", findings: [{ summary: "Synthetic finding", evidenceReferences: [], confidence: "high" }],
      proposedDecisions: [], filesObservedOrChanged: [], verificationPerformed: [], openFollowUps: [], blockers: [], evidenceFingerprints: [] } }, target, child);
  const reportId = (report.result as unknown as { publicResult: { reportId: string } }).publicResult.reportId;
  await f.protectedLifecycle({ ...base(), commandType: "propose-child-completion", childSessionId: target, expectedStreamVersion: version(), reportId }, target, child);
  assert.equal(f.service().retain(rootRequest).eventIds.length, 1);
  await f.protectedLifecycle({ ...base(), commandType: "complete-child-session", parentSessionId: f.rootAuthority.sessionId,
    childSessionId: target, expectedStreamVersion: version(), reportId }, target);
  const before = snapshot(f);
  assert.throws(() => f.service().retain(preCompletion), { code: "SESSION_HANDLE_STALE" });
  assert.throws(() => f.retainedAuthority.revalidate(verifiedBefore));
  assert.throws(() => f.service().retain(f.invocation(batch(f, { targetSessionId: target }))), { code: "SESSION_HANDLE_STALE" });
  assert.equal(snapshot(f), before);
});

test("complete 2MiB metadata-plus-body guard runs before any stream or branch write", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const ids = Array.from({ length: 64 }, () => randomUUID());
  const command = batch(f, { frames: ids.map((id, n) => frame({ frameId: id, ordinal: String(n), previousFrameId: n === 0 ? null : ids[n - 1]!, content: "fixture_a ".repeat(64) })) });
  const policy = Object.freeze({ ...f.policy, rules: Object.freeze([Object.freeze({ kind: "token" as const, prefix: "fixture_", ruleId: "😀".repeat(75) })]) });
  let planned = false;
  const originalPlan = f.events.planPrepared.bind(f.events);
  f.events.planPrepared = prepared => { planned = true; return originalPlan(prepared); };
  const before = snapshot(f);
  assert.throws(() => f.service({ policy: () => policy }).retain(f.invocation(command)), { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" });
  assert.equal(planned, true, "valid encrypted item array reaches complete durable bundle guard");
  assert.equal(snapshot(f), before);
});

test("retained git planning preserves an existing scope or null without creating a scope", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const workspace = { kind: "git" as const, workspaceId: f.projectContext.binding.workspaceId, worktreeRoot: f.root,
    gitDir: f.root, gitCommonDir: f.root, headCommit: "a".repeat(40), branchRef: "refs/heads/synthetic", detached: false };
  const context = { ...f.projectContext, workspace, binding: { ...f.projectContext.binding, workspace } };
  const branchCount = () => f.connection.prepare("SELECT count(*) AS n FROM branch_scopes").get()!.n as bigint;
  const before = branchCount();
  const first = batch(f), receipt = f.service().retain(f.invocation(first, f.rootAuthority, context));
  const event = f.repository.findPrior(first.commandId, first.idempotencyKey)!.event;
  assert.equal(event.branchScopeId, null); assert.equal(event.branchRef, workspace.branchRef); assert.equal(branchCount(), before);
  const branchId = new BranchScopeRepository().resolveOrCreate(f.connection, f.projectContext.binding.projectId, workspace, FRESH_NOW);
  const second = batch(f); f.service().retain(f.invocation(second, f.rootAuthority, context));
  assert.equal(f.repository.findPrior(second.commandId, second.idempotencyKey)!.event.branchScopeId, branchId);
  assert.equal(branchCount(), before + 1n); assert.equal(receipt.eventIds.length, 1);
});

test("forged parent mirror and changed authority after verification refuse on the same connection", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const request = f.invocation(batch(f, { targetSessionId: f.childAuthority.sessionId }));
  const handle = f.retainedAuthority.verify(request);
  f.connection.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => f.connection.prepare("UPDATE session_authority SET parent_session_id=$p WHERE session_id=$s").run({ $p: randomUUID(), $s: f.childAuthority.sessionId }), /SESSION_AUTHORITY_LINEAGE_IMMUTABLE/);
    const trigger = f.connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%SESSION_AUTHORITY_LINEAGE_IMMUTABLE%'").get()!.name as string;
    assert.match(trigger, /^[a-z_]+$/); f.connection.exec(`DROP TRIGGER ${trigger}`);
    f.connection.prepare("UPDATE session_authority SET parent_session_id=$p WHERE session_id=$s").run({ $p: randomUUID(), $s: f.childAuthority.sessionId });
    assert.throws(() => f.retainedAuthority.revalidate(handle));
  } finally { f.connection.exec("ROLLBACK"); }
  assert.doesNotThrow(() => f.retainedAuthority.revalidate(handle));
  request.input.canonicalOriginalBytes.fill(0);
});

test("authorized original retry succeeds and generic replay cannot disclose retained authorization", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const command = batch(f); const accepted = f.service().retain(f.invocation(command));
  const prior = f.repository.findPrior(command.commandId, command.idempotencyKey)!, before = snapshot(f);
  assert.deepEqual(f.service().retain(f.invocation(command)), { ...accepted, deduplicated: true });
  const generic = f.events.prepare({ context: f.projectContext, commandId: command.commandId, idempotencyKey: command.idempotencyKey,
    commandType: "generic", correlationId: randomUUID(), agentId: "synthetic", expectedStreamVersion: 0n, streamId: "generic", streamType: "generic",
    events: [{ eventType: "Synthetic", eventSchemaVersion: 1, occurredAt: FRESH_NOW, visibilityScope: "project", confidence: "high",
      verificationStatus: "unverified", payload: {}, sourceRefs: [], evidenceRefs: [], evidenceDigests: [] }], outbox: [], publicResponse: {} }, FRESH_NOW);
  // Even caller copying private symbols and arranging a matching hash cannot exploit null legacy authorization.
  assert.throws(() => f.events.findReplay({ ...generic, commandHash: prior.commandHash }, null), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => f.events.findLifecycleReplay({ context: f.projectContext, commandId: command.commandId, idempotencyKey: command.idempotencyKey,
    authoritativeIntentHash: prior.commandHash, replayExpectation: { kind: "protected", authorizationSessionId: f.rootAuthority.sessionId,
      targetSessionId: f.rootAuthority.sessionId, proof: null, approval: null, presenting: f.rootAuthority.target, target: f.rootAuthority.target } }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(snapshot(f), before);
});

test("closed root and stale capability proof cannot retain", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const request = f.invocation(batch(f)), handle = f.retainedAuthority.verify(request);
  const fixture = checkpointFixture();
  const { checkpointId: _id, sessionId: _s, parentSessionId: _p, baseEventPosition: _b, checkpointEventPosition: _e,
    createdAt: _at, creatorAgentId: _a, creatorClientInstanceId: _c, sourceState: _st, childSummaries: _ch, evidenceCoverage: _cv, ...draft } = fixture;
  await f.protectedLifecycle({ commandType: "root-suspend", commandId: randomUUID(), idempotencyKey: `retained-suspend/${randomUUID()}`,
    agentId: "fixture-agent", expectedProjectId: FRESH_IDENTITY.projectId, expectedVaultId: FRESH_IDENTITY.vaultId,
    expectedWorkspaceId: f.projectContext.binding.workspaceId, expectedBranchRef: null, sessionId: f.rootAuthority.sessionId,
    expectedStreamVersion: String(f.connection.prepare("SELECT current_version FROM streams WHERE stream_id=$s").get({ $s: `session/${f.rootAuthority.sessionId}` })!.current_version), checkpoint: draft as unknown as JsonValue }, f.rootAuthority.sessionId);
  const before = snapshot(f);
  assert.throws(() => f.retainedAuthority.revalidate(handle), { code: "SESSION_HANDLE_STALE" });
  assert.throws(() => f.service().retain(request), { code: "SESSION_HANDLE_STALE" }); assert.equal(snapshot(f), before);
});

test("root can retain a genuine live child with direct access disabled", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const child = await f.lifecycle.forkChild(f.rootAuthority.sessionId, f.rootAuthority.descriptor, false);
  const command = batch(f, { targetSessionId: child.sessionId });
  assert.equal(f.service().retain(f.invocation(command)).eventIds.length, 1);
  const admitted = f.repository.findPrior(command.commandId, command.idempotencyKey)!.authorization;
  assert.equal(admitted.targetCapabilityGeneration, null); assert.equal(admitted.targetOwnerGeneration, null);
  assert.equal(admitted.targetActorRole, "primary"); assert.equal(admitted.targetClientInstanceId, f.rootAuthority.target.clientInstanceId);
});

test("mandatory process-secret redaction and actual wrap/MAC failures have zero durable effect", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const policy = Object.freeze({ ...f.policy, rules: Object.freeze([Object.freeze({ kind: "process-secret" as const, ruleId: "synthetic-required", referenceId: "synthetic", required: true, value: null })]) });
  const before = snapshot(f);
  assert.throws(() => f.service({ policy: () => policy }).retain(f.invocation(batch(f))), { code: "RETAINED_EVIDENCE_POLICY_UNAVAILABLE" }); assert.equal(snapshot(f), before);
  for (const method of ["wrap", "mac"] as const) {
    const provider = { currentKey: f.provider.currentKey.bind(f.provider), status: f.provider.status.bind(f.provider),
      wrap: f.provider.wrap.bind(f.provider), unwrap: f.provider.unwrap.bind(f.provider), mac: f.provider.mac.bind(f.provider),
      [method]: () => { throw new Error("synthetic private provider failure"); } };
    assert.throws(() => f.service({ provider }).retain(f.invocation(batch(f))), { code: "RETAINED_EVIDENCE_KEY_UNAVAILABLE" }); assert.equal(snapshot(f), before);
  }
});

test("commit uncertainty and failed rollback preserve original unknown-outcome IDs", async t => {
  for (const failure of ["commit", "rollback"] as const) {
    const f = await makeRetainedEvidenceFixture({ faults: failure === "rollback" ? { hit(boundary) { if (boundary === "after-event") throw new Error("synthetic precommit fault"); } } : undefined }); t.after(f.cleanup);
    const exec = f.connection.exec.bind(f.connection), command = batch(f);
    f.connection.exec = sql => {
      if (failure === "commit" && sql === "COMMIT") { exec(sql); throw new Error("synthetic committed unknown"); }
      if (failure === "rollback" && sql === "ROLLBACK") throw new Error("synthetic failed rollback");
      exec(sql);
    };
    assert.throws(() => f.service().retain(f.invocation(command)), { code: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: command.commandId, idempotencyKey: command.idempotencyKey } });
    f.connection.exec = exec;
    if (failure === "commit") assert.ok(f.repository.findPrior(command.commandId, command.idempotencyKey));
    else exec("ROLLBACK"); // Test cleanup only; unknown result never claimed rollback or terminal rejection.
  }
});

test("copied generic planned events cannot acquire retained append authority", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const prepared = f.events.prepare({ context: f.projectContext, commandId: randomUUID(), idempotencyKey: randomUUID(), commandType: "generic",
    correlationId: randomUUID(), agentId: "synthetic", expectedStreamVersion: 0n, streamId: "generic-plan-copy", streamType: "generic",
    events: [{ eventType: "Synthetic", eventSchemaVersion: 1, occurredAt: FRESH_NOW, visibilityScope: "project", confidence: "high",
      verificationStatus: "unverified", payload: {}, sourceRefs: [], evidenceRefs: [], evidenceDigests: [] }], outbox: [], publicResponse: {} }, FRESH_NOW);
  const before = snapshot(f); f.connection.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => f.events.planPrepared({ ...prepared, command: { ...prepared.command,
      events: [{ ...prepared.command.events[0]!, eventType: "EvidenceBatchRetained" }] } }), { code: "COMMAND_INVALID" });
    const planned = f.events.planPrepared(prepared);
    assert.throws(() => f.events.appendPlanned({ ...planned, events: [{ ...planned.events[0]!, eventType: "EvidenceBatchRetained" }] }), { code: "COMMAND_INVALID" });
    assert.throws(() => f.events.appendPlanned({ ...planned, events: [{ ...planned.events[0]!, evidenceRefs: [randomUUID()] }] }), { code: "COMMAND_INVALID" });
  } finally { f.connection.exec("ROLLBACK"); }
  assert.equal(snapshot(f), before);
});

const durableSnapshot = (f: RetainedEvidenceFixture) => JSON.stringify([
  "events", "streams", "branch_scopes", "outbox", "retained_evidence_blobs", "retained_evidence_stream_heads",
  "retained_evidence_command_authorizations", "command_dedup",
].map(table => [table, f.connection.prepare(`SELECT * FROM ${table}`).all()]), (_k, v: unknown) => typeof v === "bigint" ? v.toString() : v);

for (const boundary of ["after-dedup", "after-commit-before-response"] as const) {
  test(`primary busy at ${boundary} preserves actual commit outcome`, async t => {
    const busy = Object.assign(new Error("synthetic primary busy"), { errcode: 5 });
    assert.equal(isPrimarySqliteBusy(busy), true);
    const f = await makeRetainedEvidenceFixture({ faults: { hit(at) { if (at === boundary) throw busy; } } }); t.after(f.cleanup);
    const command = batch(f), before = durableSnapshot(f);
    if (boundary === "after-commit-before-response") {
      assert.throws(() => f.service().retain(f.invocation(command)), {
        code: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: command.commandId, idempotencyKey: command.idempotencyKey },
      });
      const prior = f.repository.findPrior(command.commandId, command.idempotencyKey);
      assert.ok(prior);
      assert.equal(prior.event.eventType, "EvidenceBatchRetained");
      assert.equal(f.connection.prepare("SELECT count(*) AS n FROM retained_evidence_blobs").get()!.n, 1n);
      assert.equal(f.connection.prepare("SELECT count(*) AS n FROM retained_evidence_stream_heads").get()!.n, 1n);
      assert.equal(f.connection.prepare("SELECT count(*) AS n FROM retained_evidence_command_authorizations").get()!.n, 1n);
    } else {
      assert.throws(() => f.service().retain(f.invocation(command)), { code: "SQLITE_BUSY", details: {} });
      assert.equal(f.repository.findPrior(command.commandId, command.idempotencyKey), null);
      assert.equal(durableSnapshot(f), before);
    }
  });
}

for (const mismatch of ["commandId", "idempotencyKey", "targetSessionId", "conversationId", "unrelated-evidence", "reversed-evidence", "missing-evidence"] as const) {
  test(`protected receipt ${mismatch} mismatch refuses before preparation`, async t => {
    const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
    const first = frame(), second = frame({ ordinal: "1", previousFrameId: first.frameId });
    const command = batch(f, { frames: [first, second] }), before = durableSnapshot(f);
    const prepare = f.events.prepareRetainedEvidence.bind(f.events);
    let reachedPrepare = false;
    let primitiveRefusal: unknown;
    f.events.prepareRetainedEvidence = (plan, append, payload, items) => {
      reachedPrepare = true;
      assert.equal(items.length, 2);
      assert.deepEqual(append.publicResponse.evidenceIds, items.map(item => item.binding.evidenceId));
      const receipt = append.publicResponse;
      const changed = mismatch === "unrelated-evidence" ? { ...receipt, evidenceIds: [randomUUID(), receipt.evidenceIds[1]!] }
        : mismatch === "reversed-evidence" ? { ...receipt, evidenceIds: [...receipt.evidenceIds].reverse() }
        : mismatch === "missing-evidence" ? { ...receipt, evidenceIds: receipt.evidenceIds.slice(0, 1) }
        : { ...receipt, [mismatch]: randomUUID() };
      try { return prepare(plan, { ...append, publicResponse: changed }, payload, items); }
      catch (error) {
        primitiveRefusal = error;
        throw error;
      }
    };
    assert.throws(() => f.service().retain(f.invocation(command)), { code: "RETAINED_EVIDENCE_UNAVAILABLE" });
    assert.equal(reachedPrepare, true);
    assert.equal(primitiveRefusal instanceof Error && "code" in primitiveRefusal ? primitiveRefusal.code : null, "COMMAND_INVALID");
    assert.equal(durableSnapshot(f), before);
  });
}
