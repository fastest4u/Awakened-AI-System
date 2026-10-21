import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { canonicalMkdtemp } from "./support/canonical-temp.js";

const moduleUrl = new URL("../src/orchestrator/materialization/stable-compatibility-directory.js", import.meta.url).href;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const workerUrl = new URL("../src/orchestrator/materialization/stable-compatibility-directory.worker.js", import.meta.url).href;
const harness = `
import * as fs from "node:fs";
const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
const {request,fault,workerUrl,protectedRoot}=JSON.parse(Buffer.concat(chunks).toString());
const {executeStableCompatibilityRequest}=await import(workerUrl);
const trace=[]; const handles=new Map(); let injected=false;
const operations={...fs,
 openSync(path,flags,...args){trace.push({operation:"open",path,flags});
   if(!injected&&fault==="ancestor-before-open"&&flags==="wx"){injected=true;fs.renameSync(request.parentPath,request.parentPath+"-moved");fs.symlinkSync(protectedRoot,request.parentPath,process.platform==="win32"?"junction":"dir");}
   if(!injected&&fault==="target-before-open"&&path==="artifact.md"){injected=true;fs.renameSync(path,"previous.md");fs.writeFileSync(path,"unowned replacement");}
   const fd=fs.openSync(path,flags,...args);handles.set(fd,path);return fd;},
 writeSync(fd,...args){trace.push({operation:"write",path:handles.get(fd)});if(fault==="write"&&!injected){injected=true;throw Error("injected-sensitive-write");}return fs.writeSync(fd,...args);},
 fsyncSync(fd){const path=handles.get(fd);trace.push({operation:"fsync",path});if(!injected&&((fault==="file-flush"&&path!==".")||(fault==="parent-flush"&&path==="."))){injected=true;throw Error("injected-sensitive-flush");}
   fs.fsyncSync(fd);if(!injected&&fault==="temp-after-flush"&&path.startsWith(".v2-compat-")){injected=true;fs.renameSync(path,"owned-retained.md");fs.writeFileSync(path,"unowned replacement");}
   if(!injected&&["temp-symlink-after-flush","temp-hardlink-after-flush"].includes(fault)&&path.startsWith(".v2-compat-")){injected=true;fs.renameSync(path,"owned-retained.md");fs.renameSync("unowned-entry",path);}},
 closeSync(fd){const path=handles.get(fd);trace.push({operation:"close",path});fs.closeSync(fd);handles.delete(fd);if(!injected&&fault==="close"&&path!=="."){injected=true;throw Error("injected-sensitive-close");}},
 renameSync(from,to){trace.push({operation:"rename",from,to});if(fault==="rename-before"&&!injected){injected=true;throw Error("injected-sensitive-rename");}
   if(fault==="ancestor-before-rename"&&!injected){injected=true;fs.renameSync(request.parentPath,request.parentPath+"-moved");fs.symlinkSync(protectedRoot,request.parentPath,process.platform==="win32"?"junction":"dir");}
   fs.renameSync(from,to);if(fault==="rename-after"&&!injected){injected=true;throw Error("injected-sensitive-response");}},
 unlinkSync(path){trace.push({operation:"unlink",path});return fs.unlinkSync(path);},
 mkdirSync(path,options){trace.push({operation:"mkdir",path,recursive:options.recursive});
   if(fault==="ancestor-before-mkdir"&&!injected){injected=true;fs.renameSync(request.parentPath,request.parentPath+"-moved");fs.symlinkSync(protectedRoot,request.parentPath,process.platform==="win32"?"junction":"dir");}
   return fs.mkdirSync(path,options);}
};
let result;try{result={ok:true,response:executeStableCompatibilityRequest(request,operations)};}catch(error){result={ok:false,code:error.message};}
process.stdout.write(JSON.stringify({...result,trace}));
`;
async function workerFixture(t: test.TestContext, options: { existing?: boolean; operation?: "publish" | "verify" | "prepare" } = {}) {
  const root = canonicalMkdtemp("stable-compatibility-fault-"); t.after(() => rmSync(root, { recursive: true, force: true }));
  const isolated = join(root, "isolated"), protectedRoot = join(root, "protected"); mkdirSync(isolated); mkdirSync(protectedRoot);
  writeFileSync(join(protectedRoot, "sentinel.md"), "protected");
  const bytes = Buffer.from("exact fixture bytes"); if (options.existing) writeFileSync(join(isolated, "artifact.md"), bytes);
  const id = (path: string) => { const stat = lstatSync(path, { bigint: true }); return { device: String(stat.dev), inode: String(stat.ino) }; };
  const request = { schemaVersion: 1, requestId: randomBytes(16).toString("hex"), operation: options.operation ?? "publish",
    parentPath: isolated, parentIdentity: id(isolated), forbiddenIdentities: [id(protectedRoot)], basename: "artifact.md",
    attemptToken: randomBytes(16).toString("hex"), byteLength: bytes.length, contentSha256: hash(bytes), bytesBase64: (options.operation ?? "publish") === "publish" ? bytes.toString("base64") : null };
  return { root, isolated, protectedRoot, bytes, request, run(fault = "") {
    return new Promise<{ ok: boolean; code?: string; response?: { state: string }; trace: { operation: string; path?: string; flags?: string; from?: string; to?: string; recursive?: boolean }[] }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", harness], { cwd: isolated, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.stderr.resume(); child.on("error", reject);
      child.on("close", code => { try { assert.equal(code, 0); resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); } });
      child.stdin.end(JSON.stringify({ request, fault, workerUrl, protectedRoot }));
    });
  } };
}

test("real reconciliation uses flush-only platform flags and no existing-target data writes", async t => {
  const f = await workerFixture(t, { existing: true, operation: "verify" });
  const before = lstatSync(join(f.isolated, "artifact.md"), { bigint: true });
  const result = await f.run(); assert.equal(result.ok, true); assert.equal(result.response!.state, "verified");
  assert.deepEqual(result.trace.filter(row => row.operation === "write"), []);
  assert.deepEqual(result.trace.filter(row => row.operation === "open" && row.path === "artifact.md").map(row => row.flags), [process.platform === "win32" ? "r+" : "r"]);
  const after = lstatSync(join(f.isolated, "artifact.md"), { bigint: true });
  assert.deepEqual([after.dev, after.ino, after.nlink, after.size], [before.dev, before.ino, 1n, before.size]);
  assert.deepEqual(readFileSync(join(f.isolated, "artifact.md")), f.bytes);
});

test("file and parent durability or close failure never reports verified success", async t => {
  for (const fault of ["file-flush", "parent-flush", "close"]) await t.test(fault, async child => {
    const f = await workerFixture(child, { existing: true, operation: "verify" });
    const before = lstatSync(join(f.isolated, "artifact.md"), { bigint: true });
    const result = await f.run(fault); assert.equal(result.ok, false);
    assert.equal(result.code, "MIGRATION_OUTCOME_UNKNOWN");
    assert.deepEqual(result.trace.filter(row => row.operation === "write" || row.operation === "unlink" || row.operation === "rename"), []);
    const after = lstatSync(join(f.isolated, "artifact.md"), { bigint: true });
    assert.deepEqual([after.dev, after.ino, after.nlink], [before.dev, before.ino, 1n]);
    assert.deepEqual(readFileSync(join(f.isolated, "artifact.md")), f.bytes);
  });
});

test("failed publication retains authority isolation and mutates only relative attempt entries", async t => {
  for (const fault of ["write", "file-flush", "close", "rename-before", "rename-after", "parent-flush"]) await t.test(fault, async child => {
    const f = await workerFixture(child); const protectedFile = join(f.protectedRoot, "sentinel.md");
    const before = lstatSync(protectedFile, { bigint: true });
    const result = await f.run(fault); assert.equal(result.ok, false);
    for (const operation of result.trace) for (const path of [operation.path, operation.from, operation.to])
      if (path !== undefined) assert.match(path, /^(\.|artifact\.md|\.v2-compat-[0-9a-f]{32}\.tmp)$/);
    assert.deepEqual(readdirSync(f.protectedRoot), ["sentinel.md"]);
    assert.equal(readFileSync(protectedFile, "utf8"), "protected");
    const after = lstatSync(protectedFile, { bigint: true }); assert.deepEqual([after.dev, after.ino, after.nlink], [before.dev, before.ino, before.nlink]);
    if (fault === "rename-after" || fault === "parent-flush") {
      assert.deepEqual(readFileSync(join(f.isolated, "artifact.md")), f.bytes);
      const installed = lstatSync(join(f.isolated, "artifact.md"), { bigint: true });
      const reconciled = await f.run(); assert.equal(reconciled.ok, true); assert.equal(reconciled.response!.state, "verified");
      assert.equal(lstatSync(join(f.isolated, "artifact.md"), { bigint: true }).ino, installed.ino);
      assert.deepEqual(reconciled.trace.filter(row => row.operation === "rename" || row.operation === "write"), []);
    }
  });
});

test("rejects a root redirected to protected authority before child entry", async t => {
  const f = await workerFixture(t);
  renameSync(f.isolated, join(f.root, "original-isolated"));
  symlinkSync(f.protectedRoot, f.isolated, process.platform === "win32" ? "junction" : "dir");
  const before = lstatSync(join(f.protectedRoot, "sentinel.md"), { bigint: true });
  const result = await f.run(); assert.equal(result.ok, false); assert.deepEqual(result.trace, []);
  assert.deepEqual(readdirSync(f.protectedRoot), ["sentinel.md"]); assert.equal(readFileSync(join(f.protectedRoot, "sentinel.md"), "utf8"), "protected");
  const after = lstatSync(join(f.protectedRoot, "sentinel.md"), { bigint: true });
  assert.deepEqual([after.dev, after.ino, after.nlink], [before.dev, before.ino, before.nlink]);
});

test("occupied unowned attempt temps survive EEXIST and cannot be cleaned by the replacer", async t => {
  const f = await workerFixture(t); const temporary = join(f.isolated, `.v2-compat-${f.request.attemptToken}.tmp`);
  writeFileSync(temporary, "unowned"); const before = lstatSync(temporary, { bigint: true });
  const result = await f.run(); assert.equal(result.ok, false);
  assert.deepEqual(result.trace.filter(row => row.operation === "unlink"), []);
  const after = lstatSync(temporary, { bigint: true }); assert.deepEqual([after.dev, after.ino, after.nlink], [before.dev, before.ino, 1n]);
  assert.equal(readFileSync(temporary, "utf8"), "unowned");
});

test("rejects hardlinked targets without changing protected file bytes or link counts", async t => {
  const f = await workerFixture(t); const protectedFile = join(f.protectedRoot, "sentinel.md");
  linkSync(protectedFile, join(f.isolated, "artifact.md"));
  const before = lstatSync(protectedFile, { bigint: true }); assert.equal(before.nlink, 2n);
  const result = await f.run(); assert.equal(result.ok, false);
  assert.deepEqual(result.trace.filter(row => row.operation === "write" || row.operation === "rename" || row.operation === "unlink"), []);
  const after = lstatSync(protectedFile, { bigint: true }); assert.deepEqual([after.dev, after.ino, after.nlink], [before.dev, before.ino, 2n]);
  assert.equal(readFileSync(protectedFile, "utf8"), "protected");
});

function createFileSymlinkCapability(t: test.TestContext, target: string, path: string): boolean {
  try { symlinkSync(target, path, "file"); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")
      && process.env.CI !== "true" && process.env.GITHUB_ACTIONS !== "true") {
      t.skip(`Local Windows V2 file-symlink capability unavailable (${code}); no authority proof`); return false;
    }
    assert.fail(`V2 file-symlink fixture creation failed (${code ?? "UNKNOWN"}); CI requires actual execution`);
  }
}
const entryIdentity = (path: string) => {
  const stat = lstatSync(path, { bigint: true }); return [stat.dev, stat.ino, stat.nlink];
};

test("rejects a real file-symlink target in the V2 worker on every capable host", async t => {
  const f = await workerFixture(t), protectedFile = join(f.protectedRoot, "sentinel.md"), target = join(f.isolated, "artifact.md");
  if (!createFileSymlinkCapability(t, protectedFile, target)) return;
  const protectedBefore = entryIdentity(protectedFile), rootBefore = entryIdentity(f.protectedRoot), targetBefore = entryIdentity(target);
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.code, "COMPATIBILITY_INTEGRITY_FAILURE");
  assert.deepEqual(result.trace.filter(row => ["write", "rename", "unlink", "mkdir"].includes(row.operation)), []);
  assert.deepEqual(entryIdentity(protectedFile), protectedBefore); assert.deepEqual(entryIdentity(f.protectedRoot), rootBefore);
  assert.deepEqual(entryIdentity(target), targetBefore); assert.equal(lstatSync(target).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(f.protectedRoot), ["sentinel.md"]); assert.equal(readFileSync(protectedFile, "utf8"), "protected");
});

test("retains substituted file-symlink and hardlink temps without deleting unowned entries", async t => {
  for (const kind of ["symlink", "hardlink"] as const) await t.test(kind, async child => {
    const f = await workerFixture(child), protectedFile = join(f.protectedRoot, "sentinel.md"), unowned = join(f.isolated, "unowned-entry");
    if (kind === "symlink") { if (!createFileSymlinkCapability(child, protectedFile, unowned)) return; }
    else linkSync(protectedFile, unowned);
    // Establish adversarial entries before baseline: the worker must not change protected link counts.
    const protectedBefore = entryIdentity(protectedFile), rootBefore = entryIdentity(f.protectedRoot), unownedBefore = entryIdentity(unowned);
    const result = await f.run(`temp-${kind}-after-flush`); assert.equal(result.ok, false);
    assert.deepEqual(result.trace.filter(row => ["rename", "unlink"].includes(row.operation)), []);
    const substituted = join(f.isolated, `.v2-compat-${f.request.attemptToken}.tmp`);
    assert.deepEqual(entryIdentity(substituted), unownedBefore);
    assert.equal(lstatSync(substituted).isSymbolicLink(), kind === "symlink");
    assert.deepEqual(entryIdentity(protectedFile), protectedBefore); assert.deepEqual(entryIdentity(f.protectedRoot), rootBefore);
    assert.deepEqual(readdirSync(f.protectedRoot), ["sentinel.md"]); assert.equal(readFileSync(protectedFile, "utf8"), "protected");
    assert.deepEqual(readFileSync(join(f.isolated, "owned-retained.md")), f.bytes);
    assert.equal(existsSync(join(f.isolated, "artifact.md")), false);
  });
});

test("substituted target or temp inode fails closed and ambiguous entries are retained", async t => {
  for (const fault of ["target-before-open", "temp-after-flush"]) await t.test(fault, async child => {
    const f = await workerFixture(child, { existing: fault === "target-before-open" });
    const result = await f.run(fault); assert.equal(result.ok, false);
    assert.deepEqual(result.trace.filter(row => row.operation === "unlink" || row.operation === "rename"), []);
    const substituted = fault === "target-before-open" ? "artifact.md" : `.v2-compat-${f.request.attemptToken}.tmp`;
    assert.equal(readFileSync(join(f.isolated, substituted), "utf8"), "unowned replacement");
    assert.deepEqual(readdirSync(f.protectedRoot), ["sentinel.md"]);
  });
});

test("ancestor redirection at raw mkdir, exclusive open and rename remains isolated or rejects", async t => {
  for (const fault of ["ancestor-before-mkdir", "ancestor-before-open", "ancestor-before-rename"]) await t.test(fault, async child => {
    const f = await workerFixture(child, { operation: fault === "ancestor-before-mkdir" ? "prepare" : "publish" });
    if (fault === "ancestor-before-mkdir") { f.request.byteLength = 0; f.request.contentSha256 = "0".repeat(64); }
    const protectedFile = join(f.protectedRoot, "sentinel.md"), before = lstatSync(protectedFile, { bigint: true });
    const result = await f.run(fault);
    assert.deepEqual(readdirSync(f.protectedRoot), ["sentinel.md"]); assert.equal(readFileSync(protectedFile, "utf8"), "protected");
    const after = lstatSync(protectedFile, { bigint: true }); assert.deepEqual([after.dev, after.ino, after.nlink], [before.dev, before.ino, before.nlink]);
    for (const mutation of result.trace.filter(row => ["write", "mkdir", "rename", "unlink"].includes(row.operation))) {
      for (const path of [mutation.path, mutation.from, mutation.to]) if (path !== undefined) assert.equal(path.includes(":") || path.includes("/") || path.includes("\\"), false);
      if (mutation.operation === "mkdir") assert.equal(mutation.recursive, false);
    }
    // Windows may reject moving a process cwd; Linux may keep it pinned to the original directory.
    if (result.ok && fault !== "ancestor-before-mkdir") assert.deepEqual(readFileSync(join(f.isolated + "-moved", "artifact.md")), f.bytes);
  });
});

test("publishes exact bytes using the real worker and preserves the inode on durable reconciliation", async t => {
  const { StableCompatibilityDirectory } = await import(moduleUrl);
  const root = canonicalMkdtemp("stable-compatibility-"); t.after(() => rmSync(root, { recursive: true, force: true }));
  const isolated = join(root, "isolated"), protectedRoot = join(root, "protected"); mkdirSync(isolated); mkdirSync(protectedRoot);
  writeFileSync(join(protectedRoot, "sentinel.md"), "protected");
  const protectedIdentity = lstatSync(protectedRoot, { bigint: true });
  const client = new StableCompatibilityDirectory({ rootPath: isolated, forbiddenRoots: [protectedRoot] });
  const bytes = Buffer.from("exact UTF-8 ไทย\n");
  const input = { relativePath: "nested/deeper/artifact.md", byteLength: bytes.length, contentSha256: hash(bytes), remainingMs: 10000 };
  const parent = await client.prepareParent(input.relativePath, input.remainingMs);
  const first = await client.publishOrReconcile({ ...input, parent, bytes });
  assert.equal(first.deduplicated, false);
  const target = join(isolated, input.relativePath), identity = lstatSync(target, { bigint: true });
  assert.deepEqual(readFileSync(target), bytes);
  assert.equal((await client.publishOrReconcile({ ...input, parent, bytes })).deduplicated, true);
  await client.verifyOnly(input);
  assert.equal(lstatSync(target, { bigint: true }).ino, identity.ino);
  assert.deepEqual(readdirSync(protectedRoot), ["sentinel.md"]);
  assert.equal(readFileSync(join(protectedRoot, "sentinel.md"), "utf8"), "protected");
  assert.equal(lstatSync(protectedRoot, { bigint: true }).ino, protectedIdentity.ino);
  assert.equal(lstatSync(target, { bigint: true }).nlink, 1n);
});

test("verify-only rejects a missing parent without creating directories", async t => {
  const { StableCompatibilityDirectory } = await import(moduleUrl);
  const root = canonicalMkdtemp("stable-compatibility-verify-"); t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = new StableCompatibilityDirectory({ rootPath: root, forbiddenRoots: [] });
  await assert.rejects(client.verifyOnly({ relativePath: "missing/artifact.md", byteLength: 0,
    contentSha256: hash(Buffer.alloc(0)), remainingMs: 10000 }));
  assert.equal(existsSync(join(root, "missing")), false);
});

test("rejects an authority root and invalid relative components before mutations", async t => {
  const { StableCompatibilityDirectory } = await import(moduleUrl);
  const root = canonicalMkdtemp("stable-compatibility-invalid-"); t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => new StableCompatibilityDirectory({ rootPath: root, forbiddenRoots: [root] }));
  const client = new StableCompatibilityDirectory({ rootPath: root, forbiddenRoots: [] });
  for (const path of ["../outside.md", "a/../b.md", "a//b.md", "a\\b.md", "a/CON", "a/b.", "a/b:stream"])
    await assert.rejects(client.prepareParent(path, 10000));
  assert.deepEqual(readdirSync(root), []);
});

test("kills a real stalled worker at the remaining deadline and keeps payloads off arguments", async t => {
  const { StableCompatibilityDirectory } = await import(moduleUrl);
  const f = await workerFixture(t);
  const delayPath = join(f.root, "delay.mjs"); writeFileSync(delayPath, "await new Promise(resolve => setTimeout(resolve, 2000));\n");
  let launched = false, hidden = false; let argumentsSeen: readonly string[] = [];
  const launch: typeof spawn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    launched = true; hidden = options?.windowsHide === true; argumentsSeen = args;
    return spawn(command, ["--import", pathToFileURL(delayPath).href, ...args], options);
  }) as typeof spawn;
  const client = new StableCompatibilityDirectory({ rootPath: f.isolated, forbiddenRoots: [f.protectedRoot] }, launch);
  const parent = await client.prepareParent("artifact.md", 10000);
  await assert.rejects(client.publishOrReconcile({ relativePath: "artifact.md", parent, bytes: f.bytes,
    byteLength: f.bytes.length, contentSha256: hash(f.bytes), remainingMs: 200 }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "MIGRATION_OUTCOME_UNKNOWN");
  assert.equal(launched, true); assert.equal(hidden, true);
  assert.equal(argumentsSeen.length, 2); assert.equal(argumentsSeen[1], "--stable-compatibility-worker");
  assert.ok(!argumentsSeen.join(" ").includes(f.bytes.toString("base64")));
  assert.deepEqual(readdirSync(f.isolated), []); assert.deepEqual(readdirSync(f.protectedRoot), ["sentinel.md"]);
});

test("rejects malformed or oversized worker messages before any mutating operation", async t => {
  for (const variant of ["extra-field", "traversal", "oversized", "base64", "forbidden-parent"]) await t.test(variant, async child => {
    const f = await workerFixture(child);
    if (variant === "extra-field") Object.assign(f.request, { extra: "sensitive unexpected field" });
    if (variant === "traversal") f.request.basename = "../escaped.md";
    if (variant === "oversized") f.request.byteLength = 1048577;
    if (variant === "base64") f.request.bytesBase64 = "invalid sensitive content";
    if (variant === "forbidden-parent") f.request.forbiddenIdentities = [f.request.parentIdentity];
    const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.code, "COMPATIBILITY_INTEGRITY_FAILURE");
    assert.deepEqual(result.trace, []); assert.deepEqual(readdirSync(f.isolated), []);
    assert.doesNotMatch(JSON.stringify(result), /sensitive/);
  });
});

test("rejects a mismatched real-worker response identity while retaining its isolated installed bytes", async t => {
  const { StableCompatibilityDirectory } = await import(moduleUrl); const f = await workerFixture(t);
  const preload = join(f.root, "mismatch.mjs");
  writeFileSync(preload, 'const original = process.stdout.write.bind(process.stdout); process.stdout.write = (chunk, ...rest) => { const message = JSON.parse(String(chunk)); message.requestId = "0".repeat(32); return original(JSON.stringify(message), ...rest); };\n');
  const launch: typeof spawn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) =>
    spawn(command, ["--import", pathToFileURL(preload).href, ...args], options)) as typeof spawn;
  const client = new StableCompatibilityDirectory({ rootPath: f.isolated, forbiddenRoots: [f.protectedRoot] }, launch);
  const parent = await client.prepareParent("artifact.md", 10000);
  await assert.rejects(client.publishOrReconcile({ relativePath: "artifact.md", parent, bytes: f.bytes, byteLength: f.bytes.length,
    contentSha256: hash(f.bytes), remainingMs: 10000 }));
  assert.deepEqual(readFileSync(join(f.isolated, "artifact.md")), f.bytes);
  assert.deepEqual(readdirSync(f.protectedRoot), ["sentinel.md"]);
});

test("rejects a noncanonical existing leaf alias without treating it as a verified target", async t => {
  const f = await workerFixture(t, { existing: true });
  if (process.platform === "win32") f.request.basename = "ARTIFACT.md";
  else { symlinkSync("artifact.md", join(f.isolated, "alias.md")); f.request.basename = "alias.md"; }
  const result = await f.run(); assert.equal(result.ok, false);
  assert.deepEqual(result.trace.filter(row => row.operation === "write" || row.operation === "rename" || row.operation === "unlink"), []);
  assert.deepEqual(readFileSync(join(f.isolated, "artifact.md")), f.bytes);
});
