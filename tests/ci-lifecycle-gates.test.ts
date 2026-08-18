import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n?/g, "\n");
}

const BASE = "0e375d4643d4b630f36f874a3bb192e96739ac46";
const FROZEN_0002 = "68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06";
const FROZEN_0002_SQL = "85666a0bdee4455068f03a81e9d3720df172d15fce6d8e6f0cb3f5f7d0a81293";
const SCHEMA_TWO_PROVENANCE = "866bb0d22ac4225b8a06db9e528a9eaed847c02c";
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

function workflowJobs(yaml: string): ReadonlyMap<string, string> {
  const jobs = new Map<string, string>();
  const matches = [...yaml.matchAll(/^  ([a-z][a-z0-9_-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:|(?![\s\S]))/gm)];
  for (const match of matches) jobs.set(match[1]!, match[0]!);
  return jobs;
}

function workflowSteps(job: string): readonly { readonly name: string; readonly body: string }[] {
  return [...job.matchAll(/^      - name: (.+)\n([\s\S]*?)(?=^      - name:|^  [a-z][a-z0-9_-]*:|(?![\s\S]))/gm)]
    .map((match) => ({ name: match[1]!, body: match[2]! }));
}

function requiredStep(job: string, name: string): string {
  const step = workflowSteps(job).find((candidate) => candidate.name === name);
  assert.ok(step, `missing executable ${name} step`);
  return step.body;
}

function uploadSteps(job: string): readonly { readonly name: string; readonly body: string }[] {
  return workflowSteps(job).filter((step) => /\n        uses: actions\/upload-artifact@/.test(step.body));
}

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
  const ciJobs = workflowJobs(ci);
  const stressJobs = workflowJobs(stress);
  const releaseGates = ciJobs.get("release-gates");
  const minimumRuntime = ciJobs.get("minimum-runtime-rejection");
  const stressJob = stressJobs.get("stress");
  assert.ok(releaseGates, "CI must have a release-gates job");
  assert.ok(minimumRuntime, "CI must retain the minimum-runtime rejection job");
  assert.ok(stressJob, "stress workflow must have a stress job");
  const checkouts = [...ciJobs.values(), ...stressJobs.values()]
    .flatMap(workflowSteps)
    .filter((step) => step.name === "Check out repository");
  assert.equal(checkouts.length, 3, "every checkout site must be explicit");
  for (const checkout of checkouts) {
    assert.match(checkout.body, /uses: actions\/checkout@v6\n        with:\n          fetch-depth: 0/);
  }
  assert.match(requiredStep(releaseGates!, "Run lifecycle release gates"), /run: npm run test:subproject-2/);
  assert.match(requiredStep(releaseGates!, "Require immutable lifecycle base commit"), new RegExp(`run: git cat-file -e "${BASE}\\^\\{commit\\}"`));
  assert.match(requiredStep(releaseGates!, "Protect Version 1 production routing"), new RegExp(`run: git diff --exit-code ${BASE} -- src/app\\.ts src/index\\.ts src/controllers src/schemas src/services`));
  assert.match(requiredStep(releaseGates!, "Build"), /run: npm run build/);
  assert.match(requiredStep(releaseGates!, "Test build artifacts"), /run: npm run test:build-artifacts/);
  assert.equal(workflowSteps(minimumRuntime!).filter((step) => step.name === "Check out repository").length, 1);
  assert.match(stressJob!, /max-parallel: 1/);
  assert.match(requiredStep(stressJob!, "Run default and lifecycle concurrent, crash, and security tests"), /event-store\.concurrent\.test\.js.*event-store\.crash\.test\.js.*lifecycle\.concurrent\.test\.js.*lifecycle\.crash\.test\.js.*lifecycle\.security\.test\.js/s);
  assert.match(requiredStep(stressJob!, "Run release stress test"), /npm run test:stress/);
  assert.match(requiredStep(stressJob!, "Run lifecycle stress test"), /npm run test:lifecycle-stress/);
  const uploads = [...ciJobs.values(), ...stressJobs.values()].flatMap(uploadSteps);
  assert.equal(uploads.length, 1, "only the stress job may upload an artifact");
  const [upload] = uploads;
  assert.equal(upload?.name, "Upload stress logs");
  assert.match(upload?.body ?? "", /path: ci-logs\/sqlite-stress-\$\{\{ matrix\.os \}\}\.log/);
  assert.match(upload?.body ?? "", /retention-days: 14/);
  assert.doesNotMatch(upload?.body ?? "", /\*\.sqlite\*|\.memory-mcp|pending[-_ ]?(authorization|credential)|\.md\b/i);

  const smoke = source("scripts/smoke-worker.js");
  assert.match(smoke, /\[1,2,3,4,5\]/);
  assert.match(smoke, /schemaVersion !== 5/);
  assert.match(smoke, /manifest\.schemaVersion !== 1/);
  assert.match(smoke, new RegExp(FROZEN_0002));
  assert.match(smoke, new RegExp(FROZEN_0002_SQL));
  assert.match(
    smoke,
    /if\s*\(\s*frozenMigration0002 !== FROZEN_0002_SHA256\s*\|\|\s*migration0002 !== FROZEN_0002_SQL_SHA256\s*\)/s,
    "both frozen migration values must be in one executable gate",
  );
  assert.match(smoke, new RegExp(SCHEMA_TWO_PROVENANCE));
  assert.match(smoke, /verifyRecordedMigrationPrefix/);
  assert.match(smoke, /setTimeout\(/);
  assert.match(smoke, /reader\.off\("message"/);
  assert.match(smoke, /SCHEMA_TOO_NEW/);
  assert.match(smoke, /LIFECYCLE_V2_DISABLED/);
  assert.match(smoke, /zero lifecycle event\/dedup\/workflow effect/);
  assert.match(smoke, /event_count.*dedup_count.*workflow_count/s);
});
