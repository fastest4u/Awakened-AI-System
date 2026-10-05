import assert from "node:assert/strict";

export type CiWorkflowSet = Readonly<{ pr: string; release: string; legacy: string; stress: string }>;
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
  const jobSection = yaml.slice(yaml.indexOf("\njobs:\n") + "\njobs:\n".length);
  const matches = [...jobSection.matchAll(/^  ([a-z][a-z0-9_-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:|(?![\s\S]))/gm)];
  for (const match of matches) {
    assert.ok(!jobs.has(match[1]!), "duplicate workflow job");
    jobs.set(match[1]!, match[0]!);
  }
  return jobs;
}

export interface WorkflowStep {
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
  const indent = key === "max-parallel" ? 6 : ["path", "fetch-depth"].includes(key) ? 10 : 8;
  const match = new RegExp(`^ {${indent}}${key}: *(.*)$`, "m").exec(block);
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

function assertNoJobBypass(job: string, label: string): void {
  assert.doesNotMatch(job, /^    if:\s*/m, `${label} must not declare if`);
  assert.doesNotMatch(
    job,
    /^    continue-on-error:\s*/m,
    `${label} must not declare continue-on-error`,
  );
}

function requiredJobStep(job: string, name: string): WorkflowStep {
  const candidates = workflowSteps(job).filter((candidate) => candidate.name === name);
  assert.equal(candidates.length, 1, `exactly one executable ${name} step is required`);
  const step = candidates[0];
  assert.ok(step, `missing executable ${name} step`);
  assert.equal(yamlScalar(step.body, "if"), null, `${name} must not declare if`);
  assert.equal(
    yamlScalar(step.body, "continue-on-error"),
    null,
    `${name} must not declare continue-on-error`,
  );
  return step;
}

// This is deliberately a closed subset, not a general YAML parser. Validate
// hierarchy before the bounded scalar readers can see a nested or duplicate key.
function assertWorkflowStructure(yaml: string, roles = false): ReadonlyMap<string, string> {
  const maps: Record<string, readonly string[]> = {
    "": ["name", "on", "permissions", "concurrency", "jobs"],
    "on": ["push", "pull_request", "workflow_dispatch", "schedule"],
    "on/schedule/*": ["cron"],
    "permissions": ["contents"],
    "concurrency": ["group", "cancel-in-progress"],
    "jobs": ["release-gates", "minimum-runtime-rejection", "stress"],
    "jobs/*": ["name", "runs-on", "strategy", "steps", "if", "continue-on-error"],
    "jobs/*/strategy": ["fail-fast", "max-parallel", "matrix"],
    "jobs/*/strategy/matrix": ["os", "node-version"],
    "jobs/*/steps/*": ["name", "uses", "run", "shell", "with", "env", "if", "continue-on-error"],
    "jobs/*/steps/*/with": ["name", "path", "if-no-files-found", "retention-days", "fetch-depth", "node-version"],
    "jobs/*/steps/*/env": ["V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT"],
  };
  if (roles) {
    maps["on/push"] = ["branches"];
    maps["on/workflow_dispatch"] = ["inputs"];
    maps["on/workflow_dispatch/inputs"] = ["candidate_sha", "approved_workflow_sha"];
    maps["on/workflow_dispatch/inputs/candidate_sha"] = ["description", "required", "type"];
    maps["on/workflow_dispatch/inputs/approved_workflow_sha"] = ["description", "required", "type"];
    maps["jobs"] = ["release-gates", "minimum-runtime-rejection", "qualification", "legacy-regression", "stress"];
    maps["jobs/*/steps/*"] = [...maps["jobs/*/steps/*"]!, "id"];
    maps["jobs/*/steps/*/with"] = [...maps["jobs/*/steps/*/with"]!, "ref"];
    maps["jobs/*/steps/*/env"] = [...maps["jobs/*/steps/*/env"]!,
      "V2_CI_CANDIDATE_SHA", "V2_CI_APPROVED_WORKFLOW_SHA", "V2_CI_CONTROL_SHA",
      "V2_CI_OS", "V2_CI_RUN_ID", "V2_CI_RUN_ATTEMPT", "V2_CI_IDENTITY", "V2_CI_PHASE",
      ...["installation_policy", "installation", "installation_capability", "runtime", "typecheck", "build", "tests", "lifecycle", "rollout", "foundation", "artifacts"]
        .map(id => "V2_CI_OUTCOME_" + id.toUpperCase()),
      ...["build", "tests", "lifecycle", "rollout", "foundation", "artifacts"]
        .flatMap(id => ["V2_CI_RECORD_" + id.toUpperCase(), "V2_CI_PHASE_" + id.toUpperCase()])];
  }
  const scalars = new Map<string, string>();
  const lists = new Set(["on/schedule", "jobs/*/steps", "jobs/*/strategy/matrix/os", "jobs/*/strategy/matrix/node-version"]);
  if (roles) lists.add("on/push/branches");
  type Frame = { indent: number; path: string; list: boolean; keys: Set<string> };
  const stack: Frame[] = [{ indent: 0, path: "", list: false, keys: new Set() }];
  for (const line of structuralWorkflowLines(yaml)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = /^ */.exec(line)![0].length;
    while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
    let frame = stack[stack.length - 1]!;
    assert.equal(indent, frame.indent, "unsupported YAML nesting or indentation");
    let text = line.trim();
    if (text.startsWith("- ")) {
      assert.ok(frame.list, "list requires an approved sequence parent");
      text = text.slice(2);
      if (frame.path.includes("/matrix/") || frame.path === "on/push/branches") {
        assert.ok(/^(?:[a-z][a-z0-9-]*|"[0-9.]+")$/.test(text), "matrix items must be literal scalars");
        continue;
      }
      frame = { indent: indent + 2, path: `${frame.path}/*`, list: false, keys: new Set() };
      stack.push(frame);
    } else assert.equal(frame.list, false, "sequence item must begin with dash");
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$/.exec(text);
    assert.ok(pair, "mapping must be a canonical key/value");
    const key = pair[1]!, value = pair[2] ?? "";
    assert.ok(maps[frame.path]?.includes(key), `unsupported YAML key or parent: ${frame.path}/${key}`);
    assert.ok(!frame.keys.has(key), `duplicate YAML key: ${frame.path}/${key}`);
    frame.keys.add(key);
    const child = frame.path === "jobs" ? "jobs/*" : frame.path ? `${frame.path}/${key}` : key;
    if (maps[child] || lists.has(child)) {
      assert.equal(value, "", `container must not have a scalar: ${child}`);
      stack.push({ indent: frame.indent + 2, path: child, list: lists.has(child), keys: new Set() });
    } else {
      assert.ok(value !== "" || frame.path === "on", `scalar must not be a nested mapping: ${child}`);
      if (value === "|") assert.equal(key, "run");
      scalars.set(child, normalizeYamlScalar(value));
    }
  }
  return scalars;
}

function compactStep(body: string): string {
  return body.split("\n").filter(line => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .map(line => line.trim()).join("\n");
}

export const VALIDATE_QUALIFICATION_INPUTS = [
  "$ErrorActionPreference = \"Stop\"",
  "foreach ($key in @(\"V2_CI_CANDIDATE_SHA\", \"V2_CI_APPROVED_WORKFLOW_SHA\", \"V2_CI_CONTROL_SHA\")) {",
  "  $value = [Environment]::GetEnvironmentVariable($key)",
  "  if ($value -cnotmatch '\\A[0-9a-fA-F]{40}\\z') { throw \"V2_CI_IDENTITY_INVALID\" }",
  "}",
  "if ($env:V2_CI_CONTROL_SHA.ToLowerInvariant() -cne $env:V2_CI_APPROVED_WORKFLOW_SHA.ToLowerInvariant()) {",
  "  throw \"V2_CI_CONTROL_UNAPPROVED\"",
  "}",
].join("\n");
export const VERIFY_CANDIDATE_WORKFLOW_IDENTITY = [
  "$ErrorActionPreference = \"Stop\"",
  "$head = & git rev-parse HEAD",
  "if ($LASTEXITCODE -ne 0) { throw \"V2_CI_HEAD_UNAVAILABLE\" }",
  "if ($head -cne $env:V2_CI_CANDIDATE_SHA.ToLowerInvariant()) { throw \"V2_CI_CANDIDATE_MISMATCH\" }",
  "& git cat-file -e \"$($env:V2_CI_CONTROL_SHA)^{commit}\"",
  "if ($LASTEXITCODE -ne 0) { throw \"V2_CI_CONTROL_UNAVAILABLE\" }",
  "foreach ($path in @(\".github/workflows/ci.yml\", \".github/workflows/v2-release-qualification.yml\", \".github/workflows/v2-legacy-regression.yml\", \".github/workflows/sqlite-stress.yml\")) {",
  "  $candidateBlob = & git rev-parse \"$($env:V2_CI_CANDIDATE_SHA):$path\"",
  "  if ($LASTEXITCODE -ne 0) { throw \"V2_CI_CANDIDATE_WORKFLOW_UNAVAILABLE\" }",
  "  $controlBlob = & git rev-parse \"$($env:V2_CI_CONTROL_SHA):$path\"",
  "  if ($LASTEXITCODE -ne 0) { throw \"V2_CI_CONTROL_WORKFLOW_UNAVAILABLE\" }",
  "  if ($candidateBlob -cne $controlBlob) { throw \"V2_CI_WORKFLOW_MISMATCH\" }",
  "}",
].join("\n");

// Independently reviewed literal program fragments; compose only inside this pure policy.
const QUALIFICATION_CONTEXT_PROGRAM = [
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

const QUALIFICATION_PARSE_PROGRAM = [
  "const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);",
  "const parse = value => {",
  "  if (!value || value.length > 2048) fail(\"V2_CI_PHASE_INVALID\");",
  "  try { return JSON.parse(value); } catch { fail(\"V2_CI_PHASE_INVALID\"); }",
  "};",
];

const QUALIFICATION_EMIT_PROGRAM = [
  "const emit = value => {",
  "  const receipt = JSON.stringify(value);",
  "  if (receipt.length > 2048 || !process.env.GITHUB_OUTPUT) fail(\"V2_CI_RECORD_INVALID\");",
  "  appendFileSync(process.env.GITHUB_OUTPUT, \"receipt=\" + receipt + \"\\n\");",
  "  console.log(\"V2_CI_RECEIPT \" + receipt);",
  "};",
];

const QUALIFICATION_REPORT_PROGRAM = [
  "const report = error => {",
  "  const code = /^V2_CI_[A-Z_]+$/.test(error?.message ?? \"\") ? error.message : \"V2_CI_RECORD_INVALID\";",
  "  console.error(code); process.exitCode = 1;",
  "};",
];

const QUALIFICATION_MEASUREMENT_PROGRAM = [
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

const QUALIFICATION_MEASURED_IMPORTS = [
  "import { execFileSync } from \"node:child_process\";",
  "import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync } from \"node:fs\";",
  "import { createHash } from \"node:crypto\";",
];

function qualificationInlineProgram(lines: readonly string[]): string {
  return ["$ErrorActionPreference = \"Stop\"", "@'", ...lines,
    "'@ | & node --input-type=module", "if ($LASTEXITCODE -ne 0) { throw \"V2_CI_IDENTITY_RECORD_FAILED\" }"].join("\n");
}

export const RECORD_QUALIFICATION_IDENTITY = qualificationInlineProgram([
  "import { execFileSync } from \"node:child_process\";",
  "import { appendFileSync } from \"node:fs\";",
  ...QUALIFICATION_CONTEXT_PROGRAM,
  ...QUALIFICATION_EMIT_PROGRAM,
  ...QUALIFICATION_REPORT_PROGRAM,
  "try {",
  "  const bound = identity();",
  "  if (!/^[0-9a-f]{40}$/.test(bound.lock)) fail(\"V2_CI_IDENTITY_INVALID\");",
  "  emit(bound);",
  "} catch (error) { report(error); }",
]);

export const RECORD_QUALIFICATION_PHASE = qualificationInlineProgram([
  ...QUALIFICATION_MEASURED_IMPORTS,
  ...QUALIFICATION_CONTEXT_PROGRAM,
  ...QUALIFICATION_PARSE_PROGRAM,
  ...QUALIFICATION_EMIT_PROGRAM,
  ...QUALIFICATION_REPORT_PROGRAM,
  ...QUALIFICATION_MEASUREMENT_PROGRAM,
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

export const VERIFY_QUALIFICATION_CLOSURE = qualificationInlineProgram([
  ...QUALIFICATION_MEASURED_IMPORTS,
  ...QUALIFICATION_CONTEXT_PROGRAM,
  ...QUALIFICATION_PARSE_PROGRAM,
  ...QUALIFICATION_EMIT_PROGRAM,
  ...QUALIFICATION_REPORT_PROGRAM,
  ...QUALIFICATION_MEASUREMENT_PROGRAM,
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

const QUALIFICATION_BINDINGS = [
  "V2_CI_CANDIDATE_SHA: ${{ inputs.candidate_sha }}",
  "V2_CI_APPROVED_WORKFLOW_SHA: ${{ inputs.approved_workflow_sha }}",
  "V2_CI_CONTROL_SHA: ${{ github.workflow_sha }}",
  "V2_CI_OS: ${{ matrix.os }}",
  "V2_CI_RUN_ID: ${{ github.run_id }}",
  "V2_CI_RUN_ATTEMPT: ${{ github.run_attempt }}",
];
function qualificationRecordPolicy(name: string, id: string | null, phase?: string): string {
  const bindings = [...QUALIFICATION_BINDINGS];
  let run = RECORD_QUALIFICATION_IDENTITY;
  if (phase) {
    bindings.push("V2_CI_IDENTITY: ${{ steps.identity.outputs.receipt }}", "V2_CI_PHASE: " + phase);
    run = RECORD_QUALIFICATION_PHASE;
  } else if (id === null) {
    bindings.push("V2_CI_IDENTITY: ${{ steps.identity.outputs.receipt }}");
    for (const gate of ["installation_policy", "installation", "installation_capability", "runtime", "typecheck", "build", "tests", "lifecycle", "rollout", "foundation", "artifacts"]) {
      bindings.push("V2_CI_OUTCOME_" + gate.toUpperCase() + ": ${{ steps." + gate + ".outcome }}");
    }
    for (const gate of ["build", "tests", "lifecycle", "rollout", "foundation", "artifacts"]) {
      bindings.push("V2_CI_RECORD_" + gate.toUpperCase() + ": ${{ steps.record_" + gate + ".outcome }}",
        "V2_CI_PHASE_" + gate.toUpperCase() + ": ${{ steps.record_" + gate + ".outputs.receipt }}");
    }
    run = VERIFY_QUALIFICATION_CLOSURE;
  }
  return compactStep(["name: " + name, ...(id ? ["id: " + id] : []), "shell: pwsh", "env:",
    ...bindings, "run: |", run].join("\n"));
}

// Literal reviewed policies; fixtures independently spell out the owner bytes.
const ROLE_POLICY = {
  pr: {
    header: [
      "name: CI",
      "on:",
      "push:",
      "branches:",
      "- main",
      "pull_request:",
      "workflow_dispatch:",
      "permissions:",
      "contents: read",
      "concurrency:",
      "group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}",
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
].join("\n"),
    jobs: [
      {
        id: "release-gates",
        header: [
          "release-gates:",
          "name: Node ${{ matrix.node-version }} on ${{ matrix.os }}",
          "runs-on: ${{ matrix.os }}",
          "strategy:",
          "fail-fast: false",
          "matrix:",
          "os:",
          "- ubuntu-latest",
          "- windows-latest",
          "node-version:",
          "- \"24.16.0\"",
].join("\n"),
        steps: [
          [
            "name: Check out repository",
            "uses: actions/checkout@v6",
            "with:",
            "fetch-depth: 0",
].join("\n"),
          [
            "name: Set up Node.js",
            "uses: actions/setup-node@v6",
            "with:",
            "node-version: ${{ matrix.node-version }}",
].join("\n"),
          [
            "name: Check installation policy",
            "run: node scripts/check-build-installation.js before",
].join("\n"),
          [
            "name: Install dependencies",
            "run: npm ci --ignore-scripts --include=dev --include=optional",
].join("\n"),
          [
            "name: Check installation capability",
            "run: node scripts/check-build-installation.js after",
].join("\n"),
          [
            "name: Check runtime capabilities",
            "run: npm run check:runtime",
].join("\n"),
          [
            "name: Typecheck",
            "run: npm run typecheck",
].join("\n"),
          [
            "name: Build",
            "run: npm run build",
].join("\n"),
          [
            "name: Require immutable lifecycle base commit",
            "run: git cat-file -e \"0e375d4643d4b630f36f874a3bb192e96739ac46^{commit}\"",
].join("\n"),
          [
            "name: Protect Version 1 production routing",
            "run: git diff --exit-code 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services",
].join("\n"),
          [
            "name: Run tests",
            "run: npm test",
].join("\n"),
        ],
      },
      {
        id: "minimum-runtime-rejection",
        header: [
          "minimum-runtime-rejection:",
          "name: Reject Node 22.22.3",
          "runs-on: ubuntu-latest",
].join("\n"),
        steps: [
          [
            "name: Check out repository",
            "uses: actions/checkout@v6",
            "with:",
            "fetch-depth: 0",
].join("\n"),
          [
            "name: Set up Node.js 22.22.3",
            "uses: actions/setup-node@v6",
            "with:",
            "node-version: \"22.22.3\"",
].join("\n"),
          [
            "name: Require the documented minimum-runtime rejection",
            "shell: bash",
            "run: |",
            "set +e",
            "output=\"$(node scripts/check-runtime.js --json 2>&1)\"",
            "status=$?",
            "set -e",
            "printf '%s\\n' \"$output\"",
            "expected='{\"ok\":false,\"code\":\"SQLITE_CAPABILITY_MISSING\",\"message\":\"Node 22.22.3 is below 24.16.0\"}'",
            "if [[ \"$status\" -ne 1 ]]; then",
            "echo \"Expected check-runtime to exit 1, received $status\" >&2",
            "exit 1",
            "fi",
            "if [[ \"$output\" != \"$expected\" ]]; then",
            "echo \"check-runtime did not emit the exact documented rejection\" >&2",
            "exit 1",
            "fi",
].join("\n"),
        ],
      },
    ],
  },
  release: {
    header: [
      "name: V2 release qualification",
      "on:",
      "workflow_dispatch:",
      "inputs:",
      "candidate_sha:",
      "description: Full candidate commit SHA",
      "required: true",
      "type: string",
      "approved_workflow_sha:",
      "description: Approved workflow control commit SHA",
      "required: true",
      "type: string",
      "permissions:",
      "contents: read",
].join("\n"),
    jobs: [
      {
        id: "qualification",
        header: [
          "qualification:",
          "name: V2 release qualification on ${{ matrix.os }}",
          "runs-on: ${{ matrix.os }}",
          "strategy:",
          "fail-fast: false",
          "matrix:",
          "os:",
          "- ubuntu-latest",
          "- windows-latest",
          "node-version:",
          "- \"24.16.0\"",
].join("\n"),
        steps: [
          [
            "name: Validate qualification inputs",
            "shell: pwsh",
            "env:",
            "V2_CI_CANDIDATE_SHA: ${{ inputs.candidate_sha }}",
            "V2_CI_APPROVED_WORKFLOW_SHA: ${{ inputs.approved_workflow_sha }}",
            "V2_CI_CONTROL_SHA: ${{ github.workflow_sha }}",
            "run: |",
            "$ErrorActionPreference = \"Stop\"",
            "foreach ($key in @(\"V2_CI_CANDIDATE_SHA\", \"V2_CI_APPROVED_WORKFLOW_SHA\", \"V2_CI_CONTROL_SHA\")) {",
            "$value = [Environment]::GetEnvironmentVariable($key)",
            "if ($value -cnotmatch '\\A[0-9a-fA-F]{40}\\z') { throw \"V2_CI_IDENTITY_INVALID\" }",
            "}",
            "if ($env:V2_CI_CONTROL_SHA.ToLowerInvariant() -cne $env:V2_CI_APPROVED_WORKFLOW_SHA.ToLowerInvariant()) {",
            "throw \"V2_CI_CONTROL_UNAPPROVED\"",
            "}",
].join("\n"),
          [
            "name: Check out repository",
            "uses: actions/checkout@v6",
            "with:",
            "fetch-depth: 0",
            "ref: ${{ inputs.candidate_sha }}",
].join("\n"),
          [
            "name: Verify candidate and workflow identity",
            "shell: pwsh",
            "env:",
            "V2_CI_CANDIDATE_SHA: ${{ inputs.candidate_sha }}",
            "V2_CI_APPROVED_WORKFLOW_SHA: ${{ inputs.approved_workflow_sha }}",
            "V2_CI_CONTROL_SHA: ${{ github.workflow_sha }}",
            "run: |",
            "$ErrorActionPreference = \"Stop\"",
            "$head = & git rev-parse HEAD",
            "if ($LASTEXITCODE -ne 0) { throw \"V2_CI_HEAD_UNAVAILABLE\" }",
            "if ($head -cne $env:V2_CI_CANDIDATE_SHA.ToLowerInvariant()) { throw \"V2_CI_CANDIDATE_MISMATCH\" }",
            "& git cat-file -e \"$($env:V2_CI_CONTROL_SHA)^{commit}\"",
            "if ($LASTEXITCODE -ne 0) { throw \"V2_CI_CONTROL_UNAVAILABLE\" }",
            "foreach ($path in @(\".github/workflows/ci.yml\", \".github/workflows/v2-release-qualification.yml\", \".github/workflows/v2-legacy-regression.yml\", \".github/workflows/sqlite-stress.yml\")) {",
            "$candidateBlob = & git rev-parse \"$($env:V2_CI_CANDIDATE_SHA):$path\"",
            "if ($LASTEXITCODE -ne 0) { throw \"V2_CI_CANDIDATE_WORKFLOW_UNAVAILABLE\" }",
            "$controlBlob = & git rev-parse \"$($env:V2_CI_CONTROL_SHA):$path\"",
            "if ($LASTEXITCODE -ne 0) { throw \"V2_CI_CONTROL_WORKFLOW_UNAVAILABLE\" }",
            "if ($candidateBlob -cne $controlBlob) { throw \"V2_CI_WORKFLOW_MISMATCH\" }",
            "}",
].join("\n"),
          [
            "name: Set up Node.js",
            "uses: actions/setup-node@v6",
            "with:",
            "node-version: ${{ matrix.node-version }}",
].join("\n"),
          qualificationRecordPolicy("Record qualification identity", "identity"),
          [
            "name: Check installation policy",
            "id: installation_policy",
            "run: node scripts/check-build-installation.js before",
].join("\n"),
          [
            "name: Install dependencies",
            "id: installation",
            "run: npm ci --ignore-scripts --include=dev --include=optional",
].join("\n"),
          [
            "name: Check installation capability",
            "id: installation_capability",
            "run: node scripts/check-build-installation.js after",
].join("\n"),
          [
            "name: Check runtime capabilities",
            "id: runtime",
            "run: npm run check:runtime",
].join("\n"),
          [
            "name: Typecheck",
            "id: typecheck",
            "run: npm run typecheck",
].join("\n"),
          [
            "name: Build",
            "id: build",
            "run: npm run build",
].join("\n"),
          qualificationRecordPolicy("Record build identity", "record_build", "build"),
          [
            "name: Require immutable lifecycle base commit",
            "run: git cat-file -e \"0e375d4643d4b630f36f874a3bb192e96739ac46^{commit}\"",
].join("\n"),
          [
            "name: Protect Version 1 production routing",
            "run: git diff --exit-code 0e375d4643d4b630f36f874a3bb192e96739ac46 -- src/app.ts src/index.ts src/controllers src/schemas src/services",
].join("\n"),
          [
            "name: Run tests",
            "id: tests",
            "run: npm test",
].join("\n"),
          qualificationRecordPolicy("Record tests identity", "record_tests", "tests"),
          [
            "name: Run lifecycle release gates",
            "id: lifecycle",
            "run: npm run test:subproject-2",
].join("\n"),
          qualificationRecordPolicy("Record lifecycle identity", "record_lifecycle", "lifecycle"),
          [
            "name: Run V2 rollout control-plane gate",
            "id: rollout",
            "run: npm run test:rollout-control-plane",
].join("\n"),
          qualificationRecordPolicy("Record rollout identity", "record_rollout", "rollout"),
          [
            "name: Run V2 fresh-start foundation gate",
            "id: foundation",
            "run: npm run test:v2-fresh-start-foundation",
].join("\n"),
          qualificationRecordPolicy("Record foundation identity", "record_foundation", "foundation"),
          [
            "name: Test build artifacts",
            "id: artifacts",
            "run: npm run test:build-artifacts",
].join("\n"),
          qualificationRecordPolicy("Record artifacts identity", "record_artifacts", "artifacts"),
          qualificationRecordPolicy("Verify qualification closure", null),
        ],
      },
    ],
  },
  legacy: {
    header: [
      "name: V2 legacy regression",
      "on:",
      "workflow_dispatch:",
      "permissions:",
      "contents: read",
].join("\n"),
    jobs: [
      {
        id: "legacy-regression",
        header: [
          "legacy-regression:",
          "name: V2 legacy regression Node ${{ matrix.node-version }} on ${{ matrix.os }}",
          "runs-on: ${{ matrix.os }}",
          "strategy:",
          "fail-fast: false",
          "matrix:",
          "os:",
          "- ubuntu-latest",
          "- windows-latest",
          "node-version:",
          "- \"24.16.0\"",
].join("\n"),
        steps: [
          [
            "name: Check out repository",
            "uses: actions/checkout@v6",
            "with:",
            "fetch-depth: 0",
].join("\n"),
          [
            "name: Set up Node.js",
            "uses: actions/setup-node@v6",
            "with:",
            "node-version: ${{ matrix.node-version }}",
].join("\n"),
          [
            "name: Check installation policy",
            "run: node scripts/check-build-installation.js before",
].join("\n"),
          [
            "name: Install dependencies",
            "run: npm ci --ignore-scripts --include=dev --include=optional",
].join("\n"),
          [
            "name: Check installation capability",
            "run: node scripts/check-build-installation.js after",
].join("\n"),
          [
            "name: Check runtime capabilities",
            "run: npm run check:runtime",
].join("\n"),
          [
            "name: Run V2 shadow migration gate",
            "env:",
            "V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT: ${{ runner.temp }}/v2-shadow-migration-functional/evidence.json",
            "run: npm run test:migration",
].join("\n"),
          [
            "name: Upload V2 shadow migration functional synthetic evidence",
            "uses: actions/upload-artifact@v7",
            "with:",
            "name: v2-shadow-migration-functional-synthetic-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}",
            "path: ${{ runner.temp }}/v2-shadow-migration-functional/evidence.json",
            "if-no-files-found: error",
            "retention-days: 14",
].join("\n"),
        ],
      },
    ],
  },
  stress: {
    header: [
      "name: SQLite Stress",
      "on:",
      "schedule:",
      "- cron: \"0 3 * * 1\"",
      "workflow_dispatch:",
      "permissions:",
      "contents: read",
      "concurrency:",
      "group: sqlite-stress",
      "cancel-in-progress: false",
].join("\n"),
    jobs: [
      {
        id: "stress",
        header: [
          "stress:",
          "name: SQLite stress on ${{ matrix.os }}",
          "runs-on: ${{ matrix.os }}",
          "strategy:",
          "fail-fast: false",
          "max-parallel: 1",
          "matrix:",
          "os:",
          "- ubuntu-latest",
          "- windows-latest",
].join("\n"),
        steps: [
          [
            "name: Check out repository",
            "uses: actions/checkout@v6",
            "with:",
            "fetch-depth: 0",
].join("\n"),
          [
            "name: Set up Node.js",
            "uses: actions/setup-node@v6",
            "with:",
            "node-version: \"24.16.0\"",
].join("\n"),
          [
            "name: Install dependencies",
            "shell: pwsh",
            "run: |",
            "$logPath = \"ci-logs/sqlite-stress-${{ matrix.os }}.log\"",
            "New-Item -ItemType Directory -Force -Path (Split-Path $logPath) | Out-Null",
            "Write-Output \"> node scripts/check-build-installation.js before\" | Tee-Object -FilePath $logPath -Append",
            "& node scripts/check-build-installation.js before 2>&1 | Tee-Object -FilePath $logPath -Append",
            "$commandExitCode = $LASTEXITCODE",
            "if ($commandExitCode -ne 0) {",
            "exit $commandExitCode",
            "}",
            "Write-Output \"> npm ci --ignore-scripts --include=dev --include=optional\" | Tee-Object -FilePath $logPath -Append",
            "& npm ci --ignore-scripts --include=dev --include=optional 2>&1 | Tee-Object -FilePath $logPath -Append",
            "$commandExitCode = $LASTEXITCODE",
            "if ($commandExitCode -ne 0) {",
            "exit $commandExitCode",
            "}",
            "Write-Output \"> node scripts/check-build-installation.js after\" | Tee-Object -FilePath $logPath -Append",
            "& node scripts/check-build-installation.js after 2>&1 | Tee-Object -FilePath $logPath -Append",
            "$commandExitCode = $LASTEXITCODE",
            "if ($commandExitCode -ne 0) {",
            "exit $commandExitCode",
            "}",
].join("\n"),
          [
            "name: Build tests",
            "shell: pwsh",
            "run: |",
            "$logPath = \"ci-logs/sqlite-stress-${{ matrix.os }}.log\"",
            "Write-Output \"> npm run test:build\" | Tee-Object -FilePath $logPath -Append",
            "& npm run test:build 2>&1 | Tee-Object -FilePath $logPath -Append",
            "$commandExitCode = $LASTEXITCODE",
            "if ($commandExitCode -ne 0) {",
            "exit $commandExitCode",
            "}",
].join("\n"),
          [
            "name: Run default and lifecycle concurrent, crash, and security tests",
            "shell: pwsh",
            "run: |",
            "$logPath = \"ci-logs/sqlite-stress-${{ matrix.os }}.log\"",
            "Write-Output \"> node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-store.concurrent.test.js dist-test/tests/event-store.crash.test.js dist-test/tests/lifecycle.concurrent.test.js dist-test/tests/lifecycle.crash.test.js dist-test/tests/lifecycle.security.test.js\" | Tee-Object -FilePath $logPath -Append",
            "& node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-store.concurrent.test.js dist-test/tests/event-store.crash.test.js dist-test/tests/lifecycle.concurrent.test.js dist-test/tests/lifecycle.crash.test.js dist-test/tests/lifecycle.security.test.js 2>&1 | Tee-Object -FilePath $logPath -Append",
            "$commandExitCode = $LASTEXITCODE",
            "if ($commandExitCode -ne 0) {",
            "exit $commandExitCode",
            "}",
].join("\n"),
          [
            "name: Run release stress test",
            "shell: pwsh",
            "run: |",
            "$logPath = \"ci-logs/sqlite-stress-${{ matrix.os }}.log\"",
            "Write-Output \"> npm run test:stress\" | Tee-Object -FilePath $logPath -Append",
            "& npm run test:stress 2>&1 | Tee-Object -FilePath $logPath -Append",
            "$commandExitCode = $LASTEXITCODE",
            "if ($commandExitCode -ne 0) {",
            "exit $commandExitCode",
            "}",
].join("\n"),
          [
            "name: Run lifecycle stress test",
            "shell: pwsh",
            "run: |",
            "$logPath = \"ci-logs/sqlite-stress-${{ matrix.os }}.log\"",
            "Write-Output \"> npm run test:lifecycle-stress\" | Tee-Object -FilePath $logPath -Append",
            "& npm run test:lifecycle-stress 2>&1 | Tee-Object -FilePath $logPath -Append",
            "$commandExitCode = $LASTEXITCODE",
            "if ($commandExitCode -ne 0) {",
            "exit $commandExitCode",
            "}",
].join("\n"),
          [
            "name: Upload stress logs",
            "if: ${{ always() }}",
            "uses: actions/upload-artifact@v7",
            "with:",
            "name: sqlite-stress-logs-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}",
            "path: ci-logs/sqlite-stress-${{ matrix.os }}.log",
            "if-no-files-found: error",
            "retention-days: 14",
].join("\n"),
        ],
      },
    ],
  },
} as const;

export function requiredStep(yaml: string, jobId: string, stepName: string): WorkflowStep {
  assertCanonicalWorkflowGrammar(yaml, "workflow");
  assertWorkflowStructure(yaml, true);
  const job = workflowJobs(yaml).get(jobId);
  assert.ok(job, `missing workflow job: ${jobId}`);
  assertNoJobBypass(job, `${jobId} job`);
  const step = requiredJobStep(job, stepName);
  return { ...step, ownerJob: jobId };
}

export function assertCiWorkflowSet(workflows: CiWorkflowSet): void {
  assert.deepEqual(Object.keys(workflows).sort(), ["legacy", "pr", "release", "stress"], "exactly four CI workflow owners required");
  for (const role of ["pr", "release", "legacy", "stress"] as const) {
    const yaml = workflows[role];
    assert.equal(typeof yaml, "string", `${role} workflow must be a string`);
    assert.ok(yaml.trim(), `missing ${role} workflow`);
    assertCanonicalWorkflowGrammar(yaml, `${role} workflow`);
    const scalars = assertWorkflowStructure(yaml, true);
    assert.equal(scalars.get("permissions/contents"), "read", "contents permission must remain read");
    if (role === "release") {
      for (const input of ["candidate_sha", "approved_workflow_sha"]) {
        assert.equal(scalars.get(`on/workflow_dispatch/inputs/${input}/required`), "true");
        assert.equal(scalars.get(`on/workflow_dispatch/inputs/${input}/type`), "string");
      }
    }
    const policy = ROLE_POLICY[role];
    const jobsMarker = yaml.indexOf("\njobs:\n");
    assert.ok(jobsMarker >= 0, `${role} requires its explicit jobs mapping`);
    assert.equal(compactStep(yaml.slice(0, jobsMarker)), policy.header, `${role} trigger/permission/concurrency policy`);
    const jobs = workflowJobs(yaml);
    assert.deepEqual([...jobs.keys()], policy.jobs.map(job => job.id), `${role} job owners`);
    for (const owner of policy.jobs) {
      const job = jobs.get(owner.id)!;
      assertNoJobBypass(job, `${owner.id} job`);
      assert.equal(compactStep(job.slice(0, job.indexOf("    steps:\n"))), owner.header, `${role}/${owner.id} matrix and check identity`);
      const steps = workflowSteps(job, owner.id);
      const names = steps.map(step => step.name);
      assert.ok(names.every(name => name !== null), "every executable step must be named");
      assert.equal(new Set(names).size, names.length, "duplicate executable step name");
      for (const step of steps) {
        if (role !== "stress" || step.name !== "Upload stress logs") requiredJobStep(job, step.name!);
        assert.equal(yamlScalar(step.body, "continue-on-error"), null, "no step may suppress failures");
      }
      assert.deepEqual(steps.map(step => compactStep(step.body)), owner.steps,
        `${role}/${owner.id} exact unconditional action inputs, identity checks and gate order`);
    }
  }
}
