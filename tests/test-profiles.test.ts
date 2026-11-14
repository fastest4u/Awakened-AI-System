import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = join(root, "scripts/run-test-profile.js");

// Independent, reviewed policy literals: essential core V2 + storage + lifecycle + projection + WebUI tests
// ordered heavy-first (LPT) so 4-worker parallel execution finishes well under 10 minutes.
const expectedEssential = [
  // Heavy end-to-end V2 public surface, WebUI, multi-project, acceleration, governance & recovery
  "v2-public-mcp-tools",
  "v2-webui-and-curator",
  "v2-webui-spa-serving",
  "v2-governed-lifecycle-mutations",
  "v2-awakening-and-multiproject",
  "v2-recovery-backup-restore",
  "fresh-start-control-plane",
  "fresh-start-repository",
  "rollout-control-plane",
  "v2-full-body-note-privacy",
  "sqlite-driver",
  "v2-native-workflow-query",
  "retrieval-selection-core",
  "projection-manifest",
  "v2-retrieval-candidates",
  "v2-full-body-note-projection",
  "retrieval-service",
  "session-lifecycle-migration",
  "retrieval-database-core",
  "lifecycle-command-store",
  "v2-native-workflow-database",
  "session-aggregate",
  "session-authority.repository",
  "migration-registry",
  "retrieval-ranking",
  "v2-native-content-contracts",
  "v2-reader-lease",
  "session-end-workflow",
  "v2-native-content-result",
  "session-end-child-saga",
  "session-end.coordinator",
  "projection-runtime",
  "stored-event-authenticator",
  "ci-workflow-roles",
  "runtime-capabilities",
  "v2-native-workflow-contracts",
  "event-store",
  "lifecycle-executor",
  "session-end-effective-state",
  "projection-builder",
  "v2-retained-evidence-envelope",
  "v2-native-workflow-cursor",
  "projection-source-event-codec",
  "checkpoint.service",
  "retrieval-eligibility",
  "migration-runner",
  "projection-schema",
  "lifecycle-contracts",
  "v2-retained-evidence-contracts",
  "lifecycle-projection-folds",
  "v2-full-body-note-contracts",
  "session-end-policy",
  "v2-operational-key-custody",
  "v2-governed-note-redaction",
  "v2-retained-evidence-redaction",
  "projection-folds",
  "session-lease.repository",
  "v2-governed-note-contracts",
  "lifecycle-recovery",
  "event-hash",
  "canonical-json",
  "v2-ai-ide-acceleration",
  "test-profiles",
].map((name) => `${name}.test.js`);

// Heavy/exhaustive/legacy suites excluded from default `npm test` (available via dedicated scripts & `npm run test:all`).
const sampleExcludedHeavyAndLegacy = [
  "v1-source-copy.test.js",
  "v2-migration-package.test.js",
  "v2-shadow-migration-contracts.test.js",
  "v2-shadow-migration-rehearsal.test.js",
  "v2-admin-cutover-and-release-gate.test.js",
  "ci-lifecycle-gates.test.js",
  "ci-fresh-start-foundation.test.js",
  "ci-release-identity.test.js",
  "build-installation-policy.test.js",
  "v2-governed-note-gate.test.js",
  "v2-full-body-notes-gate.test.js",
  "v2-internal-verified-read-gate.test.js",
  "v2-native-content-gate.test.js",
  "v2-native-workflow-gate.test.js",
  "retrieval-evaluation.test.js",
  "lifecycle.stress.test.js",
  "lifecycle.crash.test.js",
  "lifecycle.concurrent.test.js",
  "event-store.stress.test.js",
  "event-store.crash.test.js",
  "event-store.concurrent.test.js",
  "qualified-checkpoint-full-integrity.test.js",
  "qualified-checkpoint-migration.test.js",
];

const fullCommand =
  'npm run test:build && node --test --test-concurrency=1 --test-reporter=spec "dist-test/tests/**/*.test.js"';

async function profile() {
  assert.ok(existsSync(runner), "the explicit default profile selector must exist");
  return (await import(pathToFileURL(runner).href)) as {
    ESSENTIAL_DEFAULT_TESTS: readonly string[];
    DEFAULT_TEST_CONCURRENCY: number;
    selectDefaultTests(testRoot?: string): string[];
    runDefaultTests(testRoot?: string, executable?: string): Promise<void>;
  };
}

function fixture(extraFiles: string[] = ["excluded-heavy.test.js", "nested/v2-public-mcp-tools.test.js"]) {
  const path = mkdtempSync(join(tmpdir(), "test-profile-"));
  const tests = join(path, "tests");
  const allFiles = [...expectedEssential, ...extraFiles];
  for (const name of allFiles) {
    mkdirSync(dirname(join(tests, name)), { recursive: true });
    const isSelected = expectedEssential.includes(name);
    writeFileSync(
      join(tests, name),
      isSelected
        ? `const {test}=require('node:test'); test(${JSON.stringify(name)},()=>{});`
        : "throw Error('non-essential fixture was executed');",
    );
  }
  const wrapper = join(path, "invoke.mjs");
  writeFileSync(
    wrapper,
    `import {runDefaultTests} from ${JSON.stringify(pathToFileURL(runner).href)};
await runDefaultTests(${JSON.stringify(tests)},process.argv[2]);`,
  );
  return {
    path,
    tests,
    wrapper,
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

function run(f: ReturnType<typeof fixture>, executable?: string) {
  return spawnSync(process.execPath, [f.wrapper, ...(executable ? [executable] : [])], {
    cwd: f.path,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" },
  });
}

test("default profile exports frozen essential core list and bounded 4-worker concurrency", async () => {
  const mod = await profile();
  assert.equal(mod.DEFAULT_TEST_CONCURRENCY, 4);
  assert.equal(Object.isFrozen(mod.ESSENTIAL_DEFAULT_TESTS), true);
  assert.deepEqual([...mod.ESSENTIAL_DEFAULT_TESTS], expectedEssential);
  assert.equal(new Set(mod.ESSENTIAL_DEFAULT_TESTS).size, expectedEssential.length);
});

test("default selector picks exact essential core tests in LPT priority order and excludes heavy/stress/migration/gate suites", async () => {
  const { selectDefaultTests } = await profile();
  const tests = join(root, "dist-test/tests");
  const all = globSync("**/*.test.js", { cwd: tests }).map((name) => name.replaceAll("\\", "/"));
  const selected = selectDefaultTests(tests).map((p) => relative(tests, p).replaceAll("\\", "/"));

  assert.deepEqual(selected, expectedEssential);
  assert.equal(new Set(selected).size, selected.length);
  assert.ok(selected.length < all.length, "default profile must be a bounded subset of all compiled tests");

  const selectedSet = new Set(selected);
  for (const heavy of sampleExcludedHeavyAndLegacy) {
    assert.ok(all.includes(heavy), `${heavy} must still compile for dedicated gates and test:all`);
    assert.equal(selectedSet.has(heavy), false, `${heavy} must not run in fast default npm test`);
  }
});

test("default selector ignores unapproved extra files and nested lookalikes", async () => {
  const { selectDefaultTests } = await profile();
  const f = fixture([
    "v1-source-copy.test.js",
    "untracked-scratch.test.js",
    "nested/v2-public-mcp-tools.test.js",
    "nested/sqlite-driver.test.js",
  ]);
  try {
    const names = selectDefaultTests(f.tests).map((p) => relative(f.tests, p).replaceAll("\\", "/"));
    assert.deepEqual(names, expectedEssential);
  } finally {
    f.cleanup();
  }
});

test("default selector fails closed when any required essential test is missing", async () => {
  const { selectDefaultTests } = await profile();
  const f = fixture([]);
  try {
    for (const missing of expectedEssential) {
      const target = join(f.tests, missing);
      const saved = readFileSync(target, "utf8");
      unlinkSync(target);
      try {
        assert.throws(
          () => selectDefaultTests(f.tests),
          (error) =>
            error instanceof Error &&
            error.message.includes("TEST_PROFILE_ESSENTIAL_MISSING") &&
            error.message.includes(missing),
        );
      } finally {
        writeFileSync(target, saved);
      }
    }
  } finally {
    f.cleanup();
  }
});

test("default runner overlaps top LPT files in parallel under NODE_TEST_CONTEXT with the spec reporter and skips excluded files", async () => {
  await profile();
  const f = fixture(["v1-source-copy.test.js", "ci-lifecycle-gates.test.js"]);
  const coordinated = expectedEssential.slice(0, 4);
  const log = join(f.path, "order.log");
  for (const name of coordinated) {
    const peers = coordinated.filter((other) => other !== name).map((other) => join(f.path, `${other}.started`));
    writeFileSync(
      join(f.tests, name),
      `const {test}=require('node:test'); const fs=require('node:fs'); const assert=require('node:assert/strict');
test(${JSON.stringify(name)},async()=>{
  assert.equal(process.cwd(),${JSON.stringify(join(root, "."))});
  fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(`start:${name}\n`)});
  fs.writeFileSync(${JSON.stringify(join(f.path, `${name}.started`))},'1');
  const deadline=Date.now()+2000;
  while(![${peers.map((p) => JSON.stringify(p)).join(",")}].some(p=>fs.existsSync(p)) && Date.now()<deadline) {
    await new Promise(r=>setTimeout(r,5));
  }
  await new Promise(r=>setTimeout(r,60));
  fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(`end:${name}\n`)});
});`,
    );
  }
  try {
    const result = run(f);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const events = readFileSync(log, "utf8").trim().split("\n");
    const active = new Set<string>();
    let maxConcurrent = 0;
    for (const event of events) {
      const idx = event.indexOf(":");
      const kind = event.slice(0, idx);
      const name = event.slice(idx + 1);
      if (kind === "start") {
        active.add(name);
        maxConcurrent = Math.max(maxConcurrent, active.size);
      } else if (kind === "end") {
        active.delete(name);
      }
    }
    assert.ok(maxConcurrent >= 2 && maxConcurrent <= 4, `expected parallel overlap in [2..4], observed ${maxConcurrent}`);
    assert.match(result.stdout, new RegExp(`ℹ tests ${expectedEssential.length}`));
    assert.doesNotMatch(result.stdout + result.stderr, /non-essential fixture was executed|TAP version/);
  } finally {
    f.cleanup();
  }
});

test("default runner propagates a real failed test exit and preserves its diagnostic output", async () => {
  await profile();
  const f = fixture();
  writeFileSync(
    join(f.tests, expectedEssential[0]!),
    "require('node:test').test('controlled profile failure',()=>{throw Error('real child failure');});",
  );
  try {
    const result = run(f);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /real child failure/);
    assert.match(result.stdout, /ℹ fail 1/);
  } finally {
    f.cleanup();
  }
});

test("default runner surfaces native spawn errors as nonzero failures", async () => {
  await profile();
  const f = fixture();
  try {
    const result = run(f, join(f.path, "missing-node-executable"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
  } finally {
    f.cleanup();
  }
});

// Node 24 node:test handles SIGTERM/SIGINT itself ("Interrupted while running", exit status 1),
// so only an uncatchable signal proves native child signal termination is relayed.
test(
  "default runner preserves native child signal termination",
  { skip: process.platform === "win32" ? "Windows reports process termination as an exit code, not a POSIX signal" : false },
  async () => {
    await profile();
    const f = fixture();
    writeFileSync(
      join(f.tests, expectedEssential[0]!),
      "process.kill(process.ppid,'SIGKILL'); setInterval(()=>{},1000).unref();",
    );
    try {
      const result = run(f);
      assert.equal(result.signal, "SIGKILL");
      assert.equal(result.status, null);
    } finally {
      f.cleanup();
    }
  },
);

test("package profiles compile once, retain full/stress/migration/release gates, and wire default test to run-test-profile", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts.test, "npm run test:build && node scripts/run-test-profile.js");
  assert.equal(scripts["test:all"], fullCommand);
  assert.equal(scripts.pretest, "npm run check:runtime");
  assert.equal(scripts["pretest:all"], "npm run check:runtime");
  assert.equal(scripts["test:migration"], "npm run test:v2-shadow-migration");
  assert.equal(scripts["test:stress"], "node scripts/run-stress.js");
  assert.equal(scripts["test:lifecycle-stress"], "node scripts/run-lifecycle-stress.js");
  assert.equal(scripts["verify:v2-fresh-start-release"], "node scripts/run-v2-fresh-start-release.js");
  const migrationFiles = [
    "sqlite-driver",
    "v2-shadow-migration-contracts",
    "v2-shadow-migration-runtime",
    "v1-source-copy",
    "v2-migration-package",
    "v2-shadow-migration-repository",
    "v2-shadow-importer",
    "v2-imported-event-reader",
    "v2-shadow-projection",
    "v2-parity-lifecycle-fixture",
    "recording-git-command-runner",
    "v2-snapshot-parity",
    "retrieval-evaluation",
    "retrieval-service",
    "stable-compatibility-directory",
    "v2-shadow-compatibility",
    "v2-shadow-migration-runner",
    "v2-shadow-migration-rehearsal",
    "ci-lifecycle-gates",
  ];
  assert.equal(
    scripts["test:v2-shadow-migration"],
    "npm run test:build && node --test --test-concurrency=1 --test-reporter=spec " +
      migrationFiles.map((name) => `dist-test/tests/${name}.test.js`).join(" "),
  );
});

test("default selector entry rejects arguments instead of exposing arbitrary roots or options", async () => {
  await profile();
  const result = spawnSync(process.execPath, [runner, "--root=other"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEST_PROFILE_ARGUMENTS_INVALID/);
});
