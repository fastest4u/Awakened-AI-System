import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
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
test("gate builds once, compiles once, executes the exact twenty real test files serially even nested, then smoke", async () => {
  const run = await gate(), f = fixture();
  try { assert.equal(await run({ root: f.root }), 0); assert.deepEqual(f.trace(), ["build", "compile", ...names, "smoke"]);
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false); } finally { f.cleanup(); }
});
for (const [fault, code, last] of [["build", 17, "build"], ["compile", 23, "compile"], ["test", 1, names[3]], ["smoke", 29, "smoke"]] as const)
  test(`gate propagates native ${fault} failure and stops subsequent stages`, async () => {
    const run = await gate(), f = fixture(fault);
    try { assert.equal(await run({ root: f.root }), code); assert.equal(f.trace().at(-1), last);
      assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false); } finally { f.cleanup(); }
  });
test("shared output lock refuses another owner and leaves its bytes intact", async () => {
  const run = await gate(), f = fixture(); const lock = join(f.root, ".fresh-start-foundation.lock");
  try { writeFileSync(lock, "foreign-output-owner"); assert.equal(await run({ root: f.root }), 1);
    assert.deepEqual(f.trace(), []); assert.equal(readFileSync(lock, "utf8"), "foreign-output-owner"); } finally { f.cleanup(); }
});
test("pre-abort and cancellation stop owned children and release only positively closed output ownership", async () => {
  const run = await gate(), f = fixture("hang");
  try {
    const already = new AbortController(); already.abort(); assert.equal(await run({ root: f.root, signal: already.signal }), 130); assert.deepEqual(f.trace(), []);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 200);
    try { assert.equal(await run({ root: f.root, signal: controller.signal }), 130); } finally { clearTimeout(timer); }
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false);
  } finally { f.cleanup(); }
});
test("one total deadline includes earlier stages and timeout observes owned-process cleanup", async () => {
  const run = await gate(), f = fixture();
  f.put("scripts/build.js", "await new Promise(r=>setTimeout(r,300));");
  f.put("node_modules/typescript/bin/tsc", "await new Promise(r=>setTimeout(r,300));");
  try { assert.equal(await run({ root: f.root, timeoutMs: 500 }), 124); assert.deepEqual(f.trace(), []);
    assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), false); } finally { f.cleanup(); }
});
test("changed output lock is refused and foreign replacement is preserved", async () => {
  const run = await gate(), f = fixture();
  f.put("scripts/build.js", "import{unlinkSync,writeFileSync}from'node:fs';unlinkSync('.fresh-start-foundation.lock');writeFileSync('.fresh-start-foundation.lock','replacement');process.exit(31);");
  try { assert.equal(await run({ root: f.root }), 1); assert.equal(readFileSync(join(f.root, ".fresh-start-foundation.lock"), "utf8"), "replacement"); }
  finally { f.cleanup(); }
});
test("unconfirmed native process-tree cleanup retains output ownership", { skip: process.platform !== "win32", timeout: 10000 }, async () => {
  const run = await gate(), f = fixture();
  f.put("scripts/build.js", "import{spawn}from'node:child_process';spawn(process.execPath,['-e','setTimeout(()=>{},1800)'],{stdio:'inherit',windowsHide:true});process.exit(0);");
  try { assert.equal(await run({ root: f.root, timeoutMs: 500 }), 1); assert.equal(existsSync(join(f.root, ".fresh-start-foundation.lock")), true);
    await new Promise(resolve => setTimeout(resolve, 2000)); } finally { f.cleanup(); }
});
