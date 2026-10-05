import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertCiWorkflowSet, requiredStep, type CiWorkflowSet } from "./support/ci-workflow-contract.js";

test("CI roles require the four actual saved owners", () => {
  const root = new URL("../../", import.meta.url);
  const workflows = {
    pr: readFileSync(new URL(".github/workflows/ci.yml", root), "utf8").replace(/\r\n?/g, "\n"),
    release: readFileSync(new URL(".github/workflows/v2-release-qualification.yml", root), "utf8").replace(/\r\n?/g, "\n"),
    legacy: readFileSync(new URL(".github/workflows/v2-legacy-regression.yml", root), "utf8").replace(/\r\n?/g, "\n"),
    stress: readFileSync(new URL(".github/workflows/sqlite-stress.yml", root), "utf8").replace(/\r\n?/g, "\n"),
  };
  assertCiWorkflowSet(workflows);
  for (const [name, command, id] of [
    ["Check installation policy", "node scripts/check-build-installation.js before", "installation_policy"],
    ["Install dependencies", "npm ci --ignore-scripts --include=dev --include=optional", "installation"],
    ["Check installation capability", "node scripts/check-build-installation.js after", "installation_capability"],
    ["Run tests", "npm test", "tests"],
    ["Run lifecycle release gates", "npm run test:subproject-2", "lifecycle"],
    ["Run V2 rollout control-plane gate", "npm run test:rollout-control-plane", "rollout"],
    ["Run V2 fresh-start foundation gate", "npm run test:v2-fresh-start-foundation", "foundation"],
    ["Test build artifacts", "npm run test:build-artifacts", "artifacts"],
  ]) {
    const block = `      - name: ${name}\n        id: ${id}\n        run: ${command}`;
    assert.ok(workflows.release.includes(block), name);
    for (const changed of [
      workflows.release.replace(block, ""),
      workflows.release.replace(block, `${block}\n${block}`),
      workflows.release.replace(block, block.replace("        id:", "        if: false\n        id:")),
      workflows.release.replace(block, block.replace("        id:", "        continue-on-error: true\n        id:")),
      workflows.release.replace(block, block.replace(`run: ${command}`, "run: echo passed")),
    ]) assert.throws(() => assertCiWorkflowSet({ ...workflows, release: changed }), name);
  }
});

// Independent fixture literals: share fragments here, never import the policy oracle.
const fixtureContextProgram = [
  "const fail = code => { throw new Error(code); };",
  "const git = (...args) => {",
  "  try { return execFileSync(\"git\", args, { encoding: \"utf8\", stdio: [\"ignore\", \"pipe\", \"pipe\"] }).trim(); }",
  "  catch { fail(\"V2_CI_GIT_FAILED\"); }",
  "};",
  "const identity = () => {",
  "  const candidate = process.env.V2_CI_CANDIDATE_SHA?.toLowerCase();",
  "  const control = process.env.V2_CI_CONTROL_SHA?.toLowerCase();",
  "  if (!/^[0-9a-f]{40}$/.test(candidate ?? \"\") || !/^[0-9a-f]{40}$/.test(control ?? \"\")",
  "    || control !== process.env.V2_CI_APPROVED_WORKFLOW_SHA?.toLowerCase()) fail(\"V2_CI_IDENTITY_INVALID\");",
  "  if (git(\"rev-parse\", \"HEAD\") !== candidate) fail(\"V2_CI_CANDIDATE_MISMATCH\");",
  "  try { execFileSync(\"git\", [\"diff\", \"--quiet\", \"HEAD\", \"--\"], { stdio: \"pipe\" }); }",
  "  catch { fail(\"V2_CI_INPUT_CHANGED\"); }",
  "  const os = process.env.V2_CI_OS, run = process.env.V2_CI_RUN_ID, attempt = process.env.V2_CI_RUN_ATTEMPT;",
  "  if (![\"ubuntu-latest\", \"windows-latest\"].includes(os) || !/^[1-9][0-9]{0,19}$/.test(run ?? \"\")",
  "    || !/^[1-9][0-9]{0,9}$/.test(attempt ?? \"\")) fail(\"V2_CI_IDENTITY_INVALID\");",
  "  return { schema: 1, candidate, control, os, run, attempt, lock: git(\"rev-parse\", candidate + \":package-lock.json\") };",
  "};",
];

const fixtureParseProgram = [
  "const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);",
  "const parse = value => {",
  "  if (!value || value.length > 2048) fail(\"V2_CI_PHASE_INVALID\");",
  "  try { return JSON.parse(value); } catch { fail(\"V2_CI_PHASE_INVALID\"); }",
  "};",
];

const fixtureEmitProgram = [
  "const emit = value => {",
  "  const receipt = JSON.stringify(value);",
  "  if (receipt.length > 2048 || !process.env.GITHUB_OUTPUT) fail(\"V2_CI_RECORD_INVALID\");",
  "  appendFileSync(process.env.GITHUB_OUTPUT, \"receipt=\" + receipt + \"\\n\");",
  "  console.log(\"V2_CI_RECEIPT \" + receipt);",
  "};",
];

const fixtureReportProgram = [
  "const report = error => {",
  "  const code = /^V2_CI_[A-Z_]+$/.test(error?.message ?? \"\") ? error.message : \"V2_CI_RECORD_INVALID\";",
  "  console.error(code); process.exitCode = 1;",
  "};",
];

const fixtureMeasurementProgram = [
  "const hash = bytes => createHash(\"sha256\").update(bytes).digest(\"hex\");",
  "const bytes = path => {",
  "  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail(\"V2_CI_OUTPUT_INVALID\");",
  "  return readFileSync(path);",
  "};",
  "const measure = () => {",
  "  const compiled = [];",
  "  const walk = path => {",
  "    const entry = lstatSync(path);",
  "    if (entry.isSymbolicLink()) fail(\"V2_CI_OUTPUT_INVALID\");",
  "    if (entry.isDirectory()) for (const name of readdirSync(path).sort()) walk(path + \"/\" + name);",
  "    else compiled.push(path + \"\\0\" + hash(bytes(path)));",
  "  };",
  "  if (existsSync(\"dist-test\")) walk(\"dist-test\");",
  "  const manifest = existsSync(\"dist/v2-build.json\") ? bytes(\"dist/v2-build.json\") : null;",
  "  let deployment = null, artifacts = null;",
  "  if (manifest) {",
  "    const parsed = JSON.parse(manifest.toString());",
  "    if (!/^[A-Za-z0-9-]{1,64}$/.test(parsed.deploymentId ?? \"\")) fail(\"V2_CI_OUTPUT_INVALID\");",
  "    deployment = parsed.deploymentId;",
  "    artifacts = hash([\"v2.js\", \"v2-admin.js\", \"workers/project-store.worker.js\",",
  "      \"internal/v2-internal-verified-read.js\", \"internal/v2-internal-verified-read-cleanup.js\"]",
  "      .map(path => path + \"\\0\" + hash(bytes(\"dist/\" + path))).join(\"\\n\"));",
  "  }",
  "  return { compiled: compiled.length ? hash(compiled.join(\"\\n\")) : null,",
  "    manifest: manifest ? hash(manifest) : null, deployment, artifacts };",
  "};",
];

const fixtureMeasuredImports = [
  "import { execFileSync } from \"node:child_process\";",
  "import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync } from \"node:fs\";",
  "import { createHash } from \"node:crypto\";",
];

function fixtureInlineProgram(lines: readonly string[]): readonly string[] {
  return ["$ErrorActionPreference = \"Stop\"", "@'", ...lines,
    "'@ | & node --input-type=module", "if ($LASTEXITCODE -ne 0) { throw \"V2_CI_IDENTITY_RECORD_FAILED\" }"];
}

const fixtureInitialProgram = fixtureInlineProgram([
  "import { execFileSync } from \"node:child_process\";",
  "import { appendFileSync } from \"node:fs\";",
  ...fixtureContextProgram, ...fixtureEmitProgram, ...fixtureReportProgram,
  "try {",
  "  const bound = identity();",
  "  if (!/^[0-9a-f]{40}$/.test(bound.lock)) fail(\"V2_CI_IDENTITY_INVALID\");",
  "  emit(bound);",
  "} catch (error) { report(error); }",
]);

const fixturePhaseProgram = fixtureInlineProgram([
  ...fixtureMeasuredImports, ...fixtureContextProgram, ...fixtureParseProgram,
  ...fixtureEmitProgram, ...fixtureReportProgram, ...fixtureMeasurementProgram,
  "try {",
  "  const bound = identity(), original = parse(process.env.V2_CI_IDENTITY);",
  "  if (!equal(bound, original)) fail(\"V2_CI_PHASE_INVALID\");",
  "  const phase = process.env.V2_CI_PHASE;",
  "  if (![\"build\", \"tests\", \"lifecycle\", \"rollout\", \"foundation\", \"artifacts\"].includes(phase)) fail(\"V2_CI_PHASE_INVALID\");",
  "  const measured = measure();",
  "  if (!measured.manifest || (phase !== \"build\" && !measured.compiled)) fail(\"V2_CI_OUTPUT_INVALID\");",
  "  emit({ schema: 1, phase, identity: bound, ...measured });",
  "} catch (error) { report(error); }",
]);

const fixtureClosureProgram = fixtureInlineProgram([
  ...fixtureMeasuredImports, ...fixtureContextProgram, ...fixtureParseProgram,
  ...fixtureEmitProgram, ...fixtureReportProgram, ...fixtureMeasurementProgram,
  "try {",
  "  for (const gate of [\"installation_policy\", \"installation\", \"installation_capability\", \"runtime\", \"typecheck\", \"build\", \"tests\", \"lifecycle\", \"rollout\", \"foundation\", \"artifacts\"]) {",
  "    if (process.env[\"V2_CI_OUTCOME_\" + gate.toUpperCase()] !== \"success\") fail(\"V2_CI_OUTCOME_INCOMPLETE\");",
  "  }",
  "  const bound = identity();",
  "  if (!equal(bound, parse(process.env.V2_CI_IDENTITY))) fail(\"V2_CI_PHASE_INVALID\");",
  "  const records = {};",
  "  for (const phase of [\"build\", \"tests\", \"lifecycle\", \"rollout\", \"foundation\", \"artifacts\"]) {",
  "    if (process.env[\"V2_CI_RECORD_\" + phase.toUpperCase()] !== \"success\") fail(\"V2_CI_OUTCOME_INCOMPLETE\");",
  "    const value = parse(process.env[\"V2_CI_PHASE_\" + phase.toUpperCase()]);",
  "    if (value.schema !== 1 || value.phase !== phase || !equal(value.identity, bound)",
  "      || !/^[0-9a-f]{64}$/.test(value.manifest ?? \"\") || !/^[0-9a-f]{64}$/.test(value.artifacts ?? \"\")",
  "      || (phase !== \"build\" && !/^[0-9a-f]{64}$/.test(value.compiled ?? \"\"))) fail(\"V2_CI_PHASE_INVALID\");",
  "    records[phase] = value;",
  "  }",
  "  if (records.artifacts.deployment === records.build.deployment",
  "    || records.artifacts.deployment === records.foundation.deployment) fail(\"V2_CI_PHASE_INVALID\");",
  "  let measured;",
  "  try { measured = measure(); } catch { fail(\"V2_CI_OUTPUT_STALE\"); }",
  "  for (const key of [\"compiled\", \"manifest\", \"deployment\", \"artifacts\"]) {",
  "    if (records.artifacts[key] !== measured[key]) fail(\"V2_CI_OUTPUT_STALE\");",
  "  }",
  "  console.log(\"V2_CI_QUALIFICATION_COMPLETE\");",
  "} catch (error) { report(error); }",
]);

const fixtureQualificationBindings = [
  "V2_CI_CANDIDATE_SHA: ${{ inputs.candidate_sha }}",
  "V2_CI_APPROVED_WORKFLOW_SHA: ${{ inputs.approved_workflow_sha }}",
  "V2_CI_CONTROL_SHA: ${{ github.workflow_sha }}",
  "V2_CI_OS: ${{ matrix.os }}",
  "V2_CI_RUN_ID: ${{ github.run_id }}",
  "V2_CI_RUN_ATTEMPT: ${{ github.run_attempt }}",
];

function fixtureIdentityRecord(name: string, id: string | null, program: readonly string[],
  extraBindings: readonly string[] = []): readonly string[] {
  return ["      - name: " + name, ...(id ? ["        id: " + id] : []),
    "        shell: pwsh", "        env:",
    ...[...fixtureQualificationBindings, ...extraBindings].map(line => "          " + line),
    "        run: |", ...program.map(line => "          " + line), ""];
}
function fixturePhaseRecord(phase: string): readonly string[] {
  return fixtureIdentityRecord("Record " + phase + " identity", "record_" + phase, fixturePhaseProgram,
    ["V2_CI_IDENTITY: ${{ steps.identity.outputs.receipt }}", "V2_CI_PHASE: " + phase]);
}
function fixtureClosureRecord(): readonly string[] {
  return fixtureIdentityRecord("Verify qualification closure", null, fixtureClosureProgram, [
    "V2_CI_IDENTITY: ${{ steps.identity.outputs.receipt }}",
    ...["installation_policy", "installation", "installation_capability", "runtime", "typecheck", "build", "tests", "lifecycle", "rollout", "foundation", "artifacts"]
      .map(id => "V2_CI_OUTCOME_" + id.toUpperCase() + ": ${{ steps." + id + ".outcome }}"),
    ...["build", "tests", "lifecycle", "rollout", "foundation", "artifacts"].flatMap(id => [
      "V2_CI_RECORD_" + id.toUpperCase() + ": ${{ steps.record_" + id + ".outcome }}",
      "V2_CI_PHASE_" + id.toUpperCase() + ": ${{ steps.record_" + id + ".outputs.receipt }}",
    ]),
  ]);
}

// Hand-reviewed owner fixtures: expectations are independent of the validator.
function roleFixtures(): CiWorkflowSet {
  return {
    pr: [
      "name: CI",
      "",
      "on:",
      "  push:",
      "    branches:",
      "      - main",
      "  pull_request:",
      "  workflow_dispatch:",
      "",
      "permissions:",
      "  contents: read",
      "",
      "concurrency:",
      "  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}",
      "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
      "",
      "jobs:",
      "  release-gates:",
      "    name: Node ${{ matrix.node-version }} on ${{ matrix.os }}",
      "    runs-on: ${{ matrix.os }}",
      "    strategy:",
      "      fail-fast: false",
      "      matrix:",
      "        os:",
      "          - ubuntu-latest",
      "          - windows-latest",
      "        node-version:",
      "          - \"24.16.0\"",
      "",
      "    steps:",
      "      - name: Check out repository",
      "        uses: actions/checkout@v6",
      "        with:",
      "          fetch-depth: 0",
      "",
      "      - name: Set up Node.js",
      "        uses: actions/setup-node@v6",
      "        with:",
      "          node-version: ${{ matrix.node-version }}",
      "",
      "      - name: Check installation policy",
      "        run: node scripts/check-build-installation.js before",
      "",
      "      - name: Install dependencies",
      "        run: npm ci --ignore-scripts --include=dev --include=optional",
      "",
      "      - name: Check installation capability",
      "        run: node scripts/check-build-installation.js after",
      "",
      "      - name: Check runtime capabilities",
      "        run: npm run check:runtime",
      "",
      "      - name: Typecheck",
      "        run: npm run typecheck",
      "",
      "      - name: Build",
      "        run: npm run build",
      "",
      "      - name: Require immutable lifecycle base commit",
      "        run: git cat-file -e \"0e375d4643d4b630f36f874a3bb192e96739ac46^{commit}\"",
      "",
      "      - name: Protect Version 1 production routing",
      "        run: git diff --exit-code 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services",
      "",
      "",
      "      - name: Run tests",
      "        run: npm test",
      "",
      "  minimum-runtime-rejection:",
      "    name: Reject Node 22.22.3",
      "    runs-on: ubuntu-latest",
      "",
      "    steps:",
      "      - name: Check out repository",
      "        uses: actions/checkout@v6",
      "        with:",
      "          fetch-depth: 0",
      "",
      "      - name: Set up Node.js 22.22.3",
      "        uses: actions/setup-node@v6",
      "        with:",
      "          node-version: \"22.22.3\"",
      "",
      "      - name: Require the documented minimum-runtime rejection",
      "        shell: bash",
      "        run: |",
      "          set +e",
      "          output=\"$(node scripts/check-runtime.js --json 2>&1)\"",
      "          status=$?",
      "          set -e",
      "",
      "          printf '%s\\n' \"$output\"",
      "",
      "          expected='{\"ok\":false,\"code\":\"SQLITE_CAPABILITY_MISSING\",\"message\":\"Node 22.22.3 is below 24.16.0\"}'",
      "          if [[ \"$status\" -ne 1 ]]; then",
      "            echo \"Expected check-runtime to exit 1, received $status\" >&2",
      "            exit 1",
      "          fi",
      "          if [[ \"$output\" != \"$expected\" ]]; then",
      "            echo \"check-runtime did not emit the exact documented rejection\" >&2",
      "            exit 1",
      "          fi",
      "",
    ].join("\n"),
    release: [
      "name: V2 release qualification",
      "",
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      candidate_sha:",
      "        description: Full candidate commit SHA",
      "        required: true",
      "        type: string",
      "      approved_workflow_sha:",
      "        description: Approved workflow control commit SHA",
      "        required: true",
      "        type: string",
      "",
      "permissions:",
      "  contents: read",
      "",
      "jobs:",
      "  qualification:",
      "    name: V2 release qualification on ${{ matrix.os }}",
      "    runs-on: ${{ matrix.os }}",
      "    strategy:",
      "      fail-fast: false",
      "      matrix:",
      "        os:",
      "          - ubuntu-latest",
      "          - windows-latest",
      "        node-version:",
      "          - \"24.16.0\"",
      "",
      "    steps:",
      "      - name: Validate qualification inputs",
      "        shell: pwsh",
      "        env:",
      "          V2_CI_CANDIDATE_SHA: ${{ inputs.candidate_sha }}",
      "          V2_CI_APPROVED_WORKFLOW_SHA: ${{ inputs.approved_workflow_sha }}",
      "          V2_CI_CONTROL_SHA: ${{ github.workflow_sha }}",
      "        run: |",
      "          $ErrorActionPreference = \"Stop\"",
      "          foreach ($key in @(\"V2_CI_CANDIDATE_SHA\", \"V2_CI_APPROVED_WORKFLOW_SHA\", \"V2_CI_CONTROL_SHA\")) {",
      "            $value = [Environment]::GetEnvironmentVariable($key)",
      "            if ($value -cnotmatch '\\A[0-9a-fA-F]{40}\\z') { throw \"V2_CI_IDENTITY_INVALID\" }",
      "          }",
      "          if ($env:V2_CI_CONTROL_SHA.ToLowerInvariant() -cne $env:V2_CI_APPROVED_WORKFLOW_SHA.ToLowerInvariant()) {",
      "            throw \"V2_CI_CONTROL_UNAPPROVED\"",
      "          }",
      "",
      "      - name: Check out repository",
      "        uses: actions/checkout@v6",
      "        with:",
      "          fetch-depth: 0",
      "          ref: ${{ inputs.candidate_sha }}",
      "",
      "      - name: Verify candidate and workflow identity",
      "        shell: pwsh",
      "        env:",
      "          V2_CI_CANDIDATE_SHA: ${{ inputs.candidate_sha }}",
      "          V2_CI_APPROVED_WORKFLOW_SHA: ${{ inputs.approved_workflow_sha }}",
      "          V2_CI_CONTROL_SHA: ${{ github.workflow_sha }}",
      "        run: |",
      "          $ErrorActionPreference = \"Stop\"",
      "          $head = & git rev-parse HEAD",
      "          if ($LASTEXITCODE -ne 0) { throw \"V2_CI_HEAD_UNAVAILABLE\" }",
      "          if ($head -cne $env:V2_CI_CANDIDATE_SHA.ToLowerInvariant()) { throw \"V2_CI_CANDIDATE_MISMATCH\" }",
      "          & git cat-file -e \"$($env:V2_CI_CONTROL_SHA)^{commit}\"",
      "          if ($LASTEXITCODE -ne 0) { throw \"V2_CI_CONTROL_UNAVAILABLE\" }",
      "          foreach ($path in @(\".github/workflows/ci.yml\", \".github/workflows/v2-release-qualification.yml\", \".github/workflows/v2-legacy-regression.yml\", \".github/workflows/sqlite-stress.yml\")) {",
      "            $candidateBlob = & git rev-parse \"$($env:V2_CI_CANDIDATE_SHA):$path\"",
      "            if ($LASTEXITCODE -ne 0) { throw \"V2_CI_CANDIDATE_WORKFLOW_UNAVAILABLE\" }",
      "            $controlBlob = & git rev-parse \"$($env:V2_CI_CONTROL_SHA):$path\"",
      "            if ($LASTEXITCODE -ne 0) { throw \"V2_CI_CONTROL_WORKFLOW_UNAVAILABLE\" }",
      "            if ($candidateBlob -cne $controlBlob) { throw \"V2_CI_WORKFLOW_MISMATCH\" }",
      "          }",
      "",
      "      - name: Set up Node.js",
      "        uses: actions/setup-node@v6",
      "        with:",
      "          node-version: ${{ matrix.node-version }}",
      "",
      ...fixtureIdentityRecord("Record qualification identity", "identity", fixtureInitialProgram),
      "      - name: Check installation policy",
      "        id: installation_policy",
      "        run: node scripts/check-build-installation.js before",
      "",
      "      - name: Install dependencies",
      "        id: installation",
      "        run: npm ci --ignore-scripts --include=dev --include=optional",
      "",
      "      - name: Check installation capability",
      "        id: installation_capability",
      "        run: node scripts/check-build-installation.js after",
      "",
      "      - name: Check runtime capabilities",
      "        id: runtime",
      "        run: npm run check:runtime",
      "",
      "      - name: Typecheck",
      "        id: typecheck",
      "        run: npm run typecheck",
      "",
      "      - name: Build",
      "        id: build",
      "        run: npm run build",
      "",
      ...fixturePhaseRecord("build"),
      "      - name: Require immutable lifecycle base commit",
      "        run: git cat-file -e \"0e375d4643d4b630f36f874a3bb192e96739ac46^{commit}\"",
      "",
      "      - name: Protect Version 1 production routing",
      "        run: git diff --exit-code 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services",
      "",
      "      - name: Run tests",
      "        id: tests",
      "        run: npm test",
      "",
      ...fixturePhaseRecord("tests"),
      "      - name: Run lifecycle release gates",
      "        id: lifecycle",
      "        run: npm run test:subproject-2",
      "",
      ...fixturePhaseRecord("lifecycle"),
      "      - name: Run V2 rollout control-plane gate",
      "        id: rollout",
      "        run: npm run test:rollout-control-plane",
      "",
      ...fixturePhaseRecord("rollout"),
      "      - name: Run V2 fresh-start foundation gate",
      "        id: foundation",
      "        run: npm run test:v2-fresh-start-foundation",
      "",
      ...fixturePhaseRecord("foundation"),
      "      - name: Test build artifacts",
      "        id: artifacts",
      "        run: npm run test:build-artifacts",
      "",
      ...fixturePhaseRecord("artifacts"),
      ...fixtureClosureRecord(),
    ].join("\n"),
    legacy: [
      "name: V2 legacy regression",
      "",
      "on:",
      "  workflow_dispatch:",
      "",
      "permissions:",
      "  contents: read",
      "",
      "jobs:",
      "  legacy-regression:",
      "    name: V2 legacy regression Node ${{ matrix.node-version }} on ${{ matrix.os }}",
      "    runs-on: ${{ matrix.os }}",
      "    strategy:",
      "      fail-fast: false",
      "      matrix:",
      "        os:",
      "          - ubuntu-latest",
      "          - windows-latest",
      "        node-version:",
      "          - \"24.16.0\"",
      "",
      "    steps:",
      "      - name: Check out repository",
      "        uses: actions/checkout@v6",
      "        with:",
      "          fetch-depth: 0",
      "",
      "      - name: Set up Node.js",
      "        uses: actions/setup-node@v6",
      "        with:",
      "          node-version: ${{ matrix.node-version }}",
      "",
      "      - name: Check installation policy",
      "        run: node scripts/check-build-installation.js before",
      "",
      "      - name: Install dependencies",
      "        run: npm ci --ignore-scripts --include=dev --include=optional",
      "",
      "      - name: Check installation capability",
      "        run: node scripts/check-build-installation.js after",
      "",
      "      - name: Check runtime capabilities",
      "        run: npm run check:runtime",
      "",
      "      - name: Run V2 shadow migration gate",
      "        env:",
      "          V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT: ${{ runner.temp }}/v2-shadow-migration-functional/evidence.json",
      "        run: npm run test:migration",
      "",
      "      - name: Upload V2 shadow migration functional synthetic evidence",
      "        uses: actions/upload-artifact@v7",
      "        with:",
      "          name: v2-shadow-migration-functional-synthetic-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}",
      "          path: ${{ runner.temp }}/v2-shadow-migration-functional/evidence.json",
      "          if-no-files-found: error",
      "          retention-days: 14",
      "",
    ].join("\n"),
    stress: [
      "name: SQLite Stress",
      "",
      "on:",
      "  schedule:",
      "    - cron: \"0 3 * * 1\"",
      "  workflow_dispatch:",
      "",
      "permissions:",
      "  contents: read",
      "",
      "concurrency:",
      "  group: sqlite-stress",
      "  cancel-in-progress: false",
      "",
      "jobs:",
      "  stress:",
      "    name: SQLite stress on ${{ matrix.os }}",
      "    runs-on: ${{ matrix.os }}",
      "    strategy:",
      "      fail-fast: false",
      "      max-parallel: 1",
      "      matrix:",
      "        os:",
      "          - ubuntu-latest",
      "          - windows-latest",
      "",
      "    steps:",
      "      - name: Check out repository",
      "        uses: actions/checkout@v6",
      "        with:",
      "          fetch-depth: 0",
      "",
      "      - name: Set up Node.js",
      "        uses: actions/setup-node@v6",
      "        with:",
      "          node-version: \"24.16.0\"",
      "",
      "      - name: Install dependencies",
      "        shell: pwsh",
      "        run: |",
      "          $logPath = \"ci-logs/sqlite-stress-${{ matrix.os }}.log\"",
      "          New-Item -ItemType Directory -Force -Path (Split-Path $logPath) | Out-Null",
      "          Write-Output \"> node scripts/check-build-installation.js before\" | Tee-Object -FilePath $logPath -Append",
      "          & node scripts/check-build-installation.js before 2>&1 | Tee-Object -FilePath $logPath -Append",
      "          $commandExitCode = $LASTEXITCODE",
      "          if ($commandExitCode -ne 0) {",
      "            exit $commandExitCode",
      "          }",
      "          Write-Output \"> npm ci --ignore-scripts --include=dev --include=optional\" | Tee-Object -FilePath $logPath -Append",
      "          & npm ci --ignore-scripts --include=dev --include=optional 2>&1 | Tee-Object -FilePath $logPath -Append",
      "          $commandExitCode = $LASTEXITCODE",
      "          if ($commandExitCode -ne 0) {",
      "            exit $commandExitCode",
      "          }",
      "          Write-Output \"> node scripts/check-build-installation.js after\" | Tee-Object -FilePath $logPath -Append",
      "          & node scripts/check-build-installation.js after 2>&1 | Tee-Object -FilePath $logPath -Append",
      "          $commandExitCode = $LASTEXITCODE",
      "          if ($commandExitCode -ne 0) {",
      "            exit $commandExitCode",
      "          }",
      "",
      "      - name: Build tests",
      "        shell: pwsh",
      "        run: |",
      "          $logPath = \"ci-logs/sqlite-stress-${{ matrix.os }}.log\"",
      "          Write-Output \"> npm run test:build\" | Tee-Object -FilePath $logPath -Append",
      "          & npm run test:build 2>&1 | Tee-Object -FilePath $logPath -Append",
      "          $commandExitCode = $LASTEXITCODE",
      "          if ($commandExitCode -ne 0) {",
      "            exit $commandExitCode",
      "          }",
      "",
      "      - name: Run default and lifecycle concurrent, crash, and security tests",
      "        shell: pwsh",
      "        run: |",
      "          $logPath = \"ci-logs/sqlite-stress-${{ matrix.os }}.log\"",
      "          Write-Output \"> node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-store.concurrent.test.js dist-test/tests/event-store.crash.test.js dist-test/tests/lifecycle.concurrent.test.js dist-test/tests/lifecycle.crash.test.js dist-test/tests/lifecycle.security.test.js\" | Tee-Object -FilePath $logPath -Append",
      "          & node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-store.concurrent.test.js dist-test/tests/event-store.crash.test.js dist-test/tests/lifecycle.concurrent.test.js dist-test/tests/lifecycle.crash.test.js dist-test/tests/lifecycle.security.test.js 2>&1 | Tee-Object -FilePath $logPath -Append",
      "          $commandExitCode = $LASTEXITCODE",
      "          if ($commandExitCode -ne 0) {",
      "            exit $commandExitCode",
      "          }",
      "",
      "      - name: Run release stress test",
      "        shell: pwsh",
      "        run: |",
      "          $logPath = \"ci-logs/sqlite-stress-${{ matrix.os }}.log\"",
      "          Write-Output \"> npm run test:stress\" | Tee-Object -FilePath $logPath -Append",
      "          & npm run test:stress 2>&1 | Tee-Object -FilePath $logPath -Append",
      "          $commandExitCode = $LASTEXITCODE",
      "          if ($commandExitCode -ne 0) {",
      "            exit $commandExitCode",
      "          }",
      "",
      "      - name: Run lifecycle stress test",
      "        shell: pwsh",
      "        run: |",
      "          $logPath = \"ci-logs/sqlite-stress-${{ matrix.os }}.log\"",
      "          Write-Output \"> npm run test:lifecycle-stress\" | Tee-Object -FilePath $logPath -Append",
      "          & npm run test:lifecycle-stress 2>&1 | Tee-Object -FilePath $logPath -Append",
      "          $commandExitCode = $LASTEXITCODE",
      "          if ($commandExitCode -ne 0) {",
      "            exit $commandExitCode",
      "          }",
      "",
      "      - name: Upload stress logs",
      "        if: ${{ always() }}",
      "        uses: actions/upload-artifact@v7",
      "        with:",
      "          name: sqlite-stress-logs-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}",
      "          path: ci-logs/sqlite-stress-${{ matrix.os }}.log",
      "          if-no-files-found: error",
      "          retention-days: 14",
      "",
    ].join("\n"),
  };
}

test("CI roles accept only the complete reviewed owner set", () => {
  assert.doesNotThrow(() => assertCiWorkflowSet(roleFixtures()));
  const missing = { ...roleFixtures(), release: "" };
  assert.throws(() => assertCiWorkflowSet(missing));
});

test("CI roles requiredStep binds the exact job and refuses bypasses", () => {
  const fixture = roleFixtures();
  assert.equal(requiredStep(fixture.release, "qualification", "Build").ownerJob, "qualification");
  assert.throws(() => requiredStep(fixture.release, "release-gates", "Build"));
  assert.throws(() => requiredStep(fixture.release.replace("        id: build", "        if: true\n        id: build"), "qualification", "Build"));
});

const prMutations: readonly [string, string, string][] = [
  ["duplicate jobs", "  release-gates:\n", "  release-gates:\n  release-gates:\n"],
  ["duplicate mappings", "        run: npm run build", "        run: npm run build\n        run: echo forged"],
  ["duplicate steps", "      - name: Build\n", "      - name: Build\n        run: npm run build\n      - name: Build\n"],
  ["anchors", "    name: Node", "    name: &job Node"],
  ["aliases", "    name: Node", "    name: *job"],
  ["merges", "    name: Node", "    <<: *defaults\n    name: Node"],
  ["tags", "    name: Node", "    name: !tag Node"],
  ["quoted keys", "    name: Node", "    'name': Node"],
  ["flow keys", "    name: Node", "    name: { hidden: true } # Node"],
  ["explicit keys", "    name: Node", "    ? if\n    : false\n    name: Node"],
  ["tabs", "    name: Node", "\tname: Node"],
  ["exotic blocks", "    name: Node", "    name: > # Node"],
  ["job bypass", "  release-gates:\n", "  release-gates:\n    if: true\n"],
  ["job failure suppression", "  release-gates:\n", "  release-gates:\n    continue-on-error: false\n"],
  ["step bypass", "      - name: Build\n", "      - name: Build\n        if: true\n"],
  ["step failure suppression", "      - name: Build\n", "      - name: Build\n        continue-on-error: false\n"],
  ["unknown owners", "  release-gates:", "  arbitrary-owner:"],
  ["arbitrary environment keys", "        run: npm ci --ignore-scripts --include=dev --include=optional", "        env:\n          NODE_ENV: production\n        run: npm ci --ignore-scripts --include=dev --include=optional"],
  ["broadened checkout inputs", "          fetch-depth: 0", "          fetch-depth: 0\n          path: alternate"],
  ["broadened setup inputs", "          node-version: ${{ matrix.node-version }}", "          node-version: ${{ matrix.node-version }}\n          fetch-depth: 0"],
  ["reduced or full replacement profile", "run: npm test", "run: npm run test:all"],
  ["push branch widening", "      - main", "      - feature"],
  ["push cancellation", "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "cancel-in-progress: true"],
];
for (const [label, from, to] of prMutations) test(`CI roles reject ${label}`, () => {
  const fixture = roleFixtures();
  assertCiWorkflowSet(fixture);
  const pr = fixture.pr.replace(from, to);
  assert.notEqual(pr, fixture.pr);
  assert.throws(() => assertCiWorkflowSet({ ...fixture, pr }));
});
for (const directive of ["%YAML 1.2", "---", "..."]) test(`CI roles reject directive or marker ${directive}`, () => {
  const fixture = roleFixtures();
  assertCiWorkflowSet(fixture);
  assert.throws(() => assertCiWorkflowSet({ ...fixture, pr: directive + "\n" + fixture.pr }));
});

const releaseMutations: readonly [string, string, string][] = [
  ["candidate helper before checkout", '$ErrorActionPreference = "Stop"', "node scripts/verify-ci.js"],
  ["candidate helper after checkout", "$head = & git rev-parse HEAD", "node scripts/verify-ci.js"],
  ["unvalidated checkout ref", "ref: ${{ inputs.candidate_sha }}", "ref: main"],
  ["control binding substitution", "V2_CI_CONTROL_SHA: ${{ github.workflow_sha }}", "V2_CI_CONTROL_SHA: ${{ github.sha }}"],
  ["candidate binding interpolation", "V2_CI_CANDIDATE_SHA: ${{ inputs.candidate_sha }}", "V2_CI_CANDIDATE_SHA: main"],
  ["optional dispatch input", "required: true", "required: false"],
  ["nonnative dispatch input", "type: string", "type: choice"],
  ["extra dispatch input", "      candidate_sha:\n", "      other:\n        required: true\n        type: string\n      candidate_sha:\n"],
  ["missing step IDs", "        id: build\n", ""],
  ["wrong step IDs", "        id: build", "        id: runtime"],
  ["ignored qualifier", "run: npm run test:subproject-2", "run: npm run test:subproject-2 || true"],
  ["missing qualifier", "      - name: Run lifecycle release gates\n        id: lifecycle\n        run: npm run test:subproject-2", ""],
];
for (const [label, from, to] of releaseMutations) test(`CI roles reject ${label}`, () => {
  const fixture = roleFixtures();
  assertCiWorkflowSet(fixture);
  const release = fixture.release.replace(from, to);
  assert.notEqual(release, fixture.release);
  assert.throws(() => assertCiWorkflowSet({ ...fixture, release }));
});
for (const name of ["Install dependencies", "Build"]) test(`CI roles reject ${name} before identity checks`, () => {
  const fixture = roleFixtures();
  assertCiWorkflowSet(fixture);
  const block = name === "Build" ? "      - name: Build\n        id: build\n        run: npm run build\n\n" : "      - name: Install dependencies\n        id: installation\n        run: npm ci --ignore-scripts --include=dev --include=optional\n\n";
  assert.ok(fixture.release.includes(block));
  const release = fixture.release.replace(block, "").replace("    steps:\n", "    steps:\n" + block);
  assert.notEqual(release, fixture.release);
  assert.throws(() => assertCiWorkflowSet({ ...fixture, release }));
});

for (const [label, from, to] of [
  ["forged producer", "run: npm run test:migration", "run: cp stale.json evidence.json"],
  ["glob upload", "path: ${{ runner.temp }}/v2-shadow-migration-functional/evidence.json", "path: ${{ runner.temp }}/**/*.json"],
  ["missing artifact warning", "if-no-files-found: error", "if-no-files-found: warn"],
  ["upload retention widening", "retention-days: 14", "retention-days: 140"],
  ["producer output substitution", "V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT: ${{ runner.temp }}/v2-shadow-migration-functional/evidence.json", "V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT: stale.json"],
] as const) test(`CI roles reject legacy ${label}`, () => {
  const fixture = roleFixtures();
  assertCiWorkflowSet(fixture);
  const legacy = fixture.legacy.replace(from, to);
  assert.notEqual(legacy, fixture.legacy);
  assert.throws(() => assertCiWorkflowSet({ ...fixture, legacy }));
});
test("CI roles reject role crossing and extra owner keys", () => {
  const fixture = roleFixtures();
  assertCiWorkflowSet(fixture);
  assert.throws(() => assertCiWorkflowSet({ ...fixture, pr: fixture.release, release: fixture.pr }));
  assert.throws(() => assertCiWorkflowSet({ ...fixture, unknown: fixture.pr } as CiWorkflowSet));
});

test("CI roles reject legacy schedules and release cancellation", () => {
  const fixture = roleFixtures();
  assertCiWorkflowSet(fixture);
  assert.throws(() => assertCiWorkflowSet({ ...fixture, legacy: fixture.legacy.replace("on:\n", 'on:\n  schedule:\n    - cron: "0 3 * * 1"\n') }));
  assert.throws(() => assertCiWorkflowSet({ ...fixture, release: fixture.release.replace("jobs:\n", "concurrency:\n  group: release\n  cancel-in-progress: true\n\njobs:\n") }));
});

test("CI roles concurrency fixtures collide only for the same PR", () => {
  const root = new URL("../../", import.meta.url);
  const workflows = {
    pr: readFileSync(new URL(".github/workflows/ci.yml", root), "utf8").replace(/\r\n?/g, "\n"),
    release: readFileSync(new URL(".github/workflows/v2-release-qualification.yml", root), "utf8").replace(/\r\n?/g, "\n"),
    legacy: readFileSync(new URL(".github/workflows/v2-legacy-regression.yml", root), "utf8").replace(/\r\n?/g, "\n"),
    stress: readFileSync(new URL(".github/workflows/sqlite-stress.yml", root), "utf8").replace(/\r\n?/g, "\n"),
  };
  assertCiWorkflowSet(workflows);
  const group = /^  group: (.+)$/m.exec(workflows.pr)![1]!;
  const cancel = /^  cancel-in-progress: (.+)$/m.exec(workflows.pr)![1]!;
  // Data fixtures exercise the pinned expression's identity semantics. Hosted
  // scheduling and cancellation outcomes require separately authorized runs.
  const cases = [
    { event: "pull_request", pr: 7, run: 10, group: "CI-pull_request-7", cancel: true },
    { event: "pull_request", pr: 7, run: 11, group: "CI-pull_request-7", cancel: true },
    { event: "pull_request", pr: 8, run: 12, group: "CI-pull_request-8", cancel: true },
    { event: "push", pr: null, run: 13, group: "CI-push-13", cancel: false },
    { event: "push", pr: null, run: 14, group: "CI-push-14", cancel: false },
    { event: "workflow_dispatch", pr: null, run: 15, group: "CI-workflow_dispatch-15", cancel: false },
    { event: "workflow_dispatch", pr: null, run: 16, group: "CI-workflow_dispatch-16", cancel: false },
  ] as const;
  for (const input of cases) {
    const actual = group.replace("${{ github.workflow }}", "CI")
      .replace("${{ github.event_name }}", input.event)
      .replace("${{ github.event.pull_request.number || github.run_id }}", String(input.pr || input.run));
    assert.equal(actual, input.group);
    assert.equal(cancel === "${{ github.event_name == 'pull_request' }}" && input.event === "pull_request", input.cancel);
  }
});
