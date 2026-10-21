import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import * as redaction from "../src/orchestrator/privacy/redaction.js";
import * as intent from "../src/orchestrator/governed-notes/intent.js";
import * as authority from "../src/orchestrator/governed-notes/authority.js";
import type { TrustedRedactionPolicyV1, TrustedRedactionRuleV1 } from "../src/orchestrator/privacy/redaction.js";
import type { GovernedNoteCommandV2, GovernedNoteWitnessV2, GovernedNoteAuthoritySnapshotV1, PreparedGovernedNoteCreateV2, PreparedGovernedNoteRecoveryV2, GovernedNoteRecoveryV2, GovernedNoteRecoveryIdsV1 } from "../src/orchestrator/governed-notes/contracts.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type { EvidenceKeyProvider, EvidenceKeyRefV1 } from "../src/orchestrator/privacy/evidence-key-provider.js";
import type { SemanticCommandProofTargetV1, BoundedOperationProofTargetV1 } from "../src/orchestrator/lifecycle/authority/capability-codec.js";
import { makeGovernedNoteDomainFixture } from "./support/governed-note-domain-fixture.js";

// Optional namespace seams keep the initial missing-API RED compilable.
type ContentRedactor = (summary: string, body: string, policy: TrustedRedactionPolicyV1) => Readonly<{ summary: string; body: string; policyId: string; policyVersion: string; spanCount: number }>;
const redact = (): ContentRedactor => {
  const fn = (redaction as unknown as { redactGovernedNoteContentV2?: ContentRedactor }).redactGovernedNoteContentV2;
  assert.equal(typeof fn, "function", "V2 literal content redactor must exist"); return fn!;
};
type IntentV2 = {
  buildGovernedNoteOriginalCommitmentV2(command: GovernedNoteCommandV2, snapshot: GovernedNoteAuthoritySnapshotV1, binding: ProjectBinding, ref: EvidenceKeyRefV1, provider: EvidenceKeyProvider): string;
  assertGovernedNoteOriginalEqualityV2(command: GovernedNoteCommandV2, snapshot: GovernedNoteAuthoritySnapshotV1, binding: ProjectBinding, witness: GovernedNoteWitnessV2, provider: EvidenceKeyProvider): void;
  governedNoteCommandHashV2(witness: GovernedNoteWitnessV2): string;
};
type AuthorityV2 = {
  governedNoteCreateProofTargetV2(command: GovernedNoteCommandV2, scope: authority.GovernedNoteCreateProofScopeV1, binding: ProjectBinding, nonce: string): SemanticCommandProofTargetV1;
  governedNoteRecoveryProofTargetV2(request: GovernedNoteRecoveryV2, context: ProjectContext, binding: ProjectBinding, generation: string, nonce: string): BoundedOperationProofTargetV1;
  requireGovernedNoteCreateAuthorityV2(connection: Parameters<typeof authority.requireGovernedNoteCreateAuthority>[0], handle: authority.VerifiedGovernedNoteCreateAuthority, command: GovernedNoteCommandV2, binding?: ProjectBinding): GovernedNoteAuthoritySnapshotV1;
};
type FixtureV2 = Awaited<ReturnType<typeof makeGovernedNoteDomainFixture>> & {
  commandV2(overrides?: Partial<GovernedNoteCommandV2>): GovernedNoteCommandV2;
  prepareCreateV2(command: GovernedNoteCommandV2, context?: ProjectContext): PreparedGovernedNoteCreateV2;
  prepareRecoveryV2(ids: GovernedNoteRecoveryIdsV1, expiresAt: string, context?: ProjectContext): PreparedGovernedNoteRecoveryV2;
  verifier: authority.GovernedNoteAuthorityVerifier & {
    verifyCreateV2(prepared: PreparedGovernedNoteCreateV2, context: ProjectContext): authority.VerifiedGovernedNoteCreateAuthority;
    verifyRecoveryV2(prepared: PreparedGovernedNoteRecoveryV2, context: ProjectContext): authority.VerifiedGovernedNoteRecoveryAuthority;
  };
};
async function fixture(): Promise<FixtureV2> {
  assert.equal(typeof (authority as unknown as Partial<AuthorityV2>).governedNoteCreateProofTargetV2, "function", "V2 create purpose must exist");
  return await makeGovernedNoteDomainFixture() as FixtureV2;
}
const a = authority as unknown as AuthorityV2, i = intent as unknown as IntentV2;
const policy = (rules: readonly TrustedRedactionRuleV1[] = []): TrustedRedactionPolicyV1 => Object.freeze({ policyId: "literal-notes", policyVersion: "2", rules: Object.freeze(rules.map(rule => Object.freeze({ ...rule }))) });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha = (domain: string, value: unknown) => createHash("sha256").update(domain + "\n").update(canonical(value)).digest("hex");
const expires = (f: FixtureV2) => new Date(Number(f.clock.nowMs() + 60000n)).toISOString();
function safeError(run: () => unknown, code: string, details: unknown = {}) {
  assert.throws(run, error => {
    assert.equal((error as Error).message, code);
    assert.equal((error as { code: string }).code, code);
    assert.deepEqual((error as { details: unknown }).details, details); return true;
  });
}
function witnessFor(f: FixtureV2, command: GovernedNoteCommandV2) {
  const handle = f.verifier.verifyCreateV2(f.prepareCreateV2(command), f.rootContext);
  const snapshot = f.verifier.revalidateCreate(handle), binding = f.verifier.bindingForCreate(handle);
  const ref = f.provider.currentKey({ projectId: snapshot.projectId, storeId: snapshot.storeId }, "original-input-commitment");
  const witness: GovernedNoteWitnessV2 = { witnessVersion: 2, commandType: "create-governed-note", commandId: command.commandId, idempotencyKey: command.idempotencyKey,
    recordId: randomUUID(), noteEventId: randomUUID(), sourceEventId: randomUUID(), recordKind: command.recordKind, confidence: command.confidence,
    authority: snapshot, binding, provenance: f.sources.root, policyId: f.policy.policyId, policyVersion: f.policy.policyVersion, originalCommitmentKeyRef: ref,
    originalInputCommitment: i.buildGovernedNoteOriginalCommitmentV2(command, snapshot, binding, ref, f.provider), summaryContentHash: "a".repeat(64), contentFormat: "markdown", bodyContentHash: "b".repeat(64), recordedAt: f.clock.now() };
  return { snapshot, binding, ref, witness, handle };
}

test("literal_redaction_preserves_markdown and one frozen identity across fields", () => {
  const trusted = policy([{ kind: "literal", ruleId: "private", value: "secret-value" }]);
  const body = " \t# e\u0301 ไทย 🙂  \r\n```text\r\n\tsecret-value  \r\n```\n\tend  \n";
  const result = redact()("  e\u0301 secret-value  ", body, trusted);
  assert.equal(result.body, " \t# e\u0301 ไทย 🙂  \r\n```text\r\n\t[REDACTED]  \r\n```\n\tend  \n");
  assert.equal(result.summary, "é [REDACTED]");
  assert.equal(result.policyId, "literal-notes"); assert.equal(result.policyVersion, "2"); assert.equal(result.spanCount, 2);
  assert.ok(Object.isFrozen(trusted)); assert.ok(Object.isFrozen(result));
  assert.equal(redact()("e\u0301", " e\u0301 ", policy([{ kind: "literal", ruleId: "nfc", value: "é" }])).body, " e\u0301 ");
});

test("combined_span_budget_is_4096", () => {
  const fn = redact(), p = policy([{ kind: "literal", ruleId: "match", value: "x" }]);
  assert.equal(fn("x ".repeat(100), "x ".repeat(3996), p).spanCount, 4096);
  safeError(() => fn("x ".repeat(100), "x ".repeat(3997), p), "GOVERNED_NOTE_LIMIT_EXCEEDED");
});

test("literal body raw and final byte gates reject expansion and invalid Unicode safely", () => {
  const fn = redact();
  assert.equal(fn("summary", "🙂".repeat(16384), policy()).body, "🙂".repeat(16384));
  safeError(() => fn("summary", "a".repeat(65537), policy()), "GOVERNED_NOTE_LIMIT_EXCEEDED");
  const p = policy([{ kind: "literal", ruleId: "expand", value: "x" }]);
  assert.equal(Buffer.byteLength(fn("summary", "a".repeat(65526) + "x", p).body), 65536);
  safeError(() => fn("summary", "a".repeat(65527) + "x", p), "GOVERNED_NOTE_LIMIT_EXCEEDED");
  for (const body of ["", " \t\r\n", "\ud800", "\udc00", "a\u0000", "a\u000b", "a\u001f", "a\u007f"])
    safeError(() => fn("summary", body, policy()), "GOVERNED_NOTE_INPUT_INVALID");
  for (const summary of ["", " \t\n", "\ud800"]) safeError(() => fn(summary, "body", policy()), "GOVERNED_NOTE_INPUT_INVALID");
  safeError(() => fn("x".repeat(2049), "body", policy()), "GOVERNED_NOTE_LIMIT_EXCEEDED");
  safeError(() => fn("\u0344".repeat(600), "body", policy()), "GOVERNED_NOTE_LIMIT_EXCEEDED");
});

test("missing invalid and oversized policy fail without original text", () => {
  const fn = redact();
  for (const p of [undefined, { policyId: "not-frozen", policyVersion: "2", rules: [] }, policy([{ kind: "process-secret", ruleId: "process", referenceId: "absent", required: true, value: null }])])
    safeError(() => fn("secret-value", "secret-value", p as TrustedRedactionPolicyV1), "GOVERNED_NOTE_POLICY_UNAVAILABLE");
  safeError(() => fn("summary", "body", policy(Array.from({ length: 257 }, (_, n) => ({ kind: "literal", ruleId: `r${n}`, value: "unmatched" })))), "GOVERNED_NOTE_LIMIT_EXCEEDED");
  safeError(() => fn("summary", "body", policy([{ kind: "literal", ruleId: "long", value: "a".repeat(2049) }])), "GOVERNED_NOTE_LIMIT_EXCEEDED");
});

test("proof_binds_captured_original_v2 and independent purpose/hash/MAC vectors", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const command = f.commandV2({ content: { format: "markdown", body: " \te\u0301 secret-value\r\n" } });
  const { snapshot, binding, ref, witness } = witnessFor(f, command), scope = f.scope(f.rootContext), nonce = randomUUID();
  const create = a.governedNoteCreateProofTargetV2(command, scope, binding, nonce);
  assert.equal(create.intentHash, sha("project-memory/command/v1", { proofPurpose: "create-governed-note/v2", scope, binding, originalCommand: canonical(command) }));
  const prepared = f.prepareRecoveryV2(command, expires(f)), request = prepared.request, b = f.rootContext.binding;
  const recovery = a.governedNoteRecoveryProofTargetV2(request, f.rootContext, binding, scope.capabilityGeneration, nonce);
  const selectors = { projectId: b.projectId, vaultId: b.vaultId, storeId: b.storeId, workspaceId: b.workspaceId, clientNamespace: b.clientNamespace, branchScopeId: binding.branchScopeId, branchRef: binding.branchRef,
    authoritySessionId: binding.sessionId, targetSessionId: binding.sessionId, commandId: request.commandId, idempotencyKey: request.idempotencyKey, operationId: request.operationId, requestId: request.requestId,
    presentingActorRole: b.actorRole, presentingClientInstanceId: b.clientInstanceId, targetActorRole: b.actorRole, targetClientInstanceId: b.clientInstanceId, expiresAt: request.expiresAt };
  assert.equal(recovery.operationHash, sha("project-memory/command/v1", { proofPurpose: "recover-governed-note-result/v2", ...selectors }));
  assert.equal(i.governedNoteCommandHashV2(witness), sha("project-memory/governed-note-command/v2", witness));
  const input = canonical({ input: { authority: snapshot, binding, command }, keyRef: ref, projectId: snapshot.projectId, storeId: snapshot.storeId });
  const key = Buffer.alloc(32, 7); let borrowed!: Uint8Array, returned!: Buffer;
  const provider: EvidenceKeyProvider = { currentKey: () => { throw Error("current key forbidden"); }, status: () => "available", wrap: () => { throw Error("wrap forbidden"); }, unwrap: () => { throw Error("unwrap forbidden"); },
    mac(s, purpose, r, domain, bytes) {
      assert.deepEqual(s, { projectId: snapshot.projectId, storeId: snapshot.storeId }); assert.equal(purpose, "original-input-commitment"); assert.deepEqual(r, ref);
      assert.equal(domain, "governed-note-original-input/v2"); assert.equal(Buffer.from(bytes).toString(), input);
      borrowed = bytes; returned = createHmac("sha256", key).update(domain + "\n").update(bytes).digest(); return returned;
    } };
  assert.equal(i.buildGovernedNoteOriginalCommitmentV2(command, snapshot, binding, ref, provider), createHmac("sha256", key).update("governed-note-original-input/v2\n").update(input).digest("hex"));
  assert.ok(borrowed.every(byte => byte === 0)); assert.ok(returned.every(byte => byte === 0));
  const mutable = structuredClone(command), originalBody = mutable.content.body, captured = f.prepareCreateV2(mutable);
  (mutable.content as { body: string }).body = "caller changed";
  assert.equal(captured.command.content.body, originalBody);
  const handle = f.verifier.verifyCreateV2(captured, f.rootContext);
  a.requireGovernedNoteCreateAuthorityV2(f.connection, handle, command);
  safeError(() => f.verifier.verifyCreateV2({ ...captured, command: { ...command, content: { format: "markdown", body: "different raw body" } } }, f.rootContext), "SESSION_CAPABILITY_INVALID");
});

test("raw_equal_display_conflicts for secrets EOL NFC whitespace and raw summary", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const command = f.commandV2({ content: { format: "markdown", body: "password=private-a" } });
  const { snapshot, binding, ref, witness } = witnessFor(f, command);
  assert.equal(redact()(command.summary, command.content.body, policy()).body, redact()(command.summary, "password=private-b", policy()).body);
  i.assertGovernedNoteOriginalEqualityV2(command, snapshot, binding, witness, f.provider);
  for (const body of ["password=private-b", "password=private-a\r\n", "password=private-a\n", " password=private-a", "e\u0301", "é"]) {
    const changed = { ...command, content: { format: "markdown" as const, body } };
    assert.notEqual(i.buildGovernedNoteOriginalCommitmentV2(changed, snapshot, binding, ref, f.provider), witness.originalInputCommitment);
    safeError(() => i.assertGovernedNoteOriginalEqualityV2(changed, snapshot, binding, witness, f.provider), "IDEMPOTENCY_CONFLICT");
  }
  for (const [rawA, rawB] of [["literal\r\n", "literal\n"], ["e\u0301", "é"], ["literal ", "literal"]]) {
    const first = { ...command, content: { format: "markdown" as const, body: rawA! } }, second = { ...command, content: { format: "markdown" as const, body: rawB! } };
    const firstMac = i.buildGovernedNoteOriginalCommitmentV2(first, snapshot, binding, ref, f.provider);
    assert.notEqual(firstMac, i.buildGovernedNoteOriginalCommitmentV2(second, snapshot, binding, ref, f.provider));
    safeError(() => i.assertGovernedNoteOriginalEqualityV2(second, snapshot, binding, { ...witness, originalInputCommitment: firstMac }, f.provider), "IDEMPOTENCY_CONFLICT");
  }
  safeError(() => i.assertGovernedNoteOriginalEqualityV2({ ...command, summary: command.summary.normalize("NFC").trim() }, snapshot, binding, witness, f.provider), "IDEMPOTENCY_CONFLICT");
  safeError(() => i.assertGovernedNoteOriginalEqualityV2(command, snapshot, { ...binding, sessionId: randomUUID() }, witness, f.provider), "SESSION_OWNERSHIP_MISMATCH");
});

test("historical_v2_key_selection and absent historical key safely refuse", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const command = f.commandV2(), { snapshot, binding, ref, witness } = witnessFor(f, command);
  let statusCalls = 0;
  const provider: EvidenceKeyProvider = { currentKey: () => { throw Error("current selection forbidden"); }, status(s, p, r) { statusCalls++; assert.deepEqual(r, ref); return f.provider.status(s, p, r); },
    mac: (s, p, r, d, bytes) => f.provider.mac(s, p, r, d, bytes), wrap: (...args) => f.provider.wrap(...args), unwrap: (...args) => f.provider.unwrap(...args) };
  assert.equal(i.buildGovernedNoteOriginalCommitmentV2(command, snapshot, binding, witness.originalCommitmentKeyRef, provider), witness.originalInputCommitment);
  i.assertGovernedNoteOriginalEqualityV2(command, snapshot, binding, witness, provider); assert.equal(statusCalls, 2);
  safeError(() => i.assertGovernedNoteOriginalEqualityV2(command, snapshot, binding, witness, { ...provider, status: () => "unavailable" }), "GOVERNED_NOTE_KEY_UNAVAILABLE", { commandId: command.commandId, idempotencyKey: command.idempotencyKey });
});

for (const kind of ["root", "child"] as const) test(`V2 ${kind} create recovery and opaque ownership`, async t => {
  const f = await fixture(), other = await fixture(); t.after(f.cleanup); t.after(other.cleanup);
  const context = kind === "root" ? f.rootContext : f.childContext, command = f.commandV2(), before = f.rowContents();
  const create = f.verifier.verifyCreateV2(f.prepareCreateV2(command, context), context), snapshot = a.requireGovernedNoteCreateAuthorityV2(f.connection, create, command);
  assert.equal(snapshot.capabilityKind, `${kind}-session-handle`);
  const prepared = f.prepareRecoveryV2(command, expires(f), context), recovery = f.verifier.verifyRecoveryV2(prepared, context);
  assert.deepEqual(f.verifier.revalidateRecovery(recovery), snapshot);
  for (const handle of [{ ...create }, Object.freeze(Object.create(null)), recovery]) safeError(() => a.requireGovernedNoteCreateAuthorityV2(f.connection, handle as authority.VerifiedGovernedNoteCreateAuthority, command), "SESSION_CAPABILITY_INVALID");
  safeError(() => a.requireGovernedNoteCreateAuthorityV2(other.connection, create, command), "SESSION_CAPABILITY_INVALID");
  safeError(() => authority.requireGovernedNoteCreateAuthority(f.connection, create, f.command()), "SESSION_CAPABILITY_INVALID");
  safeError(() => a.requireGovernedNoteCreateAuthorityV2(f.connection, create, { ...command, content: { format: "markdown", body: "mutated" } }), "SESSION_CAPABILITY_INVALID");
  safeError(() => a.requireGovernedNoteCreateAuthorityV2(f.connection, create, command, { ...f.verifier.bindingForCreate(create), sessionId: randomUUID() }), "SESSION_OWNERSHIP_MISMATCH");
  const mutable = structuredClone(f.prepareCreateV2(command, context)), handle = f.verifier.verifyCreateV2(mutable, context);
  (mutable.command.content as { body: string }).body = "mutated after verification";
  a.requireGovernedNoteCreateAuthorityV2(f.connection, handle, command);
  f.verifier.discardRecovery(recovery); safeError(() => f.verifier.revalidateRecovery(recovery), "SESSION_CAPABILITY_INVALID");
  assert.equal(f.rowContents(), before);
});

test("V2 root/direct-child refusal matrix guards stale scope audience purpose and generation", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const command = f.commandV2(), root = f.prepareCreateV2(command), child = f.prepareCreateV2(command, f.childContext);
  const rootRecovery = f.prepareRecoveryV2(command, expires(f)), childRecovery = f.prepareRecoveryV2(command, expires(f), f.childContext), before = f.rowContents();
  const rootHandle = f.verifier.verifyCreateV2(root, f.rootContext), childHandle = f.verifier.verifyCreateV2(child, f.childContext);
  const rootRecoveryHandle = f.verifier.verifyRecoveryV2(rootRecovery, f.rootContext), childRecoveryHandle = f.verifier.verifyRecoveryV2(childRecovery, f.childContext);
  safeError(() => f.verifier.verifyCreateV2({ ...root, authorization: { ...root.authorization, targetSessionId: child.authorization.targetSessionId } }, f.childContext), "SESSION_OWNERSHIP_MISMATCH");
  safeError(() => f.verifier.verifyRecoveryV2({ ...rootRecovery, authorization: { ...rootRecovery.authorization, targetSessionId: childRecovery.authorization.targetSessionId } }, f.childContext), "SESSION_OWNERSHIP_MISMATCH");
  for (const changes of [{ actorRole: "maintenance" }, { clientInstanceId: "other" }, { clientNamespace: "other" }, { workspaceId: "f".repeat(64) }])
    safeError(() => f.verifier.verifyCreateV2(root, { ...f.rootContext, binding: { ...f.rootContext.binding, ...changes } } as ProjectContext), "SESSION_OWNERSHIP_MISMATCH");
  safeError(() => f.verifier.verifyRecoveryV2({ ...rootRecovery, authorization: { ...rootRecovery.authorization, audience: { ...rootRecovery.authorization.audience, targetClientInstanceId: "other" } } }, f.rootContext), "SESSION_OWNERSHIP_MISMATCH");
  const scope = f.scope(f.rootContext), binding = authority.deriveGovernedNoteBinding(f.connection, f.rootContext, scope.targetSessionId);
  const { content: _body, ...v1Command } = command;
  const oldProof = f.mint(f.rootContext, authority.governedNoteCreateProofTarget({ ...v1Command, version: 1 }, scope, binding, randomUUID()));
  safeError(() => f.verifier.verifyCreateV2({ ...root, authorization: { ...root.authorization, proof: oldProof } }, f.rootContext), "SESSION_CAPABILITY_INVALID");
  const wrongGeneration = f.mint(f.rootContext, a.governedNoteCreateProofTargetV2(command, { ...scope, capabilityGeneration: "2" }, binding, randomUUID()));
  safeError(() => f.verifier.verifyCreateV2({ ...root, authorization: { ...root.authorization, proof: wrongGeneration } }, f.rootContext), "SESSION_CAPABILITY_INVALID");
  const oldRecoveryProof = f.mint(f.rootContext, authority.governedNoteRecoveryProofTarget({ ...rootRecovery.request, version: 1 }, f.rootContext, binding, scope.capabilityGeneration, randomUUID()));
  safeError(() => f.verifier.verifyRecoveryV2({ ...rootRecovery, authorization: { ...rootRecovery.authorization, proof: oldRecoveryProof } }, f.rootContext), "SESSION_CAPABILITY_INVALID");
  const wrongRecoveryGeneration = f.mint(f.rootContext, a.governedNoteRecoveryProofTargetV2(rootRecovery.request, f.rootContext, binding, "2", randomUUID()));
  safeError(() => f.verifier.verifyRecoveryV2({ ...rootRecovery, authorization: { ...rootRecovery.authorization, proof: wrongRecoveryGeneration } }, f.rootContext), "SESSION_CAPABILITY_INVALID");
  assert.equal(f.rowContents(), before);
  const sibling = await f.retained.lifecycle.forkChild(f.retained.rootAuthority.sessionId, f.retained.rootAuthority.descriptor);
  safeError(() => f.verifier.verifyCreateV2({ ...child, authorization: { ...child.authorization, targetSessionId: sibling.sessionId as never } }, f.childContext), "SESSION_OWNERSHIP_MISMATCH");
  for (const [id, column, value] of [[f.retained.childAuthority.sessionId, "terminal_event_position", 1n], [f.retained.childAuthority.sessionId, "revocation_event_position", 1n], [f.retained.rootAuthority.sessionId, "semantic_state", "ended"], [f.retained.rootAuthority.sessionId, "owner_generation", 2n], [f.retained.childAuthority.sessionId, "child_capability_generation", 2n]] as const) {
    f.connection.exec("SAVEPOINT corruption");
    try {
      for (const guard of f.connection.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='session_authority'").all()) f.connection.exec(`DROP TRIGGER "${String(guard.name).replaceAll('"', '""')}"`);
      f.connection.prepare(`UPDATE session_authority SET ${column}=$value WHERE session_id=$id`).run({ $value: value, $id: id });
      const corrupted = f.rowContents(), isRoot = id === f.retained.rootAuthority.sessionId;
      for (const run of [() => f.verifier.verifyCreateV2(isRoot ? root : child, isRoot ? f.rootContext : f.childContext), () => f.verifier.verifyRecoveryV2(isRoot ? rootRecovery : childRecovery, isRoot ? f.rootContext : f.childContext),
        () => a.requireGovernedNoteCreateAuthorityV2(f.connection, isRoot ? rootHandle : childHandle, command), () => f.verifier.revalidateRecovery(isRoot ? rootRecoveryHandle : childRecoveryHandle)])
        assert.throws(run, error => { assert.ok(["SESSION_HANDLE_STALE", "INTEGRITY_FAILURE"].includes((error as { code: string }).code)); assert.equal((error as Error).message, (error as { code: string }).code); assert.deepEqual((error as { details: unknown }).details, {}); return true; });
      assert.equal(f.rowContents(), corrupted);
    } finally { f.connection.exec("ROLLBACK TO corruption"); f.connection.exec("RELEASE corruption"); }
  }
});

test("V2 recovery expiry and captured live authority revalidation", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const command = f.commandV2(), prepared = f.prepareRecoveryV2(command, expires(f)), recovery = f.verifier.verifyRecoveryV2(prepared, f.rootContext);
  const before = f.rowContents(); f.clock.set(BigInt(Date.parse(prepared.request.expiresAt)));
  safeError(() => f.verifier.revalidateRecovery(recovery), "SESSION_CAPABILITY_EXPIRED");
  safeError(() => f.verifier.assertRecoveryUnexpired(recovery), "SESSION_CAPABILITY_EXPIRED");
  assert.equal(f.rowContents(), before);
});
