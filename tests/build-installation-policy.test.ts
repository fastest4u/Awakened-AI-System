import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

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
