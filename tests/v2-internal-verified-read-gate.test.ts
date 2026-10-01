import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const waitFor = async (predicate: () => boolean) => {
  const until = performance.now() + 10000;
  while (!predicate()) { assert.ok(performance.now() < until, "native descendant readiness was not observed"); await new Promise(r => setTimeout(r, 10)); }
};
const native = { skip: process.platform !== "win32" };
const names = ["v2-internal-verified-read-contracts", "stable-directory-read-core", "projection-image-metadata",
  "v2-internal-verified-read-admission", "v2-internal-verified-read-child", "v2-internal-verified-read-cleanup",
  "v2-internal-verified-read-ownership", "v2-internal-verified-read-supervisor", "v2-internal-verified-read-entry",
  "v2-internal-verified-read-gate", "projection-manifest", "projection-integrity", "v2-reader-lease", "retrieval-candidates",
  "v2-retrieval-candidates", "fresh-start-admission", "sqlite-driver", "v2-foundation-entry", "ci-fresh-start-foundation", "event-append-transaction"];
async function gate() {
  const url = new URL("../../scripts/run-v2-internal-verified-read.js", import.meta.url).href;
  let module: any; try { module = await import(url); } catch (error) { if ((error as any).code !== "ERR_MODULE_NOT_FOUND") throw error; }
  assert.equal(typeof module?.runVerifiedReadGate, "function", "dedicated total-budget verified-read gate is absent");
  return module.runVerifiedReadGate as (options: { root: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<number>;
}
function fixture(fault = "") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "verified-read-gate-")));
  const put = (name: string, code: string) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), code); };
  put("package.json", '{"type":"module"}');
  const record = `import {appendFileSync} from 'node:fs';const log=x=>appendFileSync('trace',x+'\\n');`;
  put("scripts/build.js", `${record}log('build');${fault === "build" ? "process.exit(17)" : fault === "hang" ? "setInterval(()=>{},1000)" : ""}`);
  put("node_modules/typescript/bin/tsc", `${record}log('compile');if(process.argv.slice(2).join(' ')!=='-p tsconfig.test.json')process.exit(91);${fault === "compile" ? "process.exit(23)" : ""}`);
  for (const name of names) put(`dist-test/tests/${name}.test.js`, `${record}import{test}from'node:test';test('${name}',()=>{log('${name}');${fault === "test" && name === names[3] ? "throw Error('fixture-native-test-failure')" : ""}});`);
  put("scripts/smoke-v2-fresh-start.js", `${record}log('smoke');${fault === "smoke" ? "process.exit(29)" : ""}`);
  return { root, trace: () => existsSync(join(root, "trace")) ? readFileSync(join(root, "trace"), "utf8").trim().split("\n") : [],
    put, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test("gate builds once, compiles once, executes the exact twenty real test files serially even nested, then smoke", native, async () => {
  const run = await gate(), f = fixture();
  try { assert.equal(await run({ root: f.root }), 0); assert.deepEqual(f.trace(), ["build", "compile", ...names, "smoke"]);
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false); } finally { f.cleanup(); }
});
for (const [fault, code, last] of [["build", 17, "build"], ["compile", 23, "compile"], ["test", 1, names[3]], ["smoke", 29, "smoke"]] as const)
  test(`gate propagates native ${fault} failure and stops subsequent stages`, native, async () => {
    const run = await gate(), f = fixture(fault);
    try { assert.equal(await run({ root: f.root }), code); assert.equal(f.trace().at(-1), last);
      assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false); } finally { f.cleanup(); }
  });
test("shared output lock refuses another owner and leaves its bytes intact", async () => {
  const run = await gate(), f = fixture(); const lock = join(f.root, ".fresh-start-foundation.lock");
  try { writeFileSync(lock, "foreign-output-owner"); assert.equal(await run({ root: f.root }), 1);
    assert.deepEqual(f.trace(), []); assert.equal(readFileSync(lock, "utf8"), "foreign-output-owner"); } finally { f.cleanup(); }
});
test("pre-abort and cancellation stop owned children and release only positively closed output ownership", native, async () => {
  const run = await gate(), f = fixture("hang");
  f.put("scripts/build.js", "import{spawn}from'node:child_process';spawn(process.execPath,['-e',\"require('node:fs').writeFileSync('cancel-descendant-ready','ready');setInterval(()=>{},1000)\"],{stdio:'ignore',windowsHide:true,detached:true}).unref();setInterval(()=>{},1000);");
  try {
    const already = new AbortController(); already.abort(); assert.equal(await run({ root: f.root, signal: already.signal }), 130); assert.deepEqual(f.trace(), []);
    const controller = new AbortController(); const pending = run({ root: f.root, signal: controller.signal });
    try { await waitFor(() => existsSync(join(f.root, "cancel-descendant-ready"))); controller.abort(); assert.equal(await pending, 130); }
    finally { controller.abort(); await pending; }
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false);
  } finally { f.cleanup(); }
});
test("one total deadline includes earlier stages and timeout observes owned-process cleanup", native, async () => {
  const run = await gate(), f = fixture();
  f.put("scripts/build.js", "import{appendFileSync}from'node:fs';appendFileSync('trace','build\\n');await new Promise(r=>setTimeout(r,1000));");
  f.put("node_modules/typescript/bin/tsc", "import{appendFileSync,writeFileSync}from'node:fs';appendFileSync('trace','compile\\n');writeFileSync('compile-ready','ready');setInterval(()=>{},1000);");
  const events: any[] = []; const write = process.stdout.write.bind(process.stdout);
  const spy = ((chunk: any, ...args: any[]) => {
    for (const line of String(chunk).split("\n")) { try { const value = JSON.parse(line); if (value.stage) events.push(value); } catch {} }
    return (write as any)(chunk, ...args);
  }) as typeof process.stdout.write;
  const { mock } = await import("node:test"); mock.method(process.stdout, "write", spy);
  const started = performance.now(); const pending = run({ root: f.root, timeoutMs: 10000 }); let confirmed = false;
  try {
    await waitFor(() => existsSync(join(f.root, "compile-ready")));
    assert.equal(events[0].stage, "build"); assert.equal(events[0].code, 0); assert.equal(events[0].closure, "windows-job-active-zero");
    assert.equal(await pending, 124); confirmed = true; assert.deepEqual(f.trace(), ["build", "compile"]);
    assert.equal(events.at(-1).stage, "compile"); assert.equal(events.at(-1).closure, "windows-job-active-zero");
    assert.ok(performance.now() - started <= 15000, "stage startup reset the original total deadline or cleanup window");
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false);
  } finally { await pending; mock.restoreAll(); if (confirmed) f.cleanup(); }
});
test("native Windows DWORD build exit is preserved without signed conversion", native, async () => {
  const run = await gate(), f = fixture(); f.put("scripts/build.js", "process.exit(3221225477);");
  let confirmed = false;
  try { assert.equal(await run({ root: f.root }), 3221225477); confirmed = true;
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false); }
  finally { if (confirmed) f.cleanup(); }
});
test("native failure cleanup also bounds final owned bridge close without restarting its window", { ...native, timeout: 25000 }, async t => {
  const run = await gate(), f = fixture("build"); const source = readFileSync(new URL("../../scripts/v2-verified-read-job.ps1", import.meta.url), "utf8");
  const exit = "exit [V2VerifiedReadJob]::Run()"; assert.equal(source.split(exit).length, 2);
  f.put("delayed-job.ps1", source.replace(exit, "$result = [V2VerifiedReadJob]::Run()\nStart-Sleep -Seconds 30\nexit $result"));
  const original = childProcess.spawn; let exitedAt: number | undefined, frames = "", injected = false;
  t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof original>) => {
    const planned = args[1];
    if (injected || args[2]?.cwd !== f.root || !planned?.some(arg => arg.endsWith("v2-verified-read-job.ps1"))) return original(...args);
    injected = true;
    // A test-local fault in this owned bridge's final host shutdown, not a
    // production selector or fabricated Job proof. All native stage work runs.
    const child = original(args[0], planned.map(arg => arg.endsWith("v2-verified-read-job.ps1") ? join(f.root, "delayed-job.ps1") : arg), args[2]);
    child.stdout!.on("data", chunk => { frames += chunk.toString(); let end;
      while ((end = frames.indexOf("\n")) !== -1) { const line = frames.slice(0, end); frames = frames.slice(end + 1);
        try { const value = JSON.parse(line); if (value.kind === "direct-exit" && value.nativeCode === 17) exitedAt = performance.now(); } catch {} }
    }); return child;
  }) as typeof original); syncBuiltinESMExports();
  const controller = new AbortController(); const cancel = () => controller.abort(); t.signal.addEventListener("abort", cancel, { once: true });
  const pending = run({ root: f.root, timeoutMs: 10000, signal: controller.signal });
  try { await waitFor(() => exitedAt !== undefined); assert.equal(await pending, 1);
    assert.ok(performance.now() - exitedAt! <= 5500, "native failure cleanup waited for a later response timeout/reset window");
    assert.deepEqual(f.trace(), ["build"]); assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), true);
  } finally { controller.abort(); await pending; t.mock.restoreAll(); syncBuiltinESMExports(); t.signal.removeEventListener("abort", cancel);
    t.diagnostic(`uncertain delayed-bridge fixture retained: ${f.root}; no owned-helper close proof inferred`); }
});
test("deadline terminates a genuinely ready detached descendant and confirms Job closure", native, async () => {
  const run = await gate(), f = fixture();
  f.put("scripts/build.js", "import{spawn}from'node:child_process';spawn(process.execPath,['-e',\"require('node:fs').writeFileSync('timeout-descendant-ready','ready');setInterval(()=>{},1000)\"],{stdio:'ignore',windowsHide:true,detached:true}).unref();setInterval(()=>{},1000);");
  const pending = run({ root: f.root, timeoutMs: 10000 }); let confirmed = false;
  try { await waitFor(() => existsSync(join(f.root, "timeout-descendant-ready"))); assert.equal(await pending, 124); confirmed = true;
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false); }
  finally { await pending; if (confirmed) f.cleanup(); }
});
test("changed output lock is refused and foreign replacement is preserved", native, async () => {
  const run = await gate(), f = fixture();
  f.put("scripts/build.js", "import{unlinkSync,writeFileSync}from'node:fs';unlinkSync('.fresh-start-foundation.lock');writeFileSync('.fresh-start-foundation.lock','replacement');process.exit(31);");
  try { assert.equal(await run({ root: f.root }), 1); assert.equal(readFileSync(join(f.root, ".fresh-start-foundation.lock"), "utf8"), "replacement"); }
  finally { f.cleanup(); }
});
// Removing positive Job closure and advancing on direct close breaks this test:
// the build parent exits only after its real, redirected-output child is ready.
test("original build waits for confirmed descendant closure before compile and ownership release", { ...native, timeout: 90000 }, async t => {
  const run = await gate(), f = fixture();
  f.put("descendant.cjs", "const fs=require('node:fs');fs.writeFileSync('descendant-ready','ready');const timer=setInterval(()=>{if(fs.existsSync('descendant-check'))fs.writeFileSync('descendant-ack','alive');if(fs.existsSync('descendant-release')){clearInterval(timer);fs.appendFileSync('trace','descendant-done\\n');}},10);");
  f.put("scripts/build.js", "import{spawn}from'node:child_process';import{existsSync,appendFileSync}from'node:fs';appendFileSync('trace','build\\n');spawn(process.execPath,['descendant.cjs'],{stdio:'ignore',windowsHide:true,detached:true}).unref();while(!existsSync('descendant-ready'))await new Promise(r=>setTimeout(r,10));appendFileSync('trace','parent-exiting\\n');console.log(JSON.stringify({kind:'closure',nativeCode:0,activeProcesses:0}));process.exit(0);");
  const events: any[] = [], exits: any[] = []; const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", ((chunk: any, ...args: any[]) => {
    for (const line of String(chunk).split("\n")) { try { const value = JSON.parse(line); if (value.gate === "v2-internal-verified-read") {
      if (value.stage) events.push(value); else if (value.observation === "direct-child-exit") exits.push(value);
    } } catch {} }
    return (write as any)(chunk, ...args);
  }) as typeof process.stdout.write);
  const controller = new AbortController(); const cancel = () => controller.abort(); t.signal.addEventListener("abort", cancel, { once: true });
  const pending = run({ root: f.root, signal: controller.signal }); let confirmed = false;
  try {
    await waitFor(() => existsSync(join(f.root, "descendant-ready")) && f.trace().includes("parent-exiting"));
    await waitFor(() => exits.length === 1); assert.equal(exits[0].code, 0); assert.ok(exits[0].activeProcesses > 0);
    f.put("descendant-check", "check"); await waitFor(() => existsSync(join(f.root, "descendant-ack")));
    assert.equal(events.length, 0, "build claimed closure while its actual detached descendant acknowledged being live");
    assert.deepEqual(f.trace(), ["build", "parent-exiting"], "original build advanced while its ready descendant remained unresolved");
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), true);
    f.put("descendant-release", "release"); assert.equal(await pending, 0); confirmed = true;
    assert.deepEqual(f.trace(), ["build", "parent-exiting", "descendant-done", "compile", ...names, "smoke"]);
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false);
    assert.ok(events.every(value => value.closure === "windows-job-active-zero"));
  } finally {
    f.put("descendant-release", "release"); await pending;
    t.signal.removeEventListener("abort", cancel); t.mock.restoreAll();
    if (confirmed) f.cleanup(); else t.diagnostic(`RED/unconfirmed fixture retained: ${f.root}`);
  }
});
test("loss of native helper proof stops at original build and retains output ownership", { ...native, timeout: 20000 }, async t => {
  const run = await gate(), f = fixture();
  f.put("descendant.cjs", "const fs=require('node:fs');fs.writeFileSync('descendant-ready','ready');setInterval(()=>{if(fs.existsSync('descendant-check'))fs.writeFileSync('descendant-ack','alive');},10);");
  f.put("scripts/build.js", "import{spawn}from'node:child_process';import{existsSync,appendFileSync}from'node:fs';appendFileSync('trace','build\\n');spawn(process.execPath,['descendant.cjs'],{stdio:'ignore',windowsHide:true,detached:true}).unref();while(!existsSync('descendant-ready'))await new Promise(r=>setTimeout(r,10));appendFileSync('trace','parent-exiting\\n');process.exit(0);");
  const original = childProcess.spawn; let helper: ReturnType<typeof original> | undefined, directExit: any, frames = "";
  const controller = new AbortController(); const cancel = () => controller.abort(); t.signal.addEventListener("abort", cancel, { once: true });
  // Test-local fault injection keeps the actual ChildProcess/native handle, not
  // a PID oracle. No production selector or fixture-root behavior is added.
  t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof original>) => {
    const child = original(...args);
    if (!helper && args[2]?.cwd === f.root && args[1]?.some(arg => arg.endsWith("v2-verified-read-job.ps1"))) {
      helper = child; child.stdout!.on("data", chunk => {
        frames += chunk.toString(); let end;
        while ((end = frames.indexOf("\n")) !== -1) {
          const line = frames.slice(0, end); frames = frames.slice(end + 1);
          try { const value = JSON.parse(line); if (value.kind === "direct-exit") directExit = value; } catch {}
        }
      });
    }
    return child;
  }) as typeof original); syncBuiltinESMExports();
  const pending = run({ root: f.root, timeoutMs: 10000, signal: controller.signal });
  try {
    await waitFor(() => existsSync(join(f.root, "descendant-ready")) && f.trace().includes("parent-exiting"));
    await waitFor(() => directExit !== undefined); assert.equal(directExit.nativeCode, 0); assert.ok(directExit.activeProcesses > 0);
    f.put("descendant-check", "check"); await waitFor(() => existsSync(join(f.root, "descendant-ack")));
    assert.ok(helper, "supported native containment helper was not started"); assert.equal(helper.kill("SIGKILL"), true);
    assert.equal(await pending, 1); assert.deepEqual(f.trace(), ["build", "parent-exiting"]);
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), true);
  } finally {
    await pending; t.mock.restoreAll(); syncBuiltinESMExports(); t.signal.removeEventListener("abort", cancel);
    t.diagnostic(`uncertain original-build fixture retained: ${f.root}; no closure/reclamation inferred from helper exit`);
  }
});
test("unsupported non-Windows containment refuses before any native stage and retains its output lock", { skip: process.platform === "win32" }, async t => {
  const run = await gate(), f = fixture();
  assert.equal(await run({ root: f.root }), 1); assert.deepEqual(f.trace(), []);
  assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), true);
  t.diagnostic(`unsupported-platform owned output fixture retained: ${f.root}; no native stage created`);
});
