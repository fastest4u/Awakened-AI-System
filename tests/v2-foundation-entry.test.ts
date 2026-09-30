import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { encodeWorkerBinding } from "../src/orchestrator/runtime/worker-protocol.js";
import { context } from "./fixtures/fresh-start-admission-child.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";

const root = process.cwd();
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const sentinel = "credential-SHOULD-NEVER-APPEAR-82731";
const capabilities = { profile: "fresh-start", version: 1, tools: ["memory_v2Status"], content: "unavailable" };
const recoveryPolicy = { profile: "fresh-start", version: 1, productionReady: false, promotion: "closed" };

function fixture() {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "v2-entry-")));
  const v1ArchiveRoot = join(projectRoot, "archive"); mkdirSync(v1ArchiveRoot);
  writeFileSync(join(v1ArchiveRoot, "sentinel.txt"), sentinel);
  const v2VaultRoot = join(projectRoot, "memory-v2");
  const releaseId = randomUUID();
  const config = { projectRoot, v2VaultRoot, v1ArchiveRoot, releaseId };
  const monitor = join(projectRoot, "monitor.cjs");
  const accessLog = join(projectRoot, "archive-access.log");
  // Installed before the actual entry loads. Every attempted content access is
  // recorded and denied; stat/realpath metadata inspection remains permitted.
  writeFileSync(monitor, `const fs=require('node:fs'),p=require('node:path'),u=require('node:url');
const archive=${JSON.stringify(v1ArchiveRoot.toLowerCase())},log=${JSON.stringify(accessLog)};
const append=fs.appendFileSync.bind(fs);
function check(x){if(x instanceof URL)x=u.fileURLToPath(x);if(typeof x!=='string'&&!Buffer.isBuffer(x))return;
const v=p.resolve(String(x)).toLowerCase();if(v===archive||v.startsWith(archive+p.sep)){append(log,'access\\n');throw Error('ARCHIVE_ACCESS_DENIED');}}
for(const n of ['readFileSync','readFile','readdirSync','readdir','opendirSync','opendir','openSync','open','createReadStream','writeFileSync','writeFile','appendFileSync','appendFile','createWriteStream']){const original=fs[n];fs[n]=function(x,...a){check(x);return original.call(this,x,...a)}}
for(const n of ['readFile','readdir','opendir','open','writeFile','appendFile']){const original=fs.promises[n];fs.promises[n]=function(x,...a){check(x);return original.call(this,x,...a)}}
require('node:module').syncBuiltinESMExports();`);
  const env = { ...process.env, MEMORY_PROJECT_ROOT: projectRoot, MEMORY_V2_VAULT_PATH: v2VaultRoot,
    MEMORY_V1_ARCHIVE_PATH: v1ArchiveRoot, MEMORY_V2_RELEASE_ID: releaseId,
    MEMORY_V2_ACTIVE: "true", MEMORY_V2_PRODUCTION_READY: "true" };
  const args = ["--project-root", projectRoot, "--v2-vault-root", v2VaultRoot, "--v1-archive-root", v1ArchiveRoot,
    "--release-manifest", join(projectRoot, "release.json")];
  function manifest(buildRoot = join(root, "dist")) {
    assert.ok(existsSync(join(buildRoot, "v2-build.json")), "compiled fresh-start deployment measurement is missing");
    const build = JSON.parse(readFileSync(join(buildRoot, "v2-build.json"), "utf8"));
    const value = { initializationId: randomUUID(), release: { profileVersion: 1, releaseId,
      buildIdentityHash: build.buildIdentityHash, schemaIdentityHash: expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS),
      configurationHash: hash(config), capabilityManifestHash: hash(capabilities), recoveryPolicyHash: hash(recoveryPolicy),
      evidenceDigest: hash({ purpose: "owned-preparation-test" }), createdAt: new Date().toISOString() } };
    writeFileSync(join(projectRoot, "release.json"), JSON.stringify(value)); return value;
  }
  function admin(command: string, buildRoot = join(root, "dist")) {
    return spawnSync(process.execPath, ["--require", monitor, join(buildRoot, "v2-admin.js"), command, ...args], { cwd: root, env, encoding: "utf8", timeout: 20000 });
  }
  return { ...config, config, monitor, accessLog, env, args, manifest, admin,
    database: join(v2VaultRoot, ".memory-mcp", "v2", "events.sqlite"),
    cleanup() { rmSync(projectRoot, { recursive: true, force: true }); } };
}

async function mcp(f: ReturnType<typeof fixture>, run: (call: (method: string, params: unknown) => Promise<any>) => Promise<void>, buildRoot = join(root, "dist")) {
  const child = spawn(process.execPath, ["--require", f.monitor, join(buildRoot, "v2.js")], { cwd: root, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", pending = "", id = 0;
  const replies = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  child.stderr.on("data", value => { stderr += value; });
  child.stdout.on("data", value => {
    stdout += value; pending += value;
    for (;;) { const end = pending.indexOf("\n"); if (end < 0) break;
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try { const response = JSON.parse(line); replies.get(response.id)?.resolve(response); }
      catch { for (const waiter of replies.values()) waiter.reject(new Error("non-protocol stdout")); }
    }
  });
  child.on("error", error => { for (const waiter of replies.values()) waiter.reject(error); });
  child.on("exit", code => { for (const waiter of replies.values()) waiter.reject(new Error(`entry exited ${code}: ${stderr}`)); });
  async function call(method: string, params: unknown) {
    const requestId = ++id;
    try { return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`protocol timeout: ${stderr}`)), 15000);
      replies.set(requestId, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    }); } finally { replies.delete(requestId); }
  }
  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "foundation-test", version: "1" } });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await run(call);
    assert.ok(stdout.trim().split("\n").every(line => JSON.parse(line).jsonrpc === "2.0"));
    assert.ok(!stdout.includes(sentinel) && !stderr.includes(sentinel));
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit"); child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  }
}

test("compiled entries exist and missing or dynamic launch bindings fail redacted before creation", () => {
  assert.ok(existsSync(join(root, "dist/v2.js")), "compiled V2 service entry is missing");
  assert.ok(existsSync(join(root, "dist/v2-admin.js")), "compiled V2 admin entry is missing");
  const f = fixture();
  try {
    for (const invalid of [undefined, "auto", "dynamic", "default", "relative", `https://${sentinel}@example.test`]) {
      const result = spawnSync(process.execPath, [join(root, "dist/v2.js")], { cwd: root, env: { ...f.env, MEMORY_PROJECT_ROOT: invalid }, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 1); assert.equal(result.stdout, "");
      assert.match(result.stderr, /FRESH_START_CONFIG_INVALID/); assert.ok(!result.stderr.includes(sentinel));
      assert.equal(existsSync(f.v2VaultRoot), false);
    }
    const nativeError = spawnSync(process.execPath, [join(root, "dist/v2.js")], { env: { ...f.env, MEMORY_V1_ARCHIVE_PATH: join(f.projectRoot, sentinel) }, encoding: "utf8", timeout: 10000 });
    assert.equal(nativeError.status, 1); assert.match(nativeError.stderr, /FRESH_START_PATH_INVALID/); assert.ok(!nativeError.stderr.includes(sentinel));
  } finally { f.cleanup(); }
});

test("ordinary startup never initializes or recreates a missing acknowledged database", () => {
  const f = fixture();
  try {
    const before = spawnSync(process.execPath, [join(root, "dist/v2.js")], { env: f.env, encoding: "utf8", timeout: 15000 });
    assert.equal(before.status, 1); assert.match(before.stderr, /FRESH_START_RECOVERY_REQUIRED/); assert.equal(existsSync(f.v2VaultRoot), false);
    f.manifest(); const initialized = f.admin("initialize-fresh"); assert.equal(initialized.status, 0, initialized.stderr);
    unlinkSync(f.database);
    const after = spawnSync(process.execPath, [join(root, "dist/v2.js")], { env: f.env, encoding: "utf8", timeout: 15000 });
    assert.equal(after.status, 1); assert.match(after.stderr, /FRESH_START_RECOVERY_REQUIRED/); assert.equal(existsSync(f.database), false);
  } finally { f.cleanup(); }
});

test("compiled foundation stays prepared across restarts and refuses content and activation without archive access", async () => {
  const f = fixture();
  try {
    const manifest = f.manifest();
    const initialized = f.admin("initialize-fresh"); assert.equal(initialized.status, 0, initialized.stderr);
    const adminStatus = JSON.parse(initialized.stdout);
    assert.equal(adminStatus.productionReady, false); assert.equal(adminStatus.mode, "prepared");
    assert.equal(adminStatus.buildIdentityHash, manifest.release.buildIdentityHash);
    const repeated = f.admin("initialize-fresh"); assert.equal(repeated.status, 1); assert.match(repeated.stderr, /FRESH_START_ALREADY_INITIALIZED/);
    const resumed = f.admin("resume-initialization"); assert.equal(resumed.status, 0, resumed.stderr); assert.deepEqual(JSON.parse(resumed.stdout), adminStatus);
    const status = f.admin("status"); assert.equal(status.status, 0, status.stderr); assert.deepEqual(JSON.parse(status.stdout), adminStatus);
    for (let count = 0; count < 2; count++) await mcp(f, async call => {
      const tools = await call("tools/list", {}); assert.deepEqual(tools.result.tools.map((tool: any) => tool.name), ["memory_v2Status"]);
      const response = await call("tools/call", { name: "memory_v2Status", arguments: {} });
      assert.deepEqual(JSON.parse(response.result.content[0].text), adminStatus);
      for (const name of ["memory_search", "memory_writeInsight", "memory_sessionStart", "activate", "memory_v2Activate"])
        assert.equal((await call("tools/call", { name, arguments: { credential: sentinel, productionReady: true } })).error.data.code, "FRESH_START_RELEASE_NOT_READY");
      assert.equal((await call("tools/call", { name: "memory_v2Status", arguments: { projectRoot: sentinel } })).error.data.code, "FRESH_START_INPUT_INVALID");
      const malformed = await call("tools/call", { name: "memory_v2Status", arguments: sentinel });
      assert.ok(malformed.error); assert.ok(!JSON.stringify(malformed).includes(sentinel));
    });
    const activate = f.admin("activate"); assert.equal(activate.status, 1); assert.match(activate.stderr, /FRESH_START_RELEASE_NOT_READY/);
    assert.equal(existsSync(f.accessLog), false, "actual compiled process attempted V1 content access");
    assert.ok(!JSON.stringify(adminStatus).includes(f.projectRoot));
    assert.deepEqual(Object.keys(adminStatus).sort(), ["profile", "profileVersion", "projectId", "vaultId", "storeId", "releaseId", "mode", "generation", "schemaVersion", "schemaIdentityHash", "buildIdentityHash", "productionReady"].sort());
  } finally { f.cleanup(); }
});

test("local release-manifest input cannot read V1 even when explicitly pointed into the archive", () => {
  const f = fixture();
  try {
    const args = [...f.args]; args[args.length - 1] = join(f.v1ArchiveRoot, "sentinel.txt");
    const result = spawnSync(process.execPath, ["--require", f.monitor, join(root, "dist/v2-admin.js"), "initialize-fresh", ...args], { env: f.env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /FRESH_START_PATH_OVERLAP/);
    assert.equal(existsSync(f.accessLog), false, "manifest loading attempted an archive read");
    assert.equal(existsSync(f.v2VaultRoot), false);
  } finally { f.cleanup(); }
});

test("release mismatch and malformed local manifests fail without creating a store", () => {
  const f = fixture();
  try {
    const value = f.manifest(); value.release.buildIdentityHash = "0".repeat(64);
    writeFileSync(join(f.projectRoot, "release.json"), JSON.stringify(value));
    const result = f.admin("initialize-fresh"); assert.equal(result.status, 1); assert.match(result.stderr, /FRESH_START_RELEASE_MISMATCH/); assert.equal(existsSync(f.v2VaultRoot), false);
    writeFileSync(join(f.projectRoot, "release.json"), `{${sentinel}`);
    const bad = f.admin("initialize-fresh"); assert.equal(bad.status, 1); assert.ok(!bad.stderr.includes(sentinel)); assert.equal(existsSync(f.v2VaultRoot), false);
  } finally { f.cleanup(); }
});

for (const substitute of [false, true]) test(`release manifest refuses archive hardlink content before reading: ${substitute ? "stat/open substitution" : "existing alias"}`, () => {
  const f = fixture();
  try {
    const source = join(f.v1ArchiveRoot, "release-source.json"), alias = join(f.projectRoot, "release.json");
    const readLog = join(f.projectRoot, "alias-read.log"), swapLog = join(f.projectRoot, "alias-swap.log");
    writeFileSync(source, JSON.stringify({ credential: sentinel }));
    if (substitute) writeFileSync(alias, "{}");
    else linkSync(source, alias);
    const identity = lstatSync(source, { bigint: true });
    if (!substitute) {
      assert.equal(lstatSync(alias, { bigint: true }).ino, identity.ino);
      assert.equal(identity.nlink, 2n);
    }
    // Observe the actual source inode through either a path or descriptor, so an
    // outside-archive alias cannot evade the existing lexical-path monitor.
    writeFileSync(f.monitor, readFileSync(f.monitor, "utf8") + `\n(() => {
const alias=${JSON.stringify(alias)},source=${JSON.stringify(source)},readLog=${JSON.stringify(readLog)},swapLog=${JSON.stringify(swapLog)};
const stat=fs.statSync.bind(fs),fstat=fs.fstatSync.bind(fs),lstat=fs.lstatSync.bind(fs);
if(${substitute}){let swapped=false;fs.lstatSync=function(x,...args){const result=lstat(x,...args);if(!swapped&&x===alias){swapped=true;fs.unlinkSync(alias);fs.linkSync(source,alias);append(swapLog,'swapped\\n');}return result;};}
function isSource(x){try{const s=typeof x==='number'?fstat(x,{bigint:true}):stat(x,{bigint:true});return String(s.dev)===${JSON.stringify(String(identity.dev))}&&String(s.ino)===${JSON.stringify(String(identity.ino))};}catch{return false;}}
for(const name of ['readFileSync','readSync','readvSync']){const original=fs[name];fs[name]=function(x,...args){const sourceRead=isSource(x);const result=original.call(this,x,...args);if(sourceRead)append(readLog,'archive-alias-content-read\\n');return result;};}
require('node:module').syncBuiltinESMExports();})();`);
    const result = f.admin("initialize-fresh");
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.match(result.stderr, /FRESH_START_INPUT_INVALID/); assert.ok(!result.stderr.includes(sentinel));
    if (substitute) assert.equal(existsSync(swapLog), true, "stat/open substitution did not run");
    assert.equal(existsSync(readLog), false, "compiled admin read archive content through an outside alias or descriptor");
    assert.equal(existsSync(f.v2VaultRoot), false);
  } finally { f.cleanup(); }
});

test("missing and altered compiled deployment files fail closed in copied deployments", () => {
  const f = fixture();
  try {
    f.manifest(); assert.equal(f.admin("initialize-fresh").status, 0);
    for (const target of ["v2-build.json", "workers/project-store.worker.js", "v2-admin.js"]) {
      const deployment = join(f.projectRoot, randomUUID()); mkdirSync(deployment);
      for (const file of ["v2.js", "v2-admin.js", "v2-build.json", "workers/project-store.worker.js"]) { mkdirSync(resolve(deployment, file, ".."), { recursive: true }); cpSync(join(root, "dist", file), join(deployment, file)); }
      if (target === "v2-build.json") unlinkSync(join(deployment, target));
      else writeFileSync(join(deployment, target), readFileSync(join(deployment, target), "utf8") + "\n// altered owned fixture\n");
      const result = f.admin("status", deployment); assert.equal(result.status, 1); assert.match(result.stderr, /FRESH_START_BUILD_MISMATCH/);
    }
  } finally { f.cleanup(); }
});

test("compiled worker independently measures the same deployment and refuses a parent hash echo", async () => {
  const f = fixture();
  try {
    const manifest = f.manifest(); const initialized = f.admin("initialize-fresh"); assert.equal(initialized.status, 0, initialized.stderr);
    const status = JSON.parse(initialized.stdout);
    const existing = context(resolve(f.database, ".."), f.database);
    const identity = { projectId: status.projectId, vaultId: status.vaultId, storeId: status.storeId };
    Object.assign(existing.binding, identity);
    existing.binding.contextFingerprint = computeProjectContextFingerprint(existing.binding);
    for (const measuredBuildHash of [manifest.release.buildIdentityHash, "0".repeat(64)]) {
      const worker = new Worker(pathToFileURL(join(root, "dist/workers/project-store.worker.js")), { workerData: { role: "store", executorLeaseMs: 15000, heartbeatIntervalMs: 5000, appendRetryDeadlineMs: 1000 } });
      try {
        const response = once(worker, "message");
        worker.postMessage({ id: "open", type: "open", binding: encodeWorkerBinding(existing), freshStart: { identity, releaseId: status.releaseId, measuredBuildHash, generation: "0" } });
        const timer = setTimeout(() => worker.terminate(), 15000);
        let message; try { [message] = await response; } finally { clearTimeout(timer); }
        assert.equal(message.ok, false);
        assert.equal(message.error.code, measuredBuildHash === manifest.release.buildIdentityHash ? "FRESH_START_ADMISSION_DENIED" : "FRESH_START_BUILD_MISMATCH");
      } finally { await worker.terminate(); }
    }
  } finally { f.cleanup(); }
});
