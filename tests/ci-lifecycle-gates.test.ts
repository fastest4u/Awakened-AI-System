import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const PROTECTED_VERSION_ONE_PATHS = [
  "src/app.ts", "src/index.ts", "src/controllers", "src/schemas", "src/services",
] as const;

const EXTENDED_PRODUCTION_ENTRY_PATHS = [
  "src/app.ts", "src/index.ts", "src/cli.ts", "src/cli", "src/controllers", "src/schemas",
  "src/services", "src/workers", "src/orchestrator/runtime",
] as const;

const SEALED_EVALUATOR_BASE = "68e77fa10165c99243ded1e8c1c80d1e0f7da92f";
const APPROVED_SEALED_SOURCE_DIFF = Object.freeze([
  "src/orchestrator/identity/git-workspace.resolver.ts",
  "src/orchestrator/storage/session-end.repository.ts",
]);
const VALID_V2_AGGREGATE = Object.freeze({
  corpusVersion: "retrieval-evaluation-v2",
  queryCount: 504,
  failedQueryCount: 0,
  languageCounts: Object.freeze({ en: 162, th: 171, mixed: 171 }),
  criticalClassCounts: Object.freeze({
    identifiers: 56, "code-artifacts": 56, "session-continuity": 56, "follow-ups": 56,
    "stale-superseded-facts": 56, conflicts: 56, "cross-project-near-duplicates": 56,
    "semantic-paraphrases": 56, "temporal-boundaries": 56,
  }),
  crossProjectContamination: 0,
  recallAt10: 1, mrr: 1, ndcgAt10: 1, citationPrecision: 1, citationRecall: 1,
  staleActiveMemoryRate: 0, exactIdentifierPathRecall: 1, currentSessionCheckpointRecallAt10: 1,
  openFollowUpRecallAt10: 1, nextActionRecallAt10: 1, semanticParaphraseRecallAt10: 1,
  bitemporalAccuracy: 1, conflictRecall: 1, conflictPrecision: 1,
  unsupportedHighImpactVerifiedClaims: 0,
});

function typescriptFiles(directory: string): readonly string[] {
  const files: string[] = [];
  const visit = (relativeDirectory: string): void => {
    for (const entry of readdirSync(new URL(`${relativeDirectory}/`, ROOT), { withFileTypes: true })) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relativePath);
    }
  };
  visit(directory);
  return Object.freeze(files.sort());
}

const PRODUCTION_CONTROLLER_PATHS = typescriptFiles("src/controllers");
const PRODUCTION_ENTRY_SOURCE_PATHS = Object.freeze([
  "src/app.ts",
  "src/index.ts",
  "src/cli.ts",
  ...typescriptFiles("src/cli"),
  ...PRODUCTION_CONTROLLER_PATHS,
  ...typescriptFiles("src/schemas"),
  ...typescriptFiles("src/services"),
  ...typescriptFiles("src/workers"),
  ...typescriptFiles("src/orchestrator/runtime"),
]);
const PROTECTED_VERSION_ONE_SOURCE_PATHS = Object.freeze([
  "src/app.ts",
  "src/index.ts",
  ...PRODUCTION_CONTROLLER_PATHS,
  ...typescriptFiles("src/schemas"),
  ...typescriptFiles("src/services"),
]);

function productionToolNames(): readonly string[] {
  return Object.freeze(PRODUCTION_ENTRY_SOURCE_PATHS.flatMap((path) => (
    [...source(path).matchAll(/registerTool\(\s*["']([^"']+)["']/g)]
      .map((match) => match[1]!)
  )));
}

function subproject3Script(): string {
  const packageJson = JSON.parse(source("package.json")) as { scripts?: Record<string, string> };
  const script = packageJson.scripts?.["test:subproject-3"];
  if (typeof script !== "string") assert.fail("test:subproject-3 must exist");
  return script;
}

const REQUIRED_SUBPROJECT_THREE_FOCUSED_TESTS = Object.freeze([
  "lifecycle-command-store",
  "lifecycle-contracts",
  "cli.orchestrator-admin",
  "project-binding.service",
  "project-store-bootstrap",
  "runtime-capabilities",
  "stored-event-authenticator",
]);

function assertRequiredSubprojectThreeFocusedTests(script: string): void {
  for (const target of REQUIRED_SUBPROJECT_THREE_FOCUSED_TESTS) {
    assert.match(
      script,
      new RegExp(`dist-test/tests/${target.replace(/[.]/g, "\\.")}\\.test\\.js`),
      `Subproject 3 focused gate must include ${target}.test.js`,
    );
  }
}

interface ProductionIsolationSource {
  readonly path: string;
  readonly contents: string;
}

function assertProductionIsolation(sources: readonly ProductionIsolationSource[]): void {
  for (const candidate of sources) {
    if (PRODUCTION_ENTRY_SOURCE_PATHS.includes(candidate.path)) {
      assert.doesNotMatch(
        candidate.contents,
        /(?:from\s+|import\s*\(|require\s*\()["'][^"']*(?:\/(?:projections|retrieval)\/(?:v2-[^"']*|evaluation)|\/runtime\/(?:projection-runtime|v2-[^"']*))[^"]*["']|registerTool\(\s*["']memory_(?:retrieval|projection)/,
        `V2_PRODUCTION_ISOLATION: ${candidate.path} must not wire Version 2 production behavior`,
      );
    }
    if (candidate.path === "tests/retrieval-evaluation.test.ts") {
      assert.doesNotMatch(
        candidate.contents,
        /\b(?:answerReplay|answersByQuery|expectedAnswers)\b/,
        "V2_PRODUCTION_ISOLATION: evaluator fixtures must not derive retrieval answers",
      );
      assert.match(
        candidate.contents,
        /assertNoAnswerDerivedFields\(query, `queries\[\$\{index\}\]`\);/,
        "V2_PRODUCTION_ISOLATION: evaluator fixtures must reject answer-derived fields",
      );
    }
  }
}

function sourceBetween(
  evaluator: string,
  startMarker: string,
  endMarker: string,
  label: string,
): string {
  const start = evaluator.indexOf(startMarker);
  const end = evaluator.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${label} must have stable bounds`);
  return evaluator.slice(start, end);
}

function realV2HarnessTestBody(evaluator: string): string {
  return sourceBetween(
    evaluator,
    '  it("hydrates authenticated sources, reproduces V1, and seals V2 through the detached lease bridge", async () => {',
    '\n  });\n});\n\ndescribe("sealed V2 threshold predicate", () => {',
    "real V2 harness test",
  );
}

function realV2BridgeImplementation(evaluator: string): string {
  return sourceBetween(
    evaluator,
    "async function createV2EvaluationBridge(",
    "\nfunction directSourceRequest(",
    "real V2 bridge implementation",
  );
}

function sealedEvaluationRequestFactory(evaluator: string): string {
  return sourceBetween(
    evaluator,
    "function requestFor(",
    "\n/** Sealed V2 evaluation never permits vector retrieval into its measured result. */",
    "sealed evaluation request factory",
  );
}

function assertSealedEvaluationRequestFactory(requestFor: string): void {
  assert.match(
    requestFor,
    /const vector = Object\.freeze\(\{ enabled: false \} as const\);/,
    "sealed request factory must disable vector retrieval",
  );
  assert.match(
    requestFor,
    /assertSealedEvaluationVectorDisabled\(vector\);/,
    "sealed request factory must enforce disabled vectors",
  );
}

function assertRealBridgeDataflow(bridge: string): void {
  assert.match(bridge, /service:\s*new InternalRetrievalService\(\{ projections, candidates \}\),/, "real bridge service must use projections and candidates");
  assert.match(bridge, /const original = originalLeases\.get\(lease\);[\s\S]*?return adapter\.collectEligible\(original, request\);/, "real bridge candidates must delegate the preserved lease");
}

function assertNoV2EntryWiring(entry: string): void {
  assert.doesNotMatch(entry, /(?:from\s+|import\s*\(|require\s*\()["'][^"']*(?:\/(?:projections|retrieval)\/(?:v2-[^"']*|evaluation)|\/runtime\/(?:projection-runtime|v2-[^"']*))[^"']*["']/, "V2 entry wiring is forbidden");
}

function runRetrievalEvaluation(...targets: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["scripts/run-retrieval-evaluation.js", ...targets],
    { cwd: fileURLToPath(ROOT), encoding: "utf8" },
  );
}

function runRetrievalEvaluationWithChildOutput(output: string) {
  const directory = mkdtempSync(join(tmpdir(), "retrieval-evaluation-runner-"));
  const loader = join(directory, "mock-child-process.mjs");
  const mockedChildProcess = [
    'import { EventEmitter } from "node:events";',
    "export function spawn() {",
    "  const child = new EventEmitter();",
    "  child.stdout = new EventEmitter();",
    "  child.stderr = new EventEmitter();",
    `  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(${JSON.stringify(output)})); child.emit("close", 0, null); });`,
    "  return child;",
    "}",
  ].join("\n");
  writeFileSync(loader, [
    `const childProcess = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(mockedChildProcess)}`)};`,
    "export async function resolve(specifier, context, nextResolve) {",
    '  if (specifier === "node:child_process") return { url: childProcess, shortCircuit: true };',
    "  return nextResolve(specifier, context);",
    "}",
  ].join("\n"));
  try {
    return spawnSync(
      process.execPath,
      ["--experimental-loader", pathToFileURL(loader).href, "scripts/run-retrieval-evaluation.js"],
      { cwd: fileURLToPath(ROOT), encoding: "utf8" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const PLAIN_WORKFLOW_KEY = "[A-Za-z][A-Za-z0-9_-]*";
const PLAIN_MAPPING_LINE = new RegExp(`^ *${PLAIN_WORKFLOW_KEY}:(?: .*)?$`);
const PLAIN_LIST_MAPPING_LINE = new RegExp(`^ *- ${PLAIN_WORKFLOW_KEY}:(?: .*)?$`);
const PLAIN_SCALAR_LIST_ITEM = /^ *- (?![?&*!|>{[\],])\S(?:.*\S)?$/;

function isPermittedRunBlockHeader(line: string): boolean {
  return /^ *run: \|(?:\s+#.*)?$/.test(line);
}

function structuralWorkflowLines(yaml: string): readonly string[] {
  const structuralLines: string[] = [];
  let blockScalarIndent: number | null = null;
  for (const line of yaml.split("\n")) {
    const indentation = /^[ ]*/.exec(line)?.[0].length ?? 0;
    if (blockScalarIndent !== null) {
      if (line.trim().length === 0 || indentation > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    structuralLines.push(line);
    if (isPermittedRunBlockHeader(line)) {
      blockScalarIndent = indentation;
    }
  }
  return structuralLines;
}

function unquotedStructuralLine(line: string): string {
  return line
    .replace(/\$\{\{[\s\S]*?\}\}/g, () => "EXPRESSION")
    .replace(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g, () => "SCALAR")
    .replace(/\s+#.*$/, "");
}

function assertCanonicalWorkflowGrammar(yaml: string, label: string): void {
  for (const line of structuralWorkflowLines(yaml)) {
    assert.doesNotMatch(line, /\t/, `${label} contains unsupported YAML tab`);
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    assert.doesNotMatch(line, /^\s*%/, `${label} contains unsupported YAML directive`);
    assert.doesNotMatch(line, /^\s*(?:---|\.\.\.)(?:\s+#.*)?$/, `${label} contains unsupported YAML document marker`);
    assert.doesNotMatch(line, /^\s*(?:-\s*)?\?/, `${label} contains explicit YAML key`);
    assert.doesNotMatch(line, /^\s*(?:-\s*)?:/, `${label} contains explicit YAML value`);
    assert.doesNotMatch(
      line,
      /^\s*(?:-\s*)?(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*')\s*:/,
      `${label} contains quoted YAML mapping key`,
    );
    if (isPermittedRunBlockHeader(line)) continue;
    const structural = unquotedStructuralLine(line);
    assert.doesNotMatch(structural, /[{}\[\]]/, `${label} contains unsupported flow-style YAML`);
    assert.doesNotMatch(structural, /(?:^|\s)<<\s*:/, `${label} contains unsupported YAML merge key`);
    assert.doesNotMatch(structural, /[&*]/, `${label} contains unsupported YAML anchor or alias`);
    assert.doesNotMatch(structural, /!/, `${label} contains unsupported YAML tag`);
    assert.doesNotMatch(
      structural,
      /^\s*(?:-\s*)?[A-Za-z][A-Za-z0-9_-]*:\s*[>|]/,
      `${label} contains unsupported YAML block scalar`,
    );
    assert.ok(
      PLAIN_MAPPING_LINE.test(structural)
        || PLAIN_LIST_MAPPING_LINE.test(structural)
        || PLAIN_SCALAR_LIST_ITEM.test(structural),
      `${label} contains non-canonical YAML structural line`,
    );
  }
}

function workflowJobs(yaml: string): ReadonlyMap<string, string> {
  const jobs = new Map<string, string>();
  const matches = [...yaml.matchAll(/^  ([a-z][a-z0-9_-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:|(?![\s\S]))/gm)];
  for (const match of matches) jobs.set(match[1]!, match[0]!);
  return jobs;
}

interface WorkflowStep {
  readonly name: string | null;
  readonly body: string;
  readonly ownerJob: string;
}

function normalizeYamlScalar(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value) as string;
  else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
  else value = value.replace(/\s+#.*$/, "");
  const expression = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(value);
  return expression?.[1]?.trim() ?? value;
}

function yamlScalar(block: string, key: string): string | null {
  const match = new RegExp(`(?:^|\\n)\\s*${key}:\\s*(.+)$`, "m").exec(block);
  return match === null ? null : normalizeYamlScalar(match[1]!);
}

function workflowSteps(job: string, ownerJob = "unknown"): readonly WorkflowStep[] {
  return [...job.matchAll(/^      -(?<first>[^\n]*)(?:\n|$)(?<rest>[\s\S]*?)(?=^      -|^  [a-z][a-z0-9_-]*:|(?![\s\S]))/gm)]
    .map((match) => {
      const first = match.groups?.first ?? "";
      const name = /^ name: (.+)$/.exec(first)?.[1];
      return {
        name: name === undefined ? null : normalizeYamlScalar(name),
        body: `${first}\n${match.groups?.rest ?? ""}`,
        ownerJob,
      };
    });
}

function assertNoJobIf(job: string, label: string): void {
  assert.doesNotMatch(job, /^    if:\s*/m, `${label} must not declare if`);
}

function requiredStep(job: string, name: string): WorkflowStep {
  const step = workflowSteps(job).find((candidate) => candidate.name === name);
  assert.ok(step, `missing executable ${name} step`);
  assert.equal(yamlScalar(step.body, "if"), null, `${name} must not declare if`);
  return step;
}

function workflowActions(job: string, ownerJob: string): readonly {
  readonly step: WorkflowStep;
  readonly uses: string;
  readonly withPath: string | null;
}[] {
  return workflowSteps(job, ownerJob).flatMap((step) => [...step.body.matchAll(/(?:^|\n)\s*uses:\s*(.+)$/gm)]
    .map((match) => ({
      step,
      uses: normalizeYamlScalar(match[1]!),
      withPath: yamlScalar(step.body, "path"),
    })));
}

function assertWorkflowReleaseContract(ci: string, stress: string): void {
  assertCanonicalWorkflowGrammar(ci, "CI workflow");
  assertCanonicalWorkflowGrammar(stress, "stress workflow");
  const ciJobs = workflowJobs(ci);
  const stressJobs = workflowJobs(stress);
  const releaseGates = ciJobs.get("release-gates");
  const minimumRuntime = ciJobs.get("minimum-runtime-rejection");
  const stressJob = stressJobs.get("stress");
  assert.ok(releaseGates, "CI must have a release-gates job");
  assert.ok(minimumRuntime, "CI must retain the minimum-runtime rejection job");
  assert.ok(stressJob, "stress workflow must have a stress job");
  assertNoJobIf(releaseGates!, "release-gates job");
  assertNoJobIf(minimumRuntime!, "minimum-runtime-rejection job");
  assertNoJobIf(stressJob!, "stress job");
  const checkouts = [...ciJobs.entries(), ...stressJobs.entries()]
    .flatMap(([ownerJob, job]) => workflowSteps(job, ownerJob))
    .filter((step) => step.name === "Check out repository");
  assert.equal(checkouts.length, 3, "every checkout site must be explicit");
  for (const checkout of checkouts) {
    assert.equal(yamlScalar(checkout.body, "if"), null, "checkout must not declare if");
    assert.equal(yamlScalar(checkout.body, "uses"), "actions/checkout@v6");
    assert.equal(yamlScalar(checkout.body, "fetch-depth"), "0");
  }
  assert.equal(yamlScalar(requiredStep(releaseGates!, "Run lifecycle release gates").body, "run"), "npm run test:subproject-2");
  assert.equal(yamlScalar(requiredStep(releaseGates!, "Require immutable lifecycle base commit").body, "run"), `git cat-file -e "${BASE}^{commit}"`);
  assert.equal(yamlScalar(requiredStep(releaseGates!, "Protect Version 1 production routing").body, "run"), `git diff --exit-code ${BASE} -- src/app.ts src/index.ts src/controllers src/schemas src/services`);
  assert.equal(yamlScalar(requiredStep(releaseGates!, "Build").body, "run"), "npm run build");
  assert.equal(yamlScalar(requiredStep(releaseGates!, "Test build artifacts").body, "run"), "npm run test:build-artifacts");
  assert.equal(workflowSteps(minimumRuntime!).filter((step) => step.name === "Check out repository").length, 1);
  assert.match(stressJob!, /max-parallel: 1/);
  assert.match(requiredStep(stressJob!, "Run default and lifecycle concurrent, crash, and security tests").body, /event-store\.concurrent\.test\.js.*event-store\.crash\.test\.js.*lifecycle\.concurrent\.test\.js.*lifecycle\.crash\.test\.js.*lifecycle\.security\.test\.js/s);
  assert.match(requiredStep(stressJob!, "Run release stress test").body, /npm run test:stress/);
  assert.match(requiredStep(stressJob!, "Run lifecycle stress test").body, /npm run test:lifecycle-stress/);
  const actions = [...ciJobs.entries(), ...stressJobs.entries()]
    .flatMap(([ownerJob, job]) => workflowActions(job, ownerJob));
  for (const action of actions) {
    assert.ok(action.uses.length > 0, "workflow action must have a non-empty uses scalar");
    if (action.withPath !== null) {
      assert.doesNotMatch(action.withPath, /\*\.sqlite\*|\.memory-mcp|pending[-_ ]?(authorization|credential)|\.md\b/i);
    }
  }
  const uploads = actions.filter((action) => action.uses.startsWith("actions/upload-artifact@"));
  assert.equal(uploads.length, 1, "exactly one upload-artifact v7 step is allowed");
  const [upload] = uploads;
  assert.equal(upload?.step.ownerJob, "stress", "upload artifact must belong to stress");
  assert.equal(upload?.uses, "actions/upload-artifact@v7");
  assert.equal(yamlScalar(upload?.step.body ?? "", "if"), "always()", "upload must use exact always() reachability");
  assert.equal(upload?.withPath, "ci-logs/sqlite-stress-${{ matrix.os }}.log");
  assert.match(upload?.step.body ?? "", /retention-days: 14/);
  assert.doesNotMatch(upload?.withPath ?? "", /\*\.sqlite\*|\.memory-mcp|pending[-_ ]?(authorization|credential)|\.md\b/i);
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
  assertWorkflowReleaseContract(ci, stress);

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
  assert.match(smoke, /execFileSync\("git", \["show",/);
  assert.match(smoke, /HISTORICAL_SCHEMA_TWO_READER_PROVENANCE\.sourceSha256/);
  assert.match(smoke, /workerData\.registry/);
  assert.match(smoke, /historicalSchemaTwoRegistry/);
  assert.match(smoke, /verifyRecordedMigrationPrefix/);
  assert.match(smoke, /setTimeout\(/);
  assert.match(smoke, /reader\.off\("message"/);
  assert.match(smoke, /SCHEMA_TOO_NEW/);
  assert.match(smoke, /LIFECYCLE_V2_DISABLED/);
  assert.match(smoke, /zero lifecycle event\/dedup\/workflow effect/);
  assert.match(smoke, /event_count.*dedup_count.*workflow_count/s);
});

test("workflow parser closes conditional, scalar, and upload-owner bypasses", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  assert.throws(
    () => assertWorkflowReleaseContract(
      ci.replace("  release-gates:\n", "  release-gates:\n    if: ${{ !true }}\n"),
      stress,
    ),
    /release-gates job must not declare if/,
  );

  const quotedUnnamedUpload = stress.replace(
    "      - name: Upload stress logs\n        if: ${{ always() }}\n        uses: actions/upload-artifact@v7",
    "      - uses: \"actions/upload-artifact@v7\"\n        if: '${{ always() }}'",
  );
  assert.doesNotThrow(() => assertWorkflowReleaseContract(ci, quotedUnnamedUpload));

  const uploadBlock = [
    "      - uses: actions/upload-artifact@v7",
    "        if: ${{ always() }}",
    "        with:",
    "          path: ci-logs/sqlite-stress-${{ matrix.os }}.log",
    "          retention-days: 14",
  ].join("\n");
  assert.throws(
    () => assertWorkflowReleaseContract(
      ci.replace("\n  minimum-runtime-rejection:", `\n${uploadBlock}\n\n  minimum-runtime-rejection:`),
      stress.replace(/\n      - name: Upload stress logs[\s\S]*$/m, "\n"),
    ),
    /upload artifact must belong to stress/,
  );

  const extraUploader = stress.replace(
    "      - name: Upload stress logs",
    `${uploadBlock.replace("actions/upload-artifact@v7", "actions/upload-artifact@v6")}\n\n      - name: Upload stress logs`,
  );
  assert.throws(() => assertWorkflowReleaseContract(ci, extraUploader), /exactly one upload-artifact/);
});

test("workflow parser rejects quoted conditional keys before reading jobs", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  assert.throws(
    () => assertWorkflowReleaseContract(
      ci.replace("  release-gates:\n", "  release-gates:\n    \"if\": ${{ !true }}\n"),
      stress,
    ),
    /quoted YAML mapping key/,
  );
});

test("workflow parser rejects quoted action keys before enumerating uploads", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  const hiddenQuotedUpload = stress.replace(
    "      - name: Upload stress logs",
    [
      "      - 'uses': 'actions/upload-artifact@v7'",
      "        if: '${{ always() }}'",
      "",
      "      - name: Upload stress logs",
    ].join("\n"),
  );
  assert.throws(() => assertWorkflowReleaseContract(ci, hiddenQuotedUpload), /quoted YAML mapping key/);
});

test("workflow parser rejects flow-style actions before enumerating uploads", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  const hiddenFlowUpload = stress.replace(
    "      - name: Upload stress logs",
    [
      "      - { uses: actions/upload-artifact@v7, if: ${{ always() }}, with: { path: ci-logs/sqlite-stress-${{ matrix.os }}.log } }",
      "",
      "      - name: Upload stress logs",
    ].join("\n"),
  );
  assert.throws(() => assertWorkflowReleaseContract(ci, hiddenFlowUpload), /flow-style YAML/);
});

test("workflow parser rejects YAML anchors, aliases, merges, and tags in structural grammar", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  const mutations = [
    ci.replace("    name: Node", "    name: &ci_name Node"),
    ci.replace("    name: Node", "    name: *ci_name"),
    ci.replace("    name: Node", "    <<: *ci_defaults\n    name: Node"),
    ci.replace("    name: Node", "    name: !ci_tag Node"),
  ];
  for (const mutatedCi of mutations) {
    assert.throws(() => assertWorkflowReleaseContract(mutatedCi, stress), /unsupported YAML (?:anchor|alias|merge key|tag)/);
  }
});

test("workflow parser rejects explicit YAML keys and values before reading jobs or actions", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  const explicitCondition = ci.replace(
    "  release-gates:\n",
    ["  release-gates:", "    ? if", "    : ${{ !true }}", ""].join("\n"),
  );
  assert.throws(() => assertWorkflowReleaseContract(explicitCondition, stress), /explicit YAML key/);

  const hiddenExplicitUpload = stress.replace(
    "      - name: Upload stress logs",
    [
      "      ? \"uses\"",
      "      : actions/upload-artifact@v7",
      "",
      "      - name: Upload stress logs",
    ].join("\n"),
  );
  assert.throws(() => assertWorkflowReleaseContract(ci, hiddenExplicitUpload), /explicit YAML key/);
});

test("workflow parser rejects directives, document markers, tabs, and exotic block scalars", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  const mutations = [
    `%YAML 1.2\n${ci}`,
    `---\n${ci}`,
    ci.replace("    name: Node", "\tname: Node"),
    ci.replace("    name: Node", "    name: >"),
  ];
  for (const mutatedCi of mutations) {
    assert.throws(() => assertWorkflowReleaseContract(mutatedCi, stress), /(?:directive|document marker|tab|block scalar)/);
  }
});

test("Subproject 3 evaluation runner rejects malformed aggregate-looking TAP output", () => {
  const malformedThenValid = [
    '# {"corpusVersion":"retrieval-evaluation-v2"',
    JSON.stringify(VALID_V2_AGGREGATE),
    "",
  ].join("\n");
  const result = runRetrievalEvaluationWithChildOutput(malformedThenValid);
  assert.notEqual(result.status, 0, "a malformed aggregate-looking line must fail closed");
  assert.match(`${result.stdout}\n${result.stderr}`, /RETRIEVAL_EVALUATION_REPORT_INVALID/);
});

test("Subproject 3 evaluation runner rejects aggregate shape and leakage", () => {
  for (const invalid of [
    { ...VALID_V2_AGGREGATE, queryText: "leak" },
    { ...VALID_V2_AGGREGATE, languageCounts: { en: 162, th: 171 } },
    { ...VALID_V2_AGGREGATE, recallAt10: 1.1 },
    { ...VALID_V2_AGGREGATE, failedQueryCount: 505 },
  ]) {
    const result = runRetrievalEvaluationWithChildOutput(`${JSON.stringify(invalid)}\n`);
    assert.notEqual(result.status, 0, "invalid aggregate shape must fail closed");
    assert.match(`${result.stdout}\n${result.stderr}`, /RETRIEVAL_EVALUATION_REPORT_INVALID/);
  }
});

test("Subproject 3 evaluation guard binds the sealed production request factory", () => {
  const requestFor = sealedEvaluationRequestFactory(source("src/orchestrator/retrieval/evaluation.ts"));
  assertSealedEvaluationRequestFactory(requestFor);
  assert.throws(
    () => assertSealedEvaluationRequestFactory(requestFor.replace("enabled: false", "enabled: true")),
    /sealed request factory must disable vector retrieval/,
  );
  assert.throws(
    () => assertSealedEvaluationRequestFactory(requestFor.replace("assertSealedEvaluationVectorDisabled(vector);", "")),
    /sealed request factory must enforce disabled vectors/,
  );
});

test("Subproject 3 evaluation guard proves real bridge dataflow", () => {
  const evaluator = source("tests/retrieval-evaluation.test.ts");
  const bridge = realV2BridgeImplementation(evaluator);
  assert.throws(
    () => assertRealBridgeDataflow(bridge.replace("service: new InternalRetrievalService({ projections, candidates }),", "service: replacementService,")),
    /real bridge service/,
  );
  assert.throws(
    () => assertRealBridgeDataflow(bridge.replace("return adapter.collectEligible(original, request);", "return answerReplay.get(request.query);")),
    /preserved lease/,
  );
});

test("Subproject 3 evaluation guard rejects dynamic V2 entry wiring", () => {
  for (const dynamic of [
    'async function load() { return import("../orchestrator/retrieval/evaluation.js"); }',
    'const load = () => require("../orchestrator/runtime/projection-runtime.js");',
  ]) assert.throws(() => assertNoV2EntryWiring(dynamic), /V2 entry wiring/);
});

test("Subproject 3 evaluation guard covers every production entry surface", () => {
  for (const path of EXTENDED_PRODUCTION_ENTRY_PATHS) {
    assert.ok(
      PRODUCTION_ENTRY_SOURCE_PATHS.includes(path)
        || PRODUCTION_ENTRY_SOURCE_PATHS.some((candidate) => candidate.startsWith(`${path}/`)),
      `${path} must be scanned for V2 routing`,
    );
  }
});

test("Subproject 3 focused gate includes lifecycle isolation and rejects answer-derived evaluation", () => {
  const script = subproject3Script();
  assertRequiredSubprojectThreeFocusedTests(script);
  for (const target of REQUIRED_SUBPROJECT_THREE_FOCUSED_TESTS) {
    assert.throws(
      () => assertRequiredSubprojectThreeFocusedTests(script.replace(`${target}.test.js`, "")),
      new RegExp(target.replace(/[.]/g, "\\.")),
    );
  }

  assert.throws(
    () => assertProductionIsolation([{
      path: "src/index.ts",
      contents: `${source("src/index.ts")}\nserver.registerTool("memory_retrievalV2", {});`,
    }]),
    /V2_PRODUCTION_ISOLATION/,
  );
  assert.throws(
    () => assertProductionIsolation([{
      path: "tests/retrieval-evaluation.test.ts",
      contents: `${source("tests/retrieval-evaluation.test.ts")}\nconst answerReplay = new Map();`,
    }]),
    /V2_PRODUCTION_ISOLATION/,
  );
  assert.doesNotThrow(() => assertProductionIsolation([
    ...PRODUCTION_ENTRY_SOURCE_PATHS.map((path) => ({ path, contents: source(path) })),
    { path: "tests/retrieval-evaluation.test.ts", contents: source("tests/retrieval-evaluation.test.ts") },
  ]));
});

test("Subproject 3 evaluation and projection runtime remain internal-only", () => {
  const toolNames = productionToolNames();
  assert.equal(toolNames.includes("memory_retrievalExplain"), false);
  assert.equal(
    toolNames.some((name) => /^memory_(?:retrieval|projection)/.test(name)),
    false,
    "no Version 2 retrieval or projection tool may be registered",
  );

  const script = subproject3Script();
  assert.match(script, /npm run test:build/);
  assert.match(script, /projection-runtime\.test\.js/);
  assert.match(script, /retrieval-evaluation\.test\.js/);
  assert.match(script, /ci-lifecycle-gates\.test\.js/);
  assert.ok(
    script.indexOf("projection-runtime.test.js") < script.indexOf("retrieval-evaluation.test.js"),
    "the runtime matrix must finish before corpus evaluation",
  );
  assert.ok(
    script.indexOf("retrieval-evaluation.test.js") < script.indexOf("ci-lifecycle-gates.test.js"),
    "corpus evaluation must finish before the isolation gate",
  );

  const protectedDiff = execFileSync(
    "git",
    ["diff", "--name-only", BASE, "--", ...PROTECTED_VERSION_ONE_PATHS],
    { cwd: fileURLToPath(ROOT), encoding: "utf8" },
  ).trim();
  assert.equal(protectedDiff, "", "Version 1 production paths must remain byte-unchanged");
  const sealedSourceDiff = execFileSync(
    "git",
    ["diff", "--name-only", SEALED_EVALUATOR_BASE, "--", "src"],
    { cwd: fileURLToPath(ROOT), encoding: "utf8" },
  ).trim();
  assert.deepEqual(
    sealedSourceDiff === "" ? [] : sealedSourceDiff.split(/\r?\n/),
    APPROVED_SEALED_SOURCE_DIFF,
    "only the approved Task 8 Git runner remediation may change production source after the sealed evaluator baseline",
  );
  for (const path of PRODUCTION_ENTRY_SOURCE_PATHS) {
    assertNoV2EntryWiring(source(path));
    assert.doesNotMatch(
      source(path),
      /\bmemory_(?:retrieval|projection)\w*/,
      `${path} must not expose a Version 2 retrieval or projection tool`,
    );
  }

  const runtime = source("src/orchestrator/runtime/projection-runtime.ts");
  assert.doesNotMatch(runtime, /(?:\bV2\b|\/v2-[\w-]*|\bv2-[\w-]*)/i, "V2 must remain evaluator-only");

  const evaluator = source("tests/retrieval-evaluation.test.ts");
  const measuredEvaluator = source("src/orchestrator/retrieval/evaluation.ts");
  const realV2Test = realV2HarnessTestBody(evaluator);
  const realV2Bridge = realV2BridgeImplementation(evaluator);
  const sealedRequest = sealedEvaluationRequestFactory(measuredEvaluator);
  assertSealedEvaluationRequestFactory(sealedRequest);
  assertRealBridgeDataflow(realV2Bridge);
  assert.match(
    realV2Test,
    /const bridge = await createV2EvaluationBridge\(\s*harness\.primaryV2Coordinator,\s*harness\.primary\.binding,\s*\);[\s\S]*?const v2Report = await evaluateSealedRetrieval\(\s*harness\.corpus,\s*bridge\.service\s*\);/,
    "the named V2 harness test must bridge its primary coordinator before sealed retrieval",
  );
  assert.match(
    realV2Bridge,
    /const originalLease = await coordinator\.leasePublishedForEvaluation\(binding\);/,
    "the bounded V2 bridge must acquire its coordinator evaluation lease",
  );
  assert.match(
    realV2Bridge,
    /const original = originalLeases\.get\(lease\);[\s\S]*?return adapter\.collectEligible\(original, request\);/,
    "the bounded V2 bridge must adapt eligible candidates from the preserved lease",
  );
  const reportAssertion = evaluator.indexOf('assert.equal(v2Report.corpusVersion, "retrieval-evaluation-v2")');
  const reportWrite = evaluator.indexOf("process.stdout.write");
  assert.ok(reportAssertion >= 0 && reportWrite > reportAssertion, "V2 report version must be checked before output");
  assert.match(
    evaluator,
    /process\.env\.RETRIEVAL_EVALUATION_REAL_REPORT === "sealed-v2"/,
    "only the sealed runner may enable the aggregate V2 report",
  );

  const invalid = runRetrievalEvaluation(
    "dist-test/tests/retrieval-evaluation.test.js",
    "dist-test/tests/ci-lifecycle-gates.test.js",
  );
  assert.notEqual(invalid.status, 0, "the runner must reject a second test target");
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /RETRIEVAL_EVALUATION_TARGET_INVALID/);

  const normal = runRetrievalEvaluation();
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /^\{[^\n]*"corpusVersion":"retrieval-evaluation-v2"[^\n]*\}\r?\n$/);
  const aggregate = JSON.parse(normal.stdout) as Record<string, unknown>;
  assert.equal(aggregate.corpusVersion, "retrieval-evaluation-v2");
  assert.doesNotMatch(
    normal.stdout,
    /queryText|expectedCitations|relevanceGrades|projectId|source-events|judgments\.json|v1-shadow-baseline|[A-Za-z]:\\|\/tmp\//,
    "runner output must contain only the aggregate V2 report",
  );
});
