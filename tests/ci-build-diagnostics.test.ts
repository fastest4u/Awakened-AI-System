import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const recipeBytes = Buffer.from('{"type":"module"}\n');
const unknownBuild = { regular: "unknown", singleLink: "unknown", withinSizeLimit: "unknown", linkCount: "unknown", size: "unknown", limit: "unknown",
  descriptorEqual: "unknown", pathEqual: "unknown", sizeEqual: "unknown", mtimeEqual: "unknown", ctimeEqual: "unknown", operation: "none", errorCode: "none" };
const cases = ["recipe-measurement", "regular-control", "link-control", "size-control", "read-control", "identity-control", "path-control",
  "coordinator-control", "manifest-control", "integrity-control", "admission-control", "durability-control", "cleanup-control"];
function record(caseId = "link-control", boundary = "descriptor-before") {
  return { schemaVersion: 1, family: "build", caseId, platform: process.platform, boundary, phase: "guard-observation", recipeId: "package.json",
    reason: "link-count", observed: { ...unknownBuild, regular: true, singleLink: false, linkCount: "2", size: "18", limit: "1024" } };
}

// Native opens/closes stay real. Faults intervene only after a real owned read/stat.
async function ownedReaderFixture() {
  const createdRoot = fs.mkdtempSync(join(tmpdir(), "ci-build-reader-"));
  let root: string;
  try { root = fs.realpathSync.native(createdRoot); }
  catch (error) { fs.rmdirSync(createdRoot); throw error; }
  const identity = fs.lstatSync(root, { bigint: true });
  fs.mkdirSync(join(root, "scripts"));
  fs.copyFileSync(fileURLToPath(new URL("../../scripts/run-v2-shadow-migration-rehearsal.js", import.meta.url)), join(root, "scripts/reader.js"));
  fs.writeFileSync(join(root, "package.json"), recipeBytes);
  const reader = await import(pathToFileURL(join(root, "scripts/reader.js")).href);
  const original = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, fstatSync: fs.fstatSync };
  const descriptors = new Set<number>();
  let fault: ((operation: "read" | "fstat", fd: number, result: any) => any) | undefined;
  fs.openSync = ((name: any, ...args: any[]) => {
    const fd = (original.openSync as any)(name, ...args);
    if (typeof name === "string" && name.startsWith(root + "/") || typeof name === "string" && name.startsWith(root + "\\")) descriptors.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.closeSync = ((fd: number) => { original.closeSync(fd); descriptors.delete(fd); }) as typeof fs.closeSync;
  fs.readSync = ((fd: number, ...args: any[]) => {
    const result = (original.readSync as any)(fd, ...args);
    return descriptors.has(fd) && fault ? fault("read", fd, result) : result;
  }) as typeof fs.readSync;
  fs.fstatSync = ((fd: number, ...args: any[]) => {
    const result = (original.fstatSync as any)(fd, ...args);
    return descriptors.has(fd) && fault ? fault("fstat", fd, result) : result;
  }) as typeof fs.fstatSync;
  syncBuiltinESMExports();
  return { reader, root,
    addRecipeHardlink() { fs.linkSync(join(root, "package.json"), join(root, "owned-alias.json")); },
    openDescriptorCount() { return descriptors.size; },
    setFault(value: typeof fault) { fault = value; },
    cleanup() {
      Object.assign(fs, original); syncBuiltinESMExports();
      for (const fd of descriptors) original.closeSync(fd);
      const current = fs.lstatSync(root, { bigint: true });
      assert.ok(!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino, "owned cleanup root must retain identity");
      // Remove leaves without following symbolic links; only originally created root is traversed.
      function remove(directory: string) {
        for (const name of fs.readdirSync(directory)) {
          const leaf = join(directory, name), stat = fs.lstatSync(leaf);
          if (stat.isDirectory() && !stat.isSymbolicLink()) remove(leaf); else fs.unlinkSync(leaf);
        }
        fs.rmdirSync(directory);
      }
      remove(root);
    },
  };
}
function observation(fixture: Awaited<ReturnType<typeof ownedReaderFixture>>, caseId: string) {
  const rows: any[] = [];
  const collector = fixture.reader.createCiDiagnosticCollector((line: string) => rows.push(JSON.parse(line)));
  return { rows, collector, option: { caseId, observe: collector.observe } };
}
function refusal(action: () => unknown) { assert.throws(action, (error: any) => error instanceof Error && error.message === "REHEARSAL_BUILD_INVALID"); }

test("CI build diagnostics preserve regular bytes and exact size acceptance", async () => {
  const fixture = await ownedReaderFixture();
  try {
    const o = observation(fixture, "regular-control");
    assert.deepEqual(fixture.reader.readBuildBytes("package.json", recipeBytes.length, o.option), recipeBytes);
    assert.deepEqual(fixture.reader.measureBuildFiles(["package.json"], o.option).map((v: any) => [v.path, v.bytes]), [["package.json", 18]]);
    assert.deepEqual(o.rows, []); assert.equal(o.collector.incomplete, false); assert.equal(fixture.openDescriptorCount(), 0);
  } finally { fixture.cleanup(); }
});
test("CI build diagnostics thread measurement refusal observations", async () => {
  const fixture = await ownedReaderFixture();
  try {
    fixture.addRecipeHardlink();
    const o = observation(fixture, "recipe-measurement");
    refusal(() => fixture.reader.measureBuildFiles(["package.json"], o.option));
    assert.equal(o.rows.length, 1); assert.equal(o.rows[0].reason, "link-count");
    assert.equal(o.rows[0].caseId, "recipe-measurement"); assert.equal(o.collector.incomplete, false);
    assert.equal(fixture.openDescriptorCount(), 0);
  } finally { fixture.cleanup(); }
});
for (const scenario of ["hardlink", "nonregular descriptor fault", "oversize", "short-read", "descriptor-mutation"] as const) {
  for (const mode of ["default", "observed"] as const) {
    test(`CI build diagnostics isolate ${scenario} maximum coercion with ${mode} observation`, async () => {
      const fixture = await ownedReaderFixture();
      try {
        if (scenario === "hardlink") fixture.addRecipeHardlink();
        if (scenario === "nonregular descriptor fault") {
          // Owned stat fault, not a claim that Windows opens native directories.
          fixture.setFault((operation, _fd, result) => operation === "fstat" ? Object.assign(result, { isFile: () => false }) : result);
        }
        if (scenario === "short-read" || scenario === "descriptor-mutation") {
          let fired = false;
          fixture.setFault((operation, _fd, result) => {
            if (!fired && operation === (scenario === "short-read" ? "fstat" : "read")) {
              fired = true;
              if (scenario === "short-read") fs.truncateSync(join(fixture.root, "package.json"), 0);
              else fs.appendFileSync(join(fixture.root, "package.json"), " ");
            }
            return result;
          });
        }
        let stringCoercions = 0, numberCoercions = 0;
        const maximum = { [Symbol.toPrimitive](hint: string) {
          if (hint === "string") { stringCoercions++; throw new Error("synthetic telemetry coercion"); }
          numberCoercions++; return scenario === "oversize" ? 17 : 1024;
        } };
        const o = observation(fixture, "read-control");
        refusal(() => fixture.reader.readBuildBytes("package.json", maximum, mode === "observed" ? o.option : undefined));
        assert.equal(numberCoercions, scenario === "hardlink" || scenario === "nonregular descriptor fault" ? 0 : 1);
        assert.equal(stringCoercions, mode === "default" ? 0 : 1);
        assert.equal(fixture.openDescriptorCount(), 0);
      } finally { fixture.cleanup(); }
    });
  }
}
for (const mode of ["default", "observed"] as const) {
  test(`CI build diagnostics preserve consulted maximum coercion error with ${mode} observation`, async () => {
    const fixture = await ownedReaderFixture();
    try {
      const expected = new Error("synthetic original guard coercion"); let consulted = 0;
      const maximum = { [Symbol.toPrimitive](hint: string) { assert.equal(hint, "number"); consulted++; throw expected; } };
      const o = observation(fixture, "size-control");
      assert.throws(() => fixture.reader.readBuildBytes("package.json", maximum, mode === "observed" ? o.option : undefined), error => error === expected);
      assert.equal(consulted, 1); assert.equal(o.rows.length, 0); assert.equal(fixture.openDescriptorCount(), 0);
    } finally { fixture.cleanup(); }
  });
}
for (const [name, caseId, reason] of [["hardlink", "link-control", "link-count"], ["oversize", "size-control", "size"], ["nonregular", "regular-control", "non-regular"]]) {
  test(`CI build diagnostics bind ${name} refusal to the first descriptor`, async () => {
    const fixture = await ownedReaderFixture();
    try {
      if (name === "hardlink") fixture.addRecipeHardlink();
      if (name === "nonregular") {
        // Explicit descriptor fault: Windows does not natively open a directory for this read.
        fixture.setFault((operation, _fd, result) => operation === "fstat" ? Object.assign(result, { isFile: () => false }) : result);
      }
      const o = observation(fixture, caseId!);
      refusal(() => fixture.reader.readBuildBytes("package.json", name === "oversize" ? 17 : 1024, o.option));
      assert.equal(o.rows.length, 1); assert.equal(o.rows[0].reason, reason); assert.equal(o.rows[0].boundary, "descriptor-before");
      assert.equal(o.rows[0].observed.regular, name !== "nonregular");
      assert.equal(o.rows[0].observed.singleLink, name === "nonregular" ? "unknown" : name !== "hardlink");
      assert.equal(o.rows[0].observed.withinSizeLimit, name === "oversize" ? false : "unknown");
      assert.equal(o.rows[0].observed.descriptorEqual, "unknown");
      assert.equal(fixture.openDescriptorCount(), 0);
    } finally { fixture.cleanup(); }
  });
}
for (const variant of ["leaf", "parent"] as const) {
  test(`CI build diagnostics refuse native ${variant} symbolic paths`, async t => {
    const fixture = await ownedReaderFixture();
    try {
      const target = join(fixture.root, "owned-target"); fs.mkdirSync(target); fs.writeFileSync(join(target, "package.json"), recipeBytes);
      if (variant === "parent") { fs.mkdirSync(join(target, "zod")); fs.writeFileSync(join(target, "zod/package.json"), recipeBytes); }
      const alias = join(fixture.root, variant === "leaf" ? "package.json" : "node_modules");
      if (variant === "leaf") fs.unlinkSync(alias);
      try { fs.symlinkSync(variant === "leaf" ? join(target, "package.json") : target, alias, variant === "parent" && process.platform === "win32" ? "junction" : variant === "parent" ? "dir" : "file"); }
      catch (error: any) {
        assert.ok(["EPERM", "EACCES", "ENOTSUP"].includes(error.code));
        t.diagnostic(`native ${variant} symlink capability unverified: ${error.code}`); t.skip("native symbolic-link capability unavailable"); return;
      }
      const o = observation(fixture, "path-control");
      refusal(() => fixture.reader.readBuildBytes(variant === "leaf" ? "package.json" : "node_modules/zod/package.json", 1024, o.option));
      assert.equal(o.rows[0].boundary, "recipe-path"); assert.equal(o.rows[0].reason, "path");
      assert.equal(fixture.openDescriptorCount(), 0);
    } finally { fixture.cleanup(); }
  });
}
for (const variant of ["short-read", "descriptor-mutation", "path-replacement"] as const) {
  test(`CI build diagnostics preserve ${variant} refusal and descriptor closure`, async () => {
    const fixture = await ownedReaderFixture();
    try {
      let fired = false;
      fixture.setFault((operation, _fd, result) => {
        if (variant === "short-read") {
          if (operation === "fstat" && !fired) { fired = true; fs.truncateSync(join(fixture.root, "package.json"), 0); }
          return result;
        }
        if (operation !== "read" || fired) return result; fired = true;
        const recipe = join(fixture.root, "package.json");
        if (variant === "descriptor-mutation") fs.appendFileSync(recipe, " ");
        else { fs.renameSync(recipe, recipe + ".held"); fs.writeFileSync(recipe, recipeBytes); }
        return result;
      });
      const o = observation(fixture, variant === "short-read" ? "read-control" : "identity-control");
      refusal(() => fixture.reader.readBuildBytes("package.json", 1024, o.option));
      assert.equal(fired, true); assert.equal(o.rows.length, 1);
      assert.equal(o.rows[0].reason, variant === "short-read" ? "short-read" : "identity-change");
      assert.equal(o.rows[0].boundary, variant === "short-read" ? "read" : "descriptor-after");
      if (variant === "descriptor-mutation") assert.equal(o.rows[0].observed.sizeEqual, false);
      if (variant === "path-replacement") {
        // Native rename can change the held descriptor's ctime before the leaf check.
        if (o.rows[0].observed.pathEqual === "unknown") assert.equal(o.rows[0].observed.ctimeEqual, false);
        else assert.equal(o.rows[0].observed.pathEqual, false);
      }
      assert.equal(fixture.openDescriptorCount(), 0);
    } finally { fixture.cleanup(); }
  });
}
test("CI build diagnostics preserve refusal when the reporter fails", async () => {
  const fixture = await ownedReaderFixture();
  try {
    const collector = fixture.reader.createCiDiagnosticCollector(() => { throw Error("synthetic reporter failure"); });
    fixture.addRecipeHardlink();
    refusal(() => fixture.reader.readBuildBytes("package.json", 1024, { caseId: "link-control", observe: collector.observe }));
    assert.equal(collector.incomplete, true); assert.equal(fixture.openDescriptorCount(), 0);
    refusal(() => fixture.reader.readBuildBytes("package.json", 1024, { caseId: "link-control", observe: () => { throw Error("callback failure"); } }));
    assert.equal(fixture.openDescriptorCount(), 0);
  } finally { fixture.cleanup(); }
});
test("CI build diagnostics preserve the native nonregular leaf outcome", async () => {
  const fixture = await ownedReaderFixture();
  try {
    const recipe = join(fixture.root, "package.json"); fs.unlinkSync(recipe); fs.mkdirSync(recipe);
    let original: any;
    try { fixture.reader.readBuildBytes("package.json", 1024); } catch (error) { original = error; }
    assert.ok(original instanceof Error);
    const o = observation(fixture, "regular-control");
    assert.throws(() => fixture.reader.readBuildBytes("package.json", 1024, o.option), (error: any) => error.message === original.message && error.code === (original as NodeJS.ErrnoException).code);
    assert.equal(o.rows.length, 1);
    assert.equal(o.rows[0].reason, original.message === "REHEARSAL_BUILD_INVALID" ? "non-regular" : "filesystem");
    assert.equal(fixture.openDescriptorCount(), 0);
  } finally { fixture.cleanup(); }
});
test("CI build diagnostics preserve native filesystem error and safe error enums", async () => {
  const fixture = await ownedReaderFixture();
  try {
    fs.unlinkSync(join(fixture.root, "package.json"));
    const o = observation(fixture, "path-control");
    assert.throws(() => fixture.reader.readBuildBytes("package.json", 1024, o.option), (error: any) => error.code === "ENOENT");
    assert.equal(o.rows[0].reason, "filesystem"); assert.equal(o.rows[0].observed.operation, "lstat"); assert.equal(o.rows[0].observed.errorCode, "ENOENT");
    assert.equal(fixture.openDescriptorCount(), 0);
  } finally { fixture.cleanup(); }
});

for (const variant of ["extra-field", "extra-observed", "unknown-enum", "invalid-count", "oversized", "unavailable"] as const) {
  test(`CI build diagnostics collector handles ${variant} independently`, async () => {
    const fixture = await ownedReaderFixture();
    try {
      const rows: string[] = [], collector = fixture.reader.createCiDiagnosticCollector((line: string) => rows.push(line));
      const input: any = record();
      if (variant === "extra-field") input.privatePath = fixture.root;
      if (variant === "extra-observed") input.observed.secret = "private";
      if (variant === "unknown-enum") input.observed.errorCode = "private-error";
      if (variant === "invalid-count") input.observed.linkCount = "-1";
      if (variant === "oversized") input.observed.size = "1".repeat(2100);
      if (variant === "unavailable") input.observed = { ...unknownBuild };
      assert.equal(collector.observe(input), variant === "unavailable");
      assert.equal(collector.incomplete, variant !== "unavailable");
      assert.equal(rows.length, variant === "unavailable" ? 1 : 0);
      if (rows.length) assert.equal(JSON.parse(rows[0]!).observed.regular, "unknown");
    } finally { fixture.cleanup(); }
  });
}
test("CI build diagnostics collector refuses duplicate boundary and case across recipes", async () => {
  const fixture = await ownedReaderFixture();
  try {
    const o = observation(fixture, "link-control"); assert.equal(o.collector.observe(record()), true);
    assert.equal(o.collector.observe({ ...record(), recipeId: "tsconfig.json" }), false);
    assert.equal(o.rows.length, 1); assert.equal(o.collector.incomplete, true);
  } finally { fixture.cleanup(); }
});
test("CI build diagnostics collector stops at sixteen records", async () => {
  const fixture = await ownedReaderFixture();
  try {
    const o = observation(fixture, "link-control");
    for (let i = 0; i < 16; i++) assert.equal(o.collector.observe(record(cases[i % cases.length], i < cases.length ? "descriptor-before" : "read")), true);
    assert.equal(o.collector.observe(record("identity-control", "descriptor-after")), false);
    assert.equal(o.rows.length, 16); assert.equal(o.collector.incomplete, true);
  } finally { fixture.cleanup(); }
});
test("CI build diagnostics collector shares the closed path snapshot schema", async () => {
  const fixture = await ownedReaderFixture();
  try {
    const o = observation(fixture, "path-control");
    const pathRecord = { schemaVersion: 1, family: "coordinator", caseId: "coordinator-control", platform: process.platform, boundary: "path-snapshot",
      phase: "pre-boundary-snapshot", reason: "snapshot", observed: { absolute: true, normalized: true, resolved: true, statSuccess: true, nativeRealpathSuccess: true,
        directory: true, symlink: false, canonicalEqual: true, relativeAbsolute: "unknown", parentEscape: "unknown", walkReachedBase: "unknown", operation: "none", errorCode: "none" } };
    assert.equal(o.collector.observe(pathRecord), true); assert.equal(o.rows[0].observed.walkReachedBase, "unknown");
    const other = fixture.reader.createCiDiagnosticCollector(() => assert.fail("extra path field must not be serialized"));
    assert.equal(other.observe({ ...pathRecord, recipeId: "package.json" }), false); assert.equal(other.incomplete, true);
  } finally { fixture.cleanup(); }
});
