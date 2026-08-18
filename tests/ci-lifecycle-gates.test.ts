import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n?/g, "\n");
}

const BASE = "0e375d4643d4b630f36f874a3bb192e96739ac46";
const FROZEN_0002 = "68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06";
const FOCUSED_TESTS = [
  "migration-runner", "session-lifecycle-migration", "qualified-checkpoint-migration",
  "project-store-upgrade", "project-store-executor", "lifecycle-contracts", "checkpoint.service",
  "evidence-coverage", "event-integrity", "lifecycle-worker-protocol", "lifecycle-executor",
  "session-end-policy", "session-end.coordinator", "validation-profile-runner", "lifecycle-recovery",
  "compatibility-log-renderer", "compatibility-log-materializer", "lifecycle-compatibility",
  "lifecycle.concurrent", "lifecycle.crash", "lifecycle.security",
  "session-end-effective-state-migration", "session-end-effective-state", "session-end-workflow",
  "session-end-child-saga", "session-end.crash", "lifecycle-validation-result.repository",
  "lifecycle-materialization-queue", "lifecycle-render-closure.reader", "lifecycle-faults",
  "lifecycle-fixture-protocol", "lifecycle-worker-runtime", "lifecycle.stress",
];

test("release configuration gates lifecycle V2 without production routing", () => {
  const packageJson = JSON.parse(source("package.json")) as { scripts?: Record<string, string> };
  const script = packageJson.scripts?.["test:subproject-2"];
  if (typeof script !== "string") assert.fail("test:subproject-2 must exist");
  const expectedScript = [
    "npm", "run", "test:build", "&&", "node", "--test", "--test-concurrency=1", "--test-reporter=spec",
    ...FOCUSED_TESTS.map((name) => `dist-test/tests/${name}.test.js`),
  ].join(" ");
  assert.equal(script, expectedScript, "test:subproject-2 must be canonical and ordered");
  for (const name of FOCUSED_TESTS) {
    assert.match(script, new RegExp(`dist-test/tests/${name.replace(/[.]/g, "\\.")}\\.test\\.js`));
  }

  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  for (const workflow of [ci, stress]) {
    assert.match(workflow, /uses: actions\/checkout@v6\n\s+with:\n\s+fetch-depth: 0/);
  }
  assert.match(ci, /npm run test:subproject-2/);
  assert.match(ci, new RegExp(`git cat-file -e "${BASE}\\^\\{commit\\}"`));
  assert.match(ci, new RegExp(`git diff --exit-code ${BASE} -- src/app\\.ts src/index\\.ts src/controllers src/schemas src/services`));
  assert.match(ci, /run: npm run build/);
  assert.match(ci, /run: npm run test:build-artifacts/);
  assert.match(stress, /max-parallel: 1/);
  assert.match(stress, /event-store\.concurrent\.test\.js.*event-store\.crash\.test\.js.*lifecycle\.concurrent\.test\.js.*lifecycle\.crash\.test\.js.*lifecycle\.security\.test\.js/s);
  assert.match(stress, /npm run test:stress/);
  assert.match(stress, /npm run test:lifecycle-stress/);
  assert.match(stress, /retention-days: 14/);
  assert.match(stress, /path: ci-logs\/sqlite-stress-\$\{\{ matrix\.os \}\}\.log/);
  assert.doesNotMatch(stress, /\*\.sqlite\*|\.memory-mcp|pending[-_ ]?(authorization|credential)|\.md\b/i);

  const smoke = source("scripts/smoke-worker.js");
  assert.match(smoke, /\[1,2,3,4,5\]/);
  assert.match(smoke, /schemaVersion !== 5/);
  assert.match(smoke, /manifest\.schemaVersion !== 1/);
  assert.match(smoke, new RegExp(FROZEN_0002));
  assert.match(smoke, /SCHEMA_TOO_NEW/);
  assert.match(smoke, /LIFECYCLE_V2_DISABLED/);
  assert.match(smoke, /zero lifecycle event\/dedup\/workflow effect/);
  assert.match(smoke, /event_count.*dedup_count.*workflow_count/s);
});
