import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { buildV2ShadowMigrationEvidence, buildV2ShadowMigrationPreflightFailureEvidence,
  reserveV2ShadowMigrationEvidence, writeV2ShadowMigrationEvidence,
  hasRequiredApprovedV2ShadowMigrationReviews, type V2ShadowMigrationEvidenceV1,
} from "../src/orchestrator/migration/v2-shadow-migration-evidence.js";
import { V2ShadowMigrationRunner, V2ShadowMigrationPreflightFailure, readV2ShadowMigrationPreflightEvidence } from "../src/orchestrator/migration/v2-shadow-migration-runner.js";
import { createShadowMigrationRunnerFixture } from "./support/v2-shadow-migration-fixture.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const H = "a".repeat(64);
const CONTROL = ".v2-shadow-migration-evidence.reservation";
const FAILURE = "preflight-failure-evidence.json";
// Synthetic serializer inputs only: these are not verified runs or review approvals.
function input(): Omit<V2ShadowMigrationEvidenceV1, "evidenceChecksum"> {
  const vector = { migrationIdentity: H, packageChecksum: H, importedEventsChecksum: H,
    transitionChainChecksum: H, v2ProjectionManifestChecksum: H, parityReportChecksum: H,
    compatibilityArtifactSetChecksum: H, sourceRecordCount: 1, importedEventCount: 1, compatibilityAcknowledgementCount: 1 };
  return { schemaVersion: 1, commit: "b".repeat(40), nodeVersion: "v24.16.0", sqliteVersion: "3.50.2", operatingSystem: "win32",
    projectStoreSchemaVersion: 5, buildIdentityHash: H, rolloutRevisionId: "11111111-1111-4111-8111-111111111111",
    migrationIdentity: H, configurationChecksum: H, policyChecksum: H, sourceManifestChecksum: H,
    sourceBeforeChecksum: H, sourceAfterChecksum: H, counts: { sourceRecords: 1 },
    deterministicRuns: [1, 2, 3].map(runOrdinal => ({ runOrdinal: runOrdinal as 1 | 2 | 3, deduplicated: false, determinismVector: { ...vector } })),
    noOpRun: { runOrdinal: 4, deduplicated: true, determinismVector: { ...vector } },
    parity: { equal: 1, expected: 0, blocking: 0, ruleIds: [] },
    compatibility: { acknowledged: 1, terminalPosition: "1", artifactSetChecksum: H },
    performance: { elapsedMs: 1, throughputPerSecond: 1, peakRssBytes: 1024, maxBatchEvents: 1, maxBatchBytes: 100, retries: 0, projectionLag: 0, materializationLag: 0 },
    tests: [{ name: "serializer-fixture", passed: 1, failed: 0, skipped: 0 }], reviews: [],
    gates: [{ name: "fixture-functional", status: "passed", evidenceDigest: H }], createdAt: "2026-09-23T00:00:00.000Z" };
}
const ownedDirectories = new Map<string, fs.BigIntStats>();
function directory(_t: TestContext): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "task12b-")));
  // Retain failed/uncertain output and ownership evidence, including assertion failures.
  ownedDirectories.set(root, fs.statSync(root, { bigint: true }));
  return root;
}
function sameOwnedDirectory(root: string): void {
  const original = ownedDirectories.get(root); assert.ok(original);
  const current = fs.lstatSync(root, { bigint: true });
  assert.ok(current.isDirectory() && !current.isSymbolicLink()); assert.equal(current.ino, original.ino); assert.equal(current.dev, original.dev);
}
function removeEmptyOwnedDirectory(root: string): void {
  sameOwnedDirectory(root); assert.deepEqual(fs.readdirSync(root), []); fs.rmdirSync(root); ownedDirectories.delete(root);
}
function removeOwnedFile(root: string, name: string, expected: { device: string; inode: string }, bytes: string): void {
  sameOwnedDirectory(root); assert.deepEqual(fs.readdirSync(root), [name]);
  const path = join(root, name), stat = fs.lstatSync(path, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.nlink, 1n); assert.equal(String(stat.ino), expected.inode); assert.equal(String(stat.dev), expected.device);
  const fd = fs.openSync(path, "r");
  try { const opened = fs.fstatSync(fd, { bigint: true }); assert.equal(opened.ino, stat.ino); assert.equal(opened.dev, stat.dev); assert.equal(opened.size, BigInt(Buffer.byteLength(bytes))); assert.equal(fs.readFileSync(fd, "utf8"), bytes); }
  finally { fs.closeSync(fd); }
  sameOwnedDirectory(root); assert.equal(fs.lstatSync(path, { bigint: true }).ino, stat.ino); fs.unlinkSync(path); removeEmptyOwnedDirectory(root);
}
function removePublishedFixture(root: string, receipt: { identity: { device: string; inode: string } }, evidence: V2ShadowMigrationEvidenceV1, name = "success.json"): void {
  removeOwnedFile(root, name, receipt.identity, canonicalJson(evidence) + "\n");
}
test("ordinary compiled-module import and invalid hidden child request perform no filesystem mutation", t => {
  const root = directory(t), moduleUrl = new URL("../src/orchestrator/migration/v2-shadow-migration-evidence.js", import.meta.url);
  const imported = childProcess.spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(moduleUrl.href)})`], { cwd: root, encoding: "utf8", timeout: 5000 });
  assert.equal(imported.status, 0); assert.equal(imported.stdout, ""); assert.deepEqual(fs.readdirSync(root), []);
  const invalid = childProcess.spawnSync(process.execPath, [fileURLToPath(moduleUrl), "--v2-shadow-migration-evidence-child"], { cwd: root, encoding: "utf8", timeout: 5000, input: "{}\n" });
  assert.equal(invalid.status, 1); assert.deepEqual(JSON.parse(invalid.stdout), { status: "refused", code: "EVIDENCE_OUTPUT_REFUSED" });
  assert.deepEqual(fs.readdirSync(root), []); removeEmptyOwnedDirectory(root);
});
test("synthetic serializer validates exact schema and independent domain checksum with immutable output", () => {
  const body = input(), result = buildV2ShadowMigrationEvidence(body);
  assert.equal(result.evidenceChecksum, hash("project-memory/v2-shadow-migration-evidence/v1\n" + canonicalJson(body)));
  assert.ok(Object.isFrozen(result.performance)); assert.ok(Object.isFrozen(result.deterministicRuns[0]!.determinismVector));
  assert.equal(hasRequiredApprovedV2ShadowMigrationReviews(result), false);
});
test("serializer refuses unknown fields, paths, secrets, accessors and invalid measurements", () => {
  let traps = 0;
  for (const extra of [{ payload: "secret" }, { artifactRelativePath: "private/file.md" }, { sourceRoot: "C:\\private" }])
    assert.throws(() => buildV2ShadowMigrationEvidence({ ...input(), ...extra }));
  for (const name of ["C:\\private", "/etc/private", "private/file.md", "\\\\host\\share", "-----BEGIN PRIVATE KEY-----", "sk-abcdef012345678901234567890", "SOURCE_PLAINTEXT_SENTINEL"]) {
    assert.throws(() => buildV2ShadowMigrationEvidence({ ...input(), tests: [{ name, passed: 1, failed: 0, skipped: 0 }] }));
  }
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => buildV2ShadowMigrationEvidence({ ...input(), performance: { ...input().performance, peakRssBytes: value } }));
  const getter = Object.defineProperty(input(), "commit", { get() { traps++; return "x"; } });
  assert.throws(() => buildV2ShadowMigrationEvidence(getter)); assert.equal(traps, 0);
  assert.throws(() => buildV2ShadowMigrationEvidence(new Proxy(input(), { ownKeys() { traps++; return []; } })));
  assert.equal(traps, 0);
});
test("review subset stays incomplete and changes-required cannot produce green evidence", () => {
  const review = { kind: "security" as const, disposition: "changes-required" as const, evidenceDigest: H };
  const result = buildV2ShadowMigrationEvidence({ ...input(), reviews: [review] });
  assert.equal(result.gates.some((gate: { status: string }) => gate.status === "failed"), true);
  assert.equal(hasRequiredApprovedV2ShadowMigrationReviews(result), false);
  assert.throws(() => buildV2ShadowMigrationEvidence({ ...input(), reviews: [review, review] }));
});
test("review prerequisite checks evidence checksum before inspecting synthetic disposition fields", () => {
  const reviews = ["specification", "implementation-quality", "security"].map(kind => ({ kind, disposition: "approved", evidenceDigest: H }));
  const document = buildV2ShadowMigrationEvidence({ ...input(), reviews });
  assert.equal(hasRequiredApprovedV2ShadowMigrationReviews(document), true, "shape validation does not authenticate any review");
  assert.throws(() => hasRequiredApprovedV2ShadowMigrationReviews({ ...document, evidenceChecksum: "0".repeat(64) }));
});
test("shared reservation refuses occupied leaves aliases and protected parents without mutation", async t => {
  for (const occupied of ["success.json", FAILURE, CONTROL]) {
    const root = directory(t); fs.mkdirSync(join(root, occupied));
    await assert.rejects(reserveV2ShadowMigrationEvidence({ outputPath: join(root, "success.json"), protectedRoots: [], timeoutMs: 5000 }));
    assert.deepEqual(fs.readdirSync(root), [occupied]);
  }
  for (const name of [FAILURE, CONTROL, "success.json.", "success.json ", "success.json:stream", "CON.json"]) {
    const root = directory(t);
    await assert.rejects(reserveV2ShadowMigrationEvidence({ outputPath: join(root, name), protectedRoots: [], timeoutMs: 5000 }));
    assert.deepEqual(fs.readdirSync(root), []);
    removeEmptyOwnedDirectory(root);
  }
  const root = directory(t);
  await assert.rejects(reserveV2ShadowMigrationEvidence({ outputPath: join(root, "success.json"), protectedRoots: [root], timeoutMs: 5000 }));
  assert.deepEqual(fs.readdirSync(root), []);
  removeEmptyOwnedDirectory(root);
});
test("genuine opaque reservation installs immutable single-link bytes and rejects copied capabilities", async t => {
  const root = directory(t), outputPath = join(root, "success.json");
  const reservation = await reserveV2ShadowMigrationEvidence({ outputPath, protectedRoots: [], timeoutMs: 5000 });
  const evidence = buildV2ShadowMigrationEvidence(input());
  for (const fake of [{}, { ...reservation }, Object.create(Object.getPrototypeOf(reservation))])
    await assert.rejects(writeV2ShadowMigrationEvidence({ reservation: fake, evidence }));
  const receipt = await writeV2ShadowMigrationEvidence({ reservation, evidence });
  assert.equal(receipt.evidenceChecksum, evidence.evidenceChecksum);
  assert.equal(fs.readFileSync(outputPath, "utf8"), canonicalJson(evidence) + "\n");
  assert.equal(fs.statSync(outputPath).nlink, 1); assert.deepEqual(fs.readdirSync(root), ["success.json"]);
  await assert.rejects(writeV2ShadowMigrationEvidence({ reservation, evidence }));
  await assert.rejects(reserveV2ShadowMigrationEvidence({ outputPath, protectedRoots: [], timeoutMs: 5000 }));
  removePublishedFixture(root, receipt, evidence);
});
test("concurrent different success names share one reservation and only one publisher wins", async t => {
  const root = directory(t);
  const results = await Promise.allSettled(["a.json", "b.json"].map(name => reserveV2ShadowMigrationEvidence({ outputPath: join(root, name), protectedRoots: [], timeoutMs: 5000 })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  for (const result of results) if (result.status === "fulfilled") {
    const evidence = buildV2ShadowMigrationEvidence(input()), receipt = await writeV2ShadowMigrationEvidence({ reservation: result.value, evidence });
    assert.equal(fs.readdirSync(root).length, 1); removePublishedFixture(root, receipt, evidence, fs.readdirSync(root)[0]!);
  }
});
test("inserted destination cannot be overwritten and uncertain publication retains reservation", async t => {
  const root = directory(t), outputPath = join(root, "success.json");
  const reservation = await reserveV2ShadowMigrationEvidence({ outputPath, protectedRoots: [], timeoutMs: 5000 });
  fs.writeFileSync(outputPath, "other-owner", { flag: "wx" });
  await assert.rejects(writeV2ShadowMigrationEvidence({ reservation, evidence: buildV2ShadowMigrationEvidence(input()) }));
  assert.equal(fs.readFileSync(outputPath, "utf8"), "other-owner"); assert.ok(fs.existsSync(join(root, CONTROL)));
});
test("publication child does not inherit parent execution flags or NODE_OPTIONS", async t => {
  const root = directory(t), previous = process.env.NODE_OPTIONS;
  let receipt: Awaited<ReturnType<typeof writeV2ShadowMigrationEvidence>> | undefined;
  process.execArgv.push("--task12b-invalid-parent-option"); process.env.NODE_OPTIONS = "--task12b-invalid-parent-option";
  try {
    const reservation = await reserveV2ShadowMigrationEvidence({ outputPath: join(root, "success.json"), protectedRoots: [], timeoutMs: 5000 });
    receipt = await writeV2ShadowMigrationEvidence({ reservation, evidence: buildV2ShadowMigrationEvidence(input()) });
  } finally { process.execArgv.pop(); if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
  assert.deepEqual(fs.readdirSync(root), ["success.json"]);
  assert.ok(receipt); removePublishedFixture(root, receipt, buildV2ShadowMigrationEvidence(input()));
});

// Native process boundary instrumentation is test-owned. Production has no injection API or mode.
function childHook(t: TestContext, source: string): () => void {
  const root = directory(t), hook = join(root, "fault.mjs");
  const bytes = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';\n${source}\nsyncBuiltinESMExports();\n`;
  fs.writeFileSync(hook, bytes, { flag: "wx" }); const stat = fs.statSync(hook, { bigint: true });
  const nativeSpawn = childProcess.spawn;
  const mocked = t.mock.method(childProcess, "spawn", ((command: string, args: string[], options: object) =>
    nativeSpawn(command, ["--import", pathToFileURL(hook).href, ...args], options)) as typeof nativeSpawn);
  syncBuiltinESMExports(); return () => { mocked.mock.restore(); syncBuiltinESMExports(); removeOwnedFile(root, "fault.mjs", { device: String(stat.dev), inode: String(stat.ino) }, bytes); };
}
test("strict directory-flush refusal retains exclusively acquired reservation", async t => {
  const root = directory(t), restore = childHook(t, `const sync=fs.fsyncSync; fs.fsyncSync=(fd)=>{if(fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('private-path'),{code:'ENOTSUP'}); return sync(fd)};`);
  try { await assert.rejects(reserveV2ShadowMigrationEvidence({ outputPath: join(root, "success.json"), protectedRoots: [], timeoutMs: 5000 }), (error: any) => error.code === "EVIDENCE_OUTCOME_UNKNOWN"); }
  finally { restore(); }
  assert.deepEqual(fs.readdirSync(root), [CONTROL]); assert.equal(fs.statSync(join(root, CONTROL)).nlink, 1);
});
for (const scenario of ["unsupported-link", "late-destination", "link-side-effect", "temp-substitution", "child-death", "lost-response", "release-flush", "temp-fsync", "final-reopen", "temp-unlink", "parent-close", "malformed-response"] as const) {
  test(`native child ${scenario} refuses success and preserves surviving ownership evidence`, async t => {
    const root = directory(t), outputPath = join(root, "success.json");
    const hooks = {
      "unsupported-link": `fs.linkSync=()=>{throw Object.assign(new Error('private-path'),{code:'ENOTSUP'})};`,
      "late-destination": `const link=fs.linkSync; fs.linkSync=(a,b)=>{fs.writeFileSync(b,'other-owner',{flag:'wx'});return link(a,b)};`,
      "link-side-effect": `const link=fs.linkSync; fs.linkSync=(a,b)=>{link(a,b);throw new Error('private-path')};`,
      "temp-substitution": `const link=fs.linkSync; fs.linkSync=(a,b)=>{link(a,b);fs.renameSync(a,a+'.held');fs.writeFileSync(a,'other-owner',{flag:'wx'})};`,
      "child-death": `const link=fs.linkSync; fs.linkSync=(a,b)=>{link(a,b);process.exit(9)};`,
      "lost-response": `const write=process.stdout.write.bind(process.stdout);process.stdout.write=(text,callback)=>{if(String(text).includes('published')){if(callback)callback();return true}return write(text,callback)};`,
      "release-flush": `let removed=false;const unlink=fs.unlinkSync,sync=fs.fsyncSync;fs.unlinkSync=p=>{unlink(p);if(p==='${CONTROL}')removed=true};fs.fsyncSync=fd=>{if(removed)throw new Error('private-path');return sync(fd)};`,
      "temp-fsync": `const sync=fs.fsyncSync;let files=0;fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isFile()&&++files===2)throw new Error('private-path');return sync(fd)};`,
      "final-reopen": `const open=fs.openSync;fs.openSync=(p,...args)=>{if(p==='success.json')throw new Error('private-path');return open(p,...args)};`,
      "temp-unlink": `const unlink=fs.unlinkSync;fs.unlinkSync=p=>{if(String(p).endsWith('.tmp'))throw new Error('private-path');return unlink(p)};`,
      "parent-close": `const close=fs.closeSync;fs.closeSync=fd=>{const directory=fs.fstatSync(fd).isDirectory();close(fd);if(directory)throw new Error('private-path')};`,
      "malformed-response": `const write=process.stdout.write.bind(process.stdout);process.stdout.write=(text,callback)=>write(String(text).includes('published')?'null\\n':text,callback);`,
    };
    const restore = childHook(t, hooks[scenario]);
    try {
      const reservation = await reserveV2ShadowMigrationEvidence({ outputPath, protectedRoots: [], timeoutMs: 5000 });
      await assert.rejects(writeV2ShadowMigrationEvidence({ reservation, evidence: buildV2ShadowMigrationEvidence(input()) }), (error: any) => error instanceof Error && !error.message.includes("private-path") && "code" in error && error.code === "EVIDENCE_OUTCOME_UNKNOWN");
    } finally { restore(); }
    const names = fs.readdirSync(root);
    if (!["lost-response", "release-flush", "parent-close", "malformed-response"].includes(scenario)) assert.ok(names.includes(CONTROL));
    if (["unsupported-link", "temp-fsync"].includes(scenario)) assert.equal(fs.existsSync(outputPath), false);
    else if (scenario === "late-destination") assert.equal(fs.readFileSync(outputPath, "utf8"), "other-owner");
    else assert.equal(fs.readFileSync(outputPath, "utf8"), canonicalJson(buildV2ShadowMigrationEvidence(input())) + "\n");
    if (scenario === "temp-substitution") assert.ok(names.some(name => name.endsWith(".tmp") && fs.readFileSync(join(root, name), "utf8") === "other-owner"));
    if (["link-side-effect", "child-death", "final-reopen", "temp-unlink"].includes(scenario)) assert.equal(fs.statSync(outputPath).nlink, 2);
    if (["lost-response", "release-flush", "parent-close", "malformed-response"].includes(scenario)) assert.equal(fs.statSync(outputPath).nlink, 1);
  });
}
test("reservation token substitution refuses and does not delete the substituted entry", async t => {
  const root = directory(t), reservation = await reserveV2ShadowMigrationEvidence({ outputPath: join(root, "success.json"), protectedRoots: [], timeoutMs: 5000 });
  fs.writeFileSync(join(root, CONTROL), "f".repeat(32) + "\n");
  await assert.rejects(writeV2ShadowMigrationEvidence({ reservation, evidence: buildV2ShadowMigrationEvidence(input()) }));
  assert.equal(fs.readFileSync(join(root, CONTROL), "utf8"), "f".repeat(32) + "\n"); assert.deepEqual(fs.readdirSync(root), [CONTROL]);
});
test("pinned parent prevents native relocation or refuses a substituted pathname", async t => {
  const root = directory(t), reservation = await reserveV2ShadowMigrationEvidence({ outputPath: join(root, "success.json"), protectedRoots: [], timeoutMs: 5000 });
  const prior = fs.statSync(root, { bigint: true }), token = fs.readFileSync(join(root, CONTROL));
  const moved = root + "-moved";
  try { fs.renameSync(root, moved); }
  catch (error) {
    assert.equal(process.platform, "win32"); assert.equal((error as NodeJS.ErrnoException).code, "EBUSY");
    const current = fs.statSync(root, { bigint: true }); assert.equal(current.ino, prior.ino); assert.equal(current.dev, prior.dev);
    assert.deepEqual(fs.readFileSync(join(root, CONTROL)), token);
    const evidence = buildV2ShadowMigrationEvidence(input()), receipt = await writeV2ShadowMigrationEvidence({ reservation, evidence });
    assert.deepEqual(fs.readdirSync(root), ["success.json"]);
    removePublishedFixture(root, receipt, evidence);
    console.log("Windows prevented parent relocation with EBUSY; successful-relocation refusal branch remains unqualified here."); return;
  }
  ownedDirectories.set(moved, prior); fs.mkdirSync(root);
  await assert.rejects(writeV2ShadowMigrationEvidence({ reservation, evidence: buildV2ShadowMigrationEvidence(input()) }));
  assert.deepEqual(fs.readdirSync(root), []); assert.deepEqual(fs.readdirSync(moved), [CONTROL]);
});
test("reservation and writer reject accessors and proxy arrays without executing caller code", async t => {
  const root = directory(t); let traps = 0;
  const options = { outputPath: join(root, "success.json"), protectedRoots: [], timeoutMs: 5000 };
  const roots = new Proxy([], { get() { traps++; throw new Error("private-path"); } });
  await assert.rejects(reserveV2ShadowMigrationEvidence({ ...options, protectedRoots: roots })); assert.equal(traps, 0);
  const writer = Object.defineProperty({ evidence: buildV2ShadowMigrationEvidence(input()) }, "reservation", { enumerable: true, get() { traps++; throw new Error("private-path"); } });
  await assert.rejects(writeV2ShadowMigrationEvidence(writer as any)); assert.equal(traps, 0); assert.deepEqual(fs.readdirSync(root), []);
  removeEmptyOwnedDirectory(root);
});
test("same-name concurrent acquisition has one winner and canonical single-link output", async t => {
  const root = directory(t), options = { outputPath: join(root, "success.json"), protectedRoots: [], timeoutMs: 5000 };
  const results = await Promise.allSettled([reserveV2ShadowMigrationEvidence(options), reserveV2ShadowMigrationEvidence(options)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  for (const result of results) if (result.status === "fulfilled") {
    const evidence = buildV2ShadowMigrationEvidence(input()), receipt = await writeV2ShadowMigrationEvidence({ reservation: result.value, evidence });
    assert.deepEqual(fs.readdirSync(root), ["success.json"]); assert.equal(fs.statSync(options.outputPath).nlink, 1); removePublishedFixture(root, receipt, evidence);
  }
});
test("symbolic output parents and occupied hardlink leaves refuse without reservation", async t => {
  const root = directory(t), target = directory(t), alias = join(root, "alias");
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(reserveV2ShadowMigrationEvidence({ outputPath: join(alias, "success.json"), protectedRoots: [], timeoutMs: 5000 }));
  assert.deepEqual(fs.readdirSync(target), []);
  for (const name of ["success.json", FAILURE, CONTROL]) {
    const parent = directory(t), existing = join(parent, name), source = join(root, name + ".owned");
    fs.writeFileSync(source, "owned-existing", { flag: "wx" }); fs.linkSync(source, existing);
    await assert.rejects(reserveV2ShadowMigrationEvidence({ outputPath: join(parent, "success.json"), protectedRoots: [], timeoutMs: 5000 }));
    assert.deepEqual(fs.readdirSync(parent), [name]); assert.equal(fs.readFileSync(existing, "utf8"), "owned-existing");
  }
});
test("native link and unlink boundaries retain exact bytes and two-to-one identities", async t => {
  const root = directory(t), traceRoot = directory(t), trace = join(traceRoot, "trace.jsonl");
  const restore = childHook(t, `const trace=${JSON.stringify(trace)};const link=fs.linkSync,unlink=fs.unlinkSync;const record=(phase,name)=>{const s=fs.statSync(name);fs.appendFileSync(trace,JSON.stringify({phase,nlink:s.nlink,ino:s.ino,bytes:fs.readFileSync(name,'utf8')})+'\\n')};fs.linkSync=(a,b)=>{link(a,b);record('linked',a);record('linked-final',b)};fs.unlinkSync=p=>{unlink(p);if(String(p).endsWith('.tmp'))record('temporary-removed','success.json')};`);
  let receipt: Awaited<ReturnType<typeof writeV2ShadowMigrationEvidence>> | undefined;
  try { const reservation = await reserveV2ShadowMigrationEvidence({ outputPath: join(root, "success.json"), protectedRoots: [], timeoutMs: 5000 });
    receipt = await writeV2ShadowMigrationEvidence({ reservation, evidence: buildV2ShadowMigrationEvidence(input()) }); }
  finally { restore(); }
  const rows = fs.readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => [row.phase, row.nlink]), [["linked", 2], ["linked-final", 2], ["temporary-removed", 1]]);
  assert.equal(new Set(rows.map(row => row.ino)).size, 1);
  for (const row of rows) assert.equal(row.bytes, canonicalJson(buildV2ShadowMigrationEvidence(input())) + "\n");
  assert.ok(receipt); removePublishedFixture(root, receipt, buildV2ShadowMigrationEvidence(input()));
  const stat = fs.statSync(trace, { bigint: true }); removeOwnedFile(traceRoot, "trace.jsonl", { device: String(stat.dev), inode: String(stat.ino) }, fs.readFileSync(trace, "utf8"));
});
test("idle child deadline refuses later publication and retains reservation", async t => {
  const root = directory(t), reservation = await reserveV2ShadowMigrationEvidence({ outputPath: join(root, "success.json"), protectedRoots: [], timeoutMs: 1500 });
  await new Promise(resolve => setTimeout(resolve, 1700));
  await assert.rejects(writeV2ShadowMigrationEvidence({ reservation, evidence: buildV2ShadowMigrationEvidence(input()) }));
  assert.deepEqual(fs.readdirSync(root), [CONTROL]);
});
test("genuine typed pre-run failure is serialized and published with retained reservation; crafted errors refuse", async t => {
  const f = await createShadowMigrationRunnerFixture(t); let failure: unknown;
  try { await new V2ShadowMigrationRunner({ driver: f.driver, utcNow: () => f.manifest.createdAt }).run({ ...f.runnerInput,
    sealedRetrieval: { corpus: f.corpus, expectedBundle: { ...f.corpus.bundle, files: { ...f.corpus.bundle.files, "judgments.json": "0".repeat(64) } } } }); }
  catch (error) { failure = error; }
  const carrier = readV2ShadowMigrationPreflightEvidence(failure); assert.ok(carrier);
  const document = buildV2ShadowMigrationPreflightFailureEvidence(failure);
  assert.equal(document.evidenceChecksum, hash("project-memory/v2-shadow-migration-preflight-failure-evidence/v1\n" + canonicalJson(carrier)));
  for (const fake of [new Error("secret"), carrier, { ...failure as object }, new V2ShadowMigrationPreflightFailure("MIGRATION_SOURCE_INVALID", carrier)])
    assert.throws(() => buildV2ShadowMigrationPreflightFailureEvidence(fake));
  const root = directory(t), reservation = await reserveV2ShadowMigrationEvidence({ outputPath: join(root, "success.json"), protectedRoots: [], timeoutMs: 5000 });
  await writeV2ShadowMigrationEvidence({ reservation, failure });
  assert.equal(fs.readFileSync(join(root, FAILURE), "utf8"), canonicalJson(document) + "\n");
  assert.deepEqual(fs.readdirSync(root).sort(), [CONTROL, FAILURE].sort());
});
