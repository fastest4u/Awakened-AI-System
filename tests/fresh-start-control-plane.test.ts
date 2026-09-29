import { strict as assert } from "node:assert";
import { afterEach, it } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteFreshStartRepository } from "../src/orchestrator/fresh-start/fresh-start.repository.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { applyCurrentProjectStoreSchema } from "./support/current-project-store-schema.js";
import { FRESH_IDENTITY, FRESH_NOW, FRESH_RELEASE_ID, freshGenesis, freshRelease } from "./support/fresh-start-fixture.js";
import type { FreshStartMode, FreshStartRelease } from "../src/orchestrator/fresh-start/contracts.js";

// Dynamic loading lets the first RED prove the missing behavior without a compiler/import crash.
const controlPath = "../src/orchestrator/fresh-start/fresh-start-control-plane.js";
const approvalPath = "../src/orchestrator/fresh-start/operator-approval.js";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function modules() {
  const control = await import(controlPath).catch(() => null);
  const approval = await import(approvalPath).catch(() => null);
  assert.ok(control?.FreshStartControlPlane, "fresh-start transitions need a closed control-plane implementation");
  assert.ok(approval?.DENY_FRESH_START_PROMOTION, "production promotion must have a closed verifier");
  return { ...control, ...approval };
}

function store() {
  const directory = mkdtempSync(join(tmpdir(), "fresh-control-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const path = join(directory, "events.sqlite");
  const connection = driver.open(path, { mode: "create", busyTimeoutMs: 1000 });
  cleanups.push(() => connection.close());
  applyCurrentProjectStoreSchema(connection, FRESH_IDENTITY, FRESH_NOW);
  const repository = new SqliteFreshStartRepository(connection);
  repository.transact(FRESH_IDENTITY, tx => tx.install(freshGenesis(), freshRelease()));
  return { connection, repository, second() {
    const other = driver.open(path, { mode: "existing", busyTimeoutMs: 1000 });
    cleanups.push(() => other.close());
    return new SqliteFreshStartRepository(other);
  } };
}

it("production verifier cannot promote a prepared release", async () => {
  const { FreshStartControlPlane, DENY_FRESH_START_PROMOTION } = await modules();
  const { repository } = store();
  const control = new FreshStartControlPlane(repository, DENY_FRESH_START_PROMOTION, DENY_FRESH_START_PROMOTION);
  await assert.rejects(control.transition({ identity: FRESH_IDENTITY, expectedGeneration: 0n,
    expectedMode: "prepared", expectedReleaseId: FRESH_RELEASE_ID, nextMode: "active",
    nextRelease: freshRelease(), approvalEnvelope: new Uint8Array([1]) }), { code: "FRESH_START_RELEASE_NOT_READY" });
  assert.equal(repository.transact(FRESH_IDENTITY, tx => tx.state())?.mode, "prepared");
});

function request(expectedMode: FreshStartMode = "prepared", expectedGeneration = 0n, nextMode: FreshStartMode = "active", nextRelease = freshRelease()) {
  return { identity: { ...FRESH_IDENTITY }, expectedGeneration, expectedMode,
    expectedReleaseId: FRESH_RELEASE_ID, nextMode, nextRelease, approvalEnvelope: new Uint8Array([1, 2, 3]) };
}
async function fixtures(approvalId = randomUUID(), nonceDigest = "1".repeat(64)) {
  const m = await modules();
  const approvals = new m.TrustedOperatorApprovalVerifier(async (_bytes: Uint8Array, requestDigest: string) => ({
    approvalId, nonceDigest, actorFingerprint: "2".repeat(64), requestDigest, evidenceDigest: "f".repeat(64),
    identity: { ...FRESH_IDENTITY },
  }));
  const evidence = new m.TrustedFreshStartEvidenceVerifier(async (release: FreshStartRelease) => release);
  return { ...m, approvals, evidence };
}
function seed(repository: SqliteFreshStartRepository, mode: FreshStartMode) {
  if (mode === "prepared") return;
  repository.transact(FRESH_IDENTITY, tx => tx.transition({
    expectedMode: "prepared", expectedGeneration: 0n, expectedReleaseId: FRESH_RELEASE_ID,
    nextMode: mode, nextReleaseId: FRESH_RELEASE_ID, transitionId: randomUUID(),
    authorization: { kind: "automatic-stop", reasonCode: "integrity-failure" },
    evidenceDigest: "f".repeat(64), recoveryPosition: null, recoveryHash: null, recordedAt: FRESH_NOW,
  }));
}
const modes: FreshStartMode[] = ["prepared", "active", "read-only-recovery", "disabled"];
const allowed = new Set(["prepared:active", "prepared:disabled", "active:read-only-recovery", "active:disabled", "read-only-recovery:active", "read-only-recovery:disabled", "disabled:prepared"]);
for (const from of modes) for (const to of modes) {
  it(`enforces state edge ${from} -> ${to}`, async () => {
    const { FreshStartControlPlane, approvals, evidence } = await fixtures();
    const { repository } = store(); seed(repository, from);
    const control = new FreshStartControlPlane(repository, approvals, evidence);
    const generation = from === "prepared" ? 0n : 1n;
    const operation = control.transition(request(from, generation, to));
    if (allowed.has(`${from}:${to}`)) {
      const state = await operation; assert.equal(state.mode, to); assert.equal(state.generation, generation + 1n);
    } else await assert.rejects(operation, { code: "FRESH_START_EDGE_FORBIDDEN" });
  });
}

it("rejects stale generation before consuming an approval", async () => {
  const { FreshStartControlPlane, approvals, evidence } = await fixtures();
  const { repository, connection } = store();
  const control = new FreshStartControlPlane(repository, approvals, evidence);
  await assert.rejects(control.transition(request("prepared", 1n)), { code: "FRESH_START_STALE_STATE" });
  assert.equal(connection.prepare("SELECT count(*) AS n FROM fresh_start_transitions").get()?.n, 0n);
  assert.equal((await control.transition(request())).generation, 1n);
});

it("consumes approval ID and nonce once across subsequent valid requests", async () => {
  const { FreshStartControlPlane, approvals, evidence, TrustedOperatorApprovalVerifier } = await fixtures();
  const { repository } = store(); const control = new FreshStartControlPlane(repository, approvals, evidence);
  await control.transition(request());
  await assert.rejects(control.transition(request("active", 1n, "disabled")), { code: "FRESH_START_APPROVAL_REUSED" });
  const sameNonce = new TrustedOperatorApprovalVerifier(async (_: Uint8Array, requestDigest: string) => ({
    approvalId: randomUUID(), nonceDigest: "1".repeat(64), actorFingerprint: "2".repeat(64), requestDigest,
    evidenceDigest: "f".repeat(64), identity: FRESH_IDENTITY,
  }));
  await assert.rejects(new FreshStartControlPlane(repository, sameNonce, evidence).transition(request("active", 1n, "disabled")), { code: "FRESH_START_APPROVAL_REUSED" });
});

it("conflicting concurrent transitions on independent SQLite connections commit exactly once", async () => {
  const { FreshStartControlPlane, approvals, evidence } = await fixtures();
  const { repository, second, connection } = store();
  const results = await Promise.allSettled([
    new FreshStartControlPlane(repository, approvals, evidence).transition(request()),
    new FreshStartControlPlane(second(), approvals, evidence).transition(request()),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected");
  assert.equal(rejected?.status === "rejected" ? rejected.reason.code : null, "FRESH_START_STALE_STATE");
  assert.equal(repository.transact(FRESH_IDENTITY, tx => tx.state())?.generation, 1n);
  assert.equal(connection.prepare("SELECT count(*) AS n FROM fresh_start_transitions").get()?.n, 1n);
});

for (const field of ["projectId", "vaultId", "storeId"] as const) {
  it(`rejects wrong ${field} at installation and approval boundaries`, async () => {
    const { FreshStartControlPlane, approvals, evidence, TrustedOperatorApprovalVerifier } = await fixtures();
    const { repository } = store();
    const wrong = { ...FRESH_IDENTITY, [field]: randomUUID() };
    await assert.rejects(new FreshStartControlPlane(repository, approvals, evidence).transition({ ...request(), identity: wrong }), { code: "FRESH_START_IDENTITY_MISMATCH" });
    const wrongApproval = new TrustedOperatorApprovalVerifier(async (_: Uint8Array, requestDigest: string) => ({
      identity: wrong, requestDigest, evidenceDigest: "f".repeat(64), approvalId: randomUUID(), nonceDigest: "1".repeat(64), actorFingerprint: "2".repeat(64),
    }));
    await assert.rejects(new FreshStartControlPlane(repository, wrongApproval, evidence).transition(request()), { code: "FRESH_START_APPROVAL_BINDING_MISMATCH" });
  });
}
for (const field of ["buildIdentityHash", "schemaIdentityHash", "configurationHash", "capabilityManifestHash", "recoveryPolicyHash", "evidenceDigest"] as const) {
  it(`binds stored and verified release ${field}`, async () => {
    const { FreshStartControlPlane, approvals, evidence, TrustedFreshStartEvidenceVerifier } = await fixtures();
    const { repository } = store();
    const wrongRelease = freshRelease({ [field]: "0".repeat(64) });
    await assert.rejects(new FreshStartControlPlane(repository, approvals, evidence).transition(request("prepared", 0n, "active", wrongRelease)), { code: "FRESH_START_RELEASE_MISMATCH" });
    const wrongEvidence = new TrustedFreshStartEvidenceVerifier(async () => wrongRelease);
    await assert.rejects(new FreshStartControlPlane(repository, approvals, wrongEvidence).transition(request()), { code: "FRESH_START_EVIDENCE_BINDING_MISMATCH" });
  });
}

it("rejects forged verifier shapes and copied genuine values", async () => {
  const { FreshStartControlPlane, approvals, evidence } = await fixtures();
  const { repository } = store();
  const forgedEvidence = { verify: async (release: FreshStartRelease) => ({ ...await evidence.verify(release) }) };
  await assert.rejects(new FreshStartControlPlane(repository, approvals, forgedEvidence).transition(request()), { code: "FRESH_START_EVIDENCE_INVALID" });
  const forgedApproval = { verify: async (bytes: Uint8Array, digest: string) => ({ ...await approvals.verify(bytes, digest) }) };
  await assert.rejects(new FreshStartControlPlane(repository, forgedApproval, evidence).transition(request()), { code: "FRESH_START_APPROVAL_INVALID" });
});

it("binds approval request digest and evidence digest independently", async () => {
  const { FreshStartControlPlane, evidence, TrustedOperatorApprovalVerifier } = await fixtures();
  const { repository } = store();
  for (const field of ["requestDigest", "evidenceDigest"]) {
    const approvals = new TrustedOperatorApprovalVerifier(async (_: Uint8Array, requestDigest: string) => ({
      identity: FRESH_IDENTITY, requestDigest, evidenceDigest: "f".repeat(64), approvalId: randomUUID(),
      nonceDigest: "1".repeat(64), actorFingerprint: "2".repeat(64), [field]: "0".repeat(64),
    }));
    await assert.rejects(new FreshStartControlPlane(repository, approvals, evidence).transition(request()), { code: "FRESH_START_APPROVAL_BINDING_MISMATCH" });
  }
});

it("copies request identity, release and opaque bytes before asynchronous verification", async () => {
  const { FreshStartControlPlane, evidence, TrustedOperatorApprovalVerifier } = await fixtures();
  const { repository } = store();
  let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
  const approvals = new TrustedOperatorApprovalVerifier(async (bytes: Uint8Array, requestDigest: string) => {
    await gate; assert.deepEqual([...bytes], [1, 2, 3]);
    return { identity: FRESH_IDENTITY, requestDigest, evidenceDigest: "f".repeat(64), approvalId: randomUUID(), nonceDigest: "1".repeat(64), actorFingerprint: "2".repeat(64) };
  });
  const input = { ...request(), nextRelease: { ...freshRelease() } };
  const pending = new FreshStartControlPlane(repository, approvals, evidence).transition(input);
  input.identity.storeId = randomUUID() as typeof input.identity.storeId;
  input.nextRelease.buildIdentityHash = "0".repeat(64); input.approvalEnvelope.fill(9); resume();
  assert.equal((await pending).mode, "active");
});

it("freezes verified nested authority identity and copies provider output", async () => {
  const { TrustedOperatorApprovalVerifier } = await fixtures();
  const source = { identity: { ...FRESH_IDENTITY }, requestDigest: "3".repeat(64), evidenceDigest: "f".repeat(64), approvalId: randomUUID(), nonceDigest: "1".repeat(64), actorFingerprint: "2".repeat(64) };
  const value = await new TrustedOperatorApprovalVerifier(async () => source).verify(new Uint8Array([1]), source.requestDigest);
  source.identity.storeId = randomUUID() as typeof source.identity.storeId;
  source.requestDigest = "4".repeat(64);
  assert.equal(value.identity.storeId, FRESH_IDENTITY.storeId); assert.equal(value.requestDigest, "3".repeat(64));
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.identity), true);
});

it("rechecks state after external verification and permits a concurrent automatic stop", async () => {
  const { FreshStartControlPlane, approvals, TrustedFreshStartEvidenceVerifier } = await fixtures();
  const { repository, second } = store();
  const other = new FreshStartControlPlane(second(), approvals, { verify: async () => { throw Error("unused"); } });
  const evidence = new TrustedFreshStartEvidenceVerifier(async (release: FreshStartRelease) => {
    other.stop({ identity: FRESH_IDENTITY, expectedGeneration: 0n, target: "disabled", reasonCode: "integrity-failure" });
    return release;
  });
  await assert.rejects(new FreshStartControlPlane(repository, approvals, evidence).transition(request()), { code: "FRESH_START_STALE_STATE" });
  assert.equal(repository.transact(FRESH_IDENTITY, tx => tx.state())?.mode, "disabled");
});

it("replaces release only through Disabled -> Prepared with verified evidence and atomic insert", async () => {
  const { FreshStartControlPlane, approvals, evidence, DENY_FRESH_START_PROMOTION } = await fixtures();
  const { repository } = store();
  const replacement = freshRelease({ releaseId: randomUUID() });
  const control = new FreshStartControlPlane(repository, approvals, evidence);
  await assert.rejects(control.transition(request("prepared", 0n, "active", replacement)), { code: "FRESH_START_RELEASE_MISMATCH" });
  control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 0n, target: "disabled", reasonCode: "binding-failure" });
  await assert.rejects(new FreshStartControlPlane(repository, DENY_FRESH_START_PROMOTION, DENY_FRESH_START_PROMOTION).transition(request("disabled", 1n, "prepared", replacement)), { code: "FRESH_START_RELEASE_NOT_READY" });
  assert.equal(repository.transact(FRESH_IDENTITY, tx => tx.release(replacement.releaseId)), null);
  assert.equal((await control.transition(request("disabled", 1n, "prepared", replacement))).releaseId, replacement.releaseId);
  assert.deepEqual(repository.transact(FRESH_IDENTITY, tx => tx.release(replacement.releaseId)), replacement);
});

it("automatic stop only reduces availability and validates closed input", async () => {
  const { FreshStartControlPlane, DENY_FRESH_START_PROMOTION } = await fixtures();
  const { repository } = store();
  const control = new FreshStartControlPlane(repository, DENY_FRESH_START_PROMOTION, DENY_FRESH_START_PROMOTION);
  const stop = { identity: FRESH_IDENTITY, expectedGeneration: 0n, target: "disabled", reasonCode: "privacy-failure" };
  assert.throws(() => control.stop({ ...stop, target: "active" }), { code: "FRESH_START_INPUT_INVALID" });
  assert.throws(() => control.stop({ ...stop, target: "read-only-recovery" }), { code: "FRESH_START_EDGE_FORBIDDEN" });
  assert.throws(() => control.stop({ ...stop, reasonCode: "anything" }), { code: "FRESH_START_INPUT_INVALID" });
  assert.throws(() => control.stop({ ...stop, approved: true }), { code: "FRESH_START_INPUT_INVALID" });
  assert.equal(control.stop(stop).mode, "disabled");
  assert.throws(() => control.stop({ ...stop, expectedGeneration: 1n }), { code: "FRESH_START_EDGE_FORBIDDEN" });
});

it("strictly rejects malformed transition requests before verification", async () => {
  const { FreshStartControlPlane, approvals, evidence } = await fixtures(); const { repository } = store();
  const control = new FreshStartControlPlane(repository, approvals, evidence);
  for (const input of [{ ...request(), approved: true }, { ...request(), expectedGeneration: "0" }, { ...request(), approvalEnvelope: [] }, { ...request(), approvalEnvelope: new Uint8Array() }, { ...request(), expectedReleaseId: "bad" }, { ...request(), nextMode: "anything" }]) {
    await assert.rejects(control.transition(input), { code: "FRESH_START_INPUT_INVALID" });
  }
});

it("rejects newline-suffixed identifiers and hashes at their decoding boundary", async () => {
  const { FreshStartControlPlane, approvals, evidence, TrustedOperatorApprovalVerifier } = await fixtures();
  const { repository } = store(); const control = new FreshStartControlPlane(repository, approvals, evidence);
  for (const input of [
    { ...request(), expectedReleaseId: `${FRESH_RELEASE_ID}\n` },
    { ...request(), nextRelease: { ...freshRelease(), buildIdentityHash: `${"a".repeat(64)}\n` } },
  ]) await assert.rejects(control.transition(input), { code: "FRESH_START_INPUT_INVALID" });
  for (const field of ["approvalId", "nonceDigest", "actorFingerprint", "requestDigest", "evidenceDigest"]) {
    const wrong = new TrustedOperatorApprovalVerifier(async (_: Uint8Array, requestDigest: string) => {
      const fields: Record<string, unknown> = { identity: FRESH_IDENTITY, requestDigest, evidenceDigest: "f".repeat(64),
        approvalId: randomUUID(), nonceDigest: "1".repeat(64), actorFingerprint: "2".repeat(64) };
      return { ...fields, [field]: `${fields[field]}\n` };
    });
    await assert.rejects(new FreshStartControlPlane(repository, wrong, evidence).transition(request()), { code: "FRESH_START_APPROVAL_INVALID" });
  }
});

for (const field of ["projectId", "vaultId", "storeId", "releaseId", "createdAt"] as const) {
  it(`rejects authentic evidence with mismatched ${field}`, async () => {
    const { FreshStartControlPlane, approvals, TrustedFreshStartEvidenceVerifier } = await fixtures(); const { repository } = store();
    const evidence = new TrustedFreshStartEvidenceVerifier(async () => freshRelease({
      [field]: field === "createdAt" ? "2026-09-28T00:00:00.000Z" : randomUUID(),
    }));
    await assert.rejects(new FreshStartControlPlane(repository, approvals, evidence).transition(request()), { code: "FRESH_START_EVIDENCE_BINDING_MISMATCH" });
  });
}

it("rolls back replacement insertion when the approval has already been consumed", async () => {
  const { FreshStartControlPlane, approvals, evidence } = await fixtures(); const { repository } = store();
  const control = new FreshStartControlPlane(repository, approvals, evidence);
  await control.transition(request());
  control.stop({ identity: FRESH_IDENTITY, expectedGeneration: 1n, target: "disabled", reasonCode: "integrity-failure" });
  const replacement = freshRelease({ releaseId: randomUUID() });
  await assert.rejects(control.transition(request("disabled", 2n, "prepared", replacement)), { code: "FRESH_START_APPROVAL_REUSED" });
  assert.equal(repository.transact(FRESH_IDENTITY, tx => tx.release(replacement.releaseId)), null);
  assert.equal(repository.transact(FRESH_IDENTITY, tx => tx.state())?.generation, 2n);
});

it("cannot reuse genuine approval for a different valid transition target", async () => {
  const { FreshStartControlPlane, approvals, evidence, freshStartRequestDigest } = await fixtures(); const { repository } = store();
  // One real approved value for prepared->active must not authorize prepared->disabled.
  const approved = await approvals.verify(new Uint8Array([1]), freshStartRequestDigest(request()));
  const staleApproval = { verify: async () => approved };
  await assert.rejects(new FreshStartControlPlane(repository, staleApproval, evidence).transition(request("prepared", 0n, "disabled")), { code: "FRESH_START_APPROVAL_BINDING_MISMATCH" });
});
