import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { makeRetainedEvidenceFixture, type RetainedEvidenceFixture } from "./support/retained-evidence-fixture.js";
import { FRESH_NOW } from "./support/fresh-start-fixture.js";
import type { RetainEvidenceBatchCommandV1 } from "../src/orchestrator/privacy/evidence-contracts.js";
import { checkpointFixture } from "./support/lifecycle-fixtures.js";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";
import type { PreparedEventAppend } from "../src/orchestrator/storage/event-append-transaction.js";
import type { RetainedEvidenceReceiptV1 } from "../src/orchestrator/privacy/evidence-contracts.js";

const batch = (f: RetainedEvidenceFixture): RetainEvidenceBatchCommandV1 => ({ version: 1, commandType: "retain-evidence-batch",
  commandId: randomUUID(), idempotencyKey: randomUUID(), targetSessionId: f.rootAuthority.sessionId, conversationId: randomUUID(),
  frames: [{ frameId: randomUUID(), ordinal: "0", role: "user", category: "user-message", occurredAt: FRESH_NOW,
    mediaType: "text/plain; charset=utf-8", content: "fixture_alpha", previousFrameId: null, toolCorrelationId: null, artifactHashes: [] }] });
const snapshot = (f: RetainedEvidenceFixture) => JSON.stringify(Object.fromEntries([
  "events", "streams", "branch_scopes", "outbox", "command_dedup", "retained_evidence_blobs", "retained_evidence_stream_heads", "retained_evidence_command_authorizations",
].map(table => [table, f.connection.prepare(`SELECT * FROM ${table}`).all()])), (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
const counts = (f: RetainedEvidenceFixture) => ["events WHERE event_type='EvidenceBatchRetained'", "retained_evidence_blobs", "retained_evidence_stream_heads", "retained_evidence_command_authorizations", "command_dedup WHERE command_type='retain-evidence-batch'"]
  .map(table => Number(f.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n));
const rotate = (f: RetainedEvidenceFixture) => { for (const purpose of ["original-input-commitment", "redacted-content-fingerprint", "data-key-wrap"] as const) f.provider.rotate(purpose); };
const policyTwo = (f: RetainedEvidenceFixture) => Object.freeze({ ...f.policy, policyVersion: "2", rules: Object.freeze([]) });

// Catches replay choosing today's policy/keys or preparing replacement ciphertext.
test("exact retry and restart return original bundle without current policy or encryption", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const command = batch(f), firstRequest = f.invocation(command), firstNonce = firstRequest.authorization.proof!.proofNonce;
  const accepted = f.service().retain(firstRequest), committed = snapshot(f), calls = { ...f.provider.calls };
  rotate(f);
  f.provider.setStatus("data-key-wrap", "revoked", "1"); f.provider.setStatus("redacted-content-fingerprint", "unavailable", "1");
  const retry = f.invocation(command); assert.notEqual(retry.authorization.proof!.proofNonce, firstNonce);
  const replayed = f.service({ policy: () => { throw new Error("current policy must not be consulted"); } }).retain(retry);
  assert.deepEqual(replayed, { ...accepted, deduplicated: true }); assert.equal(snapshot(f), committed);
  assert.equal(f.provider.calls.wrap - calls.wrap, 0); assert.equal(f.provider.calls.fingerprint - calls.fingerprint, 0); assert.equal(f.provider.calls.current - calls.current, 0);
  f.reopen();
  const restarted = f.prepareWorker(command, policyTwo(f), false);
  const result = await restarted.result; assert.equal(result.ok, true);
  if (!result.ok) assert.fail("replacement worker refused exact historical retry");
  assert.deepEqual(result.value, replayed); assert.equal(snapshot(f), committed); assert.deepEqual(f.workerExits, [0]);
  assert.equal(f.provider.calls.wrap - calls.wrap, 0); assert.equal(f.provider.calls.fingerprint - calls.fingerprint, 0);
  assert.equal(retry.input.canonicalOriginalBytes.every(value => value === 0), true);
});

// Catches equality based on redacted placeholders or incomplete original metadata.
test("different secrets with identical redaction and changed original identities conflict", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const command = batch(f); f.service().retain(f.invocation(command)); const before = snapshot(f); rotate(f);
  const changed = [
    { ...command, frames: [{ ...command.frames[0]!, content: "fixture_bravo" }] },
    { ...command, frames: [{ ...command.frames[0]!, occurredAt: "2026-09-29T00:00:00.001Z" }] },
    { ...command, conversationId: randomUUID() }, { ...command, commandId: randomUUID() }, { ...command, idempotencyKey: randomUUID() },
  ];
  for (const value of changed) assert.throws(() => f.service().retain(f.invocation(value)), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(snapshot(f), before);
});

for (const status of ["revoked", "unavailable", "missing"] as const) {
  test(`historical commitment key ${status} retains recovery identity`, async t => {
    const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
    const command = batch(f); f.service().retain(f.invocation(command)); const before = snapshot(f); rotate(f);
    if (status === "missing") f.provider.forget("original-input-commitment", "1"); else f.provider.setStatus("original-input-commitment", status, "1");
    f.reopen(); const worker = f.prepareWorker(command, policyTwo(f), false), result = await worker.result;
    assert.deepEqual(result, { ok: false, code: "RETAINED_EVIDENCE_KEY_UNAVAILABLE", details: { commandId: command.commandId, idempotencyKey: command.idempotencyKey } });
    assert.equal(snapshot(f), before); assert.deepEqual(f.workerExits, [0]);
  });
}

// Two live workers reach after-sealing/pre-BEGIN; the second must compare the winner's v1 witness.
test("racing loser compares winner pinned versions across independent SQLite connections", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const command = batch(f), first = f.prepareWorker(command);
  const a = await first.reached; rotate(f);
  const second = f.prepareWorker(command, policyTwo(f)), b = await second.reached;
  assert.notEqual(a.threadId, b.threadId); assert.ok(a.threadId > 0 && b.threadId > 0);
  assert.deepEqual([a.policyVersion, a.commitmentVersion, a.wrapVersion, a.wrapCalls], ["1", "1", "1", 1]);
  assert.deepEqual([b.policyVersion, b.commitmentVersion, b.wrapVersion, b.wrapCalls], ["2", "2", "2", 1]);
  t.diagnostic(`reached after-preparation barriers on independent worker threads ${a.threadId} and ${b.threadId}`);
  assert.deepEqual(counts(f), [0, 0, 0, 0, 0]);
  first.release(); const accepted = await first.result; assert.equal(accepted.ok, true);
  const committed = snapshot(f), calls = { ...f.provider.calls }; second.release(); const replay = await second.result;
  assert.equal(replay.ok, true); if (!accepted.ok || !replay.ok) assert.fail("winner or loser failed");
  assert.deepEqual(replay.value, { ...accepted.value, deduplicated: true }); assert.equal(snapshot(f), committed);
  assert.deepEqual(counts(f), [1, 1, 1, 1, 1]); assert.equal(f.repository.readHead(command.targetSessionId, command.conversationId)!.version, "1");
  assert.equal(f.repository.findPrior(command.commandId, command.idempotencyKey)!.witness.policyVersion, "1");
  assert.equal(f.provider.calls.wrap, calls.wrap); assert.equal(f.provider.calls.fingerprint, calls.fingerprint); assert.equal(f.provider.calls.current, calls.current);
  assert.deepEqual(f.workerExits, [0, 0]); t.diagnostic(`observed preparation barriers on worker threads ${a.threadId} and ${b.threadId}; both exited 0`);
});

// A discarded candidate must lose its writer provenance even if trusted test code holds a reference.
test("failed prepared bundle loses append provenance before the caller can reuse it", async t => {
  const f = await makeRetainedEvidenceFixture({ faults: { hit(at) { if (at === "before-begin") throw new Error("synthetic precommit stop"); } } }); t.after(f.cleanup);
  let captured: PreparedEventAppend<RetainedEvidenceReceiptV1> | undefined;
  const prepare = f.events.prepareRetainedEvidence.bind(f.events);
  f.events.prepareRetainedEvidence = (...args) => { captured = prepare(...args); return captured; };
  const before = snapshot(f); assert.throws(() => f.service().retain(f.invocation(batch(f))), { code: "RETAINED_EVIDENCE_UNAVAILABLE" });
  assert.ok(captured); const candidate = captured;
  assert.throws(() => f.events.planPrepared(candidate), { code: "COMMAND_INVALID" }); assert.equal(snapshot(f), before);
});

for (const mismatch of ["original", "historical-key"] as const) {
  test(`racing loser refuses ${mismatch} using the committed winner`, async t => {
    const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
    const command = batch(f), first = f.prepareWorker(command); const a = await first.reached; rotate(f);
    const candidate = mismatch === "original" ? { ...command, frames: [{ ...command.frames[0]!, content: "fixture_bravo" }] } : command;
    const second = f.prepareWorker(candidate, policyTwo(f)), b = await second.reached;
    assert.notEqual(a.threadId, b.threadId); assert.equal(a.wrapCalls, 1); assert.equal(b.wrapCalls, 1);
    assert.equal(a.commitmentVersion, "1"); assert.equal(b.commitmentVersion, "2");
    first.release(); assert.equal((await first.result).ok, true);
    if (mismatch === "historical-key") f.provider.setStatus("original-input-commitment", "revoked", "1");
    const before = snapshot(f); second.release(); const rejected = await second.result;
    assert.deepEqual(rejected, { ok: false, code: mismatch === "original" ? "IDEMPOTENCY_CONFLICT" : "RETAINED_EVIDENCE_KEY_UNAVAILABLE",
      details: mismatch === "original" ? {} : { commandId: command.commandId, idempotencyKey: command.idempotencyKey } });
    assert.equal(snapshot(f), before); assert.deepEqual(counts(f), [1, 1, 1, 1, 1]); assert.deepEqual(f.workerExits, [0, 0]);
  });
}

test("currently valid different authorizer cannot recover a root-authorized child result", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const command = { ...batch(f), targetSessionId: f.childAuthority.sessionId };
  f.service().retain(f.invocation(command));
  const request = f.invocation(command, f.childAuthority); assert.doesNotThrow(() => f.retainedAuthority.verify(request));
  const before = snapshot(f), calls = { ...f.provider.calls };
  assert.throws(() => f.service().retain(request), { code: "SESSION_HANDLE_STALE" });
  assert.equal(snapshot(f), before); assert.deepEqual(f.provider.calls, calls);
});

const boundaries = ["before-begin", "after-event", "after-blobs", "after-head", "after-auth", "after-dedup", "before-commit"] as const;
const expectedAtBoundary = [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0], [1, 1, 0, 0, 0], [1, 1, 1, 0, 0], [1, 1, 1, 1, 0], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1]];
for (const [index, boundary] of boundaries.entries()) {
  test(`actual ${boundary} fault rolls back every durable row`, async t => {
    let observed: number[] | undefined, armed = true;
    const f = await makeRetainedEvidenceFixture({ faults: { hit(at) { if (armed && at === boundary) { observed = counts(f); throw new Error("synthetic boundary fault"); } } } }); t.after(f.cleanup);
    const command = batch(f), before = snapshot(f), request = f.invocation(command);
    assert.throws(() => f.service().retain(request), { code: "RETAINED_EVIDENCE_UNAVAILABLE" });
    assert.deepEqual(observed, expectedAtBoundary[index]); assert.equal(snapshot(f), before);
    assert.equal(request.input.canonicalOriginalBytes.every(value => value === 0), true);
    armed = false; f.reopen(); assert.equal(snapshot(f), before);
    assert.equal(f.service().retain(f.invocation(command)).deduplicated, false); assert.deepEqual(counts(f), [1, 1, 1, 1, 1]);
  });
}

for (const fault of ["commit-before-throw", "rollback-failure", "after-commit-before-response", "busy-after-commit"] as const) {
  test(`${fault} preserves original unknown IDs and observes durable reopen outcome`, async t => {
    let armed = true, observed = false;
    const f = await makeRetainedEvidenceFixture({ faults: { hit(at) {
      if (armed && ((fault === "rollback-failure" && at === "after-dedup") || ((fault === "after-commit-before-response" || fault === "busy-after-commit") && at === "after-commit-before-response"))) {
        observed = true; throw Object.assign(new Error("synthetic fault"), fault === "busy-after-commit" ? { errcode: 5 } : {});
      }
    } } }); t.after(f.cleanup);
    const command = batch(f), before = snapshot(f), exec = f.connection.exec.bind(f.connection);
    f.connection.exec = sql => {
      if (armed && fault === "commit-before-throw" && sql === "COMMIT") { exec(sql); observed = true; throw new Error("synthetic commit acknowledgement failure"); }
      if (armed && fault === "rollback-failure" && sql === "ROLLBACK") throw new Error("synthetic rollback failure");
      exec(sql);
    };
    assert.throws(() => f.service().retain(f.invocation(command)), { code: "COMMAND_OUTCOME_UNKNOWN", details: { commandId: command.commandId, idempotencyKey: command.idempotencyKey } });
    assert.equal(observed, true); assert.deepEqual(counts(f), [1, 1, 1, 1, 1]);
    const prior = f.repository.findPrior(command.commandId, command.idempotencyKey)!, committed = snapshot(f);
    armed = false; f.connection.exec = exec; rotate(f); f.reopen();
    if (fault === "rollback-failure") {
      assert.equal(snapshot(f), before, "native close rolled back the still-open transaction; uncertainty was not a commit claim");
      assert.equal(f.service().retain(f.invocation(command)).deduplicated, false);
    } else {
      const result = f.service({ policy: () => { throw new Error("no current policy"); } }).retain(f.invocation(command));
      assert.equal(result.deduplicated, true); assert.deepEqual(result.response, prior.result.response); assert.deepEqual(result.eventIds, prior.result.eventIds);
      assert.equal(result.responseHash, prior.responseHash); assert.equal(snapshot(f), committed);
    }
    assert.deepEqual(counts(f), [1, 1, 1, 1, 1]);
  });
}

test("new owner cannot replay previous generation and stale old proof separately refuses", async t => {
  const f = await makeRetainedEvidenceFixture(); t.after(f.cleanup);
  const command = batch(f); f.service().retain(f.invocation(command)); const stale = f.invocation(command);
  const { checkpointId: _i, sessionId: _s, parentSessionId: _p, baseEventPosition: _b, checkpointEventPosition: _e, createdAt: _at,
    creatorAgentId: _a, creatorClientInstanceId: _c, sourceState: _st, childSummaries: _ch, evidenceCoverage: _cv, ...draft } = checkpointFixture();
  await f.lifecycle.checkpoint(f.rootAuthority.sessionId, f.rootAuthority.descriptor, draft as unknown as JsonValue);
  const incoming = { ...f.projectContext, binding: { ...f.projectContext.binding, clientInstanceId: "retained-incoming-owner" } };
  incoming.binding.contextFingerprint = computeProjectContextFingerprint(incoming.binding);
  const resumed = await f.lifecycle.resumeAfterExpiry(f.rootAuthority.sessionId, f.rootAuthority.descriptor, incoming);
  assert.equal(resumed.publicResult.ownerGeneration, "2");
  const next = { sessionId: f.rootAuthority.sessionId, descriptor: resumed.authorityMaterial.descriptor, target: { actorRole: "primary" as const, clientInstanceId: incoming.binding.clientInstanceId } };
  const request = f.invocation(command, next, incoming); assert.doesNotThrow(() => f.retainedAuthority.verify(request));
  const before = snapshot(f);
  assert.throws(() => f.service().retain(request), { code: "SESSION_HANDLE_STALE" });
  assert.throws(() => f.service().retain(stale), error => error instanceof Error && "code" in error && ["SESSION_OWNERSHIP_MISMATCH", "SESSION_CAPABILITY_INVALID", "SESSION_HANDLE_STALE"].includes(String(error.code)));
  assert.equal(snapshot(f), before);
});
