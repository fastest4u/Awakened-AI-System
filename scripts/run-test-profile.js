import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiledTests = join(root, "dist-test/tests");
// Pure legacy V1 data migration only. Shared, recovery and schema migrations stay in default.
const legacyDataMigrationTests = new Set([
  "v1-source-copy.test.js",
  "v2-migration-package.test.js",
  "v2-shadow-migration-contracts.test.js",
  "v2-shadow-migration-runtime.test.js",
  "v2-shadow-migration-repository.test.js",
  "v2-shadow-importer.test.js",
  "v2-imported-event-reader.test.js",
  "v2-shadow-projection.test.js",
  "v2-snapshot-parity.test.js",
  "v2-shadow-compatibility.test.js",
  "v2-shadow-migration-runner.test.js",
  "v2-shadow-migration-rehearsal.test.js",
]);
// Only these reviewed, top-level files own independent temporary SQLite stores.
const pairedTests = new Set([
  "qualified-checkpoint-migration.test.js",
  "session-end-effective-state-migration.test.js",
  "qualified-checkpoint-quick-integrity.test.js",
]);

// Internal fixture seam; the CLI always uses this checkout's compiled tests.
export function selectDefaultTests(testRoot = compiledTests) {
  const files = globSync("**/*.test.js", { cwd: testRoot })
    .map(name => name.replaceAll("\\", "/")).sort();
  const available = new Set(files);
  for (const name of legacyDataMigrationTests) {
    if (!available.has(name)) throw new Error(`TEST_PROFILE_EXCLUSION_MISSING: ${name}`);
  }
  const selected = files.filter(name => !legacyDataMigrationTests.has(name));
  if (selected.length === 0) throw new Error("TEST_PROFILE_EMPTY");
  return selected.map(name => resolve(testRoot, name));
}

export async function runDefaultTests(testRoot = compiledTests, executable = process.execPath) {
  const paired = [];
  const serial = [];
  for (const path of selectDefaultTests(testRoot)) {
    const name = relative(testRoot, path).replaceAll("\\", "/");
    (pairedTests.has(name) ? paired : serial).push(relative(root, path));
  }
  // A runner launched from node:test must start a fresh native test harness.
  const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
  let exitCode = 0;
  for (const [targets, concurrency] of [[paired, 2], [serial, 1]]) {
    if (targets.length === 0) continue;
    const result = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(executable, ["--test", `--test-concurrency=${concurrency}`, "--test-reporter=spec", ...targets], {
        cwd: root, shell: false, windowsHide: true, stdio: "inherit", env: environment,
      });
      child.once("error", rejectRun);
      child.once("close", (code, signal) => resolveRun({ code, signal }));
    });
    if (result.signal !== null) {
      process.exitCode = 1;
      try { process.kill(process.pid, result.signal); }
      catch { /* Preserve failure if this platform cannot relay the signal. */ }
      return;
    }
    if (result.code !== 0 && exitCode === 0) exitCode = result.code ?? 1;
  }
  process.exitCode = exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("TEST_PROFILE_ARGUMENTS_INVALID");
    await runDefaultTests();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
