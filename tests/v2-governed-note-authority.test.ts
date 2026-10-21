import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { makeGovernedNoteDomainFixture, type GovernedNoteDomainFixtureV1 } from "./support/governed-note-domain-fixture.js";
import { GovernedNoteAuthorityVerifier, deriveGovernedNoteBinding, governedNoteCreateProofTarget, governedNoteRecoveryProofTarget, requireGovernedNoteCreateAuthority, type VerifiedGovernedNoteCreateAuthority } from "../src/orchestrator/governed-notes/authority.js";
import { buildGovernedNoteOriginalCommitment, assertGovernedNoteOriginalEquality, governedNoteCommandHash, governedNoteSummaryHash } from "../src/orchestrator/governed-notes/intent.js";
import type { GovernedNoteWitnessV1 } from "../src/orchestrator/governed-notes/contracts.js";
import type { EvidenceKeyProvider } from "../src/orchestrator/privacy/evidence-key-provider.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { checkpointFixture } from "./support/lifecycle-fixtures.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import { createCapabilityProof } from "../src/orchestrator/lifecycle/authority/capability-codec.js";

// Independent byte oracle: binary key ordering, unmodified strings, real newline.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha = (domain: string, value: unknown) => createHash("sha256").update(domain + "\n", "utf8").update(canonical(value), "utf8").digest("hex");
const fullRows = (f: GovernedNoteDomainFixtureV1) => JSON.stringify(Object.fromEntries(["events", "command_dedup", "streams", "outbox", "retained_evidence_command_authorizations", "branch_scopes", "session_authority"].map(table => [table, f.connection.prepare(`SELECT * FROM ${table}`).all()])), (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
const expiry = (f: GovernedNoteDomainFixtureV1) => new Date(Number(f.clock.nowMs() + 60000n)).toISOString();
function witnessFor(f: GovernedNoteDomainFixtureV1, command = f.command()) {
  const handle = f.verifier.verifyCreate(f.prepareCreate(command), f.rootContext);
  const authority = f.verifier.revalidateCreate(handle), binding = f.verifier.bindingForCreate(handle);
  const ref = f.provider.currentKey({ projectId: authority.projectId, storeId: authority.storeId }, "original-input-commitment");
  const witness: GovernedNoteWitnessV1 = { witnessVersion: 1, commandType: "create-governed-note", commandId: command.commandId, idempotencyKey: command.idempotencyKey, recordId: randomUUID(), recordKind: command.recordKind, confidence: command.confidence, authority, binding, provenance: f.sources.root, policyId: f.policy.policyId, policyVersion: f.policy.policyVersion, originalCommitmentKeyRef: ref, originalInputCommitment: buildGovernedNoteOriginalCommitment(command, authority, binding, ref, f.provider), summaryContentHash: governedNoteSummaryHash("Redacted summary"), noteEventId: randomUUID(), sourceEventId: randomUUID(), recordedAt: f.clock.now() };
  return { command, authority, binding, ref, witness };
}

for (const kind of ["root", "child"] as const) test(`own ACTIVE ${kind} current create and recovery authority`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const context = kind === "root" ? f.rootContext : f.childContext;
  const command = f.command({ provenance: f.sources[kind].map(({ kind, identity }) => ({ kind, identity })) }), before = fullRows(f);
  let handle!: ReturnType<typeof f.verifier.verifyCreate>;
  assert.doesNotThrow(() => { handle = f.verifier.verifyCreate(f.prepareCreate(command, context), context); });
  const snapshot = requireGovernedNoteCreateAuthority(f.connection, handle, command);
  assert.equal(snapshot.authorizationSessionId, snapshot.targetSessionId);
  assert.equal(snapshot.capabilityKind, `${kind}-session-handle`);
  assert.deepEqual(f.verifier.bindingForCreate(handle), deriveGovernedNoteBinding(f.connection, context, snapshot.targetSessionId));
  const recovery = f.verifier.verifyRecovery(f.prepareRecovery(command, expiry(f), context), context);
  assert.deepEqual(f.verifier.revalidateRecovery(recovery), snapshot);
  assert.deepEqual(f.verifier.bindingForRecovery(recovery), f.verifier.bindingForCreate(handle));
  assert.equal(fullRows(f), before);
});

test("root on child sibling ended revoked and transferred authority refuse", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const command = f.command(), root = f.prepareCreate(command), child = f.prepareCreate(command, f.childContext);
  const before = fullRows(f), counts = f.rows(); let proofs = 0;
  const original = f.capabilities.verifyProof.bind(f.capabilities);
  f.capabilities.verifyProof = (...args) => { proofs++; return original(...args); };
  assert.throws(() => f.verifier.verifyCreate({ ...root, authorization: { ...root.authorization, targetSessionId: child.authorization.targetSessionId } }, f.childContext), { code: "SESSION_OWNERSHIP_MISMATCH" });
  assert.equal(proofs, 0);
  assert.deepEqual(f.rows(), counts); assert.equal(fullRows(f), before);
  const sibling = await f.retained.lifecycle.forkChild(f.retained.rootAuthority.sessionId, f.retained.rootAuthority.descriptor);
  const siblingBefore = fullRows(f);
  assert.throws(() => f.verifier.verifyCreate({ ...child, authorization: { ...child.authorization, targetSessionId: sibling.sessionId as never } }, f.childContext), { code: "SESSION_OWNERSHIP_MISMATCH" });
  assert.equal(fullRows(f), siblingBefore);
  const rootRecovery = f.prepareRecovery(command, expiry(f)), childRecovery = f.prepareRecovery(command, expiry(f), f.childContext);
  for (const [id, column, value] of [[f.retained.childAuthority.sessionId, "terminal_event_position", 1n], [f.retained.childAuthority.sessionId, "revocation_event_position", 1n], [f.retained.rootAuthority.sessionId, "semantic_state", "ended"], [f.retained.rootAuthority.sessionId, "owner_generation", 2n], [f.retained.childAuthority.sessionId, "child_capability_generation", 2n]] as const) {
    f.connection.exec("SAVEPOINT corruption");
    try {
      // Privileged corruption is contained and its guards are restored by rollback.
      const guards = f.connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='session_authority'").all();
      for (const guard of guards) f.connection.exec(`DROP TRIGGER "${String(guard.name).replaceAll('"', '""')}"`);
      f.connection.prepare(`UPDATE session_authority SET ${column} = $value WHERE session_id = $id`).run({ $value: value, $id: id });
      const corrupted = fullRows(f);
      assert.throws(() => f.verifier.verifyCreate(id === f.retained.rootAuthority.sessionId ? root : child, id === f.retained.rootAuthority.sessionId ? f.rootContext : f.childContext));
      assert.throws(() => f.verifier.verifyRecovery(id === f.retained.rootAuthority.sessionId ? rootRecovery : childRecovery, id === f.retained.rootAuthority.sessionId ? f.rootContext : f.childContext));
      assert.equal(fullRows(f), corrupted);
    } finally { f.connection.exec("ROLLBACK TO corruption"); f.connection.exec("RELEASE corruption"); }
  }
});

test("current audience workspace namespace branch and fold mismatches refuse without writes", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const prepared = f.prepareCreate(f.command()), before = fullRows(f);
  for (const changes of [{ actorRole: "maintenance" }, { clientInstanceId: "another-client" }, { clientNamespace: "another-namespace" }, { workspaceId: "f".repeat(64) }]) {
    const context = { ...f.rootContext, binding: { ...f.rootContext.binding, ...changes } } as ProjectContext;
    assert.throws(() => f.verifier.verifyCreate(prepared, context), { code: "SESSION_OWNERSHIP_MISMATCH" });
    assert.equal(fullRows(f), before);
  }
  f.connection.exec("SAVEPOINT fold_corruption");
  try {
    f.connection.prepare("UPDATE session_authority SET authority_commitment = $value WHERE session_id = $id").run({ $value: "f".repeat(64), $id: prepared.authorization.targetSessionId });
    const corrupted = fullRows(f); assert.throws(() => f.verifier.verifyCreate(prepared, f.rootContext)); assert.equal(fullRows(f), corrupted);
  } finally { f.connection.exec("ROLLBACK TO fold_corruption"); f.connection.exec("RELEASE fold_corruption"); }
});

test("genuine nonterminal child remains current and completion revokes its handles", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const retained = f.retained, child = retained.childAuthority, target = child.sessionId;
  const command = f.command(), prepared = f.prepareCreate(command, f.childContext), recoveryPrepared = f.prepareRecovery(command, expiry(f), f.childContext);
  const createHandle = f.verifier.verifyCreate(prepared, f.childContext), recoveryHandle = f.verifier.verifyRecovery(recoveryPrepared, f.childContext);
  const b = f.rootContext.binding;
  const base = () => ({ commandId: randomUUID(), idempotencyKey: `governed-lifecycle/${randomUUID()}`, agentId: "fixture-agent", expectedProjectId: b.projectId, expectedVaultId: b.vaultId, expectedWorkspaceId: b.workspaceId, expectedBranchRef: null });
  const version = () => String(f.connection.prepare("SELECT current_version FROM streams WHERE stream_id=$s").get({ $s: `session/${target}` })!.current_version);
  const report = await retained.protectedLifecycle({ ...base(), commandType: "record-child-report", parentSessionId: retained.rootAuthority.sessionId, childSessionId: target, childAuthorAgentId: "fixture-agent", expectedStreamVersion: version(),
    report: { reportVersion: 1, outcomeSummary: "Synthetic completed work", findings: [{ summary: "Synthetic finding", evidenceReferences: [], confidence: "high" }], proposedDecisions: [], filesObservedOrChanged: [], verificationPerformed: [], openFollowUps: [], blockers: [], evidenceFingerprints: [] } }, target, child);
  const reportId = (report.result as unknown as { publicResult: { reportId: string } }).publicResult.reportId;
  await retained.protectedLifecycle({ ...base(), commandType: "propose-child-completion", childSessionId: target, expectedStreamVersion: version(), reportId }, target, child);
  assert.doesNotThrow(() => f.verifier.revalidateCreate(createHandle));
  assert.doesNotThrow(() => f.verifier.revalidateRecovery(recoveryHandle));
  await retained.protectedLifecycle({ ...base(), commandType: "complete-child-session", parentSessionId: retained.rootAuthority.sessionId, childSessionId: target, expectedStreamVersion: version(), reportId }, target);
  const before = fullRows(f);
  for (const run of [() => f.verifier.verifyCreate(prepared, f.childContext), () => f.verifier.revalidateCreate(createHandle), () => f.verifier.verifyRecovery(recoveryPrepared, f.childContext), () => f.verifier.revalidateRecovery(recoveryHandle)]) assert.throws(run, { code: "SESSION_HANDLE_STALE" });
  assert.equal(fullRows(f), before);
});

test("genuine root ownership transfer refuses historical root and child proofs", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const command = f.command(), rootPrepared = f.prepareCreate(command), childPrepared = f.prepareCreate(command, f.childContext);
  const rootHandle = f.verifier.verifyCreate(rootPrepared, f.rootContext), childHandle = f.verifier.verifyCreate(childPrepared, f.childContext);
  const recoveryPrepared = f.prepareRecovery(command, expiry(f)), recoveryHandle = f.verifier.verifyRecovery(recoveryPrepared, f.rootContext);
  const { checkpointId: _i, sessionId: _s, parentSessionId: _p, baseEventPosition: _b, checkpointEventPosition: _e, createdAt: _at, creatorAgentId: _a, creatorClientInstanceId: _c, sourceState: _st, childSummaries: _ch, evidenceCoverage: _cv, ...draft } = checkpointFixture();
  await f.retained.lifecycle.checkpoint(f.retained.rootAuthority.sessionId, f.retained.rootAuthority.descriptor, draft as unknown as JsonValue);
  const incoming = { ...f.rootContext, binding: { ...f.rootContext.binding, clientInstanceId: "governed-incoming-owner" } };
  incoming.binding.contextFingerprint = computeProjectContextFingerprint(incoming.binding);
  const result = await f.retained.lifecycle.resumeAfterExpiry(f.retained.rootAuthority.sessionId, f.retained.rootAuthority.descriptor, incoming);
  assert.equal(result.publicResult.ownerGeneration, "2");
  const before = fullRows(f);
  for (const run of [() => f.verifier.verifyCreate(rootPrepared, f.rootContext), () => f.verifier.verifyCreate(childPrepared, f.childContext), () => f.verifier.revalidateCreate(rootHandle), () => f.verifier.revalidateCreate(childHandle), () => f.verifier.verifyRecovery(recoveryPrepared, f.rootContext), () => f.verifier.revalidateRecovery(recoveryHandle)]) assert.throws(run);
  assert.equal(fullRows(f), before);
  const issuedAt = f.connection.prepare("SELECT root_handle_issued_at FROM session_authority WHERE session_id=$id").get({ $id: f.retained.rootAuthority.sessionId })!.root_handle_issued_at as string;
  f.clock.set(BigInt(Date.parse(issuedAt)));
  const material = f.capabilities.reconstructForTarget(result.authorityMaterial.descriptor, { actorRole: "primary", clientInstanceId: incoming.binding.clientInstanceId });
  try {
    const scope = { ...f.scope(f.rootContext), capabilityGeneration: "2", presentingClientInstanceId: incoming.binding.clientInstanceId, targetClientInstanceId: incoming.binding.clientInstanceId };
    const proof = createCapabilityProof(material.handle, governedNoteCreateProofTarget(command, scope, deriveGovernedNoteBinding(f.connection, incoming, scope.targetSessionId), randomUUID()));
    assert.doesNotThrow(() => f.verifier.verifyCreate({ ...rootPrepared, authorization: { ...rootPrepared.authorization, proof } }, incoming));
  } finally { material.handle.destroy(); if (material.kind === "root") material.resumeToken?.destroy(); }
  assert.equal(fullRows(f), before);
});

test("verified handles are input verifier connection and operation bound", async t => {
  const f = await makeGovernedNoteDomainFixture(), other = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); t.after(other.cleanup);
  const command = f.command(), prepared = f.prepareCreate(command), handle = f.verifier.verifyCreate(prepared, f.rootContext), before = fullRows(f);
  const anotherVerifier = new GovernedNoteAuthorityVerifier({ connection: f.connection, capabilities: f.capabilities, clock: f.clock });
  const recovery = f.verifier.verifyRecovery(f.prepareRecovery(command, expiry(f)), f.rootContext);
  for (const copied of [{ ...handle }, Object.freeze(Object.create(null)), recovery]) assert.throws(() => requireGovernedNoteCreateAuthority(f.connection, copied as VerifiedGovernedNoteCreateAuthority, command));
  assert.throws(() => requireGovernedNoteCreateAuthority(other.connection, handle, command));
  assert.throws(() => anotherVerifier.revalidateCreate(handle));
  assert.throws(() => anotherVerifier.bindingForCreate(handle));
  assert.throws(() => f.verifier.revalidateRecovery(handle as never));
  assert.throws(() => f.verifier.bindingForRecovery(handle as never));
  assert.throws(() => requireGovernedNoteCreateAuthority(f.connection, handle, { ...command, summary: command.summary + " changed" }));
  // The verifier owns detached admitted data even if the caller later mutates it.
  const mutable = structuredClone(prepared); const owned = f.verifier.verifyCreate(mutable, f.rootContext);
  (mutable.command as { summary: string }).summary = "mutated caller";
  assert.deepEqual(f.verifier.revalidateCreate(owned), f.verifier.revalidateCreate(handle));
  assert.equal(fullRows(f), before);
});

test("five exact domain byte vectors and original scoped MAC clearing", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const { command, authority, binding, ref, witness } = witnessFor(f), scope = f.scope(f.rootContext), nonce = randomUUID();
  const create = governedNoteCreateProofTarget(command, scope, binding, nonce);
  assert.equal(create.intentHash, sha("project-memory/command/v1", { proofPurpose: "create-governed-note/v1", scope, binding, originalCommand: canonical(command) }));
  const prepared = f.prepareRecovery(command, expiry(f)), request = prepared.request;
  const recovery = governedNoteRecoveryProofTarget(request, f.rootContext, binding, scope.capabilityGeneration, nonce);
  const b = f.rootContext.binding;
  const selectors = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId, clientNamespace: b.clientNamespace, branchScopeId: binding.branchScopeId, branchRef: binding.branchRef, authoritySessionId: binding.sessionId, targetSessionId: binding.sessionId, commandId: command.commandId, idempotencyKey: command.idempotencyKey, operationId: request.operationId, requestId: request.requestId, presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId, targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId, expiresAt: request.expiresAt };
  assert.equal(recovery.operationHash, sha("project-memory/command/v1", { proofPurpose: "recover-governed-note-result/v1", ...selectors }));
  assert.equal(governedNoteSummaryHash("Redacted summary"), sha("project-memory/governed-note-summary/v1", "Redacted summary"));
  assert.equal(governedNoteCommandHash(witness), sha("project-memory/governed-note-command/v1", witness));
  let borrowed!: Uint8Array, returned!: Buffer;
  const key = Buffer.alloc(32, 7), expectedInput = canonical({ input: { authority, binding, command }, keyRef: ref, projectId: authority.projectId, storeId: authority.storeId });
  const expected = createHmac("sha256", key).update("governed-note-original-input/v1\n").update(expectedInput).digest("hex");
  const provider: EvidenceKeyProvider = { ...f.provider, status: () => "available", currentKey: () => { throw new Error("no current key"); }, wrap: () => { throw new Error("no wrap"); }, unwrap: () => { throw new Error("no unwrap"); }, mac(s, purpose, r, domain, input) {
    assert.deepEqual(s, { projectId: authority.projectId, storeId: authority.storeId }); assert.equal(purpose, "original-input-commitment"); assert.deepEqual(r, ref); assert.equal(domain, "governed-note-original-input/v1"); assert.equal(Buffer.from(input).toString(), expectedInput);
    borrowed = input; returned = createHmac("sha256", key).update(domain + "\n").update(input).digest(); return returned;
  } };
  assert.equal(buildGovernedNoteOriginalCommitment(command, authority, binding, ref, provider), expected);
  assert.ok(borrowed.every(byte => byte === 0)); assert.ok(returned.every(byte => byte === 0)); key.fill(0);
});

test("historical original equality includes scope and original Unicode", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const { command, authority, binding, ref, witness } = witnessFor(f), raw = witness.originalInputCommitment;
  for (const summary of [command.summary.normalize("NFC"), command.summary.trim()]) {
    assert.notEqual(buildGovernedNoteOriginalCommitment({ ...command, summary }, authority, binding, ref, f.provider), raw);
    assert.throws(() => assertGovernedNoteOriginalEquality({ ...command, summary }, authority, binding, witness, f.provider), { code: "IDEMPOTENCY_CONFLICT" });
  }
  assert.equal(buildGovernedNoteOriginalCommitment({ ...command, provenance: [...command.provenance].reverse() }, authority, binding, ref, f.provider), raw);
  assert.notEqual(buildGovernedNoteOriginalCommitment(command, authority, { ...binding, branchRef: "refs/heads/other" }, ref, f.provider), raw);
  f.provider.rotate("original-input-commitment"); const calls = { ...f.provider.calls };
  assertGovernedNoteOriginalEquality(command, authority, binding, witness, f.provider);
  assert.equal(f.provider.calls.current, calls.current); assert.equal(f.provider.calls.wrap, calls.wrap); assert.equal(f.provider.calls.fingerprint, calls.fingerprint);
  f.provider.forget("original-input-commitment", ref.version);
  assert.throws(() => assertGovernedNoteOriginalEquality(command, authority, binding, witness, f.provider), { code: "GOVERNED_NOTE_KEY_UNAVAILABLE", message: "GOVERNED_NOTE_KEY_UNAVAILABLE", details: { commandId: command.commandId, idempotencyKey: command.idempotencyKey } });
});

test("provider exceptions invalid MAC and malformed historical MAC are safe", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const { command, authority, binding, ref, witness } = witnessFor(f), expected = { code: "GOVERNED_NOTE_KEY_UNAVAILABLE", message: "GOVERNED_NOTE_KEY_UNAVAILABLE", details: { commandId: command.commandId, idempotencyKey: command.idempotencyKey } };
  for (const failure of ["status", "mac", "length"] as const) {
    const output = Buffer.alloc(31, 8); let input: Uint8Array | undefined;
    const provider: EvidenceKeyProvider = { currentKey: f.provider.currentKey.bind(f.provider), wrap: f.provider.wrap.bind(f.provider), unwrap: f.provider.unwrap.bind(f.provider), status: () => { if (failure === "status") throw new Error("private provider exception"); return "available"; }, mac: (_s, _p, _r, _d, bytes) => { input = bytes; if (failure === "mac") throw new Error("private provider exception"); return output; } };
    assert.throws(() => buildGovernedNoteOriginalCommitment(command, authority, binding, ref, provider), expected);
    if (input) assert.ok(input.every(byte => byte === 0)); if (failure === "length") assert.ok(output.every(byte => byte === 0));
  }
  for (const mac of ["00", "g".repeat(64), "A".repeat(64)]) assert.throws(() => assertGovernedNoteOriginalEquality(command, authority, binding, { ...witness, originalInputCommitment: mac }, f.provider), { code: "INTEGRITY_FAILURE" });
});

test("wrong proof domain target hash nonce retained substitution and oversized generation refuse", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const command = f.command(), prepared = f.prepareCreate(command), before = fullRows(f), s = f.scope(f.rootContext), binding = deriveGovernedNoteBinding(f.connection, f.rootContext, s.targetSessionId);
  const target = governedNoteCreateProofTarget(command, s, binding, randomUUID());
  for (const intentHash of [sha("project-memory/command/v1", { proofPurpose: "retain-evidence-batch/v1", scope: s, binding, originalCommand: canonical(command) }), sha("project-memory/command/v1", { proofPurpose: "wrong/v1", scope: s, binding, originalCommand: canonical(command) }), "f".repeat(64)]) {
    const proof = f.mint(f.rootContext, { ...target, intentHash }); assert.throws(() => f.verifier.verifyCreate({ ...prepared, authorization: { ...prepared.authorization, proof } }, f.rootContext), { code: "SESSION_CAPABILITY_INVALID" });
  }
  for (const proof of [{ ...prepared.authorization.proof, target: "bounded-operation" }, { ...prepared.authorization.proof, proofNonce: randomUUID() }, { ...prepared.authorization.proof, proofFingerprint: "0".repeat(64) }]) assert.throws(() => f.verifier.verifyCreate({ ...prepared, authorization: { ...prepared.authorization, proof: proof as never } }, f.rootContext));
  assert.throws(() => governedNoteCreateProofTarget(command, { ...s, capabilityGeneration: "9223372036854775808" }, binding, randomUUID()));
  assert.throws(() => governedNoteCreateProofTarget(command, s, binding, "11111111-1111-1111-8111-111111111111"));
  const recovery = f.prepareRecovery(command, expiry(f));
  assert.throws(() => governedNoteRecoveryProofTarget(recovery.request, f.rootContext, binding, "9223372036854775808", randomUUID()));
  assert.throws(() => governedNoteRecoveryProofTarget(recovery.request, f.rootContext, binding, s.capabilityGeneration, "11111111-1111-1111-8111-111111111111"));
  assert.throws(() => f.verifier.verifyRecovery({ ...recovery, authorization: { ...recovery.authorization, audience: { ...recovery.authorization.audience, targetClientInstanceId: "other" } } }, f.rootContext));
  assert.throws(() => f.verifier.verifyRecovery({ ...recovery, request: { ...recovery.request, requestId: randomUUID() } }, f.rootContext));
  assert.equal(fullRows(f), before);
});

test("recovery strict future worker expiry and stale handles", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const command = f.command(), prepared = f.prepareRecovery(command, expiry(f)), handle = f.verifier.verifyRecovery(prepared, f.rootContext), before = fullRows(f);
  f.clock.set(BigInt(Date.parse(prepared.request.expiresAt)));
  assert.throws(() => f.verifier.revalidateRecovery(handle), { code: "SESSION_CAPABILITY_EXPIRED" });
  assert.throws(() => f.verifier.verifyRecovery(prepared, f.rootContext), { code: "SESSION_CAPABILITY_EXPIRED" });
  assert.equal(fullRows(f), before);
});

test("optional branch scope derives current binding", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const workspace = { kind: "git" as const, workspaceId: f.rootContext.binding.workspaceId, branchRef: "refs/heads/governed", headCommit: "a".repeat(40), detached: false, worktreeRoot: "C:/synthetic" };
  const context = { ...f.rootContext, workspace } as ProjectContext, sessionId = f.retained.rootAuthority.sessionId;
  const repo = new BranchScopeRepository(); const scopeId = repo.resolveOrCreate(f.connection, context.binding.projectId, workspace, f.clock.now());
  const before = fullRows(f), binding = deriveGovernedNoteBinding(f.connection, context, sessionId);
  assert.deepEqual(binding, { projectId: context.binding.projectId, vaultId: context.binding.vaultId, storeId: context.binding.storeId, workspaceId: context.binding.workspaceId, branchScopeId: scopeId, branchRef: workspace.branchRef, sessionId });
  assert.deepEqual(deriveGovernedNoteBinding(f.connection, { ...context, branchScopeId: scopeId }, sessionId), binding);
  assert.throws(() => deriveGovernedNoteBinding(f.connection, { ...context, branchScopeId: randomUUID() as never }, sessionId), { code: "SESSION_OWNERSHIP_MISMATCH" });
  const command = f.command(), handle = f.verifier.verifyCreate(f.prepareCreate(command, context), context);
  f.connection.prepare("UPDATE branch_scopes SET retired_at = $now WHERE branch_scope_id = $id").run({ $now: f.clock.now(), $id: scopeId });
  const changed = fullRows(f); assert.throws(() => f.verifier.revalidateCreate(handle), { code: "SESSION_OWNERSHIP_MISMATCH" }); assert.equal(fullRows(f), changed);
  assert.notEqual(changed, before);
});
