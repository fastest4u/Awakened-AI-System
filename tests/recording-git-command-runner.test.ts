import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { SpawnSyncGitCommandRunner } from "../src/orchestrator/identity/git-workspace.resolver.js";
import { RecordingGitCommandRunner } from "./support/recording-git-command-runner.js";

function result(status: number | null = 0, stdout = "ok", stderr = "", error?: Error): ReturnType<typeof spawnSync> {
  return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null, error };
}
function sequence(values: readonly ReturnType<typeof spawnSync>[]) {
  const calls: Parameters<typeof spawnSync>[] = [];
  const spawn = ((...args: Parameters<typeof spawnSync>) => {
    calls.push(args);
    return values[Math.min(calls.length - 1, values.length - 1)]!;
  }) as typeof spawnSync;
  return { spawn, calls };
}
const timeout = () => Object.assign(new Error("bounded spawn timeout"), { code: "ETIMEDOUT" });

test("records both production timeout-then-success attempts with exact production spawn options", () => {
  const fixture = sequence([result(null, "", "", timeout()), result(0, "done", "")]);
  const runner = new RecordingGitCommandRunner(fixture.spawn);
  assert.deepEqual(runner.run("fixture-root", ["rev-parse", "--show-toplevel"]), { exitCode: 0, stdout: "done", stderr: "" });
  assert.equal(fixture.calls.length, 2);
  for (const call of fixture.calls) assert.deepEqual(call, ["git", ["rev-parse", "--show-toplevel"], {
    cwd: "fixture-root", encoding: "utf8", shell: false, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
  }]);
  const diagnostic = runner.diagnostic("bootstrap", "COMMAND_FAILED");
  assert.equal(diagnostic.probes.length, 2);
  assert.equal(diagnostic.probes[0]!.spawnError?.code, "ETIMEDOUT");
  assert.equal(diagnostic.probes[1]!.spawnError, null);
});

test("stops repeated timeouts after the production runner's two attempts", () => {
  const fixture = sequence([result(null, "", "", timeout())]);
  const runner = new RecordingGitCommandRunner(fixture.spawn);
  assert.deepEqual(runner.run("fixture-root", ["rev-parse"]), { exitCode: 1, stdout: "", stderr: "" });
  assert.equal(fixture.calls.length, 2);
  assert.equal(runner.diagnostic("binding", "COMMAND_FAILED").probes.length, 2);
});

test("does not retry other spawn errors or ordinary failed exits", () => {
  for (const value of [result(1, "", "", Object.assign(new Error("denied"), { code: "EACCES" })), result(128, "", "not-repository")]) {
    const fixture = sequence([value]);
    const runner = new RecordingGitCommandRunner(fixture.spawn);
    const expected = new SpawnSyncGitCommandRunner(sequence([value]).spawn).run("fixture-root", ["rev-parse"]);
    assert.deepEqual(runner.run("fixture-root", ["rev-parse"]), expected);
    assert.equal(fixture.calls.length, 1);
  }
});

test("delegates execution and returns the production result without diagnostic substitution", (t) => {
  const sentinel = Object.freeze({ exitCode: 128, stdout: "production", stderr: "result" });
  let calls = 0;
  t.mock.method(SpawnSyncGitCommandRunner.prototype, "run", (cwd: string, args: string[]) => {
    assert.equal(cwd, "fixture-root"); assert.deepEqual(args, ["rev-parse"]); calls++; return sentinel;
  });
  const runner = new RecordingGitCommandRunner(sequence([result()]).spawn);
  assert.equal(runner.run("fixture-root", ["rev-parse"]), sentinel);
  assert.equal(calls, 1);
});

test("bounds and freezes diagnostic snapshots without truncating production output", () => {
  const text = "x".repeat(9000);
  const fixture = sequence([result(1, text, text, Object.assign(new Error(text), { code: text }))]);
  const runner = new RecordingGitCommandRunner(fixture.spawn);
  const args = Array.from({ length: 10 }, () => text);
  const returned = runner.run(text, args);
  assert.equal(returned.exitCode, 1);
  assert.ok(returned.stdout === text && returned.stderr === text, "production output must remain untruncated");
  const before = runner.diagnostic("bootstrap", null);
  for (let i = 0; i < 20; i++) runner.run(text, args);
  const after = runner.diagnostic("binding", "COMMAND_FAILED");
  assert.equal(before.probes.length, 1);
  assert.equal(after.probes.length, 16);
  assert.equal(fixture.calls.length, 21);
  for (const probe of after.probes) {
    assert.equal(probe.argv.length, 8);
    assert.ok(probe.argv.every(arg => arg.length === 8192));
    for (const value of [probe.cwd, probe.stdout, probe.stderr, probe.spawnError!.message, probe.spawnError!.code]) assert.equal(value!.length, 8192);
    assert.ok(Object.isFrozen(probe) && Object.isFrozen(probe.argv) && Object.isFrozen(probe.spawnError));
  }
  assert.ok(Object.isFrozen(before) && Object.isFrozen(before.probes) && Object.isFrozen(after.probes));
});

test("retains NUL rejection in every captured diagnostic text field", () => {
  for (const field of ["cwd", "argv", "stdout", "stderr", "message", "code"] as const) {
    const value = "unsafe\0text";
    const fixture = sequence([result(1, field === "stdout" ? value : "", field === "stderr" ? value : "",
      Object.assign(new Error(field === "message" ? value : "error"), { code: field === "code" ? value : "EACCES" }))]);
    const runner = new RecordingGitCommandRunner(fixture.spawn);
    assert.throws(() => runner.run(field === "cwd" ? value : "fixture-root", [field === "argv" ? value : "rev-parse"]), /FIXTURE_GIT_PROBE_NUL/u);
  }
});
