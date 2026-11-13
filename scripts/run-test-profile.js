import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiledTests = join(root, "dist-test/tests");

export const DEFAULT_TEST_CONCURRENCY = 4;

// Curated essential core test profile ordered heavy-first (LPT) so 4-worker parallel
// execution covers all V2 subsystems cleanly well under 10 minutes.
// Heavy stress, crash, fault-injection, shadow-migration, 504-query corpus, and nested
// build/release-qualification gates run via dedicated scripts and `npm run test:all`.
export const ESSENTIAL_DEFAULT_TESTS = Object.freeze([
  "v2-public-mcp-tools.test.js",
  "v2-webui-and-curator.test.js",
  "v2-governed-lifecycle-mutations.test.js",
  "v2-awakening-and-multiproject.test.js",
  "v2-recovery-backup-restore.test.js",
  "fresh-start-control-plane.test.js",
  "fresh-start-repository.test.js",
  "rollout-control-plane.test.js",
  "v2-full-body-note-privacy.test.js",
  "sqlite-driver.test.js",
  "v2-native-workflow-query.test.js",
  "retrieval-selection-core.test.js",
  "projection-manifest.test.js",
  "v2-retrieval-candidates.test.js",
  "v2-full-body-note-projection.test.js",
  "retrieval-service.test.js",
  "session-lifecycle-migration.test.js",
  "retrieval-database-core.test.js",
  "lifecycle-command-store.test.js",
  "v2-native-workflow-database.test.js",
  "session-aggregate.test.js",
  "session-authority.repository.test.js",
  "migration-registry.test.js",
  "retrieval-ranking.test.js",
  "v2-native-content-contracts.test.js",
  "v2-reader-lease.test.js",
  "session-end-workflow.test.js",
  "v2-native-content-result.test.js",
  "session-end-child-saga.test.js",
  "session-end.coordinator.test.js",
  "projection-runtime.test.js",
  "stored-event-authenticator.test.js",
  "ci-workflow-roles.test.js",
  "runtime-capabilities.test.js",
  "v2-native-workflow-contracts.test.js",
  "event-store.test.js",
  "lifecycle-executor.test.js",
  "session-end-effective-state.test.js",
  "projection-builder.test.js",
  "v2-retained-evidence-envelope.test.js",
  "v2-native-workflow-cursor.test.js",
  "projection-source-event-codec.test.js",
  "checkpoint.service.test.js",
  "retrieval-eligibility.test.js",
  "migration-runner.test.js",
  "projection-schema.test.js",
  "lifecycle-contracts.test.js",
  "v2-retained-evidence-contracts.test.js",
  "lifecycle-projection-folds.test.js",
  "v2-full-body-note-contracts.test.js",
  "session-end-policy.test.js",
  "v2-operational-key-custody.test.js",
  "v2-governed-note-redaction.test.js",
  "v2-retained-evidence-redaction.test.js",
  "projection-folds.test.js",
  "session-lease.repository.test.js",
  "v2-governed-note-contracts.test.js",
  "lifecycle-recovery.test.js",
  "event-hash.test.js",
  "canonical-json.test.js",
  "v2-ai-ide-acceleration.test.js",
  "test-profiles.test.js",
]);

// Internal fixture seam; the CLI always uses this checkout's compiled tests.
export function selectDefaultTests(testRoot = compiledTests) {
  const available = new Set(
    globSync("**/*.test.js", { cwd: testRoot }).map((name) => name.replaceAll("\\", "/")),
  );
  for (const name of ESSENTIAL_DEFAULT_TESTS) {
    if (!available.has(name)) {
      throw new Error(`TEST_PROFILE_ESSENTIAL_MISSING: ${name}`);
    }
  }
  if (ESSENTIAL_DEFAULT_TESTS.length === 0) {
    throw new Error("TEST_PROFILE_EMPTY");
  }
  return ESSENTIAL_DEFAULT_TESTS.map((name) => resolve(testRoot, name));
}

export async function runDefaultTests(testRoot = compiledTests, executable = process.execPath) {
  const targets = selectDefaultTests(testRoot).map((path) => relative(root, path));
  const concurrency = Math.max(1, Math.min(DEFAULT_TEST_CONCURRENCY, targets.length));
  // A runner launched from node:test must start a fresh native test harness.
  const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;

  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      executable,
      ["--test", `--test-concurrency=${concurrency}`, "--test-reporter=spec", ...targets],
      {
        cwd: root,
        shell: false,
        windowsHide: true,
        stdio: "inherit",
        env: environment,
      },
    );
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal }));
  });

  if (result.signal !== null) {
    process.exitCode = 1;
    try {
      process.kill(process.pid, result.signal);
    } catch {
      /* Preserve failure if this platform cannot relay the signal. */
    }
    return;
  }
  process.exitCode = result.code ?? 1;
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
