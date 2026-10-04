import assert from "node:assert/strict";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createDirectoryDurably } from "../src/orchestrator/identity/directory-durability.js";
import { captureProjectionDirectoryIdentity, filesystemStableProjectionDirectoryOperations } from "../src/orchestrator/projections/stable-directory.js";
import { capturePathSnapshot, classifyEvidence, createCiDiagnosticCollector, type DiagnosticCase } from "./support/ci-path-diagnostics.js";

// Capture ownership at creation. Cleanup never resolves a later alias to choose its target.
function owned() {
  const raw = mkdtempSync(join(tmpdir(), "ci-path-owned-"));
  const created = lstatSync(raw, { bigint: true });
  let root: string;
  try { root = resolve(realpathSync.native(raw)); }
  catch (error) {
    const current = lstatSync(raw, { bigint: true });
    assert.ok(!current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino);
    rmdirSync(raw);
    throw error;
  }
  const directories = new Map<string, ReturnType<typeof captureProjectionDirectoryIdentity>>();
  const rootIdentity = captureProjectionDirectoryIdentity(root);
  assert.ok(rootIdentity.device === created.dev.toString() && rootIdentity.inode === created.ino.toString(),
    "native spelling must identify the root captured at creation");
  directories.set(root, rootIdentity);
  function rememberDirectory(path: string) {
    directories.set(path, captureProjectionDirectoryIdentity(path));
  }
  function directory(name: string) {
    const path = join(root, name);
    mkdirSync(path);
    rememberDirectory(path);
    return path;
  }
  function cleanup(): boolean {
    const files: string[] = [], pending: string[] = [];
    function inspect(path: string): boolean {
      const expected = directories.get(path);
      const current = lstatSync(path, { bigint: true });
      if (!expected || !current.isDirectory() || current.isSymbolicLink()
        || current.dev.toString() !== expected.device || current.ino.toString() !== expected.inode) return false;
      for (const name of readdirSync(path)) {
        const child = join(path, name), stat = lstatSync(child);
        if (stat.isSymbolicLink()) return false;
        if (stat.isDirectory()) { if (!inspect(child)) return false; } else files.push(child);
      }
      pending.push(path);
      return true;
    }
    if (!inspect(root)) return false;
    for (const file of files) unlinkSync(file);
    for (const path of pending) rmdirSync(path);
    return true;
  }
  return { raw, root, directory, rememberDirectory, cleanup };
}
function observations(write?: (line: string) => void) {
  const lines: string[] = [];
  const collector = createCiDiagnosticCollector(line => { if (write) write(line); lines.push(line); });
  return { lines, collector, row() { assert.equal(lines.length, 1); return JSON.parse(lines[0]!); } };
}
function snapshot(directory: string, caseId: DiagnosticCase = "path-control", durableBase?: string) {
  const o = observations();
  capturePathSnapshot({ family: "coordinator", caseId, directory, durableBase }, o.collector);
  return o;
}
function refusal(action: () => unknown) {
  assert.throws(action, { message: "PROJECTION_PATH_INVALID" });
}

test("CI path diagnostics classify parent snapshots and later reads without upgrading to a guard", () => {
  const f = owned();
  try {
    for (const path of [f.root, join(f.root, "precreation")]) {
      const o = snapshot(path);
      for (const location of ["guard", "snapshot", "later-read"] as const) {
        const input = { record: o.row(), collectorIncomplete: o.collector.incomplete,
          operationCode: "PROJECTION_PATH_INVALID", expectedCode: "PROJECTION_PATH_INVALID", cleanupComplete: true, location };
        assert.equal(classifyEvidence(input), "snapshot-only");
        assert.equal(classifyEvidence({ ...input, cleanupComplete: false }), "incomplete");
        assert.equal(classifyEvidence({ ...input, collectorIncomplete: true }), "incomplete");
        assert.equal(classifyEvidence({ ...input, operationCode: "ETIMEDOUT" }), "incomplete");
      }
    }
    const row = snapshot(f.root).row();
    for (const observed of [{ ...row.observed, statSuccess: "unknown" }, { ...row.observed, directory: "unknown" },
      { ...row.observed, nativeRealpathSuccess: "unknown" }, { ...row.observed, canonicalEqual: "unknown" }]) {
      assert.equal(classifyEvidence({ record: { ...row, observed }, collectorIncomplete: false,
        operationCode: "PROJECTION_PATH_INVALID", expectedCode: "PROJECTION_PATH_INVALID", cleanupComplete: true, location: "snapshot" }), "incomplete");
    }
  } finally { assert.equal(f.cleanup(), true); }
});

test("CI path diagnostics compare owned raw and native spellings with the real boundary", t => {
  const f = owned();
  try {
    const raw = snapshot(f.raw), canonical = snapshot(f.root, "regular-control");
    assert.equal(raw.row().observed.absolute, true);
    assert.equal(canonical.row().observed.canonicalEqual, true);
    assert.equal(canonical.row().observed.walkReachedBase, "unknown");
    assert.equal(captureProjectionDirectoryIdentity(f.root).canonicalPath, f.root);
    let rawOutcome = "accepted";
    try { captureProjectionDirectoryIdentity(f.raw); } catch (error) { refusal(() => { throw error; }); rawOutcome = "refused"; }
    t.diagnostic(`owned raw boundary=${rawOutcome}; native boundary=accepted; spelling equality=${f.raw === f.root}`);
    for (const line of [...raw.lines, ...canonical.lines]) {
      assert.ok(Buffer.byteLength(line) <= 2048);
      assert.equal(line.includes(f.root), false);
      assert.equal(line.includes(f.raw), false);
      assert.equal(line.includes("inode"), false);
      assert.equal(line.includes("device"), false);
    }
  } finally { assert.equal(f.cleanup(), true); }
});

test("CI path diagnostics retain lexical refusal and unknown filesystem observations", () => {
  const f = owned();
  try {
    for (const invalid of [
      { path: relative(process.cwd(), f.root), absolute: false, normalized: true },
      { path: `${f.root}${sep}..${sep}${basename(f.root)}`, absolute: true, normalized: false },
      { path: `${f.root}${sep}`, absolute: true, normalized: true },
    ]) {
      const o = snapshot(invalid.path);
      assert.equal(o.row().observed.absolute, invalid.absolute);
      assert.equal(o.row().observed.normalized, invalid.normalized);
      assert.equal(o.row().observed.resolved, false);
      assert.equal(o.row().observed.statSuccess, true);
      assert.equal(o.row().observed.walkReachedBase, "unknown");
      refusal(() => captureProjectionDirectoryIdentity(invalid.path));
    }
    const missing = snapshot(join(f.root, "missing"));
    assert.deepEqual({ reason: missing.row().reason, operation: missing.row().observed.operation,
      errorCode: missing.row().observed.errorCode, directory: missing.row().observed.directory },
    { reason: "filesystem", operation: "lstat", errorCode: "ENOENT", directory: "unknown" });
    const unknown = snapshot(`${f.root}\0private-exception-text`);
    assert.equal(unknown.row().observed.errorCode, "unknown");
    assert.equal(unknown.lines[0]!.includes("private-exception-text"), false);
  } finally { assert.equal(f.cleanup(), true); }
});

test("CI path diagnostics observe a native link refusal and refuse junction cleanup traversal", t => {
  const f = owned(), outside = owned(), alias = join(f.root, "alias");
  let aliasIdentity: { dev: bigint; ino: bigint } | undefined;
  try {
    writeFileSync(join(outside.root, "sentinel"), "outside-preserved");
    try {
      symlinkSync(outside.root, alias, process.platform === "win32" ? "junction" : "dir");
      const stat = lstatSync(alias, { bigint: true });
      aliasIdentity = { dev: stat.dev, ino: stat.ino };
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") throw error;
      t.skip("native directory link capability unavailable; refusal/cleanup control unverified"); return;
    }
    const o = snapshot(alias, "link-control");
    assert.equal(o.row().observed.symlink, true);
    refusal(() => captureProjectionDirectoryIdentity(alias));
    assert.equal(f.cleanup(), false);
    assert.equal(readFileSync(join(outside.root, "sentinel"), "utf8"), "outside-preserved");
  } finally {
    if (aliasIdentity) {
      const current = lstatSync(alias, { bigint: true });
      assert.ok(current.isSymbolicLink() && current.dev === aliasIdentity.dev && current.ino === aliasIdentity.ino);
      unlinkSync(alias);
    }
    assert.equal(f.cleanup(), true); assert.equal(outside.cleanup(), true);
  }
});

test("CI path diagnostics refuse replacement after authorization and preserve cleanup sentinels and closure", () => {
  const f = owned(), moved = `${f.root}-moved`;
  const identity = captureProjectionDirectoryIdentity(f.root);
  const connection = new DatabaseSync(join(f.root, "owned.sqlite"));
  const descriptor = openSync(join(f.root, "owned.sqlite"), "r");
  let closed = false;
  try {
    connection.close(); closeSync(descriptor); closed = true;
    renameSync(f.root, moved);
    mkdirSync(f.root);
    writeFileSync(join(f.root, "sentinel"), "replacement-preserved");
    const o = snapshot(f.root, "identity-control");
    assert.equal(o.row().observed.canonicalEqual, true);
    refusal(() => filesystemStableProjectionDirectoryOperations.captureManifest(f.root, identity));
    assert.equal(f.cleanup(), false);
    assert.equal(readFileSync(join(f.root, "sentinel"), "utf8"), "replacement-preserved");
    assert.equal(closed, true);
    assert.throws(() => connection.prepare("SELECT 1"));
    assert.throws(() => closeSync(descriptor), { code: "EBADF" });
  } finally {
    if (!closed) { connection.close(); closeSync(descriptor); }
    // The known replacement was created by this control; remove only its exact leaf.
    if (existsSync(join(f.root, "sentinel"))) unlinkSync(join(f.root, "sentinel"));
    rmdirSync(f.root);
    renameSync(moved, f.root);
    assert.equal(f.cleanup(), true);
  }
});

test("CI path diagnostics retain durable descendant acceptance and sibling escape refusal", () => {
  const f = owned();
  try {
    const base = f.directory("base"), sibling = f.directory("sibling");
    const target = join(base, "target"), escaped = join(sibling, "target");
    const accepted = snapshot(target, "durability-control", base);
    assert.equal(accepted.row().observed.parentEscape, false);
    assert.equal(accepted.row().observed.relativeAbsolute, false);
    assert.equal(accepted.row().observed.walkReachedBase, "unknown");
    const barriers: string[] = [];
    createDirectoryDurably(target, base, path => barriers.push(path));
    assert.deepEqual(barriers, [base]);
    // Capture the directory created by the real durable operation without replacing it.
    f.rememberDirectory(target);
    const rejected = snapshot(escaped, "path-control", base);
    assert.equal(rejected.row().observed.parentEscape, true);
    assert.throws(() => createDirectoryDurably(escaped, base, () => assert.fail("escape must not walk")), { message: "DIRECTORY_OUTSIDE_DURABLE_BASE" });
    assert.equal(existsSync(escaped), false);
  } finally { assert.equal(f.cleanup(), true); }
});

test("CI path diagnostics preserve reporter failure and reject unsanitized and duplicate evidence", () => {
  const f = owned();
  try {
    const o = snapshot(f.root), row = o.row();
    const rejected = observations();
    assert.equal(rejected.collector.observe({ ...row, rawPath: f.root }), false);
    assert.equal(rejected.collector.incomplete, true);
    assert.equal(rejected.lines.length, 0);
    assert.equal(o.collector.observe(row), false);
    assert.equal(o.collector.incomplete, true);
    const throwing = observations(() => { throw new Error("private reporter path and stack"); });
    const connection = new DatabaseSync(join(f.root, "reporter-closure.sqlite"));
    const descriptor = openSync(join(f.root, "reporter-closure.sqlite"), "r");
    let primary: unknown;
    try {
      capturePathSnapshot({ family: "manifest", caseId: "manifest-control", directory: f.root }, throwing.collector);
      captureProjectionDirectoryIdentity("relative");
    } catch (error) { primary = error; }
    finally { try { connection.close(); } finally { closeSync(descriptor); } }
    assert.ok(primary instanceof Error && primary.message === "PROJECTION_PATH_INVALID");
    assert.throws(() => connection.prepare("SELECT 1"));
    assert.throws(() => closeSync(descriptor), { code: "EBADF" });
    assert.equal(throwing.collector.incomplete, true);
    assert.equal(throwing.lines.length, 0);
    for (const bad of [{ ...row.observed, rawIdentity: "123" }, { ...row.observed, operation: "private-operation" },
      { ...row.observed, errorCode: "private-error" }, { ...row.observed, canonicalEqual: "private-value" },
      { ...row.observed, canonicalEqual: "x".repeat(2049) }]) {
      const invalid = observations();
      assert.equal(invalid.collector.observe({ ...row, observed: bad }), false);
      assert.equal(invalid.lines.length, 0);
    }
    const bounded = observations();
    const cases: DiagnosticCase[] = ["recipe-measurement", "regular-control", "link-control", "size-control", "read-control",
      "identity-control", "path-control", "coordinator-control", "manifest-control", "integrity-control", "admission-control",
      "durability-control", "cleanup-control"];
    for (const caseId of cases) assert.equal(bounded.collector.observe({ ...row, caseId }), true);
    const build = { schemaVersion: 1, family: "build", caseId: "recipe-measurement", platform: process.platform,
      phase: "guard-observation", recipeId: "package.json", reason: "unknown", observed: {
        regular: "unknown", singleLink: "unknown", withinSizeLimit: "unknown", descriptorEqual: "unknown", pathEqual: "unknown",
        sizeEqual: "unknown", mtimeEqual: "unknown", ctimeEqual: "unknown", linkCount: "unknown", size: "unknown", limit: "unknown",
        operation: "none", errorCode: "none" } };
    for (const boundary of ["recipe-path", "descriptor-before", "read"]) assert.equal(bounded.collector.observe({ ...build, boundary }), true);
    assert.equal(bounded.lines.length, 16);
    assert.ok(bounded.lines.every(line => Buffer.byteLength(line) <= 2048));
    assert.equal(bounded.collector.observe({ ...build, boundary: "descriptor-after" }), false);
    assert.equal(bounded.collector.incomplete, true);
    assert.equal(bounded.lines.length, 16);
  } finally { assert.equal(f.cleanup(), true); }
});
