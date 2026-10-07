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
  "ci-workflow-roles", "ci-fresh-start-foundation", "runtime-capabilities", "migration-runner", "migration-registry", "session-lifecycle-migration",
  "qualified-checkpoint-migration", "session-end-effective-state-migration", "project-store-bootstrap",
  "project-store-upgrade", "project-store-upgrade-phase-runner", "projection-image-metadata",
].map(name => `${name}.test.js`);
const paired = [
  "qualified-checkpoint-migration.test.js",
  "qualified-checkpoint-quick-integrity.test.js",
  "session-end-effective-state-migration.test.js",
];
const fullCommand = 'npm run test:build && node --test --test-concurrency=1 --test-reporter=spec "dist-test/tests/**/*.test.js"';

async function profile() {
  assert.ok(existsSync(runner), "the explicit default profile selector must exist");
  return await import(pathToFileURL(runner).href) as {
    selectDefaultTests(testRoot: string): string[];
    runDefaultTests(testRoot: string, executable?: string): Promise<void>;
  };
}

function fixture(files = [...excluded, ...retained, "future-migration.test.js", "ci-release-identity.test.js", "nested/v1-source-copy.test.js", "nested/v2-shadow-migration-rehearsal.test.js"]) {
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

// Real test processes coordinate through private fixture files. Removing the
// two-file cohort, admitting a lookalike, or starting the remainder early breaks this proof.
function schedulingFixture(failures: string[] = []) {
  const serial = ["a.test.js", "future-migration.test.js", "z.test.js",
    "nested/qualified-checkpoint-migration.test.js",
    "nested/qualified-checkpoint-quick-integrity.test.js",
    "nested/session-end-effective-state-migration.test.js"];
  const f = fixture([...excluded, ...paired, ...serial]);
  for (const name of [...paired, ...serial]) {
    const isPaired = paired.includes(name);
    writeFileSync(join(f.tests, name), `const {test}=require('node:test'); const fs=require('node:fs'); const assert=require('node:assert/strict');
const log=${JSON.stringify(join(f.path, "order.log"))};
const record=event=>fs.appendFileSync(log,event+':'+${JSON.stringify(name)}+'\\n');
test(${JSON.stringify(name)},async()=>{
  assert.equal(process.cwd(),${JSON.stringify(join(root, "."))});
  record('start');
  ${isPaired ? `fs.writeFileSync(${JSON.stringify(join(f.path, `${name}.started`))},'started');
  const peers=${JSON.stringify(paired.filter(other => other !== name).map(other => join(f.path, `${other}.started`)))};
  const deadline=Date.now()+1500;
  while(!peers.some(peer=>fs.existsSync(peer)) && Date.now()<deadline) await new Promise(r=>setTimeout(r,5));` : ""}
  await new Promise(r=>setTimeout(r,${isPaired ? 75 : 5}));
  record('end');
  ${isPaired ? "setTimeout(()=>record('drained'),75);" : ""}
  ${failures.includes(name) ? `throw Error(${JSON.stringify(`controlled failure:${name}`)});` : ""}
});`);
  }
  return f;
}

test("default runner pairs only the exact three isolated files, drains their harness, and keeps the complete remainder serial", async () => {
  await profile();
  const f = schedulingFixture();
  try {
    const result = run(f);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const events = readFileSync(join(f.path, "order.log"), "utf8").trim().split("\n");
    const starts = events.filter(event => event.startsWith("start:")).map(event => event.slice(6));
    assert.deepEqual([...starts].sort(), [
      "a.test.js", "future-migration.test.js", "z.test.js",
      "nested/qualified-checkpoint-migration.test.js", "nested/qualified-checkpoint-quick-integrity.test.js",
      "nested/session-end-effective-state-migration.test.js",
      "qualified-checkpoint-migration.test.js", "qualified-checkpoint-quick-integrity.test.js",
      "session-end-effective-state-migration.test.js",
    ].sort());
    assert.equal(new Set(starts).size, 9);
    const active = new Set<string>();
    const drained = new Set<string>();
    let maximumPaired = 0;
    let serialStarted = false;
    for (const event of events) {
      const separator = event.indexOf(":");
      const kind = event.slice(0, separator);
      const name = event.slice(separator + 1);
      if (kind === "drained") { drained.add(name); continue; }
      if (kind === "end") { assert.ok(active.delete(name), event); continue; }
      assert.equal(kind, "start");
      if (paired.includes(name)) {
        assert.equal(serialStarted, false, "eligible files must run before every serial file");
        active.add(name);
        maximumPaired = Math.max(maximumPaired, active.size);
        assert.ok(active.size <= 2, "the eligible cohort must never exceed two active files");
      } else {
        serialStarted = true;
        assert.deepEqual([...drained].sort(), [...paired].sort(), "the entire cohort child harness must drain first");
        assert.equal(active.size, 0, "the remainder must stay serial");
        active.add(name);
      }
    }
    assert.equal(maximumPaired, 2, "the eligible files must actually overlap");
    assert.equal(active.size, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /excluded legacy fixture was executed|TAP version/);
  } finally { f.cleanup(); }
});

for (const [label, failures] of [
  ["first cohort", ["qualified-checkpoint-migration.test.js"]],
  ["serial remainder", ["a.test.js"]],
  ["both cohorts", ["qualified-checkpoint-migration.test.js", "a.test.js"]],
] as const) {
  test(`default runner preserves failure from ${label} while executing every selected file`, async () => {
    await profile();
    const f = schedulingFixture([...failures]);
    try {
      const result = run(f);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      const events = readFileSync(join(f.path, "order.log"), "utf8").trim().split("\n");
      assert.equal(events.filter(event => event.startsWith("start:")).length, 9);
      assert.ok(events.indexOf("start:a.test.js") > events.indexOf("end:session-end-effective-state-migration.test.js"),
        "the serial remainder must execute after a normally completed cohort even when it fails");
      for (const name of failures) assert.ok((result.stdout + result.stderr).includes(`controlled failure:${name}`));
    } finally { f.cleanup(); }
  });
}

test("default runner safely omits an empty serial remainder", async () => {
  await profile();
  const f = fixture([...excluded, "qualified-checkpoint-migration.test.js"]);
  try {
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.path, "order.log"), "utf8"),
      "start:qualified-checkpoint-migration.test.js\nend:qualified-checkpoint-migration.test.js\n");
    assert.match(result.stdout, /ℹ tests 1/);
    assert.doesNotMatch(result.stdout + result.stderr, /excluded legacy fixture was executed/);
  } finally { f.cleanup(); }
});

test("default runner stops before the serial remainder on a cohort spawn error", async () => {
  await profile();
  const f = fixture([...excluded, ...paired, "a.test.js"]);
  // Record attempts while preserving the real native spawn and its ENOENT event.
  // An absent test log alone cannot detect a second attempt at the missing executable.
  const attempts = join(f.path, "spawn-attempts.log");
  writeFileSync(f.wrapper, `import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module'; import {appendFileSync} from 'node:fs';
const nativeSpawn=childProcess.spawn;
childProcess.spawn=(...args)=>{appendFileSync(${JSON.stringify(attempts)},'attempt\\n');return nativeSpawn(...args);};
syncBuiltinESMExports();
const {runDefaultTests}=await import(${JSON.stringify(pathToFileURL(runner).href)});
await runDefaultTests(${JSON.stringify(f.tests)},process.argv[2]);`);
  try {
    const result = run(f, join(f.path, "missing-node-executable"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
    assert.equal(readFileSync(attempts, "utf8"), "attempt\n", "spawn errors must stop before any second cohort attempt");
    assert.equal(existsSync(join(f.path, "order.log")), false);
  } finally { f.cleanup(); }
});

// Node 24 node:test handles SIGTERM/SIGINT itself ("Interrupted while running", exit status 1),
// so only an uncatchable signal proves native child signal termination is relayed.
test("default runner stops after a cohort signal and preserves native signal termination", {
  skip: process.platform === "win32" ? "Windows reports process termination as an exit code, not a POSIX signal" : false,
}, async () => {
  await profile();
  const f = fixture([...excluded, "qualified-checkpoint-migration.test.js", "z.test.js"]);
  writeFileSync(join(f.tests, "qualified-checkpoint-migration.test.js"), "process.kill(process.ppid,'SIGKILL'); setInterval(()=>{},1000).unref();");
  try {
    const result = run(f);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.status, null);
    assert.equal(existsSync(join(f.path, "order.log")), false);
  } finally { f.cleanup(); }
});

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
    assert.deepEqual(names, [...retained, "future-migration.test.js", "ci-release-identity.test.js", "nested/v1-source-copy.test.js", "nested/v2-shadow-migration-rehearsal.test.js"].sort());
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

// Node 24 node:test handles SIGTERM/SIGINT itself ("Interrupted while running", exit status 1),
// so only an uncatchable signal proves native child signal termination is relayed.
test("default runner preserves native child signal termination", { skip: process.platform === "win32" ? "Windows reports process termination as an exit code, not a POSIX signal" : false }, async () => {
  await profile();
  const f = fixture([...excluded, "signal.test.js"]);
  writeFileSync(join(f.tests, "signal.test.js"), "process.kill(process.ppid,'SIGKILL'); setInterval(()=>{},1000).unref();");
  try {
    const result = run(f);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.status, null);
  } finally { f.cleanup(); }
});

test("default selector entry rejects arguments instead of exposing arbitrary roots or options", async () => {
  await profile();
  const result = spawnSync(process.execPath, [runner, "--root=other"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEST_PROFILE_ARGUMENTS_INVALID/);
});
