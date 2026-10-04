import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertCiWorkflowSet, requiredStep, type WorkflowStep } from "./support/ci-workflow-contract.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const workflowPaths = [".github/workflows/ci.yml", ".github/workflows/v2-release-qualification.yml",
  ".github/workflows/v2-legacy-regression.yml", ".github/workflows/sqlite-stress.yml"];
const release = readFileSync(join(repo, workflowPaths[1]!), "utf8").replace(/\r\n?/g, "\n");
const git = process.platform === "win32" ? "C:/Program Files/Git/cmd/git.exe" : "git";
const powershell = process.platform === "win32"
  ? "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" : "pwsh";
const phases = ["build", "tests", "lifecycle", "rollout", "foundation", "artifacts"];
const gates = ["runtime", "typecheck", ...phases];
const artifactPaths = ["v2.js", "v2-admin.js", "workers/project-store.worker.js",
  "internal/v2-internal-verified-read.js", "internal/v2-internal-verified-read-cleanup.js"];

function gitRun(root: string, ...args: string[]): string {
  const result = spawnSync(git, args, { cwd: root, encoding: "utf8", windowsHide: true,
    timeout: 20000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function qualificationFixture(): { root: string; candidate: string; control: string; cleanup(): void } {
  const root = resolve(realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "ci-identity-"))));
  try {
    gitRun(root, "init", "--quiet");
    gitRun(root, "config", "user.name", "Synthetic qualification");
    gitRun(root, "config", "user.email", "qualification@example.invalid");
    gitRun(root, "config", "core.autocrlf", "false");
    for (const path of workflowPaths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), readFileSync(join(repo, path)));
    }
    writeFileSync(join(root, "package-lock.json"), '{"synthetic":true}\n');
    writeFileSync(join(root, ".gitignore"), "dist/\ndist-test/\nreceipt.out\ninstall.sentinel\n");
    gitRun(root, "add", ".");
    gitRun(root, "commit", "--quiet", "-m", "synthetic control");
    const control = gitRun(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "candidate.txt"), "distinct candidate\n");
    gitRun(root, "add", "candidate.txt");
    gitRun(root, "commit", "--quiet", "-m", "synthetic candidate");
    const candidate = gitRun(root, "rev-parse", "HEAD");
    assert.notEqual(candidate, control);
    return { root, candidate, control, cleanup() { rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
type Fixture = ReturnType<typeof qualificationFixture>;
function body(step: WorkflowStep): string {
  const match = /^ {8}run: \|\n([\s\S]*)/m.exec(step.body);
  assert.ok(match, "trusted inline run body required");
  return match[1]!.trimEnd().split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}
function step(name: string): WorkflowStep { return requiredStep(release, "qualification", name); }
function envFor(f: Fixture): Record<string, string> {
  return { V2_CI_CANDIDATE_SHA: f.candidate, V2_CI_APPROVED_WORKFLOW_SHA: f.control,
    V2_CI_CONTROL_SHA: f.control, V2_CI_OS: "windows-latest", V2_CI_RUN_ID: "12345",
    V2_CI_RUN_ATTEMPT: "1", GITHUB_OUTPUT: join(f.root, "receipt.out") };
}
function runInline(inline: WorkflowStep, fixture: Fixture, env: Record<string, string>): {
  status: number | null; stdout: string; stderr: string;
} {
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) if (key.startsWith("V2_CI_")) delete cleanEnv[key];
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", body(inline)], { cwd: fixture.root, encoding: "utf8", windowsHide: true,
    timeout: 20000, maxBuffer: 1024 * 1024,
    env: { ...cleanEnv, ...env, PATH: dirname(git) + (process.platform === "win32" ? ";" : ":") + process.env.PATH } });
  assert.equal(result.error, undefined, "native fixture must complete within its bound");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function refuse(result: ReturnType<typeof runInline>, code: string): void {
  assert.notEqual(result.status, 0, "native qualification refusal required");
  assert.notEqual(result.status, null, "refusal must have a native exit");
  assert.ok((result.stderr + result.stdout).includes(code), code);
}
function installAfter(inline: WorkflowStep, f: Fixture, env: Record<string, string>) {
  return runInline({ ...inline, body: inline.body.trimEnd()
    + '\n          [IO.File]::WriteAllText("install.sentinel", "ran")\n' }, f, env);
}
function receipt(f: Fixture): string {
  const lines = readFileSync(join(f.root, "receipt.out"), "utf8").trim().split(/\r?\n/);
  const last = lines.at(-1)!;
  assert.ok(last.startsWith("receipt="));
  return last.slice("receipt=".length);
}
function outputs(f: Fixture, generation: string, compiled?: string): void {
  mkdirSync(join(f.root, "dist"), { recursive: true });
  const artifacts = artifactPaths.map(path => {
    mkdirSync(dirname(join(f.root, "dist", path)), { recursive: true });
    writeFileSync(join(f.root, "dist", path), generation + ":" + path);
    return { path, bytes: Buffer.byteLength(generation + ":" + path), sha256: "not-validator-authority" };
  });
  writeFileSync(join(f.root, "dist/v2-build.json"), JSON.stringify({ schemaVersion: 1,
    deploymentId: generation, artifacts }));
  if (compiled !== undefined) {
    mkdirSync(join(f.root, "dist-test/tests"), { recursive: true });
    writeFileSync(join(f.root, "dist-test/tests/probe.js"), compiled);
  }
}
function begin(f: Fixture): Record<string, string> {
  const env = envFor(f);
  const result = runInline(step("Record qualification identity"), f, env);
  assert.equal(result.status, 0, result.stderr);
  const identity = receipt(f);
  const parsed = JSON.parse(identity);
  assert.deepEqual(Object.keys(parsed).sort(), ["attempt", "candidate", "control", "lock", "os", "run", "schema"]);
  assert.equal(parsed.candidate, f.candidate);
  assert.equal(parsed.control, f.control);
  assert.equal(parsed.lock, gitRun(f.root, "rev-parse", f.candidate + ":package-lock.json"));
  return { ...env, V2_CI_IDENTITY: identity };
}
function complete(f: Fixture): Record<string, string> {
  const env = begin(f);
  for (const gate of gates) env["V2_CI_OUTCOME_" + gate.toUpperCase()] = "success";
  for (const phase of phases) {
    outputs(f, phase === "artifacts" ? "generation-two" : "generation-one",
      phase === "build" ? undefined : "compiled:" + phase);
    const result = runInline(step("Record " + phase + " identity"), f, { ...env, V2_CI_PHASE: phase });
    assert.equal(result.status, 0, result.stderr);
    const value = receipt(f);
    const parsed = JSON.parse(value);
    assert.equal(parsed.phase, phase);
    assert.deepEqual(parsed.identity, JSON.parse(env.V2_CI_IDENTITY!));
    assert.equal(parsed.compiled === null, phase === "build");
    env["V2_CI_PHASE_" + phase.toUpperCase()] = value;
    env["V2_CI_RECORD_" + phase.toUpperCase()] = "success";
  }
  return env;
}

test("CI qualification accepts distinct candidate and control before synthetic installation", () => {
  const f = qualificationFixture();
  try {
    const env = envFor(f);
    assert.equal(runInline(step("Validate qualification inputs"), f, env).status, 0);
    const result = installAfter(step("Verify candidate and workflow identity"), f, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.root, "install.sentinel"), "utf8"), "ran");
  } finally { f.cleanup(); }
});

for (const value of ["", "a".repeat(39), "a".repeat(41), " main ", "main", "a".repeat(40) + " ",
  "\n" + "a".repeat(40), "a".repeat(40) + "\r\n", "'; Write-Output forged; #"]) {
  for (const key of ["V2_CI_CANDIDATE_SHA", "V2_CI_APPROVED_WORKFLOW_SHA", "V2_CI_CONTROL_SHA"]) {
    test("CI qualification refuses malformed " + key + " " + JSON.stringify(value), () => {
      const f = qualificationFixture();
      try {
        refuse(installAfter(step("Validate qualification inputs"), f, { ...envFor(f), [key]: value }), "V2_CI_IDENTITY_INVALID");
        assert.equal(existsSync(join(f.root, "install.sentinel")), false);
      } finally { f.cleanup(); }
    });
  }
}
test("CI qualification refuses unapproved control and accepts uppercase normalized pins", () => {
  const f = qualificationFixture();
  try {
    refuse(installAfter(step("Validate qualification inputs"), f,
      { ...envFor(f), V2_CI_APPROVED_WORKFLOW_SHA: f.candidate }), "V2_CI_CONTROL_UNAPPROVED");
    assert.equal(existsSync(join(f.root, "install.sentinel")), false);
    const env = { ...envFor(f), V2_CI_CANDIDATE_SHA: f.candidate.toUpperCase(),
      V2_CI_CONTROL_SHA: f.control.toUpperCase(), V2_CI_APPROVED_WORKFLOW_SHA: f.control.toUpperCase() };
    assert.equal(runInline(step("Validate qualification inputs"), f, env).status, 0);
    assert.equal(runInline(step("Verify candidate and workflow identity"), f, env).status, 0);
  } finally { f.cleanup(); }
});
for (const kind of ["wrong-head", "swapped", "missing-control", "changed-blob", "missing-blob", "missing-candidate-blob"]) {
  test("CI qualification refuses " + kind + " before synthetic installation", () => {
    const f = qualificationFixture();
    try {
      const env = envFor(f);
      let code = "V2_CI_CANDIDATE_MISMATCH";
      if (kind === "wrong-head") gitRun(f.root, "checkout", "--quiet", f.control);
      if (kind === "swapped") {
        env.V2_CI_CANDIDATE_SHA = f.control; env.V2_CI_CONTROL_SHA = f.candidate;
        env.V2_CI_APPROVED_WORKFLOW_SHA = f.candidate;
      }
      if (kind === "missing-control") {
        env.V2_CI_CONTROL_SHA = "0".repeat(40); code = "V2_CI_CONTROL_UNAVAILABLE";
      }
      if (kind === "changed-blob" || kind === "missing-blob") {
        gitRun(f.root, "checkout", "--quiet", f.control);
        const path = workflowPaths[0]!;
        if (kind === "changed-blob") writeFileSync(join(f.root, path), "name: changed\n");
        else rmSync(join(f.root, path));
        gitRun(f.root, "add", path); gitRun(f.root, "commit", "--quiet", "-m", "hostile control");
        env.V2_CI_CONTROL_SHA = gitRun(f.root, "rev-parse", "HEAD");
        env.V2_CI_APPROVED_WORKFLOW_SHA = env.V2_CI_CONTROL_SHA;
        gitRun(f.root, "checkout", "--quiet", f.candidate);
        code = kind === "changed-blob" ? "V2_CI_WORKFLOW_MISMATCH" : "V2_CI_CONTROL_WORKFLOW_UNAVAILABLE";
      }
      if (kind === "missing-candidate-blob") {
        rmSync(join(f.root, workflowPaths[0]!)); gitRun(f.root, "add", workflowPaths[0]!);
        gitRun(f.root, "commit", "--quiet", "-m", "hostile candidate");
        env.V2_CI_CANDIDATE_SHA = gitRun(f.root, "rev-parse", "HEAD");
        code = "V2_CI_CANDIDATE_WORKFLOW_UNAVAILABLE";
      }
      refuse(installAfter(step("Verify candidate and workflow identity"), f, env), code);
      assert.equal(existsSync(join(f.root, "install.sentinel")), false);
    } finally { f.cleanup(); }
  });
}
function assertNativeGitExitFault(target: string): void {
  const f = qualificationFixture();
  try {
    const real = step("Verify candidate and workflow identity");
    // Real Git still runs and returns the matching HEAD; controlled wrapper adds
    // a failing native exit. Removing its check must make this assertion fail.
    // Bound an accidental function self-resolution before it can recurse again.
    const prefix = [
      "          $fixtureGitApplication = @(Get-Command -Name $env:V2_CI_FIXTURE_GIT -CommandType Application -ErrorAction Stop)[0].Path",
      "          $script:fixtureGitDepth = 0",
      "          function git {",
      '            if ($script:fixtureGitDepth -gt 0) { throw "V2_CI_FIXTURE_RECURSIVE_RESOLUTION" }',
      "            $script:fixtureGitDepth = 1",
      "            $fixtureGitOutput = & $fixtureGitApplication @args",
      '            if ($LASTEXITCODE -ne 0) { throw "V2_CI_FIXTURE_NATIVE_FAILURE" }',
      '            [IO.File]::WriteAllText($env:V2_CI_FIXTURE_NATIVE_PROOF, ($fixtureGitOutput -join "`n"))',
      "            $script:fixtureGitDepth = 0",
      "            $fixtureGitOutput",
      "            $global:LASTEXITCODE = 39",
      "          }",
      "",
    ].join("\n");
    const inject = (scriptBody: string): WorkflowStep => ({ ...real,
      body: scriptBody.replace('          $ErrorActionPreference = "Stop"\n',
        '          $ErrorActionPreference = "Stop"\n' + prefix) });
    const injected = inject(real.body);
    const proof = join(f.root, "native-git.proof");
    const env = { ...envFor(f), V2_CI_FIXTURE_GIT: target, V2_CI_FIXTURE_NATIVE_PROOF: proof };
    const result = installAfter(injected, f, env);
    assert.equal(existsSync(proof), true, "native Git application must return HEAD; recursive-resolution="
      + result.stderr.includes("V2_CI_FIXTURE_RECURSIVE_RESOLUTION"));
    assert.equal(readFileSync(proof, "utf8"), f.candidate);
    refuse(result, "V2_CI_HEAD_UNAVAILABLE");
    assert.doesNotMatch(result.stderr, /V2_CI_FIXTURE_(?:RECURSIVE_RESOLUTION|NATIVE_FAILURE)/);
    assert.equal(existsSync(join(f.root, "install.sentinel")), false);
    const fault = inject(real.body.replace(/          if \(\$LASTEXITCODE -ne 0\).*\n/g, ""));
    const falseAcceptance = installAfter(fault, f, env);
    assert.equal(falseAcceptance.status, 0, falseAcceptance.stderr);
    assert.throws(() => refuse(falseAcceptance, "V2_CI_HEAD_UNAVAILABLE"), /native qualification refusal required/);
    assert.equal(readFileSync(join(f.root, "install.sentinel"), "utf8"), "ran");
  } finally {
    f.cleanup();
    assert.equal(existsSync(f.root), false);
  }
}
test("CI qualification checks native Git failure despite matching stdout and owns a fault assertion", () => {
  assertNativeGitExitFault(git);
});
test("CI qualification bare Git target reaches native application before exit fault wrapping", () => {
  assertNativeGitExitFault("git");
});
test("CI qualification precheckout assertion detects an owned validation fault", () => {
  const f = qualificationFixture();
  try {
    const real = step("Validate qualification inputs");
    const fault = { ...real, body: real.body.replace(
      "          if ($value -cnotmatch '\\A[0-9a-fA-F]{40}\\z') { throw \"V2_CI_IDENTITY_INVALID\" }", "") };
    const env = { ...envFor(f), V2_CI_CANDIDATE_SHA: "main" };
    assert.throws(() => refuse(runInline(fault, f, env), "V2_CI_IDENTITY_INVALID"), /native qualification refusal required/);
  } finally { f.cleanup(); }
});

test("CI qualification records fresh phase identities and all successful native outcomes", () => {
  const f = qualificationFixture();
  try {
    const env = complete(f);
    const result = runInline(step("Verify qualification closure"), f, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(env.V2_CI_PHASE_BUILD!).deployment, "generation-one");
    assert.equal(JSON.parse(env.V2_CI_PHASE_ARTIFACTS!).deployment, "generation-two");
    assert.match(result.stdout, /V2_CI_QUALIFICATION_COMPLETE/);
  } finally { f.cleanup(); }
});
for (const outcome of ["", "skipped", "cancelled", "failure"]) {
  test("CI qualification refuses every incomplete product and recorder outcome " + JSON.stringify(outcome), () => {
    const f = qualificationFixture();
    try {
      const env = complete(f);
      for (const gate of gates) refuse(runInline(step("Verify qualification closure"), f,
        { ...env, ["V2_CI_OUTCOME_" + gate.toUpperCase()]: outcome }), "V2_CI_OUTCOME_INCOMPLETE");
      for (const phase of phases) refuse(runInline(step("Verify qualification closure"), f,
        { ...env, ["V2_CI_RECORD_" + phase.toUpperCase()]: outcome }), "V2_CI_OUTCOME_INCOMPLETE");
    } finally { f.cleanup(); }
  });
}
for (const kind of ["missing-phase", "cross-os", "cross-run", "cross-attempt", "cross-candidate", "cross-control",
  "stale-compiled", "stale-manifest", "stale-artifact", "old-artifact-generation", "changed-head", "changed-tracked-input"]) {
  test("CI qualification refuses " + kind + " at native closure", () => {
    const f = qualificationFixture();
    try {
      const env = complete(f);
      let code = "V2_CI_PHASE_INVALID";
      if (kind === "missing-phase") env.V2_CI_PHASE_LIFECYCLE = "";
      if (kind.startsWith("cross-")) {
        const key = kind.slice(6).replace("attempt", "attempt");
        const parsed = JSON.parse(env.V2_CI_PHASE_ROLLOUT!);
        parsed.identity[key] = key === "os" ? "ubuntu-latest" : key === "candidate" ? f.control : "999";
        env.V2_CI_PHASE_ROLLOUT = JSON.stringify(parsed);
      }
      if (kind === "stale-compiled") { writeFileSync(join(f.root, "dist-test/tests/probe.js"), "stale"); code = "V2_CI_OUTPUT_STALE"; }
      if (kind === "stale-manifest") { writeFileSync(join(f.root, "dist/v2-build.json"), "{}"); code = "V2_CI_OUTPUT_STALE"; }
      if (kind === "stale-artifact") { writeFileSync(join(f.root, "dist/v2.js"), "stale"); code = "V2_CI_OUTPUT_STALE"; }
      if (kind === "old-artifact-generation") {
        const parsed = JSON.parse(env.V2_CI_PHASE_ARTIFACTS!); parsed.deployment = "generation-one";
        env.V2_CI_PHASE_ARTIFACTS = JSON.stringify(parsed);
      }
      if (kind === "changed-head") { gitRun(f.root, "checkout", "--quiet", f.control); code = "V2_CI_CANDIDATE_MISMATCH"; }
      if (kind === "changed-tracked-input") { writeFileSync(join(f.root, "package-lock.json"), "{}"); code = "V2_CI_INPUT_CHANGED"; }
      refuse(runInline(step("Verify qualification closure"), f, env), code);
    } finally { f.cleanup(); }
  });
}
test("CI qualification strict policy refuses recorder omission, bypass, forged body and crossed binding", () => {
  const owners = { pr: readFileSync(join(repo, workflowPaths[0]!), "utf8").replace(/\r\n?/g, "\n"), release,
    legacy: readFileSync(join(repo, workflowPaths[2]!), "utf8").replace(/\r\n?/g, "\n"),
    stress: readFileSync(join(repo, workflowPaths[3]!), "utf8").replace(/\r\n?/g, "\n") };
  assertCiWorkflowSet(owners);
  for (const name of ["Record qualification identity", ...phases.map(value => "Record " + value + " identity"), "Verify qualification closure"]) {
    const target = step(name);
    const block = "      -" + target.body;
    for (const replacement of ["", block + block, block.replace("        shell:", "        if: true\n        shell:"),
      block.replace("        shell:", "        continue-on-error: true\n        shell:"),
      block.replace('          $ErrorActionPreference = "Stop"', "          Write-Output forged")]) {
      const changed = release.replace(block, replacement);
      assert.notEqual(changed, release);
      assert.throws(() => assertCiWorkflowSet({ ...owners, release: changed }), name);
    }
  }
  for (const from of ["steps.tests.outcome", "steps.record_artifacts.outputs.receipt", "github.run_attempt"]) {
    const changed = release.replace(from, "github.sha");
    assert.notEqual(changed, release);
    assert.throws(() => assertCiWorkflowSet({ ...owners, release: changed }));
  }
});
