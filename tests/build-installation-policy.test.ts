import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

type Json = Record<string, any>;
const source = resolve(import.meta.dirname, "../..");
const checker = "scripts/check-build-installation.js";

function fixture(t: TestContext): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "installation-policy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["package.json", "package-lock.json", "scripts/run-v2-shadow-migration-rehearsal.js", checker]) {
    // Before implementation the checker is deliberately absent: still run the native
    // child, so RED is a result assertion rather than a fixture-copy exception.
    if (name === checker && !fs.existsSync(join(source, name))) continue;
    fs.mkdirSync(dirname(join(root, name)), { recursive: true });
    fs.copyFileSync(join(source, name), join(root, name));
  }
  fs.writeFileSync(join(root, "untouched.txt"), "owned sentinel\n");
  return root;
}

function edit(root: string, name: string, change: (json: Json) => void): void {
  const json = JSON.parse(fs.readFileSync(join(root, name), "utf8"));
  change(json);
  fs.writeFileSync(join(root, name), JSON.stringify(json));
}

function before(root: string, args = ["before"]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [join(root, checker), ...args], {
    cwd: tmpdir(), encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 4096,
  });
}

function unchanged(root: string, run: () => ReturnType<typeof spawnSync>): ReturnType<typeof spawnSync> {
  const inputs = ["package.json", "package-lock.json", "untouched.txt"].map(name => [name, fs.readFileSync(join(root, name))] as const);
  const result = run();
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  for (const [name, bytes] of inputs) assert.deepEqual(fs.readFileSync(join(root, name)), bytes, `${name} remains untouched`);
  assert.equal(fs.existsSync(join(root, "setup-executed.txt")), false, "setup was never executed");
  assert.equal(fs.existsSync(join(root, "node_modules")), false, "before needs no installed packages");
  return result;
}

function accepted(root: string): void {
  const result = unchanged(root, () => before(root));
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout, "BUILD_INSTALLATION_POLICY_OK\n");
  assert.equal(result.stderr, "");
}

function refused(root: string, args?: string[]): void {
  const result = unchanged(root, () => before(root, args));
  assert.equal(result.status, 1, String(result.stderr));
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "REHEARSAL_BUILD_INVALID\n", "a missing module is not an intended policy refusal");
}

test("installation policy accepts reviewed registry setup", async t => {
  accepted(fixture(t));
  await t.test("registry publishing hooks alone are inert", () => {
    const root = fixture(t);
    edit(root, "package-lock.json", lock => {
      lock.packages["node_modules/yaml"].scripts = Object.fromEntries(
        ["prepare", "prepublish", "prepublishOnly", "prepack", "postpack"].map(name => [name, "node setup-executed.txt"]));
    });
    accepted(root);
  });
  await t.test("root gypfile false disables implicit native setup", () => {
    const root = fixture(t);
    edit(root, "package.json", pkg => { pkg.gypfile = false; });
    fs.writeFileSync(join(root, "binding.gyp"), "{}\n");
    accepted(root);
  });
});

test("installation policy rejects changed setup inventory", async t => {
  const changes: [string, (lock: Json) => void][] = [
    ["added setup", lock => { lock.packages["node_modules/yaml"].hasInstallScript = true; }],
    ["removed setup", lock => { delete lock.packages["node_modules/esbuild"].hasInstallScript; }],
    ["changed setup version", lock => { lock.packages["node_modules/esbuild"].version = "0.28.3"; }],
    ["changed setup integrity", lock => { lock.packages["node_modules/esbuild"].integrity = "sha512-" + Buffer.alloc(64).toString("base64"); }],
    ["malformed setup flag", lock => { lock.packages["node_modules/yaml"].hasInstallScript = "false"; }],
    ["setup flag false", lock => { lock.packages["node_modules/esbuild"].hasInstallScript = false; }],
    ["install declaration without lock flag", lock => { lock.packages["node_modules/yaml"].scripts = { install: "node setup-executed.txt" }; }],
    ["preinstall declaration without lock flag", lock => { lock.packages["node_modules/yaml"].scripts = { preinstall: "node setup-executed.txt" }; }],
    ["postinstall declaration without lock flag", lock => { lock.packages["node_modules/yaml"].scripts = { postinstall: "node setup-executed.txt" }; }],
    ["gyp declaration without lock flag", lock => { lock.packages["node_modules/yaml"].gypfile = true; }],
    ["malformed record", lock => { lock.packages["node_modules/yaml"] = []; }],
    ["malformed scripts", lock => { lock.packages["node_modules/yaml"].scripts = []; }],
    ["wrong lock format", lock => { lock.lockfileVersion = 2; }],
    ["malformed packages", lock => { lock.packages = []; }],
    ["missing root", lock => { delete lock.packages[""]; }],
    ["wrong package name", lock => { lock.packages["node_modules/yaml"].name = "other"; }],
    ["unsafe package path", lock => { lock.packages["node_modules/../yaml"] = lock.packages["node_modules/yaml"]; }],
    ["missing version", lock => { delete lock.packages["node_modules/yaml"].version; }],
    ["malformed integrity", lock => { lock.packages["node_modules/yaml"].integrity = "sha512-bad"; }],
    ["missing root dependency", lock => { delete lock.packages[""].dependencies.yaml; }],
    ["missing locked dependency", lock => { delete lock.packages["node_modules/yaml"]; }],
    ["missing transitive dependency", lock => { delete lock.packages["node_modules/picomatch"]; }],
    ["changed selected native version", lock => { lock.packages[`node_modules/@esbuild/${process.platform}-${process.arch}`].version = "0.28.3"; }],
    ["changed selected native integrity", lock => { lock.packages[`node_modules/@esbuild/${process.platform}-${process.arch}`].integrity = "sha512-" + Buffer.alloc(64).toString("base64"); }],
    ["missing selected native", lock => { delete lock.packages[`node_modules/@esbuild/${process.platform}-${process.arch}`]; }],
    ["changed native mapping", lock => { lock.packages["node_modules/esbuild"].optionalDependencies[`@esbuild/${process.platform}-${process.arch}`] = "0.28.3"; }],
  ];
  for (const [name, change] of changes) await t.test(name, () => {
    const root = fixture(t); edit(root, "package-lock.json", change); refused(root);
  });
});

test("installation policy rejects an array lock version", t => {
  const root = fixture(t);
  edit(root, "package-lock.json", lock => { lock.packages["node_modules/yaml"].version = ["2.9.0"]; });
  refused(root);
});

test("installation policy rejects root setup and nonregistry sources", async t => {
  for (const hook of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "dependencies"]) {
    await t.test(`root ${hook}`, () => {
      const root = fixture(t);
      edit(root, "package.json", pkg => { pkg.scripts[hook] = "node -e \"require('fs').writeFileSync('setup-executed.txt','ran')\""; });
      refused(root);
    });
  }
  await t.test("root implicit binding.gyp setup", () => {
    const root = fixture(t); fs.writeFileSync(join(root, "binding.gyp"), "{}\n"); refused(root);
  });
  for (const [name, change] of [
    ["root workspace", (pkg: Json) => { pkg.workspaces = ["packages/*"]; }],
    ["mismatching root declarations", (pkg: Json) => { pkg.dependencies.yaml = "^3.0.0"; }],
    ["root local source", (pkg: Json) => { pkg.dependencies.yaml = "file:../yaml"; }],
    ["nonregistry override", (pkg: Json) => { pkg.overrides.hono = "file:../hono"; }],
    ["malformed root scripts", (pkg: Json) => { pkg.scripts = []; }],
  ] as [string, (pkg: Json) => void][]) await t.test(name, () => {
    const root = fixture(t); edit(root, "package.json", change); refused(root);
  });
  for (const source of ["file:../yaml", "git+https://example.invalid/yaml.git", "https://example.invalid/yaml.tgz",
    "http://registry.npmjs.org/yaml/-/yaml-2.9.0.tgz", "https://registry.npmjs.org/yaml/-/other-2.9.0.tgz",
    "https://registry.npmjs.org/yaml/-/yaml-2.9.0.tgz?override=1"]) await t.test(`source ${source}`, () => {
    const root = fixture(t); edit(root, "package-lock.json", lock => { lock.packages["node_modules/yaml"].resolved = source; }); refused(root);
  });
  await t.test("linked package", () => {
    const root = fixture(t); edit(root, "package-lock.json", lock => { lock.packages["node_modules/yaml"].link = true; }); refused(root);
  });
});

test("installation CLI refuses missing unknown and extra phases", async t => {
  for (const args of [[], ["unknown"], ["before", "after"], ["before", "--root", tmpdir()], ["before", "--ignore-policy"], ["after"]]) {
    await t.test(JSON.stringify(args), () => refused(fixture(t), args));
  }
});

test("installation CLI refuses an aliased checkout invocation", t => {
  const root = fixture(t), alias = `${root}-alias`;
  try { fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("platform does not permit an owned directory alias"); return;
    }
    throw error;
  }
  t.after(() => fs.rmSync(alias, { recursive: true, force: true }));
  const result = unchanged(root, () => before(alias));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "REHEARSAL_BUILD_INVALID\n");
});

test("installation CLI refuses a failed canonical resolution", t => {
  const root = fixture(t), command = join(root, checker), observed = join(root, "canonical-failure-observed.txt");
  // Force only this command's canonical lookup to fail; all fixture reads and
  // the real CLI remain native. The owned marker proves this fault was reached.
  const preload = `import fs from 'node:fs'; const native = fs.realpathSync.native;
    fs.realpathSync.native = function(input, ...args) {
      if (input === ${JSON.stringify(command)}) {
        fs.writeFileSync(${JSON.stringify(observed)}, 'EPERM\\n');
        throw Object.assign(new Error('owned canonical lookup failure'), { code: 'EPERM' });
      }
      return native(input, ...args);
    };`;
  const result = unchanged(root, () => spawnSync(process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, command, "before"],
    { cwd: tmpdir(), encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 4096 }));
  assert.equal(fs.readFileSync(observed, "utf8"), "EPERM\n", "the direct CLI reached the failed canonical lookup");
  assert.equal(result.status, 1, String(result.stderr));
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "REHEARSAL_BUILD_INVALID\n");
});

test("installation CLI import is inert and assertion is script rooted", t => {
  // A real fixture with an invalid root hook proves import does not invoke policy.
  // The explicit assertion must then refuse with the fixed existing error.
  const root = fixture(t);
  edit(root, "package.json", pkg => { pkg.scripts.install = "node setup-executed.txt"; });
  const url = pathToFileURL(join(root, checker)).href;
  const result = unchanged(root, () => spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(url)}); process.stdout.write('IMPORTED\\n'); try { m.assertBuildInstallationPolicy(); process.exitCode=7; } catch(e) { if(e.message !== 'REHEARSAL_BUILD_INVALID') throw e; process.stdout.write('REFUSED\\n'); }`],
  { cwd: tmpdir(), encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 4096 }));
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout, "IMPORTED\nREFUSED\n");
  assert.equal(result.stderr, "");
});

// Synthetic installed closure: copied executable bytes are reader/capability controls,
// not evidence of an actual npm installation or its original hardlink topology.
function installedFixture(t: TestContext): string {
  const root = fixture(t), lock = JSON.parse(fs.readFileSync(join(root, "package-lock.json"), "utf8"));
  for (const [name, record] of Object.entries(lock.packages) as [string, Json][]) {
    if (!name || name.startsWith("node_modules/@esbuild/") && name !== `node_modules/@esbuild/${process.platform}-${process.arch}`) continue;
    fs.mkdirSync(join(root, name), { recursive: true });
    const metadata = join(source, name, "package.json");
    if (fs.existsSync(metadata)) fs.copyFileSync(metadata, join(root, name, "package.json"));
    else fs.writeFileSync(join(root, name, "package.json"), JSON.stringify({ name: name.slice(name.lastIndexOf("node_modules/") + 13), version: record.version }));
  }
  for (const name of ["node_modules/esbuild/lib/main.js", "node_modules/typescript/lib/typescript.js", nativeRecipe()]) {
    fs.mkdirSync(dirname(join(root, name)), { recursive: true });
    fs.copyFileSync(join(source, name), join(root, name));
    if (process.platform !== "win32" && name === nativeRecipe()) fs.chmodSync(join(root, name), 0o755);
  }
  return root;
}
function nativeRecipe(): string {
  return `node_modules/@esbuild/${process.platform}-${process.arch}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`;
}
function buildEntryFixture(t: TestContext): string {
  const root = installedFixture(t);
  for (const name of ["scripts/build.js", "scripts/fresh-start-build.js"]) fs.copyFileSync(join(source, name), join(root, name));
  // A real installed wrapper side effect exposes an import before admission.
  fs.appendFileSync(join(root, "node_modules/esbuild/lib/main.js"),
    `\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, "dependency-executed.txt"))}, 'executed');\n`);
  fs.mkdirSync(join(root, "dist/internal"), { recursive: true });
  fs.writeFileSync(join(root, "dist/internal/v2-shadow-migration-build.json"), '{"eligible":true}\n');
  fs.writeFileSync(join(root, "dist/v2-build.json"), '{"incomplete":false}\n');
  return root;
}
function buildEntryRefused(root: string): void {
  const result = spawnSync(process.execPath, ["scripts/build.js"],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 4096 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 1, String(result.stderr));
  assert.equal(fs.existsSync(join(root, "dependency-executed.txt")), false, "installed module was not executed");
  assert.match(String(result.stderr), /REHEARSAL_BUILD_INVALID/);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(join(root, "setup-executed.txt")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(root, "dist/internal/v2-shadow-migration-build.json"), "utf8")), { eligible: false, schemaVersion: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(join(root, "dist/v2-build.json"), "utf8")), { schemaVersion: 1, incomplete: true });
}
test("build installation refusal leaves both incomplete manifests", t => {
  const root = buildEntryFixture(t);
  edit(root, "node_modules/yaml/package.json", pkg => { pkg.scripts = { install: "node setup-executed.txt" }; });
  buildEntryRefused(root);
});
test("standalone build refuses changed root hook and missing required closure", async t => {
  for (const scenario of ["root hook", "required closure"]) await t.test(scenario, () => {
    const root = buildEntryFixture(t);
    if (scenario === "root hook") edit(root, "package.json", pkg => { pkg.scripts.install = "node setup-executed.txt"; });
    else fs.rmSync(join(root, "node_modules/fast-glob"), { recursive: true });
    buildEntryRefused(root);
  });
});
function afterResult(root: string, preload?: string): ReturnType<typeof spawnSync> {
  const inputs = ["package.json", "package-lock.json", "untouched.txt"].map(name => [name, fs.readFileSync(join(root, name))] as const);
  const result = spawnSync(process.execPath, [...(preload ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`] : []), join(root, checker), "after"],
    { cwd: tmpdir(), encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 4096 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  for (const [name, bytes] of inputs) assert.deepEqual(fs.readFileSync(join(root, name)), bytes);
  assert.equal(fs.existsSync(join(root, "setup-executed.txt")), false);
  return result;
}
function afterRefused(root: string, preload?: string, invoked = false): void {
  const marker = join(root, "unexpected-native-invocation.txt");
  const audit = `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const original=cp.spawn;cp.spawn=(...args)=>{fs.writeFileSync(${JSON.stringify(marker)},'called');return original(...args);};syncBuiltinESMExports();`;
  const result = afterResult(root, invoked ? preload : `${audit}${preload ?? ""}`);
  if (!invoked) assert.equal(fs.existsSync(marker), false, "unadmitted bytes or setup must refuse before native invocation");
  assert.equal(result.status, 1, String(result.stderr)); assert.equal(result.stdout, "");
  assert.equal(result.stderr, "REHEARSAL_BUILD_INVALID\n");
}
function childModule(root: string, body: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--input-type=module", "-e", body],
    { cwd: tmpdir(), encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 4096 });
}

test("native capability admits legitimate pinned bytes resolution and version", t => {
  const result = afterResult(installedFixture(t));
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout, "BUILD_INSTALLATION_CAPABILITY_OK\n"); assert.equal(result.stderr, "");
});
test("native capability exported assertion enforces complete policy before invocation", t => {
  const root = installedFixture(t);
  edit(root, "package.json", pkg => { pkg.scripts.install = "node setup-executed.txt"; });
  const result = childModule(root, `import assert from 'node:assert/strict'; const m=await import(${JSON.stringify(pathToFileURL(join(root, checker)).href)});
    assert.equal(typeof m.assertBuildInstallationCapability,'function','complete capability assertion is exported');
    await assert.rejects(m.assertBuildInstallationCapability(),{message:'REHEARSAL_BUILD_INVALID'});`);
  assert.equal(result.status, 0, String(result.stderr)); assert.equal(result.stdout, "");
});
test("installation policy refuses missing required nested peer", t => {
  const root = installedFixture(t), nested = "node_modules/yaml/node_modules/required-peer";
  edit(root, "package-lock.json", lock => {
    lock.packages["node_modules/yaml"].peerDependencies = { "required-peer": "1.0.0" };
    lock.packages[nested] = { version: "1.0.0", resolved: "https://registry.npmjs.org/required-peer/-/required-peer-1.0.0.tgz", integrity: "sha512-" + Buffer.alloc(64).toString("base64"), optional: true,
      os: [process.platform === "win32" ? "linux" : "win32"] };
  });
  afterRefused(root);
});
test("installation policy preserves required reachability despite optional flags", async t => {
  for (const [name, flag] of [["yaml", "optional"], ["picomatch", "optional"], ["typescript", "devOptional"]]) await t.test(`${name} ${flag}`, () => {
    const root = installedFixture(t);
    edit(root, "package-lock.json", lock => {
      lock.packages[`node_modules/${name}`][flag] = true;
      // Even apparent platform-optional absence cannot override a required edge.
      lock.packages[`node_modules/${name}`].os = [process.platform === "win32" ? "linux" : "win32"];
    });
    fs.rmSync(join(root, "node_modules", name), { recursive: true }); afterRefused(root);
  });
});
test("installation policy distinguishes inert registry publishing declarations", t => {
  const root = installedFixture(t);
  edit(root, "node_modules/yaml/package.json", pkg => { pkg.scripts = Object.fromEntries(["prepare", "prepublish", "prepublishOnly", "prepack", "postpack"].map(name => [name, "node setup-executed.txt"])); });
  const result = afterResult(root); assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout, "BUILD_INSTALLATION_CAPABILITY_OK\n"); assert.equal(result.stderr, "");
});
test("installation policy inspects present optional setup and implicit node gyp", async t => {
  for (const mode of ["install", "implicit", "optional"]) await t.test(mode, () => {
    const root = installedFixture(t);
    let name = "node_modules/yaml";
    if (mode === "optional") {
      name = "node_modules/@esbuild/linux-arm64";
      if (name === `node_modules/@esbuild/${process.platform}-${process.arch}`) name = "node_modules/@esbuild/win32-arm64";
      fs.mkdirSync(join(root, name), { recursive: true });
      fs.writeFileSync(join(root, name, "package.json"), JSON.stringify({ name: name.slice(13), version: "0.28.2" }));
    }
    if (mode === "implicit") fs.writeFileSync(join(root, name, "binding.gyp"), "{}\n");
    else edit(root, `${name}/package.json`, pkg => { pkg.scripts = { install: "node setup-executed.txt" }; });
    afterRefused(root);
  });
});
test("native capability refuses altered metadata digest and resolution", async t => {
  for (const mode of ["missing", "version", "joint-digest", "hash-table", "namespace", "override", "cache", "hardlink", "symlink", "unusable"]) await t.test(mode, child => {
    const root = installedFixture(child), binary = join(root, nativeRecipe());
    if (mode === "missing") fs.rmSync(dirname(binary), { recursive: true });
    if (mode === "version") edit(root, nativeRecipe().replace(/(?:bin\/esbuild|esbuild\.exe)$/, "package.json"), pkg => { pkg.version = "0.28.3"; });
    if (mode === "joint-digest" || mode === "unusable") fs.writeFileSync(binary, "unreviewed native bytes");
    if (mode === "joint-digest") edit(root, "node_modules/esbuild/package.json", pkg => { pkg["esbuild.binaryHashes"][nativeRecipe().slice(13)] = createHash("sha256").update(fs.readFileSync(binary)).digest("hex"); });
    if (mode === "hash-table") edit(root, "node_modules/esbuild/package.json", pkg => { pkg["esbuild.binaryHashes"][nativeRecipe().slice(13)] = "0".repeat(64); });
    if (mode === "namespace") fs.mkdirSync(join(root, "scripts/node_modules"));
    if (mode === "cache") { fs.rmSync(binary); fs.writeFileSync(join(root, "node_modules/esbuild/lib/downloaded-esbuild"), "cached"); }
    if (mode === "hardlink") fs.linkSync(binary, join(root, "native-alias"));
    if (mode === "symlink") {
      fs.renameSync(binary, join(root, "native-original"));
      try { fs.symlinkSync(join(root, "native-original"), binary); }
      catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { child.skip("native file symlink unavailable"); return; } throw error; }
    }
    afterRefused(root, mode === "override" ? "process.env.ESBUILD_BINARY_PATH=process.execPath;" : undefined);
  });
});

test("guarded snapshot returns complete identity with compatible bytes", t => {
  const root = fixture(t), url = pathToFileURL(join(root, "scripts/run-v2-shadow-migration-rehearsal.js")).href;
  const result = childModule(root, `import assert from 'node:assert/strict'; import fs from 'node:fs'; const m=await import(${JSON.stringify(url)});
    assert.equal(typeof m.readBuildFileSnapshot,'function','guarded snapshot interface exists');
    const a=m.readBuildFileSnapshot('package.json'), stat=fs.statSync(${JSON.stringify(join(root, "package.json"))},{bigint:true});
    assert.deepEqual(a.bytes,m.readBuildBytes('package.json')); assert.deepEqual(Object.keys(a.identity).sort(),['ctimeNs','dev','ino','mtimeNs','size']);
    for(const key of Object.keys(a.identity)) assert.equal(a.identity[key],stat[key]);`);
  assert.equal(result.status, 0, String(result.stderr));
});
test("guarded snapshot refuses descriptor read mutation and leaf replacement", async t => {
  for (const mode of ["short-read", "descriptor", "replacement"]) await t.test(mode, () => {
    const root = fixture(t), target = join(root, "package.json"), url = pathToFileURL(join(root, "scripts/run-v2-shadow-migration-rehearsal.js")).href;
    const result = childModule(root, `import assert from 'node:assert/strict'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const m=await import(${JSON.stringify(url)}); assert.equal(typeof m.readBuildFileSnapshot,'function');
      const read=fs.readSync, stat=fs.fstatSync, originalBytes=fs.readFileSync(${JSON.stringify(target)}); let reached=false;
      fs.readSync=function(...args){ reached=true; ${mode === "short-read" ? "return 0;" : `const n=read(...args); ${mode === "replacement" ? `fs.renameSync(${JSON.stringify(target)},${JSON.stringify(target + ".old")});fs.writeFileSync(${JSON.stringify(target)},originalBytes);` : ""} return n;`} };
      ${mode === "descriptor" ? "let count=0;fs.fstatSync=function(...args){const s=stat(...args);if(++count===2)s.mtimeNs+=1n;return s;};" : ""}
      syncBuiltinESMExports(); assert.throws(()=>m.readBuildFileSnapshot('package.json'),{message:'REHEARSAL_BUILD_INVALID'});assert.equal(reached,true);`);
    assert.equal(result.status, 0, String(result.stderr));
  });
});

function nativeDouble(root: string, behavior: string): string {
  // Double only the admitted native boundary; all policy, resolution and readers stay real.
  return `import cp from 'node:child_process'; import fs from 'node:fs'; import assert from 'node:assert/strict';
    import {EventEmitter} from 'node:events';import {syncBuiltinESMExports} from 'node:module';
    const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===10000?20:ms,...args);
    cp.spawn=(file,args,options)=>{assert.equal(file,${JSON.stringify(join(root, nativeRecipe()))});assert.deepEqual(args,['--version']);
      assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.stdio[0],'ignore');
      fs.writeFileSync(${JSON.stringify(join(root, "native-called.txt"))},'called');
      const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.exitCode=null;c.signalCode=null;
      c.kill=()=>{fs.writeFileSync(${JSON.stringify(join(root, "native-killed.txt"))},'killed');${behavior === "incomplete" ? "return false;" : "timer(()=>{c.exitCode=0;c.stdout.emit('data',Buffer.from('0.28.2\\n'));c.emit('close',0,null);},1);return true;"}};
      ${behavior === "late" ? "" : behavior === "incomplete" ? "timer(()=>{c.exitCode=0;c.emit('exit',0,null);},1);" : `timer(()=>{${behavior === "overflow" ? "c.stdout.emit('data',Buffer.alloc(1025));" : behavior === "stderr" ? "c.stderr.emit('data',Buffer.from('unexpected'));" : behavior === "spawn-error" ? "c.emit('error',new Error('owned native spawn error'));" : behavior === "replace" ? `const bytes=fs.readFileSync(file);fs.renameSync(file,file+'.old');fs.writeFileSync(file,bytes);` : ""} c.exitCode=${behavior === "false-close" ? "null" : "0"};c.stdout.emit('data',Buffer.from('${behavior === "wrong-version" ? "0.28.3" : "0.28.2"}\\n${behavior === "extra-output" ? "extra\\n" : ""}'));c.emit('close',0,null);},1);`}
      return c;};syncBuiltinESMExports();`;
}
test("native capability rejects byte identical replacement across invocation", t => {
  const root = installedFixture(t); afterRefused(root, nativeDouble(root, "replace"), true);
  assert.equal(fs.existsSync(join(root, "native-called.txt")), true, "admitted native boundary must be reached");
  assert.equal(fs.readFileSync(join(root, "native-called.txt"), "utf8"), "called");
});
test("native capability rejects late success after timeout", t => {
  const root = installedFixture(t); afterRefused(root, nativeDouble(root, "late"), true);
  assert.equal(fs.existsSync(join(root, "native-killed.txt")), true, "consumer must own timeout cleanup");
  assert.equal(fs.readFileSync(join(root, "native-killed.txt"), "utf8"), "killed");
});
test("native capability rejects stream overflow and unexpected stderr", async t => {
  for (const mode of ["overflow", "stderr"]) await t.test(mode, () => {
    const root = installedFixture(t); afterRefused(root, nativeDouble(root, mode), true);
    assert.equal(fs.existsSync(join(root, "native-called.txt")), true, "admitted native boundary must be reached");
    assert.equal(fs.readFileSync(join(root, "native-called.txt"), "utf8"), "called");
    assert.equal(fs.existsSync(join(root, "native-killed.txt")), true, "stream refusal must attempt owned cleanup");
  });
});
test("native capability rejects incomplete closure", t => {
  const root = installedFixture(t); afterRefused(root, nativeDouble(root, "incomplete"), true);
  assert.equal(fs.existsSync(join(root, "native-killed.txt")), true, "consumer must attempt owned cleanup");
  assert.equal(fs.readFileSync(join(root, "native-killed.txt"), "utf8"), "killed");
});
test("native capability refuses unusable invocation and false version closure", async t => {
  for (const mode of ["spawn-error", "wrong-version", "extra-output", "false-close"]) await t.test(mode, () => {
    const root = installedFixture(t); afterRefused(root, nativeDouble(root, mode), true);
    assert.equal(fs.existsSync(join(root, "native-called.txt")), true, "fault occurred at the admitted native boundary");
  });
});
test("native capability rejects wrong selected platform metadata", async t => {
  for (const mode of ["name", "installed CPU", "installed OS", "locked CPU", "locked OS"]) await t.test(mode, child => {
    const root = installedFixture(child), nativeRoot = `node_modules/@esbuild/${process.platform}-${process.arch}`;
    if (mode === "name") edit(root, `${nativeRoot}/package.json`, pkg => { pkg.name = "@esbuild/wrong-platform"; });
    else {
      const field = mode.endsWith("CPU") ? "cpu" : "os";
      const value = field === "cpu" ? (process.arch === "x64" ? "arm64" : "x64") : (process.platform === "win32" ? "linux" : "win32");
      if (mode.startsWith("installed")) edit(root, `${nativeRoot}/package.json`, pkg => { pkg[field] = [value]; });
      else edit(root, "package-lock.json", lock => { lock.packages[nativeRoot][field] = [value]; });
    }
    afterRefused(root);
  });
});
