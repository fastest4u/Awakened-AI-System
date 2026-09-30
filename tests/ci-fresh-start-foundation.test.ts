import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = join(root, "scripts/run-v2-fresh-start-foundation.js");
const targets = ["fresh-start-repository", "fresh-start-initializer", "fresh-start-control-plane",
  "fresh-start-admission", "v2-foundation-entry", "ci-fresh-start-foundation"];
const success = "PASS fresh-start foundation: six files completed";

function assertFoundationWorkflow(workflow: any) {
  const steps = workflow.jobs["release-gates"].steps as Record<string, unknown>[];
  const required = (name: string, run: string) => {
    const matches = steps.filter(step => step.name === name);
    assert.equal(matches.length, 1, `exactly one ${name}`);
    assert.deepEqual(matches[0], { name, run });
    return steps.indexOf(matches[0]!);
  };
  const typecheck = required("Typecheck", "npm run typecheck");
  const build = required("Build", "npm run build");
  const tests = required("Run tests", "npm test");
  const foundation = required("Run V2 fresh-start foundation gate", "npm run test:v2-fresh-start-foundation");
  const artifacts = required("Test build artifacts", "npm run test:build-artifacts");
  assert.equal(build, typecheck + 1); assert.equal(tests, build + 1);
  assert.equal(steps[foundation - 1]?.name, "Run V2 shadow migration gate"); assert.equal(artifacts, foundation + 1);
}

test("CI executes Foundation and builds before the full suite without bypasses", () => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  assertFoundationWorkflow(workflow);
  for (const mutation of ["missing", "duplicate", "skip", "ignore", "forged", "late-build"]) {
    const changed = structuredClone(workflow), steps = changed.jobs["release-gates"].steps;
    const gate = steps.find((step: any) => step.name === "Run V2 fresh-start foundation gate");
    if (mutation === "missing") steps.splice(steps.indexOf(gate), 1);
    if (mutation === "duplicate") steps.push({ ...gate });
    if (mutation === "skip") gate.if = "false";
    if (mutation === "ignore") gate["continue-on-error"] = true;
    if (mutation === "forged") gate.run = "echo passed";
    if (mutation === "late-build") {
      const build = steps.find((step: any) => step.name === "Build"); steps.splice(steps.indexOf(build), 1); steps.push(build);
    }
    assert.throws(() => assertFoundationWorkflow(changed), mutation);
  }
});

// Real child programs replace only the costly compiler/test workload. The gate,
// native exits, lock, process tree, deadlines and cleanup are not mocked.
function fixture(compiler = "", failingTest = false) {
  const path = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "foundation-gate-")));
  mkdirSync(join(path, "node_modules/typescript/bin"), { recursive: true });
  mkdirSync(join(path, "dist-test/tests"), { recursive: true });
  writeFileSync(join(path, "node_modules/typescript/bin/tsc"), `const fs=require('node:fs');
fs.appendFileSync('order.log','compile\\n');fs.writeFileSync('compiler.pid',String(process.pid));
${compiler}`);
  for (const [index, name] of targets.entries()) writeFileSync(join(path, `dist-test/tests/${name}.test.js`), `
const test=require('node:test'),fs=require('node:fs');
test(${JSON.stringify(name)},async()=>{fs.appendFileSync('order.log','start:${index}\\n');
await new Promise(r=>setTimeout(r,15));fs.appendFileSync('order.log','end:${index}\\n');
${failingTest && index === 0 ? "throw Error('controlled failure');" : ""}});`);
  const wrapper = join(path, "invoke.mjs");
  writeFileSync(wrapper, `import {runFoundationGate} from ${JSON.stringify(pathToFileURL(runner).href)};
const abort=new AbortController();
if(process.argv[3]==='cancel') { const fs=await import('node:fs');const timer=setInterval(()=>{
if(fs.existsSync(${JSON.stringify(join(path, "descendant.pid"))})){clearInterval(timer);abort.abort();}},10); }
process.exitCode=await runFoundationGate({root:${JSON.stringify(path)},timeoutMs:Number(process.argv[2]||10000),signal:abort.signal});`);
  return { path, wrapper, cleanup() { rmSync(path, { recursive: true, force: true }); } };
}
function run(f: ReturnType<typeof fixture>, ...args: string[]) {
  return spawnSync(process.execPath, [f.wrapper, ...args], { cwd: f.path, encoding: "utf8", timeout: 20000, windowsHide: true });
}
function unlocked(f: ReturnType<typeof fixture>) {
  assert.equal(existsSync(join(f.path, ".fresh-start-foundation.lock")), false);
}

test("Foundation package gate and compiled smoke are required", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts["test:v2-fresh-start-foundation"], "node scripts/run-v2-fresh-start-foundation.js", "missing focused Foundation gate");
  assert.equal(scripts["test:build-artifacts"], "npm run build && node scripts/smoke-worker.js && node scripts/smoke-v2-shadow-compatibility.js && node scripts/smoke-v2-fresh-start.js");
  for (const path of ["dist/v2.js", "dist/v2-admin.js", "dist/v2-build.json"]) assert.ok(existsSync(join(root, path)), path);
});

test("Foundation runner compiles once and completes exactly six test files serially", () => {
  const f = fixture();
  try {
    const result = run(f); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, new RegExp(success));
    assert.equal(readFileSync(join(f.path, "order.log"), "utf8"), "compile\n" + targets.map((_, i) => `start:${i}\nend:${i}\n`).join(""));
    unlocked(f);
  } finally { f.cleanup(); }
});

for (const compilerFailure of [true, false]) test(`Foundation runner propagates native ${compilerFailure ? "compiler" : "test"} failure without success`, () => {
  const f = fixture(compilerFailure ? "process.exit(23);" : "", !compilerFailure);
  try {
    const result = run(f); assert.equal(result.status, compilerFailure ? 23 : 1, result.stderr);
    if (!compilerFailure) assert.match(result.stdout, /controlled failure/);
    assert.ok(!result.stdout.includes(success)); unlocked(f);
    if (compilerFailure) assert.equal(readFileSync(join(f.path, "order.log"), "utf8"), "compile\n");
  } finally { f.cleanup(); }
});

for (const reason of ["timeout", "cancel"]) test(`Foundation runner bounds ${reason} and terminates its owned process tree`, () => {
  const f = fixture(`const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync('descendant.pid',String(child.pid));setInterval(()=>{},1000);`);
  try {
    const result = run(f, reason === "timeout" ? "1200" : "10000", reason);
    assert.equal(result.status, reason === "timeout" ? 124 : 130, result.stderr);
    assert.ok(!result.stdout.includes(success));
    for (const name of ["compiler.pid", "descendant.pid"]) {
      const pid = Number(readFileSync(join(f.path, name), "utf8"));
      assert.throws(() => process.kill(pid, 0), `${name} survived owned-tree cleanup`);
    }
    unlocked(f);
  } finally { f.cleanup(); }
});

test("Foundation gate refuses a competing output owner without stealing its lock", async () => {
  const f = fixture("setInterval(()=>{},1000);");
  const owner = spawn(process.execPath, [f.wrapper, "3000"], { cwd: f.path, stdio: "pipe", windowsHide: true });
  const completion = once(owner, "exit");
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.path, "compiler.pid"))) {
      assert.ok(Date.now() < deadline, "owner failed to start");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const result = run(f); assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /FOUNDATION_OUTPUT_BUSY/);
    assert.ok(existsSync(join(f.path, ".fresh-start-foundation.lock"))); assert.ok(!result.stdout.includes(success));
    assert.equal(readFileSync(join(f.path, "order.log"), "utf8"), "compile\n");
    assert.equal((await completion)[0], 124); unlocked(f);
  } finally {
    if (owner.exitCode === null) { owner.kill(); await completion; }
    f.cleanup();
  }
});

test("actual built Foundation smoke verifies prepared identity and closed public content", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts/smoke-v2-fresh-start.js")], { cwd: root, encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS built fresh-start: prepared identity, restart, redaction, content denial and archive isolation/);
});
