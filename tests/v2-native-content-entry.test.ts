import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork, spawn, spawnSync, type ForkOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import test from "node:test";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { createVerifiedReadAdapter } from "../src/orchestrator/verified-read/supervisor.js";
import { VerifiedReadOwnershipRepository } from "../src/orchestrator/verified-read/ownership.js";
import { FreshStartAdmissionGuard } from "../src/orchestrator/fresh-start/fresh-start-admission.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { deriveEffectiveQualityPolicyV1, classifyCoverageOnlyVerificationTerminalActionV1 } from "../src/orchestrator/lifecycle/session-end-policy.js";
import { deployMeasuredNativeFixture, makeNativeContentFixture, nativeGetRequest, nativeSearchRequest, NATIVE_SESSION } from "./support/v2-native-content-fixture.js";

const deployment = join(process.cwd(), "dist");
const measured = () => JSON.parse(readFileSync(join(deployment, "v2-build.json"), "utf8"));
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
async function publicDenial() {
  const projectRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "native-public-denial-")));
  const archive = join(projectRoot, "archive"); mkdirSync(archive); writeFileSync(join(archive, "sentinel"), "owned V1 sentinel");
  const log = join(projectRoot, "v1-access"), monitor = join(projectRoot, "monitor.cjs");
  writeFileSync(monitor, `const fs=require('node:fs'),p=require('node:path'),u=require('node:url');const append=fs.appendFileSync.bind(fs);
const archive=${JSON.stringify(archive.toLowerCase())},log=${JSON.stringify(log)};
const check=(x,mode)=>{if(x instanceof URL)x=u.fileURLToPath(x);if(typeof x!=='string'&&!Buffer.isBuffer(x))return;const v=p.resolve(String(x)).toLowerCase();if(v===archive||v.startsWith(archive+p.sep)){append(log,mode+'\\n');throw Error('OWNED_ARCHIVE_ACCESS_DENIED');}};
for(const mode of ['read','write'])for(const n of mode==='read'?['readFileSync','readFile','openSync','open','readdirSync','readdir','opendirSync','opendir','createReadStream']:['writeFileSync','writeFile','appendFileSync','appendFile','createWriteStream']){const original=fs[n];fs[n]=function(x,...a){check(x,mode);return original.call(this,x,...a);};}
for(const mode of ['read','write'])for(const n of mode==='read'?['readFile','open','readdir','opendir']:['writeFile','appendFile']){const original=fs.promises[n];fs.promises[n]=function(x,...a){check(x,mode);return original.call(this,x,...a);};}require('node:module').syncBuiltinESMExports();`);
  const config = { projectRoot, v2VaultRoot: join(projectRoot, "memory-v2"), v1ArchiveRoot: archive, releaseId: randomUUID() };
  const release = { profileVersion: 1, releaseId: config.releaseId, buildIdentityHash: measured().buildIdentityHash,
    schemaIdentityHash: expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS), configurationHash: hash(config),
    capabilityManifestHash: hash({ profile: "fresh-start", version: 1, tools: ["memory_v2Status"], content: "unavailable" }),
    recoveryPolicyHash: hash({ profile: "fresh-start", version: 1, productionReady: false, promotion: "closed" }), evidenceDigest: hash("owned-native-public"), createdAt: new Date().toISOString() };
  writeFileSync(join(projectRoot, "release.json"), JSON.stringify({ initializationId: randomUUID(), release }));
  const env = { ...process.env, MEMORY_PROJECT_ROOT: projectRoot, MEMORY_V2_VAULT_PATH: config.v2VaultRoot,
    MEMORY_V1_ARCHIVE_PATH: archive, MEMORY_V2_RELEASE_ID: config.releaseId };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const initialized = spawnSync(process.execPath, ["--require", monitor, join(deployment, "v2-admin.js"), "initialize-fresh",
      "--project-root", projectRoot, "--v2-vault-root", config.v2VaultRoot, "--v1-archive-root", archive, "--release-manifest", join(projectRoot, "release.json")], { env, encoding: "utf8", timeout: 20000, windowsHide: true });
    assert.equal(initialized.status, 0, initialized.stderr);
    child = spawn(process.execPath, ["--require", monitor, join(deployment, "v2.js")], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", id = 0; const replies = new Map<number, (value: any) => void>();
    child.stdout!.on("data", bytes => { buffer += bytes; let end; while ((end = buffer.indexOf("\n")) >= 0) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); replies.get(value.id)?.(value); } });
    const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => { const requestId = ++id;
      const timer = setTimeout(() => reject(new Error("owned public MCP response missing")), 10000);
      replies.set(requestId, value => { clearTimeout(timer); replies.delete(requestId); resolve(value); });
      child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n"); });
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "native-owned", version: "1" } });
    child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const publicTools = (await call("tools/list", {})).result.tools.map((tool: any) => tool.name);
    assert.deepEqual(publicTools, ["memory_v2Status"]);
    const publicStatus = JSON.parse((await call("tools/call", { name: "memory_v2Status", arguments: {} })).result.content[0].text);
    assert.equal(publicStatus.productionReady, false);
    for (const name of ["memory_search", "memory_get", "search-projected-content", "get-canonical-record", "memory_v2Activate"])
      assert.equal((await call("tools/call", { name, arguments: {} })).error.data.code, "FRESH_START_RELEASE_NOT_READY");
    const accesses = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    const v1SentinelReads = accesses.filter(x => x === "read").length, v1SentinelWrites = accesses.filter(x => x === "write").length;
    assert.equal(v1SentinelReads, 0); assert.equal(v1SentinelWrites, 0);
  } finally {
    if (child && child.exitCode === null) { const closed = once(child, "close"); child.stdin!.end(); const timer = setTimeout(() => child!.kill("SIGKILL"), 3000); try { await closed; } finally { clearTimeout(timer); } }
    rmSync(projectRoot, { recursive: true, force: true });
  }
}
test("compiled_native_schema2_operations_and_public_denial", { timeout: 45000 }, async () => {
  // Controller ruling: V2LaunchConfig has no evidence-policy field. This is
  // real policy-helper fixture proof; actual primary-cutover wiring remains F2.
  const effectiveEvidencePolicy = deriveEffectiveQualityPolicyV1({
    trustedProfiles: [{ profileId: "owned-required", profileVersion: 1, required: true, weight: 1 }], optionalProfiles: [],
    requestedProfileIds: [], requestedQualityThreshold: 8000, trustedMinimumQualityThreshold: 8000,
    trustedRequireFullEvidence: true, requestedRequireFullEvidence: false,
    trustedRequireMaterialization: false, requestedRequireMaterialization: false });
  assert.equal(effectiveEvidencePolicy.requireFullEvidence, true);
  assert.throws(() => classifyCoverageOnlyVerificationTerminalActionV1(effectiveEvidencePolicy, { action: "record-verification-passed" }), { code: "EVIDENCE_CAPTURE_INCOMPLETE" });
  const f = await deployMeasuredNativeFixture({ session: { sessionId: NATIVE_SESSION, minimumEventPosition: "0" } });
  let adapter = createVerifiedReadAdapter(f.binding), closed = false;
  try {
    const genesis = await adapter.query(nativeSearchRequest()); assert.equal(genesis.receipt.projectionEventPosition, "0");
    assert.equal(genesis.content.operation, "search-projected-content"); if (genesis.content.operation === "search-projected-content") assert.deepEqual(genesis.content.items, []);
    const emptyGet = await adapter.query(nativeGetRequest("missing")); if (emptyGet.content.operation === "get-canonical-record") assert.equal(emptyGet.content.item, null);
    const corpus = await f.appendCorpus(); const manifest = await f.publish();
    const image = f.captureImage(); image.close(); const actualCapturedImageSha256 = createHash("sha256").update(readFileSync(join(f.binding.projectionDirectory.canonicalPath, manifest.databaseFile))).digest("hex");
    assert.equal(image.manifest.schemaVersion, 2);
    const committedProjectedSummary = "native canonical projected summary";
    const search = await adapter.query({ ...nativeSearchRequest(), minimumEventPosition: corpus.sourcePositions.canonical });
    const get = await adapter.query({ ...nativeGetRequest(corpus.ids.canonical), minimumEventPosition: corpus.sourcePositions.canonical });
    assert.equal(search.content.operation, "search-projected-content"); assert.equal(get.content.operation, "get-canonical-record");
    if (get.content.operation !== "get-canonical-record" || search.content.operation !== "search-projected-content") assert.fail("expected exact content variants");
    assert.equal(get.content.item?.textKind, "canonical-summary"); assert.equal(get.content.item?.text, committedProjectedSummary);
    assert.equal(get.content.item?.sourceEventPosition, corpus.sourcePositions.canonical); assert.equal(get.receipt.imageSha256, actualCapturedImageSha256);
    assert.equal(search.receipt.imageSha256, actualCapturedImageSha256); assert.equal(search.content.selectionScope.sessionId, NATIVE_SESSION);
    for (const [query, id, channel] of [["lexicalneedle", corpus.ids.lexical, "lexical"], ["src/native/artifact.ts", corpus.ids.artifact, "symbol-path"],
      [corpus.ids.canonical, corpus.ids.canonical, "exact"], [corpus.ids.checkpoint, corpus.ids.checkpoint, "session-checkpoint"],
      ["native open follow-up", corpus.ids.openFollowUp, "open-follow-up"], ["native blocked follow-up", corpus.ids.blockedFollowUp, "open-follow-up"]] as const) {
      const selected = await adapter.query(nativeSearchRequest({ parameters: { query, limit: 10 } }));
      if (selected.content.operation !== "search-projected-content") assert.fail("expected search");
      assert.ok(selected.content.items.some(item => item.id === id && item.channels.includes(channel)), `missing actual ${channel} projected item`);
    }
    const metadata = await adapter.verify({ ...f.request, minimumEventPosition: manifest.terminalEventPosition });
    assert.equal(metadata.imageSha256, actualCapturedImageSha256); assert.equal(Object.hasOwn(metadata, "content"), false);
    assert.equal((await adapter.close()).cleanup, "complete");
    adapter = createVerifiedReadAdapter({ ...f.binding, compositionEpoch: "native-reopened" });
    const reopened = await adapter.query({ ...nativeGetRequest(corpus.ids.canonical), minimumEventPosition: manifest.terminalEventPosition });
    assert.equal(reopened.receipt.imageSha256, actualCapturedImageSha256);
    assert.throws(() => new FreshStartAdmissionGuard(f.writer).assertRequestAllowed({ identity: f.identity, releaseId: f.release.releaseId,
      generation: 1n, measuredBuildHash: f.measuredBuildHash, operation: "content-read" }), { code: "FRESH_START_CONTENT_UNVERIFIED" });
    console.log(`compiled native schema2 build=${f.measuredBuildHash} image=${actualCapturedImageSha256} position=${manifest.terminalEventPosition} sameImage=true`);
    closed = (await adapter.close()).cleanup === "complete"; assert.equal(closed, true);
    assert.equal(await new VerifiedReadOwnershipRepository(f.binding.executorStateDirectory).inspect(), null);
    await publicDenial();
  } finally { const diagnostic = await adapter.close(); if (closed || diagnostic.cleanup === "complete") f.cleanup(); else console.error(`Retained compiled native fixture: ${f.root}`); }
});

test("pure_retrieval_closure_is_exact", () => {
  const manifest = measured(); const artifactCount = manifest.artifacts.length; assert.equal(artifactCount, 5);
  const expected = ["src/orchestrator/retrieval/contracts.ts", "src/orchestrator/retrieval/database-core.ts", "src/orchestrator/retrieval/eligibility.ts",
    "src/orchestrator/retrieval/ranking.ts", "src/orchestrator/retrieval/selection-core.ts"];
  for (const cleanup of [false, true]) {
    const name = `internal/v2-internal-verified-read${cleanup ? "-cleanup" : ""}.js`;
    const closure = JSON.parse(readFileSync(join(deployment, `${name}.closure.json`), "utf8"));
    assert.equal(closure.sourceChecked, true); assert.equal(closure.emittedChecked, true);
    assert.equal(closure.artifact.sha256, manifest.artifacts.find((value: any) => value.path === name).sha256);
    assert.equal(createHash("sha256").update(readFileSync(join(deployment, name))).digest("hex"), closure.artifact.sha256);
    const inputs = closure.inputs.map((value: any) => value.path);
    assert.deepEqual(inputs.filter((path: string) => path.includes("/retrieval/")).sort(), cleanup ? [] : expected);
    for (const module of ["content-query.ts", "content-result.ts"]) assert.equal(inputs.includes(`src/orchestrator/verified-read/${module}`), !cleanup);
    assert.ok(!closure.runtimeImports.some((path: string) => /^(node:)?(?:child_process|worker_threads)$/.test(path)));
    assert.ok(!inputs.some((path: string) => /\/(?:stable-directory|builder|coordinator|integrity|manifest)\.ts$|\/workers\/|\/parity\/|\/migration\//.test(path)));
    for (const input of closure.inputs) assert.equal(createHash("sha256").update(readFileSync(input.path)).digest("hex"), input.sha256, `stale source ${input.path}`);
  }
});

test("compiled_blocked_query_and_uncertain_closure", { timeout: 20000 }, async t => {
  for (const uncertainCleanup of [false, true]) {
    const f = await makeNativeContentFixture(); const children: ReturnType<typeof fork>[] = [];
    const exits: { kind: string; code: number | null; signal: string | null }[] = [];
    let active = 0, maximum = 0, blocked = false, closed = false;
    const executable = fileURLToPath(new URL("./fixtures/v2-verified-read-process-fixture.js", import.meta.url));
    const spawnOwned = (kind: string) => {
      const child = fork(executable, [kind], { cwd: f.binding.projectionDirectory.canonicalPath, execArgv: [], windowsHide: true,
        env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}, stdio: ["ignore", "pipe", "pipe", "ipc"] } as ForkOptions);
      children.push(child); if (kind !== "writer") maximum = Math.max(maximum, ++active);
      child.once("exit", (code, signal) => { exits.push({ kind, code, signal }); if (kind !== "writer") active--; }); return child;
    };
    const until = async (predicate: () => boolean, ms = 3000) => { const deadline = performance.now() + ms;
      while (!predicate()) { assert.ok(performance.now() < deadline, "owned process barrier not reached"); await new Promise(r => setTimeout(r, 10)); } };
    const writer = spawnOwned("writer"); let adapter: ReturnType<typeof createVerifiedReadAdapter> | undefined;
    try {
      const corpus = await f.appendCorpus(); await f.publish(); await until(() => existsSync(join(f.binding.projectionDirectory.canonicalPath, "writer-ready")));
      const writerBytes = readFileSync(join(f.binding.projectionDirectory.canonicalPath, "independent-writer.sqlite"));
      adapter = createVerifiedReadAdapter(f.binding, { ownership: new VerifiedReadOwnershipRepository(f.binding.executorStateDirectory),
        now: () => performance.now(), schedule: (cb, ms) => setTimeout(cb, ms), clear: timer => clearTimeout(timer as NodeJS.Timeout),
        currentEpoch: () => f.binding.compositionEpoch, spawnOwned(kind) {
          const child = spawnOwned(kind === "read" ? "query-hang" : "cleanup"); const errors = new Set<(error: unknown) => void>();
          child.on("error", error => { for (const cb of errors) cb(error); });
          return { get pid() { return child.pid; }, send(value) {
            const sent = uncertainCleanup && kind === "cleanup" ? { ...value, lockToken: "f".repeat(32) } : value;
            child.send(sent, error => { if (error) for (const cb of errors) cb(error); });
          }, onMessage(cb) { child.on("message", cb); return () => { child.off("message", cb); }; },
          onExit(cb) { child.on("close", cb); return () => { child.off("close", cb); }; },
          onOutput(cb) { const out = (bytes: Buffer) => cb("stdout", bytes), err = (bytes: Buffer) => cb("stderr", bytes);
            child.stdout!.on("data", out); child.stderr!.on("data", err); return () => { child.stdout!.off("data", out); child.stderr!.off("data", err); }; },
          onError(cb) { errors.add(cb); return () => { errors.delete(cb); }; }, terminate() { child.kill("SIGKILL"); }, unref() { child.unref(); child.channel?.unref(); } };
        } });
      let ticks = 0; const timer = setInterval(() => ticks++, 10); const arrival = performance.now();
      try {
        const outcome = adapter.query({ ...nativeGetRequest(corpus.ids.canonical), budgetMs: 2000 }).catch(error => error);
        await until(() => existsSync(join(f.binding.projectionDirectory.canonicalPath, "query-blocked")), 1800); blocked = true;
        assert.equal(readFileSync(join(f.binding.projectionDirectory.canonicalPath, "query-blocked"), "utf8"), "validated-image-owned-lock-fixed-canonical-query");
        assert.equal((await outcome).code, "WORKER_TIMEOUT"); assert.ok(ticks >= 5); assert.ok(performance.now() - arrival <= 3000);
        const diagnostic = await adapter.close(); closed = diagnostic.cleanup === "complete";
        assert.equal(diagnostic.code, "WORKER_TIMEOUT"); assert.equal(diagnostic.cleanup, uncertainCleanup ? "incomplete" : "complete");
        assert.equal(maximum, 1); assert.equal(exits.filter(value => value.kind === "query-hang").length, 1);
        assert.notEqual(exits.find(value => value.kind === "query-hang")?.code, 0);
        // Quarantine settlement deliberately does not certify process closure.
        // Observe the exact owned handle independently before inspecting exits.
        await until(() => exits.some(value => value.kind === "cleanup"));
        if (!uncertainCleanup) assert.deepEqual(exits.find(value => value.kind === "cleanup"), { kind: "cleanup", code: 0, signal: null });
        else {
          const exit = exits.find(value => value.kind === "cleanup")!;
          assert.ok(exit.code === 0 && exit.signal === null || exit.code === null && exit.signal === "SIGKILL");
        }
        assert.equal(writer.exitCode, null); assert.equal(exits.some(value => value.kind === "writer"), false);
        assert.deepEqual(readFileSync(join(f.binding.projectionDirectory.canonicalPath, "independent-writer.sqlite")), writerBytes);
        assert.equal(existsSync(join(f.binding.projectionDirectory.canonicalPath, ".projection-manifest.publish.lock")), uncertainCleanup);
        assert.equal(await new VerifiedReadOwnershipRepository(f.binding.executorStateDirectory).inspect() === null, !uncertainCleanup);
      } finally { clearInterval(timer); }
      writer.send("stop"); await until(() => exits.some(value => value.kind === "writer"));
      assert.deepEqual(exits.find(value => value.kind === "writer"), { kind: "writer", code: 0, signal: null });
      console.log(`compiled blocked native uncertain=${uncertainCleanup} exits=${JSON.stringify(exits)} maximum=${maximum} ownershipAbsent=${closed} writerSurvived=true`);
    } finally {
      await adapter?.close();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await until(() => children.every(child => child.exitCode !== null || child.signalCode !== null));
      if (closed || !adapter && !blocked) f.cleanup(); else { f.reader.close(); f.writer.close(); t.diagnostic(`Uncertain blocked-query root retained with original lock and ownership: ${f.root}`); }
    }
  }
});

for (const fault of ["wrong-deployment", "source-echo", "unbundled"] as const) test(`native compiled query independently refuses ${fault}`, async () => {
  const f = await deployMeasuredNativeFixture();
  try {
    const negative = measured(); let expectedHash = f.measuredBuildHash;
    if (fault === "wrong-deployment") { negative.deploymentId = "11111111-1111-4111-8111-111111111111";
      const { buildIdentityHash: _hash, ...body } = negative; expectedHash = hash(body); negative.buildIdentityHash = expectedHash;
      writeFileSync(join(dirname(f.binding.deploymentDirectory.canonicalPath), "v2-build.json"), JSON.stringify(negative)); }
    if (fault === "source-echo") expectedHash = "f".repeat(64);
    // Build refusal happens before admission; keep stored authority aligned using a separate genuine fixture.
    const authority = fault === "unbundled" ? f : await makeNativeContentFixture(expectedHash);
    try {
      const binding = { ...authority.binding, deploymentDirectory: f.binding.deploymentDirectory };
      const entry = fault === "unbundled" ? fileURLToPath(new URL("../src/v2/internal-verified-read.entry.js", import.meta.url))
        : join(f.binding.deploymentDirectory.canonicalPath, "v2-internal-verified-read.js");
      const child = fork(entry, [], { cwd: authority.binding.projectionDirectory.canonicalPath, execArgv: [], windowsHide: true,
        env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}, stdio: ["ignore", "ignore", "ignore", "ipc"] } as ForkOptions);
      const messages: any[] = []; child.on("message", value => messages.push(value)); const closed = once(child, "close");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      try { child.send({ version: 2, ids: { requestId: "native-negative", attemptId: "attempt", laneEpoch: "fixture-epoch" }, binding,
        request: nativeGetRequest("exact"), lockToken: "a".repeat(32), remainingMs: 5000 });
        await closed; assert.equal(messages.at(-1)?.failure?.code, "FRESH_START_BUILD_MISMATCH");
        assert.equal(messages.filter(message => message.kind === "stage").length, 0);
        assert.equal(await new VerifiedReadOwnershipRepository(binding.executorStateDirectory).inspect(), null);
        assert.equal(existsSync(join(binding.projectionDirectory.canonicalPath, ".projection-manifest.publish.lock")), false);
        if (fault === "wrong-deployment") {
          const sourceUrl = new URL("../src/v2/build-identity.js", import.meta.url); const guard = "manifest.deploymentId !== __V2_DEPLOYMENT_ID__";
          let source = readFileSync(sourceUrl, "utf8"); assert.equal(source.split(guard).length, 2);
          source = source.replace(guard, "false").replace(/from (["'])(\.[^"']+)\1/g, (_match, _quote, relative) => `from ${JSON.stringify(new URL(relative, sourceUrl).href)}`);
          source = `const __V2_DEPLOYMENT_ID__=${JSON.stringify(measured().deploymentId)};\n${source}`;
          const inspector = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
          assert.equal(inspector.inspectV2Build(pathToFileURL(entry).href), expectedHash, "another rejection masked deployment comparison");
        }
      } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
    } finally { if (authority !== f) authority.cleanup(); }
  } finally { f.cleanup(); }
});
