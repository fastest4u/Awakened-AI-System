import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { isBuiltin, syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { buildV2ShadowMigrationEvidence, buildV2ShadowMigrationPreflightFailureEvidence,
  reserveV2ShadowMigrationEvidence, writeV2ShadowMigrationEvidence,
  hasRequiredApprovedV2ShadowMigrationReviews, V2ShadowMigrationEvidenceError, type V2ShadowMigrationEvidenceV1,
} from "../src/orchestrator/migration/v2-shadow-migration-evidence.js";
import { V2ShadowMigrationRunner, V2ShadowMigrationPreflightFailure, readV2ShadowMigrationPreflightEvidence } from "../src/orchestrator/migration/v2-shadow-migration-runner.js";
import { createCompatibilityFixture, createShadowMigrationRunnerFixture, createSnapshotParityFixture, sealManifest } from "./support/v2-shadow-migration-fixture.js";
import { shadowMigrationPolicyChecksum, shadowMigrationConfigurationChecksum } from "../src/orchestrator/migration/v2-shadow-migration.contracts.js";
import { readV2ShadowRehearsalResources } from "../src/orchestrator/migration/v2-shadow-migration-rehearsal.js";
import { readV2ShadowImportBatchObservation, V2ShadowImporter } from "../src/orchestrator/migration/v2-shadow-importer.js";
import { SqliteEventStoreStatements } from "../src/orchestrator/storage/event-store.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import type { V2ShadowMigrationRunResult } from "../src/orchestrator/migration/v2-shadow-migration-runner.js";
import { expectedDifferenceRuleChecksum } from "../src/orchestrator/parity/v2-expected-difference.js";
import { openImmutableProjectionImage } from "../src/orchestrator/projections/integrity.js";
import { verifyV1SourceCopy } from "../src/orchestrator/migration/v1-source-copy.js";

let compiledPreflight: Promise<any> | undefined;
const nativeRecipePath = `node_modules/@esbuild/${process.platform}-${process.arch}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`;
// This snapshot is independent of the original Git administration and captures current bytes,
// including uncommitted additions/deletions. It is synthetic functional evidence only.
function cleanBuildFixture(t: TestContext): string {
  const original = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "v2-clean-build-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captures = new Map<string, Buffer>(), directories = new Map<string, string[]>(); let total = 0;
  const originalHead = fixtureGit(original, ["rev-parse", "HEAD"]);
  const originalStatus = fixtureGit(original, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const indexPath = resolve(original, fixtureGit(original, ["rev-parse", "--git-path", "index"]).trim());
  const indexBytes = fs.readFileSync(indexPath);
  function copy(name: string): void {
    if (captures.has(name)) return;
    const source = join(original, name), stat = fs.lstatSync(source);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) {
      const children = fs.readdirSync(source).filter(child => child !== "node_modules").sort();
      directories.set(name, children);
      for (const child of children) copy(join(name, child));
      return;
    }
    assert.ok(stat.isFile());
    const bytes = fs.readFileSync(source); total += bytes.length;
    assert.ok(total <= 256 * 1024 * 1024 && captures.size < 20000, "bounded current-byte fixture");
    captures.set(name, bytes); fs.mkdirSync(dirname(join(root, name)), { recursive: true });
    fs.writeFileSync(join(root, name), bytes);
  }
  for (const name of ["src", "package.json", "package-lock.json", "tsconfig.json", ".gitignore",
    "scripts/build.js", "scripts/fresh-start-build.js", "scripts/run-v2-shadow-migration-rehearsal.js"]) copy(name);
  const packages = new Set<string>();
  function dependency(name: string, from: string): void {
    let cursor = from, found: string | undefined;
    while (cursor.startsWith(original)) {
      const candidate = join(cursor, "node_modules", name);
      if (fs.existsSync(join(candidate, "package.json"))) { found = candidate; break; }
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    assert.ok(found, `installed fixture dependency ${name}`);
    if (packages.has(found)) return; packages.add(found);
    copy(relative(original, found));
    const pkg = JSON.parse(fs.readFileSync(join(found, "package.json"), "utf8"));
    for (const child of Object.keys(pkg.dependencies ?? {})) dependency(child, found);
    // esbuild's one installed native tool is optional, platform-specific build input.
    for (const child of Object.keys(pkg.optionalDependencies ?? {})) {
      if (fs.existsSync(join(original, "node_modules", child, "package.json"))) dependency(child, found);
    }
  }
  for (const name of ["esbuild", "javascript-obfuscator", "typescript", "zod", "@modelcontextprotocol/sdk"])
    dependency(name, name === "zod" || name === "@modelcontextprotocol/sdk" ? original : join(original, "scripts"));
  for (const [name, bytes] of captures) {
    assert.deepEqual(fs.readFileSync(join(original, name)), bytes, "capture correspondence at source");
    assert.deepEqual(fs.readFileSync(join(root, name)), bytes, "capture correspondence at destination");
  }
  for (const [name, children] of directories) assert.deepEqual(fs.readdirSync(join(original, name)).filter(child => child !== "node_modules").sort(), children,
    "capture correspondence includes additions and deletions");
  fixtureGit(root, ["init", "--quiet"]);
  fixtureGit(root, ["add", "--", "."]);
  fixtureGit(root, ["commit", "--quiet", "-m", "synthetic current-byte build fixture"]);
  assert.equal(fixtureGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.ok(fs.statSync(join(root, ".git")).isDirectory());
  assert.equal(fixtureGit(original, ["rev-parse", "HEAD"]), originalHead);
  assert.equal(fixtureGit(original, ["status", "--porcelain=v1", "--untracked-files=all"]), originalStatus);
  assert.deepEqual(fs.readFileSync(indexPath), indexBytes, "the original index is not mutated");
  return root;
}
function fixtureGit(root: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  return childProcess.execFileSync("git", ["--no-optional-locks", "-c", "core.autocrlf=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@invalid", ...args], { cwd: root, env, encoding: "utf8", windowsHide: true });
}
function fixtureBuild(root: string) {
  return childProcess.spawnSync(process.execPath, ["scripts/build.js"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
}
function treeIdentity(root: string): unknown {
  const stat = fs.lstatSync(root, { bigint: true });
  return [String(stat.dev), String(stat.ino), String(stat.nlink), stat.isDirectory()
    ? fs.readdirSync(root).sort().map(name => [name, treeIdentity(join(root, name))])
    : createHash("sha256").update(fs.readFileSync(root)).digest("hex")];
}
test("private builtin loader exception is path-specific and closed before and after bundling", async t => {
  const root = cleanBuildFixture(t), manifestPath = join(root, "dist/internal/v2-shadow-migration-build.json");
  const built = fixtureBuild(root); assert.equal(built.status, 0, built.stdout + built.stderr);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); assert.equal(manifest.eligible, true);
  assert.ok(manifest.inputs.some((input: any) => input.path === "src/orchestrator/storage/schema-fingerprint.ts"));
  const entry = pathToFileURL(join(root, "dist/internal/v2-shadow-migration-rehearsal.js")).href;
  const imported = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)});`],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, ""); assert.equal(imported.stderr, "");
  for (const [name, mutate] of [
    ["nonbuiltin", (text: string) => text.replace('require("node:sqlite")', 'require("unmeasured-module")')],
    ["computed", (text: string) => text.replace('require("node:sqlite")', 'require(process.env.PRIVATE_SQLITE!)')],
    ["extra argument", (text: string) => text.replace('require("node:sqlite")', 'require("node:sqlite", "extra")')],
    ["escaped loader", (text: string) => text + '\nexport const escapedLoader = require;\n'],
    ["reassigned loader", (text: string) => text.replace('const require =', 'let require =') + '\nrequire = (() => null) as any;\n'],
    ["aliased factory", (text: string) => text + '\nconst escapedFactory = createRequire;\n'],
  ] as const) await t.test(name, () => {
    const path = join(root, "src/orchestrator/storage/schema-fingerprint.ts"), bytes = fs.readFileSync(path);
    try {
      const changed = mutate(bytes.toString()); assert.notEqual(changed, bytes.toString()); fs.writeFileSync(path, changed);
      const result = fixtureBuild(root); assert.notEqual(result.status, 0); assert.match(result.stderr, /REHEARSAL_BUILD_INVALID/);
      assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).eligible, false);
    } finally { fs.writeFileSync(path, bytes); }
  });
  await t.test("the same loader in another measured source refuses", () => {
    const path = join(root, "src/orchestrator/migration/v2-shadow-migration-rehearsal.ts"), bytes = fs.readFileSync(path);
    try {
      fs.appendFileSync(path, '\nimport {createRequire} from "node:module"; const require = createRequire(import.meta.url); require("node:sqlite");\n');
      const result = fixtureBuild(root); assert.notEqual(result.status, 0); assert.match(result.stderr, /REHEARSAL_BUILD_INVALID/);
    } finally { fs.writeFileSync(path, bytes); }
  });
  await t.test("emitted renamed bindings cannot escape the independent AST proof", async () => {
    const ts = (await import("typescript")).default;
    const buildText = fs.readFileSync(join(root, "scripts/build.js"), "utf8");
    const body = buildText.slice(buildText.indexOf("function assertClosedSyntax("), buildText.indexOf("function measuredPrivateBuild("));
    assert.ok(body.startsWith("function assertClosedSyntax("));
    // Execute the exact producer checker, not a copied test implementation.
    const check = new Function("ts", "isBuiltin", "buildRefusal", body + ";return assertClosedSyntax;")(
      ts, isBuiltin, () => { throw new Error("REHEARSAL_BUILD_INVALID"); });
    const emitted = 'import{createRequire as factory}from"node:module";var loader=factory(import.meta.url);function load(){return loader("node:sqlite")}';
    assert.doesNotThrow(() => check("dist/internal/v2-shadow-migration-rehearsal.js", Buffer.from(emitted), true));
    for (const changed of [emitted.replace('"node:sqlite"', '"unmeasured"'), emitted.replace('"node:sqlite"', 'process.env.LOAD'),
      emitted.replace('loader("node:sqlite")', 'loader("node:sqlite",1)'), emitted + ';const alias=loader;', emitted + ';loader=other;',
      emitted + ';const alias=factory;', emitted.replace('factory(import.meta.url)', 'factory(other)'),
      emitted.replace('loader("node:sqlite")', 'loader.call(null,"node:sqlite")'), emitted + ';function hidden(loader){return loader("node:sqlite")}',
      emitted + ';export{loader};']) {
      assert.throws(() => check("dist/internal/v2-shadow-migration-rehearsal.js", Buffer.from(changed), true), /REHEARSAL_BUILD_INVALID/);
    }
  });
});
test("branch-bound source fixture is sealed from production Git/lifecycle events", async t => {
  const f = await createSnapshotParityFixture(t, { branchBoundSource: true, rankingPair: true });
  assert.match(f.projectionBinding.branchRef!, /^refs\/heads\//);
  assert.ok(f.projectionBinding.branchScopeId);
  const manifest = JSON.parse(fs.readFileSync(f.manifestPath, "utf8"));
  assert.equal(manifest.branchRef, f.projectionBinding.branchRef);
  assert.equal(manifest.branchScopeId, f.projectionBinding.branchScopeId);
  assert.deepEqual(manifest, f.manifest);
  const liveEvents = f.driver.open(f.liveEventStorePath, { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    const rows = liveEvents.prepare("SELECT branch_scope_id,branch_ref,event_hash FROM events ORDER BY global_position").all();
    assert.equal(rows.length, f.sourceEvents.length);
    assert.deepEqual(rows.map(row => [row.branch_scope_id, row.branch_ref, row.event_hash]),
      f.sourceEvents.map(event => [event.branchScopeId, event.branchRef, event.eventHash]));
    assert.ok(rows.every(row => row.branch_scope_id === f.projectionBinding.branchScopeId
      && row.branch_ref === f.projectionBinding.branchRef));
  } finally { liveEvents.close(); }
  const verified = await verifyV1SourceCopy(f.verificationInput);
  verified.close();
});
async function compiledCommandFixture(t: TestContext, branchBoundSource: boolean) {
  const buildRoot = cleanBuildFixture(t), built = fixtureBuild(buildRoot);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const build = JSON.parse(fs.readFileSync(join(buildRoot, "dist/internal/v2-shadow-migration-build.json"), "utf8"));
  assert.equal(build.eligible, true);
  const f = await createSnapshotParityFixture(t, { branchBoundSource, rankingPair: true, legacyArtifacts: true });
  const corpusRoot = join(f.root, "command-corpus"); fs.mkdirSync(corpusRoot);
  const artifacts = { "manifest.json": f.corpus.bundle,
    "source-events.json": { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", sources: f.corpus.sources },
    "judgments.json": { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", queries: f.corpus.queries },
    "v1-shadow-baseline.json": f.corpus.baseline };
  for (const [name, value] of Object.entries(artifacts)) fs.writeFileSync(join(corpusRoot, name), JSON.stringify(value));
  const configuration = { schemaVersion: 1 as const, policyChecksum: shadowMigrationPolicyChecksum(f.policy), packageFormatVersion: 1 as const,
    migrationAlgorithmVersion: 1 as const, expectedDifferencePolicyVersion: f.policy.expectedDifferencePolicyVersion };
  const config = { sourceManifestPath: f.manifestPath, liveEventStorePath: f.liveEventStorePath, liveLegacyArtifactRoot: f.liveVaultRoot,
    expectedBinding: f.projectionBinding, configuration, policy: f.policy, expectedDifferenceRules: [],
    sealedRetrieval: { bundleRoot: corpusRoot, expectedBundle: f.corpus.bundle }, buildIdentityHash: build.buildIdentityHash,
    rolloutRevisionTemplate: { projectId: f.projectionBinding.projectId, revisionId: f.input.rolloutRevisionId, parentRevisionId: null,
      buildIdentityHash: build.buildIdentityHash, configurationChecksum: shadowMigrationConfigurationChecksum(configuration),
      cohortAlgorithmVersion: 1, cohortSalt: hash("synthetic-command-salt"), cohortBasisPoints: 0, createdAt: f.manifest.createdAt },
    tests: [{ name: "synthetic-current-byte-build", passed: 1, failed: 0, skipped: 0 }], reviews: [] };
  const configPath = join(f.root, "command.json"); fs.writeFileSync(configPath, JSON.stringify(config));
  const workRoot = join(f.root, "command-work"), packageRoot = join(f.root, "command-packages");
  fs.mkdirSync(workRoot); fs.mkdirSync(packageRoot);
  return { buildRoot, build, f, corpusRoot, config, configPath, workRoot, packageRoot };
}

test("branch-bound compiled rehearsal accepts the authenticated source binding", async t => {
  const { buildRoot, build, f, corpusRoot, config, configPath, workRoot, packageRoot } = await compiledCommandFixture(t, true);
  const outputParent = directory(t), output = join(outputParent, "branch-functional.json");
  const protectedBefore = [f.sourceRoot, corpusRoot, f.liveVaultRoot].map(treeIdentity);
  const args = ["scripts/run-v2-shadow-migration-rehearsal.js", "--config", configPath,
    "--source-root", f.sourceRoot, "--package-root", packageRoot, "--work-root", workRoot, "--evidence-output", output];
  const mismatchedRoot = join(f.root, "disposable-mismatched-source");
  fs.cpSync(f.sourceRoot, mismatchedRoot, { recursive: true });
  const mismatchedManifestPath = join(mismatchedRoot, "manifest.json");
  fs.writeFileSync(mismatchedManifestPath, canonicalJson(sealManifest({ ...f.manifest, branchRef: "refs/heads/wrong-sealed-copy" })));
  const refused = async (name: string, changedConfig: unknown, changedArgs = args) => t.test(name, () => {
    const selectedBefore = [workRoot, packageRoot, outputParent].map(treeIdentity);
    const sourcesBefore = [f.sourceRoot, corpusRoot, f.liveVaultRoot, mismatchedRoot].map(treeIdentity);
    fs.writeFileSync(configPath, JSON.stringify(changedConfig));
    try {
      const rejected = childProcess.spawnSync(process.execPath, changedArgs,
        { cwd: buildRoot, env: { ...process.env, NODE_ENV: "production-rehearsal" }, encoding: "utf8", windowsHide: true, timeout: 60000 });
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.equal(rejected.stdout, ""); assert.equal(rejected.stderr, "REHEARSAL_REFUSED\n");
      assert.deepEqual([workRoot, packageRoot, outputParent].map(treeIdentity), selectedBefore, "refusal precedes selected writes");
      assert.deepEqual([f.sourceRoot, corpusRoot, f.liveVaultRoot, mismatchedRoot].map(treeIdentity), sourcesBefore);
    } finally { fs.writeFileSync(configPath, JSON.stringify(config)); }
  });
  assert.notEqual(f.projectionBinding.branchRef, "refs/heads/wrong-branch");
  await refused("valid-looking wrong branch ref refuses before writes",
    { ...config, expectedBinding: { ...f.projectionBinding, branchRef: "refs/heads/wrong-branch" } });
  const wrongScope = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.notEqual(f.projectionBinding.branchScopeId, wrongScope);
  await refused("wrong branch scope UUID refuses before writes",
    { ...config, expectedBinding: { ...f.projectionBinding, branchScopeId: wrongScope } });
  await refused("mismatched sealed manifest copy refuses before writes",
    { ...config, sourceManifestPath: mismatchedManifestPath },
    args.map(value => value === f.sourceRoot ? mismatchedRoot : value));
  const result = childProcess.spawnSync(process.execPath, args,
    { cwd: buildRoot, env: { ...process.env, NODE_ENV: "production-rehearsal" }, encoding: "utf8", windowsHide: true, timeout: 1200000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const bytes = fs.readFileSync(output, "utf8"), evidence = JSON.parse(bytes) as V2ShadowMigrationEvidenceV1;
  const { evidenceChecksum, ...body } = evidence;
  assert.equal(evidenceChecksum, hash("project-memory/v2-shadow-migration-evidence/v1\n" + canonicalJson(body)));
  assert.equal(bytes, canonicalJson(evidence) + "\n");
  assert.equal(evidence.sourceManifestChecksum, f.manifest.manifestChecksum);
  assert.equal(evidence.counts.sourceScopeProvenanceRecords, f.manifest.eventCount);
  assert.ok(f.manifest.eventCount > 2, "the real full source-bound corpus was imported");
  assert.equal(evidence.deterministicRuns.length, 3);
  for (const [index, run] of evidence.deterministicRuns.entries()) {
    assert.equal(run.runOrdinal, index + 1);
    assert.equal(run.deduplicated, false);
    assert.deepEqual(run.determinismVector, evidence.noOpRun.determinismVector);
    assert.ok(fs.statSync(join(workRoot, `run-${index + 1}/events.sqlite`)).isFile());
  }
  assert.equal(evidence.noOpRun.runOrdinal, 4);
  assert.equal(evidence.noOpRun.deduplicated, true);
  assert.equal(evidence.noOpRun.determinismVector.sourceRecordCount, f.manifest.eventCount + f.manifest.legacyArtifacts.length);
  assert.equal(evidence.noOpRun.determinismVector.compatibilityArtifactSetChecksum, evidence.compatibility.artifactSetChecksum);
  const noOpGate = evidence.gates.find(gate => gate.name === "fourth-semantic-no-op");
  assert.ok(noOpGate); assert.equal(noOpGate.status, "passed");
  assert.match(noOpGate.evidenceDigest, /^[a-f0-9]{64}$/, "published digest binds unchanged semantic rows and artifacts");
  assert.equal(evidence.parity.blocking, 0);
  assert.equal(evidence.sourceBeforeChecksum, evidence.sourceAfterChecksum);
  const target = f.driver.open(join(workRoot, "run-3/events.sqlite"), { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    const wrappers = target.prepare("SELECT branch_scope_id,branch_ref,payload_json FROM events WHERE event_type='V1ProjectionSourceImported' ORDER BY global_position").all();
    assert.equal(wrappers.length, f.manifest.eventCount);
    for (const [ordinal, wrapper] of wrappers.entries()) {
      assert.equal(wrapper.branch_scope_id, null, "target wrapper remains non-Git-scoped");
      assert.equal(wrapper.branch_ref, null, "target wrapper has no fabricated Git branch");
      const sourceEvent = JSON.parse(String(wrapper.payload_json)).sourceEvent;
      assert.equal(sourceEvent.branchScopeId, f.projectionBinding.branchScopeId);
      assert.equal(sourceEvent.branchRef, f.projectionBinding.branchRef);
      assert.equal(sourceEvent.eventHash, f.sourceEvents[ordinal]!.eventHash);
    }
  } finally { target.close(); }
  assert.deepEqual([f.sourceRoot, corpusRoot, f.liveVaultRoot].map(treeIdentity), protectedBefore);
});

test("retains synthetic functional evidence from the fresh compiled rehearsal command", async t => {
  const { buildRoot, build, f, corpusRoot, config, configPath, workRoot, packageRoot } = await compiledCommandFixture(t, false);
  const retained = process.env.V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT;
  let outputParent: string, output: string;
  if (retained !== undefined) {
    assert.equal(resolve(retained), retained, "retained destination must be absolute and canonical");
    output = retained; outputParent = dirname(output);
    if (!fs.existsSync(outputParent)) { assert.equal(fs.realpathSync.native(dirname(outputParent)), dirname(outputParent)); fs.mkdirSync(outputParent); }
    assert.equal(fs.realpathSync.native(outputParent), outputParent); assert.deepEqual(fs.readdirSync(outputParent), []);
    ownedDirectories.set(outputParent, fs.lstatSync(outputParent, { bigint: true }));
  } else { outputParent = directory(t); output = join(outputParent, "synthetic-functional.json"); }
  const protectedBefore = [f.sourceRoot, corpusRoot, f.liveVaultRoot].map(treeIdentity);
  const args = ["scripts/run-v2-shadow-migration-rehearsal.js", "--config", configPath, "--source-root", f.sourceRoot,
    "--package-root", packageRoot, "--work-root", workRoot, "--evidence-output", output];
  const refused = async (name: string, changedArgs = args, changedConfig: unknown = config, environment = "production-rehearsal") => t.test(name, () => {
    const before = [workRoot, packageRoot, outputParent].map(treeIdentity);
    fs.writeFileSync(configPath, JSON.stringify(changedConfig));
    try {
      const observed = childProcess.spawnSync(process.execPath, changedArgs, { cwd: buildRoot,
        env: { ...process.env, NODE_ENV: environment }, encoding: "utf8", windowsHide: true, timeout: 60000 });
      assert.equal(observed.status, 1, observed.stdout + observed.stderr); assert.equal(observed.stdout, "");
      assert.equal(observed.stderr, "REHEARSAL_REFUSED\n");
      assert.deepEqual([workRoot, packageRoot, outputParent].map(treeIdentity), before, "refusal precedes targets and reservation");
      assert.deepEqual([f.sourceRoot, corpusRoot, f.liveVaultRoot].map(treeIdentity), protectedBefore);
    } finally { fs.writeFileSync(configPath, JSON.stringify(config)); }
  });
  await refused("wrong environment refuses before selected writes", args, config, "production");
  await refused("missing flag refuses", args.slice(0, -2));
  await refused("duplicate flag refuses", args.map(value => value === "--work-root" ? "--source-root" : value));
  await refused("unknown flag refuses", args.map(value => value === "--work-root" ? "--unknown-root" : value));
  await refused("relative selected path refuses", args.map(value => value === workRoot ? "relative" : value));
  await refused("unknown configuration refuses", args, { ...config, unexpected: true });
  await refused("mismatched build identity refuses", args, { ...config, buildIdentityHash: "0".repeat(64) });
  await refused("config-only branch string against unbranched source refuses before writes", args,
    { ...config, expectedBinding: { ...f.projectionBinding, branchRef: "refs/heads/config-only" } });
  await refused("unapproved corpus refuses", args, { ...config, sealedRetrieval: { ...config.sealedRetrieval,
    expectedBundle: { ...f.corpus.bundle, files: { ...f.corpus.bundle.files, "judgments.json": "0".repeat(64) } } } });
  await refused("sensitive supplied test labels refuse", args, { ...config, tests: [{ name: "sk-secret-test-token", passed: 1, failed: 0, skipped: 0 }] });
  await refused("source-work alias refuses", args.map(value => value === workRoot ? f.sourceRoot : value));
  await refused("package-work alias refuses", args.map(value => value === workRoot ? packageRoot : value));
  await refused("protected evidence destination refuses", args.map(value => value === output ? join(f.sourceRoot, "evidence.json") : value));
  const trace = join(f.root, "command-observations.jsonl"), hook = join(f.root, "command-observations.mjs");
  fs.writeFileSync(hook, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    import {DatabaseSync} from 'node:sqlite';
    const record=value=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(value)+'\\n');
    let run3Created=false, revisionReads=0, semanticSeen=false, pending=0;
    const nativePrepare=DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare=function(sql,...rest){
      if(run3Created&&sql.includes('FROM rollout_revisions WHERE project_id')&&++revisionReads===2)pending=3;
      if(run3Created&&!semanticSeen&&sql==="SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name"){
        semanticSeen=true;pending=4}
      return nativePrepare.call(this,sql,...rest)};
    const nativeExec=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql,...rest){
      if(sql!=='BEGIN IMMEDIATE'||pending===0)return nativeExec.call(this,sql,...rest);
      const pass=pending;pending=0;const locker=new DatabaseSync(${JSON.stringify(join(workRoot, "run-3/events.sqlite"))});
      nativeExec.call(locker,'BEGIN IMMEDIATE');
      try{return nativeExec.call(this,sql,...rest)}catch(error){record({kind:'writer-retry',pass,errcode:error?.errcode});throw error}
      finally{nativeExec.call(locker,'ROLLBACK');locker.close()}};
    const mkdir=fs.mkdirSync;fs.mkdirSync=(path,...rest)=>{const result=mkdir(path,...rest);
      const ordinal=${JSON.stringify([1, 2, 3].map(n => join(workRoot, `run-${n}`)))}.indexOf(path);
      if(ordinal>=0){if(ordinal===2)run3Created=true;record({kind:'run-created',ordinal:ordinal+1,utcMs:Date.now()})}return result;};
    const usage=process.resourceUsage;process.resourceUsage=()=>{const value=usage();record({kind:'rss-cutoff',rawMaxRSS:value.maxRSS,
      outputExists:fs.existsSync(${JSON.stringify(output)})});return value;};syncBuiltinESMExports();`);
  const result = childProcess.spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, ...args], { cwd: buildRoot, env: { ...process.env, NODE_ENV: "production-rehearsal" },
    encoding: "utf8", windowsHide: true, timeout: 1200000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const bytes = fs.readFileSync(output, "utf8"), document = JSON.parse(bytes) as V2ShadowMigrationEvidenceV1;
  const stat = fs.lstatSync(output, { bigint: true }); assert.equal(stat.nlink, 1n);
  const { evidenceChecksum, ...body } = document;
  assert.equal(evidenceChecksum, hash("project-memory/v2-shadow-migration-evidence/v1\n" + canonicalJson(body)));
  assert.equal(bytes, canonicalJson(document) + "\n"); assert.deepEqual(document.reviews, []);
  assert.equal(document.commit, build.commit); assert.equal(document.buildIdentityHash, build.buildIdentityHash);
  assert.equal(document.counts.retrievalQueries, f.corpus.queries.length); assert.equal(f.corpus.queries.length, 11);
  const expectedPath = f.input.projections.v2.databasePath, expectedStat = fs.lstatSync(expectedPath, { bigint: true });
  assert.ok(expectedStat.isFile() && expectedStat.nlink === 1n && expectedStat.size <= 128n * 1024n * 1024n);
  const expectedBytes = fs.readFileSync(expectedPath);
  assert.equal(createHash("sha256").update(expectedBytes).digest("hex"), f.input.projections.v2.manifest.databaseSha256);
  const expectedProjection = openImmutableProjectionImage(expectedBytes);
  try {
    for (const [name, table] of [["projectedLifecycleSessions", "session_tree"], ["projectedCheckpoints", "session_checkpoints"],
      ["projectedFollowUps", "tasks_followups"]] as const)
      assert.equal(document.counts[name], Number(expectedProjection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n));
  } finally { expectedProjection.close(); }
  assert.equal(fs.lstatSync(expectedPath, { bigint: true }).ino, expectedStat.ino);
  assert.equal(createHash("sha256").update(fs.readFileSync(expectedPath)).digest("hex"), f.input.projections.v2.manifest.databaseSha256);
  assert.ok(document.counts.projectedLifecycleSessions! > 0); assert.ok(document.counts.projectedCheckpoints! > 0);
  assert.equal(document.counts.projectedFollowUps, 0, "the sealed corpus has no structured follow-up records");
  assert.equal(document.counts.sourceScopeProvenanceRecords, f.manifest.eventCount);
  assert.equal(document.sourceBeforeChecksum, document.sourceAfterChecksum);
  assert.equal(document.deterministicRuns.length, 3);
  for (const run of document.deterministicRuns) { assert.equal(run.deduplicated, false); assert.deepEqual(run.determinismVector, document.noOpRun.determinismVector); }
  assert.equal(document.noOpRun.deduplicated, true); assert.equal(document.parity.blocking, 0);
  assert.ok(document.performance.maxBatchEvents > 0); assert.ok(document.performance.maxBatchBytes > 0);
  assert.ok(document.performance.peakRssBytes > 0); assert.equal(document.performance.peakRssBytes % 1024, 0);
  const retryConnection = f.driver.open(join(workRoot, "run-3/events.sqlite"), { mode: "read-only-existing", busyTimeoutMs: 5000 });
  try {
    const rows = retryConnection.prepare("SELECT outcome_category, safe_error_code FROM v2_shadow_migration_attempts ORDER BY attempt_ordinal").all();
    assert.deepEqual(rows.map(row => ({ ...row })), [
      { outcome_category: "retryable-failure", safe_error_code: "SQLITE_BUSY" },
      { outcome_category: "retryable-failure", safe_error_code: "SQLITE_BUSY" },
    ]);
  } finally { retryConnection.close(); }
  assert.equal(document.performance.retries, 2, "pass-three and newly observed pass-four attempts count once each");
  const observed = fs.readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(observed.map(value => value.kind), ["run-created", "run-created", "run-created", "writer-retry", "writer-retry", "rss-cutoff"]);
  assert.ok(observed[0].utcMs < observed[1].utcMs && observed[1].utcMs < observed[2].utcMs, "real passes begin under different actual clocks");
  assert.deepEqual(observed.slice(3, 5).map(value => [value.pass, value.errcode & 0xff]), [[3, 5], [4, 5]]);
  assert.equal(observed[5].outputExists, false); assert.equal(document.performance.peakRssBytes, observed[5].rawMaxRSS * 1024);
  assert.ok(document.gates.length > 0 && document.gates.every(g => g.status === "passed"));
  assert.equal(bytes.includes(f.root), false); assert.equal(bytes.includes(buildRoot), false);
  assert.deepEqual([f.sourceRoot, corpusRoot, f.liveVaultRoot].map(treeIdentity), protectedBefore);
  assert.equal(fs.existsSync(join(outputParent, CONTROL)), false);
  const repeated = childProcess.spawnSync(process.execPath, args, { cwd: buildRoot, env: { ...process.env, NODE_ENV: "production-rehearsal" },
    encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(repeated.status, 1); assert.equal(fs.readFileSync(output, "utf8"), bytes);
  assert.equal(fs.lstatSync(output, { bigint: true }).ino, stat.ino);
  await t.test("expired rules use current UTC and publish only genuine pre-run failure evidence", () => {
    const failureWork = join(f.root, "expired-work"), failurePackages = join(f.root, "expired-packages"), failureOutput = directory(t);
    fs.mkdirSync(failureWork); fs.mkdirSync(failurePackages);
    const { ruleChecksum: _old, ...originalRule } = f.metadataRules[0]!;
    const rule = { ...originalRule, migrationIdentity: document.migrationIdentity,
      issuedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() - 30000).toISOString() };
    const expiredConfig = { ...config, expectedDifferenceRules: [{ ...rule, ruleChecksum: expectedDifferenceRuleChecksum(rule) }] };
    fs.writeFileSync(configPath, JSON.stringify(expiredConfig));
    try {
      const expiredArgs = args.map(value => value === workRoot ? failureWork : value === packageRoot ? failurePackages
        : value === output ? join(failureOutput, "success.json") : value);
      const expired = childProcess.spawnSync(process.execPath, expiredArgs, { cwd: buildRoot,
        env: { ...process.env, NODE_ENV: "production-rehearsal" }, encoding: "utf8", windowsHide: true, timeout: 120000 });
      assert.equal(expired.status, 1); assert.equal(expired.stdout, ""); assert.equal(expired.stderr, "REHEARSAL_REFUSED\n");
      assert.deepEqual(fs.readdirSync(failureOutput).sort(), [CONTROL, FAILURE].sort());
      const failureBytes = fs.readFileSync(join(failureOutput, FAILURE), "utf8"), failure = JSON.parse(failureBytes);
      const { evidenceChecksum: checksum, ...failureBody } = failure;
      assert.equal(checksum, hash("project-memory/v2-shadow-migration-preflight-failure-evidence/v1\n" + canonicalJson(failureBody)));
      assert.equal(failureBytes, canonicalJson(failure) + "\n"); assert.equal(failureBytes.includes(f.root), false);
      assert.equal(failure.rolloutRevisionId, config.rolloutRevisionTemplate.revisionId);
      const connection = f.driver.open(join(failureWork, "run-1/events.sqlite"), { mode: "read-only-existing", busyTimeoutMs: 5000 });
      try { assert.equal(connection.prepare("SELECT count(*) AS n FROM v2_shadow_migration_runs").get()!.n, 0n); }
      finally { connection.close(); }
    } finally { fs.writeFileSync(configPath, JSON.stringify(config)); }
  });
  for (const scenario of ["link-side-effect", "child-death", "lost-response"] as const) await t.test(`actual built publisher ${scenario} retains uncertain outcome`, async () => {
    const destination = directory(t), faultOutput = join(destination, "success.json");
    const bodies = {
      "link-side-effect": "const link=fs.linkSync;fs.linkSync=(a,b)=>{link(a,b);throw new Error('synthetic-secret')};",
      "child-death": "const link=fs.linkSync;fs.linkSync=(a,b)=>{link(a,b);process.exit(9)};",
      "lost-response": "const write=process.stdout.write.bind(process.stdout);process.stdout.write=(text,callback)=>{if(String(text).includes('published')){if(callback)callback();return true}return write(text,callback)};",
    };
    const restore = childHook(t, bodies[scenario], join(buildRoot, "dist/internal/v2-shadow-migration-rehearsal.js"));
    try {
      const reservation = await reserveV2ShadowMigrationEvidence({ outputPath: faultOutput, protectedRoots: [], timeoutMs: 5000 });
      await assert.rejects(writeV2ShadowMigrationEvidence({ reservation, evidence: document }), (error: any) => error.code === "EVIDENCE_OUTCOME_UNKNOWN"
        && !error.message.includes("synthetic-secret"));
    } finally { restore(); }
    assert.equal(fs.readFileSync(faultOutput, "utf8"), bytes, "original genuine finalized document, not reconstructed evidence");
    assert.equal(fs.statSync(faultOutput).nlink, scenario === "lost-response" ? 1 : 2);
    if (scenario !== "lost-response") assert.ok(fs.existsSync(join(destination, CONTROL)));
  });
  t.diagnostic(`synthetic functional evidence checksum ${evidenceChecksum}; fixture commit ${build.commit}`);
  if (!retained) removeOwnedFile(outputParent, output.slice(outputParent.length + 1), { device: String(stat.dev), inode: String(stat.ino) }, bytes);
});
test("resource aggregation uses genuine component maxima and refuses absent provenance or invalid RSS", async t => {
  const observations = [], results: V2ShadowMigrationRunResult[] = [];
  const large = await createSnapshotParityFixture(t), small = await createCompatibilityFixture(t);
  const workspace = { kind: "non-git" as const, workspaceRoot: small.root, workspaceId: small.projectionBinding.workspaceId };
  const smallContext = { ...large.context, workspace, binding: { ...large.context.binding, ...small.projectionBinding, workspace,
    projectRoot: small.root, vaultRoot: small.liveVaultRoot,
    storeRoute: { ...large.context.binding.storeRoute, storeRoot: dirname(small.eventStorePath), eventsPath: small.eventStorePath } } };
  for (const f of [large, { ...small, context: smallContext }]) {
    const imported = new V2ShadowImporter({ connection: f.connection, statements: new SqliteEventStoreStatements(f.connection),
      maintenance: new MaintenanceFence(), branchScopes: new BranchScopeRepository(), policy: f.policy })
      .import({ context: f.context, sealedPackage: f.sealedPackage });
    const observed = readV2ShadowImportBatchObservation(imported); assert.ok(observed); observations.push(observed);
    // Only the parent holder is synthetic; the opaque importer result is never copied or mocked.
    results.push({ import: imported } as V2ShadowMigrationRunResult);
  }
  const all = [results[0]!, results[1]!, results[0]!, results[1]!];
  const policy = { schemaVersion: 1, maxBatchEvents: Math.max(...observations.map(value => value.maxBatchEvents)),
    maxBatchBytes: Math.max(...observations.map(value => value.maxBatchBytes)) } as Parameters<typeof readV2ShadowRehearsalResources>[1];
  assert.notEqual(observations[0]!.maxBatchEvents, observations[1]!.maxBatchEvents);
  const original = process.resourceUsage;
  try {
    process.resourceUsage = () => ({ ...original(), maxRSS: 17 });
    const measured = readV2ShadowRehearsalResources(all, policy);
    assert.deepEqual(measured, { maxBatchEvents: policy.maxBatchEvents, maxBatchBytes: policy.maxBatchBytes, peakRssBytes: 17 * 1024 });
    assert.ok(Object.isFrozen(measured));
    for (const supplied of [[], all.slice(1), [...all, results[0]!], all.map(result => ({ ...result, import: { ...result.import } })),
      [{ import: {} }, ...all.slice(1)]]) assert.throws(() => readV2ShadowRehearsalResources(supplied as V2ShadowMigrationRunResult[], policy));
    assert.throws(() => readV2ShadowRehearsalResources(all, { ...policy, maxBatchEvents: policy.maxBatchEvents - 1 }));
    assert.throws(() => readV2ShadowRehearsalResources(all, { ...policy, maxBatchBytes: policy.maxBatchBytes - 1 }));
    for (const maxRSS of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, undefined]) {
      process.resourceUsage = () => ({ ...original(), maxRSS: maxRSS as number });
      assert.throws(() => readV2ShadowRehearsalResources(all, policy));
    }
    process.resourceUsage = () => { throw new Error("synthetic RSS unavailable"); };
    assert.throws(() => readV2ShadowRehearsalResources(all, policy));
  } finally { process.resourceUsage = original; }
});

test("tool loader resolution cannot escape the measured clean fixture", async t => {
  const root = cleanBuildFixture(t), manifestPath = join(root, "dist/internal/v2-shadow-migration-build.json");
  const baseline = fixtureBuild(root); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  const baselineManifest = fs.readFileSync(manifestPath), manifest = JSON.parse(baselineManifest.toString());
  const commandUrl = pathToFileURL(join(root, "scripts/run-v2-shadow-migration-rehearsal.js")).href;
  const module = await import(commandUrl), handoff = module.validateV2ShadowMigrationBuild(manifest.buildIdentityHash);
  const validate = (identity: string) => childProcess.spawnSync(process.execPath,
    ["--input-type=module", "-e", `const m=await import(${JSON.stringify(commandUrl)});try{m.validateV2ShadowMigrationBuild(${JSON.stringify(identity)});}catch{process.exit(7);}`],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 });
  const diagnosticDirectory = join(root, ".superpowers"); fs.mkdirSync(diagnosticDirectory);
  for (const [ordinal, variant] of ["local-esbuild", "local-typescript", "redirect-esbuild-main", "redirect-typescript-import", "nested-native"].entries()) {
    const tool = variant.includes("typescript") ? "typescript" : "esbuild";
    const packagePath = join(root, "node_modules", tool, "package.json"), packageBytes = fs.readFileSync(packagePath);
    const pkg = JSON.parse(packageBytes.toString()), marker = join(diagnosticDirectory, `executed-${ordinal}`);
    let selected: string, ownedDirectory: string | undefined;
    if (variant.startsWith("local-")) {
      ownedDirectory = join(root, "scripts/node_modules", tool); fs.mkdirSync(ownedDirectory, { recursive: true });
      selected = join(ownedDirectory, "index.cjs");
      fs.writeFileSync(join(ownedDirectory, "package.json"), JSON.stringify({ name: tool, version: pkg.version, main: "index.cjs" }));
      fs.writeFileSync(selected, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed'); module.exports=require('../../../node_modules/${tool}/lib/${tool === "esbuild" ? "main" : "typescript"}.js');`);
    } else if (variant.startsWith("redirect-")) {
      selected = join(root, "node_modules", tool, "redirect.cjs");
      fs.writeFileSync(selected, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed'); module.exports=require('./lib/${tool === "esbuild" ? "main" : "typescript"}.js');`);
      fs.writeFileSync(packagePath, JSON.stringify(variant.endsWith("-main") ? { ...pkg, main: "redirect.cjs" }
        : { ...pkg, exports: { ".": { import: "./redirect.cjs", require: "./lib/typescript.js" } } }));
    } else {
      const packageName = `@esbuild/${process.platform}-${process.arch}`, native = process.platform === "win32" ? "esbuild.exe" : "bin/esbuild";
      ownedDirectory = join(root, "node_modules/esbuild/node_modules", packageName);
      selected = join(ownedDirectory, native); fs.mkdirSync(dirname(selected), { recursive: true });
      fs.copyFileSync(join(root, "node_modules", packageName, "package.json"), join(ownedDirectory, "package.json"));
      fs.copyFileSync(join(root, "node_modules", packageName, native), selected);
      if (process.platform !== "win32") fs.chmodSync(selected, 0o755);
    }
    try {
      fs.writeFileSync(manifestPath, baselineManifest);
      assert.equal(fixtureGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]), "", "redirected tools remain genuinely Git-clean");
      await t.test(`${variant} is refused by fresh validator and existing handoff`, () => {
        assert.equal(validate(manifest.buildIdentityHash).status, 7);
        assert.throws(() => handoff.assertUnchanged());
      });
      await t.test(`${variant} cannot produce eligible provenance with the same version`, () => {
        const built = fixtureBuild(root), produced = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        t.diagnostic(`${variant}: native build exit=${built.status}, eligible=${produced.eligible}, alternate entry executed=${fs.existsSync(marker)}`);
        assert.ok(Number.isInteger(built.status) && built.status! > 0, "same-version loader redirection must refuse with a native nonzero exit");
        assert.equal(produced.eligible, false);
        assert.equal(fs.existsSync(marker), false, "alternate tool entry must not execute before refusal");
      });
      await t.test(`${variant} post-build alternate bytes cannot evade validation`, () => {
        const produced = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        fs.appendFileSync(selected, "\n ");
        // A refused producer must not make this pass solely via its ineligible sentinel.
        if (!produced.eligible) fs.writeFileSync(manifestPath, baselineManifest);
        assert.equal(validate(produced.buildIdentityHash ?? manifest.buildIdentityHash).status, 7);
        assert.throws(() => handoff.assertUnchanged());
      });
    } finally {
      fs.writeFileSync(packagePath, packageBytes);
      if (ownedDirectory) fs.rmSync(ownedDirectory, { recursive: true, force: true }); else fs.unlinkSync(selected);
      for (const name of ["scripts/node_modules", "node_modules/esbuild/node_modules/@esbuild", "node_modules/esbuild/node_modules"]) {
        const directory = join(root, name); if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
      }
    }
  }
});
test("clean current-byte fixture validates provenance and refuses stale or corrupted build state before import", async t => {
  const root = cleanBuildFixture(t), manifestPath = join(root, "dist/internal/v2-shadow-migration-build.json");
  const built = fixtureBuild(root); assert.equal(built.status, 0, built.stdout + built.stderr);
  const originalManifest = fs.readFileSync(manifestPath), manifest = JSON.parse(originalManifest.toString());
  assert.equal(manifest.eligible, true); assert.equal(manifest.commit, fixtureGit(root, ["rev-parse", "HEAD"]).trim());
  assert.match(manifest.buildIdentityHash, /^[0-9a-f]{64}$/);
  assert.ok(manifest.recipes.some((entry: any) => entry.path === "scripts/fresh-start-build.js"));
  assert.ok(manifest.inputs.some((entry: any) => entry.path.startsWith("node_modules/zod/")));
  await t.test("measured loader preserves exact ordinary esbuild output and complete input set", async () => {
    const esbuild = await import("esbuild");
    const actualInputs = new Set<string>();
    for (const [entry, artifact, external] of [
      ["src/orchestrator/migration/v2-shadow-migration-rehearsal.ts", "dist/internal/v2-shadow-migration-rehearsal.js", false],
      ["src/orchestrator/materialization/stable-compatibility-directory.worker.ts", "dist/internal/stable-compatibility-directory.worker.js", true],
    ] as const) {
      const result = await esbuild.build({ absWorkingDir: root, entryPoints: [entry], bundle: true, platform: "node", format: "esm",
        target: "node24.16", minify: true, write: false, metafile: true, ...(external ? { packages: "external" as const } : {}) });
      assert.deepEqual(Buffer.from(result.outputFiles![0]!.contents), fs.readFileSync(join(root, artifact)));
      for (const name of Object.keys(result.metafile!.inputs)) actualInputs.add(name);
    }
    assert.deepEqual(manifest.inputs.map((input: any) => input.path), [...actualInputs].sort());
  });
  const command = pathToFileURL(join(root, "scripts/run-v2-shadow-migration-rehearsal.js")).href;
  const validate = (identity = manifest.buildIdentityHash) => childProcess.spawnSync(process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(command)}); try { const h = m.validateV2ShadowMigrationBuild(${JSON.stringify(identity)}); h.assertUnchanged(); } catch { process.exit(7); }`],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(validate().status, 0);
  await t.test("supplied identity mismatch refuses", () => assert.equal(validate("0".repeat(64)).status, 7));
  for (const name of ["src/orchestrator/migration/v2-shadow-migration-rehearsal.ts", "tsconfig.json", "scripts/build.js", "scripts/fresh-start-build.js",
    "node_modules/zod/v3/types.js", "node_modules/esbuild/lib/main.js", "node_modules/typescript/lib/typescript.js", "dist/internal/v2-shadow-migration-rehearsal.js",
    "dist/internal/stable-compatibility-directory.worker.js", "scripts/run-v2-shadow-migration-rehearsal.js", nativeRecipePath]) {
    await t.test(`changed ${name} refuses`, () => {
      const path = join(root, name), bytes = fs.readFileSync(path);
      try { fs.appendFileSync(path, "\n "); assert.equal(validate().status, 7); }
      finally { fs.writeFileSync(path, bytes); }
    });
  }
  await t.test("malformed, noncanonical and unknown manifest fields refuse", () => {
    for (const bytes of ["{}", "not-json", JSON.stringify({ ...manifest, surprise: true }), originalManifest.toString() + " "]) {
      try { fs.writeFileSync(manifestPath, bytes); assert.equal(validate().status, 7); }
      finally { fs.writeFileSync(manifestPath, originalManifest); }
    }
  });
  await t.test("missing manifest refuses", () => {
    fs.unlinkSync(manifestPath); try { assert.equal(validate().status, 7); } finally { fs.writeFileSync(manifestPath, originalManifest); }
  });
  await t.test("new undeclared resolution metadata refuses", () => {
    const file = join(root, "node_modules/zod/v3/package.json");
    try { fs.writeFileSync(file, '{"type":"module"}'); assert.equal(validate().status, 7); }
    finally { fs.unlinkSync(file); }
  });
  await t.test("finalization handoff detects dependency changes", async () => {
    const module = await import(command), handoff = module.validateV2ShadowMigrationBuild(manifest.buildIdentityHash);
    const path = join(root, "node_modules/zod/v3/types.js"), bytes = fs.readFileSync(path);
    try { fs.appendFileSync(path, "\n "); assert.throws(() => handoff.assertUnchanged()); }
    finally { fs.writeFileSync(path, bytes); }
  });
  await t.test("finalization handoff detects native executable changes", async () => {
    const module = await import(command), handoff = module.validateV2ShadowMigrationBuild(manifest.buildIdentityHash);
    const path = join(root, nativeRecipePath), bytes = fs.readFileSync(path);
    try { fs.appendFileSync(path, "\n "); assert.throws(() => handoff.assertUnchanged(), /REHEARSAL_BUILD_INVALID/); }
    finally { fs.writeFileSync(path, bytes); }
  });
  await t.test("operational invocation refuses without importing a changed bundle or touching selected paths", () => {
    const marker = join(root, "must-not-exist"), artifact = join(root, "dist/internal/v2-shadow-migration-rehearsal.js"), bytes = fs.readFileSync(artifact);
    fs.writeFileSync(artifact, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'bad');`);
    try {
      assert.equal(validate().status, 7); assert.equal(fs.existsSync(marker), false);
      const result = childProcess.spawnSync(process.execPath, ["scripts/run-v2-shadow-migration-rehearsal.js", "--config", marker,
        "--source-root", marker, "--work-root", marker, "--package-root", marker, "--evidence-output", marker],
      { cwd: root, encoding: "utf8", windowsHide: true });
      assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.equal(fs.existsSync(marker), false);
      assert.equal(result.stderr.trim(), "REHEARSAL_REFUSED");
    } finally { fs.writeFileSync(artifact, bytes); }
  });
  await t.test("clean changed HEAD does not reuse prior manifest", () => {
    fixtureGit(root, ["commit", "--quiet", "--allow-empty", "-m", "different fixture commit"]);
    assert.equal(validate().status, 7);
  });
  await t.test("dirty build invalidates eligibility permanently even after source restoration", () => {
    const file = join(root, "src/orchestrator/migration/v2-shadow-migration-rehearsal.ts"), bytes = fs.readFileSync(file);
    fs.appendFileSync(file, "\n ");
    try { const result = fixtureBuild(root); assert.equal(result.status, 0, result.stdout + result.stderr); }
    finally { fs.writeFileSync(file, bytes); }
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")), { schemaVersion: 1, eligible: false });
    assert.equal(validate().status, 7);
  });
  await t.test("a missed installed input refuses instead of trusting metafile byte counts", () => {
    const script = join(root, "scripts/build.js"), bytes = fs.readFileSync(script);
    const text = bytes.toString().replace("filter: /.*/, namespace: 'file'", "filter: /[.]ts$/, namespace: 'file'");
    assert.notEqual(text, bytes.toString(), "negative fixture must bypass JS loader interception");
    try {
      fs.writeFileSync(script, text); const result = fixtureBuild(root);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /REHEARSAL_BUILD_INVALID/);
      assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).eligible, false);
    } finally { fs.writeFileSync(script, bytes); }
  });
  for (const [ordinal, name] of ["node_modules/zod/v3/types.js", "dist/internal/v2-shadow-migration-rehearsal.js", nativeRecipePath].entries()) {
  await t.test(`late byte change to ${name} refuses manifest publication`, () => {
    const dependency = join(root, name), bytes = fs.readFileSync(dependency);
    const directory = join(root, ".superpowers"); fs.mkdirSync(directory, { recursive: true });
    const preload = join(directory, `late-change-${ordinal}.mjs`), marker = join(directory, `changed-${ordinal}`);
    fs.writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const open=fs.openSync, close=fs.closeSync, selected=new Set(); let fired=false;
      fs.openSync=(...args)=>{ const fd=open(...args); if (args[0]===${JSON.stringify(dependency)}) selected.add(fd); return fd; };
      fs.closeSync=(fd)=>{close(fd); if(selected.delete(fd)&&!fired){fired=true; fs.appendFileSync(${JSON.stringify(dependency)},'\\n ');fs.writeFileSync(${JSON.stringify(marker)},'changed');}};
      syncBuiltinESMExports();`);
    try {
      const result = childProcess.spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "scripts/build.js"],
        { cwd: root, encoding: "utf8", windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
      assert.ok(fs.existsSync(marker), "the exact-load boundary was actually perturbed");
      assert.notEqual(result.status, 0); assert.match(result.stderr, /REHEARSAL_BUILD_INVALID/);
      assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).eligible, false);
    } finally { fs.writeFileSync(dependency, bytes); }
  });
  }
  await t.test("dynamic runtime load refuses the actual private build", () => {
    const entry = join(root, "src/orchestrator/migration/v2-shadow-migration-rehearsal.ts"), bytes = fs.readFileSync(entry);
    try {
      fs.appendFileSync(entry, "\nvoid import(process.env.UNDECLARED_PRIVATE_MODULE!);\n");
      const result = fixtureBuild(root); assert.notEqual(result.status, 0); assert.match(result.stderr, /REHEARSAL_BUILD_INVALID/);
      assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).eligible, false);
    } finally { fs.writeFileSync(entry, bytes); }
  });
  await t.test("missing command at build startup invalidates the previously eligible manifest", () => {
    const file = join(root, "scripts/run-v2-shadow-migration-rehearsal.js"), bytes = fs.readFileSync(file);
    fs.writeFileSync(manifestPath, originalManifest); fs.unlinkSync(file);
    try { assert.notEqual(fixtureBuild(root).status, 0); assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).eligible, false); }
    finally { fs.writeFileSync(file, bytes); }
  });
});
test("private build provenance is emitted explicitly and command import is inert", async () => {
  await preflightArtifact();
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const manifest = join(root, "dist/internal/v2-shadow-migration-build.json");
  assert.equal(fs.existsSync(manifest), true, "the producer must emit explicit private build eligibility");
  const command = join(root, "scripts/run-v2-shadow-migration-rehearsal.js");
  assert.equal(fs.existsSync(command), true, "a pre-import validation boundary must exist");
  const imported = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(command).href)}); if (typeof m.validateV2ShadowMigrationBuild !== 'function') process.exit(3);`],
    { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
});
function preflightArtifact(): Promise<any> {
  return compiledPreflight ??= (async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const built = childProcess.spawnSync(process.execPath, ["scripts/build.js"], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024 });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const entry = new URL("../../dist/internal/v2-shadow-migration-rehearsal.js", import.meta.url);
    assert.equal(fs.existsSync(entry), true, "the actual production build must emit the private preflight artifact");
    return import(entry.href);
  })();
}

test("compiled rehearsal preflight authenticates the entire pinned corpus without mutating selected roots", async t => {
  const module = await preflightArtifact();
  const f = await createSnapshotParityFixture(t, { rankingPair: true, legacyArtifacts: true });
  const bundleRoot = join(f.root, "preflight-corpus"); fs.mkdirSync(bundleRoot);
  const artifacts = {
    "manifest.json": f.corpus.bundle,
    "source-events.json": { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", sources: f.corpus.sources },
    "judgments.json": { schemaVersion: 2, corpusVersion: "retrieval-evaluation-v2", queries: f.corpus.queries },
    "v1-shadow-baseline.json": f.corpus.baseline,
  };
  for (const [name, value] of Object.entries(artifacts)) fs.writeFileSync(join(bundleRoot, name), JSON.stringify(value));
  const configuration = { schemaVersion: 1, policyChecksum: shadowMigrationPolicyChecksum(f.policy), packageFormatVersion: 1,
    migrationAlgorithmVersion: 1, expectedDifferencePolicyVersion: f.policy.expectedDifferencePolicyVersion };
  const supplied = { sourceRoot: f.sourceRoot, sourceManifestPath: f.manifestPath, liveEventStorePath: f.liveEventStorePath,
    liveLegacyArtifactRoot: f.liveVaultRoot, expectedBinding: f.projectionBinding, configuration, policy: f.policy,
    expectedDifferenceRules: [], sealedRetrieval: { bundleRoot, expectedBundle: f.corpus.bundle } };
  await t.test("fresh bounded preflights preserve identity and detect same-byte corpus replacement", async () => {
    const first = await module.preflightV2ShadowMigrationRehearsal(supplied, { driver: f.driver });
    const identity = first.identity; first.close();
    assert.ok(identity, "C3 needs immutable cross-preflight source and corpus identity");
    assert.ok(Object.isFrozen(identity));
    const second = await module.preflightV2ShadowMigrationRehearsal(supplied, { driver: f.driver });
    try { assert.deepEqual(second.identity, identity); } finally { second.close(); }
    const file = join(bundleRoot, "judgments.json"), original = fs.readFileSync(file);
    fs.renameSync(file, file + ".held"); fs.writeFileSync(file, original);
    try {
      const replaced = await module.preflightV2ShadowMigrationRehearsal(supplied, { driver: f.driver });
      try { assert.notEqual(replaced.identity.corpusChecksum, identity.corpusChecksum); }
      finally { replaced.close(); }
    } finally { fs.unlinkSync(file); fs.renameSync(file + ".held", file); }
  });
  await t.test("compiled decoder captures valid branch-scoped settings without invoking caller behavior", () => {
    const branched = { ...supplied, expectedBinding: { ...f.projectionBinding, branchScopeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", branchRef: "refs/heads/rehearsal" } };
    const result = module.decodeV2ShadowMigrationRehearsalPreflightInput(branched);
    assert.deepEqual(result.expectedBinding, branched.expectedBinding);
    branched.expectedBinding.branchRef = "refs/heads/changed";
    assert.equal(result.expectedBinding.branchRef, "refs/heads/rehearsal");
    assert.ok(Object.isFrozen(result.expectedBinding));
    assert.equal(module.decodeV2ShadowMigrationRehearsalPreflightInput({ ...branched,
      expectedBinding: { ...branched.expectedBinding, branchRef: null } }).expectedBinding.branchRef, null);
    assert.throws(() => module.decodeV2ShadowMigrationRehearsalPreflightInput({ ...branched,
      expectedBinding: { ...branched.expectedBinding, branchScopeId: "a".repeat(64) } }));
  });
  await t.test("compiled configuration preserves every supplied nonempty rule field", () => {
    const rules = f.metadataRules.map(rule => ({ ...rule, predicate: { ...rule.predicate } }));
    const captured = module.decodeV2ShadowMigrationRehearsalPreflightInput({ ...supplied, expectedDifferenceRules: rules });
    assert.equal(captured.expectedDifferenceRules.length, 3);
    assert.deepEqual(captured.expectedDifferenceRules, f.metadataRules);
    assert.ok(Object.isFrozen(captured.expectedDifferenceRules[0].predicate));
    rules[0]!.rationaleDigest = "0".repeat(64);
    assert.equal(captured.expectedDifferenceRules[0].rationaleDigest, f.metadataRules[0]!.rationaleDigest);
  });
  await t.test("compiled configuration refuses duplicate rule IDs", () => {
    assert.throws(() => module.decodeV2ShadowMigrationRehearsalPreflightInput({ ...supplied,
      expectedDifferenceRules: [f.metadataRules[0], f.metadataRules[0]] }), { code: "MIGRATION_SOURCE_INVALID" });
  });
  await t.test("compiled configuration refuses a checksum-valid rule from a different policy version", () => {
    const { ruleChecksum: _checksum, ...original } = f.metadataRules[0]!;
    const body = { ...original, policyVersion: f.policy.expectedDifferencePolicyVersion + 1 };
    const rule = { ...body, ruleChecksum: hash("project-memory/v2-expected-difference-rule/v1\n" + canonicalJson(body)) };
    assert.throws(() => module.decodeV2ShadowMigrationRehearsalPreflightInput({ ...supplied,
      expectedDifferenceRules: [rule] }), { code: "MIGRATION_SOURCE_INVALID" });
  });
  const snapshot = (root: string): unknown => fs.readdirSync(root, { withFileTypes: true }).map(entry => {
    const path = join(root, entry.name), stat = fs.lstatSync(path, { bigint: true });
    return [entry.name, String(stat.dev), String(stat.ino), String(stat.nlink), entry.isDirectory() ? snapshot(path) : hash(fs.readFileSync(path).toString("base64"))];
  });
  const before = snapshot(f.root);
  let opened = 0, closed = 0;
  const driver = { open: (...args: Parameters<typeof f.driver.open>) => {
    opened++; const connection = f.driver.open(...args);
    return { prepare: connection.prepare.bind(connection), exec: connection.exec.bind(connection), close() { connection.close(); closed++; } };
  } };
  const checked = await module.preflightV2ShadowMigrationRehearsal(supplied, { driver });
  try {
    assert.deepEqual(checked.corpus, f.corpus);
    assert.equal(checked.corpus.queries.length, 11, "all intended queries, including the extra ranking pair, survive the loader");
    assert.equal(checked.source.manifest.manifestChecksum, f.manifest.manifestChecksum);
    assert.ok(Object.isFrozen(checked.input.sealedRetrieval.expectedBundle.files));
    assert.ok(Object.isFrozen(checked.corpus.queries[0].eligibleScope));
    checked.assertUnchanged(); assert.deepEqual(snapshot(f.root), before);
  } finally { checked.close(); }
  assert.equal(opened, closed, "all verifier working-image connections close");
  assert.throws(() => checked.assertUnchanged());
  checked.close();

  await t.test("missing malformed oversize wrong-pin and source-mismatched artifacts refuse without target writes", async () => {
    const file = join(bundleRoot, "judgments.json"), original = fs.readFileSync(file);
    const reject = async (value: unknown) => {
      const baseline = snapshot(f.root);
      await assert.rejects(module.preflightV2ShadowMigrationRehearsal(value, { driver }));
      assert.deepEqual(snapshot(f.root), baseline); assert.equal(opened, closed);
    };
    for (const name of Object.keys(artifacts)) {
      const missing = join(bundleRoot, name); fs.renameSync(missing, missing + ".held");
      try { await reject(supplied); } finally { fs.renameSync(missing + ".held", missing); }
    }
    fs.writeFileSync(file, "{invalid SOURCE_PLAINTEXT_SENTINEL"); await reject(supplied); fs.writeFileSync(file, original);
    const smallPolicy = { ...f.policy, maxAggregateBytes: original.length - 1 };
    await reject({ ...supplied, policy: smallPolicy, configuration: { ...configuration, policyChecksum: shadowMigrationPolicyChecksum(smallPolicy) } });
    await reject({ ...supplied, sealedRetrieval: { bundleRoot, expectedBundle: { ...f.corpus.bundle, files: { ...f.corpus.bundle.files, "judgments.json": "0".repeat(64) } } } });
    await reject({ ...supplied, expectedBinding: { ...f.projectionBinding, projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
    const events = { ...artifacts["source-events.json"], sources: f.corpus.sources.map(source => ({ ...source,
      events: source.events.map((event, ordinal) => ordinal === 0 ? { ...event, recordedAt: "2026-09-09T00:00:00.000Z" } : event) })) };
    const changedBundle = { ...f.corpus.bundle, files: { ...f.corpus.bundle.files, "source-events.json": hash(JSON.stringify(events)) } };
    fs.writeFileSync(join(bundleRoot, "source-events.json"), JSON.stringify(events)); fs.writeFileSync(join(bundleRoot, "manifest.json"), JSON.stringify(changedBundle));
    await reject({ ...supplied, sealedRetrieval: { bundleRoot, expectedBundle: changedBundle } });
    fs.writeFileSync(join(bundleRoot, "source-events.json"), JSON.stringify(artifacts["source-events.json"]));
    fs.writeFileSync(join(bundleRoot, "manifest.json"), JSON.stringify(artifacts["manifest.json"]));
  });

  await t.test("captured corpus identity is rechecked and closure invalidates handoff", async () => {
    const result = await module.preflightV2ShadowMigrationRehearsal(supplied, { driver });
    const file = join(bundleRoot, "judgments.json"), original = fs.readFileSync(file);
    try { fs.writeFileSync(file, Buffer.concat([original, Buffer.from(" ")])); assert.throws(() => result.assertUnchanged()); }
    finally { result.close(); fs.writeFileSync(file, original); }
    assert.equal(opened, closed);
  });

  await t.test("the combined corpus byte limit accepts the exact bound and rejects one byte less", async () => {
    const total = Object.keys(artifacts).reduce((bytes, name) => bytes + fs.statSync(join(bundleRoot, name)).size, 0);
    assert.ok(total >= f.manifest.aggregateSourceBytes, "corpus boundary is independent of the source logical byte ceiling");
    const policy = { ...f.policy, maxAggregateBytes: total };
    const bounded = { ...supplied, policy, configuration: { ...configuration, policyChecksum: shadowMigrationPolicyChecksum(policy) } };
    const result = await module.preflightV2ShadowMigrationRehearsal(bounded, { driver }); result.close();
    const smaller = { ...policy, maxAggregateBytes: total - 1 }, initial = opened;
    await assert.rejects(module.preflightV2ShadowMigrationRehearsal({ ...bounded, policy: smaller,
      configuration: { ...configuration, policyChecksum: shadowMigrationPolicyChecksum(smaller) } }, { driver }), { code: "MIGRATION_LIMIT_EXCEEDED" });
    assert.equal(opened, initial);
  });

  await t.test("a corpus replacement during source verification refuses and closes every opened connection", async () => {
    const file = join(bundleRoot, "judgments.json"), original = fs.readFileSync(file); let changed = false;
    const mutatingDriver = { open: (...args: Parameters<typeof driver.open>) => {
      const connection = driver.open(...args);
      if (!changed) { changed = true; fs.renameSync(file, file + ".held"); fs.writeFileSync(file, original); }
      return connection;
    } };
    try { await assert.rejects(module.preflightV2ShadowMigrationRehearsal(supplied, { driver: mutatingDriver })); }
    finally { if (changed) { fs.unlinkSync(file); fs.renameSync(file + ".held", file); } }
    assert.equal(changed, true); assert.equal(opened, closed);
  });

  await t.test("source mutation after preflight refuses handoff and closing prevents source event reuse", async () => {
    const result = await module.preflightV2ShadowMigrationRehearsal(supplied, { driver });
    const original = fs.readFileSync(f.manifestPath);
    try { fs.appendFileSync(f.manifestPath, " "); assert.throws(() => result.assertUnchanged(), { code: "MIGRATION_SOURCE_MUTATED" }); }
    finally { result.close(); fs.writeFileSync(f.manifestPath, original); }
    assert.throws(() => result.source.events());
  });

  await t.test("strict input rejects accessors proxies aliases hardlinks and foreign fields before source open", async () => {
    const initial = opened; let traps = 0;
    const bad = [undefined, null, {}, { ...supplied, unexpected: true }, { ...supplied, configuration: { ...configuration, policyChecksum: "0".repeat(64) } },
      Object.defineProperty({ ...supplied }, "policy", { get() { traps++; return f.policy; } }),
      new Proxy(supplied, { ownKeys() { traps++; return []; } }),
      { ...supplied, sealedRetrieval: { ...supplied.sealedRetrieval, bundleRoot: bundleRoot + "/../preflight-corpus" } }];
    for (const value of bad) await assert.rejects(module.preflightV2ShadowMigrationRehearsal(value, { driver }));
    const linked = join(bundleRoot, "linked.json"); fs.linkSync(join(bundleRoot, "manifest.json"), linked);
    try { await assert.rejects(module.preflightV2ShadowMigrationRehearsal(supplied, { driver })); } finally { fs.unlinkSync(linked); }
    assert.equal(traps, 0); assert.equal(opened, initial);
    const alias = join(f.root, "corpus-alias"); fs.symlinkSync(bundleRoot, alias, process.platform === "win32" ? "junction" : "dir");
    try { await assert.rejects(module.preflightV2ShadowMigrationRehearsal({ ...supplied, sealedRetrieval: { ...supplied.sealedRetrieval, bundleRoot: alias } }, { driver })); }
    finally { fs.unlinkSync(alias); }
    assert.equal(opened, initial);
  });
});

test("fresh private preflight import and invalid entry input perform no filesystem mutation", async () => {
  await preflightArtifact();
  const entry = new URL("../../dist/internal/v2-shadow-migration-rehearsal.js", import.meta.url).href;
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import assert from 'node:assert/strict';
    let writes=0; for(const key of ['writeFileSync','mkdirSync','mkdtempSync','renameSync','linkSync','unlinkSync','rmSync','rmdirSync','writeSync'])
      fs[key]=()=>{ writes++; throw new Error('unexpected write'); }; syncBuiltinESMExports();
    const entry=await import(${JSON.stringify(entry)});
    for(const input of [undefined,null,{}]) await assert.rejects(entry.preflightV2ShadowMigrationRehearsal(input,{driver:{open(){throw new Error('unexpected open');}}}));
    assert.equal(writes,0); console.log('PASS inert import and invalid configuration');`;
  const result = childProcess.spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), "PASS inert import and invalid configuration");
});

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
const typedInvalid = (error: unknown) => error instanceof V2ShadowMigrationEvidenceError && error.code === "EVIDENCE_INVALID";
for (const [kind, credential] of [["project", "sk-proj-" + "a".repeat(32)], ["anthropic", "sk-ant-api03-" + "b".repeat(32)], ["github", "ghp_" + "c".repeat(36)]] as const) {
  test(`credential-shaped ${kind} strings refuse in nested labels and dynamic keys`, () => {
    // Deliberately fake credentials; no provider/account/source authority is implied.
    for (const value of [credential, `fixture_${credential}_label`]) {
      assert.throws(() => buildV2ShadowMigrationEvidence({ ...input(), tests: [{ name: value, passed: 1, failed: 0, skipped: 0 }] }), typedInvalid);
      assert.throws(() => buildV2ShadowMigrationEvidence({ ...input(), parity: { ...input().parity, ruleIds: [value] } }), typedInvalid);
      assert.throws(() => buildV2ShadowMigrationEvidence({ ...input(), gates: [{ name: value, status: "passed", evidenceDigest: H }] }), typedInvalid);
      assert.throws(() => buildV2ShadowMigrationEvidence({ ...input(), counts: { [value]: 1 } }), typedInvalid);
    }
  });
}
test("review prerequisite rejects null and other invalid roots with typed evidence errors", () => {
  for (const value of [null, undefined, false, true, 0, "metadata", [], {}])
    assert.throws(() => hasRequiredApprovedV2ShadowMigrationReviews(value as unknown as V2ShadowMigrationEvidenceV1), typedInvalid);
});
test("writer rejects a null evidence root with typed error before evidence publication", async t => {
  const root = directory(t), reservation = await reserveV2ShadowMigrationEvidence({ outputPath: join(root, "success.json"), protectedRoots: [], timeoutMs: 5000 });
  await assert.rejects(writeV2ShadowMigrationEvidence({ reservation, evidence: null as unknown as V2ShadowMigrationEvidenceV1 }), typedInvalid);
  assert.deepEqual(fs.readdirSync(root), [CONTROL]);
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
function childHook(t: TestContext, source: string, builtEntry?: string): () => void {
  const root = directory(t), hook = join(root, "fault.mjs");
  const bytes = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';\n${source}\nsyncBuiltinESMExports();\n`;
  fs.writeFileSync(hook, bytes, { flag: "wx" }); const stat = fs.statSync(hook, { bigint: true });
  const nativeSpawn = childProcess.spawn;
  const mocked = t.mock.method(childProcess, "spawn", ((command: string, args: string[], options: object) => {
    if (builtEntry) assert.equal(args[1], "--v2-shadow-migration-evidence-child");
    return nativeSpawn(command, ["--import", pathToFileURL(hook).href, ...(builtEntry ? [builtEntry, ...args.slice(1)] : args)], options);
  }) as typeof nativeSpawn);
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
