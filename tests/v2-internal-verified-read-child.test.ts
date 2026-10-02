import assert from "node:assert/strict";
import { fork, type ForkOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ReadBootstrap, ReadReply, ReadTerminalReply } from "../src/orchestrator/verified-read/contracts.js";
import { decodeReadBootstrap, decodeReadReply } from "../src/orchestrator/verified-read/protocol.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { GENESIS_GLOBAL_HASH } from "../src/orchestrator/storage/event-chain-constants.js";
import { GENESIS_GLOBAL_HASH as appendGenesisHash } from "../src/orchestrator/storage/event-append-transaction.js";
import { GENESIS_GLOBAL_HASH as eventStoreGenesisHash } from "../src/orchestrator/storage/event-store.js";
import { makeActiveReadFixture } from "./support/v2-verified-read-fixture.js";
import { ownedReadDirectory, readBootstrap } from "./support/v2-verified-read-fixture.js";

type Dependencies = { inspectBuild(): string; now(): number; wait(ms: number, signal: AbortSignal): Promise<void>;
  signal: AbortSignal; emitStage(reply: Extract<ReadReply, { kind: "stage" }>): void };
type Execute = (input: ReadBootstrap, dependencies: Dependencies) => Promise<ReadTerminalReply>;
test("pure and legacy append/store exports preserve the exact committed genesis anchor", () => {
  const expected = "0000000000000000000000000000000000000000000000000000000000000000";
  assert.equal(GENESIS_GLOBAL_HASH, expected); assert.equal(appendGenesisHash, expected); assert.equal(eventStoreGenesisHash, expected);
});
async function operation(): Promise<Execute> {
  const path = "../src/orchestrator/verified-read/child.js";
  let implementation: Execute | undefined;
  try { implementation = (await import(path) as { executeVerifiedRead: Execute }).executeVerifiedRead; }
  catch (error) { if ((error as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw error; }
  assert.equal(typeof implementation, "function", "Task 4 must implement the real isolated read operation");
  return implementation!;
}
type Fixture = Awaited<ReturnType<typeof makeActiveReadFixture>>;
const lock = ".projection-manifest.publish.lock";
function bootstrap(f: Fixture, remainingMs = 5000): ReadBootstrap {
  return decodeReadBootstrap({ version: 2, ids: { requestId: "read", attemptId: "attempt", laneEpoch: "epoch" },
    binding: f.binding, request: { ...f.request, budgetMs: remainingMs }, lockToken: "b".repeat(32), remainingMs });
}
async function withFixture(run: (f: Fixture, execute: Execute) => Promise<void>) {
  const execute = await operation();
  const f = await makeActiveReadFixture(); const cwd = process.cwd();
  try { process.chdir(f.binding.projectionDirectory.canonicalPath); await run(f, execute); }
  finally { process.chdir(cwd); f.cleanup(); }
}
function dependencies(f: Fixture, options: { stage?: Dependencies["emitStage"]; wait?: Dependencies["wait"]; inspect?: () => string } = {}) {
  let time = 0; const controller = new AbortController(); const stages: ReadReply[] = [];
  const deps: Dependencies = { inspectBuild: options.inspect ?? (() => f.measuredBuildHash), now: () => time,
    wait: async (ms, signal) => { assert.equal(ms, 50); assert.equal(signal, controller.signal); time += ms; await options.wait?.(ms, signal); },
    signal: controller.signal, emitStage: reply => { stages.push(decodeReadReply(reply)); options.stage?.(reply); } };
  return { deps, stages, controller, advance: (ms: number) => { time += ms; } };
}
function failure(reply: ReadTerminalReply, code: string, cleanup = "complete") {
  assert.equal(reply.kind, "failure"); if (reply.kind !== "failure") return;
  assert.equal(reply.failure.code, code); assert.equal(reply.failure.cleanup, cleanup);
}
function stop(f: Fixture) { f.control.stop({ identity: f.identity, expectedGeneration: 1n,
  target: "read-only-recovery", reasonCode: "integrity-failure" }); }

test("early fixture mkdir failure removes its owned root and preserves the exact setup error", async () => {
  // Removing the setup try region leaks this root. Inject only the first owned mkdir syscall.
  const original = fs.mkdirSync; const primary = new Error("synthetic owned setup failure"); let root: string | undefined;
  fs.mkdirSync = ((path: fs.PathLike, ...args: unknown[]) => {
    if (String(path).endsWith("projection") && String(path).includes("v2-active-read-")) {
      root = dirname(String(path)); throw primary;
    }
    return Reflect.apply(original, fs, [path, ...args]);
  }) as typeof fs.mkdirSync;
  syncBuiltinESMExports();
  try { await assert.rejects(makeActiveReadFixture(), error => error === primary); assert.ok(root); assert.equal(existsSync(root), false); }
  finally { fs.mkdirSync = original; syncBuiltinESMExports(); if (root && existsSync(root)) fs.rmSync(root, { recursive: true, force: true }); }
});

test("genesis receipt uses actual image SHA, detached metadata and closed resources without source writes", async () => withFixture(async (f, execute) => {
  const before = f.writer.prepare("SELECT total_changes() AS changes").get()!.changes;
  const { deps, stages } = dependencies(f);
  const reply = decodeReadReply(await execute(bootstrap(f), deps)); assert.equal(reply.kind, "success");
  if (reply.kind !== "success") return;
  assert.equal(reply.receipt.requiredEventPosition, "0"); assert.equal(reply.receipt.projectionEventPosition, "0");
  assert.equal(reply.receipt.imageSha256, createHash("sha256").update(readFileSync(f.manifest.databaseFile)).digest("hex"));
  assert.deepEqual(reply.closed, { image: true, reader: true, lock: true }); assert.equal(existsSync(lock), false);
  assert.equal(f.writer.prepare("SELECT total_changes() AS changes").get()!.changes, before);
  assert.deepEqual(stages.map(stage => stage.kind === "stage" ? stage.phase : ""), ["admission", "projection-wait", "capture", "validate", "revalidate"]);
}));
test("waits for existing lagging publication without retaining a lock or resetting the captured tail", async () => withFixture(async (f, execute) => {
  const first = f.append(); let waits = 0;
  const { deps } = dependencies(f, { wait: async () => { waits++; assert.equal(existsSync(lock), false);
    f.append(); await f.publish(); } });
  const reply = await execute(bootstrap(f), deps); assert.equal(reply.kind, "success");
  if (reply.kind === "success") { assert.equal(reply.fence.capturedPosition, first.position);
    assert.equal(reply.receipt.requiredEventPosition, first.position); assert.equal(reply.receipt.projectionEventPosition, "2"); }
  assert.equal(waits, 1);
}));
test("missing publication waits and never manufactures a view", async () => withFixture(async (f, execute) => {
  unlinkSync("projection-manifest.json"); let waits = 0;
  const { deps } = dependencies(f, { wait: async () => { waits++; assert.equal(existsSync(lock), false); } });
  const reply = await execute(bootstrap(f, 100), deps); failure(reply, "PROJECTION_LAG");
  assert.equal(waits, 2); assert.equal(existsSync("projection-manifest.json"), false);
  if (reply.kind === "failure") assert.deepEqual(reply.failure.positions, { required: "0", observed: null });
}));
test("busy foreign writer lock is preserved and never held by the waiting reader", async () => withFixture(async (f, execute) => {
  writeFileSync(lock, "c".repeat(32)); let waits = 0;
  const { deps } = dependencies(f, { wait: async () => { waits++; assert.equal(readFileSync(lock, "utf8"), "c".repeat(32)); } });
  failure(await execute(bootstrap(f, 100), deps), "PROJECTION_LAG"); assert.equal(waits, 2);
  assert.equal(readFileSync(lock, "utf8"), "c".repeat(32));
}));
test("publication wait stops after 600 bounded attempts", async () => withFixture(async (f, execute) => {
  f.append(); let waits = 0; const { deps } = dependencies(f, { wait: async () => { waits++; assert.equal(existsSync(lock), false); } });
  failure(await execute(bootstrap(f, 30000), deps), "PROJECTION_LAG"); assert.equal(waits, 600);
}));
test("fractional remainder below 50 ms never starts an over-budget publication wait", async () => withFixture(async (f, execute) => {
  f.append(); let waits = 0; const controls = dependencies(f, { wait: async () => { waits++; } });
  failure(await execute({ ...bootstrap(f), remainingMs: 49.9 }, controls.deps), "PROJECTION_LAG"); assert.equal(waits, 0);
}));
test("sufficient publication still refuses when admission exhausts the deadline", async () => withFixture(async (f, execute) => {
  const controls = dependencies(f, { stage: reply => { if (reply.phase === "projection-wait") controls.advance(5000); } });
  failure(await execute(bootstrap(f), controls.deps), "WORKER_TIMEOUT"); assert.equal(existsSync(lock), false);
}));
test("independent build mismatch fails before any admitted stage", async () => withFixture(async (f, execute) => {
  const controls = dependencies(f, { inspect: () => "c".repeat(64) });
  failure(await execute(bootstrap(f), controls.deps), "FRESH_START_BUILD_MISMATCH"); assert.equal(controls.stages.length, 0);
}));
test("cancellation during publication wait closes the reader and preserves the publication", async () => withFixture(async (f, execute) => {
  f.append(); const controls = dependencies(f, { wait: async () => { controls.controller.abort(); } });
  failure(await execute(bootstrap(f), controls.deps), "WORKER_CLOSED"); assert.equal(existsSync(lock), false);
}));
test("native abortable wait rejection is reported as cancellation rather than worker failure", async () => withFixture(async (f, execute) => {
  f.append(); const controls = dependencies(f);
  controls.deps.wait = async (ms, signal) => { setImmediate(() => controls.controller.abort()); await wait(ms, undefined, { signal }); };
  failure(await execute(bootstrap(f), controls.deps), "WORKER_CLOSED"); assert.equal(existsSync(lock), false);
}));
for (const phase of ["projection-wait", "capture", "validate", "revalidate"] as const) {
  test(`recovery transition at ${phase} barrier denies detached receipt`, async () => withFixture(async (f, execute) => {
    const { deps } = dependencies(f, { stage: reply => { if (reply.phase === phase) stop(f); } });
    failure(await execute(bootstrap(f), deps), "FRESH_START_CONTENT_UNVERIFIED"); assert.equal(existsSync(lock), false);
  }));
}
test("replacement publication between initial observation and locked capture is re-read under the lock", async () => withFixture(async (f, execute) => {
  const original = fs.openSync; let replaced = false;
  fs.openSync = ((path: fs.PathLike, flags: string | number, ...args: unknown[]) => {
    const result = Reflect.apply(original, fs, [path, flags, ...args]) as number;
    if (String(path) === lock && flags === "wx") {
      replaced = true; writeFileSync("projection-manifest.json", JSON.stringify({ ...f.manifest, databaseSha256: "c".repeat(64) }));
    }
    return result;
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try { failure(await execute(bootstrap(f), dependencies(f).deps), "INTEGRITY_FAILURE");
    assert.equal(replaced, true); assert.equal(existsSync(lock), false); }
  finally { fs.openSync = original; syncBuiltinESMExports(); }
}));
for (const mutation of ["changed-sha", "identical-replacement", "same-inode-rewrite", "missing", "unchanged"] as const) {
  test(`locked manifest ${mutation} at actual generation read boundary preserves continuity`, async () => withFixture(async (f, execute) => {
    const originalRead = fs.readFileSync, originalOpen = fs.openSync; let imageFd: number | undefined, reached = false;
    fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
      const fd = Reflect.apply(originalOpen, fs, [path, ...args]) as number;
      if (String(path) === f.manifest.databaseFile) imageFd = fd;
      return fd;
    }) as typeof fs.openSync;
    fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const bytes = Reflect.apply(originalRead, fs, [path, ...args]);
      if (imageFd !== undefined && path === imageFd && !reached) {
        reached = true; assert.equal(readFileSync(lock, "utf8"), "b".repeat(32));
        if (mutation === "missing") unlinkSync("projection-manifest.json");
        else if (mutation === "same-inode-rewrite") {
          const before = fs.lstatSync("projection-manifest.json", { bigint: true });
          writeFileSync("projection-manifest.json", originalRead("projection-manifest.json"));
          const after = fs.lstatSync("projection-manifest.json", { bigint: true });
          assert.equal(after.ino, before.ino); assert.notEqual(after.ctimeNs, before.ctimeNs);
        }
        else if (mutation !== "unchanged") {
          const replacement = mutation === "changed-sha" ? Buffer.from(JSON.stringify({ ...f.manifest, databaseSha256: "f".repeat(64) })) : originalRead("projection-manifest.json");
          writeFileSync("manifest-replacement", replacement); fs.renameSync("manifest-replacement", "projection-manifest.json");
        }
      }
      return bytes;
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      const reply = await execute(bootstrap(f), dependencies(f).deps); assert.equal(reached, true);
      if (mutation === "unchanged") { assert.equal(reply.kind, "success"); if (reply.kind === "success") assert.deepEqual(reply.closed, { image: true, reader: true, lock: true }); }
      else failure(reply, "PROJECTION_PATH_INVALID");
      assert.equal(existsSync(lock), false);
    } finally { fs.readFileSync = originalRead; fs.openSync = originalOpen; syncBuiltinESMExports(); }
  }));
}
test("capture phase is reported before the actual generation descriptor is opened", async () => withFixture(async (f, execute) => {
  const controls = dependencies(f); const open = fs.openSync; let observed: string | undefined;
  fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
    if (String(path) === f.manifest.databaseFile) { const last = controls.stages.at(-1); observed = last?.kind === "stage" ? last.phase : undefined; }
    return Reflect.apply(open, fs, [path, ...args]);
  }) as typeof fs.openSync; syncBuiltinESMExports();
  try { assert.equal((await execute(bootstrap(f), controls.deps)).kind, "success"); assert.equal(observed, "capture"); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
}));
for (const suffix of ["-wal", "-shm"]) test(`image ${suffix} sidecar refuses actual image capture`, async () => withFixture(async (f, execute) => {
  writeFileSync(f.manifest.databaseFile + suffix, "owned sidecar");
  failure(await execute(bootstrap(f), dependencies(f).deps), "INTEGRITY_FAILURE"); assert.equal(existsSync(lock), false);
}));
test("actual image byte tamper cannot pass manifest SHA", async () => withFixture(async (f, execute) => {
  const bytes = readFileSync(f.manifest.databaseFile); bytes[100] = bytes[100]! ^ 1; writeFileSync(f.manifest.databaseFile, bytes);
  failure(await execute(bootstrap(f), dependencies(f).deps), "INTEGRITY_FAILURE"); assert.equal(existsSync(lock), false);
}));
test("matching byte SHA does not bypass exact shared metadata validation", async () => withFixture(async (f, execute) => {
  const db = new DatabaseSync(resolve(f.manifest.databaseFile));
  try { db.exec("UPDATE projection_metadata SET generation = 123"); } finally { db.close(); }
  const hash = createHash("sha256").update(readFileSync(f.manifest.databaseFile)).digest("hex");
  writeFileSync("projection-manifest.json", JSON.stringify({ ...f.manifest, databaseSha256: hash }));
  failure(await execute(bootstrap(f), dependencies(f).deps), "PROJECTION_SCOPE_MISMATCH"); assert.equal(existsSync(lock), false);
}));
test("retained evidence prevents lock release and cannot attest complete cleanup", async () => withFixture(async (f, execute) => {
  const { deps } = dependencies(f, { stage: reply => { if (reply.phase === "capture") writeFileSync(".projection-manifest.failed-owned", "evidence"); } });
  failure(await execute(bootstrap(f), deps), "PROJECTION_PATH_INVALID", "incomplete");
  assert.equal(readFileSync(lock, "utf8"), "b".repeat(32)); assert.equal(existsSync(f.manifest.databaseFile), true);
}));
test("image close failure preserves primary metadata error and closes each opened database once", async () => withFixture(async (f, execute) => {
  const original = DatabaseSync.prototype.close; const counts = new Map<DatabaseSync, number>();
  const db = new DatabaseSync(resolve(f.manifest.databaseFile)); try { db.exec("UPDATE projection_metadata SET generation=123"); } finally { db.close(); }
  writeFileSync("projection-manifest.json", JSON.stringify({ ...f.manifest, databaseSha256: createHash("sha256").update(readFileSync(f.manifest.databaseFile)).digest("hex") }));
  DatabaseSync.prototype.close = function () { const memory = this.prepare("PRAGMA database_list").get()!.file === "";
    counts.set(this, (counts.get(this) ?? 0) + 1); original.call(this); if (memory) throw new Error("synthetic image closure failure"); };
  try { failure(await execute(bootstrap(f), dependencies(f).deps), "PROJECTION_SCOPE_MISMATCH", "incomplete");
    assert.deepEqual([...counts.values()], [1, 1]); assert.equal(existsSync(lock), false);
  } finally { DatabaseSync.prototype.close = original; }
}));
test("reader close failure cannot report successful closure", async () => withFixture(async (f, execute) => {
  const original = DatabaseSync.prototype.close; const counts = new Map<DatabaseSync, number>();
  DatabaseSync.prototype.close = function () { const file = this.prepare("PRAGMA database_list").get()!.file;
    counts.set(this, (counts.get(this) ?? 0) + 1); original.call(this); if (file) throw new Error("synthetic reader closure failure"); };
  try { failure(await execute(bootstrap(f), dependencies(f).deps), "WORKER_UNAVAILABLE", "incomplete");
    assert.deepEqual([...counts.values()], [1, 1]); assert.equal(existsSync(lock), false);
  } finally { DatabaseSync.prototype.close = original; }
}));
test("throwing image open with hidden native close failure cannot attest completed image closure", async () => withFixture(async (f, execute) => {
  const originalDeserialize = DatabaseSync.prototype.deserialize, originalClose = DatabaseSync.prototype.close;
  DatabaseSync.prototype.deserialize = function () { throw new Error("INTEGRITY_FAILURE"); };
  DatabaseSync.prototype.close = function () {
    const memory = this.prepare("PRAGMA database_list").get()!.file === "";
    originalClose.call(this); if (memory) throw new Error("synthetic hidden image close failure");
  };
  try { failure(await execute(bootstrap(f), dependencies(f).deps), "INTEGRITY_FAILURE", "incomplete"); assert.equal(existsSync(lock), false); }
  finally { DatabaseSync.prototype.deserialize = originalDeserialize; DatabaseSync.prototype.close = originalClose; }
}));
test("throwing reader open with hidden native close failure cannot attest completed reader closure", async () => withFixture(async (f, execute) => {
  const originalExec = DatabaseSync.prototype.exec, originalClose = DatabaseSync.prototype.close;
  let failedReaderConfiguration = false, nativeCloses = 0;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes("PRAGMA trusted_schema") && this.prepare("PRAGMA database_list").get()!.file !== "") {
      failedReaderConfiguration = true; throw new Error("synthetic native reader configuration failure");
    }
    return originalExec.call(this, sql);
  };
  DatabaseSync.prototype.close = function () { nativeCloses++; originalClose.call(this); throw new Error("synthetic hidden reader close failure"); };
  try { const reply = await execute(bootstrap(f), dependencies(f).deps);
    assert.equal(failedReaderConfiguration, true); assert.equal(nativeCloses, 1);
    failure(reply, "WORKER_UNAVAILABLE", "incomplete"); assert.equal(existsSync(lock), false); }
  finally { DatabaseSync.prototype.exec = originalExec; DatabaseSync.prototype.close = originalClose; }
}));
test("recovery transition after final authority observation follows its documented linearization", async () => withFixture(async (f, execute) => {
  const original = DatabaseSync.prototype.close; let stopped = false;
  DatabaseSync.prototype.close = function () { const file = this.prepare("PRAGMA database_list").get()!.file;
    original.call(this); if (file) { stop(f); stopped = true; } };
  try { const reply = await execute(bootstrap(f), dependencies(f).deps); assert.equal(stopped, true); assert.equal(reply.kind, "success"); }
  finally { DatabaseSync.prototype.close = original; }
}));

test("unknown partial acquisition evidence is preserved without falsely completing lock cleanup", async () => withFixture(async (f, execute) => {
  const original = fs.writeSync;
  fs.writeSync = ((fd: number, ...args: unknown[]) => {
    // This narrow injected syscall is used only after genuine exclusive lock creation.
    Reflect.apply(original, fs, [fd, Buffer.from("partial"), 0, 7, 0]); throw new Error("synthetic lock write failure");
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try { failure(await execute(bootstrap(f), dependencies(f).deps), "WORKER_UNAVAILABLE", "incomplete");
    assert.equal(readFileSync(lock, "utf8"), "partial");
  } finally { fs.writeSync = original; syncBuiltinESMExports(); }
}));

test("production entry runtime source closure permits only exact pure retrieval paths and no helper, publisher or process/thread dependency", () => {
  // This architectural constraint catches introducing a forbidden runtime import, including transitively.
  const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
  const visited = new Set<string>();
  const pureRetrievalPaths = new Set(["database-core.ts", "selection-core.ts", "contracts.ts", "eligibility.ts", "ranking.ts"]
    .map(name => join(sourceRoot, "orchestrator/retrieval", name).replaceAll("\\", "/")));
  const permitted = (path: string) => !/\/(?:stable-directory|builder|coordinator|integrity|manifest)\.ts$|\/workers\//u.test(path)
    && (!path.includes("/retrieval/") || pureRetrievalPaths.has(path));
  for (const name of ["candidates.ts", "v2-candidates.ts", "service.ts", "explain.ts", "providers/vector.ts", "lease.ts"]) {
    assert.equal(permitted(join(sourceRoot, "orchestrator/retrieval", name).replaceAll("\\", "/")), false);
  }
  const inspect = (path: string): void => {
    if (visited.has(path)) return; visited.add(path);
    assert.equal(permitted(path.replaceAll("\\", "/")), true, `forbidden runtime input ${path}`);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier.text;
      assert.doesNotMatch(specifier, /^(?:node:)?(?:child_process|worker_threads)$/u);
      if (specifier.startsWith(".")) inspect(resolve(dirname(path), specifier.replace(/\.js$/u, ".ts")));
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = node.arguments[0];
        assert.ok(specifier && ts.isStringLiteral(specifier), `uninspectable dynamic import in ${path}`);
        assert.doesNotMatch(specifier.text, /^(?:node:)?(?:child_process|worker_threads)$/u);
        if (specifier.text.startsWith(".")) inspect(resolve(dirname(path), specifier.text.replace(/\.js$/u, ".ts")));
        else assert.ok(specifier.text.startsWith("node:"), `external dynamic import in ${path}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  inspect(join(sourceRoot, "v2/internal-verified-read.entry.ts"));
  inspect(join(sourceRoot, "v2/internal-verified-read-cleanup.entry.ts"));
  for (const path of pureRetrievalPaths) assert.ok([...visited].some(value => value.replaceAll("\\", "/") === path), `expected reviewed dependency ${path}`);
  assert.ok(visited.size > 4);
});

test("owner opens genuine readonly-existing reader with floored fractional remaining timeout", async () => withFixture(async (f, execute) => {
  const original = NodeSqliteDriver.prototype.open; let opened = 0;
  NodeSqliteDriver.prototype.open = function (path, options) {
    opened++; assert.equal(path, f.path); assert.equal(options.mode, "read-only-existing");
    assert.equal(options.bindFileIdentity, true); assert.equal(options.busyTimeoutMs, 49);
    return original.call(this, path, options);
  };
  try { const reply = await execute({ ...bootstrap(f), remainingMs: 49.9 }, dependencies(f).deps);
    assert.equal(reply.kind, "success"); assert.equal(opened, 1);
  } finally { NodeSqliteDriver.prototype.open = original; }
}));

test("foreign token replacement after actual capture is preserved and leaves cleanup incomplete", async () => withFixture(async (f, execute) => {
  const { deps } = dependencies(f, { stage: reply => { if (reply.phase === "validate") writeFileSync(lock, "c".repeat(32)); } });
  failure(await execute(bootstrap(f), deps), "PROJECTION_PATH_INVALID", "incomplete");
  assert.equal(readFileSync(lock, "utf8"), "c".repeat(32)); assert.equal(existsSync(f.manifest.databaseFile), true);
}));

test("malformed existing manifest is integrity failure rather than publication repair", async () => withFixture(async (f, execute) => {
  writeFileSync("projection-manifest.json", "{}");
  failure(await execute(bootstrap(f), dependencies(f).deps), "INTEGRITY_FAILURE");
  assert.equal(readFileSync("projection-manifest.json", "utf8"), "{}"); assert.equal(existsSync(lock), false);
}));

test("fixed unbundled private read entry independently refuses measurement and exits normally", async () => {
  const directory = ownedReadDirectory();
  const child = fork(fileURLToPath(new URL("../src/v2/internal-verified-read.entry.js", import.meta.url)), [],
    { cwd: directory.canonicalPath, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true } as ForkOptions);
  const replies: unknown[] = []; let output = "";
  child.on("message", reply => replies.push(reply)); child.stdout!.on("data", chunk => { output += String(chunk); }); child.stderr!.on("data", chunk => { output += String(chunk); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const timer = globalThis.setTimeout(() => child.kill(), 5000);
  try {
    child.send({ ...readBootstrap(), binding: { ...readBootstrap().binding, projectionDirectory: directory } });
    assert.deepEqual(await exited, { code: 0, signal: null }); assert.equal(output, ""); assert.equal(replies.length, 1);
    const reply = decodeReadReply(replies[0]); assert.equal(reply.kind, "failure");
    if (reply.kind === "failure") assert.equal(reply.failure.code, "FRESH_START_BUILD_MISMATCH");
    assert.equal(existsSync(join(directory.canonicalPath, lock)), false);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); fs.rmSync(directory.canonicalPath, { recursive: true, force: true }); }
});
