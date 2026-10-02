import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

const nativeNames = ["retrieval-database-core", "retrieval-selection-core", "v2-native-content-contracts", "v2-native-content-query",
  "v2-native-content-result", "v2-native-content-child", "v2-native-content-supervisor", "v2-native-content-entry", "v2-native-content-gate",
  "v2-internal-verified-read-contracts", "v2-internal-verified-read-admission", "v2-internal-verified-read-child",
  "v2-internal-verified-read-cleanup", "v2-internal-verified-read-ownership", "v2-internal-verified-read-supervisor",
  "v2-internal-verified-read-entry", "v2-internal-verified-read-gate", "retrieval-candidates", "v2-retrieval-candidates",
  "retrieval-eligibility", "retrieval-ranking", "retrieval-service", "projection-runtime", "retrieval-explain", "retrieval-vector-cache",
  "stable-directory-read-core", "projection-image-metadata", "projection-manifest", "projection-integrity", "v2-reader-lease",
  "v2-foundation-entry", "ci-fresh-start-foundation", "ci-lifecycle-gates"];
const metadataNames = ["v2-internal-verified-read-contracts", "stable-directory-read-core", "projection-image-metadata",
  "v2-internal-verified-read-admission", "v2-internal-verified-read-child", "v2-internal-verified-read-cleanup",
  "v2-internal-verified-read-ownership", "v2-internal-verified-read-supervisor", "v2-internal-verified-read-entry",
  "v2-internal-verified-read-gate", "projection-manifest", "projection-integrity", "v2-reader-lease", "retrieval-candidates",
  "v2-retrieval-candidates", "fresh-start-admission", "sqlite-driver", "v2-foundation-entry", "ci-fresh-start-foundation", "event-append-transaction"];
type Run = (options: { root: string; profile?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<number>;
async function gate(): Promise<Run> { return (await import(new URL("../../scripts/run-v2-internal-verified-read.js", import.meta.url).href)).runVerifiedReadGate; }
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "native-content-gate-")));
  const put = (name: string, code: string) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), code); };
  const record = "import{appendFileSync}from'node:fs';const log=x=>appendFileSync('trace',x+'\\n');";
  put("package.json", '{"type":"module"}'); put("scripts/build.js", `${record}log('build');`);
  put("node_modules/typescript/bin/tsc", `${record}log('compile');if(process.argv.slice(2).join(' ')!=='-p tsconfig.test.json')process.exit(91);`);
  for (const name of new Set([...nativeNames, ...metadataNames])) put(`dist-test/tests/${name}.test.js`, `${record}import{test}from'node:test';test('${name}',()=>log('${name}'));`);
  put("scripts/smoke-v2-fresh-start.js", `${record}log('smoke');`);
  const events: any[] = []; let launched = false;
  return { root, put, events, trace: () => existsSync(join(root, "trace")) ? readFileSync(join(root, "trace"), "utf8").trim().split("\n") : [],
    async run(run: Run, options: Omit<Parameters<Run>[0], "root"> = {}) {
      const original = process.stdout.write; let buffer = ""; launched = true;
      process.stdout.write = function (chunk: any, ...args: any[]) {
        buffer += String(chunk); let end;
        while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try { const event = JSON.parse(line); if (event.stage) events.push(event); } catch {} }
        return Reflect.apply(original, process.stdout, [chunk, ...args]);
      } as typeof original;
      try { return await run({ root, ...options }); } finally { process.stdout.write = original; }
    },
    cleanup() {
      if (!existsSync(join(root, ".fresh-start-foundation.lock")) && (!launched || events.length > 0
        && events.every(e => e.cleanup === "complete" && e.closure === "windows-job-active-zero"))) rmSync(root, { recursive: true, force: true });
      else console.error(`Retained uncertain native profile fixture: ${root}`);
    } };
}
test("native_profile_preserves_default_and_owns_outputs", { skip: process.platform !== "win32", timeout: 180000 }, async () => {
  const run = await gate();
  for (const [profile, names] of [["native-content", nativeNames], [undefined, metadataNames]] as const) {
    const f = fixture();
    if (profile) {
      f.put("descendant.cjs", "const fs=require('node:fs');fs.writeFileSync('descendant-ready','ready');const timer=setInterval(()=>{if(fs.existsSync('descendant-check'))fs.writeFileSync('descendant-ack','alive');if(fs.existsSync('descendant-release'))clearInterval(timer);},10);");
      f.put("scripts/build.js", "import{appendFileSync,existsSync}from'node:fs';import{spawn}from'node:child_process';appendFileSync('trace','build\\n');spawn(process.execPath,['descendant.cjs'],{stdio:'ignore',detached:true,windowsHide:true}).unref();while(!existsSync('descendant-ready'))await new Promise(r=>setTimeout(r,10));process.exit(0);");
    }
    const controller = new AbortController(); const pending = f.run(run, { ...(profile ? { profile } : {}), signal: controller.signal });
    try {
      if (profile) {
        const until = performance.now() + 10000;
        while (!existsSync(join(f.root, "descendant-ready"))) { assert.ok(performance.now() < until); await new Promise(r => setTimeout(r, 10)); }
        f.put("descendant-check", "check");
        while (!existsSync(join(f.root, "descendant-ack"))) { assert.ok(performance.now() < until); await new Promise(r => setTimeout(r, 10)); }
        assert.deepEqual(f.trace(), ["build"]); assert.equal(f.events.length, 0);
        assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), true);
        f.put("descendant-release", "release");
      }
      assert.equal(await pending, 0);
      assert.deepEqual(f.trace(), ["build", "compile", ...names, "smoke"]);
      assert.equal(f.events.filter(e => e.stage === "build").length, 1);
      assert.equal(f.events.filter(e => e.stage === "compile").length, 1);
      assert.equal(f.events.length - 3, profile ? 33 : 20);
      assert.ok(f.events.every(e => e.profile === (profile ?? "metadata") && e.closure === "windows-job-active-zero" && e.cleanup === "complete"));
      assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false);
    } finally { f.put("descendant-release", "release"); controller.abort(); await pending; f.cleanup(); }
  }
});
test("native profile refuses unknown profile and both no-argument CLIs refuse extra argv before a child", async () => {
  const run = await gate(), f = fixture();
  try { assert.equal(await run({ root: f.root, profile: "arbitrary" }), 1); assert.deepEqual(f.trace(), []);
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false);
    for (const script of ["run-v2-native-content.js", "run-v2-internal-verified-read.js"]) {
      const result = spawnSync(process.execPath, [new URL(`../../scripts/${script}`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), "--profile=native-content"], { cwd: f.root, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 1); assert.match(result.stderr, /GATE_FAILED/); assert.deepEqual(f.trace(), []);
    }
  } finally { f.cleanup(); }
});
test("native and metadata share the output lock without overlapping output owners", async () => {
  const run = await gate(), f = fixture(); const lock = join(f.root, ".fresh-start-foundation.lock");
  try { writeFileSync(lock, "foreign-output-owner");
    for (const profile of ["metadata", "native-content"]) { assert.equal(await run({ root: f.root, profile }), 1); assert.deepEqual(f.trace(), []); assert.equal(readFileSync(lock, "utf8"), "foreign-output-owner"); }
  } finally { assert.equal(readFileSync(lock, "utf8"), "foreign-output-owner"); rmSync(f.root, { recursive: true, force: true }); }
});
test("native profile cancellation and timeout keep Job closure before releasing ownership", { skip: process.platform !== "win32" }, async () => {
  const run = await gate();
  for (const cancel of [false, true]) {
    const f = fixture(); f.put("scripts/build.js", "import{writeFileSync}from'node:fs';writeFileSync('ready','ready');setInterval(()=>{},1000);");
    const controller = new AbortController(); const pending = f.run(run, { profile: "native-content", timeoutMs: 6000, signal: controller.signal });
    try { const until = performance.now() + 5000; while (!existsSync(join(f.root, "ready"))) { assert.ok(performance.now() < until); await new Promise(r => setTimeout(r, 10)); }
      if (cancel) controller.abort(); assert.equal(await pending, cancel ? 130 : 124);
      assert.equal(f.events.length, 1); assert.equal(f.events[0].stage, "build"); assert.equal(f.events[0].closure, "windows-job-active-zero");
      assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false);
    } finally { controller.abort(); await pending; f.cleanup(); }
  }
});
