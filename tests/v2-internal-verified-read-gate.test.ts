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
  return module.runVerifiedReadGate as (options: { root: string; timeoutMs?: number; signal?: AbortSignal; profile?: "metadata" | "native-content" }) => Promise<number>;
}
function fixture(fault = "") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "verified-read-gate-")));
  const pending: Promise<number>[] = []; const dispositions: boolean[] = [];
  const put = (name: string, code: string) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), code); };
  put("package.json", '{"type":"module"}');
  const record = `import {appendFileSync} from 'node:fs';const log=x=>appendFileSync('trace',x+'\\n');`;
  put("scripts/build.js", `${record}log('build');${fault === "build" ? "process.exit(17)" : fault === "hang" ? "setInterval(()=>{},1000)" : ""}`);
  put("node_modules/typescript/bin/tsc", `${record}log('compile');if(process.argv.slice(2).join(' ')!=='-p tsconfig.test.json')process.exit(91);${fault === "compile" ? "process.exit(23)" : ""}`);
  for (const name of names) put(`dist-test/tests/${name}.test.js`, `${record}import{test}from'node:test';test('${name}',()=>{log('${name}');${fault === "test" && name === names[3] ? "throw Error('fixture-native-test-failure')" : ""}});`);
  put("scripts/smoke-v2-fresh-start.js", `${record}log('smoke');${fault === "smoke" ? "process.exit(29)" : ""}`);
  return { root, trace: () => existsSync(join(root, "trace")) ? readFileSync(join(root, "trace"), "utf8").trim().split("\n") : [], put,
    run(run: Awaited<ReturnType<typeof gate>>, options: { timeoutMs?: number; signal?: AbortSignal; profile?: "metadata" | "native-content" } = {}) {
      const events: { cleanup?: string; closure?: string }[] = []; const write = process.stdout.write; let buffer = "";
      const preAborted = options.signal?.aborted === true;
      process.stdout.write = function (this: typeof process.stdout, chunk: any, ...args: any[]) {
        buffer += String(chunk); let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try { const value = JSON.parse(line); if (value.gate === "v2-internal-verified-read" && value.stage) events.push(value); } catch {}
        }
        return Reflect.apply(write, this, [chunk, ...args]);
      } as typeof process.stdout.write;
      const result = run({ root, ...options }).then(code => {
        dispositions.push((preAborted && events.length === 0 || events.length > 0
          && events.every(event => event.cleanup === "complete" && event.closure === "windows-job-active-zero"))
          && !existsSync(join(root, ".fresh-start-foundation.lock")));
        return code;
      }, cause => { dispositions.push(false); throw cause; }).finally(() => { process.stdout.write = write; });
      pending.push(result); return result;
    },
    async cleanup() {
      await Promise.allSettled(pending);
      // No stage proof, a retained/replaced lock or rejected disposition means preserve the entire owned root.
      if (pending.length && dispositions.length === pending.length && dispositions.every(Boolean)
        && !existsSync(join(root, ".fresh-start-foundation.lock"))) { rmSync(root, { recursive: true, force: true }); return true; }
      return false;
    },
    cleanupForeignMarkerOnly() {
      // This fixture creates the marker before invoking the gate, which refuses before launching any work.
      assert.equal(pending.length, 0); assert.equal(readFileSync(join(root, ".fresh-start-foundation.lock"), "utf8"), "foreign-output-owner");
      rmSync(root, { recursive: true, force: true });
    } };
}
test("gate builds once, compiles once, executes the exact twenty real test files serially even nested, then smoke", native, async () => {
  const run = await gate(), f = fixture();
  try { assert.equal(await f.run(run), 0); assert.deepEqual(f.trace(), ["build", "compile", ...names, "smoke"]);
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false); } finally { await f.cleanup(); }
  assert.equal(existsSync(f.root), false, "positive native closure permits owned fixture removal");
});
test("unexpected native startup uncertainty survives the positive fixture finalizer", native, async t => {
  const run = await gate(), f = fixture(); const original = childProcess.spawn; let attempted = false;
  t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof original>) => {
    if (args[2]?.cwd === f.root && args[1]?.some(arg => arg.endsWith("v2-verified-read-job.ps1"))) {
      attempted = true;
      // A real failed native creation; no live process is deleted to reproduce the unsafe finalizer.
      return original(join(f.root, "missing-native-job.exe"), args[1], args[2]);
    }
    return original(...args);
  }) as typeof original); syncBuiltinESMExports();
  try {
    await assert.rejects(async () => {
      try { assert.equal(await f.run(run), 0, "unexpected positive-fixture native failure"); }
      finally { await f.cleanup(); }
    }, { code: "ERR_ASSERTION" });
    assert.equal(attempted, true);
    assert.equal(existsSync(f.root), true, "positive fixture finalizer erased uncertain owned evidence");
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); t.diagnostic(`unexpected native startup uncertainty root ${existsSync(f.root) ? "retained" : "removed"}: ${f.root}`); }
});
for (const [fault, code, last] of [["build", 17, "build"], ["compile", 23, "compile"], ["test", 1, names[3]], ["smoke", 29, "smoke"]] as const)
  test(`gate propagates native ${fault} failure and stops subsequent stages`, native, async () => {
    const run = await gate(), f = fixture(fault);
    try { assert.equal(await f.run(run), code); assert.equal(f.trace().at(-1), last);
      assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false); } finally { await f.cleanup(); }
  });
test("shared output lock refuses another owner and leaves its bytes intact", async () => {
  const run = await gate(), f = fixture(); const lock = join(f.root, ".fresh-start-foundation.lock");
  try { writeFileSync(lock, "foreign-output-owner"); assert.equal(await run({ root: f.root }), 1);
    assert.deepEqual(f.trace(), []); assert.equal(readFileSync(lock, "utf8"), "foreign-output-owner"); } finally { f.cleanupForeignMarkerOnly(); }
});
test("pre-abort and cancellation stop owned children and release only positively closed output ownership", native, async () => {
  const run = await gate(), f = fixture("hang");
  f.put("scripts/build.js", "import{spawn}from'node:child_process';spawn(process.execPath,['-e',\"require('node:fs').writeFileSync('cancel-descendant-ready','ready');setInterval(()=>{},1000)\"],{stdio:'ignore',windowsHide:true,detached:true}).unref();setInterval(()=>{},1000);");
  try {
    const already = new AbortController(); already.abort(); assert.equal(await f.run(run, { signal: already.signal }), 130); assert.deepEqual(f.trace(), []);
    const controller = new AbortController(); const pending = f.run(run, { signal: controller.signal });
    try { await waitFor(() => existsSync(join(f.root, "cancel-descendant-ready"))); controller.abort(); assert.equal(await pending, 130); }
    finally { controller.abort(); await pending; }
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false);
  } finally { await f.cleanup(); }
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
  const started = performance.now(); const pending = f.run(run, { timeoutMs: 10000 });
  try {
    await waitFor(() => existsSync(join(f.root, "compile-ready")));
    assert.equal(events[0].stage, "build"); assert.equal(events[0].code, 0); assert.equal(events[0].closure, "windows-job-active-zero");
    assert.equal(await pending, 124); assert.deepEqual(f.trace(), ["build", "compile"]);
    assert.equal(events.at(-1).stage, "compile"); assert.equal(events.at(-1).closure, "windows-job-active-zero");
    assert.ok(performance.now() - started <= 15000, "stage startup reset the original total deadline or cleanup window");
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false);
  } finally { await f.cleanup(); mock.restoreAll(); }
});
test("native Windows DWORD build exit is preserved without signed conversion", native, async () => {
  const run = await gate(), f = fixture(); f.put("scripts/build.js", "process.exit(3221225477);");
  try { assert.equal(await f.run(run), 3221225477);
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false); }
  finally { await f.cleanup(); }
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
  const pending = f.run(run, { timeoutMs: 10000, signal: controller.signal });
  try { await waitFor(() => exitedAt !== undefined); assert.equal(await pending, 1);
    assert.ok(performance.now() - exitedAt! <= 5500, "native failure cleanup waited for a later response timeout/reset window");
    assert.deepEqual(f.trace(), ["build"]); assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), true);
  } finally { controller.abort(); await pending; t.mock.restoreAll(); syncBuiltinESMExports(); t.signal.removeEventListener("abort", cancel);
    t.diagnostic(`uncertain delayed-bridge fixture retained: ${f.root}; no owned-helper close proof inferred`); }
});
test("deadline terminates a genuinely ready detached descendant and confirms Job closure", native, async () => {
  const run = await gate(), f = fixture();
  f.put("scripts/build.js", "import{spawn}from'node:child_process';spawn(process.execPath,['-e',\"require('node:fs').writeFileSync('timeout-descendant-ready','ready');setInterval(()=>{},1000)\"],{stdio:'ignore',windowsHide:true,detached:true}).unref();setInterval(()=>{},1000);");
  const pending = f.run(run, { timeoutMs: 10000 });
  try { await waitFor(() => existsSync(join(f.root, "timeout-descendant-ready"))); assert.equal(await pending, 124);
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false); }
  finally { await f.cleanup(); }
});
test("changed output lock is refused and foreign replacement is preserved", native, async () => {
  const run = await gate(), f = fixture();
  f.put("scripts/build.js", "import{unlinkSync,writeFileSync}from'node:fs';unlinkSync('.fresh-start-foundation.lock');writeFileSync('.fresh-start-foundation.lock','replacement');process.exit(31);");
  try { assert.equal(await f.run(run), 1); assert.equal(readFileSync(join(f.root, ".fresh-start-foundation.lock"), "utf8"), "replacement"); }
  finally { await f.cleanup(); }
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
  const pending = f.run(run, { signal: controller.signal });
  try {
    await waitFor(() => existsSync(join(f.root, "descendant-ready")) && f.trace().includes("parent-exiting"));
    await waitFor(() => exits.length === 1); assert.equal(exits[0].code, 0); assert.ok(exits[0].activeProcesses > 0);
    f.put("descendant-check", "check"); await waitFor(() => existsSync(join(f.root, "descendant-ack")));
    assert.equal(events.length, 0, "build claimed closure while its actual detached descendant acknowledged being live");
    assert.deepEqual(f.trace(), ["build", "parent-exiting"], "original build advanced while its ready descendant remained unresolved");
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), true);
    f.put("descendant-release", "release"); assert.equal(await pending, 0);
    assert.deepEqual(f.trace(), ["build", "parent-exiting", "descendant-done", "compile", ...names, "smoke"]);
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false);
    assert.ok(events.every(value => value.closure === "windows-job-active-zero"));
  } finally {
    f.put("descendant-release", "release"); await pending;
    t.signal.removeEventListener("abort", cancel); t.mock.restoreAll();
    if (!await f.cleanup()) t.diagnostic(`RED/unconfirmed fixture retained: ${f.root}`);
  }
});
test("native-content loss of helper proof stops at original build and retains shared output ownership", { ...native, timeout: 20000 }, async t => {
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
  const pending = f.run(run, { timeoutMs: 10000, signal: controller.signal, profile: "native-content" });
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
  assert.equal(await f.run(run), 1); assert.deepEqual(f.trace(), []);
  assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), true);
  t.diagnostic(`unsupported-platform owned output fixture retained: ${f.root}; no native stage created`);
});
