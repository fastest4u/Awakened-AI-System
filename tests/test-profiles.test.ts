import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = join(root, "scripts/run-test-profile.js");
// Independent, reviewed policy literals: broad "migration" filtering loses schema coverage.
const excluded = [
  "v1-source-copy", "v2-migration-package", "v2-shadow-migration-contracts", "v2-shadow-migration-runtime",
  "v2-shadow-migration-repository", "v2-shadow-importer", "v2-imported-event-reader", "v2-shadow-projection",
  "v2-snapshot-parity", "v2-shadow-compatibility", "v2-shadow-migration-runner", "v2-shadow-migration-rehearsal",
].map(name => `${name}.test.js`);
const retained = [
  "v2-parity-lifecycle-fixture", "sqlite-driver", "recording-git-command-runner", "retrieval-evaluation",
  "retrieval-service", "stable-compatibility-directory", "ci-lifecycle-gates", "projection-integrity",
  "runtime-capabilities", "migration-runner", "migration-registry", "session-lifecycle-migration",
  "qualified-checkpoint-migration", "session-end-effective-state-migration", "project-store-bootstrap",
  "project-store-upgrade", "project-store-upgrade-phase-runner", "projection-image-metadata",
].map(name => `${name}.test.js`);
const fullCommand = 'npm run test:build && node --test --test-concurrency=1 --test-reporter=spec "dist-test/tests/**/*.test.js"';

async function profile() {
  assert.ok(existsSync(runner), "the explicit default profile selector must exist");
  return await import(pathToFileURL(runner).href) as {
    selectDefaultTests(testRoot: string): string[];
    runDefaultTests(testRoot: string, executable?: string): Promise<void>;
  };
}

function fixture(files = [...excluded, ...retained, "future-migration.test.js", "nested/v2-shadow-migration-rehearsal.test.js"]) {
  const path = mkdtempSync(join(tmpdir(), "test-profile-"));
  const tests = join(path, "tests");
  for (const name of files) {
    mkdirSync(dirname(join(tests, name)), { recursive: true });
    writeFileSync(join(tests, name), excluded.includes(name)
      ? "throw Error('excluded legacy fixture was executed');"
      : `const {test}=require('node:test'); const fs=require('node:fs');
test(${JSON.stringify(name)},async()=>{fs.appendFileSync(${JSON.stringify(join(path, "order.log"))},${JSON.stringify(`start:${name}\n`)});
await new Promise(r=>setTimeout(r,5));
fs.appendFileSync(${JSON.stringify(join(path, "order.log"))},${JSON.stringify(`end:${name}\n`)});});`);
  }
  const wrapper = join(path, "invoke.mjs");
  writeFileSync(wrapper, `import {runDefaultTests} from ${JSON.stringify(pathToFileURL(runner).href)};
await runDefaultTests(${JSON.stringify(tests)},process.argv[2]);`);
  return { path, tests, wrapper, cleanup() { rmSync(path, { recursive: true, force: true }); } };
}
function run(f: ReturnType<typeof fixture>, executable?: string) {
  return spawnSync(process.execPath, [f.wrapper, ...(executable ? [executable] : [])], {
    cwd: f.path, encoding: "utf8", timeout: 20000, windowsHide: true,
    env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" },
  });
}

test("package profiles compile once, retain the full entry and runtime prechecks, and alias the migration producer", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts.test, "npm run test:build && node scripts/run-test-profile.js");
  assert.equal(scripts["test:all"], fullCommand);
  assert.equal(scripts.pretest, "npm run check:runtime");
  assert.equal(scripts["pretest:all"], "npm run check:runtime");
  assert.equal(scripts["test:migration"], "npm run test:v2-shadow-migration");
  const migrationFiles = ["sqlite-driver", "v2-shadow-migration-contracts", "v2-shadow-migration-runtime",
    "v1-source-copy", "v2-migration-package", "v2-shadow-migration-repository", "v2-shadow-importer",
    "v2-imported-event-reader", "v2-shadow-projection", "v2-parity-lifecycle-fixture", "recording-git-command-runner",
    "v2-snapshot-parity", "retrieval-evaluation", "retrieval-service", "stable-compatibility-directory",
    "v2-shadow-compatibility", "v2-shadow-migration-runner", "v2-shadow-migration-rehearsal", "ci-lifecycle-gates"];
  assert.equal(scripts["test:v2-shadow-migration"], "npm run test:build && node --test --test-concurrency=1 --test-reporter=spec "
    + migrationFiles.map(name => `dist-test/tests/${name}.test.js`).join(" "));
});

test("default selector partitions real compiled tests by exactly twelve exclusions without losses or duplicates", async () => {
  const { selectDefaultTests } = await profile();
  const tests = join(root, "dist-test/tests");
  const all = globSync("**/*.test.js", { cwd: tests }).map(name => name.replaceAll("\\", "/")).sort();
  const selected = selectDefaultTests(tests).map(path => relative(tests, path).replaceAll("\\", "/")).sort();
  assert.deepEqual(selected, all.filter(name => !excluded.includes(name)));
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(all.filter(name => !selected.includes(name)), [...excluded].sort());
  for (const name of retained) assert.ok(selected.includes(name), `${name} must retain shared/schema coverage`);
});

test("default selector includes future migration names and nested lookalikes without accidentally broadening exclusions", async () => {
  const { selectDefaultTests } = await profile();
  const f = fixture();
  try {
    const names = selectDefaultTests(f.tests).map(path => relative(f.tests, path).replaceAll("\\", "/")).sort();
    assert.deepEqual(names, [...retained, "future-migration.test.js", "nested/v2-shadow-migration-rehearsal.test.js"].sort());
    assert.equal(new Set(names).size, names.length);
  } finally { f.cleanup(); }
});

test("default selector fails closed when any explicit exclusion input is missing", async () => {
  const { selectDefaultTests } = await profile();
  for (const missing of excluded) {
    const f = fixture([...excluded.filter(name => name !== missing), "ordinary.test.js"]);
    try { assert.throws(() => selectDefaultTests(f.tests), error => error instanceof Error && error.message.includes(missing)); }
    finally { f.cleanup(); }
  }
});

test("default runner executes real selected children serially under NODE_TEST_CONTEXT with the spec reporter", async () => {
  await profile();
  const f = fixture([...excluded, "a.test.js", "nested/b.test.js"]);
  try {
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.path, "order.log"), "utf8"), "start:a.test.js\nend:a.test.js\nstart:nested/b.test.js\nend:nested/b.test.js\n");
    assert.match(result.stdout, /✔ a\.test\.js/);
    assert.match(result.stdout, /ℹ tests 2/);
    assert.doesNotMatch(result.stdout + result.stderr, /excluded legacy fixture was executed|recursive|TAP version/);
  } finally { f.cleanup(); }
});

test("default runner propagates a real failed test exit and preserves its diagnostic output", async () => {
  await profile();
  const f = fixture([...excluded, "failure.test.js"]);
  writeFileSync(join(f.tests, "failure.test.js"), "require('node:test').test('controlled profile failure',()=>{throw Error('real child failure');});");
  try {
    const result = run(f);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /real child failure/);
    assert.match(result.stdout, /ℹ fail 1/);
  } finally { f.cleanup(); }
});

test("default runner surfaces native spawn errors as nonzero failures", async () => {
  await profile();
  const f = fixture([...excluded, "ordinary.test.js"]);
  try {
    const result = run(f, join(f.path, "missing-node-executable"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
    assert.equal(existsSync(join(f.path, "order.log")), false);
  } finally { f.cleanup(); }
});

test("default runner preserves native child signal termination", { skip: process.platform === "win32" ? "Windows reports process termination as an exit code, not a POSIX signal" : false }, async () => {
  await profile();
  const f = fixture([...excluded, "signal.test.js"]);
  writeFileSync(join(f.tests, "signal.test.js"), "process.kill(process.ppid,'SIGTERM'); setInterval(()=>{},1000).unref();");
  try {
    const result = run(f);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.status, null);
  } finally { f.cleanup(); }
});

test("default selector entry rejects arguments instead of exposing arbitrary roots or options", async () => {
  await profile();
  const result = spawnSync(process.execPath, [runner, "--root=other"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEST_PROFILE_ARGUMENTS_INVALID/);
});
