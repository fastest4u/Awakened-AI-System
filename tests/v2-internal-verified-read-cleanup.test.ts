import assert from "node:assert/strict";
import { fork, type ForkOptions } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { CleanupBootstrap, CleanupReply } from "../src/orchestrator/verified-read/contracts.js";
import { ownedReadDirectory, READ_HASH } from "./support/v2-verified-read-fixture.js";

type Release = (input: CleanupBootstrap, measured: string) => CleanupReply;
async function operation(): Promise<Release> {
  const path = "../src/orchestrator/verified-read/cleanup.js"; let release: Release | undefined;
  try { release = (await import(path) as { releaseOwnedReadLock: Release }).releaseOwnedReadLock; }
  catch (error) { if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw error; }
  assert.equal(typeof release, "function", "Task 4 must implement the real owned-token cleanup operation"); return release!;
}
const lock = ".projection-manifest.publish.lock";
async function fixture(run: (release: Release, input: CleanupBootstrap) => void) {
  const release = await operation(); const directory = ownedReadDirectory(); const cwd = process.cwd();
  const input: CleanupBootstrap = { version: 1, ids: { requestId: "read", attemptId: "attempt", laneEpoch: "epoch" },
    directory, lockToken: "b".repeat(32), expectedBuildHash: READ_HASH, remainingMs: 2000 };
  try { process.chdir(directory.canonicalPath); run(release, input); }
  finally { process.chdir(cwd); rmSync(directory.canonicalPath, { recursive: true, force: true }); }
}
test("cleanup releases only exact owned token and preserves every generation", async () => fixture((release, input) => {
  writeFileSync(lock, input.lockToken); writeFileSync("projections-2-1.sqlite", "owned generation");
  const reply = release(input, READ_HASH); assert.equal(reply.outcome, "released"); assert.equal(reply.cleanup, "complete");
  assert.equal(existsSync(lock), false); assert.equal(readFileSync("projections-2-1.sqlite", "utf8"), "owned generation");
}));
test("cleanup absent token succeeds without creating any file", async () => fixture((release, input) => {
  assert.equal(release(input, READ_HASH).outcome, "absent"); assert.equal(existsSync(lock), false);
}));
for (const token of ["c".repeat(32), "bbb", ""]) test(`cleanup refuses and preserves ${token.length === 32 ? "foreign" : "partial"} token (${token.length})`, async () => fixture((release, input) => {
  writeFileSync(lock, token); const reply = release(input, READ_HASH); assert.equal(reply.outcome, "failed");
  assert.equal(reply.cleanup, "incomplete"); assert.equal(readFileSync(lock, "utf8"), token);
}));
for (const kind of ["previous", "attempted", "displaced", "failed"]) test(`cleanup preserves retained ${kind} evidence and lock`, async () => fixture((release, input) => {
  writeFileSync(lock, input.lockToken); writeFileSync(`.projection-manifest.${kind}-owned`, "evidence");
  const reply = release(input, READ_HASH); assert.equal(reply.outcome, "poisoned"); assert.equal(reply.cleanup, "incomplete");
  assert.equal(readFileSync(lock, "utf8"), input.lockToken); assert.equal(readFileSync(`.projection-manifest.${kind}-owned`, "utf8"), "evidence");
}));
test("cleanup independently measured mismatch never deletes owned token", async () => fixture((release, input) => {
  writeFileSync(lock, input.lockToken); assert.equal(release(input, "c".repeat(64)).outcome, "failed");
  assert.equal(readFileSync(lock, "utf8"), input.lockToken);
}));
test("cleanup wrong directory identity refuses token release", async () => fixture((release, input) => {
  writeFileSync(lock, input.lockToken);
  assert.equal(release({ ...input, directory: { ...input.directory, inode: "0" } }, READ_HASH).outcome, "failed");
  assert.equal(readFileSync(join(input.directory.canonicalPath, lock), "utf8"), input.lockToken);
}));
test("cleanup refuses a real replacement directory at the captured canonical path", async () => {
  const release = await operation(); const root = realpathSync.native(mkdtempSync(join(tmpdir(), "v2-cleanup-swap-")));
  const path = join(root, "projection"), displaced = join(root, "displaced"); mkdirSync(path);
  const stat = lstatSync(path, { bigint: true });
  const input: CleanupBootstrap = { version: 1, ids: { requestId: "read", attemptId: "attempt", laneEpoch: "epoch" },
    directory: { canonicalPath: path, device: String(stat.dev), inode: String(stat.ino) }, lockToken: "b".repeat(32), expectedBuildHash: READ_HASH, remainingMs: 2000 };
  writeFileSync(join(path, lock), input.lockToken); renameSync(path, displaced); mkdirSync(path); writeFileSync(join(path, lock), input.lockToken);
  const cwd = process.cwd();
  try { process.chdir(path); assert.equal(release(input, READ_HASH).outcome, "failed");
    assert.equal(readFileSync(lock, "utf8"), input.lockToken); assert.equal(readFileSync(join(displaced, lock), "utf8"), input.lockToken);
  } finally { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); }
});
test("cleanup exhausted budget preserves owned token", async () => fixture((release, input) => {
  writeFileSync(lock, input.lockToken); assert.equal(release({ ...input, remainingMs: 0 }, READ_HASH).outcome, "failed");
  assert.equal(readFileSync(lock, "utf8"), input.lockToken);
}));
test("fixed unbundled cleanup entry refuses measurement, preserves token and exits normally", async () => {
  const directory = ownedReadDirectory(); const token = "b".repeat(32); writeFileSync(join(directory.canonicalPath, lock), token);
  const child = fork(fileURLToPath(new URL("../src/v2/internal-verified-read-cleanup.entry.js", import.meta.url)), [],
    { cwd: directory.canonicalPath, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true } as ForkOptions);
  const replies: unknown[] = []; let output = "";
  child.on("message", reply => replies.push(reply)); child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.on("data", chunk => { output += String(chunk); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    child.send({ version: 1, ids: { requestId: "read", attemptId: "attempt", laneEpoch: "epoch" }, directory,
      lockToken: token, expectedBuildHash: READ_HASH, remainingMs: 2000 });
    assert.deepEqual(await exited, { code: 0, signal: null }); assert.equal(output, "");
    assert.equal(replies.length, 1); assert.equal((replies[0] as CleanupReply).outcome, "failed");
    assert.equal(readFileSync(join(directory.canonicalPath, lock), "utf8"), token);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); rmSync(directory.canonicalPath, { recursive: true, force: true }); }
});
