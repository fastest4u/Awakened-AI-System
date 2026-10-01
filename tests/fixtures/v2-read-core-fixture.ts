import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { ProjectionDirectoryIdentity } from "../../src/orchestrator/projections/stable-directory.js";
import { createCwdProjectionReadCore } from "../../src/orchestrator/projections/stable-directory-read-core.js";

const TOKEN = "a".repeat(32);
const FOREIGN = "b".repeat(32);
const LOCK = ".projection-manifest.publish.lock";
const GENERATION = "projections-2-1.sqlite";
const MANIFEST = "projection-manifest.json";
const expected = JSON.parse(process.argv[2]!) as ProjectionDirectoryIdentity;
const scenario = process.argv[3]!;
const core = createCwdProjectionReadCore(expected);
function pathFailure(operation: () => unknown) {
  assert.throws(operation, (error: unknown) => error instanceof Error && error.message === "PROJECTION_PATH_INVALID");
}
function capture() { return core.captureGeneration(TOKEN, GENERATION, 64 * 1024 * 1024); }

if (scenario === "valid") {
  core.assertDirectory();
  assert.equal(core.captureManifest().state, "missing");
  fs.writeFileSync(MANIFEST, "first");
  const first = core.captureManifest();
  fs.writeFileSync(MANIFEST, "other");
  const second = core.captureManifest();
  assert.ok(first.state === "present" && second.state === "present");
  assert.notEqual(first.fileIdentity.sha256, second.fileIdentity.sha256);
  assert.equal(core.acquireLock(TOKEN), "acquired");
  assert.equal(core.acquireLock(FOREIGN), "busy");
  fs.writeFileSync(GENERATION, "fixture");
  const direct = capture();
  const { filesystemStableProjectionDirectoryOperations: legacy } = await import("../../src/orchestrator/projections/stable-directory.js");
  assert.deepEqual(direct, legacy.readGenerationImage(expected.canonicalPath, expected, TOKEN, GENERATION));
  assert.deepEqual(second, legacy.captureManifest(expected.canonicalPath, expected));
  assert.equal(Object.isFrozen(direct), true);
  assert.equal(Object.isFrozen(direct.identity), true);
  fs.writeFileSync(GENERATION, "changed");
  assert.equal(Buffer.from(direct.bytes).toString(), "fixture");
  assert.equal(core.releaseOwnedLock(TOKEN, false), "released");
  pathFailure(() => core.releaseOwnedLock(TOKEN, false));
  assert.equal(core.releaseOwnedLock(TOKEN, true), "absent");
} else if (scenario === "foreign") {
  assert.equal(core.acquireLock(TOKEN), "acquired");
  pathFailure(() => core.releaseOwnedLock(FOREIGN, true));
  assert.equal(fs.readFileSync(LOCK, "utf8"), TOKEN);
  fs.writeFileSync(GENERATION, "fixture");
  pathFailure(() => core.captureGeneration(FOREIGN, GENERATION, 64 * 1024 * 1024));
} else if (scenario.startsWith("retained:")) {
  core.acquireLock(TOKEN);
  fs.writeFileSync(`${scenario.slice(9)}owned`, "retained");
  assert.equal(core.releaseOwnedLock(TOKEN, true), "poisoned");
  assert.equal(fs.readFileSync(LOCK, "utf8"), TOKEN);
} else if (scenario.startsWith("sidecar:")) {
  core.acquireLock(TOKEN);
  fs.writeFileSync(GENERATION, "fixture");
  fs.writeFileSync(GENERATION + scenario.slice(8), "");
  assert.throws(capture, (error: unknown) => error instanceof Error && "code" in error && error.code === "INTEGRITY_FAILURE");
} else if (scenario === "caps") {
  fs.writeFileSync(MANIFEST, Buffer.alloc(64 * 1024));
  const manifest = core.captureManifest();
  assert.ok(manifest.state === "present");
  assert.equal(manifest.fileIdentity.size, "65536");
  fs.appendFileSync(MANIFEST, "x");
  pathFailure(() => core.captureManifest());
  core.acquireLock(TOKEN);
  fs.writeFileSync(GENERATION, "");
  fs.truncateSync(GENERATION, 64 * 1024 * 1024);
  assert.equal(capture().bytes.byteLength, 67108864);
  fs.truncateSync(GENERATION, 64 * 1024 * 1024 + 1);
  pathFailure(capture);
} else if (scenario.startsWith("directory:")) {
  const bad = { ...expected, [scenario.slice(10)]: "incorrect" };
  pathFailure(() => createCwdProjectionReadCore(bad).assertDirectory());
} else if (scenario.startsWith("type:")) {
  const target = scenario.slice(5);
  core.acquireLock(TOKEN);
  if (target === "lock") fs.unlinkSync(LOCK);
  fs.mkdirSync(target === "manifest" ? MANIFEST : target === "lock" ? LOCK : GENERATION);
  pathFailure(target === "manifest" ? () => core.captureManifest() : target === "lock" ? () => core.releaseOwnedLock(TOKEN, true) : capture);
} else if (scenario === "symlink") {
  fs.writeFileSync("target", "fixture");
  try { fs.symlinkSync("target", MANIFEST, "file"); }
  catch (error) {
    if (process.platform !== "win32" || !(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
    fs.mkdirSync("target-directory");
    fs.symlinkSync(fs.realpathSync.native("target-directory"), "directory-link", "junction");
    assert.equal(fs.lstatSync("directory-link").isSymbolicLink(), true);
    fs.writeFileSync(MANIFEST, "fixture");
    fs.writeFileSync(GENERATION, "fixture");
    const stat = fs.lstatSync;
    Object.defineProperty(fs, "lstatSync", { value: ((...args: Parameters<typeof stat>) => {
      // Reuse actual link stats, including mode and isFile=false, rather than an
      // impossible regular-file/symlink shape. Only the denied file-link lstat is simulated.
      if (args[0] === MANIFEST || args[0] === GENERATION) return stat("directory-link", args[1]);
      return stat(...args);
    }) as typeof stat });
    syncBuiltinESMExports();
    process.stdout.write("Native Windows file symlink: EPERM; native junction confirmed; file-symlink stat branches exercised in isolation.");
  }
  pathFailure(() => core.captureManifest());
  if (!fs.existsSync(GENERATION)) fs.symlinkSync("target", GENERATION, "file");
  core.acquireLock(TOKEN);
  pathFailure(capture);
} else if (scenario === "release-race") {
  core.acquireLock(TOKEN);
  const stat = fs.lstatSync;
  let locks = 0;
  Object.defineProperty(fs, "lstatSync", { value: ((...args: Parameters<typeof stat>) => {
    if (args[0] === LOCK && ++locks === 2) throw Object.assign(new Error("disappeared"), { code: "ENOENT" });
    return stat(...args);
  }) as typeof stat });
  syncBuiltinESMExports();
  pathFailure(() => core.releaseOwnedLock(TOKEN, true));
  assert.equal(fs.readFileSync(LOCK, "utf8"), TOKEN);
} else if (scenario.startsWith("directory-after:")) {
  fs.writeFileSync(MANIFEST, "fixture");
  fs.mkdirSync("target-directory");
  fs.symlinkSync(fs.realpathSync.native("target-directory"), "directory-link", process.platform === "win32" ? "junction" : "dir");
  const stat = fs.lstatSync;
  let directories = 0;
  Object.defineProperty(fs, "lstatSync", { value: ((...args: Parameters<typeof stat>) => {
    const result = stat(...args)!;
    if (args[0] === "." && ++directories === 2) {
      const field = scenario.slice(16);
      if (field === "symlink") return stat("directory-link", args[1]);
      else if (field === "file") return stat(MANIFEST, args[1]);
      else Object.defineProperty(result, field, { value: (result[field as keyof typeof result] as bigint) + 1n });
    }
    return result;
  }) as typeof stat });
  syncBuiltinESMExports();
  pathFailure(() => core.captureManifest());
} else if (scenario === "inputs") {
  pathFailure(() => core.acquireLock("invalid"));
  core.acquireLock(TOKEN);
  for (const filename of ["../projections-2-1.sqlite", "projections-1-1.sqlite", "projections-2-0.sqlite"]) {
    pathFailure(() => core.captureGeneration(TOKEN, filename, 64 * 1024 * 1024));
  }
  for (const maximum of [-1, 0.5, 64 * 1024 * 1024 + 1, NaN]) {
    pathFailure(() => core.captureGeneration(TOKEN, GENERATION, maximum));
  }
} else if (scenario === "lock-after") {
  core.acquireLock(TOKEN);
  fs.writeFileSync(GENERATION, "fixture");
  const read = fs.readFileSync;
  fs.readFileSync = ((...args: Parameters<typeof read>) => {
    const result = read(...args);
    if (Buffer.isBuffer(result) && result.toString() === "fixture") fs.writeFileSync(LOCK, FOREIGN);
    return result;
  }) as typeof read;
  syncBuiltinESMExports();
  pathFailure(capture);
  assert.equal(read(LOCK, "utf8"), FOREIGN);
} else if (scenario.startsWith("continuity:")) {
  const [, target, phase, field] = scenario.split(":");
  core.acquireLock(TOKEN);
  const name = target === "manifest" ? MANIFEST : GENERATION;
  fs.writeFileSync(name, "fixture");
  // Device changes cannot be forced within one owned native filesystem. Alter one
  // descriptor observation, leaving the real open/read/close and later stat intact.
  const stat = fs.fstatSync;
  let calls = 0;
  fs.fstatSync = ((...args: Parameters<typeof stat>) => {
    const result = stat(...args);
    calls += 1;
    const offset = target === "manifest" ? 0 : 2; // the token capture precedes the image
    if (calls === offset + (phase === "opened" ? 1 : 2)) {
      Object.defineProperty(result, field!, { value: (result[field! as keyof typeof result] as bigint) + 1n });
    }
    return result;
  }) as typeof stat;
  syncBuiltinESMExports();
  pathFailure(target === "manifest" ? () => core.captureManifest() : capture);
} else if (scenario.startsWith("path-after:")) {
  const target = scenario.slice(11);
  core.acquireLock(TOKEN);
  const name = target === "manifest" ? MANIFEST : GENERATION;
  fs.writeFileSync(name, "fixture");
  const read = fs.readFileSync;
  fs.readFileSync = ((...args: Parameters<typeof read>) => {
    const result = read(...args);
    if (Buffer.isBuffer(result) && result.toString() === "fixture") {
      fs.renameSync(name, "displaced");
      fs.writeFileSync(name, "fixture");
    }
    return result;
  }) as typeof read;
  syncBuiltinESMExports();
  pathFailure(target === "manifest" ? () => core.captureManifest() : capture);
} else { assert.fail(`unknown scenario ${scenario}`); }
