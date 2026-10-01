import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm, rename, mkdir } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { ownedReadDirectory, READ_HASH } from "./support/v2-verified-read-fixture.js";
import type { ReadMessageIds } from "../src/orchestrator/verified-read/contracts.js";

const ids = { requestId: "request", attemptId: "attempt", laneEpoch: "epoch" };
const intent = { schemaVersion: 1 as const, bindingFingerprint: READ_HASH, buildHash: READ_HASH,
  supervisorId: "supervisor", ids, lockToken: "a".repeat(32) };
type RecordValue = typeof intent & { state: string; pid: number | null };
type Repository = { inspect(): Promise<RecordValue | null>; begin(value: typeof intent): Promise<void>;
  observeChild(ids: ReadMessageIds, pid: number): Promise<void>; complete(ids: ReadMessageIds): Promise<void>;
  retainIncomplete(ids: ReadMessageIds): Promise<void> };
async function constructor() {
  const path = "../src/orchestrator/verified-read/ownership.js";
  let module: { VerifiedReadOwnershipRepository?: new (directory: ReturnType<typeof ownedReadDirectory>) => Repository } = {};
  try { module = await import(path); } catch (error) { if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw error; }
  assert.equal(typeof module.VerifiedReadOwnershipRepository, "function", "durable ownership repository must exist");
  return module.VerifiedReadOwnershipRepository!;
}
for (const stage of ["intent", "pid", "lock", "incomplete"] as const) test(`restart refuses unresolved ${stage} ownership without modifying evidence`, async () => {
  const Repository = await constructor(); const directory = ownedReadDirectory(); const path = join(directory.canonicalPath, "verified-read-owner.json");
  try {
    const first = new Repository(directory); await first.begin(intent);
    if (stage !== "intent") await first.observeChild(ids, 12345);
    if (stage === "lock") await writeFile(join(directory.canonicalPath, ".projection-manifest.publish.lock"), intent.lockToken);
    if (stage === "incomplete") await first.retainIncomplete(ids);
    const before = await readFile(path); const restarted = new Repository(directory);
    assert.equal((await restarted.inspect())?.state, stage === "intent" ? "launch-intent" : stage === "incomplete" ? "incomplete" : "child-observed");
    await assert.rejects(restarted.begin({ ...intent, supervisorId: "replacement" }));
    await assert.rejects(restarted.complete(ids));
    assert.deepEqual(await readFile(path), before);
  } finally { await rm(directory.canonicalPath, { recursive: true, force: true }); }
});
test("exclusive owners race and only the winner can close its verified record", async () => {
  const Repository = await constructor(); const directory = ownedReadDirectory();
  try {
    const owners = [new Repository(directory), new Repository(directory)];
    const results = await Promise.allSettled(owners.map((owner, i) => owner.begin({ ...intent, supervisorId: `owner-${i}` })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const winner = results.findIndex(result => result.status === "fulfilled");
    await assert.rejects(owners[winner]!.complete({ ...ids, attemptId: "foreign" }));
    await owners[winner]!.observeChild(ids, 54321); await owners[winner]!.complete(ids);
    assert.equal(await new Repository(directory).inspect(), null);
    await new Repository(directory).begin({ ...intent, supervisorId: "reopened" });
  } finally { await rm(directory.canonicalPath, { recursive: true, force: true }); }
});
for (const state of ["launch-intent", "child-observed", "incomplete", "complete"]) test(`restart refuses persisted ${state} without changing original bytes or attempt`, async () => {
  const Repository = await constructor(); const directory = ownedReadDirectory(); const path = join(directory.canonicalPath, "verified-read-owner.json");
  try {
    const bytes = JSON.stringify({ ...intent, state, pid: state === "launch-intent" ? null : 9 }); await writeFile(path, bytes);
    const replacement = new Repository(directory);
    await assert.rejects(replacement.begin({ ...intent, supervisorId: "replacement", ids: { ...ids, attemptId: "replacement-attempt" } }), { code: "WORKER_UNAVAILABLE" });
    assert.equal(await readFile(path, "utf8"), bytes); assert.equal((await replacement.inspect())?.ids.attemptId, "attempt");
    await assert.rejects(replacement.complete(ids), { code: "WORKER_UNAVAILABLE" }); assert.equal(await readFile(path, "utf8"), bytes);
  } finally { await rm(directory.canonicalPath, { recursive: true, force: true }); }
});
test("foreign replacement remains untouched by the previous owner", async () => {
  const Repository = await constructor(); const directory = ownedReadDirectory(); const path = join(directory.canonicalPath, "verified-read-owner.json");
  try {
    const owner = new Repository(directory); await owner.begin(intent);
    await rename(path, path + ".old"); const foreign = JSON.stringify({ ...intent, supervisorId: "foreign", state: "launch-intent", pid: null });
    await writeFile(path, foreign); await assert.rejects(owner.complete(ids)); assert.equal(await readFile(path, "utf8"), foreign);
  } finally { await rm(directory.canonicalPath, { recursive: true, force: true }); }
});
test("8193-byte ownership record is refused and preserved", async () => {
  const Repository = await constructor(); const directory = ownedReadDirectory(); const path = join(directory.canonicalPath, "verified-read-owner.json");
  try {
    await writeFile(path, "x".repeat(8193)); await assert.rejects(new Repository(directory).inspect());
    assert.equal((await readFile(path)).length, 8193);
  } finally { await rm(directory.canonicalPath, { recursive: true, force: true }); }
});
test("complete record blocks replacement until actual unlink finishes", { timeout: 5000 }, async t => {
  const Repository = await constructor(); const directory = ownedReadDirectory(); const path = join(directory.canonicalPath, "verified-read-owner.json");
  const first = new Repository(directory); const replacement = new Repository(directory);
  const replacementIntent = { ...intent, supervisorId: "replacement", ids: { ...ids, attemptId: "replacement-attempt" } };
  let reached!: () => void, release!: () => void; const barrier = new Promise<void>(resolve => { reached = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const actualUnlink = fsPromises.unlink; let held = false; let completion: Promise<void> | undefined;
  const wrapper = t.mock.method(fsPromises, "unlink", async (target: Parameters<typeof actualUnlink>[0]) => {
    if (String(target) === path && !held) { held = true; reached(); await gate; }
    await actualUnlink(target);
  });
  syncBuiltinESMExports();
  try {
    await first.begin(intent); await first.observeChild(ids, 4321); completion = first.complete(ids); void completion.catch(() => undefined);
    await barrier; const completeBytes = await readFile(path); assert.equal(JSON.parse(completeBytes.toString()).state, "complete");
    const refusal = await replacement.begin(replacementIntent).then(() => null, cause => cause as { code: string });
    const whileHeld = await readFile(path); release(); await completion;
    if (refusal === null) t.diagnostic(`Unchanged candidate installed ${JSON.parse(whileHeld.toString()).ids.attemptId} while A unlink was held; A then removed that path.`);
    assert.equal(refusal?.code, "WORKER_UNAVAILABLE"); assert.deepEqual(whileHeld, completeBytes);
    assert.equal(await replacement.inspect(), null); await replacement.begin(replacementIntent); const replacementBytes = await readFile(path);
    assert.equal(JSON.parse(replacementBytes.toString()).ids.attemptId, "replacement-attempt");
    await assert.rejects(first.complete(ids), { code: "WORKER_UNAVAILABLE" });
    await assert.rejects(first.observeChild(ids, 5432), { code: "WORKER_UNAVAILABLE" });
    await assert.rejects(first.retainIncomplete(ids), { code: "WORKER_UNAVAILABLE" });
    assert.deepEqual(await readFile(path), replacementBytes);
  } finally {
    release(); await completion?.catch(() => undefined); wrapper.mock.restore(); syncBuiltinESMExports();
    await rm(directory.canonicalPath, { recursive: true, force: true });
  }
});
for (const operation of ["unlink", "rename"] as const) test(`target ${operation} failure retains owned evidence and restart denial`, async t => {
  const Repository = await constructor(); const directory = ownedReadDirectory(); const path = join(directory.canonicalPath, "verified-read-owner.json");
  const owner = new Repository(directory); await owner.begin(intent); const before = await readFile(path); const fault = Object.assign(new Error("owned target EIO"), { code: "EIO" });
  const actualUnlink = fsPromises.unlink, actualRename = fsPromises.rename;
  const unlinkWrapper = t.mock.method(fsPromises, "unlink", async (target: Parameters<typeof actualUnlink>[0]) => { if (operation === "unlink" && String(target) === path) throw fault; await actualUnlink(target); });
  const renameWrapper = t.mock.method(fsPromises, "rename", async (...args: Parameters<typeof actualRename>) => { if (operation === "rename" && String(args[1]) === path) throw fault; await actualRename(...args); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(operation === "unlink" ? owner.complete(ids) : owner.observeChild(ids, 4321), cause => cause === fault);
    const retained = await readFile(path); assert.equal(JSON.parse(retained.toString()).ids.attemptId, "attempt");
    assert.equal(JSON.parse(retained.toString()).state, operation === "unlink" ? "complete" : "launch-intent");
    if (operation === "rename") assert.deepEqual(retained, before);
    const restart = new Repository(directory); await assert.rejects(restart.begin({ ...intent, supervisorId: "restart" }), { code: "WORKER_UNAVAILABLE" });
    assert.deepEqual(await readFile(path), retained);
  } finally {
    unlinkWrapper.mock.restore(); renameWrapper.mock.restore(); syncBuiltinESMExports(); await rm(directory.canonicalPath, { recursive: true, force: true });
  }
});
test("changed directory refuses record mutation", async () => {
  const Repository = await constructor(); const directory = ownedReadDirectory(); const displaced = directory.canonicalPath + "-old";
  try {
    const owner = new Repository(directory); await owner.begin(intent); await rename(directory.canonicalPath, displaced);
    await mkdir(directory.canonicalPath); await assert.rejects(owner.observeChild(ids, 9));
    assert.equal(JSON.parse(await readFile(join(displaced, "verified-read-owner.json"), "utf8")).state, "launch-intent");
  } finally { await rm(directory.canonicalPath, { recursive: true, force: true }); await rm(displaced, { recursive: true, force: true }); }
});
