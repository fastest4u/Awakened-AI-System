import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { makeGovernedNoteDomainFixture, type GovernedNoteDomainFixtureV1 } from "./support/governed-note-domain-fixture.js";
import { GovernedNoteError } from "../src/orchestrator/governed-notes/errors.js";
import { GovernedNoteRepository } from "../src/orchestrator/governed-notes/repository.js";
import { deriveGovernedNoteBinding, governedNoteRecoveryProofTarget } from "../src/orchestrator/governed-notes/authority.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import { checkpointFixture } from "./support/lifecycle-fixtures.js";
import { assertFreshStartConnectionAllowed } from "../src/orchestrator/fresh-start/fresh-start-admission.js";

const outcomes = ["committed", "not-found"] as const;
type Outcome = typeof outcomes[number];
const expiry = (f: GovernedNoteDomainFixtureV1) => new Date(Number(f.clock.nowMs() + 60000n)).toISOString();
function setup(f: GovernedNoteDomainFixtureV1, outcome: Outcome, child = false) {
  const context = child ? f.childContext : f.rootContext;
  const command = f.command({ provenance: f.sources[child ? "child" : "root"].map(({ kind, identity }) => ({ kind, identity })) });
  const created = outcome === "committed" ? f.service().create(f.prepareCreate(command, context), context) : undefined;
  return { context, command, created, prepared: f.prepareRecovery(command, expiry(f), context) };
}
function corrupt(f: GovernedNoteDomainFixtureV1, table: string, sql: string) {
  const guards = f.connection.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=$table").all({ $table: table });
  for (const guard of guards) f.connection.exec(`DROP TRIGGER "${String(guard.name).replaceAll('"', '""')}"`);
  try { f.connection.exec(sql); }
  finally { for (const guard of guards) f.connection.exec(String(guard.sql)); }
}
function noSuccess(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof GovernedNoteError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.deepEqual(error.details, {});
    assert.equal("retryable" in error, false);
    return true;
  });
}

for (const outcome of outcomes) for (const child of [false, true]) for (const mode of ["active", "read-only-recovery"] as const) {
  test(`${outcome} own ${child ? "child" : "root"} recovery independently admits ${mode} and returns exact frozen receipt without content work`, async t => {
    let armed = false, contentCalls = 0;
    const f = await makeGovernedNoteDomainFixture({ policy: () => { if (armed) { contentCalls++; throw new Error("private policy"); } return f.policy; } });
    t.after(f.cleanup);
    const { context, command, created, prepared } = setup(f, outcome, child);
    if (mode === "read-only-recovery") f.retained.admission.control.stop({ identity: f.retained.admission.trusted.identity, expectedGeneration: 1n, target: mode, reasonCode: "integrity-failure" });
    f.provider.setStatus("data-key-wrap", "revoked");
    f.provider.forget("original-input-commitment", "1");
    for (const method of ["currentKey", "status", "wrap", "unwrap", "mac"] as const) {
      f.provider[method] = (() => { contentCalls++; throw new Error("private content provider"); }) as never;
    }
    let capabilityCalls = 0;
    const verify = f.capabilities.verifyProof.bind(f.capabilities);
    f.capabilities.verifyProof = (...args) => { capabilityCalls++; return verify(...args); };
    armed = true;
    const before = f.rowContents(), result = f.service().recover(prepared, context);
    assert.deepEqual(result, outcome === "committed"
      ? { resultVersion: 1, operation: "recover-governed-note-result", outcome, receipt: { ...created!.response, replay: true } }
      : { resultVersion: 1, operation: "recover-governed-note-result", outcome, commandId: command.commandId, idempotencyKey: command.idempotencyKey });
    assert.ok(Object.isFrozen(result));
    if (result.outcome === "committed") for (const value of [result.receipt, result.receipt.scope, result.receipt.sourceEventIds]) assert.ok(Object.isFrozen(value));
    assert.ok(capabilityCalls >= 3);
    assert.equal(contentCalls, 0);
    assert.equal(f.rowContents(), before);
  });
}

for (const outcome of outcomes) for (const boundary of ["before-lookup", "inside-read", "final-verify", "before-commit"] as const) {
  test(`${outcome} admission is repeated at ${boundary}`, async t => {
    let f: GovernedNoteDomainFixtureV1, changed = false;
    const disable = () => { corrupt(f, "fresh_start_control_state", "UPDATE fresh_start_control_state SET mode='disabled'"); changed = true; };
    f = await makeGovernedNoteDomainFixture({ faults: { inject(point) {
      if (boundary === "final-verify" && point === "recovery-before-final-verify" || boundary === "before-commit" && point === "recovery-before-commit") disable();
    } } });
    t.after(f.cleanup);
    const { prepared, context } = setup(f, outcome);
    const exec = f.connection.exec.bind(f.connection);
    if (boundary === "before-lookup") disable();
    if (boundary === "inside-read") f.connection.exec = sql => { exec(sql); if (sql === "BEGIN DEFERRED") disable(); };
    let lookups = 0;
    const find = GovernedNoteRepository.prototype.findGovernedNotePriorAny;
    GovernedNoteRepository.prototype.findGovernedNotePriorAny = function (...args) { lookups++; return find.apply(this, args); };
    const before = f.rowContents();
    try { noSuccess(() => f.service().recover(prepared, context), "FRESH_START_ADMISSION_DENIED"); }
    finally { f.connection.exec = exec; GovernedNoteRepository.prototype.findGovernedNotePriorAny = find; }
    assert.equal(changed, true);
    assert.equal(lookups, boundary === "before-lookup" || boundary === "inside-read" ? 0 : 1);
    assert.equal(f.rowContents(), before);
  });
}

for (const outcome of outcomes) for (const mismatch of ["release", "build", "schema", "tail", "freshness"] as const) {
  test(`${outcome} refuses ${mismatch} admission before result lookup`, async t => {
    const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
    const { prepared, context } = setup(f, outcome);
    if (mismatch === "release") {
      const replacement = randomUUID();
      f.connection.exec(`INSERT INTO fresh_start_releases SELECT project_id,vault_id,store_id,'${replacement}',profile_version,build_identity_hash,schema_identity_hash,configuration_hash,capability_manifest_hash,recovery_policy_hash,evidence_digest,created_at FROM fresh_start_releases`);
      corrupt(f, "fresh_start_control_state", `UPDATE fresh_start_control_state SET release_id='${replacement}'`);
    } else if (mismatch === "build" || mismatch === "schema") corrupt(f, "fresh_start_releases", `UPDATE fresh_start_releases SET ${mismatch}_identity_hash='${"b".repeat(64)}'`);
    else if (mismatch === "freshness") corrupt(f, "fresh_start_control_state", "UPDATE fresh_start_control_state SET generation=0");
    else {
      f.retained.admission.control.stop({ identity: f.retained.admission.trusted.identity, expectedGeneration: 1n, target: "read-only-recovery", reasonCode: "integrity-failure" });
      corrupt(f, "fresh_start_control_state", `UPDATE fresh_start_control_state SET recovery_hash='${"0".repeat(64)}'`);
    }
    const before = f.rowContents();
    let lookups = 0;
    const find = GovernedNoteRepository.prototype.findGovernedNotePriorAny;
    GovernedNoteRepository.prototype.findGovernedNotePriorAny = function (...args) { lookups++; return find.apply(this, args); };
    try { noSuccess(() => f.service().recover(prepared, context), { release: "FRESH_START_RELEASE_MISMATCH", build: "FRESH_START_BUILD_MISMATCH", schema: "FRESH_START_SCHEMA_MISMATCH", tail: "FRESH_START_RECOVERY_REQUIRED", freshness: "FRESH_START_ADMISSION_STALE" }[mismatch]); }
    finally { GovernedNoteRepository.prototype.findGovernedNotePriorAny = find; }
    assert.equal(lookups, 0); assert.equal(f.rowContents(), before);
  });
}

for (const outcome of outcomes) for (const point of ["before-lookup", "inside-read", "T-1", "T", "after-detach", "during-commit"] as const) {
  test(`${outcome} strict worker expiry ${point}`, async t => {
    let f: GovernedNoteDomainFixtureV1, expires = 0n, detached = 0, readOpen = false;
    const observations: string[] = [];
    const transactionObservations: boolean[] = [];
    f = await makeGovernedNoteDomainFixture({ faults: { inject(p) {
      if (!p.startsWith("recovery-")) return;
      observations.push(p);
      transactionObservations.push(readOpen);
      if (p === "recovery-before-final-verify" && (point === "T" || point === "T-1")) f.clock.set(expires - (point === "T-1" ? 1n : 0n));
      if (p === "recovery-after-detach") { detached++; if (point === "after-detach") f.clock.set(expires); }
    } } });
    t.after(f.cleanup);
    const { prepared, context } = setup(f, outcome); expires = BigInt(Date.parse(prepared.request.expiresAt));
    const exec = f.connection.exec.bind(f.connection), before = f.rowContents();
    f.connection.exec = sql => {
      if (sql === "COMMIT" && point === "during-commit") f.clock.set(expires + 1n);
      exec(sql);
      if (sql === "BEGIN DEFERRED") readOpen = true;
      if (sql === "COMMIT" || sql === "ROLLBACK") readOpen = false;
      if (sql === "BEGIN DEFERRED" && point === "inside-read") f.clock.set(expires);
    };
    if (point === "before-lookup") f.clock.set(expires);
    const success = ["T-1", "after-detach", "during-commit"].includes(point);
    try {
      if (success) assert.equal(f.service().recover(prepared, context).outcome, outcome);
      else noSuccess(() => f.service().recover(prepared, context), "SESSION_CAPABILITY_EXPIRED");
    } finally { f.connection.exec = exec; }
    assert.equal(detached, success ? 1 : 0);
    if (success) assert.deepEqual(observations, ["recovery-before-final-verify", "recovery-after-detach", "recovery-before-commit"]);
    assert.ok(transactionObservations.every(Boolean)); assert.equal(readOpen, false);
    assert.equal(f.rowContents(), before);
  });
}

for (const outcome of outcomes) test(`${outcome} expiry crossing after final revalidation but immediately before detach refuses`, async t => {
  let f: GovernedNoteDomainFixtureV1, final = false, detached = false;
  f = await makeGovernedNoteDomainFixture({ faults: { inject(p) { if (p === "recovery-before-final-verify") final = true; if (p === "recovery-after-detach") detached = true; } } });
  t.after(f.cleanup);
  const { prepared, context } = setup(f, outcome), before = f.rowContents();
  const revalidate = f.verifier.revalidateRecovery.bind(f.verifier);
  f.verifier.revalidateRecovery = handle => { const snapshot = revalidate(handle); if (final) f.clock.set(BigInt(Date.parse(prepared.request.expiresAt))); return snapshot; };
  noSuccess(() => f.service().recover(prepared, context), "SESSION_CAPABILITY_EXPIRED");
  assert.equal(final, true); assert.equal(detached, false); assert.equal(f.rowContents(), before);
});

for (const outcome of outcomes) for (const fault of ["commit-before", "commit-after", "rollback", "after-detach"] as const) {
  test(`${outcome} read ${fault} failure withholds private result without mutation uncertainty`, async t => {
    let detached = 0;
    const f = await makeGovernedNoteDomainFixture({ faults: { inject(p) {
      if (p === "recovery-after-detach") { detached++; if (fault === "after-detach") throw new Error("private detached failure"); }
      if (p === "recovery-before-final-verify" && fault === "rollback") throw new GovernedNoteError("SESSION_CAPABILITY_EXPIRED");
    } } });
    t.after(f.cleanup);
    const { prepared, context } = setup(f, outcome), before = f.rowContents();
    const laterCreate = fault === "rollback" ? f.prepareCreate(f.command(), context) : undefined;
    const exec = f.connection.exec.bind(f.connection); let rollbacks = 0, repaired = false;
    f.connection.exec = sql => {
      if (sql === "COMMIT" && fault === "commit-before") throw new Error("private commit before");
      if (sql === "ROLLBACK") { rollbacks++; if (fault === "rollback" && rollbacks === 1) throw new Error("private first cleanup"); }
      exec(sql);
      if (sql === "COMMIT" && fault === "commit-after") throw new Error("private commit after");
    };
    try {
      noSuccess(() => f.service().recover(prepared, context), "GOVERNED_NOTE_UNAVAILABLE");
      if (fault === "rollback") {
        let verificationCalls = 0;
        const verify = f.verifier.verifyRecovery.bind(f.verifier);
        f.verifier.verifyRecovery = (...args) => { verificationCalls++; return verify(...args); };
        // A new service over the same connection cannot resume admission while
        // the failed cleanup still owns an open read transaction.
        noSuccess(() => f.service().recover(prepared, context), "GOVERNED_NOTE_UNAVAILABLE");
        assert.equal(verificationCalls, 0);
        noSuccess(() => f.service().create(laterCreate!, context), "GOVERNED_NOTE_UNAVAILABLE");
        exec("ROLLBACK"); repaired = true;
        const retry = f.prepareRecovery(prepared.request, expiry(f), context);
        noSuccess(() => f.service().recover(retry, context), "GOVERNED_NOTE_UNAVAILABLE");
        assert.equal(verificationCalls, 0, "later successful cleanup cannot heal uncertainty");
        noSuccess(() => f.service().create(laterCreate!, context), "GOVERNED_NOTE_UNAVAILABLE");
      }
    }
    finally { f.connection.exec = exec; if (fault === "rollback" && rollbacks > 0 && !repaired) exec("ROLLBACK"); }
    assert.equal(detached, fault === "rollback" ? 0 : 1);
    if (fault === "rollback") assert.equal(rollbacks, 1);
    assert.equal(f.rowContents(), before);
  });
}

for (const outcome of outcomes) test(`${outcome} wrong bounded operation selectors domain audience and proof refuse`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const { prepared, context } = setup(f, outcome), before = f.rowContents();
  for (const field of ["operationId", "requestId", "commandId", "idempotencyKey", "expiresAt"] as const) {
    const request = { ...prepared.request, [field]: field === "expiresAt" ? new Date(Date.parse(prepared.request.expiresAt) + 1).toISOString() : randomUUID() };
    noSuccess(() => f.service().recover({ ...prepared, request }, context), "SESSION_CAPABILITY_INVALID");
  }
  noSuccess(() => f.service().recover({ ...prepared, authorization: { ...prepared.authorization, proof: { ...prepared.authorization.proof, proofNonce: randomUUID() } } }, context), "SESSION_CAPABILITY_INVALID");
  noSuccess(() => f.service().recover({ ...prepared, authorization: { ...prepared.authorization, audience: { ...prepared.authorization.audience, targetClientInstanceId: "other-owner" } } }, context), "SESSION_OWNERSHIP_MISMATCH");
  const s = f.scope(context), target = governedNoteRecoveryProofTarget(prepared.request, context, deriveGovernedNoteBinding(f.connection, context, s.targetSessionId), s.capabilityGeneration, randomUUID());
  for (const changed of [{ ...target, operationType: "other-operation" }, { ...target, operationHash: "f".repeat(64) }]) {
    noSuccess(() => f.service().recover({ ...prepared, authorization: { ...prepared.authorization, proof: f.mint(context, changed) } }, context), "SESSION_CAPABILITY_INVALID");
  }
  assert.equal(f.rowContents(), before);
});

for (const outcome of outcomes) for (const primaryFailure of [false, true]) test(`${outcome} authority cleanup failure withholds ${primaryFailure ? "expired refusal" : "committed read"} and revokes attempt`, async t => {
  const f = await makeGovernedNoteDomainFixture({ faults: { inject(p) {
    if (primaryFailure && p === "recovery-before-final-verify") throw new GovernedNoteError("SESSION_CAPABILITY_EXPIRED");
  } } });
  t.after(f.cleanup);
  const { prepared, context } = setup(f, outcome), before = f.rowContents();
  const discard = f.verifier.discardRecovery.bind(f.verifier);
  let discarded: Parameters<typeof discard>[0] | undefined, calls = 0;
  f.verifier.discardRecovery = handle => { discard(handle); discarded = handle; calls++; throw new Error("private cleanup failure"); };
  noSuccess(() => f.service().recover(prepared, context), "GOVERNED_NOTE_UNAVAILABLE");
  assert.equal(calls, 1); assert.ok(discarded);
  const revoked = discarded;
  assert.throws(() => f.verifier.revalidateRecovery(revoked), { code: "SESSION_CAPABILITY_INVALID" });
  assert.equal(f.rowContents(), before);
});

for (const outcome of outcomes) test(`${outcome} root on child refuses before capability proof verification`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const { prepared } = setup(f, outcome, true), before = f.rowContents();
  let calls = 0;
  const verify = f.capabilities.verifyProof.bind(f.capabilities);
  f.capabilities.verifyProof = (...args) => { calls++; return verify(...args); };
  // G01 decoding rejects unequal sessions before G02 or its capability provider.
  noSuccess(() => f.service().recover({ ...prepared, authorization: { ...prepared.authorization, authoritySessionId: f.retained.rootAuthority.sessionId as never } }, f.childContext), "GOVERNED_NOTE_INPUT_INVALID");
  assert.equal(calls, 0); assert.equal(f.rowContents(), before);
});

for (const corruption of ["event-orphan", "dedup-orphan", "bad-payload", "command-collision", "key-collision"] as const) test(`${corruption} cannot be qualified absence`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const { command } = setup(f, "committed");
  if (corruption === "event-orphan") corrupt(f, "command_dedup", `DELETE FROM command_dedup WHERE command_id='${command.commandId}'`);
  if (corruption === "dedup-orphan") {
    f.connection.exec("PRAGMA foreign_keys=OFF");
    try { corrupt(f, "events", `DELETE FROM events WHERE command_id='${command.commandId}'`); }
    finally { f.connection.exec("PRAGMA foreign_keys=ON"); }
  }
  if (corruption === "bad-payload") corrupt(f, "events", `UPDATE events SET payload_json='{}' WHERE command_id='${command.commandId}'`);
  const ids = { commandId: corruption === "command-collision" ? randomUUID() : command.commandId, idempotencyKey: corruption === "key-collision" ? randomUUID() : command.idempotencyKey };
  const prepared = f.prepareRecovery(ids, expiry(f)), before = f.rowContents();
  noSuccess(() => f.service().recover(prepared, f.rootContext), corruption.endsWith("collision") ? "IDEMPOTENCY_CONFLICT" : "INTEGRITY_FAILURE");
  assert.equal(f.rowContents(), before);
});

for (const outcome of outcomes) for (const change of ["ended", "revoked", "generation", "fold"] as const) test(`${outcome} current ${change} at final verification refuses`, async t => {
  let f: GovernedNoteDomainFixtureV1, changed = false, detached = false;
  f = await makeGovernedNoteDomainFixture({ faults: { inject(p) {
    if (p === "recovery-after-detach") detached = true;
    if (p !== "recovery-before-final-verify") return;
    const assignment = { ended: "semantic_state='ended'", revoked: "revocation_event_position=1", generation: "owner_generation=2", fold: `authority_commitment='${"f".repeat(64)}'` }[change];
    corrupt(f, "session_authority", `UPDATE session_authority SET ${assignment} WHERE session_id='${f.retained.rootAuthority.sessionId}'`);
    changed = true;
  } } });
  t.after(f.cleanup);
  const { prepared, context } = setup(f, outcome), before = f.rowContents();
  assert.throws(() => f.service().recover(prepared, context), (error: unknown) => error instanceof GovernedNoteError && ["SESSION_HANDLE_STALE", "INTEGRITY_FAILURE"].includes(error.code));
  assert.equal(changed, true); assert.equal(detached, false); assert.equal(f.rowContents(), before);
});

for (const outcome of outcomes) test(`${outcome} actual distinct incoming owner transfer refuses historical root and child recovery`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const root = setup(f, outcome), child = setup(f, outcome, true);
  assertFreshStartConnectionAllowed(f.connection, "command-recovery");
  for (const { prepared, context } of [root, child]) f.verifier.discardRecovery(f.verifier.verifyRecovery(prepared, context));
  const { checkpointId: _i, sessionId: _s, parentSessionId: _p, baseEventPosition: _b, checkpointEventPosition: _e, createdAt: _at, creatorAgentId: _a, creatorClientInstanceId: _c, sourceState: _st, childSummaries: _ch, evidenceCoverage: _cv, ...draft } = checkpointFixture();
  await f.retained.lifecycle.checkpoint(f.retained.rootAuthority.sessionId, f.retained.rootAuthority.descriptor, draft as unknown as JsonValue);
  const incoming = { ...f.rootContext, binding: { ...f.rootContext.binding, clientInstanceId: "recovery-incoming-owner" } };
  incoming.binding.contextFingerprint = computeProjectContextFingerprint(incoming.binding);
  const resumed = await f.retained.lifecycle.resumeAfterExpiry(f.retained.rootAuthority.sessionId, f.retained.rootAuthority.descriptor, incoming);
  assert.equal(resumed.publicResult.ownerGeneration, "2");
  const before = f.rowContents();
  for (const { prepared, context } of [root, child]) assert.throws(() => f.service().recover(prepared, context), (error: unknown) => error instanceof GovernedNoteError && ["SESSION_HANDLE_STALE", "SESSION_OWNERSHIP_MISMATCH"].includes(error.code));
  assert.equal(f.rowContents(), before);
});

for (const outcome of outcomes) test(`${outcome} actual child completion revokes recovery while nonterminal child permits it`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const { prepared, context } = setup(f, outcome, true), child = f.retained.childAuthority, b = f.rootContext.binding;
  const base = () => ({ commandId: randomUUID(), idempotencyKey: `recovery-lifecycle/${randomUUID()}`, agentId: "fixture-agent", expectedProjectId: b.projectId, expectedVaultId: b.vaultId, expectedWorkspaceId: b.workspaceId, expectedBranchRef: null });
  const version = () => String(f.connection.prepare("SELECT current_version FROM streams WHERE stream_id=$s").get({ $s: `session/${child.sessionId}` })!.current_version);
  const report = await f.retained.protectedLifecycle({ ...base(), commandType: "record-child-report", parentSessionId: f.retained.rootAuthority.sessionId, childSessionId: child.sessionId, childAuthorAgentId: "fixture-agent", expectedStreamVersion: version(), report: { reportVersion: 1, outcomeSummary: "Synthetic work", findings: [{ summary: "Synthetic finding", evidenceReferences: [], confidence: "high" }], proposedDecisions: [], filesObservedOrChanged: [], verificationPerformed: [], openFollowUps: [], blockers: [], evidenceFingerprints: [] } }, child.sessionId, child);
  const reportId = (report.result as unknown as { publicResult: { reportId: string } }).publicResult.reportId;
  await f.retained.protectedLifecycle({ ...base(), commandType: "propose-child-completion", childSessionId: child.sessionId, expectedStreamVersion: version(), reportId }, child.sessionId, child);
  let before = f.rowContents();
  assert.equal(f.service().recover(prepared, context).outcome, outcome); assert.equal(f.rowContents(), before);
  await f.retained.protectedLifecycle({ ...base(), commandType: "complete-child-session", parentSessionId: f.retained.rootAuthority.sessionId, childSessionId: child.sessionId, expectedStreamVersion: version(), reportId }, child.sessionId);
  assert.ok(f.connection.prepare("SELECT revocation_event_position FROM session_authority WHERE session_id=$s").get({ $s: child.sessionId })!.revocation_event_position);
  before = f.rowContents();
  noSuccess(() => f.service().recover(prepared, context), "SESSION_HANDLE_STALE"); assert.equal(f.rowContents(), before);
});

for (const outcome of outcomes) test(`${outcome} current branch mismatch withholds result including optional context scope`, async t => {
  let f: GovernedNoteDomainFixtureV1, change = false, observed = false;
  f = await makeGovernedNoteDomainFixture({ faults: { inject(p) {
    if (p === "recovery-before-final-verify" && change) {
      f.connection.exec("UPDATE branch_scopes SET retired_at='2026-09-29T00:00:00.000Z'"); observed = true;
    }
  } } });
  t.after(f.cleanup);
  const workspace = { kind: "git" as const, workspaceId: f.rootContext.binding.workspaceId, branchRef: "refs/heads/recovery", headCommit: "a".repeat(40), detached: false, worktreeRoot: f.retained.root, gitDir: join(f.retained.root, ".git"), gitCommonDir: join(f.retained.root, ".git") };
  const branchScopeId = new BranchScopeRepository().resolveOrCreate(f.connection, f.rootContext.binding.projectId, workspace, f.clock.now());
  const context: ProjectContext = { ...f.rootContext, workspace, binding: { ...f.rootContext.binding, workspace } };
  context.binding.contextFingerprint = computeProjectContextFingerprint(context.binding);
  const command = f.command();
  if (outcome === "committed") f.service().create(f.prepareCreate(command), f.rootContext);
  const prepared = f.prepareRecovery(command, expiry(f), context), before = f.rowContents();
  if (outcome === "committed") noSuccess(() => f.service().recover(prepared, context), "SESSION_OWNERSHIP_MISMATCH");
  else {
    assert.equal(f.service().recover(prepared, context).outcome, "not-found");
    assert.equal(f.service().recover(prepared, { ...context, branchScopeId }).outcome, "not-found");
    change = true;
    noSuccess(() => f.service().recover(prepared, context), "SESSION_OWNERSHIP_MISMATCH"); assert.equal(observed, true);
  }
  assert.equal(f.rowContents(), before);
});
